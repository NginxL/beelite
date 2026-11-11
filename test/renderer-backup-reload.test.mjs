// 配置备份（0.2.0）：界面重新载入后恢复主进程中进行中的备份任务。
// 链路：编译后的渲染层 → 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// “重新载入”的模拟与 renderer-reload 相同：丢弃旧界面的全部订阅，把编译后的 renderer/ 与 shared/ 复制到新目录重新导入（全新的模块实例），
// 按 main.ts 的顺序先订阅任务推送、再获取任务快照；主进程实例与其中进行中的备份保持不变。不打开配置备份标签页，因此不读取完整状态。
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

/** 载入一个全新的界面：先订阅备份任务推送，再获取任务快照（与 main.ts 相同的顺序），再读取本地插件列表（停在“已托管”） */
async function freshRenderer(h, base) {
  if (currentPage) currentPage.destroyed = true;
  const page = pageApi(h.api);
  currentPage = page;
  h.stub.listeners.clear(); // 旧页面销毁：它的订阅全部失效
  const pageDir = path.join(base, `renderer-${++seq}`);
  const dir = path.join(pageDir, 'renderer');
  await cp(web, dir, { recursive: true });
  await cp(webShared, path.join(pageDir, 'shared'), { recursive: true });
  for (const id of ['test-local', 'toast-root', 'modal-root']) document.getElementById(id).replaceChildren();
  globalThis.window.beelite = page.api;
  const S = await import(path.join(dir, 'state.js'));
  const L = await import(path.join(dir, 'local.js'));
  const B = await import(path.join(dir, 'backup.js'));
  S.state.config = { flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }], categories: [], defaultFlavorId: F, configError: null };
  S.state.flavorId = F;
  page.api.onActivity((s) => void S.applyActivity(s));
  page.api.onBackupTask((s) => void B.applyBackupTask(s));
  await B.syncBackupTask();
  await S.syncActivity();
  const view = document.getElementById('test-local');
  L.initLocal(view);
  await S.refreshLocal();
  return { S, L, B, view };
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
    const run = h.api.backupRun(F, A);
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
    assert.equal(p2.S.currentTarget().root, other, '当前显示的是换绑后的目录');
    assert.match(p2.view.textContent, /配置备份进行中/, '标签页标出进行中的备份');

    // 新页面的订阅生效：进度推送只到新页面
    const stale = p1.B.backupTask();
    h.service.pushBackupTask();
    await until(() => p2.B.backupTask() !== task, '新页面收到推送');
    assert.equal(p2.B.backupTask().id, original.id);
    assert.equal(p1.B.backupTask(), stale, '旧页面的订阅已销毁');

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
    assert.equal(H.ipcCalls.filter((c) => c.channel === 'backup:state').length, 0, '没有打开标签页：不读取完整状态');
    assert.ok(!(await readdir(container)).some((n) => n.startsWith('.partial-')), '取消后临时内容已清理');
  } finally {
    await h.service.backup.shutdown();
    await cleanup(base);
  }
});
