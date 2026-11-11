// 我的插件页的「配置备份」：可选的本地 WTF 配置备份（默认关闭）。
// - 启动时只订阅并获取主进程中纯内存的任务快照（不读取 WTF，也不扫描备份位置）；打开标签页才读取当前目录的备份状态。
// - 不经过 runWrite / refreshLocal（它们会读取本地状态，可能恢复事务与清理），备份操作也不刷新插件列表。
// - 任务快照按 rev 采用：迟到的回复或错误不覆盖更新的推送；完整状态里的 activeTask 不参与显示。
// - 进度推送只就地更新任务卡片；完整状态只在打开标签页、手动刷新、当前目录的任务开始与结束时读取，
//   同一目录进行中的读取期间再次请求只标记补读（最多补一轮）。
// - 完整状态按 目标（版本 + 目录）+ 请求序号 采用；目标变化（换绑、解除、读取失败、切换版本）即丢弃，切回原目标也不复活。
// - 备份 / 校验的结果按发起时的目标给出，带原目标说明，常驻显示到用户关闭（警告不会随刷新消失）。
// - 所有路径、清单信息与错误说明都按纯文本显示（textContent），列表有界、可滚动。

import type { BackupAnomalyKind, BackupPhase, BackupSnapshotInfo, BackupState, BackupTaskInfo, BackupTaskSnapshot } from '../shared/types';
import { confirmDialog, h, mount, spinner, toast } from './dom.js';
import { errMsg, formatDateTime } from './format.js';
import { api, currentTarget, emit, flavorName, isBusy, state, stillTarget, targetKey, type Target } from './state.js';

const BUSY = {
  configure: 'backup:configure',
  disable: 'backup:disable',
  run: 'backup:run',
  verify: 'backup:verify',
} as const;

// ---------- 任务快照（纯内存，按 rev） ----------

let snap: BackupTaskSnapshot | null = null;
/** 尚未取得任何快照时最近一次获取失败的原因 */
let taskError: string | null = null;
/**
 * 当前显示的任务卡片：同一任务的进度、阶段与取消状态只改这些节点的文字与属性，不重建节点，
 * “取消”按钮在 200ms 一次的进度推送中保持同一个元素（键盘焦点与进行中的鼠标点击不会丢失）。任务编号变化或整页重绘时重建
 */
interface TaskView {
  id: string;
  row: HTMLElement;
  name: HTMLElement;
  phase: HTMLElement;
  progress: HTMLElement;
  origin: HTMLElement;
  cancel: HTMLButtonElement;
}
let taskView: TaskView | null = null;

/** 主进程中进行中的备份 / 校验任务（任意目录） */
export function backupTask(): BackupTaskInfo | null {
  return snap?.task ?? null;
}

/** 有进行中的备份 / 校验任务，或本界面发起的备份请求尚未返回 */
export function backupActive(): boolean {
  return !!snap?.task || Object.values(BUSY).some((k) => isBusy(k));
}

/**
 * 主进程推送或主动获取的任务快照：只接受 rev 更大的。任务开始或结束（编号变化）时，若属于当前打开的目录则读取完整状态；
 * 同一任务的进度与阶段变化只重绘任务卡片，不读取完整状态
 */
export function applyBackupTask(s: BackupTaskSnapshot): boolean {
  if (snap && s.rev <= snap.rev) return false;
  const prev = snap?.task ?? null;
  const next = s.task ? { ...s.task } : null;
  snap = { rev: s.rev, task: next };
  taskError = null;
  if ((prev?.id ?? null) !== (next?.id ?? null)) {
    for (const t of [prev, next]) if (t) refreshIfShowing(t);
    emit('local');
  } else if (next && taskView?.id === next.id) {
    updateTaskView(taskView, next);
  }
  return true;
}

/** 获取任务快照（启动时在订阅推送之后调用，以及用户重试）；失败只在尚未取得任何快照时显示 */
export async function syncBackupTask(): Promise<void> {
  try {
    applyBackupTask(await api().backupTaskState());
  } catch (err) {
    if (!snap) {
      taskError = errMsg(err);
      emit('local');
    }
  }
}

