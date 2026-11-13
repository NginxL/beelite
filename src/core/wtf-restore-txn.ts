// 本地 WTF 恢复的磁盘事务：在 <root>/.azercube-wtf-restore/tx-<txid>/ 中构造完整的候选 WTF，
// 经两次同卷 rename 替换（WTF → old，candidate → WTF），以 userData 中的全局登记与工作目录中的 journal 记录进度。
// - 顺序：登记意图 → 工作目录 → 目标占用标记（登记它的完整证明）→ 事务目录（登记身份）→ journal(preparing) → [preparing] →
//   调用方取得备份位置占用并生成完整的恢复前备份（目标占用总在备份位置占用之前）→ 完整校验来源与当前 WTF → 计划 →
//   候选清单 + 候选根目录（登记它们的证明）→ 候选树 → 提交前复核 → journal(prepared) → [prepared] → 闸门 →
//   WTF → old → [old-moved] → 闸门 → candidate → WTF → [new-moved] → 闸门 → [before-commit] → 闸门（在 committed 写入的 rename 之前）→
//   journal(committed) → [committed] → 收尾。
// - 闸门：每个可观察的 await（测试钩子、目录同步）之后、下一次移动或提交之前，核对目标占用、各级目录身份，
//   以及当前 WTF / 原件 / 候选树相对固定遍历的集合与每一项身份 / 大小 / 时间（状态改变时间能发现原地改写）。任何变化都不移动、不提交。
// - 回滚只在当前 WTF（若是候选树）与原件都按完整内容核对一致时进行；发现外部改动一律保留现场并登记 blocked，不删除任何外来字节。
// - 候选树只按持久登记的候选根身份与候选清单逐项核对（含校验值）后删除；不使用创建时的内存记录清理曾经放入 WTF 的树。
//   没有持久证明的候选内容、元数据与占用标记一律保留，并在未完成列表中可见。
// - 已持久的 committed 永不回滚：处理未完成恢复时最先识别；当前 WTF 已不是恢复写入的目录时只提示并保留原件。
// - 删除原件 / 候选树：先完整（exact）核对通过才持久标记 discard，之后才删除；中断后只有带标记时才按子集继续。
// - 结果确定后先在登记中持久写入 outcome，再删除本次的 journal 与候选清单（只删除身份与校验值都已知的文件）、事务目录，
//   严格同步工作目录，最后释放目标占用；占用的删除确认写入磁盘之后才从登记中移除这一项。
// - 处理未完成恢复需要新的“游戏已退出”确认；只读查看（pending）不写任何文件。
// - 路径检查基于 Node 路径 API 与 dev:ino 复核，能发现跨越每一次 await 的变化，但无法消除同权限恶意进程的极短竞态。
import { lstat, mkdir, realpath, rename, rmdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { BackupLimits, BackupScope } from '../shared/backup-types';
import type { RestoreApplyResult, RestoreBaseline, RestorePendingItem, RestorePendingView, RestoreResolveResult } from '../shared/restore-types';
import { errorMessage, SimulatedCrash, UserError } from './errors';
import {
  chainIds, errCode, idOf, newSnapshotId, PartialTracker, parseBackupScope, readMeta, sameChain, throwIfAborted, unlinkIfSame, walkDiff, walkTree,
  type ManifestEntry, type WalkEntry, type WalkOptions,
} from './wtf-backup';
import {
  assertTargetLock, copyVerifiedFile, createTargetLock, idOrNull, listNames, probePid, readJson, readTargetLock, releaseTargetLock, removeVerifiedTree,
  sameLockInfo, sha256, syncDirStrict, verifyTree, writeDurable, type HeldTargetLock, type PidState, type VerifiedTree,
} from './wtf-restore-io';
import { planRestore, type PlannedEntry, type RestorePlan } from './wtf-restore-plan';
import {
  MAX_JOURNAL_BYTES, MAX_PENDING, MAX_SOURCE_HOLD, parseCandidate, parseJournal, RESTORE_FORMAT, RestoreRegistry, serializeCandidate, serializeJournal, TXID_RE,
  type RegistryDraft, type RestoreCandidateProof, type RestoreJournal, type RestoreRegEntry, type RestoreSettled,
} from './wtf-restore-registry';

export const CONTROL_DIR = '.azercube-wtf-restore';
export const CONTROL_MARKER = '.azercube-wtf-restore.json';
export const TARGET_LOCK = 'RESTORE.lock';
export const TX_PREFIX = 'tx-';
const JOURNAL = 'journal.json';
const CANDIDATE_LIST = 'candidate.json';
const CANDIDATE_DIR = 'candidate';
const OLD_DIR = 'old';
const MAX_CONTROL_NAMES = 256;
/** 读取备份目录时允许的额外条目（WTF 之外的访达文件等） */
const SOURCE_SLACK = 64;

/**
 * 测试注入点（生产不设置）。各阶段在对应状态已持久化、可被识别之后调用：
 * preparing：登记、工作目录、目标占用标记、事务目录与 journal(preparing) 都已持久化，尚未取得备份位置占用；
 * sources-ready：备份位置占用与恢复前备份已就绪；staging-file（detail 为路径）：复制每个候选文件之前；
 * staged：候选树已完整校验；prepared：journal(prepared) 已持久化，尚未移动；old-moved：原 WTF 已移入工作目录（当前没有 WTF 时不触发）；
 * new-moved：候选树已移到 WTF，尚未写 committed；before-commit：替换后复核已通过，即将写 committed；committed：committed 已持久化；
 * cleanup：开始收尾之前；resolve-locked：处理未完成恢复时取得目标占用之后、判断状态之前。
 * 每个钩子之后都有闸门复核。抛出 SimulatedCrash 时立即向上传递，不回滚、不清理、不释放（模拟进程在此处退出）；
 * 抛出其他错误按该阶段的普通故障处理（committed / cleanup 之后的异常被忽略，不改变已提交的结果）。
 */
export type RestoreStep =
  | 'preparing' | 'sources-ready' | 'staging-file' | 'staged' | 'prepared' | 'old-moved' | 'new-moved' | 'before-commit' | 'committed' | 'cleanup' | 'resolve-locked';

export interface RestoreHooks {
  step?(name: RestoreStep, detail?: string): Promise<void> | void;
}

/** 由调用方（备份服务）打开并核对过格式的一份备份；内容由本模块按清单重新校验 */
export interface RestoreTreeSource {
  snapshotId: string;
  /** 备份中 WTF 目录的绝对路径 */
  wtfDir: string;
  /** wtfDir 的身份与其上级目录各级身份（调用方固定） */
  wtfId: string;
  parentChain: readonly string[];
  /** 已解析的清单条目（相对 WTF） */
  entries: readonly ManifestEntry[];
  /** 复核备份位置（各级身份、标记、占用等）；不一致时抛错 */
  recheck(): Promise<void>;
}

export interface RestoreApplyPorts {
  /**
   * 目标占用与 journal(preparing) 持久化之后调用：取得备份位置占用；baseline 为 present 时以 safetySnapshotId 生成并完整校验
   * 当前完整 WTF 的恢复前备份（不存在时为 null）。失败时调用方清理本次的临时内容（占用由 releaseSources 释放）。
   * recordHold：调用方对备份位置占用的证明（不透明，最长 MAX_SOURCE_HOLD 字符），本模块立即持久写入 journal；
   * 应在创建占用标记之前先记录意图，取得标记身份之后再记录完整证明。一旦记录过，无论 acquireSources 成败，
   * 本模块都会调用 releaseSources；中断后交给 RestoreResolvePorts.releaseHold 按证明识别并释放
   */
  acquireSources(ctx: {
    txid: string;
    nonce: string;
    baseline: RestoreBaseline;
    safetySnapshotId: string | null;
    signal?: AbortSignal;
    recordHold(hold: string): Promise<void>;
  }): Promise<{
    snapshot: RestoreTreeSource;
    safety: RestoreTreeSource | null;
    hold?: string | null;
  }>;
  /** 按计划核对调用方的数量、字节上限与可用空间；不满足时抛错 */
  checkCapacity(plan: RestorePlan): Promise<void>;
  /** 释放 acquireSources 取得的占用（没有占用时返回 null）；返回保留说明。acquireSources 成功或记录过占用证明后调用一次 */
  releaseSources(): Promise<string | null>;
}

export interface RestoreResolvePorts {
  /** 只读打开登记的备份与恢复前备份（不取得占用）；无法打开时为 null */
  openSources(ctx: { sourceSnapshotId: string; safetySnapshotId: string | null; containerPath: string }): Promise<{ snapshot: RestoreTreeSource | null; safety: RestoreTreeSource | null }>;
  /**
   * 释放中断遗留的备份位置占用：hold 为 acquireSources 当时给出的证明。确认已释放（或确认已不存在）时返回 null，
   * 否则返回保留说明。没有提供时，带占用证明的未完成恢复保持待处理
   */
  releaseHold?(ctx: { txid: string; nonce: string; containerPath: string; hold: string }): Promise<string | null>;
}

export interface RestoreApplyInput {
  flavorId: number;
  /** 调用方已确认是当前绑定的规范化游戏目录 */
  root: string;
  scope: BackupScope;
  sourceSnapshotId: string;
  containerPath: string;
  ack: unknown;
  signal?: AbortSignal;
  /** 进入不可取消的临界段时同步调用（之后直到返回都不可取消） */
  onCritical?(): void;
  onProgress?(filesDone: number, filesTotal: number): void;
}

export type { RestoreApplyResult, RestorePendingItem, RestorePendingView, RestoreResolveResult };

export interface RestoreTxnOptions {
  registryFile: string;
  limits: BackupLimits;
  hooks?: RestoreHooks;
  /** 测试注入：进程是否已退出的判断 */
  probePid?: (pid: number) => PidState;
}

interface TxPaths {
  wtf: string;
  control: string;
  marker: string;
  lock: string;
  tx: string;
  journal: string;
  list: string;
  candidate: string;
  old: string;
}

function txPaths(root: string, txid: string): TxPaths {
  const control = path.join(root, CONTROL_DIR);
  const tx = path.join(control, TX_PREFIX + txid);
  return {
    wtf: path.join(root, 'WTF'), control, marker: path.join(control, CONTROL_MARKER), lock: path.join(control, TARGET_LOCK),
    tx, journal: path.join(tx, JOURNAL), list: path.join(tx, CANDIDATE_LIST), candidate: path.join(tx, CANDIDATE_DIR), old: path.join(tx, OLD_DIR),
  };
}

function isAck(v: unknown, keys: readonly string[]): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(v);
  return own.length === keys.length && keys.every((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return !!d && 'value' in d && d.value === true;
  });
}

