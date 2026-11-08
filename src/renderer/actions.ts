// 插件安装 / 更新动作，以及发现页和详情抽屉共用的操作按钮

import type { ManagedProjectView } from '../shared/types';
import { h, spinner } from './dom.js';
import { toast } from './dom.js';
import { api, ensureBound, findManaged, isBlocked, isBusy, isOtherFlavor, projectHasUpdate, requireTarget, runWrite, state } from './state.js';

export const modKey = (modId: string): string => `mod:${modId}`;

export async function installMod(modId: string): Promise<void> {
  const fid = state.flavorId;
  if (isBusy(modKey(modId))) return;
  if (!(await ensureBound())) return;
  if (fid !== state.flavorId) return; // 选目录期间切换了版本，放弃
  const t = requireTarget();
  if (!t || t.flavorId !== fid) return;
  await runWrite(modKey(modId), () => api().install(modId, t.flavorId, t.root));
}

/** 更新或重装：目标是当前显示的版本与目录，而不是插件记录的来源版本；来源版本不同时拒绝（主进程同样拒绝） */
export async function updateProject(p: ManagedProjectView, force: boolean): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  if (p.flavorId !== t.flavorId) {
    toast(`「${p.name}」按其他游戏版本安装，不能用当前版本的文件更新或重装。如需改用当前版本，请先卸载再安装。`, 'error');
    return;
  }
  await runWrite(modKey(p.modId), () => api().update(p.modId, t.flavorId, force, t.root));
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
  if (isBusy(modKey(mod.id))) {
    return h('button', { class: 'btn btn-sm', disabled: true }, spinner(true), '处理中');
  }
  const blocked = isBlocked() ? '游戏目录当前不可写入' : null;
  const p = findManaged(mod.id);
  if (p && isOtherFlavor(p)) {
    return h('button', { class: 'btn btn-sm', disabled: true, title: '该插件在这个目录中按其他游戏版本安装，不能用当前版本更新；可在「我的插件」中卸载后再安装' }, '其他版本已安装');
  }
  if (p) {
    if (projectHasUpdate(p)) {
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
  const reason = blocked ?? block;
  return h('button', {
    class: 'btn btn-sm btn-primary',
    disabled: !!reason,
    title: reason ?? '安装到当前游戏版本',
    on: { click: stop(() => void installMod(mod.id)) },
  }, '安装');
}
