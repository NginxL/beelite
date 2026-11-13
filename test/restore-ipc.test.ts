// WTF 恢复的接入（0.3.0）：真实 preload → 真实 AppService（假 electron）→ WtfRestoreService / WtfBackupService → 临时目录。
// 发送方与参数校验；绑定写入与恢复双向互斥（含 A→B→A 使旧预览作废）；未完成恢复的只读查看不依赖绑定、设置或备份是否启用，
// 处理只按登记的原目录；恢复期间诊断保存因保护集合正在修改而拒绝；退出与客户端更新等待恢复（临界段不可取消）收尾。
// 中断用 SimulatedCrash 钩子模拟（不是真实的进程终止）。全部在临时目录中进行，不读取真实游戏目录或 userData。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SimulatedCrash } from '../src/core/errors';
import { createQuitGuard } from '../src/core/gate';
import { LOCK_NAME } from '../src/core/wtf-backup';
import { CONTROL_DIR, TARGET_LOCK, TX_PREFIX, type RestoreStep } from '../src/core/wtf-restore-txn';
import type { BackupOutcome, RestorePreview } from '../src/shared/types';
import { cleanup, exists, FakeSource, makeGameRoot, tmpDir } from './helpers';
import { createHarness, snapshot, type Harness } from './ipc-harness';

const F = 9;
const ALL = { kind: 'all' } as const;
const ACK = { gameClosed: true, overwrite: true } as const;
const RACK = { gameClosed: true } as const;
/** 测试中“已退出”的持有进程 */
const DEAD = 999_999;
const SV = ['WTF', 'Account', 'TEST', 'SavedVariables', 'Questie.lua'];
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function completed<T>(o: BackupOutcome<T>): T {
  if (o.status !== 'completed') assert.fail(`意外取消：${o.message}`);
  return o.result;
}

/** 恢复事务的钩子：在指定阶段暂停或执行动作 */
class StepHook {
  fn: ((n: RestoreStep) => Promise<void> | void) | null = null;

  pauseAt(at: RestoreStep): { reached: Promise<void>; release: () => void } {
    const reached = deferred();
    const gate = deferred();
    this.fn = async (n) => {
      if (n !== at) return;
      this.fn = null;
      reached.resolve();
      await gate.promise;
    };
    return { reached: reached.promise, release: gate.resolve };
  }
}

