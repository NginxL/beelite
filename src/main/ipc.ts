// IPC 处理：校验发送方与每个参数，界面只传 flavorId / 插件编号 / 目录名等标量，路径全部由主进程解析。
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ActivityReservation, ActivitySnapshot, AddonWatchSnapshot, AppConfig, BackupOutcome, BackupState, BackupTaskSnapshot, ClientUpdateState, ExpectedRecord, FlavorInfo, HealthReport, HistoryKind, HistoryStatusView,
  HistoryVersion, InstalledRecord, LocalState, OpResult, ProfileInfo, SearchQuery, SortOrder, TaskEvent, TaskPhase,
} from '../shared/types';
import { ActivityRegistry } from '../core/activity';
import { AddonUpdateWatch, type WatchClock } from '../core/addon-watch';
import { errorMessage, UserError } from '../core/errors';
import { FILE_ID_RE } from '../core/file-id';
import { DEFAULT_FLAVOR_ID, FLAVORS, getFlavor, interfaceFromVersion } from '../core/flavors';
import { runUpdateAll } from '../core/batch';
import { BUILD_RE, type ClientUpdater } from '../core/client-update';
import { guardHandler, type MutationGate } from '../core/gate';
import type { HistoryOutcome, HistoryStart, HistoryStore } from '../core/history';
import { AddonManager, type InstallExpect, type InstallResult, type ManagerOptions } from '../core/manager';
import { isValidModuleName } from '../core/paths';
import type { PolicyStore } from '../core/policy';
import { inspectPickedRoot, SettingsStore } from '../core/profiles';
import { NewBeeBoxProvider } from '../core/provider';
import { ID_RE, type ProjectRecord } from '../core/store';
import { SNAPSHOT_ID_RE, WtfBackupService, type WtfBackupOptions } from '../core/wtf-backup';

const ORDERS: readonly SortOrder[] = ['ranking', 'update', 'total_download', 'favourite'];
const FINAL_PHASES: ReadonlySet<TaskPhase> = new Set(['done', 'failed', 'cancelled']);
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
/** 界面期望的目标目录：只用于与主进程解析出的绑定目录比对，绝不作为写入路径 */
function expectedRootArg(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || v.includes('\0') || !path.isAbsolute(v)) throw new UserError('目标目录参数无效');
  return v;
}
/** 客户端新版本的构建号：只用于与当前可更新的构建比对 */
function buildArg(v: unknown): string {
  if (typeof v !== 'string' || !BUILD_RE.test(v)) throw new UserError('版本参数无效');
  return v;
}
/** 备份编号：只接受核心生成的格式（不含路径分隔符） */
function snapshotIdArg(v: unknown): string {
  if (typeof v !== 'string' || !SNAPSHOT_ID_RE.test(v)) throw new UserError('备份编号无效');
  return v;
}
/** 备份任务编号：只限制类型与长度，原样交给核心与活动任务比对 */
function backupTaskIdArg(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) throw new UserError('任务编号无效');
  return v;
}
/** 更新 / 重装时界面看到的安装记录 */
function expectedArg(v: unknown): ExpectedRecord {
  if (typeof v !== 'object' || v === null) throw new UserError('安装记录参数无效');
  const r = v as Record<string, unknown>;
  if (typeof r.fileId !== 'string' || !FILE_ID_RE.test(r.fileId)) throw new UserError('安装记录参数无效');
  if (typeof r.installedAt !== 'number' || !Number.isSafeInteger(r.installedAt) || r.installedAt < 0) throw new UserError('安装记录参数无效');
  return { fileId: r.fileId, installedAt: r.installedAt };
}
function installedView(p: ProjectRecord): InstalledRecord {
  return { flavorId: p.flavorId, fileId: p.fileId, version: p.version, name: p.name, logo: p.logo, folders: [...p.folders], installedAt: p.installedAt };
}
function versionOf(p: ProjectRecord): HistoryVersion {
  return { fileId: p.fileId, version: p.version };
}
/** 只返回界面需要的结果字段（不带提交回执） */
function publicResult(r: OpResult): OpResult {
  return { ok: r.ok, message: r.message, ...(r.warnings ? { warnings: r.warnings } : {}) };
}
/** 目录保护：回滚无法判定或目录已暂停写入。它的诊断优先于取消信号，不能被说成“已取消” */
function isBlocked(err: unknown): boolean {
  return err instanceof UserError && err.code === 'blocked';
}

/**
 * 操作没有成功结束时的记录（成功回执由调用方先行处理）：目录保护只记为结果未确认并保留原诊断，不说已回滚，
 * 优先于取消；用户取消为取消；前提已变化（没有做任何改动）为未处理；其他为失败
 */
