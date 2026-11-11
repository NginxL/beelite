import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_HEALTH_LIMITS, parseTocDeclarations, scanAddonHealth, type HealthOptions } from '../src/core/health';
import { MAX_METADATA_BYTES } from '../src/core/layout';
import type { HealthReport } from '../src/shared/health-types';
import { cleanup, exists, makeGameRoot, tmpDir } from './helpers';

const FOREVER = 9;
const RETAIL = 2;
const isRoot = process.getuid?.() === 0;
const execFileAsync = promisify(execFile);
/** 与 health.ts 编译后访问的是同一个模块对象，test.mock.method 可在确定的调用时机注入外部修改 */
const fsp: typeof import('node:fs/promises') = require('node:fs/promises');

/** 整棵目录的快照：路径、类型、权限、mtime、内容哈希或链接目标（忽略 atime），不跟随链接，不读特殊文件 */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, rel: string): Promise<void> => {
    const st = await lstat(p);
    const head = `${rel}|${st.mode.toString(8)}|${st.mtimeMs}`;
    if (st.isSymbolicLink()) out.push(`${head}|link:${await readlink(p)}`);
    else if (st.isFile()) out.push(`${head}|${st.size}|${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    else if (st.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(p);
      } catch (err) {
        out.push(`${head}|dir-unreadable:${(err as NodeJS.ErrnoException).code}`);
        return;
      }
      out.push(`${head}|dir`);
      for (const n of names.sort()) await walk(path.join(p, n), `${rel}/${n}`);
    } else out.push(`${head}|special`);
  };
  await walk(dir, '.');
  return out;
}

/** 扫描并断言整个临时目录（含 WTF 与 fixture 外的链接目标）没有任何应用写入 */
async function scan(base: string, root: string, flavorId = FOREVER, ref: number | null = 16001, options: HealthOptions = {}): Promise<HealthReport> {
  const before = await snapshot(base);
  const report = await scanAddonHealth(root, flavorId, ref, { now: () => 1, ...options });
  assert.deepEqual(await snapshot(base), before, '健康检查不得改动任何文件');
  for (const i of report.issues) {
    assert.ok(Array.from(i.message).length <= 300);
    assert.ok(i.detail === null || Array.from(i.detail).length <= 300);
  }
  return report;
}

/** 两份快照之间内容不同的相对路径（含新增、删除） */
function changedPaths(a: string[], b: string[]): string[] {
  const byPath = (xs: string[]) => new Map(xs.map((x) => [x.slice(0, x.indexOf('|')), x]));
  const ma = byPath(a);
  const mb = byPath(b);
  return [...new Set([...ma.keys(), ...mb.keys()])].filter((k) => ma.get(k) !== mb.get(k)).sort();
}

function keys(r: HealthReport): string[] {
  return r.issues.map((i) => `${i.kind}:${i.folder ?? ''}:${i.detail ?? ''}`).sort();
}

function kindsOf(r: HealthReport, kind: string): string[] {
  return r.issues.filter((i) => i.kind === kind).map((i) => `${i.folder}:${i.detail}`).sort();
}

async function game(): Promise<{ base: string; root: string; addons: string }> {
  const base = await tmpDir('beelite-health-');
  const root = await makeGameRoot(base);
  return { base, root, addons: path.join(root, 'Interface', 'AddOns') };
}

async function addon(root: string, folder: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, 'Interface', 'AddOns', folder);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  return dir;
}

function toc(...lines: string[]): string {
  return ['## Interface: 16001', '## Title: T', ...lines, 'main.lua', ''].join('\n');
}

async function writeManifest(root: string, folders: Record<string, string[]>, extra: Record<string, unknown> = {}): Promise<string> {
  const meta = path.join(root, 'Interface', '.beelite');
  await mkdir(path.join(meta, 'staging'), { recursive: true });
  await mkdir(path.join(meta, 'trash'), { recursive: true });
  const projects: Record<string, unknown> = {};
  for (const [modId, fs] of Object.entries(folders)) {
    projects[modId] = { modId, flavorId: FOREVER, fileId: '1', version: '1', name: `m${modId}`, logo: null, folders: fs, installedAt: 0 };
  }
  await writeFile(path.join(meta, 'manifest.json'), JSON.stringify({ schema: 1, lastTxId: null, projects, recovery: [], purgeQueue: [], ...extra }));
  return meta;
}

test('布局：没有 Interface / AddOns / .beelite / manifest 时只说明，不创建任何路径', async () => {
  const base = await tmpDir('beelite-health-');
  try {
    const bare = path.join(base, 'bare');
    await mkdir(bare);
    let r = await scan(base, bare);
    assert.equal(r.status, 'complete');
    assert.equal(r.hasAddons, false);
    assert.deepEqual(keys(r), ['addons-absent::']);
    assert.equal(await exists(path.join(bare, 'Interface')), false);

    await mkdir(path.join(bare, 'Interface'));
    r = await scan(base, bare);
    assert.deepEqual(keys(r), ['addons-absent::']);
    assert.equal(r.manifestState, 'absent');

    await mkdir(path.join(bare, 'Interface', 'AddOns'));
    r = await scan(base, bare);
    assert.equal(r.status, 'complete');
    assert.equal(r.hasAddons, true);
    assert.deepEqual(r.issues, []);
    assert.equal(r.message, '本次检查范围内未发现异常提示');
    assert.equal(await exists(path.join(bare, 'Interface', '.beelite')), false);

    // .beelite 存在但没有 manifest：视为未托管
    await mkdir(path.join(bare, 'Interface', '.beelite'));
    r = await scan(base, bare);
    assert.equal(r.manifestState, 'absent');
    assert.equal(r.status, 'complete');
    assert.equal(await exists(path.join(bare, 'Interface', '.beelite', 'staging')), false);
  } finally {
    await cleanup(base);
  }
});

test('无法检查：未知 flavor、目录不存在、AddOns 是符号链接', async () => {
  const { base, root, addons } = await game();
  try {
    assert.equal((await scan(base, root, 999)).unavailableReason, 'unknown-flavor');
    const gone = await scanAddonHealth(path.join(base, 'nope'), FOREVER, null);
    assert.equal(gone.status, 'unavailable');
    assert.equal(gone.unavailableReason, 'layout');
    assert.equal(await exists(path.join(base, 'nope')), false);

    const outside = path.join(base, 'outside-addons');
    await mkdir(outside);
    await rm(addons, { recursive: true });
    await symlink(outside, addons);
    const r = await scan(base, root);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.unavailableReason, 'layout');
    assert.deepEqual(r.issues, []);
  } finally {
    await cleanup(base);
  }
});

test('托管与未托管目录都检查；参考值来自插件库配置', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Alpha', { 'Alpha.toc': toc() });
    await addon(root, 'Beta', { 'Beta.toc': toc('## Dependencies: Gamma') });
    await writeManifest(root, { '1': ['Alpha'] });
    const r = await scan(base, root);
    assert.equal(r.status, 'complete');
    assert.equal(r.manifestState, 'ok');
    assert.deepEqual(keys(r), ['dep-required-missing:Beta:Gamma']);
    assert.deepEqual(r.counts, { warning: 1, unknown: 0, info: 0 });
    assert.deepEqual(r.reference, { interfaceNumber: 16001, source: 'addon-library-config' });
    assert.equal(r.scanned.folders, 2);
    assert.equal(r.scanned.interfaceMatched, 2);
    assert.equal(r.checkedAt, 1);
    assert.match(r.scope, /不验证角色启用、加载条件/);
  } finally {
    await cleanup(base);
  }
});

test('存在 journal（任何类型）时无法确认，不恢复、不清理 staging/trash/purgeQueue', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Alpha', { 'Alpha.toc': toc('## Dependencies: Nope') });
    const meta = await writeManifest(root, { '1': ['Alpha'] }, { purgeQueue: ['abc-123456'] });
    await mkdir(path.join(meta, 'staging', 'tx1-000000', 'x', 'Alpha'), { recursive: true });
    await writeFile(path.join(meta, 'staging', 'tx1-000000', 'x', 'Alpha', 'a.lua'), 'x');
    await mkdir(path.join(meta, 'trash', 'abc-123456', 'Old'), { recursive: true });
    await writeFile(path.join(meta, 'trash', 'abc-123456', 'Old', 'o.lua'), 'o');
    await writeFile(path.join(meta, 'manifest.json.tmp'), 'partial');
    const journal = path.join(meta, 'journal.json');

    await writeFile(journal, '{"schema":1,"txId":"bad"}');
    let r = await scan(base, root);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.unavailableReason, 'pending-operation');
    assert.deepEqual(r.issues, []);

    await rm(journal);
    await symlink(path.join(base, 'elsewhere.json'), journal);
    r = await scan(base, root);
    assert.equal(r.unavailableReason, 'pending-operation');

    await rm(journal);
    await mkdir(journal);
    r = await scan(base, root);
    assert.equal(r.unavailableReason, 'pending-operation');
  } finally {
    await cleanup(base);
  }
});

test('manifest 坏 JSON / 超限 / 符号链接 / 目录：partial，不报登记缺失，其余检查照常', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Beta', { 'Beta.toc': toc('## Dependencies: Gamma') });
    const meta = await writeManifest(root, { '1': ['Gone'] });
    const manifest = path.join(meta, 'manifest.json');
    const cases: [string, () => Promise<void>][] = [
      ['bad-json', () => writeFile(manifest, '{not json')],
      [
        'too-large',
        async () => {
          const fh = await open(manifest, 'w');
          await fh.truncate(MAX_METADATA_BYTES + 1);
          await fh.close();
        },
      ],
      [
        'symlink',
        async () => {
          await writeFile(path.join(base, 'real-manifest.json'), JSON.stringify({ schema: 1, projects: {}, recovery: [] }));
          await rm(manifest);
          await symlink(path.join(base, 'real-manifest.json'), manifest);
        },
      ],
      [
        'directory',
        async () => {
          await rm(manifest);
          await mkdir(manifest);
        },
      ],
    ];
    for (const [name, prepare] of cases) {
      await prepare();
      const r = await scan(base, root);
      assert.equal(r.manifestState, 'invalid', name);
      assert.equal(r.status, 'partial', name);
      assert.deepEqual(keys(r), ['dep-required-missing:Beta:Gamma', 'manifest-invalid::'], name);
    }
  } finally {
    await cleanup(base);
  }
});

test('登记目录：缺失、变成文件、变成指向外部的符号链接', async () => {
  const { base, root, addons } = await game();
  try {
    await addon(root, 'Fine', { 'Fine.toc': toc() });
    await writeFile(path.join(addons, 'AsFile'), 'x');
    const outside = path.join(base, 'outside', 'AsLink');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'AsLink.toc'), toc('## Dependencies: Nope'));
    await symlink(outside, path.join(addons, 'AsLink'));
    await symlink(path.join(base, 'outside'), path.join(addons, 'Loose'));
    await writeManifest(root, { '1': ['Fine', 'Gone'], '2': ['AsFile', 'AsLink'] });
    const r = await scan(base, root);
    assert.equal(r.status, 'complete');
    assert.deepEqual(keys(r), ['entry-symlink:Loose:', 'registered-missing:Gone:', 'registered-not-dir:AsFile:file', 'registered-not-dir:AsLink:symlink']);
    assert.equal(r.scanned.tocsRead, 1);
  } finally {
    await cleanup(base);
  }
});

test('AddOns 不存在但有安装记录：同时列出登记目录未找到', async () => {
  const { base, root, addons } = await game();
  try {
    await writeManifest(root, { '1': ['Gone'] });
    await rm(addons, { recursive: true });
    const r = await scan(base, root);
    assert.equal(r.hasAddons, false);
    assert.deepEqual(keys(r), ['addons-absent::', 'registered-missing:Gone:']);
    assert.equal(await exists(addons), false);
  } finally {
    await cleanup(base);
  }
});

test('没有当前 TOC 的资源目录只待确认，不报 warning', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Media', { 'logo.tga': 'x', 'Other_Mainline.toc': toc() });
    const r = await scan(base, root);
    assert.equal(r.status, 'complete');
    assert.deepEqual(keys(r), ['toc-none:Media:']);
    assert.equal(r.counts.warning, 0);
  } finally {
    await cleanup(base);
  }
});

test('TOC 选择复用 flavor 优先级与大小写变体，不选其他 flavor 的 TOC', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Questie', {
      'Questie.toc': toc('## Dependencies: FromGeneric'),
      'Questie_Camelot.toc': toc('## Dependencies: FromCamelot'),
      'Questie_Forever.toc': toc('## Dependencies: FromForever'),
      'Questie_Mainline.toc': toc('## Dependencies: FromMainline'),
    });
    await addon(root, 'Pair', { 'Pair.toc': toc('## Dependencies: PairGeneric'), 'pair-camelot.toc': toc('## Dependencies: PairCamelot') });
    await addon(root, 'OnlyForever', { 'OnlyForever_Forever.toc': toc() });
    let r = await scan(base, root, FOREVER);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), ['Pair:PairCamelot', 'Questie:FromForever']);
    assert.deepEqual(kindsOf(r, 'toc-none'), []);
    r = await scan(base, root, RETAIL, null);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), ['Pair:PairGeneric', 'Questie:FromMainline']);
    assert.deepEqual(kindsOf(r, 'toc-none'), ['OnlyForever:null']);
  } finally {
    await cleanup(base);
  }
});

test('高优先级 TOC 是符号链接：如实待确认，不回退低优先级 TOC', async () => {
  const { base, root } = await game();
  try {
    const outsideToc = path.join(base, 'outside.toc');
    await writeFile(outsideToc, toc('## Dependencies: FromOutside'));
    const dir = await addon(root, 'Linked', { 'Linked.toc': toc('## Dependencies: FromGeneric') });
    await symlink(outsideToc, path.join(dir, 'Linked_Forever.toc'));
    const r = await scan(base, root);
    assert.equal(r.status, 'complete');
    assert.deepEqual(keys(r), ['toc-not-regular:Linked:Linked_Forever.toc']);
  } finally {
    await cleanup(base);
  }
});

test('manifest 与高优先级 TOC 是 FIFO：在可终止的子进程中检查，不会卡住', async (t) => {
  const { base, root } = await game();
  try {
    const dir = await addon(root, 'Piped', { 'Piped.toc': toc('## Dependencies: FromGeneric') });
    const meta = await writeManifest(root, { '1': ['Gone'] });
    await rm(path.join(meta, 'manifest.json'));
    try {
      execFileSync('mkfifo', [path.join(dir, 'Piped_Forever.toc'), path.join(meta, 'manifest.json')]);
    } catch {
      t.skip('无法创建 FIFO');
      return;
    }
    const before = await snapshot(base);
    // 回归时 open 会一直阻塞：子进程超时即被终止，测试失败而不是整个测试进程无法退出
    const code = 'require(process.argv[1]).scanAddonHealth(process.argv[2], 9, 16001).then((r) => process.stdout.write(JSON.stringify(r)))';
    const { stdout } = await execFileAsync(process.execPath, ['-e', code, require.resolve('../src/core/health'), root], { timeout: 15_000, killSignal: 'SIGKILL' });
    const r = JSON.parse(stdout) as HealthReport;
    assert.deepEqual(await snapshot(base), before);
    assert.equal(r.manifestState, 'invalid');
    assert.equal(r.status, 'partial');
    assert.deepEqual(keys(r), ['manifest-invalid::', 'toc-not-regular:Piped:Piped_Forever.toc']);
  } finally {
    await cleanup(base);
  }
});

test('依赖声明解析：只识别三个精确字段，去重、必需优先、条件写法未知', () => {
  const text = [
    '﻿## Interface: 16001, 11509',
    '## dependencies: Core, !Lib, , core',
    '## Dependencies: Ignored',
    '## RequiredDeps: Extra',
    '## OptionalDeps: Core, Opt, opt',
    '## DepsFoo: X1',
    '## Dep: X2',
    '## X-Dependencies: X3',
    '## RequiredDep: X4',
    '## Dependencies-Mainline: X5',
  ].join('\r\n');
  const d = parseTocDeclarations(text);
  assert.deepEqual(d.required, ['Core', '!Lib', 'Extra']);
  assert.deepEqual(d.optional, ['Opt']);
  assert.deepEqual(d.invalid, []);
  assert.equal(d.interfaceUncertain, false);

  const cond = parseTocDeclarations(
    ['## Dependencies [AllowLoadGameType mainline]: A', '## RequiredDeps [x:y]: B', '## OptionalDeps: [Family]Lib', '## Interface [Mainline]: 110000'].join('\n'),
  );
  assert.deepEqual(cond.required, []);
  assert.deepEqual(cond.optional, []);
  assert.deepEqual(
    cond.invalid.map((i) => i.reason),
    ['字段带条件修饰', '字段带条件修饰', '含条件写法'],
  );
  assert.equal(cond.interfaceUncertain, true);

  assert.equal(parseTocDeclarations('## Interface: 16001, abc').interfaceUncertain, true);
  assert.equal(parseTocDeclarations('## Interface: 16001,').interfaceUncertain, false);
  assert.equal(parseTocDeclarations('## Interface: 0').interfaceUncertain, true);
  const many = parseTocDeclarations('## Dependencies: A, B, C', 2);
  assert.deepEqual(many.required, []);
  assert.equal(many.invalid[0].reason, '超过 2 个');
});

test('非法依赖名不用于路径访问，只报声明无法解析', async () => {
  const { base, root } = await game();
  try {
    await mkdir(path.join(root, 'Interface', 'Escape'));
    await addon(root, 'Bad', { 'Bad.toc': toc('## Dependencies: ../Escape, /abs, a\\b, ctl\u0001x, .hidden, WTF') });
    const r = await scan(base, root);
    assert.deepEqual(kindsOf(r, 'dep-declaration-invalid'), ['Bad:../Escape', 'Bad:.hidden', 'Bad:/abs', 'Bad:WTF', 'Bad:a\\b', 'Bad:ctl\u0001x']);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), []);
  } finally {
    await cleanup(base);
  }
});

test('必需依赖：存在、缺失、链接、无当前 TOC、不可读、系统前缀', async () => {
  const { base, root, addons } = await game();
  const locked = path.join(addons, 'Locked');
  try {
    await addon(root, 'Lib', { 'Lib.toc': toc() });
    await addon(root, 'NoToc', { 'readme.txt': 'x' });
    await mkdir(path.join(base, 'outside', 'LinkDep'), { recursive: true });
    await symlink(path.join(base, 'outside', 'LinkDep'), path.join(addons, 'LinkDep'));
    const deps = ['Lib', 'Missing', 'LinkDep', 'NoToc', 'Blizzard_Foo'];
    if (!isRoot) {
      await addon(root, 'Locked', { 'Locked.toc': toc() });
      await chmod(locked, 0o000);
      deps.push('Locked');
    }
    await addon(root, 'Main', { 'Main.toc': toc(`## RequiredDeps: ${deps.join(', ')}`) });
    const r = await scan(base, root);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), ['Main:Missing']);
    assert.deepEqual(kindsOf(r, 'dep-system-unconfirmed'), ['Main:Blizzard_Foo']);
    const unconfirmed = ['Main:LinkDep', 'Main:NoToc'];
    if (!isRoot) unconfirmed.push('Main:Locked');
    assert.deepEqual(kindsOf(r, 'dep-unconfirmed'), unconfirmed.sort());
    assert.ok(!r.issues.some((i) => i.detail === 'Lib' && i.kind.startsWith('dep-')));
    assert.equal(r.status, isRoot ? 'complete' : 'partial');
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await cleanup(base);
  }
});

