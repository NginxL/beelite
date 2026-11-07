// 每个游戏目录一份 manifest（按目录记账，flavor 只是项目属性）与事务 journal 的读写和严格校验。
import { UserError } from './errors';
import { readFileNoFollow, type Layout } from './layout';
import { foldKey, isValidModuleName } from './paths';

export interface ProjectRecord {
  modId: string;
  flavorId: number;
  fileId: string;
  version: string;
  name: string;
  logo: string | null;
  folders: string[];
  installedAt: number;
}

export type RecoveryKind = 'uninstall' | 'update-backup' | 'takeover';

export interface RecoveryEntry {
  id: string;
  kind: RecoveryKind;
  createdAt: number;
  label: string;
  /** 实际移入回收站的目录 */
  folders: string[];
  /** 恢复时重新登记的项目；其 folders 必须是上面 folders 的子集 */
  project: ProjectRecord | null;
}

export interface Manifest {
  schema: 1;
  lastTxId: string | null;
  projects: Record<string, ProjectRecord>;
  recovery: RecoveryEntry[];
  /** 已在 manifest 中注销、等待删除的回收目录编号；只有这里列出的目录会被递归删除 */
  purgeQueue: string[];
}

export interface JournalOp {
  /** 相对 Interface 目录的路径：AddOns/<name>、.beelite/staging/<txId>/x/<name> 或 .beelite/trash/<id>/<name> */
  from: string;
  to: string;
  /** 被移动目录的 dev:ino，同卷 rename 前后不变，用来判断这一步是否已执行 */
  id: string;
}

export interface Journal {
  schema: 1;
  txId: string;
  kind: string;
  state: 'prepared' | 'committing';
  /** 本事务允许涉及的回收目录编号 */
  trashIds: string[];
  ops: JournalOp[];
  createdAt: number;
}

export function emptyManifest(): Manifest {
  return { schema: 1, lastTxId: null, projects: {}, recovery: [], purgeQueue: [] };
}

export const ID_RE = /^[0-9a-z]{1,20}-[0-9a-f]{6}(-[bt])?$/;

function bad(what: string): never {
  throw new UserError(`蜂简数据文件已损坏（${what}），为保护插件已暂停写入。`, 'manifest');
}

function folderList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((f) => typeof f === 'string' && isValidModuleName(f))) bad(what);
  const keys = new Set(v.map((f: string) => foldKey(f)));
  if (keys.size !== v.length) bad(`${what}重复`);
  return v as string[];
}

function parseProject(p: unknown): ProjectRecord {
  if (typeof p !== 'object' || p === null) bad('项目记录');
  const r = p as Record<string, unknown>;
  if (typeof r.modId !== 'string' || !/^\d{1,12}$/.test(r.modId)) bad('项目编号');
  if (typeof r.flavorId !== 'number' || !Number.isInteger(r.flavorId) || typeof r.fileId !== 'string' || !/^\d{1,15}$/.test(r.fileId)) bad('项目版本');
  return {
    modId: r.modId,
    flavorId: r.flavorId,
    fileId: r.fileId,
    version: typeof r.version === 'string' ? r.version : '',
    name: typeof r.name === 'string' ? r.name : r.modId,
    logo: typeof r.logo === 'string' ? r.logo : null,
    folders: folderList(r.folders, '项目目录'),
    installedAt: typeof r.installedAt === 'number' ? r.installedAt : 0,
  };
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('JSON 无法解析');
  }
  if (typeof raw !== 'object' || raw === null || (raw as { schema?: unknown }).schema !== 1) bad('版本标记');
  const r = raw as Record<string, unknown>;
  if (typeof r.projects !== 'object' || r.projects === null || Array.isArray(r.projects)) bad('项目列表');
  const projects: Record<string, ProjectRecord> = {};
  const owner = new Map<string, string>();
  for (const [k, v] of Object.entries(r.projects as Record<string, unknown>)) {
    const p = parseProject(v);
    if (p.modId !== k) bad('项目键');
    for (const f of p.folders) {
      // 不变量：同一个实际目录（大小写不敏感）最多属于一个项目
      if (owner.has(foldKey(f))) bad(`目录 ${f} 同时属于多个项目`);
      owner.set(foldKey(f), k);
    }
    projects[k] = p;
  }
  if (!Array.isArray(r.recovery)) bad('恢复列表');
  const ids = new Set<string>();
  const recovery = r.recovery.map((e): RecoveryEntry => {
    if (typeof e !== 'object' || e === null) bad('恢复项');
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || !ID_RE.test(x.id) || ids.has(x.id)) bad('恢复项编号');
    ids.add(x.id);
    if (x.kind !== 'uninstall' && x.kind !== 'update-backup' && x.kind !== 'takeover') bad('恢复项类型');
    const folders = folderList(x.folders, '恢复项目录');
    const project = x.project ? parseProject(x.project) : null;
    if (project) {
      const keys = new Set(folders.map(foldKey));
      if (!project.folders.every((f) => keys.has(foldKey(f)))) bad('恢复项归属超出实际备份');
    }
    return { id: x.id, kind: x.kind, createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0, label: typeof x.label === 'string' ? x.label : x.id, folders, project };
  });
  const purgeQueue = r.purgeQueue === undefined ? [] : r.purgeQueue;
  if (!Array.isArray(purgeQueue) || !purgeQueue.every((id) => typeof id === 'string' && ID_RE.test(id) && !ids.has(id))) bad('待删除列表');
  const lastTxId = typeof r.lastTxId === 'string' ? r.lastTxId : null;
  return { schema: 1, lastTxId, projects, recovery, purgeQueue: [...new Set(purgeQueue as string[])] };
}

