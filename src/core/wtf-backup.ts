// 可选本地 WTF 配置备份：用户主动启用、选择本地位置、手动创建、重新校验、在访达中查看。
// - 默认关闭；未启用时不访问 WTF，也不访问备份位置。不检测游戏是否运行，不提供恢复、定时、云端或自动删除。
// - 备份位置是用户所选目录下新建的专属容器「AzerCube WTF Backup-<随机编号>」，带标记文件；不接管已有目录。
// - 遇到符号链接、多硬链接文件、特殊文件、名称冲突或超出上限时整份失败；复制期间源发生变化直接失败，不自动重试。
// - 发布前双向核对：重算源文件校验值，按清单完整校验本次临时目录，最后再复核源与目标的集合及每项身份 / 大小 / 时间。
//   这些检查能发现常规的写入与替换，但不是瞬时的文件系统快照：最后一次复核与发布之间仍有极短的窗口。
// - 失败或取消时只删除本次登记且身份（含各级父目录）仍匹配的临时内容；外来内容、历史备份与旧的未完成目录一律保留。
// - 路径检查基于 Node 路径 API 与 dev:ino 复核，只能发现常见的替换与移动，无法完全防御同权限恶意进程的竞态替换。
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  BackupAnomaly,
  BackupLimits,
  BackupRunResult,
  BackupSnapshotInfo,
  BackupSnapshotStatus,
  BackupState,
  BackupTaskInfo,
  BackupTaskKind,
  BackupUsage,
  BackupVerifyRecord,
  BackupVerifyResult,
} from '../shared/backup-types';
import { errorMessage, UserError } from './errors';
import { writeAll } from './fsio';
import { syncDir } from './layout';
import { foldKey, isSafeSegment } from './paths';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const DEFAULT_BACKUP_LIMITS: Readonly<BackupLimits> = Object.freeze({
  maxSnapshots: 10,
  maxTotalBytes: 10 * GiB,
  maxSnapshotBytes: 2 * GiB,
  maxFileBytes: 1 * GiB,
  maxEntries: 50000,
  maxDepth: 32,
  maxManifestBytes: 16 * MiB,
});

export const CONTAINER_PREFIX = 'AzerCube WTF Backup-';
export const MARKER_NAME = '.azercube-wtf-backup.json';
export const LOCK_NAME = 'BACKUP-IN-PROGRESS.lock';
export const MANIFEST_NAME = 'manifest.json';
export const PARTIAL_PREFIX = '.partial-';
export const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{16}$/;
const FORMAT = 'azercube-wtf-backup';
/** 访达浏览时可能自行生成；未列入清单的这类普通文件不视为改动，但计入占用（链接、特殊文件、多硬链接照常拒绝） */
const IGNORED_FILE = '.DS_Store';
const MAX_SETTINGS_BYTES = 1 * MiB;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4096;
const MAX_TARGETS = 64;
/** 快照目录除 WTF 内容外允许的额外条目（WTF 目录、清单与访达文件） */
const SNAPSHOT_EXTRA_ENTRIES = 64;
/** 备份位置顶层的固定条目预算（标记、占用标记、访达文件与少量异常项） */
const CONTAINER_FIXED_ENTRIES = 64;
const CHUNK = 1 * MiB;
const PROGRESS_INTERVAL_MS = 200;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export type BackupStep =
  | 'source-enumerate'
  | 'copy-file'
  | 'source-recheck'
  | 'manifest-write'
  | 'before-publish'
  | 'target-recheck'
  | 'final-check'
  | 'verify-file'
  | 'verify-final'
  | 'configure-before-create'
  | 'configure-before-commit'
  | 'before-lock-release';

export interface WtfBackupHooks {
  /** 测试注入：在各阶段之前调用，可抛错模拟故障或在此改动文件（before-lock-release 的异常被忽略） */
  step?(name: BackupStep, detail?: string): Promise<void> | void;
}

export interface WtfBackupOptions {
  /** 独立的备份设置文件（0600） */
  settingsFile: string;
  /** 应用数据目录：备份位置不能在其中，也不能包含它 */
  appDataDir: string;
  appVersion: string;
  /** 该游戏版本当前绑定的规范化游戏目录 */
  resolveRoot(flavorId: number): Promise<string | null>;
  /** 全部已绑定的游戏目录 */
  listBoundRoots(): Promise<string[]>;
  /** 状态变化通知（无内容）；开始与结束必定触发，进度限频 */
  onChange?(): void;
  limits?: Partial<BackupLimits>;
  hooks?: WtfBackupHooks;
}

type StepFn = (name: BackupStep, detail?: string) => Promise<void>;

// ---------- 通用工具 ----------

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function idOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}`;
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAbsPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0') && path.isAbsolute(v) && path.normalize(v) === v;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function fmtBytes(n: number): string {
  if (n >= GiB) return `${+(n / GiB).toFixed(2)} GiB`;
  if (n >= MiB) return `${+(n / MiB).toFixed(2)} MiB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(2)} KiB`;
  return `${n} 字节`;
}

/** child 是否等于 parent 或位于其下（按大小写与 Unicode 无关的比较键） */
function within(child: string, parent: string): boolean {
  const c = foldKey(child);
  const p = foldKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

function newTaskId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function newSnapshotId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(4).toString('hex')}`;
}

function resolveLimits(over: Partial<BackupLimits> | undefined): BackupLimits {
  const limits: BackupLimits = { ...DEFAULT_BACKUP_LIMITS, ...over };
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error(`备份上限 ${k} 不合法`);
  }
  return limits;
}

function cancelledError(): UserError {
  return new UserError('备份任务已取消', 'backup-cancelled');
}

function isCancelled(err: unknown): boolean {
  return err instanceof UserError && err.code === 'backup-cancelled';
}

function isScanLimit(err: unknown): boolean {
  return err instanceof UserError && err.code === 'backup-scan-limit';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function unsupported(label: string, rel: string, what: string): UserError {
  return new UserError(`${label}中的「${rel}」${what}。为避免得到不完整的备份，已整份停止`, 'backup-unsupported-entry');
}

function sourceChanged(rel: string): UserError {
  return new UserError(`备份期间 WTF 中的「${rel}」发生了变化，本次备份未完成。请先退出游戏、确认配置已保存后再重新备份`, 'backup-source-changed');
}

function targetChanged(detail: string): UserError {
  return new UserError(`备份写入后核对不一致（${detail}），本次备份未完成`, 'backup-verify-failed');
}

function limitError(what: string, limit: number, unit: 'bytes' | 'count'): UserError {
  const shown = unit === 'bytes' ? fmtBytes(limit) : String(limit);
  return new UserError(`超出${what}上限（${shown}），本次备份未完成。艾泽魔方不会自动删除旧备份，请在访达中整理或另选位置`, 'backup-limit');
}

function withNotes(err: unknown, notes: string[]): unknown {
  if (notes.length === 0) return err;
  const code = err instanceof UserError ? err.code : 'backup-failed';
  return new UserError(`${errorMessage(err)}。${notes.join('。')}`, code);
}

/**
 * 读取小型元数据文件：不跟随符号链接，拒绝非普通文件与多硬链接文件；打开后分块读取，超过上限立即停止（不信任打开前的大小）；
 * 读取前后 fstat 必须一致。不存在返回 null。
 */
async function readMeta(p: string, max: number, label: string, signal?: AbortSignal): Promise<{ data: Buffer; st: BigIntStats } | null> {
  let fh: FileHandle;
  try {
    fh = await open(p, READ_FLAGS);
  } catch (err) {
    const c = errCode(err);
    if (c === 'ENOENT') return null;
    if (c === 'ELOOP') throw new UserError(`${label}是符号链接，拒绝读取`, 'backup-unsupported-entry');
    throw err;
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new UserError(`${label}不是普通文件`, 'backup-unsupported-entry');
    if (st.nlink > 1n) throw new UserError(`${label}有多个硬链接，拒绝读取`, 'backup-unsupported-entry');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      throwIfAborted(signal);
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, max + 1 - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) throw new UserError(`${label}超过 ${fmtBytes(max)} 上限`, 'backup-limit');
      chunks.push(buf.subarray(0, bytesRead));
    }
    if (!sameStat(st, await fh.stat({ bigint: true }))) throw new UserError(`${label}在读取期间发生变化`, 'backup-changed');
    return { data: Buffer.concat(chunks, total), st };
  } finally {
    await fh.close();
  }
}

async function readBounded(p: string, max: number, label: string, signal?: AbortSignal): Promise<Buffer | null> {
  return (await readMeta(p, max, label, signal))?.data ?? null;
}

/** 删除文件，但仅当它仍是指定身份的普通文件 */
async function unlinkIfSame(p: string, id: string): Promise<boolean> {
  try {
    const st = await lstat(p, { bigint: true });
    if (!st.isFile() || idOf(st) !== id) return false;
    await unlink(p);
    return true;
  } catch {
    return false;
  }
}

