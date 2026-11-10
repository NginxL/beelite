import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_TIMEOUT_MS, ClientUpdater, STOP_GRACE_MS, type BridgeIntent, type ProbeCancelResult, type SparkleBridge } from '../src/core/client-update';
import type { ClientUpdateState } from '../src/shared/types';
import { MutationGate } from '../src/core/gate';
import { bindBridge, FakeClock, send, sendAs } from './client-fakes';

class FakeBridge implements SparkleBridge {
  calls: string[] = [];
  initResult: { ok: boolean; error?: string } = { ok: true };
  probeOk = true;
  beginOk = true;
  installOk = true;
  cancelOk = true;
  cancelProbeResult: ProbeCancelResult = 'cancelled';
  /** 原生最近接受的会话（事件以它的身份派发） */
  session = 0;
  intent: BridgeIntent = 'none';
  /** probe / beginUpdate 收到的全部会话编号 */
  sessions: number[] = [];
  onEvent: ((json: string) => void) | null = null;
  init(onEvent: (json: string) => void) {
    this.calls.push('init');
    this.onEvent = onEvent;
    return this.initResult;
  }
  probe(session: number) {
    this.calls.push('probe');
    this.sessions.push(session);
    if (this.probeOk) {
      this.session = session;
      this.intent = 'probe';
    }
    return this.probeOk;
  }
  beginUpdate(_build: string, session: number) {
    this.calls.push('beginUpdate');
    this.sessions.push(session);
    if (this.beginOk) {
      this.session = session;
      this.intent = 'update';
    }
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
  /** 可替换 cancelProbe 的行为（例如抛出异常，或在调用期间同步派发事件） */
  cancelProbeImpl: ((session: number) => ProbeCancelResult) | null = null;
  cancelProbe(session: number) {
    this.calls.push(`cancelProbe:${session}`);
    return this.cancelProbeImpl ? this.cancelProbeImpl(session) : this.cancelProbeResult;
  }
  count(name: string) {
    return this.calls.filter((c) => c === name).length;
  }
  cancelProbes() {
    return this.calls.filter((c) => c.startsWith('cancelProbe:'));
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const bridge = new FakeBridge();
  const gate = new MutationGate();
  const clock = new FakeClock();
  const states: string[] = [];
  const snapshots: ClientUpdateState[] = [];
  const u = new ClientUpdater({
    bridge,
    gate,
    currentVersion: '0.1.1',
    timers: clock,
    onState: (s) => {
      states.push(s.status);
      snapshots.push(s);
    },
  });
  bindBridge(u, bridge);
  u.start();
  return { bridge, gate, clock, u, states, snapshots };
}

/** 探测到新版本 0.1.2 */
function probeFound(u: ClientUpdater) {
  u.check();
  send(u, { type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'cycle-finished', check: 'user' });
}

/** 用户授权后，原生完成下载、验签与解压 */
function downloadToReady(u: ClientUpdater) {
  send(u, { type: 'update-found', authorized: true, version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'download-start' });
  send(u, { type: 'download-progress', received: 50, total: 100 });
  send(u, { type: 'extracting', percent: 100 });
  send(u, { type: 'ready' });
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
  send(u, { type: 'no-update' });
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001, error: 'no update' });
  assert.equal(u.getState().status, 'up-to-date');
  u.check();
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 2001, error: '网络不可用' });
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
  send(u, { type: 'error', message: '用户取消' });
  assert.equal(u.getState().status, 'available');
  assert.equal(u.getState().canUpdate, false);
  send(u, { type: 'cycle-finished', check: 'user' });
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
  send(u, { type: 'error', message: '安装器启动失败' });
  assert.equal(u.getState().status, 'error');
  assert.equal(gate.frozen, false);
  release();
  await tick();
  assert.equal(bridge.count('installNow'), 0);
  assert.equal(u.getState().canUpdate, false, '旧周期结束前不能重试');
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 4, error: '安装器启动失败' });
  assert.equal(u.getState().canUpdate, true, '旧周期结束后可以重试');
});

