// 测试辅助：在不启动 Electron 的情况下，用最小的假 electron 模块加载真实的 AppService（src/main/ipc.ts）
// 与真实的 preload（src/preload/preload.ts），让 渲染层 → preload → IPC 处理 → AddonManager → 文件系统 的整条链路可测。
// 插件下载由 FakeSource 提供，不访问真实接口；所有目录都在调用方给出的临时目录中。
// 主窗口的页面可替换或销毁（模拟窗口关闭与重开）；系统保存框由桩回答，可挂起以观察闸门。
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BeeLiteApi, ExpectedRecord } from '../src/shared/types';
import type { ManagerOptions } from '../src/core/manager';
import type { WtfBackupOptions } from '../src/core/wtf-backup';
import type { WtfRestoreServiceOptions } from '../src/core/wtf-restore-service';
import type { DiagnosticsDeps } from '../src/main/ipc';
import { MutationGate } from '../src/core/gate';
import { HistoryStore } from '../src/core/history';
import { PolicyStore } from '../src/core/policy';
import { SettingsStore } from '../src/core/profiles';
import type { NewBeeBoxProvider } from '../src/core/provider';
import type { FakeSource } from './helpers';

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>;

interface Stub {
  handlers: Map<string, Handler>;
  /** showMessageBox 的回答：0 = 继续/绑定，1 = 取消 */
  messageBoxResponse: number;
  messageBoxes: { title?: string; message?: string; detail?: string }[];
  openDialogs: number;
  /** 每次文件夹选择框的 properties（例如 openDirectory） */
  openDialogProps: string[][];
  pick: string | null;
  /** shell.showItemInFolder 收到的路径 */
  revealed: string[];
  /** 系统保存框：默认按 savePick 回答（null 为取消）；saveDialog 给出时由它回答（可挂起，用于观察闸门） */
  savePick: string | null;
  saveDialog: ((opts: { title?: string; defaultPath?: string }) => Promise<{ canceled: boolean; filePath?: string }>) | null;
  /** 每次系统保存框的选项与是否带了父窗口 */
  saveDialogs: { title?: string; defaultPath?: string; withWindow: boolean }[];
  exposed: BeeLiteApi | null;
  /** 主进程推送给窗口的事件（通道与内容） */
  sent: { channel: string; payload: unknown }[];
  /** preload 经 ipcRenderer.on 订阅的事件 */
  listeners: Map<string, Set<(e: unknown, payload: unknown) => void>>;
  /** 当前主窗口的页面（null 表示没有窗口） */
  contents: FakeContents | null;
}

/** 假的 WebContents：编号、是否已销毁与一次性的 destroyed 事件（与 Electron 一致，销毁时同步触发） */
export interface FakeContents {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: string, fn: () => void): void;
  /** 测试用：模拟窗口关闭 */
  destroy(): void;
}

let contentsSeq = 0;
function makeContents(): FakeContents {
  let destroyed = false;
  const onDestroyed: (() => void)[] = [];
  return {
    id: ++contentsSeq,
    // 与 Electron 一致：按发送顺序异步送达界面的订阅者（早于随后才完成的 invoke 回复），不在主进程的调用栈中同步执行界面代码
    send: (channel: string, payload: unknown) => {
      stub.sent.push({ channel, payload });
      queueMicrotask(() => {
        for (const fn of stub.listeners.get(channel) ?? []) fn({}, payload);
      });
    },
    isDestroyed: () => destroyed,
    once: (event: string, fn: () => void) => {
      if (event === 'destroyed') onDestroyed.push(fn);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const fn of onDestroyed.splice(0)) fn();
    },
  };
}

const stub: Stub = {
  handlers: new Map(), messageBoxResponse: 0, messageBoxes: [], openDialogs: 0, openDialogProps: [], pick: null, revealed: [], savePick: null, saveDialog: null, saveDialogs: [],
  exposed: null, sent: [], listeners: new Map(), contents: null,
};
const PAGE_URL = 'app://beelite/index.html';

/** 所有经过 IPC 的调用（通道与参数），用来断言渲染层实际发送的目标 */
export const ipcCalls: { channel: string; args: unknown[] }[] = [];

