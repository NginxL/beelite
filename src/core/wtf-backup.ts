// 可选本地 WTF 配置备份：用户主动启用、选择本地位置、手动创建、重新校验、在访达中查看。
// - 默认关闭；未启用时不访问 WTF，也不访问备份位置。不检测游戏是否运行，不提供恢复、定时、云端或自动删除。
// - 备份位置是用户所选目录下新建的专属容器「AzerCube WTF Backup-<随机编号>」，带标记文件；不接管已有目录。
// - 范围：全部 WTF（清单 schema 1）、单个账号或同一账号的多个角色（schema 2）。缩小范围时只在所选路径上下降，
//   未选的账号 / 服务器 / 角色只读取名字，不 lstat、不进入；账号与角色目录列表只在已启用且用户请求时读取名称。
// - 所选范围内遇到符号链接、多硬链接文件、特殊文件、名称冲突或超出上限时整份失败；复制期间源发生变化直接失败，不自动重试。
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
  BackupCatalog,
  BackupLimits,
  BackupRunResult,
  BackupScope,
  BackupSnapshotInfo,
  BackupSnapshotStatus,
  BackupState,
  BackupTaskInfo,
  BackupTaskKind,
  BackupUsage,
  BackupVerifyRecord,
  BackupVerifyResult,
  CatalogLimits,
} from '../shared/backup-types';
import { MAX_BACKUP_SCOPE_CHARACTERS as MAX_SCOPE_CHARACTERS } from '../shared/backup-types';
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

export const DEFAULT_CATALOG_LIMITS: Readonly<CatalogLimits> = Object.freeze({
  maxAccounts: 64,
  maxRealmsPerAccount: 256,
  maxCharactersPerRealm: 256,
  maxCharactersTotal: 4096,
  maxNames: 50000,
  maxWarnings: 50,
});

/** 固定目录名与角色识别文件名：按 foldKey 唯一匹配 */
const ACCOUNT_KEY = foldKey('Account');
const SAVED_VARIABLES_KEY = foldKey('SavedVariables');
const CHARACTER_MARKER_KEYS: ReadonlySet<string> = new Set(['AddOns.txt', 'bindings-cache.wtf', 'config-cache.wtf'].map(foldKey));

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
  /** 测试注入：账号与角色目录列表的上限 */
  catalogLimits?: Partial<CatalogLimits>;
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

function resolveCatalogLimits(over: Partial<CatalogLimits> | undefined): CatalogLimits {
  const limits: CatalogLimits = { ...DEFAULT_CATALOG_LIMITS, ...over };
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error(`目录列表上限 ${k} 不合法`);
  }
  return limits;
}

// ---------- 备份范围 ----------

const ALL_SCOPE: BackupScope = Object.freeze({ kind: 'all' as const });

function scopeError(reason: string): UserError {
  return new UserError(`备份范围无效（${reason}），请重新读取账号与角色后再试`, 'backup-scope');
}

/** 原型为 Object.prototype 或 null 的普通对象 */
function isPureObject(v: unknown): v is object {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 自有属性恰为 keys 且都是数据属性（不触发访问器）；返回各属性值 */
function exactData(v: object, keys: readonly string[], what: string): Record<string, unknown> {
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) throw scopeError(`${what}的字段不正确`);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) throw scopeError(`${what}的字段不正确`);
    out[k] = d.value;
  }
  return out;
}

function scopeName(v: unknown, what: string): string {
  if (typeof v !== 'string' || !isSafeSegment(v) || v.startsWith('.')) throw scopeError(`${what}名称不安全`);
  return v;
}

/**
 * 严格解析备份范围：普通对象、字段精确、名称安全且不以 . 开头（单段、不超过 255 字节）；
 * characters 为无空洞的真数组，1–256 项，按大小写 / Unicode 无关的服务器 + 角色去重，服务器不能是 SavedVariables。
 * 名称原样保留（不做规范化改写）。返回深拷贝并深度冻结。
 */
