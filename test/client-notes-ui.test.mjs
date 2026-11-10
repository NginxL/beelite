// 客户端更新说明弹窗（0.1.3）：编译后的渲染层 client-update.js + 极简假 DOM + 窄假接口。
// 覆盖：自动弹出一次、默认焦点“稍后”、纯文本说明、“稍后”只发送已读回执、侧栏可重开、只有点击才授权并带上构建号、
// 与已有确认框（含两次确认之间）和进行中的操作互斥、说明缺失/过长/非纯文本、构建已变化时不更新、状态按 rev 防倒退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, FakeElement, installFakeDom, openModals, toasts } from './fake-dom.mjs';

let focused = null;
FakeElement.prototype.focus = function focus() {
  focused = this;
};

const calls = [];
let push = null;
let rev = 0;
const stateOf = (o = {}) => ({
  status: 'available', currentVersion: '0.1.3', availableVersion: '0.1.4', availableBuild: '0.1.4',
  releaseNotes: '修复 <script>alert(1)</script> & 改进', notesState: 'ok', notesTruncated: false, notice: true,
  percent: null, message: null, canCheck: true, canUpdate: true, canCancel: false, rev: ++rev, ...o,
});
let latest = stateOf({ notice: false });
const api = {
  clientState: async () => latest,
  clientCheck: async () => latest,
  clientCancel: async () => (calls.push(['cancel']), latest),
  clientUpdate: async (b) => (calls.push(['update', b]), (latest = stateOf({ status: 'downloading', canUpdate: false, canCheck: false, notice: false }))),
  // 与主进程一致：只清除同一构建的提醒
  clientAckNotice: async (b) => (calls.push(['ack', b]), latest.availableBuild === b ? (latest = { ...latest, notice: false, rev: ++rev }) : latest),
  onClientState: (cb) => ((push = cb), () => undefined),
};
const dom = installFakeDom(api);
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web', 'renderer');
const C = await import(path.join(web, 'client-update.js'));
const D = await import(path.join(web, 'dom.js'));
const S = await import(path.join(web, 'state.js'));
const tick = () => new Promise((r) => setImmediate(r));
const sidebar = () => globalThis.document.getElementById('client-update');
const sideButton = (label) => sidebar().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const notesOf = (overlay) => overlay.all().find((e) => e.className === 'modal-notes');
const reset = () => {
  dom.modalRoot().replaceChildren();
  dom.toastRoot().replaceChildren();
  calls.length = 0;
  S.state.busy.clear();
  // 0.1.5：主进程插件操作状态已取得且没有进行中的操作（真实启动时界面先取得这个状态）
  S.state.activity = idle();
  S.state.activityError = null;
};
let activityRev = 0;
const idle = (o = {}) => ({ instance: 'notes-test', rev: ++activityRev, batches: [], tasks: [], reservations: [], ...o });
const show = async (o) => {
  latest = stateOf(o);
  push(latest);
  await tick();
};

C.initClientUpdate();
await tick();

test('自动弹出：纯文本说明、默认焦点“稍后”；稍后只发送已读回执，不更新、不取消', async () => {
  reset();
  await show({});
  C.maybePromptNotes();
  const open = openModals(dom);
  assert.equal(open.length, 1);
  assert.match(open[0].textContent, /艾泽魔方 v0\.1\.4 可用/);
  assert.match(open[0].textContent, /当前版本 v0\.1\.3/);
  const notes = notesOf(open[0]);
  assert.equal(notes.textContent, '修复 <script>alert(1)</script> & 改进');
  assert.ok(notes.childNodes.every((n) => !(n instanceof FakeElement)), '说明只作为文本写入，不生成任何元素');
  assert.equal(focused?.textContent, '稍后', '默认焦点在“稍后”');
  clickModalButton(dom, '稍后');
  await tick();
  assert.deepEqual(calls, [['ack', '0.1.4']]);

  // 同一构建：即使主进程状态仍带提醒（例如回执尚未处理），本界面也不再自动弹出
  dom.modalRoot().replaceChildren();
  await show({});
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 0);
});

test('侧栏“更新说明”可重新打开；只有点击“下载并更新”才授权，并带上弹窗展示的构建号', async () => {
  reset();
  await show({ notice: false });
  const btn = sideButton('更新说明');
  assert.ok(btn && !btn.classList.contains('hidden'));
  btn.click();
  assert.equal(openModals(dom).length, 1);
  assert.deepEqual(calls, [['ack', '0.1.4']], '打开说明只发送已展示回执，不会更新');
  clickModalButton(dom, '下载并更新');
  await tick();
  await tick();
  assert.deepEqual(calls, [['ack', '0.1.4'], ['update', '0.1.4']]);
});

