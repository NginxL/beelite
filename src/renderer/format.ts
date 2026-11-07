// 数字、日期、大小与错误消息的格式化工具

/** 下载量等数字：过万显示“万”，过亿显示“亿” */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e8) return trimZero((n / 1e8).toFixed(1)) + '亿';
  if (n >= 1e4) return trimZero((n / 1e4).toFixed(1)) + '万';
  return String(Math.round(n));
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 兼容秒与毫秒时间戳 */
function toDate(ts: number): Date | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts < 1e12 ? ts * 1000 : ts);
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(ts: number): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(ts: number): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 去掉 Electron IPC 附加的前缀，只保留主进程给出的中文消息 */
export function errMsg(err: unknown): string {
  let msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, '');
  msg = msg.replace(/^(?:[A-Za-z]*Error):\s*/, '');
  return msg.trim() || '操作失败（未知错误）';
}

/** 去掉 TOC 文本中的魔兽颜色码 |cAARRGGBB ... |r */
export function cleanTocText(s: string): string {
  return s.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '').trim();
}
