// 0.1.5：界面重新载入后恢复主进程的插件写操作状态，以及主进程的双向冲突防护（0.1.4 复现：重新载入后卸载排队中的插件，旧批次又把它装回）。
// 链路：编译后的渲染层 → 真实 preload → 真实 AppService（假 electron）→ AddonManager → 临时目录；网络与下载为可控的替身。
// “重新载入”的模拟：丢弃旧界面的全部订阅，把编译后的渲染层复制到新目录重新导入（state / local / actions / tasks 都是全新的模块实例），
// 按 main.ts 的启动顺序先订阅任务与活动推送、再获取快照；主进程实例与其中进行中的操作保持不变。不是真实 Electron 菜单操作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, installFakeDom, openModals } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;
const OTHER = 6;
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const dom = installFakeDom(null);
const MODS = { 100: 'Alpha', 200: 'Beta', 300: 'Gamma', 999: 'NewOne' };
const zipOf = (id, v) => makeZip(addonEntries(MODS[id], v));

/** detail（只有安装会查询，发生在目录锁之前）与 latest（检查与安装都会查询）可分别挂起；onDetail 在 detail 开始时调用 */
class ControlledSource extends FakeSource {
  gates = { detail: null, latest: null };
  onDetail = () => undefined;
  /** ids：只挂起这些插件的请求（缺省为全部） */
  pause(kind, ids = null) {
    let resolve;
    let entered;
    const promise = new Promise((r) => (resolve = r));
    const reached = new Promise((r) => (entered = r));
    this.gates[kind] = { promise, resolve, entered, ids };
    return reached;
  }
  held(kind, modId) {
    const g = this.gates[kind];
    return g && (!g.ids || g.ids.includes(modId)) ? g : null;
  }
  resume(kind) {
    const g = this.gates[kind];
    this.gates[kind] = null;
    g?.resolve();
  }
  async detail(modId, flavorId) {
    await this.onDetail(modId);
    const g = this.held('detail', modId);
    if (g) {
      g.entered(modId);
      await g.promise;
    }
    return super.detail(modId, flavorId);
  }
  async latest(modId, flavorId) {
    const g = this.held('latest', modId);
    if (g) {
      g.entered(modId);
      await g.promise;
    }
    return super.latest(modId, flavorId);
  }
}

/** 可控下载：holdIds 中的插件报告 35% 后挂起，直到放行或取消 */
function controlledDownload(src) {
  const ctl = { started: [], holdIds: new Set(), holds: new Map() };
  ctl.release = (id) => {
    const r = ctl.holds.get(id);
    assert.ok(r, `${id} 没有挂起的下载`);
    ctl.holds.delete(id);
    r();
  };
  ctl.download = async (url, dest, opts) => {
    const modId = /mod_file\/(\d+)\//.exec(url)[1];
    ctl.started.push(modId);
    if (ctl.holdIds.has(modId)) {
      opts.onProgress?.(35, 100);
      await new Promise((resolve, reject) => {
        ctl.holds.set(modId, resolve);
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
    }
    return src.download(url, dest);
  };
  return ctl;
}

/** 目录 A（无限）装有 100、200（文件 1），远端为文件 2；withB：目录 B 绑定给另一个版本 */
async function setup({ ids = ['100', '200'], withB = false } = {}) {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = withB ? await makeGameRoot(path.join(base, 'B')) : null;
  const src = new ControlledSource();
  const m = makeManager(src);
  for (const id of ids) {
    src.set(id, F, { name: MODS[id], fileId: '1', zip: zipOf(id, 'v1') });
    await m.install(A, F, id);
  }
  for (const id of ids) src.set(id, F, { name: MODS[id], fileId: '2', zip: zipOf(id, 'v2') });
  src.set('999', F, { name: MODS['999'], fileId: '1', zip: zipOf('999', 'n1') });
  src.set('999', OTHER, { name: MODS['999'], fileId: '1', zip: zipOf('999', 'n1'), versions: ['12.1.5'] });
  const ctl = controlledDownload(src);
  const h = H.createHarness({ settingsFile: path.join(base, 'settings.json'), source: src, download: ctl.download });
  await h.settings.bind(F, A);
  if (B) await h.settings.bind(OTHER, B);
  return { base, A, B, src, ctl, h };
}

let rendererSeq = 0;
/** 当前页面的接口包装；载入新页面时旧页面被销毁 */
let currentPage = null;

/**
 * 每个页面自己的接口包装：调用照常到达主进程，主进程的 Promise 另外保存（测试据此等待真实结果并处理错误）；
 * 页面销毁后，旧页面拿到的 Promise 永不完成，旧页面的后续代码（例如写操作结束后的刷新与重绘）不会再运行，
 * 不会替新页面完成刷新而掩盖问题。
 */
function pageApi(raw) {
  const page = { destroyed: false, calls: [] };
  page.api = new Proxy(raw, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      return (...args) => {
        const r = v.apply(target, args);
        if (!r || typeof r.then !== 'function') return r;
        page.calls.push({ name: key, promise: r });
        r.catch(() => undefined);
        return new Promise((resolve, reject) => r.then((x) => !page.destroyed && resolve(x), (e) => !page.destroyed && reject(e)));
      };
    },
  });
  return page;
}

