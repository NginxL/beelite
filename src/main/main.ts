// 蜂简 BeeLite 主进程：窗口、本地页面协议、安全策略、启动恢复与客户端更新。
import { app, BrowserWindow, Menu, powerMonitor, protocol, session, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ClientUpdater } from '../core/client-update';
import { createQuitGuard, MutationGate } from '../core/gate';
import { displayName, resolveUserData } from '../core/identity';
import { inspectPickedRoot, SettingsStore } from '../core/profiles';
import { NewBeeBoxProvider } from '../core/provider';
import { FLAVORS } from '../core/flavors';
import { recoverBoundRoots } from '../core/startup';
import { loadSparkleBridge } from './client-update';
import { APP_ORIGIN, AppService } from './ipc';

const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const IMAGE_ORIGIN = 'https://cdn8.newbeebox.com/';
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' ${IMAGE_ORIGIN} data:`,
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// 在修改显示名之前固定 userData：默认路径由 productName 决定（生产包为 BeeLite，测试包各自独立），
// 显式设置 BEELITE_USER_DATA_DIR 时（仅开发/测试）使用该目录
const isolatedUserData = process.env.BEELITE_USER_DATA_DIR;
app.setPath('userData', resolveUserData(app.getPath('userData'), isolatedUserData, (p) => path.resolve(p)));
const APP_DISPLAY_NAME = displayName(app.getName());
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const gate = new MutationGate();
let clientUpdater: ClientUpdater | null = null;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.quit();
  });
}

/** 只提供 dist/web 内的静态文件 */
function registerAppProtocol(): void {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'beelite') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(WEB_ROOT, rel);
    const check = path.relative(WEB_ROOT, file);
    if (check.startsWith('..') || path.isAbsolute(check)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(file);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // 界面只允许加载本地页面与插件图标；联网请求全部由主进程完成
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const allowed = u.startsWith(`${APP_ORIGIN}/`) || u.startsWith('devtools://') || (u.startsWith(IMAGE_ORIGIN) && details.resourceType === 'image');
    cb({ cancel: !allowed });
  });
}

function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (e: Electron.Event, url: string) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) e.preventDefault();
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '蜂简',
        submenu: [
          { role: 'about', label: '关于蜂简' },
          { label: '检查客户端更新…', click: () => clientUpdater?.check() },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' },
          { role: 'quit', label: '退出蜂简' },
        ],
      },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'reload', label: '重新载入' }, { role: 'close', label: '关闭' }] },
    ]),
  );
}

/** 测试模式：仅在同时设置了隔离的用户数据目录时，允许通过 BEELITE_TEST_BIND="9=/tmp/x/_forever_" 预先绑定目录 */
async function applyTestBindings(settings: SettingsStore): Promise<void> {
  const spec = process.env.BEELITE_TEST_BIND;
  if (!spec || !isolatedUserData) return;
  for (const part of spec.split(';')) {
    const m = /^(\d+)=(.+)$/.exec(part.trim());
    if (!m || !FLAVORS.some((f) => f.id === Number(m[1]))) continue;
    try {
      const s = await settings.load();
      const insp = await inspectPickedRoot(m[2], Number(m[1]), s.bindings);
      if (insp.root.startsWith('/Applications/World of Warcraft')) {
        console.warn('[BeeLite] 测试绑定拒绝使用真实游戏目录：', insp.root);
        continue;
      }
      await settings.bind(Number(m[1]), insp.root);
    } catch (err) {
      console.warn('[BeeLite] 测试绑定失败：', err);
    }
  }
}

async function start(): Promise<void> {
  app.setName(APP_DISPLAY_NAME);
  registerAppProtocol();
  hardenSession();
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  // 手动退出与更新安装引起的退出都先等待已受理的插件写操作结束
  app.on('before-quit', createQuitGuard(gate, () => app.quit()));
  buildMenu();

  const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  const service = new AppService({ getWindow: () => mainWindow, settings, provider: new NewBeeBoxProvider(), gate });
  service.register();
  // 退出时停止插件更新检查：中止进行中的请求，迟到的结果不发布
  app.on('before-quit', () => service.watch.stop());

  // 测试绑定与启动恢复（残留的未完成事务）也计入写操作；全部完成后才启用客户端更新。
  // 设置无法读取时跳过恢复但不中断启动，窗口与客户端更新照常可用
  await recoverBoundRoots({
    gate,
    settings,
    recover: (root) => service.manager.recover(root),
    prepare: () => applyTestBindings(settings),
    warn: (...args) => console.warn(...args),
  });

  // 启动恢复完成后开始插件更新检查（只读）：立即一次，之后每小时；系统唤醒后按墙钟复核是否到期
  service.watch.start();
  powerMonitor.on('resume', () => service.watch.poke());

  const loaded = loadSparkleBridge();
  clientUpdater = new ClientUpdater({
    bridge: loaded.bridge,
    gate,
    currentVersion: app.getVersion(),
    unsupportedReason: loaded.reason,
    onState: (st) => service.pushClientState(st),
  });
  service.attachClientUpdater(clientUpdater);
  clientUpdater.start();
  // 启动后与每天各探测一次（只检查，不下载）
  setTimeout(() => clientUpdater?.check(), 5000);
  setInterval(() => clientUpdater?.check(), UPDATE_CHECK_INTERVAL_MS).unref();

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.BEELITE_DEVTOOLS === '1',
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}
