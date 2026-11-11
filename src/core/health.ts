// 只读插件健康检查：AddOns 一级目录、每个目录按 flavor 选中的顶层 TOC，以及其中的依赖与 Interface 声明。
// 纯读：不创建、修改、删除任何路径，不恢复事务也不清理，不读 WTF，不执行 Lua，不联网。
// 调用方负责在同目录的写操作队列内调用；锁只能排除本应用自己的写入。读取前后与收尾的元数据复核只能发现部分外部修改，
// 结果不是原子快照，也不承诺防住同权限的恶意并发替换。
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { HealthIssue, HealthIssueKind, HealthLimits, HealthReport, HealthSeverity, HealthUnavailableReason } from '../shared/health-types';
import type { TocInfo } from '../shared/types';
import { errorMessage } from './errors';
import { getFlavor } from './flavors';
import { inspectLayout, MAX_METADATA_BYTES } from './layout';
import { foldKey, isValidModuleName } from './paths';
import { parseManifest, type Manifest } from './store';
import { parseToc, selectToc } from './toc';

export const DEFAULT_HEALTH_LIMITS: Readonly<HealthLimits> = Object.freeze({
  maxEntries: 2000,
  maxFilesPerFolder: 4096,
  maxTocBytes: 256 * 1024,
  maxTotalTocBytes: 32 * 1024 * 1024,
  maxIssues: 1000,
  maxDepsPerField: 256,
});

export interface HealthOptions {
  /** 只能调低默认上限（测试用），必须是正安全整数 */
  limits?: Partial<HealthLimits>;
  now?: () => number;
}

/** 说明与附加信息的最大字符数 */
const MAX_TEXT = 300;
/** interface-mismatch 中最多列出的声明值 */
const MAX_DECLARED = 32;

const SCOPE =
  '只检查 AddOns 一级目录与按当前游戏版本选中的顶层 TOC（Interface、Dependencies、RequiredDeps、OptionalDeps）；不校验 TOC 列出的文件，不验证角色启用、加载条件或游戏内加载结果。检查期间的外部修改只能尽量发现，结果不是瞬时快照。';

/** 依赖字段只识别这三个精确名称（大小写不敏感），不做任何 Dep* 泛匹配 */
const DEP_FIELDS = new Map<string, 'required' | 'optional'>([
  ['dependencies', 'required'],
  ['requireddeps', 'required'],
  ['optionaldeps', 'optional'],
]);

const SEVERITY: Record<HealthIssueKind, HealthSeverity> = {
  'addons-absent': 'info',
  'manifest-invalid': 'unknown',
  'registered-missing': 'warning',
  'registered-not-dir': 'warning',
  'registered-unconfirmed': 'unknown',
  'name-ambiguous': 'unknown',
  'entry-symlink': 'unknown',
  'entry-unreadable': 'unknown',
  'entry-changed': 'unknown',
  'entry-too-many-files': 'unknown',
  'toc-none': 'unknown',
  'toc-ambiguous': 'unknown',
  'toc-not-regular': 'unknown',
  'toc-unreadable': 'unknown',
  'toc-too-large': 'unknown',
  'toc-changed': 'unknown',
  'toc-skipped-budget': 'unknown',
  'dep-required-missing': 'warning',
  'dep-optional-missing': 'info',
  'dep-system-unconfirmed': 'unknown',
  'dep-unconfirmed': 'unknown',
  'dep-declaration-invalid': 'unknown',
  'interface-mismatch': 'warning',
  'interface-unknown': 'unknown',
};

function clip(s: string): string {
  const chars = Array.from(s);
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : s;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
}

function normalizeLimits(o: Partial<HealthLimits> | undefined): HealthLimits {
  const out: HealthLimits = { ...DEFAULT_HEALTH_LIMITS };
  for (const k of Object.keys(out) as (keyof HealthLimits)[]) {
    const v = o?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > DEFAULT_HEALTH_LIMITS[k]) {
      throw new RangeError(`健康检查上限无效：${k}`);
    }
    out[k] = v;
  }
  return out;
}

export interface TocDeclarations {
  required: string[];
  optional: string[];
  /** 无法使用的依赖声明：非法名称、带条件修饰的字段或值、数量超过上限 */
  invalid: { field: string; value: string; reason: string }[];
  /** Interface 字段带条件修饰，或含有无法识别的值；基本数字仍以 parseToc 为准 */
  interfaceUncertain: boolean;
}

