// 文件编号的统一约定（0.1.7）：远端解析、manager 提交前、本地清单与 IPC 使用同一规则。
// 远端返回的编号超出本地清单能保存的范围时，必须在下载与事务开始之前拒绝，不能写进清单后锁住整个目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalFileId, FILE_ID_RE, MAX_FILE_ID } from '../src/core/file-id';
import { AddonManager } from '../src/core/manager';
import type { FetchFn } from '../src/core/net';
import { CONFIG_URL, NewBeeBoxProvider, parseLatest } from '../src/core/provider';
import { parseManifest } from '../src/core/store';
import { addonEntries, cleanup, exists, FakeSource, fixture, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';
import { createHarness, snapshot } from './ipc-harness';

const F = 9;
const MOD = '31505';
const FLAVOR_VERSIONS = ['1.60.1'];

/** 远端合法的形式：规范为十进制字符串 */
const VALID: [unknown, string][] = [
  [1, '1'],
  ['1', '1'],
  [673432, '673432'],
  ['123', '123'],
  ['007', '7'],
  [MAX_FILE_ID, '999999999999999'],
  ['999999999999999', '999999999999999'],
  [1e14, '100000000000000'],
];

/** 远端不合法的形式：超出 15 位、不安全整数、非正数、小数、科学计数法 / 十六进制 / 带空白的字符串、其他类型 */
const INVALID: unknown[] = [
  1e15,
  '1000000000000000',
  Number.MAX_SAFE_INTEGER,
  '9007199254740993',
  1e21,
  '1e21',
  '1e3',
  '0x10',
  ' 12',
  '12 ',
  '1.0',
  '1.5',
  1.5,
  0,
  '0',
  '000',
  -1,
  '-1',
  '',
  NaN,
  Infinity,
  null,
  undefined,
  true,
  [1],
  { id: 1 },
];

test('文件编号规则：合法远端值规范为 1–15 位十进制字符串，其余一律拒绝', () => {
  for (const [v, want] of VALID) {
    assert.equal(canonicalFileId(v), want, String(v));
    assert.ok(FILE_ID_RE.test(want));
  }
  for (const v of INVALID) assert.equal(canonicalFileId(v), null, `应拒绝 ${JSON.stringify(v) ?? String(v)}`);
  assert.ok(MAX_FILE_ID < Number.MAX_SAFE_INTEGER);
});

test('parseLatest：只接受规范后的合法编号；显示名缺失时用规范后的编号', () => {
  const file = (fixture('api-file-forever.json') as { data: Record<string, unknown> }).data;
  for (const [v, want] of VALID) {
    const r = parseLatest({ ...file, t_id: v, t_display_name: '', t_file_name: '' }, MOD, FLAVOR_VERSIONS);
    assert.equal(r.fileId, want);
    assert.equal(r.displayName, want);
  }
  for (const v of INVALID) {
    assert.throws(() => parseLatest({ ...file, t_id: v }, MOD, FLAVOR_VERSIONS), /文件编号无效/, `应拒绝 ${JSON.stringify(v) ?? String(v)}`);
  }
  const { t_id: _omit, ...missing } = file;
  assert.throws(() => parseLatest(missing, MOD, FLAVOR_VERSIONS), /文件编号无效/);
});

test('本地清单与 IPC 的规则不变：保留 1–15 位数字（含旧版本可能写入的 0 与前导零），不扩展到 16 位', () => {
  const manifest = (fileId: string) =>
    JSON.stringify({ schema: 1, lastTxId: null, projects: { 1: { modId: '1', flavorId: F, fileId, version: 'v', name: 'X', logo: null, folders: ['X'], installedAt: 1 } }, recovery: [], purgeQueue: [] });
  for (const id of ['1', '0', '007', '999999999999999', '000000000000001']) assert.equal(parseManifest(manifest(id)).projects['1'].fileId, id, id);
  for (const id of ['1000000000000000', '9007199254740993', '1e3', ' 1', '']) assert.throws(() => parseManifest(manifest(id)), /项目版本/, id);
});

/** 真实 provider + 内存接口：t_id 可变；下载调用全部记录 */
function remote(zip: () => Buffer) {
  let tId: unknown = 1;
  const posts: string[] = [];
  const downloads: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchFn: FetchFn = async (url) => {
    if (url === CONFIG_URL) return json(fixture('api-config.json'));
    posts.push(new URL(url).pathname);
    if (url.endsWith('/v3/mod/detail')) return json(fixture('api-detail-forever.json'));
    if (url.endsWith('/v3/mod_file/mod_file_latest')) {
      const file = fixture('api-file-forever.json') as { data: Record<string, unknown> };
      return json({ ...file, data: { ...file.data, t_id: tId, t_file_length: zip().length, file_folders: ['OpenMap'] } });
    }
    throw new Error(`意外的请求：${url}`);
  };
  const provider = new NewBeeBoxProvider(fetchFn);
  const manager = new AddonManager({
    source: provider,
    confirm: async () => true,
    download: async (url, dest) => {
      downloads.push(url);
      const z = zip();
      await writeFile(dest, z, { flag: 'wx' });
      return { bytes: z.length, md5: createHash('md5').update(z).digest('hex') };
    },
  });
  return { provider, manager, posts, downloads, setId: (v: unknown) => (tId = v) };
}

test('F1 首次安装：远端编号不合法时不下载、不创建 .beelite，游戏目录（含 WTF）逐字节不变', async () => {
  const base = await realpath(await tmpDir());
  try {
    const root = await makeGameRoot(base);
    const r = remote(() => makeZip(addonEntries('OpenMap', 'v1')));
    const before = await snapshot(root);
    for (const bad of [1e15, '1000000000000000', '9007199254740993', 1e21, 0, '1e3', 1.5]) {
      r.setId(bad);
      await assert.rejects(r.manager.install(root, F, MOD, { expect: { kind: 'absent' } }), /文件编号无效/, String(bad));
    }
    assert.deepEqual(r.downloads, [], '没有发起下载');
    assert.equal(await exists(path.join(root, 'Interface', '.beelite')), false, '没有创建数据目录');
    assert.deepEqual(await snapshot(root), before);
    // 合法的最大编号可以正常安装，并原样写入清单
    r.setId(MAX_FILE_ID);
    assert.ok((await r.manager.install(root, F, MOD, { expect: { kind: 'absent' } })).ok);
    assert.equal((await r.manager.readManifestFor(root)).projects[MOD].fileId, '999999999999999');
  } finally {
    await cleanup(base);
  }
});

test('F1 更新：远端返回 16 位或不安全编号时不下载、清单与插件不变，之后目录照常可读、可更新、可卸载', async () => {
  const base = await realpath(await tmpDir());
  try {
    const root = await makeGameRoot(base);
    let version = 'v1';
    const r = remote(() => makeZip(addonEntries('OpenMap', version)));
    r.setId(673432);
    await r.manager.install(root, F, MOD, { expect: { kind: 'absent' } });
    const rec = (await r.manager.readManifestFor(root)).projects[MOD];
    const before = await snapshot(root);
    const downloads = r.downloads.length;
    version = 'v2';
    for (const bad of [1e15, '1000000000000000', '9007199254740993', '1e21', -1]) {
      r.setId(bad);
      await assert.rejects(r.manager.install(root, F, MOD, { expect: { kind: 'record', fileId: rec.fileId, installedAt: rec.installedAt } }), /文件编号无效/, String(bad));
      await assert.rejects(r.provider.latest(MOD, F), /文件编号无效/);
    }
    assert.equal(r.downloads.length, downloads, '没有发起下载');
    assert.deepEqual(await snapshot(root), before, '清单、AddOns、回收站、暂存与 WTF 都没有变化');
    const st = await r.manager.localState({ flavorId: F, root, addonsPath: null }, F);
    assert.equal(st.dir?.status, 'ok');
    assert.equal(st.managed.length, 1);
    // 检查更新时不合法的编号只作为该项的错误，不会被当成可更新
    const items = await r.manager.checkUpdates(root, F);
    assert.equal(items[0].hasUpdate, false);
    assert.match(items[0].error ?? '', /文件编号无效/);
    // 远端恢复正常后照常更新与卸载
    r.setId('673433');
    assert.ok((await r.manager.install(root, F, MOD, { expect: { kind: 'record', fileId: rec.fileId, installedAt: rec.installedAt } })).ok);
    assert.equal((await r.manager.readManifestFor(root)).projects[MOD].fileId, '673433');
    assert.ok((await r.manager.uninstallProject(root, MOD)).ok);
  } finally {
    await cleanup(base);
  }
});

test('F1 纵深防御：任何数据源给出非规范的编号，manager 在加锁与下载之前拒绝', async () => {
  const base = await realpath(await tmpDir());
  try {
    const root = await makeGameRoot(base);
    const src = new FakeSource();
    const downloads: string[] = [];
    const m = new AddonManager({
      source: src,
      confirm: async () => true,
      download: async (url, dest) => {
        downloads.push(url);
        return src.download(url, dest);
      },
    });
    const before = await snapshot(root);
    for (const bad of ['1000000000000000', '007', '0', '', '1e3']) {
      src.set('1', F, { name: 'X', fileId: bad, zip: makeZip(addonEntries('X', 'v1')) });
      await assert.rejects(m.install(root, F, '1'), /文件编号无效/, bad);
    }
    assert.deepEqual(downloads, []);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await cleanup(base);
  }
});

test('F1 IPC：安装记录参数仍只接受 1–15 位数字；旧版本清单中的 0 / 前导零记录照常受理', async () => {
  const base = await realpath(await tmpDir());
  try {
    const A = await makeGameRoot(path.join(base, 'A'));
    const src = new FakeSource();
    src.set('1', F, { name: 'M1', fileId: '1', zip: makeZip(addonEntries('M1', 'v1')) });
    await makeManager(src).install(A, F, '1');
    const h = createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
    await h.settings.bind(F, A);
    for (const fileId of ['1000000000000000', '1e3', ' 1', '', 1]) {
      await assert.rejects(h.invoke('addon:update', '1', F, false, { fileId, installedAt: 0 }, A), /安装记录参数无效/, String(fileId));
    }
    for (const fileId of ['0', '007', '999999999999999']) {
      // 参数格式合法；与当前记录不一致，在目录锁内被判为“已变化”，不是参数错误
      await assert.rejects(h.invoke('addon:update', '1', F, false, { fileId, installedAt: 0 }, A), /操作受理后已被重新安装/, fileId);
    }
  } finally {
    await cleanup(base);
  }
});
