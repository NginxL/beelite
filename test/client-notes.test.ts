// 客户端新版本的更新说明与构建绑定（0.1.3）：真实 ClientUpdater + 假原生桥。
// 覆盖：版本、构建号与说明来自同一事件并整体替换；每个构建只提醒一次；“稍后”不调用原生；
// 授权绑定构建号，原生上报 build-changed 时不下载、不安装，旧周期结束后展示新构建的说明并等待用户重新点击。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientUpdater, MAX_NOTES_CHARS, normalizeNotes, type BridgeEvent, type SparkleBridge } from '../src/core/client-update';
import { MutationGate } from '../src/core/gate';

class FakeBridge implements SparkleBridge {
  calls: string[] = [];
  init() {
    this.calls.push('init');
    return { ok: true };
  }
  probe() {
    this.calls.push('probe');
    return true;
  }
  beginUpdate(build: string) {
    this.calls.push(`beginUpdate:${build}`);
    return true;
  }
  installNow() {
    this.calls.push('installNow');
    return true;
  }
  cancel() {
    this.calls.push('cancel');
    return true;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const bridge = new FakeBridge();
  const gate = new MutationGate();
  const u = new ClientUpdater({ bridge, gate, currentVersion: '0.1.3' });
  u.start();
  return { bridge, gate, u };
}

function probe(u: ClientUpdater, ev: Partial<Extract<BridgeEvent, { type: 'valid-update' }>> | null) {
  u.check();
  if (ev) u.handle({ type: 'valid-update', version: '0.1.4', displayVersion: '0.1.4', ...ev });
  else u.handle({ type: 'no-update' });
  u.handle({ type: 'cycle-finished', check: 'probe', errorCode: ev ? undefined : 1001 });
}

test('说明与版本来自同一条目：新构建整体替换，缺说明时不沿用旧说明', () => {
  const { u } = setup();
  probe(u, { notes: '0.1.4 的说明', notesState: 'ok' });
  let s = u.getState();
  assert.equal(s.availableBuild, '0.1.4');
  assert.equal(s.availableVersion, '0.1.4');
  assert.equal(s.releaseNotes, '0.1.4 的说明');
  assert.equal(s.notesState, 'ok');
  probe(u, { version: '0.1.5', displayVersion: '0.1.5' });
  s = u.getState();
  assert.equal(s.availableBuild, '0.1.5');
  assert.equal(s.releaseNotes, null, '0.1.5 没有说明时不能显示 0.1.4 的说明');
  assert.equal(s.notesState, 'missing');
  probe(u, null);
  s = u.getState();
  assert.equal(s.status, 'up-to-date');
  assert.equal(s.availableBuild, null);
  assert.equal(s.releaseNotes, null);
  assert.equal(s.notice, false);
});

test('说明规范化：只接受纯文本；控制字符去除；超长截断并标记；未验证、非纯文本或状态未知时没有正文', () => {
  assert.deepEqual(normalizeNotes({ notes: '  a\r\nb\u0007c  ', notesState: 'ok' }), { notes: 'a\nbc', notesState: 'ok', truncated: false });
  const long = normalizeNotes({ notes: '字'.repeat(MAX_NOTES_CHARS + 10), notesState: 'ok' });
  assert.equal(long.notes?.length, MAX_NOTES_CHARS);
  assert.equal(long.truncated, true);
  const emoji = normalizeNotes({ notes: `${'a'.repeat(MAX_NOTES_CHARS - 1)}😀😀`, notesState: 'ok' });
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji.notes ?? ''), '不在代理对中间截断');
  assert.equal(normalizeNotes({ notes: '短', notesState: 'ok', notesTruncated: true }).truncated, true, '原生已截断的标记保留');
  for (const st of ['unverified', 'unsupported', 'missing']) {
    assert.deepEqual(normalizeNotes({ notes: '不应显示', notesState: st }), { notes: null, notesState: st, truncated: false });
  }
  assert.equal(normalizeNotes({ notes: '<b>x</b>', notesState: 'html' }).notesState, 'missing', '未知状态按未提供处理');
  assert.equal(normalizeNotes({ notes: '   ', notesState: 'ok' }).notesState, 'missing');
  assert.equal(normalizeNotes({ notesState: 'ok' }).notesState, 'missing');
});

