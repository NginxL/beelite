// 本地 WTF 恢复界面（0.3.0）：编译后的 renderer/restore.js、backup.js + 假 DOM + 合成的 window.beelite（不经过真实 IPC，演示数据）。
// 未完成恢复：启动只读查询、查询失败 / 登记损坏不当作正常、未登记只读、处理只提交 txid 与 gameClosed、完成后只重新查询（不读插件本地状态）；
// 预览：只在点击后请求一次、两项确认初始未勾、只提交 token 与确认、blockers 与 A→B→A 作废、进行中 Esc 不关闭、不可取消阶段禁用取消；
// 结果按主进程 outcome 显示并常驻；取消请求失败时只在同一任务仍可取消时恢复重试，进入不可取消阶段后不恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeDom, openModals, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dom = installFakeDom(null);
// 记录文档级键盘监听，测试中派发 Esc
const docKeys = new Set();
globalThis.document.addEventListener = (ev, fn) => {
  if (ev === 'keydown') docKeys.add(fn);
};
globalThis.document.removeEventListener = (ev, fn) => {
  if (ev === 'keydown') docKeys.delete(fn);
};
const press = (key) => {
  const e = { key, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
  for (const fn of [...docKeys]) fn(e);
  return e;
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

const F = 9;
const A = '/demo/A';
const B = '/demo/B';

const calls = [];
const handlers = {};
globalThis.window.beelite = new Proxy({}, {
  get(_t, name) {
    return (...args) => {
      calls.push({ name, args });
      const fn = handlers[name];
      if (!fn) return Promise.reject(new Error(`演示：未提供 ${String(name)}`));
      return fn(...args);
    };
  },
});
const called = (name) => calls.filter((c) => c.name === name);

const web = process.env.AZERCUBE_WEB_DIR || path.join(here, '..', 'dist', 'web');
const S = await import(pathToFileURL(path.join(web, 'renderer', 'state.js')).href);
const B_ = await import(pathToFileURL(path.join(web, 'renderer', 'backup.js')).href);
const R = await import(pathToFileURL(path.join(web, 'renderer', 'restore.js')).href);

function setTarget(root) {
  S.state.flavorId = F;
  S.state.localError = null;
  S.state.local = { flavorId: F, profile: { flavorId: F, root, addonsPath: null }, dir: null, managed: [], unmanaged: [], recovery: [], cleanup: null, error: null };
  S.emit('local');
}

const SNAP = {
  id: '20261101-120000-demo',
  createdAt: 1_761_998_400_000,
  appVersion: '0.3.0',
  flavorId: F,
  fileCount: 3,
  dirCount: 2,
  totalBytes: 300,
  scope: { kind: 'characters', account: 'DEMOACCOUNT', characters: [{ realm: '演示服', character: '演示角色' }] },
  actualBytes: 400,
  status: 'structure-ok',
  reason: null,
  lastVerify: null,
};

let tokenSeq = 0;
function preview(o = {}) {
  return {
    token: `tok-${++tokenSeq}`,
    expiresAt: Date.now() + 60_000,
    flavorId: F,
    root: A,
    snapshotId: SNAP.id,
    snapshotCreatedAt: SNAP.createdAt,
    snapshotAppVersion: '0.3.0',
    scope: SNAP.scope,
    baseline: 'present',
    counts: { addFiles: 1, overwriteFiles: 2, sameFiles: 3, deleteFiles: 1, addDirs: 0, deleteDirs: 1, writeBytes: 2048, deleteBytes: 512 },
    samples: { add: ['Account/DEMOACCOUNT/<img src=x>.lua'], overwrite: ['Account/DEMOACCOUNT/SavedVariables/a.lua'], delete: ['Account/DEMOACCOUNT/演示服/新角色'], truncated: true },
    kept: { files: 10, dirs: 4, bytes: 9000 },
    candidate: { files: 12, dirs: 6, bytes: 10_000 },
    current: { files: 12, dirs: 6, bytes: 9500 },
    safetyCopy: { required: true, bytes: 9500, entries: 18 },
    space: { backupVolumeNeeded: 9500, backupVolumeFree: 1e9, gameVolumeNeeded: 10_000, gameVolumeFree: null, sameVolume: false },
    notes: ['按角色恢复会恢复账号共享的 SavedVariables（演示）'],
    blockers: [],
    ...o,
  };
}

const emptyPending = () => ({ registryError: null, items: [], receipts: [], scanErrors: [], boundRootsError: null });

const modal = () => {
  const open = openModals(dom);
  assert.equal(open.length, 1, '应恰好有一个打开的对话框');
  return open[0];
};
const btn = (label) => modal().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const inputs = () => modal().all().filter((e) => e.tagName === 'INPUT');
const check = (el) => {
  el.checked = true;
  for (const fn of el.listeners.change ?? []) fn({ target: el });
};
const banner = globalThis.document.getElementById('restore-warning');

R.initRestore(banner);

test('启动查询失败：提示条显示原因与重试，不当作没有未完成的恢复，预览受阻', async () => {
  handlers.backupRestorePending = async () => {
    throw new Error('演示：登记读取失败');
  };
  await R.refreshPending();
  assert.ok(!banner.classList.contains('hidden'));
  assert.match(banner.textContent, /无法查询是否有未完成的 WTF 恢复/);
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }));
  assert.equal(R.restoreNavBadge(), '待处理');
});

