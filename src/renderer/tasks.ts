// 右下角任务面板：显示下载 / 安装进度。卡片按任务编号，来自任务事件与主进程活动状态（界面重新载入后据此恢复），
// 两者按同一序列的 rev 取较新的一方；进入终态后不再被任何快照或事件改变，到期自动移除。

import type { ActivitySnapshot, TaskEvent, TaskPhase } from '../shared/types';
import { byId, h, mount } from './dom.js';
import { errMsg, formatSize } from './format.js';
import { api, taskBytes } from './state.js';

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
  /** 卡片当前内容对应的 rev */
  rev: number;
  final: boolean;
}

/** 卡片显示的内容（任务事件或快照中的任务） */
type CardData = Pick<TaskEvent, 'taskId' | 'label' | 'phase' | 'received' | 'total' | 'message'>;

const views = new Map<string, TaskView>();

function createView(taskId: string): TaskView {
  const v: TaskView = { el: h('div', { class: 'task' }), timer: 0, cancelling: false, rev: -1, final: false };
  views.set(taskId, v);
  byId('task-panel').appendChild(v.el);
  return v;
}

function removeView(taskId: string, v: TaskView): void {
  window.clearTimeout(v.timer);
  v.el.remove();
  views.delete(taskId);
}

export function handleTask(e: TaskEvent): void {
  let v = views.get(e.taskId);
  if (!v) {
    // 排队中的任务（例如全部更新中尚未开始的项目）不占卡片，开始处理时才出现；从未开始就结束的也不新建卡片
    if (e.phase === 'queued' || FINAL.includes(e.phase)) return;
    v = createView(e.taskId);
  }
  // 已结束的卡片不再变化（重复的终态不会重置移除时间）；比卡片当前内容旧的事件忽略
  if (v.final || e.rev <= v.rev) return;
  v.rev = e.rev;
  window.clearTimeout(v.timer);
  v.el.classList.remove('task-fade');
  render(e, v);

  if (FINAL.includes(e.phase)) {
    v.final = true;
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

/**
 * 按主进程活动状态恢复与校正卡片（只在界面接受了这个快照时调用）：进行中、已开始处理的任务没有卡片时补建
 * （沿用同一个任务编号，取消按钮作用于同一个后台任务），内容比快照旧的卡片更新为快照；
 * 快照中已没有、也没有收到终态的卡片移除（不会留下永远“进行中”的卡片）。已结束的卡片不受影响。
 */
export function syncTasks(s: ActivitySnapshot): void {
  const live = new Set<string>();
  for (const t of s.tasks) {
    live.add(t.taskId);
    if (t.phase === 'queued') continue;
    let v = views.get(t.taskId);
    if (v?.final || (v && v.rev >= s.rev)) continue;
    if (!v) v = createView(t.taskId);
    v.rev = s.rev;
    const { received, total } = taskBytes(t, s.rev);
    render({ taskId: t.taskId, label: t.label, phase: t.phase, received: received ?? undefined, total: total ?? undefined }, v);
  }
  for (const [id, v] of [...views]) if (!v.final && !live.has(id) && v.rev < s.rev) removeView(id, v);
}

function render(e: CardData, v: TaskView): void {
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
