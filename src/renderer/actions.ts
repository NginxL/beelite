// 插件安装 / 更新动作，以及发现页和详情抽屉共用的操作按钮

import type { ManagedProjectView } from '../shared/types';
import { h, spinner } from './dom.js';
import { api, ensureBound, findManaged, isBlocked, isBusy, projectHasUpdate, runWrite, state } from './state.js';

export const modKey = (modId: string): string => `mod:${modId}`;

export async function installMod(modId: string): Promise<void> {
  const fid = state.flavorId;
  if (isBusy(modKey(modId))) return;
  if (!(await ensureBound())) return;
  if (fid !== state.flavorId) return; // 选目录期间切换了版本，放弃
  await runWrite(modKey(modId), () => api().install(modId, fid));
}

export async function updateProject(p: ManagedProjectView, force: boolean): Promise<void> {
  await runWrite(modKey(p.modId), () => api().update(p.modId, p.flavorId, force));
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