/** 以给定页面的身份调用（默认是当前主窗口的页面；不是主窗口的页面会被主进程拒绝） */
async function invokeAs(sender: FakeContents | null, channel: string, ...args: unknown[]): Promise<unknown> {
  ipcCalls.push({ channel, args });
  const fn = stub.handlers.get(channel);
  if (!fn) throw new Error(`未注册的通道：${channel}`);
  return fn({ sender: sender ?? {}, senderFrame: { url: PAGE_URL } }, ...args);
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeAs(stub.contents, channel, ...args);
}

const fakeElectron = {
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (channel: string, fn: Handler) => void stub.handlers.set(channel, fn) },
  dialog: {
    showMessageBox: async (...a: unknown[]) => {
      const opts = (a.length > 1 ? a[1] : a[0]) as { title?: string; message?: string; detail?: string };
      stub.messageBoxes.push({ title: opts.title, message: opts.message, detail: opts.detail });
      return { response: stub.messageBoxResponse };
    },
    showOpenDialog: async (...a: unknown[]) => {
      const opts = (a.length > 1 ? a[1] : a[0]) as { properties?: string[] };
      stub.openDialogs++;
      stub.openDialogProps.push([...(opts.properties ?? [])]);
      return stub.pick ? { canceled: false, filePaths: [stub.pick] } : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async (...a: unknown[]) => {
      const opts = (a.length > 1 ? a[1] : a[0]) as { title?: string; defaultPath?: string };
      stub.saveDialogs.push({ title: opts.title, defaultPath: opts.defaultPath, withWindow: a.length > 1 });
      if (stub.saveDialog) return stub.saveDialog(opts);
      return stub.savePick ? { canceled: false, filePath: stub.savePick } : { canceled: true, filePath: '' };
    },
  },
  shell: { showItemInFolder: (p: string) => void stub.revealed.push(p) },
  contextBridge: { exposeInMainWorld: (_name: string, api: BeeLiteApi) => void (stub.exposed = api) },
  ipcRenderer: {
    invoke,
    on: (channel: string, fn: (e: unknown, payload: unknown) => void) => {
      let set = stub.listeners.get(channel);
      if (!set) stub.listeners.set(channel, (set = new Set()));
      set.add(fn);
    },
    removeListener: (channel: string, fn: (e: unknown, payload: unknown) => void) => void stub.listeners.get(channel)?.delete(fn),
  },
};

/** 让后续 require('electron') 得到假模块（必须在加载 ipc / preload 之前调用） */
function installElectronStub(): void {
  const id = require.resolve('electron');
  require.cache[id] = { id, filename: id, loaded: true, exports: fakeElectron } as unknown as NodeJS.Module;
}

export interface Harness {
  settings: SettingsStore;
  /** 操作记录与更新策略：默认放在设置文件所在的临时目录中，绝不使用真实的 userData */
  history: HistoryStore;
  policy: PolicyStore;
  gate: MutationGate;
  stub: Stub;
  invoke: typeof invoke;
  /** 以指定页面的身份直接调用 IPC 处理（用于已关闭或非主窗口的页面） */
  invokeAs: typeof invokeAs;
  /** 由真实 preload 暴露给界面的接口 */
  api: BeeLiteApi;
  service: import('../src/main/ipc').AppService;
  /** 当前主窗口的页面 */
  contents(): FakeContents | null;
  /**
   * 换成新的主窗口（新的页面）；destroyOld 为 true 时先模拟旧窗口关闭（触发 destroyed）。
   * 界面经 api 发出的调用随之来自新窗口
   */
  replaceWindow(o?: { destroyOld?: boolean }): { old: FakeContents | null; current: FakeContents };
  /** 模拟主窗口关闭：页面销毁，之后没有主窗口 */
  closeWindow(): FakeContents | null;
}