// ---------- 完整状态（打开标签页才读取） ----------

interface Shown {
  key: string;
  state: BackupState | null;
  error: string | null;
}

let shown: Shown | null = null;
/** 进行中的读取：目标键、序号；dirty 表示读取期间又请求了一次，结束后补读一轮 */
let loading: { key: string; seq: number; dirty: boolean } | null = null;
let seq = 0;
let tabOpen = false;
/** 最近一次看到的当前目标；null 表示没有当前目标 */
let lastTarget: string | null = null;

/** 当前显示的状态（只属于当前目标；测试只读） */
export function shownBackup(t: Target): { state: BackupState | null; error: string | null } | null {
  if (!shown || shown.key !== targetKey(t)) return null;
  return { state: shown.state, error: shown.error };
}

export function backupLoading(t: Target): boolean {
  return loading?.key === targetKey(t);
}

/** 标签页打开或离开；打开时读取当前目标的状态 */
export function setBackupTabOpen(open: boolean): void {
  tabOpen = open;
  if (!open) {
    taskView = null;
    return;
  }
  const t = currentTarget();
  if (t) refreshBackup(t);
}

/** 读取完整状态；同一目标已有进行中的读取时只标记补读 */
export function refreshBackup(t: Target): void {
  const key = targetKey(t);
  if (loading?.key === key) {
    loading.dirty = true;
    return;
  }
  void load(t);
}

function refreshIfShowing(task: BackupTaskInfo): void {
  const t = currentTarget();
  if (tabOpen && t && t.flavorId === task.flavorId && t.root === task.root) refreshBackup(t);
}

async function load(t: Target): Promise<void> {
  const key = targetKey(t);
  const my = ++seq;
  loading = { key, seq: my, dirty: false };
  emit('local');
  try {
    const s = await api().backupState(t.flavorId, t.root);
    if (my !== seq) return;
    // 回复必须属于发起时的目标
    if (targetKey({ flavorId: s.flavorId, root: s.root }) !== key) return;
    shown = { key, state: s, error: null };
  } catch (err) {
    if (my !== seq) return;
    shown = { key, state: shown?.key === key ? shown.state : null, error: errMsg(err) };
  } finally {
    if (loading?.seq === my) {
      const again = loading.dirty && tabOpen;
      loading = null;
      if (again) void load(t);
      else emit('local');
    }
  }
}

/** 采用操作直接返回的状态（比进行中的读取更新）：作废进行中的读取 */
function adopt(t: Target, s: BackupState): void {
  if (targetKey({ flavorId: s.flavorId, root: s.root }) !== targetKey(t)) return;
  const now = currentTarget();
  if (!now || targetKey(now) !== targetKey(t)) return;
  seq++;
  loading = null;
  shown = { key: targetKey(t), state: s, error: null };
}

/** 切换版本或目录：丢弃显示的状态，进行中的读取回复到达时也被丢弃 */
export function resetBackup(): void {
  seq++;
  shown = null;
  loading = null;
}

/**
 * 每次本地状态变化时调用：当前目标与上次不同（换绑、解除、外部修改设置后刷新、读取失败）即丢弃状态并作废进行中的读取；
 * 标签页打开时读取新目标。目标不变的普通刷新不重新读取
 */
export function noteBackupTarget(t: Target | null): void {
  const key = t ? targetKey(t) : null;
  if (key === lastTarget) return;
  lastTarget = key;
  resetBackup();
  if (t && tabOpen) refreshBackup(t);
}

// ---------- 操作结果（常驻显示到用户关闭） ----------

type NoticeKind = 'success' | 'warn' | 'error' | 'info';

interface Notice {
  origin: Target;
  kind: NoticeKind;
  title: string;
  lines: string[];
  at: number;
}

let notice: Notice | null = null;

