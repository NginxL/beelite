// 左侧导航的「配置备份」页：可选的本地 WTF 配置备份（默认关闭）。
// - 启动时只订阅并获取主进程中纯内存的任务快照（不读取 WTF，也不扫描备份位置）；进入页面才读取当前目录的备份状态，
//   重复点击已打开的页面不重新读取。页面隐藏时任务开始 / 结束也不读取完整状态。
// - 不经过 runWrite / refreshLocal（它们会读取本地状态，可能恢复事务与清理）；备份状态、列表与进度只发出 backup 事件，不让插件页重绘。
// - 页面分成固定的任务槽与主体：主体随 backup / local / flavor 事件重绘（重绘后把焦点还给同一个控件）；
//   任务槽只在任务编号变化或页面重新打开时重建，同一任务的进度、阶段与取消状态只改文字与属性，“取消”按钮保持同一个节点与焦点。
//   页面隐藏时不保留任务卡片，返回时按最新快照重建。
// - 任务快照按 rev 采用：迟到的回复或错误不覆盖更新的推送；完整状态里的 activeTask 不参与显示。
// - 完整状态按 目标（版本 + 目录）+ 请求序号 采用；目标变化（换绑、解除、读取失败、切换版本）即丢弃，切回原目标也不复活。
//   同一目标的状态读取失败时保留上次内容供查看，但在刷新成功之前不能据此创建、读取账号与角色或重新校验。
// - WTF 的访问：读取状态不访问 WTF；“读取账号与角色”只读取目录名称与元数据；只有“创建备份”读取并复制文件内容。
// - 备份范围：默认全部 WTF。指定账号 / 指定角色要用户点击“读取账号与角色”才读取目录列表（主进程只看目录名称与元数据）。
//   列表与选择只在内存，按目标采用：目标变化、关闭备份或备份位置不可用即作废（范围类型保留，不会悄悄改成全部 WTF）；
//   重新读取后只保留仍存在的精确选择，失效的明确提示，不替换成别的账号或角色。提交的范围每次用列表中的原始名称重新组装，主进程再校验。
// - 任务卡片、结果与备份列表中的范围来自主进程（task.scope / snapshot.scope），不使用页面当前的选择。
// - 备份 / 校验的结果按发起时的目标给出，带原目标说明，常驻显示到用户关闭（警告不会随刷新消失）。
// - 所有路径、名称、清单信息与错误说明都按纯文本显示（textContent），列表有界、可滚动。

import type { BackupAnomalyKind, BackupCatalog, BackupPhase, BackupScope, BackupSnapshotInfo, BackupState, BackupTaskInfo, BackupTaskSnapshot } from '../shared/types';
import { MAX_BACKUP_SCOPE_CHARACTERS } from '../shared/backup-types.js';
import { confirmDialog, h, mount, spinner, toast, type Child } from './dom.js';
import { errMsg, formatDateTime } from './format.js';
import { api, currentTarget, emit, flavorName, isBusy, on, state, stillTarget, targetKey, type Target } from './state.js';

const BUSY = {
  configure: 'backup:configure',
  disable: 'backup:disable',
  run: 'backup:run',
  verify: 'backup:verify',
} as const;

const BUSY_TITLE = '有备份或校验正在进行，完成后再操作';

// ---------- 页面结构 ----------

let headEl: HTMLElement | null = null;
let slotEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let pageOpen = false;

// ---------- 任务快照（纯内存，按 rev） ----------

let snap: BackupTaskSnapshot | null = null;
/** 尚未取得任何快照时最近一次获取失败的原因 */
let taskError: string | null = null;

interface TaskView {
  id: string;
  row: HTMLElement;
  name: HTMLElement;
  phase: HTMLElement;
  progress: HTMLElement;
  scope: HTMLElement;
  origin: HTMLElement;
  cancel: HTMLButtonElement;
}
/** 任务槽中的任务卡片；页面隐藏时为 null */
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
 * 主进程推送或主动获取的任务快照：只接受 rev 更大的。任务开始或结束（编号变化）时，若页面打开且属于当前目录则读取完整状态；
 * 同一任务的进度与阶段变化只就地更新任务卡片，不读取完整状态，也不发出事件
 */
export function applyBackupTask(s: BackupTaskSnapshot): boolean {
  if (snap && s.rev <= snap.rev) return false;
  const prev = snap?.task ?? null;
  const next = s.task ? { ...s.task } : null;
  snap = { rev: s.rev, task: next };
  taskError = null;
  if ((prev?.id ?? null) !== (next?.id ?? null)) {
    for (const t of [prev, next]) if (t) refreshIfShowing(t);
    renderTaskSlot();
    emit('backup');
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
      emit('backup');
    }
  }
}

/** 侧栏「配置备份」上的进行中标记 */
export function backupNavBadge(): string | null {
  return snap?.task ? '进行中' : null;
}

// ---------- 完整状态（页面打开才读取） ----------

interface Shown {
  key: string;
  state: BackupState | null;
  error: string | null;
}

