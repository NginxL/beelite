// 配置备份（0.2.0）：界面重新载入后恢复主进程中进行中的备份任务。
// 链路：编译后的渲染层 → 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// “重新载入”的模拟与 renderer-reload 相同：丢弃旧界面的全部订阅，把编译后的 renderer/ 与 shared/ 复制到新目录重新导入（全新的模块实例），
// 按 main.ts 的顺序先订阅任务推送、再获取任务快照；主进程实例与其中进行中的备份保持不变。不进入配置备份页，因此不读取完整状态；
// 进入页面后任务槽显示原任务与它自己的范围。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { cleanup, FakeSource, makeGameRoot, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const webShared = path.join(here, '..', 'dist', 'web', 'shared');
installFakeDom(null);

async function until(fn, what) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 页面销毁后，旧页面拿到的 Promise 永不完成，旧页面的后续代码不会再运行 */
function pageApi(raw) {
  const page = { destroyed: false };
  page.api = new Proxy(raw, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      return (...args) => {
        const r = v.apply(target, args);
        if (!r || typeof r.then !== 'function') return r;
        r.catch(() => undefined);
        return new Promise((resolve, reject) => r.then((x) => !page.destroyed && resolve(x), (e) => !page.destroyed && reject(e)));
      };
    },
  });
  return page;
}

let seq = 0;
let currentPage = null;

/** 载入一个全新的界面：初始化配置备份页（不打开）、先订阅备份任务推送再获取任务快照（与 main.ts 相同的顺序），再读取本地插件列表（停在“已托管”） */
async function freshRenderer(h, base) {
  if (currentPage) currentPage.destroyed = true;
  const page = pageApi(h.api);
  currentPage = page;
  h.stub.listeners.clear(); // 旧页面销毁：它的订阅全部失效
  const pageDir = path.join(base, `renderer-${++seq}`);
  const dir = path.join(pageDir, 'renderer');
  await cp(web, dir, { recursive: true });
  await cp(webShared, path.join(pageDir, 'shared'), { recursive: true });
  for (const id of ['test-local', 'test-backup', 'toast-root', 'modal-root']) document.getElementById(id).replaceChildren();
  globalThis.window.beelite = page.api;
  const S = await import(path.join(dir, 'state.js'));
  const L = await import(path.join(dir, 'local.js'));
  const B = await import(path.join(dir, 'backup.js'));
  S.state.config = { flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }], categories: [], defaultFlavorId: F, configError: null };
  S.state.flavorId = F;
  const backupView = document.getElementById('test-backup');
  B.initBackup(backupView);
  page.api.onActivity((s) => void S.applyActivity(s));
  page.api.onBackupTask((s) => void B.applyBackupTask(s));
  await B.syncBackupTask();
  await S.syncActivity();
  const view = document.getElementById('test-local');
  L.initLocal(view);
  await S.refreshLocal();
  return { S, L, B, view, backupView };
}

/** 测试钩子：在指定阶段暂停任务，直到 release */
function pauser() {
  const p = { armed: null };
  p.arm = (at) => {
    let reached;
    let release;
    p.armed = { at, reachedP: new Promise((r) => (reached = r)), gateP: new Promise((r) => (release = r)) };
    p.armed.reached = reached;
    return { reached: p.armed.reachedP, release };
  };
  p.step = async (name) => {
    const a = p.armed;
    if (a && a.at === name) {
      p.armed = null;
      a.reached();
      await a.gateP;
    }
  };
  return p;
}

