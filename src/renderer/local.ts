// 我的插件页：已托管 / 未托管 / 回收站

import type { LocalFolder, LocalState, ManagedProjectView, RecoveryEntryView, TaskPhase } from '../shared/types';
import { BATCH_REASON, updateProject } from './actions.js';
import { confirmDialog, h, modIcon, mount, spinner } from './dom.js';
import { cleanTocText, formatDateTime } from './format.js';
import {
  anyModBusy, api, batchHoldText, bindDirectory, checkUpdates, clearTaskNotes, currentFlavor, currentTarget, currentWatchEntry, flavorName, isBlocked, isBusy, isFinalPhase,
  isOtherFlavor, modBusy, modKey, on, projectHasUpdate, refreshLocal, requireTarget, rowTask, runWrite, state, stillTarget, targetKey,
  updateAllKey, updateCount, updateFor, updatingAll, type RowTask,
} from './state.js';

type Tab = 'managed' | 'unmanaged' | 'recovery';

const KIND_TEXT: Record<RecoveryEntryView['kind'], string> = {
  uninstall: '卸载',
  'update-backup': '更新前备份',
  takeover: '安装时接管',
};

let tab: Tab = 'managed';
let filter = '';
/** 展开了目录列表的项目，重绘时保持展开 */
const openFolders = new Set<string>();
/** 当前显示的进行中任务的状态文字（名称旁的标签与操作按钮中的文字，按插件编号），下载百分比变化时就地更新 */
const progressEls = new Map<string, HTMLElement[]>();

function trackProgress(modId: string, el: HTMLElement): HTMLElement {
  const list = progressEls.get(modId);
  if (list) list.push(el);
  else progressEls.set(modId, [el]);
  return el;
}

/** 占据“更新”按钮位置的不可点击状态按钮（中性样式）；modId 给出时文字随任务进度就地更新 */
function busyButton(text: string, title: string, modId?: string): HTMLButtonElement {
  const label = h('span', { text });
  if (modId) trackProgress(modId, label);
  return h('button', { class: 'btn btn-sm btn-busy', disabled: true, title }, spinner(true), label);
}
/** 全部更新进行中时保持开始时的行顺序，完成的项目不在列表中跳动；结束后恢复正常排序 */
let frozenOrder: { key: string; pos: Map<string, number> } | null = null;

const ROW_PHASE_TEXT: Partial<Record<TaskPhase, string>> = {
  queued: '等待中',
  checking: '准备中',
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
};

function taskText(r: RowTask): string {
  const text = ROW_PHASE_TEXT[r.phase] ?? '处理中';
  return r.phase === 'downloading' && r.percent !== null ? `${text} ${r.percent}%` : text;
}

/** 失败或取消的说明：版本保持不变 */
function taskNote(r: RowTask): string {
  if (r.phase === 'failed') return `未完成：${r.message ?? '操作失败'}`;
  return r.message ?? '已取消';
}

let toolbarEl!: HTMLElement;
let bodyEl!: HTMLElement;
let filterInput!: HTMLInputElement;
let unmanagedListEl!: HTMLElement;

export function initLocal(root: HTMLElement): void {
  toolbarEl = h('div', { class: 'local-toolbar' });
  bodyEl = h('div', { class: 'local-body' });
  filterInput = h('input', { class: 'filter-input', type: 'search', placeholder: '按目录名或标题过滤', spellcheck: false });
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    if (state.local) renderUnmanagedList(state.local);
  });
  unmanagedListEl = h('div', { class: 'row-list' });
  mount(root, toolbarEl, bodyEl);

  on('local', render);
  on('progress', () => {
    for (const [modId, els] of progressEls) {
      const r = rowTask(modId);
      if (!r || isFinalPhase(r.phase)) continue;
      const text = taskText(r);
      for (const el of els) if (el.textContent !== text) el.textContent = text;
    }
  });
  on('flavor', () => {
    filter = '';
    filterInput.value = '';
    render();
  });
  render();
}

function render(): void {
  renderToolbar();
  renderBody();
}

