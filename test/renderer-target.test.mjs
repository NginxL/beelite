// 渲染层操作目标回归（0.1.2）：编译后的渲染层操作函数 → 真实 preload → 真实 AppService（假 electron）→ AddonManager → 临时目录。
// 场景：目录 A 绑定「探索赛季」(3)，其中插件 M 按「经典旧世」(6) 安装；6 绑定目录 B（B 中也有 M）。
// 断言：渲染层发送的是操作前记录的 {当前版本, 当前目录}；确认等待期间切换版本或换绑后不会作用到新的目标；B 始终不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, installFakeDom, openModals, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, cleanup, FakeSource, listAddOns, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const SRC = 6;
const VIEW = 3;
const zipOf = (folder, v) => makeZip(addonEntries(folder, v));

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const A_ = await import(path.join(web, 'actions.js'));

async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = await makeGameRoot(path.join(base, 'B'));
  const src = new FakeSource();
  const m = makeManager(src);
  src.set('100', SRC, { name: 'M', fileId: '1', zip: zipOf('ModM', 'm1'), versions: ['12.1.5'] });
  src.set('200', VIEW, { name: 'N', fileId: '1', zip: zipOf('ModN', 'n1'), versions: ['12.1.5'] });
  await m.install(A, SRC, '100');
  await m.install(B, SRC, '100');
  await m.install(A, VIEW, '200');
  const settingsFile = path.join(base, 'settings.json');
  const h = H.createHarness({ settingsFile, source: src });
  await h.settings.bind(VIEW, A);
  await h.settings.bind(SRC, B);
  globalThis.window.beelite = h.api;
  dom.modalRoot().replaceChildren();
  dom.toastRoot().replaceChildren();
  S.state.busy.clear();
  S.state.updates = new Map();
  S.state.localError = null;
  S.state.flavorId = VIEW;
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  const p = (id) => S.state.local.managed.find((x) => x.modId === id);
  return { base, A, B, src, h, settingsFile, p };
}

const writes = () => H.ipcCalls.filter((c) => c.channel !== 'local:state').map((c) => [c.channel, ...c.args]);

test('卸载异来源插件：确认后只作用于当前显示的目录 A，B 不变', async () => {
  const { base, A, B, p } = await setup();
  try {
    const b0 = await H.snapshot(B);
    assert.equal(p('100').flavorId, SRC);
    const run = L.uninstallProject(p('100'));
    clickModalButton(dom, '卸载');
    await run;
    assert.deepEqual(writes(), [['addon:uninstall', '100', VIEW, A]]);
    assert.deepEqual(await listAddOns(A), ['ModN']);
    assert.deepEqual(await H.snapshot(B), b0);
    // 恢复同样作用于 A
    const entry = S.state.local.recovery.find((r) => r.folders.includes('ModM'));
    await L.restore(entry);
    assert.deepEqual(await listAddOns(A), ['ModM', 'ModN']);
    assert.deepEqual(await H.snapshot(B), b0);
  } finally {
    await cleanup(base);
  }
});

test('确认等待期间切换游戏版本：确认后放弃，不发送写请求，A、B 都不变', async () => {
  const { base, A, B, p } = await setup();
  try {
    const a0 = await H.snapshot(A);
    const b0 = await H.snapshot(B);
    const run = L.uninstallProject(p('200'));
    S.state.flavorId = SRC; // 用户在对话框打开期间切到「经典旧世」（显示目录 B）
    await S.refreshLocal();
    assert.equal(S.state.local.profile.root, B);
    clickModalButton(dom, '卸载');
    await run;
    assert.deepEqual(writes(), []);
    assert.ok(toasts(dom).some((t) => t.includes('已取消本次操作')));
    assert.deepEqual(await H.snapshot(A), a0);
    assert.deepEqual(await H.snapshot(B), b0);

    // 移入回收站、永久删除同样在确认后复核
    S.state.flavorId = VIEW;
    await S.refreshLocal();
    const folder = { name: 'ModN', toc: null, symlink: false };
    const run2 = L.trashFolder(folder);
    S.state.flavorId = SRC;
    await S.refreshLocal();
    clickModalButton(dom, '移入回收站');
    await run2;
    assert.deepEqual(writes(), []);
    assert.deepEqual(await H.snapshot(A), a0);
  } finally {
    await cleanup(base);
  }
});

