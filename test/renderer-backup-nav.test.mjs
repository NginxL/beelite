// 左侧导航（0.2.1）：编译后的 main.js 启动整套渲染层 → 真实 preload → 真实 AppService（假 electron）→ 临时目录。
// 四个页面（0.3.0 起含诊断报告）互斥显示；配置加载完成前即可进入配置备份页，加载完成后不强制回到发现插件、不抢焦点；
// 进入配置备份页只读取一次状态，重复点击不重读；我的插件只有五个标签页；其他页面时备份进行中只更新侧栏徽标，不读取备份状态。
// 启动时对未完成的恢复只读查询（不处理）：启动查询加第一次任务快照的补查共两次（0.3.1 起），空闲快照与备份任务不再查询；
// 没有未完成的恢复时侧栏不显示待处理；打开诊断报告页不生成报告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeElement, installFakeDom } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { cleanup, FakeSource, makeGameRoot, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;

async function until(fn, what) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}
const settle = () => new Promise((r) => setTimeout(r, 100));

installFakeDom(null);
let focused = null;
FakeElement.prototype.focus = function focus() {
  focused = this;
};
// index.html 中的侧栏导航与页面容器
const PAGES = ['discover', 'local', 'backup', 'diagnostics'];
const navs = PAGES.map((p) => {
  const b = new FakeElement('button');
  b.className = p === 'discover' ? 'nav-item active' : 'nav-item';
  b.dataset = { page: p };
  return b;
});
globalThis.document.querySelectorAll = (sel) => (sel === '.nav-item' ? navs : []);
globalThis.document.getElementById('flavor-select').options = [];
for (const id of ['page-local', 'page-backup', 'page-diagnostics', 'backup-badge', 'restore-warning']) globalThis.document.getElementById(id).classList.add('hidden');
const page = (p) => globalThis.document.getElementById(`page-${p}`);
const visible = () => PAGES.filter((p) => !page(p).classList.contains('hidden'));
const badge = globalThis.document.getElementById('backup-badge');

let paused = null;
const base = await realpath(await tmpDir());
const userData = path.join(base, 'userData');
await mkdir(userData);
const h = H.createHarness({
  settingsFile: path.join(userData, 'settings.json'),
  source: new FakeSource(),
  backup: { hooks: { step: async (n) => { if (n === 'copy-file' && paused) await paused; } } },
});
const A = await makeGameRoot(path.join(base, 'A'));
await h.settings.bind(F, A);
const picked = path.join(base, 'pick');
await mkdir(picked);
h.stub.pick = picked;
assert.equal((await h.api.backupConfigure(F, A)).state.status, 'ready');
h.stub.pick = null;

// 配置加载停住，直到测试放行
let releaseConfig;
const configP = new Promise((r) => (releaseConfig = r));
globalThis.window.beelite = { ...h.api, getConfig: () => configP };
H.ipcCalls.length = 0;
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const B = await import(path.join(web, 'backup.js'));
const R = await import(path.join(web, 'restore.js'));
await import(path.join(web, 'main.js'));

const calls = (channel) => H.ipcCalls.filter((c) => c.channel === channel).length;

test.after(async () => {
  await h.service.backup.shutdown();
  await cleanup(base);
});