let shown: Shown | null = null;
/** 进行中的读取：目标键、序号；dirty 表示读取期间又请求了一次，结束后补读一轮 */
let loading: { key: string; seq: number; dirty: boolean } | null = null;
let seq = 0;
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

/**
 * 基于当前显示状态的操作（创建、读取账号与角色、重新校验）是否受阻：尚未读取、正在刷新或最近一次读取失败时返回原因。
 * 读取失败时仍显示上次的内容，但不能据此操作，刷新成功后恢复。备份本身的结构异常（state.error）不在此列
 */
function staleReason(t: Target): string | null {
  const v = shownBackup(t);
  if (!v?.state) return '尚未读取备份状态';
  if (backupLoading(t)) return '正在刷新备份状态，完成后再操作';
  if (v.error) return '备份状态未能刷新，下面显示的是上次读取的内容；请先点击“刷新备份状态”重试';
  return null;
}

/** 初始化页面（早于配置加载）：自行跟踪目标变化；页面打开时才读取 */
export function initBackup(root: HTMLElement): void {
  headEl = h('div', { class: 'backup-page-head' });
  slotEl = h('div', { class: 'backup-task' });
  bodyEl = h('div', { class: 'backup-body scroll' });
  mount(root, headEl, slotEl, bodyEl);
  // 目标变化（含同一版本换绑、解除绑定、外部修改设置后刷新、读取失败）都会经过这里：状态、账号与角色列表随之作废
  on('local', () => {
    noteBackupTarget(currentTarget());
    renderPage();
  });
  on('flavor', () => {
    resetBackup();
    renderPage();
  });
  on('backup', renderBody);
  renderPage();
}

/** 页面进入或离开；进入时读取一次当前目标的状态，已打开时再次进入不重复读取 */
export function setBackupPageOpen(open: boolean): void {
  if (open === pageOpen) return;
  pageOpen = open;
  if (!open) {
    taskView = null;
    if (slotEl) mount(slotEl);
    return;
  }
  renderPage();
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
  if (pageOpen && t && t.flavorId === task.flavorId && t.root === task.root) refreshBackup(t);
}

async function load(t: Target): Promise<void> {
  const key = targetKey(t);
  const my = ++seq;
  loading = { key, seq: my, dirty: false };
  emit('backup');
  try {
    const s = await api().backupState(t.flavorId, t.root);
    if (my !== seq) return;
    // 回复必须属于发起时的目标
    if (targetKey({ flavorId: s.flavorId, root: s.root }) !== key) return;
    shown = { key, state: s, error: null };
    if (s.status !== 'ready') dropCatalog();
  } catch (err) {
    if (my !== seq) return;
    shown = { key, state: shown?.key === key ? shown.state : null, error: errMsg(err) };
  } finally {
    if (loading?.seq === my) {
      const again = loading.dirty && pageOpen;
      loading = null;
      if (again) void load(t);
      else emit('backup');
    }
  }
}

/** 采用操作直接返回的状态（比进行中的读取更新）：作废进行中的读取；关闭或位置不可用时账号与角色列表一并作废 */
function adopt(t: Target, s: BackupState): void {
  if (targetKey({ flavorId: s.flavorId, root: s.root }) !== targetKey(t)) return;
  const now = currentTarget();
  if (!now || targetKey(now) !== targetKey(t)) return;
  seq++;
  loading = null;
  shown = { key: targetKey(t), state: s, error: null };
  if (s.status !== 'ready') dropCatalog();
}

/** 切换版本或目录：丢弃显示的状态与账号 / 角色列表，进行中的读取回复到达时也被丢弃 */
function resetBackup(): void {
  seq++;
  shown = null;
  loading = null;
  dropCatalog();
}

/** 每次本地状态变化时调用：当前目标与上次不同即丢弃状态并作废进行中的读取；页面打开时读取新目标。目标不变的普通刷新不重新读取 */
function noteBackupTarget(t: Target | null): void {
  const key = t ? targetKey(t) : null;
  if (key === lastTarget) return;
  lastTarget = key;
  resetBackup();
  if (t && pageOpen) refreshBackup(t);
}

// ---------- 备份范围：账号与角色列表（点击才读取）与选择 ----------

type ScopeKind = BackupScope['kind'];

interface CatalogShown {
  key: string;
  data: BackupCatalog | null;
  error: string | null;
}

let catalog: CatalogShown | null = null;
let catalogLoad: { key: string; seq: number } | null = null;
let catalogSeq = 0;
/** 当前选择：kind 在目标变化时保留，账号与角色随列表作废 */
const sel: { kind: ScopeKind; account: string | null; chars: Set<string> } = { kind: 'all', account: null, chars: new Set() };
/** 最近一次重新读取后失效的选择说明 */
let lost: string[] = [];

/** 角色的选择键：服务器 + 角色的原始名称（名称不含控制字符，NUL 不会与名称混淆） */
const charKey = (realm: string, character: string): string => `${realm}\u0000${character}`;

