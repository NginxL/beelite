// WTF 备份范围（账号 / 角色）与账号角色目录列表：只使用 mkdtemp 生成的假游戏目录、应用数据与保存位置，不读取真实玩家数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { MANIFEST_NAME, MARKER_NAME, parseBackupScope, WtfBackupService, type BackupStep } from '../src/core/wtf-backup';
import type { BackupLimits, BackupScope, CatalogLimits } from '../src/shared/backup-types';

const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function put(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function setup(opts: { limits?: Partial<BackupLimits>; catalogLimits?: Partial<CatalogLimits> } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-scope-test-')));
  const root = path.join(base, 'games', '_retail_');
  const wtf = path.join(root, 'WTF');
  const appData = path.join(base, 'appData');
  const picked = path.join(base, 'Desktop');
  for (const d of [wtf, appData, picked]) await mkdir(d, { recursive: true });
  const steps: string[] = [];
  const locked: string[] = [];
  const hooks = { onStep: null as null | ((name: BackupStep, detail?: string) => Promise<void> | void) };
  const svc = new WtfBackupService({
    settingsFile: path.join(appData, 'wtf-backup.json'),
    appDataDir: appData,
    appVersion: '0.2.1-test',
    resolveRoot: async () => root,
    listBoundRoots: async () => [root],
    limits: opts.limits,
    catalogLimits: opts.catalogLimits,
    hooks: {
      step: async (name, detail) => {
        steps.push(name);
        await hooks.onStep?.(name, detail);
      },
    },
  });
  /** 设为不可访问；done 时恢复权限再清理 */
  const lockOut = async (p: string) => {
    await chmod(p, 0o000);
    locked.push(p);
  };
  const done = async () => {
    hooks.onStep = null;
    for (const p of locked) await chmod(p, 0o755).catch(() => undefined);
    await svc.shutdown();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, wtf, appData, picked, steps, hooks, svc, lockOut, done };
}

/** 目录树的完整记录：类型、权限、大小、修改时间与内容校验值（跳过不可访问的目录内容） */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, rel: string) => {
    const st = await lstat(p);
    if (st.isDirectory()) {
      out.push(`${rel}|dir|${st.mode & 0o777}|${st.mtimeMs}`);
      if ((st.mode & 0o500) !== 0o500) return;
      for (const n of (await readdir(p)).sort()) await walk(path.join(p, n), `${rel}/${n}`);
    } else {
      const readable = st.isFile() && (st.mode & 0o400) !== 0 && st.size < 1024 * 1024;
      out.push(`${rel}|${st.isFile() ? 'file' : 'other'}|${st.mode & 0o777}|${st.size}|${st.mtimeMs}|${readable ? sha(await readFile(p)) : ''}`);
    }
  };
  await walk(dir, '.');
  return out;
}

/** 记录满足 match 的路径上的 fs/promises 调用（核心在调用时读取模块导出，可被替换观察） */
function watchAccess(match: (p: string) => boolean): { calls: string[]; restore: () => void } {
  const mod = require('node:fs/promises') as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const calls: string[] = [];
  for (const n of ['open', 'opendir', 'lstat', 'stat', 'realpath', 'readdir', 'readFile']) {
    const orig = mod[n] as (...a: unknown[]) => unknown;
    saved.set(n, orig);
    mod[n] = (...args: unknown[]) => {
      const p = String(args[0]);
      if (match(p)) calls.push(`${n}:${p}`);
      return orig(...args);
    };
  }
  return { calls, restore: () => saved.forEach((fn, n) => (mod[n] = fn)) };
}

const under = (base: string) => (p: string) => p === base || p.startsWith(base + path.sep);

const LAYOUT: Record<string, string> = {
  'Config.wtf': 'SET textLocale "zhCN"\n',
  'Account/ALPHA/config-cache.wtf': 'account cache\n',
  'Account/ALPHA/bindings-cache.wtf.bak': 'old bindings\n',
  'Account/ALPHA/SavedVariables/Questie.lua': 'Questie = {}\n',
  'Account/ALPHA/SavedVariables/Questie.lua.bak': 'Questie = { old = true }\n',
  'Account/ALPHA/SavedVariables/sub/deep.lua': 'deep = 1\n',
  'Account/ALPHA/Unknown/x.dat': 'unknown\n',
  'Account/ALPHA/白银之手/甲/AddOns.txt': 'Questie: enabled\n',
  'Account/ALPHA/白银之手/甲/SavedVariables/Char.lua': 'Char = 1\n',
  'Account/ALPHA/白银之手/乙/config-cache.wtf': 'other character\n',
  'Account/ALPHA/白银之手/realm-direct.txt': 'realm direct\n',
  'Account/ALPHA/Other Realm/甲/bindings-cache.wtf': 'same name, other realm\n',
  'Account/BRAVO/config-cache.wtf': 'bravo\n',
  'Account/BRAVO/Realm/丙/AddOns.txt': 'bravo character\n',
};

