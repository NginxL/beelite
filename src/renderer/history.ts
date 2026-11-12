// 我的插件页的「操作记录」：按当前目标（版本 + 目录）读取主进程的记录；回复属于旧目标或已有更新的读取时丢弃。
// 记录只说明艾泽魔方执行过的操作：成功只表示已确认提交；结果未确认的项目以当前插件列表为准。

import type { HistoryEntry, HistoryKind, HistoryStatus, HistoryView } from '../shared/types';
import { h, mount, spinner } from './dom.js';
import { errMsg, formatDateTime } from './format.js';
import { api, emit, targetKey, type Target } from './state.js';

const KIND_TEXT: Record<HistoryKind, string> = {
  install: '安装',
  update: '更新',
  reinstall: '重装',
  uninstall: '卸载',
  'uninstall-folder': '移入回收站',
  restore: '从回收站恢复',
  purge: '永久删除',
  pause: '暂停更新',
  resume: '恢复更新',
};

const STATUS_TEXT: Record<HistoryStatus, string> = {
  accepted: '进行中',
  succeeded: '成功',
  unchanged: '未改动',
  cancelled: '已取消',
  'not-processed': '未处理',
  failed: '失败',
  unconfirmed: '结果未确认',
};

let view: HistoryView | null = null;
let viewKey: string | null = null;
let error: string | null = null;
let errorKey: string | null = null;
let loading = false;
let seq = 0;

/** 读取目标的记录；只采用最后一次读取、且仍是这个目标的回复 */
export async function loadHistory(t: Target): Promise<void> {
  const my = ++seq;
  const key = targetKey(t);
  loading = true;
  try {
    const v = await api().historyList(t.flavorId, t.root);
    if (my !== seq) return;
    if (targetKey({ flavorId: v.flavorId, root: v.root }) !== key) return;
    view = v;
    viewKey = key;
    error = null;
    errorKey = null;
  } catch (err) {
    if (my !== seq) return;
    error = errMsg(err);
    errorKey = key;
  } finally {
    if (my === seq) {
      loading = false;
      emit('local');
    }
  }
}

/** 切换版本或目录：丢弃已显示的记录，进行中的读取回复到达时也被丢弃 */
export function resetHistory(): void {
  seq++;
  view = null;
  viewKey = null;
  error = null;
  errorKey = null;
  loading = false;
}

/** 当前显示的记录（测试与其他模块只读） */
export function shownHistory(): HistoryView | null {
  return view;
}

export function renderHistory(t: Target): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  const key = targetKey(t);
  const note = h('div', {
    class: 'note',
    text: '只记录艾泽魔方在这个目录执行的操作（保存在本机，最多 500 条）。“成功”只表示已确认提交；“结果未确认”的操作请以当前插件列表为准。',
  });
  if (viewKey !== key) {
    if (errorKey === key && error) {
      mount(box, note, h('div', { class: 'state-box state-error' },
        h('div', { class: 'state-title', text: '读取操作记录失败' }),
        h('div', { class: 'state-msg', text: error }),
        h('button', { class: 'btn', on: { click: () => void loadHistory(t) } }, '重试'),
      ));
      return box;
    }
    // 尚未读取这个目标（例如刚切换）：发起读取（在渲染之外）
    if (!loading) queueMicrotask(() => void loadHistory(t));
    mount(box, note, h('div', { class: 'state-box' }, spinner(), h('div', { text: '正在读取操作记录…' })));
    return box;
  }
  // 同一目标再次读取失败：保留上次的记录供查看，并说明它可能已过时
  const stale = errorKey === key && error
    ? h('div', { class: 'banner banner-warn' },
      h('span', { text: `刷新操作记录失败，显示的是上次结果：${error}` }),
      h('button', { class: 'btn btn-sm', disabled: loading, on: { click: () => void loadHistory(t) } }, loading ? '读取中' : '重试'),
    )
    : null;
  const entries = view?.entries ?? [];
  if (entries.length === 0) {
    mount(box, note, stale, h('div', { class: 'state-box' },
      h('div', { class: 'empty-hex' }),
      h('div', { class: 'state-title', text: '还没有操作记录' }),
      h('div', { class: 'state-msg', text: '安装、更新、卸载、恢复、暂停更新等操作会记录在这里。' }),
    ));
    return box;
  }
  mount(box, note, stale, h('div', { class: 'row-list' }, entries.map(entryRow)));
  return box;
}

function versionText(e: HistoryEntry): string | null {
  const v = (x: { fileId: string; version: string }) => `${x.version || '—'}（文件 ${x.fileId}）`;
  if (e.previous && e.installed) return `${v(e.previous)} → ${v(e.installed)}`;
  if (e.installed) return `版本 ${v(e.installed)}`;
  if (e.previous) return `原版本 ${v(e.previous)}`;
  // 没有提交回执：只能说明请求时界面看到的文件，不代表实际版本
  if (e.expectedFileId) return `请求时的文件 ${e.expectedFileId}`;
  return null;
}

function entryRow(e: HistoryEntry): HTMLElement {
  const versions = versionText(e);
  return h('div', { class: 'row history-row' },
    h('div', { class: `kind-badge history-status history-${e.status}`, text: STATUS_TEXT[e.status] ?? e.status }),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        h('span', { class: 'row-name', text: e.name || '—' }),
        h('span', { class: 'tag', text: KIND_TEXT[e.kind] ?? e.kind }),
        e.batchId ? h('span', { class: 'tag tag-muted', text: '全部更新' }) : null,
        e.unsaved ? h('span', { class: 'tag tag-warn', text: '未保存', title: '这条记录还没有写入磁盘，重启后可能缺失' }) : null,
        e.truncated ? h('span', { class: 'tag tag-muted', text: '部分内容已截断' }) : null,
      ),
      h('div', { class: 'row-meta' },
        h('span', { text: formatDateTime(e.startedAt) }),
        versions ? h('span', { text: versions }) : null,
      ),
      e.message ? h('div', { class: 'history-message', text: e.message }) : null,
      e.warnings.length
        ? h('details', { class: 'folders' },
          h('summary', null, `${e.warnings.length} 条提示`),
          h('div', { class: 'history-warnings' }, e.warnings.map((w) => h('div', { text: w }))),
        )
        : null,
    ),
  );
}
