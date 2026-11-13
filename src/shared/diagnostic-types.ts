// 诊断报告的结果类型（纯数据，主进程与页面共用）。
// 报告只含固定枚举、数量、合法的公开数字编号与报告内临时别名：不含路径、账号 / 角色、插件名称或版本文本、错误说明、URL。
// 各部分分别读取，不是瞬时快照（consistency 固定为 not-atomic）。
import type { HealthIssueKind, HealthSeverity, HealthStatus, HealthUnavailableReason } from './health-types';
import type { HistoryKind, HistoryStatus } from './types';

/** 某一部分无法完整采集的固定原因 */
export type DiagReason =
  /** 文件或其上级目录不存在 */
  | 'absent'
  | 'symlink'
  /** 不是普通文件（目录、FIFO 等） */
  | 'not-file'
  | 'too-large'
  | 'io'
  | 'invalid-format'
  /** 版本标记不是 1（可能来自更新的版本） */
  | 'unsupported-schema'
  /** 读取期间文件或上级目录发生变化 */
  | 'changed'
  /** 上级目录中有符号链接或非目录 */
  | 'parent-unsafe'
  | 'not-bound'
  /** 设置无法读取，未采集与游戏目录有关的部分 */
  | 'settings-unavailable'
  /** 游戏目录存在未完成的插件操作 */
  | 'pending-operation'
  /** 健康检查超过等待时间，仍在后台进行（没有被取消） */
  | 'still-running'
  /** 另一个游戏目录的健康检查仍在进行，本次没有启动新的检查 */
  | 'busy'
  | 'failed'
  /** 健康检查结果与本次目标不符或在采集期间目标发生变化 */
  | 'mismatch';

export type DiagSectionState = 'ok' | 'absent' | 'partial' | 'unavailable' | 'skipped';

export interface DiagSection {
  state: DiagSectionState;
  reason: DiagReason | null;
}

/** 未列出的条目数：limit 超过数量上限，byteBudget 为满足报告大小上限而省略 */
export interface DiagOmitted {
  limit: number;
  byteBudget: number;
}

export type DiagPlatform = 'darwin' | 'win32' | 'linux' | 'other';

export interface DiagAddon {
  /** 报告内临时别名 p1、p2…，只在本份报告内有意义 */
  alias: string;
  modId: string | null;
  fileId: string | null;
  flavorId: number | null;
  /** 目录的报告内别名 f1、f2…；同一目录（大小写不敏感）在整份报告中别名相同 */
  folders: string[];
  foldersOmitted: number;
}

export interface DiagFailure {
  kind: HistoryKind;
  /** unconfirmed 包括之前运行中断、结果未确认的 accepted 记录 */
  status: 'failed' | 'unconfirmed';
  at: number | null;
  modId: string | null;
}

export interface DiagHealthIssue {
  kind: HealthIssueKind;
  severity: HealthSeverity;
  folder: string | null;
  /** 依赖类提示中被依赖目录的别名 */
  related: string | null;
  declared?: number[];
}

export interface DiagLimits {
  maxReportBytes: number;
  maxAddons: number;
  maxFoldersPerAddon: number;
  maxHealthIssues: number;
  recentFailures: number;
  maxSettingsBytes: number;
  maxManifestBytes: number;
  maxHistoryBytes: number;
  healthWaitMs: number;
  previewTtlMs: number;
}

export interface DiagnosticReport {
  format: 'azercube-diagnostic';
  schema: 1;
  consistency: 'not-atomic';
  app: { version: string; platform: DiagPlatform };
  generatedAt: number | null;
  limits: DiagLimits;
  settings: DiagSection & { boundFlavorIds: number[]; unknownBindings: number };
  target: { flavorId: number | null; state: 'bound' | 'not-bound' | 'not-selected' | 'settings-unavailable' };
  addons: DiagSection & { total: number; recoveryEntries: number; purgeQueued: number; items: DiagAddon[]; omitted: DiagOmitted };
  history: DiagSection & {
    total: number;
    invalidEntries: number;
    byStatus: Record<HistoryStatus, number>;
    unsaved: number | null;
    dropped: number | null;
    storeFailing: boolean | null;
    recentFailures: DiagFailure[];
    omitted: DiagOmitted;
  };
  health: DiagSection & {
    status: HealthStatus | null;
    unavailableReason: HealthUnavailableReason | null;
    manifestState: 'absent' | 'ok' | 'invalid' | null;
    counts: Record<HealthSeverity, number> | null;
    truncated: { entries: boolean; tocBudget: boolean; issues: boolean } | null;
    scanned: { entries: number; folders: number; tocsRead: number; tocBytes: number; interfaceMatched: number } | null;
    invalidIssues: number;
    issues: DiagHealthIssue[];
    omitted: DiagOmitted;
  };
}

