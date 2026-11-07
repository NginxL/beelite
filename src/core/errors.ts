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
