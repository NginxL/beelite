// 主进程与界面之间传递的数据结构。界面只拿到这些已规范化的对象，不接触路径之外的系统能力。

export type SortOrder = 'ranking' | 'update' | 'total_download' | 'favourite';

export interface FlavorInfo {
  id: number;
  name: string;
  /** 远端配置给出的游戏版本号列表，第一项为当前版本 */
  versions: string[];
  /** 当前版本对应的 TOC Interface 号，例如 1.60.1 -> 16001 */
  interfaceNumber: number | null;
  /** 远端配置是否包含该版本（离线时为 false） */
  online: boolean;
}

export interface CategoryInfo {
  id: number;
  name: string;
}

export interface AppConfig {
  flavors: FlavorInfo[];
  categories: CategoryInfo[];
  defaultFlavorId: number;
  /** 远端配置不可用时的错误说明；本地功能仍可用 */
  configError: string | null;
}

export interface ModSummary {
  id: string;
  name: string;
  logo: string | null;
  summary: string;
  author: string;
  updatedAt: number;
  downloads: number;
  favorites: number;
  categories: CategoryInfo[];
  version: string;
  gameVersions: string[];
  folders: string[];
  /** 免费且当前可访问 */
  accessible: boolean;
}

export interface ModDetail extends ModSummary {
  description: string;
  screenshots: string[];
  flavorId: number;
}

export interface ModFileInfo {
  fileId: string;
  modId: string;
  displayName: string;
  size: number;
  folders: string[];
  gameVersions: string[];
  releaseType: number;
  date: number;
  /** 文件声明的游戏版本与当前 flavor 是否有交集 */
  compatible: boolean;
}

export interface SearchQuery {
  flavorId: number;
  category: number;
  order: SortOrder;
  keyword: string;
  offset: number;
}

export interface SearchResult {
  items: ModSummary[];
  total: number;
  offset: number;
  nextOffset: number;
}

export interface ProfileInfo {
  flavorId: number;
  /** 版本根目录，例如 /Applications/World of Warcraft/_forever_ */
  root: string | null;
  addonsPath: string | null;
}

export interface TocInfo {
  title: string;
  version: string;
  notes: string;
  interfaces: number[];
  tocFile: string;
}

export interface LocalFolder {
  name: string;
  toc: TocInfo | null;
  symlink: boolean;
}

export interface ManagedProjectView {
  modId: string;
  flavorId: number;
  name: string;
  logo: string | null;
  fileId: string;
  version: string;
  folders: { name: string; present: boolean }[];
  installedAt: number;
  toc: TocInfo | null;
}

export interface RecoveryEntryView {
  id: string;
  kind: 'uninstall' | 'update-backup' | 'takeover';
  createdAt: number;
  label: string;
  folders: string[];
  modId: string | null;
}

export interface DirState {
  status: 'ok' | 'blocked';
  message: string | null;
}

export interface LocalState {
  flavorId: number;
  profile: ProfileInfo;
  dir: DirState | null;
  managed: ManagedProjectView[];
  unmanaged: LocalFolder[];
  recovery: RecoveryEntryView[];
  error: string | null;
}

export interface UpdateCheckItem {
  modId: string;
  hasUpdate: boolean;
  latestFileId: string | null;
  latestVersion: string | null;
  error: string | null;
  /** 来源游戏版本与目录当前绑定的版本不同：未检查，不会更新（说明文字） */
  skipped?: string;
  /** 检查时本地清单记录的文件编号；界面只把结果用于 fileId 仍相同的本地项目 */
  installedFileId?: string;
  /** 检查时本地清单记录的插件名称 */
  name?: string;
  /** 错误是否为临时性的（网络、超时、服务器繁忙），决定自动检查的重试间隔 */
  transient?: boolean;
  /** 本次检查失败，显示的是上一次成功检查的结果 */
  stale?: boolean;
  /** 这条结果对应的检查完成时间（毫秒） */
  checkedAt?: number;
}

export type AddonWatchStatus = 'pending' | 'checking' | 'ok' | 'partial' | 'error';

