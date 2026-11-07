import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
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

/** 与 Plater 透明贴图同形态：512×512×32 位未压缩 TGA，所有像素相同 */
function transparentTga(): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2; // 未压缩真彩
  header.writeUInt16LE(512, 12);
  header.writeUInt16LE(512, 14);
  header[16] = 32;
  header[17] = 32;
  const pixels = Buffer.alloc(512 * 512 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels[i] = 5;
  return Buffer.concat([header, pixels]);
}

test('高压缩比的合法内容可以解压且字节完全一致：透明 TGA 与 4 MiB 零填充', async () => {
  const tga = transparentTga();
  const zeros = Buffer.alloc(4 * 1024 * 1024, 0);
  for (const [label, data] of [['tga', tga], ['zeros', zeros]] as const) {
    assert.ok(data.length / zlib.deflateRawSync(data).length > 1000, `${label} 压缩比应超过 1000`);
  }
  const { dir, dest } = await run([
    ...addonEntries('A'),
    { name: 'A/images/transparent.tga', data: tga, deflate: true },
    { name: 'A/zeros.bin', data: zeros, deflate: true },
  ]);
  assert.ok((await readFile(path.join(dest, 'A', 'images', 'transparent.tga'))).equals(tga));
  assert.ok((await readFile(path.join(dest, 'A', 'zeros.bin'))).equals(zeros));
  await cleanup(dir);
});

test('硬上限：归档大小、解压总量、条目数恰好等于上限时通过，超出 1 时拒绝', async () => {
  const entries = addonEntries('A'); // 3 个条目：目录、TOC、Lua
  const zipBytes = makeZip(entries).length;
  const declaredTotal = entries.reduce((n, e) => n + (e.name.endsWith('/') ? 0 : Buffer.byteLength(e.data ?? '')), 0);
  const ok = async (limits: typeof DEFAULT_LIMITS) => cleanup((await run(entries, limits)).dir);
  await ok({ ...DEFAULT_LIMITS, maxArchiveBytes: zipBytes });
  await rejects(entries, /文件过大/, { ...DEFAULT_LIMITS, maxArchiveBytes: zipBytes - 1 });
  await ok({ ...DEFAULT_LIMITS, maxTotalBytes: declaredTotal });
  await rejects(entries, /体积过大/, { ...DEFAULT_LIMITS, maxTotalBytes: declaredTotal - 1 });
  await ok({ ...DEFAULT_LIMITS, maxEntries: 3 });
  await rejects(entries, /条目数量/, { ...DEFAULT_LIMITS, maxEntries: 2 });
});

test('多个中央目录条目引用同一份压缩数据时，解压总量按每个条目累计', async () => {
  const zeros = Buffer.alloc(4 * 1024 * 1024, 0);
  const base = addonEntries('A');
  const entries: ZipEntrySpec[] = [
    ...base,
    { name: 'A/z0.bin', data: zeros, deflate: true },
    { name: 'A/z1.bin', aliasOf: base.length },
    { name: 'A/z2.bin', aliasOf: base.length },
  ];
  const { res, dir, dest } = await run(entries);
  assert.ok(res.totalBytes >= 3 * zeros.length);
  assert.ok((await readFile(path.join(dest, 'A', 'z2.bin'))).equals(zeros));
  await cleanup(dir);
  await rejects(entries, /体积过大/, { ...DEFAULT_LIMITS, maxTotalBytes: 2 * zeros.length + 1024 });
});

test('解压阶段的数据错误正常拒绝且进程不崩溃：deflate 声明偏小、偏大、无效编码', async () => {
  const data = 'hello world hello world';
  const cases: [string, ZipEntrySpec][] = [
    ['声明偏小', { name: 'A/x.lua', data, deflate: true, declaredSize: 3 }],
    ['声明偏大', { name: 'A/x.lua', data, deflate: true, declaredSize: 999 }],
    // BFINAL=1、BTYPE=11（保留值）：真实无效的 deflate 编码
    ['无效编码', { name: 'A/x.lua', data, rawBody: Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00, 0x00]) }],
  ];
  for (const [label, spec] of cases) {
    await assert.rejects(run([...addonEntries('A'), spec]), (err: Error & { code?: string }) => {
      assert.equal(err.name, 'UserError', label);
      assert.equal(err.code, 'zip', label);
      assert.match(err.message, /压缩包校验失败/, label);
      return true;
    });
  }
  // 留出时间让迟到的流错误暴露：若有未处理的 error 事件，本测试文件的进程会崩溃并被 node:test 判为失败
  await new Promise((r) => setTimeout(r, 50));
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
