// 写操作闸门：客户端更新安装或应用退出前，冻结新的写操作并等待已受理的写操作全部结束。
// - enter() 同步计数；冻结时同步抛出 UserError，不会进入操作。
// - 冻结用令牌计数：更新与退出各自持有令牌，只有全部令牌释放后才解冻。
// - drained() 只在进行中的写操作归零时 resolve；不设超时、不会 reject，单个操作失败也要等它的 finally 收尾。
import { UserError } from './errors';

export type FreezeToken = symbol;

export class MutationGate {
  private active = 0;
  private readonly freezes = new Set<FreezeToken>();
  private waiters: (() => void)[] = [];

  get activeCount(): number {
    return this.active;
  }

  get frozen(): boolean {
    return this.freezes.size > 0;
  }

  /** 受理一个写操作；返回只生效一次的释放函数 */
  enter(): () => void {
    if (this.frozen) throw new UserError('客户端正在更新或退出，暂时不能执行此操作，请稍后再试', 'frozen');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active === 0) this.flush();
    };
  }

  /** 冻结新的写操作；返回用于解冻的令牌 */
  freeze(): FreezeToken {
    const token: FreezeToken = Symbol('freeze');
    this.freezes.add(token);
    return token;
  }

  unfreeze(token: FreezeToken): void {
    this.freezes.delete(token);
  }

  /** 等待已受理的写操作全部结束 */
  drained(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 同步冻结，然后等待排空 */
  freezeAndDrain(): { token: FreezeToken; drained: Promise<void> } {
    const token = this.freeze();
    return { token, drained: this.drained() };
  }

  private flush(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/**
 * 会写入游戏目录、设置、更新策略、操作记录或 WTF 备份位置的 IPC 通道；整个回调在闸门内执行（退出与客户端更新等待它们收尾）。
 * 备份的重新校验也会写占用标记，因此同样计入；取消备份不入闸。
 * WTF 恢复的预览 / 执行 / 处理与诊断报告的生成 / 保存（含系统保存框、写入与失败收尾）同样计入；只读查看未完成的恢复不入闸。
 * 注意：闸门只用于退出与客户端更新的等待，不是互斥；绑定与恢复的互斥由恢复服务的绑定占位负责
 */
export const MUTATING_CHANNELS: ReadonlySet<string> = new Set([
  'backup:configure',
  'backup:disable',
  'backup:run',
  'backup:verify',
  'restore:preview',
  'restore:apply',
  'restore:resolve',
  'diagnostic:preview',
  'diagnostic:save',
  'policy:set',
  'history:retry',
  'profile:bind',
  'profile:unbind',
  'local:state',
  'addon:install',
  'addon:update',
  'addon:updateAll',
  'addon:uninstall',
  'addon:uninstallFolder',
  'trash:restore',
  'trash:purge',
]);

/**
 * 包装 IPC 回调：写通道在调用 fn 之前同步 enter，整个 fn（含远端请求、系统对话框、批次间隙）结束后才释放。
 * 只读通道原样执行。
 */
export function guardHandler<A extends unknown[], R>(gate: MutationGate, channel: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  if (!MUTATING_CHANNELS.has(channel)) return fn;
  return async (...args: A) => {
    const release = gate.enter();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}

export interface QuitEvent {
  preventDefault(): void;
}

/**
 * 退出保护：有写操作时阻止退出，冻结并等待排空后再调用 quit()。覆盖用户手动退出与更新框架发起的退出。
 * 重复触发时共享同一次等待，只调用一次 quit()。
 */
export function createQuitGuard(gate: MutationGate, quit: () => void): (e: QuitEvent) => void {
  let allowed = false;
  let pending: Promise<void> | null = null;
  return (e) => {
    if (allowed) return;
    if (gate.activeCount === 0 && !pending) {
      gate.freeze();
      allowed = true;
      return;
    }
    e.preventDefault();
    if (pending) return;
    pending = gate.freezeAndDrain().drained.then(() => {
      allowed = true;
      quit();
    });
  };
}