async function makeLayout(wtf: string): Promise<void> {
  for (const [rel, data] of Object.entries(LAYOUT)) await put(path.join(wtf, ...rel.split('/')), data);
  await mkdir(path.join(wtf, 'Account', 'ALPHA', 'EmptyDir'));
}

interface RawManifest {
  schema: number;
  scope?: unknown;
  entries: Array<{ path: string; type: string; size?: number; sha256?: string }>;
}

async function readManifest(container: string, id: string): Promise<RawManifest> {
  return JSON.parse(await readFile(path.join(container, id, MANIFEST_NAME), 'utf8')) as RawManifest;
}

const pathsOf = (m: RawManifest) => new Set(m.entries.map((e) => e.path));

test('parseBackupScope：严格拒绝非法输入且不触发访问器；合法名称原样保留并深度冻结', () => {
  const nfc = 'Café';
  const nfd = 'Café';
  const extraProp = Object.assign([{ realm: 'R', character: 'C' }], { extra: 1 });
  const bad: [string, unknown][] = [
    ['null', null],
    ['字符串', 'all'],
    ['数组', []],
    ['多余键', { kind: 'all', extra: 1 }],
    ['符号键', { kind: 'all', [Symbol('x')]: 1 }],
    ['原型继承', Object.create({ kind: 'all' })],
    ['类实例', new (class { kind = 'all'; })()],
    ['未知类型', { kind: 'realm' }],
    ['缺少账号', { kind: 'account' }],
    ['空账号', { kind: 'account', account: '' }],
    ['路径穿越', { kind: 'account', account: '..' }],
    ['含分隔符', { kind: 'account', account: 'A/B' }],
    ['以点开头', { kind: 'account', account: '.hidden' }],
    ['过长', { kind: 'account', account: 'x'.repeat(256) }],
    ['控制字符', { kind: 'account', account: 'A\u0001' }],
    ['空角色列表', { kind: 'characters', account: 'A', characters: [] }],
    ['数组空洞', { kind: 'characters', account: 'A', characters: new Array(1) }],
    ['类数组对象', { kind: 'characters', account: 'A', characters: { 0: { realm: 'R', character: 'C' }, length: 1 } }],
    ['数组额外属性', { kind: 'characters', account: 'A', characters: extraProp }],
    ['超过 256 个', { kind: 'characters', account: 'A', characters: Array.from({ length: 257 }, (_, i) => ({ realm: 'R', character: `C${i}` })) }],
    ['角色多余键', { kind: 'characters', account: 'A', characters: [{ realm: 'R', character: 'C', x: 1 }] }],
    ['角色按 fold 重复', { kind: 'characters', account: 'A', characters: [{ realm: 'R', character: 'c' }, { realm: 'R', character: 'C' }] }],
    ['完全重复', { kind: 'characters', account: 'A', characters: [{ realm: 'R', character: 'C' }, { realm: 'R', character: 'C' }] }],
    ['同服务器大小写写法不同', { kind: 'characters', account: 'A', characters: [{ realm: 'Realm', character: '甲' }, { realm: 'realm', character: '乙' }] }],
    ['同服务器 NFC/NFD 写法不同', { kind: 'characters', account: 'A', characters: [{ realm: nfc, character: '甲' }, { realm: nfd, character: '乙' }] }],
    ['服务器为 SavedVariables', { kind: 'characters', account: 'A', characters: [{ realm: 'savedVARIABLES', character: 'C' }] }],
  ];
  for (const [name, v] of bad) assert.throws(() => parseBackupScope(v), isCode('backup-scope'), name);

  let touched = false;
  const getterAccount: Record<string, unknown> = { kind: 'account' };
  Object.defineProperty(getterAccount, 'account', {
    enumerable: true,
    get() {
      touched = true;
      return 'A';
    },
  });
  const getterKind = {};
  Object.defineProperty(getterKind, 'kind', {
    enumerable: true,
    get() {
      touched = true;
      return 'all';
    },
  });
  assert.throws(() => parseBackupScope(getterAccount), isCode('backup-scope'));
  assert.throws(() => parseBackupScope(getterKind), isCode('backup-scope'));
  assert.equal(touched, false, '解析不得触发访问器');

  assert.deepEqual(parseBackupScope(Object.assign(Object.create(null), { kind: 'all' })), { kind: 'all' });
  const input = { kind: 'characters', account: 'ALPHA 账号', characters: [{ realm: `${nfd} 服`, character: '甲 乙' }, { realm: 'Other Realm', character: '甲' }] };
  const s = parseBackupScope(input);
  assert.deepEqual(s, input);
  assert.notEqual(s, input);
  if (s.kind !== 'characters') return assert.fail('应为角色范围');
  assert.equal(s.characters[0].realm, `${nfd} 服`, 'NFD 名称原样保留，不改写为 NFC');
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.characters) && s.characters.every((c) => Object.isFrozen(c)));
  input.characters[0].character = 'changed';
  assert.equal(s.characters[0].character, '甲 乙', '返回值是深拷贝');
});