test('登记损坏而列表为空：仍然提醒并禁止恢复', async () => {
  handlers.backupRestorePending = async () => ({ ...emptyPending(), registryError: '演示：registry 损坏' });
  await R.refreshPending();
  assert.match(banner.textContent, /恢复登记无法读取/);
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }));
});

test('先查询成功（为空）再查询失败：提示条与侧栏标记显示错误与重试，恢复受阻；重试成功后恢复正常', async () => {
  handlers.backupRestorePending = async () => emptyPending();
  await R.refreshPending();
  assert.ok(banner.classList.contains('hidden'), '确认没有未完成的恢复时隐藏');
  assert.equal(R.restoreNavBadge(), null);
  assert.equal(R.restoreBlockReason({ flavorId: F, root: A }), null);

  handlers.backupRestorePending = async () => {
    throw new Error('演示：刷新失败');
  };
  await R.refreshPending();
  assert.ok(!banner.classList.contains('hidden'), '之前为空也要显示刷新失败');
  assert.match(banner.textContent, /未能刷新：演示：刷新失败/);
  assert.equal(R.restoreNavBadge(), '待处理');
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }), '刷新失败时不能恢复');
  const bannerButtons = banner.all().filter((e) => e.tagName === 'BUTTON' && !e.classList.contains('hidden'));
  const retry = bannerButtons.find((e) => e.textContent === '重试');
  assert.ok(retry, '有重试按钮');
  assert.ok(bannerButtons.some((e) => e.textContent === '查看未完成的恢复'), '仍可查看上次的结果');

  // 恢复受阻时不打开预览，不请求主进程
  setTarget(A);
  const before = called('backupRestorePreview').length;
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  assert.equal(openModals(dom).length, 0);
  assert.equal(called('backupRestorePreview').length, before);

  handlers.backupRestorePending = async () => emptyPending();
  const n = called('backupRestorePending').length;
  retry.click();
  await tick();
  assert.equal(called('backupRestorePending').length, n + 1);
  assert.ok(banner.classList.contains('hidden'), '重试成功后隐藏');
  assert.equal(R.restoreBlockReason({ flavorId: F, root: A }), null);
});

