// 侧栏底部：客户端版本与“检查更新 / 下载并更新”。状态完全来自主进程，不依赖插件数据源网络。
import type { ClientUpdateState } from '../shared/types';
import { byId, h, mount, toast } from './dom.js';
import { errMsg } from './format.js';
import { api } from './state.js';

/** 侧栏更新区域的固定元素：只在初始化时创建一次，之后只更新属性，保证按钮在进度刷新中保持身份与焦点 */
interface View {
  version: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  update: HTMLButtonElement;
  check: HTMLButtonElement;
  cancel: HTMLButtonElement;
  restartNote: HTMLElement;
}

let view: View | null = null;
let current: ClientUpdateState | null = null;
let pending = false;

function statusText(s: ClientUpdateState): string {
  const v = s.availableVersion ? `v${s.availableVersion}` : '新版本';
  switch (s.status) {
    case 'unsupported':
      return s.message ?? '当前环境不支持自动更新';
    case 'idle':
      return '';
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return '已是最新版本';
    case 'available':
      return s.message ? `${s.message}，${v} 可用` : `发现新版本 ${v}`;
    case 'downloading':
      return `正在下载 ${v}${s.percent !== null ? ` · ${s.percent}%` : '…'}`;
    case 'extracting':
      return '正在校验并解压…';
    case 'waiting':
      return s.message ?? '等待插件操作完成…';
    case 'installing':
      return '正在安装并重新启动…';
    case 'error':
      return s.message ?? '更新失败';
  }
}

async function act(fn: () => Promise<ClientUpdateState>): Promise<void> {
  if (pending) return;
  pending = true;
  render();
  try {
    current = await fn();
  } catch (err) {
    toast(errMsg(err), 'error');
  } finally {
    pending = false;
    render();
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
  if (el.title !== text) el.title = text;
}

function setShown(el: HTMLElement, shown: boolean): void {
  if (el.classList.contains('hidden') === shown) el.classList.toggle('hidden', !shown);
}

function setEnabled(btn: HTMLButtonElement, enabled: boolean): void {
  if (btn.disabled === enabled) btn.disabled = !enabled;
}

function render(): void {
  if (!view) return;
  const s = current;
  if (!s) {
    setText(view.version, '蜂简');
    for (const el of [view.status, view.bar, view.update, view.check, view.cancel, view.restartNote]) setShown(el, false);
    return;
  }
  setText(view.version, `蜂简 v${s.currentVersion}`);
  const text = statusText(s);
  setText(view.status, text);
  setShown(view.status, text !== '');
  view.status.classList.toggle('client-error', s.status === 'error');
  const showProgress = (s.status === 'downloading' || s.status === 'extracting') && s.percent !== null;
  setShown(view.bar, showProgress);
  if (showProgress) view.fill.style.setProperty('width', `${s.percent}%`);
  setShown(view.update, s.canUpdate);
  // 请求进行中由 act() 的 pending 防重入；不在此禁用按钮，避免已获得焦点的按钮失去焦点
  setEnabled(view.update, s.canUpdate);
  setShown(view.check, !s.canUpdate && s.canCheck);
  setEnabled(view.check, s.canCheck);
  if (view.check.textContent !== (s.status === 'error' ? '重试' : '检查更新')) view.check.textContent = s.status === 'error' ? '重试' : '检查更新';
  setShown(view.cancel, s.canCancel);
  setEnabled(view.cancel, s.canCancel);
  setShown(view.restartNote, s.canUpdate);
}

export function initClientUpdate(): void {
  const root = byId('client-update');
  const fill = h('div', { class: 'client-progress-fill' });
  view = {
    version: h('div', { class: 'client-version' }),
    status: h('div', { class: 'client-status hidden' }),
    bar: h('div', { class: 'client-progress hidden' }, fill),
    fill,
    update: h('button', { class: 'btn btn-sm btn-primary hidden', title: '下载并校验后自动安装，蜂简会自动重新启动', on: { click: () => void act(() => api().clientUpdate()) } }, '下载并更新'),
    check: h('button', { class: 'btn btn-sm hidden', on: { click: () => void act(() => api().clientCheck()) } }, '检查更新'),
    cancel: h('button', { class: 'btn btn-sm btn-text hidden', on: { click: () => void act(() => api().clientCancel()) } }, '取消'),
    restartNote: h('div', { class: 'client-note hidden', text: '更新完成后蜂简会自动重新启动' }),
  };
  mount(
    root,
    view.version,
    view.status,
    view.bar,
    h('div', { class: 'client-actions' }, view.update, view.check, view.cancel),
    view.restartNote,
    h('div', { class: 'client-note', text: '仅支持免费公开插件' }),
  );
  render();
  api().onClientState((s) => {
    current = s;
    render();
  });
  api()
    .clientState()
    .then((s) => {
      current = s;
      render();
    })
    .catch(() => undefined);
}