test('任务固定范围：受理后修改调用方对象不影响任务与结果；verify 任务的 scope 为 null', async () => {
  const f = await setup();
  try {
    await makeLayout(f.wtf);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const input = { kind: 'characters', account: 'ALPHA', characters: [{ realm: '白银之手', character: '甲' }] };
    const expected = JSON.parse(JSON.stringify(input)) as BackupScope;
    const seen: { scope: BackupScope | null; frozen: boolean } = { scope: null, frozen: false };
    f.hooks.onStep = (name) => {
      if (name !== 'copy-file' || seen.scope) return;
      input.account = 'BRAVO';
      input.characters[0].character = '乙';
      input.characters.push({ realm: 'Realm', character: '丙' });
      seen.scope = f.svc.taskState()?.scope ?? null;
      seen.frozen = seen.scope !== null && Object.isFrozen(seen.scope);
    };
    const r = await f.svc.run(9, f.root, input);
    f.hooks.onStep = null;
    assert.deepEqual(seen.scope, expected);
    assert.ok(seen.frozen);
    assert.deepEqual(r.snapshot.scope, expected);
    const paths = pathsOf(await readManifest(container, r.snapshot.id));
    assert.ok(paths.has('Account/ALPHA/白银之手/甲/AddOns.txt'));
    assert.ok(![...paths].some((p) => p.includes('BRAVO') || p.includes('乙')));

    const verifySeen: { scope: BackupScope | null | 'unset' } = { scope: 'unset' };
    f.hooks.onStep = (name) => {
      if (name === 'verify-file' && verifySeen.scope === 'unset') verifySeen.scope = f.svc.taskState()?.scope ?? null;
    };
    const v = await f.svc.verify(9, f.root, r.snapshot.id);
    assert.equal(v.ok, true);
    assert.equal(verifySeen.scope, null);
  } finally {
    await f.done();
  }
});

test('全部 WTF：默认仍写 schema 1 且磁盘清单无 scope；结果、列表与校验都视为 all', async () => {
  const f = await setup();
  try {
    await makeLayout(f.wtf);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const r = await f.svc.run(9, f.root);
    const raw = await readManifest(container, r.snapshot.id);
    assert.equal(raw.schema, 1);
    assert.ok(!('scope' in raw), 'schema 1 清单不写 scope 字段');
    const paths = pathsOf(raw);
    for (const rel of ['Config.wtf', 'Account/BRAVO/Realm/丙/AddOns.txt', 'Account/ALPHA/EmptyDir']) assert.ok(paths.has(rel), rel);
    assert.deepEqual(r.snapshot.scope, { kind: 'all' });
    const s = await f.svc.state(9, f.root);
    assert.deepEqual(s.snapshots[0].scope, { kind: 'all' });
    assert.equal(s.snapshots[0].status, 'structure-ok');
    assert.equal((await f.svc.verify(9, f.root, r.snapshot.id)).ok, true);
  } finally {
    await f.done();
  }
});

