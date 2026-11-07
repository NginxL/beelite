// 入口：导航、顶部栏（游戏版本与目录）、启动加载配置

import { initClientUpdate } from './client-update.js';
import { initDetail } from './detail.js';
import { initDiscover, focusSearch } from './discover.js';
import { byId, confirmDialog, h, mount, spinner } from './dom.js';
import { errMsg } from './format.js';
import { initLocal } from './local.js';
import { handleTask } from './tasks.js';
import { api, bindDirectory, isBusy, on, setFlavor, state, unbindDirectory, updateCount } from './state.js';

type Page = 'discover' | 'local';

const flavorSelect = byId<HTMLSelectElement>('flavor-select');
const dirPath = byId('dir-path');
const bindBtn = byId<HTMLButtonElement>('bind-btn');
const unbindBtn = byId<HTMLButtonElement>('unbind-btn');
const configWarn = byId('config-warning');
const badge = byId('update-badge');

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

  const n = updateCount();
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

function renderFlavorOptions(): void {
  const flavors = state.config?.flavors ?? [];
  mount(flavorSelect, flavors.map((f) => {
    const ver = f.versions[0] ? ` · ${f.versions[0]}` : '';
    return h('option', { value: String(f.id), selected: f.id === state.flavorId }, `${f.name}${ver}${f.online ? '' : '（离线）'}`);
  }));
  flavorSelect.disabled = flavors.length === 0;
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
  unbindBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '解除游戏目录绑定？',
      message: '只会让蜂简忘记这个目录，不会删除或修改任何插件文件。之后可以重新选择。',
      confirmText: '解除绑定',
    });
    if (ok) await unbindDirectory();
  });
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
  // 客户端更新入口不依赖插件数据源配置，先于配置加载初始化
  initClientUpdate();
  bindUi();
  renderTopbar();
  void loadConfig();
}

boot();
