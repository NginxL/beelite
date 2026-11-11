// 操作记录与暂停更新（0.2.0）：真实 preload → 真实 AppService（假 electron）→ HistoryStore / PolicyStore / AddonManager → 临时目录。
// 记录与策略文件都在测试的临时目录中（与设置文件同目录），不使用真实的 userData。插件下载由 FakeSource 提供，不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { HistoryStore } from '../src/core/history';
import { writeFileAtomic } from '../src/core/layout';
import type { AddonManager, ManagerOptions } from '../src/core/manager';
import type { LatestFile } from '../src/core/provider';
import { PolicyStore } from '../src/core/policy';
import type { AddonWatchSnapshot, HistoryEntry, TaskEvent } from '../src/shared/types';
import { addonEntries, addUnmanaged, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { createHarness, ipcCalls, readManifestJson, recordOf, snapshot } from './ipc-harness';

const F = 9;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可挂起的下载：hold 为 true 时每次下载都等待 release */
function holdingDownload(src: FakeSource) {
  const ctl = {
    hold: false,
    started: [] as string[],
    waiting: [] as (() => void)[],
    release: () => ctl.waiting.splice(0).forEach((r) => r()),
    download: (async (url, dest) => {
      ctl.started.push(url);
      if (ctl.hold) await new Promise<void>((r) => ctl.waiting.push(r));
      return src.download(url, dest);
    }) as NonNullable<ManagerOptions['download']>,
  };
  return ctl;
}

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error(`等待超时：${what}`);
}

/** 目录 A：100（M / ModM）与 200（N / ModN）装的是文件 1，远端为文件 2 */
async function setup(o: { history?: (dir: string) => HistoryStore; policy?: (dir: string) => PolicyStore; withB?: boolean; source?: FakeSource } = {}) {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = o.withB ? await makeGameRoot(path.join(base, 'B')) : null;
  const src = o.source ?? new FakeSource();
  const m = makeManager(src);
  src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
  src.set('200', F, { name: 'N', fileId: '1', zip: zipOf('ModN', 'v1') });
  for (const r of B ? [A, B] : [A]) {
    await m.install(r, F, '100');
    await m.install(r, F, '200');
  }
  src.set('100', F, { name: 'M', fileId: '2', zip: zipOf('ModM', 'v2') });
  src.set('200', F, { name: 'N', fileId: '2', zip: zipOf('ModN', 'v2') });
  const ctl = holdingDownload(src);
  const h = createHarness({
    settingsFile: path.join(base, 'settings.json'),
    source: src,
    download: ctl.download,
    history: o.history?.(base),
    policy: o.policy?.(base),
  });
  await h.policy.reload();
  await h.settings.bind(F, A);
  src.calls.length = 0;
  const hist =async (root = A): Promise<HistoryEntry[]> => (await h.api.historyList(F, root)).entries;
  const entryOf = (s: AddonWatchSnapshot, root = A) => s.entries.find((e) => e.flavorId === F && e.root === root);
  return { base, A, B, src, ctl, h, hist, entryOf };
}