/** 排他新建 0600 文件并完整写入、fsync；失败时只删除本次创建的文件。返回文件身份 */
async function writeNewFile(p: string, data: Uint8Array): Promise<string> {
  const fh = await open(p, CREATE_FLAGS, 0o600);
  let id: string;
  try {
    id = idOf(await fh.stat({ bigint: true }));
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
  try {
    await writeAll(fh, data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlinkIfSame(p, id);
    throw err;
  }
  await fh.close();
  return id;
}

/** 规范路径自身及各级父目录的身份（由近及远）；任何一级是链接或非目录即失败 */
async function chainIds(real: string): Promise<string[]> {
  const ids: string[] = [];
  let cur = real;
  for (;;) {
    const st = await lstat(cur, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(`路径中存在符号链接或非目录：${cur}`, 'backup-path-changed');
    ids.push(idOf(st));
    const parent = path.dirname(cur);
    if (parent === cur) return ids;
    cur = parent;
  }
}

function sameChain(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// ---------- 有界目录枚举 ----------

interface WalkEntry {
  /** 相对 base，以 / 分隔 */
  rel: string;
  kind: 'dir' | 'file';
  st: BigIntStats;
}

interface WalkOptions {
  maxEntries: number;
  maxDepth: number;
  /** 普通文件 nlink > 1 时失败（目录不检查） */
  rejectHardlinks: boolean;
  /** 跨多棵树共享的扫描预算；耗尽时抛 backup-scan-limit */
  budget?: { left: number };
  signal?: AbortSignal;
  label: string;
}

function scanLimitError(): UserError {
  return new UserError('备份位置中的条目超出扫描上限，无法确认占用', 'backup-scan-limit');
}

/**
 * 逐条读取目录（opendir），读到即计入预算；拒绝符号链接、特殊文件、跨卷目录、不安全名称与同目录内的大小写 / Unicode 冲突。
 * 父目录总是先于其子项出现在结果中。
 */
async function walkTree(base: string, o: WalkOptions): Promise<WalkEntry[]> {
  const baseSt = await lstat(base, { bigint: true });
  if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) throw unsupported(o.label, '.', '不是普通文件夹');
  const out: WalkEntry[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const names: string[] = [];
    const seen = new Set<string>();
    throwIfAborted(o.signal);
    const dir = await opendir(relDir ? path.join(base, relDir) : base);
    try {
      for (let d = await dir.read(); d !== null; d = await dir.read()) {
        throwIfAborted(o.signal);
        if (o.budget) {
          if (o.budget.left <= 0) throw scanLimitError();
          o.budget.left--;
        }
        if (out.length + names.length + 1 > o.maxEntries) throw limitError('文件与目录数量', o.maxEntries, 'count');
        const name = d.name;
        const rel = relDir ? `${relDir}/${name}` : name;
        if (!isSafeSegment(name)) throw unsupported(o.label, rel, '的名称不受支持');
        const k = foldKey(name);
        if (seen.has(k)) throw unsupported(o.label, rel, '与同目录中的其他条目仅大小写或 Unicode 形式不同');
        seen.add(k);
        names.push(name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    names.sort();
    for (const name of names) {
      throwIfAborted(o.signal);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (rel.split('/').length > o.maxDepth) throw limitError('目录层数', o.maxDepth, 'count');
      const st = await lstat(path.join(base, rel), { bigint: true });
      if (st.isSymbolicLink()) throw unsupported(o.label, rel, '是符号链接');
      if (st.dev !== baseSt.dev) throw unsupported(o.label, rel, '位于其他磁盘卷');
      if (st.isDirectory()) {
        out.push({ rel, kind: 'dir', st });
        stack.push(rel);
      } else if (st.isFile()) {
        if (o.rejectHardlinks && st.nlink > 1n) throw unsupported(o.label, rel, '有多个硬链接');
        out.push({ rel, kind: 'file', st });
      } else {
        throw unsupported(o.label, rel, '是特殊文件');
      }
    }
  }
  return out;
}

function sumFileBytes(entries: WalkEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.kind === 'file') n += Number(e.st.size);
  return n;
}

/** 两次枚举是否完全一致（集合、类型、每项身份 / 大小 / 时间）；返回第一处不同的相对路径 */
function walkDiff(a: WalkEntry[], b: WalkEntry[]): string | null {
  const prev = new Map(a.map((e) => [e.rel, e]));
  for (const e of b) {
    const p = prev.get(e.rel);
    if (!p || p.kind !== e.kind || !sameStat(p.st, e.st)) return e.rel;
    prev.delete(e.rel);
  }
  for (const rel of prev.keys()) return rel;
  return null;
}

/** 读取并计算校验值；超过 limit 字节立即以 onOver 的错误停止 */
async function hashHandle(fh: FileHandle, limit: number, onOver: () => UserError, signal: AbortSignal | undefined, onChunk?: (chunk: Buffer) => Promise<void> | void): Promise<{ hex: string; bytes: number }> {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  for (;;) {
    throwIfAborted(signal);
    const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > limit) throw onOver();
    const chunk = buf.subarray(0, bytesRead);
    hash.update(chunk);
    if (onChunk) await onChunk(chunk);
  }
  return { hex: hash.digest('hex'), bytes };
}

/** 打开源文件：不跟随链接、不因被换成 FIFO 而阻塞；身份与时间、大小必须和枚举时一致 */
async function openSourceFile(abs: string, rel: string, expect: BigIntStats): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(abs, READ_FLAGS);
  } catch (err) {
    const c = errCode(err);
    if (c === 'ELOOP') throw unsupported('WTF', rel, '是符号链接');
    if (c === 'ENOENT') throw sourceChanged(rel);
    throw err;
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw unsupported('WTF', rel, '不是普通文件');
    if (st.nlink > 1n) throw unsupported('WTF', rel, '有多个硬链接');
    if (!sameStat(expect, st)) throw sourceChanged(rel);
    return fh;
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

/**
 * 按清单读取已写出的备份文件：必须是单一硬链接的普通文件，大小与清单一致，
 * 身份 / 时间与枚举时（expect）一致，读完后 fstat 仍一致
 */
async function hashStoredFile(abs: string, rel: string, size: number, expect: BigIntStats, signal: AbortSignal | undefined, onBytes?: (n: number) => void): Promise<string> {
  const mismatch = (what: string) => new UserError(`「${rel}」${what}`, 'backup-mismatch');
  let fh: FileHandle;
  try {
    fh = await open(abs, READ_FLAGS);
  } catch (err) {
    const c = errCode(err);
    if (c === 'ENOENT') throw mismatch('不存在');
    if (c === 'ELOOP') throw mismatch('是符号链接');
    throw err;
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw mismatch('不是普通文件');
    if (st.nlink > 1n) throw mismatch('有多个硬链接');
    if (!sameStat(expect, st)) throw mismatch('在检查期间被改动');
    if (st.size !== BigInt(size)) throw mismatch('的大小与清单不一致');
    const r = await hashHandle(fh, size, () => mismatch('的大小与清单不一致'), signal, (c) => onBytes?.(c.byteLength));
    if (r.bytes !== size) throw mismatch('的大小与清单不一致');
    if (!sameStat(expect, await fh.stat({ bigint: true }))) throw mismatch('在检查期间被改动');
    return r.hex;
  } finally {
    await fh.close();
  }
}

// ---------- 清单 ----------

interface ManifestEntry {
  path: string;
  type: 'dir' | 'file';
  size?: number;
  sha256?: string;
}

interface SnapshotManifest {
  format: typeof FORMAT;
  kind: 'snapshot';
  schema: 1;
  snapshotId: string;
  createdAt: number;
  appVersion: string;
  flavorId: number;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  /** 相对 WTF 的全部文件与目录（含空目录）；文件带大小与 SHA-256。清单不包含自身的校验值 */
  entries: ManifestEntry[];
}

function badManifest(reason: string): UserError {
  return new UserError(`备份清单不合法（${reason}）`, 'backup-manifest');
}

function parseManifest(buf: Buffer, expectedId: string, limits: BackupLimits): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw badManifest('无法解析');
  }
  if (!isPlainObject(raw) || raw.format !== FORMAT || raw.kind !== 'snapshot' || raw.schema !== 1) throw badManifest('格式或版本不受支持');
  if (raw.snapshotId !== expectedId) throw badManifest('编号与目录不符');
  if (!isCount(raw.createdAt) || typeof raw.appVersion !== 'string' || raw.appVersion.length > 64) throw badManifest('基本信息');
  if (typeof raw.flavorId !== 'number' || !Number.isInteger(raw.flavorId)) throw badManifest('游戏版本');
  if (!isCount(raw.fileCount) || !isCount(raw.dirCount) || !isCount(raw.totalBytes)) throw badManifest('统计');
  if (!Array.isArray(raw.entries) || raw.entries.length > limits.maxEntries) throw badManifest('条目列表');
  const kinds = new Map<string, 'dir' | 'file'>();
  const entries: ManifestEntry[] = [];
  let files = 0;
  let dirs = 0;
  let total = 0;
  for (const e of raw.entries as unknown[]) {
    if (!isPlainObject(e) || typeof e.path !== 'string') throw badManifest('条目');
    const segs = e.path.split('/');
    if (segs.length > limits.maxDepth || !segs.every(isSafeSegment)) throw badManifest('路径');
    const key = foldKey(e.path);
    if (kinds.has(key)) throw badManifest('路径重复');
    if (e.type === 'dir') {
      if (Object.keys(e).some((k) => k !== 'path' && k !== 'type')) throw badManifest('目录条目');
      kinds.set(key, 'dir');
      entries.push({ path: e.path, type: 'dir' });
      dirs++;
    } else if (e.type === 'file') {
      if (!isCount(e.size) || e.size > limits.maxFileBytes || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw badManifest('文件条目');
      if (Object.keys(e).some((k) => k !== 'path' && k !== 'type' && k !== 'size' && k !== 'sha256')) throw badManifest('文件条目');
      kinds.set(key, 'file');
      entries.push({ path: e.path, type: 'file', size: e.size, sha256: e.sha256 });
      files++;
      total += e.size;
    } else {
      throw badManifest('条目类型');
    }
  }
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    if (i >= 0 && kinds.get(foldKey(e.path.slice(0, i))) !== 'dir') throw badManifest('缺少上级目录');
  }
  if (files !== raw.fileCount || dirs !== raw.dirCount || total !== raw.totalBytes || total > limits.maxSnapshotBytes) throw badManifest('统计与条目不符');
  return { format: FORMAT, kind: 'snapshot', schema: 1, snapshotId: expectedId, createdAt: raw.createdAt, appVersion: raw.appVersion, flavorId: raw.flavorId, fileCount: files, dirCount: dirs, totalBytes: total, entries };
}

/** 枚举结果与清单比较：集合（大小写 / Unicode 无关）、类型、大小；返回第一处差异 */
function compareStructure(walked: WalkEntry[], entries: ManifestEntry[], ignoreFinderFiles: boolean): string | null {
  const want = new Map(entries.map((e) => [foldKey(e.path), e]));
  const seen = new Set<string>();
  for (const w of walked) {
    const key = foldKey(w.rel);
    const e = want.get(key);
    if (!e) {
      // 只有未列入清单、单一硬链接的普通 .DS_Store 可以忽略（walkTree 已拒绝链接与特殊文件）
      if (ignoreFinderFiles && w.kind === 'file' && w.st.nlink === 1n && path.posix.basename(w.rel) === IGNORED_FILE) continue;
      return `多出「${w.rel}」`;
    }
    if (e.type !== w.kind) return `「${w.rel}」的类型与清单不一致`;
    if (e.type === 'file' && w.st.size !== BigInt(e.size ?? -1)) return `「${w.rel}」的大小与清单不一致`;
    seen.add(key);
  }
  for (const e of entries) if (!seen.has(foldKey(e.path))) return `缺少「${e.path}」`;
  return null;
}

/** 快照目录顶层只允许 WTF 目录、清单与（可选）访达文件；返回第一处不符 */
function topLevelProblem(entries: WalkEntry[], allowFinderFile: boolean): string | null {
  const top = entries.filter((e) => !e.rel.includes('/'));
  const extra = top.find(
    (e) => !(e.rel === 'WTF' && e.kind === 'dir') && !(e.rel === MANIFEST_NAME && e.kind === 'file') && !(allowFinderFile && e.rel === IGNORED_FILE && e.kind === 'file'),
  );
  if (extra) return `多出「${extra.rel}」`;
  if (!top.some((e) => e.rel === 'WTF' && e.kind === 'dir')) return '缺少 WTF 目录';
  if (!top.some((e) => e.rel === MANIFEST_NAME && e.kind === 'file')) return '缺少备份清单';
  return null;
}

function wtfEntries(entries: WalkEntry[]): WalkEntry[] {
  return entries.filter((e) => e.rel.startsWith('WTF/')).map((e) => ({ ...e, rel: e.rel.slice(4) }));
}

// ---------- 备份设置 ----------

interface TargetRecord {
  flavorId: number;
  /** 启用时绑定的规范化游戏目录；只对同一 flavor + 同一目录生效 */
  root: string;
  enabled: boolean;
  containerPath: string;
  containerId: string;
  createdAt: number;
}

interface BackupConfig {
  schema: 1;
  targets: TargetRecord[];
  /** 不认识的顶层字段原样保留 */
  [key: string]: unknown;
}

const RECORD_KEYS: ReadonlySet<string> = new Set(['flavorId', 'root', 'enabled', 'containerPath', 'containerId', 'createdAt']);

function settingsError(file: string, reason: string): UserError {
  return new UserError(`无法读取 WTF 备份设置（${file}）：${reason}。为避免覆盖已有设置，已暂停修改备份设置；请修复或移走该文件后重试`, 'backup-settings');
}

function parseConfig(buf: Buffer, file: string): BackupConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw settingsError(file, '内容不是有效的 JSON');
  }
  if (!isPlainObject(raw) || raw.schema !== 1) throw settingsError(file, '格式或版本标记不正确');
  if (!Array.isArray(raw.targets) || raw.targets.length > MAX_TARGETS) throw settingsError(file, '备份记录列表不正确');
  const keys = new Set<string>();
  const targets = (raw.targets as unknown[]).map((t, i): TargetRecord => {
    const bad = () => settingsError(file, `第 ${i + 1} 条备份记录不合法`);
    if (!isPlainObject(t)) throw bad();
    const ks = Object.keys(t);
    if (ks.length !== RECORD_KEYS.size || !ks.every((k) => RECORD_KEYS.has(k))) throw bad();
    if (typeof t.flavorId !== 'number' || !Number.isInteger(t.flavorId) || t.flavorId < 0) throw bad();
    if (!isAbsPath(t.root) || !isAbsPath(t.containerPath) || typeof t.enabled !== 'boolean' || !isCount(t.createdAt)) throw bad();
    if (typeof t.containerId !== 'string' || !CONTAINER_ID_RE.test(t.containerId) || path.basename(t.containerPath) !== CONTAINER_PREFIX + t.containerId) throw bad();
    const key = `${t.flavorId}\0${t.root}`;
    if (keys.has(key)) throw settingsError(file, '存在重复的备份记录');
    keys.add(key);
    return { flavorId: t.flavorId, root: t.root, enabled: t.enabled, containerPath: t.containerPath, containerId: t.containerId, createdAt: t.createdAt };
  });
  return { ...raw, schema: 1, targets };
}

