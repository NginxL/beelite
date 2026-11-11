// 插件更新策略：按 游戏版本 + 目录（主进程确认后的绑定目录）+ 插件编号 记录“暂停更新”，保存在 userData 的独立文件（addon-policy.json）。
// - 暂停表示保留当前版本：仍检查并显示真实的新版本，但单项更新、重装与全部更新都不处理；卸载、首次安装与回收站恢复不受影响，
//   暂停一直保留到用户恢复（卸载后重新安装仍是暂停状态）。
// - 文件不存在视为没有暂停项；无法读取或不合法时策略未知：所有插件更新一律拒绝（不当作“没有暂停”），文件不被覆盖，可重试。
// - 所有读写在一个串行队列中执行；写入为原子替换，失败时暂停状态保持不变。暂停项有数量上限，超过时拒绝新增，不自动淘汰。
// - 主进程的更新入口每次都重新读取文件判断；current() 给出最近一次读取的结果，只用于更新检查快照（数量、提醒与界面显示）。
import path from 'node:path';
import { errorMessage, UserError } from './errors';
import { BoundedReadError, readBoundedFile, writeFileAtomic } from './layout';

export interface PolicyLimits {
  maxEntries: number;
  maxFileBytes: number;
}

export const DEFAULT_POLICY_LIMITS: PolicyLimits = { maxEntries: 2000, maxFileBytes: 1024 * 1024 };

interface PausedRecord {
  flavorId: number;
  root: string;
  modId: string;
  pausedAt: number;
}

interface PolicyData {
  paused: Map<string, PausedRecord>;
  /** 不认识的顶层字段原样保留 */
  extra: Record<string, unknown>;
}

/** 最近一次读取的策略（同步，只用于显示与计数） */
export interface PolicyView {
  /** 策略未知的原因（尚未读取或读取失败）；非 null 时任何插件都不可更新 */
  error: string | null;
  isPaused(flavorId: number, root: string, modId: string): boolean;
  pausedIn(flavorId: number, root: string): string[];
  /** 全部暂停项（最近一次成功读取的结果） */
  all(): { flavorId: number; root: string; modId: string }[];
}

export interface PolicyStoreOptions {
  limits?: Partial<PolicyLimits>;
  now?: () => number;
  /** 测试注入：替换原子写入 */
  write?: (file: string, text: string) => Promise<void>;
}

