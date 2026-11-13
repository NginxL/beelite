// 本地 WTF 恢复的服务层：预览（冻结凭证）、执行、只读查看未完成的恢复、处理未完成的恢复、绑定修改的短占位。
// - 与备份 / 校验 / 备份设置修改共用 WtfBackupService 的同一个任务占位（restoreBridge），不调用公开的 run / verify。
// - 预览只读：完整校验备份内容与当前完整 WTF（单角色恢复也读取全部 WTF），计算差异、份数 / 容量与可用空间；不取得任何占用、不写任何文件。
//   凭证只存在内存中，一次有效、有时限、数量有界；执行时重新核对绑定与备份设置的代次、目标、备份位置、备份内容与当前 WTF。
// - 执行：目标占用（事务）→ 备份位置占用（本模块，先持久记录意图，再排他创建，再持久记录精确证明）→ 在两个占用下重新核对 →
//   当前 WTF 存在时生成并严格同步完整的恢复前备份（范围 all、编号由事务预先登记，计入份数与容量上限，之后一律保留）→ 事务替换。
// - 备份位置占用的释放与中断后的处理只按持久证明（标记身份、令牌、时间、pid、恢复编号与 nonce、所在目录链）识别；
//   持有进程只有 pid 为正且 kill(pid, 0) 报 ESRCH 才算已退出；普通备份 / 校验留下的标记与无法识别的标记一律保留。
// - 绑定修改：main 在真正写入绑定之前同步取得短占位（beginBindingMutation），与同一目录的恢复任务双向互斥；取得即递增代次，
//   之前的预览全部作废（即使保存之后的读取失败）。MutationGate 只负责退出 / 升级的等待，不是互斥。
// - 只读查看：全局（含已解绑 / 换绑的原目录）；登记无法读取时给出固定错误，不以空列表冒充没有。启动时只查看，不处理、不清理。
import { lstat, realpath, statfs } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { BackupScope } from '../shared/backup-types';
import type { RestorePendingView, RestorePreview, RestoreResolveResult, RestoreRunResult } from '../shared/restore-types';
import { errorMessage, UserError } from './errors';
import {
  ALL_SCOPE, BACKUP_FORMAT, chainIds, errCode, hashStoredFile, idOf, LOCK_NAME, MANIFEST_NAME, MARKER_NAME, PARTIAL_PREFIX, parseManifest, readMeta, sameChain,
  SNAPSHOT_EXTRA_ENTRIES, SNAPSHOT_ID_RE, throwIfAborted, topLevelProblem, unlinkIfSame, walkDiff, walkTree,
  type ActiveTask, type ContainerCtx, type HeldLock, type ManifestEntry, type RestoreBridge, type SnapshotManifest, type TargetRecord, type WalkEntry,
  type WalkOptions, type WtfBackupService,
} from './wtf-backup';
import { probePid, removeVerifiedTree, sha256, syncDirStrict, verifyTree, type PidState, type VerifiedTree } from './wtf-restore-io';
import { planRestore, type RestorePlan } from './wtf-restore-plan';
import { TXID_RE } from './wtf-restore-registry';
import { WtfRestoreTxn, type RestoreApplyPorts, type RestoreHooks, type RestoreResolvePorts, type RestoreTreeSource } from './wtf-restore-txn';

const MiB = 1024 ** 2;
/** 凭证有效期与同时保留的数量 */
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS = 4;
const TOKEN_RE = /^[0-9a-f]{32}$/;
/** 可用空间之外预留的余量；恢复前备份的清单与目录项按每条目估算 */
const SPACE_MARGIN = 64 * MiB;
const MANIFEST_BYTES_PER_ENTRY = 256;
const MAX_LOCK_BYTES = 4096;
const LOCK_KEYS = ['format', 'kind', 'token', 'createdAt', 'taskKind', 'taskId', 'txid', 'nonce', 'pid', 'appVersion'];

export interface WtfRestoreServiceOptions {
  /** userData 中的恢复登记 */
  registryFile: string;
  /** 测试注入：事务各阶段的钩子 */
  hooks?: RestoreHooks;
  /** 测试注入：进程是否已退出 */
  probePid?: (pid: number) => PidState;
  /** 测试注入：目录所在磁盘卷的可用字节；默认用 statfs */
  freeBytes?: (dir: string) => Promise<number>;
  /** 测试注入：时钟（凭证有效期） */
  now?: () => number;
}

/** 预览凭证在内存中的私有记录（不交给界面） */
interface PlanRecord {
  token: string;
  expiresAt: number;
  flavorId: number;
  root: string;
  rootChain: string[];
  bindingGen: number;
  configGen: number;
  containerPath: string;
  containerId: string;
  containerChain: string[];
  snapshotId: string;
  snapshotDirId: string;
  manifestSha: string;
  scope: BackupScope;
  sourceWalk: readonly WalkEntry[];
  baseline: { kind: 'absent' } | { kind: 'present'; wtfId: string; walk: WalkEntry[]; entries: ManifestEntry[]; bytes: number };
}

/** 打开并（可选）完整校验过的一份备份 */
interface OpenedSnapshot {
  id: string;
  dir: string;
  dirId: string;
  dirChain: string[];
  manifest: SnapshotManifest;
  manifestId: string;
  manifestSha: string;
  wtfDir: string;
  wtfId: string;
  tree: VerifiedTree | null;
}

/** 当前完整 WTF 的读取结果 */
type LiveRead = { kind: 'absent' } | { kind: 'present'; wtfId: string; walk: WalkEntry[]; entries: ManifestEntry[]; bytes: number; files: number; dirs: number };

/** 备份位置占用的持久证明（写入事务 journal 的 sourceHold） */
interface HoldProof {
  v: 1;
  containerPath: string;
  chain: string[];
  /** 标记身份；null 表示只记录了意图（标记创建之前） */
  id: string | null;
  token: string;
  createdAt: number;
  pid: number;
  txid: string;
  nonce: string;
  /** 标记中的任务编号与应用版本（与其他字段一起逐项比对） */
  taskId: string;
  appVersion: string;
  /** 本次将生成的恢复前备份编号：它的临时目录 .partial-<编号> 残留时不能释放占用、不能结束这项恢复 */
  safetySnapshotId: string | null;
}

