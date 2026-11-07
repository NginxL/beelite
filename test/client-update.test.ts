import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientUpdater, type SparkleBridge } from '../src/core/client-update';
import type { ClientUpdateState } from '../src/shared/types';
import { MutationGate } from '../src/core/gate';

class FakeBridge implements SparkleBridge {
  calls: string[] = [];
  initResult: { ok: boolean; error?: string } = { ok: true };
  probeOk = true;
  beginOk = true;
  installOk = true;
  cancelOk = true;
  init() {
    this.calls.push('init');
    return this.initResult;
  }
  probe() {
    this.calls.push('probe');
    return this.probeOk;
  }
  beginUpdate() {
    this.calls.push('beginUpdate');
    return this.beginOk;
  }
  installNow() {
    this.calls.push('installNow');
    return this.installOk;
  }
  cancel() {
    this.calls.push('cancel');
    return this.cancelOk;
  }
  count(name: string) {
    return this.calls.filter((c) => c === name).length;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const bridge = new FakeBridge();
  const gate = new MutationGate();
  const states: string[] = [];
  const snapshots: ClientUpdateState[] = [];
  const u = new ClientUpdater({
    bridge,
    gate,
    currentVersion: '0.1.1',
    onState: (s) => {
      states.push(s.status);
      snapshots.push(s);
    },
  });
  u.start();
  return { bridge, gate, u, states, snapshots };
}

/** 探测到新版本 0.1.2 */
function probeFound(u: ClientUpdater) {
  u.check();
  u.handle({ type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2' });
  u.handle({ type: 'cycle-finished', check: 'probe' });
}

/** 用户授权后，原生完成下载、验签与解压 */
function downloadToReady(u: ClientUpdater) {
  u.handle({ type: 'update-found', authorized: true, version: '0.1.2', displayVersion: '0.1.2' });
  u.handle({ type: 'download-start' });
  u.handle({ type: 'download-progress', received: 50, total: 100 });
  u.handle({ type: 'extracting', percent: 100 });
  u.handle({ type: 'ready' });
}

test('检查更新只探测：发现新版本后停在“可更新”，不会开始下载', () => {
  const { bridge, u } = setup();
  probeFound(u);
  const s = u.getState();
  assert.equal(s.status, 'available');
  assert.equal(s.availableVersion, '0.1.2');
  assert.equal(s.canUpdate, true);
  assert.equal(bridge.count('beginUpdate'), 0, '没有用户点击就不能授权下载');
  assert.equal(bridge.count('installNow'), 0);
});

test('检查结果：没有更新、Sparkle 报告无更新错误码、以及真实失败', () => {
  const { u } = setup();
  u.check();
  u.handle({ type: 'no-update' });
  u.handle({ type: 'cycle-finished', check: 'probe', errorCode: 1001, error: 'no update' });
  assert.equal(u.getState().status, 'up-to-date');
  u.check();
  u.handle({ type: 'cycle-finished', check: 'probe', errorCode: 2001, error: '网络不可用' });
  const s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', /网络不可用/);
  assert.equal(s.canCheck, true, '失败后可以重试');
});

test('一次点击完成全流程：下载→等待写操作排空→安装；重复点击只授权一次', async () => {
  const { bridge, gate, u, states } = setup();
  probeFound(u);
  u.update();
  u.update(); // 重复点击
  assert.equal(bridge.count('beginUpdate'), 1);
  const release = gate.enter(); // 正在进行的插件写操作
  downloadToReady(u);
  await tick();
  assert.equal(u.getState().status, 'waiting');
  assert.match(u.getState().message ?? '', /等待插件操作完成/);
  assert.equal(bridge.count('installNow'), 0, '写操作未结束不得安装');
  assert.throws(() => gate.enter(), /正在更新或退出/, '等待期间拒绝新的写操作');
  release();
  await tick();
  assert.equal(bridge.count('installNow'), 1);
  assert.equal(u.getState().status, 'installing');
  assert.ok(states.includes('downloading') && states.includes('extracting'));
  assert.equal(gate.frozen, true, '安装开始后保持冻结直到退出');
});

test('等待排空期间取消：之后排空完成也不会安装，闸门解冻，可以再次更新', async () => {
  const { bridge, gate, u } = setup();
  probeFound(u);
  u.update();
  const release = gate.enter();
  downloadToReady(u);
  await tick();
  u.cancel();
  assert.equal(bridge.count('cancel'), 1);
  assert.equal(gate.frozen, false);
  release();
  await tick();
  assert.equal(bridge.count('installNow'), 0, '已取消的尝试不得安装');
  // 取消后的残余原生事件被忽略；旧周期结束前不能重新更新
  u.handle({ type: 'error', message: '用户取消' });
  assert.equal(u.getState().status, 'available');
  assert.equal(u.getState().canUpdate, false);
  u.handle({ type: 'cycle-finished', check: 'user' });
  u.update();
  assert.equal(bridge.count('beginUpdate'), 2);
});

test('等待排空期间出错：早先等待的延续不再触发安装，闸门解冻', async () => {
  const { bridge, gate, u } = setup();
  probeFound(u);
  u.update();
  const release = gate.enter();
  downloadToReady(u);
  await tick();
  u.handle({ type: 'error', message: '安装器启动失败' });
  assert.equal(u.getState().status, 'error');
  assert.equal(gate.frozen, false);
  release();
  await tick();
  assert.equal(bridge.count('installNow'), 0);
  assert.equal(u.getState().canUpdate, false, '旧周期结束前不能重试');
  u.handle({ type: 'cycle-finished', check: 'user', errorCode: 4, error: '安装器启动失败' });
  assert.equal(u.getState().canUpdate, true, '旧周期结束后可以重试');
});

test('安装失败：原生报错后解冻闸门、保留可重试状态', async () => {
  const { bridge, gate, u } = setup();
  probeFound(u);
  u.update();
  downloadToReady(u);
  await tick();
  assert.equal(bridge.count('installNow'), 1);
  u.handle({ type: 'installing' });
  u.handle({ type: 'error', message: '无法替换应用' });
  const s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', /无法替换应用/);
  assert.equal(gate.frozen, false);
  assert.doesNotThrow(() => gate.enter()());
});

test('原生拒绝立即安装（没有待安装的回复）时报错并解冻，不会卡在安装中', async () => {
  const { bridge, gate, u } = setup();
  bridge.installOk = false;
  probeFound(u);
  u.update();
  downloadToReady(u);
  await tick();
  assert.equal(u.getState().status, 'error');
  assert.equal(gate.frozen, false);
});

test('排空后原生已无待安装回复（原生错误事件尚在队列中）：报错但等旧周期结束才允许重试', async () => {
  const { bridge, gate, u, snapshots } = setup();
  probeFound(u);
  u.update();
  const release = gate.enter();
  downloadToReady(u);
  await tick();
  assert.equal(u.getState().status, 'waiting');
  // 原生安装器出错：已清除待安装回复与授权，error / cycle-finished 还没送到 JS
  bridge.installOk = false;
  release();
  await tick();
  assert.equal(bridge.count('installNow'), 1);
  let s = u.getState();
  assert.equal(s.status, 'error');
  assert.equal(gate.frozen, false);
  assert.equal(s.canCheck, false);
  assert.equal(s.canUpdate, false);
  u.update();
  u.check();
  assert.equal(bridge.count('beginUpdate'), 1, '旧周期结束前不得开始新的更新');
  assert.equal(bridge.count('probe'), 1, '旧周期结束前不得开始新的检查');
  // 旧会话的事件随后到达
  u.handle({ type: 'error', message: '安装器启动失败' });
  assert.equal(u.getState().canUpdate, false);
  const before = snapshots.length;
  u.handle({ type: 'cycle-finished', check: 'user', errorCode: 4, error: '安装器启动失败' });
  assert.ok(snapshots.length > before, '屏障解除时应通知界面');
  s = u.getState();
  assert.equal(s.canUpdate, true);
  // 重试成功
  bridge.installOk = true;
  u.update();
  assert.equal(bridge.count('beginUpdate'), 2);
  downloadToReady(u);
  await tick();
  assert.equal(bridge.count('installNow'), 2);
  assert.equal(u.getState().status, 'installing');
});

test('下载失败与未授权的发现都不会进入安装；下载中可以取消', () => {
  const { bridge, u } = setup();
  probeFound(u);
  // 未经 update() 授权的原生事件（例如残留会话）不改变状态
  u.handle({ type: 'update-found', authorized: false, version: '0.1.2', displayVersion: '0.1.2' });
  u.handle({ type: 'ready' });
  assert.equal(u.getState().status, 'available');
  u.update();
  u.handle({ type: 'download-progress', received: 10, total: 100 });
  assert.equal(u.getState().percent, 10);
  assert.equal(u.getState().canCancel, true);
  u.handle({ type: 'error', message: '下载中断' });
  assert.equal(u.getState().status, 'error');
  assert.equal(bridge.count('installNow'), 0);
});

test('更新会话中服务器已没有新版本：回到“已是最新”', () => {
  const { u } = setup();
  probeFound(u);
  u.update();
  u.handle({ type: 'not-found' });
  assert.equal(u.getState().status, 'up-to-date');
  assert.equal(u.getState().availableVersion, null);
});

test('组件不可用或初始化失败：显示原因，所有操作都不可用且不调用原生', () => {
  const none = new ClientUpdater({ bridge: null, gate: new MutationGate(), currentVersion: '0.1.1', unsupportedReason: '开发运行时不提供客户端自动更新' });
  none.start();
  assert.equal(none.check().status, 'unsupported');
  assert.equal(none.getState().message, '开发运行时不提供客户端自动更新');

  const bridge = new FakeBridge();
  bridge.initResult = { ok: false, error: 'SUPublicEDKey 缺失' };
  const u = new ClientUpdater({ bridge, gate: new MutationGate(), currentVersion: '0.1.1' });
  u.start();
  const s = u.update();
  assert.equal(s.status, 'unsupported');
  assert.match(s.message ?? '', /启动失败/);
  assert.doesNotMatch(s.message ?? '', /SUPublicEDKey/, '界面不显示内部错误细节');
  assert.equal(s.canCheck || s.canUpdate || s.canCancel, false);
  assert.deepEqual(bridge.calls, ['init']);
});

test('原生取消返回 false（界面仍显示下载中，原生已进入解压）：不认定取消，保持授权并继续完成更新', async () => {
  const { bridge, gate, u } = setup();
  probeFound(u);
  u.update();
  u.handle({ type: 'download-progress', received: 99, total: 100 });
  bridge.cancelOk = false;
  const s = u.cancel();
  assert.equal(bridge.count('cancel'), 1);
  assert.equal(s.status, 'downloading', '不得显示已取消');
  assert.equal(s.message, null);
  u.handle({ type: 'extracting', percent: 50 });
  assert.equal(u.getState().canCancel, false, '解压阶段不提供取消');
  u.handle({ type: 'ready' });
  await tick();
  assert.equal(bridge.count('installNow'), 1, '本次授权仍然有效，排空后安装');
  assert.equal(gate.frozen, true);
});

test('解压阶段不提供取消：cancel 不调用原生', () => {
  const { bridge, u } = setup();
  probeFound(u);
  u.update();
  u.handle({ type: 'extracting' });
  assert.equal(u.getState().canCancel, false);
  u.cancel();
  assert.equal(bridge.count('cancel'), 0);
  assert.equal(u.getState().status, 'extracting');
});

for (const [label, end] of [
  ['取消', (u: ClientUpdater) => u.cancel()],
  ['出错', (u: ClientUpdater) => u.handle({ type: 'error', message: '下载失败' })],
  ['更新时已无新版本', (u: ClientUpdater) => u.handle({ type: 'not-found' })],
] as const) {
  test(`终止屏障（${label}）：旧周期结束前拒绝重新检查和更新，结束后通知界面并允许重试`, () => {
    const { bridge, u, snapshots } = setup();
    probeFound(u);
    u.update();
    u.handle({ type: 'download-progress', received: 10, total: 100 });
    end(u);
    // 此时原生可能已允许新的调用（sessionInProgress 已清空），但旧的 cycle-finished 还没送到 JS
    let s = u.getState();
    assert.equal(s.canCheck, false);
    assert.equal(s.canUpdate, false);
    u.update();
    u.check();
    assert.equal(bridge.count('beginUpdate'), 1, '屏障期间不得开始新的更新');
    assert.equal(bridge.count('probe'), 1, '屏障期间不得开始新的检查');
    // 旧周期的残余事件不会影响状态
    u.handle({ type: 'download-progress', received: 90, total: 100 });
    u.handle({ type: 'ready' });
    assert.notEqual(u.getState().status, 'waiting');
    const before = snapshots.length;
    u.handle({ type: 'cycle-finished', check: 'user', errorCode: label === '更新时已无新版本' ? 1001 : undefined });
    assert.ok(snapshots.length > before, '屏障解除时应通知界面');
    s = snapshots[snapshots.length - 1];
    assert.equal(s.canCheck, true);
    if (label === '更新时已无新版本') {
      assert.equal(s.status, 'up-to-date');
    } else {
      assert.equal(s.canUpdate, true);
      u.update();
      assert.equal(bridge.count('beginUpdate'), 2);
    }
  });
}
