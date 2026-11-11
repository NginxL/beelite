// 全局状态：当前 flavor、本地状态、更新检查结果、进行中的写操作。各页面通过 on() 订阅变化。

import type {
  ActivitySnapshot, ActivityTask, AddonWatchEntry, AddonWatchSnapshot, AppConfig, BeeLiteApi, FlavorInfo, HistoryStatusView, InstalledRecord, LocalState, ManagedProjectView, OpResult,
  TaskEvent, TaskPhase, UpdateCheckItem,
} from '../shared/types';
import { actionableUpdate } from '../shared/update-policy.js';
import { confirmDialog, toast } from './dom.js';
import { errMsg } from './format.js';

declare global {
  interface Window {
    beelite: BeeLiteApi;
  }
}

export const api = (): BeeLiteApi => window.beelite;

/**
 * flavor：切换版本；local：本地状态或按钮状态变化；watch：主进程插件更新检查快照变化；
 * progress：进行中任务的下载百分比变化（只需就地更新进度文字，不重绘页面）；history：操作记录的保存状态变化；
 * backup：配置备份的任务开始 / 结束、备份状态、账号与角色列表或操作结果变化（同一任务的进度不触发，只就地更新任务卡片）
 */
type EventName = 'flavor' | 'local' | 'watch' | 'progress' | 'history' | 'backup';
const listeners = new Map<EventName, Set<() => void>>();

export function on(ev: EventName, fn: () => void): void {
  let set = listeners.get(ev);
  if (!set) listeners.set(ev, (set = new Set()));
  set.add(fn);
}

