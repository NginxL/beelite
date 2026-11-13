// 本地 WTF 恢复的数据类型（纯数据，主进程与页面共用）。
// 恢复按快照记录的原范围把当前绑定目录的 WTF 镜像为快照内容：范围内与快照一致（多出的内容会被删除），范围外的路径与文件字节保持不变；
// 不保证 inode、修改时间、权限与扩展属性原样（恢复后的文件为 0600、目录为 0700）。
import type { BackupScope } from './backup-types';
// 注意：以下类型只是数据形状；预览、执行与处理的全部安全检查都在主进程完成，界面不提交任何路径或范围

/** 合并后候选 WTF 中每一项的来源：snapshot 取自要恢复的快照；baseline 取自恢复前的当前 WTF（实际复制时取自已校验的恢复前完整备份） */
export type RestoreOrigin = 'snapshot' | 'baseline';

/** 恢复范围内的差异计数（范围外的内容不计入，只在 kept 中统计保留的数量） */
export interface RestoreDiffCounts {
  /** 快照中有、当前范围内没有的文件 */
  addFiles: number;
  /** 两边都有、大小或内容不同的文件（包括只差大小写或 Unicode 形式的同一路径） */
  overwriteFiles: number;
  /** 两边都有、大小与内容相同的文件（仍会按快照重新写入） */
  sameFiles: number;
  /** 当前范围内有、快照中没有（或类型不同）的文件：恢复后删除 */
  deleteFiles: number;
  /** 快照中有、当前没有的目录（含需要新建的途经目录） */
  addDirs: number;
  /** 当前范围内有、快照中没有（或类型不同）的目录：连同其中内容一起删除 */
  deleteDirs: number;
  /** 新增与覆盖的文件字节 */
  writeBytes: number;
  /** 删除的文件字节 */
  deleteBytes: number;
}

/** 每类最多若干条相对 WTF 的路径示例（按路径排序）；truncated 表示还有未列出的条目 */
export interface RestoreDiffSamples {
  add: string[];
  overwrite: string[];
  delete: string[];
  truncated: boolean;
}

/** 恢复前当前 WTF 的状态：present 存在（恢复前会完整备份）；absent 不存在（不会生成恢复前备份） */
export type RestoreBaseline = 'present' | 'absent';

/** 用户在产品内对执行恢复的确认：两项都必须为 true */
export interface RestoreAck {
  gameClosed: true;
  overwrite: true;
}

/** 处理未完成恢复时的确认：上次的确认在重启后失效，需要重新确认游戏已退出 */
export interface RestoreResolveAck {
  gameClosed: true;
}

/**
 * 恢复预览（主进程生成的冻结副本）。token 为 null 时不能执行（原因见 blockers）；
 * token 一次有效、有时限，执行时主进程重新核对目标、绑定、备份与当前 WTF，任何变化都要求重新预览
 */
export interface RestorePreview {
  token: string | null;
  expiresAt: number | null;
  flavorId: number;
  root: string;
  snapshotId: string;
  snapshotCreatedAt: number;
  snapshotAppVersion: string;
  /** 备份记录的原范围（恢复只按它进行） */
  scope: BackupScope;
  baseline: RestoreBaseline;
  counts: RestoreDiffCounts;
  samples: RestoreDiffSamples;
  /** 恢复后保持不变的范围外内容 */
  kept: { files: number; dirs: number; bytes: number };
  /** 恢复后的完整 WTF */
  candidate: { files: number; dirs: number; bytes: number };
  /** 当前完整 WTF（没有 WTF 时为 null） */
  current: { files: number; dirs: number; bytes: number } | null;
  /** 执行时会先生成当前完整 WTF 的备份（计入备份位置的份数与容量上限）；当前没有 WTF 时不生成 */
  safetyCopy: { required: boolean; bytes: number; entries: number };
  /** 需要的额外空间与读取到的可用空间（字节；无法读取时为 null）；同一磁盘卷时两者合计 */
  space: { backupVolumeNeeded: number; backupVolumeFree: number | null; gameVolumeNeeded: number; gameVolumeFree: number | null; sameVolume: boolean };
  /** 连带影响说明（例如按角色恢复会恢复账号共享的 SavedVariables） */
  notes: string[];
  /** 不能执行的原因（份数 / 容量已满、空间不足等）；非空时 token 为 null */
  blockers: string[];
}

/** 未完成恢复的状态；unregistered：工作目录中有没有登记的内容（只显示，不能处理） */
export type RestorePendingState = 'preparing' | 'prepared' | 'committed' | 'blocked' | 'cleanup-pending' | 'unregistered';
/** 已确定的结果（只剩收尾） */
export type RestoreSettledOutcome = 'committed' | 'rolled-back' | 'not-applied';

export interface RestorePendingItem {
  /** 未登记的工作目录无法确认编号时为 null */
  txid: string | null;
  flavorId: number | null;
  root: string;
  /** 登记的备份位置（恢复前备份与其临时目录 .partial-<safetySnapshotId> 所在之处）；未登记的条目为 null */
  containerPath: string | null;
  state: RestorePendingState;
  outcome: RestoreSettledOutcome | null;
  /** 待处理的原因，含需要用户在访达中处理的精确路径（例如保留的临时目录） */
  reason: string | null;
  createdAt: number | null;
  sourceSnapshotId: string | null;
  safetySnapshotId: string | null;
  scope: BackupScope | null;
}

export interface RestoreReceiptView {
  txid: string;
  flavorId: number;
  root: string;
  outcome: 'committed' | 'rolled-back' | 'not-applied' | 'cleared';
  at: number;
  sourceSnapshotId: string;
  safetySnapshotId: string | null;
}

export interface RestorePendingView {
  /** 恢复登记无法读取：此时禁止所有恢复，items 为空不代表没有未完成的恢复 */
  registryError: string | null;
  items: RestorePendingItem[];
  receipts: RestoreReceiptView[];
  /** 未能检查工作目录的游戏目录：其中是否有未登记的恢复内容未知 */
  scanErrors: Array<{ root: string; reason: string }>;
  /** 已绑定目录列表无法读取（设置文件损坏等）：未登记内容的检查范围不完整 */
  boundRootsError?: string | null;
}

/**
 * committed：已恢复（cleanupPending 表示工作目录、原件或占用未能清理，之后在“处理未完成恢复”中继续）；
 * rolled-back：替换中出错，已按完整内容核对回滚到恢复前；unconfirmed：已替换但提交记录未能确认写入磁盘；
 * blocked：无法确认状态或发现外部改动，保留现场
 */
export interface RestoreApplyResult {
  txid: string;
  outcome: 'committed' | 'rolled-back' | 'unconfirmed' | 'blocked';
  safetySnapshotId: string | null;
  cleanupPending: boolean;
  message: string;
  warnings: string[];
}

/** 服务层的执行结果：带上任务编号 */
export interface RestoreRunResult extends RestoreApplyResult {
  taskId: string;
}

/** finalized：已完成提交后的收尾；rolled-back：已回滚到恢复前；cleared：WTF 未被改动，已清理本次内容；blocked / cleanup-pending 见 message */
export interface RestoreResolveResult {
  txid: string;
  outcome: 'finalized' | 'rolled-back' | 'cleared' | 'blocked' | 'cleanup-pending';
  message: string;
  warnings: string[];
}
