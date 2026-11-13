// 本地 WTF 恢复的持久记录：userData 中的全局登记（所有游戏目录的未完成恢复与最近的收据）、
// 每次恢复工作目录中的 journal 与候选清单。全部严格解析，任何不合法之处都报错，不猜测、不丢弃条目。
// - 登记的修改在跨实例的排他标记内执行（读取 → 修改 → 持久写入），两个实例不会互相覆盖：
//   rename 之前再次复核标记仍完整属于本次（所在目录、身份、每个字段）、登记文件仍是开始时读到的身份与字节（或仍不存在），
//   任何变化都放弃本次写入（restore-registry-race），不覆盖别人已保存的登记。
// - 标记已存在时等待；只有它是登记专用的标记（txid 为全 0）、内容可识别、不是本进程、持有进程 pid 为正且 kill(pid, 0) 报 ESRCH，
//   并且删除前重新核对所在目录、身份与全部字段仍一致时才删除它。其他标记（恢复的目标占用标记、无法识别、外来）一律保留。
// - mutate 的结果明确区分“已保存”与标记释放的问题：标记未能确认释放时仍返回 saved 与 warning，不会被当作没有保存。
// - 登记无法读取时，调用方必须全局禁止新的恢复，并在只读查看中显示固定的错误。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { BackupLimits, BackupScope } from '../shared/backup-types';
import { errorMessage, UserError } from './errors';
import { chainIds, idOf, parseBackupScope, sameChain, SNAPSHOT_ID_RE, unlinkIfSame, type ManifestEntry } from './wtf-backup';
import {
  assertTargetLock, createTargetLock, probePid, readJson, readTargetLock, releaseTargetLock, sameLockInfo, syncDirStrict, writeDurable,
  type HeldTargetLock, type PidState,
} from './wtf-restore-io';
import { checkEntryList, type PlannedEntry } from './wtf-restore-plan';

/** 登记专用排他标记的保留编号（恢复编号由随机数生成，不会是全 0） */
export const REGISTRY_LOCK_TXID = '0'.repeat(16);

export const RESTORE_FORMAT = 'azercube-wtf-restore';
const MAX_REGISTRY_BYTES = 1024 * 1024;
export const MAX_JOURNAL_BYTES = 64 * 1024;
/** 同时登记的未完成恢复上限；达到时拒绝新的恢复 */
export const MAX_PENDING = 32;
export const MAX_RECEIPTS = 20;
const MAX_REASON = 2048;
const LOCK_WAIT_MS = 20;
const LOCK_WAIT_TRIES = 250;

/**
 * preparing：已登记意图，正在准备（WTF 尚未移动）；prepared：准备完成，即将或正在替换；committed：替换已确认提交，收尾中；
 * blocked：无法确认状态，保留现场；cleanup-pending：有内容未能清理（原因见 reason）。
 * 结果是否已确定另见 outcome（与 state 独立）
 */
export type RestoreRegState = 'preparing' | 'prepared' | 'committed' | 'blocked' | 'cleanup-pending';
const REG_STATES: ReadonlySet<string> = new Set(['preparing', 'prepared', 'committed', 'blocked', 'cleanup-pending']);

/** 收据：committed 已恢复；rolled-back 已回滚到恢复前；not-applied 准备阶段停止，WTF 未改动；cleared 处理未完成恢复时确认没有需要处理的内容 */
export type RestoreReceiptOutcome = 'committed' | 'rolled-back' | 'not-applied' | 'cleared';
const OUTCOMES: ReadonlySet<string> = new Set(['committed', 'rolled-back', 'not-applied', 'cleared']);

/** 已确定的结果：在删除 journal 与事务目录之前持久写入，之后只做本次元数据的清理与目标占用的释放 */
export type RestoreSettled = 'committed' | 'rolled-back' | 'not-applied';
const SETTLED: ReadonlySet<string> = new Set(['committed', 'rolled-back', 'not-applied']);

/** 目标占用标记的持久证明：身份与全部持有字段（txid / nonce 取自登记本身） */
export interface RestoreLockProof {
  id: string;
  owner: string;
  pid: number;
  createdAt: number;
}

/** 候选树的持久证明：候选清单文件的身份与校验值、候选根目录的身份（创建后立即登记） */
export interface RestoreCandidateProof {
  listId: string;
  listSha: string;
  rootId: string;
}

