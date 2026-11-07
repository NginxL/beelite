// IPC 处理：校验发送方与每个参数，界面只传 flavorId / 插件编号 / 目录名等标量，路径全部由主进程解析。
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, FlavorInfo, LocalState, OpResult, ProfileInfo, SearchQuery, SortOrder, TaskEvent, TaskPhase } from '../shared/types';
import { errorMessage, UserError } from '../core/errors';
import { DEFAULT_FLAVOR_ID, FLAVORS, getFlavor, interfaceFromVersion } from '../core/flavors';
import { runUpdateAll } from '../core/batch';
import { AddonManager } from '../core/manager';
import { isValidModuleName } from '../core/paths';
import { inspectPickedRoot, SettingsStore } from '../core/profiles';
import { NewBeeBoxProvider } from '../core/provider';
import { ID_RE } from '../core/store';

const ORDERS: readonly SortOrder[] = ['ranking', 'update', 'total_download', 'favourite'];
const WOW_APP_DIR = '/Applications/World of Warcraft';

export const APP_ORIGIN = 'app://beelite';

function flavorArg(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || !getFlavor(v)) throw new UserError('不支持的游戏版本');
  return v;
}
function modArg(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw new UserError('插件编号无效');
  return v;
}
function entryArg(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new UserError('回收站条目无效');
  return v;
}
function folderArg(v: unknown): string {
  if (typeof v !== 'string' || !isValidModuleName(v)) throw new UserError('目录名无效');
  return v;
}
function queryArg(v: unknown): SearchQuery {
  if (typeof v !== 'object' || v === null) throw new UserError('搜索参数无效');
  const q = v as Record<string, unknown>;
  const category = q.category;
  const offset = q.offset;
  if (typeof category !== 'number' || !Number.isInteger(category) || category < 0 || category > 1e7) throw new UserError('分类无效');
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new UserError('分页无效');
  if (typeof q.order !== 'string' || !ORDERS.includes(q.order as SortOrder)) throw new UserError('排序无效');
  if (typeof q.keyword !== 'string' || q.keyword.length > 100) throw new UserError('关键词无效');
  return { flavorId: flavorArg(q.flavorId), category, order: q.order as SortOrder, keyword: q.keyword.trim(), offset };
}

export interface ServiceDeps {
  getWindow: () => BrowserWindow | null;
  settings: SettingsStore;
  provider: NewBeeBoxProvider;
}

export class AppService {
  readonly manager: AddonManager;
  private readonly names = new Map<string, string>();
  private readonly tasks = new Map<string, AbortController>();
  private taskSeq = 0;

  constructor(private readonly deps: ServiceDeps) {
    this.manager = new AddonManager({
      source: deps.provider,
      confirm: async (req) => {
        const win = deps.getWindow();
        const opts = { type: 'warning' as const, title: req.title, message: req.message, detail: req.detail, buttons: ['继续', '取消'], defaultId: 1, cancelId: 1 };
        const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        return r.response === 0;
      },
    });
  }