test('预览：点击后请求一次；两项确认初始未勾；只提交 token 与确认；结果按 outcome 常驻', async () => {
  handlers.backupRestorePending = async () => emptyPending();
  await R.refreshPending();
  assert.ok(banner.classList.contains('hidden'), '确认没有未完成的恢复时隐藏');
  setTarget(A);
  const p = preview();
  const pd = deferred();
  handlers.backupRestorePreview = () => pd.promise;
  let focusedBack = 0;
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => focusedBack++);
  assert.deepEqual(called('backupRestorePreview').at(-1).args, [F, A, SNAP.id]);
  assert.equal(R.restoreFlow().stage, 'previewing');
  // 进行中 Esc 不关闭
  press('Escape');
  assert.equal(openModals(dom).length, 1);
  assert.equal(focusedBack, 0);

  pd.resolve({ status: 'completed', result: p });
  await tick();
  assert.equal(R.restoreFlow().stage, 'preview');
  const text = modal().textContent;
  assert.match(text, /共享的 SavedVariables/, '角色范围醒目提示账号共享配置');
  assert.ok(text.includes('<img src=x>.lua'), '路径按纯文本显示');
  assert.match(text, /恢复前备份/);
  const [g, o] = inputs();
  assert.equal(g.checked, false);
  assert.equal(o.checked, false);
  assert.equal(btn('执行恢复').disabled, true);
  check(inputs()[0]);
  assert.equal(btn('执行恢复').disabled, true, '只勾一项仍不能执行');
  check(inputs()[1]);
  assert.equal(btn('执行恢复').disabled, false);

  const ad = deferred();
  handlers.backupRestoreApply = () => ad.promise;
  btn('执行恢复').click();
  const apply = called('backupRestoreApply');
  assert.equal(apply.length, 1);
  assert.deepEqual(apply[0].args, [p.token, { gameClosed: true, overwrite: true }], '只提交 token 与确认');
  assert.equal(R.restoreFlow().stage, 'applying');
  // 不可取消阶段：取消按钮禁用
  B_.applyBackupTask({ rev: 100, task: { id: 't1', kind: 'restore', flavorId: F, root: A, snapshotId: SNAP.id, scope: SNAP.scope, phase: 'swapping', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, cancelling: false, cancellable: false, startedAt: 1 } });
  const cancel = btn('不可取消');
  assert.ok(cancel && cancel.disabled);
  press('Escape');
  assert.equal(openModals(dom).length, 1, '执行中不能关闭');

  const pendingBefore = called('backupRestorePending').length;
  B_.applyBackupTask({ rev: 101, task: null });
  ad.resolve({ status: 'completed', result: { taskId: 't1', txid: 'tx-demo', outcome: 'rolled-back', safetySnapshotId: 'safety-demo', cleanupPending: false, message: '演示：替换中出错', warnings: [] } });
  await tick();
  await tick();
  assert.equal(R.restoreFlow().stage, 'applied');
  assert.match(modal().textContent, /已回滚到恢复前/);
  assert.equal(R.restoreNotice().title, '没有恢复：替换中出错，已回滚到恢复前');
  assert.equal(R.restoreNotice().origin.root, A);
  assert.ok(called('backupRestorePending').length > pendingBefore, '结束后重新查询未完成的恢复');
  assert.equal(called('localState').length, 0, '不读取插件本地状态');
  press('Escape');
  assert.equal(openModals(dom).length, 0);
  assert.equal(focusedBack, 1, '关闭后焦点还给触发按钮');
  // 换目录后结果仍保留原目录
  setTarget(B);
  assert.equal(R.restoreNotice().origin.root, A);
  R.clearRestoreNotice();
});

test('A→B→A 使预览作废；blockers 使执行不可用', async () => {
  setTarget(A);
  handlers.backupRestorePreview = async () => ({ status: 'completed', result: preview() });
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  await tick();
  setTarget(B);
  setTarget(A);
  assert.equal(R.restoreFlow().targetChanged, true);
  check(inputs()[0]);
  check(inputs()[1]);
  assert.equal(btn('执行恢复').disabled, true, '切回原目录也不复活');
  btn('重新预览').click();
  await tick();
  assert.equal(R.restoreFlow().targetChanged, false);
  assert.equal(R.restoreFlow().ackGame, false, '重新预览后确认重新开始');
  btn('取消').click();
  assert.equal(openModals(dom).length, 0);

  handlers.backupRestorePreview = async () => ({ status: 'completed', result: preview({ token: null, expiresAt: null, blockers: ['演示：备份位置份数已满'] }) });
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  await tick();
  assert.match(modal().textContent, /份数已满/);
  assert.ok(inputs().every((i) => i.disabled));
  assert.equal(btn('执行恢复').disabled, true);
  btn('取消').click();
});