// ---------- 占用标记 ----------

interface HeldLock {
  path: string;
  id: string;
  token: string;
}

function locationBusy(p: string): UserError {
  return new UserError(
    `备份位置正被占用：存在占用标记 ${p}。可能另一个艾泽魔方正在使用此位置，或上次备份意外中断。` +
      '艾泽魔方不会自动删除该标记，它也与游戏是否运行无关。确认没有其他艾泽魔方在备份后，可在访达中删除该文件再重试；也可以重新启用备份并选择新的位置。',
    'backup-lock',
  );
}

function settingsBusy(p: string): UserError {
  return new UserError(
    `备份设置正被修改：存在占用标记 ${p}。可能另一个艾泽魔方正在修改备份设置，或上次修改意外中断。艾泽魔方不会自动删除该标记；确认没有其他艾泽魔方在运行后，可在访达中删除该文件再重试。`,
    'backup-lock',
  );
}

/** 排他创建占用标记；已存在一律保留并报错，不判断也不回收旧标记 */
async function acquireLock(p: string, info: Record<string, unknown>, busy: (p: string) => UserError): Promise<HeldLock> {
  const token = randomBytes(16).toString('hex');
  const data = Buffer.from(JSON.stringify({ format: FORMAT, kind: 'lock', token, createdAt: Date.now(), ...info }));
  try {
    const id = await writeNewFile(p, data);
    return { path: p, id, token };
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw busy(p);
    throw err;
  }
}

/** 仅当标记仍是本次创建的文件且内容含本次令牌时删除；否则保留并返回说明。不抛错 */
async function releaseLock(l: HeldLock): Promise<string | null> {
  try {
    const st = await lstat(l.path, { bigint: true });
    if (!st.isFile() || idOf(st) !== l.id) return `占用标记 ${l.path} 已被替换，无法确认属于本次任务，已保留，请在访达中检查`;
    const buf = await readBounded(l.path, MAX_LOCK_BYTES, '占用标记');
    if (!buf || !buf.toString('utf8').includes(l.token)) return `占用标记 ${l.path} 的内容已被改动，已保留，请在访达中检查`;
    if (!(await unlinkIfSame(l.path, l.id))) return `无法删除占用标记 ${l.path}，已保留，请在访达中检查`;
    await syncDir(path.dirname(l.path));
    return null;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return `占用标记 ${l.path} 已不存在，请检查备份位置是否被改动`;
    return `无法确认占用标记 ${l.path}（${errorMessage(err)}），已保留，请在访达中检查`;
  }
}

async function assertLockHeld(l: HeldLock): Promise<void> {
  const st = await lstat(l.path, { bigint: true }).catch(() => null);
  if (!st || !st.isFile() || idOf(st) !== l.id) throw new UserError(`备份位置的占用标记 ${l.path} 被改动，已停止`, 'backup-lock');
}

interface ConfigChange<T> {
  /** null 表示无需写入 */
  next: BackupConfig | null;
  value: T;
  /** 保存失败时撤回本次已创建的内容；无法安全撤回时返回保留现场的说明 */
  undo?: () => Promise<string | null>;
}

class ConfigStore {
  constructor(
    private readonly file: string,
    private readonly step: StepFn,
  ) {}

  /** 缺失视为空设置；读取失败或内容不合法一律报错（不改写） */
  async load(): Promise<BackupConfig> {
    let buf: Buffer | null;
    try {
      buf = await readBounded(this.file, MAX_SETTINGS_BYTES, '备份设置文件');
    } catch (err) {
      const c = errCode(err);
      throw settingsError(this.file, err instanceof UserError ? '文件类型、大小或硬链接数不正确，或读取期间被改动' : c ? `读取失败（${c}）` : '读取失败');
    }
    if (!buf) return { schema: 1, targets: [] };
    return parseConfig(buf, this.file);
  }

  /**
   * 在跨实例排他标记内执行 load→修改→save。标记总是在收尾时释放；
   * 已保存但标记无法释放时明确报告“设置已保存”，不当作成功也不假称未保存。
   */
  async transact<T>(fn: (cfg: BackupConfig) => Promise<ConfigChange<T>>): Promise<T> {
    const lock = await acquireLock(`${this.file}.lock`, { kind: 'settings' }, settingsBusy);
    let failure: unknown = null;
    let saved = false;
    let value: T | undefined;
    try {
      const r = await fn(await this.load());
      value = r.value;
      if (r.next) {
        try {
          await this.save(r.next);
        } catch (err) {
          const left = r.undo ? await r.undo().catch(() => null) : null;
          throw withNotes(err, left ? [left] : []);
        }
        saved = true;
      }
    } catch (err) {
      failure = err ?? new Error('备份设置写入失败');
    }
    await this.step('before-lock-release').catch(() => undefined);
    const note = await releaseLock(lock);
    if (failure) throw withNotes(failure, note ? [note] : []);
    if (note) {
      throw new UserError(`${saved ? '备份设置已保存' : '备份设置未改变'}，但设置的占用标记未能正常释放：${note}。处理该文件之前无法再次修改备份设置`, 'backup-lock');
    }
    return value as T;
  }

  private async save(next: BackupConfig): Promise<void> {
    const text = JSON.stringify(next, null, 1);
    if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) throw new UserError('备份设置将超过大小上限，未保存', 'backup-limit');
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    const id = await writeNewFile(tmp, Buffer.from(text, 'utf8'));
    try {
      await rename(tmp, this.file);
    } catch (err) {
      await unlinkIfSame(tmp, id);
      throw err;
    }
    await syncDir(path.dirname(this.file));
  }
}

// ---------- 本次创建的临时内容 ----------

/**
 * 记录本次在 .partial 目录中创建的每个条目及其身份。清理时先复核容器各级身份，
 * 每次删除前复核临时根与各级相对父目录仍是本次创建的目录（不经由被替换的父路径）；发现变化即停止并保留现场。不递归删除。
 */
class PartialTracker {
  private readonly created: { rel: string; kind: 'dir' | 'file'; id: string }[] = [];
  private readonly dirIds = new Map<string, string>();