/** 最近一次备份操作的结果（测试只读） */
export function backupNotice(): Notice | null {
  return notice;
}

function report(origin: Target, kind: NoticeKind, title: string, lines: string[] = []): void {
  notice = { origin, kind, title, lines, at: Date.now() };
  const now = currentTarget();
  // 结果属于其他目录（发起后换了版本或目录）：另行提示原目录，不当作当前目录的结果
  if (!now || targetKey(now) !== targetKey(origin)) toast(`${originText(origin)}：${title}`, kind, 12000);
  emit('local');
}

function originText(t: Target): string {
  return `「${flavorName(t.flavorId)}」${t.root}`;
}

// ---------- 操作 ----------

async function busy<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (isBusy(key)) return undefined;
  state.busy.add(key);
  emit('local');
  try {
    return await fn();
  } finally {
    state.busy.delete(key);
    emit('local');
  }
}

/** 启用或更换保存位置：保存位置只由主进程弹出的文件夹选择框决定；取消选择不做任何改动 */
export async function enableBackup(t: Target, oldPath: string | null, replacing: boolean): Promise<void> {
  if (backupActive()) return;
  if (replacing) {
    const ok = await confirmDialog({
      title: '更换备份保存位置？',
      message: '会在你接下来选择的文件夹中新建一个独立的备份位置，之后的备份都保存到那里。原位置中的备份不会被删除，也不会被移动，仍保留在：',
      detail: oldPath ? [oldPath] : undefined,
      confirmText: '选择新位置',
    });
    if (!ok || !stillTarget(t)) return;
  }
  await busy(BUSY.configure, async () => {
    try {
      const s = await api().backupConfigure(t.flavorId, t.root);
      if (!s) return;
      adopt(t, s);
      report(t, 'success', '已启用 WTF 配置备份', [`保存位置：${s.containerPath ?? ''}`, '之后只有点击“创建备份”才会读取 WTF 并复制。']);
    } catch (err) {
      report(t, 'error', '未能启用备份', [errMsg(err)]);
    }
  });
}

/** 关闭：只停止向这个位置备份，不删除已有备份 */
export async function disableBackup(t: Target, path: string | null): Promise<void> {
  if (backupActive()) return;
  const ok = await confirmDialog({
    title: '关闭此目录的 WTF 配置备份？',
    message: '只是停止向这个位置备份。已有的备份不会被删除，仍保留在：',
    detail: path ? [path] : undefined,
    confirmText: '关闭备份',
  });
  if (!ok || !stillTarget(t)) return;
  await busy(BUSY.disable, async () => {
    try {
      adopt(t, await api().backupDisable(t.flavorId, t.root));
      report(t, 'info', '已关闭 WTF 配置备份，已有备份仍保留', path ? [`保留位置：${path}`] : []);
    } catch (err) {
      report(t, 'error', '未能关闭备份', [errMsg(err)]);
    }
  });
}

/** 手动创建备份：只有这里会读取 WTF。完整状态由任务结束的推送刷新 */
export async function runBackup(t: Target): Promise<void> {
  if (backupActive()) return;
  await busy(BUSY.run, async () => {
    try {
      const out = await api().backupRun(t.flavorId, t.root);
      if (out.status === 'cancelled') {
        report(t, 'info', '备份已取消，没有生成新的备份', [out.message]);
        return;
      }
      const r = out.result;
      const head = `${r.snapshot.id}（${r.snapshot.fileCount} 个文件，${bytesText(r.snapshot.totalBytes)}）`;
      if (r.warnings.length) report(t, 'warn', '备份已完成，但收尾时有需要你检查的情况', [`新备份：${head}`, ...r.warnings]);
      else report(t, 'success', '备份已完成', [`新备份：${head}`]);
    } catch (err) {
      report(t, 'error', '备份未完成', [errMsg(err)]);
    }
  });
}