/** 作废列表、在途读取与账号 / 角色选择；保留范围类型 */
function dropCatalog(): void {
  catalogSeq++;
  catalog = null;
  catalogLoad = null;
  sel.account = null;
  sel.chars.clear();
  lost = [];
}

/** 当前选择（测试只读） */
export function backupSelection(): { kind: ScopeKind; account: string | null; chars: { realm: string; character: string }[] } {
  return {
    kind: sel.kind,
    account: sel.account,
    chars: [...sel.chars].map((k) => {
      const [realm, character] = k.split('\u0000');
      return { realm, character };
    }),
  };
}

/** 当前目标的账号与角色列表（测试只读） */
export function backupCatalogShown(t: Target): { data: BackupCatalog | null; error: string | null } | null {
  if (!catalog || catalog.key !== targetKey(t)) return null;
  return { data: catalog.data, error: catalog.error };
}

export function catalogLoading(t: Target): boolean {
  return catalogLoad?.key === targetKey(t);
}

/**
 * 用户点击“读取账号与角色”：只在已启用、位置可用、状态已成功刷新且没有任务时读取（主进程只读 WTF 中的目录名称与元数据）；
 * 迟到或属于旧目标的回复丢弃
 */
export async function loadCatalog(t: Target): Promise<void> {
  const key = targetKey(t);
  if (catalogLoad?.key === key || backupActive()) return;
  if (staleReason(t) || shownBackup(t)?.state?.status !== 'ready') return;
  const my = ++catalogSeq;
  catalogLoad = { key, seq: my };
  emit('backup');
  try {
    const c = await api().backupCatalog(t.flavorId, t.root);
    if (my !== catalogSeq) return;
    if (targetKey({ flavorId: c.flavorId, root: c.root }) !== key) return;
    catalog = { key, data: c, error: null };
    lost = pruneSelection(c);
  } catch (err) {
    if (my !== catalogSeq) return;
    // 读取失败：不保留旧列表，窄范围不能创建
    catalog = { key, data: null, error: errMsg(err) };
    lost = [];
  } finally {
    if (catalogLoad?.seq === my) {
      catalogLoad = null;
      emit('backup');
    }
  }
}

/** 新列表中只保留仍存在的精确选择；返回失效项的说明 */
function pruneSelection(c: BackupCatalog): string[] {
  const out: string[] = [];
  if (sel.account === null) {
    sel.chars.clear();
    return out;
  }
  const acct = c.accounts.find((a) => a.account === sel.account);
  if (!acct) {
    out.push(`之前选择的账号「${sel.account}」已不在列表中，已取消选择`);
    sel.account = null;
    sel.chars.clear();
    return out;
  }
  const present = new Set(acct.characterError ? [] : acct.realms.flatMap((r) => r.characters.map((ch) => charKey(r.realm, ch))));
  for (const k of [...sel.chars]) {
    if (present.has(k)) continue;
    sel.chars.delete(k);
    const [realm, character] = k.split('\u0000');
    out.push(`之前选择的角色「${character}（${realm}）」已不在列表中，已取消选择`);
  }
  return out;
}

function setKind(k: ScopeKind): void {
  if (backupActive() || sel.kind === k) return;
  sel.kind = k;
  emit('backup');
}

function setAccount(v: string): void {
  if (backupActive()) return;
  const next = v === '' ? null : v;
  if (next === sel.account) return;
  sel.account = next;
  sel.chars.clear();
  lost = [];
  emit('backup');
}

/** 勾选角色：达到上限后不能再新增（取消勾选不受限制） */
function toggleChar(k: string, checked: boolean): void {
  if (backupActive()) return;
  if (checked) {
    if (!sel.chars.has(k) && sel.chars.size >= MAX_BACKUP_SCOPE_CHARACTERS) {
      emit('backup');
      return;
    }
    sel.chars.add(k);
  } else {
    sel.chars.delete(k);
  }
  emit('backup');
}

/** 按当前选择与当前目标的列表组装新的范围对象；不完整时给出缺少的一项 */
function scopeDraft(t: Target): { scope: BackupScope | null; text: string } {
  if (sel.kind === 'all') return { scope: { kind: 'all' }, text: '将备份：全部 WTF（整个 WTF 文件夹）' };
  const key = targetKey(t);
  if (catalogLoad?.key === key) return { scope: null, text: '正在读取账号与角色…' };
  const c = catalog?.key === key ? catalog : null;
  if (!c) return { scope: null, text: '请先点击“读取账号与角色”，再选择要备份的账号或角色' };
  if (!c.data) return { scope: null, text: '账号与角色读取失败，暂时不能按账号或角色备份；可以重新读取，或改用全部 WTF' };
  const acct = sel.account === null ? undefined : c.data.accounts.find((a) => a.account === sel.account);
  if (!acct) return { scope: null, text: '请选择账号' };
  if (sel.kind === 'account') {
    return { scope: { kind: 'account', account: acct.account }, text: `将备份：账号「${acct.account}」的完整目录（含该账号下所有角色与账号共享配置）` };
  }
  if (acct.characterError) return { scope: null, text: '这个账号的角色无法完整列出，不能按角色备份；可改用指定账号或全部 WTF' };
  const characters = acct.realms.flatMap((r) => r.characters.filter((ch) => sel.chars.has(charKey(r.realm, ch))).map((character) => ({ realm: r.realm, character })));
  if (characters.length === 0) return { scope: null, text: '请至少选择一个角色' };
  // 独立于勾选限制的兜底：超过上限不组装范围，也不会发送
  if (characters.length > MAX_BACKUP_SCOPE_CHARACTERS) {
    return { scope: null, text: `一次最多可选 ${MAX_BACKUP_SCOPE_CHARACTERS} 个角色，当前已选 ${characters.length} 个；请取消一些，或改用指定账号` };
  }
  return {
    scope: { kind: 'characters', account: acct.account, characters },
    text: `将备份：账号「${acct.account}」的 ${characters.length} 个角色（${charList(characters)}），以及该账号的直属文件与 SavedVariables 共享配置`,
  };
}

