import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { runUpdateAll } from '../src/core/batch';
import { SimulatedCrash } from '../src/core/errors';
import { identityOf } from '../src/core/layout';
import { parseManifest } from '../src/core/store';
import { addUnmanaged, addonEntries, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { snapshot as bytes } from './ipc-harness';

const F = 9;

/** 递归读取目录为 {相对路径: 内容}，符号链接记为 ->target */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = '->link';
      else if (e.isDirectory()) {
        out[r + '/'] = '';
        await walk(p, r);
      } else out[r] = await readFile(p, 'utf8');
    }
  };
  await walk(dir, '');
  return out;
}

async function snapshot(root: string) {
  const meta = path.join(root, 'Interface', '.beelite');
  const manifestText = await readFile(path.join(meta, 'manifest.json'), 'utf8').catch(() => null);
  return {
    addons: await tree(path.join(root, 'Interface', 'AddOns')),
    wtf: await tree(path.join(root, 'WTF')),
    trash: await tree(path.join(meta, 'trash')),
    manifest: manifestText ? { ...JSON.parse(manifestText), lastTxId: null } : null,
  };
}

async function assertClean(root: string) {
  const meta = path.join(root, 'Interface', '.beelite');
  assert.equal(await exists(path.join(meta, 'journal.json')), false, 'journal 应已清理');
  assert.deepEqual(await readdir(path.join(meta, 'staging')), [], 'staging 应为空');
}

function zipOf(folders: string[], version: string) {
  return makeZip(folders.flatMap((f) => addonEntries(f, version)));
}

async function setup() {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  return { base, root, src };
}

test('首次接入：没有 .beelite 时只读扫描列出全部现有插件且不创建任何目录；可恢复卸载', async () => {
  const { base, root, src } = await setup();
  await addUnmanaged(root, 'Existing');
  const m = makeManager(src);
  const st = await m.localState({ flavorId: F, root, addonsPath: null }, F);
  assert.equal(st.error, null);
  assert.deepEqual(st.unmanaged.map((u) => u.name), ['Existing']);
  assert.equal(st.unmanaged[0].toc?.title, 'Existing (old)');
  assert.equal(await exists(path.join(root, 'Interface', '.beelite')), false, '只读扫描不得创建数据目录');

  const r = await m.uninstallFolder(root, 'Existing');
  assert.ok(r.ok);
  const st2 = await m.localState({ flavorId: F, root, addonsPath: null }, F);
  assert.equal(st2.unmanaged.length, 0);
  assert.equal(st2.recovery.length, 1);
  await m.restore(root, st2.recovery[0].id);
  assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'Existing', 'Existing.toc'), 'utf8'), /old/);
  await assertClean(root);
  await cleanup(base);
});

test('多模块更新：退役模块随旧版进入备份，不残留在 AddOns；每个插件只保留一份更新备份', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('100', F, { name: '多模块', fileId: '1', zip: zipOf(['A', 'B'], 'v1'), folders: ['A', 'B'] });
  await m.install(root, F, '100');
  src.set('100', F, { name: '多模块', fileId: '2', zip: zipOf(['A', 'C'], 'v2'), folders: ['A', 'C'] });
  const r = await m.install(root, F, '100');
  assert.ok(r.ok);
  assert.ok(r.warnings?.some((w) => w.includes('B')));
  assert.deepEqual((await readdir(path.join(root, 'Interface', 'AddOns'))).sort(), ['A', 'C']);
  assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'A', 'A.toc'), 'utf8'), /v2/);
  let man = await m.readManifestFor(root);
  assert.deepEqual(man.projects['100'].folders, ['A', 'C']);
  assert.equal(man.projects['100'].fileId, '2');
  const backups = man.recovery.filter((e) => e.kind === 'update-backup');
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0].folders.sort(), ['A', 'B']);
  const firstBackupDir = path.join(root, 'Interface', '.beelite', 'trash', backups[0].id);
  assert.match(await readFile(path.join(firstBackupDir, 'B', 'B.toc'), 'utf8'), /v1/);

  // 同一文件不强制时不重复安装；强制重装后旧备份被替换并删除
  assert.match((await m.install(root, F, '100')).message, /最新/);
  await m.install(root, F, '100', { force: true });
  man = await m.readManifestFor(root);
  assert.equal(man.recovery.filter((e) => e.kind === 'update-backup').length, 1);
  assert.equal(await exists(firstBackupDir), false);
  assert.deepEqual(man.purgeQueue, []);
  // 当前已安装时恢复更新备份会报冲突
  await assert.rejects(m.restore(root, man.recovery[0].id), /无法恢复/);
  await assertClean(root);
  await cleanup(base);
});

