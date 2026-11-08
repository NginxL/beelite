// 插件写操作的占用与进度（主进程权威状态，不依赖 Electron）。
// - 占用按游戏目录（root）判断：同一目录同时最多一个全部更新；同一目录的同一插件同时最多一个写操作（安装、更新、重装、卸载）。
//   全部更新与单项写操作双向互斥：批次进行中拒绝该目录的更新、重装与卸载；有单项写操作时拒绝开始批次。
//   批次计划确定之后，允许安装计划外、尚未托管的新插件（首次安装在目录锁内另有“必须尚未安装”的条件）。
// - 调用方在解析出目标目录之后、下一个 await 之前同步调用 reserve*（检查与登记之间没有 await），
//   并在自己的 finally 中释放自己拿到的占用；释放只作用于这一次占用，不会误释放之后的批次或操作。
// - 不是目录锁：真正的写入仍由 AddonManager 的目录锁串行化；这里只拒绝会互相冲突的新请求，并为界面提供可恢复的状态。
// - 每次变化 rev 加一。结构变化（占用、任务增删、阶段变化）推送快照；下载字节数只更新状态并加 rev，不推送，
//   由任务事件带上同一个 rev，界面按 rev 取较新的一方。
import { randomUUID } from 'node:crypto';
import type { ActivePhase, ActivityBatch, ActivityReservation, ActivitySnapshot, ActivityTask } from '../shared/types';
import { UserError } from './errors';

const batchBusy = (): UserError => new UserError('这个游戏目录正在全部更新，完成后再操作', 'busy');
const projectBusy = (): UserError => new UserError('这个插件正在处理中，完成后再操作', 'busy');
const rootBusy = (): UserError => new UserError('这个游戏目录有插件正在处理，完成后再全部更新', 'busy');

interface BatchEntry extends ActivityBatch {
  /** 计划中的插件（计划确定后才有） */
  planned: Set<string>;
}

/** 一次全部更新的占用；release 只释放这一个批次 */
export interface BatchHandle {
  readonly batchId: string;
  release(): void;
}

export class ActivityRegistry {
  readonly instance = randomUUID();
  private rev = 0;
  private readonly batches = new Map<string, BatchEntry>();
  private readonly tasks = new Map<string, ActivityTask>();
  private readonly reservations = new Set<ActivityReservation>();

  constructor(private readonly onChange: (s: ActivitySnapshot) => void = () => undefined) {}

  snapshot(): ActivitySnapshot {
    return {
      instance: this.instance,
      rev: this.rev,
      batches: [...this.batches.values()].map(({ batchId, flavorId, root, stage }) => ({ batchId, flavorId, root, stage })),
      tasks: [...this.tasks.values()].map((t) => ({ ...t })),
      reservations: [...this.reservations].map((r) => ({ ...r })),
    };
  }

  /** 发布当前状态（rev 已在变化时递增） */
  publish(): void {
    this.onChange(this.snapshot());
  }

  /** 开始全部更新：该目录已有批次或任何单项写操作时拒绝 */
  reserveBatch(flavorId: number, root: string): BatchHandle {
    if (this.batches.has(root)) throw batchBusy();
    for (const r of this.reservations) if (r.root === root) throw rootBusy();
    const entry: BatchEntry = { batchId: randomUUID(), flavorId, root, stage: 'checking', planned: new Set() };
    this.batches.set(root, entry);
    this.bump();
    let released = false;
    return {
      batchId: entry.batchId,
      release: () => {
        if (released) return;
        released = true;
        if (this.batches.get(root) === entry) this.batches.delete(root);
        // 调用方已逐项结算；这里只兜底清理仍挂在该批次上的任务
        for (const [id, t] of this.tasks) if (t.batchId === entry.batchId) this.tasks.delete(id);
        this.bump();
      },
    };
  }

  /**
   * 计划确定：登记全部计划项目（排队中）并进入逐项处理，推送一次。检查阶段不受理该目录的任何单项写操作（含首次安装），
   * 所以计划中的项目不会与已受理的单项操作冲突。
   */
  planBatch(handle: BatchHandle, items: { taskId: string; modId: string; label: string }[]): number {
    const entry = [...this.batches.values()].find((b) => b.batchId === handle.batchId);
    if (!entry) throw new Error('批次已结束');
    entry.stage = 'running';
    for (const it of items) {
      entry.planned.add(it.modId);
      this.tasks.set(it.taskId, { taskId: it.taskId, label: it.label, flavorId: entry.flavorId, root: entry.root, modId: it.modId, phase: 'queued', received: null, total: null, batchId: entry.batchId });
    }
    return this.bump();
  }

  /**
   * 单个插件的写操作：同一目录同一插件已有写操作时拒绝；目录正在全部更新时拒绝，
   * 只有计划已确定、且插件不在计划中的首次安装例外。返回只生效一次的释放函数。
   */
  reserveProject(flavorId: number, root: string, modId: string, kind: ActivityReservation['kind']): () => void {
    const b = this.batches.get(root);
    if (b && (kind !== 'install' || b.stage !== 'running' || b.planned.has(modId))) throw batchBusy();
    for (const r of this.reservations) if (r.root === root && r.modId === modId) throw projectBusy();
    const entry: ActivityReservation = { flavorId, root, modId, kind };
    this.reservations.add(entry);
    this.bump();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(entry);
      this.bump();
    };
  }

  /** 登记单项任务（排队中）；返回 rev，不推送（调用方随后推送） */
  startTask(t: Omit<ActivityTask, 'phase' | 'received' | 'total'>): number {
    this.tasks.set(t.taskId, { ...t, phase: 'queued', received: null, total: null });
    return this.next();
  }

  /** 阶段变化：返回 rev，不推送 */
  setPhase(taskId: string, phase: ActivePhase, received: number | null = null, total: number | null = null): number {
    const t = this.tasks.get(taskId);
    if (!t) return this.rev;
    t.phase = phase;
    t.received = received;
    t.total = total;
    return this.next();
  }

  /** 下载字节数：返回 rev，不推送 */
  progress(taskId: string, received: number | null, total: number | null): number {
    const t = this.tasks.get(taskId);
    if (!t) return this.rev;
    t.received = received;
    t.total = total;
    return this.next();
  }

  /** 任务结束（移出状态）：返回 rev，不推送（调用方先发终态事件再推送） */
  endTask(taskId: string): number {
    if (!this.tasks.delete(taskId)) return this.rev;
    return this.next();
  }

  private next(): number {
    return ++this.rev;
  }

  private bump(): number {
    const rev = this.next();
    this.publish();
    return rev;
  }
}