test('整账号：schema 2 只含本账号完整子树（含未知目录、.bak、空目录、服务器直属文件），不含根级配置与其他账号', async () => {
  const f = await setup();
  try {
    await makeLayout(f.wtf);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const scope = { kind: 'account', account: 'ALPHA' };
    const r = await f.svc.run(9, f.root, scope);
    const raw = await readManifest(container, r.snapshot.id);
    assert.equal(raw.schema, 2);
    assert.deepEqual(raw.scope, scope);
    const paths = pathsOf(raw);
    for (const rel of ['Account', 'Account/ALPHA', 'Account/ALPHA/bindings-cache.wtf.bak', 'Account/ALPHA/Unknown/x.dat', 'Account/ALPHA/EmptyDir', 'Account/ALPHA/白银之手/realm-direct.txt', 'Account/ALPHA/白银之手/乙/config-cache.wtf']) {
      assert.ok(paths.has(rel), rel);
    }
    assert.ok(!paths.has('Config.wtf'));
    assert.ok(![...paths].some((p) => p.startsWith('Account/BRAVO')));
    const s = await f.svc.state(9, f.root);
    assert.deepEqual(s.snapshots[0].scope, scope);
    assert.equal(s.snapshots[0].status, 'structure-ok');
    assert.equal((await f.svc.verify(9, f.root, r.snapshot.id)).ok, true);
  } finally {
    await f.done();
  }
});

test('指定角色：同账号多服务器同名角色互相隔离；含账号直属文件与 .bak、SavedVariables 全树，不含服务器直属文件与其他角色', async () => {
  const f = await setup();
  try {
    await makeLayout(f.wtf);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const scope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: '白银之手', character: '甲' }, { realm: 'Other Realm', character: '甲' }] };
    const r = await f.svc.run(9, f.root, scope);
    const raw = await readManifest(container, r.snapshot.id);
    assert.equal(raw.schema, 2);
    assert.deepEqual(raw.scope, scope);
    const paths = pathsOf(raw);
    const included = [
      'Account',
      'Account/ALPHA',
      'Account/ALPHA/config-cache.wtf',
      'Account/ALPHA/bindings-cache.wtf.bak',
      'Account/ALPHA/SavedVariables/Questie.lua',
      'Account/ALPHA/SavedVariables/Questie.lua.bak',
      'Account/ALPHA/SavedVariables/sub/deep.lua',
      'Account/ALPHA/白银之手',
      'Account/ALPHA/白银之手/甲/AddOns.txt',
      'Account/ALPHA/白银之手/甲/SavedVariables/Char.lua',
      'Account/ALPHA/Other Realm/甲/bindings-cache.wtf',
    ];
    for (const rel of included) assert.ok(paths.has(rel), rel);
    const excluded = ['Config.wtf', 'Account/ALPHA/白银之手/乙', 'Account/ALPHA/白银之手/realm-direct.txt', 'Account/ALPHA/Unknown', 'Account/ALPHA/EmptyDir'];
    for (const rel of excluded) assert.ok(![...paths].some((p) => p === rel || p.startsWith(`${rel}/`)), rel);
    assert.ok(![...paths].some((p) => p.startsWith('Account/BRAVO')));
    const bak = raw.entries.find((e) => e.path === 'Account/ALPHA/SavedVariables/Questie.lua.bak');
    assert.equal(bak?.sha256, sha(LAYOUT['Account/ALPHA/SavedVariables/Questie.lua.bak']));
    const copy = await readFile(path.join(container, r.snapshot.id, 'WTF', 'Account', 'ALPHA', 'Other Realm', '甲', 'bindings-cache.wtf'), 'utf8');
    assert.equal(copy, LAYOUT['Account/ALPHA/Other Realm/甲/bindings-cache.wtf']);
    assert.equal((await f.svc.verify(9, f.root, r.snapshot.id)).ok, true);
    assert.equal((await f.svc.state(9, f.root)).snapshots[0].status, 'structure-ok');
  } finally {
    await f.done();
  }
});

