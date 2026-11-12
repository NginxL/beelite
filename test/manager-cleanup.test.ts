// 0.2.2：已提交操作之后的清理（回收站待删除队列、下载暂存、事务日志收尾）失败时的结果与状态。
// 删除失败使用临时目录中的真实权限（chmod），不 mock 文件系统；只有“删除后、队列保存前”的时序用事务钩子注入。
// 必须成立：不把未完成的删除说成已永久删除；已提交的安装不回滚、回执不丢；清理失败不让插件列表消失、不阻断无关写操作；
// 失败的待删除编号持久保留，成功项只在安全写回后离开队列；真正的事务保护（journal / 清单 / 目录身份）仍然阻断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runUpdateAll } from '../src/core/batch';
import { SimulatedCrash } from '../src/core/errors';
import type { AddonManager } from '../src/core/manager';
import { addonEntries, addUnmanaged, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { createHarness } from './ipc-harness';

const F = 9;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));
/** 以 root 运行时 chmod 不能阻止删除，这些用例没有意义 */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skip = asRoot ? '以 root 运行时权限不能阻止删除' : false;

function paths(root: string) {
  const meta = path.join(root, 'Interface', '.beelite');
  return { meta, trash: path.join(meta, 'trash'), staging: path.join(meta, 'staging'), addons: path.join(root, 'Interface', 'AddOns') };
}

async function manifestOf(root: string): Promise<{ projects: Record<string, { fileId: string }>; recovery: { id: string; kind: string; folders: string[] }[]; purgeQueue: string[] }> {
  return JSON.parse(await readFile(path.join(paths(root).meta, 'manifest.json'), 'utf8'));
}

/** 让回收目录中的一个子目录无法删除（目录本身只读，里面的文件删不掉）；返回恢复权限的函数 */
async function lockDown(dir: string): Promise<() => Promise<void>> {
  await chmod(dir, 0o500);
  return () => chmod(dir, 0o755);
}

async function state(m: AddonManager, root: string) {
  return m.localState({ flavorId: F, root, addonsPath: null }, F);
}

/** 目录中托管一个插件（100），另有两个移入回收站的未托管目录 Old1 / Old2 */
async function setup() {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = makeManager(src);
  src.set('100', F, { name: 'Keep', fileId: '1', zip: zipOf('Keep', 'v1') });
  await m.install(root, F, '100');
  for (const f of ['Old1', 'Old2']) {
    await addUnmanaged(root, f);
    await m.uninstallFolder(root, f);
  }
  const man = await manifestOf(root);
  const idOf = (f: string) => man.recovery.find((e) => e.folders.includes(f))!.id;
  return { base, root, src, m, id1: idOf('Old1'), id2: idOf('Old2') };
}

test('永久删除遇到无权限：不说已永久删除；条目已注销、待删除持久保留；插件列表正常、无关写操作不受阻；修复权限后刷新清理完成', { skip }, async () => {
  const { base, root, src, m, id1 } = await setup();
  const { trash } = paths(root);
  const restore = await lockDown(path.join(trash, id1, 'Old1'));
  try {
    const r = await m.purge(root, id1);
    assert.equal(r.ok, true, '条目已注销（已提交）');
    assert.equal(r.diskRemoved, false);
    assert.doesNotMatch(r.message, /已永久删除/);
    assert.match(r.message, /已从回收站移除并登记待清理，磁盘删除尚未完成/);
    assert.doesNotMatch(r.message, /可恢复|未做任何改动/);
    assert.equal(r.warnings?.length, 1);
    assert.match(r.warnings![0], /未能从磁盘删除完.*没有写入权限/);
    assert.match(r.warnings![0], /自动重试/);
    let man = await manifestOf(root);
    assert.equal(man.recovery.some((e) => e.id === id1), false, '不再是可恢复条目');
    assert.deepEqual(man.purgeQueue, [id1]);
    assert.equal(await exists(path.join(trash, id1, 'Old1', 'Old1.toc')), true, '磁盘上的内容确实还在');

    // 刷新：插件列表照常，待清理常驻可见
    const st = await state(m, root);
    assert.equal(st.error, null);
    assert.equal(st.dir?.status, 'ok');
    assert.deepEqual(st.managed.map((p) => p.modId), ['100']);
    assert.equal(st.recovery.length, 1, '另一个回收站条目仍可恢复');
    assert.equal(st.cleanup?.checked, true, '本次实际执行了清理');
    assert.equal(st.cleanup?.pending, 1);
    assert.equal(st.cleanup?.unsaved, 0);
    assert.match(st.cleanup!.problems.join('\n'), new RegExp(`${id1}.*没有写入权限`));

    // 同一目录的无关更新与安装照常完成，结果不重复已有的待清理问题
    src.set('100', F, { name: 'Keep', fileId: '2', zip: zipOf('Keep', 'v2') });
    const up = await m.install(root, F, '100');
    assert.equal(up.ok, true);
    assert.match(up.message, /已更新到/);
    assert.equal((up.warnings ?? []).some((w) => /清理|删除/.test(w)), false, up.warnings?.join('\n'));
    src.set('200', F, { name: 'Other', fileId: '1', zip: zipOf('Other', 'v1') });
    assert.equal((await m.install(root, F, '200')).ok, true);
    man = await manifestOf(root);
    assert.equal(man.projects['100'].fileId, '2');
    assert.ok(man.purgeQueue.includes(id1), '仍未删除的编号没有被后续事务丢掉');

    await restore();
    const after = await state(m, root);
    assert.equal(after.cleanup, null);
    assert.equal(await exists(path.join(trash, id1)), false);
    assert.deepEqual((await manifestOf(root)).purgeQueue, []);
  } finally {
    await restore().catch(() => undefined);
    await cleanup(base);
  }
});