/**
 * 补充解析 TOC 中的依赖声明与 Interface 值的有效性。行规则与 parseToc 一致：去 BOM、兼容 CRLF、同名字段第一次出现为准。
 * 字段名带条件修饰（如 `## Dependencies [AllowLoadGameType mainline]: X`）或值含方括号时整字段无法确认，不尝试展开。
 */
export function parseTocDeclarations(text: string, maxDepsPerField: number = DEFAULT_HEALTH_LIMITS.maxDepsPerField): TocDeclarations {
  const seen = new Set<string>();
  const required = new Map<string, string>();
  const optional = new Map<string, string>();
  const invalid: TocDeclarations['invalid'] = [];
  let interfaceUncertain = false;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    // 条件修饰可能含冒号，字段名在第一个冒号处截断，所以只看 "名称[" 开头
    const cond = /^([a-z]+)\s*\[/.exec(key);
    const base = cond ? cond[1] : key;
    if (base === 'interface') {
      if (cond) interfaceUncertain = true;
      else if (!seen.has(key)) {
        seen.add(key);
        const tokens = value.split(',').map((x) => x.trim()).filter(Boolean);
        if (tokens.some((x) => !/^\d+$/.test(x) || !Number.isSafeInteger(Number(x)) || Number(x) <= 0)) interfaceUncertain = true;
      }
      continue;
    }
    const kind = DEP_FIELDS.get(base);
    if (!kind) continue;
    if (cond) {
      invalid.push({ field: m[1], value, reason: '字段带条件修饰' });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (/[[\]]/.test(value)) {
      invalid.push({ field: m[1], value, reason: '含条件写法' });
      continue;
    }
    const names = value.split(',').map((x) => x.trim()).filter(Boolean);
    if (names.length > maxDepsPerField) {
      invalid.push({ field: m[1], value, reason: `超过 ${maxDepsPerField} 个` });
      continue;
    }
    const target = kind === 'required' ? required : optional;
    for (const n of names) {
      if (!isValidModuleName(n)) invalid.push({ field: m[1], value: n, reason: '不是有效的插件目录名' });
      else if (!target.has(foldKey(n))) target.set(foldKey(n), n);
    }
  }
  // 同名同时出现在必需与可选中时按必需处理
  for (const k of required.keys()) optional.delete(k);
  return { required: [...required.values()], optional: [...optional.values()], invalid, interfaceUncertain };
}

/** 按 warning → unknown → info 有界保留提示项；计数始终是全量 */
class IssueSink {
  readonly counts: Record<HealthSeverity, number> = { warning: 0, unknown: 0, info: 0 };
  private readonly buckets: Record<HealthSeverity, HealthIssue[]> = { warning: [], unknown: [], info: [] };

  constructor(private readonly max: number) {}

  add(kind: HealthIssueKind, folder: string | null, detail: string | null, message: string, declared?: number[]): void {
    const severity = SEVERITY[kind];
    this.counts[severity]++;
    const bucket = this.buckets[severity];
    if (bucket.length >= this.max) return;
    const issue: HealthIssue = { kind, severity, folder: folder === null ? null : clip(folder), detail: detail === null ? null : clip(detail), message: clip(message) };
    if (declared) issue.declared = declared.slice(0, MAX_DECLARED);
    bucket.push(issue);
  }

  result(): { issues: HealthIssue[]; truncated: boolean } {
    const all = [...this.buckets.warning, ...this.buckets.unknown, ...this.buckets.info];
    const total = this.counts.warning + this.counts.unknown + this.counts.info;
    return { issues: all.slice(0, this.max), truncated: total > this.max };
  }
}

type EntryKind = 'dir' | 'symlink' | 'file' | 'other' | 'error';

interface Entry {
  name: string;
  kind: EntryKind;
  code?: string;
}

/** 收尾复核用的元数据身份 */
interface Ident {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function identOf(st: BigIntStats): Ident {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs };
}

/** 路径（不跟随链接）的当前身份是否仍与记录一致；记录为 null 表示当时不存在 */
async function stillSame(p: string, id: Ident | null): Promise<boolean> {
  let st;
  try {
    st = await lstat(p, { bigint: true });
  } catch (err) {
    return id === null && errCode(err) === 'ENOENT';
  }
  return id !== null && st.dev === id.dev && st.ino === id.ino && st.size === id.size && st.mtimeNs === id.mtimeNs;
}

type FolderResult =
  | { state: 'ok'; toc: TocInfo; decl: TocDeclarations; dirPath: string; dirId: Ident; tocPath: string; tocId: Ident }
  | { state: 'unconfirmed'; reason: string };

/** bytes 是实际读取的字节数（未读取为 0），读取后才发现变化时也计入 */
type BoundedRead = { bytes: number } & ({ kind: 'ok'; text: string; id: Ident } | { kind: 'absent' | 'not-regular' | 'unreadable' | 'too-large' | 'changed' | 'budget'; code?: string });

interface ScanContext {
  limits: HealthLimits;
  sink: IssueSink;
  addonsDir: string;
  addonsReal: string;
  addonsDev: bigint;
  suffixes: readonly string[];
  tocBytes: number;
  tocsRead: number;
  budgetHit: boolean;
  partial: boolean;
}

/**
 * 有界读取一个普通文件：O_NOFOLLOW 不跟随链接，O_NONBLOCK 不会卡在 FIFO 等特殊文件上；用句柄确认是普通文件，
 * 并核对读取前后没有变化。budget 是本次最多允许读取的字节数（多读 1 字节用来发现读取期间文件变大）。
 */
async function readRegularBounded(file: string, maxBytes: number, dev: bigint | null, budget: number): Promise<BoundedRead> {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ELOOP') return { kind: 'not-regular', code: 'symlink', bytes: 0 };
    if (code === 'ENOENT') return { kind: 'absent', code, bytes: 0 };
    if (code === 'ENOTDIR') return { kind: 'changed', code, bytes: 0 };
    return { kind: 'unreadable', code, bytes: 0 };
  }
  let total = 0;
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) return { kind: 'not-regular', code: 'special', bytes: 0 };
    if (dev !== null && st.dev !== dev) return { kind: 'changed', code: 'device', bytes: 0 };
    const size = Number(st.size);
    if (size > maxBytes) return { kind: 'too-large', bytes: 0 };
    if (size + 1 > budget) return { kind: 'budget', bytes: 0 };
    const buf = Buffer.alloc(size + 1);
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const st2 = await fh.stat({ bigint: true });
    if (total !== size || st2.size !== st.size || st2.ino !== st.ino || st2.mtimeNs !== st.mtimeNs) return { kind: 'changed', code: 'modified', bytes: total };
    // 路径仍指向刚读取的文件（父目录没有在读取期间被换掉）
    let now;
    try {
      now = await lstat(file, { bigint: true });
    } catch (err) {
      return { kind: 'changed', code: errCode(err), bytes: total };
    }
    if (now.dev !== st.dev || now.ino !== st.ino) return { kind: 'changed', code: 'replaced', bytes: total };
    return { kind: 'ok', text: buf.subarray(0, total).toString('utf8'), id: identOf(st), bytes: total };
  } catch (err) {
    return { kind: 'unreadable', code: errCode(err), bytes: total };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** 读取选中的 TOC；实际读取的字节计入累计上限 */
async function readTocFile(ctx: ScanContext, file: string): Promise<BoundedRead> {
  if (ctx.tocBytes >= ctx.limits.maxTotalTocBytes) return { kind: 'budget', bytes: 0 };
  const r = await readRegularBounded(file, ctx.limits.maxTocBytes, ctx.addonsDev, ctx.limits.maxTotalTocBytes - ctx.tocBytes);
  ctx.tocBytes += r.bytes;
  if (r.kind === 'ok' || r.bytes > 0) ctx.tocsRead++;
  // 选中后又消失的 TOC 属于检查期间的变化
  return r.kind === 'absent' ? { kind: 'changed', code: r.code, bytes: r.bytes } : r;
}

async function scanFolder(ctx: ScanContext, name: string): Promise<FolderResult> {
  const dir = path.join(ctx.addonsDir, name);
  const fail = (kind: HealthIssueKind, detail: string | null, message: string, partial = true): FolderResult => {
    ctx.sink.add(kind, name, detail, message);
    if (partial) ctx.partial = true;
    return { state: 'unconfirmed', reason: message };
  };
  // 目录必须仍是真实目录，且实际位置就在 AddOns 之下
  let before;
  try {
    before = await lstat(dir, { bigint: true });
    if (!before.isDirectory()) return fail('entry-changed', null, `目录在检查期间发生变化：${name}`);
    if (foldKey(await realpath(dir)) !== foldKey(path.join(ctx.addonsReal, name))) return fail('entry-changed', null, `目录的实际位置不在插件目录内，未检查：${name}`);
  } catch (err) {
    return fail('entry-unreadable', errCode(err), `目录无法读取（${errCode(err)}）：${name}`);
  }
  const tocNames: string[] = [];
  let count = 0;
  let tooMany = false;
  try {
    const d = await opendir(dir);
    try {
      for (let e = await d.read(); e; e = await d.read()) {
        if (++count > ctx.limits.maxFilesPerFolder) {
          tooMany = true;
          break;
        }
        // 不按类型过滤：被选中的 TOC 是链接或特殊文件时如实报告，不悄悄退回低优先级的 TOC
        if (foldKey(e.name).endsWith('.toc')) tocNames.push(e.name);
      }
    } finally {
      await d.close().catch(() => undefined);
    }
  } catch (err) {
    return fail('entry-unreadable', errCode(err), `目录无法读取（${errCode(err)}）：${name}`);
  }
  if (tooMany) {
    return fail('entry-too-many-files', String(ctx.limits.maxFilesPerFolder), `目录内条目超过 ${ctx.limits.maxFilesPerFolder} 个，未确认其 TOC：${name}`);
  }
  const toc = selectToc(name, tocNames, ctx.suffixes);
  if (!toc) return fail('toc-none', null, `未找到当前游戏版本对应的顶层 TOC，可能是共享资源目录：${name}`, false);
  if (tocNames.filter((n) => foldKey(n) === foldKey(toc)).length > 1) {
    return fail('toc-ambiguous', toc, `存在仅大小写或 Unicode 形式不同的同名 TOC，无法确认使用哪一个：${name}/${toc}`);
  }
  const where = `${name}/${toc}`;
  const tocPath = path.join(dir, toc);
  const read = await readTocFile(ctx, tocPath);
  switch (read.kind) {
    case 'not-regular':
      return fail('toc-not-regular', toc, `TOC 是符号链接或特殊文件，未读取：${where}`, false);
    case 'unreadable':
      return fail('toc-unreadable', toc, `TOC 无法读取（${read.code}）：${where}`);
    case 'too-large':
      return fail('toc-too-large', toc, `TOC 超过 ${ctx.limits.maxTocBytes / 1024} KiB 的检查上限：${where}`);
    case 'absent':
    case 'changed':
      return fail('toc-changed', toc, `TOC 在检查期间发生变化：${where}`);
    case 'budget':
      ctx.budgetHit = true;
      return fail('toc-skipped-budget', toc, `TOC 累计读取量已达上限，未读取：${where}`);
  }
  try {
    const after = await lstat(dir, { bigint: true });
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) return fail('entry-changed', null, `目录在检查期间发生变化：${name}`);
  } catch {
    return fail('entry-changed', null, `目录在检查期间发生变化：${name}`);
  }
  return {
    state: 'ok',
    toc: parseToc(read.text, toc),
    decl: parseTocDeclarations(read.text, ctx.limits.maxDepsPerField),
    dirPath: dir,
    dirId: identOf(before),
    tocPath,
    tocId: read.id,
  };
}