/** 一个已绑定游戏目录的插件更新检查状态（主进程内存中，按 游戏版本 + 目录 区分） */
export interface AddonWatchEntry {
  flavorId: number;
  root: string;
  status: AddonWatchStatus;
  items: UpdateCheckItem[];
  /** 可更新的插件数 */
  pending: number;
  /** 检查失败的插件数（不含跳过的） */
  failed: number;
  /** 最近一次检查完成的时间；从未完成为 null */
  checkedAt: number | null;
  /** 整个目录无法检查时的原因 */
  error: string | null;
  /** 下次自动检查的时间 */
  nextCheckAt: number | null;
}

export interface AddonWatchSnapshot {
  /** 主进程本次运行的标识；rev 只在同一 instance 内可比较 */
  instance: string;
  /** 单调递增，界面只按它判断快照新旧（检查时间只用于显示） */
  rev: number;
  entries: AddonWatchEntry[];
  settingsError: string | null;
  /** 最近一次自动检查新发现的可更新插件（同一目录、插件与文件只提醒一次） */
  notice: { seq: number; count: number; flavorIds: number[] } | null;
}

export type TaskPhase = 'queued' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled';

/** 一次安装或更新提交到清单的记录（主进程在提交后给出，界面据此显示已安装的版本，不按远端最新文件推测） */
export interface InstalledRecord {
  flavorId: number;
  fileId: string;
  version: string;
  name: string;
  logo: string | null;
  folders: string[];
  installedAt: number;
}

export interface TaskEvent {
  taskId: string;
  /** 只用于显示，不作为身份 */
  label: string;
  phase: TaskPhase;
  /** 任务受理时确定的游戏版本、目录与插件编号：界面只按三者完全一致把任务关联到插件行 */
  flavorId: number;
  root: string;
  modId: string;
  received?: number;
  total?: number;
  message?: string;
  /** 只出现在 done 中，且仅当这次确实提交了新的清单记录（“已是最新”等未改动的情况没有） */
  installed?: InstalledRecord;
  /** 发送时主进程活动状态的版本（与 ActivitySnapshot.rev 同一序列）：界面据此判断事件与快照谁更新 */
  rev: number;
}

/** 更新或重装时界面看到的安装记录：主进程在目录锁内核对，与当前清单不一致时不写入 */
export interface ExpectedRecord {
  fileId: string;
  installedAt: number;
}

export type ActivePhase = 'queued' | 'checking' | 'downloading' | 'verifying' | 'installing';

/** 进行中的安装 / 更新任务（批次中排队的项目也在内） */
export interface ActivityTask {
  taskId: string;
  label: string;
  flavorId: number;
  root: string;
  modId: string;
  phase: ActivePhase;
  received: number | null;
  total: number | null;
  /** 所属的全部更新；单项操作为 null */
  batchId: string | null;
}

/** 进行中的全部更新；checking：正在重新检查（计划未定），running：计划已确定、逐项处理 */
export interface ActivityBatch {
  batchId: string;
  flavorId: number;
  root: string;
  stage: 'checking' | 'running';
}

/** 已受理、尚未结束的单个插件写操作（安装、更新、重装、卸载） */
export interface ActivityReservation {
  flavorId: number;
  root: string;
  modId: string;
  kind: 'install' | 'update' | 'uninstall';
}

/**
 * 主进程的插件写操作状态（界面重新载入后据此恢复占用与进度）。同一次运行内 rev 单调递增，
 * 任务事件携带同一序列的 rev；界面先订阅推送再获取快照，按 rev 丢弃过时的一方。
 */
export interface ActivitySnapshot {
  instance: string;
  rev: number;
  batches: ActivityBatch[];
  tasks: ActivityTask[];
  reservations: ActivityReservation[];
}

export interface OpResult {
  ok: boolean;
  message: string;
  warnings?: string[];
}

export type ClientUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'extracting'
  | 'waiting'
  | 'installing'
  | 'error';

/** 更新说明的来源状态：ok 有纯文本说明；missing 未提供；unsupported 不是纯文本格式；unverified 更新信息签名未通过 */
export type ReleaseNotesState = 'ok' | 'missing' | 'unsupported' | 'unverified';