  constructor(
    readonly base: string,
    private readonly container: string,
    private readonly containerChain: string[],
  ) {}

  abs(rel: string): string {
    return rel ? path.join(this.base, ...rel.split('/')) : this.base;
  }

  async mkdir(rel: string): Promise<void> {
    const p = this.abs(rel);
    await mkdir(p, { mode: 0o700 });
    const st = await lstat(p, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError('备份临时目录被替换，已停止', 'backup-path-changed');
    this.created.push({ rel, kind: 'dir', id: idOf(st) });
    this.dirIds.set(rel, idOf(st));
  }

  async createFile(rel: string): Promise<FileHandle> {
    const fh = await open(this.abs(rel), CREATE_FLAGS, 0o600);
    try {
      this.created.push({ rel, kind: 'file', id: idOf(await fh.stat({ bigint: true })) });
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
    return fh;
  }

  async writeFile(rel: string, data: Uint8Array): Promise<void> {
    const fh = await this.createFile(rel);
    try {
      await writeAll(fh, data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** 容器、临时根与 rel 的各级父目录是否仍是登记的身份 */
  private async parentsIntact(rel: string): Promise<boolean> {
    const cst = await lstat(this.container, { bigint: true }).catch(() => null);
    if (!cst || cst.isSymbolicLink() || !cst.isDirectory() || idOf(cst) !== this.containerChain[0]) return false;
    if (rel === '') return true;
    const segs = rel.split('/');
    for (let i = 0; i < segs.length; i++) {
      const anc = segs.slice(0, i).join('/');
      const want = this.dirIds.get(anc);
      if (!want) return false;
      const st = await lstat(this.abs(anc), { bigint: true }).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || idOf(st) !== want) return false;
    }
    return true;
  }

  /** 倒序删除本次创建且身份仍匹配的条目；返回 null 表示全部清理，否则返回保留现场的说明。不抛错 */
  async cleanup(): Promise<string | null> {
    if (this.created.length === 0) return null;
    const moved = `临时目录 ${this.base} 或其上级在清理前被移动或替换，已停止清理并保留现场，请在访达中检查`;
    const chain = await chainIds(this.container).catch(() => null);
    if (!chain || !sameChain(chain, this.containerChain)) return moved;
    let kept = false;
    for (const c of [...this.created].reverse()) {
      if (!(await this.parentsIntact(c.rel))) return moved;
      const p = this.abs(c.rel);
      try {
        const st = await lstat(p, { bigint: true });
        if (st.isSymbolicLink() || idOf(st) !== c.id || (c.kind === 'dir' ? !st.isDirectory() : !st.isFile())) {
          kept = true;
          continue;
        }
        if (c.kind === 'dir') await rmdir(p);
        else await unlink(p);
      } catch (err) {
        if (errCode(err) !== 'ENOENT') kept = true;
      }
    }
    await syncDir(this.container);
    return kept ? `未完成的临时目录中有无法确认属于本次备份的内容，已保留，请在访达中检查：${this.base}` : null;
  }
}

// ---------- 备份位置扫描 ----------

interface ContainerScan {
  snapshots: BackupSnapshotInfo[];
  anomalies: BackupAnomaly[];
  usage: BackupUsage;
}

interface ScanContext {
  limits: BackupLimits;
  /** 本实例正在持有的占用标记身份，不列为异常 */
  ownLockId: string | null;
  /** 本实例正在写入的临时目录名，计入份数与占用但不列为异常 */
  ownPartial: string | null;
  lastVerify(snapshotId: string): BackupVerifyRecord | null;
  /** 备份位置登记的游戏版本；清单的 flavorId 必须与之一致 */
  flavorId: number;
  signal?: AbortSignal;
}

function blankSnapshot(id: string, status: BackupSnapshotStatus, reason: string, actualBytes: number, lastVerify: BackupVerifyRecord | null): BackupSnapshotInfo {
  return { id, createdAt: 0, appVersion: '', flavorId: 0, fileCount: 0, dirCount: 0, totalBytes: 0, actualBytes, status, reason, lastVerify };
}

function manifestSnapshot(m: SnapshotManifest, actualBytes: number, status: BackupSnapshotStatus, reason: string | null, lastVerify: BackupVerifyRecord | null): BackupSnapshotInfo {
  return { id: m.snapshotId, createdAt: m.createdAt, appVersion: m.appVersion, flavorId: m.flavorId, fileCount: m.fileCount, dirCount: m.dirCount, totalBytes: m.totalBytes, actualBytes, status, reason, lastVerify };
}

/** 取消与扫描预算耗尽必须向上传递，不能被当作某一项的普通错误 */
function rethrowControl(err: unknown): void {
  if (isCancelled(err) || isScanLimit(err)) throw err;
}

/** 检查一份已发布备份的结构（不计算内容校验值）：集合、类型、大小、硬链接，并统计实际占用 */
async function scanSnapshot(abs: string, id: string, ctx: ScanContext, budget: { left: number }): Promise<{ info: BackupSnapshotInfo; confirmed: boolean }> {
  const lv = ctx.lastVerify(id);
  let entries: WalkEntry[];
  try {
    entries = await walkTree(abs, { maxEntries: ctx.limits.maxEntries + SNAPSHOT_EXTRA_ENTRIES, maxDepth: ctx.limits.maxDepth + 1, rejectHardlinks: true, budget, signal: ctx.signal, label: '备份' });
  } catch (err) {
    rethrowControl(err);
    return { info: blankSnapshot(id, 'invalid', errorMessage(err), 0, lv), confirmed: false };
  }
  const bytes = sumFileBytes(entries);
  let manifest: SnapshotManifest;
  try {
    const buf = await readBounded(path.join(abs, MANIFEST_NAME), ctx.limits.maxManifestBytes, '备份清单', ctx.signal);
    if (!buf) return { info: blankSnapshot(id, 'invalid', '缺少备份清单', bytes, lv), confirmed: true };
    manifest = parseManifest(buf, id, ctx.limits);
  } catch (err) {
    rethrowControl(err);
    return { info: blankSnapshot(id, 'invalid', errorMessage(err), bytes, lv), confirmed: true };
  }
  if (manifest.flavorId !== ctx.flavorId) return { info: manifestSnapshot(manifest, bytes, 'invalid', '清单的游戏版本与备份位置不符', lv), confirmed: true };
  const top = topLevelProblem(entries, true);
  if (top) return { info: manifestSnapshot(manifest, bytes, 'mismatch', top, lv), confirmed: true };
  const diff = compareStructure(wtfEntries(entries), manifest.entries, true);
  return { info: manifestSnapshot(manifest, bytes, diff ? 'mismatch' : 'structure-ok', diff, lv), confirmed: true };
}

/** 统计一个异常条目的实际占用；无法完整统计（含链接、特殊文件、多硬链接）时返回 null */
async function measure(abs: string, st: BigIntStats, ctx: ScanContext, budget: { left: number }): Promise<number | null> {
  if (st.isFile()) return st.nlink > 1n ? null : Number(st.size);
  if (!st.isDirectory()) return null;
  try {
    return sumFileBytes(await walkTree(abs, { maxEntries: Number.MAX_SAFE_INTEGER, maxDepth: ctx.limits.maxDepth + 2, rejectHardlinks: true, budget, signal: ctx.signal, label: '备份位置' }));
  } catch (err) {
    rethrowControl(err);
    return null;
  }
}

/**
 * 有界扫描备份位置的直接条目与每份备份的结构（lstat，不读取旧文件内容），统计实际份数与占用。
 * 未完成目录、外来条目、他人的占用标记、无法读取的条目都列为异常；任何异常都会阻止新建，但扫描不删除、不修改任何内容。
 * 取消会立即向上抛出。
 */
async function scanContainer(container: string, ctx: ScanContext): Promise<ContainerScan> {
  const { limits } = ctx;
  // 每份（含本次与一份余量）计入快照目录名、WTF 负载与固定开销，再加顶层固定条目；限制在安全整数内
  const perSnapshot = limits.maxEntries + SNAPSHOT_EXTRA_ENTRIES + 1;
  const budget = { left: Math.min(Number.MAX_SAFE_INTEGER, perSnapshot * (limits.maxSnapshots + 1) + CONTAINER_FIXED_ENTRIES) };
  const snapshots: BackupSnapshotInfo[] = [];
  const anomalies: BackupAnomaly[] = [];
  let count = 0;
  let bytes = 0;
  let confirmed = true;
  const note = (name: string, kind: BackupAnomaly['kind'], message: string) => anomalies.push({ name, kind, message });
  try {
    const names: string[] = [];
    throwIfAborted(ctx.signal);
    const dir = await opendir(container);
    try {
      for (let d = await dir.read(); d !== null; d = await dir.read()) {
        throwIfAborted(ctx.signal);
        if (budget.left <= 0) throw scanLimitError();
        budget.left--;
        names.push(d.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    names.sort();
    for (const name of names) {
      throwIfAborted(ctx.signal);
      const abs = path.join(container, name);
      let st: BigIntStats;
      try {
        st = await lstat(abs, { bigint: true });
      } catch (err) {
        if (errCode(err) === 'ENOENT') continue;
        confirmed = false;
        note(name, 'unreadable', `无法读取：${errorMessage(err)}`);
        continue;
      }
      if (st.isSymbolicLink()) {
        note(name, 'foreign', '符号链接不属于艾泽魔方备份');
        continue;
      }
      if (name === MARKER_NAME || name === IGNORED_FILE) {
        if (st.isFile() && st.nlink === 1n) bytes += Number(st.size);
        else note(name, 'unreadable', '不是单一硬链接的普通文件');
        continue;
      }
      if (name === LOCK_NAME) {
        if (st.isFile() && st.nlink === 1n) bytes += Number(st.size);
        if (!st.isFile() || idOf(st) !== ctx.ownLockId) note(name, 'lock', '存在占用标记：其他艾泽魔方可能正在使用此位置，或上次备份意外中断');
        continue;
      }
      if (st.isDirectory() && SNAPSHOT_ID_RE.test(name)) {
        count++;
        const r = await scanSnapshot(abs, name, ctx, budget);
        bytes += r.info.actualBytes;
        if (!r.confirmed) confirmed = false;
        snapshots.push(r.info);
        continue;
      }
      const isPartial = st.isDirectory() && name.startsWith(PARTIAL_PREFIX) && SNAPSHOT_ID_RE.test(name.slice(PARTIAL_PREFIX.length));
      if (isPartial) count++;
      const size = await measure(abs, st, ctx, budget);
      if (size === null) confirmed = false;
      else bytes += size;
      if (isPartial && name === ctx.ownPartial) continue;
      if (isPartial) note(name, 'incomplete', '未完成的备份（可能是中断遗留），不能当作可用备份');
      else note(name, 'foreign', '不认识的内容，艾泽魔方不会使用或删除它');
    }
  } catch (err) {
    if (!isScanLimit(err)) throw err;
    confirmed = false;
    note('', 'scan-limit', '备份位置中的条目过多，已停止扫描，占用无法确认');
  }
  snapshots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { snapshots, anomalies, usage: { count, bytes, maxCount: limits.maxSnapshots, maxBytes: limits.maxTotalBytes, confirmed } };
}

/** 新建前的阻塞原因；null 表示可以新建 */
function blockingReason(scan: ContainerScan, limits: BackupLimits, container: string): UserError | null {
  const handle = `艾泽魔方不会自动删除或修改这些内容，请在访达中检查 ${container}，或重新启用备份并选择新的位置`;
  if (scan.anomalies.length > 0) return new UserError(`备份位置中有 ${scan.anomalies.length} 项需要处理（${scan.anomalies[0].message}）。${handle}`, 'backup-container');
  const bad = scan.snapshots.find((s) => s.status !== 'structure-ok');
  if (bad) return new UserError(`备份 ${bad.id} 与其清单不一致（${bad.reason ?? '无法确认'}）。${handle}`, 'backup-container');
  if (!scan.usage.confirmed) return new UserError(`无法确认备份位置的实际占用。${handle}`, 'backup-container');
  // 达到上限是状态而不是失败：查看列表与新建前共用中性提示
  const full = (what: string) => new UserError(`已达到${what}上限，不能新建备份；旧备份均保留，请在访达中整理 ${container}，或选择新的位置`, 'backup-limit');
  if (scan.usage.count >= limits.maxSnapshots) return full(`备份份数（${limits.maxSnapshots} 份）`);
  if (scan.usage.bytes >= limits.maxTotalBytes) return full(`备份位置总占用（${fmtBytes(limits.maxTotalBytes)}）`);
  return null;
}

// ---------- 服务 ----------

interface ActiveTask {
  info: BackupTaskInfo;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

interface ContainerCtx {
  path: string;
  chain: string[];
}

interface SourceCtx {
  root: string;
  wtf: string;
  rootChain: string[];
  wtfId: string;
}

function flavorArg(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e7) throw new UserError('游戏版本参数无效');
  return v;
}

function pathArg(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || v.includes('\0') || !path.isAbsolute(v)) throw new UserError(`${what}参数无效`);
  return v;
}

function snapshotArg(v: unknown): string {
  if (typeof v !== 'string' || !SNAPSHOT_ID_RE.test(v)) throw new UserError('备份编号无效');
  return v;
}

export class WtfBackupService {
  readonly limits: BackupLimits;
  private readonly config: ConfigStore;
  private active: ActiveTask | null = null;
  /** 本实例正在修改备份设置（与任务互斥） */
  private configuring: Promise<unknown> | null = null;
  private closed = false;
  private lastEmit = 0;
  /** 本实例在某个备份位置持有的占用标记与临时目录，state 据此不把它们列为异常 */
  private held: { container: string; lockId: string; partial: string | null } | null = null;
  /** 本次运行期间的校验结果（备份位置 + 编号）；不持久化 */
  private readonly verified = new Map<string, BackupVerifyRecord>();

  constructor(private readonly opts: WtfBackupOptions) {
    this.limits = resolveLimits(opts.limits);
    this.config = new ConfigStore(opts.settingsFile, (name, detail) => this.step(name, detail));
  }

  // ---------- 通知与任务占位 ----------

  private emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    try {
      const r = this.opts.onChange?.() as unknown;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // 监听方的异常不影响任务
    }
  }

  private async step(name: BackupStep, detail?: string): Promise<void> {
    await this.opts.hooks?.step?.(name, detail);
  }

  private busyError(): UserError {
    if (this.closed) return new UserError('应用正在退出，暂不能进行备份操作', 'backup-busy');
    return new UserError('已有备份或校验任务正在进行，请等待完成或取消后再试', 'backup-busy');
  }

  /** 同步占位：同一时刻全局只有一个备份 / 校验任务，且不与设置修改并行 */
  private begin(kind: BackupTaskKind, flavorId: number, root: string, snapshotId: string | null): ActiveTask {
    if (this.closed || this.active || this.configuring) throw this.busyError();
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const task: ActiveTask = {
      info: { id: newTaskId(), kind, flavorId, root, snapshotId, phase: 'preparing', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, cancelling: false, startedAt: Date.now() },
      controller: new AbortController(),
      done,
      finish,
    };
    this.active = task;
    this.emit(true);
    return task;
  }

  private end(task: ActiveTask): void {
    if (this.active === task) this.active = null;
    task.finish();
    this.emit(true);
  }

  private phase(task: ActiveTask, phase: BackupTaskInfo['phase']): void {
    task.info.phase = phase;
    this.emit(true);
  }

  /** 设置修改与任务互斥；同步占位 */
  private async exclusiveConfig<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed || this.active || this.configuring) throw this.busyError();
    const p = fn();
    this.configuring = p;
    this.emit(true);
    try {
      return await p;
    } finally {
      this.configuring = null;
      this.emit(true);
    }
  }

  /** 先给 before-lock-release 测试钩子机会（异常忽略），再释放占用标记；不抛错 */
  private async release(lock: HeldLock): Promise<string | null> {
    await this.step('before-lock-release').catch(() => undefined);
    return releaseLock(lock);
  }

  // ---------- 目标与位置 ----------

  /** 当前绑定必须与界面期望的目录一致，否则拒绝（不转向新目录） */
  private async checkTarget(flavorId: number, expected: string): Promise<string> {
    const root = await this.opts.resolveRoot(flavorId);
    if (root !== expected) throw new UserError('游戏目录绑定已变更，未做任何改动，请刷新后重试', 'target');
    return root;
  }

  private async enabledRecord(flavorId: number, root: string): Promise<TargetRecord> {
    const cfg = await this.config.load();
    const rec = cfg.targets.find((t) => t.flavorId === flavorId && t.root === root);
    if (!rec || !rec.enabled) throw new UserError('当前游戏目录尚未启用 WTF 配置备份', 'backup-disabled');
    return rec;
  }

  private verifyKey(container: string, id: string): string {
    return `${container}\0${id}`;
  }

  /** 校验已登记的备份位置：真实目录、规范路径未变、名称与标记一致；返回路径与各级身份 */
  private async openContainer(rec: TargetRecord, signal?: AbortSignal): Promise<ContainerCtx> {
    const p = rec.containerPath;
    let st: BigIntStats;
    try {
      st = await lstat(p, { bigint: true });
    } catch (err) {
      if (errCode(err) === 'ENOENT') throw new UserError(`找不到备份位置 ${p}。如果它在外置磁盘上，请连接后重试；也可以重新启用备份并选择新的位置`, 'backup-container');
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(`备份位置 ${p} 已不是普通文件夹，已停止使用`, 'backup-container');
    if ((await realpath(p)) !== p) throw new UserError(`备份位置 ${p} 的路径已变化（可能被移动或替换为链接），已停止使用`, 'backup-container');
    let marker: Buffer | null = null;
    try {
      marker = await readBounded(path.join(p, MARKER_NAME), MAX_MARKER_BYTES, '备份位置标记', signal);
    } catch (err) {
      if (isCancelled(err)) throw err;
    }
    let ok = false;
    if (marker) {
      try {
        const m = JSON.parse(marker.toString('utf8')) as unknown;
        ok = isPlainObject(m) && m.format === FORMAT && m.kind === 'container' && m.schema === 1 && m.containerId === rec.containerId && m.flavorId === rec.flavorId;
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new UserError(`备份位置 ${p} 的标记缺失或不符，艾泽魔方不会使用它；请重新启用备份并选择新的位置`, 'backup-container');
    return { path: p, chain: await chainIds(p) };
  }

  private async recheckContainer(ctr: ContainerCtx, rec: TargetRecord, signal?: AbortSignal): Promise<void> {
    const again = await this.openContainer(rec, signal);
    if (!sameChain(again.chain, ctr.chain)) throw new UserError(`备份位置 ${ctr.path} 或其上级目录在任务期间被替换，已停止`, 'backup-path-changed');
  }

  /**
   * 位置规则：target（规范路径）不能等于或位于任何已绑定游戏目录（含其 WTF）或应用数据目录之内；
   * existing=true 时还不能包含它们。按各级 dev:ino 与大小写无关的路径共同判断；不读取 WTF 内容。
   * 只拒绝包含关系，同一上级目录下的其他位置（例如桌面）不受影响。
   */
  private async assertLocation(target: string, currentRoot: string, existing: boolean): Promise<void> {
    const protectedPaths = [...new Set([currentRoot, ...(await this.opts.listBoundRoots()), this.opts.appDataDir])];
    const ids = new Set<string>();
    const reals: string[] = [];
    for (const p of protectedPaths) {
      if (!path.isAbsolute(p)) continue;
      reals.push(path.resolve(p));
      try {
        const real = await realpath(p);
        reals.push(real);
        ids.add(idOf(await lstat(real, { bigint: true })));
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw new UserError(`无法确认备份位置与游戏目录、应用数据目录的关系（${errorMessage(err)}），已停止`, 'backup-location');
      }
    }
    const reject = () => new UserError('备份位置不能在游戏目录或艾泽魔方数据目录之内，也不能包含它们，请选择其他位置', 'backup-location');
    const chain = await chainIds(target);
    if (chain.some((id) => ids.has(id))) throw reject();
    for (const r of reals) {
      if (within(target, r)) throw reject();
      if (existing && within(r, target)) throw reject();
    }
    if (existing) {
      for (const r of reals) {
        const rc = await chainIds(r).catch(() => [] as string[]);
        if (rc.includes(chain[0])) throw reject();
      }
    }
  }

  private async openSource(root: string): Promise<SourceCtx> {
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      throw new UserError(`游戏目录不存在或无法访问：${root}`, 'backup-source');
    }
    if (real !== root) throw new UserError('游戏目录的路径已变化（可能被移动或替换为链接），请重新绑定后再备份', 'backup-source');
    const rootChain = await chainIds(root);
    const wtf = path.join(root, 'WTF');
    let st: BigIntStats;
    try {
      st = await lstat(wtf, { bigint: true });
    } catch (err) {
      if (errCode(err) === 'ENOENT') throw new UserError('该游戏目录下没有 WTF 文件夹，没有可备份的配置', 'backup-source');
      throw err;
    }
    if (st.isSymbolicLink()) throw unsupported('游戏目录', 'WTF', '是符号链接');
    if (!st.isDirectory()) throw unsupported('游戏目录', 'WTF', '不是文件夹');
    return { root, wtf, rootChain, wtfId: idOf(st) };
  }

  private async recheckSource(src: SourceCtx): Promise<void> {
    const chain = await chainIds(src.root).catch(() => null);
    const st = await lstat(src.wtf, { bigint: true }).catch(() => null);
    if (!chain || !sameChain(chain, src.rootChain) || !st || idOf(st) !== src.wtfId) {
      throw new UserError('备份期间游戏目录或其 WTF 文件夹被移动或替换，本次备份未完成', 'backup-source-changed');
    }
  }

  // ---------- 设置 ----------

  /**
   * 用户选择保存位置后启用：在 pickedParent 下排他新建专属容器并写入标记，再保存启用记录。
   * 取得设置标记后、创建前与提交前都复核当前绑定与所选目录各级身份；新容器按已存在位置再做一次位置检查。
   * 只对当前 flavor + 当前绑定目录生效；用户取消选择时 main 不调用本方法。不读取 WTF。
   */
  async configure(flavorId: number, expectedRoot: string, pickedParent: string): Promise<BackupState> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    const picked = pathArg(pickedParent, '保存位置');
    await this.exclusiveConfig(async () => {
      const root = await this.checkTarget(f, expected);
      let parent: string;
      try {
        parent = await realpath(picked);
      } catch {
        throw new UserError('选择的保存位置不存在或无法访问', 'backup-location');
      }
      const pst = await lstat(parent, { bigint: true });
      if (!pst.isDirectory()) throw new UserError('请选择一个文件夹作为保存位置', 'backup-location');
      const parentChain = await chainIds(parent);
      await this.assertLocation(parent, root, false);
      const parentMoved = () => new UserError('所选保存位置或其上级目录在启用过程中被移动或替换，未启用备份，请重新选择', 'backup-path-changed');
      const checkParent = async () => {
        const now = await chainIds(parent).catch(() => null);
        if (!now || !sameChain(now, parentChain)) throw parentMoved();
      };
      await this.config.transact(async (cfg): Promise<ConfigChange<undefined>> => {
        await this.checkTarget(f, expected);
        await checkParent();
        await this.step('configure-before-create');
        await checkParent();
        const containerId = randomBytes(8).toString('hex');
        const container = path.join(parent, CONTAINER_PREFIX + containerId);
        try {
          await mkdir(container, { mode: 0o700 });
        } catch (err) {
          if (errCode(err) === 'EEXIST') throw new UserError('保存位置中已有同名文件夹，未做改动，请重试', 'backup-location');
          throw err;
        }
        const cst = await lstat(container, { bigint: true });
        const createdAt = Date.now();
        const markerPath = path.join(container, MARKER_NAME);
        let markerId: string | null = null;
        // 撤回前复核新容器与所选目录各级身份；不吻合就不经由可能被替换的路径删除任何东西，保留现场
        const undo = async (): Promise<string | null> => {
          const kept = `未启用备份；新建的备份位置已保留于 ${container}，请在访达中检查后自行处理`;
          const chain = await chainIds(container).catch(() => null);
          if (!chain || chain[0] !== idOf(cst) || !sameChain(chain.slice(1), parentChain)) return kept;
          if (markerId && !(await unlinkIfSame(markerPath, markerId))) return kept;
          return (await rmdir(container).then(() => true, () => false)) ? null : kept;
        };
        try {
          if (cst.isSymbolicLink() || !cst.isDirectory()) throw new UserError('新建的备份位置被替换，已停止', 'backup-path-changed');
          markerId = await writeNewFile(markerPath, Buffer.from(JSON.stringify({ format: FORMAT, kind: 'container', schema: 1, containerId, flavorId: f, createdAt }, null, 1)));
          await syncDir(container);
          await syncDir(parent);
          await this.step('configure-before-commit');
          // 提交前复核：绑定未变、所选目录与新容器的各级身份未变、新容器满足位置规则
          await this.checkTarget(f, expected);
          const cchain = await chainIds(container).catch(() => null);
          if (!cchain || cchain[0] !== idOf(cst) || !sameChain(cchain.slice(1), parentChain)) throw parentMoved();
          await this.assertLocation(container, root, true);
          const targets = cfg.targets.filter((t) => !(t.flavorId === f && t.root === root));
          targets.push({ flavorId: f, root, enabled: true, containerPath: container, containerId, createdAt });
          if (targets.length > MAX_TARGETS) throw new UserError('备份记录过多，未保存', 'backup-limit');
          return { next: { ...cfg, targets }, value: undefined, undo };
        } catch (err) {
          const left = await undo().catch(() => `未启用备份；新建的备份位置已保留于 ${container}，请在访达中检查后自行处理`);
          throw withNotes(err, left ? [left] : []);
        }
      });
    });
    return this.state(f, expected);
  }

  /** 关闭当前目录的备份：只改设置，不访问 WTF，不删除任何备份。取得设置标记后复核绑定 */
  async disable(flavorId: number, expectedRoot: string): Promise<BackupState> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    await this.exclusiveConfig(async () => {
      await this.checkTarget(f, expected);
      await this.config.transact(async (cfg): Promise<ConfigChange<undefined>> => {
        const root = await this.checkTarget(f, expected);
        const rec = cfg.targets.find((t) => t.flavorId === f && t.root === root);
        if (!rec || !rec.enabled) return { next: null, value: undefined };
        const targets = cfg.targets.map((t) => (t === rec ? { ...t, enabled: false } : t));
        return { next: { ...cfg, targets }, value: undefined };
      });
    });
    return this.state(f, expected);
  }

  // ---------- 状态 ----------

  private activeInfo(): BackupTaskInfo | null {
    return this.active ? { ...this.active.info } : null;
  }

  private scanCtx(container: string, flavorId: number, signal?: AbortSignal): ScanContext {
    const held = this.held && this.held.container === container ? this.held : null;
    return {
      limits: this.limits,
      ownLockId: held?.lockId ?? null,
      ownPartial: held?.partial ?? null,
      lastVerify: (id) => this.verified.get(this.verifyKey(container, id)) ?? null,
      flavorId,
      signal,
    };
  }

  /** 当前活动任务的内存快照（克隆）；不读设置、不访问磁盘、不查绑定，供高频进度推送使用 */
  taskState(): BackupTaskInfo | null {
    return this.activeInfo();
  }

  /** 只读：未启用时只读设置文件；启用时只读已登记的备份位置，不访问 WTF，不创建任何目录 */
  async state(flavorId: number, expectedRoot: string): Promise<BackupState> {
    const f = flavorArg(flavorId);
    const root = await this.checkTarget(f, pathArg(expectedRoot, '目标目录'));
    // 每个返回分支都取返回时的最新任务状态
    const done = (s: Omit<BackupState, 'activeTask'>): BackupState => ({ ...s, activeTask: this.activeInfo() });
    const base: Omit<BackupState, 'activeTask'> = { flavorId: f, root, status: 'disabled', containerPath: null, snapshots: [], anomalies: [], usage: null, canCreate: false, error: null, limits: { ...this.limits } };
    let cfg: BackupConfig;
    try {
      cfg = await this.config.load();
    } catch (err) {
      return done({ ...base, status: 'unavailable', error: errorMessage(err) });
    }
    const rec = cfg.targets.find((t) => t.flavorId === f && t.root === root);
    if (!rec) return done(base);
    if (!rec.enabled) return done({ ...base, containerPath: rec.containerPath });
    try {
      const ctr = await this.openContainer(rec);
      const scan = await scanContainer(ctr.path, this.scanCtx(ctr.path, rec.flavorId));
      const block = blockingReason(scan, this.limits, ctr.path);
      const idle = !this.active && !this.configuring && !this.closed;
      return done({ ...base, status: 'ready', containerPath: ctr.path, snapshots: scan.snapshots, anomalies: scan.anomalies, usage: scan.usage, canCreate: block === null && idle, error: block ? block.message : null });
    } catch (err) {
      return done({ ...base, status: 'unavailable', containerPath: rec.containerPath, error: errorMessage(err) });
    }
  }

  // ---------- 备份 ----------

  /** 手动备份；Promise 在文件句柄关闭、临时内容收尾、占用标记释放之后才结束。已受理的任务固定原目录 */
  async run(flavorId: number, expectedRoot: string): Promise<BackupRunResult> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    const task = this.begin('run', f, expected, null);
    try {
      return await this.doRun(task);
    } finally {
      this.end(task);
    }
  }

  private async doRun(task: ActiveTask): Promise<BackupRunResult> {
    const { info } = task;
    const signal = task.controller.signal;
    const root = await this.checkTarget(info.flavorId, info.root);
    const rec = await this.enabledRecord(info.flavorId, root);
    const ctr = await this.openContainer(rec, signal);
    await this.assertLocation(ctr.path, root, true);
    throwIfAborted(signal);
    const lock = await acquireLock(path.join(ctr.path, LOCK_NAME), { taskKind: 'run', taskId: info.id, appVersion: this.opts.appVersion }, locationBusy);
    this.held = { container: ctr.path, lockId: lock.id, partial: null };
    const box: { partial: PartialTracker | null } = { partial: null };
    let snapshot: BackupSnapshotInfo | null = null;
    let failure: unknown = null;
    try {
      snapshot = await this.copySnapshot(task, rec, ctr, lock, (p) => {
        box.partial = p;
        if (this.held) this.held.partial = path.basename(p.base);
      });
    } catch (err) {
      failure = err ?? new Error('备份未完成');
    }
    const notes: string[] = [];
    const tracker = box.partial;
    if (failure && tracker) {
      this.phase(task, 'cleanup');
      try {
        const left = await tracker.cleanup();
        if (left) notes.push(left);
      } catch (err) {
        notes.push(`清理临时目录时出错（${errorMessage(err)}），已保留：${tracker.base}`);
      }
    }
    const lockNote = await this.release(lock);
    this.held = null;
    if (lockNote) notes.push(lockNote);
    if (failure || !snapshot) throw withNotes(failure ?? new Error('备份未完成'), notes);
    return { taskId: info.id, snapshot, warnings: notes };
  }

  private async copySnapshot(task: ActiveTask, rec: TargetRecord, ctr: ContainerCtx, lock: HeldLock, onPartial: (p: PartialTracker) => void): Promise<BackupSnapshotInfo> {
    const { info } = task;
    const signal = task.controller.signal;
    const limits = this.limits;
    const root = info.root;

    // 1. 备份位置的实际占用（不信任清单声明）
    const before = await scanContainer(ctr.path, this.scanCtx(ctr.path, rec.flavorId, signal));
    const block = blockingReason(before, limits, ctr.path);
    if (block) throw block;
    const budget = Math.min(limits.maxSnapshotBytes, limits.maxTotalBytes - before.usage.bytes);

    // 2. 有界枚举源
    const src = await this.openSource(root);
    await this.step('source-enumerate');
    const walkOpts: WalkOptions = { maxEntries: limits.maxEntries, maxDepth: limits.maxDepth, rejectHardlinks: true, signal, label: 'WTF' };
    const entries = await walkTree(src.wtf, walkOpts);
    const files = entries.filter((e) => e.kind === 'file');
    for (const e of files) if (Number(e.st.size) > limits.maxFileBytes) throw limitError(`单个文件（「${e.rel}」）`, limits.maxFileBytes, 'bytes');
    const statBytes = sumFileBytes(entries);
    if (statBytes > budget) throw limitError('本次备份可用空间', budget, 'bytes');
    info.filesTotal = files.length;
    info.bytesTotal = statBytes;
    this.phase(task, 'copying');

    // 3. 复制到本次专属的临时目录，边读边算校验值，按实际字节计入上限
    const createdAt = Date.now();
    const id = newSnapshotId(new Date(createdAt));
    const partial = new PartialTracker(path.join(ctr.path, PARTIAL_PREFIX + id), ctr.path, ctr.chain);
    onPartial(partial);
    await partial.mkdir('');
    await partial.mkdir('WTF');
    const hashes = new Map<string, string>();
    for (const e of entries) {
      throwIfAborted(signal);
      if (e.kind === 'dir') {
        await partial.mkdir(`WTF/${e.rel}`);
        continue;
      }
      await this.step('copy-file', e.rel);
      hashes.set(e.rel, await this.copyFile(task, src.wtf, e, partial, budget));
      info.filesDone++;
      this.emit(false);
    }

    // 4. 源复核：集合与每项身份未变，源内容重算一致（读取所用的源文件身份与枚举一致）
    this.phase(task, 'rechecking');
    await this.step('source-recheck');
    await this.assertSourceUnchanged(src, entries, walkOpts);
    for (const e of files) {
      const fh = await openSourceFile(path.join(src.wtf, ...e.rel.split('/')), e.rel, e.st);
      try {
        const r = await hashHandle(fh, Number(e.st.size), () => sourceChanged(e.rel), signal);
        if (r.bytes !== Number(e.st.size) || r.hex !== hashes.get(e.rel)) throw sourceChanged(e.rel);
        if (!sameStat(e.st, await fh.stat({ bigint: true }))) throw sourceChanged(e.rel);
      } finally {
        await fh.close();
      }
    }

    // 5. 清单（不含自身校验值），写入前确认不超过读取上限
    const manifestEntries: ManifestEntry[] = entries.map((e) => {
      if (e.kind === 'dir') return { path: e.rel, type: 'dir' };
      const sha256 = hashes.get(e.rel);
      if (!sha256) throw new Error('内部错误：缺少文件校验值');
      return { path: e.rel, type: 'file', size: Number(e.st.size), sha256 };
    });
    const manifest: SnapshotManifest = {
      format: FORMAT,
      kind: 'snapshot',
      schema: 1,
      snapshotId: id,
      createdAt,
      appVersion: this.opts.appVersion,
      flavorId: info.flavorId,
      fileCount: files.length,
      dirCount: entries.length - files.length,
      totalBytes: statBytes,
      entries: manifestEntries,
    };
    const text = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
    if (text.byteLength > limits.maxManifestBytes) throw limitError('备份清单大小', limits.maxManifestBytes, 'bytes');
    await this.step('manifest-write');
    await partial.writeFile(MANIFEST_NAME, text);
    await syncDir(partial.abs('WTF'));
    await syncDir(partial.base);

    // 6. 发布前复核：位置与占用标记、实际份数与占用
    this.phase(task, 'publishing');
    await this.step('before-publish');
    await this.recheckSource(src);
    await this.recheckContainer(ctr, rec, signal);
    await this.assertLocation(ctr.path, root, true);
    await assertLockHeld(lock);
    await this.assertContainerFits(ctr.path, rec.flavorId, signal);

    // 7. 按刚生成的清单完整校验本次临时目录：集合、内容、清单内容与身份，结束时确认校验期间未变化
    await this.step('target-recheck');
    const pinned = await this.verifyPartial(partial, manifestEntries, text, signal);

    // 8. 最终复核：源与目标的集合及每项身份 / 大小 / 时间在上述检查之后仍未变化
    await this.step('final-check');
    await this.assertSourceUnchanged(src, entries, walkOpts);
    const finalTarget = await this.walkPartial(partial, signal);
    const moved = walkDiff(pinned, finalTarget);
    if (moved) throw targetChanged(`「${moved}」在核对后被改动`);
    await this.recheckContainer(ctr, rec, signal);
    await assertLockHeld(lock);
    // 发布前最后一次有界扫描：外来项、历史结构与实际占用（含本次临时目录）；此后不再有测试钩子
    await this.assertContainerFits(ctr.path, rec.flavorId, signal);
    const finalPath = path.join(ctr.path, id);
    if (await lstat(finalPath).then(() => true, (err) => errCode(err) !== 'ENOENT')) throw new UserError('备份编号冲突，本次备份未完成，请重试', 'backup-container');
    const actualBytes = statBytes + text.byteLength;
    const record: BackupVerifyRecord = { at: Date.now(), ok: true, reason: null };
    throwIfAborted(signal);
    await rename(partial.base, finalPath);
    await syncDir(ctr.path);
    this.verified.set(this.verifyKey(ctr.path, id), record);
    return manifestSnapshot(manifest, actualBytes, 'structure-ok', null, record);
  }

  /** 发布前复核备份位置：无外来项或异常，历史备份结构一致，实际份数与占用（含本次临时目录）不超限 */
  private async assertContainerFits(container: string, flavorId: number, signal: AbortSignal): Promise<void> {
    const limits = this.limits;
    const scan = await scanContainer(container, this.scanCtx(container, flavorId, signal));
    if (scan.anomalies.length > 0 || !scan.usage.confirmed || scan.snapshots.some((s) => s.status !== 'structure-ok')) {
      throw new UserError(`发布前发现备份位置被改动，本次备份未完成。请在访达中检查 ${container}`, 'backup-container');
    }
    if (scan.usage.count > limits.maxSnapshots) throw limitError('备份份数', limits.maxSnapshots, 'count');
    if (scan.usage.bytes > limits.maxTotalBytes) throw limitError('备份位置总占用', limits.maxTotalBytes, 'bytes');
  }

  /** 源的根目录链、WTF 身份、完整集合与每项身份 / 大小 / 时间与首次枚举一致 */
  private async assertSourceUnchanged(src: SourceCtx, entries: WalkEntry[], walkOpts: WalkOptions): Promise<void> {
    await this.recheckSource(src);
    const again = await walkTree(src.wtf, walkOpts);
    const changed = walkDiff(entries, again);
    if (changed) throw sourceChanged(changed);
  }

  private walkPartial(partial: PartialTracker, signal: AbortSignal): Promise<WalkEntry[]> {
    return walkTree(partial.base, { maxEntries: this.limits.maxEntries + 2, maxDepth: this.limits.maxDepth + 1, rejectHardlinks: true, signal, label: '备份' });
  }

  /** 完整校验本次临时目录；返回校验时固定的枚举结果。任何差异都按核对失败处理 */
  private async verifyPartial(partial: PartialTracker, entries: ManifestEntry[], manifestText: Buffer, signal: AbortSignal): Promise<WalkEntry[]> {
    try {
      const first = await this.walkPartial(partial, signal);
      const top = topLevelProblem(first, false);
      if (top) throw targetChanged(top);
      const wtf = wtfEntries(first);
      const diff = compareStructure(wtf, entries, false);
      if (diff) throw targetChanged(diff);
      const manifestWalk = first.find((e) => e.rel === MANIFEST_NAME);
      const meta = await readMeta(partial.abs(MANIFEST_NAME), this.limits.maxManifestBytes, '备份清单', signal);
      if (!meta || !manifestWalk || !sameStat(meta.st, manifestWalk.st) || !meta.data.equals(manifestText)) throw targetChanged('备份清单被改动');
      const byKey = new Map(wtf.map((e) => [foldKey(e.rel), e]));
      for (const m of entries) {
        if (m.type !== 'file') continue;
        const w = byKey.get(foldKey(m.path));
        if (!w) throw targetChanged(`缺少「${m.path}」`);
        const hex = await hashStoredFile(partial.abs(`WTF/${w.rel}`), m.path, m.size ?? 0, w.st, signal);
        if (hex !== m.sha256) throw targetChanged(`「${m.path}」内容不符`);
      }
      const second = await this.walkPartial(partial, signal);
      const moved = walkDiff(first, second);
      if (moved) throw targetChanged(`「${moved}」在核对期间被改动`);
      return first;
    } catch (err) {
      if (isCancelled(err) || (err instanceof UserError && err.code === 'backup-verify-failed')) throw err;
      throw targetChanged(errorMessage(err));
    }
  }

  /** 复制单个文件：源 O_NOFOLLOW|O_NONBLOCK 打开并核对身份，目标排他新建 0600；前后 fstat 一致才算完成 */
  private async copyFile(task: ActiveTask, srcBase: string, e: WalkEntry, partial: PartialTracker, budget: number): Promise<string> {
    const { info } = task;
    const signal = task.controller.signal;
    const fh = await openSourceFile(path.join(srcBase, ...e.rel.split('/')), e.rel, e.st);
    try {
      const out = await partial.createFile(`WTF/${e.rel}`);
      const r = await (async () => {
        try {
          const h = await hashHandle(fh, this.limits.maxFileBytes, () => limitError(`单个文件（「${e.rel}」）`, this.limits.maxFileBytes, 'bytes'), signal, async (chunk) => {
            if (info.bytesDone + chunk.byteLength > budget) throw limitError('本次备份可用空间', budget, 'bytes');
            await writeAll(out, chunk);
            info.bytesDone += chunk.byteLength;
            this.emit(false);
          });
          await out.sync();
          return h;
        } finally {
          await out.close();
        }
      })();
      if (r.bytes !== Number(e.st.size) || !sameStat(e.st, await fh.stat({ bigint: true }))) throw sourceChanged(e.rel);
      return r.hex;
    } finally {
      await fh.close();
    }
  }

  // ---------- 重新校验 ----------

  /** 只读校验一份已发布的备份；内容差异返回 ok:false，目标 / 占用 / 未启用 / 位置被替换等情况抛错 */
  async verify(flavorId: number, expectedRoot: string, snapshotId: string): Promise<BackupVerifyResult> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    const id = snapshotArg(snapshotId);
    const task = this.begin('verify', f, expected, id);
    try {
      return await this.doVerify(task, id);
    } finally {
      this.end(task);
    }
  }

  private async doVerify(task: ActiveTask, snapshotId: string): Promise<BackupVerifyResult> {
    const { info } = task;
    const signal = task.controller.signal;
    const root = await this.checkTarget(info.flavorId, info.root);
    const rec = await this.enabledRecord(info.flavorId, root);
    const ctr = await this.openContainer(rec, signal);
    // 与备份相同的位置保护：在写入占用标记之前拒绝已位于游戏目录或应用数据目录内（或包含它们）的位置
    await this.assertLocation(ctr.path, root, true);
    throwIfAborted(signal);
    const lock = await acquireLock(path.join(ctr.path, LOCK_NAME), { taskKind: 'verify', taskId: info.id, appVersion: this.opts.appVersion }, locationBusy);
    this.held = { container: ctr.path, lockId: lock.id, partial: null };
    let out: { ok: boolean; reason: string | null; files: number; bytes: number } | null = null;
    let failure: unknown = null;
    try {
      this.phase(task, 'verifying');
      out = await this.verifySnapshot(task, ctr, rec, lock, snapshotId);
    } catch (err) {
      failure = err ?? new Error('校验未完成');
    }
    const lockNote = await this.release(lock);
    this.held = null;
    const notes = lockNote ? [lockNote] : [];
    if (failure || !out) throw withNotes(failure ?? new Error('校验未完成'), notes);
    this.verified.set(this.verifyKey(ctr.path, snapshotId), { at: Date.now(), ok: out.ok, reason: out.reason });
    return { taskId: info.id, snapshotId, ok: out.ok, reason: out.reason, checkedFiles: out.files, checkedBytes: out.bytes, warnings: notes };
  }

  /**
   * 只读校验：固定快照目录、清单与每个文件的身份，读取前后核对；结束时再次有界枚举，确认集合与每项身份在校验期间未变化，
   * 并复核备份位置各级身份与占用标记。内容差异返回 ok:false；位置被替换、占用标记被改动或取消则抛错。
   */
  private async verifySnapshot(task: ActiveTask, ctr: ContainerCtx, rec: TargetRecord, lock: HeldLock, snapshotId: string): Promise<{ ok: boolean; reason: string | null; files: number; bytes: number }> {
    const { info } = task;
    const signal = task.controller.signal;
    const limits = this.limits;
    const dir = path.join(ctr.path, snapshotId);
    let files = 0;
    let bytes = 0;
    const fail = (reason: string) => ({ ok: false, reason, files, bytes });
    let dirSt: BigIntStats;
    try {
      dirSt = await lstat(dir, { bigint: true });
    } catch (err) {
      if (errCode(err) === 'ENOENT') throw new UserError('找不到该备份，可能已在访达中删除，请刷新', 'backup-snapshot');
      throw err;
    }
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) return fail('备份目录不是普通文件夹');
    const walkOpts: WalkOptions = { maxEntries: limits.maxEntries + SNAPSHOT_EXTRA_ENTRIES, maxDepth: limits.maxDepth + 1, rejectHardlinks: true, signal, label: '备份' };
    let first: WalkEntry[];
    try {
      first = await walkTree(dir, walkOpts);
    } catch (err) {
      if (isCancelled(err)) throw err;
      return fail(errorMessage(err));
    }
    const top = topLevelProblem(first, true);
    if (top) return fail(top);
    let manifest: SnapshotManifest;
    try {
      const meta = await readMeta(path.join(dir, MANIFEST_NAME), limits.maxManifestBytes, '备份清单', signal);
      const manifestWalk = first.find((e) => e.rel === MANIFEST_NAME);
      if (!meta || !manifestWalk) return fail('缺少备份清单');
      if (!sameStat(meta.st, manifestWalk.st)) return fail('备份清单在校验期间被改动');
      manifest = parseManifest(meta.data, snapshotId, limits);
    } catch (err) {
      if (isCancelled(err)) throw err;
      return fail(errorMessage(err));
    }
    if (manifest.flavorId !== rec.flavorId) return fail('清单的游戏版本与备份位置不符');
    const wtf = wtfEntries(first);
    const diff = compareStructure(wtf, manifest.entries, true);
    if (diff) return fail(diff);
    const byKey = new Map(wtf.map((e) => [foldKey(e.rel), e]));
    const list = manifest.entries.filter((e) => e.type === 'file');
    info.filesTotal = list.length;
    info.bytesTotal = manifest.totalBytes;
    this.emit(true);
    for (const e of list) {
      throwIfAborted(signal);
      await this.step('verify-file', e.path);
      const w = byKey.get(foldKey(e.path));
      if (!w) return fail(`缺少「${e.path}」`);
      let hex: string;
      try {
        hex = await hashStoredFile(path.join(dir, 'WTF', ...w.rel.split('/')), e.path, e.size ?? 0, w.st, signal, (n) => {
          info.bytesDone += n;
          bytes += n;
          this.emit(false);
        });
      } catch (err) {
        if (isCancelled(err)) throw err;
        return fail(errorMessage(err));
      }
      if (hex !== e.sha256) return fail(`「${e.path}」的内容与清单不一致`);
      files++;
      info.filesDone = files;
      this.emit(false);
    }
    await this.step('verify-final');
    let second: WalkEntry[];
    try {
      second = await walkTree(dir, walkOpts);
    } catch (err) {
      if (isCancelled(err)) throw err;
      return fail(`校验期间备份被改动（${errorMessage(err)}）`);
    }
    const moved = walkDiff(first, second);
    if (moved) return fail(`校验期间「${moved}」被改动`);
    const dirNow = await lstat(dir, { bigint: true }).catch(() => null);
    if (!dirNow || dirNow.isSymbolicLink() || idOf(dirNow) !== idOf(dirSt)) return fail('校验期间备份目录被移动或替换');
    await this.recheckContainer(ctr, rec, signal);
    await this.assertLocation(ctr.path, info.root, true);
    await assertLockHeld(lock);
    return { ok: true, reason: null, files, bytes };
  }