test('所有权冲突：两个项目共享 OpenMap 目录时拒绝覆盖，原插件与回收站保持不变', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('31505', F, { name: 'openmap-cn', fileId: '673432', zip: zipOf(['OpenMap'], 'cn'), folders: ['OpenMap'] });
  src.set('30738', F, { name: 'OpenMap', fileId: '672216', zip: zipOf(['OpenMap'], 'curse'), folders: ['OpenMap'] });
  await m.install(root, F, '31505');
  const before = await snapshot(root);
  await assert.rejects(m.install(root, F, '30738'), /已属于已安装的「openmap-cn」/);
  assert.deepEqual(await snapshot(root), before);
  await assertClean(root);
  await cleanup(base);
});

test('接管未托管目录需要确认；拒绝时不改动，接受后旧目录可从回收站恢复', async () => {
  const { base, root, src } = await setup();
  await addUnmanaged(root, 'Questie', 'manual');
  src.set('20', F, { name: 'Questie', fileId: '702728', zip: zipOf(['Questie'], 'v12'), folders: ['Questie'] });
  const before = await snapshot(root);
  const deny = makeManager(src, { confirm: async () => false });
  const r = await deny.install(root, F, '20');
  assert.equal(r.ok, false);
  const after = await snapshot(root);
  assert.deepEqual(after.addons, before.addons);
  assert.deepEqual(after.wtf, before.wtf);

  const prompts: string[] = [];
  const m = makeManager(src, { confirm: async (q) => (prompts.push(q.detail), true) });
  await m.install(root, F, '20');
  assert.ok(prompts[0].includes('Questie'));
  const man = await m.readManifestFor(root);
  const take = man.recovery.find((e) => e.kind === 'takeover')!;
  assert.deepEqual(take.folders, ['Questie']);
  await m.uninstallProject(root, '20');
  await m.restore(root, take.id);
  assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'Questie', 'Questie.toc'), 'utf8'), /manual/);
  const st = await m.localState({ flavorId: F, root, addonsPath: null }, F);
  assert.deepEqual(st.unmanaged.map((u) => u.name), ['Questie']);
  assert.deepEqual((await snapshot(root)).wtf, before.wtf, 'WTF 不得被改动');
  await cleanup(base);
});

test('P1 回归：恢复缺失模块的项目不会抢占其他项目的目录', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('1', F, { name: '项目一', fileId: '11', zip: zipOf(['A', 'B'], 'p1'), folders: ['A', 'B'] });
  src.set('2', F, { name: '项目二', fileId: '22', zip: zipOf(['B'], 'p2'), folders: ['B'] });
  await m.install(root, F, '1');
  await rm(path.join(root, 'Interface', 'AddOns', 'B'), { recursive: true }); // 外部删除 B
  await m.uninstallProject(root, '1');
  let man = await m.readManifestFor(root);
  const entry = man.recovery[0];
  assert.deepEqual(entry.folders, ['A']);
  assert.deepEqual(entry.project?.folders, ['A']);

  await m.install(root, F, '2');
  const p2Before = await snapshot(root);
  await m.restore(root, entry.id);
  man = await m.readManifestFor(root);
  assert.deepEqual(man.projects['1'].folders, ['A']);
  assert.deepEqual(man.projects['2'].folders, ['B']);

  await m.uninstallProject(root, '1');
  const after = await snapshot(root);
  assert.equal(after.addons['B/B.toc'], p2Before.addons['B/B.toc'], '项目二的 B 必须保持不变');
  assert.equal(after.addons['B/B.lua'], p2Before.addons['B/B.lua']);
  assert.equal(after.addons['A/'], undefined);
  await cleanup(base);
});