export function createHarness(opts: {
  settingsFile: string;
  source: FakeSource;
  download?: ManagerOptions['download'];
  history?: HistoryStore;
  policy?: PolicyStore;
  /** WTF 备份的测试注入（上限与阶段钩子）；备份设置与受保护的应用数据目录都在设置文件所在的临时目录 */
  backup?: Pick<WtfBackupOptions, 'limits' | 'hooks'>;
  /** WTF 恢复的测试注入（事务钩子、进程探测、可用空间、时钟）；恢复登记在设置文件所在的临时目录 */
  restore?: Omit<WtfRestoreServiceOptions, 'registryFile'>;
  /** 诊断报告的测试注入；应用目录默认为设置文件所在临时目录下的 app-bundle（不存在也受保护），绝不指向真实应用 */
  diagnostics?: Partial<Omit<DiagnosticsDeps, 'settingsFile' | 'userData'>>;
}): Harness {
  installElectronStub();
  stub.handlers.clear();
  stub.messageBoxResponse = 0;
  stub.messageBoxes = [];
  stub.openDialogs = 0;
  stub.openDialogProps = [];
  stub.pick = null;
  stub.revealed = [];
  stub.savePick = null;
  stub.saveDialog = null;
  stub.saveDialogs = [];
  stub.sent = [];
  stub.listeners = new Map();
  stub.contents = makeContents();
  ipcCalls.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppService, backupOptions, diagnosticsOptions, restoreOptions } = require('../src/main/ipc') as typeof import('../src/main/ipc');
  const settings = new SettingsStore(opts.settingsFile);
  const dataDir = path.dirname(opts.settingsFile);
  const history = opts.history ?? new HistoryStore(path.join(dataDir, 'operation-history.json'));
  const policy = opts.policy ?? new PolicyStore(path.join(dataDir, 'addon-policy.json'));
  const gate = new MutationGate();
  const service = new AppService({
    getWindow: () => {
      const c = stub.contents;
      return c ? ({ webContents: c, isDestroyed: () => c.isDestroyed() } as unknown as Electron.BrowserWindow) : null;
    },
    settings,
    provider: opts.source as unknown as NewBeeBoxProvider,
    gate,
    history,
    policy,
    download: opts.download ?? opts.source.download,
    // 与 main 相同的目录解析；应用数据目录是设置文件所在的临时目录，绝不使用真实的 userData
    backup: { ...backupOptions(settings, dataDir, fakeElectron.app.getVersion()), ...opts.backup },
    restore: { ...restoreOptions(dataDir), ...opts.restore },
    diagnostics: {
      ...diagnosticsOptions(dataDir, fakeElectron.app.getVersion(), [path.join(dataDir, 'app-bundle')]),
      settingsFile: opts.settingsFile,
      ...opts.diagnostics,
    },
  });
  service.register();
  // 与 main 一致：先读取一次策略（只读；文件不存在即没有暂停项）。读取在之后的任何检查完成之前结束
  void policy.reload();
  // 每次重新加载 preload，让它把接口暴露到本次的桩上
  const preloadId = require.resolve('../src/preload/preload');
  delete require.cache[preloadId];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../src/preload/preload');
  if (!stub.exposed) throw new Error('preload 没有暴露接口');
  const replaceWindow = (o: { destroyOld?: boolean } = {}) => {
    const old = stub.contents;
    if (o.destroyOld) old?.destroy();
    const current = makeContents();
    stub.contents = current;
    return { old, current };
  };
  const closeWindow = () => {
    const old = stub.contents;
    old?.destroy();
    stub.contents = null;
    return old;
  };
  return { settings, history, policy, gate, stub, invoke, invokeAs, api: stub.exposed, service, contents: () => stub.contents, replaceWindow, closeWindow };
}

/** 递归快照：目录与文件（内容哈希），用于断言某个游戏目录（含 .beelite 清单、回收站与 WTF）完全没有变化 */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel);
    const st = await lstat(abs);
    if (st.isDirectory()) {
      out[rel || '.'] = 'dir';
      for (const n of (await readdir(abs)).sort()) await walk(path.join(rel, n));
    } else if (st.isSymbolicLink()) {
      out[rel] = 'symlink';
    } else {
      out[rel] = createHash('sha256').update(await readFile(abs)).digest('hex');
    }
  };
  await walk('');
  return out;
}

export async function readManifestJson(root: string): Promise<{ projects: Record<string, { flavorId: number; fileId: string; folders: string[]; installedAt: number }>; recovery: { id: string; kind: string; folders: string[] }[] }> {
  return JSON.parse(await readFile(path.join(root, 'Interface', '.beelite', 'manifest.json'), 'utf8'));
}

/** 清单中某个插件当前的安装记录（更新 / 重装请求需要带上界面看到的记录） */
export async function recordOf(root: string, modId: string): Promise<ExpectedRecord> {
  const p = (await readManifestJson(root)).projects[modId];
  if (!p) throw new Error(`清单中没有 ${modId}`);
  return { fileId: p.fileId, installedAt: p.installedAt };
}
