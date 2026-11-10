// 渲染层更新检查结果的目标隔离（0.1.3 修复 0.1.2 的换绑缓存问题）：编译后的渲染层 → 真实 preload → 真实 AppService（假 electron）→ 临时目录。
// 场景：同一游戏版本把目录 A 换绑到 B，A 的检查结果（已是最新 / 可更新 / 失败 / 跳过）都不能出现在 B 上；
// 只刷新也要丢弃；A→B→A 期间的旧回包、过时的快照、写操作后的旧结论都不能生效；整个过程不会自动安装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './fake-dom.mjs';

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
const A_ = await import(path.join(web, 'actions.js'));

/** latest 可被挂起的数据源（模拟慢网络与迟到的回包） */
class GatedSource extends FakeSource {
  hold = null;
  /** 这些插件的查询出现临时网络错误 */
  netFail = new Set();
  async latest(modId, flavorId) {
    if (this.hold) await this.hold.promise;
    if (this.netFail.has(modId)) throw new TypeError('fetch failed');
    return super.latest(modId, flavorId);
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
 * 目录 A 与 B 都是「无限」(9) 的游戏目录（各在自己的 _forever_ 下）：
 * - N(200)：A 中为最新文件 2，B 中为旧文件 1
 * - P(300)：A、B 都是文件 1，远端为 2（两边都可更新）
 * - E(400)：A、B 都是文件 1，远端查询会失败
 * - M(100)：A、B 都按「经典旧世」(6) 安装（检查时跳过）
 */
async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = await makeGameRoot(path.join(base, 'B'));
  const src = new GatedSource();
  const m = makeManager(src);
  src.set('200', F, { name: 'N', fileId: '1', zip: zipOf('ModN', 'n1') });
  src.set('300', F, { name: 'P', fileId: '1', zip: zipOf('ModP', 'p1') });
  src.set('400', F, { name: 'E', fileId: '1', zip: zipOf('ModE', 'e1') });
  src.set('100', OTHER, { name: 'M', fileId: '1', zip: zipOf('ModM', 'm1'), versions: ['12.1.5'] });
  for (const root of [A, B]) {
    for (const id of ['200', '300', '400']) await m.install(root, F, id);
    await m.install(root, OTHER, '100');
  }
  src.set('200', F, { name: 'N', fileId: '2', zip: zipOf('ModN', 'n2') });
  await m.install(A, F, '200');
  src.set('300', F, { name: 'P', fileId: '2', zip: zipOf('ModP', 'p2') });
  src.mods.delete('400'); // E 的远端查询失败
  const h = H.createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
  await h.settings.bind(F, A);
  globalThis.window.beelite = h.api;
  // 0.1.5：插件写入口在取得主进程活动状态之后才可用（与真实启动顺序一致：先订阅推送再获取快照）
  h.api.onActivity((s) => S.applyActivity(s));
  await S.syncActivity();
  dom.modalRoot().replaceChildren();
  dom.toastRoot().replaceChildren();
  S.state.busy.clear();
  S.state.watch = null;
  S.state.flavorId = F;
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  const p = (id) => S.state.local.managed.find((x) => x.modId === id);
  return { base, A, B, src, h, p };
}

const writes = () => H.ipcCalls.filter((c) => ['addon:install', 'addon:update', 'addon:updateAll'].includes(c.channel));

test('同一版本换绑 A→B 后只刷新：A 的“已是最新 / 可更新 / 失败 / 跳过”都不出现在 B 上；B 检查后显示自己的结果', async () => {
  const { base, A, B, h, p } = await setup();
  try {
    await S.checkUpdates(true);
    assert.equal(S.updateFor(p('200'))?.hasUpdate, false, 'A 中 N 已是最新');
    assert.equal(S.projectHasUpdate(p('300')), true, 'A 中 P 可更新');
    assert.ok(S.updateFor(p('400'))?.error, 'A 中 E 检查失败');
    assert.match(S.updateFor(p('100'))?.skipped ?? '', /不检查更新/);
    assert.equal(S.updateCount(), 1);

    // 在其他入口换绑（界面没有经过 bindDirectory），之后只点“刷新”
    await h.settings.bind(F, B);
    await S.refreshLocal();
    assert.equal(S.state.local.profile.root, B);
    for (const id of ['200', '300', '400', '100']) assert.equal(S.updateFor(p(id)), undefined, `${id} 不能沿用 A 的结论`);
    assert.equal(S.state.updatesChecked, false, 'B 还没有检查过');
    assert.equal(S.updateCount(), 0);

    await S.checkUpdates(true);
    assert.equal(S.projectHasUpdate(p('200')), true, 'B 中 N 是旧文件，需要更新');
    assert.equal(S.projectHasUpdate(p('300')), true);
    assert.equal(S.updateCount(), 2);
    assert.equal(S.updateFor(p('200'))?.installedFileId, '1');

    // 换回 A 并只刷新：B 的“可更新”不会出现在 A 的 N 上；显示的只是 A 自己条目中的结论（P 可更新）
    await h.settings.bind(F, A);
    await S.refreshLocal();
    assert.equal(S.projectHasUpdate(p('200')), false);
    assert.equal(S.updateCount(), 1);
    const aEntry = S.state.watch.entries.find((e) => e.flavorId === F && e.root === A);
    assert.equal(S.updateFor(p('300')), S.state.updates.get('300'));
    assert.deepEqual(aEntry.items.find((i) => i.modId === '300'), S.updateFor(p('300')), '结论来自 A 的条目');
    assert.deepEqual(writes(), [], '没有任何自动安装或更新');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('经界面换绑 A→B→A 期间在途的检查：回包被主进程丢弃，界面不显示任何旧结论', async () => {
  const { base, A, B, src, h, p } = await setup();
  try {
    src.pause();
    const checking = S.checkUpdates(true);
    await new Promise((r) => setTimeout(r, 20));
    h.stub.pick = B;
    assert.equal(await S.bindDirectory(), true);
    assert.equal(S.state.local.profile.root, B);
    h.stub.pick = A;
    assert.equal(await S.bindDirectory(), true);
    assert.equal(S.state.local.profile.root, A);
    src.resume();
    await checking;
    assert.equal(S.state.updatesChecked, false, '旧回包没有被采用');
    for (const id of ['200', '300', '400']) assert.equal(S.updateFor(p(id)), undefined);
    const e = S.state.watch?.entries ?? [];
    assert.ok(!e.some((x) => x.checkedAt !== null), '主进程也没有发布旧结果');
    assert.deepEqual(writes(), []);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('快照：按 rev 丢弃过时快照；只采用当前目标的条目；更早的检查不覆盖更新的结果', async () => {
  const { base, A, B, h, p } = await setup();
  try {
    const items = [{ modId: '300', hasUpdate: true, latestFileId: '2', latestVersion: 'v2', error: null, installedFileId: '1', name: 'P', checkedAt: 2000 }];
    const entry = (root, checkedAt, its) => ({ flavorId: F, root, status: 'ok', items: its, pending: its.filter((i) => i.hasUpdate).length, failed: 0, checkedAt, error: null, nextCheckAt: null });
    // 其他目录（B）的条目：不会套用到当前目录 A
    assert.equal(S.applyWatch({ rev: 10, entries: [entry(B, 2000, items)], settingsError: null, notice: null }), true);
    assert.equal(S.projectHasUpdate(p('300')), false);
    // 当前目录 A 的条目
    S.applyWatch({ rev: 11, entries: [entry(A, 2000, items)], settingsError: null, notice: null });
    assert.equal(S.projectHasUpdate(p('300')), true);
    // 过时的快照（rev 更小）被丢弃
    assert.equal(S.applyWatch({ rev: 9, entries: [entry(A, 3000, [])], settingsError: null, notice: null }), false);
    assert.equal(S.projectHasUpdate(p('300')), true);
    // rev 更大但检查时间更早（系统时钟回拨）：仍以 rev 为准采用新快照，检查时间只用于显示
    S.applyWatch({ rev: 12, entries: [entry(A, 1000, [])], settingsError: null, notice: null });
    assert.equal(S.projectHasUpdate(p('300')), false);
    S.applyWatch({ rev: 12.5, entries: [entry(A, 500, items)], settingsError: null, notice: null });
    assert.equal(S.projectHasUpdate(p('300')), true, '时钟回拨后的新结果被采用');
    // 检查结果对应的本地文件编号与当前不同：不采用
    S.applyWatch({ rev: 13, entries: [entry(A, 4000, [{ ...items[0], installedFileId: '9' }])], settingsError: null, notice: null });
    assert.equal(S.projectHasUpdate(p('300')), false);
    // 其他版本的待更新数量用于侧栏总数；当前版本以本地核对为准
    S.applyWatch({ rev: 14, entries: [entry(A, 5000, items), { ...entry('/x/other', 5000, items), flavorId: 3, pending: 2 }], settingsError: null, notice: null });
    assert.deepEqual([...S.pendingByFlavor()].sort(), [[3, 2], [F, 1]]);
    assert.deepEqual(writes(), []);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('写操作后：更新完成的插件不再显示可更新；只有点击才会更新，检查与快照不会触发安装', async () => {
  const { base, h, p } = await setup();
  try {
    await S.checkUpdates(true);
    assert.equal(S.projectHasUpdate(p('300')), true);
    assert.deepEqual(writes(), []);
    await A_.updateProject(p('300'), false);
    assert.equal(p('300').fileId, '2');
    assert.equal(S.projectHasUpdate(p('300')), false, '旧结论（文件 1）不再适用');
    assert.equal(S.updateFor(p('300')), undefined);
    assert.deepEqual(writes().map((c) => c.channel), ['addon:update'], '只有用户点击的那一次更新');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('手动检查回复是权威快照：临时网络失败时保留已知的“可更新”；晚到的回复不覆盖更新的快照', async () => {
  const { base, A, src, h, p } = await setup();
  try {
    await S.checkUpdates(true);
    assert.equal(S.updateCount(), 1);
    // 再次检查时 P 的查询临时失败：主进程合并后仍是“可更新”（标注本次失败），界面不能被原始失败结果覆盖
    src.netFail.add('300');
    await S.checkUpdates(true);
    assert.equal(S.updateCount(), 1, '已知更新保留');
    assert.equal(S.updateFor(p('300'))?.stale, true);
    assert.match(S.updateFor(p('300'))?.error ?? '', /本次检查失败/);
    src.netFail.clear();

    // 手动检查的回复在途时，主进程又产生了更新的快照（远端出现文件 3）
    const orig = h.api.checkUpdates;
    let deliver = null;
    globalThis.window.beelite = { ...h.api, checkUpdates: async (f, r) => { const s = await orig(f, r); await new Promise((res) => (deliver = res)); return s; } };
    const pending = S.checkUpdates(true);
    for (let i = 0; i < 200 && !deliver; i++) await new Promise((r) => setTimeout(r, 5));
    src.set('300', F, { name: 'P', fileId: '3', zip: zipOf('ModP', 'p3') });
    await h.service.watch.check(F, A);
    S.applyWatch(h.service.watch.snapshot());
    assert.equal(S.updateFor(p('300'))?.latestFileId, '3');
    deliver();
    await pending;
    assert.equal(S.updateFor(p('300'))?.latestFileId, '3', '晚到的旧回复被 rev 拦截');
    globalThis.window.beelite = h.api;
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('同一目标的新快照中条目被移除或尚未检查（绑定变更作废、重建中）：界面清空旧结果，不保留到下一次检查', async () => {
  const { base, h, p } = await setup();
  try {
    await S.checkUpdates(true);
    assert.equal(S.updateCount(), 1);
    assert.equal(S.state.updatesChecked, true);
    h.service.watch.invalidateFlavor(F); // 绑定刚变更（例如 A→B→A 的中途）
    S.applyWatch(h.service.watch.snapshot());
    assert.equal(S.updateCount(), 0);
    assert.equal(S.state.updatesChecked, false);
    assert.equal(S.updateFor(p('200')), undefined);
    await h.service.watch.bindingsChanged(); // 重建为尚未检查的条目
    S.applyWatch(h.service.watch.snapshot());
    assert.equal(S.updateCount(), 0);
    assert.equal(S.state.updatesChecked, false);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('设置文件变得不可读：界面不再把旧的“已是最新”当作结论，并暴露设置错误；不改动设置文件，恢复后手动检查即恢复正常', async () => {
  const { base, h, p } = await setup();
  try {
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = path.join(base, 'settings.json');
    await S.checkUpdates(true);
    assert.equal(S.updateFor(p('200'))?.hasUpdate, false, '先显示 N 已是最新');
    assert.equal(S.state.updatesChecked, true);
    const good = await readFile(file, 'utf8');
    await writeFile(file, '{ broken');
    // 主进程的检查在发布前读取设置失败（例如自动检查）
    await assert.rejects(h.service.watch.check(F, S.state.local.profile.root, { fresh: true }), /无法读取艾泽魔方设置文件/);
    S.applyWatch(h.service.watch.snapshot());
    assert.match(S.state.watch.settingsError ?? '', /无法读取艾泽魔方设置文件/);
    assert.equal(S.updateFor(p('200')), undefined, '不再显示“已是最新”');
    assert.equal(S.state.updatesChecked, false);
    assert.equal(S.updateCount(), 0);
    assert.equal(S.currentWatchEntry()?.status, 'error');
    assert.equal(await readFile(file, 'utf8'), '{ broken', '设置文件没有被改写');
    // 用户恢复文件后手动检查
    await writeFile(file, good);
    await S.checkUpdates(true);
    assert.equal(S.state.watch.settingsError, null);
    assert.equal(S.updateFor(p('200'))?.hasUpdate, false);
    assert.equal(S.updateCount(), 1);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
