// 本地 WTF 恢复的纯计划：根据已校验的快照清单与完整的当前 WTF 清单，计算恢复后的完整候选树、每个文件的来源与范围内的差异。
// 只处理内存中的数据，不访问磁盘；输入的生产与校验（严格遍历、清单解析、内容校验值）由调用方负责。
// - 范围（与备份的读取范围一致）：
//   all：整个 WTF 镜像为快照；
//   account：只替换 Account/<账号> 完整子树（名称逐字节相等），其他账号与 WTF 根级内容保留；
//   characters：替换账号直属的普通文件、完整的 SavedVariables 与所选 <服务器>/<角色> 子树；
//   快照中没有的范围内内容（例如快照缺少 SavedVariables）恢复后删除；其他账号、WTF 根级、服务器直属文件、未选角色与未选服务器保留。
// - 途经目录（Account、Account/<账号>、所选服务器）不属于范围：当前存在时保留（连同其中范围外的兄弟），缺失时按快照新建。
// - 冲突一律拒绝，不做名称猜测或改名：当前的 Account 目录、所选账号、所选服务器、所选角色与备份只差大小写 / Unicode 形式；
//   Account 或所选账号（按角色恢复时）不是文件夹；快照条目与保留的范围外条目同名但类型或拼写不同
//   （例如快照的账号直属文件与当前未选服务器目录同名）；当前服务器目录下的直属文件与所选角色同名（它在范围外）。
// - 范围内的类型变化（文件与文件夹互换）按镜像处理，包括与所选服务器同名的账号直属普通文件（属于按角色恢复的范围）被替换为服务器目录。
// - 完全属于范围的内容之间只差大小写 / Unicode 形式时按快照的拼写镜像：文件计为覆盖，目录计为删除旧拼写并新增新拼写。
// - 只有清单列出的条目参与恢复（快照目录中未列入清单的 .DS_Store 等不会出现在输入里）。
import type { BackupScope } from '../shared/backup-types';
import type { RestoreBaseline, RestoreDiffCounts, RestoreDiffSamples, RestoreOrigin } from '../shared/restore-types';
import { UserError } from './errors';
import { foldKey, isSafeSegment } from './paths';
import { ACCOUNT_KEY, SAVED_VARIABLES_KEY, scopeEntriesProblem, type ManifestEntry } from './wtf-backup';

/** 每类差异最多列出的路径示例 */
export const RESTORE_SAMPLE_MAX = 50;

export interface PlannedEntry {
  path: string;
  type: 'dir' | 'file';
  size?: number;
  sha256?: string;
  origin: RestoreOrigin;
}

export interface RestorePlan {
  scope: BackupScope;
  baseline: RestoreBaseline;
  /** 恢复后的完整候选 WTF（父目录在前） */
  entries: PlannedEntry[];
  counts: RestoreDiffCounts;
  samples: RestoreDiffSamples;
  candidate: { files: number; dirs: number; bytes: number };
  /** 保留的范围外内容（含途经目录） */
  kept: { files: number; dirs: number; bytes: number };
}

type Ownership = 'owned' | 'pass' | 'out';

function conflict(reason: string): UserError {
  return new UserError(`无法按原范围恢复：${reason}。为避免改动范围外的内容，未做任何改动`, 'restore-conflict');
}

function invalidInput(what: string, reason: string): UserError {
  return new UserError(`恢复计划的输入不合法（${what}：${reason}）`, 'restore-plan');
}

function depth(p: string): number {
  return p.split('/').length;
}