test('manifest 校验：拒绝跨项目重复归属、重复恢复编号与超出备份的归属', () => {
  const proj = (modId: string, folders: string[]) => ({ modId, flavorId: 9, fileId: '1', version: '', name: modId, logo: null, folders, installedAt: 0 });
  const base = { schema: 1, lastTxId: null, recovery: [] as unknown[], purgeQueue: [] };
  assert.throws(() => parseManifest(JSON.stringify({ ...base, projects: { 1: proj('1', ['A']), 2: proj('2', ['a']) } })), /多个项目/);
  const e = { id: 'abc-123456', kind: 'uninstall', createdAt: 0, label: 'x', folders: ['A'], project: null };
  assert.throws(() => parseManifest(JSON.stringify({ ...base, projects: {}, recovery: [e, e] })), /恢复项编号/);
  assert.throws(() => parseManifest(JSON.stringify({ ...base, projects: {}, recovery: [{ ...e, project: proj('1', ['A', 'B']) }] })), /超出/);
  assert.ok(parseManifest(JSON.stringify({ ...base, projects: { 1: proj('1', ['A']) }, recovery: [{ ...e, project: proj('1', ['A']) }] })));
});

/** 已安装 v1，再更新到 v2（产生更新备份），并有一个未托管目录 D 将被 v3 接管 */
async function updateScenario() {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('100', F, { name: '多模块', fileId: '1', zip: zipOf(['A', 'B'], 'v1'), folders: ['A', 'B'] });
  await m.install(root, F, '100');
  src.set('100', F, { name: '多模块', fileId: '2', zip: zipOf(['A', 'B'], 'v2'), folders: ['A', 'B'] });
  await m.install(root, F, '100');
  await addUnmanaged(root, 'D', 'mine');
  src.set('100', F, { name: '多模块', fileId: '3', zip: zipOf(['A', 'C', 'D'], 'v3'), folders: ['A', 'C', 'D'] });
  return { base, root, src };
}

// 更新 v2->v3 的步骤：备份 A、B，接管 D，再放入 A、C、D，共 6 步
const OP_COUNT = 6;
const FAIL_STEPS = ['journal-written', ...Array.from({ length: OP_COUNT }, (_, i) => [`before-op:${i}`, `op:${i}`]).flat(), 'manifest-tmp-written', 'committing'];

test('注入失败：每个事务步骤失败都完整回滚，旧插件、旧备份与 WTF 不变', async () => {
  for (const step of FAIL_STEPS) {
    const { base, root, src } = await updateScenario();
    const before = await snapshot(root);
    const m = makeManager(src, {
      hook: (s) => {
        if (s === step) throw new Error(`注入失败@${s}`);
      },
    });
    await assert.rejects(m.install(root, F, '100'), new RegExp(`注入失败@${step}`), step);
    assert.deepEqual(await snapshot(root), before, `回滚后状态应与之前一致：${step}`);
    await assertClean(root);
    await cleanup(base);
  }
});

test('模拟崩溃：任一步骤进程中断后重启恢复，结果要么完整旧版要么完整新版', async () => {
  for (const step of [...FAIL_STEPS, 'manifest-committed']) {
    const { base, root, src } = await updateScenario();
    const before = await snapshot(root);
    const crashing = makeManager(src, {
      hook: (s) => {
        if (s === step) throw new SimulatedCrash(s);
      },
    });
    await assert.rejects(crashing.install(root, F, '100'), SimulatedCrash);
    const fresh = makeManager(src);
    const state = await fresh.recover(root);
    assert.equal(state.status, 'ok', `${step}: ${state.message}`);
    await assertClean(root);
    const after = await snapshot(root);
    if (step === 'manifest-committed') {
      assert.deepEqual(Object.keys(after.addons).filter((k) => k.endsWith('/')).sort(), ['A/', 'C/', 'D/']);
      assert.equal(after.manifest.projects['100'].fileId, '3');
      assert.match(after.addons['A/A.toc'], /v3/);
    } else {
      assert.deepEqual(after, before, `崩溃于 ${step} 后应恢复为旧版`);
    }
    await cleanup(base);
  }
});

