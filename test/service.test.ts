import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runUpdateAll } from '../src/core/batch';
import { UserError } from '../src/core/errors';
import { inspectPickedRoot, SettingsStore } from '../src/core/profiles';
import { cleanupRunDir, createRunDir } from '../scripts/smoke-dir';
import { addonEntries, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';

const F = 9;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));

/** 在 rootA 安装 M1、M2 的 v1，然后让源上出现 v2 */
async function twoOutdated(root: string, src: FakeSource) {
  const m = makeManager(src);
  src.set('1', F, { name: 'M1', fileId: '1', zip: zipOf('M1', 'v1') });
  src.set('2', F, { name: 'M2', fileId: '1', zip: zipOf('M2', 'v1') });
  await m.install(root, F, '1');
  await m.install(root, F, '2');
  src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
  src.set('2', F, { name: 'M2', fileId: '2', zip: zipOf('M2', 'v2') });
  return m;
}

test('全部更新：检查全部失败时不得声称“全部最新”', async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = await twoOutdated(root, src);
  src.mods.clear(); // 远端全部查询失败
  const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, /最新版本/);
  assert.match(r.message, /检查更新失败/);
  assert.equal(r.warnings?.length, 2);
  await cleanup(base);
});

test('全部更新：用户取消的项目不计为成功', async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = await twoOutdated(root, src);
  const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: async () => ({ ok: false, message: '已取消安装，未做任何改动' }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /已更新 0 个插件/);
  assert.match(r.message, /取消 2 个/);
  await cleanup(base);
});

test('全部更新：计划在第一项开始之前给出一次；任务中被取消的项目计为取消而不是失败，并继续处理下一项', async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = await twoOutdated(root, src);
  const log: string[] = [];
  const r = await runUpdateAll({
    manager: m,
    root,
    flavorId: F,
    isStillBound: async () => true,
    plan: (ps) => log.push(`plan:${ps.map((p) => p.modId).join(',')}`),
    installOne: async (p, r0) => {
      log.push(`install:${p.modId}`);
      if (log.length === 2) throw new UserError('已取消', 'cancelled');
      return m.install(r0, p.flavorId, p.modId);
    },
  });
  assert.equal(log.length, 3);
  assert.match(log[0], /^plan:(1,2|2,1)$/);
  assert.deepEqual(log.slice(1), log[0].slice(5).split(',').map((id) => `install:${id}`), '按计划顺序处理');
  assert.equal(r.ok, false);
  assert.match(r.message, /已更新 1 个插件，取消 1 个/);
  assert.doesNotMatch(r.message, /失败/);
  await cleanup(base);
});

test('全部更新：批次中途换绑或解绑时停止，所有写入只发生在最初的目录', async () => {
  for (const change of ['rebind', 'unbind'] as const) {
    const base = await tmpDir();
    const rootA = await makeGameRoot(path.join(base, 'a'));
    const rootB = await makeGameRoot(path.join(base, 'b'));
    const settings = new SettingsStore(path.join(base, 'settings.json'));
    const src = new FakeSource();
    const m = await twoOutdated(rootA, src);
    await settings.bind(F, rootA);
    const bBefore = await readdir(path.join(rootB, 'Interface', 'AddOns'));
    const writtenTo: string[] = [];
    const r = await runUpdateAll({
      manager: m,
      root: rootA,
      flavorId: F,
      isStillBound: async () => (await settings.profile(F)).root === rootA,
      installOne: async (p, fixedRoot) => {
        writtenTo.push(fixedRoot);
        const res = await m.install(fixedRoot, p.flavorId, p.modId);
        // 第一项完成后，用户在另一个窗口操作换绑/解绑
        await settings.bind(F, change === 'rebind' ? rootB : null);
        return res;
      },
    });
    assert.deepEqual(writtenTo, [rootA], `${change}: 只应处理一项且写入最初目录`);
    assert.equal(r.ok, false);
    assert.match(r.message, /绑定已变更，剩余 1 个未处理/);
    assert.deepEqual(await readdir(path.join(rootB, 'Interface', 'AddOns')), bBefore, `${change}: 新目录不得被写入`);
    assert.equal(await exists(path.join(rootB, 'Interface', '.beelite')), false);
    await cleanup(base);
  }
});