/** 客户端（蜂简自身）更新状态，由主进程维护 */
export interface ClientUpdateState {
  status: ClientUpdateStatus;
  currentVersion: string;
  /** 新版本的显示版本号 */
  availableVersion: string | null;
  /** 新版本的构建号（Sparkle 比较与授权用），与 availableVersion、说明来自同一个已验证的更新条目 */
  availableBuild?: string | null;
  /** 新版本的纯文本更新说明 */
  releaseNotes?: string | null;
  notesState?: ReleaseNotesState | null;
  notesTruncated?: boolean;
  /** 本次启动中这个构建尚未提醒过，界面应主动展示更新说明 */
  notice?: boolean;
  /** 单调递增，界面据此丢弃过时的状态 */
  rev?: number;
  /** 下载或解压进度，0–100；未知时为 null */
  percent: number | null;
  message: string | null;
  /**
   * 最近一次检查新版本失败、超时，或正在因超时停止。它本身不表示原生检查已结束：
   * 界面只在同时 canCheck 时显示“重试”（停止期间 canCheck 为 false），即使之前发现的新版本仍可更新
   */
  checkFailed?: boolean;
  canCheck: boolean;
  canUpdate: boolean;
  canCancel: boolean;
}

export interface BeeLiteApi {
  clientState(): Promise<ClientUpdateState>;
  clientCheck(): Promise<ClientUpdateState>;
  /** expectedBuild：用户看到并确认的新版本构建号；与当前可更新的构建不一致时不会开始更新 */
  clientUpdate(expectedBuild: string): Promise<ClientUpdateState>;
  clientCancel(): Promise<ClientUpdateState>;
  /** 标记某个构建的更新说明已展示（只影响本次启动的提醒，不跳过该版本） */
  clientAckNotice(build: string): Promise<ClientUpdateState>;
  onClientState(cb: (s: ClientUpdateState) => void): () => void;
  watchState(): Promise<AddonWatchSnapshot>;
  onAddonWatch(cb: (s: AddonWatchSnapshot) => void): () => void;
  getConfig(): Promise<AppConfig>;
  search(q: SearchQuery): Promise<SearchResult>;
  detail(modId: string, flavorId: number): Promise<ModDetail>;
  latestFile(modId: string, flavorId: number): Promise<ModFileInfo>;
  listProfiles(): Promise<ProfileInfo[]>;
  bindProfile(flavorId: number): Promise<ProfileInfo | null>;
  // 以下作用于游戏目录的操作：flavorId 为界面当前显示的版本，root 为操作前记录的期望目录（主进程只做比对）
  unbindProfile(flavorId: number, root: string): Promise<ProfileInfo>;
  localState(flavorId: number): Promise<LocalState>;
  /** 手动检查：完成一次有效检查后返回主进程的权威快照（含合并后的结果与 rev）；结果作废时报错 */
  checkUpdates(flavorId: number, root: string): Promise<AddonWatchSnapshot>;
  /** 首次安装：插件已在该目录中托管时不做改动 */
  install(modId: string, flavorId: number, root: string): Promise<OpResult>;
  /** 更新或重装（force）：expected 是界面看到的安装记录，与目录锁内读到的不一致时不做改动 */
  update(modId: string, flavorId: number, force: boolean, expected: ExpectedRecord, root: string): Promise<OpResult>;
  updateAll(flavorId: number, root: string): Promise<OpResult>;
  uninstallProject(modId: string, flavorId: number, root: string): Promise<OpResult>;
  uninstallFolder(folder: string, flavorId: number, root: string): Promise<OpResult>;
  restore(entryId: string, flavorId: number, root: string): Promise<OpResult>;
  purge(entryId: string, flavorId: number, root: string): Promise<OpResult>;
  cancelTask(taskId: string): Promise<void>;
  onTask(cb: (e: TaskEvent) => void): () => void;
  /** 主进程当前的插件写操作状态（只读） */
  activityState(): Promise<ActivitySnapshot>;
  onActivity(cb: (s: ActivitySnapshot) => void): () => void;
}