test('互斥：已有确认框或进行中的操作时不弹出；两次确认之间也不会插入；条件满足后再弹出', async () => {
  reset();
  await show({ availableVersion: '0.1.5', availableBuild: '0.1.5' });
  void D.confirmDialog({ title: '卸载「X」？', message: 'm', danger: true });
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 1);
  assert.match(openModals(dom)[0].textContent, /卸载/);
  clickModalButton(dom, '取消');
  dom.modalRoot().replaceChildren();

  // 永久删除的两次确认：第一次确认后紧接着打开第二次，期间不能插入更新说明
  const flow = (async () => {
    if (!(await D.confirmDialog({ title: '永久删除回收站条目？', message: 'm', danger: true, confirmText: '继续' }))) return;
    await D.confirmDialog({ title: '再次确认', message: 'm2', danger: true, confirmText: '永久删除' });
  })();
  clickModalButton(dom, '继续');
  await tick();
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 1);
  assert.match(openModals(dom)[0].textContent, /再次确认/);
  clickModalButton(dom, '取消');
  await flow;
  dom.modalRoot().replaceChildren();

  S.state.busy.add('mod:1'); // 插件安装进行中（可能伴随主进程的确认框）
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 0);
  S.state.busy.clear();
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 1);
  assert.match(openModals(dom)[0].textContent, /v0\.1\.5/);
  clickModalButton(dom, '稍后');
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'update' || c[0] === 'cancel'));
});

test('说明缺失、非纯文本、签名未通过时显示明确的占位；过长时注明已截断', async () => {
  const cases = [
    [{ releaseNotes: null, notesState: 'missing' }, /此版本未提供更新说明/],
    [{ releaseNotes: null, notesState: 'unsupported' }, /不是纯文本格式/],
    [{ releaseNotes: null, notesState: 'unverified' }, /签名未通过校验/],
  ];
  let n = 6;
  for (const [o, re] of cases) {
    reset();
    const v = `0.1.${n++}`;
    await show({ ...o, availableVersion: v, availableBuild: v });
    C.maybePromptNotes();
    assert.match(notesOf(openModals(dom)[0]).textContent, re);
    clickModalButton(dom, '稍后');
  }
  reset();
  await show({ releaseNotes: '长'.repeat(4000), notesTruncated: true, availableVersion: '0.2.0', availableBuild: '0.2.0' });
  C.maybePromptNotes();
  assert.match(openModals(dom)[0].textContent, /已截断显示/);
  clickModalButton(dom, '稍后');
});

test('弹窗打开期间新版本构建已变化：点击“下载并更新”不会更新旧构建，提示重新查看', async () => {
  reset();
  await show({ availableVersion: '0.3.0', availableBuild: '0.3.0' });
  C.maybePromptNotes();
  await show({ availableVersion: '0.3.1', availableBuild: '0.3.1', releaseNotes: '另一版本' });
  clickModalButton(dom, '下载并更新');
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'update'), '没有以旧说明授权新构建');
  assert.ok(toasts(dom).some((t) => /新版本信息已变化/.test(t)));
});

test('正在下载或安装时不弹出；过时的状态（rev 更小）不覆盖较新的状态', async () => {
  reset();
  await show({ status: 'downloading', canUpdate: false, availableVersion: '0.4.0', availableBuild: '0.4.0' });
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 0);
  const newer = stateOf({ status: 'available', availableVersion: '0.4.1', availableBuild: '0.4.1', notice: false });
  const older = { ...newer, availableVersion: '0.3.9', availableBuild: '0.3.9', rev: newer.rev - 5 };
  push(newer);
  push(older);
  const status = sidebar().all().find((e) => e.className.includes('client-status'));
  assert.match(status.textContent, /v0\.4\.1/);
});

test('说明一显示就发送已展示回执；说明打开时重新载入界面，同一构建不会再次自动弹出；回执不授权下载', async () => {
  reset();
  await show({ availableVersion: '0.5.0', availableBuild: '0.5.0' });
  C.maybePromptNotes();
  assert.equal(openModals(dom).length, 1);
  await tick();
  assert.deepEqual(calls, [['ack', '0.5.0']], '弹窗还开着时已经回执');
  // 模拟“重新载入”：界面清空，加载新的界面模块实例，主进程状态保留
  dom.modalRoot().replaceChildren();
  const C2 = await import(path.join(web, 'client-update.js') + '?reload=1');
  C2.initClientUpdate();
  await tick();
  C2.maybePromptNotes();
  assert.equal(openModals(dom).length, 0, '重新载入后不再自动弹出');
  assert.ok(!calls.some((c) => c[0] === 'update'));
});