test('重新载入后恢复进行中的备份：新页面先订阅再取快照，显示原任务与原目录（已换绑），可按原任务取消；不重新备份、不读取完整状态', async () => {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const pause = pauser();
  const h = H.createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource(), backup: { hooks: { step: (n) => pause.step(n) } } });
  try {
    const A = await makeGameRoot(path.join(base, 'A'));
    const other = await makeGameRoot(path.join(base, 'B'));
    await h.settings.bind(F, A);
    const picked = path.join(base, 'pick');
    await mkdir(picked);
    h.stub.pick = picked;
    const enabled = await h.api.backupConfigure(F, A);
    h.stub.pick = null;
    const container = enabled.containerPath;

    // 第一个页面：发起备份（经主进程，停在复制阶段）
    const p1 = await freshRenderer(h, base);
    const at = pause.arm('copy-file');
    const run = h.api.backupRun(F, A, { kind: 'account', account: 'TEST' });
    await at.reached;
    await until(() => p1.B.backupTask()?.phase === 'copying', '旧页面看到任务');
    const original = p1.B.backupTask();

    // 进行中换绑到另一个目录，然后重新载入
    await h.settings.bind(F, other);
    H.ipcCalls.length = 0;
    const p2 = await freshRenderer(h, base);
    assert.notEqual(p2.B, p1.B, '新的模块实例');
    const task = p2.B.backupTask();
    assert.ok(task, '新页面恢复了进行中的任务');
    assert.equal(task.id, original.id);
    assert.equal(task.root, A, '任务仍属于原目录');
    assert.equal(task.flavorId, F);
    assert.equal(task.phase, 'copying');
    assert.equal(task.filesTotal, original.filesTotal);
    assert.deepEqual(task.scope, { kind: 'account', account: 'TEST' }, '任务带着受理时的范围');
    assert.equal(p2.S.currentTarget().root, other, '当前显示的是换绑后的目录');
    assert.equal(p2.B.backupNavBadge(), '进行中', '侧栏标出进行中的备份');
    assert.doesNotMatch(p2.view.textContent, /配置备份/, '我的插件页不再有配置备份入口');
    assert.equal(p2.backupView.all().filter((e) => e.tagName === 'BUTTON' && e.textContent === '取消').length, 0, '页面未打开：没有任务卡片');

    // 新页面的订阅生效：进度推送只到新页面
    const stale = p1.B.backupTask();
    h.service.pushBackupTask();
    await until(() => p2.B.backupTask() !== task, '新页面收到推送');
    assert.equal(p2.B.backupTask().id, original.id);
    assert.equal(p1.B.backupTask(), stale, '旧页面的订阅已销毁');
    assert.equal(H.ipcCalls.filter((c) => c.channel === 'backup:state').length, 0, '没有进入配置备份页：不读取完整状态');

    // 进入配置备份页：任务槽显示原任务、原目录与任务自己的范围（读取的是当前目录的状态）
    p2.B.setBackupPageOpen(true);
    assert.match(p2.backupView.textContent, /正在备份/);
    assert.match(p2.backupView.textContent, /范围：账号「TEST」（完整账号目录）/);
    assert.match(p2.backupView.textContent, /原目录（不是当前显示的目录）/);
    assert.ok(p2.backupView.textContent.includes(A));

    // 按原任务取消（原编号、原版本、原目录，不是当前目录）
    await p2.B.cancelBackupTask(p2.B.backupTask());
    const cancel = H.ipcCalls.find((c) => c.channel === 'backup:cancel');
    assert.deepEqual(cancel.args, [original.id, F, A]);
    await until(() => p2.B.backupTask()?.cancelling, '取消中');
    at.release();
    const out = await run;
    assert.equal(out.status, 'cancelled');
    await until(() => p2.B.backupTask() === null, '新页面看到任务结束');

    assert.equal(H.ipcCalls.filter((c) => c.channel === 'backup:run').length, 0, '重新载入不重新发起备份');
    assert.ok(H.ipcCalls.filter((c) => c.channel === 'backup:state').every((c) => c.args[1] === other), '只读取当前目录的状态');
    assert.equal(H.ipcCalls.filter((c) => c.channel === 'backup:catalog').length, 0, '不读取账号与角色');
    assert.ok(!(await readdir(container)).some((n) => n.startsWith('.partial-')), '取消后临时内容已清理');
  } finally {
    await h.service.backup.shutdown();
    await cleanup(base);
  }
});

// ---------- 0.3.1：重新载入后未完成恢复的状态 ----------

/**
 * 载入一个全新的界面（含未完成恢复的提示条），与 main.ts 相同的顺序：订阅任务推送 → 获取任务快照（不等待）→ 初始化恢复 → 启动查询。
 * wrap 可以替换页面看到的接口（模拟回复的先后）；ready 在任务快照与启动查询都结束后完成
 */
async function freshRestorePage(h, base, wrap = (api) => api) {
  if (currentPage) currentPage.destroyed = true;
  const page = pageApi(h.api);
  currentPage = page;
  h.stub.listeners.clear();
  const pageDir = path.join(base, `renderer-${++seq}`);
  const dir = path.join(pageDir, 'renderer');
  await cp(web, dir, { recursive: true });
  await cp(webShared, path.join(pageDir, 'shared'), { recursive: true });
  for (const id of ['test-backup', 'toast-root', 'modal-root', 'restore-warning']) document.getElementById(id).replaceChildren();
  const api = wrap(page.api);
  globalThis.window.beelite = api;
  const S = await import(path.join(dir, 'state.js'));
  const B = await import(path.join(dir, 'backup.js'));
  const R = await import(path.join(dir, 'restore.js'));
  S.state.config = { flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }], categories: [], defaultFlavorId: F, configError: null };
  S.state.flavorId = F;
  B.initBackup(document.getElementById('test-backup'));
  api.onBackupTask((s) => void B.applyBackupTask(s));
  const synced = B.syncBackupTask();
  const banner = document.getElementById('restore-warning');
  R.initRestore(banner);
  const started = R.refreshPending();
  return { S, B, R, banner, synced, ready: Promise.all([synced, started]) };
}