test('未完成的恢复：未登记只读；处理只提交 txid 与 gameClosed；完成后重新查询，不读取插件本地状态', async () => {
  const reason = '保留在 /demo/backups/AzerCube-WTF/.partial-safety-1（演示）';
  const container = '/demo/backups/AzerCube-WTF';
  handlers.backupRestorePending = async () => ({
    registryError: null,
    items: [
      { txid: 'tx-1', flavorId: F, root: B, containerPath: container, state: 'blocked', outcome: null, reason, createdAt: 1, sourceSnapshotId: SNAP.id, safetySnapshotId: 'safety-1', scope: { kind: 'all' } },
      { txid: null, flavorId: null, root: '/demo/C', containerPath: null, state: 'unregistered', outcome: null, reason: '未登记（演示）', createdAt: null, sourceSnapshotId: null, safetySnapshotId: null, scope: null },
    ],
    receipts: [{ txid: 'tx-0', flavorId: F, root: A, outcome: 'committed', at: 2, sourceSnapshotId: SNAP.id, safetySnapshotId: null }],
    scanErrors: [{ root: '/demo/D', reason: '演示：无法访问' }],
    boundRootsError: null,
  });
  await R.refreshPending();
  assert.match(banner.textContent, /2 项未完成/);
  assert.ok(R.restoreBlockReason({ flavorId: F, root: B }), '有未完成恢复的目录不能预览');
  R.openPendingView(() => undefined);
  await tick();
  const text = modal().textContent;
  assert.ok(text.includes(reason), '原因（含 .partial 路径）按纯文本显示');
  assert.ok(text.includes(`备份位置：${container}`), '登记的备份位置原样显示');
  assert.equal(text.split(container).length - 1, 2, '只有原因与备份位置两处，不另行拼接临时目录路径');
  assert.match(text, /未登记/);
  assert.match(text, /\/demo\/D/);
  assert.match(text, /不是本次操作的结果/);
  const resolveBtns = modal().all().filter((e) => e.tagName === 'BUTTON' && e.textContent === '处理');
  assert.equal(resolveBtns.length, 1, '未登记的没有处理按钮');
  assert.equal(resolveBtns[0].disabled, true, '确认之前不能处理');
  check(inputs()[0]);
  const before = called('backupRestorePending').length;
  handlers.backupRestoreResolve = async () => ({ status: 'completed', result: { taskId: 't2', txid: 'tx-1', outcome: 'cleared', message: '演示：已清理', warnings: [] } });
  modal().all().find((e) => e.tagName === 'BUTTON' && e.textContent === '处理').click();
  assert.deepEqual(called('backupRestoreResolve').at(-1).args, ['tx-1', { gameClosed: true }]);
  await tick();
  await tick();
  assert.ok(called('backupRestorePending').length > before);
  assert.equal(called('localState').length, 0);
  assert.match(R.restoreNotice().title, /没有被改动/);
  assert.equal(R.restoreNotice().origin.root, B, '结果注明原目录');
  assert.ok(toasts(dom).some((t) => t.includes(B)), '不属于当前目录的结果另行提示原目录');
  btn('关闭').click();
});

const taskOf = (o) => ({
  id: 'task-x', kind: 'restore-preview', flavorId: F, root: A, snapshotId: SNAP.id, scope: SNAP.scope, phase: 'verifying',
  filesDone: 0, filesTotal: 3, bytesDone: 0, bytesTotal: 300, cancelling: false, cancellable: true, startedAt: 1, ...o,
});

test('取消请求失败：同一任务仍可取消时恢复按钮可以重试；请求失败不声称已取消', async () => {
  handlers.backupRestorePending = async () => emptyPending();
  await R.refreshPending();
  setTarget(A);
  const pd = deferred();
  handlers.backupRestorePreview = () => pd.promise;
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  const task = taskOf({ id: 'preview-retry' });
  B_.applyBackupTask({ rev: 300, task });
  handlers.backupCancel = async () => {
    throw new Error('演示：取消请求失败');
  };
  const n0 = called('backupCancel').length;
  btn('取消预览').click();
  assert.deepEqual(called('backupCancel').at(-1).args, [task.id, F, A], '按任务受理时的原值取消');
  assert.ok(btn('正在取消…')?.disabled, '请求进行中不能重复点击');
  await tick();
  await tick();
  assert.ok(toasts(dom).some((t) => t.includes('演示：取消请求失败')), '失败原因已提示');
  // 后续同一任务的进度快照仍可取消：按钮恢复，可以重试
  B_.applyBackupTask({ rev: 301, task: { ...task, filesDone: 1, bytesDone: 100 } });
  const again = btn('取消预览');
  assert.ok(again, '恢复为可取消');
  assert.equal(again.disabled, false);
  assert.equal(R.restoreFlow().stage, 'previewing', '没有声称已取消');
  handlers.backupCancel = async () => true;
  again.click();
  assert.equal(called('backupCancel').length, n0 + 2, '第二次点击确实发出请求');
  await tick();
  assert.ok(btn('正在取消…')?.disabled, '已受理：等待任务的结果');
  B_.applyBackupTask({ rev: 302, task: null });
  pd.resolve({ status: 'cancelled', message: '演示：已取消，没有读取完成' });
  await tick();
  assert.match(modal().textContent, /预览已取消/, '取消以预览的返回为准');
  btn('关闭').click();
});