test('待删除队列逐项处理：一项失败不影响其他项，成功项删除并移出已保存队列，失败项保留；不删除未登记的回收目录', { skip }, async () => {
  const { base, root, m, id1, id2 } = await setup();
  const { trash } = paths(root);
  // 未登记、非空的外来回收目录：任何清理都不能删除
  const foreign = path.join(trash, 'foreign-dir');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'keep.txt'), 'x');
  const restore = await lockDown(path.join(trash, id1, 'Old1'));
  try {
    assert.equal((await m.purge(root, id1)).diskRemoved, false);
    // 队列中第一项仍失败；第二项本次登记并成功删除
    const r = await m.purge(root, id2);
    assert.equal(r.diskRemoved, true);
    assert.equal(r.message, '已永久删除：Old2');
    assert.equal(r.warnings, undefined, '其他条目的失败不写入这一次的结果');
    assert.deepEqual((await manifestOf(root)).purgeQueue, [id1]);
    assert.equal(await exists(path.join(trash, id2)), false);
    assert.equal(await exists(path.join(trash, id1, 'Old1', 'Old1.toc')), true);
    assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'x');
    const st = await state(m, root);
    assert.equal(st.cleanup?.pending, 1);
    assert.equal(st.recovery.length, 0);
  } finally {
    await restore();
    await cleanup(base);
  }
});

test('删除完成但队列保存失败（真实权限）：如实区分“已删除、状态待保存”，磁盘上的队列保持原样，之后确认移除', { skip }, async () => {
  const { base, root, m, id1 } = await setup();
  const { meta, trash } = paths(root);
  const restoreEntry = await lockDown(path.join(trash, id1, 'Old1'));
  let restoreMeta: (() => Promise<void>) | null = null;
  try {
    await m.purge(root, id1);
    await restoreEntry();
    // 数据目录只读：回收目录可以删除，但清单无法写回
    restoreMeta = await lockDown(meta);
    const st = await state(m, root);
    assert.equal(st.error, null);
    assert.deepEqual(st.managed.map((p) => p.modId), ['100']);
    assert.equal(st.cleanup?.pending, 0, '磁盘上已经没有待删除的内容');
    assert.equal(st.cleanup?.unsaved, 1);
    assert.match(st.cleanup!.problems.join('\n'), /1 项已从磁盘删除，但待删除记录未能保存/);
    assert.equal(await exists(path.join(trash, id1)), false);
    assert.deepEqual((await manifestOf(root)).purgeQueue, [id1], '队列未能缩减时保留原样');
    await restoreMeta();
    restoreMeta = null;
    assert.equal((await state(m, root)).cleanup, null);
    assert.deepEqual((await manifestOf(root)).purgeQueue, []);
  } finally {
    await restoreEntry().catch(() => undefined);
    await restoreMeta?.();
    await cleanup(base);
  }
});

