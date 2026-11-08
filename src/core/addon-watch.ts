// 插件更新自动检查：主进程内的协调器（不依赖 Electron，时钟可注入）。
// - 只在应用运行期间工作：启动恢复完成后检查一次，之后每个已绑定目录每小时检查一次；以墙钟时间判断是否到期，
//   系统休眠唤醒后到期的目录最多补检一次，不补发错过的周期。退出后不检查。
// - 只读：只读取设置与各目录的清单、查询远端 latest，绝不写入设置、游戏目录或 .beelite，也不安装任何东西。
//   只检查应用支持的游戏版本；设置中保留的未知版本键不检查（也不改动设置）。
// - 所有检查（自动、手动、全部更新的内部重查）在一个串行队列中执行，每次最多 3 个并发请求，多个目录依次进行。
//   自动检查只在没有插件写操作、写入闸门未冻结时才开始；手动与全部更新的重查不等待闸门（全部更新本身就在闸门内）。
// - 结果按 游戏版本 + 目录 隔离，只保存在内存中。发布前必须同时满足：
//   绑定与写入代次未变（绑定或写操作完成时在任何 await 之前同步递增）、检查前后清单指纹一致、
//   重新读取的设置中该版本仍绑定该目录；读取设置之后再核对一次代次。不满足的结果不发布，
//   有等待者的检查（手动、全部更新）自动重查，仍无法得到有效结果时明确拒绝，绝不把作废的结果交给调用方。
// - 临时错误（网络、超时、服务器繁忙）按 5 / 15 / 60 分钟重试；其他错误按正常的每小时间隔；
//   设置文件无法读取时等满一小时才再读（用户绑定或解绑会立即重读）。
import { randomUUID } from 'node:crypto';
import type { AddonWatchEntry, AddonWatchSnapshot, AddonWatchStatus, UpdateCheckItem } from '../shared/types';
import { errorMessage, isTransientError, UserError } from './errors';
import { getFlavor } from './flavors';
import type { Manifest } from './store';

export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const RETRY_DELAYS_MS: readonly number[] = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
/** 闸门忙（插件写操作、启动恢复、客户端准备安装）或结果作废时，自动检查推迟的时间 */
export const GATE_RETRY_MS = 30 * 1000;
/** 定时器最长间隔：即使定时器因休眠而延后，也会在唤醒后尽快按墙钟复核 */
export const MAX_TIMER_MS = 5 * 60 * 1000;
/** 有等待者的检查因结果作废而自动重查的次数上限 */
export const MAX_STALE_RETRIES = 2;
/** 墙钟回拨超过该值时视为到期 */
const CLOCK_SKEW_MS = 60 * 1000;

export interface WatchClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: WatchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** AddonManager 的只读检查接口 */
export interface WatchChecker {
  checkUpdatesDetailed(root: string, flavorId: number, signal?: AbortSignal): Promise<{ items: UpdateCheckItem[]; fingerprint: string }>;
  readCheckedManifest(root: string): Promise<{ manifest: Manifest; fingerprint: string }>;
}

export interface AddonWatchOptions {
  settings: { load(): Promise<{ bindings: Record<string, string> }> };
  checker: WatchChecker;
  gate: { readonly activeCount: number; readonly frozen: boolean };
  clock?: WatchClock;
  onChange?: (s: AddonWatchSnapshot) => void;
}

interface Entry {
  key: string;
  flavorId: number;
  root: string;
  /** 写操作完成后递增：进行中的检查结果作废 */
  epoch: number;
  /** 结果每次变化时递增：异步重校验据此判断期间是否已有更新的结果 */
  rev: number;
  status: AddonWatchStatus;
  items: UpdateCheckItem[];
  /** items 所依据的清单指纹 */
  fingerprint: string | null;
  checkedAt: number | null;
  error: string | null;
  /** 连续出现临时错误的次数 */
  failures: number;
  nextAt: number;
  /** 因设置文件无法读取而作废、等待设置恢复后重新检查 */
  unconfirmed: boolean;
}

type JobKind = 'auto' | 'manual' | 'fresh';

