/** 可以直接展示给用户的错误，message 为中文说明 */
export class UserError extends Error {
  constructor(message: string, readonly code: string = 'user') {
    super(message);
    this.name = 'UserError';
  }
}

/** 测试用：模拟进程在某一步骤突然退出，事务代码遇到它时不执行回滚 */
export class SimulatedCrash extends Error {
  constructor(step: string) {
    super(`simulated crash at ${step}`);
    this.name = 'SimulatedCrash';
  }
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
]);
/** 沿 cause 链查找底层网络错误的最大深度 */
const MAX_CAUSE_DEPTH = 5;

/**
 * 是否为临时错误：网络不可达、连接中断、超时、服务器繁忙（HTTP 408/429/5xx）。
 * 服务端明确拒绝、数据不合法、文件不兼容、本地目录问题都不是临时错误。只用于决定自动检查的重试间隔。
 * Node fetch 把底层网络错误放在 cause 中（例如响应体读取中断：TypeError('terminated')，cause.code = UND_ERR_SOCKET），
 * 这里有限深度地检查 cause 链中的已知网络错误码；不会把所有 TypeError 都视为临时错误。
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof UserError) return err.code === 'http-transient';
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && cur instanceof Error && !seen.has(cur); depth++) {
    seen.add(cur);
    if (cur.name === 'AbortError' || cur.name === 'TimeoutError') return true;
    const code = (cur as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    // undici 的连接失败：TypeError('fetch failed')
    if (depth === 0 && cur.name === 'TypeError' && cur.message === 'fetch failed') return true;
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof UserError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return '操作已取消或超时';
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return '没有写入权限：' + err.message;
    if (code === 'ENOSPC') return '磁盘空间不足';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return '网络连接失败，请检查网络';
    if (err.message === 'fetch failed') return '网络连接失败，请检查网络';
    return err.message;
  }
  return String(err);
}
