// 本地 WTF 恢复（0.3.0）：配置备份页中每份合法备份的「预览恢复…」与恢复对话框，以及全局的「未完成的恢复」提示与处理。
// - 只有用户点击「预览恢复…」才请求主进程读取这份备份与当前完整 WTF；恢复按备份记录的原范围进行。
//   界面不提交任何路径或范围：预览只提交 版本 + 期望目录 + 备份编号，执行只提交预览 token 与两项确认。
// - 预览按 目标（版本 + 目录）采用：对话框打开后当前目标变化过（包括 A→B→A）即作废，不能再执行，只能重新预览；
//   有效期只按本机时间辅助判断，最终由主进程核对目标、绑定、备份与当前 WTF。
// - 预览、执行与处理进行中对话框不能关闭；“取消”只向主进程发出请求，结果以主进程返回为准，不可取消的阶段按钮禁用。
//   进度与取消按钮是对话框中固定的节点，只就地更新（任务快照按 rev 采用，见 backup.ts）。
// - 执行与处理的结果按主进程返回的 outcome 显示并注明原目录，常驻到用户关闭；换目录、关闭对话框都不丢失。
// - 未完成的恢复：启动时只读查询，不自动处理；任意页面顶部都能看到并打开处理对话框（不依赖当前绑定、页面或备份是否启用）。
//   主进程中的恢复 / 处理任务结束时（按任务快照，包括界面重新载入前开始的任务）重新查询；按目录判断能否恢复，与主进程一致。
//   处理只提交 txid 与重新确认的“已退出游戏”；完成后只重新查询未完成的恢复与配置备份状态，
//   不读取插件本地状态（localState / refreshLocal 可能恢复插件事务）。
// - receipts 是登记中已结束事务的最终记录；本次执行 / 处理的结果是调用的返回值，两者分开显示。
// - 所有路径、原因与说明都按纯文本显示（textContent）。

import type {
  BackupLimits, BackupOutcome, BackupScope, BackupSnapshotInfo, BackupTaskInfo, BackupTaskKind, BackupUsage, RestorePendingItem, RestorePendingState, RestorePendingView, RestorePreview,
  RestoreReceiptView, RestoreResolveRunResult, RestoreRunResult, RestoreSettledOutcome,
} from '../shared/types';
import { backupActive, backupTask, bytesText, cancelBackupTask, onBackupTaskChange, phaseText, refreshBackupIfShowing, scopeText } from './backup.js';
import { byId, h, mount, spinner, toast, type Child } from './dom.js';
import { errMsg, formatDateTime } from './format.js';
import { api, currentTarget, emit, flavorName, on, targetKey, type Target } from './state.js';

const BUSY_TITLE = '有备份、校验或恢复正在进行，完成后再操作';

/** 结果、提示所属的原目录；未登记的工作目录可能无法确认游戏版本 */
interface Origin {
  flavorId: number | null;
  root: string;
}

const originText = (o: Origin): string => `「${o.flavorId === null ? '游戏版本未知' : flavorName(o.flavorId)}」${o.root}`;
const wtfPath = (root: string): string => (root.endsWith('/') ? `${root}WTF` : `${root}/WTF`);
const sameOrigin = (a: Origin, b: Origin): boolean => a.flavorId === b.flavorId && a.root === b.root;

// ---------- 未完成的恢复（只读查询） ----------

let pending: RestorePendingView | null = null;
/** 最近一次查询失败的原因（已有结果时保留上次的结果，并提示未能刷新） */
let pendingError: string | null = null;
let pendingLoading = false;
/** 查询期间又请求了一次：结束后补查一轮 */
let pendingDirty = false;

/** 当前的未完成恢复视图（测试只读） */
export function restorePending(): { view: RestorePendingView | null; error: string | null; loading: boolean } {
  return { view: pending, error: pendingError, loading: pendingLoading };
}

/** 回复的基本形状；不符合时按查询失败处理，不把缺失的列表当作“没有” */
function checkPendingView(v: RestorePendingView): RestorePendingView {
  if (!v || !Array.isArray(v.items) || !Array.isArray(v.scanErrors) || !Array.isArray(v.receipts)) throw new Error('未完成恢复的查询结果格式不正确');
  return v;
}

/** 只读查询未完成的恢复（启动时、处理与执行结束后、用户刷新）；不处理、不清理 */
export async function refreshPending(): Promise<void> {
  if (pendingLoading) {
    pendingDirty = true;
    return;
  }
  pendingLoading = true;
  changed();
  try {
    pending = checkPendingView(await api().backupRestorePending());
    pendingError = null;
  } catch (err) {
    pendingError = errMsg(err);
  } finally {
    pendingLoading = false;
    if (pendingDirty) {
      pendingDirty = false;
      void refreshPending();
    } else changed();
  }
}

/** 最近一次采用的任务快照中的任务；undefined 表示还没有采用过任何快照 */
let lastTask: { id: string; kind: BackupTaskKind } | null | undefined;

/**
 * 每次采用任务快照：第一次采用时查询一次（启动查询可能早于快照，期间进行中的恢复可能已经结束）；之后只在恢复或处理任务结束
 * （编号变化）时查询，与发起它的界面是否还在无关（重新载入后同样刷新）。同一任务的进度、预览与备份 / 校验的结束都不查询；
 * 查询中再次请求只补查一轮。然后就地更新对话框的任务行
 */
function onTaskSnapshot(): void {
  const t = backupTask();
  const prev = lastTask;
  lastTask = t ? { id: t.id, kind: t.kind } : null;
  const ended = !!prev && prev.id !== t?.id && (prev.kind === 'restore' || prev.kind === 'restore-resolve');
  if (prev === undefined || ended) void refreshPending();
  updateTask();
}

/**
 * 需要提醒的情况；null 表示最近一次查询成功且确认没有未完成的恢复。
 * 查询失败优先：即使上次查询的结果为空也提醒（此时所有恢复都被禁止，必须能看到原因并重试）
 */
function attention(): { level: 'error' | 'warn'; text: string } | null {
  const parts: string[] = [];
  let level: 'error' | 'warn' = 'warn';
  if (pendingError) {
    level = 'error';
    parts.push(pending
      ? `未完成恢复的状态未能刷新：${pendingError}。刷新成功之前不能执行恢复`
      : `无法查询是否有未完成的 WTF 恢复：${pendingError}。查询成功之前不能执行恢复`);
  }
  if (pending) {
    // 有错误时下面是上次查询的结果
    const prev = pendingError ? '上次查询：' : '';
    if (pending.registryError) {
      level = 'error';
      parts.push(`${prev}恢复登记无法读取，已停止所有恢复，列表可能不完整`);
    }
    if (pending.items.length) parts.push(`${prev}有 ${pending.items.length} 项未完成的 WTF 恢复需要处理`);
    if (pending.scanErrors.length) parts.push(`${prev}${pending.scanErrors.length} 个游戏目录未能检查，其中是否有遗留的恢复内容未知`);
    if (pending.boundRootsError) parts.push(`${prev}已绑定的目录列表无法读取，检查范围不完整`);
  }
  if (!parts.length) return null;
  return { level, text: `${parts.join('；')}。` };
}