interface Job {
  entry: Entry;
  /** 创建（或重查）时的写入代次与绑定代次 */
  epoch: number;
  bindEpoch: number;
  /** auto 没有等待者；有手动检查加入后改为 manual */
  kind: JobKind;
  ac: AbortController;
  attempts: number;
  promise: Promise<UpdateCheckItem[]>;
  resolve: (items: UpdateCheckItem[]) => void;
  reject: (err: unknown) => void;
  /** 已给出结果：之后的调用不能再复用它 */
  settled: boolean;
}

/** 最近一次自动提醒涉及的 目录 + 插件 + 文件；快照中的提醒按当前结果重新计算 */
interface NoticeKey {
  entryKey: string;
  flavorId: number;
  modId: string;
  fileId: string;
}

const keyOf = (flavorId: number, root: string): string => `${flavorId}\n${root}`;
const boundChanged = (): UserError => new UserError('游戏目录绑定已变更，未做任何改动，请刷新后重试', 'target');
const stoppedError = (): UserError => new UserError('蜂简正在退出或更新，已停止检查插件更新', 'frozen');
const staleError = (): UserError => new UserError('检查期间插件发生了变化，这次的检查结果已作废，请重新检查', 'stale');

export class AddonUpdateWatch {
  private readonly entries = new Map<string, Entry>();
  /** 每个游戏版本的绑定代次：绑定或解绑完成时同步递增 */
  private readonly bindEpochs = new Map<number, number>();
  private queue: Job[] = [];
  private running: Job | null = null;
  /** 已提醒过的 目录 + 插件 + 文件 */
  private readonly seen = new Set<string>();
  private noticeKeys: NoticeKey[] = [];
  private noticeSeq = 0;
  private rev = 0;
  /** 本次运行的标识：界面据此区分不同进程的快照序号 */
  private readonly instance = randomUUID();
  private settingsError: string | null = null;
  /** 设置读取失败后，下次允许自动重读的时间 */
  private settingsRetryAt: number | null = null;
  private started = false;
  /** 已成功按设置同步过目录列表 */
  private synced = false;
  private stopped = false;
  private sweeping = false;
  private resweep = false;
  private timer: unknown = null;
  private timerAt = 0;
  private readonly clock: WatchClock;

  constructor(private readonly o: AddonWatchOptions) {
    this.clock = o.clock ?? realClock;
  }

