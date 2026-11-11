// 操作记录：本机 userData 中的一份独立文件（operation-history.json），只由主进程读写，与插件事务完全分开。
// - 受理时写入 accepted，结束时按同一编号写入结果；之前某次运行留下的 accepted 读取时一律改为“结果未确认”，
//   不根据当前清单或启动恢复推测成功或回滚。
// - 有界：最多保留 500 条已结束的记录（进行中的不淘汰），整个文件不超过 2 MiB；名称、说明与提示按 UTF-8 字节截断并明确标注。
// - 所有读写在一个串行队列中执行，写入为原子替换。文件无法读取（损坏、过大、符号链接、未知版本）时不覆盖它，
//   新的记录留在内存中继续显示并可重试；保存失败不影响插件操作本身的结果。
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HistoryEntry, HistoryKind, HistoryStatus, HistoryStatusView, HistoryVersion, HistoryView } from '../shared/types';
import { errorMessage, UserError } from './errors';
import { FILE_ID_RE } from './file-id';
import { BoundedReadError, readBoundedFile, writeFileAtomic } from './layout';

export interface HistoryLimits {
  /** 已结束记录的条数上限（超过时淘汰最旧的已结束记录） */
  maxFinished: number;
  /** 记录文件的字节上限（读取与写入共用） */
  maxFileBytes: number;
  /** 尚未写入磁盘的记录条数上限（超过时丢弃最旧的已结束记录并计数） */
  maxPending: number;
  maxNameBytes: number;
  /** 旧 / 新版本的展示名称（文件编号不截断）；写入与读取共用 */
  maxVersionBytes: number;
  maxMessageBytes: number;
  maxWarningBytes: number;
  maxWarnings: number;
  maxWarningsTotalBytes: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxFinished: 500,
  maxFileBytes: 2 * 1024 * 1024,
  maxPending: 500,
  maxNameBytes: 256,
  maxVersionBytes: 256,
  maxMessageBytes: 2048,
  maxWarningBytes: 1024,
  maxWarnings: 20,
  maxWarningsTotalBytes: 8 * 1024,
};

/** 一次操作受理时的信息 */
export interface HistoryStart {
  flavorId: number;
  root: string;
  kind: HistoryKind;
  modId?: string | null;
  target?: string | null;
  name: string;
  batchId?: string | null;
  expectedFileId?: string | null;
}

/** 操作结束时的结果；previous / installed 只能来自提交回执 */
export interface HistoryOutcome {
  status: Exclude<HistoryStatus, 'accepted'>;
  message: string;
  warnings?: string[];
  name?: string;
  modId?: string | null;
  previous?: HistoryVersion | null;
  installed?: HistoryVersion | null;
}

interface StoredEntry extends Omit<HistoryEntry, 'unsaved'> {
  /** 写入这条记录的运行标识：之前运行留下的 accepted 视为中断 */
  instance: string;
}

export interface HistoryStoreOptions {
  limits?: Partial<HistoryLimits>;
  now?: () => number;
  /** 测试注入：替换原子写入 */
  write?: (file: string, text: string) => Promise<void>;
}

const TRUNC_MARK = '…（已截断）';
const INTERRUPTED = '上次运行中断，这项操作的结果未确认；请以当前插件列表为准';
const KINDS: ReadonlySet<string> = new Set<HistoryKind>(['install', 'update', 'reinstall', 'uninstall', 'uninstall-folder', 'restore', 'purge', 'pause', 'resume']);
const STATUSES: ReadonlySet<string> = new Set<HistoryStatus>(['accepted', 'succeeded', 'unchanged', 'cancelled', 'not-processed', 'failed', 'unconfirmed']);
const ENTRY_ID_RE = /^[0-9a-z]{1,16}-[0-9a-f]{8}$/;
const TARGET_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 按 UTF-8 字节截断（不拆开字符），被截断时以明确的标记结尾 */
export function clipText(s: string, maxBytes: number): { text: string; cut: boolean } {
  if (bytes(s) <= maxBytes) return { text: s, cut: false };
  const budget = Math.max(0, maxBytes - bytes(TRUNC_MARK));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return { text: out + TRUNC_MARK, cut: true };
}

