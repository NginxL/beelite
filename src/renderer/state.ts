// 全局状态：当前 flavor、本地状态、更新检查结果、进行中的写操作。各页面通过 on() 订阅变化。

import type { AddonWatchEntry, AddonWatchSnapshot, AppConfig, BeeLiteApi, FlavorInfo, LocalState, ManagedProjectView, OpResult, UpdateCheckItem } from '../shared/types';
import { confirmDialog, toast } from './dom.js';
import { errMsg } from './format.js';

declare global {
  interface Window {
    beelite: BeeLiteApi;
  }
}

export const api = (): BeeLiteApi => window.beelite;

/** flavor：切换版本；local：本地状态或按钮状态变化；watch：主进程插件更新检查快照变化 */
type EventName = 'flavor' | 'local' | 'watch';
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
};

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

// ---------- 本地状态加载（请求序号丢弃过期响应） ----------

let localSeq = 0;

export async function refreshLocal(): Promise<void> {
  const seq = ++localSeq;
  const fid = state.flavorId;
  state.localLoading = true;
  emit('local');
  try {
    const r = await api().localState(fid);
    if (seq !== localSeq) return;
    state.local = r;
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