/** 侧栏「配置备份」上的待处理标记 */
export function restoreNavBadge(): string | null {
  return attention() ? '待处理' : null;
}

/**
 * 不能为这个目标预览或执行恢复的原因（界面提示；主进程另有同样的检查）：
 * 尚未确认没有未完成的恢复、恢复登记无法读取，或这个目录有未完成的恢复（与主进程相同，只按目录判断，不论属于哪个游戏版本）
 */
export function restoreBlockReason(t: Target): string | null {
  if (!pending) return pendingError ? `无法确认是否有未完成的恢复：${pendingError}` : '正在检查是否有未完成的恢复…';
  if (pendingError) return '未完成恢复的状态未能刷新，请先在顶部的提示中重试';
  if (pending.registryError) return '恢复登记无法读取，已停止所有恢复';
  if (pending.items.some((i) => i.root === t.root)) return '这个目录有未完成的恢复，请先在顶部的提示中查看并处理';
  return null;
}

// ---------- 结果（常驻显示到用户关闭） ----------

type NoticeKind = 'success' | 'warn' | 'error' | 'info';

export interface RestoreNotice {
  origin: Origin;
  kind: NoticeKind;
  title: string;
  lines: string[];
  at: number;
}

let notice: RestoreNotice | null = null;

/** 最近一次执行或处理的结果（配置备份页与处理对话框显示） */
export function restoreNotice(): RestoreNotice | null {
  return notice;
}

export function clearRestoreNotice(): void {
  notice = null;
  changed();
}

function setNotice(n: RestoreNotice): void {
  notice = n;
  const now = currentTarget();
  // 结果属于其他目录：另行提示原目录，不当作当前目录的结果（结果本身仍常驻在配置备份页）
  if (!now || now.flavorId !== n.origin.flavorId || now.root !== n.origin.root) toast(`${originText(n.origin)}：${n.title}`, n.kind, 12000);
}

/** 除正在淡出的之外还有其他确认框（本模块的对话框刚关闭时仍在淡出，不算） */
function otherModalOpen(): boolean {
  return Array.from(byId('modal-root').childNodes as ArrayLike<Node>).some((n) => !(n as Element).classList?.contains('modal-out'));
}

export function restoreOriginText(o: Origin): string {
  return originText(o);
}

// ---------- 合法的备份 ----------

/** 这份备份不能恢复的原因；null 表示可以预览恢复（主进程预览时再完整核对） */
export function notRestorable(x: BackupSnapshotInfo): string | null {
  if (x.status !== 'structure-ok') return '这份备份没有通过结构检查，不能恢复';
  if (!x.scope) return '这份备份的范围无法确认，不能恢复';
  if (!x.createdAt) return '这份备份的清单无法确认，不能恢复';
  if (x.lastVerify && !x.lastVerify.ok) return '这份备份上次内容校验未通过，不能恢复';
  return null;
}

// ---------- 对话框框架：固定标题、独立滚动的内容、固定的任务行与按钮 ----------

interface View {
  kind: 'restore' | 'pending';
  overlay: HTMLElement;
  box: HTMLElement;
  body: HTMLElement;
  task: HTMLElement;
  taskText: HTMLElement;
  /** 固定节点：同一任务期间只改文字与属性，保持焦点 */
  taskCancel: HTMLButtonElement;
  foot: HTMLElement;
  onKey: (e: KeyboardEvent) => void;
  returnFocus: () => void;
  /** 上次渲染的阶段 */
  stage?: string;
}

let view: View | null = null;
let focusKeys = new WeakMap<Element, string>();
let focusEls = new Map<string, HTMLElement>();
/** 当前渲染中可聚焦控件的顺序（Tab 在对话框内循环） */
let order: HTMLElement[] = [];
let footStart = 0;

function fk<T extends HTMLElement>(key: string, el: T): T {
  focusKeys.set(el, key);
  focusEls.set(key, el);
  order.push(el);
  return el;
}

/** 正在进行、不能关闭对话框的任务（预览、执行或处理） */
interface Running {
  kind: BackupTaskKind;
  origin: Origin;
  cancelLabel: string;
  cancelAsked: boolean;
  /** 已看到过对应的任务（任务结束后、结果到达前不再显示“等待开始”） */
  seen?: boolean;
  /** 整个过程都不可取消（处理未完成的恢复） */
  noCancel?: boolean;
  /** 取消请求失败，且之后任务已不可取消或已结束（不再说“已请求取消”） */
  cancelFailed?: boolean;
}

function running(): Running | null {
  if (view?.kind === 'restore' && flow && (flow.stage === 'previewing' || flow.stage === 'applying')) return flow.run;
  if (view?.kind === 'pending' && resolving) return resolving.run;
  return null;
}

function matchTask(r: Running): BackupTaskInfo | null {
  const t = backupTask();
  if (!t || t.kind !== r.kind || t.root !== r.origin.root) return null;
  return r.origin.flavorId === null || t.flavorId === r.origin.flavorId ? t : null;
}

function openView(kind: View['kind'], title: string, returnFocus: () => void): View {
  const taskText = h('span', { class: 'restore-task-text' });
  const taskCancel = h('button', { class: 'btn btn-sm', on: { click: () => cancelRunning() } });
  // 内容区可以用键盘聚焦后滚动
  const body = h('div', { class: 'restore-body', attrs: { tabindex: '0', 'aria-label': '详细内容' } });
  const foot = h('div', { class: 'modal-actions restore-actions' });
  const task = h('div', { class: 'restore-task hidden', attrs: { role: 'status' } }, spinner(true), taskText, taskCancel);
  const box = h('div', { class: 'modal restore-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' } },
    h('div', { class: 'modal-title', text: title }),
    body,
    task,
    foot,
  );
  const overlay = h('div', { class: 'modal-overlay' }, box);
  const v: View = { kind, overlay, box, body, task, taskText, taskCancel, foot, returnFocus, onKey: (e) => onKey(v, e) };
  document.addEventListener('keydown', v.onKey, true);
  byId('modal-root').appendChild(overlay);
  view = v;
  return v;
}

function onKey(v: View, e: KeyboardEvent): void {
  if (view !== v) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    // 进行中不能关闭：关闭对话框不等于取消任务
    if (!running()) closeView();
  } else if (e.key === 'Tab') {
    const list = focusables(v);
    if (list.length === 0) {
      e.preventDefault();
      return;
    }
    const active = (document as { activeElement?: Element | null }).activeElement ?? null;
    const i = active ? list.indexOf(active as HTMLElement) : -1;
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === list.length - 1)) {
      e.preventDefault();
      list[0].focus();
    }
  }
}