function changed(detail: string): UserError {
  return new UserError(`${detail}，恢复未执行`, 'restore-changed');
}

function isCrash(err: unknown): boolean {
  return err instanceof SimulatedCrash;
}

/** 文件的已知身份与内容校验值 */
interface FileProof {
  id: string;
  sha: string;
}

/** 一次恢复（执行中或处理中）在内存中的状态 */
interface Tx {
  txid: string;
  nonce: string;
  flavorId: number;
  root: string;
  rootChain: string[];
  P: TxPaths;
  journal: RestoreJournal;
  /** 最近一次写入或读取并固定的 journal 文件；null 表示还没有 journal */
  journalProof: FileProof | null;
  controlId: string | null;
  txdirId: string | null;
  lock: HeldTargetLock | null;
  /** 候选树清单（执行中来自计划；处理中来自按证明读取的候选清单） */
  candidateEntries: readonly ManifestEntry[] | null;
  /** 本进程刚写入的候选清单文件（持久证明登记之前也能精确识别它） */
  listProof: FileProof | null;
  sourcesHeld: boolean;
  safetyMade: boolean;
  snapshot: VerifiedTree | null;
  safety: { src: RestoreTreeSource; tree: VerifiedTree } | null;
  /** 恢复前固定的当前 WTF（执行中才有） */
  live: VerifiedTree | null;
  /** 完整校验后的候选树（执行中才有） */
  candidate: VerifiedTree | null;
}

/** 收尾结果：pending 为未完成的清理（非空时登记 cleanup-pending、占用保留），warnings 只是提示 */
interface Closed {
  pending: string[];
  warnings: string[];
}

export class WtfRestoreTxn {
  readonly registry: RestoreRegistry;
  private readonly limits: BackupLimits;
  private readonly probe: (pid: number) => PidState;
  /** 正在处理的游戏目录（同步占位，防止同一实例重入） */
  private readonly busy = new Set<string>();
  /** 本实例持有、尚未释放的目标占用标记（按游戏目录）：事务未完全结束时保留，处理未完成恢复时可按精确所有权继续使用 */
  private readonly ownLocks = new Map<string, HeldTargetLock>();
  /** 本次操作中登记已保存但排他标记未能确认释放的提示（apply / resolve 返回时并入 warnings） */
  private readonly regWarnings: string[] = [];

  constructor(private readonly opts: RestoreTxnOptions) {
    this.limits = opts.limits;
    this.probe = opts.probePid ?? probePid;
    this.registry = new RestoreRegistry(opts.registryFile, this.probe);
  }

  /** 修改登记：已保存但排他标记未能确认释放时，提示收集到本次操作的结果中（不当作没有保存） */
  private async reg<T>(fn: (d: RegistryDraft) => T): Promise<T> {
    const r = await this.registry.mutate(fn);
    if (r.warning) this.regWarnings.push(r.warning);
    return r.value;
  }

  private async step(name: RestoreStep, detail?: string): Promise<void> {
    await this.opts.hooks?.step?.(name, detail);
  }

  private wtfOpts(signal: AbortSignal | undefined, label: string): WalkOptions {
    return { maxEntries: this.limits.maxEntries, maxDepth: this.limits.maxDepth, rejectHardlinks: true, signal, label };
  }

  private srcOpts(signal: AbortSignal | undefined): WalkOptions {
    return { maxEntries: this.limits.maxEntries + SOURCE_SLACK, maxDepth: this.limits.maxDepth, rejectHardlinks: true, signal, label: '备份' };
  }

  private enter(root: string): () => void {
    if (this.busy.has(root)) throw new UserError('这个游戏目录正在进行恢复或处理未完成的恢复', 'restore-busy');
    this.busy.add(root);
    return () => this.busy.delete(root);
  }

  private async wrap<R extends { warnings: string[] }>(root: string, run: () => Promise<R>): Promise<R> {
    const leave = this.enter(root);
    try {
      const r = await run();
      r.warnings.push(...this.regWarnings.splice(0));
      return r;
    } catch (err) {
      const notes = this.regWarnings.splice(0);
      throw notes.length && !isCrash(err) ? withNotesKeep(err, notes) : err;
    } finally {
      leave();
    }
  }

  // ---------- 只读查看 ----------

