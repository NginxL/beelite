// 全局状态：当前 flavor、本地状态、更新检查结果、进行中的写操作。各页面通过 on() 订阅变化。

import type { AppConfig, BeeLiteApi, FlavorInfo, LocalState, ManagedProjectView, OpResult, UpdateCheckItem } from '../shared/types';
import { toast } from './dom.js';
import { errMsg } from './format.js';

declare global {
  interface Window {
    beelite: BeeLiteApi;
  }
}

export const api = (): BeeLiteApi => window.beelite;

type EventName = 'flavor' | 'local';
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
  /** 当前 flavor 的更新检查结果，按 modId */
  updates: new Map<string, UpdateCheckItem>(),
  updatesChecked: false,
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

/** 有更新：检查结果说有更新，且本地文件还不是最新文件（更新完成后自动失效） */
export function projectHasUpdate(p: ManagedProjectView): boolean {
  const u = state.updates.get(p.modId);
  return !!u && u.hasUpdate && u.latestFileId !== p.fileId;
}

export function updateCount(): number {
  return (state.local?.managed ?? []).filter(projectHasUpdate).length;
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

export async function unbindDirectory(): Promise<void> {
  const fid = state.flavorId;
  if (isBusy('bind')) return;
  state.busy.add('bind');
  emit('local');
  try {
    await api().unbindProfile(fid);
    toast('已解除游戏目录绑定（不会删除任何文件）', 'success');
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('bind');
    if (fid === state.flavorId) {
      state.updates = new Map();
      state.updatesChecked = false;
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
  const seq = ++updateSeq;
  const fid = state.flavorId;
  state.busy.add('check');
  emit('local');
  try {
    const items = await api().checkUpdates(fid);
    if (seq !== updateSeq || fid !== state.flavorId) return;
    state.updates = new Map(items.map((i) => [i.modId, i]));
    state.updatesChecked = true;
    if (!silent) {
      const n = updateCount();
      const errors = items.filter((i) => i.error).length;
      if (errors === 0) toast(n > 0 ? `发现 ${n} 个插件可更新` : '所有插件均为最新', 'success');
      else if (errors === items.length) toast(`检查更新失败（${errors} 个插件），请检查网络后重试`, 'error');
      else toast(`${n > 0 ? `发现 ${n} 个插件可更新，` : ''}${errors} 个插件检查失败，其余已是最新`, 'warn');
    }
  } catch (err) {
    if (seq === updateSeq) toast(errMsg(err), 'error');
  } finally {
    state.busy.delete('check');
    emit('local');
  }
}