export async function readManifest(l: Layout): Promise<{ manifest: Manifest; exists: boolean }> {
  const text = await readFileNoFollow(l.manifestPath);
  if (text === null) return { manifest: emptyManifest(), exists: false };
  return { manifest: parseManifest(text), exists: true };
}

/** 校验一条事务路径属于本事务：staging 必须是本 txId，trash 必须在 trashIds 中 */
function checkOpPath(p: string, txId: string, trashIds: Set<string>): 'addons' | 'meta' {
  let m = /^AddOns\/([^/]+)$/.exec(p);
  if (m) {
    if (!isValidModuleName(m[1])) bad('事务目录名');
    return 'addons';
  }
  m = /^\.beelite\/staging\/([^/]+)\/x\/([^/]+)$/.exec(p);
  if (m) {
    if (m[1] !== txId || !isValidModuleName(m[2])) bad('事务暂存路径');
    return 'meta';
  }
  m = /^\.beelite\/trash\/([^/]+)\/([^/]+)$/.exec(p);
  if (m) {
    if (!trashIds.has(m[1]) || !isValidModuleName(m[2])) bad('事务回收路径');
    return 'meta';
  }
  bad('事务路径');
}

export function parseJournal(text: string): Journal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('事务日志无法解析');
  }
  const r = raw as Record<string, unknown>;
  if (!r || r.schema !== 1 || typeof r.txId !== 'string' || !ID_RE.test(r.txId)) bad('事务日志');
  if (r.state !== 'prepared' && r.state !== 'committing') bad('事务状态');
  if (!Array.isArray(r.trashIds) || !r.trashIds.every((id) => typeof id === 'string' && ID_RE.test(id))) bad('事务回收编号');
  const trashIds = new Set(r.trashIds as string[]);
  if (!Array.isArray(r.ops)) bad('事务步骤');
  const ops = r.ops.map((o): JournalOp => {
    const x = o as Record<string, unknown>;
    if (!x || typeof x.from !== 'string' || typeof x.to !== 'string' || typeof x.id !== 'string' || !/^\d+:\d+$/.test(x.id)) bad('事务步骤');
    const a = checkOpPath(x.from, r.txId as string, trashIds);
    const b = checkOpPath(x.to, r.txId as string, trashIds);
    // 每一步必须恰好一端在 AddOns，一端在蜂简数据目录
    if (a === b) bad('事务步骤方向');
    return { from: x.from, to: x.to, id: x.id };
  });
  return { schema: 1, txId: r.txId, kind: typeof r.kind === 'string' ? r.kind : '', state: r.state, trashIds: [...trashIds], ops, createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0 };
}
