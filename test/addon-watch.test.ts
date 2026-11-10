// 插件更新自动检查（0.1.3）：真实 AddonUpdateWatch + AddonManager + SettingsStore + 临时目录，时钟可控。
// 覆盖：启动/每小时/休眠补一次、所有目录、并发上限与复用、退避、部分失败、设置与目录错误隔离、写入闸门、
// 停止与中止、绑定变化（含 A→B→A 迟到回包）、写后失效与只读重校验、提醒去重，以及“只读、不安装”。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AddonUpdateWatch, CHECK_INTERVAL_MS, GATE_RETRY_MS, type WatchClock } from '../src/core/addon-watch';
import { runUpdateAll } from '../src/core/batch';
import { UserError } from '../src/core/errors';
import { MutationGate } from '../src/core/gate';
import { AddonManager, type ModSource } from '../src/core/manager';
import { SettingsStore } from '../src/core/profiles';
import type { LatestFile } from '../src/core/provider';
import type { AddonWatchSnapshot } from '../src/shared/types';
import { addonEntries, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { snapshot } from './ipc-harness';

const MIN = 60 * 1000;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));

/** 可控时钟：advance 依次触发到期的定时器；jump 模拟休眠（墙钟前进、定时器不触发） */
class FakeClock implements WatchClock {
  t = Date.UTC(2026, 10, 8, 8, 0, 0);
  private seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  constructor(private readonly settle: () => Promise<void>) {}
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await this.settle();
    }
    this.t = end;
  }
  jump(ms: number): void {
    this.t += ms;
  }
}

