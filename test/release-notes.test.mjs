// 更新说明的发布流程（0.1.3）：纯函数，不访问 Keychain、不签名、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppcast, descriptionElement, MAX_NOTES_CHARS, normalizeReleaseNotes, releaseNotesFile, resolveReleaseNotes } from '../scripts/release-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = {
  title: '蜂简 BeeLite',
  itemTitle: '蜂简 0.1.4',
  pubDate: 'Sun, 08 Nov 2026 00:00:00 GMT',
  version: '0.1.4',
  shortVersion: '0.1.4',
  minimumSystemVersion: '13.0.0',
  url: 'https://github.com/NginxL/beelite/releases/download/v0.1.4/BeeLite-0.1.4-arm64-mac.zip',
  length: 123,
  signature: 'abc=',
};

test('appcast 说明：使用官方属性 sparkle:format="plain-text"，正文 XML 转义；不写外部说明链接', () => {
  const xml = buildAppcast({ ...base, notes: '修复 <script>alert(1)</script> & "引号"\r\n第二行' });
  assert.match(xml, /<description sparkle:format="plain-text">修复 &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;引号&quot;\n第二行<\/description>/);
  assert.doesNotMatch(xml, /descriptionFormat/, '不能使用 SUAppcastItem 的属性名代替 XML 属性名');
  assert.doesNotMatch(xml, /releaseNotesLink|fullReleaseNotesLink/);
  assert.doesNotMatch(xml, /<script>/);
});

test('appcast 不带说明时与原有输出一致（旧版本客户端与 e2e 负向用例沿用）', () => {
  const xml = buildAppcast(base);
  assert.doesNotMatch(xml, /<description/);
  assert.match(xml, /<pubDate>[^<]+<\/pubDate>\n      <sparkle:version>0\.1\.4<\/sparkle:version>/);
});

test('说明校验：去掉 BOM 与首尾空白、统一换行；拒绝空内容、超长、控制字符与无效 Unicode', () => {
  assert.equal(normalizeReleaseNotes('﻿  a\r\nb\rc  \n'), 'a\nb\nc');
  assert.throws(() => normalizeReleaseNotes(' \n '), /为空/);
  assert.throws(() => normalizeReleaseNotes('x'.repeat(MAX_NOTES_CHARS + 1)), /过长/);
  assert.equal(normalizeReleaseNotes('x'.repeat(MAX_NOTES_CHARS)).length, MAX_NOTES_CHARS);
  assert.throws(() => normalizeReleaseNotes('a\u0000b'), /控制字符/);
  assert.throws(() => normalizeReleaseNotes('a\u001bb'), /控制字符/);
  assert.throws(() => normalizeReleaseNotes('a\uD800b'), /无效的 Unicode/);
  assert.throws(() => descriptionElement(''), /为空/);
  assert.throws(() => normalizeReleaseNotes(undefined), /必须是文本/);
});

test('说明来源：生产只读 release-notes/<版本>.txt，缺失或为空即失败且拒绝 --notes；e2e 可选', () => {
  const files = { [path.join('release-notes', '0.1.4.txt')]: '0.1.4 的说明\n', 'fixture.txt': 'e2e 说明' };
  const readText = (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };
  assert.deepEqual(resolveReleaseNotes({ mode: 'production', version: '0.1.4', readText }), { file: path.join('release-notes', '0.1.4.txt'), notes: '0.1.4 的说明' });
  assert.throws(() => resolveReleaseNotes({ mode: 'production', version: '0.1.5', readText }), /缺少 release-notes\/0\.1\.5\.txt/);
  assert.throws(() => resolveReleaseNotes({ mode: 'production', version: '0.1.4', override: 'fixture.txt', readText }), /拒绝 --notes/);
  assert.throws(() => resolveReleaseNotes({ mode: 'production', version: '0.1.4', readText: () => '  ' }), /为空/);
  assert.throws(() => releaseNotesFile('../0.1.4'), /版本号格式不正确/);
  assert.deepEqual(resolveReleaseNotes({ mode: 'e2e', version: '0.9.2', readText }), { file: null, notes: null });
  assert.equal(resolveReleaseNotes({ mode: 'e2e', version: '0.9.2', override: 'fixture.txt', readText }).notes, 'e2e 说明');
});

test('仓库：当前版本的说明文件存在且合法；e2e 夹具说明合法', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version, 'package-lock 版本与 package.json 一致');
  assert.equal(lock.packages[''].version, pkg.version);
  const notes = normalizeReleaseNotes(readFileSync(path.join(ROOT, releaseNotesFile(pkg.version)), 'utf8'));
  assert.ok(notes.includes(pkg.version));
  normalizeReleaseNotes(readFileSync(path.join(ROOT, 'test', 'fixtures', 'e2e-release-notes.txt'), 'utf8'));
});