async function setup() {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const A = await makeGameRoot(path.join(base, 'games', 'A'));
  const B = await makeGameRoot(path.join(base, 'games', 'B'));
  const picked = path.join(base, 'Desktop');
  const elsewhere = path.join(base, 'Elsewhere');
  await mkdir(picked);
  await mkdir(elsewhere);
  const hook = new StepHook();
  const settingsFile = path.join(userData, 'settings.json');
  const make = (): Harness =>
    createHarness({
      settingsFile,
      source: new FakeSource(),
      restore: { hooks: { step: (n) => hook.fn?.(n) }, probePid: (pid) => (pid === DEAD ? 'gone' : 'alive'), freeBytes: async () => 1e15 },
    });
  const h = make();
  await h.settings.bind(F, A);
  return { base, userData, settingsFile, A, B, picked, elsewhere, hook, make, h, sv: path.join(A, ...SV) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** 经 IPC 启用备份并做一份完整备份；返回备份位置与备份编号 */
async function enableAndSnapshot(f: Setup, h: Harness = f.h): Promise<{ container: string; id: string }> {
  h.stub.pick = f.picked;
  const c = await h.api.backupConfigure(F, f.A);
  h.stub.pick = null;
  assert.ok(c?.enabled && c.containerPath);
  const r = completed(await h.api.backupRun(F, f.A, ALL));
  return { container: c.containerPath, id: r.snapshot.id };
}

async function preview(h: Harness, root: string, id: string): Promise<RestorePreview & { token: string }> {
  const p = completed(await h.api.backupRestorePreview(F, root, id));
  assert.ok(p.token, p.blockers.join('；'));
  return p as RestorePreview & { token: string };
}

/** 模拟持有进程已退出：目标占用、登记、备份位置占用与 journal 中占用证明里的 pid 改成不存在的进程（与核心测试相同） */
async function orphanAll(f: Setup, container: string): Promise<void> {
  const control = path.join(f.A, CONTROL_DIR);
  const patch = async (file: string, fn: (v: Record<string, unknown>) => void) => {
    const v = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    fn(v);
    await writeFile(file, JSON.stringify(v));
  };
  await patch(path.join(control, TARGET_LOCK), (v) => (v.pid = DEAD));
  await patch(path.join(f.userData, 'wtf-restore-registry.json'), (v) => {
    const e = (v.entries as Record<string, unknown>[])[0];
    (e.lock as Record<string, unknown>).pid = DEAD;
  });
  if (await exists(path.join(container, LOCK_NAME))) await patch(path.join(container, LOCK_NAME), (v) => (v.pid = DEAD));
  const [tx] = (await readdir(control)).filter((n) => n.startsWith(TX_PREFIX));
  await patch(path.join(control, tx, 'journal.json'), (v) => {
    if (typeof v.sourceHold === 'string') {
      const hold = JSON.parse(v.sourceHold) as Record<string, unknown>;
      hold.pid = DEAD;
      v.sourceHold = JSON.stringify(hold);
    }
  });
}

test('恢复 IPC：只接受主窗口；参数逐一校验（确认必须是固定的精确对象）；拒绝的请求不留闸门计数；只读查看不入闸', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const evil = { sender: {}, senderFrame: { url: 'https://evil.example/' } };
    for (const [channel, args] of [
      ['restore:preview', [F, A, '20260101-000000-00000000']],
      ['restore:apply', ['0'.repeat(32), ACK]],
      ['restore:pending', []],
      ['restore:resolve', ['x', RACK]],
    ] as [string, unknown[]][]) {
      await assert.rejects(h.stub.handlers.get(channel)!(evil, ...args), /拒绝来自未知页面/, channel);
    }
    // 已关闭的窗口（不再是主窗口）发出的请求同样拒绝
    const old = h.replaceWindow({ destroyOld: true }).old;
    await assert.rejects(h.invokeAs(old, 'restore:pending'), /拒绝来自未知页面/);

    await assert.rejects(h.api.backupRestorePreview(999, A, '20260101-000000-00000000'), /不支持的游戏版本/);
    await assert.rejects(h.api.backupRestorePreview(F, 'relative', '20260101-000000-00000000'), /目标目录参数无效/);
    for (const bad of ['../..', '/etc', 42, null]) {
      await assert.rejects(h.api.backupRestorePreview(F, A, bad as string), /备份编号无效/, String(bad));
    }
    for (const bad of [5, '', 'x'.repeat(65)]) await assert.rejects(h.api.backupRestoreApply(bad as string, ACK), /恢复凭证无效/);
    for (const bad of [
      null, [], { gameClosed: true }, { overwrite: true }, { gameClosed: true, overwrite: true, scope: { kind: 'all' } },
      { gameClosed: 'true', overwrite: true }, { gameClosed: true, overwrite: 1 }, Object.assign(Object.create({ x: 1 }), ACK),
    ]) {
      await assert.rejects(h.api.backupRestoreApply('0'.repeat(32), bad as typeof ACK), /确认已完全退出游戏/, JSON.stringify(bad));
    }
    // 格式正确但不存在的凭证由核心拒绝
    await assert.rejects(h.api.backupRestoreApply('0'.repeat(32), ACK), /失效或已使用/);
    for (const bad of ['', '../x', 7, null]) await assert.rejects(h.api.backupRestoreResolve(bad as string, RACK), /恢复编号无效/);
    const someTx = 'a'.repeat(16);
    for (const bad of [{}, { gameClosed: false }, { gameClosed: true, root: A }, null]) {
      await assert.rejects(h.api.backupRestoreResolve(someTx, bad as typeof RACK), /重新确认/, JSON.stringify(bad));
    }
    assert.equal(h.gate.activeCount, 0);

    // 冻结期间：只读查看照常；预览被闸门拒绝
    const token = h.gate.freeze();
    const v = await h.api.backupRestorePending();
    assert.deepEqual(v.items, []);
    assert.equal(v.registryError, null);
    await assert.rejects(h.api.backupRestorePreview(F, A, '20260101-000000-00000000'), /正在更新或退出/);
    h.gate.unfreeze(token);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('只读查看：没有绑定、设置文件损坏、备份未启用时仍返回完整结构；不读写游戏目录', async () => {
  const f = await setup();
  try {
    const before = await snapshot(f.A);
    // 已绑定、备份未启用
    let v = await f.h.api.backupRestorePending();
    assert.deepEqual({ ...v, boundRootsError: v.boundRootsError ?? null }, { registryError: null, items: [], receipts: [], scanErrors: [], boundRootsError: null });
    // 没有任何绑定
    await f.h.api.unbindProfile(F, f.A);
    v = await f.h.api.backupRestorePending();
    assert.equal(v.registryError, null);
    assert.deepEqual(v.items, []);
    // 设置文件损坏：不报错，给出检查范围不完整的说明
    await writeFile(f.settingsFile, '{bad');
    v = await f.h.api.backupRestorePending();
    assert.equal(v.registryError, null);
    assert.ok(v.boundRootsError);
    assert.deepEqual(v.items, []);
    assert.deepEqual(await snapshot(f.A), before);
    // 恢复登记损坏：给出全局错误，而不是空列表冒充没有
    await writeFile(path.join(f.userData, 'wtf-restore-registry.json'), '{"format":"x"}');
    v = await f.h.api.backupRestorePending();
    assert.ok(v.registryError);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('经 IPC 预览与执行：恢复为备份时的 WTF，生成恢复前备份；凭证一次有效；准备阶段可经 backupCancel 取消', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    let p = await preview(h, A, id);
    assert.equal(p.root, A);
    assert.equal(p.scope.kind, 'all');
    assert.equal(p.safetyCopy.required, true);
    // 准备阶段取消：WTF 未改动
    const pause = f.hook.pauseAt('staging-file');
    const run = h.api.backupRestoreApply(p.token, ACK);
    await pause.reached;
    const task = h.service.backup.taskState();
    assert.equal(task?.kind, 'restore');
    assert.equal(task?.cancellable, true);
    assert.equal(await h.api.backupCancel(task!.id, F, A), true);
    pause.release();
    const cancelled = await run;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await readFile(f.sv, 'utf8'), 'changed');
    // 已用过的凭证不能再用
    await assert.rejects(h.api.backupRestoreApply(p.token, ACK), /失效或已使用/);
    p = await preview(h, A, id);
    const r = completed(await h.api.backupRestoreApply(p.token, ACK));
    assert.equal(r.outcome, 'committed', r.message);
    assert.ok(r.safetySnapshotId);
    assert.ok(r.taskId);
    assert.equal(await readFile(f.sv, 'utf8'), 'QuestieConfig = {}\n');
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('绑定 A→B→A：旧预览作废，执行拒绝且 WTF 不变；重新预览后可以执行', async () => {
  const f = await setup();
  const { h, A, B } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    const old = await preview(h, A, id);
    h.stub.pick = B;
    assert.equal((await h.api.bindProfile(F))?.root, B);
    h.stub.pick = A;
    assert.equal((await h.api.bindProfile(F))?.root, A);
    h.stub.pick = null;
    await assert.rejects(h.api.backupRestoreApply(old.token, ACK), /绑定或备份设置发生了变化/);
    assert.equal(await readFile(f.sv, 'utf8'), 'changed');
    const fresh = await preview(h, A, id);
    assert.equal(completed(await h.api.backupRestoreApply(fresh.token, ACK)).outcome, 'committed');
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('绑定确认说明：插件管理只写 Interface，只有明确确认恢复才改写 WTF 与同级恢复工作目录', async () => {
  const f = await setup();
  try {
    f.h.stub.messageBoxResponse = 1;
    f.h.stub.pick = f.B;
    assert.equal(await f.h.api.bindProfile(F), null);
    const seen = f.h.stub.messageBoxes.map((m) => String(m.detail));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /仅写入所选游戏目录的 Interface/);
    assert.match(seen[0], /明确确认恢复/);
    assert.match(seen[0], /\.azercube-wtf-restore/);
    assert.doesNotMatch(seen[0], /不会改动 WTF/);
    assert.equal((await f.h.settings.profile(F)).root, f.A);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('绑定写入进行中（设置写入的 await 期间）：同目录的预览与执行被拒绝；无关的只读查看照常', async () => {
  const f = await setup();
  const { h, A, B } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    const p = await preview(h, A, id);
    const reached = deferred();
    const go = deferred();
    const orig = h.settings.bind.bind(h.settings);
    h.settings.bind = async (...a: Parameters<typeof orig>) => {
      reached.resolve();
      await go.promise;
      return orig(...a);
    };
    h.stub.pick = B;
    const binding = h.api.bindProfile(F);
    await reached.promise;
    await assert.rejects(h.api.backupRestorePreview(F, A, id), /绑定正在修改/);
    await assert.rejects(h.api.backupRestoreApply(p.token, ACK), /绑定正在修改/);
    assert.deepEqual((await h.api.backupRestorePending()).items, []);
    go.resolve();
    assert.equal((await binding)?.root, B);
    // 解绑的写入同样占位
    const reached2 = deferred();
    const go2 = deferred();
    h.settings.bind = async (...a: Parameters<typeof orig>) => {
      reached2.resolve();
      await go2.promise;
      return orig(...a);
    };
    const unbinding = h.api.unbindProfile(F, B);
    await reached2.promise;
    await assert.rejects(h.api.backupRestorePreview(F, B, id), /绑定正在修改/);
    go2.resolve();
    assert.equal((await unbinding).root, null);
    h.settings.bind = orig;
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('恢复进行中：换绑与解绑该目录被拒绝（设置不变）；诊断保存因保护集合正在修改而拒绝且保留预览；结束后均可进行', async () => {
  const f = await setup();
  const { h, A, B } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    const diag = await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' });
    assert.equal(diag.status, 'ready');
    if (diag.status !== 'ready') return;
    const p = await preview(h, A, id);
    const pause = f.hook.pauseAt('staging-file');
    const run = h.api.backupRestoreApply(p.token, ACK);
    await pause.reached;
    h.stub.pick = B;
    await assert.rejects(h.api.bindProfile(F), /正在恢复/);
    await assert.rejects(h.api.unbindProfile(F, A), /正在恢复/);
    assert.equal((await h.settings.profile(F)).root, A);
    const out = path.join(f.elsewhere, 'report.json');
    h.stub.savePick = out;
    const saved = await h.api.diagnosticSave(diag.token);
    assert.deepEqual(saved, { status: 'rejected', code: 'protected-roots-unknown', previewKept: true });
    assert.equal(await exists(out), false);
    pause.release();
    assert.equal(completed(await run).outcome, 'committed');
    assert.equal((await h.api.diagnosticSave(diag.token)).status, 'saved');
    assert.equal(await readFile(out, 'utf8'), diag.json);
    h.stub.pick = B;
    assert.equal((await h.api.bindProfile(F))?.root, B);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('退出：恢复临界段中不可取消，退出保护等待恢复与收尾完成后才退出；之后不再受理恢复', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    const p = await preview(h, A, id);
    const pause = f.hook.pauseAt('prepared');
    const run = h.api.backupRestoreApply(p.token, ACK);
    await pause.reached;
    const task = h.service.backup.taskState();
    assert.equal(task?.cancellable, false);
    // 与 main 相同的 before-quit 顺序：先让备份服务拒绝新任务并中止可中止的任务，再由退出保护冻结并等待
    const shut = h.service.backup.shutdown();
    let quits = 0;
    const guard = createQuitGuard(h.gate, () => quits++);
    let prevented = 0;
    guard({ preventDefault: () => prevented++ });
    assert.equal(prevented, 1);
    assert.equal(await h.api.backupCancel(task!.id, F, A), false);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(quits, 0);
    assert.equal(h.gate.activeCount, 1);
    pause.release();
    const r = completed(await run);
    assert.equal(r.outcome, 'committed');
    await shut;
    await h.gate.drained();
    await tick();
    assert.equal(quits, 1);
    assert.equal(await readFile(f.sv, 'utf8'), 'QuestieConfig = {}\n');
  } finally {
    await cleanup(f.base);
  }
});

test('客户端更新冻结：等待准备阶段的恢复完成，不主动取消；冻结期间不受理新的恢复', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const { id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    const p = await preview(h, A, id);
    const pause = f.hook.pauseAt('staging-file');
    const run = h.api.backupRestoreApply(p.token, ACK);
    await pause.reached;
    const { token, drained } = h.gate.freezeAndDrain();
    let done = false;
    void drained.then(() => (done = true));
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(done, false);
    assert.equal(h.service.backup.taskState()?.cancelling, false);
    await assert.rejects(h.api.backupRestorePreview(F, A, id), /正在更新或退出/);
    pause.release();
    assert.equal(completed(await run).outcome, 'committed');
    await drained;
    h.gate.unfreeze(token);
  } finally {
    await f.h.service.backup.shutdown();
    await cleanup(f.base);
  }
});

test('中断的恢复：启动只读不处理；原目录已解绑、设置损坏时仍全局可见；处理只传编号与新确认，按登记的原目录完成', async () => {
  const f = await setup();
  try {
    const { container, id } = await enableAndSnapshot(f);
    await writeFile(f.sv, 'changed');
    const p = await preview(f.h, f.A, id);
    f.hook.fn = (n) => {
      if (n === 'old-moved') throw new SimulatedCrash(n);
    };
    await assert.rejects(f.h.api.backupRestoreApply(p.token, ACK), /simulated crash/);
    f.hook.fn = null;
    await f.h.service.backup.shutdown();
    const left = await snapshot(f.A);

    // 新的主进程：创建服务（启动）不查看也不处理
    const h2 = f.make();
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(await snapshot(f.A), left);
    // 原目录解绑、另一个目录成为当前绑定
    await h2.api.unbindProfile(F, f.A);
    await h2.settings.bind(F, f.B);
    let v = await h2.api.backupRestorePending();
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0].root, f.A);
    const txid = v.items[0].txid as string;
    assert.ok(txid);
    // 设置损坏仍可见
    const good = await readFile(f.settingsFile, 'utf8');
    await writeFile(f.settingsFile, '{bad');
    v = await h2.api.backupRestorePending();
    assert.equal(v.items.length, 1);
    assert.ok(v.boundRootsError);
    await writeFile(f.settingsFile, good);
    // 已解绑的原目录仍因恢复登记受保护：诊断报告不能保存进去
    const diag = await h2.api.diagnosticPreview({ flavorId: null, mode: 'replace' });
    assert.equal(diag.status, 'ready');
    if (diag.status !== 'ready') return;
    h2.stub.savePick = path.join(f.A, 'diag.json');
    assert.deepEqual(await h2.api.diagnosticSave(diag.token), { status: 'rejected', code: 'protected-location', previewKept: true });
    assert.deepEqual(await snapshot(f.A), left);
    // 原持有进程仍“存活”：拒绝，不猜测
    await assert.rejects(h2.api.backupRestoreResolve(txid, RACK));
    await orphanAll(f, container);
    const r = completed(await h2.api.backupRestoreResolve(txid, RACK));
    assert.equal(r.txid, txid);
    assert.equal(r.outcome, 'rolled-back', r.message);
    assert.ok(r.taskId);
    assert.equal(await readFile(f.sv, 'utf8'), 'changed');
    assert.deepEqual((await h2.api.backupRestorePending()).items, []);
    // 当前绑定没有被改变
    assert.equal((await h2.settings.profile(F)).root, f.B);
    assert.equal(h2.gate.activeCount, 0);
    await h2.service.backup.shutdown();
  } finally {
    await cleanup(f.base);
  }
});