test('永久删除：删除后队列保存失败（注入）仍是已永久删除并说明状态待保存；保存前崩溃时重启后完成清理且不恢复条目', async () => {
  {
    const { base, root, src, id1 } = await setup();
    try {
      const m = makeManager(src, { hook: (s) => { if (s === 'purge-queue-save') throw new Error('注入：队列保存失败'); } });
      const r = await m.purge(root, id1);
      assert.equal(r.diskRemoved, true);
      assert.equal(r.message, '已永久删除：Old1');
      assert.deepEqual(r.warnings, ['这一条目已从磁盘删除，但清理状态尚未保存（注入：队列保存失败），刷新后会重新确认']);
      assert.deepEqual((await manifestOf(root)).purgeQueue, [id1]);
      const st = await state(makeManager(src), root);
      assert.equal(st.cleanup, null);
      assert.deepEqual((await manifestOf(root)).purgeQueue, []);
    } finally {
      await cleanup(base);
    }
  }
  {
    const { base, root, src, id1 } = await setup();
    try {
      const crashing = makeManager(src, { hook: (s) => { if (s === 'purge-queue-save') throw new SimulatedCrash(s); } });
      await assert.rejects(crashing.purge(root, id1), SimulatedCrash);
      const man = await manifestOf(root);
      assert.deepEqual(man.purgeQueue, [id1], '已删除的编号仍在磁盘队列中');
      assert.equal(man.recovery.some((e) => e.id === id1), false);
      const fresh = makeManager(src);
      assert.equal((await fresh.recover(root)).status, 'ok');
      assert.deepEqual((await manifestOf(root)).purgeQueue, []);
      assert.equal((await state(fresh, root)).recovery.some((e) => e.id === id1), false);
    } finally {
      await cleanup(base);
    }
  }
});

test('更新时旧的更新前备份无法删除：新版本、清单与回执正确，不回滚，结果带清理提示；之后读取正常', { skip }, async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = makeManager(src);
  const { trash, addons } = paths(root);
  let restore: (() => Promise<void>) | null = null;
  try {
    src.set('100', F, { name: 'Rot', fileId: '1', zip: zipOf('Rot', 'v1') });
    await m.install(root, F, '100');
    src.set('100', F, { name: 'Rot', fileId: '2', zip: zipOf('Rot', 'v2') });
    await m.install(root, F, '100');
    const oldBackup = (await manifestOf(root)).recovery.find((e) => e.kind === 'update-backup')!.id;
    restore = await lockDown(path.join(trash, oldBackup, 'Rot'));
    src.set('100', F, { name: 'Rot', fileId: '3', zip: zipOf('Rot', 'v3') });
    const r = await m.install(root, F, '100');
    assert.equal(r.ok, true);
    assert.match(r.message, /已更新到/);
    assert.equal(r.installed?.fileId, '3', '提交回执保留');
    assert.equal(r.previous?.fileId, '2');
    assert.ok(r.warnings?.some((w) => /^旧的更新前备份未能从磁盘删除完（没有写入权限/.test(w)), r.warnings?.join('\n'));
    assert.match(await readFile(path.join(addons, 'Rot', 'Rot.toc'), 'utf8'), /v3/);
    const man = await manifestOf(root);
    assert.equal(man.projects['100'].fileId, '3');
    assert.deepEqual(man.purgeQueue, [oldBackup]);
    const backups = man.recovery.filter((e) => e.kind === 'update-backup');
    assert.equal(backups.length, 1);
    assert.notEqual(backups[0].id, oldBackup);
    const st = await state(m, root);
    assert.deepEqual(st.managed.map((p) => [p.modId, p.fileId]), [['100', '3']]);
    assert.equal(st.cleanup?.pending, 1);
  } finally {
    await restore?.();
    await cleanup(base);
  }
});

test('全部更新：某项旧备份清理失败时该项计为已更新，后续项照常处理，提示只出现在这一项', { skip }, async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const m = makeManager(src);
  const { trash } = paths(root);
  let restore: (() => Promise<void>) | null = null;
  try {
    for (const [id, name] of [['1', 'A1'], ['2', 'B2']]) {
      src.set(id, F, { name, fileId: '1', zip: zipOf(name, 'v1') });
      await m.install(root, F, id);
      src.set(id, F, { name, fileId: '2', zip: zipOf(name, 'v2') });
      await m.install(root, F, id);
      src.set(id, F, { name, fileId: '3', zip: zipOf(name, 'v3') });
    }
    const a1Backup = (await manifestOf(root)).recovery.find((e) => e.folders.includes('A1'))!.id;
    restore = await lockDown(path.join(trash, a1Backup, 'A1'));
    const r = await runUpdateAll({ manager: m, root, flavorId: F, isStillBound: async () => true, installOne: (p, r0) => m.install(r0, p.flavorId, p.modId) });
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /已更新 2 个插件/);
    const cleanupNotes = (r.warnings ?? []).filter((w) => w.includes('旧的更新前备份'));
    assert.equal(cleanupNotes.length, 1, cleanupNotes.join('\n'));
    assert.match(cleanupNotes[0], /^A1：/);
    const man = await manifestOf(root);
    assert.deepEqual([man.projects['1'].fileId, man.projects['2'].fileId], ['3', '3']);
    assert.deepEqual(man.purgeQueue, [a1Backup]);
  } finally {
    await restore?.();
    await cleanup(base);
  }
});

