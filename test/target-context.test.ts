// 操作目标回归（0.1.2）：preload → IPC 处理 → AddonManager → 文件系统 的真实链路。
// 场景复刻实际流程：目录 A 原先以「经典旧世」(6) 安装了插件 M，之后 A 改绑给「探索赛季」(3)，6 改绑到目录 B（B 中也装有 M）。
// 断言：作用于 A 的操作绝不改动 B（目录、清单、回收站、WTF 全部逐字节不变）；来源版本不同的插件只能卸载与恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addonEntries, cleanup, FakeSource, listAddOns, makeGameRoot, makeManager, makeZip, readAddonFile, tmpDir } from './helpers';
import { createHarness, ipcCalls, readManifestJson, recordOf, snapshot } from './ipc-harness';
import type { AddonWatchSnapshot } from '../src/shared/types';

const SRC = 6; // 插件记录的来源版本
const VIEW = 3; // 目录 A 当前绑定的版本
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));
/** 0.1.3 起手动检查回复主进程快照：取出该目录条目中的检查结果 */
const itemsOf = (s: AddonWatchSnapshot, flavorId: number, root: string) => s.entries.find((e) => e.flavorId === flavorId && e.root === root)?.items ?? [];

async function crossSetup() {
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
  const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
  await h.settings.bind(VIEW, A);
  await h.settings.bind(SRC, B);
  return { base, A, B, src, h };
}

test('异来源插件：在 A 卸载与恢复只改动 A，B 的目录、清单、回收站与 WTF 完全不变', async () => {
  const { base, A, B, h } = await crossSetup();
  try {
    const b0 = await snapshot(B);
    const r = (await h.api.uninstallProject('100', VIEW, A)) as { ok: boolean; message: string };
    assert.equal(r.ok, true);
    assert.deepEqual(await listAddOns(A), ['ModN']);
    const ma = await readManifestJson(A);
    assert.equal(ma.projects['100'], undefined);
    const entry = ma.recovery.find((e) => e.kind === 'uninstall');
    assert.deepEqual(entry?.folders, ['ModM']);
    assert.deepEqual(await snapshot(B), b0);

    await h.api.restore(entry!.id, VIEW, A);
    assert.deepEqual(await listAddOns(A), ['ModM', 'ModN']);
    const ma2 = await readManifestJson(A);
    assert.equal(ma2.projects['100'].flavorId, SRC, '恢复后仍记录原来源版本');
    assert.equal(ma2.recovery.length, 0);
    assert.deepEqual(await snapshot(B), b0);
    assert.deepEqual(ipcCalls.map((c) => [c.channel, ...c.args]), [
      ['addon:uninstall', '100', VIEW, A],
      ['trash:restore', entry!.id, VIEW, A],
    ]);
  } finally {
    await cleanup(base);
  }
});

test('异来源插件：更新、重装被拒绝；按旧来源版本发起的请求不会转向 B；A、B 都不变', async () => {
  const { base, A, B, src, h } = await crossSetup();
  try {
    // 两个版本都出现了新文件
    src.set('100', SRC, { name: 'M', fileId: '2', zip: zipOf('ModM', 'm2'), versions: ['12.1.5'] });
    src.set('100', VIEW, { name: 'M', fileId: '9', zip: zipOf('ModM', 'm9-view'), versions: ['12.1.5'] });
    const a0 = await snapshot(A);
    const b0 = await snapshot(B);
    await assert.rejects(h.api.update('100', VIEW, false, await recordOf(A, '100'), A), /不会用当前版本的文件更新或重装/);
    await assert.rejects(h.api.update('100', VIEW, true, await recordOf(A, '100'), A), /不会用当前版本的文件更新或重装/);
    // 0.1.1 的界面会按插件记录的来源版本发送（100, 6），现在因期望目录 A 与 6 的绑定目录 B 不符而被拒绝
    await assert.rejects(h.api.update('100', SRC, true, await recordOf(A, '100'), A), /绑定已变更/);
    await assert.rejects(h.api.uninstallProject('100', SRC, A), /绑定已变更/);
    assert.deepEqual(await snapshot(A), a0);
    assert.deepEqual(await snapshot(B), b0);
    assert.equal(await readAddonFile(A, 'ModM', 'ModM.toc').then((t) => t.includes('m1')), true);
  } finally {
    await cleanup(base);
  }
});