test('操作记录：安装、更新、已是最新、重装、卸载、恢复、永久删除、移入回收站各记一条，版本来自提交回执', async () => {
  const { base, A, src, h, hist } = await setup();
  try {
    src.set('300', F, { name: 'P', fileId: '1', zip: zipOf('ModP', 'v1') });
    await h.api.install('300', F, A);
    let e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.name, e.modId, e.previous, e.installed], ['install', 'succeeded', 'P', '300', null, { fileId: '1', version: 'v1' }]);

    await h.api.update('100', F, false, await recordOf(A, '100'), A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.expectedFileId], ['update', 'succeeded', '1']);
    assert.deepEqual([e.previous, e.installed], [{ fileId: '1', version: 'v1' }, { fileId: '2', version: 'v2' }], '旧版本来自目录锁内的记录');

    const r = await h.api.update('100', F, false, await recordOf(A, '100'), A);
    assert.equal(r.ok, true);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.installed], ['update', 'unchanged', null], '已是最新：ok 但没有提交，不记为成功');

    await h.api.update('100', F, true, await recordOf(A, '100'), A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.previous, e.installed], ['reinstall', 'succeeded', { fileId: '2', version: 'v2' }, { fileId: '2', version: 'v2' }]);

    await h.api.uninstallProject('100', F, A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.name, e.previous], ['uninstall', 'succeeded', 'M', { fileId: '2', version: 'v2' }]);

    const manifest = await readManifestJson(A);
    const un = manifest.recovery.find((x) => x.kind === 'uninstall' && x.folders.includes('ModM'))!;
    await h.api.restore(un.id, F, A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.target, e.modId, e.installed], ['restore', 'succeeded', un.id, '100', { fileId: '2', version: 'v2' }]);

    const backup = (await readManifestJson(A)).recovery.find((x) => x.kind === 'update-backup')!;
    await h.api.purge(backup.id, F, A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.target], ['purge', 'succeeded', backup.id]);
    assert.match(e.name, /更新前备份/);

    await addUnmanaged(A, 'Loose');
    await h.api.uninstallFolder('Loose', F, A);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.target, e.modId], ['uninstall-folder', 'succeeded', 'Loose', null]);

    const all = await hist();
    assert.equal(all.length, 8, '每个操作只记一条');
    assert.ok(all.every((x) => x.status !== 'accepted'));
    // 参数不合法、目标已换绑等受理之前的拒绝不进入记录
    await assert.rejects(h.api.uninstallProject('abc', F, A), /插件编号无效/);
    await assert.rejects(h.api.uninstallProject('200', F, '/x/other'), /绑定已变更/);
    assert.equal((await hist()).length, 8);
    // 记录在临时目录，不在游戏目录
    assert.ok(JSON.parse(await readFile(path.join(base, 'operation-history.json'), 'utf8')).entries.length >= 8);
  } finally {
    await cleanup(base);
  }
});

test('操作记录：失败、前提已变化、确认取消、目录保护分别记为失败 / 未处理 / 已取消 / 结果未确认', async () => {
  const { base, A, src, h, hist } = await setup();
  try {
    // 网络失败（远端查询报错）
    const saved = src.mods.get('200')!;
    src.mods.delete('200');
    await assert.rejects(h.api.update('200', F, false, await recordOf(A, '200'), A), /查询不到/);
    let e = (await hist())[0];
    assert.deepEqual([e.kind, e.status, e.installed, e.expectedFileId], ['update', 'failed', null, '1']);
    src.mods.set('200', saved);

    // 受理后记录已变化：没有做任何改动
    await assert.rejects(h.api.update('200', F, false, { fileId: '9', installedAt: 0 }, A), /未做任何改动/);
    e = (await hist())[0];
    assert.equal(e.status, 'not-processed');

    // 接管确认时用户取消
    await addUnmanaged(A, 'ModQ');
    src.set('400', F, { name: 'Q', fileId: '1', zip: zipOf('ModQ', 'q1') });
    h.stub.messageBoxResponse = 1;
    const r = await h.api.install('400', F, A);
    assert.equal(r.ok, false);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status], ['install', 'cancelled']);
    h.stub.messageBoxResponse = 0;

    // 目录保护：残留的事务日志无法判定，只记为结果未确认，不说已回滚
    const journal = path.join(A, 'Interface', '.beelite', 'journal.json');
    await writeFile(journal, 'garbage');
    await assert.rejects(h.api.uninstallProject('200', F, A), /暂停写入/);
    e = (await hist())[0];
    assert.deepEqual([e.kind, e.status], ['uninstall', 'unconfirmed']);
    assert.match(e.message, /结果未确认/);
    assert.doesNotMatch(e.message, /已回滚/);
    await rm(journal);
  } finally {
    await cleanup(base);
  }
});