test('取消请求失败期间任务进入不可取消阶段：按最新快照显示，不恢复取消能力', async () => {
  setTarget(A);
  handlers.backupRestorePreview = async () => ({ status: 'completed', result: preview() });
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  await tick();
  check(inputs()[0]);
  check(inputs()[1]);
  const ad = deferred();
  handlers.backupRestoreApply = () => ad.promise;
  btn('执行恢复').click();
  const task = taskOf({ id: 'apply-critical', kind: 'restore', phase: 'safety-copy' });
  B_.applyBackupTask({ rev: 310, task });
  const cd = deferred();
  handlers.backupCancel = () => cd.promise;
  const n0 = called('backupCancel').length;
  btn('取消恢复').click();
  assert.equal(called('backupCancel').length, n0 + 1);
  B_.applyBackupTask({ rev: 311, task: { ...task, phase: 'swapping', cancellable: false } });
  cd.reject(new Error('演示：取消请求失败'));
  await tick();
  await tick();
  const locked = btn('不可取消');
  assert.ok(locked && locked.disabled, '进入不可取消阶段后不恢复取消');
  assert.ok(!btn('取消恢复'));
  assert.match(modal().textContent, /取消请求未能送达/);
  assert.doesNotMatch(modal().textContent, /已请求取消/);
  locked.click();
  assert.equal(called('backupCancel').length, n0 + 1, '不可取消时点击不发请求');
  press('Escape');
  assert.equal(openModals(dom).length, 1, '执行中不能关闭');
  B_.applyBackupTask({ rev: 312, task: null });
  ad.resolve({ status: 'completed', result: { taskId: task.id, txid: 'tx-c', outcome: 'committed', safetySnapshotId: 'safety-c', cleanupPending: false, message: '演示：已恢复', warnings: [] } });
  await tick();
  await tick();
  assert.equal(R.restoreFlow().stage, 'applied');
  assert.equal(R.restoreNotice().title, '已恢复', '结果来自主进程的 outcome');
  btn('关闭').click();
  R.clearRestoreNotice();
});

// ---------- 0.3.1 ----------

const pendingItem = (txid, root, flavorId = F) => ({
  txid, flavorId, root, containerPath: '/demo/backups/AzerCube-WTF', state: 'blocked', outcome: null, reason: '演示', createdAt: 1,
  sourceSnapshotId: SNAP.id, safetySnapshotId: null, scope: { kind: 'all' },
});

test('按目录判断（与主进程一致）：同一目录属于其他游戏版本或版本未知的未完成恢复都阻止预览，其他目录不受影响', async () => {
  handlers.backupRestorePending = async () => ({
    ...emptyPending(),
    items: [
      pendingItem('tx-other-flavor', A, 6),
      { ...pendingItem(null, B, null), state: 'unregistered', containerPath: null, sourceSnapshotId: null, scope: null },
    ],
  });
  await R.refreshPending();
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }), '同一目录、另一游戏版本的未完成恢复');
  assert.ok(R.restoreBlockReason({ flavorId: F, root: B }), '同一目录、游戏版本未知');
  assert.equal(R.restoreBlockReason({ flavorId: F, root: '/demo/E' }), null, '其他目录不受影响');
  setTarget(A);
  const before = called('backupRestorePreview').length;
  R.openRestorePreview({ flavorId: F, root: A }, SNAP, { usage: null, limits: null }, () => undefined);
  assert.equal(openModals(dom).length, 0);
  assert.equal(called('backupRestorePreview').length, before, '不发出注定被主进程拒绝的预览');
});