test('P1 回归：回滚时原位置被外部占用，保留 journal、备份与外部内容并阻止后续写入', async () => {
  const { base, root, src } = await updateScenario();
  const addons = path.join(root, 'Interface', 'AddOns');
  const meta = path.join(root, 'Interface', '.beelite');
  const before = await snapshot(root);
  const m = makeManager(src, {
    hook: async (s) => {
      // 第 0 步（A 已移入备份）后，外部程序重新创建了 AddOns/A
      if (s === 'op:0') {
        await mkdir(path.join(addons, 'A'));
        await writeFile(path.join(addons, 'A', 'foreign.txt'), 'foreign');
      }
    },
  });
  await assert.rejects(m.install(root, F, '100'), /暂停写入/);
  assert.equal(await exists(path.join(meta, 'journal.json')), true, 'journal 必须保留');
  assert.equal(await readFile(path.join(addons, 'A', 'foreign.txt'), 'utf8'), 'foreign');
  // 旧 A 仍在本次事务的备份中，旧的更新备份（v1）也必须还在
  const trash = await tree(path.join(meta, 'trash'));
  assert.ok(Object.entries(trash).some(([k, v]) => k.endsWith('/A/A.toc') && /v2/.test(v)), '被移走的 v2 A 必须保留');
  for (const [k, v] of Object.entries(before.trash)) assert.equal(trash[k], v, `旧备份 ${k} 必须保持不变`);

  const fresh = makeManager(src);
  const st = await fresh.recover(root);
  assert.equal(st.status, 'blocked');
  assert.equal(await exists(path.join(meta, 'journal.json')), true);
  await assert.rejects(fresh.uninstallProject(root, '100'), /暂停写入/);
  const trash2 = await tree(path.join(meta, 'trash'));
  assert.deepEqual(trash2, trash, '阻塞状态下不得清理任何备份');
  await cleanup(base);
});

test('正常未执行情形：暂存源与旧目标同时存在不被误判', async () => {
  const { base, root, src } = await updateScenario();
  const before = await snapshot(root);
  const crashing = makeManager(src, { hook: (s) => { if (s === 'journal-written') throw new SimulatedCrash(s); } });
  await assert.rejects(crashing.install(root, F, '100'));
  // 此时 staging/x/A 与 AddOns/A 同时存在
  const st = await makeManager(src).recover(root);
  assert.equal(st.status, 'ok');
  assert.deepEqual(await snapshot(root), before);
  await cleanup(base);
});

test('P1 回归：staging/trash/journal 为符号链接时拒绝操作，外部文件逐字节不变', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('1', F, { name: 'X', fileId: '1', zip: zipOf(['X'], 'v1'), folders: ['X'] });
  await m.install(root, F, '1');
  const meta = path.join(root, 'Interface', '.beelite');
  const outside = path.join(base, 'valuable');
  await mkdir(path.join(outside, 'B'), { recursive: true });
  await writeFile(path.join(outside, 'important.txt'), 'keep-me');
  await writeFile(path.join(outside, 'B', 'B.toc'), 'external');
  const outsideBefore = await tree(outside);

  // 1) staging 被替换为指向外部的符号链接
  await rm(path.join(meta, 'staging'), { recursive: true });
  await symlink(outside, path.join(meta, 'staging'));
  const st = await m.localState({ flavorId: F, root, addonsPath: null }, F);
  assert.match(st.error ?? '', /符号链接/);
  await assert.rejects(m.recover(root), /符号链接/);
  await assert.rejects(m.install(root, F, '1', { force: true }), /符号链接/);
  assert.deepEqual(await tree(outside), outsideBefore);
  await rm(path.join(meta, 'staging'));
  await mkdir(path.join(meta, 'staging'));

  // 2) trash 子目录是符号链接，伪造的 journal 试图把外部 B 搬进 AddOns
  const evilId = 'evil01-abcdef';
  await symlink(outside, path.join(meta, 'trash', evilId));
  const extId = await identityOf(path.join(outside, 'B'));
  const journal = { schema: 1, txId: 'zzz-123456', kind: 'restore', state: 'prepared', trashIds: [evilId], createdAt: 0, ops: [{ from: `.beelite/trash/${evilId}/B`, to: 'AddOns/B', id: extId }] };
  await writeFile(path.join(meta, 'journal.json'), JSON.stringify(journal));
  const st2 = await m.recover(root);
  assert.equal(st2.status, 'blocked');
  assert.equal(await exists(path.join(root, 'Interface', 'AddOns', 'B')), false);
  assert.deepEqual(await tree(outside), outsideBefore);
  // 阻塞时不做 GC：符号链接本身仍在（未被跟随删除）
  assert.ok((await lstat(path.join(meta, 'trash', evilId))).isSymbolicLink());
  await rm(path.join(meta, 'journal.json'));
  await rm(path.join(meta, 'trash', evilId));

  // 3) journal 本身是符号链接
  await writeFile(path.join(base, 'fake-journal.json'), JSON.stringify({ ...journal, trashIds: [], ops: [] }));
  await symlink(path.join(base, 'fake-journal.json'), path.join(meta, 'journal.json'));
  assert.equal((await m.recover(root)).status, 'blocked');
  await rm(path.join(meta, 'journal.json'));

  // 4) 伪造不属于本事务的暂存路径
  await writeFile(path.join(meta, 'journal.json'), JSON.stringify({ ...journal, trashIds: [], ops: [{ from: '.beelite/staging/other-123456/x/B', to: 'AddOns/B', id: extId }] }));
  assert.equal((await m.recover(root)).status, 'blocked');
  assert.deepEqual(await tree(outside), outsideBefore);
  await cleanup(base);
});