test('下载暂存无法清理：安装结果如实提示，之后的本地状态显示待清理；修复后刷新清空暂存', { skip }, async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const { staging } = paths(root);
  let locked: string | null = null;
  try {
    // 解压之后在本次暂存目录中放一个删不掉的子目录（真实权限）
    const m = makeManager(src, {
      hook: async (s) => {
        if (s !== 'extracted') return;
        const [tx] = await readdir(staging);
        locked = path.join(staging, tx, 'x', 'stuck');
        await mkdir(locked);
        await writeFile(path.join(locked, 'f.txt'), 'x');
        await chmod(locked, 0o500);
      },
    });
    src.set('100', F, { name: 'S', fileId: '1', zip: zipOf('S', 'v1') });
    const r = await m.install(root, F, '100');
    assert.equal(r.ok, true);
    assert.equal(r.installed?.fileId, '1');
    assert.ok(r.warnings?.some((w) => /^本次下载的暂存文件未能清理（没有写入权限/.test(w)), r.warnings?.join('\n'));
    const plain = makeManager(src);
    const st = await state(plain, root);
    assert.deepEqual(st.managed.map((p) => p.modId), ['100']);
    assert.equal(st.cleanup?.pending, 0);
    assert.match(st.cleanup!.problems.join('\n'), /下载暂存 .* 未能清理：没有写入权限/);
    await chmod(locked!, 0o755);
    locked = null;
    assert.equal((await state(plain, root)).cleanup, null);
    assert.deepEqual(await readdir(staging), []);

    // 暂存目录本身无法读取：不当作已清空
    await chmod(staging, 0o300);
    locked = staging;
    const st2 = await state(plain, root);
    assert.match(st2.cleanup!.problems.join('\n'), /无法读取下载暂存目录/);
    assert.deepEqual(st2.managed.map((p) => p.modId), ['100']);
  } finally {
    if (locked) await chmod(locked, 0o755);
    await cleanup(base);
  }
});

test('提交后事务日志未能移除：回执保留并提示收尾；日志仍无法移除时后续写入不开始；之后自动收尾', { skip }, async () => {
  const base = await tmpDir();
  const root = await makeGameRoot(base);
  const src = new FakeSource();
  const { meta, trash } = paths(root);
  let restore: (() => Promise<void>) | null = null;
  try {
    src.set('100', F, { name: 'J', fileId: '1', zip: zipOf('J', 'v1') });
    const failing = makeManager(src, { hook: (s) => { if (s === 'manifest-committed') throw new Error('注入：日志移除前失败'); } });
    const r = await failing.install(root, F, '100');
    assert.equal(r.ok, true);
    assert.equal(r.installed?.fileId, '1');
    assert.ok(r.warnings?.some((w) => /^操作已提交，但事务日志未能移除（注入：日志移除前失败）/.test(w)), r.warnings?.join('\n'));
    assert.equal(await exists(path.join(meta, 'journal.json')), true);

    // 已提交的日志无法移除时不开始新的事务，也不覆盖它
    restore = await lockDown(meta);
    src.set('200', F, { name: 'K', fileId: '1', zip: zipOf('K', 'v1') });
    const m = makeManager(src);
    await assert.rejects(m.install(root, F, '200'), /EACCES.*journal\.json/);
    assert.equal(await exists(path.join(meta, 'journal.json')), true);
    await restore();
    restore = null;
    assert.equal((await m.install(root, F, '200')).ok, true);
    assert.equal(await exists(path.join(meta, 'journal.json')), false);

    // 永久删除在日志收尾失败时没有执行删除：如实说明待清理，之后刷新完成
    await addUnmanaged(root, 'Gone');
    await m.uninstallFolder(root, 'Gone');
    const id = (await manifestOf(root)).recovery[0].id;
    const p = await failing.purge(root, id);
    assert.equal(p.diskRemoved, false);
    assert.match(p.message, /磁盘删除尚未完成/);
    assert.ok(p.warnings?.some((w) => w.startsWith('操作已提交，但事务日志未能移除')));
    assert.equal(await exists(path.join(trash, id)), true);
    assert.equal((await state(m, root)).cleanup, null);
    assert.equal(await exists(path.join(trash, id)), false);
  } finally {
    await restore?.();
    await cleanup(base);
  }
});

