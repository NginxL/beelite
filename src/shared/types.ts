// 主进程与界面之间传递的数据结构。界面只拿到这些已规范化的对象，不接触路径之外的系统能力。

import type { BackupCatalog, BackupConfigResult, BackupRunResult, BackupScope, BackupState, BackupTaskInfo, BackupVerifyResult } from './backup-types';
import type { HealthReport } from './health-types';
import type { DiagPreviewResult, DiagSaveResult } from './diagnostic-types';
import type { RestoreAck, RestorePendingView, RestorePreview, RestoreResolveAck, RestoreResolveResult, RestoreRunResult } from './restore-types';

/** 本地 WTF 恢复的数据类型 */
export type {
  RestoreAck, RestoreApplyResult, RestoreBaseline, RestoreDiffCounts, RestoreDiffSamples, RestoreOrigin, RestorePendingItem, RestorePendingState, RestorePendingView,
  RestorePreview, RestoreReceiptView, RestoreResolveAck, RestoreResolveResult, RestoreRunResult, RestoreSettledOutcome,
} from './restore-types';
/** 诊断报告的数据类型 */
export type {
  DiagAddon, DiagCleanup, DiagFailure, DiagHealthIssue, DiagLimits, DiagnosticReport, DiagOmitted, DiagPlatform, DiagPreviewCode, DiagPreviewResult, DiagReason,
  DiagSaveFailCode, DiagSaveRejectCode, DiagSaveResult, DiagSection, DiagSectionState, DiagTokenCode,
} from './diagnostic-types';
/** 处理一项未完成恢复的结果（带任务编号） */
export type RestoreResolveRunResult = RestoreResolveResult & { taskId: string };

/** 只读插件健康检查的结果类型 */
export type { HealthIssue, HealthIssueKind, HealthReport, HealthSeverity, HealthStatus, HealthUnavailableReason } from './health-types';
/** 可选本地 WTF 配置备份的数据类型 */
export type {
  BackupAnomaly, BackupAnomalyKind, BackupCatalog, BackupConfigResult, BackupLimits, BackupPhase, BackupRunResult, BackupScope, BackupSnapshotInfo, BackupSnapshotStatus, BackupState,
  BackupStatus, BackupTaskInfo, BackupTaskKind, BackupUsage, BackupVerifyRecord, BackupVerifyResult,
} from './backup-types';

/**
 * 备份 / 校验任务的纯内存快照（不扫描备份位置）：rev 单调递增，界面据此丢弃过时的推送或查询结果；
 * task 为全局活动任务，可能属于其他游戏版本或目录
 */
export interface BackupTaskSnapshot {
  rev: number;
  task: BackupTaskInfo | null;
}

/**
 * 备份 / 校验的结构化结果：只有任务确实以取消结束才是 cancelled（message 为完整说明，可能含收尾时保留现场的提示）；
 * 已完成的结果即使之后收到取消请求也是 completed。其他失败照常以错误返回
 */
export type BackupOutcome<T> = { status: 'completed'; result: T } | { status: 'cancelled'; message: string };

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

/**
 * 已提交操作之后的清理（回收站中登记永久删除的条目、下载暂存）尚未完成；不影响插件列表与写操作，
 * 每次刷新本地状态或写入这个目录时自动重试
 */
export interface CleanupState {
  /**
   * 本次是否实际执行了清理。false：目录暂停写入等原因没有执行，pending 只是清单中登记的待删除数，磁盘上是否还有内容尚未确认
   */
  checked: boolean;
  /**
   * 已申请永久删除（已从回收站注销、不能再恢复）但尚未清理完成的条目数：checked 时是本次删除失败的条目（可能已删除一部分），
   * 否则是清单中登记的待删除数
   */
  pending: number;
  /** 已从磁盘删除、但待删除记录还没能保存的条目数（下次清理时确认移除） */
  unsaved: number;
  /** 最近一次清理遇到的问题（条数有上限） */
  problems: string[];
}

export interface LocalState {
  flavorId: number;
  profile: ProfileInfo;
  dir: DirState | null;
  managed: ManagedProjectView[];
  unmanaged: LocalFolder[];
  recovery: RecoveryEntryView[];
  /** 没有待清理内容（或目录尚无艾泽魔方数据）时为 null */
  cleanup: CleanupState | null;
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
  /**
   * 该插件在这个目录已暂停更新（快照生成时按当前策略标注）。hasUpdate / latest* 仍是真实的检查结果，
   * 是否可以更新以 actionableUpdate 判断
   */
  paused?: boolean;
}

export type AddonWatchStatus = 'pending' | 'checking' | 'ok' | 'partial' | 'error';

