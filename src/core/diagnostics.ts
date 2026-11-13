// 诊断报告（0.3.0）：主进程生成并冻结的白名单 JSON 预览。
// - 纯读：设置、操作记录、当前目标的 manifest 都以 O_NOFOLLOW | O_NONBLOCK 有界读取，读取前后复核文件身份
//   （dev/ino/size/mtime/ctime）与从文件系统根开始的整条上级目录链（每一级必须是真实目录）。不恢复事务、不清理、
//   不写操作记录，不读 WTF 或备份内容，不联网，不读取用户名或主目录。
// - 输出只含固定枚举、数量、合法的公开数字编号与报告内临时别名；名称、版本文本、路径、错误说明一律不进入报告。
//   源数据中的字符串只用于内部比较（例如操作记录是否属于当前目录、目录别名的归并），不会被复制到输出。
// - 设置无法读取时仍生成应用摘要，但不读取任何游戏目录。各部分分别读取，不是瞬时快照；采集前后绑定计数或设置内容
//   变化时放弃本次结果（stale），保留之前的预览。
// - 健康检查由调用方注入（主进程在同目录队列中去重执行）。这里同时最多等待一个检查；等待超时只报告仍在进行，
//   不会取消它，也不会再启动新的检查。
// - 保存：只写冻结预览的同一份字节，位置只来自主进程的系统对话框回调。选择之后、创建之前两次读取完整的受保护目录集合
//   （设置中的全部绑定 + 主进程给出的保护列表 + 设置与操作记录所在目录），任何一项无法确认即拒绝，不当作空集合。
//   每次读取自身前后核对设置内容与保护配置变更计数（epoch），计数在整个保存期间必须不变。
//   新文件以 O_RDWR | O_EXCL | O_NOFOLLOW、0600 创建，不覆盖任何已有路径；每段写入之前都复核原目录链、文件身份与
//   已写入前缀的逐字节内容，写完、fsync、目录 fsync 后再逐字节读回整份内容，全部一致才算保存。
//   失败时只删除可确认是本次文件且内容恰为已确认写入前缀的路径；外部改动（含同 inode 改写）一律保留并如实返回。
//   只防本应用自身与常见的意外替换，不承诺防住同权限恶意进程在检查与操作之间的竞态。
import { createHash, randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiagAddon,
  DiagFailure,
  DiagHealthIssue,
  DiagLimits,
  DiagnosticReport,
  DiagOmitted,
  DiagPlatform,
  DiagPreviewCode,
  DiagPreviewResult,
  DiagReason,
  DiagSaveFailCode,
  DiagSaveRejectCode,
  DiagSaveResult,
  DiagCleanup,
  DiagSection,
  DiagTokenCode,
} from '../shared/diagnostic-types';
import type { HealthIssueKind, HealthReport, HealthSeverity, HealthStatus, HealthUnavailableReason } from '../shared/health-types';
import type { HistoryKind, HistoryStatus } from '../shared/types';
import { FILE_ID_RE } from './file-id';
import { getFlavor } from './flavors';
import { DEFAULT_HISTORY_LIMITS } from './history';
import { layoutFor, MAX_METADATA_BYTES } from './layout';
import { foldKey } from './paths';
import { parseSettings } from './profiles';
import { parseManifest, type Manifest } from './store';

const KiB = 1024;
const MiB = 1024 * KiB;

/** 硬上限：配置只能调低 */
export const HARD_DIAG_LIMITS: Readonly<DiagLimits> = Object.freeze({
  maxReportBytes: 512 * KiB,
  maxAddons: 500,
  maxFoldersPerAddon: 32,
  maxHealthIssues: 200,
  recentFailures: 100,
  maxSettingsBytes: 1 * MiB,
  maxManifestBytes: MAX_METADATA_BYTES,
  maxHistoryBytes: DEFAULT_HISTORY_LIMITS.maxFileBytes,
  healthWaitMs: 20_000,
  previewTtlMs: 30 * 60_000,
});

export const DEFAULT_DIAG_LIMITS: Readonly<DiagLimits> = Object.freeze({ ...HARD_DIAG_LIMITS, recentFailures: 20 });

/** interface-mismatch 中最多列出的声明值 */
const MAX_DECLARED = 32;
const READ_CHUNK = 64 * KiB;
const MODID_RE = /^\d{1,12}$/;
const APP_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** 保护列表的条目数上限：超过即按无法确认处理 */
const MAX_PROTECTED = 4096;
const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;

// 运行时白名单：Record 保证与类型定义同步（新增枚举值时编译报错）
const HISTORY_KINDS: Record<HistoryKind, true> = { install: true, update: true, reinstall: true, uninstall: true, 'uninstall-folder': true, restore: true, purge: true, pause: true, resume: true };
const HISTORY_STATUSES: Record<HistoryStatus, true> = { accepted: true, succeeded: true, unchanged: true, cancelled: true, 'not-processed': true, failed: true, unconfirmed: true };
const ISSUE_KINDS: Record<HealthIssueKind, true> = {
  'addons-absent': true,
  'manifest-invalid': true,
  'registered-missing': true,
  'registered-not-dir': true,
  'registered-unconfirmed': true,
  'name-ambiguous': true,
  'entry-symlink': true,
  'entry-unreadable': true,
  'entry-changed': true,
  'entry-too-many-files': true,
  'toc-none': true,
  'toc-ambiguous': true,
  'toc-not-regular': true,
  'toc-unreadable': true,
  'toc-too-large': true,
  'toc-changed': true,
  'toc-skipped-budget': true,
  'dep-required-missing': true,
  'dep-optional-missing': true,
  'dep-system-unconfirmed': true,
  'dep-unconfirmed': true,
  'dep-declaration-invalid': true,
  'interface-mismatch': true,
  'interface-unknown': true,
};
const SEVERITIES: Record<HealthSeverity, true> = { warning: true, unknown: true, info: true };
const HEALTH_STATUSES: Record<HealthStatus, true> = { complete: true, partial: true, unavailable: true };
const UNAVAILABLE_REASONS: Record<HealthUnavailableReason, true> = { 'unknown-flavor': true, layout: true, 'pending-operation': true, 'addons-unreadable': true };
const MANIFEST_STATES = { absent: true, ok: true, invalid: true } as const;
/** detail 是被依赖目录名的提示类型：只输出其别名 */
const DEP_KINDS: ReadonlySet<HealthIssueKind> = new Set<HealthIssueKind>(['dep-required-missing', 'dep-optional-missing', 'dep-unconfirmed', 'dep-system-unconfirmed']);