interface Held {
  proof: HoldProof | null;
  lock: HeldLock | null;
}

function changed(detail: string): UserError {
  return new UserError(`${detail}，请重新预览`, 'restore-changed');
}

function flavorArg(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e7) throw new UserError('游戏版本参数无效');
  return v;
}

function pathArg(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || v.includes('\0') || !path.isAbsolute(v)) throw new UserError('目标目录参数无效');
  return v;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseHold(text: string): HoldProof | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const keys = ['v', 'containerPath', 'chain', 'id', 'token', 'createdAt', 'pid', 'txid', 'nonce', 'taskId', 'appVersion', 'safetySnapshotId'];
  if (!isObj(v) || Object.keys(v).length !== keys.length || !keys.every((k) => k in v) || v.v !== 1) return null;
  if (typeof v.containerPath !== 'string' || !path.isAbsolute(v.containerPath)) return null;
  if (!Array.isArray(v.chain) || v.chain.length === 0 || !v.chain.every((x) => typeof x === 'string' && /^\d+:\d+$/.test(x))) return null;
  if (!(v.id === null || (typeof v.id === 'string' && /^\d+:\d+$/.test(v.id)))) return null;
  if (typeof v.token !== 'string' || !/^[0-9a-f]{32}$/.test(v.token) || typeof v.txid !== 'string' || !TXID_RE.test(v.txid)) return null;
  if (typeof v.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(v.nonce)) return null;
  if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid <= 0 || typeof v.createdAt !== 'number' || !Number.isSafeInteger(v.createdAt) || v.createdAt < 0) return null;
  if (typeof v.taskId !== 'string' || v.taskId.length === 0 || v.taskId.length > 64 || typeof v.appVersion !== 'string' || v.appVersion.length > 64) return null;
  if (!(v.safetySnapshotId === null || (typeof v.safetySnapshotId === 'string' && SNAPSHOT_ID_RE.test(v.safetySnapshotId)))) return null;
  return {
    v: 1, containerPath: v.containerPath, chain: v.chain as string[], id: v.id as string | null, token: v.token, createdAt: v.createdAt, pid: v.pid, txid: v.txid, nonce: v.nonce,
    taskId: v.taskId, appVersion: v.appVersion, safetySnapshotId: v.safetySnapshotId as string | null,
  };
}

/**
 * 按受控清单核对并清理恢复前备份的临时目录（复制失败时由备份服务调用）。三项同时满足才删除，否则整体保留：
 * - 临时目录的上级链与根身份与创建时一致；
 * - 每一个条目（目录与文件）当前的身份都等于创建时记录的身份（createdIds，来自 PartialTracker 在 mkdir / createFile 时的记录），
 *   没有未登记的条目；字节相同但身份不同的替换不被认领；
 * - 内容与受控清单逐项完全一致（每个文件的大小与已写入字节的校验值）。
 * 删除时每一步仍复核身份与上级目录（removeVerifiedTree）。目录已不存在时返回 null
 */
export async function cleanupSafetyPartial(
  limits: { maxEntries: number; maxDepth: number },
  p: { base: string; entries: ManifestEntry[]; parentChain: string[]; baseId: string; createdIds: ReadonlyMap<string, string> },
): Promise<string | null> {
  const st = await lstat(p.base).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)));
  if (!st) return null;
  const kept = (why: string) => `恢复前备份的临时目录中有无法确认属于本次写入的内容（${why}），已保留：${p.base}`;
  if (p.createdIds.get('') !== p.baseId) return kept('临时目录的创建身份不符');
  for (const e of p.entries) if (!p.createdIds.has(e.path)) return kept(`「${e.path}」没有创建时的身份记录`);
  try {
    const opts: WalkOptions = { maxEntries: limits.maxEntries + SNAPSHOT_EXTRA_ENTRIES, maxDepth: limits.maxDepth + 1, rejectHardlinks: true, label: '恢复前备份的临时目录' };
    const tree = await verifyTree(p.base, p.entries, opts, 'exact', '恢复前备份的临时目录', { parentChain: p.parentChain, baseId: p.baseId });
    for (const w of tree.walk) {
      if (p.createdIds.get(w.rel) !== idOf(w.st)) return kept(`「${w.rel}」不是本次创建的那一个`);
    }
    const r = await removeVerifiedTree(tree);
    if (r.kept) return `${r.kept}（恢复前备份的临时目录：${p.base}）`;
    if (r.unsynced) return r.unsynced;
    return null;
  } catch (err) {
    return kept(errorMessage(err));
  }
}

/** 两组清单条目是否完全相同（路径、类型、大小、校验值） */
function sameEntries(a: readonly ManifestEntry[], b: readonly ManifestEntry[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((e) => [e.path, e]));
  return b.every((e) => {
    const x = m.get(e.path);
    return !!x && x.type === e.type && x.size === e.size && x.sha256 === e.sha256;
  });
}

export class WtfRestoreService {
  readonly txn: WtfRestoreTxn;
  private readonly bridge: RestoreBridge;
  private readonly probe: (pid: number) => PidState;
  private readonly now: () => number;
  /** 绑定修改的代次：每次进入或离开绑定写入段都递增，之前的预览一律作废 */
  private bindingGen = 0;
  /** 进行中的绑定写入段（涉及的目录） */
  private readonly leases = new Set<{ roots: ReadonlySet<string> }>();
  /** 正在进行的恢复类任务的目录（预览、执行、处理） */
  private activeRoot: string | null = null;
  private readonly plans = new Map<string, PlanRecord>();
  /** 本实例创建的备份位置占用的令牌（同一进程内重新释放时作为精确所有权） */
  private readonly ownHoldTokens = new Set<string>();