/** 重新校验一份备份的内容（按清单逐个文件计算校验值） */
export async function verifyBackup(t: Target, snapshotId: string): Promise<void> {
  if (backupActive()) return;
  await busy(BUSY.verify, async () => {
    try {
      const out = await api().backupVerify(t.flavorId, t.root, snapshotId);
      if (out.status === 'cancelled') {
        report(t, 'info', `已取消校验 ${snapshotId}`, [out.message]);
        return;
      }
      const r = out.result;
      const counted = `已检查 ${r.checkedFiles} 个文件，${bytesText(r.checkedBytes)}`;
      if (!r.ok) report(t, 'warn', `备份 ${snapshotId} 的内容与清单不一致`, [r.reason ?? '原因未知', ...r.warnings]);
      else if (r.warnings.length) report(t, 'warn', `备份 ${snapshotId} 内容校验通过，但收尾时有需要你检查的情况`, [counted, ...r.warnings]);
      else report(t, 'success', `备份 ${snapshotId} 内容校验通过`, [counted]);
    } catch (err) {
      report(t, 'error', `校验 ${snapshotId} 未完成`, [errMsg(err)]);
    }
  });
}

/** 按任务受理时的原值取消（可能不是当前显示的目录） */
export async function cancelBackupTask(task: BackupTaskInfo): Promise<void> {
  try {
    if (!(await api().backupCancel(task.id, task.flavorId, task.root))) toast('该任务已经结束，没有取消', 'info');
  } catch (err) {
    toast(errMsg(err), 'error');
  }
}

async function reveal(t: Target, snapshotId: string | null): Promise<void> {
  try {
    await api().backupReveal(t.flavorId, t.root, snapshotId);
  } catch (err) {
    toast(errMsg(err), 'error');
  }
}

// ---------- 显示 ----------

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** 按文件大小（字节）统计的占用 */
function bytesText(n: number): string {
  if (n >= GB) return `${+(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${+(n / MB).toFixed(2)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} 字节`;
}

const PHASE_TEXT: Record<BackupPhase, string> = {
  preparing: '准备中',
  copying: '正在复制',
  rechecking: '正在复核源文件',
  publishing: '正在核对并保存',
  verifying: '正在校验内容',
  cleanup: '正在清理未完成的内容',
};

const ANOMALY_TEXT: Record<BackupAnomalyKind, string> = {
  incomplete: '未完成的备份',
  foreign: '不认识的内容',
  lock: '占用标记',
  unreadable: '无法读取',
  'scan-limit': '条目过多',
};

/** 标签页上的进行中标记 */
export function backupTabBadge(): string | null {
  return snap?.task ? '进行中' : null;
}

const INTRO = [
  '启用后，点击“创建备份”时会把当前游戏目录中的 WTF 文件夹复制到你选择的位置。WTF 里保存着账号、角色与插件的设置，可能包含账号名等个人信息。',
  '备份保存到你选择的文件夹，艾泽魔方不会主动上传；如果选择的是 iCloud 等云盘同步的文件夹，副本可能会被云盘同步。不会自动备份，也不会自动删除旧备份。',
  '建议先退出游戏再备份：备份期间游戏写入设置会导致本次备份失败；备份是逐个文件复制并核对的副本，不是瞬间快照。',
  '艾泽魔方不提供一键还原。需要时请在访达中打开备份，自行复制所需文件。',
];

