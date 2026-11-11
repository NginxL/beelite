// 全部更新 / 单项更新的逐项行状态（0.1.4）：编译后的渲染层（state / local / actions / tasks）→ 真实 preload（主进程事件按序送达）
// → 真实 AppService（假 electron）→ AddonManager → 临时目录。下载由可控的假下载提供（挂起在 35%、失败、响应取消），不联网。
// 场景：第一项已提交、第二项下载 35% 时，第一行立即显示提交的新版本、撤掉“可更新”，第二行显示真实进度；批次期间该目标的
// 所有写入口同步防重；失败 / 取消保留旧版本并继续下一项；换绑停止时未开始的项目结束等待；事件只按 目标 + 插件编号 关联。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, openModals, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;
const OTHER = 6;
const zipOf = (folder, v) => makeZip(addonEntries(folder, v));

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const A_ = await import(path.join(web, 'actions.js'));

const view = document.getElementById('test-local');
L.initLocal(view);
const panel = () => document.getElementById('task-panel');
let taskModule = 0;

const MODS = {
  100: { name: 'Dungeons', folder: 'Dungeons' },
  200: { name: 'openmap', folder: 'OpenMap' },
  300: { name: 'RegionIcons', folder: 'RegionIcons' },
  400: { name: 'Questie', folder: 'Questie' },
};

/** latest（检查与安装都会查询）或 detail（只有安装会查询）可被挂起的数据源 */
class PausableSource extends FakeSource {
  hold = null;
  holdDetail = null;
  async latest(modId, flavorId) {
    if (this.hold) await this.hold.promise;
    return super.latest(modId, flavorId);
  }
  async detail(modId, flavorId) {
    const h = this.holdDetail;
    if (h) {
      h.entered?.(modId);
      await h.promise;
    }
    return super.detail(modId, flavorId);
  }
  pauseDetail() {
    let resolve;
    let entered;
    const promise = new Promise((r) => (resolve = r));
    const reached = new Promise((r) => (entered = r));
    this.holdDetail = { promise, resolve, entered, reached };
    return reached;
  }
  resumeDetail() {
    const h = this.holdDetail;
    this.holdDetail = null;
    h?.resolve();
  }
  pause() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.hold = { promise, resolve };
  }
  resume() {
    const h = this.hold;
    this.hold = null;
    h?.resolve();
  }
}

/**
 * 可控的下载：behavior(插件编号, 第几次下载) 返回
 * pass：直接完成；hold：报告 35% 后挂起，等待放行或取消；fail：报告 35% 后失败。
 */
function controlledDownload(src) {
  const ctl = {
    started: [],
    holds: new Map(),
    behavior: () => 'pass',
    /** 每次下载完成写入文件之前调用 */
    beforeFinish: () => undefined,
    release(modId) {
      const r = ctl.holds.get(modId);
      assert.ok(r, `${modId} 没有挂起的下载`);
      ctl.holds.delete(modId);
      r();
    },
  };
  ctl.download = async (url, dest, opts) => {
    const modId = /mod_file\/(\d+)\//.exec(url)[1];
    const how = ctl.behavior(modId, ctl.started.length);
    ctl.started.push(modId);
    if (how !== 'pass') {
      opts.onProgress?.(35, 100);
      if (how === 'fail') throw new Error('网络中断（测试）');
      await new Promise((resolve, reject) => {
        ctl.holds.set(modId, resolve);
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
    }
    ctl.beforeFinish(modId);
    return src.download(url, dest);
  };
  return ctl;
}

/**
 * 目录 A（无限）：updatable 中的插件装的是文件 1、远端为文件 2；current 中的插件已是最新。
 * withB：另建目录 B，装同样的插件（文件 1），用于换绑场景。
 */
async function setup({ updatable, current = [], withB = false, source = new FakeSource() }) {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = withB ? await makeGameRoot(path.join(base, 'B')) : null;
  const src = source;
  const m = makeManager(src);
  for (const id of [...updatable, ...current]) {
    src.set(id, F, { name: MODS[id].name, fileId: '1', zip: zipOf(MODS[id].folder, 'v1') });
    await m.install(A, F, id);
    if (B) await m.install(B, F, id);
  }
  for (const id of updatable) src.set(id, F, { name: MODS[id].name, fileId: '2', zip: zipOf(MODS[id].folder, 'v2') });
  const ctl = controlledDownload(src);
  const h = H.createHarness({ settingsFile: path.join(base, 'settings.json'), source: src, download: ctl.download });
  await h.settings.bind(F, A);
  // 每个测试是新的主进程（任务编号从头开始），任务面板也用新的模块实例
  const T = await import(`${path.join(web, 'tasks.js')}?n=${++taskModule}`);
  globalThis.window.beelite = h.api;
  h.api.onTask((e) => {
    S.applyTask(e);
    T.handleTask(e);
  });
  h.api.onAddonWatch((s) => S.applyWatch(s));
  // 0.1.5：进行中的状态来自主进程活动快照（先订阅推送再获取），任务面板按接受的快照恢复卡片
  h.api.onActivity((s) => S.applyActivity(s));
  S.onActivityAccepted(T.syncTasks);
  dom.modalRoot().replaceChildren();
  dom.toastRoot().replaceChildren();
  panel().replaceChildren();
  S.state.busy.clear();
  S.state.notes.clear();
  S.state.activity = null;
  await S.syncActivity();
  S.state.watch = null;
  S.state.localError = null;
  S.state.config = { flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }], categories: [], defaultFlavorId: F, configError: null };
  S.state.flavorId = F;
  await S.refreshLocal();
  await S.checkUpdates(true);
  dom.toastRoot().replaceChildren();
  H.ipcCalls.length = 0;
  src.calls.length = 0;
  const p = (id) => S.state.local.managed.find((x) => x.modId === id);
  return { base, A, B, src, ctl, h, p };
}

