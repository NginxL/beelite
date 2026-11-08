// 测试辅助：在不启动 Electron 的情况下，用最小的假 electron 模块加载真实的 AppService（src/main/ipc.ts）
// 与真实的 preload（src/preload/preload.ts），让 渲染层 → preload → IPC 处理 → AddonManager → 文件系统 的整条链路可测。
// 插件下载由 FakeSource 提供，不访问真实接口；所有目录都在调用方给出的临时目录中。
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BeeLiteApi } from '../src/shared/types';
import type { ManagerOptions } from '../src/core/manager';
import { MutationGate } from '../src/core/gate';
import { SettingsStore } from '../src/core/profiles';
import type { NewBeeBoxProvider } from '../src/core/provider';
import type { FakeSource } from './helpers';

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>;

interface Stub {
  handlers: Map<string, Handler>;
  /** showMessageBox 的回答：0 = 继续/绑定，1 = 取消 */
  messageBoxResponse: number;
  messageBoxes: { title?: string; message?: string }[];
  openDialogs: number;
  pick: string | null;
  exposed: BeeLiteApi | null;
}

const stub: Stub = { handlers: new Map(), messageBoxResponse: 0, messageBoxes: [], openDialogs: 0, pick: null, exposed: null };
const webContents = { send: () => undefined };
const senderEvent = { sender: webContents, senderFrame: { url: 'app://beelite/index.html' } };

/** 所有经过 IPC 的调用（通道与参数），用来断言渲染层实际发送的目标 */
export const ipcCalls: { channel: string; args: unknown[] }[] = [];

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  ipcCalls.push({ channel, args });
  const fn = stub.handlers.get(channel);
  if (!fn) throw new Error(`未注册的通道：${channel}`);
  return fn(senderEvent, ...args);
}

const fakeElectron = {
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (channel: string, fn: Handler) => void stub.handlers.set(channel, fn) },
  dialog: {
    showMessageBox: async (...a: unknown[]) => {
      const opts = (a.length > 1 ? a[1] : a[0]) as { title?: string; message?: string };
      stub.messageBoxes.push({ title: opts.title, message: opts.message });
      return { response: stub.messageBoxResponse };
    },
    showOpenDialog: async () => {
      stub.openDialogs++;
      return stub.pick ? { canceled: false, filePaths: [stub.pick] } : { canceled: true, filePaths: [] };
    },
  },
  contextBridge: { exposeInMainWorld: (_name: string, api: BeeLiteApi) => void (stub.exposed = api) },
  ipcRenderer: { invoke, on: () => undefined, removeListener: () => undefined },
};

/** 让后续 require('electron') 得到假模块（必须在加载 ipc / preload 之前调用） */
function installElectronStub(): void {
  const id = require.resolve('electron');
  require.cache[id] = { id, filename: id, loaded: true, exports: fakeElectron } as unknown as NodeJS.Module;
}

export interface Harness {
  settings: SettingsStore;
  gate: MutationGate;
  stub: Stub;
  invoke: typeof invoke;
  /** 由真实 preload 暴露给界面的接口 */
  api: BeeLiteApi;
}

export function createHarness(opts: { settingsFile: string; source: FakeSource; download?: ManagerOptions['download'] }): Harness {
  installElectronStub();
  stub.handlers.clear();
  stub.messageBoxResponse = 0;
  stub.messageBoxes = [];
  stub.openDialogs = 0;
  stub.pick = null;
  ipcCalls.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppService } = require('../src/main/ipc') as typeof import('../src/main/ipc');
  const settings = new SettingsStore(opts.settingsFile);
  const gate = new MutationGate();
  const service = new AppService({
    getWindow: () => ({ webContents, isDestroyed: () => false }) as unknown as Electron.BrowserWindow,
    settings,
    provider: opts.source as unknown as NewBeeBoxProvider,
    gate,
    download: opts.download ?? opts.source.download,
  });
  service.register();
  // 每次重新加载 preload，让它把接口暴露到本次的桩上
  const preloadId = require.resolve('../src/preload/preload');
  delete require.cache[preloadId];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../src/preload/preload');
  if (!stub.exposed) throw new Error('preload 没有暴露接口');
  return { settings, gate, stub, invoke, api: stub.exposed };
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

export async function readManifestJson(root: string): Promise<{ projects: Record<string, { flavorId: number; fileId: string; folders: string[] }>; recovery: { id: string; kind: string; folders: string[] }[] }> {
  return JSON.parse(await readFile(path.join(root, 'Interface', '.beelite', 'manifest.json'), 'utf8'));
}