const RESTORE_ACK = { gameClosed: true, overwrite: true };
const pendingCalls = () => H.ipcCalls.filter((c) => c.channel === 'restore:pending').length;
const settled = (p) => !!p.R.restorePending().view && !p.R.restorePending().loading;

test('重新载入后主进程中的恢复结束（0.3.0 复现）：新页面按任务快照重新查询未完成的恢复，不依赖旧页面；进度不查询', async () => {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const pause = pauser();
  const h = H.createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource(), restore: { hooks: { step: (n) => pause.step(n) }, freeBytes: async () => 1e12 } });
  try {
    const A = await makeGameRoot(path.join(base, 'A'));
    const sv = path.join(A, 'WTF', 'Account', 'TEST', 'SavedVariables', 'Questie.lua');
    await h.settings.bind(F, A);
    const picked = path.join(base, 'pick');
    await mkdir(picked);
    h.stub.pick = picked;
    await h.api.backupConfigure(F, A);
    h.stub.pick = null;
    const run0 = await h.api.backupRun(F, A, { kind: 'all' });
    assert.equal(run0.status, 'completed');
    const snapshotId = run0.result.snapshot.id;

    /** 预览并开始执行恢复（经主进程），停在候选树完成之后 */
    const startRestore = async (content) => {
      await writeFile(sv, content);
      const p = await h.api.backupRestorePreview(F, A, snapshotId);
      assert.equal(p.status, 'completed');
      assert.ok(p.result.token, p.result.blockers?.join('；'));
      const at = pause.arm('staged');
      const run = h.api.backupRestoreApply(p.result.token, RESTORE_ACK);
      await at.reached;
      return { run, release: at.release };
    };

    // 情形一：旧页面发起恢复后重新载入；新页面启动时看到进行中的恢复，主进程结束后自行刷新
    await (await freshRestorePage(h, base)).ready;
    const r1 = await startRestore('Questie = 1\n');
    const p2 = await freshRestorePage(h, base);
    await p2.ready;
    await until(() => settled(p2) && p2.B.backupTask()?.kind === 'restore', '新页面看到进行中的恢复');
    assert.equal(p2.R.restorePending().view.items.length, 1);
    assert.ok(p2.R.restoreBlockReason({ flavorId: F, root: A }));
    const calls0 = pendingCalls();
    r1.release();
    const out1 = await r1.run;
    assert.equal(out1.status, 'completed');
    assert.equal(out1.result.outcome, 'committed');
    await until(() => p2.B.backupTask() === null && settled(p2) && p2.R.restorePending().view.items.length === 0, '新页面刷新未完成的恢复');
    assert.equal(pendingCalls(), calls0 + 1, '只在任务结束时查询一次，进度与阶段变化不查询');
    assert.equal(p2.R.restoreBlockReason({ flavorId: F, root: A }), null);
    assert.ok(p2.banner.classList.contains('hidden'));

    // 情形二：启动查询在恢复进行中读取、回复较慢；任务快照（已结束，task 为 null）先到，且没有收到推送。
    // 第一次采用快照时补查一轮，过时的启动回复不会留下
    const r2 = await startRestore('Questie = 2\n');
    let computed;
    const computedP = new Promise((r) => (computed = r));
    let releaseReply;
    const replyGate = new Promise((r) => (releaseReply = r));
    let first = true;
    const p3 = await freshRestorePage(h, base, (api) => new Proxy(api, {
      get(target, key) {
        if (key === 'onBackupTask') return () => () => undefined;
        if (key === 'backupTaskState') return async () => {
          await r2.run.catch(() => undefined);
          return target.backupTaskState();
        };
        if (key === 'backupRestorePending') return async () => {
          const v = await target.backupRestorePending();
          if (first) {
            first = false;
            computed();
            await replyGate;
          }
          return v;
        };
        return target[key];
      },
    }));
    await computedP;
    r2.release();
    const out2 = await r2.run;
    assert.equal(out2.result.outcome, 'committed');
    await p3.synced;
    assert.equal(p3.B.backupTask(), null);
    releaseReply();
    await p3.ready;
    await until(() => settled(p3) && p3.R.restorePending().view.items.length === 0, '补查后没有未完成的恢复');
    assert.equal(p3.R.restoreBlockReason({ flavorId: F, root: A }), null);
    assert.equal((await h.api.backupRestorePending()).items.length, 0);
  } finally {
    await h.service.backup.shutdown();
    await cleanup(base);
  }
});