export interface RestoreRegEntry {
  txid: string;
  nonce: string;
  flavorId: number;
  root: string;
  /** 登记时游戏目录自身及各级上级目录的身份（由近及远） */
  rootChain: string[];
  scope: BackupScope;
  sourceSnapshotId: string;
  containerPath: string;
  /** 当前 WTF 存在时预先分配的恢复前备份编号；不存在时为 null */
  safetySnapshotId: string | null;
  state: RestoreRegState;
  reason: string | null;
  controlId: string | null;
  txdirId: string | null;
  /** 当前登记的目标占用标记；null 表示没有（或已确认删除）。标记删除未能确认写入磁盘时保留，用于识别它是否重新出现 */
  lock: RestoreLockProof | null;
  candidate: RestoreCandidateProof | null;
  /** 已确定的结果；null 表示尚未确定 */
  outcome: RestoreSettled | null;
  createdAt: number;
  updatedAt: number;
}

export interface RestoreReceipt {
  txid: string;
  flavorId: number;
  root: string;
  outcome: RestoreReceiptOutcome;
  at: number;
  sourceSnapshotId: string;
  safetySnapshotId: string | null;
}

export interface RestoreRegData {
  entries: RestoreRegEntry[];
  receipts: RestoreReceipt[];
}

export const TXID_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^\d+:\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const isAbs = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0') && path.isAbsolute(v) && path.normalize(v) === v;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isFlavor = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e7;
const optSnap = (v: unknown): v is string | null => v === null || (typeof v === 'string' && SNAPSHOT_ID_RE.test(v));
const optId = (v: unknown): v is string | null => v === null || (typeof v === 'string' && ID_RE.test(v));
const isChain = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 256 && v.every((x) => typeof x === 'string' && ID_RE.test(x));
const optReason = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= MAX_REASON);

function registryError(file: string, reason: string): UserError {
  return new UserError(`恢复登记（${file}）无法读取：${reason}。为避免在状态不明时改动 WTF，已暂停所有恢复；请保留该文件并检查`, 'restore-registry');
}

const ENTRY_KEYS = [
  'txid', 'nonce', 'flavorId', 'root', 'rootChain', 'scope', 'sourceSnapshotId', 'containerPath', 'safetySnapshotId', 'state', 'reason',
  'controlId', 'txdirId', 'lock', 'candidate', 'outcome', 'createdAt', 'updatedAt',
] as const;

function parseLockProof(v: unknown): RestoreLockProof | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !exactKeys(v, ['id', 'owner', 'pid', 'createdAt'])) return undefined;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id) || typeof v.owner !== 'string' || !NONCE_RE.test(v.owner)) return undefined;
  if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid <= 0 || !isTime(v.createdAt)) return undefined;
  return { id: v.id, owner: v.owner, pid: v.pid, createdAt: v.createdAt };
}

function parseCandidateProof(v: unknown): RestoreCandidateProof | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !exactKeys(v, ['listId', 'listSha', 'rootId'])) return undefined;
  if (typeof v.listId !== 'string' || !ID_RE.test(v.listId) || typeof v.listSha !== 'string' || !SHA_RE.test(v.listSha) || typeof v.rootId !== 'string' || !ID_RE.test(v.rootId)) return undefined;
  return { listId: v.listId, listSha: v.listSha, rootId: v.rootId };
}
const RECEIPT_KEYS = ['txid', 'flavorId', 'root', 'outcome', 'at', 'sourceSnapshotId', 'safetySnapshotId'] as const;