function focusables(v: View): HTMLElement[] {
  const enabled = (el: HTMLElement): boolean => !(el as HTMLElement & { disabled?: boolean }).disabled;
  const task = v.task.classList.contains('hidden') ? [] : [v.taskCancel];
  return [v.body, ...order.slice(0, footStart), ...task, ...order.slice(footStart)].filter(enabled);
}

function closeView(): void {
  const v = view;
  if (!v || running()) return;
  view = null;
  document.removeEventListener('keydown', v.onKey, true);
  if (v.kind === 'restore') endFlow();
  else resolveAck.clear();
  v.overlay.classList.add('modal-out');
  window.setTimeout(() => {
    v.overlay.remove();
    // 让等待确认框关闭的提示（例如客户端更新说明）重新判断
    emit('backup');
  }, 150);
  v.returnFocus();
}

/** 重绘对话框内容：保持滚动位置；焦点原本在重绘区域内时还给同一个控件，控件消失或禁用时移到默认控件 */
function renderView(initial = false): void {
  const v = view;
  if (!v) return;
  const active = (document as { activeElement?: Element | null }).activeElement ?? null;
  const key = active ? focusKeys.get(active) : undefined;
  // 阶段变化（预览 → 结果等）时内容整体替换，回到顶部；同一阶段的重绘保持滚动位置
  const stage = v.kind === 'restore' && flow ? flow.stage : 'pending';
  const top = stage === v.stage ? (v.body.scrollTop ?? 0) : 0;
  v.stage = stage;
  focusKeys = new WeakMap();
  focusEls = new Map();
  order = [];
  let def: string;
  if (v.kind === 'restore' && flow) {
    mount(v.body, flowBody(flow));
    footStart = order.length;
    def = flowFoot(flow, v.foot);
  } else {
    mount(v.body, pendingBody());
    footStart = order.length;
    def = pendingFoot(v.foot);
  }
  v.body.scrollTop = top;
  updateTask();
  if (!initial && key === undefined) return;
  const usable = (el: HTMLElement | undefined): el is HTMLElement => !!el && !(el as HTMLElement & { disabled?: boolean }).disabled;
  const want = key !== undefined ? focusEls.get(key) : undefined;
  const target = usable(want) ? want : focusEls.get(def);
  if (usable(target)) target.focus({ preventScroll: true });
  else if (!v.task.classList.contains('hidden') && !v.taskCancel.disabled) v.taskCancel.focus({ preventScroll: true });
  else v.box.focus({ preventScroll: true });
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** 任务行：进度与取消按钮就地更新（同一个按钮节点） */
function updateTask(): void {
  const v = view;
  if (!v) return;
  const r = running();
  if (v.task.classList.contains('hidden') === !!r) v.task.classList.toggle('hidden', !r);
  if (!r) return;
  const task = matchTask(r);
  let text: string;
  let label: string;
  let disabled = true;
  let title = '';
  if (!task) {
    text = r.seen ? '任务已结束，正在等待结果…' : '正在等待主进程开始任务…';
    label = r.cancelLabel;
    title = r.seen ? '任务已结束' : '任务开始后才能取消';
  } else {
    r.seen = true;
    const counts = task.filesTotal > 0 || task.bytesTotal > 0
      ? ` · ${task.filesDone} / ${task.filesTotal} 个文件 · ${bytesText(task.bytesDone)} / ${bytesText(task.bytesTotal)}`
      : '';
    text = `${task.cancelling ? '正在取消…' : phaseText(task)}${counts}`;
    if (r.noCancel) {
      label = '不可取消';
      title = '处理未完成的恢复期间不能取消；退出艾泽魔方也会等待它结束';
    } else if (task.cancellable === false) {
      label = '不可取消';
      title = '正在替换或回滚 WTF，这一步不能中断；退出艾泽魔方也会等待它结束';
      if (r.cancelAsked && !r.cancelFailed) text += ' · 已请求取消，但任务已进入不可取消的阶段，将按实际结果显示';
      else if (r.cancelFailed) text += ' · 取消请求未能送达，任务已进入不可取消的阶段，将按实际结果显示';
    } else if (task.cancelling || r.cancelAsked) {
      label = '正在取消…';
      title = '已请求取消，等待主进程确认';
    } else {
      label = r.cancelLabel;
      disabled = false;
    }
  }
  setText(v.taskText, text);
  setText(v.taskCancel, label);
  if (v.taskCancel.disabled !== disabled) v.taskCancel.disabled = disabled;
  if (v.taskCancel.title !== title) v.taskCancel.title = title;
}

/**
 * 只向主进程请求取消；是否取消以预览 / 执行的返回为准。请求失败时（已提示原因）只有仍是同一任务、
 * 最新快照仍可取消且未在取消时才恢复按钮供重试；已进入不可取消阶段或任务已结束则按最新快照显示
 */
function cancelRunning(): void {
  const r = running();
  if (!r) return;
  const task = matchTask(r);
  if (!task || r.noCancel || task.cancelling || task.cancellable === false || r.cancelAsked) return;
  r.cancelAsked = true;
  updateTask();
  void cancelBackupTask(task).then((res) => {
    if (res !== 'failed' || running() !== r) return;
    const now = matchTask(r);
    if (now && now.id === task.id && now.cancellable !== false && !now.cancelling) r.cancelAsked = false;
    else r.cancelFailed = true;
    updateTask();
  });
}

// ---------- 预览与执行 ----------

type Stage = 'previewing' | 'preview' | 'preview-failed' | 'applying' | 'applied';

interface Flow {
  origin: Target;
  snapshot: BackupSnapshotInfo;
  /** 打开时配置备份页显示的占用与限制（只用于说明，主进程预览时另行核对） */
  usage: BackupUsage | null;
  limits: BackupLimits | null;
  stage: Stage;
  seq: number;
  run: Running;
  preview: RestorePreview | null;
  /** 预览请求发出之后当前目标变化过（包括又变回来）：这份预览不能再执行 */
  targetChanged: boolean;
  /** 预览未能生成或被取消的说明 */
  failure: { cancelled: boolean; message: string } | null;
  ackGame: boolean;
  ackOverwrite: boolean;
  /** 执行的结果（本次调用的返回值） */
  applied: RestoreNotice | null;
  /** 执行结果需要到「未完成的恢复」中继续处理 */
  needsResolve: boolean;
  expiryTimer: number | null;
}

let flow: Flow | null = null;
let flowSeq = 0;

/** 当前恢复对话框的状态（测试只读） */
export function restoreFlow(): { stage: Stage; preview: RestorePreview | null; targetChanged: boolean; ackGame: boolean; ackOverwrite: boolean } | null {
  return flow ? { stage: flow.stage, preview: flow.preview, targetChanged: flow.targetChanged, ackGame: flow.ackGame, ackOverwrite: flow.ackOverwrite } : null;
}

function endFlow(): void {
  if (flow?.expiryTimer !== null && flow?.expiryTimer !== undefined) window.clearTimeout(flow.expiryTimer);
  flow = null;
}

/**
 * 用户点击某份备份的「预览恢复…」：打开对话框并请求主进程读取这份备份与当前完整 WTF（只读）。
 * returnFocus 在对话框关闭时把焦点还给触发的按钮
 */
export function openRestorePreview(t: Target, snapshot: BackupSnapshotInfo, ctx: { usage: BackupUsage | null; limits: BackupLimits | null }, returnFocus: () => void): void {
  if (view) return;
  if (otherModalOpen()) {
    toast('请先完成当前的确认，再预览恢复', 'info');
    return;
  }
  const why = notRestorable(snapshot) ?? restoreBlockReason(t) ?? (backupActive() ? BUSY_TITLE : null);
  if (why) {
    toast(why, 'warn');
    return;
  }
  const now = currentTarget();
  if (!now || targetKey(now) !== targetKey(t)) {
    toast('游戏版本或目录已变更，请在新的目录中重新选择备份', 'warn');
    return;
  }
  flow = {
    origin: { flavorId: t.flavorId, root: t.root },
    snapshot,
    usage: ctx.usage,
    limits: ctx.limits,
    stage: 'previewing',
    seq: 0,
    run: { kind: 'restore-preview', origin: t, cancelLabel: '取消预览', cancelAsked: false },
    preview: null,
    targetChanged: false,
    failure: null,
    ackGame: false,
    ackOverwrite: false,
    applied: null,
    needsResolve: false,
    expiryTimer: null,
  };
  openView('restore', `预览恢复：${snapshot.id}`, returnFocus);
  void runPreview(flow);
}

/** 重新预览：只能在当前目标仍是原目录时 */
function canRepreview(f: Flow): string | null {
  const now = currentTarget();
  if (!now || targetKey(now) !== targetKey(f.origin)) return '当前显示的已不是这个目录，请关闭后在对应的目录中重新选择备份';
  return restoreBlockReason(f.origin) ?? (backupActive() ? BUSY_TITLE : null);
}

async function runPreview(f: Flow): Promise<void> {
  const my = ++flowSeq;
  f.seq = my;
  f.stage = 'previewing';
  f.preview = null;
  f.failure = null;
  f.ackGame = false;
  f.ackOverwrite = false;
  f.targetChanged = false;
  f.run = { kind: 'restore-preview', origin: f.origin, cancelLabel: '取消预览', cancelAsked: false };
  if (f.expiryTimer !== null) window.clearTimeout(f.expiryTimer);
  f.expiryTimer = null;
  renderView(true);
  let out: BackupOutcome<RestorePreview> | null = null;
  let error: string | null = null;
  try {
    out = await api().backupRestorePreview(f.origin.flavorId, f.origin.root, f.snapshot.id);
  } catch (err) {
    error = errMsg(err);
  }
  if (flow !== f || f.seq !== my) return;
  if (!out) {
    f.stage = 'preview-failed';
    f.failure = { cancelled: false, message: error ?? '预览没有正常完成' };
  } else if (out.status === 'cancelled') {
    f.stage = 'preview-failed';
    f.failure = { cancelled: true, message: out.message };
  } else {
    const p = out.result;
    if (p.flavorId !== f.origin.flavorId || p.root !== f.origin.root || p.snapshotId !== f.snapshot.id) {
      f.stage = 'preview-failed';
      f.failure = { cancelled: false, message: '收到的预览与请求的目录或备份不符，已丢弃' };
    } else {
      f.preview = p;
      f.stage = 'preview';
      armExpiry(f, p);
    }
  }
  renderView(true);
}

/** 有效期到达时重绘（只是本机时间的辅助判断） */
function armExpiry(f: Flow, p: RestorePreview): void {
  if (p.expiresAt === null || !p.token) return;
  const ms = Math.min(2_147_483_647, Math.max(0, p.expiresAt - Date.now()) + 50);
  f.expiryTimer = window.setTimeout(() => {
    f.expiryTimer = null;
    if (flow === f) renderView();
  }, ms);
}

function expired(p: RestorePreview): boolean {
  return p.expiresAt !== null && Date.now() >= p.expiresAt;
}

/** 执行受阻的原因；null 表示可以执行（主进程仍会完整核对） */
function applyBlock(f: Flow): string | null {
  const p = f.preview;
  if (f.stage !== 'preview' || !p) return '尚未生成预览';
  if (f.targetChanged) return '打开预览后游戏版本或目录发生过变化，这份预览已作废，请重新预览';
  if (p.blockers.length || !p.token) return '有不能恢复的原因（见上方），不能执行';
  if (expired(p)) return '这份预览已过期，请重新预览';
  if (backupActive()) return BUSY_TITLE;
  const block = restoreBlockReason(f.origin);
  if (block) return block;
  if (!f.ackGame || !f.ackOverwrite) return '请先勾选上面的两项确认';
  return null;
}

async function runApply(f: Flow): Promise<void> {
  const p = f.preview;
  if (applyBlock(f) || !p?.token) return;
  const token = p.token;
  f.stage = 'applying';
  f.run = { kind: 'restore', origin: f.origin, cancelLabel: '取消恢复', cancelAsked: false };
  if (f.expiryTimer !== null) window.clearTimeout(f.expiryTimer);
  f.expiryTimer = null;
  renderView(true);
  let out: BackupOutcome<RestoreRunResult> | null = null;
  let error: string | null = null;
  try {
    out = await api().backupRestoreApply(token, { gameClosed: true, overwrite: true });
  } catch (err) {
    error = errMsg(err);
  }
  const n = applyNotice(f, p, out, error);
  f.applied = n;
  f.needsResolve = !out || (out.status === 'completed' && (out.result.outcome === 'unconfirmed' || out.result.outcome === 'blocked' || out.result.cleanupPending));
  f.stage = 'applied';
  setNotice(n);
  // 执行结束后只重新查询未完成的恢复与配置备份状态（不读取插件本地状态）
  void refreshPending();
  refreshBackupIfShowing(f.origin);
  changed();
  if (flow === f) renderView(true);
}

function applyNotice(f: Flow, p: RestorePreview, out: BackupOutcome<RestoreRunResult> | null, error: string | null): RestoreNotice {
  const base = [`来源备份：${f.snapshot.id}（${formatDateTime(p.snapshotCreatedAt)}）`, `范围：${scopeText(p.scope)}`];
  const at = Date.now();
  if (!out) {
    return {
      origin: f.origin, kind: 'error', at, title: '恢复没有正常完成',
      lines: [error ?? '原因未知', ...base, 'WTF 是否被改动以「未完成的恢复」中的状态为准，请在顶部的提示中查看。'],
    };
  }
  if (out.status === 'cancelled') {
    return { origin: f.origin, kind: 'info', at, title: '恢复已取消', lines: [out.message, ...base] };
  }
  const r = out.result;
  const safety = r.safetySnapshotId
    ? `恢复前备份：${r.safetySnapshotId}`
    : p.baseline === 'absent' ? '恢复前当前目录没有 WTF，没有生成恢复前备份' : '没有生成恢复前备份';
  const lines = [r.message, ...base, safety, ...r.warnings, `恢复编号：${r.txid}`].filter((l) => l !== '');
  switch (r.outcome) {
    case 'committed':
      if (r.cleanupPending) return { origin: f.origin, kind: 'warn', at, title: '已恢复，但收尾未完成', lines: [...lines, '剩余的收尾需要在顶部「未完成的恢复」中处理。'] };
      return { origin: f.origin, kind: r.warnings.length ? 'warn' : 'success', at, title: '已恢复', lines };
    case 'rolled-back':
      return { origin: f.origin, kind: 'warn', at, title: '没有恢复：替换中出错，已回滚到恢复前', lines };
    case 'unconfirmed':
      return { origin: f.origin, kind: 'error', at, title: '恢复结果未确认：已替换，但提交记录未能确认写入', lines: [...lines, '请在顶部「未完成的恢复」中处理。'] };
    case 'blocked':
      return { origin: f.origin, kind: 'error', at, title: '恢复被阻止：无法确认状态，已保留现场', lines: [...lines, '请在顶部「未完成的恢复」中查看并处理。'] };
    default:
      return { origin: f.origin, kind: 'error', at, title: '收到无法识别的恢复结果', lines: [...lines, '请在顶部「未完成的恢复」中查看。'] };
  }
}

// ---------- 预览内容 ----------

function scopeBanner(s: BackupScope): HTMLElement {
  if (s.kind === 'all') return h('div', { class: 'banner banner-warn', text: '将按这份备份恢复整个 WTF：所有账号与角色的配置，以及 WTF 根级的游戏全局设置。' });
  if (s.kind === 'account') return h('div', { class: 'banner banner-warn', text: `将恢复账号「${s.account}」的完整目录：该账号下所有角色、账号共享配置（SavedVariables）与其他文件。其他账号与 WTF 根级的游戏全局设置保持不变。` });
  return h('div', { class: 'banner banner-error restore-shared' },
    h('div', { class: 'restore-strong', text: `注意：按角色恢复也会恢复账号「${s.account}」共享的 SavedVariables（含 .bak）与账号直属文件。` }),
    h('div', { text: '这些是同一账号下所有角色共用的插件设置：同账号的其他角色（包括没有选中的角色）的这部分设置也会变成备份时的内容。' }),
    h('div', { text: `恢复的角色：${s.characters.map((c) => `${c.character}（${c.realm}）`).join('、')}` }),
  );
}

function countCell(label: string, n: number, cls = ''): HTMLElement {
  return h('div', { class: `restore-count${cls ? ` ${cls}` : ''}` },
    h('div', { class: 'restore-count-n', text: String(n) }),
    h('div', { class: 'restore-count-k', text: label }),
  );
}

function sampleList(title: string, list: string[], total: number, unit: string): Child {
  if (total === 0) return null;
  return h('div', null,
    h('div', { class: 'restore-section-title', text: `${title}（共 ${total} ${unit}${list.length < total ? `，列出 ${list.length} 个示例` : ''}）` }),
    list.length ? h('ul', { class: 'restore-samples mono' }, list.map((x) => h('li', { text: x }))) : null,
  );
}

function kv(rows: [string, string][]): HTMLElement {
  return h('dl', { class: 'restore-kv' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
}

const sizeOf = (x: { files: number; dirs: number; bytes: number }): string => `${x.files} 个文件、${x.dirs} 个文件夹，${bytesText(x.bytes)}`;
const freeText = (n: number | null): string => (n === null ? '可用空间无法读取' : `可用 ${bytesText(n)}`);

function previewParts(f: Flow, p: RestorePreview): Child[] {
  const c = p.counts;
  const out: Child[] = [];
  out.push(kv([
    ['来源备份', `${p.snapshotId} · 创建于 ${formatDateTime(p.snapshotCreatedAt)}${p.snapshotAppVersion ? ` · 艾泽魔方 v${p.snapshotAppVersion}` : ''}${f.snapshot.purpose === 'pre-restore' ? ' · 恢复前自动备份' : ''}`],
    ['恢复到', `「${flavorName(p.flavorId)}」${wtfPath(p.root)}`],
    ['范围', `${scopeText(p.scope)}（备份记录的原范围，不能更改）`],
    ['当前 WTF', p.current ? sizeOf(p.current) : '当前游戏目录中没有 WTF 文件夹'],
    ['恢复后 WTF', sizeOf(p.candidate)],
    ['预览有效至', p.expiresAt === null ? '—' : `${formatDateTime(p.expiresAt)}（以主进程执行时的核对为准）`],
  ]));
  out.push(scopeBanner(p.scope));
  if (p.notes.length) out.push(h('div', { class: 'banner banner-warn backup-lines' }, p.notes.map((n) => h('div', { text: n }))));
  if (p.blockers.length) {
    out.push(h('div', { class: 'banner banner-error' },
      h('div', { class: 'restore-strong', text: '不能执行这次恢复：' }),
      h('div', { class: 'backup-lines' }, p.blockers.map((b) => h('div', { text: b }))),
    ));
  }
  out.push(h('div', { class: 'restore-section-title', text: '范围内的变化' }));
  out.push(h('div', { class: 'restore-counts' },
    countCell('新增文件', c.addFiles),
    countCell('覆盖文件', c.overwriteFiles),
    countCell('内容相同（仍会重新写入）', c.sameFiles),
    countCell('删除文件', c.deleteFiles, c.deleteFiles ? 'restore-count-del' : ''),
    countCell('新建文件夹', c.addDirs),
    countCell('删除文件夹（连同其中内容）', c.deleteDirs, c.deleteDirs ? 'restore-count-del' : ''),
  ));
  out.push(h('div', { class: 'backup-meta', text: `写入 ${bytesText(c.writeBytes)} · 删除 ${bytesText(c.deleteBytes)}` }));
  if (c.deleteFiles || c.deleteDirs) {
    out.push(h('div', { class: 'banner banner-warn', text: `范围内当前有、这份备份中没有的 ${c.deleteFiles} 个文件与 ${c.deleteDirs} 个文件夹会被删除（之后的新角色、新插件设置等）。` }));
  }
  out.push(sampleList('将新增', p.samples.add, c.addFiles, '个文件'));
  out.push(sampleList('将覆盖', p.samples.overwrite, c.overwriteFiles, '个文件'));
  out.push(sampleList('将删除', p.samples.delete, c.deleteFiles + c.deleteDirs, '个文件与文件夹'));
  if (p.samples.truncated) out.push(h('div', { class: 'backup-meta', text: '示例只列出了部分路径（相对 WTF）。' }));
  out.push(h('div', { class: 'restore-section-title', text: '范围外' }));
  out.push(h('div', {
    text: p.scope.kind === 'all'
      ? '恢复范围是全部 WTF，没有范围外的内容：整个 WTF 会与这份备份一致。'
      : `范围外的 ${sizeOf(p.kept)} 保持不变。`,
  }));
  out.push(h('div', { class: 'restore-section-title', text: '恢复前备份与空间' }));
  out.push(...safetyParts(f, p));
  return out;
}

function safetyParts(f: Flow, p: RestorePreview): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (p.baseline === 'absent' || !p.safetyCopy.required) {
    out.push(h('div', { class: 'banner banner-warn', text: '当前游戏目录中没有 WTF 文件夹：不会生成恢复前备份。恢复之后没有可以回到“恢复前”的备份（恢复前本来就没有 WTF）。' }));
  } else {
    out.push(h('div', { text: `执行时会先把当前完整的 WTF（${p.safetyCopy.entries} 个文件与文件夹，${bytesText(p.safetyCopy.bytes)}）复制为一份新的「恢复前备份」，保存在当前备份位置，计入份数与容量上限；之后不会自动删除。` }));
    if (p.scope.kind !== 'all') out.push(h('div', { class: 'backup-meta', text: '即使只恢复部分范围，恢复前备份也包含完整的 WTF，所需时间与空间按完整 WTF 计算。' }));
  }
  const s = p.space;
  out.push(h('div', { class: 'backup-meta', text: `备份位置需要 ${bytesText(s.backupVolumeNeeded)}（${freeText(s.backupVolumeFree)}）；游戏目录所在磁盘需要 ${bytesText(s.gameVolumeNeeded)}（${freeText(s.gameVolumeFree)}）` }));
  if (s.sameVolume) out.push(h('div', { class: 'backup-meta', text: '备份位置与游戏目录在同一磁盘上，两者需要的空间合计计算。' }));
  const u = f.usage;
  const l = f.limits;
  if (u) {
    const least = u.confirmed ? '' : '至少 ';
    out.push(h('div', { class: 'backup-meta', text: `打开预览时备份位置已用 ${least}${bytesText(u.bytes)} / 上限 ${bytesText(u.maxBytes)} · ${least}${u.count} / ${u.maxCount} 份${l ? `；单份最多 ${bytesText(l.maxSnapshotBytes)}、${l.maxEntries} 个文件与文件夹` : ''}。是否超限以主进程的检查为准（见上方不能执行的原因）。` }));
  }
  return out;
}

function flowBody(f: Flow): Child[] {
  const out: Child[] = [];
  out.push(h('div', { class: 'note restore-intro' },
    h('div', { text: '只有点击「执行恢复」才会改动 WTF。执行前请完全退出游戏（包括战网中的游戏进程）：游戏运行时会在退出时写回配置。' }),
    h('div', { text: '恢复按这份备份记录的原范围进行：范围内会与备份完全一致（备份中没有的内容会被删除），范围外的内容保持不变。恢复后的文件只有你本人可读写，不保留原来的修改时间与扩展属性。' }),
  ));
  if (f.targetChanged && f.stage !== 'applied' && f.stage !== 'applying') {
    out.push(h('div', { class: 'banner banner-error', text: `打开预览后当前游戏版本或目录发生过变化，这份预览已作废，不能执行。原目录：${originText(f.origin)}` }));
  }
  if (f.stage === 'previewing') {
    out.push(h('div', { class: 'state-box small' },
      h('div', { class: 'state-title', text: '正在读取备份与当前完整 WTF…' }),
      h('div', { class: 'state-msg', text: `只读取、核对，不改动任何文件。备份 ${f.snapshot.id}，范围：${scopeText(f.snapshot.scope)}；目录 ${wtfPath(f.origin.root)}` }),
    ));
    return out;
  }
  if (f.stage === 'preview-failed') {
    const fail = f.failure;
    out.push(h('div', { class: fail?.cancelled ? 'banner backup-notice' : 'banner banner-error' },
      h('div', { class: 'restore-strong', text: fail?.cancelled ? '预览已取消，没有改动任何文件' : '未能生成预览，没有改动任何文件' }),
      h('div', { class: 'backup-lines', text: fail?.message ?? '' }),
    ));
    return out;
  }
  if (f.stage === 'applied' && f.applied) {
    out.push(noticeBlock(f.applied));
    return out;
  }
  const p = f.preview;
  if (!p) return out;
  out.push(...previewParts(f, p));
  if (f.stage === 'preview' || f.stage === 'applying') {
    const lock = f.stage !== 'preview' || f.targetChanged || !p.token || p.blockers.length > 0;
    out.push(h('div', { class: 'restore-acks' },
      h('label', { class: 'backup-choice' },
        fk('ack-game', h('input', { type: 'checkbox', checked: f.ackGame, disabled: lock, on: { change: (e: Event) => { f.ackGame = (e.target as HTMLInputElement).checked; renderView(); } } })),
        h('span', { text: '我已完全退出游戏' }),
      ),
      h('label', { class: 'backup-choice' },
        fk('ack-overwrite', h('input', { type: 'checkbox', checked: f.ackOverwrite, disabled: lock, on: { change: (e: Event) => { f.ackOverwrite = (e.target as HTMLInputElement).checked; renderView(); } } })),
        h('span', { text: '我确认用这份备份替换上述范围内的配置，并删除备份中没有的内容' }),
      ),
    ));
    if (f.stage === 'preview' && p.expiresAt !== null && expired(p)) out.push(h('div', { class: 'banner banner-warn', text: '这份预览已过期，请重新预览。' }));
  }
  return out;
}

/** 返回默认焦点的键 */
function flowFoot(f: Flow, foot: HTMLElement): string {
  const parts: HTMLElement[] = [];
  if (f.stage === 'previewing' || f.stage === 'applying') {
    parts.push(fk('close', h('button', { class: 'btn', disabled: true, title: '进行中不能关闭；需要停止请点击上方的“取消”' }, '关闭')));
  } else if (f.stage === 'applied') {
    if (f.needsResolve) parts.push(fk('pending', h('button', { class: 'btn', on: { click: () => { closeView(); openPendingView(() => focusBanner()); } } }, '查看未完成的恢复')));
    parts.push(fk('close', h('button', { class: 'btn btn-primary', on: { click: closeView } }, '关闭')));
  } else {
    const re = canRepreview(f);
    parts.push(fk('close', h('button', { class: 'btn', on: { click: closeView } }, f.stage === 'preview' ? '取消' : '关闭')));
    const stalePreview = f.stage === 'preview-failed' || f.targetChanged || (f.preview !== null && (expired(f.preview) || !f.preview.token));
    if (stalePreview) parts.push(fk('repreview', h('button', { class: 'btn', disabled: !!re, title: re ?? '重新读取备份与当前完整 WTF 并生成新的预览', on: { click: () => void runPreview(f) } }, '重新预览')));
    if (f.stage === 'preview') {
      const why = applyBlock(f);
      parts.push(fk('apply', h('button', { class: 'btn btn-danger', disabled: !!why, title: why ?? '', on: { click: () => void runApply(f) } }, '执行恢复')));
    }
  }
  mount(foot, parts);
  return 'close';
}

// ---------- 处理未完成的恢复 ----------

const STATE_TEXT: Record<RestorePendingState, string> = {
  preparing: '准备中断',
  prepared: '已准备，未完成',
  committed: '已提交，收尾未完成',
  blocked: '无法确认状态，已保留现场',
  'cleanup-pending': '收尾未完成',
  unregistered: '未登记的内容',
};

const SETTLED_TEXT: Record<RestoreSettledOutcome, string> = {
  committed: '已恢复（只剩收尾）',
  'rolled-back': '已回滚到恢复前（只剩收尾）',
  'not-applied': 'WTF 没有被改动（只剩收尾）',
};

const RECEIPT_TEXT: Record<RestoreReceiptView['outcome'], string> = {
  committed: '已恢复',
  'rolled-back': '已回滚到恢复前',
  'not-applied': 'WTF 没有被改动',
  cleared: '已清理，WTF 没有被改动',
};

/** 本次打开处理对话框后勾选了“已退出游戏”的事务（每次打开都重新确认） */
const resolveAck = new Set<string>();
let resolving: { txid: string; run: Running } | null = null;

let bannerEl: HTMLElement | null = null;
let bannerText: HTMLElement | null = null;
let bannerBtn: HTMLButtonElement | null = null;
let bannerRetry: HTMLButtonElement | null = null;

function focusBanner(): void {
  if (bannerBtn && !bannerEl?.classList.contains('hidden')) bannerBtn.focus();
}

/** 打开「未完成的恢复」对话框：打开时重新只读查询一次 */
export function openPendingView(returnFocus: () => void): void {
  if (view) return;
  if (otherModalOpen()) {
    toast('请先完成当前的确认，再查看未完成的恢复', 'info');
    return;
  }
  resolveAck.clear();
  openView('pending', '未完成的 WTF 恢复', returnFocus);
  renderView(true);
  void refreshPending();
}

async function runResolve(item: RestorePendingItem): Promise<void> {
  const txid = item.txid;
  if (!txid || item.state === 'unregistered' || resolving || !resolveAck.has(txid) || backupActive()) return;
  const origin: Origin = { flavorId: item.flavorId, root: item.root };
  resolving = { txid, run: { kind: 'restore-resolve', origin, cancelLabel: '不可取消', cancelAsked: false, noCancel: true } };
  renderView(true);
  let out: BackupOutcome<RestoreResolveRunResult> | null = null;
  let error: string | null = null;
  try {
    out = await api().backupRestoreResolve(txid, { gameClosed: true });
  } catch (err) {
    error = errMsg(err);
  }
  resolving = null;
  resolveAck.delete(txid);
  setNotice(resolveNotice(origin, txid, out, error));
  // 处理结束后只重新查询未完成的恢复与配置备份状态（不读取插件本地状态）
  void refreshPending();
  if (origin.flavorId !== null) refreshBackupIfShowing({ flavorId: origin.flavorId, root: origin.root });
  changed();
  renderView(true);
}

function resolveNotice(origin: Origin, txid: string, out: BackupOutcome<RestoreResolveRunResult> | null, error: string | null): RestoreNotice {
  const at = Date.now();
  const id = `恢复编号：${txid}`;
  if (!out) return { origin, kind: 'error', at, title: '处理没有正常完成', lines: [error ?? '原因未知', id, '状态以重新查询的「未完成的恢复」为准。'] };
  if (out.status === 'cancelled') return { origin, kind: 'info', at, title: '处理已取消', lines: [out.message, id] };
  const r = out.result;
  const lines = [r.message, ...r.warnings, id].filter((l) => l !== '');
  switch (r.outcome) {
    case 'finalized':
      return { origin, kind: r.warnings.length ? 'warn' : 'success', at, title: '已完成收尾（恢复此前已提交）', lines };
    case 'rolled-back':
      return { origin, kind: 'warn', at, title: '已回滚到恢复前', lines };
    case 'cleared':
      return { origin, kind: r.warnings.length ? 'warn' : 'success', at, title: 'WTF 没有被改动，已清理这次恢复的内容', lines };
    case 'blocked':
      return { origin, kind: 'error', at, title: '仍无法处理：无法确认状态，已保留现场', lines };
    case 'cleanup-pending':
      return { origin, kind: 'warn', at, title: '仍有收尾未完成', lines };
    default:
      return { origin, kind: 'error', at, title: '收到无法识别的处理结果', lines };
  }
}

function noticeBlock(n: RestoreNotice): HTMLElement {
  const cls = n.kind === 'error' ? 'banner banner-error' : n.kind === 'warn' ? 'banner banner-warn' : 'banner backup-notice';
  return h('div', { class: `${cls} backup-result` },
    h('div', { class: 'backup-result-title', text: n.title }),
    h('div', { class: 'backup-meta', text: `${formatDateTime(n.at)} · 原目录：${originText(n.origin)}` }),
    n.lines.length ? h('div', { class: 'backup-lines' }, n.lines.map((l) => h('div', { text: l }))) : null,
  );
}

function itemRow(item: RestorePendingItem): HTMLElement {
  const meta: string[] = [];
  if (item.createdAt) meta.push(`开始于 ${formatDateTime(item.createdAt)}`);
  if (item.sourceSnapshotId) meta.push(`来源备份 ${item.sourceSnapshotId}`);
  if (item.safetySnapshotId) meta.push(`恢复前备份 ${item.safetySnapshotId}`);
  if (item.scope) meta.push(`范围：${scopeText(item.scope)}`);
  if (item.txid) meta.push(`恢复编号 ${item.txid}`);
  const parts: Child[] = [
    h('div', { class: 'row-title' },
      h('span', { class: item.state === 'blocked' || item.state === 'unregistered' ? 'tag tag-danger' : 'tag tag-warn', text: STATE_TEXT[item.state] ?? '未知状态' }),
      item.outcome ? h('span', { class: 'tag tag-muted', text: SETTLED_TEXT[item.outcome] ?? '结果未知' }) : null,
    ),
    h('div', { class: 'backup-meta' }, '原目录：', h('span', { class: 'mono', text: `${originText(item)}` })),
    // 登记的备份位置：原样显示，不据此拼接或推测其中的临时目录
    item.containerPath ? h('div', { class: 'backup-meta' }, '备份位置：', h('span', { class: 'mono', text: item.containerPath })) : null,
    meta.length ? h('div', { class: 'row-meta' }, meta.map((m) => h('span', { text: m }))) : null,
    // 原因可能含有保留的工作目录或恢复前备份的完整路径：只显示，不据此删除或处理
    item.reason ? h('div', { class: 'restore-reason', text: item.reason }) : null,
  ];
  if (!item.txid || item.state === 'unregistered') {
    parts.push(h('div', { class: 'backup-meta', text: '未登记：艾泽魔方无法确认它属于哪一次恢复，不会处理或删除它。请根据上面的位置自行检查。' }));
  } else {
    const txid = item.txid;
    const busyNow = resolving !== null;
    const active = backupActive();
    const why = busyNow ? '正在处理另一项' : active ? BUSY_TITLE : !resolveAck.has(txid) ? '请先确认已完全退出游戏' : '';
    parts.push(h('div', { class: 'restore-item-actions' },
      h('label', { class: 'backup-choice' },
        fk(`ack:${txid}`, h('input', {
          type: 'checkbox',
          checked: resolveAck.has(txid),
          disabled: busyNow,
          on: { change: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) resolveAck.add(txid);
            else resolveAck.delete(txid);
            renderView();
          } },
        })),
        h('span', { text: '我已完全退出游戏' }),
      ),
      fk(`resolve:${txid}`, h('button', {
        class: 'btn btn-sm btn-primary',
        disabled: !!why,
        title: why || '按登记的原目录继续或回滚这次恢复（即使该目录现在已解除绑定）',
        on: { click: () => void runResolve(item) },
      }, resolving?.txid === txid ? [spinner(true), '处理中'] : '处理')),
    ));
  }
  return h('div', { class: 'row restore-item' }, h('div', { class: 'row-main' }, parts));
}

