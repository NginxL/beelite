import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LIMITS, extractAddonZip } from '../src/core/zip';
import { addonEntries, cleanup, exists, makeZip, tmpDir, type ZipEntrySpec } from './helpers';

async function run(entries: ZipEntrySpec[], limits = DEFAULT_LIMITS) {
  const dir = await tmpDir();
  const zip = path.join(dir, 'p.zip');
  await writeFile(zip, makeZip(entries));
  const dest = path.join(dir, 'x');
  try {
    const res = await extractAddonZip(zip, dest, limits);
    return { res, dir, dest };
  } catch (err) {
    await cleanup(dir);
    throw err;
  }
}

async function rejects(entries: ZipEntrySpec[], pattern: RegExp, limits = DEFAULT_LIMITS) {
  await assert.rejects(run(entries, limits), (err: Error) => {
    assert.match(err.message, pattern);
    return true;
  });
}

test('接受真实 Questie 形态：反斜杠路径 + 7 条完全相同的重复条目 + 多份 TOC', async () => {
  const dup: ZipEntrySpec = { name: 'Questie\\addon_version.txt', data: '12.6.3' };
  const { res, dir, dest } = await run([
    ...addonEntries('Questie'),
    { name: 'Questie/Questie_Forever.toc', data: '## Interface: 16001\n' },
    { name: 'Questie/Questie_Vanilla.toc', data: '## Interface: 11509\n' },
    dup, dup, dup, dup, dup, dup, dup,
    { name: '__MACOSX/Questie/._x', data: 'junk' },
    { name: 'Questie/.DS_Store', data: 'junk' },
  ]);
  assert.deepEqual(res.modules, ['Questie']);
  assert.equal(await readFile(path.join(dest, 'Questie', 'addon_version.txt'), 'utf8'), '12.6.3');
  assert.equal(await exists(path.join(dest, '__MACOSX')), false);
  assert.equal(await exists(path.join(dest, 'Questie', '.DS_Store')), false);
  await cleanup(dir);
});

test('多模块包返回全部一级目录，根部零散文件被忽略并提示', async () => {
  const { res, dir, dest } = await run([...addonEntries('QuestieDB'), ...addonEntries('Questie'), { name: 'README.txt', data: 'hi' }]);
  assert.deepEqual(res.modules, ['Questie', 'QuestieDB']);
  assert.ok(res.warnings.some((w) => w.includes('README.txt')));
  assert.deepEqual((await readdir(dest)).sort(), ['Questie', 'QuestieDB']);
  await cleanup(dir);
});

test('拒绝路径穿越与绝对路径', async () => {
  await rejects([...addonEntries('A'), { name: 'A/../../evil.txt', data: 'x' }], /路径|relative/);
  await rejects([...addonEntries('A'), { name: '/etc/evil', data: 'x' }], /路径|absolute/);
  await rejects([...addonEntries('A'), { name: 'C:\\evil.txt', data: 'x' }], /路径|absolute/);
  await rejects([...addonEntries('A'), { name: 'A\\..\\..\\evil.txt', data: 'x' }], /路径|relative/);
});

test('拒绝符号链接与特殊文件', async () => {
  await rejects([...addonEntries('A'), { name: 'A/link', data: '/etc/passwd', mode: 0o120777 }], /符号链接/);
  await rejects([...addonEntries('A'), { name: 'A/fifo', data: '', mode: 0o010644 }], /特殊文件/);
});

test('拒绝内容不同的重复条目与大小写碰撞', async () => {
  await rejects([...addonEntries('A'), { name: 'A/x.lua', data: '1' }, { name: 'A/x.lua', data: '2' }], /重复|大小写/);
  await rejects([...addonEntries('A'), { name: 'A/X.lua', data: '1' }, { name: 'A/x.lua', data: '1' }], /重复|大小写/);
  await rejects([...addonEntries('A'), { name: 'a/other.lua', data: '1' }], /大小写/);
});

test('拒绝文件与目录同名', async () => {
  await rejects([...addonEntries('A'), { name: 'A/sub', data: 'f' }, { name: 'A/sub/x.lua', data: '1' }], /同名/);
});

test('拒绝压缩炸弹、超量条目与超总体积', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 0);
  await rejects([...addonEntries('A'), { name: 'A/bomb.bin', data: big, deflate: true }], /压缩比/);
  await rejects(addonEntries('A'), /条目数量/, { ...DEFAULT_LIMITS, maxEntries: 2 });
  await rejects(addonEntries('A'), /体积/, { ...DEFAULT_LIMITS, maxTotalBytes: 10 });
});

test('拒绝加密条目', async () => {
  await rejects([...addonEntries('A'), { name: 'A/secret.lua', data: 'x', encrypted: true }], /加密/);
});

test('解压时校验 CRC 与实际大小', async () => {
  await rejects([...addonEntries('A'), { name: 'A/bad.lua', data: 'hello', crc: 12345 }], /CRC/);
  await rejects([...addonEntries('A'), { name: 'A/short.lua', data: 'hello', declaredSize: 3 }], /大小|size|校验/);
});

test('拒绝不符合插件结构的包', async () => {
  await rejects([{ name: 'readme.txt', data: 'x' }], /没有插件目录/);
  await rejects([{ name: 'Pack/', data: '' }, { name: 'Pack/A/A.toc', data: '## Title: A\n' }], /TOC/);
  await rejects([...addonEntries('A'), { name: 'WTF/Config.wtf', data: 'x' }], /不允许/);
  await rejects([{ name: 'Interface/AddOns/A/A.toc', data: 'x' }], /不允许/);
});

test('无 TOC 的附属目录允许安装但给出提示', async () => {
  const { res, dir } = await run([...addonEntries('A'), { name: 'A_Media/font.ttf', data: 'x' }]);
  assert.deepEqual(res.modules, ['A', 'A_Media']);
  assert.ok(res.warnings.some((w) => w.includes('A_Media')));
  await cleanup(dir);
});
