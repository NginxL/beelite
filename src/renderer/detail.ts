// 插件详情抽屉（右侧滑出，Esc / 点击遮罩关闭）

import type { ModDetail, ModFileInfo, ModSummary } from '../shared/types';
import { modActionButton } from './actions.js';
import { byId, h, isAllowedImage, modIcon, mount, spinner } from './dom.js';
import { errMsg, formatCount, formatDate, formatSize } from './format.js';
import { api, on, state } from './state.js';

interface DrawerState {
  modId: string;
  flavorId: number;
  summary: ModSummary | null;
  detail: ModDetail | null;
  detailError: string | null;
  file: ModFileInfo | null;
  fileError: string | null;
  loading: boolean;
  overlay: HTMLElement;
  body: HTMLElement;
}

let cur: DrawerState | null = null;
let seq = 0;

export function initDetail(): void {
  on('flavor', closeDetail);
  on('local', () => {
    if (cur && !cur.loading) render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cur) closeDetail();
  });
}

export function openDetail(modId: string, summary?: ModSummary): void {
  closeDetail(true);
  const body = h('div', { class: 'drawer-body' });
  const overlay = h('div', { class: 'drawer-overlay' },
    h('aside', { class: 'drawer', attrs: { role: 'dialog', 'aria-label': '插件详情' } },
      h('button', { class: 'drawer-close', title: '关闭 (Esc)', on: { click: () => closeDetail() } }, '×'),
      body,
    ),
  );
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeDetail();
  });
  byId('drawer-root').appendChild(overlay);
  // 下一帧加 open 类触发滑入动画
  requestAnimationFrame(() => overlay.classList.add('open'));

  cur = {
    modId, flavorId: state.flavorId, summary: summary ?? null,
    detail: null, detailError: null, file: null, fileError: null,
    loading: true, overlay, body,
  };
  void load();
}

export function closeDetail(immediate = false): void {
  if (!cur) return;
  seq++;
  const overlay = cur.overlay;
  cur = null;
  if (immediate) overlay.remove();
  else {
    overlay.classList.remove('open');
    window.setTimeout(() => overlay.remove(), 250);
  }
}

async function load(): Promise<void> {
  if (!cur) return;
  const s = ++seq;
  const { modId, flavorId } = cur;
  cur.loading = true;
  cur.detailError = null;
  cur.fileError = null;
  render();
  const [d, f] = await Promise.allSettled([api().detail(modId, flavorId), api().latestFile(modId, flavorId)]);
  if (s !== seq || !cur) return;
  cur.loading = false;
  if (d.status === 'fulfilled') cur.detail = d.value;
  else cur.detailError = errMsg(d.reason);
  if (f.status === 'fulfilled') cur.file = f.value;
  else cur.fileError = errMsg(f.reason);
  render();
}

function render(): void {
  if (!cur) return;
  const c = cur;
  const mod: ModSummary | null = c.detail ?? c.summary;

  if (c.loading && !mod) {
    mount(c.body, h('div', { class: 'state-box' }, spinner(), h('div', { text: '正在加载详情…' })));
    return;
  }
  if (!mod) {
    mount(c.body, h('div', { class: 'state-box state-error' },
      h('div', { class: 'state-title', text: '加载详情失败' }),
      h('div', { class: 'state-msg', text: c.detailError ?? '未知错误' }),
      h('button', { class: 'btn', on: { click: () => void load() } }, '重试'),
    ));
    return;
  }

  const header = h('div', { class: 'detail-head' },
    modIcon(mod.logo, mod.name, 'lg'),
    h('div', { class: 'detail-head-text' },
      h('div', { class: 'detail-name', text: mod.name }),
      h('div', { class: 'detail-author', text: mod.author ? `作者：${mod.author}` : '作者未知' }),
      h('div', { class: 'tag-row' }, mod.categories.map((cat) => h('span', { class: 'tag', text: cat.name }))),
    ),
  );

  const stats = h('div', { class: 'detail-stats' },
    stat('下载', formatCount(mod.downloads)),
    stat('收藏', formatCount(mod.favorites)),
    stat('更新', formatDate(mod.updatedAt)),
    stat('版本', mod.version || '—'),
  );

  mount(c.body,
    header,
    stats,
    renderFileCard(c, mod),
    c.detailError ? h('div', { class: 'inline-error', text: `详情加载不完整：${c.detailError}` }) : null,
    h('div', { class: 'section-title', text: '简介' }),
    h('div', { class: 'detail-desc', text: (c.detail?.description || mod.summary || '暂无简介').trim() }),
    renderShots(c.detail),
  );
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value', text: value }), h('div', { class: 'stat-label', text: label }));
}

function renderFileCard(c: DrawerState, mod: ModSummary): HTMLElement {
  let block: string | null = null;
  const rows: HTMLElement[] = [];
  const notes: HTMLElement[] = [];

  if (c.loading) {
    rows.push(h('div', { class: 'file-loading' }, spinner(true), '正在获取最新文件…'));
    block = '正在获取文件信息';
  } else if (c.fileError || !c.file) {
    block = c.fileError ?? '没有可用文件';
    notes.push(h('div', { class: 'inline-error', text: `无法获取可安装文件：${block}` }));
  } else {
    const f = c.file;
    rows.push(
      kv('文件版本', f.displayName || '—'),
      kv('大小', formatSize(f.size)),
      kv('发布日期', formatDate(f.date)),
      kv('支持版本', f.gameVersions.length ? f.gameVersions.join('、') : '—'),
      kv('包含目录', f.folders.length ? f.folders.join('、') : '—'),
    );
    if (!f.compatible) {
      block = '最新文件不支持当前游戏版本';
      notes.push(h('div', { class: 'inline-error', text: `该文件声明的游戏版本与当前「${currentName()}」不匹配，已禁止安装。` }));
    }
  }
  if (!mod.accessible) notes.push(h('div', { class: 'inline-note', text: '仅支持免费公开插件，该插件无法通过艾泽魔方安装。' }));

  return h('div', { class: 'file-card' },
    h('div', { class: 'file-card-head' },
      h('div', { class: 'section-title', text: '最新文件' }),
      modActionButton(mod, block),
    ),
    h('div', { class: 'kv-list' }, rows),
    notes,
  );
}

function currentName(): string {
  return state.config?.flavors.find((f) => f.id === state.flavorId)?.name ?? '当前版本';
}

function kv(k: string, v: string): HTMLElement {
  return h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: v }));
}

function renderShots(d: ModDetail | null): HTMLElement | null {
  const shots = (d?.screenshots ?? []).filter(isAllowedImage).slice(0, 6);
  if (shots.length === 0) return null;
  return h('div', null,
    h('div', { class: 'section-title', text: '截图' }),
    h('div', { class: 'shots' }, shots.map((src) => {
      const img = h('img', { class: 'shot', src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', draggable: false });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.addEventListener('click', () => img.classList.toggle('shot-zoom'));
      return img;
    })),
  );
}