test('确认等待期间同一版本换绑：界面已刷新则放弃；界面未刷新则主进程按期望目录拒绝，不转向新目录', async () => {
  const { base, A, B, h, p } = await setup();
  try {
    const C = await makeGameRoot(path.join(base, 'C'));
    const a0 = await H.snapshot(A);
    const b0 = await H.snapshot(B);
    const c0 = await H.snapshot(C);

    // 情形一：换绑后界面已刷新
    const run = L.uninstallProject(p('200'));
    await h.settings.bind(VIEW, C);
    await S.refreshLocal();
    clickModalButton(dom, '卸载');
    await run;
    assert.deepEqual(writes(), []);

    // 情形二：界面仍显示 A（尚未刷新），主进程绑定已是 C
    await h.settings.bind(VIEW, A);
    await S.refreshLocal();
    const pN = p('200');
    const run2 = L.uninstallProject(pN);
    await h.settings.bind(VIEW, C);
    clickModalButton(dom, '卸载');
    await run2;
    assert.deepEqual(writes(), [['addon:uninstall', '200', VIEW, A]], '渲染层只发送确认前记录的目标');
    assert.ok(toasts(dom).some((t) => t.includes('绑定已变更')));
    assert.deepEqual(await H.snapshot(A), a0);
    assert.deepEqual(await H.snapshot(B), b0);
    assert.deepEqual(await H.snapshot(C), c0);
  } finally {
    await cleanup(base);
  }
});

test('异来源插件：更新与重装在渲染层即被拒绝；发现页/详情按钮显示“其他版本已安装”；同来源插件正常传递目标', async () => {
  const { base, A, B, src, p } = await setup();
  try {
    src.set('100', SRC, { name: 'M', fileId: '2', zip: zipOf('ModM', 'm2'), versions: ['12.1.5'] });
    src.set('200', VIEW, { name: 'N', fileId: '2', zip: zipOf('ModN', 'n2'), versions: ['12.1.5'] });
    const b0 = await H.snapshot(B);
    await A_.updateProject(p('100'), true);
    await A_.updateProject(p('100'), false);
    assert.deepEqual(writes(), []);
    assert.ok(toasts(dom).some((t) => t.includes('不能用当前版本的文件更新或重装')));
    const btn = A_.modActionButton({ id: '100', accessible: true });
    assert.equal(btn.textContent, '其他版本已安装');
    assert.equal(btn.disabled, true);

    await S.checkUpdates(true);
    assert.deepEqual(writes(), [['addon:check', VIEW, A]]);
    assert.ok(S.state.updates.get('100').skipped);
    assert.equal(S.projectHasUpdate(p('100')), false);
    assert.equal(S.projectHasUpdate(p('200')), true);
    assert.equal(A_.modActionButton({ id: '200', accessible: true }).textContent, '更新');

    H.ipcCalls.length = 0;
    await A_.updateProject(p('200'), false);
    await L.doUpdateAll();
    await A_.updateProject(p('200'), true);
    assert.deepEqual(writes(), [
      ['addon:update', '200', VIEW, false, A],
      ['addon:updateAll', VIEW, A],
      ['addon:update', '200', VIEW, true, A],
    ]);
    const manifest = await H.readManifestJson(A);
    assert.equal(manifest.projects['200'].fileId, '2');
    assert.equal(manifest.projects['100'].fileId, '1', '异来源插件未被更新');
    assert.deepEqual(await H.snapshot(B), b0);
  } finally {
    await cleanup(base);
  }
});

test('从发现页安装：目标为当前版本与目录', async () => {
  const { base, A, B, src } = await setup();
  try {
    const b0 = await H.snapshot(B);
    src.set('300', VIEW, { name: 'P', fileId: '1', zip: zipOf('ModP', 'p1'), versions: ['12.1.5'] });
    await A_.installMod('300');
    assert.deepEqual(writes(), [['addon:install', '300', VIEW, A]]);
    assert.ok((await listAddOns(A)).includes('ModP'));
    assert.deepEqual(await H.snapshot(B), b0);
  } finally {
    await cleanup(base);
  }
});

test('刷新失败时界面上的旧快照不会成为操作目标；修复后重试恢复正常', async () => {
  const { base, A, settingsFile, p } = await setup();
  try {
    const a0 = await H.snapshot(A);
    const good = await import('node:fs/promises').then((f) => f.readFile(settingsFile));
    await writeFile(settingsFile, '{"schema":1,"bindings":');
    await S.refreshLocal();
    assert.match(S.state.localError, /无法读取蜂简设置文件/);
    assert.ok(S.state.local, '旧快照仍在界面上显示');
    assert.equal(S.currentTarget(), null);
    await L.uninstallProject(p('200'));
    await A_.updateProject(p('200'), true);
    await S.unbindDirectory();
    assert.equal(openModals(dom).length, 0, '没有弹出确认框');
    assert.deepEqual(writes(), []);
    assert.deepEqual(await H.snapshot(A), a0);
    assert.equal(await import('node:fs/promises').then((f) => f.readFile(settingsFile, 'utf8')), '{"schema":1,"bindings":');
    // 用户修复文件后点击“刷新”
    await writeFile(settingsFile, good);
    await S.refreshLocal();
    assert.equal(S.state.localError, null);
    assert.deepEqual(S.currentTarget(), { flavorId: VIEW, root: A });
  } finally {
    await cleanup(base);
  }
});