function renderToolbar(): void {
  const local = state.local;
  const hasRoot = !!local?.profile.root;
  const blocked = isBlocked();
  const n = updateCount();
  const checking = isBusy('check');
  const batch = updatingAll();
  const modsBusy = anyModBusy();

  const info = checkInfo();
  mount(toolbarEl,
    h('div', { class: 'page-title' },
      h('span', { text: '我的插件' }),
      state.localLoading && local ? spinner(true) : null,
      info ? h('span', { class: info.error ? 'check-info check-info-warn' : 'check-info', text: info.text, title: info.title }) : null,
    ),
    h('div', { class: 'toolbar-actions' },
      h('button', {
        class: 'btn',
        disabled: !hasRoot || checking || !local || local.managed.length === 0,
        on: { click: () => void checkUpdates() },
      }, checking ? [spinner(true), '检查中'] : '检查更新'),
      h('button', {
        class: 'btn btn-primary',
        disabled: !hasRoot || blocked || n === 0 || batch || modsBusy,
        title: blocked ? '游戏目录当前不可写入' : modsBusy && !batch ? '有插件正在处理，完成后再全部更新' : '',
        on: { click: () => void doUpdateAll() },
      }, batch ? [spinner(true), '更新中'] : `全部更新 (${n})`),
      h('button', {
        class: 'btn',
        disabled: state.localLoading,
        on: { click: () => void refreshLocal() },
      }, '刷新'),
    ),
  );
}

/** 当前目录的自动检查状态：上次检查时间、失败数量或整体错误 */
function checkInfo(): { text: string; title: string; error: boolean } | null {
  const e = currentWatchEntry();
  if (!e || !state.local?.profile.root || state.local.managed.length === 0) return null;
  const next = e.nextCheckAt ? `；下次自动检查约 ${formatDateTime(e.nextCheckAt).slice(11)}` : '';
  const settingsError = state.watch?.settingsError ?? null;
  if (settingsError) return { text: '无法确认更新：设置文件无法读取', title: `${settingsError}；自动检查已暂停。修复设置文件后点「检查更新」恢复检查`, error: true };
  if (e.status === 'checking') return { text: '正在检查更新…', title: '', error: false };
  if (e.error) return { text: '无法确认更新状态', title: `${e.error}${next}`, error: true };
  if (e.checkedAt === null) return { text: '尚未检查更新', title: '蜂简运行期间会自动检查已托管插件的更新', error: false };
  const at = `上次检查 ${formatDateTime(e.checkedAt)}`;
  if (e.failed > 0) return { text: `${at} · ${e.failed} 个检查失败`, title: `失败的插件不会显示为“已是最新”${next}`, error: true };
  return { text: at, title: `蜂简运行期间每小时自动检查一次${next}`, error: false };
}

/** 从更新提醒跳转过来时显示“已托管”标签页 */
export function showManagedTab(): void {
  if (tab === 'managed') return;
  tab = 'managed';
  if (bodyEl) renderBody();
}

export async function doUpdateAll(): Promise<void> {
  const t = requireTarget();
  // 同一目标已在全部更新，或有插件正在单独处理时不再发起
  if (!t || updatingAll(t) || anyModBusy()) return;
  clearTaskNotes(t);
  state.batchPlanned.delete(targetKey(t));
  try {
    await runWrite(updateAllKey(t), () => api().updateAll(t.flavorId, t.root));
  } finally {
    state.batchPlanned.delete(targetKey(t));
  }
}

function renderBody(): void {
  const local = state.local;
  if (!local) {
    if (state.localError) {
      mount(bodyEl, h('div', { class: 'state-box state-error' },
        h('div', { class: 'state-title', text: '读取本地插件失败' }),
        h('div', { class: 'state-msg', text: state.localError }),
        h('button', { class: 'btn', on: { click: () => void refreshLocal() } }, '重试'),
      ));
    } else {
      mount(bodyEl, h('div', { class: 'state-box' }, spinner(), h('div', { text: '正在读取本地插件…' })));
    }
    return;
  }

  if (!local.profile.root) {
    mount(bodyEl, h('div', { class: 'state-box' },
      h('div', { class: 'empty-hex' }),
      h('div', { class: 'state-title', text: `尚未设置「${flavorName(local.flavorId)}」的游戏目录` }),
      h('div', { class: 'state-msg', text: '请选择魔兽世界对应版本的目录（例如 _retail_、_classic_ 等），蜂简只会管理其中 Interface/AddOns 下的插件。' }),
      h('button', { class: 'btn btn-primary', disabled: isBusy('bind'), on: { click: () => void bindDirectory() } }, '选择游戏目录'),
    ));
    return;
  }

  const banners: HTMLElement[] = [];
  if (state.localError) banners.push(h('div', { class: 'banner banner-warn', text: `刷新失败，显示的是上次结果：${state.localError}` }));
  if (local.error) banners.push(h('div', { class: 'banner banner-error', text: local.error }));
  if (local.dir?.status === 'blocked') {
    banners.push(h('div', { class: 'banner banner-error banner-pre' },
      h('div', { class: 'banner-title', text: '游戏目录当前不可写入，已禁用所有写操作' }),
      h('div', { text: local.dir.message ?? '' }),
    ));
  }

  const tabs: [Tab, string, number][] = [
    ['managed', '已托管', local.managed.length],
    ['unmanaged', '未托管', local.unmanaged.length],
    ['recovery', '回收站', local.recovery.length],
  ];
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([id, label, count]) =>
    h('button', {
      class: id === tab ? 'tab active' : 'tab',
      on: { click: () => { tab = id; renderBody(); } },
    }, label, h('span', { class: 'tab-count', text: String(count) })),
  ));

  let content: HTMLElement;
  progressEls.clear();
  if (tab === 'managed') content = renderManaged(local);
  else if (tab === 'unmanaged') content = renderUnmanaged(local);
  else content = renderRecovery(local);

  const prevScroll = bodyEl.querySelector('.tab-content')?.scrollTop ?? 0;
  mount(bodyEl, banners, tabBar, content);
  content.scrollTop = prevScroll;
}