function byTree(a: { path: string }, b: { path: string }): number {
  const d = depth(a.path) - depth(b.path);
  if (d !== 0) return d;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** 条目列表的上限（与备份上限同义）；给出时一并检查 */
export interface EntryListLimits {
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxSnapshotBytes: number;
}

/**
 * 清单形状检查（计划与候选清单共用）：路径安全、按大小写 / Unicode 无关唯一、每一项的上级目录都在列表中且是目录、
 * 文件带大小（与可选的校验值）；给出 limits 时还检查条目数、层数、单文件与总字节。不合法时抛出 restore-plan
 */
export function checkEntryList(entries: readonly ManifestEntry[], what: string, requireFileHash: boolean, limits?: EntryListLimits): Map<string, ManifestEntry> {
  if (limits && entries.length > limits.maxEntries) throw invalidInput(what, `条目超过 ${limits.maxEntries} 个`);
  const byKey = new Map<string, ManifestEntry>();
  let total = 0;
  for (const e of entries) {
    if (typeof e.path !== 'string' || !e.path.split('/').every(isSafeSegment)) throw invalidInput(what, `路径不合法：${JSON.stringify(e.path)}`);
    if (limits && depth(e.path) > limits.maxDepth) throw invalidInput(what, `「${e.path}」层数超过上限`);
    if (e.type !== 'dir' && e.type !== 'file') throw invalidInput(what, `「${e.path}」类型不合法`);
    if (e.type === 'file') {
      if (!Number.isSafeInteger(e.size) || (e.size as number) < 0) throw invalidInput(what, `「${e.path}」缺少大小`);
      if (requireFileHash && (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256))) throw invalidInput(what, `「${e.path}」缺少校验值`);
      total += e.size as number;
      if (limits && (e.size as number) > limits.maxFileBytes) throw invalidInput(what, `「${e.path}」超过单个文件上限`);
      if (limits && total > limits.maxSnapshotBytes) throw invalidInput(what, '总大小超过上限');
    }
    const k = foldKey(e.path);
    if (byKey.has(k)) throw invalidInput(what, `「${e.path}」与其他条目仅大小写或 Unicode 形式不同`);
    byKey.set(k, e);
  }
  const exact = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    if (i < 0) continue;
    if (exact.get(e.path.slice(0, i))?.type !== 'dir') throw invalidInput(what, `「${e.path}」缺少上级目录`);
  }
  return byKey;
}

/**
 * 当前 WTF 中一项相对恢复范围的归属：owned 属于范围（会被快照内容替换或删除）；pass 途经目录（保留）；out 范围外（保留）。
 * 范围归属按前缀封闭：owned 的子项都是 owned。遇到不能安全判定的情况直接拒绝。
 */
function classify(scope: BackupScope, e: ManifestEntry): Ownership {
  if (scope.kind === 'all') return 'owned';
  const s = e.path.split('/');
  if (foldKey(s[0]) !== ACCOUNT_KEY) return 'out';
  if (s.length === 1) {
    if (e.type !== 'dir') throw conflict(`WTF 中的「${s[0]}」不是文件夹`);
    return 'pass';
  }
  if (foldKey(s[1]) !== foldKey(scope.account)) return 'out';
  if (s[1] !== scope.account) throw conflict(`当前账号目录「${s[1]}」与备份中的「${scope.account}」只差大小写或 Unicode 形式`);
  if (scope.kind === 'account') return 'owned';
  if (s.length === 2) {
    if (e.type !== 'dir') throw conflict(`账号「${scope.account}」不是文件夹`);
    return 'pass';
  }
  const k2 = foldKey(s[2]);
  if (k2 === SAVED_VARIABLES_KEY) return 'owned';
  const realm = scope.characters.find((c) => foldKey(c.realm) === k2)?.realm;
  if (realm === undefined) {
    // 账号直属的普通文件属于范围；未选的服务器目录（及其中全部内容）在范围外
    return s.length === 3 && e.type === 'file' ? 'owned' : 'out';
  }
  if (s[2] !== realm) throw conflict(`当前服务器目录「${s[2]}」与备份中的「${realm}」只差大小写或 Unicode 形式`);
  // 与所选服务器同名的账号直属文件属于范围（类型变化按镜像处理）；同名目录是途经目录
  if (s.length === 3) return e.type === 'file' ? 'owned' : 'pass';
  const k3 = foldKey(s[3]);
  const character = scope.characters.find((c) => c.realm === realm && foldKey(c.character) === k3)?.character;
  if (character === undefined) return 'out';
  if (s[3] !== character) throw conflict(`当前角色目录「${s[2]}/${s[3]}」与备份中的「${realm}/${character}」只差大小写或 Unicode 形式`);
  if (s.length === 4 && e.type !== 'dir') throw conflict(`服务器「${realm}」下的文件「${s[3]}」与所选角色同名，它不属于恢复范围`);
  return 'owned';
}

function sample(list: string[], out: string[]): boolean {
  list.sort();
  out.push(...list.slice(0, RESTORE_SAMPLE_MAX));
  return list.length > RESTORE_SAMPLE_MAX;
}

/**
 * 计算恢复计划。snapshot 是已校验快照的清单条目（相对 WTF，文件带大小与校验值），必须落在 scope 内；
 * current 是当前完整 WTF 的条目，null 表示当前没有 WTF（absent）。范围内的当前文件必须带校验值（用于区分覆盖与相同）；
 * 范围外的当前文件可以不带，原样作为 baseline 来源进入候选树。冲突时抛出 restore-conflict，不返回部分结果。
 */