test('可选依赖：缺失只是参考信息，存在但无法确认为未知，不计必需缺失', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Res', { 'a.tga': 'x' });
    await addon(root, 'Main', { 'Main.toc': toc('## OptionalDeps: LibA, Res, Both', '## Dependencies: Both') });
    const r = await scan(base, root);
    assert.deepEqual(kindsOf(r, 'dep-optional-missing'), ['Main:LibA']);
    assert.deepEqual(kindsOf(r, 'dep-unconfirmed'), ['Main:Res']);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), ['Main:Both']);
    assert.equal(r.issues.find((i) => i.kind === 'dep-optional-missing')!.severity, 'info');
    assert.equal(r.counts.warning, 1);
  } finally {
    await cleanup(base);
  }
});

test('Interface：匹配不出条目，不匹配需确认，无效或部分无效为未知，参考值未知不判断', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Match', { 'Match.toc': '## Interface: 11509, 16001\n' });
    await addon(root, 'Old', { 'Old.toc': '## Interface: 11508\n' });
    await addon(root, 'Mixed', { 'Mixed.toc': '## Interface: 16001, abc\n' });
    await addon(root, 'NoIface', { 'NoIface.toc': '## Title: x\n' });
    let r = await scan(base, root, FOREVER, 16001);
    assert.deepEqual(keys(r), ['interface-mismatch:Old:Old.toc', 'interface-unknown:Mixed:Mixed.toc', 'interface-unknown:NoIface:NoIface.toc']);
    assert.deepEqual(r.issues.find((i) => i.kind === 'interface-mismatch')!.declared, [11508]);
    assert.match(r.issues.find((i) => i.kind === 'interface-mismatch')!.message, /参考值来自插件库配置，不是本机游戏实测/);
    assert.equal(r.scanned.interfaceMatched, 1);

    for (const ref of [null, Number.NaN, 0, -1, 1.5]) {
      r = await scan(base, root, FOREVER, ref);
      assert.equal(r.reference.interfaceNumber, null);
      assert.deepEqual(kindsOf(r, 'interface-mismatch'), []);
      assert.equal(r.scanned.interfaceMatched, 0);
    }
  } finally {
    await cleanup(base);
  }
});