// ---------- 已托管 ----------

function renderManaged(local: LocalState): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  if (local.managed.length === 0) {
    mount(box, emptyState('还没有通过蜂简安装的插件', '到「发现插件」中搜索并安装，蜂简会记录来源并支持一键更新。'));
    return box;
  }
  const list = [...local.managed].sort((a, b) => Number(projectHasUpdate(b)) - Number(projectHasUpdate(a)) || a.name.localeCompare(b.name, 'zh'));
  const t = currentTarget();
  if (t && updatingAll(t)) {
    if (frozenOrder?.key !== targetKey(t)) frozenOrder = { key: targetKey(t), pos: new Map(list.map((p, i) => [p.modId, i])) };
    const pos = frozenOrder.pos;
    // 批次开始后才出现的项目排在后面，彼此保持正常顺序
    list.sort((a, b) => (pos.get(a.modId) ?? pos.size) - (pos.get(b.modId) ?? pos.size));
  } else frozenOrder = null;
  mount(box, h('div', { class: 'row-list' }, list.map((p) => managedRow(p))));
  return box;
}

function managedRow(p: ManagedProjectView): HTMLElement {
  const blocked = isBlocked();
  const t = currentTarget();
  const task = rowTask(p.modId);
  const active = !!task && !isFinalPhase(task.phase);
  const busy = modBusy(p.modId);
  /** 已发起、还没有任务进度的单项操作（受理前、卸载等） */
  const pending = !active && !!t && isBusy(modKey(t, p.modId));
  const hasUpdate = projectHasUpdate(p);
  const u = updateFor(p);
  const missing = p.folders.filter((f) => !f.present).length;
  const otherFlavor = isOtherFlavor(p);
  const otherTitle = `该插件按「${flavorName(p.flavorId)}」版本安装，与当前游戏版本不同：可以卸载（卸载后可恢复），但不会检查更新、更新或重装。如需改用当前版本，请先卸载再安装。`;

  let status: HTMLElement | null = null;
  if (active) {
    status = trackProgress(p.modId, h('span', { class: 'tag tag-accent tag-task', text: taskText(task) }));
  } else if (hasUpdate) status = h('span', { class: 'tag tag-accent', text: `可更新到 ${u?.latestVersion ?? '新版本'}`, title: u?.stale ? (u.error ?? '') : '' });
  else if (u?.skipped) status = h('span', { class: 'tag tag-muted', text: '不检查更新', title: u.skipped });
  else if (u?.error) status = h('span', { class: 'small-error', text: u.error, title: u.error });
  else if (state.updatesChecked && u) status = h('span', { class: 'tag tag-muted', text: '已是最新' });
  const note = task && !active
    ? h('span', { class: task.phase === 'failed' ? 'small-error' : 'tag tag-muted', text: taskNote(task), title: task.message ?? '' })
    : null;

  const folders = h('details', { class: 'folders', open: openFolders.has(p.modId) },
    h('summary', null, `${p.folders.length} 个目录`, missing > 0 ? h('span', { class: 'tag tag-danger', text: `缺失 ${missing}` }) : null),
    h('div', { class: 'folder-list' }, p.folders.map((f) =>
      h('span', { class: f.present ? 'folder' : 'folder folder-missing', text: f.present ? f.name : `${f.name}（缺失）` }),
    )),
  );

  folders.addEventListener('toggle', () => {
    if (folders.open) openFolders.add(p.modId);
    else openFolders.delete(p.modId);
  });

  const disabledTitle = blocked ? '游戏目录当前不可写入' : busy && updatingAll() ? BATCH_REASON : '';
  // “更新”按钮的位置：进行中的任务显示阶段与进度，已发起尚未开始的操作显示处理中，全部更新期间的其他可更新插件显示检查中 / 全部更新中
  const hold = batchHoldText();
  let updateBtn: HTMLElement | null = null;
  if (active) updateBtn = busyButton(taskText(task), disabledTitle || '正在处理这个插件', p.modId);
  else if (pending) updateBtn = busyButton('处理中', '正在处理这个插件');
  else if (hasUpdate && !otherFlavor) {
    updateBtn = hold
      ? busyButton(hold, BATCH_REASON)
      : h('button', { class: 'btn btn-sm btn-primary', disabled: blocked || busy, title: disabledTitle, on: { click: () => void updateProject(p, false) } }, '更新');
  }
  return h('div', { class: 'row' },
    modIcon(p.logo, p.name, 'sm'),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        h('span', { class: 'row-name', text: p.name }),
        h('span', { class: otherFlavor ? 'tag tag-warn' : 'tag', text: flavorName(p.flavorId), title: otherFlavor ? otherTitle : '' }),
        status,
        note,
      ),
      h('div', { class: 'row-meta' },
        h('span', { text: `版本 ${p.version || '—'}` }),
        h('span', { text: `安装于 ${formatDateTime(p.installedAt)}` }),
      ),
      folders,
    ),
    h('div', { class: 'row-actions' },
      updateBtn,
      h('button', {
        class: 'btn btn-sm', disabled: blocked || busy || otherFlavor, title: disabledTitle || (otherFlavor ? otherTitle : '重新下载并安装最新文件'),
        on: { click: () => void updateProject(p, true) },
      }, '重装'),
      h('button', {
        class: 'btn btn-sm btn-ghost-danger', disabled: blocked || busy, title: disabledTitle,
        on: { click: () => void uninstallProject(p) },
      }, '卸载'),
    ),
  );
}