/**
 * 只读检查 root 下当前 flavor 的插件目录。interfaceNumber 是插件库已加载配置给出的参考值（未知传 null），不联网获取。
 * 不会抛出文件系统错误：无法检查时返回 unavailable，局部失败返回 partial。仅在 options.limits 无效时抛 RangeError。
 */
export async function scanAddonHealth(root: string, flavorId: number, interfaceNumber: number | null, options: HealthOptions = {}): Promise<HealthReport> {
  const limits = normalizeLimits(options.limits);
  const reference = typeof interfaceNumber === 'number' && Number.isSafeInteger(interfaceNumber) && interfaceNumber > 0 ? interfaceNumber : null;
  const report: HealthReport = {
    root,
    flavorId,
    checkedAt: (options.now ?? Date.now)(),
    status: 'complete',
    unavailableReason: null,
    message: null,
    scope: SCOPE,
    hasAddons: false,
    manifestState: 'absent',
    reference: { interfaceNumber: reference, source: 'addon-library-config' },
    limits,
    scanned: { entries: 0, folders: 0, tocsRead: 0, tocBytes: 0, interfaceMatched: 0 },
    truncated: { entries: false, tocBudget: false, issues: false },
    counts: { warning: 0, unknown: 0, info: 0 },
    issues: [],
  };
  const unavailable = (reason: HealthUnavailableReason, message: string): HealthReport => ({ ...report, status: 'unavailable', unavailableReason: reason, message: clip(message) });
  const sink = new IssueSink(limits.maxIssues);
  let partial = false;
  const finish = (): HealthReport => {
    const { issues, truncated } = sink.result();
    report.issues = issues;
    report.counts = { ...sink.counts };
    report.truncated.issues = truncated;
    const notes: string[] = [];
    if (report.truncated.entries) notes.push(`插件目录条目超过 ${limits.maxEntries} 个，只检查了其中一部分`);
    if (report.truncated.tocBudget) notes.push('TOC 累计读取量已达上限，其余 TOC 未读取');
    if (partial) notes.push('部分目录或记录无法确认');
    if (truncated) notes.push(`提示项超过 ${limits.maxIssues} 条，按需要留意、无法确认、参考信息的顺序只列出前 ${limits.maxIssues} 条`);
    if (notes.length > 0) {
      report.status = 'partial';
      report.message = clip(`本次检查不完整：${notes.join('；')}`);
    } else if (report.counts.warning + report.counts.unknown + report.counts.info === 0) {
      report.message = '本次检查范围内未发现异常提示';
    }
    return report;
  };

  const flavor = getFlavor(flavorId);
  if (!flavor) return unavailable('unknown-flavor', '未知的游戏版本，无法选择 TOC');
  let info;
  try {
    info = await inspectLayout(root, false);
  } catch (err) {
    return unavailable('layout', errorMessage(err));
  }
  const l = info.l;
  if (!info.hasInterface) {
    sink.add('addons-absent', null, null, '当前目录未找到插件目录（Interface/AddOns）');
    return finish();
  }

  // 存在任何类型的 journal 都说明有未完成的操作：不读取、不恢复、不清理（收尾复核再查一次）
  const pendingCheck = async (): Promise<HealthReport | null> => {
    try {
      await lstat(l.journalPath);
      return unavailable('pending-operation', '该游戏目录存在未完成的操作，本次无法确认插件状态；健康检查不会恢复或清理它');
    } catch (err) {
      if (errCode(err) !== 'ENOENT') return unavailable('pending-operation', `无法确认是否存在未完成的操作（${errCode(err)}）`);
    }
    return null;
  };
  const pending = await pendingCheck();
  if (pending) return pending;

  // 不复用 readManifest：它的读取不带 O_NONBLOCK，manifest 是 FIFO 时会一直等待；内容校验仍用 parseManifest
  let manifest: Manifest | null = null;
  let manifestProblem: string | null = null;
  /** 成功解析时的 manifest 身份；当时不存在为 null；读取失败为 undefined（已是无法确认，不再复核） */
  let manifestId: Ident | null | undefined;
  const mr = await readRegularBounded(l.manifestPath, MAX_METADATA_BYTES, null, MAX_METADATA_BYTES + 1);
  switch (mr.kind) {
    case 'ok':
      try {
        manifest = parseManifest(mr.text);
        report.manifestState = 'ok';
        manifestId = mr.id;
      } catch (err) {
        manifestProblem = errorMessage(err);
      }
      break;
    case 'absent':
      manifestId = null;
      break;
    case 'not-regular':
      manifestProblem = '安装记录不是普通文件（符号链接或特殊文件），未读取';
      break;
    case 'too-large':
    case 'budget':
      manifestProblem = `安装记录超过 ${MAX_METADATA_BYTES / 1024 / 1024} MiB 的读取上限`;
      break;
    case 'changed':
      manifestProblem = '安装记录在读取期间发生变化';
      break;
    case 'unreadable':
      manifestProblem = `安装记录无法读取（${mr.code}）`;
      break;
  }
  if (manifestProblem !== null) {
    report.manifestState = 'invalid';
    partial = true;
    sink.add('manifest-invalid', null, null, `安装记录无法读取，已登记目录的状态无法确认：${manifestProblem}`);
  }
  let registered = manifest ? Object.values(manifest.projects).flatMap((p) => p.folders) : [];

  /**
   * 收尾复核：所有读取结束后、给出确定结论之前，只用 lstat 比对元数据，不重读内容。
   * journal 出现或 AddOns 本身变化（含增删一级目录）时整体无法检查；manifest 变化时放弃登记目录的结论。
   */
  const recheck = async (addons: Ident | null): Promise<HealthReport | null> => {
    const again = await pendingCheck();
    if (again) return again;
    if (!(await stillSame(l.addonsDir, addons))) return unavailable('addons-unreadable', '插件目录在检查期间发生变化，请稍后重试');
    if (manifestId !== undefined && !(await stillSame(l.manifestPath, manifestId))) {
      registered = [];
      report.manifestState = 'invalid';
      partial = true;
      sink.add('manifest-invalid', null, null, '安装记录在检查期间发生变化，已登记目录的状态无法确认');
    }
    return null;
  };

  if (!info.hasAddons) {
    const stop = await recheck(null);
    if (stop) return stop;
    sink.add('addons-absent', null, null, '当前目录未找到插件目录（Interface/AddOns）');
    for (const f of registered) sink.add('registered-missing', f, null, `安装记录中的目录未找到：${f}`);
    return finish();
  }
  report.hasAddons = true;

  let addonsId;
  let addonsReal: string;
  try {
    addonsId = await lstat(l.addonsDir, { bigint: true });
    addonsReal = await realpath(l.addonsDir);
  } catch (err) {
    return unavailable('addons-unreadable', `插件目录无法读取：${errorMessage(err)}`);
  }
  if (!addonsId.isDirectory() || foldKey(addonsReal) !== foldKey(l.addonsDir)) return unavailable('layout', '插件目录的实际位置异常，本次无法检查');

  // 一级目录：opendir 逐条读取，到上限即停
  const entries: Entry[] = [];
  try {
    const d = await opendir(l.addonsDir);
    try {
      for (let e = await d.read(); e; e = await d.read()) {
        if (report.scanned.entries >= limits.maxEntries) {
          report.truncated.entries = true;
          break;
        }
        report.scanned.entries++;
        if (!e.name.startsWith('.')) entries.push({ name: e.name, kind: 'error' });
      }
    } finally {
      await d.close().catch(() => undefined);
    }
  } catch (err) {
    return unavailable('addons-unreadable', `插件目录无法读取：${errorMessage(err)}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    try {
      const st = await lstat(path.join(l.addonsDir, e.name));
      e.kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    } catch (err) {
      e.code = errCode(err);
    }
  }

  const index = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = foldKey(e.name);
    index.set(k, [...(index.get(k) ?? []), e]);
  }
  for (const hits of index.values()) {
    if (hits.length > 1) {
      partial = true;
      sink.add('name-ambiguous', hits[0].name, hits.map((h) => h.name).join(', '), `存在仅大小写或 Unicode 形式不同的同名条目，相关结论无法确认：${hits.map((h) => h.name).join('、')}`);
    }
  }
  const registeredKeys = new Set(registered.map(foldKey));

  const ctx: ScanContext = { limits, sink, addonsDir: l.addonsDir, addonsReal, addonsDev: addonsId.dev, suffixes: flavor.tocSuffixes, tocBytes: 0, tocsRead: 0, budgetHit: false, partial: false };
  const results = new Map<Entry, FolderResult>();
  for (const e of entries) {
    // 同名歧义的条目已报 name-ambiguous：无法确认游戏使用哪一个，不读取其 TOC，也不给出确定的声明结论
    if (index.get(foldKey(e.name))!.length > 1) continue;
    if (e.kind === 'error') {
      partial = true;
      sink.add('entry-unreadable', e.name, e.code ?? null, `目录无法读取（${e.code}）：${e.name}`);
    } else if (e.kind === 'symlink' && !registeredKeys.has(foldKey(e.name))) {
      sink.add('entry-symlink', e.name, null, `该项是符号链接，未跟随检查：${e.name}`);
    } else if (e.kind === 'dir') {
      report.scanned.folders++;
      results.set(e, await scanFolder(ctx, e.name));
    }
  }
  if (ctx.partial) partial = true;
  report.truncated.tocBudget = ctx.budgetHit;
  report.scanned.tocsRead = ctx.tocsRead;
  report.scanned.tocBytes = ctx.tocBytes;

  const stop = await recheck(identOf(addonsId));
  if (stop) return stop;
  // 已读取的 TOC 或其目录之后被改动：放弃该项的确定结论，依赖它的插件也随之无法确认
  for (const [e, r] of results) {
    if (r.state !== 'ok') continue;
    if ((await stillSame(r.dirPath, r.dirId)) && (await stillSame(r.tocPath, r.tocId))) continue;
    partial = true;
    const message = `TOC 或其目录在检查期间发生变化，结论无法确认：${e.name}/${r.toc.tocFile}`;
    sink.add('toc-changed', e.name, r.toc.tocFile, message);
    results.set(e, { state: 'unconfirmed', reason: message });
  }

  for (const f of registered) {
    const hits = index.get(foldKey(f));
    if (!hits) {
      if (report.truncated.entries) sink.add('registered-unconfirmed', f, 'index-incomplete', `插件目录枚举不完整，安装记录中的目录无法确认：${f}`);
      else sink.add('registered-missing', f, null, `安装记录中的目录未找到：${f}`);
    } else if (hits.length > 1) {
      sink.add('registered-unconfirmed', f, 'ambiguous', `安装记录中的目录存在大小写不同的同名条目，无法确认：${f}`);
    } else if (hits[0].kind !== 'dir' && hits[0].kind !== 'error') {
      sink.add('registered-not-dir', f, hits[0].kind, `安装记录中的目录不是普通插件目录（文件、符号链接或特殊文件），未检查内容：${f}`);
    }
  }

  const resolveDep = (dep: string): { state: 'ok' } | { state: 'missing' } | { state: 'system' } | { state: 'unknown'; reason: string } => {
    const hits = index.get(foldKey(dep));
    if (!hits) {
      if (foldKey(dep).startsWith('blizzard_')) return { state: 'system' };
      if (report.truncated.entries) return { state: 'unknown', reason: '插件目录枚举不完整' };
      return { state: 'missing' };
    }
    if (hits.length > 1) return { state: 'unknown', reason: '存在大小写不同的同名目录' };
    const e = hits[0];
    if (e.kind === 'symlink') return { state: 'unknown', reason: '依赖目录是符号链接' };
    if (e.kind !== 'dir') return { state: 'unknown', reason: e.kind === 'error' ? '依赖目录无法读取' : '依赖不是普通插件目录' };
    const r = results.get(e);
    if (!r || r.state !== 'ok') return { state: 'unknown', reason: r?.state === 'unconfirmed' ? r.reason : '依赖目录未检查' };
    return { state: 'ok' };
  };

  for (const [e, r] of results) {
    if (r.state !== 'ok') continue;
    const where = `${e.name}/${r.toc.tocFile}`;
    if (r.toc.interfaces.length === 0 || r.decl.interfaceUncertain) {
      sink.add('interface-unknown', e.name, r.toc.tocFile, `TOC 的 Interface 缺失、无效或带条件，适配版本无法确认：${where}`);
    } else if (reference !== null) {
      if (r.toc.interfaces.includes(reference)) report.scanned.interfaceMatched++;
      else sink.add('interface-mismatch', e.name, r.toc.tocFile, `声明适配版本需要确认（声明 ${r.toc.interfaces.join(', ')}，参考 ${reference}；参考值来自插件库配置，不是本机游戏实测）：${where}`, r.toc.interfaces);
    }
    for (const inv of r.decl.invalid) {
      sink.add('dep-declaration-invalid', e.name, inv.value, `依赖声明无法解析（${inv.reason}）：${inv.field}: ${inv.value}（${where}）`);
    }
    for (const [deps, required] of [[r.decl.required, true], [r.decl.optional, false]] as const) {
      const label = required ? '必需' : '可选';
      for (const dep of deps) {
        const res = resolveDep(dep);
        if (res.state === 'ok') continue;
        if (res.state === 'missing') {
          if (required) sink.add('dep-required-missing', e.name, dep, `声明的必需依赖未在当前 AddOns 中找到：${dep}（由 ${e.name} 声明）`);
          else sink.add('dep-optional-missing', e.name, dep, `可选依赖未找到：${dep}（由 ${e.name} 声明，通常不要求单独安装）`);
        } else if (res.state === 'system') {
          sink.add('dep-system-unconfirmed', e.name, dep, `系统插件依赖无法通过本地目录确认：${dep}（由 ${e.name} 声明的${label}依赖）`);
        } else {
          sink.add('dep-unconfirmed', e.name, dep, `声明的${label}依赖无法确认：${dep}（${res.reason}；由 ${e.name} 声明）`);
        }
      }
    }
  }
  return finish();
}