function inSet<K extends string>(set: Record<K, true>, v: unknown): v is K {
  return typeof v === 'string' && Object.hasOwn(set, v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 非负安全整数，否则 null */
function nat(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function normalizeLimits(o: Partial<DiagLimits> | undefined): DiagLimits {
  const out: DiagLimits = { ...DEFAULT_DIAG_LIMITS };
  for (const k of Object.keys(out) as (keyof DiagLimits)[]) {
    const v = o?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > HARD_DIAG_LIMITS[k]) throw new RangeError(`诊断上限无效：${k}`);
    out[k] = v;
  }
  return out;
}

function platformOf(p: string): DiagPlatform {
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other';
}

// ---------- 有界只读 ----------

type ReadFail = 'symlink' | 'not-file' | 'too-large' | 'io' | 'changed' | 'parent-unsafe';
type SourceRead = { kind: 'ok'; buf: Buffer } | { kind: 'absent' } | { kind: 'fail'; reason: ReadFail };
type Chain = { kind: 'ok'; ids: string[]; key: string; dev: string } | { kind: 'absent' } | { kind: 'fail'; reason: 'parent-unsafe' | 'io' };

/** 从文件系统根到 dir 的每一级都必须是真实目录（不跟随链接）；返回各级 dev:ino（key 为整条链）与 dir 自身的 dev。某一级不存在为 absent */
async function dirChain(dir: string): Promise<Chain> {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) return { kind: 'fail', reason: 'parent-unsafe' };
  const root = path.parse(dir).root;
  const parts = dir.slice(root.length).split(path.sep).filter(Boolean);
  const ids: string[] = [];
  let cur = root;
  let dev = '';
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cur = path.join(cur, parts[i]);
    let st: BigIntStats;
    try {
      st = await lstat(cur, { bigint: true });
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return { kind: 'absent' };
      return { kind: 'fail', reason: code === 'ENOTDIR' ? 'parent-unsafe' : 'io' };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { kind: 'fail', reason: 'parent-unsafe' };
    ids.push(`${st.dev}:${st.ino}`);
    dev = String(st.dev);
  }
  return { kind: 'ok', ids, key: ids.join('/'), dev };
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * 读取一个小型数据文件：先确认上级目录链，再以 O_NOFOLLOW | O_NONBLOCK 打开（链接立即失败，FIFO 不等待写端），
 * 确认是普通文件后最多读取 max + 1 字节；读取前后句柄身份、路径指向与上级目录链都必须不变。
 */
async function readSource(file: string, max: number): Promise<SourceRead> {
  const dir = path.dirname(file);
  const before = await dirChain(dir);
  if (before.kind === 'absent') return { kind: 'absent' };
  if (before.kind === 'fail') return { kind: 'fail', reason: before.reason };
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'ELOOP') return { kind: 'fail', reason: 'symlink' };
    return { kind: 'fail', reason: code === 'ENOTDIR' ? 'changed' : 'io' };
  }
  let buf: Buffer;
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) return { kind: 'fail', reason: 'not-file' };
    if (st.size > BigInt(max)) return { kind: 'fail', reason: 'too-large' };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(READ_CHUNK, max + 1 - total);
      const b = Buffer.alloc(want);
      const n = (await fh.read(b, 0, want, null)).bytesRead;
      if (n === 0) break;
      chunks.push(n === want ? b : b.subarray(0, n));
      total += n;
      if (total > max) return { kind: 'fail', reason: 'too-large' };
    }
    const st2 = await fh.stat({ bigint: true });
    if (!sameFile(st, st2) || BigInt(total) !== st2.size) return { kind: 'fail', reason: 'changed' };
    const now = await lstat(file, { bigint: true }).catch(() => null);
    if (!now || now.dev !== st.dev || now.ino !== st.ino) return { kind: 'fail', reason: 'changed' };
    buf = Buffer.concat(chunks, total);
  } catch {
    return { kind: 'fail', reason: 'io' };
  } finally {
    await fh.close().catch(() => undefined);
  }
  const after = await dirChain(dir);
  if (after.kind !== 'ok' || after.key !== before.key) return { kind: 'fail', reason: 'changed' };
  return { kind: 'ok', buf };
}

// ---------- 保存用的路径与文件工具 ----------

type OkChain = Extract<Chain, { kind: 'ok' }>;

