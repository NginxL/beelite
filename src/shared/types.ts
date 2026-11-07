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
}

export type TaskPhase = 'queued' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled';

export interface TaskEvent {
  taskId: string;
  label: string;
  phase: TaskPhase;
  received?: number;
  total?: number;
  message?: string;
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

/** 客户端（蜂简自身）更新状态，由主进程维护 */
export interface ClientUpdateState {
  status: ClientUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  /** 下载或解压进度，0–100；未知时为 null */
  percent: number | null;
  message: string | null;
  canCheck: boolean;
  canUpdate: boolean;
  canCancel: boolean;
}

export interface BeeLiteApi {
  clientState(): Promise<ClientUpdateState>;
  clientCheck(): Promise<ClientUpdateState>;
  clientUpdate(): Promise<ClientUpdateState>;
  clientCancel(): Promise<ClientUpdateState>;
  onClientState(cb: (s: ClientUpdateState) => void): () => void;
  getConfig(): Promise<AppConfig>;
  search(q: SearchQuery): Promise<SearchResult>;
  detail(modId: string, flavorId: number): Promise<ModDetail>;
  latestFile(modId: string, flavorId: number): Promise<ModFileInfo>;
  listProfiles(): Promise<ProfileInfo[]>;
  bindProfile(flavorId: number): Promise<ProfileInfo | null>;
  unbindProfile(flavorId: number): Promise<ProfileInfo>;
  localState(flavorId: number): Promise<LocalState>;
  checkUpdates(flavorId: number): Promise<UpdateCheckItem[]>;
  install(modId: string, flavorId: number): Promise<OpResult>;
  update(modId: string, flavorId: number, force: boolean): Promise<OpResult>;
  updateAll(flavorId: number): Promise<OpResult>;
  uninstallProject(modId: string, flavorId: number): Promise<OpResult>;
  uninstallFolder(folder: string, flavorId: number): Promise<OpResult>;
  restore(entryId: string, flavorId: number): Promise<OpResult>;
  purge(entryId: string, flavorId: number): Promise<OpResult>;
  cancelTask(taskId: string): Promise<void>;
  onTask(cb: (e: TaskEvent) => void): () => void;
}