  constructor(backup: WtfBackupService, private readonly opts: WtfRestoreServiceOptions) {
    this.bridge = backup.restoreBridge();
    this.probe = opts.probePid ?? probePid;
    this.now = opts.now ?? (() => Date.now());
    this.txn = new WtfRestoreTxn({ registryFile: opts.registryFile, limits: this.bridge.limits, hooks: opts.hooks, probePid: this.probe });
  }

  // ---------- 绑定修改的短占位 ----------

  /**
   * main 在写入绑定（绑定 / 解除绑定）之前同步调用，写入结束后（无论成败）在 finally 中调用返回的释放函数。
   * 涉及的目录（当前与新的绑定目录）正在恢复、预览或处理未完成的恢复时同步抛出 restore-busy；取得与释放都递增代次，
   * 使之前的全部预览失效。原生对话框期间不需要占位
   */
  beginBindingMutation(input: { flavorId: number; roots: readonly (string | null)[] }): () => void {
    const roots = new Set(input.roots.filter((r): r is string => typeof r === 'string'));
    if (this.activeRoot !== null && roots.has(this.activeRoot)) {
      throw new UserError('这个游戏目录正在恢复 WTF 或处理未完成的恢复，暂时不能更改绑定', 'restore-busy');
    }
    this.bindingGen++;
    const lease = { roots };
    this.leases.add(lease);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.delete(lease);
      this.bindingGen++;
    };
  }

  /** 同步占位：涉及的目录没有进行中的绑定写入，且没有其他备份 / 恢复任务（由共用的任务占位保证） */
  private beginTask(kind: 'restore-preview' | 'restore' | 'restore-resolve', flavorId: number, root: string, snapshotId: string | null, scope: BackupScope | null): ActiveTask {
    for (const l of this.leases) if (l.roots.has(root)) throw new UserError('这个游戏目录的绑定正在修改，请稍后再试', 'restore-busy');
    const task = this.bridge.begin(kind, flavorId, root, snapshotId, scope);
    this.activeRoot = root;
    return task;
  }

  private endTask(task: ActiveTask): void {
    this.activeRoot = null;
    this.bridge.end(task);
  }

  private walkOpts(signal: AbortSignal | undefined, label: string, extra = 0, depthExtra = 0): WalkOptions {
    const L = this.bridge.limits;
    return { maxEntries: L.maxEntries + extra, maxDepth: L.maxDepth + depthExtra, rejectHardlinks: true, signal, label };
  }

  // ---------- 预览 ----------

  /** 预览恢复：只读，见文件头。目标必须是该游戏版本当前绑定的目录且已启用备份；有未完成的恢复时拒绝 */
  async restorePreview(flavorId: unknown, expectedRoot: unknown, snapshotId: unknown): Promise<RestorePreview> {
    const f = flavorArg(flavorId);
    const expected = pathArg(expectedRoot);
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(snapshotId)) throw new UserError('备份编号无效');
    const task = this.beginTask('restore-preview', f, expected, snapshotId, null);
    try {
      return await this.doPreview(task, f, expected, snapshotId);
    } finally {
      this.endTask(task);
    }
  }

  private async assertNoPending(root: string): Promise<void> {
    const data = await this.txn.registry.load();
    if (data.entries.some((e) => e.root === root)) throw new UserError('这个游戏目录有未完成的恢复，请先在“未完成的恢复”中处理', 'restore-pending');
  }

  private async doPreview(task: ActiveTask, f: number, expected: string, snapshotId: string): Promise<RestorePreview> {
    const B = this.bridge;
    const signal = task.controller.signal;
    const gen = this.bindingGen;
    const cfgGen = B.configGeneration();
    const root = await B.checkTarget(f, expected);
    const rootChain = await chainIds(root);
    await this.assertNoPending(root);
    const rec = await B.enabledRecord(f, root);
    const ctr = await B.openContainer(rec, signal);
    await B.assertLocation(ctr.path, root, true);
    B.phase(task, 'verifying');
    const snap = await this.openSnapshot(ctr, snapshotId, rec.flavorId, true, signal);
    const live = await this.readLive(root, signal);
    const plan = planRestore(snap.manifest.scope, snap.manifest.entries, live.kind === 'present' ? live.entries : null);
    const cap = await this.capacity(ctr, rec, root, live, plan, signal);
    // 返回前复核：代次、绑定、目标目录与备份位置
    if (gen !== this.bindingGen || cfgGen !== B.configGeneration()) throw changed('预览期间游戏目录绑定或备份设置发生了变化');
    await B.checkTarget(f, expected);
    const chainNow = await chainIds(root).catch(() => null);
    if (!chainNow || !sameChain(chainNow, rootChain)) throw changed('预览期间游戏目录被移动或替换');
    await B.recheckContainer(ctr, rec, signal);
    throwIfAborted(signal);

    const token = cap.blockers.length === 0 ? randomBytes(16).toString('hex') : null;
    const expiresAt = token ? this.now() + TOKEN_TTL_MS : null;
    if (token && expiresAt !== null && snap.tree) {
      this.storePlan({
        token, expiresAt, flavorId: f, root, rootChain, bindingGen: gen, configGen: cfgGen, containerPath: ctr.path, containerId: rec.containerId, containerChain: [...ctr.chain],
        snapshotId, snapshotDirId: snap.dirId, manifestSha: snap.manifestSha, scope: snap.manifest.scope, sourceWalk: snap.tree.walk,
        baseline: live.kind === 'present' ? { kind: 'present', wtfId: live.wtfId, walk: live.walk, entries: live.entries, bytes: live.bytes } : { kind: 'absent' },
      });
    }
    const preview: RestorePreview = {
      token, expiresAt, flavorId: f, root, snapshotId, snapshotCreatedAt: snap.manifest.createdAt, snapshotAppVersion: snap.manifest.appVersion,
      scope: snap.manifest.scope, baseline: plan.baseline, counts: { ...plan.counts },
      samples: { add: [...plan.samples.add], overwrite: [...plan.samples.overwrite], delete: [...plan.samples.delete], truncated: plan.samples.truncated },
      kept: { ...plan.kept }, candidate: { ...plan.candidate },
      current: live.kind === 'present' ? { files: live.files, dirs: live.dirs, bytes: live.bytes } : null,
      safetyCopy: cap.safety, space: cap.space, notes: this.notesFor(snap.manifest.scope, live.kind === 'present'), blockers: cap.blockers,
    };
    return JSON.parse(JSON.stringify(preview)) as RestorePreview;
  }

  private storePlan(p: PlanRecord): void {
    const now = this.now();
    for (const [k, v] of this.plans) if (v.expiresAt <= now) this.plans.delete(k);
    while (this.plans.size >= MAX_PLANS) {
      const oldest = this.plans.keys().next().value as string;
      this.plans.delete(oldest);
    }
    this.plans.set(p.token, p);
  }

  private notesFor(scope: BackupScope, present: boolean): string[] {
    const notes: string[] = [];
    if (scope.kind === 'all') notes.push('整个 WTF（包括所有账号与 Config.wtf）会恢复为备份时的状态，备份之后新增的内容会被删除');
    else if (scope.kind === 'account') notes.push(`账号「${scope.account}」的整个目录（包括其中所有角色）会恢复为备份时的状态，备份之后新增的角色与文件会被删除；其他账号与 WTF 根级设置不变`);
    else notes.push(`按角色恢复会同时把账号「${scope.account}」共享的 SavedVariables 与账号目录下的直属文件恢复为备份时的状态，影响这个账号下的所有角色（包括没有选择的角色）`);
    notes.push('恢复前会读取并核对当前完整的 WTF；其中有链接、多硬链接、特殊文件或超出上限的内容时不能恢复');
    if (present) notes.push('执行时会先把当前完整的 WTF 备份到同一备份位置（计入份数与容量上限，不会自动删除）');
    else notes.push('当前没有 WTF，不会生成恢复前的备份');
    notes.push('恢复后的文件权限为 0600、文件夹为 0700，修改时间为恢复时的时间；请确认已完全退出魔兽世界');
    return notes;
  }

  /** 份数 / 容量与可用空间；不满足的条件写入 blockers（不抛错） */
  private async capacity(ctr: ContainerCtx, rec: TargetRecord, root: string, live: LiveRead, plan: RestorePlan, signal: AbortSignal | undefined) {
    const L = this.bridge.limits;
    const blockers: string[] = [];
    const present = live.kind === 'present';
    const safetyBytes = present ? live.bytes : 0;
    const safetyEntries = present ? live.files + live.dirs : 0;
    if (present) {
      const u = await this.bridge.usage(ctr.path, rec.flavorId, signal);
      if (u.block) blockers.push(`不能生成恢复前的备份：${u.block}`);
      else {
        if (u.usage.count + 1 > L.maxSnapshots) blockers.push(`备份位置的份数将超过上限（${L.maxSnapshots} 份），旧备份不会自动删除，请先整理`);
        if (u.usage.bytes + safetyBytes + safetyEntries * MANIFEST_BYTES_PER_ENTRY > L.maxTotalBytes) blockers.push('备份位置的总占用将超过上限，旧备份不会自动删除，请先整理');
      }
      if (safetyBytes > L.maxSnapshotBytes) blockers.push('当前 WTF 超出单份备份的大小上限，不能生成恢复前的备份');
    }
    if (plan.candidate.bytes > L.maxSnapshotBytes || plan.candidate.files + plan.candidate.dirs > L.maxEntries) blockers.push('恢复后的 WTF 超出数量或大小上限');
    const backupNeed = present ? safetyBytes + safetyEntries * MANIFEST_BYTES_PER_ENTRY : 0;
    const gameNeed = plan.candidate.bytes;
    const [cst, rst] = await Promise.all([lstat(ctr.path, { bigint: true }), lstat(root, { bigint: true })]);
    const sameVolume = cst.dev === rst.dev;
    const free = async (dir: string): Promise<number | null> => {
      try {
        if (this.opts.freeBytes) return await this.opts.freeBytes(dir);
        const s = await statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    };
    const backupFree = present || sameVolume ? await free(ctr.path) : null;
    const gameFree = await free(root);
    if (gameFree === null || (present && backupFree === null)) blockers.push('无法读取磁盘的可用空间，不能确认恢复所需的空间');
    else if (sameVolume) {
      if (gameFree < backupNeed + gameNeed + SPACE_MARGIN) blockers.push('磁盘可用空间不足，不能同时放下恢复前的备份与恢复后的内容');
    } else {
      if (gameFree < gameNeed + SPACE_MARGIN) blockers.push('游戏所在磁盘的可用空间不足，放不下恢复后的内容');
      if (present && backupFree !== null && backupFree < backupNeed + SPACE_MARGIN) blockers.push('备份位置所在磁盘的可用空间不足，放不下恢复前的备份');
    }
    return {
      blockers,
      safety: { required: present, bytes: safetyBytes, entries: safetyEntries },
      space: { backupVolumeNeeded: backupNeed, backupVolumeFree: backupFree, gameVolumeNeeded: gameNeed, gameVolumeFree: gameFree, sameVolume },
    };
  }

  /**
   * 打开一份备份：目录是备份位置下的真实目录，顶层只有 WTF、清单与访达文件，清单严格解析且游戏版本一致；
   * verify 为 true 时按清单完整校验 WTF 内容（集合、身份与全部校验值，清单外只允许 .DS_Store），并确认清单在校验期间未变
   */
  private async openSnapshot(ctr: { path: string; chain: readonly string[] }, id: string, flavorId: number, verify: boolean, signal: AbortSignal | undefined): Promise<OpenedSnapshot> {
    const L = this.bridge.limits;
    const bad = (why: string) => new UserError(`备份 ${id} 无法用于恢复：${why}`, 'restore-snapshot');
    const dir = path.join(ctr.path, id);
    const st = await lstat(dir, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)));
    if (!st) throw new UserError('找不到该备份，可能已在访达中删除，请刷新', 'backup-snapshot');
    if (st.isSymbolicLink() || !st.isDirectory()) throw bad('不是普通文件夹');
    const dirChain = await chainIds(dir);
    if (dirChain[0] !== idOf(st) || !sameChain(dirChain.slice(1), ctr.chain)) throw bad('目录被移动或替换');
    let top: WalkEntry[];
    try {
      top = await walkTree(dir, this.walkOpts(signal, '备份', SNAPSHOT_EXTRA_ENTRIES, 1));
    } catch (err) {
      if (err instanceof UserError && err.code === 'backup-cancelled') throw err;
      throw bad(errorMessage(err));
    }
    const topBad = topLevelProblem(top, true);
    if (topBad) throw bad(topBad);
    const manifestPath = path.join(dir, MANIFEST_NAME);
    const meta = await readMeta(manifestPath, L.maxManifestBytes, '备份清单', signal);
    if (!meta) throw bad('缺少备份清单');
    const manifest = parseManifest(meta.data, id, L);
    if (manifest.flavorId !== flavorId) throw bad('清单的游戏版本与备份位置不符');
    const wtfDir = path.join(dir, 'WTF');
    const wtfId = idOf(await lstat(wtfDir, { bigint: true }));
    let tree: VerifiedTree | null = null;
    if (verify) {
      tree = await verifyTree(wtfDir, manifest.entries, this.walkOpts(signal, '备份', SNAPSHOT_EXTRA_ENTRIES), 'finder', `备份 ${id}`, { parentChain: dirChain, baseId: wtfId });
      const again = await readMeta(manifestPath, L.maxManifestBytes, '备份清单', signal);
      if (!again || idOf(again.st) !== idOf(meta.st) || !again.data.equals(meta.data)) throw bad('清单在校验期间被改动');
    }
    return { id, dir, dirId: idOf(st), dirChain, manifest, manifestId: idOf(meta.st), manifestSha: sha256(meta.data), wtfDir, wtfId, tree };
  }

  /** 读取当前完整 WTF：不存在（ENOENT）为 absent；链接、非目录、跨卷拒绝；有界遍历并重算全部校验值，结束时确认未变化 */
  private async readLive(root: string, signal: AbortSignal | undefined): Promise<LiveRead> {
    const L = this.bridge.limits;
    const wtf = path.join(root, 'WTF');
    const st = await lstat(wtf, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)));
    if (!st) return { kind: 'absent' };
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError('游戏目录中的 WTF 是符号链接或不是文件夹，不能恢复', 'restore-unsafe');
    if (st.dev !== (await lstat(root, { bigint: true })).dev) throw new UserError('WTF 与游戏目录不在同一磁盘卷，不能恢复', 'restore-unsafe');
    const walk = await walkTree(wtf, this.walkOpts(signal, 'WTF'));
    // 读取任何内容之前，按枚举到的大小核对单个文件与整个 WTF 的上限
    let total = 0;
    for (const w of walk) {
      if (w.kind !== 'file') continue;
      const size = Number(w.st.size);
      if (size > L.maxFileBytes) throw new UserError(`当前 WTF 中的「${w.rel}」超出单个文件上限，不能恢复`, 'restore-limit');
      total += size;
      if (total > L.maxSnapshotBytes) throw new UserError('当前 WTF 超出单份备份的大小上限，不能生成恢复前的备份，不能恢复', 'restore-limit');
    }
    throwIfAborted(signal);
    const entries: ManifestEntry[] = [];
    let bytes = 0;
    let files = 0;
    for (const w of walk) {
      if (w.kind === 'dir') {
        entries.push({ path: w.rel, type: 'dir' });
        continue;
      }
      const size = Number(w.st.size);
      const sha = await hashStoredFile(path.join(wtf, ...w.rel.split('/')), w.rel, size, w.st, signal);
      entries.push({ path: w.rel, type: 'file', size, sha256: sha });
      bytes += size;
      files++;
    }
    const again = await walkTree(wtf, this.walkOpts(signal, 'WTF'));
    const d = walkDiff(walk, again);
    if (d) throw new UserError(`读取期间当前 WTF 中的「${d}」发生了变化，请确认已退出游戏后重试`, 'restore-changed');
    const st2 = await lstat(wtf, { bigint: true });
    if (idOf(st2) !== idOf(st)) throw new UserError('读取期间 WTF 被移动或替换，请重试', 'restore-changed');
    return { kind: 'present', wtfId: idOf(st), walk, entries, bytes, files, dirs: walk.length - files };
  }

  // ---------- 执行 ----------

  /**
   * 执行恢复：只使用凭证中固定的目标、备份与范围；凭证同步消费（之后失败也需要重新预览）。ack 必须是 { gameClosed: true, overwrite: true }。
   * 准备阶段可取消（抛出 backup-cancelled，WTF 未改动）；进入替换后不可取消，结果按事务返回
   */
  async restoreApply(token: unknown, ack: unknown): Promise<RestoreRunResult> {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new UserError('恢复凭证无效，请重新预览', 'restore-token');
    const plan = this.plans.get(token);
    if (!plan) throw new UserError('恢复预览已失效或已使用，请重新预览', 'restore-token');
    this.plans.delete(token);
    if (this.now() > plan.expiresAt) throw new UserError('恢复预览已过期，请重新预览', 'restore-token');
    const task = this.beginTask('restore', plan.flavorId, plan.root, plan.snapshotId, plan.scope);
    try {
      const r = await this.doApply(task, plan, ack);
      return { ...r, taskId: task.info.id };
    } finally {
      this.endTask(task);
    }
  }

  private async doApply(task: ActiveTask, plan: PlanRecord, ack: unknown) {
    const B = this.bridge;
    const signal = task.controller.signal;
    if (plan.bindingGen !== this.bindingGen || plan.configGen !== B.configGeneration()) throw changed('预览之后游戏目录绑定或备份设置发生了变化');
    const root = await B.checkTarget(plan.flavorId, plan.root);
    const chain = await chainIds(root).catch(() => null);
    if (!chain || !sameChain(chain, plan.rootChain)) throw changed('预览之后游戏目录被移动或替换');
    const rec = await B.enabledRecord(plan.flavorId, root);
    if (rec.containerId !== plan.containerId || rec.containerPath !== plan.containerPath) throw changed('预览之后备份位置发生了变化');
    const ctr = await B.openContainer(rec, signal);
    if (!sameChain(ctr.chain, plan.containerChain)) throw changed('预览之后备份位置被移动或替换');
    await B.assertLocation(ctr.path, root, true);
    const held: Held = { proof: null, lock: null };
    const ports: RestoreApplyPorts = {
      acquireSources: (ctx) => this.acquireSources(task, plan, rec, ctr, root, held, ctx),
      checkCapacity: async (p) => {
        const free = await (this.opts.freeBytes ?? (async (d: string) => {
          const s = await statfs(d);
          return Number(s.bavail) * Number(s.bsize);
        }))(root).catch(() => null);
        if (free === null) throw new UserError('无法读取游戏所在磁盘的可用空间', 'restore-space');
        if (free < p.candidate.bytes + SPACE_MARGIN) throw new UserError('游戏所在磁盘的可用空间不足，放不下恢复后的内容', 'restore-space');
      },
      releaseSources: () => this.releaseHeld(held, ctr.path),
    };
    return this.txn.apply({
      flavorId: plan.flavorId, root, scope: plan.scope, sourceSnapshotId: plan.snapshotId, containerPath: ctr.path, ack, signal,
      onCritical: () => {
        B.critical(task);
        B.phase(task, 'swapping');
      },
      onProgress: (done, total) => {
        task.info.filesDone = done;
        task.info.filesTotal = total;
        B.progress();
      },
    }, ports);
  }

  /**
   * 事务取得目标占用之后调用：取得备份位置占用（持久意图 → 排他创建 → 严格同步 → 持久精确证明），
   * 在两个占用下重新核对备份与当前 WTF 与预览完全一致，生成恢复前备份（当前存在时）并确认它与预览时的当前 WTF 完全相同
   */
  private async acquireSources(
    task: ActiveTask, plan: PlanRecord, rec: TargetRecord, ctr: ContainerCtx, root: string, held: Held,
    ctx: Parameters<RestoreApplyPorts['acquireSources']>[0],
  ): Promise<{ snapshot: RestoreTreeSource; safety: RestoreTreeSource | null }> {
    const B = this.bridge;
    const { signal } = ctx;
    await B.recheckContainer(ctr, rec, signal);
    await B.assertLocation(ctr.path, root, true);
    if (ctx.baseline !== plan.baseline.kind) throw changed('当前 WTF 的存在状态与预览时不同');
    const token = randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const intent: HoldProof = {
      v: 1, containerPath: ctr.path, chain: [...ctr.chain], id: null, token, createdAt, pid: process.pid, txid: ctx.txid, nonce: ctx.nonce,
      taskId: task.info.id, appVersion: B.appVersion, safetySnapshotId: plan.baseline.kind === 'present' ? ctx.safetySnapshotId : null,
    };
    await ctx.recordHold(JSON.stringify(intent));
    held.proof = intent;
    const lock = await B.acquireLock(ctr.path, { token, createdAt }, {
      taskKind: 'restore', taskId: intent.taskId, txid: ctx.txid, nonce: ctx.nonce, pid: process.pid, appVersion: intent.appVersion,
    });
    held.lock = lock;
    this.ownHoldTokens.add(token);
    await syncDirStrict(ctr.path, '备份位置的占用标记');
    const proof: HoldProof = { ...intent, id: lock.id };
    await ctx.recordHold(JSON.stringify(proof));
    held.proof = proof;

    // 在两个占用下重新核对：备份与预览完全一致，当前 WTF 的集合与每一项身份 / 大小 / 时间与预览一致
    B.phase(task, 'verifying');
    const snap = await this.openSnapshot(ctr, plan.snapshotId, rec.flavorId, true, signal);
    if (snap.manifestSha !== plan.manifestSha || snap.dirId !== plan.snapshotDirId || !snap.tree || walkDiff(plan.sourceWalk, snap.tree.walk)) {
      throw changed(`备份 ${plan.snapshotId} 在预览之后被改动`);
    }
    const wtf = path.join(root, 'WTF');
    if (plan.baseline.kind === 'present') {
      const id = await lstat(wtf, { bigint: true }).then(idOf, () => null);
      if (id !== plan.baseline.wtfId) throw changed('预览之后 WTF 被移动或替换');
      const now = await walkTree(wtf, this.walkOpts(signal, 'WTF'));
      const d = walkDiff(plan.baseline.walk, now);
      if (d) throw changed(`预览之后当前 WTF 中的「${d}」发生了变化`);
    } else if (await lstat(wtf).then(() => true, (err: unknown) => errCode(err) !== 'ENOENT')) {
      throw changed('预览之后出现了 WTF');
    }
    throwIfAborted(signal);

    const check = async () => {
      await B.recheckContainer(ctr, rec);
      await this.assertHeldLock(held);
    };
    const snapshot = this.treeSource(snap, check);
    let safety: RestoreTreeSource | null = null;
    if (plan.baseline.kind === 'present') {
      if (!ctx.safetySnapshotId) throw new UserError('缺少恢复前备份的编号', 'restore-unsafe');
      B.phase(task, 'safety-copy');
      const out = await B.copy(task, rec, ctr, lock, {
        scope: ALL_SCOPE, id: ctx.safetySnapshotId, restoreTx: ctx.txid, syncDirStrict: (d) => syncDirStrict(d, '恢复前备份'),
        ledger: { rootId: null, entries: new Map() }, cleanupPartial: (p) => cleanupSafetyPartial(B.limits, p),
      });
      if (!sameEntries(out.manifest.entries, plan.baseline.entries)) {
        throw changed(`恢复前备份 ${ctx.safetySnapshotId} 已保留，但它与预览时的当前 WTF 不一致（WTF 在预览之后被改动）`);
      }
      const opened = await this.openSnapshot(ctr, ctx.safetySnapshotId, rec.flavorId, false, signal);
      safety = this.treeSource(opened, check);
    }
    B.phase(task, 'staging');
    return { snapshot, safety };
  }

  private treeSource(s: OpenedSnapshot, check: () => Promise<void>): RestoreTreeSource {
    const L = this.bridge.limits;
    return {
      snapshotId: s.id, wtfDir: s.wtfDir, wtfId: s.wtfId, parentChain: s.dirChain, entries: s.manifest.entries,
      recheck: async () => {
        await check();
        const chain = await chainIds(s.dir).catch(() => null);
        if (!chain || !sameChain(chain, s.dirChain)) throw new UserError(`备份 ${s.id} 被移动或替换`, 'restore-changed');
        const meta = await readMeta(path.join(s.dir, MANIFEST_NAME), L.maxManifestBytes, '备份清单').catch(() => null);
        if (!meta || idOf(meta.st) !== s.manifestId || sha256(meta.data) !== s.manifestSha) throw new UserError(`备份 ${s.id} 的清单被改动`, 'restore-changed');
      },
    };
  }

  /** 本次的备份位置占用标记仍完整：所在目录链、身份与全部字段与证明一致 */
  private async assertHeldLock(held: Held): Promise<void> {
    if (!held.proof || !held.lock) throw new UserError('没有持有备份位置的占用', 'restore-changed');
    const r = await this.lockMatches(held.proof);
    if (r !== 'match') throw new UserError(`备份位置的占用标记被改动（${held.lock.path}）`, 'restore-changed');
  }

  /** 标记与证明的关系：match 完全一致；absent 不存在；other 是其他标记（身份不同）；changed 身份相同但内容不符；unknown 无法确认 */
  private async lockMatches(p: HoldProof): Promise<'match' | 'absent' | 'other' | 'changed' | 'unknown'> {
    const chain = await chainIds(p.containerPath).catch(() => null);
    if (!chain || !sameChain(chain, p.chain)) return 'unknown';
    const file = path.join(p.containerPath, LOCK_NAME);
    let meta;
    try {
      meta = await readMeta(file, MAX_LOCK_BYTES, '占用标记');
    } catch {
      return 'unknown';
    }
    if (!meta) return 'absent';
    if (p.id === null || idOf(meta.st) !== p.id) {
      // 只有意图、没有身份：同令牌的标记无法确认是本次创建的那一个
      if (p.id === null) {
        const v = (() => {
          try {
            return JSON.parse(meta.data.toString('utf8')) as unknown;
          } catch {
            return null;
          }
        })();
        return isObj(v) && v.token === p.token ? 'unknown' : 'other';
      }
      return 'other';
    }
    let v: unknown;
    try {
      v = JSON.parse(meta.data.toString('utf8'));
    } catch {
      return 'changed';
    }
    if (
      !isObj(v) || Object.keys(v).length !== LOCK_KEYS.length || !LOCK_KEYS.every((k) => k in v) || v.format !== BACKUP_FORMAT || v.kind !== 'lock' ||
      v.token !== p.token || v.createdAt !== p.createdAt || v.taskKind !== 'restore' || v.txid !== p.txid || v.nonce !== p.nonce || v.pid !== p.pid ||
      v.taskId !== p.taskId || v.appVersion !== p.appVersion
    ) {
      return 'changed';
    }
    return 'match';
  }

  /** 按证明删除本次的备份位置占用标记并严格同步；不存在时也严格同步。返回保留说明（null 表示已释放且已确认） */
  private async dropLock(p: HoldProof): Promise<string | null> {
    const file = path.join(p.containerPath, LOCK_NAME);
    const state = await this.lockMatches(p);
    if (state === 'unknown') return `备份位置的占用标记无法确认属于这次恢复，已保留：${file}`;
    if (state === 'changed') return `备份位置的占用标记已被改动，已保留：${file}`;
    if (state === 'match' && p.id && !(await unlinkIfSame(file, p.id))) return `无法删除备份位置的占用标记，已保留：${file}`;
    try {
      await syncDirStrict(p.containerPath, '备份位置占用标记的删除');
    } catch (err) {
      return `备份位置的占用标记已删除，但删除结果未能确认写入磁盘（${errorMessage(err)}）：${file}`;
    }
    return null;
  }

  /**
   * 恢复前备份的临时目录是否残留：残留（或无法确认）时返回说明，占用保留、这项恢复保持待处理。
   * 中断后临时目录中的字节无法证明属于本次，不会被自动删除；用户移走该目录后再次处理即可继续
   */
  private async partialLeft(p: HoldProof): Promise<string | null> {
    if (!p.safetySnapshotId) return null;
    const dir = path.join(p.containerPath, PARTIAL_PREFIX + p.safetySnapshotId);
    const st = await lstat(dir).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : undefined));
    if (st === null) return null;
    return `恢复前备份的临时目录仍在备份位置中，内容无法确认已完整或只含本次写入的数据，已保留：${dir}。它会阻止在该位置新建备份；确认不需要后请在访达中移走这个文件夹，然后再次处理这项恢复`;
  }

  /** 释放本次执行取得的备份位置占用（事务的 releaseSources）；恢复前备份的临时目录残留时保留占用 */
  private async releaseHeld(held: Held, container: string): Promise<string | null> {
    const p = held.proof;
    if (!p) return null;
    const left = await this.partialLeft(p);
    if (left) {
      this.bridge.forgetLock(container);
      return left;
    }
    const note = await this.dropLock(p);
    this.bridge.forgetLock(container);
    if (!note) {
      held.lock = null;
      held.proof = null;
      this.ownHoldTokens.delete(p.token);
    }
    return note;
  }

  // ---------- 只读查看与处理 ----------

  /** 全局未完成的恢复（不要求启用或当前绑定）；登记无法读取时 registryError 非空；已绑定目录的工作目录无法检查时列入 scanErrors */
  async restorePending(): Promise<RestorePendingView> {
    let roots: string[] = [];
    let boundRootsError: string | null = null;
    try {
      roots = await this.bridge.listBoundRoots();
    } catch (err) {
      boundRootsError = `无法读取游戏目录绑定（${errorMessage(err)}），未登记的恢复内容只检查了登记中的目录`;
    }
    return { ...(await this.txn.pending(roots)), boundRootsError };
  }

  /**
   * 处理一项登记的未完成恢复：只接收恢复编号，目标目录、游戏版本与备份位置都取自登记（原目录已解绑或换绑时也处理原目录，
   * 不转向当前绑定）；需要新的 { gameClosed: true } 确认。处理期间不可取消
   */
  async restoreResolve(txid: unknown, ack: unknown): Promise<RestoreResolveResult & { taskId: string }> {
    if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw new UserError('恢复编号无效', 'restore-unknown');
    const data = await this.txn.registry.load();
    const entry = data.entries.find((e) => e.txid === txid);
    if (!entry) throw new UserError('找不到这项未完成的恢复，可能已处理', 'restore-unknown');
    const task = this.beginTask('restore-resolve', entry.flavorId, entry.root, entry.sourceSnapshotId, entry.scope);
    try {
      this.bridge.critical(task);
      const ports: RestoreResolvePorts = {
        openSources: (c) => this.openRegisteredSources(entry.flavorId, c),
        releaseHold: (c) => this.releaseStaleHold(c),
      };
      const r = await this.txn.resolve({ flavorId: entry.flavorId, root: entry.root, txid, ack }, ports);
      return { ...r, taskId: task.info.id };
    } finally {
      this.endTask(task);
    }
  }

  /** 只读打开登记的备份位置中的两份备份（不取得占用；内容由事务完整校验）。无法打开的为 null */
  private async openRegisteredSources(flavorId: number, c: { sourceSnapshotId: string; safetySnapshotId: string | null; containerPath: string }) {
    const open = async (id: string | null): Promise<RestoreTreeSource | null> => {
      if (!id) return null;
      try {
        const st = await lstat(c.containerPath, { bigint: true });
        if (st.isSymbolicLink() || !st.isDirectory() || (await realpath(c.containerPath)) !== c.containerPath) return null;
        const marker = await readMeta(path.join(c.containerPath, MARKER_NAME), 64 * 1024, '备份位置标记');
        const m = marker ? (JSON.parse(marker.data.toString('utf8')) as unknown) : null;
        if (!isObj(m) || m.format !== BACKUP_FORMAT || m.kind !== 'container' || m.flavorId !== flavorId) return null;
        const chain = await chainIds(c.containerPath);
        const snap = await this.openSnapshot({ path: c.containerPath, chain }, id, flavorId, false, undefined);
        return this.treeSource(snap, async () => {
          const now = await chainIds(c.containerPath).catch(() => null);
          if (!now || !sameChain(now, chain)) throw new UserError('备份位置被移动或替换', 'restore-changed');
        });
      } catch {
        return null;
      }
    };
    return { snapshot: await open(c.sourceSnapshotId), safety: await open(c.safetySnapshotId) };
  }

  /**
   * 中断遗留的备份位置占用：证明必须与登记一致（恢复编号、nonce、备份位置）。标记已不存在或已是其他标记时严格同步后视为释放；
   * 与证明完全一致时，只有本实例创建的（同一进程）或持有进程确认已退出（ESRCH）才删除；只有意图、没有身份的同令牌标记保留
   */
  private async releaseStaleHold(c: { txid: string; nonce: string; containerPath: string; hold: string }): Promise<string | null> {
    const p = parseHold(c.hold);
    const file = path.join(c.containerPath, LOCK_NAME);
    if (!p || p.txid !== c.txid || p.nonce !== c.nonce || p.containerPath !== c.containerPath) return `备份位置占用的记录无法识别，保留为待处理：${file}`;
    const left = await this.partialLeft(p);
    if (left) return left;
    const state = await this.lockMatches(p);
    if (state === 'unknown') return `备份位置不可用，或占用标记在登记身份之前中断而无法确认，已保留：${file}`;
    if (state === 'changed') return `备份位置的占用标记已被改动，已保留：${file}`;
    if (state === 'match') {
      const own = p.pid === process.pid && this.ownHoldTokens.has(p.token);
      if (!own) {
        if (p.pid === process.pid) return `备份位置的占用标记由本进程中的其他任务持有，已保留：${file}`;
        if (this.probe(p.pid) !== 'gone') return `备份位置占用的原持有进程仍在运行，或无法确认它已退出，已保留：${file}`;
        if ((await this.lockMatches(p)) !== 'match' || this.probe(p.pid) !== 'gone') return `备份位置的占用标记在核对期间发生变化，已保留：${file}`;
      }
    }
    const note = await this.dropLock(p);
    if (!note) this.ownHoldTokens.delete(p.token);
    return note;
  }

  /**
   * 诊断导出用的受保护位置：恢复登记中全部未完成恢复的游戏目录与备份位置（含已解绑的目录）。只读有界读取登记；
   * 登记不存在时为空；存在但无法读取或不合法时抛错（不能当作没有）
   */
  async pendingProtectionPaths(): Promise<string[]> {
    const data = await this.txn.registry.load();
    return [...new Set(data.entries.flatMap((e) => [e.root, e.containerPath]))];
  }
}