function pendingBody(): Child[] {
  const out: Child[] = [];
  out.push(h('div', { class: 'note restore-intro', text: '这些是之前的恢复没有正常结束时留下的状态。艾泽魔方不会自动处理、删除或移动它们；处理前请确认游戏已完全退出。处理按登记的原目录进行，即使该目录现在已解除绑定或更换。' }));
  if (notice) out.push(noticeBlock(notice));
  if (pendingLoading && !pending) out.push(h('div', { class: 'state-box small', text: '正在查询…' }));
  if (pendingError) out.push(h('div', { class: 'banner banner-error', text: `查询失败：${pendingError}${pending ? '。下面显示的是上次查询的结果。' : ''}` }));
  const v = pending;
  if (!v) return out;
  if (v.registryError) out.push(h('div', { class: 'banner banner-error', text: `恢复登记无法读取，已停止所有恢复：${v.registryError}。下面的列表可能不完整，为空也不代表没有未完成的恢复。` }));
  if (v.boundRootsError) out.push(h('div', { class: 'banner banner-warn', text: `已绑定的目录列表无法读取：${v.boundRootsError}。未登记内容的检查范围不完整。` }));
  if (v.scanErrors.length) {
    out.push(h('div', { class: 'banner banner-warn' },
      h('div', { text: '以下游戏目录未能检查，其中是否有未登记的恢复内容未知：' }),
      h('div', { class: 'backup-lines' }, v.scanErrors.map((e) => h('div', null, h('span', { class: 'mono', text: e.root }), h('span', { text: `：${e.reason}` })))),
    ));
  }
  if (v.items.length) out.push(h('div', { class: 'restore-list' }, v.items.map(itemRow)));
  else if (!v.registryError && !v.scanErrors.length && !v.boundRootsError) out.push(h('div', { class: 'state-box small', text: '没有未完成的恢复。' }));
  if (v.receipts.length) {
    out.push(h('div', { class: 'restore-section-title', text: '最近结束的恢复（登记中的最终记录，不是本次操作的结果）' }));
    out.push(h('div', { class: 'backup-lines restore-receipts' }, v.receipts.map((r) => h('div', {
      text: `${formatDateTime(r.at)} · ${RECEIPT_TEXT[r.outcome] ?? '结果未知'} · ${originText(r)} · 来源备份 ${r.sourceSnapshotId}${r.safetySnapshotId ? ` · 恢复前备份 ${r.safetySnapshotId}` : ''} · 恢复编号 ${r.txid}`,
    }))));
  }
  return out;
}

