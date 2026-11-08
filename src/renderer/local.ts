// 我的插件页：已托管 / 未托管 / 回收站

import type { LocalFolder, LocalState, ManagedProjectView, RecoveryEntryView } from '../shared/types';
import { modKey, updateProject } from './actions.js';
import { confirmDialog, h, modIcon, mount, spinner } from './dom.js';
import { cleanTocText, formatDateTime } from './format.js';
import {
  api, bindDirectory, checkUpdates, currentFlavor, flavorName, isBlocked, isBusy, isOtherFlavor,
  on, projectHasUpdate, refreshLocal, requireTarget, runWrite, state, stillTarget, updateCount,
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
  const updatingAll = isBusy('updateAll');

  mount(toolbarEl,
    h('div', { class: 'page-title' },
      h('span', { text: '我的插件' }),
      state.localLoading && local ? spinner(true) : null,
    ),
    h('div', { class: 'toolbar-actions' },
      h('button', {
        class: 'btn',
        disabled: !hasRoot || checking || !local || local.managed.length === 0,
        on: { click: () => void checkUpdates() },
      }, checking ? [spinner(true), '检查中'] : '检查更新'),
      h('button', {
        class: 'btn btn-primary',
        disabled: !hasRoot || blocked || n === 0 || updatingAll,
        title: blocked ? '游戏目录当前不可写入' : '',
        on: { click: () => void doUpdateAll() },
      }, updatingAll ? [spinner(true), '更新中'] : `全部更新 (${n})`),
      h('button', {
        class: 'btn',
        disabled: state.localLoading,
        on: { click: () => void refreshLocal() },
      }, '刷新'),
    ),
  );
}

export async function doUpdateAll(): Promise<void> {
  const t = requireTarget();
  if (!t) return;
  await runWrite('updateAll', () => api().updateAll(t.flavorId, t.root));
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
  mount(box, h('div', { class: 'row-list' }, list.map((p) => managedRow(p))));
  return box;
}

function managedRow(p: ManagedProjectView): HTMLElement {
  const blocked = isBlocked();
  const busy = isBusy(modKey(p.modId));
  const hasUpdate = projectHasUpdate(p);
  const u = state.updates.get(p.modId);
  const missing = p.folders.filter((f) => !f.present).length;
  const otherFlavor = isOtherFlavor(p);
  const otherTitle = `该插件按「${flavorName(p.flavorId)}」版本安装，与当前游戏版本不同：可以卸载（卸载后可恢复），但不会检查更新、更新或重装。如需改用当前版本，请先卸载再安装。`;

  let status: HTMLElement | null = null;
  if (hasUpdate) status = h('span', { class: 'tag tag-accent', text: `可更新到 ${u?.latestVersion ?? '新版本'}` });
  else if (u?.skipped) status = h('span', { class: 'tag tag-muted', text: '不检查更新', title: u.skipped });
  else if (u?.error) status = h('span', { class: 'small-error', text: u.error, title: u.error });
  else if (state.updatesChecked && u) status = h('span', { class: 'tag tag-muted', text: '已是最新' });

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

  const disabledTitle = blocked ? '游戏目录当前不可写入' : '';
  return h('div', { class: 'row' },
    modIcon(p.logo, p.name, 'sm'),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        h('span', { class: 'row-name', text: p.name }),
        h('span', { class: otherFlavor ? 'tag tag-warn' : 'tag', text: flavorName(p.flavorId), title: otherFlavor ? otherTitle : '' }),
        status,
      ),
      h('div', { class: 'row-meta' },
        h('span', { text: `版本 ${p.version || '—'}` }),
        h('span', { text: `安装于 ${formatDateTime(p.installedAt)}` }),
      ),
      folders,
    ),
    h('div', { class: 'row-actions' },
      busy ? h('span', { class: 'busy-text' }, spinner(true), '处理中') : null,
      hasUpdate && !otherFlavor ? h('button', {
        class: 'btn btn-sm btn-primary', disabled: blocked || busy, title: disabledTitle,
        on: { click: () => void updateProject(p, false) },
      }, '更新') : null,
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
  if (!t) return;
  const present = p.folders.filter((f) => f.present).map((f) => f.name);
  const ok = await confirmDialog({
    title: `卸载「${p.name}」？`,
    message: '以下目录会被移入蜂简回收站，可随时在「回收站」中恢复；不会删除 WTF 中保存的插件设置。',
    detail: present.length ? present : ['（没有现存目录，仅移除托管记录）'],
    confirmText: '卸载',
    danger: true,
  });
  if (!ok || !stillTarget(t)) return;
  await runWrite(modKey(p.modId), () => api().uninstallProject(p.modId, t.flavorId, t.root));
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