/** 包装数据源：统计并发、可让请求挂起、可按插件注入错误 */
class ControlledSource implements ModSource {
  inFlight = 0;
  maxInFlight = 0;
  calls: string[] = [];
  hold = false;
  /** 挂起的请求不响应中止信号（模拟迟到的回包） */
  ignoreAbort = false;
  private waiters: (() => void)[] = [];
  /** modId -> 'net'（临时网络错误）| 'remote'（服务端拒绝） */
  fail = new Map<string, 'net' | 'remote'>();
  constructor(readonly inner: FakeSource) {}
  detail(modId: string, flavorId: number) {
    return this.inner.detail(modId, flavorId);
  }
  async latest(modId: string, flavorId: number, signal?: AbortSignal): Promise<LatestFile> {
    this.calls.push(`${modId}:${flavorId}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (this.hold) {
        await new Promise<void>((resolve, reject) => {
          this.waiters.push(resolve);
          if (!this.ignoreAbort) signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const f = this.fail.get(modId);
      if (f === 'net') throw new TypeError('fetch failed');
      if (f === 'remote') throw new UserError('服务器提示：查询不到当前游戏的插件信息', 'remote');
      return await this.inner.latest(modId, flavorId);
    } finally {
      this.inFlight--;
    }
  }
  release(): void {
    this.hold = false;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
  get waiting(): number {
    return this.waiters.length;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等待协调器空闲（没有进行中、排队或正在调度的检查） */
async function idle(w: AddonUpdateWatch): Promise<void> {
  const x = w as unknown as { running: unknown; queue: unknown[]; sweeping: boolean };
  for (let i = 0; i < 600; i++) {
    await sleep(3);
    if (!x.running && x.queue.length === 0 && !x.sweeping) {
      await sleep(3);
      if (!x.running && x.queue.length === 0 && !x.sweeping) return;
    }
  }
  throw new Error('协调器没有在预期时间内空闲');
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await sleep(3);
  }
  throw new Error(`等待超时：${what}`);
}

/**
 * 目录 A 绑定「无限」(9)，装有 M1、M2（fileId 1）；目录 B 绑定「探索赛季」(3)，装有 N（fileId 1）。
 * extra：A 中额外安装的插件数量（用于并发与中止测试）。
 */
async function world(opts: { extraA?: number } = {}) {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const B = await makeGameRoot(path.join(base, 'B'));
  const fake = new FakeSource();
  const writer = makeManager(fake);
  fake.set('1', 9, { name: 'M1', fileId: '1', zip: zipOf('M1', 'v1') });
  fake.set('2', 9, { name: 'M2', fileId: '1', zip: zipOf('M2', 'v1') });
  fake.set('5', 3, { name: 'N', fileId: '1', zip: zipOf('N5', 'v1'), versions: ['12.1.5'] });
  await writer.install(A, 9, '1');
  await writer.install(A, 9, '2');
  for (let i = 0; i < (opts.extraA ?? 0); i++) {
    const id = String(100 + i);
    fake.set(id, 9, { name: `X${i}`, fileId: '1', zip: zipOf(`X${i}`, 'v1') });
    await writer.install(A, 9, id);
  }
  await writer.install(B, 3, '5');
  fake.calls.length = 0; // 之后出现的 detail 调用才说明进入了安装流程
  const settingsFile = path.join(base, 'settings.json');
  const settings = new SettingsStore(settingsFile);
  await settings.bind(9, A);
  await settings.bind(3, B);
  const src = new ControlledSource(fake);
  const checker = new AddonManager({ source: src, download: fake.download, confirm: async () => true });
  const gate = new MutationGate();
  const snaps: AddonWatchSnapshot[] = [];
  let w!: AddonUpdateWatch;
  const clock = new FakeClock(() => idle(w));
  w = new AddonUpdateWatch({ settings, checker, gate, clock, onChange: (s) => snaps.push(s) });
  const entry = (flavorId: number, root: string) => w.snapshot().entries.find((e) => e.flavorId === flavorId && e.root === root);
  return { base, A, B, fake, writer, settings, settingsFile, src, checker, gate, clock, w, snaps, entry };
}

test('启动后检查所有已绑定目录一次，之后每小时一次；休眠唤醒后只补检一次，不补发错过的周期', async () => {
  const x = await world();
  try {
    x.w.start();
    await idle(x.w);
    assert.equal(x.src.calls.length, 3, '启动后 A 的 2 个与 B 的 1 个插件各查询一次');
    assert.deepEqual(x.w.snapshot().entries.map((e) => e.status), ['ok', 'ok']);
    assert.equal(x.entry(9, x.A)?.checkedAt, x.clock.t);

    await x.clock.advance(59 * MIN);
    await idle(x.w);
    assert.equal(x.src.calls.length, 3, '不到一小时不再检查');
    await x.clock.advance(1 * MIN);
    await idle(x.w);
    assert.equal(x.src.calls.length, 6, '满一小时再检查一次');

    // 休眠 5 小时：期间定时器不触发；唤醒后按墙钟只补检一次
    x.clock.jump(5 * 60 * MIN);
    x.w.poke();
    await idle(x.w);
    assert.equal(x.src.calls.length, 9);
    await x.clock.advance(10 * MIN);
    await idle(x.w);
    assert.equal(x.src.calls.length, 9, '补检之后重新按一小时计时');
    // 即使没有唤醒事件，最长 5 分钟的定时器也会按墙钟发现到期
    x.clock.jump(2 * 60 * MIN);
    await x.clock.advance(5 * MIN);
    await idle(x.w);
    assert.equal(x.src.calls.length, 12);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('只读：自动与手动检查不写设置、游戏目录（含 .beelite 与 WTF），没有艾泽魔方数据的目录也不会被创建', async () => {
  const x = await world();
  try {
    const C = await makeGameRoot(path.join(x.base, 'C'));
    await x.settings.bind(2, C);
    const before = { a: await snapshot(x.A), b: await snapshot(x.B), c: await snapshot(C), s: await readFile(x.settingsFile, 'utf8'), m: (await stat(x.settingsFile)).mtimeMs };
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.w.start();
    await idle(x.w);
    await x.w.check(9, x.A);
    await x.w.check(9, x.A, { fresh: true });
    await x.clock.advance(3 * CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.equal(x.entry(9, x.A)?.pending, 1, '发现了更新');
    assert.equal(x.entry(2, C)?.status, 'ok');
    assert.deepEqual(await snapshot(x.A), before.a);
    assert.deepEqual(await snapshot(x.B), before.b);
    assert.deepEqual(await snapshot(C), before.c);
    assert.equal(await exists(path.join(C, 'Interface', '.beelite')), false);
    assert.equal(await readFile(x.settingsFile, 'utf8'), before.s);
    assert.equal((await stat(x.settingsFile)).mtimeMs, before.m);
    assert.ok(!x.fake.calls.some((c) => c.startsWith('detail:')), '检查不会进入安装流程');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('并发：多个目录依次检查，任何时刻最多 3 个请求；手动检查复用同一目录进行中的检查，强制检查重新查询', async () => {
  const x = await world({ extraA: 6 });
  try {
    await x.settings.bind(3, null);
    x.src.hold = true;
    x.w.start();
    await until(() => x.src.waiting === 3, '首批 3 个请求');
    const manual = x.w.check(9, x.A);
    const fresh = x.w.check(9, x.A, { fresh: true });
    await sleep(20);
    assert.equal(x.src.inFlight, 3, '手动与强制检查都没有叠加并发');
    x.src.release();
    const items = await manual;
    assert.equal(items.length, 8);
    await fresh;
    await idle(x.w);
    assert.equal(x.src.calls.length, 16, '自动检查与手动检查共用一次（8 次），强制检查另查一次（8 次）');
    assert.equal(x.src.maxInFlight, 3);

    // 多个目录：重新绑定 B 后，两个目录依次检查，并发仍不超过 3
    await x.settings.bind(3, x.B);
    x.src.maxInFlight = 0;
    await x.w.bindingsChanged();
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.ok(x.src.calls.some((c) => c.endsWith(':3')));
    assert.ok(x.src.maxInFlight <= 3);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('失败处理：临时错误按 5/15/60 分钟重试，长期错误按每小时；部分失败不算“全部最新”，临时失败保留上次“可更新”', async () => {
  const x = await world();
  try {
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.w.start();
    await idle(x.w);
    let a = x.entry(9, x.A)!;
    assert.equal(a.status, 'ok');
    assert.equal(a.pending, 1);
    assert.equal(a.nextCheckAt, x.clock.t + CHECK_INTERVAL_MS);

    // M1、M2 都出现临时网络错误
    x.src.fail.set('1', 'net');
    x.src.fail.set('2', 'net');
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    a = x.entry(9, x.A)!;
    assert.equal(a.status, 'partial');
    assert.equal(a.failed, 2);
    const m1 = a.items.find((i) => i.modId === '1')!;
    const m2 = a.items.find((i) => i.modId === '2')!;
    assert.equal(m1.hasUpdate, true, '上次的“可更新”结论保留');
    assert.equal(m1.stale, true);
    assert.match(m1.error ?? '', /本次检查失败/);
    assert.equal(m2.hasUpdate, false);
    assert.ok(m2.error, '上次“已是最新”的项目本次失败时显示失败，不显示为最新');
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const e = x.entry(9, x.A)!;
      delays.push((e.nextCheckAt ?? 0) - x.clock.t);
      await x.clock.advance((e.nextCheckAt ?? 0) - x.clock.t);
      await idle(x.w);
    }
    assert.deepEqual(delays, [5 * MIN, 15 * MIN, 60 * MIN, 60 * MIN]);

    // 长期错误（服务端拒绝）：不加快轮询
    x.src.fail.set('1', 'remote');
    x.src.fail.set('2', 'remote');
    await x.clock.advance((x.entry(9, x.A)!.nextCheckAt ?? 0) - x.clock.t);
    await idle(x.w);
    a = x.entry(9, x.A)!;
    assert.equal(a.nextCheckAt, x.clock.t + CHECK_INTERVAL_MS);
    assert.equal(a.items.find((i) => i.modId === '1')?.hasUpdate, false, '长期错误不保留旧结论');
    assert.equal(a.items.find((i) => i.modId === '1')?.transient, false);
    assert.equal(x.entry(3, x.B)?.status, 'ok', '一个目录的失败不影响另一个目录');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('错误隔离：一个目录不可访问只影响它自己；设置无法读取时不检查也不覆盖设置文件，修复后恢复', async () => {
  const x = await world();
  try {
    await rm(x.B, { recursive: true, force: true });
    x.w.start();
    await idle(x.w);
    assert.equal(x.entry(9, x.A)?.status, 'ok');
    const b = x.entry(3, x.B)!;
    assert.equal(b.status, 'error');
    assert.match(b.error ?? '', /游戏目录不存在或无法访问/);
    assert.equal(b.nextCheckAt, x.clock.t + CHECK_INTERVAL_MS, '长期错误按每小时');

    const good = await readFile(x.settingsFile, 'utf8');
    await writeFile(x.settingsFile, '{ broken');
    const calls = x.src.calls.length;
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    const s = x.w.snapshot();
    assert.match(s.settingsError ?? '', /无法读取艾泽魔方设置文件/);
    assert.equal(x.src.calls.length, calls, '无法确认绑定时不检查');
    assert.equal(await readFile(x.settingsFile, 'utf8'), '{ broken', '不会改写设置文件');

    await writeFile(x.settingsFile, good);
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.equal(x.w.snapshot().settingsError, null);
    assert.ok(x.src.calls.length > calls);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('写入闸门：有写操作或已冻结时自动检查推迟；闸门内的强制检查（全部更新）不等待闸门，不会死锁', async () => {
  const x = await world();
  try {
    const release = x.gate.enter(); // 启动恢复或插件写操作进行中
    x.w.start();
    await idle(x.w);
    assert.equal(x.src.calls.length, 0, '写操作进行中不开始自动检查');
    // 全部更新在闸门内发起强制检查：照常完成
    const items = await x.w.check(9, x.A, { fresh: true });
    assert.equal(items.length, 2);
    await x.clock.advance(GATE_RETRY_MS);
    await idle(x.w);
    assert.equal(x.src.calls.length, 2, '闸门仍被占用：自动检查继续推迟');
    release();
    await x.clock.advance(GATE_RETRY_MS);
    await idle(x.w);
    assert.equal(x.src.calls.filter((c) => c.endsWith(':3')).length, 1, '闸门空闲后自动检查进行');

    const token = x.gate.freeze(); // 客户端安装或退出
    const n = x.src.calls.length;
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.equal(x.src.calls.length, n, '冻结期间不自动检查');
    x.gate.unfreeze(token);
    await x.clock.advance(GATE_RETRY_MS);
    await idle(x.w);
    assert.ok(x.src.calls.length > n);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('停止：进行中的检查立即中止，不再查询剩余插件；等待中的调用被拒绝，迟到的结果不会发布为“最新”', async () => {
  const x = await world({ extraA: 5 });
  try {
    x.src.hold = true;
    const manual = x.w.check(9, x.A);
    await until(() => x.src.waiting === 3, '3 个请求挂起');
    const queued = x.w.check(3, x.B);
    x.w.stop();
    await assert.rejects(manual, /停止检查/);
    await assert.rejects(queued, /停止检查/);
    x.src.release();
    await sleep(30);
    assert.equal(x.src.calls.length, 3, '中止后不再查询 A 中剩余的 4 个插件，也不检查 B');
    assert.ok(x.snaps.every((s) => s.entries.every((e) => e.status !== 'ok')), '没有发布任何“最新”结果');
    await assert.rejects(x.w.check(9, x.A), /停止检查/);
  } finally {
    await cleanup(x.base);
  }
});

test('绑定变化：解绑或换绑丢弃旧目录结果；A→B→A 期间在途的旧回包不会发布到重新绑定的 A', async () => {
  const x = await world();
  try {
    x.w.start();
    await idle(x.w);
    assert.ok(x.entry(9, x.A));
    // 解绑 3：B 的结果立即消失
    await x.settings.bind(3, null);
    await x.w.bindingsChanged();
    assert.equal(x.entry(3, x.B), undefined);

    // A 的检查在途时：9 换绑到 C 再换回 A（数据源忽略中止信号，模拟迟到的回包）
    const C = await makeGameRoot(path.join(x.base, 'C'));
    x.src.hold = true;
    x.src.ignoreAbort = true;
    const late = x.w.check(9, x.A, { fresh: true });
    await until(() => x.src.waiting === 2, 'A 的请求挂起');
    const release = x.gate.enter(); // 之后的自动检查推迟，只观察迟到回包
    await x.settings.bind(9, C);
    await x.w.bindingsChanged();
    assert.equal(x.entry(9, x.A), undefined);
    assert.ok(x.entry(9, C));
    await x.settings.bind(9, x.A);
    await x.w.bindingsChanged();
    const fresh = x.entry(9, x.A)!;
    assert.equal(fresh.status, 'pending');
    x.src.release();
    await assert.rejects(late, /绑定已变更/);
    await sleep(20);
    const a = x.entry(9, x.A)!;
    assert.equal(a.status, 'pending', '旧回包没有发布');
    assert.deepEqual(a.items, []);
    assert.equal(a.checkedAt, null);
    release();
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('写操作：检查期间清单变化或有写操作完成，结果不发布；写后按新清单只读重校验，不发起网络请求', async () => {
  const x = await world();
  try {
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    // 1. 检查期间更新了 M1（指纹变化）：作废的结果既不发布也不交给调用方，自动重查后返回与当前清单一致的结果
    x.src.hold = true;
    const first = x.w.check(9, x.A);
    await until(() => x.src.waiting === 2, '请求挂起');
    await x.writer.install(x.A, 9, '1');
    x.src.release();
    const returned = await first;
    assert.equal(returned.find((i) => i.modId === '1')?.installedFileId, '2', '调用方拿到的是重查后的有效结果');
    assert.equal(returned.find((i) => i.modId === '1')?.hasUpdate, false);
    assert.equal(x.src.calls.length, 4, '作废后重查了一次');
    assert.ok(!x.snaps.some((s) => s.entries.some((e) => e.items.some((i) => i.modId === '1' && i.installedFileId === '1'))), '作废的结果从未发布');
    let a = x.entry(9, x.A)!;
    assert.equal(a.status, 'ok');

    // 2. 正常检查发现 M2 可更新；随后更新 M2 并写后通知：按新清单重校验
    x.fake.set('2', 9, { name: 'M2', fileId: '3', zip: zipOf('M2', 'v3') });
    await x.w.check(9, x.A);
    a = x.entry(9, x.A)!;
    assert.equal(a.pending, 1);
    assert.equal(a.items.find((i) => i.modId === '2')?.hasUpdate, true);
    await x.writer.install(x.A, 9, '2');
    const calls = x.src.calls.length;
    await x.w.afterWrite(9, x.A);
    a = x.entry(9, x.A)!;
    const m2 = a.items.find((i) => i.modId === '2')!;
    assert.equal(m2.hasUpdate, false, '已更新到当时检查到的最新文件');
    assert.equal(m2.installedFileId, '3');
    assert.equal(a.pending, 0);
    assert.equal(x.src.calls.length, calls, '重校验不发起网络请求');

    // 3. 写操作完成时检查在途：在途结果作废
    x.src.hold = true;
    const inflight = x.w.check(9, x.A, { fresh: true });
    await until(() => x.src.waiting === 2, '请求挂起');
    const rev = x.w.snapshot().entries.find((e) => e.flavorId === 9)!.checkedAt;
    await x.w.afterWrite(9, x.A);
    x.src.release();
    await inflight;
    assert.equal(x.entry(9, x.A)!.checkedAt, rev, '写后作废的检查没有发布');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('提醒：同一目录、同一插件、同一文件只提醒一次；出现新文件再提醒；手动检查不产生自动提醒', async () => {
  const x = await world();
  try {
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.w.start();
    await idle(x.w);
    assert.deepEqual(x.w.snapshot().notice, { seq: 1, count: 1, flavorIds: [9] });
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.equal(x.w.snapshot().notice?.seq, 1, '同一文件不重复提醒');
    x.fake.set('1', 9, { name: 'M1', fileId: '3', zip: zipOf('M1', 'v3') });
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.deepEqual(x.w.snapshot().notice, { seq: 2, count: 1, flavorIds: [9] });
    // 用户手动检查发现 M2 更新：界面自己有提示，不产生自动提醒；之后的自动检查也不再提醒它
    x.fake.set('2', 9, { name: 'M2', fileId: '2', zip: zipOf('M2', 'v2') });
    await x.w.check(9, x.A);
    assert.equal(x.w.snapshot().notice?.seq, 2);
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.equal(x.w.snapshot().notice?.seq, 2);
    assert.ok(!x.fake.calls.some((c) => c.startsWith('detail:')), '没有任何安装');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('检查中止：manager 不再查询剩余插件，以中止结束而不返回不完整的结果', async () => {
  const x = await world({ extraA: 5 });
  try {
    x.src.hold = true;
    const ac = new AbortController();
    const p = x.checker.checkUpdatesDetailed(x.A, 9, ac.signal);
    await until(() => x.src.waiting === 3, '3 个请求挂起');
    ac.abort();
    await assert.rejects(p, (err: Error) => err.name === 'AbortError');
    x.src.release();
    await sleep(20);
    assert.equal(x.src.calls.length, 3, '中止后不再遍历其余插件');
  } finally {
    await cleanup(x.base);
  }
});

// ---------- 第二轮回归 ----------

test('设置无法读取：按读取次数核对，等满一小时才重读，期间不检查任何目录；修复后恢复', async () => {
  const x = await world();
  try {
    let reads = 0;
    const load = x.settings.load.bind(x.settings);
    x.settings.load = () => (reads++, load());
    x.w.start();
    await idle(x.w);
    const latestBefore = x.src.calls.length;
    await writeFile(x.settingsFile, '{ broken');
    await x.clock.advance(CHECK_INTERVAL_MS); // 两个目录到期，读取设置失败
    await idle(x.w);
    const afterFail = reads;
    assert.match(x.w.snapshot().settingsError ?? '', /无法读取艾泽魔方设置文件/);
    for (let i = 0; i < 59; i++) {
      await x.clock.advance(MIN);
      await idle(x.w);
    }
    assert.equal(reads, afterFail, '一小时内（包括 5 分钟的定时器唤醒）都不重读设置');
    assert.equal(x.src.calls.length, latestBefore, '期间不检查任何目录');
    assert.ok([...x.clock.timers.values()].every((t) => t.at > x.clock.t), '没有立即触发的定时器');
    await x.clock.advance(MIN);
    await idle(x.w);
    assert.equal(reads, afterFail + 1, '满一小时后重读一次');
    // 用户重新绑定会立即重读，不受间隔限制
    await writeFile(x.settingsFile, JSON.stringify({ schema: 1, bindings: { 9: x.A, 3: x.B }, lastFlavorId: null }));
    await x.w.bindingsChanged();
    await idle(x.w);
    assert.equal(x.w.snapshot().settingsError, null);
    assert.ok(x.src.calls.length > latestBefore);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('作废的自动检查真正推迟 30 秒（不会因为过期的 nextAt 变成每秒重试）', async () => {
  const x = await world();
  try {
    await x.settings.bind(3, null);
    x.src.hold = true;
    x.w.start();
    await until(() => x.src.waiting === 2, '自动检查挂起');
    await x.w.afterWrite(9, x.A); // 检查期间有写操作完成
    x.src.release();
    await idle(x.w);
    assert.equal(x.src.calls.length, 2);
    assert.notEqual(x.entry(9, x.A)?.status, 'ok', '作废的结果没有发布');
    await x.clock.advance(20 * 1000);
    await idle(x.w);
    assert.equal(x.src.calls.length, 2, '20 秒内没有重试');
    await x.clock.advance(10 * 1000);
    await idle(x.w);
    assert.equal(x.src.calls.length, 4, '30 秒后重查');
    assert.equal(x.entry(9, x.A)?.status, 'ok');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('全部更新（真实 runUpdateAll）：检查期间本地回退到旧文件时，作废的结果不会被当作“全部最新”，重查后照常更新', async () => {
  const x = await world();
  try {
    await x.settings.bind(3, null);
    // A 中 M1 先更新到 2（远端最新也是 2）
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    await x.writer.install(x.A, 9, '1');
    // 另一个数据源提供旧文件 1，用来在检查期间把本地改回 1
    const old = new FakeSource();
    old.set('1', 9, { name: 'M1', fileId: '1', zip: zipOf('M1', 'v1') });
    const rollback = makeManager(old);
    let installs = 0;
    x.src.hold = true;
    const result = runUpdateAll({
      manager: x.checker,
      root: x.A,
      flavorId: 9,
      isStillBound: async () => true,
      installOne: async () => (installs++, { ok: true, message: 'ok' }),
      check: (r, f) => x.w.check(f, r, { fresh: true }),
    });
    await until(() => x.src.waiting === 2, '批次检查挂起');
    const release = x.gate.enter(); // 批次在写入闸门内：强制检查不能等待闸门
    await rollback.install(x.A, 9, '1');
    void x.w.afterWrite(9, x.A);
    x.src.release();
    const r = await result;
    release();
    assert.equal(installs, 1, '重查后发现 M1 需要更新');
    assert.doesNotMatch(r.message, /最新版本/);
    assert.match(r.message, /已更新 1 个插件/);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('结果持续作废：重查次数用尽后明确拒绝，绝不返回作废的结果', async () => {
  const x = await world();
  try {
    let checks = 0;
    const flaky = {
      checkUpdatesDetailed: (root: string, f: number, s?: AbortSignal) => (checks++, x.checker.checkUpdatesDetailed(root, f, s)),
      // 每次读到的清单都不同：模拟检查期间清单不断变化
      readCheckedManifest: async (root: string) => ({ ...(await x.checker.readCheckedManifest(root)), fingerprint: `changing-${Math.random()}` }),
    };
    const w = new AddonUpdateWatch({ settings: x.settings, checker: flaky, gate: x.gate, clock: x.clock });
    let installs = 0;
    await assert.rejects(
      runUpdateAll({ manager: x.checker, root: x.A, flavorId: 9, isStillBound: async () => true, installOne: async () => (installs++, { ok: true, message: '' }), check: (r, f) => w.check(f, r, { fresh: true }) }),
      /结果已作废/,
    );
    assert.equal(checks, 3, '首次检查 + 2 次重查');
    assert.equal(installs, 0);
    assert.equal(w.snapshot().entries.find((e) => e.flavorId === 9)?.checkedAt, null, '没有发布');
    w.stop();
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('提醒随结果失效：换绑后同一版本的新目录不继承旧目录的提醒；写操作后已更新的插件不再计入提醒', async () => {
  const x = await world();
  try {
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.w.start();
    await idle(x.w);
    assert.equal(x.w.snapshot().notice?.count, 1);
    // 写操作：M1 更新完成后提醒消失
    await x.writer.install(x.A, 9, '1');
    await x.w.afterWrite(9, x.A);
    assert.equal(x.w.snapshot().notice, null);

    // 新文件 3 再次提醒；随后 9 换绑到 C（同一版本的新目录）
    x.fake.set('1', 9, { name: 'M1', fileId: '3', zip: zipOf('M1', 'v3') });
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.deepEqual(x.w.snapshot().notice, { seq: 2, count: 1, flavorIds: [9] });
    const C = await makeGameRoot(path.join(x.base, 'C'));
    await x.settings.bind(9, C);
    x.w.invalidateFlavor(9);
    assert.equal(x.w.snapshot().notice, null, '绑定变更时立即清除，不等异步同步');
    assert.equal(x.entry(9, x.A), undefined);
    await x.w.bindingsChanged();
    await idle(x.w);
    assert.equal(x.w.snapshot().notice, null, '新目录没有继承旧目录的提醒');
    assert.equal(x.entry(9, C)?.status, 'ok');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('写后清单无法读取：不再显示旧结论，标为无法确认；只检查支持的游戏版本，设置中的未知版本键原样保留', async () => {
  const x = await world();
  try {
    let unreadable = false;
    const checker = {
      checkUpdatesDetailed: x.checker.checkUpdatesDetailed.bind(x.checker),
      readCheckedManifest: async (root: string) => {
        if (unreadable) throw new Error('EIO: 读取失败');
        return x.checker.readCheckedManifest(root);
      },
    };
    const raw = JSON.stringify({ schema: 1, bindings: { 9: x.A, 999: path.join(x.base, 'future') }, lastFlavorId: null, extra: 'keep' });
    await writeFile(x.settingsFile, raw);
    const w = new AddonUpdateWatch({ settings: x.settings, checker, gate: x.gate, clock: x.clock });
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    w.start();
    await idle(w);
    assert.deepEqual(w.snapshot().entries.map((e) => e.flavorId), [9], '不支持的版本 999 没有加入检查');
    assert.ok(!x.src.calls.some((c) => c.endsWith(':999')));
    assert.equal(await readFile(x.settingsFile, 'utf8'), raw, '设置文件原样保留');
    assert.equal(w.snapshot().entries[0].pending, 1);

    unreadable = true;
    await w.afterWrite(9, x.A);
    const e = w.snapshot().entries[0];
    assert.equal(e.status, 'error');
    assert.match(e.error ?? '', /无法确认更新状态/);
    assert.equal(e.pending, 0);
    assert.deepEqual(e.items, []);
    assert.equal(w.snapshot().notice, null);
    w.stop();
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

// ---------- 第三轮回归 ----------

/** 让设置读取可控地失败，并统计读取次数（只包装读取，不改设置文件） */
function controlledSettings(x: Awaited<ReturnType<typeof world>>) {
  const ctl = { reads: 0, broken: false };
  const load = x.settings.load.bind(x.settings);
  x.settings.load = async () => {
    ctl.reads++;
    if (ctl.broken) throw new UserError('无法读取艾泽魔方设置文件（测试）：读取失败（EACCES）', 'settings');
    return load();
  };
  return ctl;
}

test('多目录：一个检查发布前读设置失败后，排队中的其他自动检查不再开始；一小时内不读设置、不查网络，期满且设置恢复后两个目录都重新检查', async () => {
  const x = await world();
  try {
    const ctl = controlledSettings(x);
    x.src.hold = true;
    x.w.start();
    await until(() => x.src.waiting === 1, '第一个目录（B）的检查挂起');
    assert.equal(ctl.reads, 1, '启动同步读取一次');
    ctl.broken = true;
    x.src.release();
    await idle(x.w);
    assert.equal(x.src.calls.length, 1, '第二个目录（A）的自动检查没有开始');
    assert.equal(ctl.reads, 2, 'B 发布前读取一次（失败），之后没有再读');
    assert.match(x.w.snapshot().settingsError ?? '', /无法读取艾泽魔方设置文件/);
    assert.ok(x.w.snapshot().entries.every((e) => e.status === 'error' && e.items.length === 0), '所有目录都标为无法确认');
    for (let i = 0; i < 59; i++) {
      await x.clock.advance(MIN);
      await idle(x.w);
    }
    assert.equal(ctl.reads, 2);
    assert.equal(x.src.calls.length, 1);
    ctl.broken = false;
    await x.clock.advance(MIN);
    await idle(x.w);
    assert.equal(x.w.snapshot().settingsError, null);
    assert.equal(x.src.calls.length, 4, '设置恢复后 B（1 个插件）与 A（2 个插件）都重新检查');
    assert.deepEqual(x.w.snapshot().entries.map((e) => e.status), ['ok', 'ok']);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('设置读取失败期间，用户手动 / 全部更新的检查不被排队的自动检查堵住；闸门内的强制检查不死锁', async () => {
  const x = await world();
  try {
    const ctl = controlledSettings(x);
    x.w.start();
    await idle(x.w);
    ctl.broken = true;
    await x.clock.advance(CHECK_INTERVAL_MS);
    await idle(x.w);
    assert.ok(x.w.snapshot().settingsError);
    const release = x.gate.enter();
    // 设置仍不可读：显式检查照常执行，但无法确认绑定，明确拒绝而不是挂起
    await assert.rejects(x.w.check(9, x.A, { fresh: true }), /无法读取艾泽魔方设置文件/);
    ctl.broken = false;
    const items = await x.w.check(9, x.A, { fresh: true });
    assert.equal(items.length, 2, '设置恢复后显式检查立即成功（不受一小时期限限制）');
    release();
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('检查后读回清单失败：结果不发布，标为无法确认并按错误间隔退避，等待者收到错误', async () => {
  const x = await world();
  try {
    await x.settings.bind(3, null);
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    let readbackFails = true;
    const checker = {
      checkUpdatesDetailed: x.checker.checkUpdatesDetailed.bind(x.checker),
      readCheckedManifest: async (root: string) => {
        if (readbackFails) throw new Error('manifest no longer readable');
        return x.checker.readCheckedManifest(root);
      },
    };
    const w = new AddonUpdateWatch({ settings: x.settings, checker, gate: x.gate, clock: x.clock });
    await assert.rejects(w.check(9, x.A, { fresh: true }), /manifest no longer readable/);
    const e = w.snapshot().entries.find((i) => i.flavorId === 9)!;
    assert.equal(e.status, 'error');
    assert.match(e.error ?? '', /检查后无法读取插件清单/);
    assert.equal(e.pending, 0);
    assert.deepEqual(e.items, []);
    assert.equal(w.snapshot().notice, null);
    w.start();
    await idle(w);
    assert.equal(w.snapshot().entries[0].nextCheckAt, x.clock.t + CHECK_INTERVAL_MS, '非临时错误按每小时，不立即重试');
    readbackFails = false;
    await w.check(9, x.A);
    assert.equal(w.snapshot().entries[0].status, 'ok');
    assert.equal(w.snapshot().entries[0].pending, 1);
    w.stop();
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('设置恢复：检查中读设置失败后，修复并手动检查成功即清除全局错误、恢复自动调度；其他目录的旧结论不会被放出，而是重新检查', async () => {
  const x = await world();
  try {
    const ctl = controlledSettings(x);
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.w.start();
    await idle(x.w);
    assert.equal(x.entry(9, x.A)?.pending, 1);
    ctl.broken = true;
    await assert.rejects(x.w.check(3, x.B, { fresh: true }), /无法读取艾泽魔方设置文件/);
    let s = x.w.snapshot();
    assert.ok(s.settingsError);
    assert.equal(x.entry(9, x.A)?.pending, 0, 'A 的旧结论在设置不可读时作废');
    assert.ok(s.entries.every((e) => e.nextCheckAt === null));

    ctl.broken = false;
    const calls = x.src.calls.length;
    await x.w.check(3, x.B, { fresh: true });
    s = x.w.snapshot();
    assert.equal(s.settingsError, null, '成功读取设置后清除全局错误');
    assert.ok(s.entries.every((e) => e.nextCheckAt !== null), '自动调度恢复');
    const a = x.entry(9, x.A)!;
    assert.equal(a.status, 'pending', 'A 没有沿用旧结论，等待重新检查');
    assert.deepEqual(a.items, []);
    assert.equal(x.src.calls.length, calls + 1, '只查询了 B');
    await idle(x.w);
    await x.clock.advance(1000);
    await idle(x.w);
    assert.equal(x.entry(9, x.A)?.status, 'ok', 'A 随即自动重新检查');
    assert.equal(x.entry(9, x.A)?.pending, 1);
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

test('没有任何目录时设置读取失败：重读期限一到照常读取一次设置并清除错误，不会每秒空转', async () => {
  const x = await world();
  try {
    const ctl = controlledSettings(x);
    x.w.start();
    await idle(x.w);
    assert.equal(ctl.reads, 3, '启动同步 1 次 + 两个目录发布前各 1 次');
    // 两个版本都被解绑：目录列表变空，随后同步时设置读取失败
    x.w.invalidateFlavor(3);
    x.w.invalidateFlavor(9);
    assert.equal(x.w.snapshot().entries.length, 0);
    ctl.broken = true;
    await x.w.bindingsChanged();
    await idle(x.w);
    assert.equal(ctl.reads, 4);
    assert.ok(x.w.snapshot().settingsError);
    ctl.broken = false; // 用户恢复了设置文件
    for (let i = 0; i < 59; i++) {
      await x.clock.advance(MIN);
      await idle(x.w);
    }
    assert.equal(ctl.reads, 4, '期限之前不读');
    await x.clock.advance(MIN + 3000);
    await idle(x.w);
    assert.equal(ctl.reads, 7, '期限到达后同步读取 1 次（第 5 次），重建的两个目录随即检查，各有 1 次发布前读取');
    assert.equal(x.w.snapshot().settingsError, null, '错误已清除');
    assert.equal(x.w.snapshot().entries.length, 2, '按设置重建目录');
    // 之后没有 1 秒的忙循环：定时器都在未来至少数秒之后
    const readsAfter = ctl.reads;
    await x.clock.advance(10 * 1000);
    await idle(x.w);
    assert.ok([...x.clock.timers.values()].every((t) => t.at - x.clock.t > 1000), '没有每秒触发的定时器');
    assert.equal(ctl.reads, readsAfter, '恢复后不再反复读取设置');
  } finally {
    x.w.stop();
    await cleanup(x.base);
  }
});

// ---------- 0.1.7 回归：写后回读重叠 ----------

/**
 * 读回可控的检查接口：hold 时每次读回立即读取当时的清单，但等测试放行才交出结果（或以给定错误失败）。
 * 用来让两次写后回读按指定顺序返回。
 */
function heldReadback(x: Awaited<ReturnType<typeof world>>) {
  const held: { ok: () => void; fail: (err: unknown) => void }[] = [];
  const ctl = { hold: false, held };
  const checker = {
    checkUpdatesDetailed: x.checker.checkUpdatesDetailed.bind(x.checker),
    readCheckedManifest: async (root: string) => {
      if (!ctl.hold) return x.checker.readCheckedManifest(root);
      const value = await x.checker.readCheckedManifest(root);
      return new Promise<typeof value>((resolve, reject) => held.push({ ok: () => resolve(value), fail: reject }));
    },
  };
  return { ctl, checker };
}

/**
 * 目录 A 的 M1、M2 都有新文件（2），自动结果显示 2 个可更新；随后依次更新 M1、M2，各自触发一次写后回读：
 * 旧回读看到 M1=2、M2=1，新回读看到两者都是 2。按 order 放行，返回最终的目录状态与放行第一个之后的快照数。
 */
async function overlap(order: 'old-first' | 'new-first', oldOk: boolean, newOk: boolean) {
  const x = await world();
  const { ctl, checker } = heldReadback(x);
  const snaps: AddonWatchSnapshot[] = [];
  const w = new AddonUpdateWatch({ settings: x.settings, checker, gate: x.gate, clock: x.clock, onChange: (s) => snaps.push(s) });
  try {
    x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
    x.fake.set('2', 9, { name: 'M2', fileId: '2', zip: zipOf('M2', 'v2') });
    await w.check(9, x.A);
    assert.equal(w.snapshot().entries.find((e) => e.flavorId === 9)!.pending, 2);
    ctl.hold = true;
    await x.writer.install(x.A, 9, '1');
    const a1 = w.afterWrite(9, x.A);
    await until(() => ctl.held.length === 1, '旧回读已读取清单');
    await x.writer.install(x.A, 9, '2');
    const a2 = w.afterWrite(9, x.A);
    await until(() => ctl.held.length === 2, '新回读已读取清单');
    const [oldR, newR] = ctl.held;
    const settle = (r: (typeof ctl.held)[number], ok: boolean) => (ok ? r.ok() : r.fail(new Error('EIO: 读取失败')));
    const first = order === 'old-first' ? [oldR, oldOk, a1] as const : [newR, newOk, a2] as const;
    const second = order === 'old-first' ? [newR, newOk, a2] as const : [oldR, oldOk, a1] as const;
    settle(first[0], first[1]);
    await first[2];
    const afterFirst = snaps.length;
    settle(second[0], second[1]);
    await second[2];
    return { entry: w.snapshot().entries.find((e) => e.flavorId === 9)!, afterFirst, total: snaps.length };
  } finally {
    w.stop();
    x.w.stop();
    await cleanup(x.base);
  }
}

test('F3 写后回读重叠（都成功）：无论哪个先返回，都以最近一次写入的回读为准，不残留已更新插件的提醒', async () => {
  for (const order of ['old-first', 'new-first'] as const) {
    const { entry, afterFirst, total } = await overlap(order, true, true);
    assert.equal(entry.status, 'ok', order);
    assert.equal(entry.pending, 0, `${order}：两项都已更新，不应残留可更新`);
    assert.deepEqual(entry.items.map((i) => [i.modId, i.installedFileId, i.hasUpdate]).sort(), [['1', '2', false], ['2', '2', false]], order);
    if (order === 'new-first') assert.equal(total, afterFirst, '新结果发布后，迟到的旧回读不再发布');
  }
});

test('F3 写后回读重叠（失败）：旧回读失败不覆盖新结果；新回读失败时如实标为无法确认，旧回读不能把它改回旧结论', async () => {
  for (const order of ['old-first', 'new-first'] as const) {
    const oldFails = await overlap(order, false, true);
    assert.equal(oldFails.entry.status, 'ok', `${order}：旧回读失败不进入 error`);
    assert.equal(oldFails.entry.error, null);
    assert.equal(oldFails.entry.pending, 0);

    const newFails = await overlap(order, true, false);
    assert.equal(newFails.entry.status, 'error', `${order}：最近一次回读失败时无法确认`);
    assert.match(newFails.entry.error ?? '', /无法确认更新状态/);
    assert.deepEqual(newFails.entry.items, []);
  }
});

test('F3 写后回读与手动检查交错：回读等待期间手动检查已发布结果时，迟到的回读不覆盖（rev）；换绑后迟到的回读不发布', async () => {
  // 1. 手动检查交错
  {
    const x = await world();
    const { ctl, checker } = heldReadback(x);
    const w = new AddonUpdateWatch({ settings: x.settings, checker, gate: x.gate, clock: x.clock });
    try {
      x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
      x.fake.set('2', 9, { name: 'M2', fileId: '2', zip: zipOf('M2', 'v2') });
      await w.check(9, x.A);
      ctl.hold = true;
      await x.writer.install(x.A, 9, '1');
      const a1 = w.afterWrite(9, x.A);
      await until(() => ctl.held.length === 1, '回读已读取清单');
      ctl.hold = false;
      await x.writer.install(x.A, 9, '2'); // 没有经过协调器的写入（例如外部改动），由手动检查发现
      const items = await w.check(9, x.A, { fresh: true });
      assert.equal(items.filter((i) => i.hasUpdate).length, 0, '回读等待期间开始的手动检查照常发布，不被当作作废');
      const published = w.snapshot().entries.find((e) => e.flavorId === 9)!;
      ctl.held[0].ok();
      await a1;
      assert.deepEqual(w.snapshot().entries.find((e) => e.flavorId === 9), published, '迟到的旧回读没有覆盖手动检查的结果');
    } finally {
      w.stop();
      x.w.stop();
      await cleanup(x.base);
    }
  }
  // 2. 换绑：回读等待期间该版本绑定变化
  {
    const x = await world();
    const { ctl, checker } = heldReadback(x);
    const snaps: AddonWatchSnapshot[] = [];
    const w = new AddonUpdateWatch({ settings: x.settings, checker, gate: x.gate, clock: x.clock, onChange: (s) => snaps.push(s) });
    try {
      x.fake.set('1', 9, { name: 'M1', fileId: '2', zip: zipOf('M1', 'v2') });
      await w.check(9, x.A);
      ctl.hold = true;
      await x.writer.install(x.A, 9, '1');
      const a1 = w.afterWrite(9, x.A);
      await until(() => ctl.held.length === 1, '回读已读取清单');
      w.invalidateFlavor(9);
      const count = snaps.length;
      ctl.held[0].ok();
      await a1;
      assert.equal(snaps.length, count, '换绑后迟到的回读不发布');
      assert.equal(w.snapshot().entries.find((e) => e.flavorId === 9), undefined);
    } finally {
      w.stop();
      x.w.stop();
      await cleanup(x.base);
    }
  }
});