test('异来源插件：检查更新跳过且不查询远端，全部更新只更新同来源插件', async () => {
  const { base, A, B, src, h } = await crossSetup();
  try {
    src.set('100', SRC, { name: 'M', fileId: '2', zip: zipOf('ModM', 'm2'), versions: ['12.1.5'] });
    src.set('200', VIEW, { name: 'N', fileId: '2', zip: zipOf('ModN', 'n2'), versions: ['12.1.5'] });
    const b0 = await snapshot(B);
    src.calls.length = 0;
    const items = itemsOf(await h.api.checkUpdates(VIEW, A), VIEW, A);
    const m = items.find((i) => i.modId === '100')!;
    const n = items.find((i) => i.modId === '200')!;
    assert.equal(m.hasUpdate, false);
    assert.match(m.skipped ?? '', /不检查更新/);
    assert.equal(m.error, null);
    assert.equal(n.hasUpdate, true);
    assert.ok(!src.calls.some((c) => c.startsWith('latest:100:')), '异来源插件不查询远端');

    const r = (await h.api.updateAll(VIEW, A)) as { ok: boolean; message: string; warnings?: string[] };
    assert.equal(r.ok, true);
    assert.match(r.message, /已更新 1 个插件/);
    assert.match(r.message, /跳过其他游戏版本来源的 1 个/);
    const ma = await readManifestJson(A);
    assert.equal(ma.projects['200'].fileId, '2');
    assert.equal(ma.projects['100'].fileId, '1');
    assert.equal(await readAddonFile(A, 'ModM', 'ModM.toc').then((t) => t.includes('m1')), true);
    assert.ok(!src.calls.some((c) => c === 'latest:100:3' || c === 'detail:100:3'));
    assert.deepEqual(await snapshot(B), b0);
  } finally {
    await cleanup(base);
  }
});

