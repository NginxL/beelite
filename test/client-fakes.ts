// 客户端更新测试共用：给原生事件打上会话标记、假时钟。
// 真实原生桥在回调发生时为每个事件带上当时所属会话的编号与意图；假原生桥记录最近一次被接受的会话，send 用它打标记。
import type { BridgeEvent, BridgeEventBody, BridgeIntent, ClientUpdater, UpdateTimers } from '../src/core/client-update';

/** 假原生桥需要提供的会话信息 */
export interface SessionSource {
  session: number;
  intent: BridgeIntent;
}

const sources = new WeakMap<ClientUpdater, SessionSource>();

/** 关联更新器与它的假原生桥 */
export function bindBridge(u: ClientUpdater, bridge: SessionSource): ClientUpdater {
  sources.set(u, bridge);
  return u;
}

/** 以原生当前会话的身份派发事件 */
export function send(u: ClientUpdater, ev: BridgeEventBody): void {
  const src = sources.get(u);
  if (!src) throw new Error('send 前需要 bindBridge');
  u.handle({ ...ev, session: src.session, intent: src.intent } as BridgeEvent);
}

/** 以指定会话的身份派发事件（模拟旧会话或其他意图的残余事件） */
export function sendAs(u: ClientUpdater, session: number, intent: BridgeIntent, ev: BridgeEventBody): void {
  u.handle({ ...ev, session, intent } as BridgeEvent);
}

/** 假时钟：advance 按到期顺序执行计时器 */
export class FakeClock implements UpdateTimers {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  /** 取出当前待执行的回调（模拟“已排队、随后被清除但仍会执行一次”的旧回调，之后可手动重放） */
  callbacks(): Array<() => void> {
    return [...this.timers.values()].map((t) => t.fn);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}
