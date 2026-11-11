// 只读健康检查的接入（0.2.0）：真实 preload → 真实 AppService（假 electron）→ AddonManager.health → scanAddonHealth → 临时目录。
// 发送方与参数、绑定目标校验；残留 journal / 暂存 / 待删除回收项时前后逐字节不变（不恢复、不清理）；不联网、不加载配置；
// 与同目录写操作串行；同一目录的重复请求复用同一次检查。全部在临时目录中进行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagerOptions } from '../src/core/manager';
import type { RemoteConfig } from '../src/core/provider';
import type { HealthReport } from '../src/shared/types';
import { addonEntries, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { createHarness, ipcCalls, readManifestJson, recordOf, snapshot } from './ipc-harness';

const F = 9;
const zipOf = (folder: string, v: string) => makeZip(addonEntries(folder, v));
const tick = () => new Promise((r) => setImmediate(r));

class ConfigSource extends FakeSource {
  configCalls = 0;
  config: RemoteConfig | null = null;
  async getConfig(): Promise<RemoteConfig> {
    this.configCalls++;
    if (!this.config) throw new Error('配置不可用（测试）');
    return this.config;
  }
}

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 目录 A：托管 100（ModM，文件 1）；未托管 Needs 声明缺失的必需依赖 */
async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new ConfigSource();
  src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
  await makeManager(src).install(A, F, '100');
  await mkdir(path.join(A, 'Interface', 'AddOns', 'Needs'));
  await writeFile(path.join(A, 'Interface', 'AddOns', 'Needs', 'Needs.toc'), '## Interface: 16001\n## Title: Needs\n## Dependencies: MissingLib, <img onerror=x>\n');
  const ctl = { hold: false, started: 0, waiting: [] as (() => void)[] };
  const download: NonNullable<ManagerOptions['download']> = async (url, dest) => {
    ctl.started++;
    if (ctl.hold) await new Promise<void>((r) => ctl.waiting.push(r));
    return src.download(url, dest);
  };
  const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src, download });
  await h.policy.reload();
  await h.settings.bind(F, A);
  src.calls.length = 0;
  return { base, A, src, h, ctl };
}

test('健康检查 IPC：只接受主窗口的请求、合法的游戏版本与当前绑定的期望目录；结果属于该目标', async () => {
  const { base, A, h } = await setup();
  try {
    const handler = h.stub.handlers.get('health:check')!;
    await assert.rejects(handler({ sender: {}, senderFrame: { url: 'https://evil.example/' } }, F, A), /拒绝来自未知页面/);
    await assert.rejects(h.api.healthCheck(999, A), /不支持的游戏版本/);
    await assert.rejects(h.api.healthCheck('9' as unknown as number, A), /不支持的游戏版本/);
    await assert.rejects(h.api.healthCheck(F, 'relative/path'), /目标目录参数无效/);
    await assert.rejects(h.api.healthCheck(F, path.join(base, 'elsewhere')), /绑定已变更/);
    await assert.rejects(h.api.healthCheck(2, A), /请先为当前游戏版本选择游戏目录/);

    const r = await h.api.healthCheck(F, A);
    assert.deepEqual([r.root, r.flavorId, r.manifestState], [A, F, 'ok']);
    assert.ok(r.issues.some((i) => i.kind === 'dep-required-missing' && i.folder === 'Needs' && i.detail === 'MissingLib'));
    assert.ok(r.scope.length > 0);
    assert.equal(r.reference.source, 'addon-library-config');
    assert.equal(r.reference.interfaceNumber, null, '没有加载过插件库配置：参考值未知');
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(base);
  }
});