  /** 启动恢复完成后调用：立即检查一次，之后按计划检查 */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.sweep();
  }

  /** 应用退出：停止计时，中止进行中的检查，拒绝排队中的检查；迟到的结果一律不发布 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.running?.ac.abort();
    for (const j of this.queue) j.reject(stoppedError());
    this.queue = [];
  }

  /** 系统唤醒等时机：立即按墙钟复核是否到期 */
  poke(): void {
    if (this.started && !this.stopped) void this.sweep();
  }

  snapshot(): AddonWatchSnapshot {
    const entries: AddonWatchEntry[] = [...this.entries.values()]
      .sort((a, b) => a.flavorId - b.flavorId)
      .map((e) => ({
        flavorId: e.flavorId,
        root: e.root,
        status: e.status,
        items: e.items.map((i) => ({ ...i })),
        pending: e.items.filter((i) => i.hasUpdate).length,
        failed: e.items.filter((i) => i.error && !i.skipped).length,
        checkedAt: e.checkedAt,
        error: e.error,
        nextCheckAt: this.started && !this.stopped && this.settingsRetryAt === null ? e.nextAt : null,
      }));
    return { instance: this.instance, rev: this.rev, entries, settingsError: this.settingsError, notice: this.currentNotice() };
  }

  /**
   * 手动检查或全部更新的内部重查（调用方已确认 root 是 flavorId 当前绑定的目录）。
   * 返回本次有效检查的结果；结果作废时自动重查，仍无效则拒绝。
   * fresh=false 时复用同一目录、同一代次正在进行或排队的检查；fresh=true 总是重新检查。
   * 两者都排在自动检查之前，且不等待写入闸门。
   */
  check(flavorId: number, root: string, opts: { fresh?: boolean } = {}): Promise<UpdateCheckItem[]> {
    if (this.stopped) return Promise.reject(stoppedError());
    const key = keyOf(flavorId, root);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.newEntry(flavorId, root);
      this.entries.set(key, entry);
    }
    if (!opts.fresh) {
      const same = (j: Job | null) => !!j && !j.settled && j.entry === entry && j.epoch === entry!.epoch;
      if (same(this.running)) {
        if (this.running!.kind === 'auto') this.running!.kind = 'manual';
        return this.running!.promise;
      }
      const queued = this.queue.find(same);
      if (queued) {
        if (queued.kind === 'auto') {
          // 用户正在等待：提到自动检查之前
          this.queue = this.queue.filter((j) => j !== queued);
          queued.kind = 'manual';
          this.enqueuePriority(queued);
        }
        return queued.promise;
      }
    }
    const job = this.makeJob(entry, opts.fresh ? 'fresh' : 'manual');
    this.enqueuePriority(job);
    this.pump();
    return job.promise;
  }

  /**
   * 某个游戏版本的绑定刚刚完成变更（绑定或解绑，必须在任何 await 之前调用）：
   * 立即作废该版本所有目录的结果、提醒与进行中的检查；随后由 bindingsChanged() 按设置重建。
   */
  invalidateFlavor(flavorId: number): void {
    this.bindEpochs.set(flavorId, this.bindEpoch(flavorId) + 1);
    let changed = false;
    for (const e of [...this.entries.values()]) {
      if (e.flavorId !== flavorId) continue;
      this.removeEntry(e);
      changed = true;
    }
    if (changed) this.emit();
  }

  /** 绑定或解绑之后：按设置同步目录列表（立即读取设置，不受设置错误重试间隔限制），新绑定的目录随即排入检查 */
  async bindingsChanged(): Promise<void> {
    await this.syncBindings();
    if (this.started && !this.stopped) void this.sweep();
  }

  /**
   * 写操作完成之后（写入代次在任何 await 之前递增）：进行中的检查作废；按新清单只读重校验已有结果
   * （文件编号已变化的项目不再显示旧结论，已更新到当时检查到的最新文件的项目显示为最新）。不发起网络请求。
   * 清单无法读取时不再显示旧结论，标为无法确认。
   */
  async afterWrite(flavorId: number, root: string): Promise<void> {
    const key = keyOf(flavorId, root);
    const entry = this.entries.get(key);
    if (!entry || this.stopped) return;
    entry.epoch++;
    const rev = entry.rev;
    let next: { manifest: Manifest; fingerprint: string };
    try {
      next = await this.o.checker.readCheckedManifest(root);
    } catch (err) {
      if (this.stopped || this.entries.get(key) !== entry || entry.rev !== rev) return;
      entry.status = 'error';
      entry.error = `暂时无法读取插件清单，无法确认更新状态：${errorMessage(err)}`;
      entry.items = [];
      entry.fingerprint = null;
      entry.nextAt = this.clock.now() + CHECK_INTERVAL_MS;
      this.touch(entry);
      this.emit();
      return;
    }
    if (this.stopped || this.entries.get(key) !== entry || entry.rev !== rev || next.fingerprint === entry.fingerprint) return;
    entry.items = revalidate(entry.items, next.manifest, flavorId);
    entry.fingerprint = next.fingerprint;
    this.touch(entry);
    this.emit();
  }

  // ---------- 内部 ----------

  private bindEpoch(flavorId: number): number {
    return this.bindEpochs.get(flavorId) ?? 0;
  }

  private newEntry(flavorId: number, root: string): Entry {
    return { key: keyOf(flavorId, root), flavorId, root, epoch: 0, rev: 0, status: 'pending', items: [], fingerprint: null, checkedAt: null, error: null, failures: 0, nextAt: this.clock.now(), unconfirmed: false };
  }

  /** 移除目录：中止它进行中的检查，拒绝排队的检查 */
  private removeEntry(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.running?.entry === entry) this.running.ac.abort();
    for (const j of this.queue.filter((q) => q.entry === entry)) j.reject(boundChanged());
    this.queue = this.queue.filter((q) => q.entry !== entry);
  }

  private makeJob(entry: Entry, kind: JobKind): Job {
    let res!: Job['resolve'];
    let rej!: Job['reject'];
    const promise = new Promise<UpdateCheckItem[]>((a, b) => {
      res = a;
      rej = b;
    });
    // 自动检查没有等待者；避免未处理的拒绝
    promise.catch(() => undefined);
    const job: Job = {
      entry,
      epoch: entry.epoch,
      bindEpoch: this.bindEpoch(entry.flavorId),
      kind,
      ac: new AbortController(),
      attempts: 0,
      promise,
      resolve: (items) => {
        job.settled = true;
        res(items);
      },
      reject: (err) => {
        job.settled = true;
        rej(err);
      },
      settled: false,
    };
    return job;
  }

  /** 手动与全部更新的检查排在所有自动检查之前（彼此之间先来先到） */
  private enqueuePriority(job: Job): void {
    const i = this.queue.findIndex((j) => j.kind === 'auto');
    if (i < 0) this.queue.push(job);
    else this.queue.splice(i, 0, job);
  }

  private gateBusy(): boolean {
    return this.o.gate.frozen || this.o.gate.activeCount > 0;
  }

  private touch(entry: Entry): void {
    entry.rev++;
  }

  private emit(): void {
    this.rev++;
    this.o.onChange?.(this.snapshot());
  }

  /** 最近一次自动提醒中仍然成立的部分（目录仍绑定、该插件仍显示这个新文件可更新） */
  private currentNotice(): AddonWatchSnapshot['notice'] {
    let count = 0;
    const flavorIds = new Set<number>();
    for (const k of this.noticeKeys) {
      const e = this.entries.get(k.entryKey);
      if (!e || !e.items.some((i) => i.modId === k.modId && i.hasUpdate && i.latestFileId === k.fileId)) continue;
      count++;
      flavorIds.add(k.flavorId);
    }
    return count > 0 ? { seq: this.noticeSeq, count, flavorIds: [...flavorIds].sort((a, b) => a - b) } : null;
  }

  /** 只读加载设置并同步目录列表；失败时记录错误与下次重读时间，不改动已有目录列表 */
  private async syncBindings(): Promise<boolean> {
    let bindings: Record<string, string>;
    try {
      bindings = (await this.o.settings.load()).bindings;
    } catch (err) {
      if (this.stopped) return false;
      this.settingsFailed(err);
      return false;
    }
    if (this.stopped) return false;
    if (this.applyBindings(bindings)) this.emit();
    return true;
  }

  /**
   * 按一次成功读取的设置同步全部目录（不只是某一个目录）：不再绑定的目录移除，新绑定的目录加入；
   * 之前因设置无法读取而作废的目录清除错误并立即排入检查，全局设置错误与重读期限一并解除。返回是否有变化（未发布）。
   */
  private applyBindings(bindings: Record<string, string>): boolean {
    this.synced = true;
    let changed = this.settingsError !== null || this.settingsRetryAt !== null;
    this.settingsError = null;
    this.settingsRetryAt = null;
    const now = this.clock.now();
    for (const e of this.entries.values()) {
      if (!e.unconfirmed) continue;
      e.unconfirmed = false;
      e.status = 'pending';
      e.error = null;
      e.checkedAt = null;
      e.nextAt = now;
      this.touch(e);
      changed = true;
    }
    const wanted = new Map<string, [number, string]>();
    for (const [fid, root] of Object.entries(bindings)) {
      const flavorId = Number(fid);
      // 只检查应用支持的游戏版本；设置中保留的未知版本键原样留在文件中，但不发起查询
      if (Number.isInteger(flavorId) && getFlavor(flavorId)) wanted.set(keyOf(flavorId, root), [flavorId, root]);
    }
    for (const e of [...this.entries.values()]) {
      if (wanted.has(e.key)) continue;
      this.removeEntry(e);
      changed = true;
    }
    for (const [key, [flavorId, root]] of wanted) {
      if (this.entries.has(key)) continue;
      this.entries.set(key, this.newEntry(flavorId, root));
      changed = true;
    }
    return changed;
  }

  /**
   * 设置文件无法读取：无法确认任何目录的绑定，所有目录的旧结论（包括“已是最新”和已知更新）作废并标为无法确认；
   * 自动检查暂停到一小时后再读设置。用户修复设置后，手动检查或重新绑定会立即恢复。
   */
  private settingsFailed(err: unknown): void {
    const msg = errorMessage(err);
    let changed = this.settingsError !== msg || this.settingsRetryAt === null;
    this.settingsError = msg;
    this.settingsRetryAt = this.clock.now() + CHECK_INTERVAL_MS;
    for (const e of this.entries.values()) {
      if (e.unconfirmed && e.items.length === 0) continue;
      e.unconfirmed = true;
      e.status = 'error';
      e.error = `无法读取蜂简设置文件，暂时无法确认这个目录的插件更新：${msg}`;
      e.items = [];
      e.fingerprint = null;
      this.touch(e);
      changed = true;
    }
    if (changed) this.emit();
  }

  private isDue(e: Entry, now: number): boolean {
    return now >= e.nextAt || (e.checkedAt !== null && now < e.checkedAt - CLOCK_SKEW_MS);
  }

  private async sweep(): Promise<void> {
    if (!this.started || this.stopped) return;
    if (this.sweeping) {
      // 正在调度时又有绑定变化或唤醒：本轮结束后再来一次
      this.resweep = true;
      return;
    }
    this.resweep = false;
    if (this.gateBusy()) {
      this.schedule(this.clock.now() + GATE_RETRY_MS);
      return;
    }
    if (this.settingsRetryAt !== null && this.clock.now() < this.settingsRetryAt) {
      // 设置无法读取：等到重读时间，期间不读取设置、不检查任何目录
      this.scheduleNext();
      return;
    }
    if (this.settingsRetryAt === null && this.synced && ![...this.entries.values()].some((e) => this.isDue(e, this.clock.now()))) {
      // 已同步过、设置正常且没有到期的目录：定时器的例行唤醒不读取设置（绑定变化由界面通知，发布前也会重新核对设置）。
      // 设置读取失败的重读期限一到，即使没有任何目录也必须读一次设置
      this.scheduleNext();
      return;
    }
    this.sweeping = true;
    let ok = false;
    try {
      ok = await this.syncBindings();
      if (ok && !this.stopped) {
        const now = this.clock.now();
        for (const e of this.entries.values()) {
          if (!this.isDue(e, now)) continue;
          if (this.running?.entry === e || this.queue.some((j) => j.entry === e)) continue;
          this.queue.push(this.makeJob(e, 'auto'));
        }
      }
    } finally {
      this.sweeping = false;
    }
    if (this.stopped) return;
    if (this.resweep) return this.sweep();
    if (ok) this.pump();
    if (!this.running) this.scheduleNext();
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (job.kind === 'auto' && this.settingsRetryAt !== null) {
        // 设置无法读取：撤下所有排队的自动检查（不读设置、不查网络），等重读期限到达后由调度重新安排；手动与全部更新的检查不受影响
        for (const j of [job, ...this.queue.filter((q) => q.kind === 'auto')]) j.resolve([]);
        this.queue = this.queue.filter((q) => q.kind !== 'auto');
        continue;
      }
      if (job.kind === 'auto' && this.gateBusy()) {
        // 有插件写操作或闸门已冻结：推迟所有自动检查（真正延后 30 秒），手动与全部更新的检查照常进行
        const retry = this.clock.now() + GATE_RETRY_MS;
        for (const j of [job, ...this.queue.filter((q) => q.kind === 'auto')]) {
          j.entry.nextAt = Math.max(j.entry.nextAt, retry);
          j.resolve([]);
        }
        this.queue = this.queue.filter((q) => q.kind !== 'auto');
        continue;
      }
      this.running = job;
      void this.run(job).finally(() => {
        this.running = null;
        this.pump();
        if (!this.running) this.scheduleNext();
      });
      return;
    }
  }

  /** 作废的检查：不发布；有等待者时重查（次数有限），否则稍后由调度重新检查 */
  private retryOrReject(job: Job, err: unknown): void {
    const { entry } = job;
    entry.nextAt = this.clock.now() + GATE_RETRY_MS;
    if (job.kind !== 'auto' && job.attempts < MAX_STALE_RETRIES && this.entries.get(entry.key) === entry && !this.stopped) {
      job.attempts++;
      job.epoch = entry.epoch;
      job.bindEpoch = this.bindEpoch(entry.flavorId);
      job.ac = new AbortController();
      this.enqueuePriority(job);
      return;
    }
    if (job.kind === 'auto') job.resolve([]);
    else job.reject(err);
  }

  private async run(job: Job): Promise<void> {
    const { entry } = job;
    if (this.entries.get(entry.key) !== entry || job.bindEpoch !== this.bindEpoch(entry.flavorId)) return job.reject(boundChanged());
    const prevStatus = entry.status;
    entry.status = 'checking';
    this.touch(entry);
    this.emit();
    const restore = () => {
      if (this.entries.get(entry.key) !== entry || this.stopped) return;
      entry.status = prevStatus;
      this.touch(entry);
      this.emit();
    };

    let res: { items: UpdateCheckItem[]; fingerprint: string } | null = null;
    let failure: unknown = null;
    let manifestChanged = false;
    /** 检查之后读回清单失败：无法确认结果对应的清单，结果不能发布 */
    let readbackFailure: unknown = null;
    try {
      res = await this.o.checker.checkUpdatesDetailed(entry.root, entry.flavorId, job.ac.signal);
    } catch (err) {
      failure = err;
    }
    if (res) {
      try {
        // 网络请求期间清单可能被改动（包括同一文件编号的重装、外部改动）：前后指纹不一致的结果不发布
        const after = await this.o.checker.readCheckedManifest(entry.root);
        manifestChanged = after.fingerprint !== res.fingerprint;
      } catch (err) {
        readbackFailure = err;
      }
    }

    // 发布前重新读取设置，确认该版本仍绑定这个目录（覆盖没有经过界面的设置改动）
    let bindings: Record<string, string> | null = null;
    let settingsFailure: unknown = null;
    if (!this.stopped && !job.ac.signal.aborted) {
      try {
        bindings = (await this.o.settings.load()).bindings;
      } catch (err) {
        settingsFailure = err;
      }
    }

    // 以下核对与发布之间不再有 await
    const current = this.entries.get(entry.key) === entry && job.bindEpoch === this.bindEpoch(entry.flavorId);
    if (this.stopped) return job.reject(stoppedError());
    if (job.ac.signal.aborted || !current) {
      restore();
      return job.reject(boundChanged());
    }
    if (settingsFailure || !bindings) {
      restore();
      this.settingsFailed(settingsFailure);
      return job.reject(settingsFailure);
    }
    if (this.settingsError !== null || this.settingsRetryAt !== null) {
      // 设置重新可读：按读到的全部绑定统一恢复（其他目录作废的结论不会被放出，而是重新检查）
      if (this.applyBindings(bindings)) this.emit();
      if (this.entries.get(entry.key) !== entry) return job.reject(boundChanged());
    }
    const bound = bindings[String(entry.flavorId)];
    if (bound !== entry.root) {
      // 设置已在别处改变：丢弃这次结果，稍后由同步移除该目录
      restore();
      entry.nextAt = this.clock.now() + GATE_RETRY_MS;
      return job.reject(boundChanged());
    }
    if (this.o.gate.frozen) {
      restore();
      entry.nextAt = this.clock.now() + GATE_RETRY_MS;
      return job.reject(stoppedError());
    }
    if (entry.epoch !== job.epoch || manifestChanged) {
      // 检查期间有写操作完成或清单变化：不发布，也不把作废的结果交给调用方
      restore();
      return this.retryOrReject(job, staleError());
    }

    const now = this.clock.now();
    if (readbackFailure) {
      // 检查后无法读回清单：不知道结果对应哪份清单，标为无法确认，不显示任何结论
      entry.status = 'error';
      entry.error = `检查后无法读取插件清单，暂时无法确认更新状态：${errorMessage(readbackFailure)}`;
      entry.items = [];
      entry.fingerprint = null;
      entry.checkedAt = now;
      const transient = isTransientError(readbackFailure);
      entry.failures = transient ? entry.failures + 1 : 0;
      entry.nextAt = now + (transient ? retryDelay(entry.failures) : CHECK_INTERVAL_MS);
      entry.unconfirmed = false;
      this.touch(entry);
      this.emit();
      return job.reject(readbackFailure);
    }
    if (!res) {
      // 整个目录无法检查（目录不存在、无权限、清单损坏等）：不显示任何旧结论
      const transient = isTransientError(failure);
      entry.unconfirmed = false;
      entry.status = 'error';
      entry.error = errorMessage(failure);
      entry.items = [];
      entry.fingerprint = null;
      entry.checkedAt = now;
      entry.failures = transient ? entry.failures + 1 : 0;
      entry.nextAt = now + (transient ? retryDelay(entry.failures) : CHECK_INTERVAL_MS);
      this.touch(entry);
      this.emit();
      return job.reject(failure);
    }

    entry.unconfirmed = false;
    const items = stamp(res.items, now);
    const merged = mergeResults(entry.items, items);
    const transient = items.some((i) => i.error && i.transient);
    entry.items = merged;
    entry.fingerprint = res.fingerprint;
    entry.checkedAt = now;
    entry.error = null;
    entry.status = merged.some((i) => i.error && !i.skipped) ? 'partial' : 'ok';
    entry.failures = transient ? entry.failures + 1 : 0;
    entry.nextAt = now + (transient ? retryDelay(entry.failures) : CHECK_INTERVAL_MS);
    this.recordNotice(job, merged);
    this.touch(entry);
    this.emit();
    job.resolve(items);
  }

  /** 同一 目录 + 插件 + 文件 只提醒一次；手动检查与全部更新的结果只记为已提醒（界面已有自己的提示） */
  private recordNotice(job: Job, items: UpdateCheckItem[]): void {
    const fresh: NoticeKey[] = [];
    for (const i of items) {
      if (!i.hasUpdate || !i.latestFileId) continue;
      const k = `${job.entry.key}\n${i.modId}\n${i.latestFileId}`;
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      fresh.push({ entryKey: job.entry.key, flavorId: job.entry.flavorId, modId: i.modId, fileId: i.latestFileId });
    }
    if (job.kind === 'auto' && fresh.length > 0) {
      this.noticeSeq++;
      this.noticeKeys = fresh;
    }
  }

  private scheduleNext(): void {
    if (!this.started || this.stopped) return;
    if (this.settingsRetryAt !== null) {
      // 设置无法读取期间不检查任何目录：只在重读时间到达时再试
      this.schedule(this.settingsRetryAt);
      return;
    }
    const now = this.clock.now();
    let next = now + CHECK_INTERVAL_MS;
    for (const e of this.entries.values()) next = Math.min(next, e.nextAt);
    this.schedule(next);
  }

  private schedule(at: number): void {
    if (this.stopped) return;
    const now = this.clock.now();
    // 已有更早的定时器时保留它
    if (this.timer !== null && this.timerAt <= at && this.timerAt > now) return;
    this.clearTimer();
    const delay = Math.min(MAX_TIMER_MS, Math.max(1000, at - now));
    this.timerAt = now + delay;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.sweep();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

function retryDelay(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1];
}