export function parseBackupScope(v: unknown): BackupScope {
  if (!isPureObject(v)) throw scopeError('不是普通对象');
  const kd = Object.getOwnPropertyDescriptor(v, 'kind');
  const kind = kd && 'value' in kd ? kd.value : undefined;
  if (kind === 'all') {
    exactData(v, ['kind'], '范围');
    return ALL_SCOPE;
  }
  if (kind === 'account') {
    const d = exactData(v, ['kind', 'account'], '范围');
    return Object.freeze({ kind: 'account' as const, account: scopeName(d.account, '账号') });
  }
  if (kind !== 'characters') throw scopeError('类型不受支持');
  const d = exactData(v, ['kind', 'account', 'characters'], '范围');
  const account = scopeName(d.account, '账号');
  const arr = d.characters;
  if (!Array.isArray(arr) || Object.getPrototypeOf(arr) !== Array.prototype) throw scopeError('角色列表不是数组');
  if (arr.length < 1 || arr.length > MAX_SCOPE_CHARACTERS) throw scopeError(`角色数量须为 1–${MAX_SCOPE_CHARACTERS} 个`);
  // 自有键只能是 length 与每个下标（拒绝空洞与额外属性）
  if (Reflect.ownKeys(arr).length !== arr.length + 1) throw scopeError('角色列表格式不正确');
  const seen = new Set<string>();
  /** 同一 foldKey 的服务器必须使用完全相同的名称（否则后续定位会把它们混为一个） */
  const realmSpelling = new Map<string, string>();
  const characters: Array<{ realm: string; character: string }> = [];
  for (let i = 0; i < arr.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(arr, String(i));
    if (!slot || !('value' in slot) || !isPureObject(slot.value)) throw scopeError('角色列表格式不正确');
    const item = exactData(slot.value, ['realm', 'character'], '角色');
    const realm = scopeName(item.realm, '服务器');
    const character = scopeName(item.character, '角色');
    if (foldKey(realm) === SAVED_VARIABLES_KEY) throw scopeError('SavedVariables 不是服务器');
    const spelled = realmSpelling.get(foldKey(realm));
    if (spelled !== undefined && spelled !== realm) throw scopeError('同一服务器使用了大小写或 Unicode 形式不同的名称');
    realmSpelling.set(foldKey(realm), realm);
    const key = `${foldKey(realm)}/${foldKey(character)}`;
    if (seen.has(key)) throw scopeError('角色重复');
    seen.add(key);
    characters.push(Object.freeze({ realm, character }));
  }
  Object.freeze(characters);
  return Object.freeze({ kind: 'characters' as const, account, characters });
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
  /** 途经目录：只为容纳所选子树，复核时只比较身份与类型（未选兄弟的变化不影响） */
  pass?: boolean;
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

/**
 * 两次枚举是否完全一致（集合、类型、每项身份 / 大小 / 时间）；返回第一处不同的相对路径。
 * 途经目录只比较身份与类型：其下未选兄弟的增删会改变目录时间，但不属于所选范围的变化。
 */
function walkDiff(a: WalkEntry[], b: WalkEntry[]): string | null {
  const prev = new Map(a.map((e) => [e.rel, e]));
  for (const e of b) {
    const p = prev.get(e.rel);
    if (!p || p.kind !== e.kind || !!p.pass !== !!e.pass) return e.rel;
    if (p.pass ? idOf(p.st) !== idOf(e.st) : !sameStat(p.st, e.st)) return e.rel;
    prev.delete(e.rel);
  }
  for (const rel of prev.keys()) return rel;
  return null;
}

// ---------- 按范围枚举源 ----------

interface PassBudget {
  left: number;
  total: number;
}

/**
 * 在途经目录中按名称定位子目录：只读取名字（计入途经预算），未命中的名字不 lstat、不校验、不进入。
 * wanted：foldKey → 必须逐字节相等的名称（固定名称为 null，只按 foldKey 匹配）。
 * 同一 foldKey 命中多个名字，或与所选名称只差大小写 / Unicode 形式时失败。
 */
async function findPass(dirAbs: string, relDir: string, wanted: Map<string, string | null>, budget: PassBudget, o: WalkOptions): Promise<Map<string, string>> {
  const hits = new Map<string, string[]>();
  throwIfAborted(o.signal);
  const dir = await opendir(dirAbs);
  try {
    for (let d = await dir.read(); d !== null; d = await dir.read()) {
      throwIfAborted(o.signal);
      if (budget.left <= 0) throw limitError('途经目录的条目数量', budget.total, 'count');
      budget.left--;
      const k = foldKey(d.name);
      if (!wanted.has(k)) continue;
      const list = hits.get(k) ?? [];
      list.push(d.name);
      hits.set(k, list);
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  const found = new Map<string, string>();
  for (const [k, exact] of wanted) {
    const list = hits.get(k);
    if (!list) continue;
    if (list.length > 1) throw scopeError(`「${relDir || 'WTF'}」中有多个仅大小写或 Unicode 形式不同的「${list[0]}」`);
    if (exact !== null && list[0] !== exact) throw scopeError(`「${relDir ? `${relDir}/` : ''}${list[0]}」与所选名称「${exact}」的大小写或 Unicode 形式不一致`);
    found.set(k, list[0]);
  }
  return found;
}

/** 已定位的目录：必须是同卷真实目录（不跟随链接） */
async function dirEntry(base: string, rel: string, dev: bigint, o: WalkOptions, pass: boolean): Promise<WalkEntry> {
  if (rel.split('/').length > o.maxDepth) throw limitError('目录层数', o.maxDepth, 'count');
  let st: BigIntStats;
  try {
    st = await lstat(path.join(base, ...rel.split('/')), { bigint: true });
  } catch (err) {
    if (errCode(err) === 'ENOENT') throw scopeError(`「${rel}」已不存在`);
    throw err;
  }
  if (st.isSymbolicLink()) throw unsupported(o.label, rel, '是符号链接');
  if (!st.isDirectory()) throw unsupported(o.label, rel, '不是文件夹');
  if (st.dev !== dev) throw unsupported(o.label, rel, '位于其他磁盘卷');
  return pass ? { rel, kind: 'dir', st, pass: true } : { rel, kind: 'dir', st };
}

/** 严格完整枚举 rel 之下的子树（原有全部检查），结果追加到 out；共用总条目与层数上限 */
async function walkSubtree(base: string, rel: string, out: WalkEntry[], o: WalkOptions): Promise<void> {
  if (out.length > o.maxEntries) throw limitError('文件与目录数量', o.maxEntries, 'count');
  const sub = await walkTree(path.join(base, ...rel.split('/')), {
    ...o,
    maxEntries: o.maxEntries - out.length,
    maxDepth: o.maxDepth - rel.split('/').length,
    label: `${o.label}/${rel}`,
  });
  for (const e of sub) out.push({ ...e, rel: `${rel}/${e.rel}` });
}

/**
 * 按冻结范围枚举 WTF。all 与原行为相同；其余范围每次都从 WTF 重新按名称定位，只在所选路径上下降：
 * - account：WTF、Account 为途经目录；Account/<账号> 严格完整子树。
 * - characters：Account/<账号> 的直属条目逐项严格分类（普通文件全部纳入，SavedVariables 完整子树，所选服务器作途经目录，
 *   其他目录跳过不进入）；所选服务器下只定位所选角色，角色目录严格完整子树，顶层须有识别文件（普通文件）。
 * 父目录总是先于子项出现在结果中。
 */
async function walkScopedSource(wtf: string, scope: BackupScope, o: WalkOptions): Promise<WalkEntry[]> {
  if (scope.kind === 'all') return walkTree(wtf, o);
  const baseSt = await lstat(wtf, { bigint: true });
  if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) throw unsupported(o.label, '.', '不是普通文件夹');
  const dev = baseSt.dev;
  const budget: PassBudget = { left: o.maxEntries, total: o.maxEntries };
  const out: WalkEntry[] = [];
  // 所有写入结果的条目（途经目录、直属文件、子树）共用同一总量上限；子树由 walkSubtree 按剩余量约束
  const push = (e: WalkEntry) => {
    if (out.length + 1 > o.maxEntries) throw limitError('文件与目录数量', o.maxEntries, 'count');
    out.push(e);
  };

  const accountName = (await findPass(wtf, '', new Map<string, string | null>([[ACCOUNT_KEY, null]]), budget, o)).get(ACCOUNT_KEY);
  if (!accountName) throw scopeError('WTF 中没有 Account 目录');
  push(await dirEntry(wtf, accountName, dev, o, true));
  const acctKey = foldKey(scope.account);
  const acctName = (await findPass(path.join(wtf, accountName), accountName, new Map<string, string | null>([[acctKey, scope.account]]), budget, o)).get(acctKey);
  if (!acctName) throw scopeError(`找不到账号「${scope.account}」`);
  const acctRel = `${accountName}/${acctName}`;
  if (scope.kind === 'account') {
    push(await dirEntry(wtf, acctRel, dev, o, false));
    await walkSubtree(wtf, acctRel, out, o);
    return out;
  }

  push(await dirEntry(wtf, acctRel, dev, o, true));
  const realms = new Map<string, string[]>();
  for (const c of scope.characters) realms.set(c.realm, [...(realms.get(c.realm) ?? []), c.character]);
  const realmByKey = new Map([...realms.keys()].map((r) => [foldKey(r), r]));

  // 账号目录直属条目逐项严格分类
  const acctAbs = path.join(wtf, accountName, acctName);
  const names: string[] = [];
  const seen = new Set<string>();
  throwIfAborted(o.signal);
  const dir = await opendir(acctAbs);
  try {
    for (let d = await dir.read(); d !== null; d = await dir.read()) {
      throwIfAborted(o.signal);
      // 读到的名字计入扫描预算；写入结果的条目由 push 按总量约束
      if (budget.left <= 0) throw limitError('途经目录的条目数量', budget.total, 'count');
      budget.left--;
      const rel = `${acctRel}/${d.name}`;
      if (!isSafeSegment(d.name)) throw unsupported(o.label, rel, '的名称不受支持');
      const k = foldKey(d.name);
      if (seen.has(k)) throw unsupported(o.label, rel, '与同目录中的其他条目仅大小写或 Unicode 形式不同');
      seen.add(k);
      names.push(d.name);
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  names.sort();
  const realmDirs: string[] = [];
  for (const name of names) {
    throwIfAborted(o.signal);
    const rel = `${acctRel}/${name}`;
    if (rel.split('/').length > o.maxDepth) throw limitError('目录层数', o.maxDepth, 'count');
    const st = await lstat(path.join(acctAbs, name), { bigint: true });
    if (st.isSymbolicLink()) throw unsupported(o.label, rel, '是符号链接');
    if (st.dev !== dev) throw unsupported(o.label, rel, '位于其他磁盘卷');
    if (st.isFile()) {
      if (o.rejectHardlinks && st.nlink > 1n) throw unsupported(o.label, rel, '有多个硬链接');
      push({ rel, kind: 'file', st });
      continue;
    }
    if (!st.isDirectory()) throw unsupported(o.label, rel, '是特殊文件');
    const k = foldKey(name);
    if (k === SAVED_VARIABLES_KEY) {
      push({ rel, kind: 'dir', st });
      await walkSubtree(wtf, rel, out, o);
      continue;
    }
    const realm = realmByKey.get(k);
    if (realm === undefined) continue; // 未选目录：不进入
    if (realm !== name) throw scopeError(`服务器「${name}」与所选名称「${realm}」的大小写或 Unicode 形式不一致`);
    push({ rel, kind: 'dir', st, pass: true });
    realmDirs.push(name);
  }
  for (const realm of realms.keys()) if (!realmDirs.includes(realm)) throw scopeError(`找不到服务器「${realm}」`);

  // 所选服务器下只定位所选角色
  for (const realm of realmDirs) {
    const realmRel = `${acctRel}/${realm}`;
    const chars = [...(realms.get(realm) ?? [])].sort();
    const found = await findPass(path.join(acctAbs, realm), realmRel, new Map(chars.map((c) => [foldKey(c), c])), budget, o);
    for (const character of chars) {
      const hit = found.get(foldKey(character));
      if (!hit) throw scopeError(`找不到角色「${realm}/${character}」`);
      const rel = `${realmRel}/${hit}`;
      push(await dirEntry(wtf, rel, dev, o, false));
      const before = out.length;
      await walkSubtree(wtf, rel, out, o);
      const depth = rel.split('/').length + 1;
      const marked = out.slice(before).some((e) => e.kind === 'file' && e.rel.split('/').length === depth && CHARACTER_MARKER_KEYS.has(foldKey(path.posix.basename(e.rel))));
      if (!marked) throw scopeError(`角色「${realm}/${character}」缺少识别文件（AddOns.txt、bindings-cache.wtf 或 config-cache.wtf）`);
    }
  }
  return out;
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
  /** 1：完整 WTF（0.2.0 格式，不含 scope 字段）；2：缩小范围，必须带 scope */
  schema: 1 | 2;
  snapshotId: string;
  createdAt: number;
  appVersion: string;
  flavorId: number;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  /** 相对 WTF 的全部文件与目录（含空目录）；文件带大小与 SHA-256。清单不包含自身的校验值 */
  entries: ManifestEntry[];
  /** schema 1 视为 all */
  scope: BackupScope;
}

/** 写入格式：完整 WTF 仍写 schema 1（不含 scope，0.2.0 可读），缩小范围写 schema 2 并带 scope */
function serializeManifest(m: SnapshotManifest): string {
  const { scope, ...rest } = m;
  return JSON.stringify(m.schema === 1 ? rest : { ...rest, scope }, null, 1);
}

function badManifest(reason: string): UserError {
  return new UserError(`备份清单不合法（${reason}）`, 'backup-manifest');
}

/**
 * schema 2 的范围约束：每个条目都落在范围允许的区域内，且账号、所选服务器、所选角色目录与角色识别文件都存在。
 * 固定目录名 Account / SavedVariables / 识别文件按 foldKey 匹配；所选名称逐字节相等。返回第一处问题。
 */
function scopeEntriesProblem(scope: BackupScope, entries: ManifestEntry[]): string | null {
  if (scope.kind === 'all') return null;
  const realms = new Set(scope.kind === 'characters' ? scope.characters.map((c) => c.realm) : []);
  const pairs = new Set(scope.kind === 'characters' ? scope.characters.map((c) => `${c.realm}/${c.character}`) : []);
  const outside = (p: string) => `「${p}」不在备份范围内`;
  let accountDir: string | null = null;
  for (const e of entries) {
    const s = e.path.split('/');
    if (foldKey(s[0]) !== ACCOUNT_KEY) return outside(e.path);
    if (s.length === 1) {
      if (e.type !== 'dir') return outside(e.path);
      accountDir = s[0];
      continue;
    }
    if (s[1] !== scope.account) return outside(e.path);
    if (s.length === 2) {
      if (e.type !== 'dir') return outside(e.path);
      continue;
    }
    if (scope.kind === 'account') continue;
    const third = s[2];
    if (s.length === 3) {
      if (e.type === 'file' || foldKey(third) === SAVED_VARIABLES_KEY || realms.has(third)) continue;
      return outside(e.path);
    }
    if (foldKey(third) === SAVED_VARIABLES_KEY) continue;
    if (!realms.has(third) || !pairs.has(`${third}/${s[3]}`)) return outside(e.path);
    if (s.length === 4 && e.type !== 'dir') return outside(e.path);
  }
  if (accountDir === null) return '缺少 Account 目录';
  const types = new Map(entries.map((e) => [e.path, e.type]));
  const markedDirs = new Set(entries.filter((e) => e.type === 'file' && CHARACTER_MARKER_KEYS.has(foldKey(path.posix.basename(e.path)))).map((e) => path.posix.dirname(e.path)));
  const acct = `${accountDir}/${scope.account}`;
  if (types.get(acct) !== 'dir') return `缺少账号目录「${scope.account}」`;
  if (scope.kind === 'account') return null;
  for (const realm of realms) if (types.get(`${acct}/${realm}`) !== 'dir') return `缺少服务器目录「${realm}」`;
  for (const pair of pairs) {
    const dir = `${acct}/${pair}`;
    if (types.get(dir) !== 'dir') return `缺少角色目录「${pair}」`;
    if (!markedDirs.has(dir)) return `角色「${pair}」缺少识别文件`;
  }
  return null;
}

function parseManifest(buf: Buffer, expectedId: string, limits: BackupLimits): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw badManifest('无法解析');
  }
  if (!isPlainObject(raw) || raw.format !== FORMAT || raw.kind !== 'snapshot' || (raw.schema !== 1 && raw.schema !== 2)) throw badManifest('格式或版本不受支持');
  if (raw.snapshotId !== expectedId) throw badManifest('编号与目录不符');
  let scope: BackupScope = ALL_SCOPE;
  if (raw.schema === 2) {
    // schema 2 必须带合法范围；缺失或不合法不回退为全部 WTF
    try {
      scope = parseBackupScope(raw.scope);
    } catch {
      throw badManifest('范围缺失或不合法');
    }
  }
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
  const problem = scopeEntriesProblem(scope, entries);
  if (problem) throw badManifest(`条目与范围不符：${problem}`);
  return { format: FORMAT, kind: 'snapshot', schema: raw.schema === 2 ? 2 : 1, snapshotId: expectedId, createdAt: raw.createdAt, appVersion: raw.appVersion, flavorId: raw.flavorId, fileCount: files, dirCount: dirs, totalBytes: total, entries, scope };
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
  return { id, createdAt: 0, appVersion: '', flavorId: 0, fileCount: 0, dirCount: 0, totalBytes: 0, scope: null, actualBytes, status, reason, lastVerify };
}

function manifestSnapshot(m: SnapshotManifest, actualBytes: number, status: BackupSnapshotStatus, reason: string | null, lastVerify: BackupVerifyRecord | null): BackupSnapshotInfo {
  return { id: m.snapshotId, createdAt: m.createdAt, appVersion: m.appVersion, flavorId: m.flavorId, fileCount: m.fileCount, dirCount: m.dirCount, totalBytes: m.totalBytes, scope: m.scope, actualBytes, status, reason, lastVerify };
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

// ---------- 账号与角色目录列表 ----------

/** 列表读取中止：global 为 true 时（总名称或总角色数耗尽）其后账号不再读取角色 */
class CatalogStop extends Error {
  constructor(
    message: string,
    readonly global: boolean,
  ) {
    super(message);
  }
}

function catalogLimitError(what: string): UserError {
  return new UserError(`账号与角色目录超出列表上限（${what}），无法完整列出；可改用全部 WTF 备份`, 'backup-catalog-limit');
}

/**
 * 有界列出 Account/<账号>/<服务器>/<角色>：只读取目录项名称并对候选做 lstat，不打开任何文件、不递归角色目录。
 * 候选角色目录只做一次浅层读取名称，识别文件按 foldKey 匹配（同名冲突则跳过该角色），唯一匹配者须是单一硬链接的普通文件。
 * 链接、跨卷、名称不受支持或冲突的条目跳过并写入提示；Account 缺失或无法读取时报错，不当作没有账号。
 */
async function scanCatalog(wtf: string, limits: CatalogLimits): Promise<{ accounts: BackupCatalog['accounts']; warnings: string[] }> {
  const dev = (await lstat(wtf, { bigint: true })).dev;
  let namesLeft = limits.maxNames;
  let charsLeft = limits.maxCharactersTotal;
  const warnings: string[] = [];
  let hidden = 0;
  const warn = (m: string) => {
    if (warnings.length < limits.maxWarnings) warnings.push(m);
    else hidden++;
  };
  const show = (name: string) => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);

  const readNames = async (abs: string): Promise<string[]> => {
    const out: string[] = [];
    const dir = await opendir(abs);
    try {
      for (let d = await dir.read(); d !== null; d = await dir.read()) {
        if (namesLeft <= 0) throw new CatalogStop(`读取的目录项超过 ${limits.maxNames} 个，未列出全部角色，只能整账号备份`, true);
        namesLeft--;
        out.push(d.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return out;
  };

  /** 名称安全、不以 . 开头、同目录内 foldKey 唯一的名字（排序）；冲突与不受支持的名字写入提示 */
  const candidates = (names: string[], where: string, exclude: string | null): string[] => {
    const groups = new Map<string, string[]>();
    for (const n of names) {
      if (n.startsWith('.')) continue;
      if (!isSafeSegment(n)) {
        warn(`已跳过名称不受支持的条目：${where}/${show(n)}`);
        continue;
      }
      const k = foldKey(n);
      if (k === exclude) continue;
      const list = groups.get(k);
      if (list) list.push(n);
      else groups.set(k, [n]);
    }
    const out: string[] = [];
    for (const list of groups.values()) {
      if (list.length > 1) warn(`已跳过仅大小写或 Unicode 形式不同的同名条目：${where}/${list.map(show).join('、')}`);
      else out.push(list[0]);
    }
    return out.sort();
  };

  const kindOf = async (abs: string, label: string): Promise<'dir' | 'file' | 'skip'> => {
    let st: BigIntStats;
    try {
      st = await lstat(abs, { bigint: true });
    } catch {
      warn(`无法读取：${label}`);
      return 'skip';
    }
    if (st.isSymbolicLink()) {
      warn(`已跳过符号链接：${label}`);
      return 'skip';
    }
    if (st.dev !== dev) {
      warn(`已跳过位于其他磁盘卷的条目：${label}`);
      return 'skip';
    }
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    warn(`已跳过特殊文件：${label}`);
    return 'skip';
  };

  const hasMarker = async (charAbs: string, label: string): Promise<boolean> => {
    let names: string[];
    try {
      names = await readNames(charAbs);
    } catch (err) {
      if (err instanceof CatalogStop) throw err;
      warn(`无法读取角色目录：${label}`);
      return false;
    }
    const groups = new Map<string, string[]>();
    for (const n of names) {
      const k = foldKey(n);
      if (!CHARACTER_MARKER_KEYS.has(k)) continue;
      const list = groups.get(k);
      if (list) list.push(n);
      else groups.set(k, [n]);
    }
    if ([...groups.values()].some((l) => l.length > 1)) {
      warn(`已跳过识别文件名称冲突的角色目录：${label}`);
      return false;
    }
    // 所有匹配到的识别文件都必须是单一硬链接的同卷普通文件；任一不受支持则跳过（备份时整棵角色目录也会因此失败）
    if (groups.size === 0) return false;
    for (const [n] of groups.values()) {
      const st = await lstat(path.join(charAbs, n), { bigint: true }).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1n || st.dev !== dev) {
        warn(`已跳过识别文件不受支持（链接、多硬链接、特殊文件或无法读取）的角色目录：${label}`);
        return false;
      }
    }
    return true;
  };

  const listRealms = async (acctAbs: string, label: string): Promise<Array<{ realm: string; characters: string[] }>> => {
    const realmNames: string[] = [];
    for (const n of candidates(await readNames(acctAbs), label, SAVED_VARIABLES_KEY)) {
      if ((await kindOf(path.join(acctAbs, n), `${label}/${show(n)}`)) !== 'dir') continue;
      if (realmNames.length >= limits.maxRealmsPerAccount) throw new CatalogStop(`服务器超过 ${limits.maxRealmsPerAccount} 个，未列出角色，只能整账号备份`, false);
      realmNames.push(n);
    }
    const realms: Array<{ realm: string; characters: string[] }> = [];
    for (const realm of realmNames) {
      const realmAbs = path.join(acctAbs, realm);
      const realmLabel = `${label}/${show(realm)}`;
      let names: string[];
      try {
        names = await readNames(realmAbs);
      } catch (err) {
        if (err instanceof CatalogStop) throw err;
        warn(`无法读取服务器目录：${realmLabel}`);
        continue;
      }
      const characters: string[] = [];
      let directFiles = 0;
      for (const n of candidates(names, realmLabel, SAVED_VARIABLES_KEY)) {
        const kind = await kindOf(path.join(realmAbs, n), `${realmLabel}/${show(n)}`);
        if (kind === 'file') directFiles++;
        if (kind !== 'dir' || !(await hasMarker(path.join(realmAbs, n), `${realmLabel}/${show(n)}`))) continue;
        if (characters.length >= limits.maxCharactersPerRealm) throw new CatalogStop(`服务器 ${show(realm)} 的角色超过 ${limits.maxCharactersPerRealm} 个，只能整账号备份`, false);
        if (charsLeft <= 0) throw new CatalogStop(`角色总数超过 ${limits.maxCharactersTotal} 个，未列出全部角色，只能整账号备份`, true);
        charsLeft--;
        characters.push(n);
      }
      if (directFiles > 0) warn(`服务器目录 ${realmLabel} 下有 ${directFiles} 个直属文件，按角色备份不包含它们；需要时请选择整账号备份`);
      if (characters.length > 0) realms.push({ realm, characters });
    }
    return realms;
  };

  // WTF 与 Account：无法定位或超出上限时整体失败，不当作没有账号
  const readTop = async (abs: string, what: string): Promise<string[]> => {
    try {
      return await readNames(abs);
    } catch (err) {
      if (err instanceof CatalogStop) throw catalogLimitError(`读取的目录项超过 ${limits.maxNames} 个`);
      const c = errCode(err);
      throw new UserError(`无法读取 ${what}${c ? `（${c}）` : ''}，无法列出账号；可改用全部 WTF 备份`, 'backup-catalog');
    }
  };
  const hits = (await readTop(wtf, 'WTF 目录')).filter((n) => foldKey(n) === ACCOUNT_KEY);
  if (hits.length > 1) throw new UserError('WTF 中有多个仅大小写或 Unicode 形式不同的 Account 目录，无法确定账号目录；可改用全部 WTF 备份', 'backup-catalog');
  if (hits.length === 0) throw new UserError('WTF 中没有 Account 目录，未发现账号；可改用全部 WTF 备份', 'backup-catalog');
  const accountRoot = path.join(wtf, hits[0]);
  const ast = await lstat(accountRoot, { bigint: true });
  if (ast.isSymbolicLink() || !ast.isDirectory() || ast.dev !== dev) throw new UserError('WTF/Account 不是同一磁盘上的普通文件夹，无法列出账号；可改用全部 WTF 备份', 'backup-catalog');
  const accountNames: string[] = [];
  for (const n of candidates(await readTop(accountRoot, 'Account 目录'), hits[0], SAVED_VARIABLES_KEY)) {
    if ((await kindOf(path.join(accountRoot, n), `${hits[0]}/${show(n)}`)) !== 'dir') continue;
    if (accountNames.length >= limits.maxAccounts) throw catalogLimitError(`账号超过 ${limits.maxAccounts} 个`);
    accountNames.push(n);
  }

  const accounts: BackupCatalog['accounts'] = [];
  let exhausted: string | null = null;
  for (const account of accountNames) {
    if (exhausted) {
      accounts.push({ account, realms: [], characterError: exhausted });
      continue;
    }
    try {
      accounts.push({ account, realms: await listRealms(path.join(accountRoot, account), `${hits[0]}/${show(account)}`), characterError: null });
    } catch (err) {
      if (err instanceof CatalogStop) {
        if (err.global) exhausted = err.message;
        accounts.push({ account, realms: [], characterError: err.message });
      } else {
        const c = errCode(err);
        accounts.push({ account, realms: [], characterError: `无法读取该账号目录${c ? `（${c}）` : ''}，只能整账号备份` });
      }
    }
  }
  if (hidden > 0) warnings[warnings.length - 1] = `另有 ${hidden + 1} 条提示未显示`;
  return { accounts, warnings };
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
  readonly catalogLimits: CatalogLimits;
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
    this.catalogLimits = resolveCatalogLimits(opts.catalogLimits);
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
  private begin(kind: BackupTaskKind, flavorId: number, root: string, snapshotId: string | null, scope: BackupScope | null): ActiveTask {
    if (this.closed || this.active || this.configuring) throw this.busyError();
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const task: ActiveTask = {
      info: { id: newTaskId(), kind, flavorId, root, snapshotId, scope, phase: 'preparing', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, cancelling: false, startedAt: Date.now() },
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

  // ---------- 账号与角色目录列表 ----------

  /**
   * 读取账号与角色目录列表：只在已启用且用户明确请求时调用；不要求备份位置可用。
   * 只读取目录项名称与候选的 lstat（不打开任何文件、不递归角色目录）；回包前复核绑定与源目录身份。结果不持久化、不写日志。
   */
  async catalog(flavorId: number, expectedRoot: string): Promise<BackupCatalog> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    if (this.closed) throw this.busyError();
    const root = await this.checkTarget(f, expected);
    await this.enabledRecord(f, root);
    const src = await this.openSource(root);
    const scan = await scanCatalog(src.wtf, this.catalogLimits);
    await this.checkTarget(f, expected);
    try {
      await this.recheckSource(src);
    } catch {
      throw new UserError('读取期间游戏目录或其 WTF 文件夹被移动或替换，请重新读取', 'backup-source-changed');
    }
    return { flavorId: f, root, accounts: scan.accounts, warnings: scan.warnings, scannedAt: Date.now() };
  }

  // ---------- 备份 ----------

  /**
   * 手动备份；Promise 在文件句柄关闭、临时内容收尾、占用标记释放之后才结束。已受理的任务固定原目录与范围。
   * scope 在受理前严格解析并冻结；省略时为全部 WTF（仅供进程内旧调用，IPC 必须显式传入）。
   */
  async run(flavorId: number, expectedRoot: string, scope: unknown = ALL_SCOPE): Promise<BackupRunResult> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot, '目标目录');
    const fixed = parseBackupScope(scope);
    const task = this.begin('run', f, expected, null, fixed);
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
    // 首次枚举与两次源复核共用同一个冻结范围，每次都从 WTF 重新按名称定位
    const scope = info.scope ?? ALL_SCOPE;
    const walkSource = () => walkScopedSource(src.wtf, scope, walkOpts);
    const entries = await walkSource();
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
    await this.assertSourceUnchanged(src, entries, walkSource);
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
      schema: scope.kind === 'all' ? 1 : 2,
      snapshotId: id,
      createdAt,
      appVersion: this.opts.appVersion,
      flavorId: info.flavorId,
      fileCount: files.length,
      dirCount: entries.length - files.length,
      totalBytes: statBytes,
      entries: manifestEntries,
      scope,
    };
    const text = Buffer.from(serializeManifest(manifest), 'utf8');
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
    await this.assertSourceUnchanged(src, entries, walkSource);
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

  /**
   * 源的根目录链、WTF 身份、按同一范围重新枚举的集合与每项身份 / 大小 / 时间与首次枚举一致（途经目录只比身份与类型）。
   * 所选路径在复核时消失、被替换或名称变化，按源变化处理。
   */
  private async assertSourceUnchanged(src: SourceCtx, entries: WalkEntry[], walkSource: () => Promise<WalkEntry[]>): Promise<void> {
    await this.recheckSource(src);
    let again: WalkEntry[];
    try {
      again = await walkSource();
    } catch (err) {
      if (err instanceof UserError && err.code === 'backup-scope') throw new UserError(`备份期间所选范围发生了变化（${err.message}），本次备份未完成`, 'backup-source-changed');
      throw err;
    }
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
    const task = this.begin('verify', f, expected, id, null);
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
