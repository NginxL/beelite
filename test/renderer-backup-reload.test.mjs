// 配置备份（0.2.0）：界面重新载入后恢复主进程中进行中的备份任务。
// 链路：编译后的渲染层 → 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// “重新载入”的模拟与 renderer-reload 相同：丢弃旧界面的全部订阅，把编译后的 renderer/ 与 shared/ 复制到新目录重新导入（全新的模块实例），
// 按 main.ts 的顺序先订阅任务推送、再获取任务快照；主进程实例与其中进行中的备份保持不变。不进入配置备份页，因此不读取完整状态；
// 进入页面后任务槽显示原任务与它自己的范围。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, realpath } from 'node:fs/promises';
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
