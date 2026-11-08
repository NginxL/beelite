// 更新说明的原生读取（0.1.3）：编译 native/test/appcast_notes_test.m，链接 vendor 中官方 Sparkle 2.9.6，
// 用 Sparkle 自己的 SUAppcast 解析发布脚本生成的 appcast，再经原生桥共用的 BLNotesOf 读取。
// 验证：正确属性 sparkle:format="plain-text" 能读出原文；写成 sparkle:descriptionFormat 时 Sparkle 视为 html、不显示；
// 签名未通过（Failed / Skipped）不显示；超长按上限截断；不含外部说明链接。不访问 Keychain、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanup, tmpDir } from './helpers';

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'native', 'vendor');
const SRC = path.join(ROOT, 'native', 'test', 'appcast_notes_test.m');
const hasCc = process.platform === 'darwin' && spawnSync('/usr/bin/xcrun', ['--find', 'clang'], { encoding: 'utf8' }).status === 0;
const hasSparkle = existsSync(path.join(VENDOR, 'Sparkle.framework', 'Versions', 'B', 'Sparkle'));
const skip = !hasCc ? '需要 macOS 与 Xcode 命令行工具' : !hasSparkle ? '需要先运行 npm run native 取得官方 Sparkle.framework' : false;

const NOTES = '修复 <script>alert(1)</script> & "引号"\n第二行 😀';

test('原生读取更新说明：只接受签名通过的 sparkle:format="plain-text"，错误属性名、HTML、缺失、签名失败都不显示正文', { skip }, async () => {
  // 发布脚本是 ES 模块：在子进程中调用真实的 buildAppcast 生成 feed
  const buildAppcast = (o: Record<string, unknown>): string => {
    const code = `import { buildAppcast } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'release-lib.mjs')).href)};\nprocess.stdout.write(buildAppcast(JSON.parse(process.argv[1])));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(o)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const dir = await tmpDir();
  try {
    const bin = path.join(dir, 'appcast_notes_test');
    const cc = spawnSync('/usr/bin/xcrun', [
      'clang', '-fobjc-arc', '-Wall', '-Werror', `-F${VENDOR}`, `-I${path.join(VENDOR, 'Sparkle.framework', 'Versions', 'B', 'PrivateHeaders')}`,
      '-framework', 'Foundation', '-framework', 'Sparkle', `-Wl,-rpath,${VENDOR}`, SRC, '-o', bin,
    ], { encoding: 'utf8' });
    assert.equal(cc.status, 0, cc.stderr);

    const feed = (notes?: string) => buildAppcast({
      title: '蜂简', itemTitle: '蜂简 0.1.4', pubDate: 'Sun, 08 Nov 2026 00:00:00 GMT', version: '0.1.4', shortVersion: '0.1.4',
      minimumSystemVersion: '13.0.0', url: 'https://github.com/NginxL/beelite/releases/download/v0.1.4/x.zip', length: 1, signature: 'abc=', notes,
    });
    const ok = feed(NOTES);
    const files: Record<string, string> = {
      ok,
      wrongAttr: ok.replace('sparkle:format=', 'sparkle:descriptionFormat='),
      html: ok.replace('sparkle:format="plain-text"', 'sparkle:format="html"'),
      none: feed(),
      long: ok.replace(/<description([^>]*)>[\s\S]*?<\/description>/, `<description$1>${'字'.repeat(5000)}</description>`),
    };
    for (const [k, v] of Object.entries(files)) await writeFile(path.join(dir, `${k}.xml`), v);
    const parse = (status: number, ...names: string[]) => {
      const r = spawnSync(bin, [String(status), ...names.map((n) => path.join(dir, `${n}.xml`))], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    };

    const [a, wrong, html, none, long] = parse(1, 'ok', 'wrongAttr', 'html', 'none', 'long');
    assert.equal(a.itemDescriptionFormat, 'plain-text');
    assert.equal(a.notesState, 'ok');
    assert.equal(a.notes, NOTES, 'XML 转义后由 Sparkle 还原为原文');
    assert.equal(a.notesTruncated, false);
    assert.equal(a.version, '0.1.4');
    assert.equal(a.hasReleaseNotesURL, 0);
    assert.equal(wrong.itemDescriptionFormat, 'html', '错误的属性名被 Sparkle 视为 html');
    assert.equal(wrong.notesState, 'unsupported');
    assert.equal(wrong.notes, undefined);
    assert.equal(html.notesState, 'unsupported');
    assert.equal(none.notesState, 'missing');
    assert.equal(long.notesState, 'ok');
    assert.equal(long.notesTruncated, true);
    assert.equal((long.notes as string).length, 4000);

    const [failed] = parse(2, 'ok');
    assert.equal(failed.notesState, 'unverified');
    assert.equal(failed.notes, undefined);
    const [skipped] = parse(0, 'ok');
    assert.equal(skipped.notesState, 'unverified', '未要求签名（Skipped）的 feed 也不显示说明');
  } finally {
    await cleanup(dir);
  }
});