/** 一个已绑定游戏目录的插件更新检查状态（主进程内存中，按 游戏版本 + 目录 区分） */
export interface AddonWatchEntry {
  flavorId: number;
  root: string;
  status: AddonWatchStatus;
  items: UpdateCheckItem[];
  /** 可以更新的插件数（有新版本、未暂停，且更新策略可读取） */
  pending: number;
  /** 这个目录（游戏版本 + 目录）已暂停更新的插件编号，包括当前未安装的 */
  paused: string[];
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
  /** 更新策略（暂停列表）无法读取的原因：此时所有插件更新都被拒绝，不能显示为已是最新 */
  policyError: string | null;
  /**
   * 主进程最近一次读取到的全部暂停项（按 游戏版本 + 目录 + 插件；有数量上限）。界面按当前目标判断，
   * 不依赖该目录是否已有检查条目（例如在别处换绑之后、检查协调器尚未同步目录列表时）
   */
  pausedAll: { flavorId: number; root: string; modId: string }[];
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
  /** policy：暂停或恢复更新（与同一插件的其他写操作互斥，全部更新期间不受理） */
  kind: 'install' | 'update' | 'uninstall' | 'policy';
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
  /** 操作本身的结果不受影响，但操作记录目前有未保存的内容（单独提示，不混入 warnings） */
  historyError?: string;
}

// ---------- 操作记录 ----------

export type HistoryKind = 'install' | 'update' | 'reinstall' | 'uninstall' | 'uninstall-folder' | 'restore' | 'purge' | 'pause' | 'resume';

/**
 * accepted：已受理、尚未结束（之前某次运行留下的 accepted 读取时显示为 unconfirmed）；
 * succeeded：确认已提交；unchanged：没有改动（例如已是最新）；cancelled：用户取消；
 * not-processed：前提已变化或批次停止，没有处理；failed：失败；unconfirmed：结果未确认（运行中断或目录保护）
 */
export type HistoryStatus = 'accepted' | 'succeeded' | 'unchanged' | 'cancelled' | 'not-processed' | 'failed' | 'unconfirmed';

export interface HistoryVersion {
  fileId: string;
  version: string;
}

export interface HistoryEntry {
  id: string;
  flavorId: number;
  root: string;
  kind: HistoryKind;
  status: HistoryStatus;
  modId: string | null;
  /** 未托管目录名或回收站条目编号 */
  target: string | null;
  name: string;
  batchId: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 受理时界面看到的文件编号（只是请求，不代表实际旧版本） */
  expectedFileId: string | null;
  /** 目录锁内读到的旧版本（来自提交回执） */
  previous: HistoryVersion | null;
  /** 本次提交的新版本（来自提交回执） */
  installed: HistoryVersion | null;
  message: string;
  warnings: string[];
  /** 名称、说明或提示超过上限，已截断 */
  truncated: boolean;
  /** 这条记录（或它的最新状态）尚未写入磁盘 */
  unsaved?: boolean;
}

export interface HistoryStatusView {
  /** 单调递增（同一次运行内） */
  rev: number;
  /** 记录文件无法读取（损坏、过大、符号链接等）；不会被覆盖 */
  loadError: string | null;
  /** 最近一次保存失败的原因 */
  saveError: string | null;
  /** 尚未写入磁盘的记录数 */
  unsaved: number;
  /** 因未保存的记录过多而丢弃的条数 */
  dropped: number;
  file: string;
}