export function emit(ev: EventName): void {
  for (const fn of listeners.get(ev) ?? []) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

export const state = {
  config: null as AppConfig | null,
  flavorId: 9,
  local: null as LocalState | null,
  localLoading: false,
  localError: null as string | null,
  /** 当前目标（版本 + 目录）的更新检查结果，按 modId；只在 updatesFor 与当前目标一致时有效 */
  updates: new Map<string, UpdateCheckItem>(),
  updatesChecked: false,
  /** updates 所属的目标 */
  updatesFor: null as Target | null,
  /** 主进程插件更新检查快照（所有已绑定目录） */
  watch: null as AddonWatchSnapshot | null,
  /** 尚未取得任何快照时，最近一次获取失败的原因（可重试） */
  watchError: null as string | null,
  /** 进行中的操作键，用于禁用按钮防止重复点击 */
  busy: new Set<string>(),
  /**
   * 主进程的插件写操作状态（进行中的全部更新、任务与单项写操作），是“是否在处理”的唯一依据；
   * null 表示尚未取得（启动中或获取失败），此时插件写入口保守地禁止
   */
  activity: null as ActivitySnapshot | null,
  /** 获取活动状态失败的原因（尚未取得任何状态时才显示，可重试） */
  activityError: null as string | null,
  /** 失败与取消的行内说明，按 目标（版本 + 目录）+ 插件编号 记录；只在本界面中保留 */
  notes: new Map<string, { taskId: string; phase: 'failed' | 'cancelled'; message: string | null }>(),
  /** 主进程操作记录的保存状态（未取得为 null） */
  history: null as HistoryStatusView | null,
  /** 本界面看到的插件写操作结束次数（发起的写操作、任务终态、主进程结束的占用）：健康检查结果据此标为可能过期 */
  writeEpoch: 0,
};

export interface RowTask {
  taskId: string;
  phase: TaskPhase;
  /** 下载百分比（整数）；未知时为 null */
  percent: number | null;
  message: string | null;
}

export function flavorById(id: number): FlavorInfo | undefined {
  return state.config?.flavors.find((f) => f.id === id);
}

export function currentFlavor(): FlavorInfo | undefined {
  return flavorById(state.flavorId);
}

export function flavorName(id: number): string {
  return flavorById(id)?.name ?? `版本 ${id}`;
}

export function isBlocked(): boolean {
  return state.local?.dir?.status === 'blocked';
}

export function findManaged(modId: string): ManagedProjectView | undefined {
  return state.local?.managed.find((p) => p.modId === modId);
}

// ---------- 操作目标（操作前记录，确认后复核） ----------

/** 一次写操作的目标：当前显示的游戏版本及其绑定目录。主进程只把 root 当作期望值比对，不当作写入路径 */
export interface Target {
  flavorId: number;
  root: string;
}

/** 当前显示的目标；本地状态未加载、刷新失败（显示的是旧结果）或与当前版本不一致时返回 null */
export function currentTarget(): Target | null {
  const local = state.local;
  if (!local || state.localError || local.flavorId !== state.flavorId || !local.profile.root) return null;
  return { flavorId: local.flavorId, root: local.profile.root };
}

/** 取当前目标；取不到时提示并返回 null */
export function requireTarget(): Target | null {
  const t = currentTarget();
  if (!t) toast(state.localError ? '本地插件状态未能刷新，请先点击“刷新”重试' : '请先为当前游戏版本选择游戏目录', 'error');
  return t;
}

/** 确认等异步步骤之后复核：目标未变才继续，否则提示并放弃 */
export function stillTarget(t: Target): boolean {
  const now = currentTarget();
  if (now && now.flavorId === t.flavorId && now.root === t.root) return true;
  toast('游戏版本或目录已变更，已取消本次操作，未做任何改动', 'warn');
  return false;
}

/** 插件是否按当前显示的游戏版本安装（来源版本不同的只能卸载与恢复，不检查、不更新、不重装） */
export function isOtherFlavor(p: ManagedProjectView): boolean {
  return p.flavorId !== (state.local?.flavorId ?? state.flavorId);
}

const sameTarget = (a: Target | null, b: Target | null): boolean => !!a && !!b && a.flavorId === b.flavorId && a.root === b.root;

/**
 * 某个本地项目的检查结果：结果必须属于当前目标（版本 + 目录），且检查时的本地文件编号与现在相同；
 * 否则（换绑目录、更新/重装/卸载后恢复等）视为没有检查结果，不能沿用其他目录或旧文件的结论。
 */
export function updateFor(p: ManagedProjectView): UpdateCheckItem | undefined {
  if (!sameTarget(state.updatesFor, currentTarget())) return undefined;
  const u = state.updates.get(p.modId);
  return u && u.installedFileId === p.fileId ? u : undefined;
}

/** 有更新：检查结果说有更新，且本地文件还不是最新文件（更新完成后自动失效） */
export function projectHasUpdate(p: ManagedProjectView): boolean {
  const u = updateFor(p);
  return !!u && u.hasUpdate && u.latestFileId !== p.fileId;
}

/**
 * 更新策略不可用的原因：主进程快照尚未取得（获取失败时页面提供重试），或主进程无法读取策略文件。
 * 非 null 时任何插件都不能更新或重装（主进程同样拒绝），但已知的新版本仍照常显示。
 * 快照带有全部暂停项，不要求当前目录已有检查条目（在别处换绑后也能立即按新目录判断）
 */
export function policyBlock(): string | null {
  if (state.watch?.policyError) return `更新策略无法读取，已停止所有插件更新：${state.watch.policyError}`;
  if (!state.watch) return state.watchError ? `插件更新状态未能同步，暂时不能更新：${state.watchError}` : '正在同步插件更新状态，完成后可更新';
  return null;
}

/** 这个插件在当前目标（版本 + 目录）上已暂停更新（按主进程快照中的全部暂停项） */
export function isPaused(modId: string): boolean {
  const t = currentTarget();
  if (!t || !state.watch) return false;
  const all = state.watch.pausedAll;
  if (all) return all.some((r) => r.flavorId === t.flavorId && r.root === t.root && r.modId === modId);
  return !!currentWatchEntry()?.paused?.includes(modId);
}

/**
 * 主动获取主进程的更新检查快照（启动时与用户重试）。尚未取得任何快照时记录失败原因（页面显示并可重试），
 * 不覆盖已收到的快照；apply 默认按 rev 合并
 */
export async function syncWatch(apply: (s: AddonWatchSnapshot) => unknown = applyWatch): Promise<void> {
  try {
    apply(await api().watchState());
  } catch (err) {
    if (!state.watch) {
      state.watchError = errMsg(err);
      emit('local');
    }
  }
}

/** 可以更新：有新版本、没有暂停、策略可用（与主进程的待更新数量、提醒与全部更新使用同一判定） */
export function projectActionable(p: ManagedProjectView): boolean {
  return projectHasUpdate(p) && actionableUpdate({ hasUpdate: true, paused: isPaused(p.modId) }, policyBlock());
}

export function updateCount(): number {
  return (state.local?.managed ?? []).filter(projectActionable).length;
}

/** 当前目标在快照中的条目 */
export function currentWatchEntry(): AddonWatchEntry | undefined {
  const t = currentTarget();
  if (!t) return undefined;
  return state.watch?.entries.find((e) => e.flavorId === t.flavorId && e.root === t.root);
}

/** 重新读取更新策略（策略无法读取时用户点击重试） */
export async function reloadPolicy(): Promise<void> {
  if (isBusy('policy')) return;
  state.busy.add('policy');
  emit('local');
  try {
    applyWatch(await api().reloadPolicy());
    if (state.watch?.policyError) toast(`更新策略仍无法读取：${state.watch.policyError}`, 'error');
    else toast('更新策略已重新读取', 'success');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('policy');
    emit('local');
  }
}

// ---------- 操作记录的保存状态 ----------

/** 主进程推送或主动获取的状态：同一个记录文件只接受不更旧的状态 */
export function applyHistoryStatus(s: HistoryStatusView): void {
  const prev = state.history;
  if (prev && prev.file === s.file && s.rev < prev.rev) return;
  state.history = s;
  emit('history');
  emit('local');
}

export async function syncHistoryStatus(): Promise<void> {
  try {
    applyHistoryStatus(await api().historyStatus());
  } catch {
    // 获取失败时保持原状态；操作结果中仍会单独提示
  }
}

/** 重新读取记录文件并保存尚未写入的记录 */
export async function retryHistory(): Promise<void> {
  if (isBusy('history')) return;
  state.busy.add('history');
  emit('local');
  try {
    const s = await api().historyRetry();
    applyHistoryStatus(s);
    if (s.loadError || s.unsaved > 0) toast(`操作记录仍未能保存：${s.loadError ?? s.saveError ?? '原因未知'}`, 'error');
    else toast('操作记录已保存', 'success');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('history');
    emit('local');
  }
}

/** 操作记录需要提示的问题（无法读取、未保存、已丢弃）；没有问题为 null */
export function historyProblem(): string | null {
  const s = state.history;
  if (!s) return null;
  if (s.loadError) return `操作记录文件无法读取：${s.loadError}`;
  const parts: string[] = [];
  if (s.unsaved > 0) parts.push(`${s.unsaved} 条操作记录尚未保存${s.saveError ? `（${s.saveError}）` : ''}，重启后可能缺失`);
  if (s.dropped > 0) parts.push(`${s.dropped} 条未保存的记录因数量上限已丢弃`);
  return parts.length ? parts.join('；') : null;
}

/**
 * 各游戏版本可更新的插件数：当前显示的目标用本地状态逐项核对；其他已绑定目录用主进程按其清单核对过的数量。
 * 只统计与当前绑定一致的目录（快照只包含已绑定目录）。
 */
export function pendingByFlavor(): Map<number, number> {
  const out = new Map<number, number>();
  const t = currentTarget();
  for (const e of state.watch?.entries ?? []) {
    if (t && e.flavorId === t.flavorId) continue;
    if (e.flavorId === state.flavorId) continue; // 当前版本的本地状态尚未就绪时不显示可能过时的数量
    if (e.pending > 0) out.set(e.flavorId, e.pending);
  }
  const n = updateCount();
  if (t && n > 0) out.set(t.flavorId, n);
  return out;
}

/**
 * 检查结果完全取自主进程的权威快照中当前目标（版本 + 目录）的条目，绝不套用其他目录的结果。
 * 快照中没有该目录、尚未完成检查（例如绑定刚变更、结果已作废）或整个目录检查失败时，清空界面上的结果。
 */
export function syncUpdatesFromWatch(): void {
  const t = currentTarget();
  state.updatesFor = t;
  const e = currentWatchEntry();
  if (!t || !e || e.checkedAt === null) {
    state.updates = new Map();
    state.updatesChecked = false;
    return;
  }
  state.updates = new Map(e.items.map((i) => [i.modId, i]));
  state.updatesChecked = e.status !== 'error';
}

/**
 * 收到主进程快照（事件、启动时主动获取或手动检查的回复）：同一次运行内只按 rev 判断新旧，丢弃过时的快照；
 * 检查时间只用于显示，不参与比较（系统时钟回拨不影响）。
 */
export function applyWatch(s: AddonWatchSnapshot): boolean {
  if (state.watch && s.instance === state.watch.instance && s.rev <= state.watch.rev) return false;
  state.watch = s;
  state.watchError = null;
  syncUpdatesFromWatch();
  emit('watch');
  emit('local');
  return true;
}

export function isBusy(key: string): boolean {
  return state.busy.has(key);
}

// ---------- 插件操作的占用与任务进度（按目标区分：A 目录的操作不影响 B 中同一插件） ----------

export const targetKey = (t: Target): string => `${t.flavorId}\n${t.root}`;
/** 单个插件写操作的占用键 */
export const modKey = (t: Target, modId: string): string => `mod:${targetKey(t)}\n${modId}`;
/** 全部更新的占用键 */
export const updateAllKey = (t: Target): string => `updateAll:${targetKey(t)}`;
const taskKey = (t: Target, modId: string): string => `${targetKey(t)}\n${modId}`;
const onTarget = (x: { flavorId: number; root: string }, t: Target): boolean => x.flavorId === t.flavorId && x.root === t.root;

const FINAL_PHASES: readonly TaskPhase[] = ['done', 'failed', 'cancelled'];
export const isFinalPhase = (p: TaskPhase): boolean => FINAL_PHASES.includes(p);

/**
 * 任务事件带来的下载字节数（按任务编号），只在比当前快照更新（rev 更大）时使用，
 * 因此迟到的旧快照不会让进度倒退，旧事件也不会覆盖更新的快照。
 */
const progressByTask = new Map<string, { rev: number; received: number | null; total: number | null }>();
/** 已收到终态的任务及其 rev：快照追上之前，这些任务不再显示为进行中 */
const endedTasks = new Map<string, number>();
/** 已结算终态的任务（终态只处理一次） */
const settledTasks = new Set<string>();

/** 尚未取得主进程的活动状态（启动中或获取失败）：插件写入口保守地禁止 */
export function activityUnknown(): boolean {
  return state.activity === null;
}

/** 这个目标上进行中的任务（来自主进程状态；已收到终态的不算） */
function activeTask(t: Target, modId: string): ActivityTask | undefined {
  return state.activity?.tasks.find((x) => x.modId === modId && onTarget(x, t) && !endedTasks.has(x.taskId));
}

/** 任务的下载进度：取快照与更新的任务事件中较新的一方 */
export function taskBytes(task: ActivityTask, snapshotRev = state.activity?.rev ?? 0): { received: number | null; total: number | null } {
  const p = progressByTask.get(task.taskId);
  return p && p.rev > snapshotRev ? p : { received: task.received, total: task.total };
}

/** 这个插件在目标上的任务（默认当前目标）：进行中的任务优先，否则是上次失败 / 取消的说明 */
export function rowTask(modId: string, t: Target | null = currentTarget()): RowTask | undefined {
  if (!t) return undefined;
  const a = activeTask(t, modId);
  if (a) {
    const { received, total } = taskBytes(a);
    const percent = a.phase === 'downloading' && total ? Math.min(100, Math.round(((received ?? 0) / total) * 100)) : null;
    return { taskId: a.taskId, phase: a.phase, percent, message: null };
  }
  const n = state.notes.get(taskKey(t, modId));
  return n ? { taskId: n.taskId, phase: n.phase, percent: null, message: n.message } : undefined;
}

/** 目标上进行中的全部更新（主进程状态） */
function batchOf(t: Target): { stage: 'checking' | 'running' } | undefined {
  return state.activity?.batches.find((b) => onTarget(b, t));
}

/** 目标上已受理、尚未结束的单个插件写操作（主进程状态） */
export function isReserved(t: Target, modId: string): boolean {
  return !!state.activity?.reservations.some((r) => r.modId === modId && onTarget(r, t));
}

/** 目标（默认当前目标）正在全部更新：本界面已发起，或主进程有该目标的批次 */
export function updatingAll(t: Target | null = currentTarget()): boolean {
  return !!t && (isBusy(updateAllKey(t)) || !!batchOf(t));
}

/**
 * 目标上可更新但没有任务的插件在操作位置上的说明：活动状态未知时为“同步中”；
 * 正在全部更新时，主进程给出计划（批次进入逐项处理）之前为“检查中”，之后为“全部更新中”
 */
export function batchHoldText(t: Target | null = currentTarget()): string | null {
  if (!t) return null;
  if (activityUnknown()) return state.activityError ? '暂不可用' : '同步中';
  if (!updatingAll(t)) return null;
  return batchOf(t)?.stage === 'running' ? '全部更新中' : '检查中';
}

/**
 * 当前目标上这个插件的写入口是否被占用：活动状态未知；单项操作已发起（含确认与受理之前）或已受理；有进行中的任务；
 * 或该目标正在全部更新且插件已托管，或批次计划尚未确定（主进程此时不受理任何单项写操作）。
 * 所有入口在调用时同步检查，不只依赖按钮的禁用状态；主进程另有同样的冲突判断。
 */
export function modBusy(modId: string): boolean {
  const t = currentTarget();
  if (!t) return false;
  if (activityUnknown()) return true;
  if (isBusy(modKey(t, modId)) || isReserved(t, modId) || !!activeTask(t, modId)) return true;
  return updatingAll(t) && (!!findManaged(modId) || batchOf(t)?.stage !== 'running');
}

/** 重新发起操作前清除目标上（或其中一个插件）上次失败 / 取消的说明 */
export function clearTaskNotes(t: Target, modId?: string): void {
  const prefix = modId === undefined ? `${targetKey(t)}\n` : taskKey(t, modId);
  for (const k of [...state.notes.keys()]) {
    if (modId === undefined ? k.startsWith(prefix) : k === prefix) state.notes.delete(k);
  }
}

/** 当前目标有插件写操作正在进行或已发起（主进程此时不受理全部更新）；活动状态未知时视为有 */
export function anyModBusy(): boolean {
  const t = currentTarget();
  if (!t) return false;
  if (activityUnknown()) return true;
  const prefix = `mod:${targetKey(t)}\n`;
  if ([...state.busy].some((k) => k.startsWith(prefix))) return true;
  const a = state.activity!;
  return a.reservations.some((r) => onTarget(r, t)) || a.tasks.some((x) => onTarget(x, t) && !endedTasks.has(x.taskId));
}

/** 主进程有进行中的插件写操作（任意目录）；活动状态未知时为 false（由调用方另行判断） */
export function activityBusy(): boolean {
  const a = state.activity;
  return !!a && (a.batches.length > 0 || a.tasks.length > 0 || a.reservations.length > 0);
}

/** 接受新快照后的通知（任务面板据此恢复卡片） */
let activitySink: (s: ActivitySnapshot) => void = () => undefined;
export function onActivityAccepted(fn: (s: ActivitySnapshot) => void): void {
  activitySink = fn;
}

/**
 * 主进程的活动状态（推送或主动获取的回复）：同一次运行内只接受 rev 更大的，迟到的旧快照被丢弃，
 * 不会清除更新的占用，也不会复活已结束的任务。本界面没有在等待对应请求的批次或单项写操作结束时
 * （例如重新载入之后才看到的操作），重新读取本地列表。
 */
export function applyActivity(s: ActivitySnapshot): boolean {
  const prev = state.activity;
  if (prev && s.instance === prev.instance && s.rev <= prev.rev) return false;
  if (prev && s.instance !== prev.instance) {
    // 另一次运行的主进程：任务编号重新开始，之前的进度与终态记录作废
    progressByTask.clear();
    endedTasks.clear();
    settledTasks.clear();
  }
  state.activity = s;
  state.activityError = null;
  const live = new Set(s.tasks.map((x) => x.taskId));
  for (const [id, p] of progressByTask) if (p.rev <= s.rev || !live.has(id)) progressByTask.delete(id);
  for (const [id, rev] of endedTasks) if (rev <= s.rev) endedTasks.delete(id);
  if (prev && prev.instance === s.instance) markEndedTargets(prev, s);
  activitySink(s);
  emit('local');
  return true;
}

/**
 * 结束后需要重新读取完整列表的目标（批次或单项写操作结束、而本界面没有在等待对应请求的回复，例如重新载入之后才看到的操作）。
 * 值是标记时最后发出的列表读取序号：序号不大于它的读取可能在结束之前读出（回收站、未托管目录等不会由提交记录补全），
 * 这样的回复到达后再读一次；之后发出的读取一定在结束之后，回复到达时标记清除。列表尚未就绪、正在读取其他目标时标记保留，
 * 不会套用到其他目标。
 */
const staleTargets = new Map<string, number>();

function markEndedTargets(prev: ActivitySnapshot, s: ActivitySnapshot): void {
  const ended: Target[] = [];
  for (const b of prev.batches) {
    if (!s.batches.some((x) => x.batchId === b.batchId) && !isBusy(updateAllKey(b))) ended.push(b);
  }
  for (const r of prev.reservations) {
    const still = s.reservations.some((x) => onTarget(x, r) && x.modId === r.modId && x.kind === r.kind);
    if (!still && !isBusy(modKey(r, r.modId))) ended.push(r);
  }
  if (ended.length === 0) return;
  state.writeEpoch++;
  for (const t of ended) staleTargets.set(targetKey(t), localSeq);
  // 当前显示的目标已结束、且没有进行中的读取：立即重新读取；有进行中的读取时，由它的回复决定是否再读
  const t = currentTarget();
  if (t && staleTargets.has(targetKey(t)) && !state.localLoading) void refreshLocal();
}

let activitySeq = 0;

/** 获取主进程的活动状态（启动时与用户重试）；失败只在尚未取得任何状态时显示，不覆盖已收到的更新状态 */
export async function syncActivity(): Promise<void> {
  const seq = ++activitySeq;
  try {
    applyActivity(await api().activityState());
  } catch (err) {
    if (seq === activitySeq && !state.activity) {
      state.activityError = errMsg(err);
      emit('local');
    }
  }
}

/**
 * 主进程的任务事件：按 目标 + 插件编号 关联到行（label 只用于显示）。是否进行中、处于哪个阶段以活动状态为准；
 * 事件负责下载字节数（按 rev 与快照比较新旧）与终态：终态只结算一次，失败 / 取消保留为行内说明，
 * done 带有提交记录时立即更新这一行。下载百分比只在整数变化时通知，并且只就地更新进度文字。
 */
export function applyTask(e: TaskEvent): void {
  const t: Target = { flavorId: e.flavorId, root: e.root };
  const key = taskKey(t, e.modId);
  if (isFinalPhase(e.phase)) {
    if (settledTasks.has(e.taskId)) return;
    settledTasks.add(e.taskId);
    state.writeEpoch++;
    if (!state.activity || e.rev > state.activity.rev) endedTasks.set(e.taskId, e.rev);
    progressByTask.delete(e.taskId);
    if (e.phase === 'done') {
      state.notes.delete(key);
      if (e.installed) applyInstalled(t, e.modId, e.installed);
    } else {
      state.notes.set(key, { taskId: e.taskId, phase: e.phase as 'failed' | 'cancelled', message: e.message ?? null });
    }
    emit('local');
    return;
  }
  if (e.phase !== 'downloading' || settledTasks.has(e.taskId)) return;
  const prev = progressByTask.get(e.taskId);
  if ((prev && prev.rev >= e.rev) || (state.activity && state.activity.rev >= e.rev)) return;
  const before = rowTask(e.modId, t)?.percent;
  progressByTask.set(e.taskId, { rev: e.rev, received: e.received ?? null, total: e.total ?? null });
  if (rowTask(e.modId, t)?.percent !== before) emit('progress');
}

/**
 * 已提交的安装记录：当前显示的正是这个目标时立即更新该行，不等待目录锁之后的完整刷新。
 * 目录只登记本次提交的目录；TOC 要等完整刷新才知道，不沿用旧版本的。
 * 进行中的刷新可能在提交之前就读取了清单：重新发起一次刷新（localSeq 递增），旧请求的回复到达时被丢弃；
 * 新请求在收到这条事件之后才发出，读到的一定是提交之后的清单。
 */
function applyInstalled(t: Target, modId: string, r: InstalledRecord): void {
  const view: ManagedProjectView = {
    modId, flavorId: r.flavorId, name: r.name, logo: r.logo, fileId: r.fileId, version: r.version,
    folders: r.folders.map((name) => ({ name, present: true })), installedAt: r.installedAt, toc: null,
  };
  // 列表正在读取（包括切换版本后列表尚未就绪）：已发出的读取可能读的是提交之前的清单，回复时叠加这条记录
  if (state.localLoading) pendingInstalled.set(taskKey(t, modId), { t, view, seq: localSeq });
  const local = state.local;
  if (!local || local.flavorId !== t.flavorId || local.profile.root !== t.root) return;
  const i = local.managed.findIndex((p) => p.modId === modId);
  state.local = { ...local, managed: i < 0 ? [...local.managed, view] : local.managed.map((p, j) => (j === i ? view : p)) };
  if (state.localLoading) void refreshLocal();
}

// ---------- 本地状态加载（请求序号丢弃过期响应） ----------

let localSeq = 0;

/**
 * 列表读取期间收到的提交记录（按 目标 + 插件编号）；seq 是记录时最后发出的读取序号。
 * 序号不大于 seq 的读取可能读的是提交之前的清单：它的回复属于同一目标、且该插件仍在列表中时，用这条记录替换；
 * 之后发出的读取一定读到提交之后的清单，它的回复到达时记录作废。不会套用到其他目标（例如已改绑的目录）。
 */
const pendingInstalled = new Map<string, { t: Target; view: ManagedProjectView; seq: number }>();

function withPendingInstalled(r: LocalState, seq: number): LocalState {
  let managed = r.managed;
  for (const [k, p] of pendingInstalled) {
    if (p.seq < seq) {
      pendingInstalled.delete(k);
      continue;
    }
    if (r.flavorId !== p.t.flavorId || r.profile.root !== p.t.root) continue;
    managed = managed.map((m) => (m.modId === p.view.modId ? p.view : m));
  }
  return managed === r.managed ? r : { ...r, managed };
}

export async function refreshLocal(): Promise<void> {
  const seq = ++localSeq;
  let again = false;
  const fid = state.flavorId;
  state.localLoading = true;
  emit('local');
  try {
    const r = await api().localState(fid);
    if (seq !== localSeq) return;
    state.local = withPendingInstalled(r, seq);
    state.localError = null;
    // 目录可能已在别处换绑：只刷新也要丢弃属于旧目录的检查结果
    syncUpdatesFromWatch();
    if (r.profile.root) {
      const k = targetKey({ flavorId: r.flavorId, root: r.profile.root });
      const mark = staleTargets.get(k);
      if (mark !== undefined) {
        if (seq > mark) staleTargets.delete(k);
        else again = true;
      }
    }
  } catch (err) {
    if (seq !== localSeq) return;
    state.localError = errMsg(err);
  } finally {
    if (seq === localSeq) {
      state.localLoading = false;
      emit('local');
    }
  }
  // 这次读取可能早于目标上操作的结束：再读一次（新读取的序号大于标记，最多补读一次）
  if (again && seq === localSeq) void refreshLocal();
}

/** 切换 flavor：清空所有与 flavor 相关的数据后重新加载 */
export function setFlavor(id: number): void {
  state.flavorId = id;
  localSeq++;
  updateSeq++;
  state.local = null;
  state.localError = null;
  state.updates = new Map();
  state.updatesChecked = false;
  state.updatesFor = null;
  // 失败 / 取消的行内说明只在当次查看中保留；进行中的任务继续跟踪（来自主进程状态）
  state.notes.clear();
  emit('flavor');
  void refreshLocal();
}

// ---------- 游戏目录 ----------

/** 弹出系统目录选择；返回是否绑定成功 */
export async function bindDirectory(): Promise<boolean> {
  const fid = state.flavorId;
  if (isBusy('bind')) return false;
  state.busy.add('bind');
  emit('local');
  try {
    const p = await api().bindProfile(fid);
    if (!p) return false;
    if (fid === state.flavorId) await refreshLocal();
    if (p.root) toast(`已绑定游戏目录：${p.addonsPath ?? p.root}`, 'success');
    return !!p.root;
  } catch (err) {
    toast(errMsg(err), 'error');
    return false;
  } finally {
    state.busy.delete('bind');
    emit('local');
  }
}

/** 解除当前版本的目录绑定：确认前记录目标，确认后复核，主进程再按期望目录比对 */
export async function unbindDirectory(): Promise<void> {
  if (isBusy('bind')) return;
  const t = requireTarget();
  if (!t) return;
  const ok = await confirmDialog({
    title: '解除游戏目录绑定？',
    message: '只会让艾泽魔方忘记这个目录，不会删除或修改任何插件文件。之后可以重新选择。',
    detail: [t.root],
    confirmText: '解除绑定',
  });
  if (!ok || isBusy('bind') || !stillTarget(t)) return;
  const fid = t.flavorId;
  state.busy.add('bind');
  emit('local');
  try {
    await api().unbindProfile(fid, t.root);
    toast('已解除游戏目录绑定（不会删除任何文件）', 'success');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('bind');
    if (fid === state.flavorId) {
      state.updates = new Map();
      state.updatesChecked = false;
      state.updatesFor = null;
      await refreshLocal();
    } else emit('local');
  }
}

/** 安装前确保当前 flavor 已绑定目录；未绑定则引导选择，取消返回 false */
export async function ensureBound(): Promise<boolean> {
  if (!state.local) await refreshLocal();
  if (state.local?.profile.root) return true;
  return bindDirectory();
}

// ---------- 写操作统一封装 ----------

/** 写操作结果中逐条显示的提示上限；超过时合并显示 */
const MAX_SEPARATE_WARNINGS = 4;
const MERGED_WARNINGS_MS = 15000;

/** 执行写操作：防重复、toast 结果与警告、完成后刷新本地状态 */
export async function runWrite(key: string, fn: () => Promise<OpResult>): Promise<OpResult | null> {
  if (isBusy(key)) return null;
  state.busy.add(key);
  emit('local');
  let result: OpResult | null = null;
  try {
    result = await fn();
    if (result.ok) toast(result.message || '操作完成', 'success');
    else if (result.message) toast(result.message, 'info');
    const warnings = result.warnings ?? [];
    // toast 最多保留 5 条（其中一条是结果）：提示更多时合并为一条可滚动的提示，避免前面的被挤掉
    if (warnings.length > MAX_SEPARATE_WARNINGS) toast(warnings.join('\n'), 'warn', MERGED_WARNINGS_MS, true);
    else for (const w of warnings) toast(w, 'warn');
    // 操作本身的结果不变；记录未保存单独提示（页面上的提示条会一直显示到保存成功）
    if (result.historyError) toast(result.historyError, 'warn');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete(key);
    state.writeEpoch++;
    await refreshLocal();
  }
  return result;
}

// ---------- 检查更新 ----------

let updateSeq = 0;

export async function checkUpdates(silent = false): Promise<void> {
  if (isBusy('check')) return;
  const t = requireTarget();
  if (!t) return;
  const seq = ++updateSeq;
  state.busy.add('check');
  emit('local');
  try {
    // 回复是主进程的权威快照：按 rev 合并（晚到的回复不会覆盖更新的快照），界面结果只来自快照
    applyWatch(await api().checkUpdates(t.flavorId, t.root));
    // 提示只针对发起时的版本与目录
    const now = currentTarget();
    if (seq !== updateSeq || !now || now.flavorId !== t.flavorId || now.root !== t.root) return;
    const items = currentWatchEntry()?.items ?? [];
    if (!silent) {
      const managed = state.local?.managed ?? [];
      const checked = items.filter((i) => !i.skipped);
      const errors = checked.filter((i) => i.error).length;
      const skipped = items.length - checked.length;
      const skipNote = skipped ? `；${skipped} 个其他游戏版本来源的插件未检查` : '';
      if (errors > 0 && errors === checked.length) {
        toast(`检查更新失败（${errors} 个插件），请检查网络后重试${skipNote}`, 'error');
      } else if (state.watch?.policyError) {
        // 更新策略不可用：无法确认可更新状态，绝不说“均为最新”；真实的新版本数量照常列出
        const known = managed.filter(projectHasUpdate).length;
        const parts = ['更新策略不可用，无法确认可更新状态'];
        if (known) parts.push(`${known} 个插件有新版本`);
        if (errors) parts.push(`${errors} 个插件检查失败`);
        toast(`${parts.join('；')}${skipNote}`, 'warn');
      } else {
        // 分别列出数量：可更新、已暂停但有新版本、检查失败；都没有时才说均为最新
        const n = updateCount();
        const paused = managed.filter((p) => projectHasUpdate(p) && isPaused(p.modId)).length;
        const parts: string[] = [];
        if (n) parts.push(`发现 ${n} 个插件可更新`);
        if (paused) parts.push(`${paused} 个已暂停更新的插件有新版本`);
        if (errors) parts.push(`${errors} 个插件检查失败`);
        const head = parts.length ? parts.join('；') : checked.length ? '所有插件均为最新' : '没有可检查的插件';
        toast(`${head}${skipNote}`, errors ? 'warn' : 'success');
      }
    }
  } catch (err) {
    if (seq === updateSeq) toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('check');
    emit('local');
  }
}
