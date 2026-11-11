// 只读插件健康检查的结果类型（纯数据，主进程与页面共用）。
// 结果只是磁盘上的静态线索：不代表游戏内的启用或加载状态，没有提示项也不等于插件完全正常。

/** warning：需要留意；unknown：无法确认，不能当作通过；info：仅供参考 */
export type HealthSeverity = 'warning' | 'unknown' | 'info';

export type HealthIssueKind =
  /** Interface/AddOns 不存在 */
  | 'addons-absent'
  /** 安装记录无法读取，已登记目录的结论无法确认 */
  | 'manifest-invalid'
  /** 安装记录中的目录在完整枚举中未找到 */
  | 'registered-missing'
  /** 安装记录中的目录现在是文件、符号链接或特殊文件 */
  | 'registered-not-dir'
  /** 安装记录中的目录状态无法确认（枚举不完整、同名歧义、无法读取） */
  | 'registered-unconfirmed'
  /** 存在仅大小写或 Unicode 形式不同的同名条目 */
  | 'name-ambiguous'
  | 'entry-symlink'
  | 'entry-unreadable'
  /** 目录在检查期间发生变化，或实际位置不在 AddOns 之下 */
  | 'entry-changed'
  | 'entry-too-many-files'
  /** 没有当前游戏版本对应的顶层 TOC（可能是共享资源目录） */
  | 'toc-none'
  /** 同一个 TOC 名有大小写不同的多个文件 */
  | 'toc-ambiguous'
  | 'toc-not-regular'
  | 'toc-unreadable'
  | 'toc-too-large'
  | 'toc-changed'
  /** 累计 TOC 读取量已到上限，未读取 */
  | 'toc-skipped-budget'
  | 'dep-required-missing'
  | 'dep-optional-missing'
  /** Blizzard_ 前缀的依赖本地未找到，无法通过本地目录确认 */
  | 'dep-system-unconfirmed'
  /** 依赖目录存在但无法确认（链接、不可读、无当前 TOC、未读取、歧义），或索引不完整 */
  | 'dep-unconfirmed'
  /** 依赖声明无法解析：非法名称、条件修饰、数量超限 */
  | 'dep-declaration-invalid'
  | 'interface-mismatch'
  | 'interface-unknown';

export interface HealthIssue {
  kind: HealthIssueKind;
  severity: HealthSeverity;
  /** 相关的一级目录名；与具体目录无关时为 null */
  folder: string | null;
  /** 机器可关联的附加信息（依赖名、TOC 文件名、错误码），有长度上限 */
  detail: string | null;
  /** 可直接展示的纯文本说明，有长度上限；页面必须按文本渲染 */
  message: string;
  /** 仅 interface-mismatch：TOC 声明的 Interface 值 */
  declared?: number[];
}

export type HealthStatus = 'complete' | 'partial' | 'unavailable';

export type HealthUnavailableReason = 'unknown-flavor' | 'layout' | 'pending-operation' | 'addons-unreadable';

export interface HealthLimits {
  maxEntries: number;
  maxFilesPerFolder: number;
  maxTocBytes: number;
  maxTotalTocBytes: number;
  maxIssues: number;
  maxDepsPerField: number;
}

export interface HealthReference {
  /** 调用方传入的参考 Interface 值；没有已加载配置时为 null */
  interfaceNumber: number | null;
  /** 参考值来自插件库已加载的配置，不是本机游戏实测 */
  source: 'addon-library-config';
}

export interface HealthReport {
  root: string;
  flavorId: number;
  checkedAt: number;
  /** complete：检查范围内全部检查过（不代表插件完全正常）；partial：有截断或局部失败；unavailable：本次无法检查 */
  status: HealthStatus;
  unavailableReason: HealthUnavailableReason | null;
  /** 无法检查或部分检查时的说明 */
  message: string | null;
  /** 本次检查范围说明（纯文本） */
  scope: string;
  hasAddons: boolean;
  manifestState: 'absent' | 'ok' | 'invalid';
  reference: HealthReference;
  limits: HealthLimits;
  scanned: { entries: number; folders: number; tocsRead: number; tocBytes: number; interfaceMatched: number };
  truncated: { entries: boolean; tocBudget: boolean; issues: boolean };
  /** 按严重程度的全量计数，不受 issues 截断影响 */
  counts: Record<HealthSeverity, number>;
  issues: HealthIssue[];
}