export interface HistoryView {
  flavorId: number;
  root: string;
  /** 新的在前 */
  entries: HistoryEntry[];
  status: HistoryStatusView;
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

/** 客户端（艾泽魔方自身）更新状态，由主进程维护 */
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
  /** 暂停（true）或恢复（false）某个插件在该目录的更新 */
  setPaused(modId: string, flavorId: number, paused: boolean, root: string): Promise<OpResult>;
  /** 重新读取更新策略，返回更新检查快照（含暂停列表与策略错误） */
  reloadPolicy(): Promise<AddonWatchSnapshot>;
  historyList(flavorId: number, root: string): Promise<HistoryView>;
  /** 重新读取并保存尚未写入的操作记录 */
  historyRetry(): Promise<HistoryStatusView>;
  historyStatus(): Promise<HistoryStatusView>;
  onHistoryStatus(cb: (s: HistoryStatusView) => void): () => void;
  /**
   * 只读健康检查：root 为界面记录的期望目录（只做比对）。只在用户点击时调用；不恢复事务、不清理、不联网，
   * 适配参考值取自主进程已加载的插件库配置
   */
  healthCheck(flavorId: number, root: string): Promise<HealthReport>;
  // WTF 配置备份：root 为界面记录的期望目录（只做比对）；保存位置只由主进程弹出的选择框决定，界面不传任何路径
  /** 当前备份 / 校验任务的内存快照（不读取 WTF，也不扫描备份位置） */
  backupTaskState(): Promise<BackupTaskSnapshot>;
  onBackupTask(cb: (s: BackupTaskSnapshot) => void): () => void;
  /** 只读：未启用时只读备份设置；已启用时扫描已登记的备份位置，不读取 WTF */
  backupState(flavorId: number, root: string): Promise<BackupState>;
  /**
   * 主进程弹出文件夹选择框并在其中新建备份位置后启用；用户取消选择时返回 null，不做任何改动。
   * 返回即表示设置已保存；保存前的失败一律报错
   */
  backupConfigure(flavorId: number, root: string): Promise<BackupConfigResult | null>;
  /** 关闭该目录的备份：只改设置，不删除已有备份；返回即表示设置已保存（或本来就未启用） */
  backupDisable(flavorId: number, root: string): Promise<BackupConfigResult>;
  /**
   * 只读：列出当前目录 WTF/Account 下的账号、服务器与角色（只看目录名称与元数据，不读取文件内容）。
   * 只在已启用且用户点击“读取账号与角色”时调用；结果只在内存中，不能当作备份授权
   */
  backupCatalog(flavorId: number, root: string): Promise<BackupCatalog>;
  /**
   * 手动备份：scope 必须显式给出（缺失即拒绝，不会默认改成全部 WTF），主进程重新校验并在受理时固定；
   * 结束时句柄、临时内容与占用标记都已收尾；取消以 cancelled 返回，其他失败报错
   */
  backupRun(flavorId: number, root: string, scope: BackupScope): Promise<BackupOutcome<BackupRunResult>>;
  /** 按清单完整校验一份备份的内容；内容不一致为 completed 且 ok:false */
  backupVerify(flavorId: number, root: string, snapshotId: string): Promise<BackupOutcome<BackupVerifyResult>>;
  /** 取消任务：taskId、flavorId 与 root 均为任务受理时的原值（不要求与当前绑定相同）；不匹配时返回 false */
  backupCancel(taskId: string, flavorId: number, root: string): Promise<boolean>;
  /** 在访达中显示已登记的备份位置（snapshotId 为 null）或其中一份备份 */
  backupReveal(flavorId: number, root: string, snapshotId: string | null): Promise<void>;
  // WTF 恢复：界面只传游戏版本、期望目录（只做比对）、备份编号、凭证、恢复编号与固定的确认；范围与路径全部由主进程决定
  /**
   * 预览恢复（只读，读取并核对源备份与当前完整 WTF）：result.token 为 null 时不能执行，原因见 result.blockers。
   * 准备期间可用 backupCancel 取消（任务见 onBackupTask），以 cancelled 返回；其他失败（目录正在修改绑定、有未完成的恢复、
   * 备份不可用、绑定已变更等）报错，说明文字即原因
   */
  backupRestorePreview(flavorId: number, root: string, snapshotId: string): Promise<BackupOutcome<RestorePreview>>;
  /**
   * 执行恢复：token 一次有效（报错后也需要重新预览）；ack 必须是 { gameClosed: true, overwrite: true }。
   * 进入替换前可用 backupCancel 取消（cancelled，WTF 未改动）；之后不可取消，result.outcome 给出 committed / rolled-back / unconfirmed / blocked
   */
  backupRestoreApply(token: string, ack: RestoreAck): Promise<BackupOutcome<RestoreRunResult>>;
  /**
   * 全局只读查看未完成的恢复（不要求当前绑定或备份已启用，不处理、不清理）。registryError 非空时 items 为空不代表没有；
   * scanErrors / boundRootsError 表示检查范围不完整
   */
  backupRestorePending(): Promise<RestorePendingView>;
  /**
   * 处理一项登记的未完成恢复：只传恢复编号与新的 { gameClosed: true }；目录取自登记（原目录已解绑或换绑时也处理原目录）。
   * 处理期间不可取消（为与其他恢复接口一致仍以 BackupOutcome 返回）
   */
  backupRestoreResolve(txid: string, ack: RestoreResolveAck): Promise<BackupOutcome<RestoreResolveRunResult>>;
  // 诊断报告：只读应用元数据、插件清单、操作记录与健康检查，不读取 WTF、不联网；窗口身份由主进程确定
  /**
   * 生成（replace）或重新打开本窗口已有的（reuse）预览；flavorId 为 null 时只生成应用摘要。
   * ready 返回冻结的 JSON 与凭证；rejected 只带固定原因码，原有预览保持不变
   */
  diagnosticPreview(req: { flavorId: number | null; mode: 'reuse' | 'replace' }): Promise<DiagPreviewResult>;
  /** 主进程弹出系统保存框，把凭证对应的冻结 JSON 原样保存为新文件（不覆盖已有文件）；取消与失败均不清除预览（见 previewKept） */
  diagnosticSave(token: string): Promise<DiagSaveResult>;
}
