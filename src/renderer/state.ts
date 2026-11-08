// 全局状态：当前 flavor、本地状态、更新检查结果、进行中的写操作。各页面通过 on() 订阅变化。

import type { AddonWatchEntry, AddonWatchSnapshot, AppConfig, BeeLiteApi, FlavorInfo, InstalledRecord, LocalState, ManagedProjectView, OpResult, TaskEvent, TaskPhase, UpdateCheckItem } from '../shared/types';
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
 * progress：进行中任务的下载百分比变化（只需就地更新进度文字，不重绘页面）
 */
type EventName = 'flavor' | 'local' | 'watch' | 'progress';
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
  /** 进行中的操作键，用于禁用按钮防止重复点击 */
  busy: new Set<string>(),
  /** 安装 / 更新任务的状态，按 目标（版本 + 目录）+ 插件编号 记录；失败与取消的保留为行内说明 */
  tasks: new Map<string, RowTask>(),
  /** 全部更新已给出计划（收到批次项目的“排队中”）的目标；计划之前，可更新的行显示“检查中” */
  batchPlanned: new Set<string>(),
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

export function updateCount(): number {
  return (state.local?.managed ?? []).filter(projectHasUpdate).length;
}

/** 当前目标在快照中的条目 */
export function currentWatchEntry(): AddonWatchEntry | undefined {
  const t = currentTarget();
  if (!t) return undefined;
  return state.watch?.entries.find((e) => e.flavorId === t.flavorId && e.root === t.root);
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

const FINAL_PHASES: readonly TaskPhase[] = ['done', 'failed', 'cancelled'];
export const isFinalPhase = (p: TaskPhase): boolean => FINAL_PHASES.includes(p);
const isActive = (r: RowTask | undefined): boolean => !!r && !isFinalPhase(r.phase);

/** 这个插件在目标上的任务（默认当前目标） */
export function rowTask(modId: string, t: Target | null = currentTarget()): RowTask | undefined {
  return t ? state.tasks.get(taskKey(t, modId)) : undefined;
}

/** 目标（默认当前目标）正在全部更新 */
export function updatingAll(t: Target | null = currentTarget()): boolean {
  return !!t && isBusy(updateAllKey(t));
}

/** 目标正在全部更新时，可更新但没有任务的插件在操作位置上的说明：计划确定之前为“检查中”，之后为“全部更新中” */
export function batchHoldText(t: Target | null = currentTarget()): string | null {
  if (!t || !updatingAll(t)) return null;
  return state.batchPlanned.has(targetKey(t)) ? '全部更新中' : '检查中';
}

/**
 * 当前目标上这个插件的写入口是否被占用：单项操作已发起（含确认与受理之前）、有进行中的任务，
 * 或该目标正在全部更新且插件已托管（从开始检查到批次结束，包括计划确定之前）。
 * 所有入口在调用时同步检查，不只依赖按钮的禁用状态。
 */
export function modBusy(modId: string): boolean {
  const t = currentTarget();
  if (!t) return false;
  return isBusy(modKey(t, modId)) || isActive(rowTask(modId, t)) || (updatingAll(t) && !!findManaged(modId));
}

/** 重新发起操作前清除目标上（或其中一个插件）上次失败 / 取消的说明 */
export function clearTaskNotes(t: Target, modId?: string): void {
  const prefix = modId === undefined ? `${targetKey(t)}\n` : taskKey(t, modId);
  for (const [k, r] of state.tasks) {
    if (isFinalPhase(r.phase) && (modId === undefined ? k.startsWith(prefix) : k === prefix)) state.tasks.delete(k);
  }
}

/** 当前目标有已托管插件正在单独处理（全部更新等它们结束后再开始） */
export function anyModBusy(): boolean {
  const t = currentTarget();
  if (!t) return false;
  return (state.local?.managed ?? []).some((p) => isBusy(modKey(t, p.modId)) || isActive(rowTask(p.modId, t)));
}

/**
 * 主进程的任务事件：按 目标 + 插件编号 关联到行（label 只用于显示）。
 * 同一插件的事件按主进程的发送顺序到达，进行中的阶段直接覆盖；终态只结算同一个任务一次，
 * 重复或迟到的旧任务终态不会清除更晚的任务。done 带有提交记录时立即更新这一行。
 * 下载百分比只在整数变化时通知，并且只就地更新进度文字。
 */
export function applyTask(e: TaskEvent): void {
  const t: Target = { flavorId: e.flavorId, root: e.root };
  const key = taskKey(t, e.modId);
  const prev = state.tasks.get(key);
  if (isFinalPhase(e.phase)) {
    if (!prev || prev.taskId !== e.taskId || isFinalPhase(prev.phase)) return;
    if (e.phase === 'done') {
      state.tasks.delete(key);
      if (e.installed) applyInstalled(t, e.modId, e.installed);
    } else {
      state.tasks.set(key, { taskId: e.taskId, phase: e.phase, percent: null, message: e.message ?? null });
    }
    emit('local');
    return;
  }
  const percent = e.phase === 'downloading' && e.total ? Math.min(100, Math.round(((e.received ?? 0) / e.total) * 100)) : null;
  state.tasks.set(key, { taskId: e.taskId, phase: e.phase, percent, message: null });
  if (e.phase === 'queued' && updatingAll(t)) state.batchPlanned.add(targetKey(t));
  if (!prev || prev.taskId !== e.taskId || prev.phase !== e.phase) emit('local');
  else if (prev.percent !== percent) emit('progress');
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
  } catch (err) {
    if (seq !== localSeq) return;
    state.localError = errMsg(err);
  } finally {
    if (seq === localSeq) {
      state.localLoading = false;
      emit('local');
    }
  }
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
  // 失败 / 取消的行内说明只在当次查看中保留；进行中的任务继续跟踪
  for (const [k, r] of state.tasks) if (isFinalPhase(r.phase)) state.tasks.delete(k);
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
    message: '只会让蜂简忘记这个目录，不会删除或修改任何插件文件。之后可以重新选择。',
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
    for (const w of result.warnings ?? []) toast(w, 'warn');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete(key);
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
      const n = updateCount();
      const checked = items.filter((i) => !i.skipped);
      const errors = checked.filter((i) => i.error).length;
      const skipped = items.length - checked.length;
      const skipNote = skipped ? `；${skipped} 个其他游戏版本来源的插件未检查` : '';
      if (errors === 0) toast(`${n > 0 ? `发现 ${n} 个插件可更新` : checked.length ? '所有插件均为最新' : '没有可检查的插件'}${skipNote}`, 'success');
      else if (errors === checked.length) toast(`检查更新失败（${errors} 个插件），请检查网络后重试${skipNote}`, 'error');
      else toast(`${n > 0 ? `发现 ${n} 个插件可更新，` : ''}${errors} 个插件检查失败，其余已是最新${skipNote}`, 'warn');
    }
  } catch (err) {
    if (seq === updateSeq) toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('check');
    emit('local');
  }
}