test('局部失败隔离：不可读目录与超限 TOC 不影响其他目录', async () => {
  const { base, root, addons } = await game();
  const locked = path.join(addons, 'A');
  try {
    if (!isRoot) {
      await addon(root, 'A', { 'A.toc': toc() });
      await chmod(locked, 0o000);
    }
    await addon(root, 'B', { 'B.toc': toc(`## Notes: ${'x'.repeat(200)}`) });
    await addon(root, 'C', { 'C.toc': toc('## Dependencies: Nope') });
    const r = await scan(base, root, FOREVER, 16001, { limits: { maxTocBytes: 128 } });
    assert.equal(r.status, 'partial');
    const expected = ['dep-required-missing:C:Nope', 'toc-too-large:B:B.toc'];
    if (!isRoot) expected.push('entry-unreadable:A:EACCES');
    assert.deepEqual(keys(r), expected.sort());
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await cleanup(base);
  }
});

test('一级目录超限：只给未知，不报依赖或登记目录缺失', async () => {
  const { base, root } = await game();
  try {
    for (const n of ['D1', 'D2', 'D3', 'D4', 'D5']) await addon(root, n, { [`${n}.toc`]: toc('## Dependencies: NotThere', '## OptionalDeps: AlsoNot') });
    await writeManifest(root, { '1': ['Gone'] });
    const r = await scan(base, root, FOREVER, 16001, { limits: { maxEntries: 3 } });
    assert.equal(r.status, 'partial');
    assert.equal(r.truncated.entries, true);
    assert.equal(r.scanned.entries, 3);
    assert.ok(r.scanned.folders <= 3);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), []);
    assert.deepEqual(kindsOf(r, 'dep-optional-missing'), []);
    assert.deepEqual(kindsOf(r, 'registered-missing'), []);
    assert.deepEqual(kindsOf(r, 'registered-unconfirmed'), ['Gone:index-incomplete']);
    assert.ok(kindsOf(r, 'dep-unconfirmed').length >= 2);
  } finally {
    await cleanup(base);
  }
});

