// 发现插件页：搜索、排序、分类、分页列表

import type { ModSummary, SearchResult, SortOrder } from '../shared/types';
import { modActionButton } from './actions.js';
import { openDetail } from './detail.js';
import { h, modIcon, mount, spinner } from './dom.js';
import { errMsg, formatCount, formatDate } from './format.js';
import { api, on, state } from './state.js';

const ORDERS: [SortOrder, string][] = [
  ['ranking', '综合'],
  ['update', '更新时间'],
  ['total_download', '下载量'],
  ['favourite', '收藏量'],
];
const DEFAULT_PAGE_SIZE = 12;

const ds = {
  keyword: '',
  order: 'ranking' as SortOrder,
  category: 0,
  offset: 0,
  /** 上一页的 offset 栈 */
  stack: [] as number[],
  /** 第一页返回的条数，作为本次搜索稳定的每页大小（不能用末页余数推算） */
  pageSize: 0,
  result: null as SearchResult | null,
  loading: false,
  error: null as string | null,
};

let seq = 0;
let debounce = 0;

let input!: HTMLInputElement;
let sortEl!: HTMLElement;
let chipsEl!: HTMLElement;
let listEl!: HTMLElement;
let pagerEl!: HTMLElement;

export function initDiscover(root: HTMLElement): void {
  input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜索插件名称或关键词，回车立即搜索',
    spellcheck: false,
    autocomplete: 'off',
  });
  input.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(newSearch, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      window.clearTimeout(debounce);
      newSearch();
    }
  });

  sortEl = h('div', { class: 'segmented' });
  chipsEl = h('div', { class: 'chips' });
  listEl = h('div', { class: 'mod-list scroll' });
  pagerEl = h('div', { class: 'pager' });

  mount(root,
    h('div', { class: 'discover-head' },
      h('div', { class: 'search-box' }, h('span', { class: 'search-icon' }), input),
      h('div', { class: 'filter-row' }, sortEl, chipsEl),
    ),
    listEl,
    pagerEl,
  );
  renderSort();

  on('flavor', () => {
    renderChips();
    newSearch();
  });
  // 本地状态变化只影响按钮，重绘列表即可
  on('local', () => {
    if (!ds.loading && ds.result) renderList();
  });
}

export function focusSearch(): void {
  input?.focus();
}

function newSearch(): void {
  ds.keyword = input.value.trim();
  ds.offset = 0;
  ds.stack = [];
  ds.pageSize = 0;
  void load();
}

async function load(): Promise<void> {
  const s = ++seq;
  const fid = state.flavorId;
  ds.loading = true;
  ds.error = null;
  render();
  try {
    const r = await api().search({ flavorId: fid, category: ds.category, order: ds.order, keyword: ds.keyword, offset: ds.offset });
    if (s !== seq || fid !== state.flavorId) return;
    ds.result = r;
  } catch (err) {
    if (s !== seq) return;
    ds.result = null;
    ds.error = errMsg(err);
  }
  ds.loading = false;
  render();
  listEl.scrollTop = 0;
}

function render(): void {
  renderList();
  renderPager();
}

function renderSort(): void {
  mount(sortEl, ORDERS.map(([value, label]) =>
    h('button', {
      class: value === ds.order ? 'seg active' : 'seg',
      on: {
        click: () => {
          if (ds.order === value) return;
          ds.order = value;
          renderSort();
          newSearch();
        },
      },
    }, label),
  ));
}

function renderChips(): void {
  const cats = [{ id: 0, name: '全部' }, ...(state.config?.categories ?? [])];
  if (!cats.some((c) => c.id === ds.category)) ds.category = 0;
  mount(chipsEl, cats.map((c) =>
    h('button', {
      class: c.id === ds.category ? 'chip active' : 'chip',
      on: {
        click: () => {
          if (ds.category === c.id) return;
          ds.category = c.id;
          renderChips();
          newSearch();
        },
      },
    }, c.name),
  ));
}

function renderList(): void {
  if (ds.loading) {
    mount(listEl, Array.from({ length: 6 }, () =>
      h('div', { class: 'mod-row skeleton' },
        h('div', { class: 'sk sk-icon' }),
        h('div', { class: 'sk-lines' }, h('div', { class: 'sk sk-line w40' }), h('div', { class: 'sk sk-line w80' }), h('div', { class: 'sk sk-line w60' })),
      ),
    ));
    return;
  }
  if (ds.error) {
    mount(listEl, h('div', { class: 'state-box state-error' },
      h('div', { class: 'state-title', text: '搜索失败' }),
      h('div', { class: 'state-msg', text: ds.error }),
      h('button', { class: 'btn', on: { click: () => void load() } }, '重试'),
    ));
    return;
  }
  const items = ds.result?.items ?? [];
  if (items.length === 0) {
    mount(listEl, h('div', { class: 'state-box' },
      h('div', { class: 'state-title', text: ds.keyword ? `没有找到与「${ds.keyword}」相关的插件` : '暂无插件' }),
      h('div', { class: 'state-msg', text: '试试其他关键词、分类或游戏版本。' }),
    ));
    return;
  }
  mount(listEl, items.map(modRow));
}

function modRow(m: ModSummary): HTMLElement {
  const meta = [
    m.version ? `版本 ${m.version}` : null,
    m.gameVersions.length ? m.gameVersions.slice(0, 2).join(' / ') : null,
    `${formatCount(m.downloads)} 下载`,
    `更新于 ${formatDate(m.updatedAt)}`,
  ].filter((x): x is string => !!x);

  const row = h('div', { class: 'mod-row clickable', tabIndex: 0, title: '查看详情' },
    modIcon(m.logo, m.name, 'md'),
    h('div', { class: 'mod-main' },
      h('div', { class: 'mod-title' },
        h('span', { class: 'mod-name', text: m.name }),
        m.author ? h('span', { class: 'mod-author', text: m.author }) : null,
      ),
      h('div', { class: 'mod-summary', text: m.summary || '暂无简介' }),
      h('div', { class: 'mod-meta', text: meta.join(' · ') }),
    ),
    h('div', { class: 'mod-action' }, modActionButton(m)),
  );
  row.addEventListener('click', () => openDetail(m.id, m));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === row) openDetail(m.id, m);
  });
  return row;
}

function renderPager(): void {
  const r = ds.result;
  if (ds.loading || ds.error || !r || r.items.length === 0) {
    mount(pagerEl);
    pagerEl.classList.add('hidden');
    return;
  }
  pagerEl.classList.remove('hidden');
  if (r.offset === 0 && r.nextOffset > 0) ds.pageSize = r.nextOffset;
  const pageSize = ds.pageSize || DEFAULT_PAGE_SIZE;
  const page = ds.stack.length + 1;
  const pages = Math.max(page, Math.ceil(r.total / pageSize));
  const hasNext = r.nextOffset > r.offset && r.nextOffset < r.total;

  mount(pagerEl,
    h('button', {
      class: 'btn btn-sm',
      disabled: ds.stack.length === 0,
      on: {
        click: () => {
          const prev = ds.stack.pop();
          if (prev === undefined) return;
          ds.offset = prev;
          void load();
        },
      },
    }, '上一页'),
    h('span', { class: 'pager-info', text: `第 ${page} 页 / 共 ${pages} 页（${r.total} 条）` }),
    h('button', {
      class: 'btn btn-sm',
      disabled: !hasNext,
      on: {
        click: () => {
          ds.stack.push(r.offset);
          ds.offset = r.nextOffset;
          void load();
        },
      },
    }, '下一页'),
  );
}