export type DiagPreviewCode =
  /** 正在生成另一份预览 */
  | 'busy'
  /** 已有另一个窗口的有效预览，需要显式替换 */
  | 'preview-exists'
  /** 采集期间绑定或设置发生变化，请重新生成 */
  | 'stale'
  /** 发起预览的窗口已关闭 */
  | 'owner-gone'
  | 'invalid-request'
  | 'internal';

export type DiagPreviewResult =
  | { status: 'ready'; token: string; json: string; bytes: number; expiresAt: number; reused: boolean }
  | { status: 'rejected'; code: DiagPreviewCode };

export type DiagTokenCode = 'token-invalid' | 'token-expired' | 'owner-mismatch';

/** 保存被拒绝：没有创建任何文件 */
export type DiagSaveRejectCode =
  | DiagTokenCode
  /** 正在生成预览或保存 */
  | 'busy'
  /** 选择期间窗口已关闭 */
  | 'owner-gone'
  | 'picker-failed'
  /** 选择的不是规范的绝对文件路径 */
  | 'invalid-path'
  /** 无法完整确认受保护的目录（设置或保护列表无法读取），未保存；修复后可重试 */
  | 'protected-roots-unknown'
  /** 位于游戏目录、应用数据、备份位置等受保护目录之内 */
  | 'protected-location'
  /** 所在目录或其上级不存在、是符号链接或不是目录 */
  | 'parent-unsafe'
  /** 所在目录在保存过程中被替换 */
  | 'parent-changed'
  /** 读取保护集合期间绑定或保护配置发生变化，请重试 */
  | 'protection-changed'
  /** 目标已存在（任何类型），不覆盖 */
  | 'exists'
  | 'internal';

/**
 * 已创建新文件之后的失败。parent-changed：所在目录链被替换；protection-changed：保护配置发生变化；
 * content-changed：文件被替换，或读回的内容与本次已写入的部分不一致。这三种情况之后不再写入。
 */
export type DiagSaveFailCode =
  | 'create-failed'
  | 'identity-unknown'
  | 'write-failed'
  | 'sync-failed'
  | 'close-failed'
  | 'parent-sync-failed'
  | 'parent-changed'
  | 'protection-changed'
  | 'content-changed';

/** 失败后本次文件的处理结果；retained-* 表示文件保留在原处，需要用户在访达中检查 */
export type DiagCleanup =
  /** 没有创建文件 */
  | 'not-created'
  | 'removed'
  /** 已删除，但所在目录的同步失败 */
  | 'removed-unsynced'
  /** 文件已不在原处 */
  | 'absent'
  /** 无法确认它仍是本次写入且内容与本次已写入部分完全一致的文件 */
  | 'retained-unconfirmed'
  /** 原位置已是另一个文件 */
  | 'retained-replaced'
  /** 所在目录或其上级已被替换 */
  | 'retained-parent-changed'
  | 'remove-failed';

/** previewKept：调用之后原预览是否仍可保存 */
export type DiagSaveResult =
  | { status: 'saved'; bytes: number; previewKept: boolean }
  | { status: 'cancelled'; previewKept: boolean }
  | { status: 'rejected'; code: DiagSaveRejectCode; previewKept: boolean }
  | { status: 'failed'; code: DiagSaveFailCode; cleanup: DiagCleanup; previewKept: boolean }
  /** 内容已完整写入并同步，但最终逐字节读回或收尾复核未通过（文件、内容或所在目录被改动）：保留，不确认 */
  | { status: 'unconfirmed'; code: 'post-verify-failed'; cleanup: 'retained-unconfirmed'; previewKept: boolean };