test('目录内条目、累计 TOC 字节与提示项数量上限', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Crowded', { 'Crowded.toc': toc(), 'a.lua': '', 'b.lua': '' });
    let r = await scan(base, root, FOREVER, 16001, { limits: { maxFilesPerFolder: 2 } });
    assert.deepEqual(keys(r), ['entry-too-many-files:Crowded:2']);
    assert.equal(r.status, 'partial');
    await rm(path.join(root, 'Interface', 'AddOns', 'Crowded'), { recursive: true });

    // 按名称顺序：A 读取后预算用尽，B 未读取；A 对 B 的依赖只能未知
    await addon(root, 'A', { 'A.toc': toc('## Dependencies: B') });
    await addon(root, 'B', { 'B.toc': toc() });
    const aSize = Buffer.byteLength(toc('## Dependencies: B'));
    r = await scan(base, root, FOREVER, 16001, { limits: { maxTotalTocBytes: aSize + 10 } });
    assert.equal(r.truncated.tocBudget, true);
    assert.equal(r.status, 'partial');
    assert.equal(r.scanned.tocsRead, 1);
    assert.ok(r.scanned.tocBytes <= aSize + 10);
    assert.deepEqual(keys(r), ['dep-unconfirmed:A:B', 'toc-skipped-budget:B:B.toc']);

    // 提示项截断时 warning 优先保留，计数仍是全量
    await addon(root, 'Many', { 'Many.toc': toc('## OptionalDeps: O1, O2, O3', '## Dependencies: Req') });
    r = await scan(base, root, FOREVER, 16001, { limits: { maxIssues: 2 } });
    assert.equal(r.truncated.issues, true);
    assert.equal(r.status, 'partial');
    assert.equal(r.issues.length, 2);
    assert.equal(r.issues[0].kind, 'dep-required-missing');
    assert.deepEqual(r.counts, { warning: 1, unknown: 0, info: 3 });
  } finally {
    await cleanup(base);
  }
});