test('安装失败：原生报错后解冻闸门、保留可重试状态', async () => {
  const { bridge, gate, u } = setup();
  probeFound(u);
  u.update();
  downloadToReady(u);
  await tick();
  assert.equal(bridge.count('installNow'), 1);
  send(u, { type: 'installing' });
  send(u, { type: 'error', message: '无法替换应用' });
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
  send(u, { type: 'error', message: '安装器启动失败' });
  assert.equal(u.getState().canUpdate, false);
  const before = snapshots.length;
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 4, error: '安装器启动失败' });
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
  send(u, { type: 'update-found', authorized: false, version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'ready' });
  assert.equal(u.getState().status, 'available');
  u.update();
  send(u, { type: 'download-progress', received: 10, total: 100 });
  assert.equal(u.getState().percent, 10);
  assert.equal(u.getState().canCancel, true);
  send(u, { type: 'error', message: '下载中断' });
  assert.equal(u.getState().status, 'error');
  assert.equal(bridge.count('installNow'), 0);
});

test('更新会话中服务器已没有新版本：回到“已是最新”', () => {
  const { u } = setup();
  probeFound(u);
  u.update();
  send(u, { type: 'not-found' });
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
  const u = new ClientUpdater({ bridge, gate: new MutationGate(), currentVersion: '0.1.1', timers: new FakeClock() });
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
  send(u, { type: 'download-progress', received: 99, total: 100 });
  bridge.cancelOk = false;
  const s = u.cancel();
  assert.equal(bridge.count('cancel'), 1);
  assert.equal(s.status, 'downloading', '不得显示已取消');
  assert.equal(s.message, null);
  send(u, { type: 'extracting', percent: 50 });
  assert.equal(u.getState().canCancel, false, '解压阶段不提供取消');
  send(u, { type: 'ready' });
  await tick();
  assert.equal(bridge.count('installNow'), 1, '本次授权仍然有效，排空后安装');
  assert.equal(gate.frozen, true);
});

test('解压阶段不提供取消：cancel 不调用原生', () => {
  const { bridge, u } = setup();
  probeFound(u);
  u.update();
  send(u, { type: 'extracting' });
  assert.equal(u.getState().canCancel, false);
  u.cancel();
  assert.equal(bridge.count('cancel'), 0);
  assert.equal(u.getState().status, 'extracting');
});

