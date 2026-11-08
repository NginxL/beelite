// 全局提示：无法取得主进程的插件操作状态时，在所有页面（包括默认的发现页）说明原因并提供重试。

import { h, mount } from './dom.js';
import { activityUnknown, on, state, syncActivity } from './state.js';

/** 受影响的入口：托管插件的安装、更新、重装、卸载与全部更新（未托管目录与回收站的操作不受影响） */
export const ACTIVITY_BLOCKED_TEXT = '安装、更新、重装、卸载插件和全部更新暂不可用';

export function initActivityNotice(el: HTMLElement): void {
  let retrying = false;
  const render = (): void => {
    const failed = activityUnknown() && state.activityError !== null;
    el.classList.toggle('hidden', !failed);
    if (!failed) {
      mount(el);
      return;
    }
    mount(el,
      h('span', { text: `无法获取后台插件操作状态，${ACTIVITY_BLOCKED_TEXT}：${state.activityError}` }),
      h('button', {
        class: 'btn btn-sm',
        disabled: retrying,
        on: {
          click: () => {
            retrying = true;
            render();
            void syncActivity().finally(() => {
              retrying = false;
              render();
            });
          },
        },
      }, retrying ? '正在重试…' : '重试'),
    );
  };
  on('local', render);
  render();
}
