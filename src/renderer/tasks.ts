// 右下角任务面板：显示下载 / 安装进度

import type { TaskEvent, TaskPhase } from '../shared/types';
import { byId, h, mount } from './dom.js';
import { errMsg, formatSize } from './format.js';
import { api } from './state.js';

const PHASE_TEXT: Record<TaskPhase, string> = {
  queued: '排队中',
  checking: '检查中',
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const FINAL: TaskPhase[] = ['done', 'failed', 'cancelled'];

interface TaskView {
  el: HTMLElement;
  timer: number;
  cancelling: boolean;
}

const views = new Map<string, TaskView>();

export function handleTask(e: TaskEvent): void {
  const panel = byId('task-panel');
  let v = views.get(e.taskId);
  if (!v) {
    // 排队中的任务（例如全部更新中尚未开始的项目）不占卡片，开始处理时才出现；从未开始就结束的也不新建卡片
    if (e.phase === 'queued' || FINAL.includes(e.phase)) return;
    v = { el: h('div', { class: 'task' }), timer: 0, cancelling: false };
    views.set(e.taskId, v);
    panel.appendChild(v.el);
  }
  window.clearTimeout(v.timer);
  v.el.classList.remove('task-fade');
  render(e, v);

  if (FINAL.includes(e.phase)) {
    const view = v;
    const delay = e.phase === 'failed' ? 8000 : 3500;
    view.timer = window.setTimeout(() => {
      view.el.classList.add('task-fade');
      view.timer = window.setTimeout(() => {
        view.el.remove();
        views.delete(e.taskId);
      }, 400);
    }, delay);
  }
}

function render(e: TaskEvent, v: TaskView): void {
  const total = e.total ?? 0;
  const received = e.received ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

  let phase = PHASE_TEXT[e.phase] ?? e.phase;
  if (e.phase === 'downloading') {
    phase += pct !== null ? ` ${pct}%` : received > 0 ? ` ${formatSize(received)}` : '';
  }

  // 进度条宽度：下载阶段按实际比例，其他阶段给出近似位置
  let width: number | null = null;
  if (e.phase === 'downloading') width = pct;
  else if (e.phase === 'verifying' || e.phase === 'installing' || e.phase === 'done') width = 100;
  else if (e.phase === 'failed' || e.phase === 'cancelled') width = pct ?? 100;

  const bar = h('div', { class: 'progress-bar' });
  if (width === null) bar.classList.add('indeterminate');
  else bar.style.setProperty('width', `${width}%`);

  let cancelBtn: HTMLButtonElement | null = null;
  if (e.phase === 'downloading') {
    const btn = h('button', { class: 'btn btn-xs', disabled: v.cancelling }, v.cancelling ? '取消中…' : '取消');
    btn.addEventListener('click', () => {
      v.cancelling = true;
      btn.disabled = true;
      btn.textContent = '取消中…';
      api().cancelTask(e.taskId).catch((err: unknown) => {
        v.cancelling = false;
        btn.disabled = false;
        btn.textContent = '取消';
        console.warn(errMsg(err));
      });
    });
    cancelBtn = btn;
  }

  v.el.className = `task task-${e.phase}`;
  mount(v.el,
    h('div', { class: 'task-head' },
      h('div', { class: 'task-label', text: e.label, title: e.label }),
      cancelBtn,
    ),
    h('div', { class: 'task-phase', text: phase }),
    h('div', { class: 'progress' }, bar),
    e.message && e.phase !== 'downloading' ? h('div', { class: 'task-msg', text: e.message }) : null,
  );
}