for (const [label, end] of [
  ['取消', (u: ClientUpdater) => u.cancel()],
  ['出错', (u: ClientUpdater) => send(u, { type: 'error', message: '下载失败' })],
  ['更新时已无新版本', (u: ClientUpdater) => send(u, { type: 'not-found' })],
] as const) {
  test(`终止屏障（${label}）：旧周期结束前拒绝重新检查和更新，结束后通知界面并允许重试`, () => {
    const { bridge, u, snapshots } = setup();
    probeFound(u);
    u.update();
    send(u, { type: 'download-progress', received: 10, total: 100 });
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
    send(u, { type: 'download-progress', received: 90, total: 100 });
    send(u, { type: 'ready' });
    assert.notEqual(u.getState().status, 'waiting');
    const before = snapshots.length;
    send(u, { type: 'cycle-finished', check: 'user', errorCode: label === '更新时已无新版本' ? 1001 : undefined });
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

// ---------- 0.1.6：检查预算、会话编号与超时后的重试 ----------

const STOPPING = /检查艾泽魔方新版本超时，正在停止本次检查/;
const TIMED_OUT = /检查艾泽魔方新版本超时，请稍后重试/;
const STUCK = /本次检查未能停止，请退出并重新打开艾泽魔方后再检查/;

test('检查在预算内结束：正常结果生效，计时器清除，之后不会再请求取消', () => {
  const { bridge, clock, u } = setup();
  u.check();
  assert.equal(u.getState().status, 'checking');
  clock.advance(CHECK_TIMEOUT_MS - 1);
  send(u, { type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'cycle-finished', check: 'user' });
  assert.equal(u.getState().status, 'available');
  assert.equal(clock.pending, 0, '结果先到：计时器全部清除');
  clock.advance(CHECK_TIMEOUT_MS + STOP_GRACE_MS);
  assert.deepEqual(bridge.cancelProbes(), [], '已结束的检查不会被取消');
  assert.equal(u.getState().status, 'available');
  assert.equal(u.getState().checkFailed, false);
});

test('检查超时：请求取消本次会话，作废迟到的结果；周期结束前不能重试，结束后报告超时并可重试', () => {
  const { bridge, clock, gate, u } = setup();
  u.check();
  clock.advance(CHECK_TIMEOUT_MS);
  assert.deepEqual(bridge.cancelProbes(), ['cancelProbe:1'], '只取消超时的这个会话');
  let s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', STOPPING);
  assert.equal(s.canCheck, false, '只凭计时器与取消返回值不能允许重试');
  assert.equal(s.canUpdate, false);
  u.check();
  assert.equal(bridge.count('probe'), 1, '停止期间不得开始新的检查');
  // 迟到的结果（超时作废）：不形成可更新条目，也不报告已是最新
  send(u, { type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2', notes: '迟到的说明', notesState: 'ok' });
  send(u, { type: 'no-update' });
  send(u, { type: 'update-found', authorized: false, version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'error', message: '迟到的错误' });
  assert.equal(u.getState().canCheck, false);
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  s = u.getState();
  assert.equal(s.status, 'error', '作废的检查不报告“已是最新”');
  assert.match(s.message ?? '', TIMED_OUT);
  assert.equal(s.availableBuild, null, '迟到的条目不采用');
  assert.equal(s.notice, false, '不会因作废的检查弹出更新说明');
  assert.equal(s.canCheck, true);
  assert.equal(s.checkFailed, true);
  assert.equal(clock.pending, 0, '停止宽限计时器已清除');
  // 手动重试：新的会话编号，同一进程内正常完成
  u.check();
  assert.deepEqual(bridge.sessions, [1, 2]);
  send(u, { type: 'no-update' });
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  s = u.getState();
  assert.equal(s.status, 'up-to-date');
  assert.equal(s.checkFailed, false);
  assert.equal(gate.frozen, false, '检查与重试都不冻结插件写操作');
  assert.equal(bridge.count('beginUpdate') + bridge.count('installNow') + bridge.count('cancel'), 0, '检查不授权下载、不安装');
});

for (const result of ['cancelled', 'pending', 'none'] as const) {
  test(`超时后取消返回 ${result}：同样只等该会话的周期结束才允许重试`, () => {
    const { bridge, clock, u } = setup();
    bridge.cancelProbeResult = result;
    u.check();
    clock.advance(CHECK_TIMEOUT_MS);
    assert.equal(u.getState().canCheck, false);
    clock.advance(STOP_GRACE_MS - 1);
    assert.equal(u.getState().canCheck, false);
    assert.match(u.getState().message ?? '', STOPPING);
    send(u, { type: 'cycle-finished', check: 'user' });
    assert.equal(u.getState().canCheck, true);
    assert.match(u.getState().message ?? '', TIMED_OUT);
  });
}

test('停止宽限到期仍未结束：如实提示退出并重新打开，保持屏障；迟到的周期结束后仍可重试', () => {
  const { bridge, clock, u, snapshots } = setup();
  u.check();
  clock.advance(CHECK_TIMEOUT_MS + STOP_GRACE_MS);
  let s = u.getState();
  assert.match(s.message ?? '', STUCK);
  assert.equal(s.canCheck, false);
  assert.equal(s.canUpdate, false);
  u.check();
  clock.advance(10 * 60_000);
  assert.equal(bridge.count('probe'), 1, '不自动重试，也不允许手动重试');
  assert.equal(bridge.cancelProbes().length, 1, '只请求一次取消');
  const before = snapshots.length;
  send(u, { type: 'cycle-finished', check: 'user' });
  assert.ok(snapshots.length > before, '屏障解除时通知界面');
  s = u.getState();
  assert.match(s.message ?? '', TIMED_OUT);
  assert.equal(s.canCheck, true);
  u.check();
  assert.equal(bridge.count('probe'), 2);
});

test('旧会话 A 的事件与计时器不影响新会话 B', () => {
  const { bridge, clock, u } = setup();
  u.check(); // A = 1
  clock.advance(CHECK_TIMEOUT_MS);
  send(u, { type: 'cycle-finished', check: 'user' });
  clock.advance(1000);
  u.check(); // B = 2
  assert.equal(bridge.session, 2);
  // A 的残余事件（编号 1）与意图不符的事件都被丢弃
  sendAs(u, 1, 'probe', { type: 'valid-update', version: '0.1.9', displayVersion: '0.1.9' });
  sendAs(u, 1, 'probe', { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  sendAs(u, 2, 'update', { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  assert.equal(u.getState().status, 'checking');
  // A 的停止宽限原本在 30s+15s 到期：已清除，不会改动 B
  clock.advance(STOP_GRACE_MS);
  assert.equal(u.getState().status, 'checking');
  assert.deepEqual(bridge.cancelProbes(), ['cancelProbe:1']);
  send(u, { type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'cycle-finished', check: 'user' });
  const s = u.getState();
  assert.equal(s.status, 'available');
  assert.equal(s.availableBuild, '0.1.2', 'B 的结果生效，A 的 0.1.9 没有混入');
  clock.advance(CHECK_TIMEOUT_MS);
  assert.deepEqual(bridge.cancelProbes(), ['cancelProbe:1'], 'B 已结束，不再请求取消');
});

test('严格的事件身份：没有标记、编号为 0、编号或意图不符的事件一律丢弃（包括经原生回调的 JSON）', () => {
  const { bridge, u } = setup();
  u.check();
  const native = (v: unknown) => bridge.onEvent?.(JSON.stringify(v));
  native({ type: 'valid-update', version: '0.1.7', displayVersion: '0.1.7' });
  native({ type: 'valid-update', version: '0.1.7', displayVersion: '0.1.7', session: 0, intent: 'none' });
  native({ type: 'valid-update', version: '0.1.7', displayVersion: '0.1.7', session: '1', intent: 'probe' });
  native({ type: 'valid-update', version: '0.1.7', displayVersion: '0.1.7', session: 1, intent: 'update' });
  native({ type: 'cycle-finished', check: 'user', session: 2, intent: 'probe' });
  native({ type: 'cycle-finished', check: 'user' });
  native(null);
  bridge.onEvent?.('not json');
  assert.equal(u.getState().status, 'checking');
  native({ type: 'no-update', session: 1, intent: 'probe' });
  native({ type: 'cycle-finished', check: 'user', errorCode: 1001, session: 1, intent: 'probe' });
  const s = u.getState();
  assert.equal(s.status, 'up-to-date');
  assert.equal(s.availableBuild, null);
});

test('已有新版本时检查失败或超时：保留之前已验证的版本，显示原因与“重试”，仍可更新', () => {
  const { bridge, clock, u } = setup();
  probeFound(u);
  u.ackNotice('0.1.2');
  // 超时
  u.check();
  clock.advance(CHECK_TIMEOUT_MS);
  assert.equal(u.getState().canUpdate, false, '停止期间不能更新');
  send(u, { type: 'cycle-finished', check: 'user' });
  let s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', TIMED_OUT);
  assert.match(s.message ?? '', /之前发现的 v0\.1\.2 仍可更新/);
  assert.equal(s.availableBuild, '0.1.2');
  assert.equal(s.canUpdate, true);
  assert.equal(s.canCheck, true);
  assert.equal(s.checkFailed, true, '界面据此显示“重试”');
  assert.equal(s.notice, false, '已提醒过的构建不再弹出');
  // 普通失败
  u.check();
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 2001, error: '网络不可用' });
  s = u.getState();
  assert.match(s.message ?? '', /检查艾泽魔方新版本失败：网络不可用；之前发现的 v0\.1\.2 仍可更新/);
  assert.equal(s.checkFailed, true);
  assert.equal(s.canUpdate, true);
  // 仍可按之前的版本更新；更新失败（不是检查失败）不显示检查的“重试”
  u.update('0.1.2');
  assert.equal(bridge.count('beginUpdate'), 1);
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 3, error: '下载失败' });
  s = u.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.canUpdate, true);
  assert.equal(s.checkFailed, false);
});

test('重复点击与取消：检查中再次检查不发起新的原生检查；cancel() 不作用于检查；每日检查在屏障期间不执行', () => {
  const { bridge, clock, u } = setup();
  u.check();
  u.check();
  u.check();
  assert.equal(bridge.count('probe'), 1);
  assert.equal(u.getState().canCancel, false);
  u.cancel();
  assert.equal(bridge.count('cancel'), 0, '检查没有更新会话的取消');
  clock.advance(CHECK_TIMEOUT_MS);
  u.check(); // 例如每日检查在停止期间触发
  u.cancel();
  assert.equal(bridge.count('probe'), 1);
  assert.equal(bridge.count('cancel'), 0);
  assert.equal(bridge.cancelProbes().length, 1);
});

test('检查期间收到发现更新或准备安装的事件：不冻结、不安装', async () => {
  const { bridge, gate, u } = setup();
  u.check();
  send(u, { type: 'update-found', authorized: false, version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'ready' });
  send(u, { type: 'download-start' });
  await tick();
  assert.equal(u.getState().status, 'checking');
  assert.equal(gate.frozen, false);
  assert.doesNotThrow(() => gate.enter()());
  assert.equal(bridge.count('installNow'), 0);
});

test('原生拒绝检查：报错并可重试；会话编号在检查与更新之间严格递增、不复用', () => {
  const { bridge, u } = setup();
  bridge.probeOk = false;
  let s = u.check();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', /暂时无法检查艾泽魔方新版本/);
  assert.equal(s.canCheck, true);
  assert.equal(s.checkFailed, true);
  bridge.probeOk = true;
  probeFound(u);
  u.update();
  send(u, { type: 'not-found' });
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  s = u.check();
  assert.deepEqual(bridge.sessions, [1, 2, 3, 4]);
  assert.equal(s.status, 'checking');
});

test('授权更新会话不受检查预算影响：下载超过 30 秒不会被取消', () => {
  const { bridge, clock, u } = setup();
  probeFound(u);
  u.update();
  send(u, { type: 'download-progress', received: 1, total: 100 });
  clock.advance(10 * CHECK_TIMEOUT_MS);
  assert.equal(u.getState().status, 'downloading');
  assert.equal(u.getState().canCancel, true);
  assert.deepEqual(bridge.cancelProbes(), []);
});

// ---------- 0.1.6 复核：排队的旧回调、取消异常、appcast-loaded、无结果的周期结束 ----------

test('已排队的旧会话检查计时回调在新会话开始后执行：不清掉新会话的句柄，新会话结束后没有残留计时', () => {
  const { clock, u } = setup();
  u.check(); // A
  const [staleA] = clock.callbacks();
  assert.equal(clock.pending, 1);
  send(u, { type: 'no-update' });
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  assert.equal(clock.pending, 0);
  u.check(); // B
  assert.equal(clock.pending, 1);
  staleA(); // A 的回调已被清除但仍执行了一次
  assert.equal(u.getState().status, 'checking', '旧回调不改变 B 的状态');
  send(u, { type: 'no-update' });
  send(u, { type: 'cycle-finished', check: 'user', errorCode: 1001 });
  assert.equal(u.getState().status, 'up-to-date');
  assert.equal(clock.pending, 0, 'B 结束时清除了自己的检查计时');
});

test('已排队的旧会话停止宽限回调在新会话停止期间执行：不清掉新会话的宽限句柄，也不提前提示', () => {
  const { clock, u } = setup();
  u.check(); // A
  clock.advance(CHECK_TIMEOUT_MS);
  const [staleGraceA] = clock.callbacks();
  send(u, { type: 'cycle-finished', check: 'user' });
  assert.equal(clock.pending, 0);
  u.check(); // B
  clock.advance(CHECK_TIMEOUT_MS);
  assert.equal(clock.pending, 1, 'B 的停止宽限');
  staleGraceA();
  assert.match(u.getState().message ?? '', STOPPING, 'A 的宽限回调不会让 B 提前显示无法停止');
  send(u, { type: 'cycle-finished', check: 'user' });
  assert.match(u.getState().message ?? '', TIMED_OUT);
  assert.equal(clock.pending, 0, 'B 结束时清除了自己的宽限计时');
});

test('请求取消时原生桥抛出异常：异常不外泄，仍进入停止屏障；宽限到期提示重新打开；迟到的周期结束仍可解除', (t) => {
  const { bridge, clock, u } = setup();
  const warn = t.mock.method(console, 'warn', () => undefined);
  bridge.cancelProbeImpl = () => {
    throw new Error('含有不应记录的细节 https://example.invalid/?q=secret');
  };
  u.check();
  assert.doesNotThrow(() => clock.advance(CHECK_TIMEOUT_MS));
  let s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', STOPPING);
  assert.equal(s.canCheck, false, '取消失败不等于检查已结束');
  assert.equal(clock.pending, 1, '停止宽限已建立');
  assert.equal(warn.mock.callCount(), 1);
  const logged = JSON.stringify(warn.mock.calls[0].arguments);
  assert.match(logged, /"session":1/);
  assert.doesNotMatch(logged, /secret|example\.invalid|不应记录/, '只记录会话编号与异常类型');
  clock.advance(STOP_GRACE_MS);
  s = u.getState();
  assert.match(s.message ?? '', STUCK);
  assert.equal(s.canCheck, false);
  send(u, { type: 'valid-update', version: '0.1.2', displayVersion: '0.1.2' });
  send(u, { type: 'cycle-finished', check: 'user' });
  s = u.getState();
  assert.match(s.message ?? '', TIMED_OUT);
  assert.equal(s.availableBuild, null, '作废检查的结果仍不采用');
  assert.equal(s.canCheck, true);
});

test('请求取消期间同步收到该会话的周期结束：结束状态不会被之后的代码覆盖', () => {
  const { bridge, clock, u } = setup();
  bridge.cancelProbeImpl = () => {
    send(u, { type: 'cycle-finished', check: 'user' });
    return 'cancelled';
  };
  u.check();
  clock.advance(CHECK_TIMEOUT_MS);
  const s = u.getState();
  assert.match(s.message ?? '', TIMED_OUT);
  assert.equal(s.canCheck, true);
  assert.equal(clock.pending, 0, '停止宽限已随周期结束清除');
  clock.advance(STOP_GRACE_MS);
  assert.match(u.getState().message ?? '', TIMED_OUT, '不会再显示“正在停止”或“无法停止”');
});

test('appcast-loaded：只用于诊断，不改变状态、期限，也不授权下载', () => {
  const { bridge, clock, u } = setup();
  u.check();
  clock.advance(10_000);
  const rev = u.getState().rev;
  send(u, { type: 'appcast-loaded' });
  bridge.onEvent?.(JSON.stringify({ type: 'appcast-loaded', session: 1, intent: 'probe' }));
  assert.equal(u.getState().status, 'checking');
  assert.equal(u.getState().rev, rev, '没有状态变化');
  clock.advance(CHECK_TIMEOUT_MS - 10_000 - 1);
  assert.deepEqual(bridge.cancelProbes(), [], '期限没有被延长或缩短');
  clock.advance(1);
  assert.deepEqual(bridge.cancelProbes(), ['cancelProbe:1']);
  send(u, { type: 'cycle-finished', check: 'user' });
  // 授权更新会话中同样只是诊断事件
  probeFound(u);
  u.update();
  const before = u.getState();
  send(u, { type: 'appcast-loaded' });
  assert.equal(u.getState().status, before.status);
  assert.equal(u.getState().rev, before.rev);
  assert.equal(bridge.count('installNow'), 0);
});

test('检查周期结束但没有结果也没有错误：显示失败，不报告已是最新', () => {
  const { u } = setup();
  u.check();
  send(u, { type: 'cycle-finished', check: 'user' });
  const s = u.getState();
  assert.equal(s.status, 'error');
  assert.match(s.message ?? '', /检查艾泽魔方新版本失败：未知错误/);
  assert.equal(s.checkFailed, true);
  assert.equal(s.canCheck, true);
});