test('提醒：每个构建在本次启动只提醒一次；“稍后”只记录已提醒，不调用原生、不取消、不跳过；新构建再次提醒', () => {
  const { bridge, u } = setup();
  probe(u, { notes: 'n', notesState: 'ok' });
  assert.equal(u.getState().notice, true);
  const calls = [...bridge.calls];
  u.ackNotice('0.1.5'); // 不是当前构建：无效
  assert.equal(u.getState().notice, true);
  u.ackNotice('0.1.4');
  assert.equal(u.getState().notice, false);
  assert.equal(u.getState().canUpdate, true);
  assert.deepEqual(bridge.calls, calls, '稍后不调用原生');
  probe(u, { notes: 'n', notesState: 'ok' });
  assert.equal(u.getState().notice, false, '同一构建再次探测到也不再提醒');
  probe(u, { version: '0.1.5', displayVersion: '0.1.5' });
  assert.equal(u.getState().notice, true, '新构建再次提醒');
});

test('授权绑定构建号：不一致时不开始；一致时把构建号交给原生；点击更新即视为已提醒', () => {
  const { bridge, u } = setup();
  probe(u, { notes: 'n', notesState: 'ok' });
  const before = u.getState().rev ?? 0;
  let s = u.update('0.1.3');
  assert.equal(s.status, 'available');
  assert.ok(!bridge.calls.some((c) => c.startsWith('beginUpdate')));
  assert.ok((s.rev ?? 0) > before);
  s = u.update('0.1.4');
  assert.equal(s.status, 'downloading');
  assert.deepEqual(bridge.calls.filter((c) => c.startsWith('beginUpdate')), ['beginUpdate:0.1.4']);
  assert.equal(s.notice, false);
});

test('授权会话中服务器变为另一个构建：不下载、不安装，闸门不冻结；旧周期结束后展示新构建与它自己的说明，需要重新点击', async () => {
  const { bridge, gate, u } = setup();
  probe(u, { notes: 'A 版说明', notesState: 'ok' });
  u.ackNotice('0.1.4');
  u.update('0.1.4');
  // 原生：发现 0.1.5，与授权的 0.1.4 不同 → build-changed，随后 update-found(authorized=false) 并回复 Dismiss
  u.handle({ type: 'build-changed', version: '0.1.5', displayVersion: '0.1.5', notes: 'B 版说明', notesState: 'ok' });
  u.handle({ type: 'update-found', authorized: false, version: '0.1.5', displayVersion: '0.1.5' });
  let s = u.getState();
  assert.equal(s.status, 'available');
  assert.equal(s.availableBuild, '0.1.5');
  assert.equal(s.releaseNotes, 'B 版说明', '不能用 A 版说明');
  assert.match(s.message ?? '', /已变为 v0\.1\.5，未下载/);
  assert.equal(s.canUpdate, false, '旧周期结束前不能重新更新');
  // 旧周期的残余事件不会触发安装
  u.handle({ type: 'download-start' });
  u.handle({ type: 'ready' });
  await tick();
  assert.equal(gate.frozen, false);
  assert.ok(!bridge.calls.includes('installNow'));
  u.handle({ type: 'cycle-finished', check: 'user' });
  s = u.getState();
  assert.equal(s.canUpdate, true);
  assert.equal(s.notice, true, '新构建需要重新提醒');
  assert.equal(s.status, 'available');
  // 用户看过 B 的说明后重新点击：授权 B
  u.update('0.1.5');
  assert.deepEqual(bridge.calls.filter((c) => c.startsWith('beginUpdate')), ['beginUpdate:0.1.4', 'beginUpdate:0.1.5']);
  assert.ok(!bridge.calls.includes('cancel'), '整个过程没有取消或跳过');
});

test('原生条目字段不合法时不形成可更新条目（构建号格式校验）', () => {
  const { u } = setup();
  probe(u, { version: '0.1.4"><script>', displayVersion: 'x' });
  assert.equal(u.getState().availableBuild, null);
  assert.equal(u.getState().canUpdate, false);
});

test('状态序号：每次状态变化 rev 递增，界面据此丢弃过时的回复', () => {
  const { u } = setup();
  const r0 = u.getState().rev ?? 0;
  probe(u, { notes: 'n', notesState: 'ok' });
  const r1 = u.getState().rev ?? 0;
  assert.ok(r1 > r0);
  u.ackNotice('0.1.4');
  assert.ok((u.getState().rev ?? 0) > r1);
});