test('flavor 隔离与免费复核：没有对应版本文件、版本不兼容或非免费时不写入任何内容', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  const before = await snapshot(root);
  src.set('31505', F, { name: 'cn', fileId: '1', zip: zipOf(['OpenMap'], 'cn') });
  await assert.rejects(m.install(root, 2, '31505'), /查询不到当前游戏的插件信息/);
  src.set('5', F, { name: '错版本', fileId: '1', zip: zipOf(['W'], 'r'), versions: ['12.1.5'] });
  await assert.rejects(m.install(root, F, '5'), /不匹配/);
  src.set('6', F, { name: '付费', fileId: '1', zip: zipOf(['P'], 'p'), accessible: false });
  await assert.rejects(m.install(root, F, '6'), /免费/);
  assert.deepEqual((await snapshot(root)).addons, before.addons);
  assert.ok(!src.calls.includes('latest:31505:9'), '不得回退到其他 flavor');

  // 已按无限安装的插件不能在同一目录被另一个 flavor 覆盖
  await m.install(root, F, '31505');
  src.set('31505', 2, { name: 'cn', fileId: '9', zip: zipOf(['OpenMap'], 'retail'), versions: ['12.1.5'] });
  await assert.rejects(m.install(root, 2, '31505'), /已以「无限」版本安装/);
  await cleanup(base);
});

test('更新包解压失败（无效 deflate 编码）时：原插件、manifest、回收站不变，暂存区已清理', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  src.set('100', F, { name: '多模块', fileId: '1', zip: zipOf(['A', 'B'], 'v1'), folders: ['A', 'B'] });
  await m.install(root, F, '100');
  const before = await snapshot(root);
  const broken = makeZip([...addonEntries('A', 'v2'), { name: 'A/broken.lua', data: 'x'.repeat(64), rawBody: Buffer.from([0x07, 0, 0, 0, 0, 0]) }]);
  src.set('100', F, { name: '多模块', fileId: '2', zip: broken, folders: ['A'] });
  await assert.rejects(m.install(root, F, '100'), /压缩包校验失败/);
  assert.deepEqual(await snapshot(root), before);
  await assertClean(root);
  await cleanup(base);
});

test('同一目录并发操作串行执行，manifest 完整', async () => {
  const { base, root, src } = await setup();
  const m = makeManager(src);
  for (const id of ['1', '2', '3']) src.set(id, F, { name: `M${id}`, fileId: id, zip: zipOf([`M${id}`], 'v') });
  await Promise.all(['1', '2', '3'].map((id) => m.install(root, F, id)));
  const man = await m.readManifestFor(root);
  assert.deepEqual(Object.keys(man.projects).sort(), ['1', '2', '3']);
  assert.deepEqual((await readdir(path.join(root, 'Interface', 'AddOns'))).sort(), ['M1', 'M2', 'M3']);
  await assertClean(root);
  await cleanup(base);
});

// ---------- 0.1.7 回归 ----------