test('上限选项只接受不高于默认的正安全整数', async () => {
  const { base, root } = await game();
  try {
    for (const v of [Infinity, Number.NaN, 0, -1, 1.5, DEFAULT_HEALTH_LIMITS.maxEntries + 1]) {
      await assert.rejects(scanAddonHealth(root, FOREVER, null, { limits: { maxEntries: v } }), RangeError);
    }
    await assert.rejects(scanAddonHealth(root, FOREVER, null, { limits: { maxTotalTocBytes: DEFAULT_HEALTH_LIMITS.maxTotalTocBytes * 2 } }), RangeError);
    assert.equal((await scanAddonHealth(root, FOREVER, null, { limits: { maxEntries: 10 } })).limits.maxEntries, 10);
  } finally {
    await cleanup(base);
  }
});

test('TOC 中的 HTML / Lua 文本只作为纯文本出现，不加载引用', async () => {
  const { base, root } = await game();
  try {
    await addon(root, 'Evil', { 'Evil.toc': toc('## Dependencies: <script>alert(1)</script>, <img onerror=x>', 'os.execute("rm -rf /")', 'missing-file.lua') });
    const r = await scan(base, root);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), ['Evil:<img onerror=x>']);
    assert.deepEqual(kindsOf(r, 'dep-declaration-invalid'), ['Evil:<script>alert(1)</script>']);
    assert.ok(r.issues.some((i) => i.message.includes('<img onerror=x>')));
  } finally {
    await cleanup(base);
  }
});