  /** 全局未完成恢复与最近收据；boundRoots 中未登记的工作目录也列出。不写任何文件 */
  async pending(boundRoots: readonly string[] = []): Promise<RestorePendingView> {
    let data;
    try {
      data = await this.registry.load();
    } catch (err) {
      return { registryError: errorMessage(err), items: [], receipts: [], scanErrors: [] };
    }
    const scanErrors: RestorePendingView['scanErrors'] = [];
    const items: RestorePendingItem[] = data.entries.map((e) => ({
      txid: e.txid, flavorId: e.flavorId, root: e.root, containerPath: e.containerPath, state: e.state, outcome: e.outcome, reason: e.reason, createdAt: e.createdAt,
      sourceSnapshotId: e.sourceSnapshotId, safetySnapshotId: e.safetySnapshotId, scope: e.scope,
    }));
    for (const root of new Set(boundRoots)) {
      // 只有“不存在”才算没有工作目录；其他读取失败如实列出（只读，不修改任何文件）
      let names: string[] | null;
      try {
        const ctl = path.join(root, CONTROL_DIR);
        const cst = await lstat(ctl, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)));
        if (cst && (cst.isSymbolicLink() || !cst.isDirectory())) throw new UserError('不是普通文件夹', 'ENOTDIR');
        names = cst ? await listNames(ctl, MAX_CONTROL_NAMES) : null;
      } catch (err) {
        scanErrors.push({ root, reason: `无法检查恢复工作目录 ${path.join(root, CONTROL_DIR)}（${errCode(err) ?? errorMessage(err)}），其中是否有未完成的恢复未知` });
        continue;
      }
      for (const n of names ?? []) {
        if (!n.startsWith(TX_PREFIX) || data.entries.some((e) => e.root === root && TX_PREFIX + e.txid === n)) continue;
        const id = n.slice(TX_PREFIX.length);
        items.push({
          txid: TXID_RE.test(id) ? id : null, flavorId: null, root, containerPath: null, state: 'unregistered', outcome: null, reason: `未登记的恢复工作目录：${path.join(root, CONTROL_DIR, n)}`,
          createdAt: null, sourceSnapshotId: null, safetySnapshotId: null, scope: null,
        });
      }
    }
    return { registryError: null, items, receipts: data.receipts, scanErrors };
  }

  // ---------- 公共的核对与写入 ----------

  private txChainOf(t: Tx): string[] | null {
    return t.txdirId && t.controlId ? [t.txdirId, t.controlId, ...t.rootChain] : null;
  }

  /** 目标占用仍完整属于本次、游戏目录 / 工作目录 / 事务目录的各级身份都未变化 */
  private async assertHeld(t: Tx): Promise<void> {
    if (!t.lock) throw changed('没有持有目标占用');
    await assertTargetLock(t.lock);
    const chain = await chainIds(t.root).catch(() => null);
    if (!chain || !sameChain(chain, t.rootChain)) throw changed('游戏目录或其上级目录被移动或替换');
    const expect = this.txChainOf(t);
    if (expect) {
      const tc = await chainIds(t.P.tx).catch(() => null);
      if (!tc || !sameChain(tc, expect)) throw changed('恢复事务目录被移动或替换');
    }
  }

  /** 持久写入 journal：rename 之前复核占用、目录与 journal 文件仍是最近一次固定的那一个（extra 为调用方的额外复核） */
  private async saveJournal(t: Tx, patch: Partial<RestoreJournal>, extra?: () => Promise<void>): Promise<void> {
    const next: RestoreJournal = { ...t.journal, ...patch };
    const buf = serializeJournal(next);
    const id = await writeDurable(t.P.journal, buf, '恢复日志', {
      beforeRename: async () => {
        await this.assertHeld(t);
        const cur = await readMeta(t.P.journal, MAX_JOURNAL_BYTES, '恢复日志').catch(() => undefined);
        const same = t.journalProof === null ? cur === null : !!cur && idOf(cur.st) === t.journalProof.id && sha256(cur.data) === t.journalProof.sha;
        if (!same) throw changed('恢复日志被改动');
        if (extra) await extra();
      },
    });
    t.journalProof = { id, sha: sha256(buf) };
    t.journal = next;
  }

  /** 只删除身份与内容都与证明一致的文件（所在目录各级身份也必须一致）；不存在为 null；否则返回保留说明 */
  private async removeKnownFile(file: string, proof: FileProof | null, dirChain: readonly string[]): Promise<string | null> {
    const chain = await chainIds(path.dirname(file)).catch(() => null);
    if (!chain || !sameChain(chain, dirChain)) return `${path.dirname(file)} 被移动或替换，${file} 已保留`;
    const meta = await readMeta(file, Math.max(MAX_JOURNAL_BYTES, this.limits.maxManifestBytes), path.basename(file)).catch(() => undefined);
    if (meta === null) return null;
    if (!proof || !meta || idOf(meta.st) !== proof.id || sha256(meta.data) !== proof.sha) return `${file} 无法确认是本次写入的文件，已保留`;
    if (!(await unlinkIfSame(file, proof.id))) return `${file} 无法删除，已保留`;
    return null;
  }

  // ---------- 执行恢复 ----------

  async apply(input: RestoreApplyInput, ports: RestoreApplyPorts): Promise<RestoreApplyResult> {
    if (!isAck(input.ack, ['gameClosed', 'overwrite'])) throw new UserError('需要确认已退出游戏并同意覆盖', 'restore-ack');
    const scope = parseBackupScope(input.scope);
    return this.wrap(input.root, () => this.doApply(input, scope, ports));
  }

  private async doApply(input: RestoreApplyInput, scope: BackupScope, ports: RestoreApplyPorts): Promise<RestoreApplyResult> {
    const { root, signal } = input;
    if ((await realpath(root).catch(() => null)) !== root) throw changed('游戏目录不存在或路径已变化');
    const rootSt = await lstat(root, { bigint: true });
    const rootChain = await chainIds(root);
    const before = await this.currentWtf(path.join(root, 'WTF'), rootSt.dev);
    throwIfAborted(signal);

    const txid = randomBytes(8).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const now = Date.now();
    const safetySnapshotId = before ? newSnapshotId(new Date(now)) : null;
    const entry: RestoreRegEntry = {
      txid, nonce, flavorId: input.flavorId, root, rootChain, scope, sourceSnapshotId: input.sourceSnapshotId, containerPath: input.containerPath,
      safetySnapshotId, state: 'preparing', reason: null, controlId: null, txdirId: null, lock: null, candidate: null, outcome: null, createdAt: now, updatedAt: now,
    };
    // 1. 登记意图（失败时什么都没有创建）
    await this.reg((d) => {
      if (d.data.entries.some((e) => e.root === root)) throw new UserError('这个游戏目录有未完成的恢复，请先处理', 'restore-pending');
      if (d.data.entries.length >= MAX_PENDING) throw new UserError('未完成的恢复过多，请先处理已有的未完成恢复', 'restore-pending');
      d.add(entry);
    });

    const t: Tx = {
      txid, nonce, flavorId: input.flavorId, root, rootChain, P: txPaths(root, txid),
      journal: {
        txid, nonce, flavorId: input.flavorId, root, state: 'preparing', before, candidate: null, sourceSnapshotId: input.sourceSnapshotId,
        safetySnapshotId, containerPath: input.containerPath, sourceHold: null, discardOld: false, discardCandidate: false, createdAt: now,
      },
      journalProof: null, controlId: null, txdirId: null, lock: null, candidateEntries: null, listProof: null, sourcesHeld: false, safetyMade: false,
      snapshot: null, safety: null, live: null, candidate: null,
    };

    // 2. 准备（可取消）：任何失败都在没有移动 WTF 的前提下撤回本次内容
    try {
      await this.prepare(t, input, ports, rootSt.dev);
    } catch (err) {
      if (isCrash(err)) throw err;
      const c = await this.abandon(t, ports);
      throw withNotesKeep(err, [...c.pending, ...c.warnings]);
    }

    // 3. 临界段：journal(prepared) → 闸门 → 两次 rename → 闸门 → committed
    input.onCritical?.();
    try {
      await this.saveJournal(t, { state: 'prepared' });
      await this.reg((d) => d.update(txid, { state: 'prepared' }));
      await this.step('prepared');
      await this.gate(t, 'before-move');
    } catch (err) {
      if (isCrash(err)) throw err;
      // 还没有移动任何东西：按准备阶段失败撤回（外部改动的内容不会被删除）
      const c = await this.abandon(t, ports);
      throw withNotesKeep(err, [...c.pending, ...c.warnings]);
    }
    try {
      await this.swap(t);
    } catch (err) {
      if (isCrash(err)) throw err;
      return this.rollbackSafe(t, ports, err);
    }
    try {
      await this.saveJournal(t, { state: 'committed' }, () => this.gate(t, 'swapped'));
    } catch (err) {
      if (isCrash(err)) throw err;
      if (err instanceof UserError && err.code === 'restore-fsync-unconfirmed') return this.unconfirmedCommit(t, ports, err);
      return this.rollbackSafe(t, ports, err);
    }
    await this.afterCommitStep('committed');
    return this.finishCommitted(t, ports);
  }

  /** 提交之后的测试钩子：模拟崩溃照常向上传递；其他异常不能把已提交的结果变成失败 */
  private async afterCommitStep(name: 'committed' | 'cleanup'): Promise<void> {
    try {
      await this.step(name);
    } catch (err) {
      if (isCrash(err)) throw err;
    }
  }

  /** 当前 WTF 的身份：不存在为 null；链接、非目录或跨卷拒绝 */
  private async currentWtf(wtf: string, dev: bigint): Promise<string | null> {
    let st;
    try {
      st = await lstat(wtf, { bigint: true });
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError('游戏目录中的 WTF 是符号链接或不是文件夹，不能恢复', 'restore-unsafe');
    if (st.dev !== dev) throw new UserError('WTF 与游戏目录不在同一磁盘卷，不能恢复', 'restore-unsafe');
    return idOf(st);
  }

  /** 工作目录：不存在时新建（0700）并写标记；已存在时必须是带标记（或为空）的同卷真实目录 */
  private async ensureControl(t: Tx, dev: bigint): Promise<string> {
    const { P } = t;
    let st = await lstat(P.control, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)));
    if (!st) {
      await mkdir(P.control, { mode: 0o700 });
      st = await lstat(P.control, { bigint: true });
      if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError('恢复工作目录被替换，已停止', 'restore-unsafe');
      await syncDirStrict(t.root, '恢复工作目录');
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(`${P.control} 不是普通文件夹，不能使用`, 'restore-unsafe');
    if (st.dev !== dev) throw new UserError(`${P.control} 与游戏目录不在同一磁盘卷，不能使用`, 'restore-unsafe');
    const marker = await readJson(P.marker, 4096, '恢复工作目录标记').catch(() => undefined);
    if (marker === undefined) throw new UserError(`${P.control} 的标记无法识别，艾泽魔方不会使用它`, 'restore-unsafe');
    if (marker === null) {
      const names = await listNames(P.control, MAX_CONTROL_NAMES);
      if (names && names.length > 0) throw new UserError(`${P.control} 中有不认识的内容，艾泽魔方不会使用它`, 'restore-unsafe');
      await writeDurable(P.marker, Buffer.from(JSON.stringify({ format: RESTORE_FORMAT, kind: 'control', schema: 1 })), '恢复工作目录标记');
    } else {
      const v = marker.value as Record<string, unknown> | null;
      if (!v || v.format !== RESTORE_FORMAT || v.kind !== 'control' || v.schema !== 1) throw new UserError(`${P.control} 的标记无法识别，艾泽魔方不会使用它`, 'restore-unsafe');
    }
    return idOf(st);
  }

  private async prepare(t: Tx, input: RestoreApplyInput, ports: RestoreApplyPorts, dev: bigint): Promise<void> {
    const { P } = t;
    const signal = input.signal;
    t.controlId = await this.ensureControl(t, dev);
    const names = (await listNames(P.control, MAX_CONTROL_NAMES)) ?? [];
    if (names.some((n) => n.startsWith(TX_PREFIX))) throw new UserError(`${P.control} 中留有其他恢复的内容，请先处理未完成的恢复`, 'restore-pending');
    // 目标占用：已存在的标记（含持有进程已退出的未登记标记）一律保留，不猜测归属
    t.lock = await createTargetLock(P.lock, t.txid, t.nonce);
    this.ownLocks.set(t.root, t.lock);
    const lock = t.lock;
    await this.reg((d) => d.update(t.txid, { controlId: t.controlId, lock: { id: lock.id, owner: lock.owner, pid: lock.pid, createdAt: lock.createdAt } }));
    await mkdir(P.tx, { mode: 0o700 });
    const txSt = await lstat(P.tx, { bigint: true });
    if (txSt.isSymbolicLink() || !txSt.isDirectory() || txSt.dev !== dev) throw new UserError('恢复事务目录被替换，已停止', 'restore-unsafe');
    await syncDirStrict(P.control, '恢复事务目录');
    const txdirId = idOf(txSt);
    await this.reg((d) => d.update(t.txid, { txdirId }));
    t.txdirId = txdirId;
    const txChain = this.txChainOf(t) as string[];
    await this.saveJournal(t, {});
    await this.step('preparing');
    throwIfAborted(signal);

    // 备份位置占用与恢复前备份（调用方）
    const baseline: RestoreBaseline = t.journal.before ? 'present' : 'absent';
    const recordHold = async (hold: string) => {
      if (typeof hold !== 'string' || hold.length === 0 || hold.length > MAX_SOURCE_HOLD) throw new UserError('备份位置占用证明不合法', 'restore-unsafe');
      // 记录过证明之后，无论取得来源成败都要释放
      t.sourcesHeld = true;
      await this.saveJournal(t, { sourceHold: hold });
    };
    const got = await ports.acquireSources({ txid: t.txid, nonce: t.nonce, baseline, safetySnapshotId: t.journal.safetySnapshotId, signal, recordHold });
    t.sourcesHeld = true;
    t.safetyMade = got.safety !== null;
    const hold = got.hold ?? null;
    if (hold !== null) await recordHold(hold);
    if ((got.safety === null) !== (baseline === 'absent')) throw new UserError('恢复前备份与当前 WTF 的状态不符', 'restore-unsafe');
    await this.step('sources-ready');

    // 来源完整校验（固定每个文件的身份）
    t.snapshot = await this.verifySource(got.snapshot, signal);
    if (got.safety) t.safety = { src: got.safety, tree: await this.verifySource(got.safety, signal) };

    // 当前 WTF：集合、身份与全部校验值都必须等于恢复前备份
    if (t.safety) {
      t.live = await verifyTree(P.wtf, t.safety.src.entries, this.wtfOpts(signal, 'WTF'), 'exact', '当前 WTF', { parentChain: t.rootChain, baseId: t.journal.before });
    } else if ((await idOrNull(P.wtf)) !== null) {
      throw changed('准备期间出现了 WTF');
    }

    // 计划与资源上限
    const plan = planRestore(scopeOf(input), got.snapshot.entries, t.safety ? t.safety.src.entries : null);
    const L = this.limits;
    if (plan.candidate.files + plan.candidate.dirs > L.maxEntries) throw new UserError(`恢复后的 WTF 超出文件与目录数量上限（${L.maxEntries}）`, 'restore-limit');
    if (plan.candidate.bytes > L.maxSnapshotBytes) throw new UserError('恢复后的 WTF 超出单份大小上限', 'restore-limit');
    if (plan.entries.some((e) => e.type === 'file' && (e.size ?? 0) > L.maxFileBytes)) throw new UserError('恢复后的 WTF 中有文件超出单个文件上限', 'restore-limit');
    await ports.checkCapacity(plan);
    const list = serializeCandidate(t.txid, plan.entries);
    if (list.byteLength > L.maxManifestBytes) throw new UserError('候选清单超出大小上限', 'restore-limit');

    // 候选清单与候选根目录：创建后立即在登记与 journal 中持久证明，之后中断也能按证明识别
    await this.assertHeld(t);
    const listId = await writeDurable(P.list, list, '候选清单', { beforeRename: () => this.assertHeld(t) });
    t.listProof = { id: listId, sha: sha256(list) };
    const tracker = new PartialTracker(P.candidate, P.tx, txChain);
    await tracker.mkdir('');
    await syncDirStrict(P.tx, '候选目录');
    const rootId = await idOrNull(P.candidate);
    if (!rootId) throw changed('候选根目录被移动');
    const proof: RestoreCandidateProof = { listId, listSha: sha256(list), rootId };
    await this.reg((d) => d.update(t.txid, { candidate: proof }));
    await this.saveJournal(t, { candidate: proof });
    t.candidateEntries = plan.entries;

    // 候选树：只复制清单条目，来源身份固定，边写边校验；失败时只删除本次未写完、仍与句柄一致的那一个文件
    const pinned = (tree: VerifiedTree) => new Map(tree.walk.map((w) => [w.rel, w]));
    const fromSnapshot = pinned(t.snapshot);
    const fromSafety = t.safety ? pinned(t.safety.tree) : new Map<string, WalkEntry>();
    const files = plan.entries.filter((e) => e.type === 'file').length;
    let done = 0;
    for (const e of plan.entries) {
      throwIfAborted(signal);
      if (e.type === 'dir') {
        await tracker.mkdir(e.path);
        continue;
      }
      const src = e.origin === 'snapshot' ? got.snapshot : t.safety?.src;
      const w = (e.origin === 'snapshot' ? fromSnapshot : fromSafety).get(e.path);
      if (!src || !w || w.kind !== 'file') throw changed(`来源中缺少「${e.path}」`);
      await this.step('staging-file', e.path);
      await copyVerifiedFile(path.join(src.wtfDir, ...e.path.split('/')), e.path, w.st, e.size ?? 0, e.sha256 ?? '', tracker, e.path, signal);
      input.onProgress?.(++done, files);
    }
    for (const e of [...plan.entries].reverse()) if (e.type === 'dir') await syncDirStrict(path.join(P.candidate, ...e.path.split('/')), '候选目录');
    await syncDirStrict(P.candidate, '候选目录');
    t.candidate = await verifyTree(P.candidate, plan.entries, this.wtfOpts(signal, '候选 WTF'), 'exact', '候选 WTF', { parentChain: txChain, baseId: rootId });
    await this.step('staged');

    // 提交前复核：目标、工作目录、占用、来源、当前 WTF（重新遍历并重算全部校验值）与候选树
    await this.precheck(t, got, signal);
    throwIfAborted(signal);
  }

  private async verifySource(src: RestoreTreeSource, signal: AbortSignal | undefined): Promise<VerifiedTree> {
    await src.recheck();
    return verifyTree(src.wtfDir, src.entries, this.srcOpts(signal), 'finder', `备份 ${src.snapshotId}`, { parentChain: src.parentChain, baseId: src.wtfId });
  }

  private async precheck(t: Tx, got: { snapshot: RestoreTreeSource; safety: RestoreTreeSource | null }, signal: AbortSignal | undefined): Promise<void> {
    await this.assertHeld(t);
    for (const [src, tree] of [[got.snapshot, t.snapshot], [got.safety, t.safety?.tree ?? null]] as const) {
      if (!src || !tree) continue;
      await src.recheck();
      const again = await walkTree(src.wtfDir, this.srcOpts(signal));
      if (walkDiff(tree.walk, again) || (await idOrNull(src.wtfDir)) !== tree.baseId) throw changed(`备份 ${src.snapshotId} 在准备期间被改动`);
    }
    if (t.safety && t.live) {
      const again = await verifyTree(t.P.wtf, t.safety.src.entries, this.wtfOpts(signal, 'WTF'), 'exact', '当前 WTF', { parentChain: t.rootChain, baseId: t.journal.before });
      if (walkDiff(t.live.walk, again.walk)) throw changed('准备期间当前 WTF 被改动（请确认游戏已退出）');
    }
    await this.gate(t, 'before-move');
  }

  /**
   * 闸门：占用与各级目录身份未变；按阶段核对各棵树相对固定遍历的集合与每一项身份 / 大小 / 时间（walkDiff，含状态改变时间）。
   * before-move：WTF 是恢复前的样子（或仍不存在），候选树未变，原件位置为空；old-moved：WTF 不存在，原件与候选树未变；
   * swapped：WTF 是未变的候选树，原件未变，候选位置为空。不一致抛出 restore-changed
   */
  private async gate(t: Tx, phase: 'before-move' | 'old-moved' | 'swapped'): Promise<void> {
    await this.assertHeld(t);
    const { P } = t;
    const cand = t.candidate;
    const rootId = t.journal.candidate?.rootId;
    if (!cand || !rootId) throw changed('候选树缺失');
    const same = async (p: string, id: string, tree: VerifiedTree, what: string) => {
      if ((await idOrNull(p)) !== id) throw changed(`${what}被移动或替换`);
      const now = await walkTree(p, this.wtfOpts(undefined, what));
      const d = walkDiff(tree.walk, now);
      if (d) throw changed(`${what}中的「${d}」被改动`);
    };
    const absent = async (p: string, what: string) => {
      if ((await idOrNull(p)) !== null) throw changed(`${what}位置出现了其他内容`);
    };
    const before = t.journal.before;
    if (phase === 'before-move') {
      if (before && t.live) await same(P.wtf, before, t.live, '当前 WTF');
      else await absent(P.wtf, 'WTF ');
      await same(P.candidate, rootId, cand, '候选树');
      await absent(P.old, '原件');
    } else if (phase === 'old-moved') {
      await absent(P.wtf, 'WTF ');
      if (before && t.live) await same(P.old, before, t.live, '恢复前的原件');
      await same(P.candidate, rootId, cand, '候选树');
    } else {
      await same(P.wtf, rootId, cand, '恢复后的 WTF');
      if (before && t.live) await same(P.old, before, t.live, '恢复前的原件');
      await absent(P.candidate, '候选');
    }
  }

  /** 两次 rename，每次之后严格同步并经过闸门；任何异常由调用方按内容核对回滚。不响应取消 */
  private async swap(t: Tx): Promise<void> {
    const { P } = t;
    if (t.journal.before) {
      await rename(P.wtf, P.old);
      await syncDirStrict(t.root, '游戏目录');
      await syncDirStrict(P.tx, '恢复事务目录');
      await this.step('old-moved');
      await this.gate(t, 'old-moved');
    } else if ((await idOrNull(P.wtf)) !== null) {
      throw changed('替换前出现了新的 WTF');
    }
    await rename(P.candidate, P.wtf);
    await syncDirStrict(t.root, '游戏目录');
    await syncDirStrict(P.tx, '恢复事务目录');
    await this.step('new-moved');
    await this.gate(t, 'swapped');
    await this.step('before-commit');
    // committed 写入的 rename 之前还有一次闸门（saveJournal 的 extra）
  }

  /**
   * 提交之前在本进程内回滚。先判定当前位置并按完整内容（集合、身份 / 时间、全部校验值）核对所有要移动的对象：
   * 当前 WTF（若是候选树）、原件（若已移出）、目标位置为空、占用与各级目录身份；全部通过之后才开始第一次 rename，
   * 两次 rename 之间再次复核。任何核对失败都不移动任何东西（当前 WTF 保持原位），不删除任何东西，登记 blocked 并保留现场
   */
  private async rollbackSafe(t: Tx, ports: RestoreApplyPorts, cause: unknown): Promise<RestoreApplyResult> {
    const { P } = t;
    const why = errorMessage(cause);
    const rootId = t.journal.candidate?.rootId ?? null;
    const txChain = this.txChainOf(t);
    const before = t.journal.before;
    let ok = false;
    let detail = '';
    try {
      if (!rootId || !txChain || !t.candidateEntries || !t.candidate) throw new Error('候选树的证明缺失');
      const cand = t.candidate;
      const entries = t.candidateEntries;
      const W = await idOrNull(P.wtf);
      const O = await idOrNull(P.old);
      const C = await idOrNull(P.candidate);
      const liveIsCandidate = W === rootId;
      const oldMoved = !!before && O === before;
      // 1. 判定：只接受三种已知位置组合
      const atStart = (before ? W === before : W === null) && O === null && C === rootId;
      const oldOnly = !!before && W === null && oldMoved && C === rootId;
      const both = liveIsCandidate && C === null && (before ? oldMoved : O === null);
      if (!atStart && !oldOnly && !both) throw new Error('当前 WTF、原件与候选树的位置不符合任何可回滚的状态');
      // 2. 移动之前核对全部要移动的对象
      const checkLive = async () => {
        const now = await verifyTree(P.wtf, entries, this.wtfOpts(undefined, 'WTF'), 'exact', '恢复后的 WTF', { parentChain: t.rootChain, baseId: rootId });
        if (walkDiff(cand.walk, now.walk)) throw new Error('恢复后的 WTF 已被改动');
      };
      const checkOld = async () => {
        if (!before || !t.safety || !t.live) throw new Error('无法核对恢复前的原件');
        const old = await verifyTree(P.old, t.safety.src.entries, this.wtfOpts(undefined, '原件'), 'exact', '恢复前的原件', { parentChain: txChain, baseId: before });
        if (walkDiff(t.live.walk, old.walk)) throw new Error('恢复前的原件已被改动');
      };
      if (both) await checkLive();
      if (oldMoved) await checkOld();
      await this.assertHeld(t);
      // 3. 移动：每次移动前复核位置与占用，两次移动之间再核对原件
      if (both) {
        if ((await idOrNull(P.candidate)) !== null || (await idOrNull(P.wtf)) !== rootId) throw new Error('位置在核对之后发生变化');
        await rename(P.wtf, P.candidate);
        await syncDirStrict(t.root, '游戏目录');
        await syncDirStrict(P.tx, '恢复事务目录');
      }
      if (oldMoved) {
        await this.assertHeld(t);
        await checkOld();
        if ((await idOrNull(P.wtf)) !== null) throw new Error('WTF 位置出现了其他内容');
        await rename(P.old, P.wtf);
        await syncDirStrict(t.root, '游戏目录');
        await syncDirStrict(P.tx, '恢复事务目录');
      }
      const w = await idOrNull(P.wtf);
      ok = (before ? w === before && (await idOrNull(P.old)) === null : w === null) && (await idOrNull(P.candidate)) === rootId;
    } catch (err) {
      if (isCrash(err)) throw err;
      detail = errorMessage(err);
    }
    if (!ok) {
      const reason = `替换中止（${why}）${detail ? `，${detail}` : ''}。为保护可能的外部改动，没有继续移动或删除任何内容；当前 WTF、原件与候选树都保留（${P.tx}）`;
      return { ...(await this.block(t, ports, reason)), outcome: 'blocked' };
    }
    const warnings: string[] = [];
    try {
      await this.saveJournal(t, { state: 'rolled-back' });
    } catch (err) {
      if (isCrash(err)) throw err;
      warnings.push(`回滚记录未能写入：${errorMessage(err)}`);
    }
    const c = await this.abandon(t, ports, 'rolled-back');
    warnings.push(...c.pending, ...c.warnings);
    return {
      txid: t.txid, outcome: 'rolled-back', safetySnapshotId: t.journal.safetySnapshotId, cleanupPending: c.pending.length > 0,
      message: `恢复未完成（${why}），WTF 已回滚到恢复前的状态`, warnings,
    };
  }

  /** committed 已写入但未能确认落盘：不报告成功，保留全部内容与占用，登记为 blocked */
  private async unconfirmedCommit(t: Tx, ports: RestoreApplyPorts, cause: unknown): Promise<RestoreApplyResult> {
    const reason = `WTF 已替换为恢复后的内容，但提交记录未能确认写入磁盘（${errorMessage(cause)}）。请在确认游戏已退出后处理未完成的恢复`;
    return { ...(await this.block(t, ports, reason)), outcome: 'unconfirmed' };
  }

  private async block(t: Tx, ports: RestoreApplyPorts, reason: string): Promise<RestoreApplyResult> {
    const warnings: string[] = [];
    try {
      await this.reg((d) => d.update(t.txid, { state: 'blocked', reason }));
    } catch (err) {
      warnings.push(`登记未能更新：${errorMessage(err)}`);
    }
    if (t.sourcesHeld) {
      t.sourcesHeld = false;
      const n = await ports.releaseSources().catch((err: unknown) => errorMessage(err));
      if (n) warnings.push(n);
      else if (t.journal.sourceHold) await this.saveJournal(t, { sourceHold: null }).catch(() => undefined);
    }
    // 目标占用保留（本实例记录精确所有权，之后处理未完成恢复时继续使用）
    return { txid: t.txid, outcome: 'blocked', safetySnapshotId: t.journal.safetySnapshotId, cleanupPending: true, message: reason, warnings };
  }

  /**
   * 没有移动 WTF（或已按内容核对回滚到原状态）时撤回本次内容：候选树只按持久证明与清单逐项核对后删除；
   * 释放备份位置占用；之后按 settle 收尾。返回未完成的清理与提示
   */
  private async abandon(t: Tx, ports: RestoreApplyPorts, outcome: 'not-applied' | 'rolled-back' = 'not-applied'): Promise<Closed> {
    const pending: string[] = [];
    const warnings: string[] = [];
    if (t.journal.candidate && t.candidateEntries) {
      const left = await this.discardCandidate(t, t.journal.state === 'preparing' ? 'subset' : 'exact');
      if (left) pending.push(left);
    } else if (t.txdirId && (await idOrNull(t.P.candidate).catch(() => 'unknown')) !== null) {
      pending.push(`候选目录没有持久的证明，无法确认属于本次，已保留：${t.P.candidate}`);
    }
    if (t.sourcesHeld) {
      t.sourcesHeld = false;
      const n = await ports.releaseSources().catch((err: unknown) => errorMessage(err));
      if (n) pending.push(n);
      else if (t.journal.sourceHold && t.journalProof) await this.saveJournal(t, { sourceHold: null }).catch((err: unknown) => void pending.push(`占用释放记录未能写入：${errorMessage(err)}`));
    }
    if (t.safetyMade) warnings.push(`恢复前的完整备份 ${t.journal.safetySnapshotId ?? ''} 已保留在备份位置`);
    if (pending.length > 0) return { pending: await this.markPending(t, pending), warnings };
    const c = await this.settle(t, outcome);
    return { pending: c.pending, warnings: [...warnings, ...c.warnings] };
  }

  private async markPending(t: Tx, pending: string[]): Promise<string[]> {
    try {
      await this.reg((d) => d.update(t.txid, { state: 'cleanup-pending', reason: pending.join('；').slice(0, 2000) }));
    } catch (err) {
      pending.push(`恢复登记未能更新：${errorMessage(err)}`);
    }
    return pending;
  }

  /**
   * 结果已确定之后的收尾（apply 与 resolve 共用）：先在登记中持久写入 outcome；删除身份与校验值都已知的候选清单与 journal、
   * 事务目录（其中有其他内容时保留）；严格同步工作目录；释放目标占用，删除确认写入磁盘后才从登记中移除这一项并写收据。
   * 任何一步未完成都保留登记（cleanup-pending），下次处理时从这里继续
   */
  private async settle(t: Tx, outcome: RestoreSettled): Promise<Closed> {
    const { P } = t;
    const pending: string[] = [];
    const warnings: string[] = [];
    try {
      await this.reg((d) => d.update(t.txid, { outcome }));
    } catch (err) {
      return { pending: [`结果未能写入登记：${errorMessage(err)}`], warnings };
    }
    const txChain = this.txChainOf(t);
    if (txChain && t.txdirId && (await idOrNull(P.tx)) !== null) {
      if ((await idOrNull(P.tx)) !== t.txdirId) pending.push(`恢复事务目录 ${P.tx} 被替换，已保留`);
      else {
        const proof = t.journal.candidate;
        const l1 = await this.removeKnownFile(P.list, proof ? { id: proof.listId, sha: proof.listSha } : t.listProof, txChain);
        const l2 = l1 ? null : await this.removeKnownFile(P.journal, t.journalProof, txChain);
        if (l1 || l2) pending.push((l1 ?? l2) as string);
        else {
          try {
            await rmdir(P.tx);
          } catch (err) {
            if (errCode(err) !== 'ENOENT') pending.push(`恢复事务目录 ${P.tx} 中有其他内容，已保留`);
          }
        }
      }
    }
    if (pending.length === 0 && t.controlId && (await idOrNull(P.control)) !== null) {
      try {
        await syncDirStrict(P.control, '恢复工作目录');
      } catch (err) {
        pending.push(`本次恢复的工作文件已删除，但删除结果未能确认写入磁盘（${errorMessage(err)}）`);
      }
    }
    if (pending.length === 0 && t.lock) {
      const r = await releaseTargetLock(t.lock);
      if (r.status === 'released') {
        this.ownLocks.delete(t.root);
        t.lock = null;
        try {
          await this.reg((d) => d.update(t.txid, { lock: null }));
        } catch (err) {
          pending.push(`占用标记已释放，但登记未能更新：${errorMessage(err)}`);
        }
      } else {
        // unsynced：标记已删除但未确认；登记保留它的证明，下次处理时严格同步后再结束
        if (r.status === 'unsynced') {
          this.ownLocks.delete(t.root);
          t.lock = null;
        }
        pending.push(r.note ?? '恢复占用标记未能释放');
      }
    }
    if (pending.length === 0) {
      try {
        await this.reg((d) => d.finish(t.txid, outcome));
        return { pending, warnings };
      } catch (err) {
        pending.push(`恢复登记未能更新：${errorMessage(err)}`);
      }
    }
    return { pending: await this.markPending(t, pending), warnings };
  }

  /**
   * 删除候选树：必须有持久的候选根身份与候选清单，候选根就是那个目录。exact：完整核对通过后才持久标记 discardCandidate，再删除；
   * subset（准备阶段从未放入 WTF，或已带标记的继续删除）：剩余部分必须是清单的子集且每个文件校验值一致。
   * 不能确认的内容保留。返回 null 表示候选树已不存在
   */
  private async discardCandidate(t: Tx, mode: 'exact' | 'subset'): Promise<string | null> {
    const { P } = t;
    const proof = t.journal.candidate;
    const txChain = this.txChainOf(t);
    try {
      const id = await idOrNull(P.candidate);
      if (id === null) return null;
      if (!proof || !txChain || !t.candidateEntries) return `候选树没有可核对的证明，已保留：${P.candidate}`;
      if (id !== proof.rootId) return `候选位置的目录不是本次创建的，已保留：${P.candidate}`;
      let tree: VerifiedTree;
      if (mode === 'subset' || t.journal.discardCandidate) {
        tree = await verifyTree(P.candidate, t.candidateEntries, this.wtfOpts(undefined, '候选 WTF'), 'subset', '候选 WTF', { parentChain: txChain, baseId: proof.rootId });
      } else {
        tree = await verifyTree(P.candidate, t.candidateEntries, this.wtfOpts(undefined, '候选 WTF'), 'exact', '候选 WTF', { parentChain: txChain, baseId: proof.rootId });
        await this.saveJournal(t, { discardCandidate: true });
      }
      const r = await removeVerifiedTree(tree);
      if (r.kept) return `${r.kept}（候选树：${P.candidate}）`;
      if (r.unsynced) return r.unsynced;
      return null;
    } catch (err) {
      if (isCrash(err)) throw err;
      return `候选树中有无法确认的内容（${errorMessage(err)}），已保留于 ${P.candidate}`;
    }
  }

  /**
   * 删除已提交恢复的原件：完整校验恢复前备份（来源复核 + 全部校验值），原件身份等于 journal.before；
   * 没有 discardOld 标记时原件必须与恢复前备份 exact 一致（live 给出时还要求每一项身份与恢复前固定的一致），通过后才持久标记，再删除；
   * 已带标记时只要求剩余部分是子集。原件已不存在时：带标记则严格同步事务目录后视为完成，否则保留为待处理。返回 null 表示完成
   */
  private async discardOld(t: Tx, safety: RestoreTreeSource | null): Promise<string | null> {
    const { P } = t;
    const before = t.journal.before;
    const txChain = this.txChainOf(t);
    try {
      if (!before || !txChain) return null;
      const oldId = await idOrNull(P.old);
      if (oldId === null) {
        if (!t.journal.discardOld) return `恢复前的原件不在工作目录中（${P.old}），无法确认它的去向，保留为待处理`;
        await syncDirStrict(P.tx, '原件的删除');
        return null;
      }
      if (oldId !== before) return `恢复前的原件位置被替换，已保留：${P.old}`;
      if (!safety) return `无法打开恢复前备份以确认原件，原件保留于 ${P.old}`;
      await this.verifySource(safety, undefined);
      let tree: VerifiedTree;
      if (t.journal.discardOld) {
        tree = await verifyTree(P.old, safety.entries, this.wtfOpts(undefined, '原件'), 'subset', '恢复前的原件', { parentChain: txChain, baseId: before });
      } else {
        tree = await verifyTree(P.old, safety.entries, this.wtfOpts(undefined, '原件'), 'exact', '恢复前的原件', { parentChain: txChain, baseId: before });
        if (t.live && walkDiff(t.live.walk, tree.walk)) return `恢复前的原件在恢复期间被改动，已保留：${P.old}`;
        await this.saveJournal(t, { discardOld: true });
      }
      const r = await removeVerifiedTree(tree);
      if (r.kept) return `${r.kept}（恢复前的原件：${P.old}）`;
      if (r.unsynced) return r.unsynced;
      return null;
    } catch (err) {
      if (isCrash(err)) throw err;
      return `${errorMessage(err)}；恢复前的原件保留于 ${P.old}`;
    }
  }

  /** committed 已持久化：只收尾，不回滚 */
  private async finishCommitted(t: Tx, ports: RestoreApplyPorts): Promise<RestoreApplyResult> {
    const warnings: string[] = [];
    try {
      await this.reg((d) => d.update(t.txid, { state: 'committed' }));
    } catch (err) {
      warnings.push(`恢复已完成，但登记未能更新：${errorMessage(err)}`);
    }
    await this.afterCommitStep('cleanup');
    const pending: string[] = [];
    const left = await this.discardOld(t, t.safety?.src ?? null);
    if (left) pending.push(left);
    if (t.sourcesHeld) {
      t.sourcesHeld = false;
      const n = await ports.releaseSources().catch((err: unknown) => errorMessage(err));
      if (n) pending.push(n);
      else if (t.journal.sourceHold) await this.saveJournal(t, { sourceHold: null }).catch((err: unknown) => void pending.push(`占用释放记录未能写入：${errorMessage(err)}`));
    }
    let closed: Closed;
    if (pending.length > 0) closed = { pending: await this.markPending(t, pending), warnings: [] };
    else closed = await this.settle(t, 'committed');
    warnings.push(...closed.pending, ...closed.warnings);
    const unfinished = closed.pending.length > 0;
    return {
      txid: t.txid, outcome: 'committed', safetySnapshotId: t.journal.safetySnapshotId, cleanupPending: unfinished,
      message: unfinished ? '已恢复。部分收尾未完成，可稍后在“处理未完成恢复”中继续' : '已恢复',
      warnings,
    };
  }

  // ---------- 处理未完成的恢复 ----------

  /**
   * 处理一项未完成的恢复（需要新的“游戏已退出”确认）。flavorId / root 必须与登记一致，root 的身份链必须与登记时相同；
   * 调用方负责确认 root 仍是该游戏版本的当前绑定。已持久的 committed 只收尾；其他状态只按实际的树身份与完整校验值回滚或清理；
   * 外部改动与无法证明的内容一律保留
   */
  async resolve(input: { flavorId: number; root: string; txid: string; ack: unknown }, ports: RestoreResolvePorts): Promise<RestoreResolveResult> {
    if (!isAck(input.ack, ['gameClosed'])) throw new UserError('需要确认已退出游戏', 'restore-ack');
    if (typeof input.txid !== 'string' || !TXID_RE.test(input.txid)) throw new UserError('恢复编号无效', 'restore-unknown');
    return this.wrap(input.root, () => this.doResolve(input, ports));
  }

  private async doResolve(input: { flavorId: number; root: string; txid: string }, ports: RestoreResolvePorts): Promise<RestoreResolveResult> {
    const data = await this.registry.load();
    const entry = data.entries.find((e) => e.txid === input.txid);
    if (!entry) throw new UserError('找不到这项未完成的恢复，可能已处理', 'restore-unknown');
    if (entry.flavorId !== input.flavorId || entry.root !== input.root) throw new UserError('这项恢复属于其他游戏版本或目录', 'target');
    const root = entry.root;
    if ((await realpath(root).catch(() => null)) !== root) throw changed('游戏目录不存在或路径已变化');
    const chain = await chainIds(root).catch(() => null);
    if (!chain || !sameChain(chain, entry.rootChain)) throw changed('游戏目录或其上级目录与恢复时不同（可能被移动或替换）');
    const t: Tx = {
      txid: entry.txid, nonce: entry.nonce, flavorId: entry.flavorId, root, rootChain: entry.rootChain, P: txPaths(root, entry.txid),
      journal: {
        txid: entry.txid, nonce: entry.nonce, flavorId: entry.flavorId, root, state: 'preparing', before: null, candidate: entry.candidate,
        sourceSnapshotId: entry.sourceSnapshotId, safetySnapshotId: entry.safetySnapshotId, containerPath: entry.containerPath, sourceHold: null,
        discardOld: false, discardCandidate: false, createdAt: entry.createdAt,
      },
      journalProof: null, controlId: entry.controlId, txdirId: entry.txdirId, lock: null, candidateEntries: null, listProof: null, sourcesHeld: false, safetyMade: false,
      snapshot: null, safety: null, live: null, candidate: null,
    };
    t.lock = await this.claimLock(entry, t);
    await this.step('resolve-locked');
    try {
      return await this.dispatch(entry, t, ports);
    } catch (err) {
      if (isCrash(err)) throw err;
      return this.pendingResult(t, 'blocked', `处理时出错：${errorMessage(err)}`);
    }
  }

  /**
   * 取得目标占用。工作目录不存在时不需要（返回 null）。
   * - 标记不存在：登记中仍有标记证明（上次删除未确认写入磁盘）时，先严格同步工作目录、清除证明；然后新建标记并登记证明。
   * - 标记存在：必须与登记的证明完全一致（文件身份、owner、pid、createdAt，以及 txid / nonce），所在目录链也一致；
   *   本实例精确持有时直接使用；不是本进程、且持有进程确认已退出（ESRCH）时，重新读取核对后删除再新建。其他情况一律保留并拒绝
   */
  private async claimLock(entry: RestoreRegEntry, t: Tx): Promise<HeldTargetLock | null> {
    const { P } = t;
    const ctl = await idOrNull(P.control);
    if (ctl === null) return null;
    if (!entry.controlId) {
      // 工作目录在登记它的身份之前中断：只接受带艾泽魔方标记、直接位于这个游戏目录下的真实目录
      const st = await lstat(P.control, { bigint: true });
      const pc = await chainIds(t.root).catch(() => null);
      const marker = await readJson(P.marker, 4096, '恢复工作目录标记').catch(() => null);
      const v = marker?.value as Record<string, unknown> | undefined;
      if (st.isSymbolicLink() || !st.isDirectory() || !pc || !sameChain(pc, entry.rootChain) || !v || v.format !== RESTORE_FORMAT || v.kind !== 'control') {
        throw new UserError(`恢复工作目录无法确认，已保留：${P.control}`, 'restore-lock');
      }
      await this.reg((d) => d.update(entry.txid, { controlId: ctl }));
      t.controlId = ctl;
    } else if (ctl !== entry.controlId) {
      throw new UserError(`恢复工作目录无法确认属于这项恢复，已保留：${P.control}`, 'restore-lock');
    }
    const controlChain = [ctl, ...entry.rootChain];
    const chainOk = async () => {
      const c = await chainIds(P.control).catch(() => null);
      return !!c && sameChain(c, controlChain);
    };
    if (!(await chainOk())) throw new UserError(`恢复工作目录被移动或替换：${P.control}`, 'restore-lock');
    const busy = (why: string) => new UserError(`无法取得恢复占用：${why}（${P.lock}）`, 'restore-lock');
    const proof = entry.lock;
    const matches = (cur: Awaited<ReturnType<typeof readTargetLock>>) =>
      !!cur && !!proof && idOf(cur.st) === proof.id && !!cur.info && cur.info.txid === entry.txid && cur.info.nonce === entry.nonce &&
      cur.info.owner === proof.owner && cur.info.pid === proof.pid && cur.info.createdAt === proof.createdAt;
    let cur = await readTargetLock(P.lock);
    if (cur) {
      const own = this.ownLocks.get(entry.root);
      if (own && matches(cur) && idOf(cur.st) === own.id && sameLockInfo(cur.info, own)) {
        await assertTargetLock(own);
        return own;
      }
      if (!matches(cur)) throw busy('标记无法证明属于这项恢复，已保留');
      const info = cur.info;
      if (!info || info.pid === process.pid) throw busy('标记由本进程中的其他任务持有或无法确认');
      if (this.probe(info.pid) !== 'gone') throw busy('原来的持有进程仍在运行，或无法确认它已退出');
      const again = await readTargetLock(P.lock);
      if (!matches(again) || !(await chainOk()) || this.probe(info.pid) !== 'gone') throw busy('标记在核对期间发生变化，已保留');
      if (!(await unlinkIfSame(P.lock, (proof as { id: string }).id))) throw busy('旧标记无法删除');
      cur = null;
    }
    if (proof) {
      // 标记已不存在（或刚删除）：确认删除写入磁盘后清除证明
      await syncDirStrict(P.control, '旧的恢复占用标记的删除');
      await this.reg((d) => d.update(entry.txid, { lock: null }));
    }
    const lock = await createTargetLock(P.lock, entry.txid, entry.nonce);
    this.ownLocks.set(entry.root, lock);
    await this.reg((d) => d.update(entry.txid, { lock: { id: lock.id, owner: lock.owner, pid: lock.pid, createdAt: lock.createdAt } }));
    return lock;
  }

  private async pendingResult(t: Tx, outcome: 'blocked' | 'cleanup-pending', reason: string): Promise<RestoreResolveResult> {
    const warnings: string[] = [];
    try {
      await this.reg((d) => d.update(t.txid, { state: outcome, reason }));
    } catch (err) {
      warnings.push(`登记未能更新：${errorMessage(err)}`);
    }
    return { txid: t.txid, outcome, message: reason, warnings };
  }

  private async settleResult(t: Tx, outcome: RestoreSettled, done: RestoreResolveResult['outcome'], message: string, extra: string[] = []): Promise<RestoreResolveResult> {
    const c = await this.settle(t, outcome);
    if (c.pending.length > 0) return { txid: t.txid, outcome: 'cleanup-pending', message: `${message}；${c.pending.join('；')}`, warnings: [...extra, ...c.warnings] };
    return { txid: t.txid, outcome: done, message, warnings: [...extra, ...c.warnings] };
  }

  /** 遗留的备份位置占用：交给调用方按证明释放；成功后在 journal 中清除证明。返回未完成说明 */
  private async releaseHold(t: Tx, ports: RestoreResolvePorts): Promise<string | null> {
    const hold = t.journal.sourceHold;
    if (!hold) return null;
    if (!ports.releaseHold) return '恢复时取得的备份位置占用还没有可用的处理方式，保留为待处理';
    const n = await ports.releaseHold({ txid: t.txid, nonce: t.nonce, containerPath: t.journal.containerPath, hold }).catch((err: unknown) => errorMessage(err));
    if (n) return n;
    await this.saveJournal(t, { sourceHold: null });
    return null;
  }

  private async dispatch(entry: RestoreRegEntry, t: Tx, ports: RestoreResolvePorts): Promise<RestoreResolveResult> {
    const { P } = t;
    const txChain = this.txChainOf(t);
    const txId = await idOrNull(P.tx);

    // 读取并固定 journal（若有）
    let j: RestoreJournal | null = null;
    if (txId !== null) {
      if (!txChain || txId !== entry.txdirId) return this.pendingResult(t, 'blocked', `恢复事务目录无法确认属于这项恢复，已保留：${P.tx}`);
      const tc = await chainIds(P.tx).catch(() => null);
      if (!tc || !sameChain(tc, txChain)) return this.pendingResult(t, 'blocked', `恢复事务目录被移动或替换：${P.tx}`);
      let jr;
      try {
        jr = await readMeta(P.journal, MAX_JOURNAL_BYTES, '恢复日志');
      } catch (err) {
        return this.pendingResult(t, 'blocked', `恢复日志无法读取（${errorMessage(err)}），已保留：${P.journal}`);
      }
      if (jr) {
        try {
          j = parseJournal(JSON.parse(jr.data.toString('utf8')) as unknown);
        } catch (err) {
          return this.pendingResult(t, 'blocked', `恢复日志无法识别（${errorMessage(err)}），已保留：${P.journal}`);
        }
        const same = j.txid === entry.txid && j.nonce === entry.nonce && j.root === entry.root && j.flavorId === entry.flavorId &&
          j.sourceSnapshotId === entry.sourceSnapshotId && j.safetySnapshotId === entry.safetySnapshotId && j.containerPath === entry.containerPath &&
          (j.candidate === null || (entry.candidate !== null && j.candidate.listId === entry.candidate.listId && j.candidate.listSha === entry.candidate.listSha && j.candidate.rootId === entry.candidate.rootId));
        if (!same) return this.pendingResult(t, 'blocked', `恢复日志与登记不符，已保留：${P.journal}`);
        t.journal = { ...j, candidate: entry.candidate };
        t.journalProof = { id: idOf(jr.st), sha: sha256(jr.data) };
      }
    }

    // 结果已确定：只做元数据收尾（不再看 WTF）
    if (entry.outcome) {
      const done = entry.outcome === 'committed' ? 'finalized' : entry.outcome === 'rolled-back' ? 'rolled-back' : 'cleared';
      const h = await this.releaseHold(t, ports);
      if (h) return this.pendingResult(t, 'cleanup-pending', h);
      if (txId !== null && !j && (await listNames(P.tx, MAX_CONTROL_NAMES))?.length) return this.pendingResult(t, 'cleanup-pending', `恢复事务目录中有无法确认的内容，已保留：${P.tx}`);
      return this.settleResult(t, entry.outcome, done, '结果已确定，收尾完成');
    }

    if (txId === null || !j) {
      // 准备阶段（WTF 从未移动）且事务目录不存在或为空：没有需要处理的内容
      const empty = txId === null || ((await listNames(P.tx, MAX_CONTROL_NAMES)) ?? []).length === 0;
      if (entry.state === 'preparing' && empty) return this.settleResult(t, 'not-applied', 'cleared', 'WTF 没有被改动，没有需要处理的内容');
      return this.pendingResult(t, 'blocked', txId === null ? `恢复事务目录不存在，无法确认 WTF 的状态（${P.tx}）` : `恢复日志缺失，无法确认 WTF 的状态：${P.tx}`);
    }

    // 候选清单：只按登记的证明读取
    const proof = entry.candidate;
    if (proof) {
      try {
        const lr = await readMeta(P.list, this.limits.maxManifestBytes, '候选清单');
        if (lr && idOf(lr.st) === proof.listId && sha256(lr.data) === proof.listSha) t.candidateEntries = parseCandidate(JSON.parse(lr.data.toString('utf8')) as unknown, entry.txid, this.limits);
      } catch {
        t.candidateEntries = null;
      }
    }
    const src = await ports.openSources({ sourceSnapshotId: entry.sourceSnapshotId, safetySnapshotId: entry.safetySnapshotId, containerPath: entry.containerPath })
      .catch(() => ({ snapshot: null, safety: null }));
    const W = await idOrNull(P.wtf);
    const O = await idOrNull(P.old);
    const C = await idOrNull(P.candidate);
    const before = j.before;

    // 1. 已持久提交：永不回滚
    if (j.state === 'committed') {
      if (!proof || W !== proof.rootId) {
        return this.pendingResult(t, 'cleanup-pending', `恢复已提交，但当前 WTF 已不是恢复写入的目录（可能被移动、替换或删除）。没有做任何改动；恢复前的原件保留于 ${P.old}`);
      }
      if (C !== null) return this.pendingResult(t, 'cleanup-pending', `恢复已完成，但候选位置出现了不认识的内容，已保留：${P.candidate}`);
      const left = await this.discardOld(t, src.safety);
      if (left) return this.pendingResult(t, 'cleanup-pending', `恢复已完成。${left}`);
      const h = await this.releaseHold(t, ports);
      if (h) return this.pendingResult(t, 'cleanup-pending', `恢复已完成。${h}`);
      return this.settleResult(t, 'committed', 'finalized', '恢复已完成，收尾完成');
    }

    // 2. 准备阶段：WTF 从未移动
    if (j.state === 'preparing') {
      if (O !== null) return this.pendingResult(t, 'blocked', `准备阶段的工作目录中出现了原件位置，已保留：${P.tx}`);
      if (C !== null) {
        const left = await this.discardCandidate(t, 'subset');
        if (left) return this.pendingResult(t, 'cleanup-pending', `WTF 没有被改动。${left}`);
      }
      const h = await this.releaseHold(t, ports);
      if (h) return this.pendingResult(t, 'cleanup-pending', `WTF 没有被改动。${h}`);
      return this.settleResult(t, 'not-applied', 'cleared', 'WTF 没有被改动，已清理本次恢复的内容');
    }

    // 3. prepared / rolled-back：只按真实树身份与完整内容决定
    if (!proof || !t.candidateEntries || !txChain) return this.pendingResult(t, 'blocked', `候选树的证明缺失，无法确认 WTF 的状态，保留现场：${P.tx}`);
    const beforeOk = before ? W === before : W === null;
    if (beforeOk && O === null) {
      if (C !== null) {
        const left = await this.discardCandidate(t, 'exact');
        if (left) return this.pendingResult(t, 'cleanup-pending', `WTF 处于恢复前的状态。${left}`);
      }
      const h = await this.releaseHold(t, ports);
      if (h) return this.pendingResult(t, 'cleanup-pending', `WTF 处于恢复前的状态。${h}`);
      return this.settleResult(t, 'rolled-back', 'rolled-back', 'WTF 处于恢复前的状态，已清理本次恢复的内容');
    }
    const oldIntact = async (): Promise<string | null> => {
      if (!before) return null;
      if (O !== before) return `无法确认恢复前的原件（${P.old}）`;
      if (!src.safety) return '无法打开恢复前备份以确认原件';
      try {
        await verifyTree(P.old, src.safety.entries, this.wtfOpts(undefined, '原件'), 'exact', '恢复前的原件', { parentChain: txChain, baseId: before });
        return null;
      } catch (err) {
        return `恢复前的原件与恢复前备份不一致（${errorMessage(err)}）`;
      }
    };
    // 原件已移出、新树未放入：原件完整才放回
    if (before && W === null && O === before) {
      const bad = await oldIntact();
      if (bad) return this.pendingResult(t, 'blocked', `WTF 当前不存在，${bad}，原件保留于 ${P.old}，未放回`);
      await this.assertHeld(t);
      if ((await idOrNull(P.wtf)) !== null) return this.pendingResult(t, 'blocked', 'WTF 在处理期间出现，原件保留，未放回');
      await rename(P.old, P.wtf);
      await syncDirStrict(root(t), '游戏目录');
      await syncDirStrict(P.tx, '恢复事务目录');
      await this.saveJournal(t, { state: 'rolled-back' });
      return this.dispatch(entry, t, ports);
    }
    // 新树已放入但没有持久的提交：新树与原件都按完整内容核对一致才回滚
    if (W === proof.rootId) {
      try {
        await verifyTree(P.wtf, t.candidateEntries, this.wtfOpts(undefined, 'WTF'), 'exact', '当前 WTF', { parentChain: t.rootChain, baseId: proof.rootId });
      } catch (err) {
        return this.pendingResult(t, 'blocked', `当前 WTF 与恢复时写入的内容不一致（可能已启动游戏，${errorMessage(err)}），不会回滚；原件保留于 ${P.old}`);
      }
      const bad = await oldIntact();
      if (bad) return this.pendingResult(t, 'blocked', `${bad}，不会回滚`);
      if (C !== null) return this.pendingResult(t, 'blocked', `候选位置已被占用，不会回滚：${P.candidate}`);
      await this.assertHeld(t);
      await rename(P.wtf, P.candidate);
      await syncDirStrict(root(t), '游戏目录');
      await syncDirStrict(P.tx, '恢复事务目录');
      if (before) {
        if ((await idOrNull(P.wtf)) !== null) return this.pendingResult(t, 'blocked', `WTF 在处理期间出现，原件保留于 ${P.old}`);
        await this.assertHeld(t);
        await rename(P.old, P.wtf);
        await syncDirStrict(root(t), '游戏目录');
        await syncDirStrict(P.tx, '恢复事务目录');
      }
      await this.saveJournal(t, { state: 'rolled-back' });
      return this.dispatch(entry, t, ports);
    }
    return this.pendingResult(t, 'blocked', `无法确认 WTF 的状态（当前 WTF、原件与候选树的身份都不符合记录），保留现场：${P.tx}`);
  }
}

function root(t: Tx): string {
  return t.root;
}

function scopeOf(input: RestoreApplyInput): BackupScope {
  return parseBackupScope(input.scope);
}

/** 保留原错误码与原因，附加未完成的收尾说明 */
function withNotesKeep(err: unknown, notes: string[]): unknown {
  if (notes.length === 0) return err;
  const code = err instanceof UserError ? err.code : 'restore-failed';
  return new UserError(`${errorMessage(err)}。${notes.join('。')}`, code);
}

export type { PlannedEntry };
