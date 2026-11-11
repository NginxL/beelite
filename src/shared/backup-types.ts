// 可选本地 WTF 配置备份的数据类型（纯数据，主进程与页面共用）。
// 备份是磁盘上的配置副本：不是瞬时事务性快照，不检测游戏是否运行，也不提供应用内恢复。

/** 备份与重新校验的资源上限；默认值见 core/wtf-backup.ts 的 DEFAULT_BACKUP_LIMITS */
export interface BackupLimits {
  /** 每个备份位置最多保留的备份份数（含未完成与异常项） */
  maxSnapshots: number;
  /** 每个备份位置的总占用字节 */
  maxTotalBytes: number;
  /** 单份备份的 WTF 字节 */
  maxSnapshotBytes: number;
  /** 单个文件字节 */
  maxFileBytes: number;
  /** 单份备份的文件与目录总数 */
  maxEntries: number;
  /** 相对 WTF 的最大路径层数 */
  maxDepth: number;
  /** manifest.json 字节 */
  maxManifestBytes: number;
}

export type BackupTaskKind = 'run' | 'verify';

export type BackupPhase = 'preparing' | 'copying' | 'rechecking' | 'publishing' | 'verifying' | 'cleanup';

/** 主进程中唯一的备份 / 校验任务；界面重新载入后据此恢复进度与取消按钮 */
export interface BackupTaskInfo {
  id: string;
  kind: BackupTaskKind;
  flavorId: number;
  /** 任务受理时固定的游戏目录；换绑后任务仍只读这个目录 */
  root: string;
  /** 校验任务的快照编号；备份任务为 null */
  snapshotId: string | null;
  phase: BackupPhase;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  cancelling: boolean;
  startedAt: number;
}

/**
 * structure-ok：清单可读，文件与目录集合及大小与清单一致（只检查结构，未计算内容校验值）；
 * mismatch：与清单不一致（可能在访达中被改动）；invalid：清单缺失或无法解析
 */
export type BackupSnapshotStatus = 'structure-ok' | 'mismatch' | 'invalid';

export interface BackupVerifyRecord {
  at: number;
  ok: boolean;
  reason: string | null;
}

export interface BackupSnapshotInfo {
  id: string;
  /** 以下字段来自清单；清单无法解析时为 0 / 空 */
  createdAt: number;
  appVersion: string;
  flavorId: number;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  /** 本次扫描到的实际占用（含清单与额外文件） */
  actualBytes: number;
  status: BackupSnapshotStatus;
  reason: string | null;
  /** 本次运行期间最近一次重新校验的结果；只存内存，不代表之后备份未被改动 */
  lastVerify: BackupVerifyRecord | null;
}

/**
 * incomplete：未完成的 .partial 目录（中断遗留）；foreign：不认识的条目；lock：占用标记存在；
 * unreadable：无法读取或不是预期类型；scan-limit：超出扫描上限，未继续检查
 */
export type BackupAnomalyKind = 'incomplete' | 'foreign' | 'lock' | 'unreadable' | 'scan-limit';

export interface BackupAnomaly {
  /** 备份位置下的直接条目名 */
  name: string;
  kind: BackupAnomalyKind;
  message: string;
}

export interface BackupUsage {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  /** false：扫描不完整或有无法读取的条目，count / bytes 只是下限 */
  confirmed: boolean;
}

/**
 * disabled：当前游戏目录未启用（不读取 WTF 与备份位置）；ready：已启用且备份位置可用；
 * unavailable：设置无法读取、备份位置缺失（例如外置盘未连接）或标记不符
 */
export type BackupStatus = 'disabled' | 'ready' | 'unavailable';

export interface BackupState {
  flavorId: number;
  root: string;
  status: BackupStatus;
  /** 已登记的备份位置；disabled 时仅供显示，未访问 */
  containerPath: string | null;
  snapshots: BackupSnapshotInfo[];
  anomalies: BackupAnomaly[];
  usage: BackupUsage | null;
  /** 存在异常或无法确认占用时为 false，此时不能新建备份 */
  canCreate: boolean;
  error: string | null;
  limits: BackupLimits;
  /** 全局活动任务，可能属于其他游戏版本或目录 */
  activeTask: BackupTaskInfo | null;
}

export interface BackupRunResult {
  taskId: string;
  snapshot: BackupSnapshotInfo;
  /** 备份已发布但收尾有异常（例如占用标记无法确认属于本次任务而被保留） */
  warnings: string[];
}

export interface BackupVerifyResult {
  taskId: string;
  snapshotId: string;
  ok: boolean;
  /** 不一致时的第一处原因 */
  reason: string | null;
  checkedFiles: number;
  checkedBytes: number;
  warnings: string[];
}