test('恢复 / 处理任务结束时重新查询（不依赖发起它的对话框）；开始、进度、过时快照、预览与备份 / 校验的结束都不查询；查询中只补查一轮', async () => {
  const n = () => called('backupRestorePending').length;
  handlers.backupRestorePending = async () => ({ ...emptyPending(), items: [pendingItem('tx-a', A), pendingItem('tx-b', B)] });
  await R.refreshPending();
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }));
  assert.ok(R.restoreBlockReason({ flavorId: F, root: B }));

  // 后台恢复（目录 A）：开始与同一任务的进度不查询，过时的快照不采用
  const n0 = n();
  const task = taskOf({ id: 'bg-restore', kind: 'restore', phase: 'staging' });
  B_.applyBackupTask({ rev: 400, task });
  B_.applyBackupTask({ rev: 401, task: { ...task, filesDone: 1 } });
  B_.applyBackupTask({ rev: 402, task: { ...task, filesDone: 2, phase: 'swapping', cancellable: false } });
  assert.equal(B_.applyBackupTask({ rev: 401, task: null }), false);
  await tick();
  assert.equal(n(), n0, '开始与进度不查询');

  // 结束：查询一次；结果只反映主进程（目录 B 的未完成恢复仍阻止）
  const dq = deferred();
  handlers.backupRestorePending = () => dq.promise;
  B_.applyBackupTask({ rev: 403, task: null });
  assert.equal(n(), n0 + 1, '恢复结束后查询一次');
  B_.applyBackupTask({ rev: 404, task: null });
  assert.equal(n(), n0 + 1, '空闲快照不查询');
  dq.resolve({ ...emptyPending(), items: [pendingItem('tx-b', B)] });
  await tick();
  await tick();
  assert.equal(n(), n0 + 1);
  assert.equal(R.restoreBlockReason({ flavorId: F, root: A }), null, '目录 A 的恢复已结束');
  assert.ok(R.restoreBlockReason({ flavorId: F, root: B }), '目录 B 的未完成恢复仍阻止');

  // 预览、备份与校验的结束不查询
  let rev = 410;
  for (const kind of ['restore-preview', 'run', 'verify']) {
    B_.applyBackupTask({ rev: rev++, task: taskOf({ id: `bg-${kind}`, kind }) });
    B_.applyBackupTask({ rev: rev++, task: null });
  }
  await tick();
  assert.equal(n(), n0 + 1, '其他任务的结束不查询');

  // 查询进行中，处理任务（目录 B）结束：只补查一轮，最终采用补查的结果
  const dq2 = deferred();
  handlers.backupRestorePending = () => dq2.promise;
  const manual = R.refreshPending();
  assert.equal(n(), n0 + 2);
  const resolveTask = taskOf({ id: 'bg-resolve', kind: 'restore-resolve', root: B, phase: 'swapping', cancellable: false });
  B_.applyBackupTask({ rev: rev++, task: resolveTask });
  B_.applyBackupTask({ rev: rev++, task: null });
  assert.equal(n(), n0 + 2, '查询中不重复发出');
  handlers.backupRestorePending = async () => emptyPending();
  dq2.resolve({ ...emptyPending(), items: [pendingItem('tx-b', B)] });
  await manual;
  await tick();
  await tick();
  assert.equal(n(), n0 + 3, '补查一轮');
  assert.equal(R.restoreBlockReason({ flavorId: F, root: B }), null);
  assert.ok(banner.classList.contains('hidden'));

  // 结束后的查询失败：错误可见，仍阻止恢复
  B_.applyBackupTask({ rev: rev++, task: taskOf({ id: 'bg-restore-2', kind: 'restore' }) });
  handlers.backupRestorePending = async () => {
    throw new Error('演示：结束后查询失败');
  };
  B_.applyBackupTask({ rev: rev++, task: null });
  await tick();
  await tick();
  assert.equal(n(), n0 + 4);
  assert.match(banner.textContent, /未能刷新：演示：结束后查询失败/);
  assert.ok(R.restoreBlockReason({ flavorId: F, root: A }));
  handlers.backupRestorePending = async () => emptyPending();
  await R.refreshPending();
  assert.equal(R.restoreBlockReason({ flavorId: F, root: A }), null);
});
