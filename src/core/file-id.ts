// 文件编号（NewBeeBox 的 t_id）的统一约定：远端解析、本地清单与 IPC 共用，避免规则各自漂移。
// 本地清单与 IPC 只接受 1–15 位十进制数字（与 0.1.6 及更早版本写入的清单兼容，含前导零等历史值）；
// 远端值必须能规范为同样范围内的正安全整数，否则在下载与事务开始之前拒绝。

/** 清单与 IPC 中文件编号的格式 */
export const FILE_ID_RE = /^\d{1,15}$/;

/** 15 位十进制数字的最大值，小于 Number.MAX_SAFE_INTEGER */
export const MAX_FILE_ID = 999_999_999_999_999;

/**
 * 把远端返回的文件编号规范为十进制字符串：数字必须是正安全整数；字符串必须是纯十进制数字（不接受空白、小数、
 * 科学计数法或十六进制），按数值规范（"007" → "7"）。超出 1–MAX_FILE_ID 或无法规范时返回 null。
 */
export function canonicalFileId(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_FILE_ID) return null;
  return String(n);
}