async function until(fn, what) {
  for (let i = 0; i < 600; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 已托管列表中某个插件的行（按显示名称查找） */
function row(id) {
  const r = view.all().find((e) => e.classList.contains('row') && e.all().some((n) => n.classList.contains('row-name') && n.textContent === MODS[id].name));
  assert.ok(r, `找不到 ${MODS[id].name} 的行`);
  return r;
}
const rowText = (id) => row(id).textContent;
const buttons = (id) => row(id).all().filter((e) => e.tagName === 'BUTTON');
const buttonMap = (id) => Object.fromEntries(buttons(id).map((b) => [b.textContent, b.disabled]));
const rowOrder = () => view.all().filter((e) => e.classList.contains('row-name')).map((e) => e.textContent);
const toolbarText = () => view.querySelector('.local-toolbar').textContent;
const cards = () => panel().childNodes;
const taskEvents = (h) => h.stub.sent.filter((s) => s.channel === 'task:event').map((s) => s.payload);
const writeCalls = () => H.ipcCalls.filter((c) => c.channel !== 'local:state' && c.channel !== 'addon:watchState');

/** 所有用户入口（不经按钮，直接调用）：都不应发出任何请求 */
async function tryAllEntries(p, id) {
  await A_.updateProject(p(id), false);
  await A_.updateProject(p(id), true);
  await L.uninstallProject(p(id));
  await A_.installMod(id);
  await L.doUpdateAll();
  for (const b of buttons(id)) b.click();
  A_.modActionButton({ id, accessible: true }).click();
  await new Promise((r) => setImmediate(r));
}

test('全部更新：第一项提交、第二项下载 35% 时，第一行立即显示提交的新版本并撤掉“可更新”，第二行显示进度；所有入口同步防重', async () => {
  const { base, A, src, ctl, h, p } = await setup({ updatable: ['100', '200'], current: ['300'] });
  try {
    ctl.behavior = () => 'hold';
    assert.equal(S.updateCount(), 2);
    const order0 = rowOrder();
    const run = L.doUpdateAll();
    // 发起即同步占用：计划确定之前该目标的所有托管行都不能写入
    assert.match(toolbarText(), /更新中/);
    for (const id of ['100', '200', '300']) assert.ok(buttons(id).every((b) => b.disabled), `${id} 的写按钮应禁用`);
    // 计划确定之前：可更新插件的“更新”按钮位置显示禁用的“检查中”，发现页 / 详情按钮同样
    for (const id of ['100', '200']) {
      assert.equal(buttonMap(id)['检查中'], true);
      assert.equal(buttonMap(id)['更新'], undefined, '不再显示“更新”按钮');
      const b = A_.modActionButton({ id, accessible: true });
      assert.deepEqual([b.textContent, b.disabled, b.classList.contains('btn-primary')], ['检查中', true, false]);
    }

    await until(() => ctl.started.length === 1 && /下载中 35%/.test(rowText(ctl.started[0])), '第一项下载 35%');
    const [first, second] = [ctl.started[0], ctl.started[0] === '100' ? '200' : '100'];
    assert.match(rowText(second), /等待中/, '第二项在等待');
    // 按钮本身显示进度：原“更新”按钮的位置替换为禁用的状态按钮
    // 0.2.0：每行多一个“暂停更新”，处理中同样禁用
    assert.deepEqual(buttonMap(first), { '下载中 35%': true, 暂停更新: true, 重装: true, 卸载: true });
    assert.deepEqual(buttonMap(second), { 等待中: true, 暂停更新: true, 重装: true, 卸载: true });
    for (const id of [first, second]) assert.equal(A_.modActionButton({ id, accessible: true }).textContent, '处理中');
    assert.doesNotMatch(rowText('300'), /等待中|下载中/, '不在计划中的插件不显示进度');
    assert.equal(cards().length, 1, '等待中的项目不占任务卡片');

    // 所有入口直接调用（不只是按钮禁用）：不发出任何请求、不查询远端、不新增下载，也不弹出确认框
    const ipc0 = H.ipcCalls.length;
    const src0 = src.calls.length;
    for (const id of ['100', '200', '300']) await tryAllEntries(p, id);
    assert.equal(openModals(dom).length, 0);
    assert.equal(H.ipcCalls.length, ipc0, '没有任何新的请求');
    assert.equal(src.calls.length, src0);
    assert.deepEqual(ctl.started, [first]);

    ctl.release(first);
    await until(() => ctl.started.length === 2 && /下载中 35%/.test(rowText(second)), '第二项下载 35%');
    const done = taskEvents(h).filter((e) => e.modId === first && e.phase === 'done');
    assert.equal(done.length, 1, '每个任务只有一个 done');
    assert.equal(done[0].installed?.fileId, '2', 'done 带有提交到清单的记录');
    assert.equal(done[0].installed?.version, 'v2');
    assert.deepEqual([done[0].flavorId, done[0].root], [F, A]);
    // 第一行：清单中已提交的新版本，不再可更新；第二行：真实进度
    assert.equal(p(first).fileId, '2');
    assert.equal(p(first).toc, null, '不沿用旧版本的 TOC');
    assert.ok(p(first).folders.every((f) => f.present));
    assert.match(rowText(first), /版本 v2/);
    assert.doesNotMatch(rowText(first), /可更新/);
    assert.match(rowText(first), /已是最新/, '更新检查结果已按新清单逐项同步');
    assert.equal(buttonMap(first)['更新'], undefined, '第一行不再有“更新”按钮');
    assert.ok(buttons(first).every((b) => b.disabled), '批次未结束：仍受批次占用');
    assert.match(rowText(second), /版本 v1/);
    assert.match(rowText(second), /下载中 35%/);
    assert.deepEqual(buttonMap(second), { '下载中 35%': true, 暂停更新: true, 重装: true, 卸载: true });
    assert.equal(S.updateCount(), 1);
    assert.equal(S.currentWatchEntry().pending, 1, '全局待更新数逐项减少');
    assert.equal(H.ipcCalls.filter((c) => c.channel === 'local:state').length, 0, '没有等待整页刷新');
    assert.deepEqual(rowOrder(), order0, '批次中行顺序不跳动');
    assert.equal(cards().length, 2);

    ctl.release(second);
    await run;
    assert.equal(p('100').fileId, '2');
    assert.equal(p('200').fileId, '2');
    assert.doesNotMatch(toolbarText(), /更新中/);
    for (const id of ['100', '200', '300']) assert.ok(buttons(id).every((b) => !b.disabled), `${id} 批次结束后恢复可操作`);
    assert.ok(toasts(dom).some((t) => t.includes('已更新 2 个插件')));
    // 每个任务恰好一个终态
    const finals = taskEvents(h).filter((e) => ['done', 'failed', 'cancelled'].includes(e.phase));
    assert.equal(new Set(finals.map((e) => e.taskId)).size, finals.length);
    assert.ok(taskEvents(h).every((e) => e.flavorId === F && e.root === A && typeof e.modId === 'string'));
    const manifest = await H.readManifestJson(A);
    assert.deepEqual([manifest.projects['100'].fileId, manifest.projects['200'].fileId, manifest.projects['300'].fileId], ['2', '2', '1']);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新：一项失败、一项取消后继续下一项；失败与取消保留旧版本和说明，汇总如实区分，批次结束后恢复操作', async () => {
  const { base, A, ctl, h, p } = await setup({ updatable: ['100', '200', '400'] });
  try {
    ctl.behavior = (_id, i) => (i === 0 ? 'fail' : i === 1 ? 'hold' : 'pass');
    const run = L.doUpdateAll();
    await until(() => ctl.started.length === 2 && /下载中 35%/.test(rowText(ctl.started[1])), '第二项下载 35%');
    const [failed, cancelled] = ctl.started;
    assert.match(rowText(failed), /版本 v1/);
    assert.match(rowText(failed), /未完成：网络中断（测试）/);
    assert.match(rowText(failed), /可更新到 v2/, '失败不误报为最新');
    assert.equal(buttonMap(failed)['全部更新中'], true, '批次未结束：失败项仍受批次占用，不显示可点的“更新”');
    assert.equal(buttonMap(failed)['更新'], undefined);
    assert.ok(cards().some((c) => c.classList.contains('task-failed')), '失败卡片保留');

    // 在任务面板点“取消”
    const cancelBtn = panel().all().find((e) => e.tagName === 'BUTTON' && e.textContent === '取消');
    assert.ok(cancelBtn);
    cancelBtn.click();
    await run;
    const third = ctl.started[2];
    assert.ok(third, '取消一项后继续处理下一项');
    assert.equal(p(third).fileId, '2');
    assert.equal(p(failed).fileId, '1');
    assert.equal(p(cancelled).fileId, '1');
    assert.match(rowText(cancelled), /已取消/);
    assert.match(rowText(failed), /未完成：网络中断（测试）/);
    assert.ok(toasts(dom).some((t) => t.includes('已更新 1 个插件，取消 1 个，失败 1 个')), toasts(dom).join(' | '));
    assert.ok(!toasts(dom).some((t) => /失败 2 个/.test(t)), '取消不计为失败');
    for (const id of [failed, cancelled]) assert.equal(buttonMap(id)['更新'], false, '批次结束后可以重新更新');
    const manifest = await H.readManifestJson(A);
    assert.equal(manifest.projects[failed].fileId, '1');
    assert.equal(manifest.projects[cancelled].fileId, '1');
    assert.equal(manifest.projects[third].fileId, '2');

    // 重新更新失败的插件：旧说明随即清除，这次成功
    await A_.updateProject(p(failed), false);
    assert.equal(p(failed).fileId, '2');
    assert.doesNotMatch(rowText(failed), /未完成/);
    assert.match(rowText(cancelled), /已取消/, '其他插件的说明不受影响');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新中途换绑 A→B：B 中同一插件不显示 A 的进度、版本或占用；未开始的项目结束等待且不新建任务卡片', async () => {
  const { base, A, B, ctl, h, p } = await setup({ updatable: ['100', '200', '400'], withB: true });
  try {
    const b0 = await H.snapshot(B);
    ctl.behavior = (_id, i) => (i === 0 ? 'hold' : 'pass');
    const run = L.doUpdateAll();
    await until(() => ctl.started.length === 1 && /下载中 35%/.test(rowText(ctl.started[0])), '第一项下载 35%');
    const first = ctl.started[0];
    // 在其他入口换绑到 B，界面刷新后显示 B
    await h.settings.bind(F, B);
    await S.refreshLocal();
    assert.equal(S.currentTarget().root, B);
    for (const id of ['100', '200', '400']) {
      assert.doesNotMatch(rowText(id), /等待中|下载中|处理中/, `B 中 ${id} 不显示 A 的进度`);
      assert.ok(buttons(id).every((b) => !b.disabled), `B 中 ${id} 不受 A 的批次占用`);
      assert.notEqual(A_.modActionButton({ id, accessible: true }).textContent, '处理中');
    }
    assert.doesNotMatch(toolbarText(), /更新中/);

    ctl.release(first);
    await run;
    assert.ok(toasts(dom).some((t) => t.includes('游戏目录绑定已变更，剩余 2 个未处理')), toasts(dom).join(' | '));
    for (const id of ['100', '200', '400']) assert.equal(p(id).fileId, '1', `A 的完成结果不写到 B 的 ${id} 上`);
    const leftovers = taskEvents(h).filter((e) => e.phase === 'cancelled');
    assert.equal(leftovers.length, 2);
    assert.ok(leftovers.every((e) => e.root === A && e.message === '全部更新已停止，这一项未处理'));
    assert.equal(cards().length, 1, '未开始的项目不新建“已取消”卡片');
    assert.deepEqual([S.state.activity.tasks, S.state.activity.batches], [[], []], '没有残留的等待状态');
    assert.deepEqual(await H.snapshot(B), b0, 'B 没有被写入');

    // 换回 A：第一项是提交的新版本；未开始的两项保持旧版本、显示未处理且可以操作
    await h.settings.bind(F, A);
    await S.refreshLocal();
    assert.equal(p(first).fileId, '2');
    for (const id of ['100', '200', '400'].filter((x) => x !== first)) {
      assert.equal(p(id).fileId, '1');
      assert.match(rowText(id), /全部更新已停止，这一项未处理/);
      assert.ok(buttons(id).every((b) => !b.disabled));
    }
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新：计划确定之前（批次正在重新检查）该目标的托管行已禁止写入，所有入口不发请求', async () => {
  const source = new PausableSource();
  const { base, ctl, h, p } = await setup({ updatable: ['100', '200'], current: ['300'], source });
  try {
    source.pause();
    const run = L.doUpdateAll();
    await until(() => H.ipcCalls.some((c) => c.channel === 'addon:updateAll') && S.state.activity.batches.length === 1, '已发起全部更新、主进程已登记批次');
    assert.deepEqual(S.state.activity.tasks, [], '计划尚未确定');
    assert.deepEqual(S.state.activity.batches.map((b) => [b.root, b.stage]), [[S.currentTarget().root, 'checking']], '主进程已登记批次（检查中）');
    const ipc0 = H.ipcCalls.length;
    for (const id of ['100', '200', '300']) {
      assert.ok(buttons(id).every((b) => b.disabled));
      await tryAllEntries(p, id);
    }
    assert.equal(openModals(dom).length, 0);
    assert.equal(H.ipcCalls.length, ipc0);
    source.resume();
    await run;
    assert.deepEqual(ctl.started.sort(), ['100', '200']);
    assert.equal(p('100').fileId, '2');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('提交前读取的 local:state 回复晚到：不能覆盖已提交的新版本（新刷新使旧序号失效），最终完整刷新仍执行', async () => {
  const { base, ctl, h, p } = await setup({ updatable: ['100', '200'] });
  try {
    ctl.behavior = () => 'hold';
    const api = h.api;
    let holdNext = true;
    let held = null;
    globalThis.window.beelite = {
      ...api,
      localState: async (f) => {
        const r = await api.localState(f);
        if (holdNext) {
          holdNext = false;
          await new Promise((release) => (held = { release, r }));
        }
        return r;
      },
    };
    // 1. 用户点了“刷新”：主进程已读出批次开始前的状态，回复被延迟
    const refresh = S.refreshLocal();
    await until(() => held, '旧刷新已读出');
    // 2. 全部更新：第一项提交、第二项挂起在 35%（持有目录锁）
    const run = L.doUpdateAll();
    await until(() => ctl.started.length === 1, '第一项开始');
    const [first, second] = [ctl.started[0], ctl.started[0] === '100' ? '200' : '100'];
    ctl.release(first);
    await until(() => ctl.started.length === 2 && /下载中 35%/.test(rowText(second)), '第二项下载 35%');
    // 3. 已提交的行立即更新；正在进行的旧刷新被提交后发起的新刷新取代（localSeq 递增）
    assert.equal(p(first).fileId, '2');
    assert.equal(H.ipcCalls.filter((c) => c.channel === 'local:state').length, 2, '旧刷新 + 提交后发起的新刷新');
    // 4. 旧回复到达：它是提交之前的状态，但已被丢弃
    held.release();
    await refresh;
    assert.equal(held.r.managed.find((x) => x.modId === first).fileId, '1', '旧回复确实是提交之前的状态');
    assert.equal(p(first).fileId, '2', '旧回复没有覆盖已提交的新版本');
    assert.match(rowText(first), /版本 v2/);
    ctl.release(second);
    await run;
    assert.equal(S.state.localLoading, false);
    assert.equal(p('100').fileId, '2');
    assert.equal(p('200').fileId, '2');
  } finally {
    globalThis.window.beelite = undefined;
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('列表尚未就绪时收到提交（A→其他版本→A）：提交之前读出的回复晚到仍显示提交的版本；收到完成不重启读取，其他版本的完成也不影响', async () => {
  const source = new PausableSource();
  const { base, ctl, h, p } = await setup({ updatable: ['100', '200'], source });
  try {
    ctl.behavior = (_id, i) => (i === 0 ? 'pass' : 'hold');
    // 第一项在取得目录锁之前停住，让 A 的读取能在提交之前完成
    const reached = source.pauseDetail();
    const run = L.doUpdateAll();
    const first = await reached;
    const second = first === '100' ? '200' : '100';
    const api = h.api;
    let held = null;
    globalThis.window.beelite = {
      ...api,
      localState: async (f) => {
        const r = await api.localState(f);
        if (f === F && !held) await new Promise((release) => (held = { release, r }));
        return r;
      },
    };
    S.setFlavor(OTHER);
    S.setFlavor(F);
    await until(() => held, 'A 的读取已完成并被延迟');
    assert.equal(S.state.local, null, '列表尚未就绪');
    assert.equal(held.r.managed.find((x) => x.modId === first).fileId, '1', '这次读取在提交之前');
    const reads = () => H.ipcCalls.filter((c) => c.channel === 'local:state').length;
    const reads0 = reads();

    source.resumeDetail();
    await until(() => ctl.started.length === 2 && ctl.holds.has(second), '第二项下载 35%');
    assert.equal(taskEvents(h).filter((e) => e.modId === first && e.phase === 'done').length, 1, '第一项已提交');
    assert.equal(reads(), reads0, '列表未就绪时收到完成不重启读取（不会排到第二项的目录锁之后）');
    // 其他版本同一插件编号的完成：不重启读取，也不套用到 A
    const other = { label: 'x', flavorId: OTHER, root: '/other/root', modId: first };
    const rev = S.state.activity.rev;
    S.applyTask({ ...other, taskId: 'o1', phase: 'queued', rev: rev + 1000 });
    S.applyTask({ ...other, taskId: 'o1', phase: 'done', rev: rev + 1001, installed: { flavorId: OTHER, fileId: '9', version: 'v9', name: 'x', logo: null, folders: ['X'], installedAt: 1 } });
    assert.equal(reads(), reads0);

    held.release();
    await until(() => S.state.local && !S.state.localLoading, '旧回复已到达');
    assert.equal(p(first).fileId, '2', '旧回复没有把已提交的版本改回去');
    assert.equal(p(first).toc, null);
    assert.match(rowText(first), /版本 v2/);
    assert.equal(buttonMap(first)['更新'], undefined);
    assert.equal(buttonMap(second)['下载中 35%'], true, '第二项仍在下载');
    ctl.release(second);
    await run;
    assert.equal(p('100').fileId, '2');
    assert.equal(p('200').fileId, '2');
  } finally {
    source.resumeDetail();
    globalThis.window.beelite = undefined;
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('单项更新使用同一机制：进度显示在行上、所有入口防重；已是最新（没有提交）时不伪造安装时间与目录', async () => {
  const { base, A, ctl, h, p } = await setup({ updatable: ['100'], current: ['300'] });
  try {
    ctl.behavior = () => 'hold';
    const run = A_.updateProject(p('100'), false);
    await until(() => /下载中 35%/.test(rowText('100')), '下载 35%');
    assert.ok(buttons('100').every((b) => b.disabled));
    const ipc0 = H.ipcCalls.length;
    await tryAllEntries(p, '100');
    assert.equal(H.ipcCalls.length, ipc0, '重复操作与全部更新都没有发出');
    assert.equal(A_.modActionButton({ id: '100', accessible: true }).textContent, '处理中');
    assert.ok(buttons('300').every((b) => !b.disabled), '其他插件不受影响');
    ctl.release('100');
    await run;
    assert.equal(p('100').fileId, '2');
    const done100 = taskEvents(h).filter((e) => e.modId === '100' && e.phase === 'done');
    assert.equal(done100.length, 1);
    assert.equal(done100[0].installed.fileId, '2');

    // 已是最新：没有提交，done 不带记录，界面与清单都不变
    const before = { ...p('300') };
    const m0 = await H.readManifestJson(A);
    await A_.updateProject(p('300'), false);
    const done300 = taskEvents(h).filter((e) => e.modId === '300' && e.phase === 'done');
    assert.equal(done300.length, 1);
    assert.equal('installed' in done300[0], false, '没有提交就没有安装记录');
    assert.deepEqual(p('300'), before);
    assert.deepEqual((await H.readManifestJson(A)).projects['300'], m0.projects['300']);
    assert.deepEqual(writeCalls().map((c) => c.channel), ['addon:update', 'addon:update']);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('提交成功后只读同步失败：不算安装失败、不猜测状态，明确显示无法确认更新状态', async () => {
  const { base, ctl, h, p } = await setup({ updatable: ['100', '200'] });
  try {
    const mgr = h.service.manager;
    const orig = mgr.readCheckedManifest.bind(mgr);
    let failRead = false;
    mgr.readCheckedManifest = async (root) => {
      if (failRead) {
        failRead = false;
        throw new Error('清单暂时无法读取（测试）');
      }
      return orig(root);
    };
    // 第一项下载完成时安排一次读取失败：落在提交之后的同步上
    ctl.beforeFinish = () => {
      if (ctl.started.length === 1) failRead = true;
    };
    await L.doUpdateAll();
    assert.ok(toasts(dom).some((t) => t.includes('已更新 2 个插件')), toasts(dom).join(' | '));
    const first = ctl.started[0];
    const done = taskEvents(h).filter((e) => e.modId === first && e.phase === 'done');
    assert.equal(done.length, 1);
    assert.equal(done[0].installed.fileId, '2');
    assert.equal(p(first).fileId, '2');
    assert.equal(S.currentWatchEntry().status, 'error');
    assert.match(S.currentWatchEntry().error, /无法确认更新状态/);
    assert.doesNotMatch(rowText(first), /已是最新/, '无法确认时不显示“已是最新”');
    assert.match(toolbarText(), /无法确认更新状态/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('任务事件只按 目标 + 插件编号 关联：其他目录 / 其他版本的事件、旧任务或重复的终态都不影响当前行', async () => {
  const { base, A, B, h, p } = await setup({ updatable: ['200'], withB: true });
  try {
    // 0.1.5：是否进行中来自主进程活动快照，事件带来下载字节数与终态；两者共用一个 rev 序列
    const instance = S.state.activity.instance;
    let rev = S.state.activity.rev;
    const task = (o = {}) => ({ taskId: 'x2', label: 'openmap', flavorId: F, root: A, modId: '200', phase: 'downloading', received: 10, total: 100, batchId: null, ...o });
    const snap = (tasks, at = ++rev) => ({ instance, rev: at, batches: [], tasks, reservations: [] });
    const ev = (o) => ({ label: 'openmap', flavorId: F, root: A, modId: '200', rev: ++rev, ...o });
    const rec = (fileId) => ({ flavorId: F, fileId, version: `v${fileId}`, name: 'openmap', logo: null, folders: ['OpenMap'], installedAt: 1 });
    assert.equal(S.applyActivity(snap([task()])), true);
    S.applyTask(ev({ taskId: 'x1', phase: 'failed', message: '旧任务' }));
    assert.equal(S.rowTask('200').taskId, 'x2', '旧任务的终态不清除更晚的任务');
    assert.match(rowText('200'), /下载中 10%/);
    const btn = buttons('200').find((b) => b.textContent === '下载中 10%');
    assert.ok(btn?.disabled, '“更新”按钮的位置显示禁用的进度');
    const rowEl = row('200');
    S.applyTask(ev({ taskId: 'x2', phase: 'downloading', received: 47, total: 100 }));
    assert.match(rowText('200'), /下载中 47%/, '百分比就地更新');
    assert.equal(row('200'), rowEl, '百分比变化不重建行');
    assert.ok(buttons('200').includes(btn), '按钮节点不变');
    assert.equal(btn.textContent, '下载中 47%');
    assert.equal(btn.disabled, true);
    // 迟到的旧快照（10%）被丢弃，进度不倒退；比快照旧的事件也不覆盖快照
    assert.equal(S.applyActivity(snap([task()], rev - 3)), false);
    assert.equal(S.rowTask('200').percent, 47);

    S.applyTask(ev({ taskId: 'y1', phase: 'done', root: '/other/root', installed: rec('9') }));
    S.applyActivity(snap([task({ received: 47 }), task({ taskId: 'y2', flavorId: OTHER, phase: 'queued' })]));
    assert.equal(p('200').fileId, '1', '其他目录的完成结果不写到当前行');
    assert.equal(S.rowTask('200').taskId, 'x2', '其他版本的同一插件不影响当前行');

    S.applyTask(ev({ taskId: 'x2', phase: 'done', installed: rec('2') }));
    assert.equal(p('200').fileId, '2');
    S.applyTask(ev({ taskId: 'x2', phase: 'done', installed: rec('3') }));
    assert.equal(p('200').fileId, '2', '同一任务只结算一次');
    assert.equal(S.rowTask('200'), undefined, '收到终态后即使快照尚未追上也不再显示进行中');

    // 列表尚未就绪时目录已改绑到 B：A 的提交记录不会套用到 B 中同一插件
    await h.settings.bind(F, B);
    S.setFlavor(F);
    S.applyTask(ev({ taskId: 'z1', phase: 'queued' }));
    S.applyTask(ev({ taskId: 'z1', phase: 'done', installed: rec('7') }));
    await until(() => S.state.local && !S.state.localLoading, '读取 B');
    assert.equal(S.state.local.profile.root, B);
    assert.equal(p('200').fileId, '1');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

/**
 * 每个插件装有 <前缀>Core、<前缀>Gone、<前缀>Missing 三个目录的文件 1；更新前 <前缀>Missing 已不在 AddOns，
 * 远端文件 2 只含 <前缀>Core。每项更新返回两条提示（已移入备份、没有可备份的内容）。
 */
async function warningSetup(mods) {
  const s = await setup({ updatable: [] });
  const m = makeManager(s.src);
  const entries = (prefix, v, parts) => makeZip(parts.flatMap((f) => addonEntries(`${prefix}${f}`, v)));
  for (const [id, name, prefix] of mods) {
    s.src.set(id, F, { name, fileId: '1', zip: entries(prefix, 'v1', ['Core', 'Gone', 'Missing']) });
    await m.install(s.A, F, id);
    await rm(path.join(s.A, 'Interface', 'AddOns', `${prefix}Missing`), { recursive: true });
    s.src.set(id, F, { name, fileId: '2', zip: entries(prefix, 'v2', ['Core']) });
  }
  await S.refreshLocal();
  await S.checkUpdates(true);
  dom.toastRoot().replaceChildren();
  assert.equal(S.updateCount(), mods.length);
  return s;
}

const notesFor = (name, prefix) => [
  `${name}：新版本不再包含 ${prefix}Gone，已随旧版本一起移入备份`,
  `${name}：新版本不再包含 ${prefix}Missing；它们在更新前已不在 AddOns 中，没有可备份的内容`,
];

/** 记录 toast 的显示时长（假 window 的计时器不执行） */
function recordTimeouts() {
  const ms = [];
  const original = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (_fn, t) => (ms.push(t), 0);
  return { ms, restore: () => (globalThis.window.setTimeout = original) };
}

test('全部更新显示每项更新的提示（Core / Gone / Missing）：经 IPC 到界面逐条显示并带插件名称；任务事件与计数不变', async () => {
  const { base, A, h } = await warningSetup([['100', 'WarningFixture', '']]);
  const timers = recordTimeouts();
  try {
    await L.doUpdateAll();
    const shown = dom.toastRoot().childNodes;
    assert.deepEqual(toasts(dom), ['已更新 1 个插件×', ...notesFor('WarningFixture', '').map((w) => `${w}×`)]);
    assert.deepEqual(shown.map((t) => t.className), ['toast toast-success', 'toast toast-warn', 'toast toast-warn']);
    assert.ok(shown.every((t) => !t.querySelector('.toast-msg-list')), '提示不多时逐条显示，不合并');
    assert.equal(timers.ms.includes(15000), false);
    const done = taskEvents(h).filter((e) => e.phase === 'done');
    assert.equal(done.length, 1);
    assert.equal(done[0].message, '「WarningFixture」已更新到 v2');
    assert.equal('warnings' in done[0], false, '任务事件结构不变');
    const manifest = await H.readManifestJson(A);
    assert.equal(manifest.projects['100'].fileId, '2');
    assert.ok(manifest.recovery.some((e) => e.kind === 'update-backup' && e.folders.includes('Gone')));
    assert.equal(manifest.recovery.some((e) => e.folders.includes('Missing')), false);
  } finally {
    timers.restore();
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新的提示超过 4 条：合并为一条限高可滚动的提示，全部内容可读，显示 15 秒', async () => {
  const mods = [['100', 'Dungeons', 'D'], ['200', 'openmap', 'O'], ['300', 'RegionIcons', 'R']];
  const { base, h } = await warningSetup(mods);
  const timers = recordTimeouts();
  try {
    await L.doUpdateAll();
    const shown = dom.toastRoot().childNodes;
    assert.equal(shown.length, 2, '结果一条 + 合并的提示一条，没有被挤掉的提示');
    assert.equal(toasts(dom)[0], '已更新 3 个插件×');
    const list = shown[1].querySelector('.toast-msg-list');
    assert.ok(list, '合并的提示使用限高的文字区域');
    assert.equal(shown[1].className, 'toast toast-warn');
    assert.equal(list.attrs.tabindex, '0', '可用键盘聚焦后滚动');
    assert.deepEqual(list.textContent.split('\n').sort(), mods.flatMap(([, name, prefix]) => notesFor(name, prefix)).sort());
    assert.ok(timers.ms.includes(15000));
  } finally {
    timers.restore();
    h.service.watch.stop();
    await cleanup(base);
  }
});