function parseEntry(v: unknown): RestoreRegEntry | null {
  if (!isObj(v) || !exactKeys(v, ENTRY_KEYS)) return null;
  if (typeof v.txid !== 'string' || !TXID_RE.test(v.txid) || typeof v.nonce !== 'string' || !NONCE_RE.test(v.nonce)) return null;
  if (!isFlavor(v.flavorId) || !isAbs(v.root) || !isChain(v.rootChain) || !isAbs(v.containerPath)) return null;
  if (typeof v.sourceSnapshotId !== 'string' || !SNAPSHOT_ID_RE.test(v.sourceSnapshotId) || !optSnap(v.safetySnapshotId)) return null;
  if (typeof v.state !== 'string' || !REG_STATES.has(v.state) || !optReason(v.reason)) return null;
  if (!optId(v.controlId) || !optId(v.txdirId) || !isTime(v.createdAt) || !isTime(v.updatedAt)) return null;
  if (!(v.outcome === null || (typeof v.outcome === 'string' && SETTLED.has(v.outcome)))) return null;
  const lock = parseLockProof(v.lock);
  const candidate = parseCandidateProof(v.candidate);
  if (lock === undefined || candidate === undefined) return null;
  let scope: BackupScope;
  try {
    scope = parseBackupScope(v.scope);
  } catch {
    return null;
  }
  return {
    txid: v.txid, nonce: v.nonce, flavorId: v.flavorId, root: v.root, rootChain: [...v.rootChain], scope, sourceSnapshotId: v.sourceSnapshotId,
    containerPath: v.containerPath, safetySnapshotId: v.safetySnapshotId, state: v.state as RestoreRegState, reason: v.reason,
    controlId: v.controlId, txdirId: v.txdirId, lock, candidate, outcome: v.outcome as RestoreSettled | null, createdAt: v.createdAt, updatedAt: v.updatedAt,
  };
}

function parseReceipt(v: unknown): RestoreReceipt | null {
  if (!isObj(v) || !exactKeys(v, RECEIPT_KEYS)) return null;
  if (typeof v.txid !== 'string' || !TXID_RE.test(v.txid) || !isFlavor(v.flavorId) || !isAbs(v.root)) return null;
  if (typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome) || !isTime(v.at)) return null;
  if (typeof v.sourceSnapshotId !== 'string' || !SNAPSHOT_ID_RE.test(v.sourceSnapshotId) || !optSnap(v.safetySnapshotId)) return null;
  return { txid: v.txid, flavorId: v.flavorId, root: v.root, outcome: v.outcome as RestoreReceiptOutcome, at: v.at, sourceSnapshotId: v.sourceSnapshotId, safetySnapshotId: v.safetySnapshotId };
}

export function parseRegistry(value: unknown, file: string): RestoreRegData {
  if (!isObj(value) || !exactKeys(value, ['format', 'kind', 'schema', 'entries', 'receipts'])) throw registryError(file, '格式不正确');
  if (value.format !== RESTORE_FORMAT || value.kind !== 'registry' || value.schema !== 1) throw registryError(file, '格式或版本标记不正确');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_PENDING || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) throw registryError(file, '记录列表不正确');
  const entries: RestoreRegEntry[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of value.entries.entries()) {
    const e = parseEntry(raw);
    if (!e || seen.has(e.txid)) throw registryError(file, `第 ${i + 1} 条未完成恢复不合法`);
    seen.add(e.txid);
    entries.push(e);
  }
  const receipts: RestoreReceipt[] = [];
  for (const [i, raw] of value.receipts.entries()) {
    const r = parseReceipt(raw);
    if (!r) throw registryError(file, `第 ${i + 1} 条收据不合法`);
    receipts.push(r);
  }
  return { entries, receipts };
}

/**
 * 一次 mutate 的结果：value 为修改函数的返回值；saved 表示这次确实写入并确认了新的登记（没有改动时为 false）；
 * warning 非空表示登记的排他标记未能确认释放（已删除但未确认写入磁盘，或已被改动而保留）——登记本身的保存结果不受影响
 */
export interface RegistryMutation<T> {
  value: T;
  saved: boolean;
  warning: string | null;
}

/** 测试注入点：登记写入的各阶段（生产不设置）。before-rename 在临时文件写完之后、rename 前的复核之前调用 */
export interface RegistryHooks {
  step?(name: 'locked' | 'before-rename'): Promise<void> | void;
}

/**
 * 全局登记。load 只读；mutate 在跨实例的排他标记内重新读取、修改并持久写入（同一实例内另有队列串行）。
 * 修改函数抛错时不写入。写入失败向上抛出：restore-registry-race 表示登记被其他操作改动、本次未保存；
 * restore-fsync-unconfirmed 表示已 rename 但未能确认（调用方不能当作没有保存）；其他错误表示未保存。
 * 标记释放的问题不改变保存结果：成功时随结果返回 warning，失败时附加在错误说明中。
 */