/**
 * 载入一个全新的界面（模拟重新载入）。api：界面拿到的接口（默认真实 preload，可包一层延迟）。
 * 不自动获取活动快照：由调用方按需要控制 syncActivity 的时机。backend(name)：这个页面发出的该接口调用在主进程的 Promise。
 */
async function freshRenderer(h, base, raw = h.api) {
  if (currentPage) currentPage.destroyed = true;
  const page = pageApi(raw);
  currentPage = page;
  const api = page.api;
  h.stub.listeners.clear(); // 旧页面销毁：它的订阅全部失效
  const dir = path.join(base, `renderer-${++rendererSeq}`);
  await cp(web, dir, { recursive: true });
  for (const id of ['test-local', 'task-panel', 'modal-root', 'toast-root', 'activity-warning']) document.getElementById(id).replaceChildren();
  globalThis.window.beelite = api;
  const S = await import(path.join(dir, 'state.js'));
  const L = await import(path.join(dir, 'local.js'));
  const A = await import(path.join(dir, 'actions.js'));
  const T = await import(path.join(dir, 'tasks.js'));
  const N = await import(path.join(dir, 'activity-notice.js'));
  S.state.config = {
    flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }, { id: OTHER, name: '经典', versions: ['12.1.5'], interfaceNumber: 120105, online: true }],
    categories: [],
    defaultFlavorId: F,
    configError: null,
  };
  S.state.flavorId = F;
  // main.ts boot 的顺序：任务事件 → 活动推送（接受的快照交给任务面板）→ 更新检查推送
  api.onTask((e) => {
    S.applyTask(e);
    T.handleTask(e);
  });
  S.onActivityAccepted(T.syncTasks);
  api.onActivity((s) => void S.applyActivity(s));
  api.onAddonWatch((s) => S.applyWatch(s));
  const view = document.getElementById('test-local');
  L.initLocal(view);
  // 页面顶部的全局提示（main.ts 中挂在 #activity-warning）
  const warning = document.getElementById('activity-warning');
  N.initActivityNotice(warning);
  const row = (id) => {
    const r = view.all().find((e) => e.classList.contains('row') && e.all().some((n) => n.classList.contains('row-name') && n.textContent === MODS[id]));
    assert.ok(r, `找不到 ${MODS[id]} 的行`);
    return r;
  };
  const buttons = (id) => row(id).all().filter((e) => e.tagName === 'BUTTON');
  return {
    S, L, A, T, view, row, buttons,
    warning: () => warning,
    backend: (name) => page.calls.filter((c) => c.name === name).map((c) => c.promise),
    rowText: (id) => row(id).textContent,
    buttonMap: (id) => Object.fromEntries(buttons(id).map((b) => [b.textContent, b.disabled])),
    toolbar: () => view.querySelector('.local-toolbar').textContent,
    updateAllButton: () => view.all().find((e) => e.tagName === 'BUTTON' && /全部更新|更新中/.test(e.textContent)),
    cards: () => document.getElementById('task-panel').childNodes,
  };
}