test('未选范围不被访问：其他账号、未选角色与未知目录不 lstat / 打开 / 进入，其中的链接、超大稀疏文件与无权限目录不影响；所选范围的链接仍拒绝', async () => {
  const f = await setup();
  try {
    await makeLayout(f.wtf);
    const outside = path.join(f.base, 'outside.txt');
    await writeFile(outside, 'outside\n');
    const acct = path.join(f.wtf, 'Account');
    await symlink(outside, path.join(f.wtf, 'rootlink'));
    await symlink(outside, path.join(acct, 'ZLINK'));
    await symlink(outside, path.join(acct, 'ALPHA', 'Unknown', 'link'));
    const huge = await open(path.join(acct, 'ALPHA', 'Unknown', 'huge.bin'), 'w');
    await huge.truncate(3 * 1024 ** 3);
    await huge.close();
    await f.lockOut(path.join(acct, 'BRAVO'));
    await f.lockOut(path.join(acct, 'ALPHA', '白银之手', '乙'));
    await f.svc.configure(9, f.root, f.picked);
    const sourceBefore = await tree(f.wtf);

    const forbidden = [path.join(f.wtf, 'Config.wtf'), path.join(f.wtf, 'rootlink'), path.join(acct, 'ZLINK'), path.join(acct, 'BRAVO'), path.join(acct, 'ALPHA', '白银之手', '乙')];
    const unknownInside = path.join(acct, 'ALPHA', 'Unknown') + path.sep;
    const spy = watchAccess((p) => forbidden.some((x) => under(x)(p)) || p.startsWith(unknownInside));
    const r = await f.svc.run(9, f.root, { kind: 'characters', account: 'ALPHA', characters: [{ realm: '白银之手', character: '甲' }] }).finally(() => spy.restore());
    assert.deepEqual(spy.calls, [], '未选范围只允许在父目录中读到名字');
    assert.equal(r.snapshot.status, 'structure-ok');
    assert.deepEqual(await tree(f.wtf), sourceBefore);

    await symlink(outside, path.join(acct, 'ALPHA', '白银之手', '甲', 'link.lua'));
    await assert.rejects(f.svc.run(9, f.root, { kind: 'characters', account: 'ALPHA', characters: [{ realm: '白银之手', character: '甲' }] }), isCode('backup-unsupported-entry'));
  } finally {
    await f.done();
  }
});

test('条目总量：空账号的途经目录也计入上限；SavedVariables 用尽后其余直属文件或所选角色超限；超限时不复制、不留临时目录、源不变', async () => {
  for (const [maxEntries, ok] of [
    [1, false],
    [2, true],
  ] as const) {
    const f = await setup({ limits: { maxEntries } });
    try {
      await mkdir(path.join(f.wtf, 'Account', 'EMPTY'), { recursive: true });
      const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
      if (ok) {
        const r = await f.svc.run(9, f.root, { kind: 'account', account: 'EMPTY' });
        assert.deepEqual([...pathsOf(await readManifest(container, r.snapshot.id))].sort(), ['Account', 'Account/EMPTY']);
      } else {
        await assert.rejects(f.svc.run(9, f.root, { kind: 'account', account: 'EMPTY' }), isCode('backup-limit'), `maxEntries=${maxEntries}`);
        assert.deepEqual(await readdir(container), [MARKER_NAME]);
      }
    } finally {
      await f.done();
    }
  }

  // 条目顺序：Account、ACC、R（途经）、SavedVariables、a.lua、b.lua、z.txt、R/C、R/C/AddOns.txt，共 9 项
  const scope = { kind: 'characters', account: 'ACC', characters: [{ realm: 'R', character: 'C' }] };
  for (const [maxEntries, what] of [
    [6, 'SavedVariables 用尽后余下直属文件'],
    [8, '所选角色内容'],
    [9, null],
  ] as const) {
    const f = await setup({ limits: { maxEntries } });
    try {
      const acc = path.join(f.wtf, 'Account', 'ACC');
      await put(path.join(acc, 'SavedVariables', 'a.lua'), 'a');
      await put(path.join(acc, 'SavedVariables', 'b.lua'), 'b');
      await put(path.join(acc, 'z.txt'), 'z');
      await put(path.join(acc, 'R', 'C', 'AddOns.txt'), 'marker');
      const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
      const before = await tree(f.wtf);
      if (what === null) {
        const r = await f.svc.run(9, f.root, scope);
        assert.equal(pathsOf(await readManifest(container, r.snapshot.id)).size, 9);
      } else {
        await assert.rejects(f.svc.run(9, f.root, scope), isCode('backup-limit'), what);
        assert.ok(!f.steps.includes('copy-file'), `${what}：超限必须在复制前发现`);
        assert.deepEqual(await readdir(container), [MARKER_NAME], `${what}：不留临时目录`);
        assert.deepEqual(await tree(f.wtf), before);
      }
    } finally {
      await f.done();
    }
  }
});

