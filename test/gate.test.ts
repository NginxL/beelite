import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuitGuard, guardHandler, MUTATING_CHANNELS, MutationGate } from '../src/core/gate';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

test('写通道清单：恰好 16 个，包含会触发恢复的 local:state、写更新策略、操作记录与 WTF 备份（含会写占用标记的重新校验）的通道，不含只读通道与备份取消', () => {
  assert.equal(MUTATING_CHANNELS.size, 16);
  for (const c of [
    'profile:bind', 'profile:unbind', 'local:state', 'addon:install', 'addon:update', 'addon:updateAll', 'addon:uninstall', 'addon:uninstallFolder', 'trash:restore', 'trash:purge', 'policy:set', 'history:retry',
    'backup:configure', 'backup:disable', 'backup:run', 'backup:verify',
  ]) {
    assert.ok(MUTATING_CHANNELS.has(c), c);
  }
  for (const c of [
    'addon:check', 'config:get', 'mods:search', 'profile:list', 'task:cancel', 'client:update', 'policy:reload', 'history:list', 'history:status', 'health:check',
    'backup:taskState', 'backup:state', 'backup:cancel', 'backup:reveal',
  ]) assert.ok(!MUTATING_CHANNELS.has(c), c);
});

test('包装后的写操作在调用当下同步入闸，覆盖首个 await 之前的阶段', async () => {
  const gate = new MutationGate();
  const step = deferred();
  const fn = guardHandler(gate, 'addon:install', async () => {
    await step.promise; // 模拟 boundRoot / 远端请求 / 对话框
    return 'ok';
  });
  const p = fn();
  assert.equal(gate.activeCount, 1, '调用后立即计数');
  const { drained } = gate.freezeAndDrain();
  let done = false;
  void drained.then(() => (done = true));
  await tick();
  assert.equal(done, false, '操作未结束前不得排空');
  step.resolve();
  assert.equal(await p, 'ok');
  await drained;
  assert.equal(gate.activeCount, 0);
});

test('冻结后新的写操作同步失败且不执行；只读通道不受影响', async () => {
  const gate = new MutationGate();
  let ran = 0;
  const write = guardHandler(gate, 'trash:purge', async () => void ran++);
  const read = guardHandler(gate, 'addon:check', async () => 'read');
  gate.freeze();
  await assert.rejects(write(), /正在更新或退出/);
  assert.equal(ran, 0);
  assert.equal(await read(), 'read');
  assert.equal(gate.activeCount, 0);
});

test('同步抛错与异步拒绝都会释放计数；并行时排空要等最慢的那个收尾', async () => {
  const gate = new MutationGate();
  const syncThrow = guardHandler(gate, 'addon:uninstall', async () => {
    throw new Error('同步失败');
  });
  await assert.rejects(syncThrow(), /同步失败/);
  assert.equal(gate.activeCount, 0);

  const slowCleanup = deferred();
  const failing = guardHandler(gate, 'addon:update', async () => {
    throw new Error('很快失败');
  });
  const slow = guardHandler(gate, 'trash:restore', async () => {
    await slowCleanup.promise;
  });
  const a = failing();
  const b = slow();
  const { drained } = gate.freezeAndDrain();
  await assert.rejects(a, /很快失败/);
  let done = false;
  void drained.then(() => (done = true));
  await tick();
  assert.equal(done, false, '一个失败不能让排空提前结束');
  slowCleanup.resolve();
  await b;
  await drained;
  assert.equal(done, true);
});

test('批次只入闸一次：冻结后已受理的批次完整执行，内部步骤不再入闸', async () => {
  const gate = new MutationGate();
  const steps: string[] = [];
  const between = deferred();
  const batch = guardHandler(gate, 'addon:updateAll', async () => {
    steps.push('第1项');
    await between.promise; // 批次间隙
    steps.push('第2项');
  });
  const p = batch();
  const { drained } = gate.freezeAndDrain();
  between.resolve();
  await p;
  await drained;
  assert.deepEqual(steps, ['第1项', '第2项']);
});

test('冻结令牌：两个来源都释放后才解冻；释放函数只生效一次', () => {
  const gate = new MutationGate();
  const t1 = gate.freeze();
  const t2 = gate.freeze();
  gate.unfreeze(t1);
  assert.equal(gate.frozen, true);
  gate.unfreeze(t2);
  assert.equal(gate.frozen, false);
  const release = gate.enter();
  release();
  release();
  assert.equal(gate.activeCount, 0);
});

test('退出保护：有写操作时阻止退出，排空后只调用一次 quit；空闲时直接放行并冻结', async () => {
  const gate = new MutationGate();
  let quits = 0;
  const guard = createQuitGuard(gate, () => quits++);
  const release = gate.enter();
  let prevented = 0;
  const ev = { preventDefault: () => void prevented++ };
  guard(ev);
  guard(ev); // 重复触发（例如再次按 ⌘Q）
  assert.equal(prevented, 2);
  assert.equal(gate.frozen, true);
  assert.throws(() => gate.enter(), /正在更新或退出/);
  await tick();
  assert.equal(quits, 0);
  release();
  await tick();
  assert.equal(quits, 1);
  guard(ev); // quit() 引起的再次 before-quit 不再阻止
  assert.equal(prevented, 2);

  const idle = new MutationGate();
  let p2 = 0;
  createQuitGuard(idle, () => assert.fail('不应调用'))({ preventDefault: () => void p2++ });
  assert.equal(p2, 0);
  assert.equal(idle.frozen, true);
});