async function until(fn, what) {
  for (let i = 0; i < 600; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}
const tick = () => new Promise((r) => setImmediate(r));
const writeCalls = () => H.ipcCalls.filter((c) => !['local:state', 'addon:watchState', 'addon:activityState', 'addon:check'].includes(c.channel));

test('R1 重新载入（批次第一项停在目录锁之前的远端请求）：新界面恢复批次与排队状态；卸载 / 更新 / 再次全部更新在界面与主进程都被拒绝；结束后恢复，WTF 不变', async () => {
  const { base, A, src, h } = await setup();
  try {
    const wtf0 = await H.snapshot(path.join(A, 'WTF'));
    // 旧界面发起全部更新
    const R0 = await freshRenderer(h, base);
    await R0.S.syncActivity();
    await R0.S.refreshLocal();
    await R0.S.checkUpdates(true);
    const reached = src.pause('detail');
    void R0.L.doUpdateAll(); // 旧页面销毁后这个界面 Promise 不再完成
    const [backendRun] = R0.backend('updateAll');
    const first = await reached;
    const second = first === '100' ? '200' : '100';
    const m0 = await H.readManifestJson(A);

    // 重新载入：本地列表立即可读，但后台批次仍在进行
    const R = await freshRenderer(h, base);
    await R.S.syncActivity();
    await R.S.refreshLocal();
    assert.equal(h.gate.activeCount, 1, '主进程的批次仍在进行');
    assert.deepEqual([...R.S.state.busy], [], '新界面没有本地占用');
    assert.deepEqual(R.S.state.activity.batches.map((b) => [b.root, b.stage]), [[A, 'running']]);
    assert.deepEqual(R.S.state.activity.tasks.map((t) => t.modId).sort(), ['100', '200']);
    assert.match(R.toolbar(), /更新中/);
    assert.equal(R.updateAllButton().disabled, true);
    assert.equal(R.S.modBusy(second), true);
    assert.match(R.rowText(second), /等待中/);
    assert.ok(R.buttons(second).every((b) => b.disabled), '排队中的插件所有写按钮禁用');

    // 界面入口不发请求
    H.ipcCalls.length = 0;
    const p2 = R.S.state.local.managed.find((x) => x.modId === second);
    await R.A.updateProject(p2, false);
    await R.A.updateProject(p2, true);
    await R.L.uninstallProject(p2);
    await R.L.doUpdateAll();
    assert.equal(openModals(dom).length, 0);
    assert.deepEqual(writeCalls(), []);
    // 绕过界面直接走真实 IPC：主进程拒绝，不写清单、不新增任务
    const rec = await H.recordOf(A, second);
    await assert.rejects(h.api.uninstallProject(second, F, A), /正在全部更新/);
    await assert.rejects(h.api.update(second, F, false, rec, A), /正在全部更新/);
    await assert.rejects(h.api.update(second, F, true, rec, A), /正在全部更新/);
    await assert.rejects(h.api.updateAll(F, A), /正在全部更新/);
    assert.deepEqual(await H.readManifestJson(A), m0);
    assert.equal(h.service.activity.snapshot().tasks.length, 2);
    assert.equal(h.service.activity.snapshot().batches.length, 1);

    src.resume('detail');
    assert.equal((await backendRun).ok, true);
    await until(() => R.S.state.activity.batches.length === 0 && !R.S.state.localLoading && R.S.state.local.managed.every((x) => x.fileId === '2'), '批次结束、新界面已重新读取列表');
    const m1 = await H.readManifestJson(A);
    assert.deepEqual([m1.projects['100'].fileId, m1.projects['200'].fileId], ['2', '2']);
    assert.doesNotMatch(R.toolbar(), /更新中/);
    assert.ok(R.buttons(second).every((b) => !b.disabled), '批次结束后恢复可操作');
    // 批次结束后卸载可以正常进行
    const p2b = R.S.state.local.managed.find((x) => x.modId === second);
    const un = R.L.uninstallProject(p2b);
    clickModalButton(dom, '卸载');
    await un;
    assert.equal((await H.readManifestJson(A)).projects[second], undefined);
    assert.deepEqual(await H.snapshot(path.join(A, 'WTF')), wtf0, 'WTF 不变');
    assert.equal(h.gate.activeCount, 0);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('R2 计划确定之前重新载入：新界面显示“检查中”并禁止写入；主进程拒绝第二个批次与该目录的新安装', async () => {
  const { base, A, src, h } = await setup();
  try {
    const R0 = await freshRenderer(h, base);
    await R0.S.syncActivity();
    await R0.S.refreshLocal();
    await R0.S.checkUpdates(true);
    const reached = src.pause('latest');
    void R0.L.doUpdateAll();
    const [backendRun] = R0.backend('updateAll');
    await reached;
    const R = await freshRenderer(h, base);
    await R.S.syncActivity();
    await R.S.refreshLocal();
    assert.deepEqual(R.S.state.activity.batches.map((b) => b.stage), ['checking']);
    assert.deepEqual(R.S.state.activity.tasks, [], '计划尚未确定');
    assert.match(R.toolbar(), /更新中/);
    for (const id of ['100', '200']) assert.ok(R.buttons(id).every((b) => b.disabled));
    assert.equal(R.S.modBusy('999'), true, '检查阶段不能安装新插件');
    H.ipcCalls.length = 0;
    await R.A.installMod('999');
    assert.deepEqual(writeCalls(), []);
    await assert.rejects(h.api.updateAll(F, A), /正在全部更新/);
    await assert.rejects(h.api.install('999', F, A), /正在全部更新/);
    src.resume('latest');
    assert.equal((await backendRun).ok, true);
    const m = await H.readManifestJson(A);
    assert.deepEqual([m.projects['100'].fileId, m.projects['200'].fileId, m.projects['999']], ['2', '2', undefined]);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('R6 下载 35% 时重新载入：只凭活动快照立即恢复同一个任务的卡片与 35% 进度（不重复、不归零、不重新下载），取消按钮作用于原任务；结束后行内显示已取消', async () => {
  const { base, A, ctl, h } = await setup();
  try {
    ctl.holdIds.add('100');
    const R0 = await freshRenderer(h, base);
    await R0.S.syncActivity();
    await R0.S.refreshLocal();
    const p = R0.S.state.local.managed.find((x) => x.modId === '100');
    void R0.A.updateProject(p, false);
    const [backendRun] = R0.backend('update');
    await until(() => ctl.holds.has('100'), '下载 35%');
    const taskId = h.service.activity.snapshot().tasks[0].taskId;

    const R = await freshRenderer(h, base);
    await R.S.syncActivity();
    // 本地列表的读取排在持有目录锁的下载之后（与 0.1.4 相同），在它结束之前列表不可用：
    // 任务卡片与取消按钮必须只凭活动快照立即恢复，不能等列表，也不能等下一次进度事件
    const listing = R.S.refreshLocal();
    assert.equal(R.cards().length, 1, '恢复一张卡片');
    assert.match(R.cards()[0].textContent, /下载中 35%/);
    assert.deepEqual(R.S.state.activity.tasks.map((t) => [t.taskId, t.phase, t.received, t.total]), [[taskId, 'downloading', 35, 100]]);
    // 同一个快照再次到来、或旧快照迟到：不重复建卡片
    R.S.applyActivity(R.S.state.activity);
    R.T.syncTasks(R.S.state.activity);
    assert.equal(R.cards().length, 1);
    assert.deepEqual(ctl.started, ['100'], '没有重新下载');
    // 取消按钮：作用于原任务
    H.ipcCalls.length = 0;
    const cancel = R.cards()[0].all().find((e) => e.tagName === 'BUTTON' && e.textContent === '取消');
    assert.ok(cancel);
    cancel.click();
    await assert.rejects(backendRun, /已取消/);
    // 取消后目录锁释放，列表才读出；此时再核对行内状态
    await listing;
    await until(() => R.S.state.activity.tasks.length === 0 && R.S.state.activity.reservations.length === 0, '任务结束');
    assert.deepEqual(H.ipcCalls.filter((c) => c.channel === 'task:cancel').map((c) => c.args[0]), [taskId]);
    assert.equal(R.cards().length, 1, '终态沿用同一张卡片');
    assert.ok(R.cards()[0].classList.contains('task-cancelled'));
    assert.match(R.rowText('100'), /已取消/);
    assert.equal((await H.readManifestJson(A)).projects['100'].fileId, '1', '取消后保留原版本');
    // 之后的无关快照不让已结束的卡片复活或重置
    R.S.applyActivity({ ...h.service.activity.snapshot(), rev: R.S.state.activity.rev + 1 });
    assert.equal(R.cards().length, 1);
    assert.ok(R.cards()[0].classList.contains('task-cancelled'));
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('R3 反向冲突：单项更新已受理（停在锁前远端请求）或卸载正在等待目录锁时，主进程拒绝同一目录的全部更新与同一插件的其他写操作；结束后可以全部更新', async () => {
  const { base, A, src, ctl, h } = await setup({ ids: ['100', '200', '300'] });
  try {
    // 1. 单项更新停在目录锁之前的 detail
    const reached = src.pause('detail');
    const upd = h.api.update('100', F, false, await H.recordOf(A, '100'), A);
    await reached;
    await assert.rejects(h.api.updateAll(F, A), /有插件正在处理/);
    await assert.rejects(h.api.uninstallProject('100', F, A), /这个插件正在处理/);
    await assert.rejects(h.api.update('100', F, true, await H.recordOf(A, '100'), A), /这个插件正在处理/);
    assert.deepEqual(h.service.activity.snapshot().batches, [], '没有新建批次');
    src.resume('detail');
    await upd;

    // 2. 卸载在等待目录锁（锁被另一项挂起的下载持有）
    ctl.holdIds.add('300');
    const hold = h.api.update('300', F, false, await H.recordOf(A, '300'), A);
    await until(() => ctl.holds.has('300'), '300 持有目录锁');
    const un = h.api.uninstallProject('200', F, A);
    await until(() => h.service.activity.snapshot().reservations.some((r) => r.modId === '200' && r.kind === 'uninstall'), '卸载已受理');
    await assert.rejects(h.api.updateAll(F, A), /有插件正在处理/);
    assert.equal((await H.readManifestJson(A)).projects['200'].fileId, '1', '卸载仍在等待目录锁');
    ctl.release('300');
    await hold;
    await un;
    assert.equal((await H.readManifestJson(A)).projects['200'], undefined);
    assert.deepEqual(h.service.activity.snapshot().reservations, []);
    const r = await h.api.updateAll(F, A);
    assert.equal(r.ok, true, r.message);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('R4 其他目录：A 正在全部更新时，B 的写操作正常；B 的结束不解除 A 的占用；A 失败收尾后不留占用', async () => {
  const { base, A, B, src, h } = await setup({ withB: true });
  try {
    // 批次停在第二项的 detail（目录锁之前），A 的占用持续
    const reached = src.pause('detail', ['200']);
    const run = h.api.updateAll(F, A);
    await reached;
    // 在 B（另一个版本）安装新插件：不受 A 影响；它的结束也不解除 A 的批次
    const r = await h.api.install('999', OTHER, B);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(h.service.activity.snapshot().batches.map((b) => b.root), [A], 'A 的批次仍在');
    await assert.rejects(h.api.uninstallProject('100', F, A), /正在全部更新/);
    src.resume('detail');
    assert.equal((await run).ok, true);
    assert.deepEqual(h.service.activity.snapshot().batches, []);
    // 失败收尾：检查全部失败
    src.mods.delete('100');
    src.mods.delete('200');
    const bad = await h.api.updateAll(F, A);
    assert.equal(bad.ok, false);
    const s = h.service.activity.snapshot();
    assert.deepEqual([s.batches, s.tasks, s.reservations], [[], [], []], '失败后没有残留占用');
    // 检查本身抛错（目录无法读取清单之外的情况：数据源抛错在检查项中）同样释放
    await assert.rejects(h.api.updateAll(F, path.join(base, 'nowhere')), /绑定已变更/);
    assert.deepEqual(h.service.activity.snapshot().batches, []);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('R5 排队期间被改动：绕过防护卸载计划中的后项，旧批次跳过它（不复活、不计成功）；之后换绑停止时剩余数正确；计划后的新插件安装可以进行', async () => {
  const { base, A, src, h } = await setup({ ids: ['100', '200', '300'] });
  try {
    const C = await makeGameRoot(path.join(base, 'C'));
    const reached = src.pause('detail', ['100']);
    const run = h.api.updateAll(F, A);
    const first = await reached;
    assert.equal(first, '100');
    // 计划已确定：允许安装计划外的新插件（第一项尚未取得目录锁）
    const nr = await h.api.install('999', F, A);
    assert.equal(nr.ok, true, nr.message);
    // 绕过主进程防护的改动（例如另一个进程）：直接用 manager 卸载计划中的 200
    await h.service.manager.uninstallProject(A, '200');
    // 200 开始处理时（目录锁之前）把这个版本改绑到 C：200 仍在原目录核对，300 不再处理
    src.onDetail = (id) => (id === '200' ? h.settings.bind(F, C) : undefined);
    src.resume('detail');
    const r = await run;
    assert.equal(r.ok, false);
    assert.match(r.message, /已更新 1 个插件/);
    assert.match(r.message, /排队期间已变化未处理 1 个/);
    assert.match(r.message, /剩余 1 个未处理/);
    assert.ok(r.warnings.some((w) => /Beta：排队期间已变化，未处理/.test(w)), r.warnings.join(' | '));
    const m = await H.readManifestJson(A);
    assert.equal(m.projects['200'], undefined, '已卸载的插件没有被装回');
    assert.equal(m.projects['100'].fileId, '2');
    assert.equal(m.projects['300'].fileId, '1');
    assert.equal(m.projects['999'].fileId, '1');
    const ev200 = h.stub.sent.filter((x) => x.channel === 'task:event' && x.payload.modId === '200' && ['done', 'failed', 'cancelled'].includes(x.payload.phase)).map((x) => x.payload);
    assert.equal(ev200.length, 1);
    assert.equal(ev200[0].phase, 'cancelled', '未处理，不是失败');
    assert.match(ev200[0].message, /已不在这个目录的蜂简管理列表中/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('快照竞争 S1 / S2：开始前取得的空快照晚到不清除占用；进行中取得的忙快照在结束之后到达不复活任务', async () => {
  const { base, A, ctl, h } = await setup();
  try {
    let held = [];
    const api = { ...h.api, activityState: () => h.api.activityState().then((s) => new Promise((res) => held.push(() => res(s)))) };
    // S1
    const R = await freshRenderer(h, base, api);
    await R.S.refreshLocal();
    const sync1 = R.S.syncActivity();
    await until(() => held.length === 1, '空快照已取得、回复被延迟');
    assert.equal(R.S.activityUnknown(), true);
    ctl.holdIds.add('100');
    const upd = h.api.update('100', F, false, await H.recordOf(A, '100'), A);
    await until(() => ctl.holds.has('100') && R.S.state.activity, '推送已到达');
    assert.equal(R.S.modBusy('100'), true);
    held.shift()();
    await sync1;
    assert.equal(R.S.modBusy('100'), true, '旧空快照没有清除占用');
    assert.match(R.rowText('100'), /下载中 35%/);
    assert.equal(R.cards().length, 1);

    // S2：进行中取得快照，回复延迟到任务结束之后
    const sync2 = R.S.syncActivity();
    await until(() => held.length === 1, '忙快照已取得');
    ctl.release('100');
    await upd;
    await until(() => R.S.state.activity.tasks.length === 0 && R.S.state.activity.reservations.length === 0, '结束推送已到达');
    held.shift()();
    await sync2;
    assert.equal(R.S.modBusy('100'), false, '旧忙快照没有复活任务');
    assert.equal(R.S.rowTask('100'), undefined);
    assert.ok(R.cards()[0].classList.contains('task-done'), '卡片保持终态');
    assert.equal(R.cards().length, 1);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('快照竞争 S4：活动状态获取失败时不当作空闲（写入口禁止并可重试）；失败晚于更新的推送时不覆盖；重试后恢复', async () => {
  const { base, A, h } = await setup();
  try {
    let mode = 'fail';
    let late = null;
    const api = {
      ...h.api,
      activityState: async () => {
        if (mode === 'fail') throw new Error('读取失败（测试）');
        if (mode === 'late-fail') return new Promise((_res, rej) => (late = () => rej(new Error('迟到的失败（测试）'))));
        return h.api.activityState();
      },
    };
    const R = await freshRenderer(h, base, api);
    await R.S.syncActivity();
    await R.S.refreshLocal();
    await R.S.checkUpdates(true);
    assert.equal(R.S.activityUnknown(), true);
    // 失败原因与重试在页面顶部的全局提示中（发现页同样可见），不是一直“同步中”
    assert.equal(R.warning().classList.contains('hidden'), false);
    assert.match(R.warning().textContent, /无法获取后台插件操作状态，安装、更新、重装、卸载插件和全部更新暂不可用：读取失败（测试）/);
    assert.doesNotMatch(R.view.textContent, /同步中/);
    assert.equal(R.updateAllButton().disabled, true);
    assert.ok(R.buttons('100').every((b) => b.disabled), '写入口保守禁止');
    assert.match(R.rowText('100'), /暂不可用/);
    const discoverBtn = R.A.modActionButton({ id: '999', accessible: true });
    assert.deepEqual([discoverBtn.textContent, discoverBtn.disabled], ['暂不可用', true], '发现页按钮说明暂不可用');
    assert.match(discoverBtn.title, /读取失败（测试）.*页面顶部重试/);
    H.ipcCalls.length = 0;
    await R.A.updateProject(R.S.state.local.managed.find((x) => x.modId === '100'), false);
    await R.L.doUpdateAll();
    assert.deepEqual(writeCalls(), []);
    // 重试成功
    mode = 'ok';
    R.warning().all().find((e) => e.tagName === 'BUTTON' && e.textContent === '重试').click();
    await until(() => !R.S.activityUnknown(), '重试后取得状态');
    assert.equal(R.warning().classList.contains('hidden'), true);
    assert.equal(R.updateAllButton().disabled, false);
    assert.equal(R.A.modActionButton({ id: '999', accessible: true }).textContent, '安装');

    // 失败晚于更新的推送：不覆盖已取得的状态
    const R2 = await freshRenderer(h, base, api);
    mode = 'late-fail';
    const sync = R2.S.syncActivity();
    await until(() => late, '请求已发出');
    await h.api.uninstallProject('300', F, A).catch(() => undefined); // 不存在的插件：受理并结束，产生推送
    await until(() => !R2.S.activityUnknown(), '推送已到达');
    late();
    await sync;
    assert.equal(R2.S.activityUnknown(), false);
    assert.equal(R2.S.state.activityError, null);
    assert.equal(R2.warning().classList.contains('hidden'), true, '迟到的失败不显示错误');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('P3 批次计划阶段只来自主进程：检查中另一个目录的单项安装不改变 A 的“检查中”；计划确定后才是“全部更新中”', async () => {
  const { base, A, B, src, ctl, h } = await setup({ withB: true });
  try {
    const R = await freshRenderer(h, base);
    await R.S.syncActivity();
    await R.S.refreshLocal();
    await R.S.checkUpdates(true);
    ctl.holdIds.add('100');
    ctl.holdIds.add('200');
    const reached = src.pause('latest');
    const run = R.L.doUpdateAll();
    await reached;
    await until(() => R.S.state.activity.batches.length === 1, '批次已登记');
    for (const id of ['100', '200']) assert.equal(R.buttonMap(id)['检查中'], true);
    // 另一个目录（B，另一个版本）的单项安装：排队事件不影响 A
    const other = h.api.install('999', OTHER, B);
    await until(() => h.stub.sent.some((x) => x.channel === 'task:event' && x.payload.root === B && x.payload.phase === 'queued'), 'B 的单项任务已排队');
    await tick();
    for (const id of ['100', '200']) assert.equal(R.buttonMap(id)['检查中'], true, 'A 仍在检查中');
    // 本目录检查阶段的新安装：界面不发请求，主进程拒绝
    await assert.rejects(h.api.install('999', F, A), /正在全部更新/);
    src.resume('latest');
    await other;
    await until(() => R.S.state.activity.batches[0]?.stage === 'running' && ctl.holds.size === 1, '计划已确定、第一项下载中');
    const waiting = ctl.holds.has('100') ? '200' : '100';
    assert.match(R.rowText(waiting), /等待中/);
    for (const id of ['100', '200']) ctl.holdIds.delete(id);
    ctl.release(ctl.holds.has('100') ? '100' : '200');
    await run;
    assert.equal((await H.readManifestJson(B)).projects['999'].fileId, '1');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('P3 未托管目录的占用按目标区分：A 的移入回收站未完成时切到 B，B 的同名目录不显示“处理中”，写入只针对确认时的目标', async () => {
  const roots = { [F]: '/fixture/A/_retail_', [OTHER]: '/fixture/B/_classic_' };
  const folder = { name: 'SharedAddon', toc: null, symlink: false };
  const makeLocal = (f) => ({ flavorId: f, profile: { flavorId: f, root: roots[f], addonsPath: `${roots[f]}/Interface/AddOns` }, dir: { status: 'ok', message: null }, managed: [], unmanaged: [folder], recovery: [], error: null });
  const calls = [];
  const releases = [];
  const empty = { instance: 'fixture', rev: 1, batches: [], tasks: [], reservations: [] };
  const api = {
    localState: async (f) => makeLocal(f),
    activityState: async () => empty,
    onTask: () => () => undefined,
    onActivity: () => () => undefined,
    onAddonWatch: () => () => undefined,
    uninstallFolder: async (...args) => {
      calls.push(args);
      await new Promise((r) => releases.push(r));
      return { ok: true, message: '完成' };
    },
  };
  const base = await realpath(await tmpDir());
  try {
    const fakeH = { stub: { listeners: new Map() } };
    const R = await freshRenderer(fakeH, base, api);
    await R.S.syncActivity();
    await R.S.refreshLocal();
    const tabBtn = () => R.view.all().find((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('未托管'));
    tabBtn().click();
    const trashBtn = () => R.view.all().find((e) => e.tagName === 'BUTTON' && (e.textContent === '移入回收站' || e.textContent.includes('处理中')));
    const runA = R.L.trashFolder(folder);
    clickModalButton(dom, '移入回收站');
    await tick();
    assert.deepEqual(calls, [['SharedAddon', F, roots[F]]]);
    assert.equal(trashBtn().textContent.includes('处理中'), true, 'A 显示处理中');
    R.S.setFlavor(OTHER);
    await tick();
    assert.equal(R.S.currentTarget().root, roots[OTHER]);
    assert.equal(trashBtn().textContent, '移入回收站', 'B 的同名目录不显示 A 的处理中');
    assert.equal(trashBtn().disabled, false);
    // B 的操作只针对 B，与 A 的占用互不影响
    const runB = R.L.trashFolder(folder);
    clickModalButton(dom, '移入回收站');
    await tick();
    assert.deepEqual(calls[1], ['SharedAddon', OTHER, roots[OTHER]]);
    releases[0]();
    await runA;
    assert.equal(trashBtn().textContent.includes('处理中'), true, 'A 完成不解除 B 的占用');
    releases[1]();
    await runB;
    assert.equal(trashBtn().textContent, '移入回收站');
    assert.equal(calls.length, 2);
  } finally {
    await cleanup(base);
  }
});

// ---------- 结束后的完整列表：首次列表读取的回复晚于操作结束（重新载入之后） ----------

/** 第一次列表读取在主进程照常读出，回复延迟到 release() 之后才交给界面；reads 记录读取次数 */
function delayFirstLocalState(raw) {
  const ctl = { held: null, reads: 0 };
  ctl.api = {
    ...raw,
    localState: async (f) => {
      ctl.reads++;
      const r = await raw.localState(f);
      if (!ctl.held) await new Promise((release) => (ctl.held = { release, r }));
      return r;
    },
  };
  return ctl;
}

/** 界面的完整列表与主进程当前的完整列表一致（托管记录、未托管目录、回收站） */
async function assertFullList(h, R, flavorId) {
  const actual = await h.api.localState(flavorId);
  const view = R.S.state.local;
  assert.equal(view.profile.root, actual.profile.root);
  assert.deepEqual(view.managed.map((m) => [m.modId, m.fileId, m.installedAt]), actual.managed.map((m) => [m.modId, m.fileId, m.installedAt]));
  assert.deepEqual(view.unmanaged.map((u) => u.name), actual.unmanaged.map((u) => u.name));
  assert.deepEqual(view.recovery.map((r) => [r.id, r.kind]), actual.recovery.map((r) => [r.id, r.kind]));
  return actual;
}

test('C1 重新载入后首次列表读取已读出旧状态、回复晚于批次结束：结束信号保留，回复到达后自动补读一次完整列表（含回收站）', async () => {
  const { base, h, src } = await setup();
  try {
    const R0 = await freshRenderer(h, base);
    await R0.S.syncActivity();
    await R0.S.refreshLocal();
    await R0.S.checkUpdates(true);
    const reached = src.pause('detail', ['100']);
    void R0.L.doUpdateAll();
    const [backendRun] = R0.backend('updateAll');
    await reached;

    const d = delayFirstLocalState(h.api);
    const R = await freshRenderer(h, base, d.api);
    await R.S.syncActivity();
    const first = R.S.refreshLocal();
    await until(() => d.held, '首次读取已读出');
    assert.equal(d.held.r.recovery.length, 0);
    assert.deepEqual(d.held.r.managed.map((m) => m.fileId), ['1', '1']);
    src.resume('detail');
    assert.equal((await backendRun).ok, true);
    await until(() => R.S.state.activity.batches.length === 0 && R.S.state.activity.tasks.length === 0, '结束推送已到达');
    assert.equal(R.S.state.local, null, '结束时列表尚未就绪');
    d.held.release();
    await first;
    await until(() => !R.S.state.localLoading && R.S.state.local?.recovery.length === 2, '自动补读到完整列表');
    const actual = await assertFullList(h, R, F);
    assert.deepEqual(actual.managed.map((m) => m.fileId), ['2', '2']);
    assert.equal(d.reads, 2, '旧回复之后补读一次');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d.reads, 2, '不会循环读取');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('C2 首次列表读取的回复晚于单项卸载结束（没有提交记录可补）：回复到达后补读，已卸载的插件不再显示', async () => {
  const { base, A, h } = await setup();
  try {
    const d = delayFirstLocalState(h.api);
    const R = await freshRenderer(h, base, d.api);
    await R.S.syncActivity();
    const first = R.S.refreshLocal();
    await until(() => d.held, '首次读取已读出');
    assert.ok(d.held.r.managed.some((m) => m.modId === '200'));
    // 另一个页面（例如重新载入之前）发起的卸载：受理、完成，结束推送到达时列表尚未就绪
    await h.api.uninstallProject('200', F, A);
    await until(() => R.S.state.activity.reservations.length === 0 && R.S.state.activity.rev > 0, '结束推送已到达');
    assert.equal(R.S.state.local, null);
    d.held.release();
    await first;
    await until(() => !R.S.state.localLoading && R.S.state.local && !R.S.state.local.managed.some((m) => m.modId === '200'), '自动补读');
    const actual = await assertFullList(h, R, F);
    assert.ok(actual.recovery.some((r) => r.kind === 'uninstall'));
    assert.equal(d.reads, 2);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('C3 结束标记只属于原目标：回复到达之前切换到另一个目标，B 的列表不被 A 的旧回复或标记影响；切回 A 时读到结束后的完整列表', async () => {
  const { base, A, B, h } = await setup({ withB: true });
  try {
    const d = delayFirstLocalState(h.api);
    const R = await freshRenderer(h, base, d.api);
    await R.S.syncActivity();
    const first = R.S.refreshLocal();
    await until(() => d.held, 'A 的首次读取已读出');
    await h.api.uninstallProject('200', F, A);
    await until(() => R.S.state.activity.reservations.length === 0 && R.S.state.activity.rev > 0, '结束推送已到达');
    R.S.setFlavor(OTHER);
    await until(() => !R.S.state.localLoading && R.S.state.local?.profile.root === B, '显示 B');
    d.held.release();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(R.S.state.local.profile.root, B, 'A 的旧回复被丢弃');
    assert.deepEqual(R.S.state.local.managed, []);
    await assertFullList(h, R, OTHER);
    assert.equal(d.reads, 2, 'A 的标记不会触发对 B 的反复读取');
    R.S.setFlavor(F);
    await until(() => !R.S.state.localLoading && R.S.state.local?.profile.root === A, '切回 A');
    assert.ok(!R.S.state.local.managed.some((m) => m.modId === '200'));
    await assertFullList(h, R, F);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d.reads, 3, '切回时的读取在结束之后，不再补读');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