test('暂停更新：保留当前版本；检查仍显示真实新版本但不计数；单项更新与 force 重装被主进程拒绝；全部更新跳过并说明', async () => {
  const { base, A, src, h, hist, entryOf } = await setup();
  try {
    await h.api.checkUpdates(F, A);
    const r = await h.api.setPaused('100', F, true, A);
    assert.equal(r.ok, true);
    assert.match(r.message, /保留当前版本/);
    let snap = await h.api.watchState();
    let e = entryOf(snap)!;
    assert.deepEqual(e.paused, ['100']);
    const i100 = e.items.find((i) => i.modId === '100')!;
    assert.deepEqual([i100.hasUpdate, i100.latestFileId, i100.paused], [true, '2', true], '真实的新版本仍在');
    assert.equal(e.pending, 1, '待更新数量不含暂停项');
    assert.equal(snap.policyError, null);

    const rec = await recordOf(A, '100');
    const before = await snapshot(path.join(A, 'Interface'));
    await assert.rejects(h.api.update('100', F, false, rec, A), /已暂停更新/);
    await assert.rejects(h.api.update('100', F, true, rec, A), /已暂停更新/);
    assert.deepEqual(await snapshot(path.join(A, 'Interface')), before, '没有任何改动');
    assert.ok(!src.calls.some((c) => c.startsWith('detail:100')), '没有进入安装流程');

    const all = await h.api.updateAll(F, A);
    assert.equal(all.ok, true);
    assert.match(all.message, /已更新 1 个插件/);
    assert.match(all.message, /已暂停更新未处理 1 个/);
    assert.ok(all.warnings?.some((w) => /M：已暂停更新，保留当前版本，未处理/.test(w)));
    let m = await readManifestJson(A);
    assert.deepEqual([m.projects['100'].fileId, m.projects['200'].fileId], ['1', '2']);

    // 有新版本的全部暂停：不能说“所有插件都已是最新”
    src.set('200', F, { name: 'N', fileId: '3', zip: zipOf('ModN', 'v3') });
    await h.api.setPaused('200', F, true, A);
    const none = await h.api.updateAll(F, A);
    assert.match(none.message, /没有需要更新的插件：2 个已暂停更新的插件有新版本/);
    assert.doesNotMatch(none.message, /都已是最新/);

    // 恢复后立即可以更新（不必等下一次检查）
    await h.api.setPaused('200', F, false, A);
    snap = await h.api.watchState();
    e = entryOf(snap)!;
    assert.deepEqual(e.paused, ['100']);
    assert.equal(e.pending, 1);
    await h.api.update('200', F, false, await recordOf(A, '200'), A);
    m = await readManifestJson(A);
    assert.equal(m.projects['200'].fileId, '3');
    const kinds = (await hist()).map((x) => `${x.kind}:${x.status}`);
    assert.ok(kinds.includes('pause:succeeded') && kinds.includes('resume:succeeded'));
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('暂停更新：卸载允许且不清除暂停；重新安装后仍保持暂停，直到用户恢复', async () => {
  const { base, A, src, h, entryOf } = await setup();
  try {
    await h.api.setPaused('100', F, true, A);
    await h.api.uninstallProject('100', F, A);
    assert.equal(await h.policy.isPaused(F, A, '100'), true, '卸载不清除暂停');
    await assert.rejects(h.api.setPaused('100', F, true, A), /不在这个目录的艾泽魔方管理列表中/);
    await h.api.install('100', F, A);
    src.set('100', F, { name: 'M', fileId: '3', zip: zipOf('ModM', 'v3') });
    await h.api.checkUpdates(F, A);
    const e = entryOf(await h.api.watchState())!;
    assert.ok(e.paused.includes('100'));
    assert.equal(e.items.find((i) => i.modId === '100')?.paused, true);
    await assert.rejects(h.api.update('100', F, false, await recordOf(A, '100'), A), /已暂停更新/);
    await h.api.setPaused('100', F, false, A);
    await h.api.update('100', F, false, await recordOf(A, '100'), A);
    assert.equal((await readManifestJson(A)).projects['100'].fileId, '3');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('暂停更新：按 版本 + 目录 + 插件 隔离；换绑到 B 不继承，切回 A 仍保留', async () => {
  const { base, A, B, h } = await setup({ withB: true });
  try {
    await h.api.setPaused('100', F, true, A);
    await h.settings.bind(F, B!);
    await h.api.update('100', F, false, await recordOf(B!, '100'), B!);
    assert.equal((await readManifestJson(B!)).projects['100'].fileId, '2', 'B 中同一插件不受 A 的暂停影响');
    // 旧界面仍按 A 发出的请求：绑定已变更，主进程拒绝，不转向 B
    await assert.rejects(h.api.setPaused('200', F, true, A), /绑定已变更/);
    await h.settings.bind(F, A);
    await assert.rejects(h.api.update('100', F, false, await recordOf(A, '100'), A), /已暂停更新/);
    assert.equal(await h.policy.isPaused(F, B!, '100'), false);
    assert.equal(await h.policy.isPaused(6, A, '100'), false);
  } finally {
    await cleanup(base);
  }
});

test('暂停更新：策略文件损坏时所有更新入口 fail closed，快照不显示为可更新；修复后重新读取恢复', async () => {
  const { base, A, h, entryOf } = await setup();
  try {
    await h.api.checkUpdates(F, A);
    const file = path.join(base, 'addon-policy.json');
    await writeFile(file, '{"schema":1,"paused":[');
    const before = await snapshot(path.join(A, 'Interface'));
    await assert.rejects(h.api.update('100', F, false, await recordOf(A, '100'), A), /无法读取插件更新策略文件/);
    await assert.rejects(h.api.update('100', F, true, await recordOf(A, '100'), A), /无法读取插件更新策略文件/);
    await assert.rejects(h.api.updateAll(F, A), /无法读取插件更新策略文件/);
    await assert.rejects(h.api.setPaused('100', F, true, A), /无法读取插件更新策略文件/);
    assert.deepEqual(await snapshot(path.join(A, 'Interface')), before);
    assert.equal(await readFile(file, 'utf8'), '{"schema":1,"paused":[', '策略文件不被覆盖');
    const snap = await h.api.reloadPolicy();
    assert.match(snap.policyError ?? '', /无法读取插件更新策略文件/);
    const e = entryOf(snap)!;
    assert.equal(e.pending, 0, '策略未知：不计为可更新');
    assert.ok(e.items.some((i) => i.hasUpdate), '真实的新版本仍在，不显示为已是最新');
    // 卸载不依赖策略
    await h.api.uninstallProject('200', F, A);
    // 写通道结束后，主进程按新清单只读重校验（不等待 IPC 回复）：以它发布到窗口的快照为同步点，确认结果收敛（200 已不在结果中）
    const revalidated = (s: { channel: string; payload: unknown }) => {
      const e = s.channel === 'addon:watch' ? entryOf(s.payload as AddonWatchSnapshot) : undefined;
      return !!e && e.items.some((i) => i.modId === '100') && !e.items.some((i) => i.modId === '200');
    };
    await until(() => h.stub.sent.some(revalidated), '卸载后的重校验已发布');

    await writeFile(file, JSON.stringify({ schema: 1, paused: [] }));
    const ok = await h.api.reloadPolicy();
    assert.equal(ok.policyError, null);
    assert.equal(entryOf(ok)!.pending, 1);
    await h.api.update('100', F, false, await recordOf(A, '100'), A);
    assert.equal((await readManifestJson(A)).projects['100'].fileId, '2');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('暂停更新：与同一插件的更新互斥（两种先后顺序），全部更新期间不受理；写入在闸门内', async () => {
  const w = { hold: false, release: null as (() => void) | null };
  const { base, A, ctl, h } = await setup({
    policy: (dir) => new PolicyStore(path.join(dir, 'addon-policy.json'), {
      write: async (f, t) => {
        if (w.hold) await new Promise<void>((r) => (w.release = r));
        return writeFileAtomic(f, t);
      },
    }),
  });
  try {
    // 先更新：下载挂起期间暂停被拒绝
    ctl.hold = true;
    const upd = h.api.update('100', F, false, await recordOf(A, '100'), A);
    await until(() => ctl.started.length === 1, '开始下载');
    await assert.rejects(h.api.setPaused('100', F, true, A), /正在处理/);
    ctl.hold = false;
    ctl.release();
    await upd;
    assert.equal(await h.policy.isPaused(F, A, '100'), false);

    // 先暂停：策略写入挂起期间，更新、重装、全部更新都被拒绝；闸门计入（退出与客户端更新会等待）
    w.hold = true;
    const pause = h.api.setPaused('200', F, true, A);
    await until(() => w.release !== null, '策略写入开始');
    assert.equal(h.gate.activeCount, 1);
    await assert.rejects(h.api.update('200', F, false, await recordOf(A, '200'), A), /正在处理/);
    await assert.rejects(h.api.update('200', F, true, await recordOf(A, '200'), A), /正在处理/);
    await assert.rejects(h.api.updateAll(F, A), /有插件正在处理/);
    w.hold = false;
    w.release?.();
    await pause;
    await assert.rejects(h.api.update('200', F, false, await recordOf(A, '200'), A), /已暂停更新/);
    assert.equal(h.gate.activeCount, 0);

    // 全部更新进行中：暂停与恢复都不受理
    await h.api.setPaused('200', F, false, A);
    const m = await readManifestJson(A);
    assert.equal(m.projects['200'].fileId, '1');
    ctl.hold = true;
    const n0 = ctl.started.length;
    const batch = h.api.updateAll(F, A);
    await until(() => ctl.started.length === n0 + 1, '批次开始下载');
    await assert.rejects(h.api.setPaused('200', F, true, A), /正在全部更新/);
    await assert.rejects(h.api.setPaused('100', F, true, A), /正在全部更新/);
    ctl.hold = false;
    ctl.release();
    await batch;
    assert.equal((await readManifestJson(A)).projects['200'].fileId, '2');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新：中途换绑停止，未开始的项目记为未处理并属于原目录', async () => {
  const { base, A, B, ctl, h, hist } = await setup({ withB: true });
  try {
    ctl.hold = true;
    const batch = h.api.updateAll(F, A);
    await until(() => ctl.started.length === 1, '第一项开始下载');
    await h.settings.bind(F, B!);
    ctl.hold = false;
    ctl.release();
    const r = await batch;
    assert.match(r.message, /剩余 1 个未处理/);
    await h.settings.bind(F, A);
    const entries = await hist(A);
    const batchEntries = entries.filter((e) => e.batchId);
    assert.deepEqual(batchEntries.map((e) => e.status).sort(), ['not-processed', 'succeeded']);
    assert.ok(batchEntries.every((e) => e.root === A && e.batchId === batchEntries[0].batchId));
    await h.settings.bind(F, B!);
    assert.equal((await hist(B!)).length, 0, 'B 没有这次批次的记录');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('操作记录保存失败：插件事务照常提交、结果不变，单独提示并可重试；记录文件损坏时不覆盖', async () => {
  let fail = true;
  const { base, A, src, h, hist } = await setup({
    history: (dir) => new HistoryStore(path.join(dir, 'operation-history.json'), {
      write: async (f, t) => (fail ? Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) : writeFileAtomic(f, t)),
    }),
  });
  try {
    src.set('300', F, { name: 'P', fileId: '1', zip: zipOf('ModP', 'v1') });
    const r = await h.api.install('300', F, A);
    assert.equal(r.ok, true, '安装结果不因记录保存失败而改变');
    assert.match(r.historyError ?? '', /操作记录未能保存/);
    assert.ok((await readManifestJson(A)).projects['300'], '清单已提交');
    const done = h.stub.sent.filter((s) => s.channel === 'task:event').map((s) => s.payload as TaskEvent).find((e) => e.modId === '300' && e.phase === 'done');
    assert.equal(done?.installed?.fileId, '1');
    const st = await h.api.historyStatus();
    assert.ok(st.unsaved > 0);
    assert.ok(h.stub.sent.some((s) => s.channel === 'history:status'), '状态推送到窗口');
    const shown = await hist();
    assert.deepEqual(shown.map((e) => [e.kind, e.status, e.unsaved]), [['install', 'succeeded', true]]);
    // 卸载同样不受影响
    const u = await h.api.uninstallProject('200', F, A);
    assert.equal(u.ok, true);
    assert.ok(u.historyError);

    fail = false;
    const ok = await h.api.historyRetry();
    assert.deepEqual([ok.unsaved, ok.saveError], [0, null]);
    assert.equal(JSON.parse(await readFile(path.join(base, 'operation-history.json'), 'utf8')).entries.length, 2);

    // 记录文件损坏：不覆盖；操作照常，提示可见
    const file = path.join(base, 'operation-history.json');
    await writeFile(file, 'broken');
    const r2 = await h.api.uninstallProject('100', F, A);
    assert.equal(r2.ok, true);
    assert.match(r2.historyError ?? '', /无法读取/);
    assert.equal(await readFile(file, 'utf8'), 'broken');
    assert.match((await h.api.historyStatus()).loadError ?? '', /操作记录文件无法读取/);
    assert.equal(ipcCalls.filter((c) => c.channel === 'history:retry').length, 1);
  } finally {
    await cleanup(base);
  }
});

/** 上游给出很长的中文版本名称（manifest 与提交回执中的 version 没有长度上限） */
class LongNameSource extends FakeSource {
  override async latest(modId: string, flavorId: number): Promise<LatestFile> {
    const l = await super.latest(modId, flavorId);
    return { ...l, displayName: `${'很长的版本名称'.repeat(30)}-${l.fileId}` };
  }
}

test('操作记录：真实提交回执中的长中文版本名称截断保存，文件编号原样；记录文件不自损坏，之后仍可保存与读取', async () => {
  const { base, A, h, hist } = await setup({ source: new LongNameSource() });
  try {
    await h.api.update('100', F, false, await recordOf(A, '100'), A);
    const e = (await hist())[0];
    assert.equal(e.status, 'succeeded');
    assert.deepEqual([e.previous?.fileId, e.installed?.fileId], ['1', '2']);
    assert.equal(e.truncated, true);
    assert.ok(Buffer.byteLength(e.installed!.version) <= 256 && e.installed!.version.endsWith('（已截断）'));
    assert.equal((await h.api.historyStatus()).loadError, null);
    await h.api.uninstallProject('200', F, A);
    const again = await new HistoryStore(path.join(base, 'operation-history.json')).list(F, A);
    assert.equal(again.status.loadError, null, '新的运行能读回');
    assert.equal(again.entries.length, 2);
    assert.equal(again.entries[0].previous?.fileId, '1');
  } finally {
    await cleanup(base);
  }
});

/**
 * 让第一次安装停在下载之前，收到取消后以“目录保护”结束（模拟取消与回滚无法判定同时发生）；之后的安装照常执行
 */
function blockOnCancel(manager: AddonManager): void {
  const m = manager as unknown as { install: AddonManager['install'] };
  const original = m.install.bind(manager);
  let first = true;
  m.install = async (root, flavorId, modId, o = {}) => {
    if (!first) return original(root, flavorId, modId, o);
    first = false;
    o.onPhase?.('checking');
    await new Promise<void>((resolve) => {
      if (o.signal?.aborted) resolve();
      else o.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new UserError('该游戏目录有一个未完成且无法自动判定的操作，已暂停写入以保护插件。回滚无法确认（测试）', 'blocked');
  };
}

const finalEvents = (sent: { channel: string; payload: unknown }[], modId: string) =>
  sent.filter((s) => s.channel === 'task:event').map((s) => s.payload as TaskEvent).filter((e) => e.modId === modId && ['done', 'failed', 'cancelled'].includes(e.phase));

test('取消与目录保护同时发生：IPC 错误、任务终态与记录都保留未确认的诊断，不只说已取消', async () => {
  const { base, A, h, hist } = await setup();
  try {
    blockOnCancel(h.service.manager);
    const settled = h.api.update('100', F, false, await recordOf(A, '100'), A).then(() => null, (e: Error) => e);
    const box = { taskId: '' };
    await until(() => !!(box.taskId = h.service.activity.snapshot().tasks.find((t) => t.modId === '100')?.taskId ?? ''), '任务开始');
    await h.api.cancelTask(box.taskId);
    const err = await settled;
    assert.ok(err, '请求失败');
    assert.match(err.message, /无法自动判定/);
    assert.notEqual(err.message, '已取消');
    const ev = finalEvents(h.stub.sent, '100');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].phase, 'failed');
    assert.match(ev[0].message ?? '', /无法自动判定/);
    const e = (await hist())[0];
    assert.equal(e.status, 'unconfirmed');
    assert.match(e.message, /结果未确认/);
    assert.match(e.message, /无法自动判定/);
  } finally {
    await cleanup(base);
  }
});

test('全部更新：其中一项取消时遇到目录保护，计为结果未确认而不是取消；其他项照常处理', async () => {
  const { base, A, h, hist } = await setup();
  try {
    blockOnCancel(h.service.manager);
    const run = h.api.updateAll(F, A);
    const box = { taskId: '', modId: '' };
    await until(() => {
      const t = h.service.activity.snapshot().tasks.find((x) => x.phase !== 'queued');
      if (t) Object.assign(box, { taskId: t.taskId, modId: t.modId });
      return !!t;
    }, '第一项开始');
    await h.api.cancelTask(box.taskId);
    const r = await run;
    assert.match(r.message, /已更新 1 个插件/);
    assert.match(r.message, /结果未确认 1 个/);
    assert.doesNotMatch(r.message, /取消/);
    assert.equal(r.ok, false);
    assert.ok(r.warnings?.some((w) => /结果未确认/.test(w) && /无法自动判定/.test(w)));
    const e = (await hist()).find((x) => x.modId === box.modId && x.batchId)!;
    assert.equal(e.status, 'unconfirmed');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

/** 批次检查之后，100 的远端最新文件回到本地已装的文件 1（安装时得到“已是最新”） */
class RollbackSource extends FakeSource {
  armed = false;
  private seen = 0;
  override async latest(modId: string, flavorId: number): Promise<LatestFile> {
    if (this.armed && modId === '100' && ++this.seen === 2) this.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
    return super.latest(modId, flavorId);
  }
}

test('全部更新：安装时已是最新（没有提交）的项目计为未改动，不计为已更新；记录为未改动', async () => {
  const src = new RollbackSource();
  const { base, A, h, hist } = await setup({ source: src });
  try {
    src.armed = true;
    const r = await h.api.updateAll(F, A);
    assert.equal(r.message, '已更新 1 个插件，1 个已是最新，未改动');
    assert.equal(r.ok, true);
    const m = await readManifestJson(A);
    assert.deepEqual([m.projects['100'].fileId, m.projects['200'].fileId], ['1', '2']);
    const byMod = new Map((await hist()).map((e) => [e.modId, e.status]));
    assert.deepEqual([byMod.get('100'), byMod.get('200')], ['unchanged', 'succeeded']);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
