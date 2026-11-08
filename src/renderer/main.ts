// 入口：导航、顶部栏（游戏版本与目录）、启动加载配置

import { initClientUpdate } from './client-update.js';
import { initDetail } from './detail.js';
import { initDiscover, focusSearch } from './discover.js';
import type { AddonWatchSnapshot } from '../shared/types';
import { byId, h, mount, spinner, toast } from './dom.js';
import { errMsg } from './format.js';
import { initLocal, showManagedTab } from './local.js';
import { handleTask } from './tasks.js';
import { api, applyWatch, bindDirectory, flavorName, isBusy, on, pendingByFlavor, setFlavor, state, unbindDirectory } from './state.js';

type Page = 'discover' | 'local';

const flavorSelect = byId<HTMLSelectElement>('flavor-select');
const dirPath = byId('dir-path');
const bindBtn = byId<HTMLButtonElement>('bind-btn');
const unbindBtn = byId<HTMLButtonElement>('unbind-btn');
const configWarn = byId('config-warning');
const updateNotice = byId('update-notice');
const badge = byId('update-badge');
/** 已处理到的自动检查提醒序号；首次收到快照时只记录，不弹提示（启动时的结果由徽标与提示条展示） */
let noticeSeen: number | null = null;

function showPage(page: Page): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.page === page);
  }
  byId('page-discover').classList.toggle('hidden', page !== 'discover');
  byId('page-local').classList.toggle('hidden', page !== 'local');
  if (page === 'discover') focusSearch();
}

function renderTopbar(): void {
  const local = state.local;
  const profile = local && local.flavorId === state.flavorId ? local.profile : null;
  const busy = isBusy('bind');

  dirPath.classList.remove('dir-empty');
  if (!local) {
    dirPath.textContent = state.localError ? '读取目录失败' : '正在读取…';
    dirPath.title = state.localError ?? '';
  } else if (profile?.root) {
    dirPath.textContent = profile.addonsPath ?? profile.root;
    dirPath.title = profile.addonsPath ?? profile.root;
  } else {
    dirPath.textContent = '未设置游戏目录';
    dirPath.title = '';
    dirPath.classList.add('dir-empty');
  }
  bindBtn.textContent = profile?.root ? '更换' : '选择目录';
  bindBtn.disabled = busy || !local;
  unbindBtn.classList.toggle('hidden', !profile?.root);
  unbindBtn.disabled = busy;

  renderUpdateHints();
}

/** 侧栏徽标为所有已绑定游戏版本的可更新总数；顶部提示条列出每个有更新的版本，点击直达其「我的插件」 */
function renderUpdateHints(): void {
  const pending = pendingByFlavor();
  const total = [...pending.values()].reduce((a, b) => a + b, 0);
  const text = String(total);
  if (badge.textContent !== text) badge.textContent = text;
  badge.classList.toggle('hidden', total === 0);
  badge.title = total ? [...pending].map(([f, n]) => `${flavorName(f)}：${n} 个可更新`).join('\n') : '';
  const settingsError = state.watch?.settingsError ?? null;
  updateNotice.classList.toggle('update-notice-warn', !!settingsError);
  if (settingsError) {
    // 设置文件无法读取：无法确认任何目录的绑定，旧结论已作废；所有页面都显示这一状态
    mount(updateNotice,
      h('span', { class: 'update-notice-text', text: '插件更新检查已暂停：无法读取蜂简设置文件，暂时无法确认插件是否有更新。', title: settingsError }),
      h('span', { class: 'update-notice-hint', text: '修复设置文件后，先在「我的插件」点「刷新」或「重试」恢复列表，再点「检查更新」恢复检查' }),
    );
    updateNotice.classList.remove('hidden');
  } else if (total === 0) {
    updateNotice.classList.add('hidden');
    mount(updateNotice);
  } else {
    mount(updateNotice,
      h('span', { class: 'update-notice-text', text: '发现可更新的插件：' }),
      [...pending].map(([f, n]) => h('button', { class: 'update-chip', title: `查看「${flavorName(f)}」的插件更新`, on: { click: () => goToUpdates(f) } }, `${flavorName(f)} ${n} 个`)),
      h('span', { class: 'update-notice-hint', text: '更新需要你确认后点击「更新」或「全部更新」' }),
    );
    updateNotice.classList.remove('hidden');
  }
  renderFlavorOptions(pending);
}