export function planRestore(scope: BackupScope, snapshot: readonly ManifestEntry[], current: readonly ManifestEntry[] | null): RestorePlan {
  checkEntryList(snapshot, '快照', true);
  const problem = scopeEntriesProblem(scope, snapshot);
  if (problem) throw invalidInput('快照', `条目与范围不符：${problem}`);
  if (current) checkEntryList(current, '当前 WTF', false);

  const owned = new Map<string, ManifestEntry>();
  const merged = new Map<string, PlannedEntry>();
  const kept = { files: 0, dirs: 0, bytes: 0 };
  for (const e of current ?? []) {
    const own = classify(scope, e);
    if (own === 'owned') {
      if (e.type === 'file' && (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256))) throw invalidInput('当前 WTF', `范围内的「${e.path}」缺少校验值`);
      owned.set(foldKey(e.path), e);
      continue;
    }
    merged.set(foldKey(e.path), { ...e, origin: 'baseline' });
    if (e.type === 'file') {
      kept.files++;
      kept.bytes += e.size ?? 0;
    } else {
      kept.dirs++;
    }
  }

  // 快照条目逐项并入：只允许与保留的途经目录（拼写完全相同的目录）重合
  const fromSnapshot = new Map<string, ManifestEntry>();
  for (const e of snapshot) {
    const k = foldKey(e.path);
    const hit = merged.get(k);
    if (hit) {
      if (hit.type === 'dir' && e.type === 'dir' && hit.path === e.path) continue;
      if (hit.type === e.type) throw conflict(`备份中的「${e.path}」与当前保留的「${hit.path}」只差大小写或 Unicode 形式`);
      throw conflict(`备份中的${e.type === 'file' ? '文件' : '文件夹'}「${e.path}」与当前范围外的${hit.type === 'file' ? '文件' : '文件夹'}「${hit.path}」同名，恢复它会改动范围外的内容`);
    }
    merged.set(k, { ...e, origin: 'snapshot' });
    fromSnapshot.set(k, e);
  }

  const entries = [...merged.values()].sort(byTree);
  const exact = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    if (i >= 0 && exact.get(e.path.slice(0, i))?.type !== 'dir') throw conflict(`「${e.path}」的上级目录在合并后不是同名文件夹`);
  }

  const counts: RestoreDiffCounts = { addFiles: 0, overwriteFiles: 0, sameFiles: 0, deleteFiles: 0, addDirs: 0, deleteDirs: 0, writeBytes: 0, deleteBytes: 0 };
  const add: string[] = [];
  const overwrite: string[] = [];
  const del: string[] = [];
  for (const [k, e] of fromSnapshot) {
    const cur = owned.get(k);
    if (e.type === 'dir') {
      // 拼写不同的同一目录也显示为变化（删除旧拼写在下面计入）
      if (cur?.type !== 'dir' || cur.path !== e.path) {
        counts.addDirs++;
        add.push(e.path);
      }
      continue;
    }
    const size = e.size ?? 0;
    if (cur?.type === 'file') {
      if (cur.size === e.size && cur.sha256 === e.sha256 && cur.path === e.path) {
        counts.sameFiles++;
      } else {
        counts.overwriteFiles++;
        counts.writeBytes += size;
        overwrite.push(e.path);
      }
    } else {
      counts.addFiles++;
      counts.writeBytes += size;
      add.push(e.path);
    }
  }
  for (const [k, cur] of owned) {
    const s = fromSnapshot.get(k);
    if (s && s.type === cur.type && (s.type === 'file' || s.path === cur.path)) continue;
    if (cur.type === 'file') {
      counts.deleteFiles++;
      counts.deleteBytes += cur.size ?? 0;
    } else {
      counts.deleteDirs++;
    }
    del.push(cur.path);
  }
  const samples: RestoreDiffSamples = { add: [], overwrite: [], delete: [], truncated: false };
  const t1 = sample(add, samples.add);
  const t2 = sample(overwrite, samples.overwrite);
  const t3 = sample(del, samples.delete);
  samples.truncated = t1 || t2 || t3;

  const candidate = { files: 0, dirs: 0, bytes: 0 };
  for (const e of entries) {
    if (e.type === 'file') {
      candidate.files++;
      candidate.bytes += e.size ?? 0;
    } else {
      candidate.dirs++;
    }
  }
  return { scope, baseline: current ? 'present' : 'absent', entries, counts, samples, candidate, kept };
}