function charList(list: { realm: string; character: string }[]): string {
  const head = list.slice(0, 3).map((c) => `${c.character}（${c.realm}）`).join('、');
  return list.length > 3 ? `${head} 等 ${list.length} 个` : head;
}

/** 主进程给出的范围（任务、结果、备份列表）；null 表示无法确认（例如清单无法解析） */
export function scopeText(s: BackupScope | null | undefined): string {
  if (!s) return '范围无法确认';
  if (s.kind === 'all') return '全部 WTF';
  if (s.kind === 'account') return `账号「${s.account}」（完整账号目录）`;
  return `账号「${s.account}」的 ${s.characters.length} 个角色：${charList(s.characters)}，含账号共享配置`;
}

/** 悬停时显示的完整角色列表 */
function scopeTitle(s: BackupScope | null | undefined): string {
  if (!s || s.kind !== 'characters') return '';
  return s.characters.map((c) => `${c.character}（${c.realm}）`).join('\n');
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
  emit('backup');
}

function originText(t: Target): string {
  return `「${flavorName(t.flavorId)}」${t.root}`;
}

// ---------- 操作 ----------

async function busy<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (isBusy(key)) return undefined;
  state.busy.add(key);
  emit('backup');
  try {
    return await fn();
  } finally {
    state.busy.delete(key);
    emit('backup');
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
      report(t, 'success', '已启用 WTF 配置备份', [
        `保存位置：${s.containerPath ?? ''}`,
        '之后只有点击“创建备份”才会读取并复制 WTF 中的配置文件；按账号或角色备份前点击“读取账号与角色”，只会读取目录名称、文件类型等元信息，不读取配置内容。',
      ]);
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

/**
 * 手动创建备份：只有这里会读取并复制 WTF 中的文件内容（“读取账号与角色”只读目录名称与元数据）。
 * 范围在点击时按当前列表重新组装（全新对象）；选择不完整、超出上限或状态未成功刷新时不发送。
 * 结果中的范围来自主进程返回的备份；取消与失败时注明本次请求的范围。完整状态由任务结束的推送刷新
 */
export async function runBackup(t: Target): Promise<void> {
  if (backupActive()) return;
  const stale = staleReason(t);
  if (stale) {
    toast(stale, 'warn');
    return;
  }
  const draft = scopeDraft(t);
  const scope = draft.scope;
  if (!scope) {
    toast(draft.text, 'warn');
    return;
  }
  const asked = `本次请求的范围：${scopeText(scope)}`;
  await busy(BUSY.run, async () => {
    try {
      const out = await api().backupRun(t.flavorId, t.root, scope);
      if (out.status === 'cancelled') {
        report(t, 'info', '备份已取消，没有生成新的备份', [out.message, asked]);
        return;
      }
      const r = out.result;
      const head = `${r.snapshot.id}（${r.snapshot.fileCount} 个文件，${bytesText(r.snapshot.totalBytes)}）`;
      const range = `范围：${scopeText(r.snapshot.scope)}`;
      if (r.warnings.length) report(t, 'warn', '备份已完成，但收尾时有需要你检查的情况', [`新备份：${head}`, range, ...r.warnings]);
      else report(t, 'success', '备份已完成', [`新备份：${head}`, range]);
    } catch (err) {
      report(t, 'error', '备份未完成', [errMsg(err), asked]);
    }
  });
}

/** 重新校验一份备份的内容（按清单逐个文件计算校验值）；状态未成功刷新时不基于旧列表发起 */
export async function verifyBackup(t: Target, snapshotId: string): Promise<void> {
  if (backupActive()) return;
  const stale = staleReason(t);
  if (stale) {
    toast(stale, 'warn');
    return;
  }
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

const SCOPE_LABEL: [ScopeKind, string][] = [
  ['all', '全部 WTF'],
  ['account', '指定账号'],
  ['characters', '指定角色'],
];

const SCOPE_DESC: Record<ScopeKind, string> = {
  all: '整个 WTF 文件夹：所有账号与角色，以及 WTF 根级的游戏全局设置。',
  account: '所选账号的完整目录：该账号下所有角色、账号共享配置（SavedVariables）与其他文件（含 .bak）。不含其他账号，也不含 WTF 根级的游戏全局设置。',
  characters:
    '所选角色的目录，加上该账号的直属文件与 SavedVariables（含 .bak）。SavedVariables 是账号共享配置，可能含有其他角色的数据；艾泽魔方不解析也不裁剪其中的 Lua 文件。' +
    '不含其他角色目录、服务器目录下的直属文件，也不含 WTF 根级的游戏全局设置。',
};

const INTRO = [
  '启用后，点击“创建备份”时会把当前游戏目录中的 WTF 文件夹（或你选择的账号、角色部分）复制到你选择的位置。WTF 里保存着账号、角色与插件的设置，可能包含账号名等个人信息。',
  '备份保存到你选择的文件夹，艾泽魔方不会主动上传；如果选择的是 iCloud 等云盘同步的文件夹，副本可能会被云盘同步。不会自动备份，也不会自动删除旧备份。',
  '建议先退出游戏再备份：备份期间游戏写入设置会导致本次备份失败；备份是逐个文件复制并核对的副本，不是瞬间快照。',
  '艾泽魔方不提供一键还原。需要时请在访达中打开备份，自行复制所需文件。',
];

/** 主体重绘时把焦点还给同一个控件（按稳定的键对应）；只恢复原本就在本页面中的焦点，不从其他地方抢走 */
let focusKeys = new WeakMap<Element, string>();
let focusEls = new Map<string, HTMLElement>();
/** 角色列表（有界滚动）；重绘时保持滚动位置 */
let charsEl: HTMLElement | null = null;

function fk<T extends HTMLElement>(key: string, el: T): T {
  focusKeys.set(el, key);
  focusEls.set(key, el);
  return el;
}

function renderPage(): void {
  renderTaskSlot();
  renderBody();
}

/** 任务槽：同一任务只就地更新；编号变化或页面重新打开时重建。页面隐藏时清空 */
function renderTaskSlot(): void {
  if (!slotEl) return;
  const task = pageOpen ? (snap?.task ?? null) : null;
  if (task && taskView?.id === task.id) {
    updateTaskView(taskView, task);
    return;
  }
  taskView = task ? buildTaskView(task) : null;
  mount(slotEl, taskView?.row);
}

function renderBody(): void {
  if (!headEl || !bodyEl || !pageOpen) return;
  const active = (document as { activeElement?: Element | null }).activeElement ?? null;
  const key = active ? focusKeys.get(active) : undefined;
  const charsScroll = charsEl?.scrollTop ?? 0;
  focusKeys = new WeakMap();
  focusEls = new Map();
  charsEl = null;
  const t = currentTarget();
  mount(headEl, headParts(t));
  mount(bodyEl, bodyParts(t));
  restoreCharsScroll(charsScroll);
  if (key) {
    const el = focusEls.get(key) as (HTMLElement & { disabled?: boolean }) | undefined;
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

function restoreCharsScroll(top: number): void {
  if (charsEl && top) charsEl.scrollTop = top;
}

function headParts(t: Target | null): Child[] {
  const loadingNow = t ? backupLoading(t) : false;
  return [
    h('span', { class: 'page-title', text: '配置备份' }),
    t ? fk('refresh', h('button', { class: 'btn btn-sm', disabled: loadingNow, on: { click: () => refreshBackup(t) } }, loadingNow ? [spinner(true), '读取中'] : '刷新备份状态')) : null,
  ];
}

function bodyParts(t: Target | null): Child[] {
  const parts: Child[] = [];
  if (taskError && !snap) {
    parts.push(h('div', { class: 'banner banner-warn' },
      h('span', { text: `备份任务状态未能同步：${taskError}` }),
      fk('sync', h('button', { class: 'btn btn-sm', on: { click: () => void syncBackupTask() } }, '重新同步')),
    ));
  }
  if (notice) parts.push(noticeBox(notice, t));
  if (!t) {
    parts.push(noTargetBox());
    return parts;
  }
  const view = shownBackup(t);
  const s = view?.state ?? null;
  parts.push(sourceBox(t, s));
  if (view?.error) {
    parts.push(h('div', { class: 'banner banner-error' },
      h('div', { text: `无法读取备份状态：${view.error}` }),
      s ? h('div', { text: '下面显示的是上次读取的内容。刷新成功之前，不能创建备份、读取账号与角色或重新校验。' }) : null,
    ));
  }
  if (!s) {
    parts.push(h('div', { class: 'state-box small', text: backupLoading(t) ? '正在读取备份状态…' : '尚未读取备份状态。' }));
  } else if (s.status === 'disabled') {
    parts.push(...disabledParts(t, s));
  } else {
    parts.push(...enabledParts(t, s));
  }
  return parts;
}

function noTargetBox(): HTMLElement {
  let title = '请先选择游戏目录';
  let msg = 'WTF 配置备份针对当前游戏版本绑定的目录，可在顶部的「游戏目录」处选择。';
  if (state.localError) {
    title = '暂时无法确认当前游戏目录';
    msg = `${state.localError}。请在「我的插件」中刷新后再查看备份。`;
  } else if (!state.local) {
    title = '正在读取游戏目录…';
    msg = state.config ? '' : '应用配置加载完成后显示当前游戏版本绑定的目录。';
  }
  return h('div', { class: 'state-box' },
    h('div', { class: 'state-title', text: title }),
    msg ? h('div', { class: 'state-msg', text: msg }) : null,
  );
}

/** 备份来源：主进程确认的游戏目录下的 WTF（只用于显示，不作为任何请求的路径） */
function sourceBox(t: Target, s: BackupState | null): HTMLElement {
  const root = s?.root ?? t.root;
  const wtf = root.endsWith('/') ? `${root}WTF` : `${root}/WTF`;
  return h('div', { class: 'backup-source' },
    h('div', null, `游戏版本「${flavorName(t.flavorId)}」的备份来源：`, h('span', { class: 'mono', text: wtf })),
    h('div', { text: '即当前绑定游戏目录中的 WTF 文件夹；顶部显示的插件目录（Interface/AddOns）不在备份范围内。' }),
  );
}

function noticeBox(n: Notice, t: Target | null): HTMLElement {
  const cls = n.kind === 'error' ? 'banner banner-error' : n.kind === 'warn' ? 'banner banner-warn' : 'banner backup-notice';
  const other = !t || targetKey(t) !== targetKey(n.origin);
  return h('div', { class: `${cls} backup-result` },
    h('div', { class: 'backup-result-title', text: n.title }),
    h('div', { class: 'backup-meta', text: `${formatDateTime(n.at)} · ${other ? `原目录（不是当前显示的目录）：${originText(n.origin)}` : originText(n.origin)}` }),
    n.lines.length ? h('div', { class: 'backup-lines' }, n.lines.map((l) => h('div', { text: l }))) : null,
    fk('notice-close', h('button', { class: 'btn btn-sm', on: { click: () => { notice = null; emit('backup'); } } }, '知道了')),
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
    scope: h('span', { class: 'backup-task-scope' }),
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
      h('div', { class: 'row-meta' }, v.scope),
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

/** 同一任务的变化：只改文字与属性，节点（包括“取消”按钮）保持不变。范围来自任务本身，不取页面当前的选择 */
function updateTaskView(v: TaskView, task: BackupTaskInfo): void {
  const origin: Target = { flavorId: task.flavorId, root: task.root };
  const now = currentTarget();
  const other = !now || targetKey(now) !== targetKey(origin);
  setText(v.name, task.kind === 'run' ? '正在备份' : `正在校验 ${task.snapshotId ?? ''}`);
  setText(v.phase, task.cancelling ? '正在取消…' : PHASE_TEXT[task.phase]);
  setText(v.progress, task.filesTotal > 0 || task.bytesTotal > 0
    ? `${task.filesDone} / ${task.filesTotal} 个文件 · ${bytesText(task.bytesDone)} / ${bytesText(task.bytesTotal)}`
    : '');
  setText(v.scope, task.kind === 'run' ? `范围：${scopeText(task.scope)}` : '');
  if (v.scope.title !== scopeTitle(task.scope)) v.scope.title = scopeTitle(task.scope);
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
  out.push(h('div', { class: 'backup-meta', text: '启用后可以选择备份全部 WTF、指定账号或指定角色。未启用时艾泽魔方不会读取 WTF。' }));
  out.push(h('div', { class: 'health-head' },
    fk('enable', h('button', {
      class: 'btn btn-primary',
      disabled: configuring || backupActive(),
      title: backupActive() ? BUSY_TITLE : '',
      on: { click: () => void enableBackup(t, s.containerPath, false) },
    }, configuring ? [spinner(true), '等待选择'] : s.containerPath ? '选择保存位置并重新启用' : '选择保存位置并启用')),
  ));
  return out;
}

/**
 * 按钮可用性由 status / error、当前范围、状态是否已成功刷新与实时的 backupActive() 派生，不使用 s.canCreate：canCreate 还包含读取时“没有任何任务”，
 * 其他目录的任务结束时不会重新读取当前目录，沿用缓存的 false 会让按钮一直禁用。任务冲突以实时任务快照为准，主进程另有同样的拒绝。
 * 状态读取失败或正在刷新时仍显示上次的内容，但创建、读取账号与角色、重新校验都暂停（动作入口另有同样的检查）
 */
function enabledParts(t: Target, s: BackupState): HTMLElement[] {
  const out: HTMLElement[] = [];
  const active = backupActive();
  const busyTitle = active ? BUSY_TITLE : '';
  const stale = staleReason(t);
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
  const draft = ready ? scopeDraft(t) : null;
  if (ready) out.push(scopeForm(t, active, stale));
  out.push(h('div', { class: 'health-head' },
    fk('create', h('button', {
      class: 'btn btn-primary',
      disabled: !ready || !!s.error || active || !!stale || !draft?.scope,
      title: busyTitle || stale || (s.error ?? '') || (draft && !draft.scope ? draft.text : ''),
      on: { click: () => void runBackup(t) },
    }, isBusy(BUSY.run) ? [spinner(true), '备份中'] : '创建备份')),
    ready ? fk('reveal', h('button', { class: 'btn', on: { click: () => void reveal(t, null) } }, '在访达中查看')) : null,
    fk('replace', h('button', { class: 'btn', disabled: active, title: busyTitle, on: { click: () => void enableBackup(t, s.containerPath, true) } }, '更换保存位置')),
    fk('disable', h('button', { class: 'btn btn-text', disabled: active, title: busyTitle, on: { click: () => void disableBackup(t, s.containerPath) } }, '关闭备份')),
  ));
  if (draft) out.push(h('div', { class: draft.scope ? 'backup-summary' : 'backup-summary backup-summary-missing', text: draft.text }));
  if (ready) {
    out.push(s.snapshots.length
      ? h('div', { class: 'row-list backup-list' }, s.snapshots.map((x) => snapshotRow(t, x, active, stale)))
      : h('div', { class: 'state-box small', text: '还没有备份。选择范围后点击“创建备份”。' }));
  }
  out.push(limitsBox(s));
  return out;
}

/**
 * 备份范围：类型单选；窄范围显示读取按钮、账号下拉框与按服务器分组的角色复选框。任务进行中全部禁用；
 * 状态未成功刷新（stale）时只禁用读取按钮，已有选择保留
 */
function scopeForm(t: Target, lock: boolean, stale: string | null): HTMLElement {
  const kinds = h('div', { class: 'backup-scope-kinds', attrs: { role: 'radiogroup', 'aria-label': '备份范围' } },
    SCOPE_LABEL.map(([k, label]) => h('label', { class: 'backup-choice' },
      fk(`kind:${k}`, h('input', { type: 'radio', name: 'backup-scope-kind', value: k, checked: sel.kind === k, disabled: lock, on: { change: () => setKind(k) } })),
      h('span', { text: label }),
    )),
  );
  const parts: Child[] = [h('legend', { text: '备份范围' }), kinds, h('div', { class: 'backup-scope-desc', text: SCOPE_DESC[sel.kind] })];
  if (sel.kind !== 'all') parts.push(catalogParts(t, lock, stale));
  return h('fieldset', { class: 'backup-scope' }, parts);
}

function catalogParts(t: Target, lock: boolean, stale: string | null): Child[] {
  const key = targetKey(t);
  const loadingNow = catalogLoad?.key === key;
  const c = catalog?.key === key ? catalog : null;
  const out: Child[] = [];
  out.push(h('div', { class: 'backup-scope-actions' },
    // 读取列表期间不禁用按钮（保持焦点），重复点击被忽略
    fk('catalog', h('button', {
      class: 'btn btn-sm',
      disabled: lock || !!stale,
      title: lock ? BUSY_TITLE : stale ?? '只读取 WTF/Account 下账号、服务器与角色的目录名称与类型等信息，不读取文件内容',
      attrs: { 'aria-busy': loadingNow ? 'true' : 'false' },
      on: { click: () => void loadCatalog(t) },
    }, loadingNow ? [spinner(true), '正在读取账号与角色'] : c?.data ? '重新读取账号与角色' : '读取账号与角色')),
    h('span', {
      class: 'backup-meta',
      text: loadingNow
        ? '正在读取目录名称…'
        : c?.data
          ? `读取于 ${formatDateTime(c.data.scannedAt)}。名称来自本地 WTF 目录，只保存在本次界面中`
          : '会读取 WTF 中账号、服务器与角色的目录名称，不读取文件内容',
    }),
  ));
  if (c?.error) out.push(h('div', { class: 'banner banner-error', text: `账号与角色读取失败：${c.error}。暂时不能按账号或角色备份，可以重新读取，或改用全部 WTF。` }));
  if (lost.length) {
    out.push(h('div', { class: 'banner banner-warn' },
      h('div', { text: '重新读取后，部分之前的选择已失效：' }),
      h('div', { class: 'backup-lines' }, lost.map((l) => h('div', { text: l }))),
    ));
  }
  const data = c?.data;
  if (!data) return out;
  if (data.warnings.length) {
    out.push(h('div', { class: 'banner banner-warn' },
      h('div', { text: '读取时有以下情况，相关目录不会出现在列表中（需要时可改用指定账号或全部 WTF）：' }),
      h('div', { class: 'backup-lines' }, data.warnings.map((w) => h('div', { text: w }))),
    ));
  }
  if (data.accounts.length === 0) {
    out.push(h('div', { class: 'state-box small', text: '在 WTF/Account 中没有找到账号目录。可以改用全部 WTF。' }));
    return out;
  }
  out.push(h('label', { class: 'backup-account' },
    h('span', { text: '账号' }),
    fk('account', h('select', {
      disabled: lock,
      on: { change: (e: Event) => setAccount((e.target as HTMLSelectElement).value) },
    },
    h('option', { value: '', selected: sel.account === null, text: '请选择账号' }),
    data.accounts.map((a) => h('option', { value: a.account, selected: a.account === sel.account, text: a.account })),
    )),
  ));
  const acct = sel.account === null ? undefined : data.accounts.find((a) => a.account === sel.account);
  if (sel.kind === 'characters' && acct) out.push(...characterParts(acct, lock));
  return out;
}

function characterParts(acct: BackupCatalog['accounts'][number], lock: boolean): Child[] {
  if (acct.characterError) {
    return [h('div', { class: 'banner banner-warn', text: `这个账号的角色无法完整列出：${acct.characterError}。可以改用指定账号（完整账号目录）或全部 WTF。` })];
  }
  if (acct.realms.length === 0) {
    return [h('div', { class: 'state-box small', text: '这个账号下没有识别到角色目录。可以改用指定账号，备份完整账号目录。' })];
  }
  // 跨服务器统计已选数量；达到上限后未选的角色暂不可勾选，已选的仍可取消
  const count = acct.realms.reduce((n, r) => n + r.characters.filter((ch) => sel.chars.has(charKey(r.realm, ch))).length, 0);
  const full = count >= MAX_BACKUP_SCOPE_CHARACTERS;
  const list = h('div', { class: 'backup-chars', attrs: { role: 'group', 'aria-label': `账号 ${acct.account} 的角色` } },
    acct.realms.map((r) => h('div', { class: 'backup-realm' },
      h('div', { class: 'backup-realm-name', text: r.realm }),
      h('div', { class: 'backup-realm-chars' }, r.characters.map((ch) => {
        const k = charKey(r.realm, ch);
        const checked = sel.chars.has(k);
        return h('label', { class: 'backup-choice', title: `${ch}（${r.realm}）` },
          fk(`char:${k}`, h('input', {
            type: 'checkbox',
            checked,
            disabled: lock || (full && !checked),
            attrs: { 'aria-label': `${ch}（${r.realm}）` },
            on: { change: (e: Event) => toggleChar(k, (e.target as HTMLInputElement).checked) },
          })),
          h('span', { text: ch }),
        );
      })),
    )),
  );
  charsEl = list;
  const meta = full
    ? `已选 ${count} / ${MAX_BACKUP_SCOPE_CHARACTERS} 个角色，已达到一次可选的上限；取消一些后才能再选`
    : `已选 ${count} / ${MAX_BACKUP_SCOPE_CHARACTERS} 个角色（同一账号内可以跨服务器选择多个）`;
  return [list, h('div', { class: full ? 'backup-meta backup-summary-missing' : 'backup-meta', text: meta })];
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

/** stale：状态未成功刷新时暂停重新校验（旧列表可能已过时）；在访达中显示由主进程按登记路径核对，保持可用 */
function snapshotRow(t: Target, x: BackupSnapshotInfo, active: boolean, stale: string | null): HTMLElement {
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
        h('span', { class: 'backup-row-scope', text: `范围：${scopeText(x.scope)}`, title: scopeTitle(x.scope) }),
      ),
      st.detail ? h('div', { class: 'health-issue', text: st.detail }) : null,
    ),
    h('div', { class: 'row-actions' },
      fk(`verify:${x.id}`, h('button', {
        class: 'btn btn-sm',
        disabled: active || !!stale,
        title: active ? BUSY_TITLE : stale ?? '按清单逐个文件重新计算校验值',
        on: { click: () => void verifyBackup(t, x.id) },
      },
        isBusy(BUSY.verify) && snap?.task?.snapshotId === x.id ? [spinner(true), '校验中'] : '重新校验')),
      fk(`reveal:${x.id}`, h('button', { class: 'btn btn-sm', on: { click: () => void reveal(t, x.id) } }, '在访达中显示')),
    ),
  );
}

function limitsBox(s: BackupState): HTMLElement {
  const l = s.limits;
  return h('details', { class: 'backup-limits' },
    h('summary', { text: '备份限制' }),
    h('div', { class: 'backup-meta' },
      h('div', { text: `每个保存位置最多 ${l.maxSnapshots} 份、共 ${bytesText(l.maxTotalBytes)}（全部 WTF 与按账号、角色的备份合计）；单份最多 ${bytesText(l.maxSnapshotBytes)}、${l.maxEntries} 个文件与文件夹；单个文件最多 ${bytesText(l.maxFileBytes)}。` }),
      h('div', { text: '达到上限后不能再创建备份，艾泽魔方不会自动删除旧备份；请在访达中自行整理，或更换保存位置。' }),
      h('div', { text: '所选范围内遇到符号链接、特殊文件或复制期间被改动的文件时，整份备份会停止；未完成的副本不会作为可用备份。若有临时内容未能清理，会明确提示保留的位置。' }),
      h('div', { text: '所选账号或角色在读取列表后被移动、改名或删除时，本次备份会停止，不会改为备份全部 WTF；重新读取后再选择即可。' }),
    ),
  );
}
