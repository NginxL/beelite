// 基于 journal 的 rename 事务。所有步骤都是同卷内的目录 rename，不复制、不删除插件内容。
//
// 每一步在写 journal 前记录被移动目录的身份（dev:ino，同卷 rename 不变）。回滚按逆序判断：
//   to 处是该身份         -> 这一步已执行；from 处必须为空才把它移回，否则说明原位置被外部占用，停止
//   from 处是该身份       -> 这一步未执行，跳过
//   两处都不是该身份      -> 无法判定，停止
// 停止时保留 journal 与所有原件，由调用方阻止继续写入。绝不在判断不明时报告成功。
import { rename } from 'node:fs/promises';
import { SimulatedCrash, UserError } from './errors';
import { checkParentChain, identityOf, syncDir, type Layout } from './layout';
import { resolveInside } from './paths';
import type { JournalOp } from './store';

export type StepHook = (step: string) => void | Promise<void>;

export interface PlannedOp {
  from: string;
  to: string;
}

async function opPaths(l: Layout, op: PlannedOp): Promise<{ from: string; to: string; fromParent: boolean; toParent: boolean }> {
  const from = resolveInside(l.interfaceDir, op.from);
  const to = resolveInside(l.interfaceDir, op.to);
  // 逐级确认父目录都是真实目录，防止经由符号链接移动外部内容
  const fromParent = await checkParentChain(l.interfaceDir, op.from);
  const toParent = await checkParentChain(l.interfaceDir, op.to);
  return { from, to, fromParent, toParent };
}

/** 在写 journal 之前记录每个源目录的身份 */
export async function prepareOps(l: Layout, ops: PlannedOp[]): Promise<JournalOp[]> {
  const out: JournalOp[] = [];
  for (const op of ops) {
    const p = await opPaths(l, op);
    if (!p.fromParent || !p.toParent) throw new UserError(`事务路径的上级目录不存在：${op.from} -> ${op.to}`);
    const id = await identityOf(p.from);
    if (!id) throw new UserError(`要移动的目录不存在：${op.from}`);
    out.push({ ...op, id });
  }
  return out;
}

export async function executeOps(l: Layout, ops: JournalOp[], hook?: StepHook): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    await hook?.(`before-op:${i}`);
    const p = await opPaths(l, op);
    if (!p.fromParent || !p.toParent) throw new UserError(`事务路径的上级目录不存在：${op.from} -> ${op.to}`);
    if ((await identityOf(p.from)) !== op.id) throw new UserError(`要移动的目录已被外部改动：${op.from}`);
    // macOS 上 rename 会静默替换空目录，因此先确认目标不存在
    if ((await identityOf(p.to)) !== null) throw new UserError(`目标位置已存在同名目录：${op.to}`);
    await rename(p.from, p.to);
    await hook?.(`op:${i}`);
  }
  await syncDir(l.addonsDir);
}

export type RollbackResult = { ok: true } | { ok: false; reason: string };

export async function rollbackOps(l: Layout, ops: JournalOp[]): Promise<RollbackResult> {
  try {
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      const p = await opPaths(l, op);
      const toId = p.toParent ? await identityOf(p.to) : null;
      if (toId === op.id) {
        if (!p.fromParent) return { ok: false, reason: `第 ${i + 1} 步的原位置上级目录已不存在：${op.from}` };
        if ((await identityOf(p.from)) !== null) {
          return { ok: false, reason: `第 ${i + 1} 步的原位置已被其他内容占用，无法放回：${op.from}（原目录仍保存在 ${op.to}）` };
        }
        await rename(p.to, p.from);
        continue;
      }
      const fromId = p.fromParent ? await identityOf(p.from) : null;
      if (fromId === op.id) continue;
      return { ok: false, reason: `第 ${i + 1} 步移动的目录在原位置和目标位置都找不到：${op.from} -> ${op.to}` };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await syncDir(l.addonsDir);
  return { ok: true };
}

export function isCrash(err: unknown): boolean {
  return err instanceof SimulatedCrash;
}