test('手动打开更新说明同样不叠在已有确认框上，也不插进进行中的操作', async () => {
  reset();
  await show({ notice: false, availableVersion: '0.5.1', availableBuild: '0.5.1' });
  void D.confirmDialog({ title: '永久删除回收站条目？', message: 'm', danger: true, confirmText: '继续' });
  sideButton('更新说明').click();
  assert.equal(openModals(dom).length, 1);
  assert.match(openModals(dom)[0].textContent, /永久删除/);
  assert.ok(toasts(dom).some((t) => /请先完成当前的确认或操作/.test(t)));
  clickModalButton(dom, '取消');
  dom.modalRoot().replaceChildren();
  S.state.busy.add('mod:1');
  sideButton('更新说明').click();
  assert.equal(openModals(dom).length, 0);
  S.state.busy.clear();
  sideButton('更新说明').click();
  assert.equal(openModals(dom).length, 1);
  clickModalButton(dom, '稍后');
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'update'));
});

// 0.1.5 的用例使用新的界面模块实例（上面的重新载入用例已让另一个实例接管侧栏与状态推送）
let Cn = null;
async function freshNotes() {
  if (!Cn) {
    Cn = await import(path.join(web, 'client-update.js') + '?reload=activity');
    Cn.initClientUpdate();
    await tick();
  }
  return Cn;
}

test('0.1.5 重新载入后本界面没有本地占用、但主进程有进行中的批次 / 下载任务 / 卸载时：不自动弹出说明、不回执、不更新；结束后才弹出，只回执', async () => {
  const root = '/fixture/A/_forever_';
  const busyStates = [
    { batches: [{ batchId: 'b1', flavorId: 9, root, stage: 'checking' }] },
    { tasks: [{ taskId: 't1', label: 'x', flavorId: 9, root, modId: '1', phase: 'downloading', received: 35, total: 100, batchId: null }] },
    { reservations: [{ flavorId: 6, root: '/fixture/B/_classic_', modId: '2', kind: 'uninstall' }] },
  ];
  const Cn = await freshNotes();
  let n = 0;
  for (const busy of busyStates) {
    reset();
    await show({ availableVersion: `0.6.${n}`, availableBuild: `0.6.${n++}` });
    assert.equal(S.state.busy.size, 0, '本界面没有本地占用（重新载入后的情形）');
    assert.equal(S.applyActivity(idle(busy)), true);
    Cn.maybePromptNotes();
    assert.equal(openModals(dom).length, 0, `后台有进行中的操作时不弹出：${Object.keys(busy)[0]}`);
    sideButton('更新说明').click();
    assert.equal(openModals(dom).length, 0, '手动打开说明同样等待');
    await tick();
    assert.deepEqual(calls, [], '没有回执，也没有更新');
    // 后台操作结束（推送空状态）
    assert.equal(S.applyActivity(idle()), true);
    Cn.maybePromptNotes();
    assert.equal(openModals(dom).length, 1);
    clickModalButton(dom, '稍后');
    await tick();
    assert.deepEqual(calls.map((c) => c[0]), ['ack'], '只回执，不更新');
  }
});

test('0.1.5 主进程插件操作状态：首次同步尚未完成时推迟自动说明；获取失败时不因此无限推迟；侧栏“下载并更新”不受影响', async () => {
  const Cn = await freshNotes();
  reset();
  S.state.activity = null;
  await show({ availableVersion: '0.7.0', availableBuild: '0.7.0' });
  Cn.maybePromptNotes();
  assert.equal(openModals(dom).length, 0, '同步中：推迟');
  S.state.activityError = '读取失败（测试）';
  Cn.maybePromptNotes();
  assert.equal(openModals(dom).length, 1, '获取失败：照常展示说明');
  clickModalButton(dom, '稍后');
  await tick();
  assert.deepEqual(calls.map((c) => c[0]), ['ack']);
  // 后台有进行中的操作时，用户明确点击侧栏“下载并更新”仍按原流程授权该构建（安装前的等待由主进程的写入闸门负责）
  reset();
  S.applyActivity(idle({ reservations: [{ flavorId: 9, root: '/fixture/A/_forever_', modId: '1', kind: 'update' }] }));
  await show({ notice: false, availableVersion: '0.7.1', availableBuild: '0.7.1' });
  sideButton('下载并更新').click();
  await tick();
  assert.deepEqual(calls, [['update', '0.7.1']]);
});