function stamp(items: UpdateCheckItem[], at: number): UpdateCheckItem[] {
  return items.map((i) => ({ ...i, checkedAt: at }));
}

/**
 * 合并本次结果：某项本次临时失败、而上次成功结果对应同一个本地文件且为“可更新”时，保留“可更新”并标注本次失败。
 * 其他失败（包括上次是“已是最新”）如实显示为失败，不能显示成最新。
 */
function mergeResults(prev: UpdateCheckItem[], next: UpdateCheckItem[]): UpdateCheckItem[] {
  const old = new Map(prev.map((i) => [i.modId, i]));
  return next.map((i) => {
    if (!i.error || !i.transient) return i;
    const p = old.get(i.modId);
    if (p && p.hasUpdate && p.installedFileId === i.installedFileId) {
      return { ...p, error: `本次检查失败（${i.error}），显示的是上次的检查结果`, transient: true, stale: true, checkedAt: p.checkedAt };
    }
    return i;
  });
}

/** 写操作后按新清单重校验：只保留本地文件编号仍相同的结论；已更新到当时最新文件的项目改为最新 */
function revalidate(items: UpdateCheckItem[], manifest: Manifest, flavorId: number): UpdateCheckItem[] {
  const out: UpdateCheckItem[] = [];
  for (const i of items) {
    const p = manifest.projects[i.modId];
    if (!p) continue;
    if (i.skipped) {
      if (p.flavorId !== flavorId) out.push({ ...i, installedFileId: p.fileId, name: p.name });
      continue;
    }
    if (p.flavorId !== flavorId) continue;
    if (p.fileId === i.installedFileId) out.push(i);
    else if (i.latestFileId && !i.error && p.fileId === i.latestFileId) {
      out.push({ ...i, hasUpdate: false, installedFileId: p.fileId, name: p.name, error: null, transient: undefined });
    }
  }
  return out;
}