export function renderBackup(t: Target | null): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  const task = snap?.task ?? null;
  taskView = task ? buildTaskView(task) : null;
  const tasks = h('div', { class: 'backup-task' }, taskView?.row);
  const parts: HTMLElement[] = [];
  if (taskError && !snap) {
    parts.push(h('div', { class: 'banner banner-warn' },
      h('span', { text: `备份任务状态未能同步：${taskError}` }),
      h('button', { class: 'btn btn-sm', on: { click: () => void syncBackupTask() } }, '重新同步'),
    ));
  }
  if (notice) parts.push(noticeBox(notice, t));
  if (!t) {
    mount(box, tasks, parts, h('div', { class: 'state-box' },
      h('div', { class: 'state-title', text: '请先选择游戏目录' }),
      h('div', { class: 'state-msg', text: 'WTF 配置备份针对当前游戏版本绑定的目录。' }),
    ));
    return box;
  }
  const view = shownBackup(t);
  const s = view?.state ?? null;
  const loadingNow = backupLoading(t);
  const head = h('div', { class: 'health-head' },
    h('span', { class: 'backup-title', text: 'WTF 配置备份' }),
    h('button', { class: 'btn btn-sm', disabled: loadingNow, on: { click: () => refreshBackup(t) } }, loadingNow ? [spinner(true), '读取中'] : '刷新备份状态'),
  );
  if (view?.error) parts.push(h('div', { class: 'banner banner-error', text: `无法读取备份状态：${view.error}` }));
  if (!s) {
    parts.push(h('div', { class: 'state-box small', text: loadingNow ? '正在读取备份状态…' : '尚未读取备份状态。' }));
  } else if (s.status === 'disabled') {
    parts.push(...disabledParts(t, s));
  } else {
    parts.push(...enabledParts(t, s));
  }
  mount(box, head, tasks, parts);
  return box;
}

function noticeBox(n: Notice, t: Target | null): HTMLElement {
  const cls = n.kind === 'error' ? 'banner banner-error' : n.kind === 'warn' ? 'banner banner-warn' : 'banner backup-notice';
  const other = !t || targetKey(t) !== targetKey(n.origin);
  return h('div', { class: `${cls} backup-result` },
    h('div', { class: 'backup-result-title', text: n.title }),
    h('div', { class: 'backup-meta', text: `${formatDateTime(n.at)} · ${other ? `原目录（不是当前显示的目录）：${originText(n.origin)}` : originText(n.origin)}` }),
    n.lines.length ? h('div', { class: 'backup-lines' }, n.lines.map((l) => h('div', { text: l }))) : null,
    h('button', { class: 'btn btn-sm', on: { click: () => { notice = null; emit('local'); } } }, '知道了'),
  );
}

function buildTaskView(task: BackupTaskInfo): TaskView {
  const id = task.id;
  const v: TaskView = {
    id,
    row: h('div', { class: 'row backup-task-row' }),
    name: h('span', { class: 'row-name' }),
    phase: h('span', { class: 'tag tag-accent tag-task' }),
    progress: h('span', { class: 'backup-progress' }),
    origin: h('span', { class: 'mono' }),
    // 总是取消这张卡片对应的任务：编号、版本与目录取自该任务最新的快照（受理时的原值），不取当前显示的目录
    cancel: h('button', {
      class: 'btn btn-sm',
      on: { click: () => {
        const cur = snap?.task;
        if (cur && cur.id === id && !cur.cancelling) void cancelBackupTask(cur);
      } },
    }),
  };
  mount(v.row,
    spinner(true),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, v.name, v.phase),
      h('div', { class: 'row-meta' }, v.progress),
      h('div', { class: 'row-meta' }, v.origin),
    ),
    h('div', { class: 'row-actions' }, v.cancel),
  );
  updateTaskView(v, task);
  return v;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** 同一任务的变化：只改文字与属性，节点（包括“取消”按钮）保持不变 */
function updateTaskView(v: TaskView, task: BackupTaskInfo): void {
  const origin: Target = { flavorId: task.flavorId, root: task.root };
  const now = currentTarget();
  const other = !now || targetKey(now) !== targetKey(origin);
  setText(v.name, task.kind === 'run' ? '正在备份' : `正在校验 ${task.snapshotId ?? ''}`);
  setText(v.phase, task.cancelling ? '正在取消…' : PHASE_TEXT[task.phase]);
  setText(v.progress, task.filesTotal > 0 || task.bytesTotal > 0
    ? `${task.filesDone} / ${task.filesTotal} 个文件 · ${bytesText(task.bytesDone)} / ${bytesText(task.bytesTotal)}`
    : '');
  setText(v.origin, `${other ? '原目录（不是当前显示的目录）：' : ''}${originText(origin)}`);
  if (v.cancel.disabled !== task.cancelling) v.cancel.disabled = task.cancelling;
  setText(v.cancel, task.cancelling ? '正在取消' : '取消');
}