function pendingFoot(foot: HTMLElement): string {
  const busyNow = resolving !== null;
  mount(foot,
    fk('refresh', h('button', { class: 'btn', disabled: busyNow || pendingLoading, on: { click: () => void refreshPending() } }, pendingLoading ? [spinner(true), '查询中'] : '重新查询')),
    fk('close', h('button', { class: 'btn btn-primary', disabled: busyNow, title: busyNow ? '处理进行中，完成后才能关闭' : '', on: { click: closeView } }, '关闭')),
  );
  return 'close';
}

// ---------- 全局提示条 ----------

function renderBanner(): void {
  if (!bannerEl || !bannerText || !bannerBtn || !bannerRetry) return;
  const a = attention();
  bannerEl.classList.toggle('hidden', !a);
  if (!a) return;
  bannerEl.classList.toggle('restore-warning-error', a.level === 'error');
  setText(bannerText, a.text);
  // 查询失败时提供重试（查询中重复点击只补查一轮，不禁用按钮以保持焦点）；有结果（含上次的）时可以打开对话框查看
  bannerRetry.classList.toggle('hidden', !pendingError);
  bannerRetry.setAttribute('aria-busy', pendingLoading ? 'true' : 'false');
  setText(bannerRetry, pendingLoading ? '正在重试…' : '重试');
  bannerBtn.classList.toggle('hidden', !pending);
}