test('账号与角色列表：未启用拒绝且不访问 WTF；启用不扫描；读取时只读名字与 lstat、不打开文件；识别文件规则与提示', async () => {
  const f = await setup();
  try {
    const acct = path.join(f.wtf, 'Account');
    const outside = path.join(f.base, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await put(path.join(acct, 'ALPHA', 'SavedVariables', 'x.lua'), 'shared');
    await put(path.join(acct, 'ALPHA', 'R1', '甲', 'AddOns.txt'), 'marker');
    await put(path.join(acct, 'ALPHA', 'R1', 'Mixed', 'ADDONS.TXT'), 'marker');
    await put(path.join(acct, 'ALPHA', 'R1', 'Linked', 'other.txt'), 'x');
    await symlink(outside, path.join(acct, 'ALPHA', 'R1', 'Linked', 'AddOns.txt'));
    await put(path.join(acct, 'ALPHA', 'R1', 'Both', 'config-cache.wtf'), 'marker');
    await symlink(outside, path.join(acct, 'ALPHA', 'R1', 'Both', 'bindings-cache.wtf'));
    await put(path.join(acct, 'ALPHA', 'R1', 'NoMarker', 'foo.txt'), 'x');
    await put(path.join(acct, 'ALPHA', 'R1', 'direct.txt'), 'realm direct');
    await put(path.join(acct, 'BRAVO', 'config-cache.wtf'), 'bravo');
    await f.lockOut(path.join(acct, 'ALPHA', 'R1', '甲', 'AddOns.txt'));

    const spy = watchAccess(under(f.wtf));
    try {
      await assert.rejects(f.svc.catalog(9, f.root), isCode('backup-disabled'));
      assert.equal((await f.svc.state(9, f.root)).status, 'disabled');
      await f.svc.configure(9, f.root, f.picked);
      assert.deepEqual(spy.calls, [], '未启用与启用时都不访问 WTF');
    } finally {
      spy.restore();
    }

    const reading = watchAccess(under(f.wtf));
    const cat = await f.svc.catalog(9, f.root).finally(() => reading.restore());
    assert.ok(reading.calls.length > 0);
    assert.deepEqual(reading.calls.filter((c) => !/^(opendir|lstat|realpath):/.test(c)), [], '只读目录名称与元数据，不打开任何文件');
    assert.equal(cat.root, f.root);
    assert.deepEqual(cat.accounts, [
      { account: 'ALPHA', realms: [{ realm: 'R1', characters: ['Mixed', '甲'] }], characterError: null },
      { account: 'BRAVO', realms: [], characterError: null },
    ]);
    assert.ok(cat.warnings.some((w) => w.includes('Linked') && w.includes('识别文件不受支持')));
    assert.ok(cat.warnings.some((w) => w.includes('Both') && w.includes('识别文件不受支持')));
    assert.ok(cat.warnings.some((w) => w.includes('直属文件')));
    assert.ok(!cat.warnings.some((w) => w.includes('NoMarker')), '没有识别文件的目录只是不列出，不算异常');
  } finally {
    await f.done();
  }
});

test('账号与角色列表上限：账号数超限整体失败；名称总数在 Account 层耗尽整体失败，在账号内耗尽则该账号及其后账号标为无法列出', async () => {
  const build = async (wtf: string) => {
    await put(path.join(wtf, 'Account', 'ALPHA', 'R1', 'C1', 'AddOns.txt'), 'm');
    await put(path.join(wtf, 'Account', 'ALPHA', 'SavedVariables', 'x.lua'), 's');
    await put(path.join(wtf, 'Account', 'BRAVO', 'R2', 'C2', 'AddOns.txt'), 'm');
  };
  {
    const f = await setup({ catalogLimits: { maxAccounts: 1 } });
    try {
      await build(f.wtf);
      await f.svc.configure(9, f.root, f.picked);
      await assert.rejects(f.svc.catalog(9, f.root), isCode('backup-catalog-limit'));
    } finally {
      await f.done();
    }
  }
  {
    // WTF 根 1 个名字 + Account 下 2 个名字 = 3；上限 2 时在 Account 层耗尽
    const f = await setup({ catalogLimits: { maxNames: 2 } });
    try {
      await build(f.wtf);
      await f.svc.configure(9, f.root, f.picked);
      await assert.rejects(f.svc.catalog(9, f.root), isCode('backup-catalog-limit'));
    } finally {
      await f.done();
    }
  }
  {
    // 上限 4：读完 Account 层（3 个）后，ALPHA 目录的第二个名字耗尽
    const f = await setup({ catalogLimits: { maxNames: 4 } });
    try {
      await build(f.wtf);
      await f.svc.configure(9, f.root, f.picked);
      const cat = await f.svc.catalog(9, f.root);
      assert.deepEqual(cat.accounts.map((a) => a.account), ['ALPHA', 'BRAVO']);
      for (const a of cat.accounts) {
        assert.deepEqual(a.realms, [], a.account);
        assert.match(a.characterError ?? '', /只能整账号备份/, a.account);
      }
    } finally {
      await f.done();
    }
  }
});