test('大小写敏感卷上的同名目录与同名 TOC：未知，不任选一个下结论', async (t) => {
  const { base, root, addons } = await game();
  try {
    await mkdir(path.join(addons, 'Dup'));
    if (await exists(path.join(addons, 'dup'))) {
      t.skip('当前卷不区分大小写');
      return;
    }
    // 两个歧义源目录各自声明了确定会触发 warning/info 的内容：不能任选一个给出结论
    await writeFile(path.join(addons, 'Dup', 'Dup.toc'), '## Interface: 11508\n## Dependencies: NeedA\n');
    await addon(root, 'dup', { 'dup.toc': '## Interface: 11508\n## OptionalDeps: NeedB\n' });
    await addon(root, 'Two', { 'Two.toc': toc(), 'two.toc': toc() });
    await addon(root, 'Main', { 'Main.toc': toc('## Dependencies: DUP') });
    await writeManifest(root, { '1': ['Dup'] });
    const r = await scan(base, root, FOREVER, 16001);
    assert.equal(r.status, 'partial');
    assert.deepEqual(kindsOf(r, 'dep-unconfirmed'), ['Main:DUP']);
    assert.deepEqual(kindsOf(r, 'registered-unconfirmed'), ['Dup:ambiguous']);
    assert.equal(kindsOf(r, 'name-ambiguous').length, 1);
    assert.deepEqual(r.issues.filter((i) => i.kind === 'toc-ambiguous').map((i) => i.folder), ['Two']);
    assert.deepEqual(kindsOf(r, 'dep-required-missing'), []);
    assert.deepEqual(kindsOf(r, 'dep-optional-missing'), []);
    assert.deepEqual(kindsOf(r, 'interface-mismatch'), []);
    assert.ok(!r.issues.some((i) => i.kind !== 'name-ambiguous' && i.kind !== 'registered-unconfirmed' && (i.folder === 'Dup' || i.folder === 'dup')));
    assert.equal(r.scanned.folders, 2);
  } finally {
    await cleanup(base);
  }
});

