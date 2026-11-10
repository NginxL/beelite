// 0.1.5：插件写操作的占用（主进程权威状态）与安装前的锁内前置条件。
// 占用：同一目录全部更新与单项写操作双向互斥、同一插件不重复、不同目录互不影响、释放只作用于自己的占用。
// 前置条件：首次安装必须尚未安装；更新 / 重装必须仍是受理时的记录（文件编号 + 安装时间），不满足时不下载、不写入、不复活。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ActivityRegistry } from '../src/core/activity';
import { UserError } from '../src/core/errors';
import { AddonManager } from '../src/core/manager';
import type { ActivitySnapshot } from '../src/shared/types';
import { addonEntries, cleanup, exists, FakeSource, listAddOns, makeGameRoot, makeZip, tmpDir } from './helpers';
import { readManifestJson, recordOf, snapshot } from './ipc-harness';

const F = 9;
const RA = '/games/A/_retail_';
const RB = '/games/B/_retail_';
const busy = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof UserError && e.code === 'busy' && re.test(e.message));

test('占用：同一目录同时只有一个全部更新（换成其他游戏版本也算同一目录）；不同目录互不影响；旧批次的释放不影响新批次', () => {
  const pushed: ActivitySnapshot[] = [];
  const a = new ActivityRegistry((s) => pushed.push(s));
  const b1 = a.reserveBatch(F, RA);
  busy(() => a.reserveBatch(F, RA), /正在全部更新/);
  busy(() => a.reserveBatch(6, RA), /正在全部更新/);
  const other = a.reserveBatch(F, RB);
  b1.release();
  const b2 = a.reserveBatch(F, RA);
  b1.release(); // 重复释放旧批次：不得释放之后的批次
  busy(() => a.reserveBatch(F, RA), /正在全部更新/);
  assert.deepEqual(a.snapshot().batches.map((b) => [b.root, b.stage, b.batchId === b2.batchId || b.root === RB]), [[RB, 'checking', true], [RA, 'checking', true]]);
  b2.release();
  other.release();
  assert.deepEqual(a.snapshot().batches, []);
  const revs = pushed.map((s) => s.rev);
  assert.deepEqual(revs, [...revs].sort((x, y) => x - y), 'rev 单调递增');
  assert.equal(new Set(revs).size, revs.length);
});

test('占用：已受理的单项更新 / 卸载 / 安装阻止同一目录开始全部更新（反向）；结束后可以开始；其他目录不受影响', () => {
  const a = new ActivityRegistry();
  for (const kind of ['update', 'uninstall', 'install'] as const) {
    const release = a.reserveProject(F, RA, '100', kind);
    busy(() => a.reserveBatch(F, RA), /有插件正在处理/);
    a.reserveBatch(F, RB).release();
    release();
    release();
    a.reserveBatch(F, RA).release();
  }
});

test('占用：批次检查阶段拒绝该目录所有单项写操作；计划确定后只允许计划外插件的首次安装；同一插件不能同时有两个写操作', () => {
  const a = new ActivityRegistry();
  const b = a.reserveBatch(F, RA);
  for (const kind of ['update', 'uninstall', 'install'] as const) busy(() => a.reserveProject(F, RA, '999', kind), /正在全部更新/);
  const rev0 = a.snapshot().rev;
  const rev = a.planBatch(b, [{ taskId: 'x1', modId: '100', label: 'A' }, { taskId: 'x2', modId: '200', label: 'B' }]);
  assert.ok(rev > rev0);
  const s = a.snapshot();
  assert.deepEqual(s.batches.map((x) => x.stage), ['running']);
  assert.deepEqual(s.tasks.map((t) => [t.taskId, t.modId, t.phase, t.batchId === b.batchId]), [['x1', '100', 'queued', true], ['x2', '200', 'queued', true]]);
  busy(() => a.reserveProject(F, RA, '200', 'install'), /正在全部更新/);
  busy(() => a.reserveProject(F, RA, '300', 'update'), /正在全部更新/);
  busy(() => a.reserveProject(F, RA, '300', 'uninstall'), /正在全部更新/);
  const install = a.reserveProject(F, RA, '999', 'install');
  busy(() => a.reserveProject(F, RA, '999', 'install'), /这个插件正在处理/);
  // 其他目录的同一插件不受影响
  a.reserveProject(F, RB, '200', 'uninstall')();
  install();
  // 批次结束时兜底清理仍挂在批次上的任务
  b.release();
  assert.deepEqual(a.snapshot().tasks, []);
  a.reserveProject(F, RA, '200', 'uninstall')();
});