test('全部更新：正常情况下全部更新成功', async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = await twoOutdated(root, src);
  const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
  assert.equal(r.ok, true);
  assert.match(r.message, /已更新 2 个插件/);
  assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'M2', 'M2.toc'), 'utf8'), /v2/);
  await cleanup(base);
});

/**
 * 每项更新都会返回提示：WarningFixture（Core、Gone、Missing → 只含 Core，更新前 Missing 已不在 AddOns）
 * 与 PairFixture（Alpha、Beta → 只含 Alpha）。
 */
async function twoWithWarnings(root: string, src: FakeSource) {
  const m = makeManager(src);
  const zipOfAll = (folders: string[], v: string) => makeZip(folders.flatMap((f) => addonEntries(f, v)));
  src.set('100', F, { name: 'WarningFixture', fileId: '1', zip: zipOfAll(['Core', 'Gone', 'Missing'], 'v1') });
  src.set('200', F, { name: 'PairFixture', fileId: '1', zip: zipOfAll(['Alpha', 'Beta'], 'v1') });
  await m.install(root, F, '100');
  await m.install(root, F, '200');
  await rm(path.join(root, 'Interface', 'AddOns', 'Missing'), { recursive: true });
  src.set('100', F, { name: 'WarningFixture', fileId: '2', zip: zipOf('Core', 'v2') });
  src.set('200', F, { name: 'PairFixture', fileId: '2', zip: zipOf('Alpha', 'v2') });
  return m;
}

const FIXTURE_NOTES = [
  'WarningFixture：新版本不再包含 Gone，已随旧版本一起移入备份',
  'WarningFixture：新版本不再包含 Missing；它们在更新前已不在 AddOns 中，没有可备份的内容',
];
const PAIR_NOTE = 'PairFixture：新版本不再包含 Beta，已随旧版本一起移入备份';

test('全部更新：保留每项更新返回的提示并加上插件名称，计数与成功判定不变', async () => {
  const base = await tmpDir();
  try {
    const root = await makeGameRoot(base);
    const src = new FakeSource();
    const m = await twoWithWarnings(root, src);
    const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
    assert.equal(r.ok, true);
    assert.equal(r.message, '已更新 2 个插件');
    assert.deepEqual([...(r.warnings ?? [])].sort(), [...FIXTURE_NOTES, PAIR_NOTE].sort());
    const manifest = await m.readManifestFor(root);
    assert.ok(manifest.recovery.some((e) => e.kind === 'update-backup' && e.folders.includes('Gone')));
    assert.equal(manifest.recovery.some((e) => e.folders.includes('Missing')), false);
  } finally {
    await cleanup(base);
  }
});