test('解除绑定：确认前记录目标；确认期间切换版本则放弃；正常确认只解绑记录的版本', async () => {
  const { base, A, B, h } = await setup();
  try {
    const run = S.unbindDirectory();
    S.state.flavorId = SRC;
    await S.refreshLocal();
    clickModalButton(dom, '解除绑定');
    await run;
    assert.deepEqual(writes(), []);
    assert.equal((await h.settings.profile(VIEW)).root, A);
    assert.equal((await h.settings.profile(SRC)).root, B);

    const run2 = S.unbindDirectory(); // 当前显示 SRC（目录 B）
    clickModalButton(dom, '解除绑定');
    await run2;
    assert.deepEqual(writes(), [['profile:unbind', SRC, B]]);
    assert.equal((await h.settings.profile(SRC)).root, null);
    assert.equal((await h.settings.profile(VIEW)).root, A);
  } finally {
    await cleanup(base);
  }
});

const tick = () => new Promise((r) => setImmediate(r));

/** 在 A 中卸载 N，得到一条回收项；返回刷新后的界面条目 */
async function trashEntryInA(h, A) {
  await h.api.uninstallProject('200', VIEW, A);
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  const entry = S.state.local.recovery.find((r) => r.folders.includes('ModN'));
  assert.ok(entry);
  return entry;
}

test('永久删除双确认：两次确认之间或第二次确认挂起时换绑/切换版本则取消，回收项与 B 不变；正常双确认只删除 A 中的条目', async () => {
  const { base, A, B, h } = await setup();
  try {
    const C = await makeGameRoot(path.join(base, 'C'));
    const entry = await trashEntryInA(h, A);
    const trashDir = path.join(A, 'Interface', '.beelite', 'trash', entry.id);
    const a0 = await H.snapshot(A);
    const b0 = await H.snapshot(B);
    const c0 = await H.snapshot(C);
    const unchanged = async () => {
      assert.deepEqual(writes(), [], '没有发送永久删除请求');
      assert.deepEqual(await H.snapshot(A), a0);
      assert.deepEqual(await H.snapshot(B), b0);
      assert.deepEqual(await H.snapshot(C), c0);
    };

    // 情形一：第一次确认后、第二次确认前，同一版本换绑到 C 且界面已刷新
    let run = L.purge(entry);
    clickModalButton(dom, '继续');
    await tick();
    await h.settings.bind(VIEW, C);
    await S.refreshLocal();
    clickModalButton(dom, '永久删除');
    await run;
    await unchanged();
    await h.settings.bind(VIEW, A);
    await S.refreshLocal();

    // 情形二：第二次确认挂起时切换游戏版本（显示目录 B）
    run = L.purge(entry);
    clickModalButton(dom, '继续');
    await tick();
    S.state.flavorId = SRC;
    await S.refreshLocal();
    assert.equal(S.state.local.profile.root, B);
    clickModalButton(dom, '永久删除');
    await run;
    await unchanged();
    S.state.flavorId = VIEW;
    await S.refreshLocal();

    // 情形三：第二次确认挂起时同一版本换绑，但界面尚未刷新：渲染层只发送确认前的目标 A，主进程按期望目录拒绝
    run = L.purge(entry);
    clickModalButton(dom, '继续');
    await tick();
    await h.settings.bind(VIEW, C);
    clickModalButton(dom, '永久删除');
    await run;
    assert.deepEqual(writes(), [['trash:purge', entry.id, VIEW, A]]);
    assert.ok(toasts(dom).some((t) => t.includes('绑定已变更')));
    assert.deepEqual(await H.snapshot(A), a0);
    assert.deepEqual(await H.snapshot(B), b0);
    assert.deepEqual(await H.snapshot(C), c0);
    await h.settings.bind(VIEW, A);
    await S.refreshLocal();
    H.ipcCalls.length = 0;

    // 第一次确认就取消：什么也不发生
    run = L.purge(entry);
    clickModalButton(dom, '取消');
    await run;
    await unchanged();

    // 正常双确认：只删除 A 中的这一条回收项
    run = L.purge(entry);
    clickModalButton(dom, '继续');
    await tick();
    clickModalButton(dom, '永久删除');
    await run;
    assert.deepEqual(writes(), [['trash:purge', entry.id, VIEW, A]]);
    const ma = await H.readManifestJson(A);
    assert.equal(ma.recovery.some((r) => r.id === entry.id), false);
    assert.equal(await import('node:fs/promises').then((f) => f.lstat(trashDir).then(() => true, () => false)), false, '回收目录已删除');
    assert.deepEqual(await listAddOns(A), ['ModM']);
    assert.deepEqual(await H.snapshot(B), b0);
    assert.deepEqual(await H.snapshot(C), c0);
  } finally {
    await cleanup(base);
  }
});
