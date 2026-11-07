// 构建客户端更新 E2E 验收所需的两个隔离测试版本与本地 feed（只生成文件，不启动应用）。
// - 测试身份：productName “BeeLite E2E”、appId app.beelite.addons.e2e（userData 与 Sparkle 偏好随之隔离，重启不依赖环境变量）
// - 测试签名：每次运行新建一个唯一的 Keychain 账户（beelite-e2e-<时间>-<随机>），记录在 identity.json，验收后按记录删除
// - feed：http://127.0.0.1:<端口>/appcast.xml，由 scripts/e2e-feed-server.mjs 提供；附带若干负向用例目录
//
// 用法：node scripts/build-e2e.mjs [--out <目录>] [--port 47831]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PROJECT_ROOT, TOOLS_DIR } from './sparkle-common.mjs';
import { buildAppcast } from './release-lib.mjs';
import { verifyApp } from './verify-app.mjs';

const require = createRequire(import.meta.url);
const PRODUCT = 'BeeLite E2E';
const APP_ID = 'app.beelite.addons.e2e';
const VERSIONS = ['0.9.1', '0.9.2'];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ''} 失败：${(r.stderr || r.stdout || '').trim().slice(-1500)}`);
  return r.stdout ?? '';
}

async function main() {
  const port = Number(arg('--port', '47831'));
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const outRoot = path.resolve(arg('--out', path.join(PROJECT_ROOT, '..', '..', 'work', 'client-update-e2e', `run-${runId}`)));
  if (outRoot.startsWith('/Applications')) throw new Error('输出目录不能位于 /Applications');
  await mkdir(outRoot, { recursive: true });
  const feedURL = `http://127.0.0.1:${port}/appcast.xml`;

  // 1. 编译代码与原生桥
  run('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  run('npm', ['run', 'native'], { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // 2. 新建本次专用测试签名账户（只输出公钥）
  const account = `beelite-e2e-${runId}`;
  const keyOut = run(path.join(TOOLS_DIR, 'generate_keys'), ['--account', account]);
  const publicKey = /<string>([A-Za-z0-9+/=]+)<\/string>/.exec(keyOut)?.[1];
  if (!publicKey) throw new Error('未能取得测试公钥');
  const identity = {
    createdAt: new Date().toISOString(),
    productName: PRODUCT,
    appId: APP_ID,
    feedURL,
    keychainAccount: account,
    publicKey,
    deleteTestKey: `security delete-generic-password -s https://sparkle-project.org -a ${account}`,
    userData: `~/Library/Application Support/${PRODUCT}`,
  };
  await writeFile(path.join(outRoot, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);

  // 3. 构建两个测试版本
  const { build, Platform, Arch } = require('electron-builder');
  const base = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).build;
  const zips = {};
  for (const version of VERSIONS) {
    const cfg = structuredClone(base);
    cfg.appId = APP_ID;
    cfg.productName = PRODUCT;
    cfg.directories = { output: path.join(outRoot, `v${version}`), buildResources: 'build' };
    cfg.afterPack = path.join(PROJECT_ROOT, 'scripts', 'after-pack.cjs');
    cfg.extraMetadata = { productName: PRODUCT, version };
    cfg.mac.extendInfo = { ...cfg.mac.extendInfo, SUFeedURL: feedURL, SUPublicEDKey: publicKey };
    cfg.mac.artifactName = 'BeeLite-E2E-${version}-${arch}-mac.${ext}';
    await build({ projectDir: PROJECT_ROOT, targets: Platform.MAC.createTarget(['dir', 'zip'], Arch.arm64), config: cfg, publish: 'never' });
    const app = path.join(outRoot, `v${version}`, 'mac-arm64', `${PRODUCT}.app`);
    const { errors, info } = verifyApp('e2e', app, { feed: feedURL, key: publicKey });
    if (errors.length) throw new Error(`测试包 ${version} 校验失败：\n- ${errors.join('\n- ')}`);
    if (info.CFBundleShortVersionString !== version) throw new Error(`测试包版本应为 ${version}，实际 ${info.CFBundleShortVersionString}`);
    zips[version] = path.join(outRoot, `v${version}`, `BeeLite-E2E-${version}-arm64-mac.zip`);
  }

  // 4. 为新版本生成 feed：正常用例与负向用例
  const newer = VERSIONS[1];
  const zipName = path.basename(zips[newer]);
  const feedRoot = path.join(outRoot, 'feed');
  const ok = path.join(feedRoot, 'ok');
  await mkdir(ok, { recursive: true });
  await copyFile(zips[newer], path.join(ok, zipName));
  run(process.execPath, [
    path.join(PROJECT_ROOT, 'scripts', 'release-appcast.mjs'),
    '--mode', 'e2e', '--zip', path.join(ok, zipName), '--account', account,
    '--download-url', `http://127.0.0.1:${port}/${zipName}`, '--out', ok, '--feed', feedURL, '--key', publicKey,
  ]);
  const okFeed = await readFile(path.join(ok, 'appcast.xml'), 'utf8');

  // 篡改归档：feed 签名有效，但归档中间一个字节被改动，EdDSA 校验应失败
  const badArchive = path.join(feedRoot, 'bad-archive');
  await mkdir(badArchive, { recursive: true });
  const zipBytes = await readFile(zips[newer]);
  zipBytes[Math.floor(zipBytes.length / 2)] ^= 0xff;
  await writeFile(path.join(badArchive, zipName), zipBytes);
  await writeFile(path.join(badArchive, 'appcast.xml'), okFeed);

  // feed 被篡改：签名后修改标题
  const tampered = path.join(feedRoot, 'tampered-feed');
  await mkdir(tampered, { recursive: true });
  await copyFile(zips[newer], path.join(tampered, zipName));
  await writeFile(path.join(tampered, 'appcast.xml'), okFeed.replace(/<title>蜂简 0\.9\.2<\/title>/, '<title>蜂简 0.9.2 (modified)</title>'));

  // feed 未签名：同样的条目但没有 feed 签名
  const unsigned = path.join(feedRoot, 'unsigned-feed');
  await mkdir(unsigned, { recursive: true });
  await copyFile(zips[newer], path.join(unsigned, zipName));
  const enclosure = /sparkle:edSignature="([^"]+)"/.exec(okFeed)[1];
  const length = Number(/length="(\d+)"/.exec(okFeed)[1]);
  await writeFile(
    path.join(unsigned, 'appcast.xml'),
    buildAppcast({ title: `蜂简 ${PRODUCT}`, itemTitle: `蜂简 ${newer}`, pubDate: new Date().toUTCString(), version: newer, shortVersion: newer, minimumSystemVersion: '13.0.0', url: `http://127.0.0.1:${port}/${zipName}`, length, signature: enclosure }),
  );

  // 归档缺失：feed 有效，但服务器上没有 zip（下载返回 404）
  const missing = path.join(feedRoot, 'missing-archive');
  await mkdir(missing, { recursive: true });
  await writeFile(path.join(missing, 'appcast.xml'), okFeed);

  console.log(`\n[e2e] 完成：${outRoot}
  旧版应用：${path.join(outRoot, `v${VERSIONS[0]}`, 'mac-arm64', `${PRODUCT}.app`)}
  新版 feed：node scripts/e2e-feed-server.mjs ${ok} --port ${port}
  负向用例：${['bad-archive', 'tampered-feed', 'unsigned-feed', 'missing-archive'].map((d) => path.join(feedRoot, d)).join('\n            ')}
  测试签名账户：${account}（验收后删除：${identity.deleteTestKey}）`);
}

main().catch((err) => {
  console.error(`[e2e] ${err.message}`);
  process.exit(1);
});