function disabledParts(t: Target, s: BackupState): HTMLElement[] {
  const out: HTMLElement[] = [h('div', { class: 'note backup-intro' }, INTRO.map((p) => h('div', { text: p })))];
  const configuring = isBusy(BUSY.configure);
  if (s.containerPath) {
    out.push(h('div', { class: 'backup-status' },
      h('div', { text: '此目录的备份已关闭。之前的备份没有被删除，仍保留在：' }),
      h('div', { class: 'mono backup-path', text: s.containerPath }),
      h('div', { class: 'backup-meta', text: '重新启用会新建一个独立的备份位置，之前的备份不会被删除或迁移。' }),
    ));
  }
  out.push(h('div', { class: 'health-head' },
    h('button', {
      class: 'btn btn-primary',
      disabled: configuring || backupActive(),
      title: backupActive() ? '有备份或校验正在进行，完成后再操作' : '',
      on: { click: () => void enableBackup(t, s.containerPath, false) },
    }, configuring ? [spinner(true), '等待选择'] : s.containerPath ? '选择保存位置并重新启用' : '选择保存位置并启用'),
  ));
  return out;
}

/**
 * 按钮可用性由 status / error 与实时的 backupActive() 派生，不使用 s.canCreate：canCreate 还包含读取时“没有任何任务”，
 * 其他目录的任务结束时不会重新读取当前目录，沿用缓存的 false 会让按钮一直禁用。任务冲突以实时任务快照为准，主进程另有同样的拒绝
 */
function enabledParts(t: Target, s: BackupState): HTMLElement[] {
  const out: HTMLElement[] = [];
  const active = backupActive();
  const busyTitle = active ? '有备份或校验正在进行，完成后再操作' : '';
  const ready = s.status === 'ready';
  out.push(h('div', { class: 'backup-status' },
    h('div', { class: ready ? 'health-status' : 'health-status health-unavailable', text: ready ? '已启用' : s.containerPath ? '已启用，但备份位置当前不可用' : '备份设置当前无法读取' }),
    s.containerPath ? h('div', { class: 'mono backup-path', text: s.containerPath }) : null,
    s.usage ? h('div', { class: 'backup-usage', text: usageText(s) }) : null,
    s.usage && !s.usage.confirmed ? h('div', { class: 'backup-meta', text: '有内容无法读取或条目过多，实际占用可能更多。' }) : null,
  ));
  if (s.error) out.push(h('div', { class: ready ? 'banner banner-warn' : 'banner banner-error', text: s.error }));
  if (s.anomalies.length) {
    out.push(h('div', { class: 'banner banner-warn' },
      h('div', { text: `备份位置中有 ${s.anomalies.length} 项需要你检查。艾泽魔方不会自动删除或修改它们，处理之前不能创建新备份：` }),
      h('div', { class: 'backup-list backup-anomalies' }, s.anomalies.map((a) =>
        h('div', { class: 'backup-anomaly' },
          h('span', { class: 'tag tag-warn', text: ANOMALY_TEXT[a.kind] }),
          a.name ? h('span', { class: 'mono', text: a.name }) : null,
          h('span', { text: a.message }),
        ),
      )),
    ));
  }
  out.push(h('div', { class: 'health-head' },
    h('button', {
      class: 'btn btn-primary',
      disabled: !ready || !!s.error || active,
      title: busyTitle || (s.error ?? ''),
      on: { click: () => void runBackup(t) },
    }, isBusy(BUSY.run) ? [spinner(true), '备份中'] : '创建备份'),
    ready ? h('button', { class: 'btn', on: { click: () => void reveal(t, null) } }, '在访达中查看') : null,
    h('button', { class: 'btn', disabled: active, title: busyTitle, on: { click: () => void enableBackup(t, s.containerPath, true) } }, '更换保存位置'),
    h('button', { class: 'btn btn-text', disabled: active, title: busyTitle, on: { click: () => void disableBackup(t, s.containerPath) } }, '关闭备份'),
  ));
  if (ready) {
    out.push(s.snapshots.length
      ? h('div', { class: 'row-list backup-list' }, s.snapshots.map((x) => snapshotRow(t, x, active)))
      : h('div', { class: 'state-box small', text: '还没有备份。点击“创建备份”复制当前的 WTF。' }));
  }
  out.push(limitsBox(s));
  return out;
}

