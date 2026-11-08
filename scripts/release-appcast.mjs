// 为一个发布 zip 生成并签名 Sparkle appcast，同时输出 SHA256SUMS。只生成文件，不上传。
// 私钥只由官方 sign_update 从 login Keychain 读取（--account），不出现在参数、输出或文件中。
// 生成前会确认：签名账户的公钥与安装包内置的 SUPublicEDKey 一致；归档签名可被同一公钥验证；
// 生产模式的下载地址只能是本仓库对应版本 Release 中的该文件。
// 更新说明：生产模式读取 release-notes/<版本>.txt（必须存在且非空），以纯文本 <description sparkle:format="plain-text"> 写入条目，
// 在 feed 签名之前加入；同一份正文另存为 RELEASE_NOTES.txt，供 GitHub Release 使用，两处内容一致。
//
// 用法：
//   node scripts/release-appcast.mjs --zip release/BeeLite-0.1.3-arm64-mac.zip
//   （e2e）node scripts/release-appcast.mjs --mode e2e --zip <zip> --account <测试账户> --download-url <url> --out <目录> --feed <url> --key <公钥> [--notes <说明文件>]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION, PROJECT_ROOT, TOOLS_DIR, sha256 } from './sparkle-common.mjs';
import { buildAppcast, checkSigningKey, isMain, parseSignOutput, resolveDownloadUrl, resolveReleaseNotes, threePart } from './release-lib.mjs';
import { verifyApp } from './verify-app.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败：${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function main() {
  const mode = arg('--mode', 'production');
  const zip = path.resolve(arg('--zip', ''));
  const account = arg('--account', PRODUCTION.keyAccount);
  const outDir = path.resolve(arg('--out', path.dirname(zip)));
  if (!arg('--zip')) throw new Error('缺少 --zip');
  if (mode === 'production' && account !== PRODUCTION.keyAccount) throw new Error('生产发布必须使用 app.beelite.addons 签名账户');

  // 压缩包只能包含一个 .app（Sparkle 要求），并在解压后通过完整的产物校验
  const entries = run('/usr/bin/zipinfo', ['-1', zip]).split('\n').filter(Boolean);
  const tops = new Set(entries.map((e) => e.split('/')[0]));
  if (tops.size !== 1 || ![...tops][0].endsWith('.app')) throw new Error(`压缩包应只包含一个 .app，实际：${[...tops].join(', ')}`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'beelite-appcast-'));
  try {
    run('/usr/bin/ditto', ['-x', '-k', zip, tmp]);
    const app = path.join(tmp, (await readdir(tmp)).find((n) => n.endsWith('.app')));
    const { errors, info } = verifyApp(mode, app, { feed: arg('--feed'), key: arg('--key') });
    if (errors.length) throw new Error(`解压后的应用校验失败：\n- ${errors.join('\n- ')}`);

    const version = info.CFBundleVersion;
    const shortVersion = info.CFBundleShortVersionString;
    const zipName = path.basename(zip);
    const url = resolveDownloadUrl({ mode, override: arg('--download-url'), version: shortVersion, zipName });
    const { file: notesFile, notes } = resolveReleaseNotes({
      mode,
      version: shortVersion,
      override: arg('--notes'),
      readText: (p) => readFileSync(path.resolve(PROJECT_ROOT, p), 'utf8'),
    });

    // 签名账户的公钥必须与包内公钥一致（只读查询，不会生成新密钥）
    checkSigningKey(() => run(path.join(TOOLS_DIR, 'generate_keys'), ['--account', account, '-p']), info.SUPublicEDKey, account);

    const sign = path.join(TOOLS_DIR, 'sign_update');
    const { signature, length } = parseSignOutput(run(sign, ['--account', account, zip]));
    // 立即用同一账户校验归档签名
    run(sign, ['--account', account, '--verify', zip, signature]);

    const feedPath = path.join(outDir, 'appcast.xml');
    await writeFile(
      feedPath,
      buildAppcast({
        title: mode === 'production' ? '蜂简 BeeLite' : `蜂简 ${info.CFBundleName}`,
        itemTitle: `蜂简 ${shortVersion}`,
        pubDate: new Date().toUTCString(),
        version,
        shortVersion,
        minimumSystemVersion: threePart(info.LSMinimumSystemVersion),
        url,
        length,
        signature,
        notes: notes ?? undefined,
      }),
    );
    // 给 feed 本身签名（SURequireSignedFeed），并立即校验；说明已在签名之前写入
    run(sign, ['--account', account, feedPath]);
    run(sign, ['--account', account, '--verify', feedPath]);

    const sums = [`${await sha256(zip)}  ${zipName}`, `${await sha256(feedPath)}  appcast.xml`].join('\n');
    await writeFile(path.join(outDir, 'SHA256SUMS'), `${sums}\n`);
    if (notes) await writeFile(path.join(outDir, 'RELEASE_NOTES.txt'), `${notes}\n`);
    const notesLine = notes ? `更新说明取自 ${notesFile}（${notes.length} 字符），已写入 feed 与 RELEASE_NOTES.txt` : '未写入更新说明';
    console.log(`[appcast] ${feedPath}\n  版本 ${shortVersion}（${version}），${length} 字节\n  下载地址 ${url}\n  ${notesLine}\n  签名公钥与包内 SUPublicEDKey 一致；归档与 feed 签名已校验；SHA256SUMS 已写入`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[appcast] ${err.message}`);
    process.exit(1);
  });
}