function failureOutcome(err: unknown, cancelled = false): HistoryOutcome {
  if (isBlocked(err)) return { status: 'unconfirmed', message: `结果未确认，请以当前插件列表为准：${errorMessage(err)}` };
  const code = err instanceof UserError ? err.code : null;
  if (cancelled || code === 'cancelled') return { status: 'cancelled', message: '已取消' };
  const message = errorMessage(err);
  if (code === 'changed') return { status: 'not-processed', message };
  return { status: 'failed', message };
}

/** runInstall 的结果：changed 只在这次确实提交了新的清单记录时为 true（“已是最新”等没有改动） */
interface InstallOutcome {
  result: OpResult;
  changed: boolean;
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
  gate: MutationGate;
  /** 操作记录（userData/operation-history.json；测试注入临时目录中的实例） */
  history: HistoryStore;
  /** 更新策略（userData/addon-policy.json；测试注入临时目录中的实例） */
  policy: PolicyStore;
  /** 测试注入：替换插件下载实现，避免访问真实接口 */
  download?: ManagerOptions['download'];
  /** 测试注入：插件更新自动检查的时钟 */
  clock?: WatchClock;
  /** WTF 配置备份的设置与目录解析（由 backupOptions 生成；测试注入临时目录、上限与阶段钩子） */
  backup: BackupServiceOptions;
}

export type BackupServiceOptions = Omit<WtfBackupOptions, 'onChange'>;

/**
 * WTF 备份服务的依赖：独立设置文件 userData/wtf-backup-settings.json；受保护的应用数据目录只是本应用的 userData；
 * 游戏目录只取自目录绑定（绑定时已规范化）
 */
export function backupOptions(settings: SettingsStore, userData: string, appVersion: string): BackupServiceOptions {
  return {
    settingsFile: path.join(userData, 'wtf-backup-settings.json'),
    appDataDir: userData,
    appVersion,
    resolveRoot: async (flavorId) => (await settings.profile(flavorId)).root,
    listBoundRoots: async () => Object.values((await settings.load()).bindings),
  };
}

/** 完成后要让该目录已有的检查结果按新清单重校验的写通道（flavorId 为第 2 个参数、全部更新为第 1 个；期望目录为最后一个参数，新增参数只能加在它之前） */
const ROOT_WRITE_CHANNELS: ReadonlySet<string> = new Set(['addon:install', 'addon:update', 'addon:updateAll', 'addon:uninstall', 'addon:uninstallFolder', 'trash:restore', 'trash:purge']);
const BINDING_CHANNELS: ReadonlySet<string> = new Set(['profile:bind', 'profile:unbind']);

export class AppService {
  readonly manager: AddonManager;
  /** 插件更新检查协调器：手动、自动与全部更新的内部重查都经由它；由 main 在启动恢复后 start() */
  readonly watch: AddonUpdateWatch;
  private readonly names = new Map<string, string>();
  private readonly tasks = new Map<string, AbortController>();
  private taskSeq = 0;
  /** 插件写操作的占用与进度（界面重新载入后据此恢复）；冲突判断在这里，不依赖界面 */
  readonly activity: ActivityRegistry;
  private clientUpdater: ClientUpdater | null = null;
  /**
   * 健康检查的适配参考值（按游戏版本）：只来自最近一次成功加载的插件库配置（不是本机游戏实测）；
   * 加载失败或从未加载时为空。健康检查本身不加载配置、不联网，也不接受界面给出的参考值
   */
  private interfaceRefs = new Map<number, number | null>();
  /** 进行中的健康检查（按 游戏版本 + 目录）：重复请求复用同一次检查，不并发扫描同一目录 */
  private readonly healthRuns = new Map<string, Promise<HealthReport>>();
  /** 可选的 WTF 配置备份（默认关闭）；退出时由 main 先调用 shutdown() 中止任务，再由退出保护等待闸门排空 */
  readonly backup: WtfBackupService;
  /** 最近一次推送的备份任务快照；只来自内存中的任务状态，不扫描备份位置 */
  private backupTask: BackupTaskSnapshot = { rev: 0, task: null };

  constructor(private readonly deps: ServiceDeps) {
    this.backup = new WtfBackupService({ ...deps.backup, onChange: () => this.pushBackupTask() });
    this.manager = new AddonManager({
      source: deps.provider,
      download: deps.download,
      confirm: async (req) => {
        const win = deps.getWindow();
        const opts = { type: 'warning' as const, title: req.title, message: req.message, detail: req.detail, buttons: ['继续', '取消'], defaultId: 1, cancelId: 1 };
        const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        return r.response === 0;
      },
    });
    this.activity = new ActivityRegistry((s) => this.pushActivity(s));
    this.watch = new AddonUpdateWatch({
      settings: deps.settings,
      checker: this.manager,
      gate: deps.gate,
      clock: deps.clock,
      onChange: (s) => this.pushWatch(s),
      policy: deps.policy,
    });
    // 策略的读取结果变化（包括重新读取后出错或恢复）：立即发布按新策略计算的快照
    deps.policy.onChange(() => this.watch.policyChanged());
    deps.history.onStatus((s) => this.pushHistory(s));
  }