/** 卸载：作用于当前显示的目录（包括来源版本不同的插件）；确认前记录目标，确认后复核 */
export async function uninstallProject(p: ManagedProjectView): Promise<void> {
  const t = requireTarget();
  if (!t || modBusy(p.modId)) return;
  const present = p.folders.filter((f) => f.present).map((f) => f.name);
  const ok = await confirmDialog({
    title: `卸载「${p.name}」？`,
    message: '以下目录会被移入蜂简回收站，可随时在「回收站」中恢复；不会删除 WTF 中保存的插件设置。',
    detail: present.length ? present : ['（没有现存目录，仅移除托管记录）'],
    confirmText: '卸载',
    danger: true,
  });
  if (!ok || !stillTarget(t) || modBusy(p.modId)) return;
  await runWrite(modKey(t, p.modId), () => api().uninstallProject(p.modId, t.flavorId, t.root));
}

// ---------- 未托管 ----------

function renderUnmanaged(local: LocalState): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  const note = h('div', { class: 'note', text: '这些目录不是由蜂简安装的，蜂简不会自动更新它们，也不会按名称猜测来源。' });
  if (local.unmanaged.length === 0) {
    mount(box, note, emptyState('没有未托管的目录', 'AddOns 目录中的插件都由蜂简管理。'));
    return box;
  }
  renderUnmanagedList(local);
  mount(box, note, local.unmanaged.length > 8 ? h('div', { class: 'filter-bar' }, filterInput) : null, unmanagedListEl);
  return box;
}

function renderUnmanagedList(local: LocalState): void {
  const items = local.unmanaged.filter((f) => {
    if (!filter) return true;
    const title = f.toc ? cleanTocText(f.toc.title).toLowerCase() : '';
    return f.name.toLowerCase().includes(filter) || title.includes(filter);
  });
  if (items.length === 0) {
    mount(unmanagedListEl, h('div', { class: 'state-box small', text: '没有匹配的目录' }));
    return;
  }
  mount(unmanagedListEl, items.map(folderRow));
}