/** 状态变化：刷新提示条，并经 backup 事件刷新配置备份页、侧栏标记与打开的对话框 */
function changed(): void {
  renderBanner();
  emit('backup');
}

/** 初始化（早于配置加载）：全局提示条，以及跟踪目标变化让打开的预览作废 */
export function initRestore(banner: HTMLElement): void {
  bannerEl = banner;
  bannerText = h('span', { class: 'restore-warning-text' });
  bannerBtn = h('button', { class: 'btn btn-sm', on: { click: () => openPendingView(focusBanner) } }, '查看未完成的恢复');
  bannerRetry = h('button', { class: 'btn btn-sm', on: { click: () => void refreshPending() } }, '重试');
  mount(banner, bannerText, bannerBtn, bannerRetry);
  const noteTarget = (): void => {
    const f = flow;
    if (!f || f.stage === 'applying' || f.stage === 'applied') return;
    const now = currentTarget();
    if (!f.targetChanged && (!now || targetKey(now) !== targetKey(f.origin))) {
      f.targetChanged = true;
      renderView();
    }
  };
  on('local', noteTarget);
  on('flavor', noteTarget);
  // 未完成恢复的查询结果、其他任务开始 / 结束会改变“执行恢复”“处理”的可用性；同一任务的进度只就地更新任务行
  on('backup', () => {
    if (view) renderView();
  });
  // 恢复 / 处理任务结束时重新查询未完成的恢复（见 onTaskSnapshot）
  onBackupTaskChange(onTaskSnapshot);
  renderBanner();
}