test('同一版本换绑：带旧期望目录的请求全部拒绝，不写入旧目录也不转向新目录', async () => {
  const { base, A, B, h } = await crossSetup();
  try {
    const C = await makeGameRoot(path.join(base, 'C'));
    await h.settings.bind(VIEW, C);
    const a0 = await snapshot(A);
    const b0 = await snapshot(B);
    const c0 = await snapshot(C);
    const ma = await readManifestJson(A);
    await assert.rejects(h.api.uninstallProject('200', VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.uninstallFolder('ModN', VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.update('200', VIEW, true, await recordOf(A, '200'), A), /绑定已变更/);
    await assert.rejects(h.api.updateAll(VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.install('300', VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.checkUpdates(VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.restore('zzzz-000000', VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.purge('zzzz-000000', VIEW, A), /绑定已变更/);
    await assert.rejects(h.api.unbindProfile(VIEW, A), /绑定已变更/);
    assert.equal((await h.settings.profile(VIEW)).root, C, '解绑被拒绝，绑定保持为 C');
    assert.deepEqual(await readManifestJson(A), ma);
    assert.deepEqual(await snapshot(A), a0);
    assert.deepEqual(await snapshot(B), b0);
    assert.deepEqual(await snapshot(C), c0);
    // 期望值正确时解绑成功
    await h.api.unbindProfile(VIEW, C);
    assert.equal((await h.settings.profile(VIEW)).root, null);
    assert.equal((await h.settings.profile(SRC)).root, B);
  } finally {
    await cleanup(base);
  }
});

test('期望目录参数：缺失、相对路径或非字符串一律拒绝，不执行操作', async () => {
  const { base, A, h } = await crossSetup();
  try {
    const a0 = await snapshot(A);
    for (const bad of [undefined, '', 'relative/path', 42, `${A}\0x`]) {
      await assert.rejects(h.invoke('addon:uninstall', '200', VIEW, bad), /目标目录参数无效/);
      await assert.rejects(h.invoke('profile:unbind', VIEW, bad), /目标目录参数无效/);
    }
    assert.deepEqual(await snapshot(A), a0);
  } finally {
    await cleanup(base);
  }
});

test('正常来源：经 IPC 安装、更新、重装、卸载、恢复都作用于当前目录，期望目录逐次传递，B 不变', async () => {
  const { base, A, B, src, h } = await crossSetup();
  try {
    const b0 = await snapshot(B);
    src.set('300', VIEW, { name: 'P', fileId: '1', zip: zipOf('ModP', 'p1'), versions: ['12.1.5'] });
    assert.match(((await h.api.install('300', VIEW, A)) as { message: string }).message, /安装完成/);
    assert.match(await readAddonFile(A, 'ModP', 'ModP.toc'), /p1/);

    src.set('300', VIEW, { name: 'P', fileId: '2', zip: zipOf('ModP', 'p2'), versions: ['12.1.5'] });
    const items = itemsOf(await h.api.checkUpdates(VIEW, A), VIEW, A);
    assert.equal(items.find((i) => i.modId === '300')?.hasUpdate, true);
    assert.match(((await h.api.update('300', VIEW, false, await recordOf(A, '300'), A)) as { message: string }).message, /已更新到/);
    assert.match(await readAddonFile(A, 'ModP', 'ModP.toc'), /p2/);
    assert.match(((await h.api.update('300', VIEW, true, await recordOf(A, '300'), A)) as { message: string }).message, /已重新安装/);

    await h.api.uninstallProject('300', VIEW, A);
    assert.ok(!(await listAddOns(A)).includes('ModP'));
    const entry = (await readManifestJson(A)).recovery.find((e) => e.kind === 'uninstall' && e.folders.includes('ModP'))!;
    await h.api.restore(entry.id, VIEW, A);
    assert.match(await readAddonFile(A, 'ModP', 'ModP.toc'), /p2/);
    assert.equal((await readManifestJson(A)).projects['300'].flavorId, VIEW);

    for (const c of ipcCalls) assert.equal(c.args[c.args.length - 1], A, `${c.channel} 的期望目录应为 A`);
    assert.deepEqual(await snapshot(B), b0);
  } finally {
    await cleanup(base);
  }
});

test('已受理的安装固定在原目录完成：下载期间换绑不会转向新目录', async () => {
  const base = await realpath(await tmpDir());
  try {
    const A = await makeGameRoot(path.join(base, 'A'));
    const C = await makeGameRoot(path.join(base, 'C'));
    const src = new FakeSource();
    src.set('300', VIEW, { name: 'P', fileId: '1', zip: zipOf('ModP', 'p1'), versions: ['12.1.5'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const downloading = new Promise<void>((r) => (started = r));
    const h = createHarness({
      settingsFile: path.join(base, 'settings.json'),
      source: src,
      download: async (url, dest, o) => {
        started();
        await gate;
        return src.download(url, dest);
      },
    });
    await h.settings.bind(VIEW, A);
    const c0 = await snapshot(C);
    const p = h.api.install('300', VIEW, A);
    await downloading;
    await h.settings.bind(VIEW, C);
    release();
    await p;
    assert.deepEqual(await listAddOns(A), ['ModP']);
    assert.deepEqual(await snapshot(C), c0);
  } finally {
    await cleanup(base);
  }
});

// 防止快照辅助本身失效：改动一个文件后快照必须不同
test('快照辅助：内容或结构变化都能被检出', async () => {
  const base = await tmpDir();
  try {
    await mkdir(path.join(base, 'x'));
    await writeFile(path.join(base, 'x', 'f'), '1');
    const s0 = await snapshot(base);
    await writeFile(path.join(base, 'x', 'f'), '2');
    assert.notDeepEqual(await snapshot(base), s0);
    const s1 = await snapshot(base);
    await rename(path.join(base, 'x', 'f'), path.join(base, 'x', 'g'));
    assert.notDeepEqual(await snapshot(base), s1);
  } finally {
    await cleanup(base);
  }
});