test('全部更新：前面完成项的提示不因后续项失败、取消或批次停止而丢失', async () => {
  // 第二项失败（失败排在前面）或第一项完成后换绑停止：第一项的提示仍在
  for (const how of ['fail', 'stop'] as const) {
    const base = await tmpDir();
    try {
      const root = await makeGameRoot(base);
      const src = new FakeSource();
      const m = await twoWithWarnings(root, src);
      const order: string[] = [];
      let bound = 0;
      const r = await runUpdateAll({
        manager: m,
        root,
        flavorId: F,
        isStillBound: async () => how === 'fail' || bound++ === 0,
        installOne: async (p, r0) => {
          order.push(p.modId);
          if (order.length === 2) throw new Error('网络中断（测试）');
          return m.install(r0, p.flavorId, p.modId);
        },
      });
      const firstNotes = order[0] === '100' ? FIXTURE_NOTES : [PAIR_NOTE];
      const firstName = order[0] === '100' ? 'WarningFixture' : 'PairFixture';
      const secondName = order[0] === '100' ? 'PairFixture' : 'WarningFixture';
      assert.equal(r.ok, false);
      if (how === 'fail') {
        assert.equal(r.message, '已更新 1 个插件，失败 1 个');
        assert.deepEqual(r.warnings, [`${secondName}：网络中断（测试）`, ...firstNotes]);
      } else {
        assert.equal(order.length, 1, `${firstName} 完成后停止`);
        assert.equal(r.message, '已更新 1 个插件，游戏目录绑定已变更，剩余 1 个未处理');
        assert.deepEqual(r.warnings, firstNotes);
      }
    } finally {
      await cleanup(base);
    }
  }

  // 返回未成功（取消）的项目计为取消，它带回的提示同样保留
  const base = await tmpDir();
  try {
    const root = await makeGameRoot(base);
    const src = new FakeSource();
    const m = await twoOutdated(root, src);
    const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: async (p) => ({ ok: false, message: '已取消安装，未做任何改动', warnings: [`${p.modId} 的提示`] }) });
    assert.equal(r.ok, false);
    assert.equal(r.message, '已更新 0 个插件，取消 2 个');
    assert.deepEqual([...(r.warnings ?? [])].sort(), ['M1：1 的提示', 'M2：2 的提示']);
  } finally {
    await cleanup(base);
  }
});

test('目录绑定：同一目录不能绑定两个版本；已知版本目录选反直接拒绝；自定义名称仅提示', async () => {
  const base = await tmpDir();
  const forever = path.join(base, '_forever_');
  const retail = path.join(base, '_retail_');
  const custom = path.join(base, 'MyWoW');
  for (const d of [forever, retail, custom]) await mkdir(path.join(d, 'Interface', 'AddOns'), { recursive: true });

  // 已知目录选反
  await assert.rejects(inspectPickedRoot(forever, 2, {}), /是「无限」的游戏目录/);
  await assert.rejects(inspectPickedRoot(path.join(retail, 'Interface', 'AddOns'), 9, {}), /是「正式服」的游戏目录/);
  // 正确选择（包括选中 AddOns 自动上移）
  const ok = await inspectPickedRoot(path.join(forever, 'Interface', 'AddOns'), 9, {});
  assert.equal(path.basename(ok.root), '_forever_');
  assert.deepEqual(ok.warnings, []);
  // 同一目录已绑定给其他版本
  await assert.rejects(inspectPickedRoot(custom, 2, { 9: (await inspectPickedRoot(custom, 9, {})).root }), /已绑定给「无限」/);
  // 未知的自定义名称：允许，但必须带提示让用户确认
  const c = await inspectPickedRoot(custom, 9, {});
  assert.ok(c.warnings.some((w) => w.includes('_forever_')));

  // 存储层同样拒绝重复绑定
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.bind(9, c.root);
  await assert.rejects(settings.bind(2, c.root), /不能用于两个游戏版本/);
  assert.equal((await settings.profile(2)).root, null);
  await settings.bind(9, c.root); // 同一版本重新绑定同一目录允许
  await cleanup(base);
});

test('smoke 目录：只清理本次新建的子目录，已有目录与其中的文件保持不变', async () => {
  const parent = await tmpDir('beelite-smoke-parent-');
  await writeFile(path.join(parent, 'sentinel.txt'), 'do-not-delete');
  const run = await createRunDir(parent);
  await writeFile(path.join(run, 'x.txt'), 'tmp');
  await cleanupRunDir(run, parent);
  assert.equal(await exists(run), false);
  assert.equal(await readFile(path.join(parent, 'sentinel.txt'), 'utf8'), 'do-not-delete');
  // 拒绝清理父目录本身、没有标记的目录
  await assert.rejects(cleanupRunDir(parent, parent), /拒绝清理/);
  const fake = path.join(parent, 'beelite-smoke-fake');
  await mkdir(fake);
  await assert.rejects(cleanupRunDir(fake, parent), /缺少本次运行标记/);
  assert.equal(await exists(fake), true);
  assert.equal(await readFile(path.join(parent, 'sentinel.txt'), 'utf8'), 'do-not-delete');
  await cleanup(parent);
});