test('说明恰好 300 字符时完整保留，超过时截断到 300', async () => {
  const { base, root } = await game();
  try {
    // 源目录名等长，说明长度只随依赖名长度变化：先用短依赖名量出固定部分，再构造恰好 300 与 301 字符
    const missing = (r: HealthReport, dep: string) => r.issues.find((i) => i.kind === 'dep-required-missing' && i.detail === dep)!;
    await addon(root, 'P'.repeat(60), { [`${'P'.repeat(60)}.toc`]: toc('## Dependencies: X') });
    const fixed = Array.from(missing(await scan(base, root), 'X').message).length - 1;
    const atLimit = 'A'.repeat(300 - fixed);
    const overLimit = 'B'.repeat(301 - fixed);
    assert.ok(Buffer.byteLength(overLimit) <= 255);
    await addon(root, 'Q'.repeat(60), { [`${'Q'.repeat(60)}.toc`]: toc(`## Dependencies: ${atLimit}`) });
    await addon(root, 'R'.repeat(60), { [`${'R'.repeat(60)}.toc`]: toc(`## Dependencies: ${overLimit}`) });
    const r = await scan(base, root);

    const kept = missing(r, atLimit);
    assert.equal(Array.from(kept.message).length, 300);
    assert.ok(kept.message.includes(atLimit));
    assert.ok(!kept.message.endsWith('…'));

    const cut = missing(r, overLimit);
    assert.equal(cut.detail, overLimit);
    assert.equal(Array.from(cut.message).length, 300);
    assert.ok(cut.message.endsWith('…'));
  } finally {
    await cleanup(base);
  }
});

// 以下用 test.mock.method 在确定的调用时机注入外部修改；injected 记录注入后的快照，
// 用来区分测试自己的改动与扫描写入：扫描结束时的快照必须与注入后完全一致。

test('收尾复核：已读的 TOC 在读取其他 TOC 时被外部改写，其结论与对它的依赖都改为无法确认', async (t) => {
  const { base, root, addons } = await game();
  try {
    await addon(root, 'A', { 'A.toc': '## Interface: 11508\n## Dependencies: MissingA\n' });
    await addon(root, 'B', { 'B.toc': toc('## Dependencies: MissingB') });
    await addon(root, 'C', { 'C.toc': toc('## Dependencies: A') });
    const before = await snapshot(base);
    const injected: { snap: string[] | null } = { snap: null };
    const realOpen = fsp.open;
    t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      if (injected.snap === null && String(args[0]).endsWith(`${path.sep}B${path.sep}B.toc`)) {
        await writeFile(path.join(addons, 'A', 'A.toc'), '## Interface: 16001\n## Title: changed by test\n');
        injected.snap = await snapshot(base);
      }
      return realOpen(...args);
    });
    const r = await scanAddonHealth(root, FOREVER, 16001);
    assert.ok(injected.snap, '应在打开 B.toc 时注入改动');
    assert.deepEqual(await snapshot(base), injected.snap);
    assert.deepEqual(changedPaths(before, injected.snap), ['./_forever_/Interface/AddOns/A/A.toc']);
    assert.equal(r.status, 'partial');
    // A 过时的 Interface 不匹配与缺依赖不再显示；C 对 A 的依赖无法确认；未变化的 B 照常
    assert.deepEqual(keys(r), ['dep-required-missing:B:MissingB', 'dep-unconfirmed:C:A', 'toc-changed:A:A.toc']);
  } finally {
    await cleanup(base);
  }
});

