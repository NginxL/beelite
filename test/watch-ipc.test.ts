// 插件更新检查与客户端更新说明的 IPC 接线（0.1.3）：真实 preload → 真实 AppService（假 electron）→ 协调器 / ClientUpdater → 临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClientUpdater, type SparkleBridge } from '../src/core/client-update';
import { MUTATING_CHANNELS } from '../src/core/gate';
import type { AddonWatchSnapshot, UpdateCheckItem } from '../src/shared/types';
import { addonEntries, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { createHarness, ipcCalls } from './ipc-harness';

const F = 9;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  const m = makeManager(src);
  src.set('1', F, { name: 'M1', fileId: '1', zip: zipOf('M1', 'v1') });
  src.set('2', F, { name: 'M2', fileId: '1', zip: zipOf('M2', 'v1') });
  await m.install(A, F, '1');
  await m.install(A, F, '2');
  const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
  await h.settings.bind(F, A);
  src.calls.length = 0;
  return { base, A, src, h };
}

const entryOf = (s: AddonWatchSnapshot, root: string) => s.entries.find((e) => e.flavorId === F && e.root === root);

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(5);
  }
  throw new Error(`等待超时：${what}`);
}

test('新增通道都是只读通道：写通道清单不变', () => {
  for (const c of ['addon:watchState', 'client:ackNotice']) assert.ok(!MUTATING_CHANNELS.has(c), c);
});