export class RestoreRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly probe: (pid: number) => PidState = probePid,
    private readonly hooks: RegistryHooks = {},
    /** 排他标记已存在时的等待间隔与次数（测试可调低） */
    private readonly wait: { ms: number; tries: number } = { ms: LOCK_WAIT_MS, tries: LOCK_WAIT_TRIES },
  ) {}

  async load(): Promise<RestoreRegData> {
    return (await this.read()).data;
  }

  private async read(): Promise<{ data: RestoreRegData; id: string | null; sha: string | null }> {
    let r;
    try {
      r = await readJson(this.file, MAX_REGISTRY_BYTES, '恢复登记');
    } catch (err) {
      throw registryError(this.file, errorMessage(err));
    }
    if (!r) return { data: { entries: [], receipts: [] }, id: null, sha: null };
    return { data: parseRegistry(r.value, this.file), id: idOf(r.st), sha: r.sha };
  }

  mutate<T>(fn: (d: RegistryDraft) => T): Promise<RegistryMutation<T>> {
    const run = this.queue.then(() => this.locked(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async locked<T>(fn: (d: RegistryDraft) => T): Promise<RegistryMutation<T>> {
    const lock = await this.acquire(`${this.file}.lock`);
    let out: { value: T; saved: boolean } | null = null;
    let failure: unknown = null;
    try {
      await this.hooks.step?.('locked');
      const start = await this.read();
      const draft = new RegistryDraft(start.data);
      const value = fn(draft);
      let saved = false;
      if (draft.dirty) {
        draft.data.receipts = draft.data.receipts.slice(-MAX_RECEIPTS);
        if (draft.data.entries.length > MAX_PENDING) throw new UserError('未完成的恢复过多，请先处理已有的未完成恢复', 'restore-pending');
        const text = JSON.stringify({ format: RESTORE_FORMAT, kind: 'registry', schema: 1, entries: draft.data.entries, receipts: draft.data.receipts });
        if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) throw new UserError('恢复登记将超过大小上限，未保存', 'restore-registry');
        await writeDurable(this.file, Buffer.from(text, 'utf8'), '恢复登记', {
          beforeRename: async () => {
            await this.hooks.step?.('before-rename');
            await this.assertUnchanged(lock, start.id, start.sha);
          },
        });
        saved = true;
      }
      out = { value, saved };
    } catch (err) {
      failure = err ?? new Error('恢复登记修改失败');
    }
    const rel = await releaseTargetLock(lock);
    const warning = rel.status === 'released' ? null : `恢复登记的排他标记未能正常释放：${rel.note ?? lock.path}`;
    if (failure || !out) {
      if (!warning) throw failure;
      const code = failure instanceof UserError ? failure.code : 'restore-registry';
      throw new UserError(`${errorMessage(failure)}。${warning}`, code);
    }
    return { ...out, warning };
  }

  /** rename 前的复核：排他标记仍完整属于本次，登记文件仍是开始时读到的身份与字节（或仍不存在） */
  private async assertUnchanged(lock: HeldTargetLock, id: string | null, sha: string | null): Promise<void> {
    const race = (why: string) => new UserError(`恢复登记在修改期间被其他操作改动（${why}），本次修改未保存，请重试`, 'restore-registry-race');
    try {
      await assertTargetLock(lock);
    } catch {
      throw race('排他标记已被移除或替换');
    }
    let cur;
    try {
      cur = await readJson(this.file, MAX_REGISTRY_BYTES, '恢复登记');
    } catch {
      throw race('登记文件无法读取');
    }
    if (id === null ? cur !== null : !cur || idOf(cur.st) !== id || cur.sha !== sha) throw race('登记文件已变化');
  }

  /**
   * 登记的排他标记：与目标占用标记同一格式，txid 固定为 REGISTRY_LOCK_TXID。已存在时等待；
   * 只有登记专用、内容可识别、不是本进程、持有进程确认已退出（ESRCH），且删除前重新核对所在目录、身份与全部字段仍一致时才删除
   */
  private async acquire(p: string): Promise<HeldTargetLock> {
    const dir = path.dirname(p);
    for (let i = 0; ; i++) {
      try {
        return await createTargetLock(p, REGISTRY_LOCK_TXID, randomBytes(16).toString('hex'));
      } catch (err) {
        if (!(err instanceof UserError && err.code === 'restore-lock-busy')) throw err;
      }
      if (await this.reclaimStale(p, dir)) continue;
      if (i >= this.wait.tries) throw new UserError(`恢复登记正被占用（${p}）。如确认没有其他艾泽魔方在运行，可在访达中删除该文件后重试`, 'restore-registry-busy');
      await new Promise((r) => setTimeout(r, this.wait.ms));
    }
  }

  private async reclaimStale(p: string, dir: string): Promise<boolean> {
    const chain = await chainIds(dir).catch(() => null);
    const cur = await readTargetLock(p).catch(() => null);
    const info = cur?.info;
    if (!chain || !cur || !info || info.txid !== REGISTRY_LOCK_TXID || info.pid === process.pid || this.probe(info.pid) !== 'gone') return false;
    const again = await readTargetLock(p).catch(() => null);
    const chainNow = await chainIds(dir).catch(() => null);
    if (!again || idOf(again.st) !== idOf(cur.st) || !sameLockInfo(again.info, info) || !chainNow || !sameChain(chainNow, chain) || this.probe(info.pid) !== 'gone') return false;
    if (!(await unlinkIfSame(p, idOf(cur.st)))) return false;
    await syncDirStrict(dir, '恢复登记的旧排他标记的删除');
    return true;
  }
}

/** mutate 中的可修改副本 */
export class RegistryDraft {
  dirty = false;
  constructor(readonly data: RestoreRegData) {}

  find(txid: string): RestoreRegEntry | undefined {
    return this.data.entries.find((e) => e.txid === txid);
  }

  add(e: RestoreRegEntry): void {
    this.data.entries.push(e);
    this.dirty = true;
  }

  update(txid: string, patch: Partial<Omit<RestoreRegEntry, 'txid' | 'nonce' | 'root' | 'flavorId'>>): void {
    const e = this.find(txid);
    if (!e) throw new UserError('恢复登记中找不到这项恢复', 'restore-registry');
    Object.assign(e, patch, { updatedAt: Date.now() });
    if (e.reason !== null) e.reason = e.reason.slice(0, MAX_REASON);
    this.dirty = true;
  }

  finish(txid: string, outcome: RestoreReceiptOutcome): void {
    const e = this.find(txid);
    if (!e) return;
    this.data.entries = this.data.entries.filter((x) => x.txid !== txid);
    this.data.receipts.push({ txid, flavorId: e.flavorId, root: e.root, outcome, at: Date.now(), sourceSnapshotId: e.sourceSnapshotId, safetySnapshotId: e.safetySnapshotId });
    this.dirty = true;
  }
}

// ---------- journal 与候选清单 ----------

/** preparing：尚未移动任何东西；prepared：可以开始替换；committed：替换已提交；rolled-back：已回滚 */
export type JournalState = 'preparing' | 'prepared' | 'committed' | 'rolled-back';
const JOURNAL_STATES: ReadonlySet<string> = new Set(['preparing', 'prepared', 'committed', 'rolled-back']);

export interface RestoreJournal {
  txid: string;
  nonce: string;
  flavorId: number;
  root: string;
  state: JournalState;
  /** 恢复前 WTF 目录的身份；null 表示当前没有 WTF */
  before: string | null;
  /** 候选树的持久证明（候选清单写入、候选根目录创建之后立即写入）；之前为 null */
  candidate: RestoreCandidateProof | null;
  sourceSnapshotId: string;
  safetySnapshotId: string | null;
  containerPath: string;
  /**
   * 调用方（备份服务）给出的备份位置占用证明（不透明、有长度上限）；null 表示没有占用或已释放。
   * 中断后由处理未完成恢复的端口按它识别并释放遗留的占用
   */
  sourceHold: string | null;
  /** 已经完整核对通过并开始删除原件 / 候选树：之后只要求剩余部分是清单的子集 */
  discardOld: boolean;
  discardCandidate: boolean;
  createdAt: number;
}

const JOURNAL_KEYS = [
  'format', 'kind', 'schema', 'txid', 'nonce', 'flavorId', 'root', 'state', 'before', 'candidate', 'sourceSnapshotId', 'safetySnapshotId', 'containerPath',
  'sourceHold', 'discardOld', 'discardCandidate', 'createdAt',
];
/** 占用证明含备份位置的完整路径与各级身份，按路径上限留足余量 */
export const MAX_SOURCE_HOLD = 16 * 1024;

export function serializeJournal(j: RestoreJournal): Buffer {
  return Buffer.from(JSON.stringify({ format: RESTORE_FORMAT, kind: 'journal', schema: 1, ...j }), 'utf8');
}

export function parseJournal(v: unknown): RestoreJournal {
  const bad = (why: string) => new UserError(`恢复日志不合法（${why}）`, 'restore-corrupt');
  if (!isObj(v) || !exactKeys(v, JOURNAL_KEYS) || v.format !== RESTORE_FORMAT || v.kind !== 'journal' || v.schema !== 1) throw bad('格式');
  if (typeof v.txid !== 'string' || !TXID_RE.test(v.txid) || typeof v.nonce !== 'string' || !NONCE_RE.test(v.nonce)) throw bad('编号');
  if (!isFlavor(v.flavorId) || !isAbs(v.root) || !isAbs(v.containerPath) || typeof v.state !== 'string' || !JOURNAL_STATES.has(v.state)) throw bad('目标');
  const candidate = parseCandidateProof(v.candidate);
  if (!optId(v.before) || candidate === undefined) throw bad('身份');
  if (typeof v.sourceSnapshotId !== 'string' || !SNAPSHOT_ID_RE.test(v.sourceSnapshotId) || !optSnap(v.safetySnapshotId)) throw bad('备份编号');
  if (!(v.sourceHold === null || (typeof v.sourceHold === 'string' && v.sourceHold.length > 0 && v.sourceHold.length <= MAX_SOURCE_HOLD))) throw bad('占用证明');
  if (typeof v.discardOld !== 'boolean' || typeof v.discardCandidate !== 'boolean' || !isTime(v.createdAt)) throw bad('标记');
  return {
    txid: v.txid, nonce: v.nonce, flavorId: v.flavorId, root: v.root, state: v.state as JournalState, before: v.before, candidate,
    sourceSnapshotId: v.sourceSnapshotId, safetySnapshotId: v.safetySnapshotId, containerPath: v.containerPath, sourceHold: v.sourceHold,
    discardOld: v.discardOld, discardCandidate: v.discardCandidate, createdAt: v.createdAt,
  };
}

export function serializeCandidate(txid: string, entries: readonly PlannedEntry[]): Buffer {
  return Buffer.from(JSON.stringify({ format: RESTORE_FORMAT, kind: 'candidate', txid, entries }), 'utf8');
}

/**
 * 候选清单：每个条目的字段精确（目录 path/type/origin；文件另有 size/sha256），来源只能是 snapshot / baseline；
 * 整体再按计划使用的同一规则校验（路径安全、大小写 / Unicode 无关唯一、上级目录完整、条目数 / 层数 / 单文件 / 总字节不超过 limits）。
 * 只返回清单条目（来源只用于说明）。任何不合法之处抛出 restore-corrupt
 */
export function parseCandidate(v: unknown, txid: string, limits: Pick<BackupLimits, 'maxEntries' | 'maxDepth' | 'maxFileBytes' | 'maxSnapshotBytes'>): ManifestEntry[] {
  const bad = (why: string) => new UserError(`候选清单不合法（${why}）`, 'restore-corrupt');
  if (!isObj(v) || !exactKeys(v, ['format', 'kind', 'txid', 'entries']) || v.format !== RESTORE_FORMAT || v.kind !== 'candidate' || v.txid !== txid) throw bad('格式');
  if (!Array.isArray(v.entries) || v.entries.length > limits.maxEntries) throw bad('条目列表');
  const out = v.entries.map((e: unknown): ManifestEntry => {
    if (!isObj(e) || typeof e.path !== 'string') throw bad('条目');
    if (e.origin !== 'snapshot' && e.origin !== 'baseline') throw bad(`「${e.path}」的来源`);
    if (e.type === 'dir' && exactKeys(e, ['path', 'type', 'origin'])) return { path: e.path, type: 'dir' };
    if (e.type === 'file' && exactKeys(e, ['path', 'type', 'size', 'sha256', 'origin']) && isTime(e.size) && typeof e.sha256 === 'string' && SHA_RE.test(e.sha256)) {
      return { path: e.path, type: 'file', size: e.size, sha256: e.sha256 };
    }
    throw bad(`「${e.path}」的字段`);
  });
  try {
    checkEntryList(out, '候选清单', true, limits);
  } catch (err) {
    throw bad(errorMessage(err));
  }
  return out;
}