test('活动状态：下载字节数只递增 rev 不推送；阶段变化与任务结束由调用方推送；快照不暴露内部可变对象', () => {
  const pushed: ActivitySnapshot[] = [];
  const a = new ActivityRegistry((s) => pushed.push(s));
  const r1 = a.startTask({ taskId: 't', label: 'L', flavorId: F, root: RA, modId: '1', batchId: null });
  const r2 = a.setPhase('t', 'downloading', 0, 100);
  const r3 = a.progress('t', 35, 100);
  assert.ok(r1 < r2 && r2 < r3);
  assert.equal(pushed.length, 0, '未推送');
  const s = a.snapshot();
  assert.equal(s.rev, r3);
  assert.deepEqual([s.tasks[0].phase, s.tasks[0].received, s.tasks[0].total], ['downloading', 35, 100]);
  s.tasks[0].received = 0;
  assert.equal(a.snapshot().tasks[0].received, 35);
  const r4 = a.endTask('t');
  assert.ok(r4 > r3);
  assert.equal(a.endTask('t'), r4, '重复结束不改变状态');
  a.publish();
  assert.deepEqual(pushed.map((x) => [x.rev, x.tasks.length]), [[r4, 0]]);
});

// ---------- 安装前的锁内前置条件（真实 AddonManager + 临时目录） ----------

async function managerSetup() {
  const base = await realpath(await tmpDir());
  const root = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  const downloads: string[] = [];
  const m = new AddonManager({
    source: src,
    download: async (url, dest) => {
      downloads.push(url);
      return src.download(url, dest);
    },
    confirm: async () => true,
  });
  src.set('100', F, { name: 'Alpha', fileId: '1', zip: makeZip(addonEntries('Alpha', 'a1')) });
  src.set('200', F, { name: 'Beta', fileId: '1', zip: makeZip(addonEntries('Beta', 'b1')) });
  await m.install(root, F, '100');
  await m.install(root, F, '200');
  downloads.length = 0;
  return { base, root, src, m, downloads };
}

const changed = (re: RegExp) => (e: unknown) => e instanceof UserError && e.code === 'changed' && re.test(e.message);

test('前置条件：首次安装遇到已托管的插件不做任何改动；不存在时照常安装', async () => {
  const { base, root, src, m, downloads } = await managerSetup();
  try {
    src.set('100', F, { name: 'Alpha', fileId: '2', zip: makeZip(addonEntries('Alpha', 'a2')) });
    const s0 = await snapshot(root);
    await assert.rejects(m.install(root, F, '100', { expect: { kind: 'absent' } }), changed(/已经安装在这个目录/));
    assert.deepEqual(await snapshot(root), s0, '没有任何写入');
    assert.deepEqual(downloads, [], '没有下载');
    src.set('300', F, { name: 'Gamma', fileId: '1', zip: makeZip(addonEntries('Gamma', 'g1')) });
    const r = await m.install(root, F, '300', { expect: { kind: 'absent' } });
    assert.equal(r.ok, true);
    assert.ok((await listAddOns(root)).includes('Gamma'));
  } finally {
    await cleanup(base);
  }
});

test('前置条件：受理后插件被卸载、换了文件、或同一文件被重新安装（安装时间不同），更新与重装都不下载、不写入、不复活', async () => {
  const { base, root, src, m, downloads } = await managerSetup();
  try {
    src.set('100', F, { name: 'Alpha', fileId: '2', zip: makeZip(addonEntries('Alpha', 'a2')) });
    // 1. 受理时的记录 → 之后被卸载
    const rec100 = await recordOf(root, '100');
    await m.uninstallProject(root, '100');
    const s1 = await snapshot(root);
    for (const force of [false, true]) {
      await assert.rejects(m.install(root, F, '100', { force, expect: { kind: 'record', ...rec100 } }), changed(/已不在这个目录的艾泽魔方管理列表中/));
    }
    assert.deepEqual(await snapshot(root), s1);
    assert.equal((await readManifestJson(root)).projects['100'], undefined, '没有被当成首次安装复活');

    // 2. 受理后换了文件编号
    const rec200 = await recordOf(root, '200');
    src.set('200', F, { name: 'Beta', fileId: '2', zip: makeZip(addonEntries('Beta', 'b2')) });
    await m.install(root, F, '200');
    src.set('200', F, { name: 'Beta', fileId: '3', zip: makeZip(addonEntries('Beta', 'b3')) });
    downloads.length = 0;
    const s2 = await snapshot(root);
    await assert.rejects(m.install(root, F, '200', { expect: { kind: 'record', ...rec200 } }), changed(/已被重新安装、更新或恢复/));
    assert.deepEqual(await snapshot(root), s2);

    // 3. 同一文件编号被重新安装（卸载后再装）：安装时间不同
    const rec2 = await recordOf(root, '200');
    await m.uninstallProject(root, '200');
    await new Promise((r) => setTimeout(r, 5));
    src.set('200', F, { name: 'Beta', fileId: '2', zip: makeZip(addonEntries('Beta', 'b2')) });
    await m.install(root, F, '200');
    const now = await recordOf(root, '200');
    assert.equal(now.fileId, rec2.fileId);
    assert.notEqual(now.installedAt, rec2.installedAt);
    downloads.length = 0;
    await assert.rejects(m.install(root, F, '200', { force: true, expect: { kind: 'record', ...rec2 } }), changed(/已被重新安装/));
    assert.deepEqual(downloads, [], '所有被拒绝的请求都没有下载');
  } finally {
    await cleanup(base);
  }
});