function fileError(file: string, reason: string): UserError {
  return new UserError(`操作记录文件无法读取（${file}）：${reason}。为避免丢失已有记录，不会覆盖该文件；新的记录暂存在内存中。可将该文件移走后点击重试`, 'history');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class HistoryStore {
  readonly instance = randomUUID();
  private readonly limits: HistoryLimits;
  private readonly now: () => number;
  private readonly write: (file: string, text: string) => Promise<void>;
  /** 尚未写入磁盘的记录（编号 → 最新内容与版本号）；写入成功且版本未变时移除 */
  private readonly pending = new Map<string, { entry: StoredEntry; version: number }>();
  /** 已受理、尚未结束的记录 */
  private readonly active = new Map<string, StoredEntry>();
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private loadError: string | null = null;
  private saveError: string | null = null;
  private dropped = 0;
  private rev = 0;
  private readonly listeners = new Set<(s: HistoryStatusView) => void>();

  constructor(readonly file: string, o: HistoryStoreOptions = {}) {
    this.limits = { ...DEFAULT_HISTORY_LIMITS, ...o.limits };
    this.now = o.now ?? (() => Date.now());
    this.write = o.write ?? ((f, t) => writeFileAtomic(f, t));
  }

  onStatus(fn: (s: HistoryStatusView) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** 保存状态：只有最近一次读取或保存失败时，待写入的记录才算“未保存”（正在写入的不算） */
  status(): HistoryStatusView {
    const failing = this.loadError !== null || this.saveError !== null;
    return { rev: this.rev, loadError: this.loadError, saveError: this.saveError, unsaved: failing ? this.pending.size : 0, dropped: this.dropped, file: this.file };
  }

  /** 受理一项操作：记录 accepted 并尝试保存（保存失败不抛出），返回记录编号 */
  async begin(s: HistoryStart): Promise<string> {
    const id = `${this.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const entry: StoredEntry = {
      id,
      instance: this.instance,
      flavorId: s.flavorId,
      root: s.root,
      kind: s.kind,
      status: 'accepted',
      modId: s.modId ?? null,
      target: s.target ?? null,
      name: '',
      batchId: s.batchId ?? null,
      startedAt: this.now(),
      finishedAt: null,
      expectedFileId: s.expectedFileId ?? null,
      previous: null,
      installed: null,
      message: '',
      warnings: [],
      truncated: false,
    };
    this.setText(entry, s.name, '', []);
    this.active.set(id, entry);
    this.stage(entry);
    await this.flush();
    return id;
  }

  /** 结束一项已受理的操作（同一编号只结算一次） */
  async finish(id: string, o: HistoryOutcome): Promise<void> {
    const base = this.active.get(id);
    if (!base) return;
    this.active.delete(id);
    this.stage(this.settle(base, o));
    await this.flush();
  }

  /** 直接记录一项已结束的操作（例如全部更新停止时没有开始的项目） */
  async record(s: HistoryStart, o: HistoryOutcome): Promise<void> {
    const id = await this.begin(s);
    await this.finish(id, o);
  }

  /** 重新读取记录文件并保存尚未写入的记录 */
  async retry(): Promise<HistoryStatusView> {
    await this.enqueue(async () => {
      if (this.pending.size > 0) return this.flushLocked();
      try {
        await this.readFile();
        this.loadError = null;
      } catch (err) {
        this.loadError = errorMessage(err);
      }
      this.publish();
    });
    return this.status();
  }

  /** 某个目录（游戏版本 + 目录）的记录，新的在前；文件无法读取时只返回内存中尚未保存的记录 */
  async list(flavorId: number, root: string): Promise<HistoryView> {
    return this.enqueue(async () => {
      let saved: StoredEntry[] = [];
      try {
        saved = await this.readFile();
        if (this.loadError !== null) {
          this.loadError = null;
          this.publish();
        }
      } catch (err) {
        const msg = errorMessage(err);
        if (this.loadError !== msg) {
          this.loadError = msg;
          this.publish();
        }
      }
      const byId = new Map<string, HistoryEntry>();
      for (const e of saved) byId.set(e.id, view(e));
      const failing = this.loadError !== null || this.saveError !== null;
      for (const { entry } of this.pending.values()) byId.set(entry.id, failing ? { ...view(entry), unsaved: true } : view(entry));
      const entries = [...byId.values()].filter((e) => e.flavorId === flavorId && e.root === root).reverse();
      return { flavorId, root, entries, status: this.status() };
    });
  }

  // ---------- 内部 ----------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private publish(): void {
    this.rev++;
    const s = this.status();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        // 通知失败不影响记录
      }
    }
  }

  /** 名称、说明与提示按字节上限截断；任何一项被截断时标记 truncated */
  private setText(e: StoredEntry, name: string, message: string, warnings: string[]): void {
    const L = this.limits;
    let cut = e.truncated;
    const n = clipText(name, L.maxNameBytes);
    const m = clipText(message, L.maxMessageBytes);
    cut = cut || n.cut || m.cut;
    const kept: string[] = [];
    let total = 0;
    let omitted = 0;
    for (const w of warnings) {
      const c = clipText(w, L.maxWarningBytes);
      if (kept.length >= L.maxWarnings || total + bytes(c.text) > L.maxWarningsTotalBytes) {
        omitted++;
        continue;
      }
      cut = cut || c.cut;
      kept.push(c.text);
      total += bytes(c.text);
    }
    if (omitted > 0) {
      cut = true;
      kept.push(clipText(`另有 ${omitted} 条提示未保存（已截断）`, L.maxWarningBytes).text);
    }
    e.name = n.text;
    e.message = m.text;
    e.warnings = kept;
    e.truncated = cut;
  }

  private settle(base: StoredEntry, o: HistoryOutcome): StoredEntry {
    // 文件编号保持原值；版本名称是展示文本，按与读取相同的字节上限截断并标记（否则写出的记录自己读不回来）
    let cut = false;
    const clipVersion = (v: HistoryVersion | null | undefined): HistoryVersion | null => {
      if (!v) return null;
      const c = clipText(v.version, this.limits.maxVersionBytes);
      cut = cut || c.cut;
      return { fileId: v.fileId, version: c.text };
    };
    const e: StoredEntry = {
      ...base,
      status: o.status,
      finishedAt: this.now(),
      modId: o.modId !== undefined ? o.modId : base.modId,
      previous: clipVersion(o.previous),
      installed: clipVersion(o.installed),
    };
    e.truncated = e.truncated || cut;
    this.setText(e, o.name ?? base.name, o.message, o.warnings ?? []);
    return e;
  }

  /** 放入待保存；超过上限时丢弃最旧的已结束记录（计数，状态中可见） */
  private stage(entry: StoredEntry): void {
    this.pending.set(entry.id, { entry, version: ++this.version });
    while (this.pending.size > this.limits.maxPending) {
      const victim = [...this.pending.values()].find((p) => p.entry.status !== 'accepted');
      if (!victim) break;
      this.pending.delete(victim.entry.id);
      this.dropped++;
    }
  }

  private flush(): Promise<void> {
    return this.enqueue(() => this.flushLocked());
  }

  private async flushLocked(): Promise<void> {
    if (this.pending.size === 0) return;
    let entries: StoredEntry[];
    try {
      entries = await this.readFile();
      this.loadError = null;
    } catch (err) {
      this.loadError = errorMessage(err);
      this.saveError = this.loadError;
      this.publish();
      return;
    }
    const batch = [...this.pending.values()].map((p) => ({ id: p.entry.id, version: p.version, entry: p.entry }));
    const index = new Map(entries.map((e, i) => [e.id, i]));
    for (const b of batch) {
      const i = index.get(b.id);
      if (i === undefined) {
        index.set(b.id, entries.length);
        entries.push(b.entry);
      } else entries[i] = b.entry;
    }
    try {
      await this.write(this.file, this.serialize(entries));
      this.saveError = null;
      for (const b of batch) if (this.pending.get(b.id)?.version === b.version) this.pending.delete(b.id);
    } catch (err) {
      this.saveError = errorMessage(err);
    }
    this.publish();
  }

  /** 淘汰最旧的已结束记录，直到条数与字节都在上限内；进行中的记录不淘汰 */
  private serialize(entries: StoredEntry[]): string {
    const L = this.limits;
    const finished = (e: StoredEntry) => e.status !== 'accepted' || e.instance !== this.instance;
    let count = entries.filter(finished).length;
    while (count > L.maxFinished) {
      const i = entries.findIndex(finished);
      entries.splice(i, 1);
      count--;
    }
    for (;;) {
      const text = JSON.stringify({ schema: 1, entries });
      if (bytes(text) <= L.maxFileBytes) return text;
      const i = entries.findIndex(finished);
      if (i < 0) throw new UserError('操作记录超过大小上限，暂时无法保存', 'history');
      entries.splice(i, 1);
    }
  }

  /** 读取记录文件（不跟随符号链接、不等待 FIFO，最多读取上限 + 1 字节，严格校验）；不存在时为空 */
  private async readFile(): Promise<StoredEntry[]> {
    let text: string | null;
    try {
      text = await readBoundedFile(this.file, this.limits.maxFileBytes);
    } catch (err) {
      throw fileError(this.file, err instanceof BoundedReadError ? err.message : errorMessage(err));
    }
    return text === null ? [] : this.parse(text);
  }

  private parse(text: string): StoredEntry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw fileError(this.file, '内容不是有效的 JSON');
    }
    if (!isPlainObject(raw)) throw fileError(this.file, '内容格式不正确');
    if (raw.schema !== 1) throw fileError(this.file, '版本标记不正确或来自更新的版本');
    if (!Array.isArray(raw.entries)) throw fileError(this.file, '记录列表格式不正确');
    const ids = new Set<string>();
    return raw.entries.map((v, i) => {
      const e = this.parseEntry(v);
      if (!e || ids.has(e.id)) throw fileError(this.file, `第 ${i + 1} 条记录不合法`);
      ids.add(e.id);
      // 之前运行留下的未结束记录：结果未确认，不推测成功或回滚
      if (e.status === 'accepted' && e.instance !== this.instance) {
        return { ...e, status: 'unconfirmed' as const, message: e.message ? `${INTERRUPTED}。${e.message}` : INTERRUPTED };
      }
      return e;
    });
  }

  private parseEntry(v: unknown): StoredEntry | null {
    if (!isPlainObject(v)) return null;
    const L = this.limits;
    const str = (x: unknown, max: number) => typeof x === 'string' && bytes(x) <= max;
    const optStr = (x: unknown, re: RegExp) => x === null || (typeof x === 'string' && re.test(x));
    const time = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
    const ver = (x: unknown): x is HistoryVersion | null =>
      x === null || (isPlainObject(x) && typeof x.fileId === 'string' && FILE_ID_RE.test(x.fileId) && str(x.version, L.maxVersionBytes));
    if (typeof v.id !== 'string' || !ENTRY_ID_RE.test(v.id) || !str(v.instance, 64)) return null;
    if (typeof v.flavorId !== 'number' || !Number.isInteger(v.flavorId)) return null;
    if (typeof v.root !== 'string' || v.root.length === 0 || v.root.length > 4096 || v.root.includes('\0') || !path.isAbsolute(v.root)) return null;
    if (typeof v.kind !== 'string' || !KINDS.has(v.kind) || typeof v.status !== 'string' || !STATUSES.has(v.status)) return null;
    if (!optStr(v.modId, /^\d{1,12}$/) || !optStr(v.target, TARGET_RE) || !optStr(v.batchId, /^[0-9a-f-]{1,64}$/)) return null;
    if (!optStr(v.expectedFileId, FILE_ID_RE)) return null;
    if (!str(v.name, L.maxNameBytes) || !str(v.message, L.maxMessageBytes + bytes(INTERRUPTED) + 3)) return null;
    if (!time(v.startedAt) || !(v.finishedAt === null || time(v.finishedAt))) return null;
    if (!ver(v.previous) || !ver(v.installed) || typeof v.truncated !== 'boolean') return null;
    if (!Array.isArray(v.warnings) || v.warnings.length > L.maxWarnings + 1 || !v.warnings.every((w) => str(w, L.maxWarningBytes))) return null;
    return {
      id: v.id,
      instance: v.instance as string,
      flavorId: v.flavorId,
      root: v.root,
      kind: v.kind as HistoryKind,
      status: v.status as HistoryStatus,
      modId: v.modId as string | null,
      target: v.target as string | null,
      name: v.name as string,
      batchId: v.batchId as string | null,
      startedAt: v.startedAt as number,
      finishedAt: v.finishedAt as number | null,
      expectedFileId: v.expectedFileId as string | null,
      previous: v.previous as HistoryVersion | null,
      installed: v.installed as HistoryVersion | null,
      message: v.message as string,
      warnings: [...(v.warnings as string[])],
      truncated: v.truncated,
    };
  }
}

function view(e: StoredEntry): HistoryEntry {
  const { instance: _instance, ...rest } = e;
  return { ...rest, warnings: [...rest.warnings] };
}