test('收尾复核：AddOns 枚举之后新增或删除一级目录时整体无法检查，不留下过时的缺失结论', async (t) => {
  const { base, root, addons } = await game();
  try {
    await addon(root, 'A', { 'A.toc': toc('## Dependencies: Late') });
    await addon(root, 'Doomed', { 'Doomed.toc': toc() });
    await writeManifest(root, { '1': ['Late'] });
    const realOpendir = fsp.opendir;
    const rel = './_forever_/Interface/AddOns';
    const cases: [string, () => Promise<void>, string[]][] = [
      [
        'add',
        async () => {
          await mkdir(path.join(addons, 'Late'));
          await writeFile(path.join(addons, 'Late', 'Late.toc'), toc());
        },
        [`${rel}`, `${rel}/Late`, `${rel}/Late/Late.toc`],
      ],
      ['remove', () => rm(path.join(addons, 'Doomed'), { recursive: true }), [`${rel}`, `${rel}/Doomed`, `${rel}/Doomed/Doomed.toc`]],
    ];
    for (const [name, change, expectedPaths] of cases) {
      const before = await snapshot(base);
      const injected: { snap: string[] | null } = { snap: null };
      // 一级目录枚举完成后，开始列出第一个插件目录 A 时注入
      const m = t.mock.method(fsp, 'opendir', async (...args: Parameters<typeof fsp.opendir>) => {
        if (injected.snap === null && String(args[0]).endsWith(`${path.sep}AddOns${path.sep}A`)) {
          await change();
          injected.snap = await snapshot(base);
        }
        return realOpendir(...args);
      });
      const r = await scanAddonHealth(root, FOREVER, 16001);
      m.mock.restore();
      assert.ok(injected.snap, name);
      assert.deepEqual(await snapshot(base), injected.snap, name);
      assert.deepEqual(changedPaths(before, injected.snap), expectedPaths, name);
      assert.equal(r.status, 'unavailable', name);
      assert.equal(r.unavailableReason, 'addons-unreadable', name);
      assert.match(r.message ?? '', /检查期间发生变化/, name);
      assert.deepEqual(r.issues, [], name);
      assert.equal(r.truncated.entries, false, name);
    }
    // 不再变化时照常检查：Late 已存在，A 的依赖与登记目录都满足
    const r = await scan(base, root);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.issues, []);
  } finally {
    await cleanup(base);
  }
});

test('收尾复核：首次确认没有 journal 之后出现 journal，返回存在未完成操作且不恢复', async (t) => {
  const { base, root } = await game();
  try {
    await addon(root, 'A', { 'A.toc': toc('## Dependencies: MissingX') });
    const meta = await writeManifest(root, { '1': ['Gone'] });
    const journal = path.join(meta, 'journal.json');
    const before = await snapshot(base);
    const injected: { snap: string[] | null } = { snap: null };
    const realLstat = fsp.lstat;
    let calls = 0;
    t.mock.method(fsp, 'lstat', async (...args: Parameters<typeof fsp.lstat>) => {
      if (String(args[0]).endsWith(`${path.sep}.beelite${path.sep}journal.json`) && calls++ === 0) {
        try {
          return await realLstat(...args);
        } finally {
          await writeFile(journal, '{"schema":1}');
          injected.snap = await snapshot(base);
        }
      }
      return realLstat(...args);
    });
    const r = await scanAddonHealth(root, FOREVER, 16001);
    assert.ok(injected.snap);
    assert.deepEqual(await snapshot(base), injected.snap);
    assert.deepEqual(changedPaths(before, injected.snap), ['./_forever_/Interface/.beelite', './_forever_/Interface/.beelite/journal.json']);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.unavailableReason, 'pending-operation');
    assert.deepEqual(r.issues, []);
    assert.equal(await readFile(journal, 'utf8'), '{"schema":1}');
  } finally {
    await cleanup(base);
  }
});