  private emit(ev: TaskEvent): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('task:event', ev);
  }

  async config(): Promise<AppConfig> {
    try {
      const cfg = await this.deps.provider.getConfig();
      const flavors: FlavorInfo[] = FLAVORS.map((f) => {
        const remote = cfg.flavors.find((r) => r.id === f.id);
        return { id: f.id, name: remote?.name || f.name, versions: remote?.versions ?? [], interfaceNumber: remote?.versions[0] ? interfaceFromVersion(remote.versions[0]) : null, online: !!remote };
      });
      return { flavors, categories: cfg.categories, defaultFlavorId: DEFAULT_FLAVOR_ID, configError: null };
    } catch (err) {
      const flavors = FLAVORS.map((f) => ({ id: f.id, name: f.name, versions: [], interfaceNumber: null, online: false }));
      return { flavors, categories: [], defaultFlavorId: DEFAULT_FLAVOR_ID, configError: `无法获取插件库配置：${errorMessage(err)}。本地插件管理仍可使用。` };
    }
  }

  private async boundRoot(flavorId: number): Promise<string> {
    const p = await this.deps.settings.profile(flavorId);
    if (!p.root) throw new UserError('请先为当前游戏版本选择游戏目录');
    return p.root;
  }

  async bind(flavorId: number): Promise<ProfileInfo | null> {
    const flavor = getFlavor(flavorId)!;
    const win = this.deps.getWindow();
    let defaultPath = WOW_APP_DIR;
    if (flavor.expectedDir) {
      const candidate = path.join(WOW_APP_DIR, flavor.expectedDir);
      if (await stat(candidate).then((s) => s.isDirectory(), () => false)) defaultPath = candidate;
    }
    const openOpts: Electron.OpenDialogOptions = {
      title: `选择「${flavor.name}」的游戏目录`,
      message: flavor.expectedDir ? `请选择 ${flavor.expectedDir} 文件夹（也可以直接选择其中的 Interface/AddOns）` : '请选择该版本的游戏目录（形如 _xxx_ 的文件夹）',
      defaultPath,
      properties: ['openDirectory'],
      buttonLabel: '选择',
    };
    const picked = win ? await dialog.showOpenDialog(win, openOpts) : await dialog.showOpenDialog(openOpts);
    if (picked.canceled || !picked.filePaths[0]) return null;
    const settings = await this.deps.settings.load();
    const insp = await inspectPickedRoot(picked.filePaths[0], flavorId, settings.bindings);
    const addons = path.join(insp.root, 'Interface', 'AddOns');
    const msgOpts = {
      type: (insp.warnings.length ? 'warning' : 'question') as 'warning' | 'question',
      title: '确认游戏目录',
      message: `将「${flavor.name}」绑定到以下插件目录？`,
      detail: [`插件目录：${addons}`, ...insp.warnings, '蜂简只会在你执行安装、更新、卸载等操作时写入该目录，不会改动 WTF 设置。'].join('\n\n'),
      buttons: ['绑定', '取消'],
      defaultId: 0,
      cancelId: 1,
    };
    const ok = win ? await dialog.showMessageBox(win, msgOpts) : await dialog.showMessageBox(msgOpts);
    if (ok.response !== 0) return null;
    const profile = await this.deps.settings.bind(flavorId, insp.root);
    await this.manager.recover(insp.root).catch(() => undefined);
    return profile;
  }

  async localState(flavorId: number): Promise<LocalState> {
    const profile = await this.deps.settings.profile(flavorId);
    if (!profile.root) return { flavorId, profile, dir: null, managed: [], unmanaged: [], recovery: [], error: null };
    return this.manager.localState({ ...profile, root: profile.root }, flavorId);
  }

  /** 以任务形式执行安装/更新，向界面推送进度，可取消 */
  private async runInstall(modId: string, flavorId: number, force: boolean, fixedRoot?: string): Promise<OpResult> {
    const root = fixedRoot ?? (await this.boundRoot(flavorId));
    const taskId = `t${++this.taskSeq}`;
    const label = this.names.get(modId) ?? `插件 ${modId}`;
    const ac = new AbortController();
    this.tasks.set(taskId, ac);
    const send = (phase: TaskPhase, extra: Partial<TaskEvent> = {}) => this.emit({ taskId, label, phase, ...extra });
    send('queued');
    try {
      const r = await this.manager.install(root, flavorId, modId, { force, signal: ac.signal, onPhase: (phase, received, total) => send(phase, { received, total }) });
      send(r.ok ? 'done' : 'cancelled', { message: r.message });
      return r;
    } catch (err) {
      const message = ac.signal.aborted ? '已取消' : errorMessage(err);
      send(ac.signal.aborted ? 'cancelled' : 'failed', { message });
      throw new Error(message);
    } finally {
      this.tasks.delete(taskId);
    }
  }

  /** 全部更新：批次固定在开始时绑定的目录，绑定变化即停止 */
  async updateAll(flavorId: number): Promise<OpResult> {
    const root = await this.boundRoot(flavorId);
    return runUpdateAll({
      manager: this.manager,
      root,
      isStillBound: async () => (await this.deps.settings.profile(flavorId)).root === root,
      installOne: (p, fixedRoot) => {
        this.names.set(p.modId, p.name);
        return this.runInstall(p.modId, p.flavorId, false, fixedRoot);
      },
    });
  }

  register(): void {
    const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
        this.assertSender(e);
        try {
          return await fn(...args);
        } catch (err) {
          throw new Error(errorMessage(err));
        }
      });
    };
    handle('config:get', () => this.config());
    handle('mods:search', async (q) => {
      const r = await this.deps.provider.search(queryArg(q));
      for (const it of r.items) this.names.set(it.id, it.name);
      return r;
    });
    handle('mods:detail', async (m, f) => {
      const d = await this.deps.provider.detail(modArg(m), flavorArg(f));
      this.names.set(d.id, d.name);
      return d;
    });
    handle('mods:latest', async (m, f) => {
      const { downloadUrl: _url, ...info } = await this.deps.provider.latest(modArg(m), flavorArg(f));
      return info;
    });
    handle('profile:list', async () => Promise.all(FLAVORS.map((f) => this.deps.settings.profile(f.id))));
    handle('profile:bind', (f) => this.bind(flavorArg(f)));
    handle('profile:unbind', (f) => this.deps.settings.bind(flavorArg(f), null));
    handle('local:state', (f) => this.localState(flavorArg(f)));
    handle('addon:check', async (f) => this.manager.checkUpdates(await this.boundRoot(flavorArg(f))));
    handle('addon:install', (m, f) => this.runInstall(modArg(m), flavorArg(f), false));
    handle('addon:update', (m, f, force) => {
      if (typeof force !== 'boolean') throw new UserError('参数无效');
      return this.runInstall(modArg(m), flavorArg(f), force);
    });
    handle('addon:updateAll', (f) => this.updateAll(flavorArg(f)));
    handle('addon:uninstall', async (m, f) => this.manager.uninstallProject(await this.boundRoot(flavorArg(f)), modArg(m)));
    handle('addon:uninstallFolder', async (name, f) => this.manager.uninstallFolder(await this.boundRoot(flavorArg(f)), folderArg(name)));
    handle('trash:restore', async (id, f) => this.manager.restore(await this.boundRoot(flavorArg(f)), entryArg(id)));
    handle('trash:purge', async (id, f) => this.manager.purge(await this.boundRoot(flavorArg(f)), entryArg(id)));
    handle('task:cancel', async (id) => {
      if (typeof id === 'string') this.tasks.get(id)?.abort();
    });
  }

  /** 只接受主窗口中本地页面发出的调用 */
  private assertSender(e: IpcMainInvokeEvent): void {
    const win = this.deps.getWindow();
    const url = e.senderFrame?.url ?? '';
    if (!win || e.sender !== win.webContents || !url.startsWith(`${APP_ORIGIN}/`)) {
      throw new Error('拒绝来自未知页面的请求');
    }
  }
}