test('健康检查只读：残留的暂存、待删除回收项前后逐字节不变；有未完成的 journal 时无法检查且不恢复；不写设置、记录或策略', async () => {
  const { base, A, h } = await setup();
  try {
    const meta = path.join(A, 'Interface', '.beelite');
    await mkdir(path.join(meta, 'staging', 'leftover'), { recursive: true });
    await writeFile(path.join(meta, 'staging', 'leftover', 'x.txt'), '暂存残留');
    await mkdir(path.join(meta, 'trash', 'abc-123456'), { recursive: true });
    await writeFile(path.join(meta, 'trash', 'abc-123456', 'old.lua'), '待删除');
    const manifest = await readManifestJson(A);
    await writeFile(path.join(meta, 'manifest.json'), JSON.stringify({ ...manifest, purgeQueue: ['abc-123456'] }, null, 1));
    const settings0 = await readFile(path.join(base, 'settings.json'));
    const before = await snapshot(A);

    const r = await h.api.healthCheck(F, A);
    assert.notEqual(r.status, 'unavailable');
    assert.deepEqual(await snapshot(A), before, '暂存与待删除项都没有被清理');

    await writeFile(path.join(meta, 'journal.json'), '{"未完成":');
    const withJournal = await snapshot(A);
    const r2 = await h.api.healthCheck(F, A);
    assert.equal(r2.status, 'unavailable');
    assert.equal(r2.unavailableReason, 'pending-operation');
    assert.deepEqual(await snapshot(A), withJournal, '不恢复、不删除 journal');

    assert.deepEqual(await readFile(path.join(base, 'settings.json')), settings0);
    assert.equal(await exists(path.join(base, 'operation-history.json')), false, '健康检查不写操作记录');
    assert.equal(await exists(path.join(base, 'addon-policy.json')), false);
    assert.ok(!ipcCalls.some((c) => c.channel === 'local:state'), '没有读取会恢复目录的本地状态');

    // 对照：恢复确实会改动这些内容（说明上面的快照能发现清理）
    await rm(path.join(meta, 'journal.json'));
    await h.service.manager.recover(A);
    assert.notDeepEqual(await snapshot(A), before);
  } finally {
    await cleanup(base);
  }
});

test('健康检查不联网、不加载配置；参考值只来自之前已加载的插件库配置，加载失败后为未知', async () => {
  const { base, A, src, h } = await setup();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error('不应联网');
  }) as typeof fetch;
  try {
    await h.api.healthCheck(F, A);
    assert.deepEqual([src.calls.length, src.configCalls, fetches], [0, 0, 0]);

    src.config = { flavors: [{ id: F, name: '无限', versions: ['1.60.1'] }], categories: [] };
    await h.api.getConfig();
    assert.equal(src.configCalls, 1);
    const r = await h.api.healthCheck(F, A);
    assert.deepEqual(r.reference, { interfaceNumber: 16001, source: 'addon-library-config' });
    assert.equal(src.configCalls, 1, '检查本身没有加载配置');

    src.config = null;
    const cfg = await h.api.getConfig();
    assert.ok(cfg.configError);
    assert.equal((await h.api.healthCheck(F, A)).reference.interfaceNumber, null, '配置加载失败后不沿用旧的参考值');
    assert.deepEqual([src.calls.length, fetches], [0, 0]);
  } finally {
    globalThis.fetch = realFetch;
    await cleanup(base);
  }
});

test('健康检查与同目录的写操作串行：安装持有目录锁时排队等待，结束后才读取', async () => {
  const { base, A, src, h, ctl } = await setup();
  try {
    src.set('100', F, { name: 'M', fileId: '2', zip: zipOf('ModM', 'v2') });
    ctl.hold = true;
    const order: string[] = [];
    // 以安装事务本身（目录锁内）的结束为准；IPC 回复还要等提交后的记录写入
    const manager = h.service.manager;
    const install = manager.install.bind(manager);
    manager.install = async (...a: Parameters<typeof install>) => {
      const r = await install(...a);
      order.push('update');
      return r;
    };
    const upd = h.api.update('100', F, false, await recordOf(A, '100'), A);
    await until(() => ctl.started === 1, '下载开始（已持有目录锁）');
    const check = h.api.healthCheck(F, A).then((r) => {
      order.push('health');
      return r;
    });
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(order, [], '安装进行中，检查仍在排队');
    ctl.hold = false;
    ctl.waiting.splice(0).forEach((r) => r());
    await Promise.all([upd, check]);
    assert.deepEqual(order, ['update', 'health']);
    assert.equal((await readManifestJson(A)).projects['100'].fileId, '2');
  } finally {
    await cleanup(base);
  }
});

test('同一目录重复请求复用进行中的检查，不并发扫描；结束后再次请求重新检查', async () => {
  const { base, A, h } = await setup();
  try {
    const manager = h.service.manager;
    const original = manager.health.bind(manager);
    let scans = 0;
    const gate: { open: (() => void) | null } = { open: null };
    manager.health = async (...a: Parameters<typeof original>) => {
      scans++;
      await new Promise<void>((r) => (gate.open = r));
      return original(...a);
    };
    const one = h.api.healthCheck(F, A);
    const two = h.api.healthCheck(F, A);
    await until(() => gate.open !== null, '检查开始');
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(scans, 1);
    gate.open!();
    const [a, b]: HealthReport[] = await Promise.all([one, two]);
    assert.deepEqual(a, b);
    gate.open = null;
    const three = h.api.healthCheck(F, A);
    await until(() => gate.open !== null, '再次检查开始');
    gate.open!();
    await three;
    assert.equal(scans, 2);
  } finally {
    await cleanup(base);
  }
});