test('F2 只读检查：数据目录缺少 trash 或 staging 时仍按实际清单检查，不补目录；全部更新照常完成并由写操作补齐', async () => {
  for (const aux of ['trash', 'staging']) {
    const { base, root, src } = await setup();
    try {
      const m = makeManager(src);
      src.set('1', F, { name: 'M1', fileId: '1', zip: zipOf(['M1'], 'v1') });
      await m.install(root, F, '1');
      src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf(['M1'], 'v2') });
      const meta = path.join(root, 'Interface', '.beelite');
      await rm(path.join(meta, aux), { recursive: true });
      const before = await bytes(root);
      src.calls.length = 0;

      const checked = await m.checkUpdatesDetailed(root, F);
      assert.deepEqual(checked.items.map((i) => [i.modId, i.hasUpdate, i.installedFileId, i.latestFileId]), [['1', true, '1', '2']], aux);
      assert.deepEqual(src.calls, [`latest:1:${F}`], '查询了上游');
      const readback = await m.readCheckedManifest(root);
      assert.equal(readback.fingerprint, checked.fingerprint, '检查与读回依据同一份清单');
      assert.deepEqual(Object.keys(readback.manifest.projects), ['1']);
      assert.deepEqual(Object.keys((await m.readManifestFor(root)).projects), ['1']);
      assert.deepEqual(await bytes(root), before, '只读：没有补目录或写入任何文件');
      assert.equal(await exists(path.join(meta, aux)), false);

      const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
      assert.equal(r.ok, true, r.message);
      assert.equal((await m.readManifestFor(root)).projects['1'].fileId, '2');
      assert.equal(await exists(path.join(meta, aux)), true, '写操作补齐了辅助目录');
    } finally {
      await cleanup(base);
    }
  }
});

test('F2 只读检查：真正首次使用（没有 Interface、没有 .beelite、只有空 .beelite）返回空结果且不创建任何东西', async () => {
  const { base, root, src } = await setup();
  try {
    const m = makeManager(src);
    const empty = await m.checkUpdatesDetailed(root, F);
    assert.deepEqual(empty.items, []);
    assert.equal(await exists(path.join(root, 'Interface', '.beelite')), false);

    const meta = path.join(root, 'Interface', '.beelite');
    await mkdir(meta);
    const before = await bytes(root);
    assert.deepEqual((await m.checkUpdatesDetailed(root, F)).items, []);
    assert.equal((await m.readCheckedManifest(root)).fingerprint, empty.fingerprint);
    assert.deepEqual(await bytes(root), before, '空数据目录中没有创建 staging/trash/manifest');

    const bare = path.join(base, 'bare');
    await mkdir(bare);
    assert.deepEqual((await m.checkUpdatesDetailed(bare, F)).items, []);
    assert.deepEqual(await readdir(bare), [], '没有 Interface 时不创建任何东西');
    assert.deepEqual(src.calls, []);
  } finally {
    await cleanup(base);
  }
});

test('F2 只读检查：符号链接与无权限如实报错，不当作没有插件；外部文件不变', async () => {
  const { base, root, src } = await setup();
  try {
    const m = makeManager(src);
    src.set('1', F, { name: 'M1', fileId: '1', zip: zipOf(['M1'], 'v1') });
    await m.install(root, F, '1');
    const meta = path.join(root, 'Interface', '.beelite');
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'manifest.json'), '{"schema":1,"lastTxId":null,"projects":{},"recovery":[],"purgeQueue":[]}');
    const outsideBefore = await tree(outside);

    // 缺失的辅助目录被替换为指向外部的符号链接
    await rm(path.join(meta, 'trash'), { recursive: true });
    await symlink(outside, path.join(meta, 'trash'));
    await assert.rejects(m.checkUpdatesDetailed(root, F), /符号链接/);
    await assert.rejects(m.readCheckedManifest(root), /符号链接/);
    await rm(path.join(meta, 'trash'));

    // 清单本身是符号链接
    await rename(path.join(meta, 'manifest.json'), path.join(base, 'manifest.saved'));
    await symlink(path.join(outside, 'manifest.json'), path.join(meta, 'manifest.json'));
    await assert.rejects(m.checkUpdatesDetailed(root, F), /符号链接/);
    await assert.rejects(m.readManifestFor(root), /符号链接/);
    await rm(path.join(meta, 'manifest.json'));
    await rename(path.join(base, 'manifest.saved'), path.join(meta, 'manifest.json'));
    assert.deepEqual(await tree(outside), outsideBefore);

    // 数据目录不可读：报错而不是空结果（以 root 运行时权限不生效，跳过这一段）
    if (process.getuid?.() !== 0) {
      await chmod(meta, 0o000);
      try {
        await assert.rejects(m.checkUpdatesDetailed(root, F), /EACCES|权限|permission/i);
        await assert.rejects(m.readCheckedManifest(root), /EACCES|权限|permission/i);
      } finally {
        await chmod(meta, 0o755);
      }
    }
    assert.equal((await m.checkUpdatesDetailed(root, F)).items.length, 1, '恢复后照常检查');
  } finally {
    await cleanup(base);
  }
});