  // ---------- 取消、查看位置、退出 ----------

  /** 只有 taskId、flavor、任务受理时的目录都与活动任务一致才取消；不检查当前绑定 */
  cancel(taskId: string, flavorId: number, expectedRoot: string): boolean {
    const t = this.active;
    if (!t || t.info.id !== taskId || t.info.flavorId !== flavorId || t.info.root !== expectedRoot) return false;
    if (!t.info.cancelling) {
      t.info.cancelling = true;
      t.controller.abort();
      this.emit(true);
    }
    return true;
  }

  /** 只返回已启用且标记正确的备份位置，或其中已发布的备份目录；不接受任意路径 */
  async revealPath(flavorId: number, expectedRoot: string, snapshotId?: string | null): Promise<string> {
    const f = flavorArg(flavorId);
    const root = await this.checkTarget(f, pathArg(expectedRoot, '目标目录'));
    const rec = await this.enabledRecord(f, root);
    const ctr = await this.openContainer(rec);
    if (snapshotId === undefined || snapshotId === null) return ctr.path;
    const p = path.join(ctr.path, snapshotArg(snapshotId));
    const st = await lstat(p, { bigint: true }).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new UserError('找不到该备份，可能已在访达中删除，请刷新', 'backup-snapshot');
    const m = await lstat(path.join(p, MANIFEST_NAME), { bigint: true }).catch(() => null);
    if (!m || !m.isFile()) throw new UserError('该目录不是完整的备份', 'backup-snapshot');
    return p;
  }

  /** 退出时调用：拒绝新任务，取消进行中的任务，并等待任务与设置修改全部收尾 */
  async shutdown(): Promise<void> {
    this.closed = true;
    const t = this.active;
    if (t) {
      if (!t.info.cancelling) {
        t.info.cancelling = true;
        t.controller.abort();
        this.emit(true);
      }
      await t.done;
    }
    if (this.configuring) await this.configuring.catch(() => undefined);
  }
}
