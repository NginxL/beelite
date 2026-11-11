// 插件安装 / 更新动作，以及发现页和详情抽屉共用的操作按钮

import type { ManagedProjectView } from '../shared/types';
import { h, spinner } from './dom.js';
import { toast } from './dom.js';
import {
  activityUnknown, api, batchHoldText, clearTaskNotes, currentTarget, ensureBound, findManaged, isBlocked, isBusy, isFinalPhase, isOtherFlavor, isPaused, isReserved, modBusy,
  modKey, policyBlock, projectHasUpdate, requireTarget, rowTask, runWrite, state, stillTarget,
} from './state.js';

/** 全部更新进行中时插件写入口的说明 */
export const BATCH_REASON = '正在全部更新，完成后可操作';
/** 暂停更新的插件在更新 / 重装位置上的说明 */
export const PAUSED_REASON = '已暂停更新（保留当前版本）。如需更新或重装，请先点「恢复更新」';

/** 更新 / 重装此刻不可用的原因（暂停或策略不可用）；可用时为 null。主进程另有同样的判断 */
export function updateBlock(modId: string): string | null {
  return policyBlock() ?? (isPaused(modId) ? PAUSED_REASON : null);
}

export async function installMod(modId: string): Promise<void> {
  const fid = state.flavorId;
  if (modBusy(modId)) return;
  if (!(await ensureBound())) return;
  if (fid !== state.flavorId) return; // 选目录期间切换了版本，放弃
  const t = requireTarget();
  if (!t || t.flavorId !== fid || modBusy(modId)) return;
  clearTaskNotes(t, modId);
  await runWrite(modKey(t, modId), () => api().install(modId, t.flavorId, t.root));
}

/** 更新或重装：目标是当前显示的版本与目录，而不是插件记录的来源版本；来源版本不同时拒绝（主进程同样拒绝） */
export async function updateProject(p: ManagedProjectView, force: boolean): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  if (p.flavorId !== t.flavorId) {
    toast(`「${p.name}」按其他游戏版本安装，不能用当前版本的文件更新或重装。如需改用当前版本，请先卸载再安装。`, 'error');
    return;
  }
  if (modBusy(p.modId)) return;
  // 暂停的插件与策略不可用时不发出请求（按钮之外的入口同样拦截；主进程也会拒绝）
  const block = updateBlock(p.modId);
  if (block) {
    toast(block, 'warn');
    return;
  }
  clearTaskNotes(t, p.modId);
  // 界面看到的安装记录：主进程在目录锁内核对，期间被卸载、重装或更新时不做改动
  const expected = { fileId: p.fileId, installedAt: p.installedAt };
  await runWrite(modKey(t, p.modId), () => api().update(p.modId, t.flavorId, force, expected, t.root));
}

/** 暂停（保留当前版本）或恢复某个插件在当前目录的更新；与它的其他写操作互斥 */
export async function setPaused(p: ManagedProjectView, paused: boolean): Promise<void> {
  const t = requireTarget();
  if (!t || modBusy(p.modId)) return;
  if (paused && p.flavorId !== t.flavorId) return;
  if (!stillTarget(t)) return;
  await runWrite(modKey(t, p.modId), () => api().setPaused(p.modId, t.flavorId, paused, t.root));
}

/**
 * 根据本地托管状态生成操作按钮。
 * block：额外的禁止安装原因（例如详情里最新文件不可用/不兼容）。
 */
export function modActionButton(mod: { id: string; accessible: boolean }, block: string | null = null): HTMLButtonElement {
  const stop = (fn: () => void) => (e: Event): void => {
    e.stopPropagation();
    fn();
  };
  const t = currentTarget();
  const task = rowTask(mod.id);
  if ((t && (isBusy(modKey(t, mod.id)) || isReserved(t, mod.id))) || (task && !isFinalPhase(task.phase))) {
    return h('button', { class: 'btn btn-sm', disabled: true }, spinner(true), '处理中');
  }
  if (t && activityUnknown()) {
    // 获取失败时不显示“同步中”：说明暂不可用，原因与重试在页面顶部
    return state.activityError
      ? h('button', { class: 'btn btn-sm', disabled: true, title: `无法获取后台插件操作状态：${state.activityError}。请在页面顶部重试` }, '暂不可用')
      : h('button', { class: 'btn btn-sm btn-busy', disabled: true, title: '正在同步后台任务状态，完成后可操作' }, spinner(true), '同步中');
  }
  const blocked = isBlocked() ? '游戏目录当前不可写入' : null;
  const p = findManaged(mod.id);
  if (p && isOtherFlavor(p)) {
    return h('button', { class: 'btn btn-sm', disabled: true, title: '该插件在这个目录中按其他游戏版本安装，不能用当前版本更新；可在「我的插件」中卸载后再安装' }, '其他版本已安装');
  }
  if (p) {
    if (projectHasUpdate(p)) {
      // 暂停或策略不可用：显示原因，不提供更新（恢复在「我的插件」中进行）
      if (isPaused(p.modId)) return h('button', { class: 'btn btn-sm', disabled: true, title: `${PAUSED_REASON}（在「我的插件」中操作）` }, '已暂停更新');
      const policy = policyBlock();
      if (policy) return h('button', { class: 'btn btn-sm', disabled: true, title: policy }, '暂不可更新');
      const hold = batchHoldText();
      if (hold) return h('button', { class: 'btn btn-sm btn-busy', disabled: true, title: BATCH_REASON }, spinner(true), hold);
      const reason = blocked ?? block;
      return h('button', {
        class: 'btn btn-sm btn-primary',
        disabled: !!reason,
        title: reason ?? '更新到最新版本',
        on: { click: stop(() => void updateProject(p, false)) },
      }, '更新');
    }
    return h('button', { class: 'btn btn-sm btn-installed', disabled: true, title: `已安装 ${p.version}` }, '已安装');
  }
  if (!mod.accessible) {
    return h('button', { class: 'btn btn-sm', disabled: true, title: '仅支持免费公开插件' }, '不可安装');
  }
  // 全部更新计划确定之前，主进程不受理这个目录的新安装
  const reason = blocked ?? block ?? (t && modBusy(mod.id) ? BATCH_REASON : null);
  // 卸载后保留的暂停项：可以安装，安装后仍保持暂停
  const pausedNote = t && isPaused(mod.id) ? '；这个插件在当前目录已暂停更新，安装后仍保持暂停' : '';
  return h('button', {
    class: 'btn btn-sm btn-primary',
    disabled: !!reason,
    title: reason ?? `安装到当前游戏版本${pausedNote}`,
    on: { click: stop(() => void installMod(mod.id)) },
  }, '安装');
}
