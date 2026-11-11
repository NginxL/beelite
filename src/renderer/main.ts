// 入口：导航、顶部栏（游戏版本与目录）、启动加载配置

import { initActivityNotice } from './activity-notice.js';
import { applyBackupTask, backupNavBadge, initBackup, setBackupPageOpen, syncBackupTask } from './backup.js';
import { initClientUpdate } from './client-update.js';
import { initDetail } from './detail.js';
import { initDiscover, focusSearch } from './discover.js';
import type { AddonWatchSnapshot } from '../shared/types';
import { byId, h, mount, spinner, toast } from './dom.js';
import { errMsg } from './format.js';
import { initLocal, showManagedTab } from './local.js';
import { handleTask, syncTasks } from './tasks.js';
import {
  api, applyActivity, applyHistoryStatus, applyTask, applyWatch, bindDirectory, flavorName, isBusy, on, onActivityAccepted, pendingByFlavor, setFlavor, state, syncActivity,
  syncHistoryStatus, syncWatch, unbindDirectory,
} from './state.js';

type Page = 'discover' | 'local' | 'backup';
const PAGES: readonly Page[] = ['discover', 'local', 'backup'];

const flavorSelect = byId<HTMLSelectElement>('flavor-select');
const dirPath = byId('dir-path');
const bindBtn = byId<HTMLButtonElement>('bind-btn');
const unbindBtn = byId<HTMLButtonElement>('unbind-btn');
const configWarn = byId('config-warning');
const updateNotice = byId('update-notice');
const badge = byId('update-badge');
const backupBadge = byId('backup-badge');
/** 已处理到的自动检查提醒序号；首次收到快照时只记录，不弹提示（启动时的结果由徽标与提示条展示） */
let noticeSeen: number | null = null;
/** 当前显示的页面；配置加载完成后不强制切回发现插件 */
let currentPage: Page = 'discover';

/** 三个页面互斥显示；配置备份页的打开 / 离开交给 backup 模块（重复点击已打开的页面不会重新读取） */
function showPage(page: Page): void {
  currentPage = page;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.page === page);
  }
  for (const p of PAGES) byId(`page-${p}`).classList.toggle('hidden', p !== page);
  setBackupPageOpen(page === 'backup');
  if (page === 'discover') focusSearch();
}

function pageOf(v: string | undefined): Page {
  return v === 'local' || v === 'backup' ? v : 'discover';
}

/** 侧栏「配置备份」的进行中标记：来自主进程的全局任务（可能属于其他游戏版本或目录） */
function renderBackupBadge(): void {
  const text = backupNavBadge() ?? '';
  if (backupBadge.textContent !== text) backupBadge.textContent = text;
  backupBadge.classList.toggle('hidden', !text);
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
  const policyError = state.watch?.policyError ?? null;
  updateNotice.classList.toggle('update-notice-warn', !!settingsError || !!policyError);
  if (policyError) {
    // 更新策略无法读取：所有插件更新都被拒绝，不能显示为已是最新；所有页面都显示这一状态
    mount(updateNotice,
      h('span', { class: 'update-notice-text', text: '插件更新已停止：无法读取更新策略（暂停列表），暂时不能更新任何插件。', title: policyError }),
      h('span', { class: 'update-notice-hint', text: '修复或移走该文件后，在「我的插件」点「重试」' }),
    );
    updateNotice.classList.remove('hidden');
  } else if (settingsError) {
    // 设置文件无法读取：无法确认任何目录的绑定，旧结论已作废；所有页面都显示这一状态
    mount(updateNotice,
      h('span', { class: 'update-notice-text', text: '插件更新检查已暂停：无法读取艾泽魔方设置文件，暂时无法确认插件是否有更新。', title: settingsError }),
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
    btn.addEventListener('click', () => showPage(pageOf(btn.dataset.page)));
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
  on('backup', renderBackupBadge);
  renderBackupBadge();
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
    // 配置加载期间用户可能已切到其他页面：只在仍停留在发现插件时聚焦搜索框
    if (currentPage === 'discover') focusSearch();
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
      h('div', { class: 'state-msg', text: '请通过艾泽魔方应用启动本界面。' }),
    ));
    return;
  }
  // 任务事件同时更新对应插件行（按目标 + 插件编号）与右下角任务面板
  window.beelite.onTask((e) => {
    applyTask(e);
    handleTask(e);
  });
  // 插件写操作状态在主进程（界面重新载入后据此恢复占用、行内进度与任务卡片）：先订阅推送再获取快照，按 rev 丢弃过时的一方；
  // 取得之前插件写入口保持禁止，获取失败时所有页面顶部显示原因与重试
  onActivityAccepted(syncTasks);
  initActivityNotice(byId('activity-warning'));
  window.beelite.onActivity((s) => void applyActivity(s));
  void syncActivity();
  // 插件更新检查在主进程进行，可能早于界面完成：先订阅事件再获取快照，按 rev 丢弃过时的一方
  window.beelite.onAddonWatch(onWatch);
  // 获取失败时插件更新保持关闭，「我的插件」页面显示原因与重试；之后任何一次推送也会恢复
  void syncWatch(onWatch);
  // 操作记录的保存状态：无法读取或未保存时页面一直提示，可重试
  window.beelite.onHistoryStatus(applyHistoryStatus);
  void syncHistoryStatus();
  // WTF 配置备份：页面不依赖插件数据源配置，先于配置加载初始化（加载慢时点进去也能正确显示）；
  // 启动时只同步主进程内存中的任务快照（先订阅再获取，按 rev 丢弃过时的一方），不读取备份状态与 WTF
  initBackup(byId('page-backup'));
  window.beelite.onBackupTask((s) => void applyBackupTask(s));
  void syncBackupTask();
  // 客户端更新入口不依赖插件数据源配置，先于配置加载初始化
  initClientUpdate();
  bindUi();
  renderTopbar();
  void loadConfig();
}

boot();