test('前置条件：来源版本不同仍按原规则拒绝；同一目录另一个插件的提交不影响本插件的记录核对', async () => {
  const { base, root, src, m } = await managerSetup();
  try {
    const rec = await recordOf(root, '100');
    src.set('100', 6, { name: 'Alpha', fileId: '5', zip: makeZip(addonEntries('Alpha', 'a5')), versions: ['12.1.5'] });
    await assert.rejects(m.install(root, 6, '100', { expect: { kind: 'record', ...rec } }), /不会用当前版本的文件更新或重装/);
    // 另一个插件更新（改变目录的清单与 lastTxId），本插件的记录未变：照常更新
    src.set('200', F, { name: 'Beta', fileId: '2', zip: makeZip(addonEntries('Beta', 'b2')) });
    await m.install(root, F, '200');
    src.set('100', F, { name: 'Alpha', fileId: '2', zip: makeZip(addonEntries('Alpha', 'a2')) });
    const r = await m.install(root, F, '100', { expect: { kind: 'record', ...rec } });
    assert.match(r.message, /已更新到 v2/);
  } finally {
    await cleanup(base);
  }
});

test('前置条件的已知边界：卸载后从回收站恢复的是原来那条记录（文件编号与安装时间相同），核对仍然通过并照常更新', async () => {
  const { base, root, src, m } = await managerSetup();
  try {
    const rec = await recordOf(root, '100');
    await m.uninstallProject(root, '100');
    const entry = (await readManifestJson(root)).recovery.find((e) => e.kind === 'uninstall' && e.folders.includes('Alpha'))!;
    await m.restore(root, entry.id);
    assert.deepEqual(await recordOf(root, '100'), rec, '恢复的是同一条记录');
    src.set('100', F, { name: 'Alpha', fileId: '2', zip: makeZip(addonEntries('Alpha', 'a2')) });
    const r = await m.install(root, F, '100', { expect: { kind: 'record', ...rec } });
    assert.match(r.message, /已更新到 v2/);
  } finally {
    await cleanup(base);
  }
});

test('前置条件：force 只跳过“已是最新”的短路——记录一致时同一文件重新下载并提交；目录缺失时重装补回；不带 force 已是最新不写入', async () => {
  const { base, root, m, downloads } = await managerSetup();
  try {
    const rec = await recordOf(root, '100');
    const s0 = await snapshot(root);
    const same = await m.install(root, F, '100', { expect: { kind: 'record', ...rec } });
    assert.match(same.message, /已是最新/);
    assert.deepEqual(await snapshot(root), s0);
    assert.deepEqual(downloads, []);

    await new Promise((r) => setTimeout(r, 5));
    const re = await m.install(root, F, '100', { force: true, expect: { kind: 'record', ...rec } });
    assert.match(re.message, /已重新安装/);
    assert.equal(downloads.length, 1, '同一文件重新下载');
    const rec2 = await recordOf(root, '100');
    assert.equal(rec2.fileId, rec.fileId);
    assert.notEqual(rec2.installedAt, rec.installedAt, '重新提交了记录');

    // 托管记录还在、插件目录被手动删掉：重装补回
    await rm(path.join(root, 'Interface', 'AddOns', 'Alpha'), { recursive: true });
    assert.equal(await exists(path.join(root, 'Interface', 'AddOns', 'Alpha')), false);
    const fixed = await m.install(root, F, '100', { force: true, expect: { kind: 'record', ...rec2 } });
    assert.equal(fixed.ok, true);
    assert.ok((await listAddOns(root)).includes('Alpha'));
  } finally {
    await cleanup(base);
  }
});