test('真正的事务保护不被清理逻辑吞掉：损坏的事务日志与无法读取的清单仍暂停写入，且不运行清理', async () => {
  const { base, root, src, m, id1 } = await setup();
  const { meta, trash } = paths(root);
  try {
    // 登记一个待删除项但不清理：之后若运行了清理，它会被删除
    const man = await manifestOf(root);
    man.recovery = man.recovery.filter((e) => e.id !== id1);
    man.purgeQueue = [id1];
    await writeFile(path.join(meta, 'manifest.json'), JSON.stringify(man));
    await writeFile(path.join(meta, 'journal.json'), '{ 损坏');
    const st = await state(m, root);
    assert.equal(st.dir?.status, 'blocked');
    assert.equal(st.cleanup?.pending, 1, '没有运行清理，只按清单计数');
    assert.equal(st.cleanup?.checked, false, '未检查磁盘，不能据此说内容还在');
    assert.deepEqual(st.cleanup?.problems, []);
    assert.equal(await exists(path.join(trash, id1)), true);
    src.set('200', F, { name: 'K', fileId: '1', zip: zipOf('K', 'v1') });
    await assert.rejects(m.install(root, F, '200'), (err: unknown) => (err as { code?: string }).code === 'blocked');
    assert.equal(await exists(path.join(trash, id1)), true);
  } finally {
    await cleanup(base);
  }
});

test('IPC：永久删除未完成时结果、操作记录如实说明并保留提示；卸载、恢复的提示也写入操作记录', { skip }, async () => {
  const base = await tmpDir();
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  const m = makeManager(src);
  let restore: (() => Promise<void>) | null = null;
  try {
    await addUnmanaged(A, 'Old');
    await m.uninstallFolder(A, 'Old');
    const id = (await manifestOf(A)).recovery[0].id;
    restore = await lockDown(path.join(paths(A).trash, id, 'Old'));
    const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
    await h.settings.bind(F, A);
    const r = await h.api.purge(id, F, A);
    assert.equal(r.ok, true);
    assert.match(r.message, /磁盘删除尚未完成/);
    assert.equal('diskRemoved' in r, false, '界面只拿到公开结果');
    assert.equal(r.warnings?.length, 1);
    const st = await h.api.localState(F);
    assert.equal(st.cleanup?.pending, 1);
    const entry = (await h.api.historyList(F, A)).entries.find((e) => e.kind === 'purge')!;
    assert.equal(entry.status, 'succeeded');
    assert.doesNotMatch(entry.message, /已永久删除/);
    assert.match(entry.message, /磁盘删除尚未完成/);
    assert.deepEqual(entry.warnings, r.warnings);

    // 卸载在提交后日志未能移除：提示进入操作记录（tracked 回调保留 warnings）
    src.set('100', F, { name: 'U', fileId: '1', zip: zipOf('U', 'v1') });
    await m.install(A, F, '100');
    // 另一个主进程实例（独立的设置与操作记录目录），它的插件管理在提交后、移除事务日志前失败
    await mkdir(path.join(base, 'h2'));
    const failing = createHarness({ settingsFile: path.join(base, 'h2', 'settings.json'), source: src });
    await failing.settings.bind(F, A);
    (failing.service.manager as unknown as { opts: { hook?: (s: string) => void } }).opts.hook = (s) => {
      if (s === 'manifest-committed') throw new Error('注入：日志移除前失败');
    };
    const u = await failing.api.uninstallProject('100', F, A);
    assert.equal(u.ok, true);
    assert.ok(u.warnings?.some((w) => w.startsWith('操作已提交，但事务日志未能移除')));
    const ue = (await failing.api.historyList(F, A)).entries.find((e) => e.kind === 'uninstall')!;
    assert.equal(ue.status, 'succeeded');
    assert.deepEqual(ue.warnings, u.warnings);
    const rid = (await manifestOf(A)).recovery.find((e) => e.folders.includes('U'))!.id;
    const rs = await failing.api.restore(rid, F, A);
    assert.ok(rs.warnings?.some((w) => w.startsWith('操作已提交，但事务日志未能移除')));
    const re = (await failing.api.historyList(F, A)).entries.find((e) => e.kind === 'restore')!;
    assert.deepEqual(re.warnings, rs.warnings);
  } finally {
    await restore?.();
    await cleanup(base);
  }
});