test('配置加载前进入配置备份页；加载完成后仍停留在该页、不抢焦点；重复点击不重读；四个页面互斥；我的插件只有五个标签页；其他页面时只更新侧栏徽标；启动只读查询未完成的恢复；诊断页打开不生成', async () => {
  assert.deepEqual(visible(), ['discover']);
  navs[2].click();
  assert.deepEqual(visible(), ['backup']);
  assert.ok(navs[2].classList.contains('active') && !navs[0].classList.contains('active'));
  assert.match(page('backup').textContent, /配置备份/);
  assert.match(page('backup').textContent, /正在读取游戏目录/);
  assert.equal(calls('backup:state'), 0, '还没有目标：不读取');

  // 未完成的恢复：配置加载前就只读查询，不处理；查询失败时给出原因（而不是之后徽标超时）。
  // 0.3.1 起共两次：启动查询，加上第一次采用任务快照时的补查（启动查询还在进行时合并为它之后的一轮）；之后只在恢复或处理任务结束时查询
  await until(() => calls('restore:pending') === 2 && !R.restorePending().loading && (R.restorePending().view || R.restorePending().error), '启动查询与首次快照的补查');
  const rp = R.restorePending();
  assert.equal(rp.error, null, `启动查询失败：${rp.error}`);
  assert.equal(R.restoreNavBadge(), null, `没有未完成的恢复时不显示待处理：${JSON.stringify(rp.view)}`);
  assert.ok(globalThis.document.getElementById('restore-warning').classList.contains('hidden'));
  assert.equal(calls('restore:resolve'), 0, '启动不处理未完成的恢复');
  // 稳定上限：空闲的任务快照重复推送（每一次都已被采用并通知到恢复模块）不再查询
  let accepted = 0;
  B.onBackupTaskChange(() => accepted++);
  for (let i = 0; i < 3; i++) h.service.pushBackupTask();
  await until(() => accepted === 3, '三次空闲快照已采用');
  assert.equal(calls('restore:pending'), 2, '空闲快照不查询未完成的恢复');

  focused = null;
  releaseConfig({ flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }], categories: [], defaultFlavorId: F, configError: null });
  await until(() => S.currentTarget()?.root === A, '读取到目标');
  await until(() => calls('backup:state') === 1 && !B.backupLoading(S.currentTarget()) && B.shownBackup(S.currentTarget())?.state, '进入页面的读取');
  assert.deepEqual(visible(), ['backup'], '配置加载完成后仍停留在配置备份页');
  assert.ok(!focused?.classList.contains('search-input'), '没有把焦点移到搜索框');
  assert.ok(page('backup').textContent.includes(`${A}/WTF`), '显示备份来源');
  assert.equal(calls('backup:catalog'), 0);

  navs[2].click();
  await settle();
  assert.equal(calls('backup:state'), 1, '重复点击已打开的页面不重新读取');

  navs[1].click();
  assert.deepEqual(visible(), ['local']);
  await until(() => page('local').all().some((e) => e.classList.contains('tab')), '我的插件');
  const tabs = page('local').all().filter((e) => e.classList.contains('tab')).map((e) => e.textContent.replace(/\d+$/, ''));
  assert.deepEqual(tabs, ['已托管', '未托管', '回收站', '操作记录', '健康检查']);

  // 停在我的插件时备份进行中：侧栏徽标显示，不读取备份状态
  let release;
  paused = new Promise((r) => (release = r));
  const acceptedBefore = accepted;
  const run = h.api.backupRun(F, A, { kind: 'all' });
  await until(() => badge.textContent === '进行中' && !badge.classList.contains('hidden'), '徽标显示');
  release();
  paused = null;
  assert.equal((await run).status, 'completed');
  await until(() => badge.classList.contains('hidden'), '徽标隐藏');
  await settle();
  assert.equal(calls('backup:state'), 1, '页面隐藏时任务开始与结束都不读取');
  // 备份任务的开始、进度与结束快照（徽标隐藏说明结束快照已采用）都不查询未完成的恢复
  assert.ok(accepted >= acceptedBefore + 2, '备份任务的快照已采用');
  assert.equal(calls('restore:pending'), 2, '备份任务不查询未完成的恢复');

  // 诊断报告页：互斥显示，打开不生成报告
  navs[3].click();
  assert.deepEqual(visible(), ['diagnostics']);
  assert.match(page('diagnostics').textContent, /诊断报告/);
  await settle();
  assert.equal(calls('diagnostic:preview'), 0, '打开页面不生成');
  assert.equal(calls('backup:state'), 1, '离开配置备份页不读取');

  focused = null;
  navs[0].click();
  assert.deepEqual(visible(), ['discover']);
  assert.ok(focused?.classList.contains('search-input'), '回到发现插件聚焦搜索框');

  navs[2].click();
  await until(() => calls('backup:state') === 2 && !B.backupLoading(S.currentTarget()), '返回时读取一次');
  assert.equal(B.shownBackup(S.currentTarget()).state.snapshots.length, 1);
});
