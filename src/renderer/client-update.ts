// 侧栏底部：客户端版本与“检查更新 / 下载并更新”。状态完全来自主进程，不依赖插件数据源网络。
// 发现新版本后，本次启动中每个构建自动展示一次更新说明（主进程记录是否已提醒，界面重载不会重复）：
// - 只在可以更新、没有其他确认框、没有进行中的操作时弹出，不会插进已有的确认流程（例如永久删除的两次确认之间）；
// - 说明为纯文本（textContent），默认焦点在“稍后”；说明一显示就告知主进程已提醒（不授权下载、不跳过版本），
//   “稍后”不取消、不跳过该版本，侧栏可随时重新查看；
// - 只有点击“下载并更新”才授权更新，并带上弹窗中展示的构建号，构建已变化时不会更新。
import type { ClientUpdateState } from '../shared/types';
import { byId, confirmDialog, h, modalOpen, mount, onModalClosed, toast } from './dom.js';
import { errMsg } from './format.js';
import { activityBusy, activityUnknown, api, on, state } from './state.js';

/** 侧栏更新区域的固定元素：只在初始化时创建一次，之后只更新属性，保证按钮在进度刷新中保持身份与焦点 */
interface View {
  version: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  update: HTMLButtonElement;
  check: HTMLButtonElement;
  cancel: HTMLButtonElement;
  notes: HTMLButtonElement;
  restartNote: HTMLElement;
}

let view: View | null = null;
let current: ClientUpdateState | null = null;
let pending = false;
/** 更新说明弹窗是否打开 */
let notesOpen = false;
/** 本界面中已自动弹出过的构建（主进程的 notice 是权威记录，这里防止确认回执到达前重复弹出） */
const autoShown = new Set<string>();
let promptTimer: ReturnType<typeof setTimeout> | null = null;
const PROMPT_DELAY_MS = 400;

/**
 * 有进行中的操作：本界面已发起的请求，或主进程已知的插件写操作（任意目录；界面重新载入后只能从后者得知）。
 * 只影响是否展示更新说明，不影响侧栏“下载并更新”。
 */
function operationsActive(): boolean {
  return state.busy.size > 0 || activityBusy();
}

/** 采用较新的状态：rev 更小的（过时的回复或事件）丢弃 */
function applyState(s: ClientUpdateState): void {
  if (current && typeof current.rev === 'number' && typeof s.rev === 'number' && s.rev < current.rev) return;
  current = s;
  render();
  schedulePrompt();
}

function notesBody(s: ClientUpdateState): { text: string; note?: string } {
  if (s.notesState === 'ok' && s.releaseNotes) return { text: s.releaseNotes, note: s.notesTruncated ? '更新说明较长，已截断显示。' : undefined };
  if (s.notesState === 'unsupported') return { text: '此版本的更新说明不是纯文本格式，艾泽魔方不予显示。' };
  if (s.notesState === 'unverified') return { text: '更新信息的签名未通过校验，不显示更新说明。' };
  return { text: '此版本未提供更新说明。' };
}

/** 展示更新说明；auto 表示自动弹出 */
async function openNotes(auto: boolean): Promise<void> {
  const s = current;
  if (!s || !s.canUpdate || !s.availableBuild || notesOpen) return;
  // 不叠在已有确认框上，也不插进进行中的操作（例如永久删除的两次确认之间）
  if (modalOpen() || operationsActive()) {
    if (!auto) toast('请先完成当前的确认或操作，再查看更新说明', 'info');
    return;
  }
  const build = s.availableBuild;
  notesOpen = true;
  if (auto) autoShown.add(build);
  const body = notesBody(s);
  let ok = false;
  try {
    const shown = confirmDialog({
      title: `艾泽魔方 v${s.availableVersion ?? build} 可用`,
      message: `当前版本 v${s.currentVersion}，新版本 v${s.availableVersion ?? build}。点击“下载并更新”后才会下载并校验安装包，完成后自动重新启动；“稍后”不会下载，之后可在侧栏的“更新说明”中重新查看。`,
      notes: body.text,
      notesNote: body.note,
      confirmText: '下载并更新',
      cancelText: '稍后',
      focus: 'cancel',
    });
    // 说明已经显示：立即告知主进程，本次启动不再自动提醒这个构建（界面重新载入也不会重复）。只表示已展示，不授权下载，也不跳过版本
    void api().clientAckNotice(build).then(applyState, () => undefined);
    ok = await shown;
  } finally {
    notesOpen = false;
  }
  if (!ok) return;
  if (!current?.canUpdate || current.availableBuild !== build) {
    toast('新版本信息已变化，请重新查看更新说明后再更新', 'warn');
    return;
  }
  await act(() => api().clientUpdate(build));
}