test('经 preload / IPC 手动检查：由协调器执行并发布快照；结果带检查时的本地文件编号；快照推送到窗口', async () => {
  const { base, A, src, h } = await setup();
  try {
    src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    const reply = await h.api.checkUpdates(F, A);
    const items: UpdateCheckItem[] = entryOf(reply, A)!.items;
    const m1 = items.find((i) => i.modId === '1')!;
    assert.equal(m1.hasUpdate, true);
    assert.equal(m1.installedFileId, '1');
    assert.equal(typeof m1.checkedAt, 'number');
    const snap = await h.api.watchState();
    assert.equal(snap.instance, reply.instance);
    assert.ok(snap.rev >= reply.rev, '手动检查回复的是带 rev 的权威快照');
    const e = entryOf(snap, A)!;
    assert.equal(e.status, 'ok');
    assert.equal(e.pending, 1);
    assert.equal(e.checkedAt, m1.checkedAt);
    const pushed = h.stub.sent.filter((s) => s.channel === 'addon:watch').map((s) => s.payload as AddonWatchSnapshot);
    assert.ok(pushed.length >= 2, '检查开始与完成都推送了快照');
    assert.ok(pushed.every((s, i) => i === 0 || s.rev > pushed[i - 1].rev), '推送的快照 rev 递增');
    assert.ok(!src.calls.some((c) => c.startsWith('detail:')), '检查没有进入安装流程');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('写后失效：经 IPC 更新插件后该目录结果按新清单重校验（不发网络请求）；解绑后该目录结果移除', async () => {
  const { base, A, src, h } = await setup();
  try {
    src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    await h.api.checkUpdates(F, A);
    await h.api.update('1', F, false, A);
    const latestCalls = src.calls.filter((c) => c.startsWith('latest:')).length;
    const e = await waitFor(async () => {
      const x = entryOf(await h.api.watchState(), A);
      return x && x.pending === 0 ? x : undefined;
    }, '重校验');
    const m1 = e.items.find((i) => i.modId === '1')!;
    assert.equal(m1.hasUpdate, false);
    assert.equal(m1.installedFileId, '2');
    assert.equal(src.calls.filter((c) => c.startsWith('latest:')).length, latestCalls, '重校验不查询远端');

    await h.api.unbindProfile(F, A);
    await waitFor(async () => (entryOf(await h.api.watchState(), A) ? undefined : true), '解绑后移除');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('全部更新：批次内的检查经协调器强制重新查询（不使用刚才手动检查的结果），在写入闸门内完成而不死锁', async () => {
  const { base, A, src, h } = await setup();
  try {
    src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    await h.api.checkUpdates(F, A);
    const before = src.calls.filter((c) => c.startsWith('latest:')).length;
    src.set('2', F, { name: 'M2', fileId: '2', zip: zipOf('M2', 'v2') }); // 手动检查之后才出现的新文件
    const r = (await h.api.updateAll(F, A)) as { ok: boolean; message: string };
    assert.equal(r.ok, true);
    assert.match(r.message, /已更新 2 个插件/, '批次重新检查后发现了 M2');
    assert.ok(src.calls.filter((c) => c.startsWith('latest:')).length >= before + 2);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

class FakeBridge implements SparkleBridge {
  calls: string[] = [];
  init() {
    return { ok: true };
  }
  probe() {
    this.calls.push('probe');
    return true;
  }
  beginUpdate(build: string) {
    this.calls.push(`beginUpdate:${build}`);
    return true;
  }
  installNow() {
    this.calls.push('installNow');
    return true;
  }
  cancel() {
    this.calls.push('cancel');
    return true;
  }
}

test('客户端更新 IPC：更新必须带上与当前一致的构建号；参数无效时拒绝；已读提醒不调用原生、不跳过版本', async () => {
  const { base, h } = await setup();
  try {
    const bridge = new FakeBridge();
    const u = new ClientUpdater({ bridge, gate: h.gate, currentVersion: '0.1.3', onState: (s) => h.service.pushClientState(s) });
    u.start();
    h.service.attachClientUpdater(u);
    u.check();
    u.handle({ type: 'valid-update', version: '0.1.4', displayVersion: '0.1.4', notes: '修复若干问题', notesState: 'ok' });
    u.handle({ type: 'cycle-finished', check: 'probe' });
    let s = await h.api.clientState();
    assert.equal(s.availableBuild, '0.1.4');
    assert.equal(s.releaseNotes, '修复若干问题');
    assert.equal(s.notice, true);

    for (const bad of [undefined, '', 42, 'x'.repeat(65), '0.1.4;rm']) {
      await assert.rejects(h.invoke('client:update', bad), /版本参数无效/);
      await assert.rejects(h.invoke('client:ackNotice', bad), /版本参数无效/);
    }
    s = await h.api.clientUpdate('0.1.5');
    assert.equal(s.status, 'available', '构建号不一致：不开始更新');
    assert.match(s.message ?? '', /新版本信息已变化/);
    s = await h.api.clientAckNotice('0.1.4');
    assert.equal(s.notice, false);
    assert.equal(s.canUpdate, true, '“稍后”不影响之后更新');
    assert.deepEqual(bridge.calls, ['probe'], '已读提醒与不一致的更新请求都没有调用原生');
    s = await h.api.clientUpdate('0.1.4');
    assert.equal(s.status, 'downloading');
    assert.deepEqual(bridge.calls, ['probe', 'beginUpdate:0.1.4'], '授权绑定用户确认的构建号');
    assert.ok(h.stub.sent.some((x) => x.channel === 'client:event'));
    assert.ok(ipcCalls.every((c) => c.channel !== 'addon:update' && c.channel !== 'addon:install'));
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

// ---------- 第二轮回归：绑定与写入的同步失效 ----------

/** latest 可挂起的数据源（忽略中止信号，模拟迟到的回包） */
class GatedSource extends FakeSource {
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  waiting = 0;
  pause(): void {
    this.gate = new Promise((r) => (this.open = r));
  }
  resume(): void {
    this.gate = null;
    this.open?.();
  }
  override async latest(modId: string, flavorId: number) {
    if (this.gate) {
      this.waiting++;
      await this.gate;
      this.waiting--;
    }
    return super.latest(modId, flavorId);
  }
}

async function gatedSetup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = await makeGameRoot(path.join(base, 'B'));
  const src = new GatedSource();
  const m = makeManager(src);
  src.set('1', F, { name: 'M1', fileId: '1', zip: zipOf('M1', 'v1') });
  await m.install(A, F, '1');
  await m.install(B, F, '1');
  src.set('1', F, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') }); // 两个目录都可更新
  const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
  await h.settings.bind(F, A);
  return { base, A, B, src, h };
}

const published = (h: ReturnType<typeof createHarness>, from: number) =>
  h.stub.sent.slice(from).filter((x) => x.channel === 'addon:watch').map((x) => x.payload as AddonWatchSnapshot);

test('经界面 A→B→A 换绑（检查器读取设置被延迟，两次都只读到最终的 A）：绑定完成时同步作废，旧检查不发布，旧提醒不保留', async () => {
  const { base, A, B, src, h } = await gatedSetup();
  try {
    const real = h.settings;
    const delayed: (() => void)[] = [];
    let delay = false;
    (h.service.watch as unknown as { o: { settings: unknown } }).o.settings = {
      load: () => (delay ? new Promise((res, rej) => delayed.push(() => void real.load().then(res, rej))) : real.load()),
    };
    src.pause();
    const old = h.api.checkUpdates(F, A);
    old.catch(() => undefined);
    await waitFor(async () => (src.waiting > 0 ? true : undefined), 'A 的检查挂起');
    delay = true;
    const mark = h.stub.sent.length;
    h.stub.pick = B;
    assert.equal((await h.api.bindProfile(F))?.root, B);
    h.stub.pick = A;
    assert.equal((await h.api.bindProfile(F))?.root, A);
    assert.equal(delayed.length >= 2, true, '两次同步都还在等待读取设置');
    assert.equal(entryOf(await h.api.watchState(), A), undefined, '绑定完成时已同步移除旧条目');
    src.resume();
    await assert.rejects(old, /绑定已变更/);
    await sleep(20);
    for (const s of published(h, mark)) {
      assert.ok(!s.entries.some((e) => e.root === A && e.checkedAt !== null), '旧检查的结果从未发布');
      assert.equal(s.notice, null);
    }
    delay = false;
    for (const f of delayed.splice(0)) f();
    const a = await waitFor(async () => entryOf(await h.api.watchState(), A), '重建 A');
    assert.equal(a.status, 'pending');
    assert.deepEqual(a.items, []);
    assert.equal(a.checkedAt, null);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('发布前重新核对设置：绕过界面把绑定改到 B 时旧结果不发布；检查期间设置损坏也不发布“已是最新”', async () => {
  const { base, A, B, src, h } = await gatedSetup();
  try {
    src.pause();
    const p1 = h.api.checkUpdates(F, A);
    p1.catch(() => undefined);
    await waitFor(async () => (src.waiting > 0 ? true : undefined), '挂起');
    await h.settings.bind(F, B); // 没有经过 IPC，检查器不知道
    src.resume();
    await assert.rejects(p1, /绑定已变更/);
    assert.equal(entryOf(await h.api.watchState(), A)?.checkedAt ?? null, null);

    await h.settings.bind(F, A);
    src.pause();
    const p2 = h.api.checkUpdates(F, A);
    p2.catch(() => undefined);
    await waitFor(async () => (src.waiting > 0 ? true : undefined), '挂起');
    await writeFile(path.join(base, 'settings.json'), '{ broken');
    src.resume();
    await assert.rejects(p2, /无法读取蜂简设置文件/);
    const s = await h.api.watchState();
    assert.match(s.settingsError ?? '', /无法读取蜂简设置文件/);
    assert.ok(!s.entries.some((e) => e.status === 'ok'), '没有发布任何结论');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('写后失效钩子：install、update(force=false / true) 按实际参数形状调用 afterWrite(flavorId, 目录)；绑定成功时同步作废，取消选择时不作废', async () => {
  const { base, A, B, h } = await gatedSetup();
  try {
    const writes: unknown[][] = [];
    const invalidations: number[] = [];
    const w = h.service.watch;
    const origWrite = w.afterWrite.bind(w);
    const origInvalidate = w.invalidateFlavor.bind(w);
    w.afterWrite = (f, r) => (writes.push([f, r]), origWrite(f, r));
    w.invalidateFlavor = (f) => (invalidations.push(f), origInvalidate(f));
    await h.api.update('1', F, false, A);
    await h.api.update('1', F, true, A);
    await assert.rejects(h.api.install('9', F, A));
    assert.deepEqual(writes, [[F, A], [F, A], [F, A]]);
    h.stub.pick = null; // 取消选择
    assert.equal(await h.api.bindProfile(F), null);
    assert.deepEqual(invalidations, [], '绑定没有变化');
    h.stub.pick = B;
    await h.api.bindProfile(F);
    assert.deepEqual(invalidations, [F]);
    await h.api.unbindProfile(F, B);
    assert.deepEqual(invalidations, [F, F]);
    await assert.rejects(h.api.unbindProfile(F, A), /绑定已变更/);
    assert.deepEqual(invalidations, [F, F], '被拒绝的解绑不作废');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