/** 受保护目录：词法与规范路径（按段、大小写与 Unicode 折叠）及存在时的 dev:ino */
interface ProtectedRoot {
  keys: string[][];
  id: string | null;
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

function canonicalAbs(p: string): boolean {
  return p.length > 0 && !p.includes('\0') && byteLen(p) <= MAX_PATH_BYTES && path.isAbsolute(p) && path.resolve(p) === p;
}

/** 保存目标：规范的绝对路径，最后一段是普通的文件名 */
function validTarget(p: string): boolean {
  const name = path.basename(p);
  return canonicalAbs(p) && path.dirname(p) !== p && name !== '' && name !== '.' && name !== '..' && byteLen(name) <= MAX_NAME_BYTES;
}

function segs(p: string): string[] {
  return foldKey(p).split(path.sep).filter(Boolean);
}

/**
 * 受保护目录的比较依据。存在时取 realpath 与其 dev:ino；不存在时保护词法路径，以及最近存在的上级的规范路径接上其余各段
 * （例如 /var → /private/var 的别名）。除不存在以外的任何错误都 throw（按无法确认处理）。
 */
async function protectedRoot(p: string): Promise<ProtectedRoot> {
  const lexical = path.resolve(p);
  const keys = [segs(lexical)];
  try {
    const real = await realpath(lexical);
    keys.push(segs(real));
    return { keys, id: idOf(await lstat(real, { bigint: true })) };
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
  const rest: string[] = [];
  let cur = lexical;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
    try {
      keys.push(segs(path.join(await realpath(cur), ...rest)));
      break;
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err;
    }
  }
  return { keys, id: null };
}

/** 目标所在目录链中任何一级是受保护目录（同一 dev:ino），或目标路径按段落在任何一个受保护路径之内（含相等） */
function isProtected(target: string, chainIds: readonly string[], roots: readonly ProtectedRoot[]): boolean {
  const t = segs(target);
  return roots.some((r) => (r.id !== null && chainIds.includes(r.id)) || r.keys.some((k) => k.length <= t.length && k.every((s, i) => s === t[i])));
}

interface Sig {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function idOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}`;
}

function sigOf(st: BigIntStats): Sig {
  return { size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
}

function sameSig(st: BigIntStats, s: Sig): boolean {
  return st.size === s.size && st.mtimeNs === s.mtimeNs && st.ctimeNs === s.ctimeNs;
}

/** 顺序写入 [from, to)；prog.written 只在每次 write 成功返回后前移（失败那一次写入了多少未知，不计入） */
async function writeRange(fh: FileHandle, buf: Buffer, from: number, to: number, prog: { written: number }): Promise<void> {
  let off = from;
  while (off < to) {
    const { bytesWritten } = await fh.write(buf, off, to - off, off);
    if (bytesWritten <= 0) throw new Error('short-write');
    off += bytesWritten;
    prog.written = off;
  }
}

/**
 * 经句柄核对文件就是本次的 inode、唯一链接、长度恰为 len，并逐字节等于 bytes 的前 len 字节（多读 1 字节发现增长）；
 * 读取前后元数据不变。len 不超过冻结内容长度（≤ 报告上限）。任何不符或错误返回 null
 */
async function verifyContent(fh: FileHandle, bytes: Buffer, len: number, id: string): Promise<Sig | null> {
  try {
    if (len > bytes.length) return null;
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.nlink !== 1n || idOf(st) !== id || st.size !== BigInt(len)) return null;
    const buf = Buffer.alloc(len + 1);
    let total = 0;
    while (total < buf.length) {
      const n = (await fh.read(buf, total, buf.length - total, total)).bytesRead;
      if (n === 0) break;
      total += n;
    }
    if (total !== len || !buf.subarray(0, len).equals(bytes.subarray(0, len))) return null;
    const st2 = await fh.stat({ bigint: true });
    if (idOf(st2) !== id || st2.nlink !== 1n || !sameSig(st2, sigOf(st))) return null;
    return sigOf(st2);
  } catch {
    return null;
  }
}

/**
 * 删除前的所有权证明（句柄已关闭）：目录链未变；以 O_NOFOLLOW | O_NONBLOCK 重新打开的仍是本次 inode，
 * 内容恰为已确认写入的前缀；路径仍指向它；目录链再次未变。返回 ok 或应报告的保留原因
 */
async function ownedOnDisk(bytes: Buffer, target: string, dir: string, chainKey: string, id: string, written: number): Promise<'ok' | DiagCleanup> {
  const before = await dirChain(dir);
  if (before.kind !== 'ok' || before.key !== chainKey) return 'retained-parent-changed';
  let fh: FileHandle;
  try {
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') return 'absent';
    return code === 'ELOOP' ? 'retained-replaced' : 'retained-unconfirmed';
  }
  let sig: Sig | null = null;
  let replaced = false;
  try {
    const st = await fh.stat({ bigint: true });
    if (idOf(st) !== id) replaced = true;
    else sig = await verifyContent(fh, bytes, written, id);
  } catch {
    sig = null;
  } finally {
    await fh.close().catch(() => undefined);
  }
  if (replaced) return 'retained-replaced';
  if (sig === null) return 'retained-unconfirmed';
  const now = await lstat(target, { bigint: true }).catch(() => null);
  if (!now) return 'retained-unconfirmed';
  if (idOf(now) !== id) return 'retained-replaced';
  if (now.nlink !== 1n || !sameSig(now, sig)) return 'retained-unconfirmed';
  const after = await dirChain(dir);
  if (after.kind !== 'ok' || after.key !== chainKey) return 'retained-parent-changed';
  return 'ok';
}

/** 目录 fsync：任何失败都抛出（不同于 layout.syncDir 的忽略） */
async function syncDirStrict(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** JSON 顶层对象与 schema 1 的预检；之后再交给各自的严格校验 */
function jsonObject(buf: Buffer): { ok: true; v: Record<string, unknown>; text: string } | { ok: false; reason: 'invalid-format' | 'unsupported-schema' } {
  const text = buf.toString('utf8');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-format' };
  }
  if (!isPlainObject(v)) return { ok: false, reason: 'invalid-format' };
  if (v.schema !== 1) return { ok: false, reason: 'unsupported-schema' };
  return { ok: true, v, text };
}

const section = (state: DiagSection['state'], reason: DiagReason | null): DiagSection => ({ state, reason });
const noOmit = (): DiagOmitted => ({ limit: 0, byteBudget: 0 });

/** 报告内的目录别名：大小写 / Unicode 形式不同的同名目录归为同一别名 */
class Aliases {
  private readonly map = new Map<string, string>();
  of(name: string): string {
    const k = foldKey(name);
    let a = this.map.get(k);
    if (a === undefined) {
      a = `f${this.map.size + 1}`;
      this.map.set(k, a);
    }
    return a;
  }
}

// ---------- 服务 ----------

/**
 * 测试注入点。生成：after-*。保存：save-after-pick、save-before-open（两次保护检查之间）、save-fstat、save-after-open、
 * save-write（写入前一半之后）、save-sync、save-parent-sync、save-before-verify（最终读回之前）、save-close、
 * save-before-cleanup、save-unlink（删除前最终复核之前）；在 save-fstat 到 save-unlink 抛错即模拟对应步骤失败。
 */
export type DiagStep =
  | 'after-settings'
  | 'after-manifest'
  | 'after-history'
  | 'after-health'
  | 'save-after-pick'
  | 'save-before-open'
  | 'save-fstat'
  | 'save-after-open'
  | 'save-write'
  | 'save-sync'
  | 'save-close'
  | 'save-parent-sync'
  | 'save-before-verify'
  | 'save-before-cleanup'
  | 'save-unlink';

/** 预览的所属者：主进程给出的不透明窗口标识，不进入报告 */
export type DiagOwner = number | string;

export interface DiagnosticsOptions {
  /** 主进程给出的应用版本；不是 x.y.z 数字形式时报告 unknown */
  appVersion: string;
  platform?: string;
  /** userData/settings.json */
  settingsFile: string;
  /** userData/operation-history.json */
  historyFile: string;
  /** 当前运行的操作记录实例：其他实例留下的 accepted 记录按结果未确认统计 */
  historyInstance: string;
  /** 操作记录的内存状态，只取数量与是否失败 */
  historyStatus?(): { unsaved: number; dropped: number; failing: boolean };
  /** 只读健康检查（主进程在同目录队列中去重执行；不经过无界的设置读取） */
  health(flavorId: number, root: string): Promise<HealthReport>;
  /**
   * 保存位置的受保护目录（必需）。合同：
   * - 由主进程以有界、只读的方式读取，返回完整列表：至少包括 userData、应用 bundle、全部已登记的备份位置
   *   （包括已关闭但仍登记的）与 WTF 恢复的保护位置；每项是规范的绝对路径（不含 . / ..、无结尾分隔符）。
   * - 任何来源无法完整读取、或保护配置正在改动而无法给出完整稳定的集合时必须 throw；绝不能在出错时返回空列表或部分列表。
   * - 只读：不得修改任何数据。保存会在每次调用前后核对 epoch 与设置内容，期间的变化按 protection-changed 拒绝。
   * - 返回非数组、相对或不规范路径、超过 4096 项时，本模块按无法确认处理（protected-roots-unknown）。
   * 游戏目录绑定由本模块自己从设置文件读取（全部绑定，不只已知游戏版本），设置与操作记录所在目录也总是受保护。
   */
  protectedExtras(): Promise<string[]>;
  /**
   * 保护配置变更计数（单调递增）。合同：主进程在 bind / unbind、备份 configure / disable 以及任何改变受保护集合的入口
   * 开始改动前与完成（含失败收尾）时都递增，覆盖全部保护配置而不只绑定。生成预览用它发现采集期间的 A→B→A；
   * 保存从选择位置之后到写完最后一个字节都要求它不变，变化即放弃（protection-changed）。
   * 配置正在改动、protectedExtras 无法返回完整稳定的集合时，protectedExtras 必须 throw。
   */
  epoch?(): number;
  now?(): number;
  limits?: Partial<DiagLimits>;
  /** 测试注入：各阶段之后调用 */
  hooks?: { step?(name: DiagStep): Promise<void> | void };
}

interface Frozen {
  token: string;
  owner: DiagOwner;
  json: string;
  bytes: Buffer;
  expiresAt: number;
}

interface SettingsView {
  section: DiagSection;
  /** absent 为空绑定；无法读取为 null */
  bindings: Map<number, string> | null;
  unknownBindings: number;
  /** 首尾复核用：内容哈希或固定失败原因 */
  fingerprint: string;
}

type HealthOutcome = { ok: true; report: HealthReport } | { ok: false };

interface HealthRun {
  flavorId: number;
  root: string;
  epoch: number;
  settled: Promise<HealthOutcome>;
}

export class DiagnosticsService {
  private readonly limits: DiagLimits;
  private readonly now: () => number;
  private current: Frozen | null = null;
  private generating = false;
  /** 保存进行中（从受理到收尾完成）；期间生成与另一次保存都返回 busy */
  private saving = false;
  /** 已关闭的所属者 → 关闭序号；生成开始与结束时比较，晚到的结果不会复活已关闭的窗口 */
  private readonly dropped = new Map<DiagOwner, number>();
  private dropSeq = 0;
  /** 同时最多一个进行中的健康检查（绑定启动时的目标与绑定计数） */
  private healthRun: HealthRun | null = null;

  constructor(private readonly opts: DiagnosticsOptions) {
    this.limits = normalizeLimits(opts.limits);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 生成预览。flavorId 为 null 时只生成应用摘要。已有有效预览时：reuse 返回它（其他所属者的预览需要 replace）；
   * replace 只有在新预览完整生成后才替换旧预览，失败时旧预览保持可用。
   */
  async preview(req: { flavorId: number | null; mode: 'reuse' | 'replace'; owner: DiagOwner }): Promise<DiagPreviewResult> {
    const { flavorId, mode, owner } = req;
    const validOwner = (typeof owner === 'number' && Number.isFinite(owner)) || (typeof owner === 'string' && owner.length > 0 && owner.length <= 128);
    const validFlavor = flavorId === null || (typeof flavorId === 'number' && getFlavor(flavorId) !== undefined);
    if (!validOwner || !validFlavor || (mode !== 'reuse' && mode !== 'replace')) return { status: 'rejected', code: 'invalid-request' };
    if (this.generating || this.saving) return { status: 'rejected', code: 'busy' };
    this.expire();
    const cur = this.current;
    if (cur && mode === 'reuse') return cur.owner === owner ? this.ready(cur, true) : { status: 'rejected', code: 'preview-exists' };
    this.generating = true;
    const mark = this.dropped.get(owner);
    let code: DiagPreviewCode;
    try {
      const json = await this.build(flavorId);
      if (this.dropped.get(owner) !== mark) code = 'owner-gone';
      else if (json === null) code = 'stale';
      else {
        const frozen: Frozen = { token: randomBytes(24).toString('hex'), owner, json, bytes: Buffer.from(json, 'utf8'), expiresAt: this.now() + this.limits.previewTtlMs };
        this.current = frozen;
        return this.ready(frozen, false);
      }
    } catch {
      code = 'internal';
    } finally {
      this.generating = false;
    }
    return { status: 'rejected', code };
  }

  /** 核对 token 是否仍对应该所属者的有效预览（不改变状态，过期的除外） */
  checkToken(token: unknown, owner: DiagOwner): { status: 'ok'; bytes: number } | { status: 'rejected'; code: DiagTokenCode } {
    const cur = this.current;
    if (!cur || typeof token !== 'string' || token !== cur.token) return { status: 'rejected', code: 'token-invalid' };
    if (cur.expiresAt <= this.now()) {
      this.current = null;
      return { status: 'rejected', code: 'token-expired' };
    }
    if (cur.owner !== owner) return { status: 'rejected', code: 'owner-mismatch' };
    return { status: 'ok', bytes: cur.bytes.length };
  }

  /** 窗口关闭：丢弃它的预览，进行中的生成结果到达后也不再采用 */
  dropOwner(owner: DiagOwner): void {
    this.dropped.set(owner, ++this.dropSeq);
    if (this.current?.owner === owner) this.current = null;
  }

  /**
   * 把 token 对应的冻结预览原样保存为新文件。pickPath 必须是主进程的系统保存对话框（取消返回 null），
   * 页面不能提供路径或内容。拒绝、取消时预览不变；成功后预览保留，可另存一份。
   * 一旦新文件已创建，不论窗口是否关闭都完整收尾后才返回；不会复活已关闭窗口的预览。
   */
  async save(token: unknown, owner: DiagOwner, pickPath: () => Promise<string | null>): Promise<DiagSaveResult> {
    const keeps = () => this.current !== null && this.current.token === token && this.current.expiresAt > this.now();
    if (this.generating || this.saving) return { status: 'rejected', code: 'busy', previewKept: keeps() };
    const chk = this.checkToken(token, owner);
    if (chk.status !== 'ok') return { status: 'rejected', code: chk.code, previewKept: keeps() };
    const f = this.current as Frozen;
    const mark = this.dropped.get(owner);
    this.saving = true;
    try {
      return await this.saveLocked(f, owner, mark, pickPath);
    } finally {
      this.saving = false;
    }
  }

  /** 选择位置之后：所属窗口未关闭、预览未被替换且未过期 */
  private stillValid(f: Frozen, owner: DiagOwner, mark: number | undefined): DiagSaveRejectCode | null {
    if (this.dropped.get(owner) !== mark) return 'owner-gone';
    if (this.current !== f) return 'token-invalid';
    if (f.expiresAt <= this.now()) {
      this.current = null;
      return 'token-expired';
    }
    return null;
  }

  private async saveLocked(f: Frozen, owner: DiagOwner, mark: number | undefined, pickPath: () => Promise<string | null>): Promise<DiagSaveResult> {
    const kept = () => this.current === f && f.expiresAt > this.now();
    const reject = (code: DiagSaveRejectCode): DiagSaveResult => ({ status: 'rejected', code, previewKept: kept() });
    let picked: unknown;
    try {
      picked = await pickPath();
    } catch {
      return reject('picker-failed');
    }
    if (picked === null || picked === undefined) return { status: 'cancelled', previewKept: kept() };
    if (typeof picked !== 'string' || !validTarget(picked)) return reject('invalid-path');
    const target = picked;
    let chain: OkChain;
    let e0: number;
    try {
      const invalid = this.stillValid(f, owner, mark);
      if (invalid) return reject(invalid);
      // 保护配置的变更计数贯穿整个保存：任何一次读取期间或之后发生变化都放弃
      e0 = this.epoch();
      await this.step('save-after-pick');
      // 选择期间可能新增了绑定或保护位置：选择之后读取完整集合，创建之前再读一次；每次读取自身也要求前后一致
      const first = await this.checkTarget(target, e0);
      if (typeof first === 'string') return reject(first);
      await this.step('save-before-open');
      const second = await this.checkTarget(target, e0);
      if (typeof second === 'string') return reject(second);
      if (second.key !== first.key) return reject('parent-changed');
      const late = this.stillValid(f, owner, mark);
      if (late) return reject(late);
      if (this.epoch() !== e0) return reject('protection-changed');
      chain = second;
    } catch {
      return reject('internal');
    }
    return this.writeNew(f, target, chain, e0, kept);
  }

  /**
   * 读取完整保护集合并检查目标；返回所在目录链，或拒绝原因。读取结束后再读一次设置并核对变更计数：
   * 读取期间设置内容或任何保护配置发生变化时返回 protection-changed（这次读到的集合可能不完整）。
   */
  private async checkTarget(target: string, e0: number): Promise<OkChain | DiagSaveRejectCode> {
    let set: { roots: ProtectedRoot[]; fingerprint: string };
    try {
      set = await this.protectedRoots();
    } catch {
      return 'protected-roots-unknown';
    }
    const chain = await dirChain(path.dirname(target));
    if (chain.kind !== 'ok') return 'parent-unsafe';
    if (isProtected(target, chain.ids, set.roots)) return 'protected-location';
    let again: string;
    try {
      again = (await this.readProtectionSettings()).fingerprint;
    } catch {
      return 'protected-roots-unknown';
    }
    if (again !== set.fingerprint || this.epoch() !== e0) return 'protection-changed';
    return chain;
  }

  /** 设置中的全部绑定（不论游戏版本是否已知）与内容指纹；存在但无法完整读取或校验时 throw */
  private async readProtectionSettings(): Promise<{ bindings: string[]; fingerprint: string }> {
    const r = await readSource(this.opts.settingsFile, this.limits.maxSettingsBytes);
    if (r.kind === 'fail') throw new Error('settings-unreadable');
    if (r.kind === 'absent') return { bindings: [], fingerprint: 'absent' };
    const j = jsonObject(r.buf);
    if (!j.ok) throw new Error('settings-invalid');
    return { bindings: Object.values(parseSettings(j.text, 'settings.json').bindings), fingerprint: createHash('sha256').update(r.buf).digest('hex') };
  }

  /**
   * 受保护目录：设置与操作记录所在目录、设置中的全部绑定、主进程给出的保护列表。
   * 设置存在但无法完整读取或校验、保护列表读取失败或不合法时 throw，不退化为部分集合。
   */
  private async protectedRoots(): Promise<{ roots: ProtectedRoot[]; fingerprint: string }> {
    const paths = [path.dirname(this.opts.settingsFile), path.dirname(this.opts.historyFile)];
    const s = await this.readProtectionSettings();
    paths.push(...s.bindings);
    const extras: unknown = await this.opts.protectedExtras();
    if (!Array.isArray(extras) || extras.length > MAX_PROTECTED) throw new Error('extras-invalid');
    for (const p of extras) {
      if (typeof p !== 'string' || !canonicalAbs(p)) throw new Error('extras-invalid');
      paths.push(p);
    }
    const roots: ProtectedRoot[] = [];
    for (const p of paths) roots.push(await protectedRoot(p));
    return { roots, fingerprint: s.fingerprint };
  }

  /**
   * 写入前与每段写入之间的复核（经过任何可观察的 await 之后）：保护配置计数未变、原目录链未变、
   * 句柄仍是唯一链接的本次文件且内容逐字节等于已写入的前缀、路径仍指向它。成功返回读回后的元数据
   */
  private async ownCheck(fh: FileHandle, f: Frozen, target: string, dir: string, chainKey: string, id: string, e0: number, len: number): Promise<Sig | 'parent-changed' | 'protection-changed' | 'content-changed'> {
    if (this.epoch() !== e0) return 'protection-changed';
    const before = await dirChain(dir);
    if (before.kind !== 'ok' || before.key !== chainKey) return 'parent-changed';
    const sig = await verifyContent(fh, f.bytes, len, id);
    if (sig === null) return 'content-changed';
    const now = await lstat(target, { bigint: true }).catch(() => null);
    if (!now || idOf(now) !== id) return 'content-changed';
    const after = await dirChain(dir);
    if (after.kind !== 'ok' || after.key !== chainKey) return 'parent-changed';
    if (this.epoch() !== e0) return 'protection-changed';
    return sig;
  }

  /** 分两段写入冻结字节，每段之前完整复核；随后 fsync 文件与所在目录。prog.written 只记录确认写入成功的字节数 */
  private async fill(fh: FileHandle, f: Frozen, target: string, dir: string, chainKey: string, id: string, e0: number, prog: { written: number }): Promise<DiagSaveFailCode | null> {
    try {
      await this.step('save-after-open');
    } catch {
      return 'write-failed';
    }
    const half = f.bytes.length > 1 ? Math.floor(f.bytes.length / 2) : f.bytes.length;
    const parts: [number, number][] = [
      [0, half],
      [half, f.bytes.length],
    ];
    for (const [i, [from, to]] of parts.entries()) {
      const ok = await this.ownCheck(fh, f, target, dir, chainKey, id, e0, prog.written);
      if (typeof ok === 'string') return ok;
      try {
        await writeRange(fh, f.bytes, from, to, prog);
        if (i === 0) await this.step('save-write');
      } catch {
        return 'write-failed';
      }
    }
    try {
      await this.step('save-sync');
      await fh.sync();
    } catch {
      return 'sync-failed';
    }
    try {
      await this.step('save-parent-sync');
      await syncDirStrict(dir);
    } catch {
      return 'parent-sync-failed';
    }
    return null;
  }

  /** 已受理：独占创建新文件并写入冻结字节；之后的任何结果都经过完整收尾，不抛出 */
  private async writeNew(f: Frozen, target: string, chain: OkChain, e0: number, kept: () => boolean): Promise<DiagSaveResult> {
    const dir = path.dirname(target);
    let fh: FileHandle;
    try {
      // 读写打开：同一句柄逐字节读回本次写入的内容（只读本次新建的文件）
      fh = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      const code = errCode(err);
      if (code === 'EEXIST' || code === 'ELOOP') return { status: 'rejected', code: 'exists', previewKept: kept() };
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'rejected', code: 'parent-changed', previewKept: kept() };
      return { status: 'failed', code: 'create-failed', cleanup: 'not-created', previewKept: kept() };
    }
    let id: string | null = null;
    let failure: DiagSaveFailCode | null = null;
    const prog = { written: 0 };
    let verified: Sig | null = null;
    try {
      await this.step('save-fstat');
      const st = await fh.stat({ bigint: true });
      id = idOf(st);
      if (!st.isFile() || st.nlink !== 1n || String(st.dev) !== chain.dev) failure = 'create-failed';
    } catch {
      failure = 'identity-unknown';
    }
    if (failure === null && id !== null) {
      try {
        failure = await this.fill(fh, f, target, dir, chain.key, id, e0, prog);
      } catch {
        failure = 'write-failed';
      }
      if (failure === null) {
        // 完整成功路径：逐字节读回整份冻结内容（≤ 报告上限），并复核身份、目录链与保护计数
        await this.step('save-before-verify').catch(() => undefined);
        const v = await this.ownCheck(fh, f, target, dir, chain.key, id, e0, f.bytes.length).catch(() => 'content-changed' as const);
        if (typeof v !== 'string') verified = v;
      }
    }
    let closeFailed = false;
    try {
      if (failure === null && verified !== null) await this.step('save-close');
      await fh.close();
    } catch {
      closeFailed = true;
      await fh.close().catch(() => undefined);
    }
    if (failure === null && closeFailed) failure = 'close-failed';
    if (failure !== null) return { status: 'failed', code: failure, cleanup: await this.cleanup(f, target, dir, chain.key, id, prog.written), previewKept: kept() };
    const unconfirmed: DiagSaveResult = { status: 'unconfirmed', code: 'post-verify-failed', cleanup: 'retained-unconfirmed', previewKept: kept() };
    // 内容已完整写入：读回不一致时保留，不删除也不覆写修复
    if (verified === null) return unconfirmed;
    // 关闭之后：路径仍指向本次文件，元数据与读回时一致，目录链未变
    const st = await lstat(target, { bigint: true }).catch(() => null);
    const after = await dirChain(dir);
    if (!st || idOf(st) !== id || st.nlink !== 1n || !sameSig(st, verified) || after.kind !== 'ok' || after.key !== chain.key) return unconfirmed;
    return { status: 'saved', bytes: f.bytes.length, previewKept: kept() };
  }

  /**
   * 失败收尾：只删除可确认是本次文件的路径——目录链未变、路径指向本次 inode、唯一链接、长度等于确认写入的字节数，
   * 且逐字节等于冻结内容的同长前缀；之后的外部改动（包括同 inode 改写）一律保留。
   * 注入点都在最终复核之前；最终复核与 unlink 系统调用之间没有可观察的 await，但仍有无法消除的极短窗口。
   */
  private async cleanup(f: Frozen, target: string, dir: string, chainKey: string, id: string | null, written: number): Promise<DiagCleanup> {
    if (id === null) return 'retained-unconfirmed';
    await this.step('save-before-cleanup').catch(() => undefined);
    try {
      await this.step('save-unlink');
    } catch {
      return 'remove-failed';
    }
    const proof = await ownedOnDisk(f.bytes, target, dir, chainKey, id, written);
    if (proof !== 'ok') return proof;
    try {
      await unlink(target);
    } catch (err) {
      return errCode(err) === 'ENOENT' ? 'absent' : 'remove-failed';
    }
    try {
      await syncDirStrict(dir);
      return 'removed';
    } catch {
      return 'removed-unsynced';
    }
  }

  private expire(): void {
    if (this.current && this.current.expiresAt <= this.now()) this.current = null;
  }

  private ready(f: Frozen, reused: boolean): DiagPreviewResult {
    return { status: 'ready', token: f.token, json: f.json, bytes: f.bytes.length, expiresAt: f.expiresAt, reused };
  }

  /** 保护配置的变更计数；读取失败或不是安全整数时为 NaN（与任何值都不相等，按已变化处理） */
  private epoch(): number {
    try {
      const e = this.opts.epoch?.() ?? 0;
      return Number.isSafeInteger(e) ? e : NaN;
    } catch {
      return NaN;
    }
  }

  private async step(name: DiagStep): Promise<void> {
    await this.opts.hooks?.step?.(name);
  }

  /** 生成报告文本；采集前后绑定计数或设置内容变化时返回 null */
  private async build(flavorId: number | null): Promise<string | null> {
    const e0 = this.epoch();
    const s = await this.readSettings();
    await this.step('after-settings');
    const aliases = new Aliases();
    const skipped = (reason: DiagReason) => section('skipped', reason);

    let targetState: DiagnosticReport['target']['state'];
    let root: string | null = null;
    if (flavorId === null) targetState = 'not-selected';
    else if (s.bindings === null) targetState = 'settings-unavailable';
    else {
      root = s.bindings.get(flavorId) ?? null;
      targetState = root === null ? 'not-bound' : 'bound';
    }
    const skipReason: DiagReason = targetState === 'settings-unavailable' ? 'settings-unavailable' : 'not-bound';

    let addons: DiagnosticReport['addons'] = { ...skipped(skipReason), total: 0, recoveryEntries: 0, purgeQueued: 0, items: [], omitted: noOmit() };
    let history: DiagnosticReport['history'] = { ...skipped(skipReason), ...emptyHistory(), ...this.storeState() };
    let health: DiagnosticReport['health'] = { ...skipped(skipReason), ...emptyHealth() };
    if (flavorId !== null && root !== null) {
      addons = await this.addonsSection(root, aliases);
      await this.step('after-manifest');
      history = { ...(await this.historySection(flavorId, root)), ...this.storeState() };
      await this.step('after-history');
      health = await this.healthSection(flavorId, root, e0, aliases);
      await this.step('after-health');
    }

    const s2 = await this.readSettings();
    if (this.epoch() !== e0 || Number.isNaN(e0) || s2.fingerprint !== s.fingerprint) return null;

    const boundFlavorIds = s.bindings ? [...s.bindings.keys()].sort((a, b) => a - b) : [];
    const report: DiagnosticReport = {
      format: 'azercube-diagnostic',
      schema: 1,
      consistency: 'not-atomic',
      app: { version: APP_VERSION_RE.test(this.opts.appVersion) ? this.opts.appVersion : 'unknown', platform: platformOf(this.opts.platform ?? process.platform) },
      generatedAt: nat(this.now()),
      limits: { ...this.limits },
      settings: { ...s.section, boundFlavorIds, unknownBindings: s.unknownBindings },
      target: { flavorId, state: targetState },
      addons,
      history,
      health,
    };
    return encode(report, this.limits.maxReportBytes);
  }

  // ---------- 设置 ----------

  private async readSettings(): Promise<SettingsView> {
    const r = await readSource(this.opts.settingsFile, this.limits.maxSettingsBytes);
    if (r.kind === 'absent') return { section: section('absent', 'absent'), bindings: new Map(), unknownBindings: 0, fingerprint: 'absent' };
    const fail = (reason: DiagReason): SettingsView => ({ section: section('unavailable', reason), bindings: null, unknownBindings: 0, fingerprint: `fail:${reason}` });
    if (r.kind === 'fail') return fail(r.reason);
    const fingerprint = `ok:${createHash('sha256').update(r.buf).digest('hex')}`;
    const j = jsonObject(r.buf);
    if (!j.ok) return { ...fail(j.reason), fingerprint };
    let parsed;
    try {
      parsed = parseSettings(j.text, 'settings.json');
    } catch {
      // 错误说明含文件路径，不使用
      return { ...fail('invalid-format'), fingerprint };
    }
    const bindings = new Map<number, string>();
    let unknownBindings = 0;
    for (const [k, v] of Object.entries(parsed.bindings)) {
      const id = Number(k);
      if (Number.isSafeInteger(id) && getFlavor(id) && String(id) === k) bindings.set(id, v);
      else unknownBindings++;
    }
    return { section: section('ok', null), bindings, unknownBindings, fingerprint };
  }

  // ---------- 插件清单 ----------

  private async addonsSection(root: string, aliases: Aliases): Promise<DiagnosticReport['addons']> {
    const base = { total: 0, recoveryEntries: 0, purgeQueued: 0, items: [] as DiagAddon[], omitted: noOmit() };
    const l = layoutFor(root);
    const chain = await dirChain(l.metaDir);
    if (chain.kind === 'absent') return { ...section('absent', 'absent'), ...base };
    if (chain.kind === 'fail') return { ...section('unavailable', chain.reason), ...base };
    // 未完成的插件操作（任何类型的 journal）：清单可能处于事务中间，不读取、不恢复
    const pending = async (): Promise<boolean> => {
      try {
        await lstat(l.journalPath);
        return true;
      } catch (err) {
        return errCode(err) !== 'ENOENT';
      }
    };
    if (await pending()) return { ...section('unavailable', 'pending-operation'), ...base };
    const r = await readSource(l.manifestPath, this.limits.maxManifestBytes);
    if (await pending()) return { ...section('unavailable', 'pending-operation'), ...base };
    if (r.kind === 'absent') return { ...section('absent', 'absent'), ...base };
    if (r.kind === 'fail') return { ...section('unavailable', r.reason), ...base };
    const j = jsonObject(r.buf);
    if (!j.ok) return { ...section('unavailable', j.reason), ...base };
    let m: Manifest;
    try {
      m = parseManifest(j.text);
    } catch {
      return { ...section('unavailable', 'invalid-format'), ...base };
    }
    const projects = Object.values(m.projects).sort((a, b) => a.modId.length - b.modId.length || (a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : 0));
    const L = this.limits;
    const items: DiagAddon[] = projects.slice(0, L.maxAddons).map((p, i) => ({
      alias: `p${i + 1}`,
      modId: MODID_RE.test(p.modId) ? p.modId : null,
      fileId: FILE_ID_RE.test(p.fileId) ? p.fileId : null,
      flavorId: getFlavor(p.flavorId) ? p.flavorId : null,
      folders: p.folders.slice(0, L.maxFoldersPerAddon).map((f) => aliases.of(f)),
      foldersOmitted: Math.max(0, p.folders.length - L.maxFoldersPerAddon),
    }));
    return {
      ...section('ok', null),
      total: projects.length,
      recoveryEntries: m.recovery.length,
      purgeQueued: m.purgeQueue.length,
      items,
      omitted: { limit: projects.length - items.length, byteBudget: 0 },
    };
  }

  // ---------- 操作记录 ----------

  private storeState(): Pick<DiagnosticReport['history'], 'unsaved' | 'dropped' | 'storeFailing'> {
    let st: { unsaved: unknown; dropped: unknown; failing: unknown } | undefined;
    try {
      st = this.opts.historyStatus?.();
    } catch {
      st = undefined;
    }
    return { unsaved: nat(st?.unsaved), dropped: nat(st?.dropped), storeFailing: typeof st?.failing === 'boolean' ? st.failing : null };
  }

  /**
   * 独立投影：只读记录文件，不进入操作记录的队列、不更新其状态。只统计属于当前游戏版本与目录的记录；
   * 本次运行之外留下的 accepted 按结果未确认统计，本次运行中的 accepted 仍是进行中，都不当作成功。
   */
  private async historySection(flavorId: number, root: string): Promise<Omit<DiagnosticReport['history'], 'unsaved' | 'dropped' | 'storeFailing'>> {
    const out = emptyHistory();
    const r = await readSource(this.opts.historyFile, this.limits.maxHistoryBytes);
    if (r.kind === 'absent') return { ...section('absent', 'absent'), ...out };
    if (r.kind === 'fail') return { ...section('unavailable', r.reason), ...out };
    const j = jsonObject(r.buf);
    if (!j.ok) return { ...section('unavailable', j.reason), ...out };
    if (!Array.isArray(j.v.entries)) return { ...section('unavailable', 'invalid-format'), ...out };
    const failures: (DiagFailure & { order: number })[] = [];
    j.v.entries.forEach((e, order) => {
      if (!isPlainObject(e) || !inSet(HISTORY_KINDS, e.kind) || !inSet(HISTORY_STATUSES, e.status) || typeof e.flavorId !== 'number' || typeof e.root !== 'string' || typeof e.instance !== 'string') {
        out.invalidEntries++;
        return;
      }
      if (e.flavorId !== flavorId || e.root !== root) return;
      const status: HistoryStatus = e.status === 'accepted' && e.instance !== this.opts.historyInstance ? 'unconfirmed' : e.status;
      out.total++;
      out.byStatus[status]++;
      if (status === 'failed' || status === 'unconfirmed') {
        failures.push({ kind: e.kind, status, at: nat(e.finishedAt) ?? nat(e.startedAt), modId: typeof e.modId === 'string' && MODID_RE.test(e.modId) ? e.modId : null, order });
      }
    });
    // 新的在前；时间未知的排在最后
    failures.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || b.order - a.order);
    const keep = failures.slice(0, this.limits.recentFailures);
    out.recentFailures = keep.map(({ kind, status, at, modId }) => ({ kind, status, at, modId }));
    out.omitted.limit = failures.length - keep.length;
    return { ...section(out.invalidEntries > 0 ? 'partial' : 'ok', null), ...out };
  }

  // ---------- 健康检查 ----------

  /**
   * 同时最多一个进行中的检查。进行中的检查属于另一目标时不启动新的检查（busy）；等待超过上限时报告仍在进行（不取消）。
   * 结果必须与本次目标一致，且检查是在本次采集开始时的绑定计数下启动的，否则不采用。
   */
  private async healthSection(flavorId: number, root: string, e0: number, aliases: Aliases): Promise<DiagnosticReport['health']> {
    const blank = emptyHealth();
    let run = this.healthRun;
    if (run && (run.flavorId !== flavorId || run.root !== root)) return { ...section('unavailable', 'busy'), ...blank };
    if (!run) {
      let p: Promise<HealthReport>;
      try {
        p = Promise.resolve(this.opts.health(flavorId, root));
      } catch {
        return { ...section('unavailable', 'failed'), ...blank };
      }
      const settled = p.then(
        (report): HealthOutcome => ({ ok: true, report }),
        (): HealthOutcome => ({ ok: false }),
      );
      const started: HealthRun = { flavorId, root, epoch: e0, settled };
      this.healthRun = started;
      void settled.then(() => {
        if (this.healthRun === started) this.healthRun = null;
      });
      run = started;
    }
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      run.settled,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.limits.healthWaitMs);
      }),
    ]);
    clearTimeout(timer);
    if (waited === 'timeout') return { ...section('unavailable', 'still-running'), ...blank };
    if (!waited.ok) return { ...section('unavailable', 'failed'), ...blank };
    if (run.epoch !== e0) return { ...section('unavailable', 'mismatch'), ...blank };
    return projectHealth(waited.report, flavorId, root, aliases, this.limits.maxHealthIssues);
  }
}

function emptyHistory(): Omit<DiagnosticReport['history'], keyof DiagSection | 'unsaved' | 'dropped' | 'storeFailing'> {
  const byStatus = Object.fromEntries(Object.keys(HISTORY_STATUSES).map((k) => [k, 0])) as Record<HistoryStatus, number>;
  return { total: 0, invalidEntries: 0, byStatus, recentFailures: [], omitted: noOmit() };
}

function emptyHealth(): Omit<DiagnosticReport['health'], keyof DiagSection> {
  return { status: null, unavailableReason: null, manifestState: null, counts: null, truncated: null, scanned: null, invalidIssues: 0, issues: [], omitted: noOmit() };
}

/** 健康检查结果的白名单投影：只取固定枚举、数量与别名；说明、目录名、依赖名、错误码文本都不输出 */
function projectHealth(r: HealthReport, flavorId: number, root: string, aliases: Aliases, maxIssues: number): DiagnosticReport['health'] {
  const failed = { ...section('unavailable', 'failed' as const), ...emptyHealth() };
  if (!isPlainObject(r)) return failed;
  if (r.flavorId !== flavorId || r.root !== root) return { ...failed, reason: 'mismatch' };
  if (!inSet(HEALTH_STATUSES, r.status) || !(r.unavailableReason === null || inSet(UNAVAILABLE_REASONS, r.unavailableReason)) || !inSet(MANIFEST_STATES, r.manifestState)) return failed;
  const c: Record<string, unknown> = isPlainObject(r.counts) ? r.counts : {};
  const counts = { warning: nat(c.warning), unknown: nat(c.unknown), info: nat(c.info) };
  const t: Record<string, unknown> = isPlainObject(r.truncated) ? r.truncated : {};
  const sc: Record<string, unknown> = isPlainObject(r.scanned) ? r.scanned : {};
  const scanned = { entries: nat(sc.entries), folders: nat(sc.folders), tocsRead: nat(sc.tocsRead), tocBytes: nat(sc.tocBytes), interfaceMatched: nat(sc.interfaceMatched) };
  if (Object.values(counts).some((v) => v === null) || Object.values(scanned).some((v) => v === null)) return failed;
  if (typeof t.entries !== 'boolean' || typeof t.tocBudget !== 'boolean' || typeof t.issues !== 'boolean' || !Array.isArray(r.issues)) return failed;

  const issues: DiagHealthIssue[] = [];
  let invalid = 0;
  let over = 0;
  for (const raw of r.issues as unknown[]) {
    if (!isPlainObject(raw) || !inSet(ISSUE_KINDS, raw.kind) || !inSet(SEVERITIES, raw.severity)) {
      invalid++;
      continue;
    }
    if (issues.length >= maxIssues) {
      over++;
      continue;
    }
    const issue: DiagHealthIssue = {
      kind: raw.kind,
      severity: raw.severity,
      folder: typeof raw.folder === 'string' ? aliases.of(raw.folder) : null,
      related: DEP_KINDS.has(raw.kind) && typeof raw.detail === 'string' ? aliases.of(raw.detail) : null,
    };
    if (raw.kind === 'interface-mismatch' && Array.isArray(raw.declared)) {
      issue.declared = raw.declared.filter((n): n is number => nat(n) !== null).slice(0, MAX_DECLARED);
    }
    issues.push(issue);
  }
  const state = r.status === 'complete' ? 'ok' : r.status;
  return {
    ...section(state, r.status === 'unavailable' ? (r.unavailableReason === 'pending-operation' ? 'pending-operation' : 'failed') : null),
    status: r.status,
    unavailableReason: r.unavailableReason,
    manifestState: r.manifestState,
    counts: counts as Record<HealthSeverity, number>,
    truncated: { entries: t.entries, tocBudget: t.tocBudget, issues: t.issues },
    scanned: scanned as NonNullable<DiagnosticReport['health']['scanned']>,
    invalidIssues: invalid,
    issues,
    omitted: { limit: over, byteBudget: 0 },
  };
}

/**
 * 序列化为最终文本（UTF-8，结尾换行）。超过大小上限时依次从最近失败、健康提示、插件列表末尾省略条目并计数，
 * 直到整份 JSON 不超过上限；不在 JSON 中途截断。
 */
function encode(r: DiagnosticReport, max: number): string {
  const lists: { arr: unknown[]; om: DiagOmitted }[] = [
    { arr: r.history.recentFailures, om: r.history.omitted },
    { arr: r.health.issues, om: r.health.omitted },
    { arr: r.addons.items, om: r.addons.omitted },
  ];
  for (;;) {
    const text = `${JSON.stringify(r, null, 1)}\n`;
    const size = Buffer.byteLength(text, 'utf8');
    if (size <= max) return text;
    const l = lists.find((x) => x.arr.length > 0);
    if (!l) throw new RangeError('诊断报告的固定部分超过大小上限');
    const per = Buffer.byteLength(JSON.stringify(l.arr[l.arr.length - 1], null, 1), 'utf8') + 2;
    const n = Math.min(l.arr.length, Math.max(1, Math.ceil((size - max) / per)));
    l.arr.splice(l.arr.length - n, n);
    l.om.byteBudget += n;
  }
}
