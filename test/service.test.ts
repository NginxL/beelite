import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runUpdateAll } from '../src/core/batch';
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
  const r = await runUpdateAll({ manager: m, root, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
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
  const r = await runUpdateAll({ manager: m, root, isStillBound: async () => true, installOne: async () => ({ ok: false, message: '已取消安装，未做任何改动' }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /已更新 0 个插件/);
  assert.match(r.message, /取消 2 个/);
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
  const r = await runUpdateAll({ manager: m, root, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
  assert.equal(r.ok, true);
  assert.match(r.message, /已更新 2 个插件/);
  assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'M2', 'M2.toc'), 'utf8'), /v2/);
  await cleanup(base);
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