  private pushHistory(s: HistoryStatusView): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('history:status', s);
  }

  /** 操作记录目前有未保存的内容时给出单独提示（不改变操作结果） */
  private withHistoryNote(r: OpResult): OpResult {
    const s = this.deps.history.status();
    const note = s.loadError
      ? `操作记录文件无法读取，记录暂存在内存中：${s.loadError}`
      : s.unsaved > 0
        ? `有 ${s.unsaved} 条操作记录未能保存${s.saveError ? `：${s.saveError}` : ''}，可在「操作记录」中重试`
        : null;
    return note ? { ...r, historyError: note } : r;
  }

  /**
   * 记录一项非安装类的写操作：受理时写入 accepted，结束时只按提交回执写入结果；记录保存失败不改变操作结果。
   */
  private async tracked<R extends OpResult>(start: HistoryStart, run: () => Promise<R>, done: (r: R) => HistoryOutcome): Promise<OpResult> {
    const id = await this.deps.history.begin(start);
    let r: R;
    try {
      r = await run();
    } catch (err) {
      await this.deps.history.finish(id, failureOutcome(err));
      throw err;
    }
    await this.deps.history.finish(id, done(r));
    return this.withHistoryNote(publicResult(r));
  }

  /** 更新与重装之前（已占用该插件）：读取策略文件确认没有暂停；策略无法读取时拒绝 */
  private async assertUpdatable(flavorId: number, root: string, modId: string): Promise<void> {
    if (await this.deps.policy.isPaused(flavorId, root, modId)) {
      throw new UserError('这个插件已暂停更新（保留当前版本），没有做任何改动。如需更新或重装，请先点「恢复更新」', 'paused');
    }
  }

  /**
   * 暂停或恢复更新（已占用该插件：与它的更新、重装、卸载互斥，全部更新期间不受理）。
   * 暂停要求插件按当前游戏版本托管在这个目录；恢复不要求（例如卸载后保留的暂停项）。
   */
  private async setPaused(flavorId: number, root: string, modId: string, paused: boolean): Promise<OpResult> {
    let name = this.names.get(modId) ?? `插件 ${modId}`;
    if (paused) {
      const project = (await this.manager.readManifestFor(root)).projects[modId];
      if (!project) throw new UserError('该插件不在这个目录的艾泽魔方管理列表中，无法暂停更新');
      if (project.flavorId !== flavorId) throw new UserError(`「${project.name}」按其他游戏版本安装，本来就不会检查或更新，无需暂停`);
      name = project.name;
    } else {
      const project = await this.manager.readManifestFor(root).then((m) => m.projects[modId], () => undefined);
      if (project) name = project.name;
    }
    const result = await this.tracked(
      { flavorId, root, kind: paused ? 'pause' : 'resume', modId, name },
      async () => ({ ok: true, message: '', changed: await this.deps.policy.set(flavorId, root, modId, paused) }),
      (r) => ({ status: r.changed ? 'succeeded' : 'unchanged', message: paused ? '暂停更新' : '恢复更新' }),
    ).then((r) => ({
      ...r,
      message: paused
        ? `已暂停「${name}」的更新：保留当前版本。仍会检查并显示新版本，但不会被更新、重装或全部更新处理，也不计入更新提醒；卸载后重新安装仍保持暂停，需要时点「恢复更新」`
        : `已恢复「${name}」的更新`,
    }));
    this.watch.policyChanged(paused ? undefined : { flavorId, root, modId });
    return result;
  }

  /** 备份任务开始、阶段变化、进度（核心已限频）与结束时调用：只读取内存中的任务状态（不调用 state()，不扫描备份位置） */
  private pushBackupTask(): void {
    this.backupTask = { rev: this.backupTask.rev + 1, task: this.backup.taskState() };
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('backup:task', this.backupTaskSnapshot());
  }

  /** 最近一次推送的任务快照（克隆） */
  backupTaskSnapshot(): BackupTaskSnapshot {
    const { rev, task } = this.backupTask;
    return { rev, task: task ? { ...task } : null };
  }

  /**
   * 启用备份：先确认目标仍是当前绑定、没有进行中的任务，再由主进程弹出文件夹选择框；保存位置只来自选择框。
   * 用户取消时返回 null，不调用核心。选择之后由核心在设置标记内再次复核绑定与所选目录
   */
  private async configureBackup(flavorId: number, expected: string): Promise<BackupState | null> {
    await this.targetRoot(flavorId, expected);
    if (this.backup.taskState()) throw new UserError('已有备份或校验任务正在进行，请等待完成或取消后再试', 'backup-busy');
    const win = this.deps.getWindow();
    const opts: Electron.OpenDialogOptions = {
      title: '选择 WTF 配置备份的保存位置',
      message: '将在所选文件夹中新建一个专属的备份文件夹。艾泽魔方不会主动上传；若选择云盘同步的文件夹，副本可能会被云盘同步',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择',
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return null;
    return this.backup.configure(flavorId, expected, picked.filePaths[0]);
  }

  /**
   * 备份 / 校验的结构化结果：核心正常返回即 completed（即使任务最后收到取消请求）；只有明确的 backup-cancelled 错误才是 cancelled，
   * 并保留完整说明；其他错误照常抛出
   */
  private async backupOutcome<T>(run: () => Promise<T>): Promise<BackupOutcome<T>> {
    try {
      return { status: 'completed', result: await run() };
    } catch (err) {
      if (err instanceof UserError && err.code === 'backup-cancelled') return { status: 'cancelled', message: errorMessage(err) };
      throw err;
    }
  }

  /** 在访达中显示：路径只取自核心返回的已登记备份位置或其中已发布的备份 */
  private async revealBackup(flavorId: number, expected: string, snapshotId: string | null): Promise<void> {
    shell.showItemInFolder(await this.backup.revealPath(flavorId, expected, snapshotId));
  }

  private pushActivity(s: ActivitySnapshot): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('addon:activity', s);
  }

  private pushWatch(s: AddonWatchSnapshot): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('addon:watch', s);
  }

  /**
   * 写通道结束后（无论成败），在任何 await 之前同步作废相关结果，再异步只读同步：
   * - 绑定 / 解绑成功：立即作废该游戏版本的全部结果、提醒与进行中的检查，再按设置重建目录列表；
   *   用户取消选择（返回 null）或请求被拒绝时绑定没有改变，只重新同步。
   * - 目录写操作：立即递增该目录的写入代次，再按新清单重校验已有结果。
   */
  private afterMutation(channel: string, args: unknown[], outcome: { failed: boolean; result?: unknown } = { failed: false }): void {
    if (BINDING_CHANNELS.has(channel)) {
      const changed = !outcome.failed && !(channel === 'profile:bind' && outcome.result === null);
      if (changed && typeof args[0] === 'number') this.watch.invalidateFlavor(args[0]);
      void this.watch.bindingsChanged().catch(() => undefined);
      return;
    }
    if (!ROOT_WRITE_CHANNELS.has(channel)) return;
    const f = channel === 'addon:updateAll' ? args[0] : args[1];
    const root = args[args.length - 1];
    if (typeof f !== 'number' || typeof root !== 'string') return;
    void this.watch.afterWrite(f, root).catch(() => undefined);
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
      this.interfaceRefs = new Map(flavors.map((f) => [f.id, f.interfaceNumber]));
      return { flavors, categories: cfg.categories, defaultFlavorId: DEFAULT_FLAVOR_ID, configError: null };
    } catch (err) {
      // 配置不可用：健康检查的适配参考值未知，不沿用旧值
      this.interfaceRefs = new Map();
      const flavors = FLAVORS.map((f) => ({ id: f.id, name: f.name, versions: [], interfaceNumber: null, online: false }));
      return { flavors, categories: [], defaultFlavorId: DEFAULT_FLAVOR_ID, configError: `无法获取插件库配置：${errorMessage(err)}。本地插件管理仍可使用。` };
    }
  }

  private async boundRoot(flavorId: number): Promise<string> {
    const p = await this.deps.settings.profile(flavorId);
    if (!p.root) throw new UserError('请先为当前游戏版本选择游戏目录');
    return p.root;
  }

  /**
   * 操作目标：写入路径只取自设置中该版本当前绑定的目录；expected 是界面在操作前（含确认前）记录的目录，
   * 两者不一致说明绑定已变更，拒绝操作而不是转向新目录
   */
  private async targetRoot(flavorId: number, expected: string): Promise<string> {
    const root = await this.boundRoot(flavorId);
    if (root !== expected) throw new UserError('游戏目录绑定已变更，未做任何改动，请刷新后重试', 'target');
    return root;
  }

  async bind(flavorId: number): Promise<ProfileInfo | null> {
    const flavor = getFlavor(flavorId)!;
    // 先确认设置文件可读取，避免选完目录才报错
    await this.deps.settings.load();
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
      detail: [`插件目录：${addons}`, ...insp.warnings, '艾泽魔方只会在你执行安装、更新、卸载等操作时写入该目录，不会改动 WTF 设置。'].join('\n\n'),
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

  /**
   * 只读健康检查：目标只取自该版本当前绑定的目录（期望目录只做比对）；在 manager 的同目录队列中执行，
   * 不恢复事务、不清理、不刷新本地状态。同一目录已有进行中的检查时直接复用它的结果
   */
  async healthCheck(flavorId: number, expected: string): Promise<HealthReport> {
    const root = await this.targetRoot(flavorId, expected);
    const key = `${flavorId}\n${root}`;
    const running = this.healthRuns.get(key);
    if (running) return running;
    const run = this.manager.health(root, flavorId, this.interfaceRefs.get(flavorId) ?? null).finally(() => {
      if (this.healthRuns.get(key) === run) this.healthRuns.delete(key);
    });
    this.healthRuns.set(key, run);
    return run;
  }

  async localState(flavorId: number): Promise<LocalState> {
    const profile = await this.deps.settings.profile(flavorId);
    if (!profile.root) return { flavorId, profile, dir: null, managed: [], unmanaged: [], recovery: [], error: null };
    return this.manager.localState({ ...profile, root: profile.root }, flavorId);
  }

  /** 任务编号：带上本次运行的活动状态标识，不同运行（例如测试中的多个主进程实例）的编号不会重复 */
  private newTaskId(): string {
    return `${this.activity.instance.slice(0, 8)}-t${++this.taskSeq}`;
  }

  /**
   * 单个插件的写操作：目标目录已解析，在下一个 await 之前同步占用（与全部更新、同一插件的其他写操作互斥），
   * 由这一次调用在 finally 中释放。
   */
  private async single<T>(flavorId: number, root: string, modId: string, kind: ActivityReservation['kind'], fn: () => Promise<T>): Promise<T> {
    const release = this.activity.reserveProject(flavorId, root, modId, kind);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 以任务形式执行安装/更新，向界面推送进度，可取消；root 在受理时已确定，之后即使换绑也只写入它。
   * 任务从受理到终态都登记在活动状态中（界面重新载入后可恢复）；每个任务只发一个终态，在安装返回（目录锁已释放）之后发送，
   * 先发终态（done 带上本次提交到清单的记录）再推送移除了该任务的快照。
   * expect：目录锁内核对的条件（首次安装必须尚未安装；更新 / 重装必须仍是受理时的记录）。
   * syncWatch：发终态之前先把这次写入同步到更新检查结果（只读清单，不扫描目录），全部更新据此在进入下一项之前完成同步；
   * 单项操作由写通道结束后的 afterMutation 同步。
   * batch：全部更新中已在计划时登记（排队中）的任务。
   */
  private async runInstall(
    modId: string,
    flavorId: number,
    force: boolean,
    root: string,
    o: { expect: InstallExpect; batch?: { taskId: string; batchId: string }; syncWatch?: boolean },
  ): Promise<InstallOutcome> {
    const taskId = o.batch?.taskId ?? this.newTaskId();
    const label = this.names.get(modId) ?? `插件 ${modId}`;
    const ac = new AbortController();
    this.tasks.set(taskId, ac);
    const send = (phase: TaskPhase, rev: number, extra: Partial<TaskEvent> = {}) => this.emit({ taskId, label, phase, flavorId, root, modId, rev, ...extra });
    if (!o.batch) {
      const rev = this.activity.startTask({ taskId, label, flavorId, root, modId, batchId: null });
      this.activity.publish();
      send('queued', rev);
    }
    let phaseNow: TaskPhase = 'queued';
    let r: InstallResult | null = null;
    let failure: unknown = null;
    // 受理时写入操作记录（保存失败不影响安装）；旧 / 新版本只取自提交回执，受理时的文件编号只作为“请求时”的参考
    const kind: HistoryKind = force ? 'reinstall' : o.expect.kind === 'absent' ? 'install' : 'update';
    const hid = await this.deps.history.begin({
      flavorId, root, kind, modId, name: label, batchId: o.batch?.batchId ?? null, expectedFileId: o.expect.kind === 'record' ? o.expect.fileId : null,
    });
    try {
      // 终态统一在下面发送，这里只转发进行中的阶段；阶段变化推送快照，下载字节数只随事件发送
      r = await this.manager.install(root, flavorId, modId, {
        force,
        signal: ac.signal,
        expect: o.expect,
        onPhase: (phase, received, total) => {
          if (FINAL_PHASES.has(phase)) return;
          const bytes = { received: received ?? null, total: total ?? null };
          if (phase === phaseNow) {
            send(phase, this.activity.progress(taskId, bytes.received, bytes.total), { received, total });
            return;
          }
          phaseNow = phase;
          const rev = this.activity.setPhase(taskId, phase as Exclude<TaskPhase, 'done' | 'failed' | 'cancelled'>, bytes.received, bytes.total);
          this.activity.publish();
          send(phase, rev, { received, total });
        },
      });
    } catch (err) {
      failure = err;
    } finally {
      this.tasks.delete(taskId);
    }
    // 同步失败（例如清单暂时无法读回）由检查协调器标为无法确认，不影响这次安装的结果
    if (o.syncWatch) await this.watch.afterWrite(flavorId, root).catch(() => undefined);
    const end = (phase: TaskPhase, extra: Partial<TaskEvent>) => {
      send(phase, this.activity.endTask(taskId), extra);
      this.activity.publish();
    };
    if (r) {
      // 已有结果优先于取消信号：已提交的安装不会被记为取消
      const { installed, previous, ...rest } = r;
      const result = publicResult(rest);
      end(result.ok ? 'done' : 'cancelled', { message: result.message, ...(installed ? { installed: installedView(installed) } : {}) });
      await this.deps.history.finish(hid, installed
        ? { status: 'succeeded', message: result.message, warnings: result.warnings, name: installed.name, previous: previous ? versionOf(previous) : null, installed: versionOf(installed) }
        : result.ok
          ? { status: 'unchanged', message: result.message, warnings: result.warnings }
          : { status: 'cancelled', message: result.message });
      return { result: this.withHistoryNote(result), changed: !!installed };
    }
    // 没有结果：目录保护的诊断优先于取消信号（取消与回滚无法判定同时发生时，不能只说已取消）
    const blocked = isBlocked(failure);
    const cancelled = !blocked && ac.signal.aborted;
    const message = cancelled ? '已取消' : errorMessage(failure);
    // 前置条件不满足：没有做任何改动，行内显示为未处理（不是失败）
    const changed = !cancelled && failure instanceof UserError && failure.code === 'changed';
    end(cancelled || changed ? 'cancelled' : 'failed', { message });
    await this.deps.history.finish(hid, failureOutcome(failure, cancelled));
    // 保留错误码：全部更新据此区分取消、排队期间变化、结果未确认与失败
    if (cancelled) throw new UserError(message, 'cancelled');
    if (failure instanceof UserError) throw new UserError(message, failure.code);
    throw new Error(message);
  }

  /**
   * 全部更新：批次固定在开始时绑定的目录，绑定变化即停止（当前项在原目录完成，之后的项目不再处理）；
   * 只更新来源版本与当前版本一致的插件。目标解析后同步占用该目录（与单项写操作双向互斥），finally 中释放。
   * 每一项在目录锁内核对计划时的安装记录，排队期间被改动的项目不处理。
   */
  async updateAll(flavorId: number, expected: string): Promise<OpResult> {
    const root = await this.targetRoot(flavorId, expected);
    const batch = this.activity.reserveBatch(flavorId, root);
    /** 已排入计划、尚未开始的项目 */
    const waiting = new Map<string, { taskId: string; label: string }>();
    try {
      const result = await runUpdateAll({
        manager: this.manager,
        root,
        flavorId,
        // 批次已占用该目录：期间不受理暂停与恢复，检查前读取一次即可；策略无法读取时整个批次不开始
        paused: () => this.deps.policy.pausedIn(flavorId, root),
        isStillBound: async () => (await this.deps.settings.profile(flavorId)).root === root,
        // 批次已在写入闸门内：强制新检查排在自动检查之前、不等待闸门，避免与自动检查叠加并发
        check: (r, f) => this.watch.check(f, r, { fresh: true }),
        // 计划确定后登记每一项（排队中，推送一次快照），开始处理时沿用同一个任务编号
        plan: (projects) => {
          const items = projects.map((p) => {
            this.names.set(p.modId, p.name);
            const t = { taskId: this.newTaskId(), label: p.name };
            waiting.set(p.modId, t);
            return { ...t, modId: p.modId };
          });
          const rev = this.activity.planBatch(batch, items);
          for (const it of items) this.emit({ taskId: it.taskId, label: it.label, phase: 'queued', flavorId, root, modId: it.modId, rev });
        },
        installOne: async (p, fixedRoot) => {
          const t = waiting.get(p.modId);
          waiting.delete(p.modId);
          if (!t) throw new Error(`计划中没有 ${p.modId}`);
          const o = await this.runInstall(p.modId, flavorId, false, fixedRoot, {
            batch: { taskId: t.taskId, batchId: batch.batchId },
            syncWatch: true,
            expect: { kind: 'record', fileId: p.fileId, installedAt: p.installedAt },
          });
          // 结构化地告诉批次这一项是否真的提交了改动（不解析说明文字）
          return { ...o.result, changed: o.changed };
        },
      });
      return this.withHistoryNote(result);
    } finally {
      // 批次停止（绑定变更）或中止：尚未开始的项目结束等待，它们没有执行任何操作
      const stopped = [...waiting];
      for (const [modId, t] of stopped) {
        this.emit({ ...t, phase: 'cancelled', flavorId, root, modId, message: '全部更新已停止，这一项未处理', rev: this.activity.endTask(t.taskId) });
      }
      batch.release();
      for (const [modId, t] of stopped) {
        await this.deps.history.record(
          { flavorId, root, kind: 'update', modId, name: t.label, batchId: batch.batchId },
          { status: 'not-processed', message: '全部更新已停止，这一项未处理' },
        );
      }
    }
  }

  attachClientUpdater(u: ClientUpdater): void {
    this.clientUpdater = u;
  }

  pushClientState(st: ClientUpdateState): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('client:event', st);
  }

  private clientState(): ClientUpdateState {
    if (this.clientUpdater) return this.clientUpdater.getState();
    return { status: 'unsupported', currentVersion: app.getVersion(), availableVersion: null, percent: null, message: '客户端更新组件尚未就绪', canCheck: false, canUpdate: false, canCancel: false };
  }

  register(): void {
    const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      // 写通道在调用 fn 之前同步进入闸门，整个回调结束后才释放
      const guarded = guardHandler(this.deps.gate, channel, fn);
      ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
        this.assertSender(e);
        const outcome: { failed: boolean; result?: unknown } = { failed: true };
        try {
          outcome.result = await guarded(...args);
          outcome.failed = false;
          return outcome.result;
        } catch (err) {
          throw new Error(errorMessage(err));
        } finally {
          this.afterMutation(channel, args, outcome);
        }
      });
    };
    // 客户端更新：固定操作；更新与已读提醒只接收界面看到的构建号，用于比对
    handle('client:state', async () => this.clientState());
    handle('client:check', async () => this.clientUpdater?.check() ?? this.clientState());
    handle('client:update', async (b) => {
      const build = buildArg(b);
      return this.clientUpdater?.update(build) ?? this.clientState();
    });
    handle('client:cancel', async () => this.clientUpdater?.cancel() ?? this.clientState());
    handle('client:ackNotice', async (b) => {
      const build = buildArg(b);
      return this.clientUpdater?.ackNotice(build) ?? this.clientState();
    });
    handle('addon:watchState', async () => this.watch.snapshot());
    handle('addon:activityState', async () => this.activity.snapshot());
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
    // 以下作用于某个游戏目录的操作：flavorId 是界面当前显示的版本，root 是界面记录的期望目录（只做比对）
    handle('profile:unbind', (f, root) => this.deps.settings.bind(flavorArg(f), null, expectedRootArg(root)));
    handle('local:state', (f) => this.localState(flavorArg(f)));
    handle('addon:check', async (f, root) => {
      const flavorId = flavorArg(f);
      // 等一次有效检查完成后返回权威快照（含合并结果与 rev）；界面不使用未经快照校验的原始结果
      await this.watch.check(flavorId, await this.targetRoot(flavorId, expectedRootArg(root)));
      return this.watch.snapshot();
    });
    // 安装 / 更新 / 卸载：目标解析之后同步占用，再开始远端请求与等待目录锁
    handle('addon:install', async (m, f, root) => {
      const modId = modArg(m);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      return this.single(flavorId, target, modId, 'install', async () => (await this.runInstall(modId, flavorId, false, target, { expect: { kind: 'absent' } })).result);
    });
    handle('addon:update', async (m, f, force, expected, root) => {
      if (typeof force !== 'boolean') throw new UserError('参数无效');
      const modId = modArg(m);
      const flavorId = flavorArg(f);
      const record = expectedArg(expected);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      // 占用之后再读取策略：暂停 / 恢复也占用同一插件，两者不会交错；暂停项（包括 force 重装）与策略未知时拒绝
      return this.single(flavorId, target, modId, 'update', async () => {
        await this.assertUpdatable(flavorId, target, modId);
        return (await this.runInstall(modId, flavorId, force, target, { expect: { kind: 'record', ...record } })).result;
      });
    });
    handle('addon:updateAll', (f, root) => this.updateAll(flavorArg(f), expectedRootArg(root)));
    handle('addon:uninstall', async (m, f, root) => {
      const modId = modArg(m);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      // 卸载不受暂停影响，也不清除暂停（重新安装后仍保持暂停）
      return this.single(flavorId, target, modId, 'uninstall', () => this.tracked(
        { flavorId, root: target, kind: 'uninstall', modId, name: this.names.get(modId) ?? `插件 ${modId}` },
        () => this.manager.uninstallProject(target, modId),
        (r) => ({ status: 'succeeded', message: r.message, name: r.removed.name, previous: versionOf(r.removed) }),
      ));
    });
    handle('addon:uninstallFolder', async (name, f, root) => {
      const folder = folderArg(name);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      return this.tracked(
        { flavorId, root: target, kind: 'uninstall-folder', target: folder, name: folder },
        () => this.manager.uninstallFolder(target, folder),
        (r) => ({ status: 'succeeded', message: r.message }),
      );
    });
    handle('trash:restore', async (id, f, root) => {
      const entryId = entryArg(id);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      return this.tracked(
        { flavorId, root: target, kind: 'restore', target: entryId, name: `回收站条目 ${entryId}` },
        () => this.manager.restore(target, entryId),
        (r) => ({ status: 'succeeded', message: r.message, name: r.label, modId: r.restored?.modId ?? null, installed: r.restored ? versionOf(r.restored) : null }),
      );
    });
    handle('trash:purge', async (id, f, root) => {
      const entryId = entryArg(id);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      return this.tracked(
        { flavorId, root: target, kind: 'purge', target: entryId, name: `回收站条目 ${entryId}` },
        () => this.manager.purge(target, entryId),
        (r) => ({ status: 'succeeded', message: r.message, name: r.label }),
      );
    });
    handle('task:cancel', async (id) => {
      if (typeof id === 'string') this.tasks.get(id)?.abort();
    });
    // 暂停 / 恢复更新：目标解析之后同步占用同一插件（与它的更新、重装、卸载以及全部更新互斥），再读写策略文件
    handle('policy:set', async (m, f, p, root) => {
      if (typeof p !== 'boolean') throw new UserError('参数无效');
      const modId = modArg(m);
      const flavorId = flavorArg(f);
      const target = await this.targetRoot(flavorId, expectedRootArg(root));
      return this.single(flavorId, target, modId, 'policy', () => this.setPaused(flavorId, target, modId, p));
    });
    // 重新读取策略文件（只读），返回按新策略计算的快照
    handle('policy:reload', async () => {
      await this.deps.policy.reload();
      return this.watch.snapshot();
    });
    // 操作记录：只返回当前绑定目录的记录
    handle('history:list', async (f, root) => {
      const flavorId = flavorArg(f);
      return this.deps.history.list(flavorId, await this.targetRoot(flavorId, expectedRootArg(root)));
    });
    handle('history:status', async () => this.deps.history.status());
    handle('history:retry', async () => this.deps.history.retry());
    // 只读健康检查：只接收游戏版本与期望目录（比对用），不接受任何路径或参考值
    handle('health:check', async (f, root) => this.healthCheck(flavorArg(f), expectedRootArg(root)));
    // WTF 配置备份：不经过插件写操作的占用与本地状态刷新；启用 / 关闭 / 备份 / 校验在闸门内（整个 Promise 含收尾），取消不入闸
    handle('backup:taskState', async () => this.backupTaskSnapshot());
    handle('backup:state', async (f, root) => this.backup.state(flavorArg(f), expectedRootArg(root)));
    handle('backup:configure', (f, root) => this.configureBackup(flavorArg(f), expectedRootArg(root)));
    handle('backup:disable', async (f, root) => this.backup.disable(flavorArg(f), expectedRootArg(root)));
    handle('backup:run', async (f, root) => {
      const flavorId = flavorArg(f);
      const target = expectedRootArg(root);
      return this.backupOutcome(() => this.backup.run(flavorId, target));
    });
    handle('backup:verify', async (f, root, id) => {
      const flavorId = flavorArg(f);
      const target = expectedRootArg(root);
      const snapshotId = snapshotIdArg(id);
      return this.backupOutcome(() => this.backup.verify(flavorId, target, snapshotId));
    });
    // 取消按任务受理时的原值匹配，不要求与当前绑定相同；只影响编号、版本与目录都一致的那个任务
    handle('backup:cancel', async (id, f, root) => this.backup.cancel(backupTaskIdArg(id), flavorArg(f), expectedRootArg(root)));
    handle('backup:reveal', async (f, root, id) => this.revealBackup(flavorArg(f), expectedRootArg(root), id === null ? null : snapshotIdArg(id)));
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