/** 满足条件时自动弹出更新说明；否则等待下一次状态、操作或确认框变化后再判断 */
export function maybePromptNotes(): void {
  const s = current;
  if (!s || !s.notice || !s.canUpdate || !s.availableBuild) return;
  if (notesOpen || pending || autoShown.has(s.availableBuild)) return;
  // 主进程的插件操作状态仍在首次同步：等它到达再判断（获取失败时不因此无限推迟）
  if (modalOpen() || operationsActive() || (activityUnknown() && state.activityError === null)) return;
  void openNotes(true);
}

/** 稍后判断：让同一轮中紧接着打开的确认框（例如第二次确认）先出现 */
function schedulePrompt(): void {
  if (!current?.notice) return;
  if (promptTimer !== null) clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    promptTimer = null;
    maybePromptNotes();
  }, PROMPT_DELAY_MS);
}

function statusText(s: ClientUpdateState): string {
  const v = s.availableVersion ? `v${s.availableVersion}` : '新版本';
  switch (s.status) {
    case 'unsupported':
      return s.message ?? '当前环境不支持自动更新';
    case 'idle':
      return '';
    case 'checking':
      return '正在检查艾泽魔方新版本…';
    case 'up-to-date':
      return '艾泽魔方已是最新版本';
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
    applyState(await fn());
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
    setText(view.version, '艾泽魔方');
    for (const el of [view.status, view.bar, view.update, view.check, view.cancel, view.notes, view.restartNote]) setShown(el, false);
    return;
  }
  setText(view.version, `艾泽魔方 v${s.currentVersion}`);
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
  // 检查失败或超时并已结束后显示“重试”，即使之前发现的新版本仍可更新
  setShown(view.check, s.canCheck && (!s.canUpdate || s.checkFailed === true));
  setEnabled(view.check, s.canCheck);
  if (view.check.textContent !== (s.status === 'error' ? '重试' : '检查更新')) view.check.textContent = s.status === 'error' ? '重试' : '检查更新';
  setShown(view.cancel, s.canCancel);
  setEnabled(view.cancel, s.canCancel);
  const canNotes = s.canUpdate && !!s.availableBuild;
  setShown(view.notes, canNotes);
  setEnabled(view.notes, canNotes);
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
    // 侧栏按钮显示着版本号，点击即授权更新这个构建
    update: h('button', { class: 'btn btn-sm btn-primary hidden', title: '下载并校验后自动安装，艾泽魔方会自动重新启动', on: { click: () => void act(() => api().clientUpdate(current?.availableBuild ?? '')) } }, '下载并更新'),
    check: h('button', { class: 'btn btn-sm hidden', on: { click: () => void act(() => api().clientCheck()) } }, '检查更新'),
    cancel: h('button', { class: 'btn btn-sm btn-text hidden', on: { click: () => void act(() => api().clientCancel()) } }, '取消'),
    notes: h('button', { class: 'btn btn-sm btn-text hidden', title: '查看新版本的更新说明', on: { click: () => void openNotes(false) } }, '更新说明'),
    restartNote: h('div', { class: 'client-note hidden', text: '更新完成后艾泽魔方会自动重新启动' }),
  };
  mount(
    root,
    view.version,
    view.status,
    view.bar,
    h('div', { class: 'client-actions' }, view.update, view.check, view.cancel, view.notes),
    view.restartNote,
    h('div', { class: 'client-note', text: '仅支持免费公开插件' }),
  );
  render();
  // 进行中的操作结束、确认框关闭后，再判断是否可以展示被推迟的更新说明
  on('local', schedulePrompt);
  onModalClosed(schedulePrompt);
  api().onClientState(applyState);
  api()
    .clientState()
    .then(applyState)
    .catch(() => undefined);
}