const keyOf = (flavorId: number, root: string, modId: string): string => `${flavorId}\n${root}\n${modId}`;
const NOT_LOADED = '更新策略尚未读取';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class PolicyStore {
  private readonly limits: PolicyLimits;
  private readonly now: () => number;
  private readonly write: (file: string, text: string) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  /** 最近一次成功读取的暂停项；从未成功读取为 null */
  private cache: Map<string, PausedRecord> | null = null;
  private error: string | null = NOT_LOADED;
  private readonly listeners = new Set<() => void>();

  constructor(readonly file: string, o: PolicyStoreOptions = {}) {
    this.limits = { ...DEFAULT_POLICY_LIMITS, ...o.limits };
    this.now = o.now ?? (() => Date.now());
    this.write = o.write ?? ((f, t) => writeFileAtomic(f, t));
  }

  /** 读取结果（暂停项或错误）变化时通知 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  current(): PolicyView {
    const cache = this.cache ?? new Map<string, PausedRecord>();
    return {
      error: this.error,
      isPaused: (f, root, modId) => cache.has(keyOf(f, root, modId)),
      pausedIn: (f, root) => [...cache.values()].filter((r) => r.flavorId === f && r.root === root).map((r) => r.modId).sort(),
      all: () => [...cache.values()].map(({ flavorId, root, modId }) => ({ flavorId, root, modId })),
    };
  }

  /** 重新读取文件（不抛出；错误记录在 current().error 中） */
  async reload(): Promise<void> {
    await this.enqueue(() => this.load().then(() => undefined, () => undefined));
  }

  /** 读取文件判断是否暂停；策略无法读取时抛出（调用方据此拒绝更新） */
  async isPaused(flavorId: number, root: string, modId: string): Promise<boolean> {
    return this.enqueue(async () => (await this.load()).paused.has(keyOf(flavorId, root, modId)));
  }

  /** 读取文件，返回该目录已暂停的插件编号；策略无法读取时抛出 */
  async pausedIn(flavorId: number, root: string): Promise<Set<string>> {
    return this.enqueue(async () => {
      const out = new Set<string>();
      for (const r of (await this.load()).paused.values()) if (r.flavorId === flavorId && r.root === root) out.add(r.modId);
      return out;
    });
  }

  /** 暂停或恢复；返回是否有改动。策略无法读取、超过上限或保存失败时抛出，原有策略不变 */
  async set(flavorId: number, root: string, modId: string, paused: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await this.load();
      const key = keyOf(flavorId, root, modId);
      if (paused === data.paused.has(key)) return false;
      const next = new Map(data.paused);
      if (paused) {
        if (next.size >= this.limits.maxEntries) {
          throw new UserError(`已暂停更新的插件达到 ${this.limits.maxEntries} 个的上限，请先恢复一些插件的更新`, 'policy-limit');
        }
        next.set(key, { flavorId, root, modId, pausedAt: this.now() });
      } else next.delete(key);
      const text = JSON.stringify({ ...data.extra, schema: 1, paused: [...next.values()] }, null, 1);
      if (Buffer.byteLength(text, 'utf8') > this.limits.maxFileBytes) {
        throw new UserError('更新策略将超过大小上限，未保存，暂停状态保持不变', 'policy-limit');
      }
      try {
        await this.write(this.file, text);
      } catch (err) {
        throw new UserError(`保存更新策略失败，暂停状态保持不变：${errorMessage(err)}`, 'policy-write');
      }
      this.accept(next, null);
      return true;
    });
  }

  // ---------- 内部 ----------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 记录这次读取的结果；内容或错误变化时通知 */
  private accept(paused: Map<string, PausedRecord> | null, error: string | null): void {
    const prev = this.cache;
    const changed = error !== this.error || (paused !== null && (prev === null || !sameKeys(prev, paused)));
    if (paused !== null) this.cache = paused;
    this.error = error;
    if (!changed) return;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // 通知失败不影响策略
      }
    }
  }

  private async load(): Promise<PolicyData> {
    try {
      const data = await this.readFile();
      this.accept(data.paused, null);
      return data;
    } catch (err) {
      const e = err instanceof UserError ? err : this.fileError(errorMessage(err));
      this.accept(null, e.message);
      throw e;
    }
  }

  private fileError(reason: string): UserError {
    return new UserError(`无法读取插件更新策略文件（${this.file}）：${reason}。为避免误更新已暂停的插件，已停止所有插件更新；请修复或移走该文件后点击重试`, 'policy');
  }

  /** 不跟随符号链接、不等待 FIFO，最多读取上限 + 1 字节（读取期间增长同样拒绝）；不存在时没有暂停项 */
  private async readFile(): Promise<PolicyData> {
    let text: string | null;
    try {
      text = await readBoundedFile(this.file, this.limits.maxFileBytes);
    } catch (err) {
      throw this.fileError(err instanceof BoundedReadError ? err.message : errorMessage(err));
    }
    return text === null ? { paused: new Map(), extra: {} } : this.parse(text);
  }

  /** 严格校验：任何不合法之处都报错，不丢弃条目（否则保存时会悄悄恢复它们的更新） */
  private parse(text: string): PolicyData {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw this.fileError('内容不是有效的 JSON');
    }
    if (!isPlainObject(raw)) throw this.fileError('内容格式不正确');
    if (raw.schema !== 1) throw this.fileError('版本标记不正确或来自更新的版本');
    if (!Array.isArray(raw.paused)) throw this.fileError('暂停列表格式不正确');
    if (raw.paused.length > this.limits.maxEntries) throw this.fileError('暂停项超过上限');
    const paused = new Map<string, PausedRecord>();
    raw.paused.forEach((v, i) => {
      const bad = () => this.fileError(`第 ${i + 1} 个暂停项不合法`);
      if (!isPlainObject(v)) throw bad();
      const { flavorId, root, modId, pausedAt } = v;
      if (typeof flavorId !== 'number' || !Number.isInteger(flavorId)) throw bad();
      if (typeof root !== 'string' || root.length === 0 || root.length > 4096 || root.includes('\0') || !path.isAbsolute(root)) throw bad();
      if (typeof modId !== 'string' || !/^\d{1,12}$/.test(modId)) throw bad();
      if (typeof pausedAt !== 'number' || !Number.isSafeInteger(pausedAt) || pausedAt < 0) throw bad();
      const key = keyOf(flavorId, root, modId);
      if (paused.has(key)) throw this.fileError(`第 ${i + 1} 个暂停项重复`);
      paused.set(key, { flavorId, root, modId, pausedAt });
    });
    const { schema: _schema, paused: _paused, ...extra } = raw;
    return { paused, extra };
  }
}

function sameKeys(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}