function folderRow(f: LocalFolder): HTMLElement {
  const blocked = isBlocked();
  const key = `folder:${f.name}`;
  const busy = isBusy(key);
  const iface = currentFlavor()?.interfaceNumber ?? null;
  const title = f.toc ? cleanTocText(f.toc.title) : '';
  const tags: HTMLElement[] = [];
  if (!f.toc) tags.push(h('span', { class: 'tag tag-muted', text: '无 TOC' }));
  else if (iface !== null && !f.toc.interfaces.includes(iface)) {
    tags.push(h('span', {
      class: 'tag tag-muted',
      text: '可能不兼容',
      title: `TOC Interface：${f.toc.interfaces.join(', ') || '未声明'}；当前版本：${iface}`,
    }));
  }
  if (f.symlink) tags.push(h('span', { class: 'tag tag-muted', text: '符号链接' }));

  return h('div', { class: 'row' },
    h('div', { class: 'folder-icon' }),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('span', { class: 'row-name mono', text: f.name }), tags),
      h('div', { class: 'row-meta' },
        title && title !== f.name ? h('span', { text: title }) : null,
        f.toc?.version ? h('span', { text: `版本 ${cleanTocText(f.toc.version)}` }) : null,
      ),
    ),
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn btn-sm btn-ghost-danger',
        disabled: blocked || busy,
        title: blocked ? '游戏目录当前不可写入' : '',
        on: { click: () => void trashFolder(f) },
      }, busy ? [spinner(true), '处理中'] : '移入回收站'),
    ),
  );
}

export async function trashFolder(f: LocalFolder): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  const ok = await confirmDialog({
    title: `移入回收站：${f.name}`,
    message: f.symlink
      ? '这是一个符号链接，只会移除链接本身，不会影响链接指向的内容。之后可在「回收站」中恢复。'
      : '该目录会被移入蜂简回收站，之后可在「回收站」中恢复；不会删除 WTF 中保存的插件设置。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok || !stillTarget(t)) return;
  await runWrite(`folder:${f.name}`, () => api().uninstallFolder(f.name, t.flavorId, t.root));
}

// ---------- 回收站 ----------

function renderRecovery(local: LocalState): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  if (local.recovery.length === 0) {
    mount(box, emptyState('回收站是空的', '卸载、更新前备份以及安装时接管的目录会保存在这里，可以随时恢复。'));
    return box;
  }
  const list = [...local.recovery].sort((a, b) => b.createdAt - a.createdAt);
  mount(box, h('div', { class: 'row-list' }, list.map(recoveryRow)));
  return box;
}

function recoveryRow(r: RecoveryEntryView): HTMLElement {
  const blocked = isBlocked();
  const key = `recovery:${r.id}`;
  const busy = isBusy(key);
  const dis = blocked ? '游戏目录当前不可写入' : '';
  return h('div', { class: 'row' },
    h('div', { class: `kind-badge kind-${r.kind}`, text: KIND_TEXT[r.kind] ?? r.kind }),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('span', { class: 'row-name', text: r.label })),
      h('div', { class: 'row-meta' },
        h('span', { text: formatDateTime(r.createdAt) }),
        h('span', { class: 'mono', text: r.folders.join('、') || '（无目录）' }),
      ),
    ),
    h('div', { class: 'row-actions' },
      busy ? h('span', { class: 'busy-text' }, spinner(true), '处理中') : null,
      h('button', {
        class: 'btn btn-sm', disabled: blocked || busy, title: dis || '把这些目录放回 AddOns',
        on: { click: () => void restore(r) },
      }, '恢复'),
      h('button', {
        class: 'btn btn-sm btn-danger', disabled: blocked || busy, title: dis,
        on: { click: () => void purge(r) },
      }, '永久删除'),
    ),
  );
}

export async function restore(r: RecoveryEntryView): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  await runWrite(`recovery:${r.id}`, () => api().restore(r.id, t.flavorId, t.root));
}

export async function purge(r: RecoveryEntryView): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  const first = await confirmDialog({
    title: '永久删除回收站条目？',
    message: `「${r.label}」中的目录将被彻底删除，无法再恢复。`,
    detail: r.folders,
    confirmText: '继续',
    danger: true,
  });
  if (!first) return;
  const second = await confirmDialog({
    title: '再次确认',
    message: '此操作不可撤销，确定要永久删除吗？',
    confirmText: '永久删除',
    danger: true,
  });
  if (!second || !stillTarget(t)) return;
  await runWrite(`recovery:${r.id}`, () => api().purge(r.id, t.flavorId, t.root));
}

function emptyState(title: string, msg: string): HTMLElement {
  return h('div', { class: 'state-box' },
    h('div', { class: 'empty-hex' }),
    h('div', { class: 'state-title', text: title }),
    h('div', { class: 'state-msg', text: msg }),
  );
}