function goToUpdates(flavorId: number): void {
  if (flavorId !== state.flavorId) {
    setFlavor(flavorId);
    flavorSelect.value = String(flavorId);
  }
  showManagedTab();
  showPage('local');
}

function renderFlavorOptions(pending = pendingByFlavor()): void {
  const flavors = state.config?.flavors ?? [];
  const labels = flavors.map((f) => {
    const ver = f.versions[0] ? ` · ${f.versions[0]}` : '';
    const n = pending.get(f.id);
    return `${f.name}${ver}${f.online ? '' : '（离线）'}${n ? `（${n} 个可更新）` : ''}`;
  });
  // 标签没变时不重建，避免打断正在展开的下拉框
  const current = Array.from(flavorSelect.options, (o) => o.textContent);
  if (current.length === labels.length && current.every((t, i) => t === labels[i])) return;
  mount(flavorSelect, flavors.map((f, i) => h('option', { value: String(f.id), selected: f.id === state.flavorId }, labels[i])));
  flavorSelect.disabled = flavors.length === 0;
}

function onWatch(s: AddonWatchSnapshot): void {
  if (!applyWatch(s)) return;
  const seq = s.notice?.seq ?? 0;
  if (noticeSeen === null) {
    noticeSeen = seq;
    return;
  }
  if (s.notice && seq > noticeSeen) {
    noticeSeen = seq;
    const names = s.notice.flavorIds.map(flavorName).join('、');
    toast(`发现 ${s.notice.count} 个插件可更新（${names}），可在「我的插件」中确认后更新`, 'info', 8000);
  }
}

function bindUi(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    btn.addEventListener('click', () => showPage(btn.dataset.page === 'local' ? 'local' : 'discover'));
  }
  flavorSelect.addEventListener('change', () => {
    const id = Number(flavorSelect.value);
    if (Number.isFinite(id) && id !== state.flavorId) setFlavor(id);
  });
  bindBtn.addEventListener('click', () => void bindDirectory());
  // 确认对话框在 unbindDirectory 内：确认前记录目标，确认后复核
  unbindBtn.addEventListener('click', () => void unbindDirectory());
  on('local', renderTopbar);
  on('flavor', renderTopbar);
}

async function loadConfig(): Promise<void> {
  const page = byId('page-discover');
  try {
    const cfg = await api().getConfig();
    state.config = cfg;
    if (cfg.configError) {
      configWarn.textContent = `在线配置暂不可用：${cfg.configError}（本地插件管理仍可使用）`;
      configWarn.classList.remove('hidden');
    } else configWarn.classList.add('hidden');
    const id = cfg.flavors.some((f) => f.id === cfg.defaultFlavorId) ? cfg.defaultFlavorId : (cfg.flavors[0]?.id ?? cfg.defaultFlavorId);
    state.flavorId = id;
    renderFlavorOptions();
    initDiscover(page);
    initLocal(byId('page-local'));
    initDetail();
    setFlavor(id);
    focusSearch();
  } catch (err) {
    mount(page, h('div', { class: 'state-box state-error' },
      h('div', { class: 'state-title', text: '启动失败：无法读取应用配置' }),
      h('div', { class: 'state-msg', text: errMsg(err) }),
      h('button', { class: 'btn', on: { click: () => { mount(page, h('div', { class: 'state-box' }, spinner())); void loadConfig(); } } }, '重试'),
    ));
  }
}

function boot(): void {
  if (!window.beelite) {
    mount(byId('page-discover'), h('div', { class: 'state-box state-error' },
      h('div', { class: 'state-title', text: '界面未能连接到主进程' }),
      h('div', { class: 'state-msg', text: '请通过蜂简应用启动本界面。' }),
    ));
    return;
  }
  window.beelite.onTask(handleTask);
  // 插件更新检查在主进程进行，可能早于界面完成：先订阅事件再获取快照，按 rev 丢弃过时的一方
  window.beelite.onAddonWatch(onWatch);
  void window.beelite.watchState().then(onWatch, () => undefined);
  // 客户端更新入口不依赖插件数据源配置，先于配置加载初始化
  initClientUpdate();
  bindUi();
  renderTopbar();
  void loadConfig();
}

boot();