function usageText(s: BackupState): string {
  const u = s.usage!;
  const least = u.confirmed ? '' : '至少 ';
  return `已用 ${least}${bytesText(u.bytes)} / 上限 ${bytesText(u.maxBytes)} · ${least}${u.count} / ${u.maxCount} 份（按文件大小统计）`;
}

/** 一份备份的状态：当前的不一致优先于本次运行中较早的校验结果 */
function snapshotStatus(x: BackupSnapshotInfo): { cls: string; text: string; detail: string | null } {
  if (x.status === 'mismatch') return { cls: 'tag tag-danger', text: '与清单不一致', detail: x.reason };
  if (x.status === 'invalid') return { cls: 'tag tag-danger', text: '无法识别', detail: x.reason };
  const v = x.lastVerify;
  if (v && v.ok) return { cls: 'tag tag-accent', text: '上次内容校验通过', detail: `校验于 ${formatDateTime(v.at)}（本次运行期间；之后的改动需要重新校验）` };
  if (v) return { cls: 'tag tag-danger', text: '上次内容校验未通过', detail: v.reason };
  return { cls: 'tag tag-muted', text: '结构检查通过，尚未校验内容', detail: null };
}

function snapshotRow(t: Target, x: BackupSnapshotInfo, active: boolean): HTMLElement {
  const st = snapshotStatus(x);
  return h('div', { class: 'row backup-row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        h('span', { class: 'row-name mono', text: x.id }),
        h('span', { class: st.cls, text: st.text }),
      ),
      h('div', { class: 'row-meta' },
        x.createdAt ? h('span', { text: `创建于 ${formatDateTime(x.createdAt)}` }) : null,
        x.createdAt ? h('span', { text: `${x.fileCount} 个文件` }) : null,
        h('span', { text: `占用 ${bytesText(x.actualBytes)}` }),
      ),
      st.detail ? h('div', { class: 'health-issue', text: st.detail }) : null,
    ),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', disabled: active, title: active ? '有备份或校验正在进行，完成后再操作' : '按清单逐个文件重新计算校验值', on: { click: () => void verifyBackup(t, x.id) } },
        isBusy(BUSY.verify) && snap?.task?.snapshotId === x.id ? [spinner(true), '校验中'] : '重新校验'),
      h('button', { class: 'btn btn-sm', on: { click: () => void reveal(t, x.id) } }, '在访达中显示'),
    ),
  );
}

function limitsBox(s: BackupState): HTMLElement {
  const l = s.limits;
  return h('details', { class: 'backup-limits' },
    h('summary', { text: '备份限制' }),
    h('div', { class: 'backup-meta' },
      h('div', { text: `每个保存位置最多 ${l.maxSnapshots} 份、共 ${bytesText(l.maxTotalBytes)}；单份最多 ${bytesText(l.maxSnapshotBytes)}、${l.maxEntries} 个文件与文件夹；单个文件最多 ${bytesText(l.maxFileBytes)}。` }),
      h('div', { text: '达到上限后不能再创建备份，艾泽魔方不会自动删除旧备份；请在访达中自行整理，或更换保存位置。' }),
      h('div', { text: '遇到符号链接、特殊文件或复制期间被改动的文件时，整份备份会停止；未完成的副本不会作为可用备份。若有临时内容未能清理，会明确提示保留的位置。' }),
    ),
  );
}