test('F4 备份提示：只把实际移入备份的目录说成已备份；更新前已缺失的旧目录单独说明', async () => {
  const { base, root, src } = await setup();
  try {
    const m = makeManager(src);
    const addons = path.join(root, 'Interface', 'AddOns');
    src.set('1', F, { name: 'P', fileId: '1', zip: zipOf(['Alpha', 'Beta'], 'v1'), folders: ['Alpha', 'Beta'] });
    await m.install(root, F, '1');
    await rm(path.join(addons, 'Beta'), { recursive: true });
    src.set('1', F, { name: 'P', fileId: '2', zip: zipOf(['Alpha'], 'v2'), folders: ['Alpha'] });
    const r = await m.install(root, F, '1');
    assert.ok(r.ok);
    assert.ok(!r.warnings?.some((w) => w.includes('已随旧版本一起移入备份')), '没有承诺不存在的 Beta 可从备份找回');
    assert.deepEqual(r.warnings?.filter((w) => w.includes('Beta')), ['新版本不再包含 Beta；它们在更新前已不在 AddOns 中，没有可备份的内容']);
    const backup = (await m.readManifestFor(root)).recovery.find((e) => e.kind === 'update-backup')!;
    assert.deepEqual(backup.folders, ['Alpha']);
    assert.deepEqual(await readdir(path.join(root, 'Interface', '.beelite', 'trash', backup.id)), ['Alpha']);
    assert.deepEqual(await readdir(addons), ['Alpha']);
  } finally {
    await cleanup(base);
  }
});

test('F4 备份提示：旧目录全部缺失时不创建备份也不提示已备份；大小写不同的目录按实际名称计入', async () => {
  const { base, root, src } = await setup();
  try {
    const m = makeManager(src);
    const addons = path.join(root, 'Interface', 'AddOns');
    // 1. 全部缺失
    src.set('1', F, { name: 'P', fileId: '1', zip: zipOf(['Alpha', 'Beta'], 'v1'), folders: ['Alpha', 'Beta'] });
    await m.install(root, F, '1');
    await rm(path.join(addons, 'Alpha'), { recursive: true });
    await rm(path.join(addons, 'Beta'), { recursive: true });
    src.set('1', F, { name: 'P', fileId: '2', zip: zipOf(['Alpha'], 'v2'), folders: ['Alpha'] });
    let r = await m.install(root, F, '1');
    assert.ok(r.ok);
    assert.deepEqual(r.warnings?.filter((w) => /Alpha|Beta/.test(w)), ['新版本不再包含 Beta；它们在更新前已不在 AddOns 中，没有可备份的内容']);
    assert.equal((await m.readManifestFor(root)).recovery.filter((e) => e.kind === 'update-backup').length, 0, '没有内容可备份时不建立备份条目');

    // 2. 大小写：清单记录 Alpha、Beta，磁盘上是 alpha、beta；新版本目录写作 ALPHA
    const m2 = makeManager(src);
    await m2.uninstallProject(root, '1');
    src.set('2', F, { name: 'Q', fileId: '1', zip: zipOf(['Alpha', 'Beta'], 'v1'), folders: ['Alpha', 'Beta'] });
    await m2.install(root, F, '2');
    await rename(path.join(addons, 'Alpha'), path.join(addons, 'alpha'));
    await rename(path.join(addons, 'Beta'), path.join(addons, 'beta'));
    src.set('2', F, { name: 'Q', fileId: '2', zip: zipOf(['ALPHA'], 'v2'), folders: ['ALPHA'] });
    r = await m2.install(root, F, '2');
    assert.ok(r.ok);
    assert.deepEqual(r.warnings?.filter((w) => /alpha|beta/i.test(w)), ['新版本不再包含 beta，已随旧版本一起移入备份'], '只提一次 beta，使用磁盘上的实际名称；ALPHA 与 alpha 视为同一目录');
    const backup = (await m2.readManifestFor(root)).recovery.find((e) => e.kind === 'update-backup' && e.project?.modId === '2')!;
    assert.deepEqual([...backup.folders].sort(), ['alpha', 'beta']);
    assert.deepEqual(await readdir(addons), ['ALPHA']);
  } finally {
    await cleanup(base);
  }
});
