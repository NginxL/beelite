// 校验打包后的 .app：身份、Sparkle 设置、组件版本、原生桥最低系统与代码签名。
// 用法：node scripts/verify-app.mjs production <BeeLite.app>
//       node scripts/verify-app.mjs e2e <BeeLite E2E.app> --feed <url> --key <public-key>
// 生产模式会断言不含任何测试身份、测试 feed 或测试公钥。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isMain } from './release-lib.mjs';
import { PRODUCTION, PROJECT_ROOT } from './sparkle-common.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const SECURITY = {
  SUEnableAutomaticChecks: false,
  SUAutomaticallyUpdate: false,
  SUAllowsAutomaticUpdates: false,
  SUVerifyUpdateBeforeExtraction: true,
  SURequireSignedFeed: true,
  SUSignedFeedFailureExpirationInterval: 0,
};

function plist(file) {
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`无法读取 ${file}`);
  return JSON.parse(r.stdout);
}

function out(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, text: `${r.stdout}${r.stderr}` };
}

export function verifyApp(mode, appPath, expect = {}) {
  const errors = [];
  const check = (cond, msg) => cond || errors.push(msg);
  const info = plist(path.join(appPath, 'Contents', 'Info.plist'));
  const pkg = JSON.parse(asar.extractFile(path.join(appPath, 'Contents', 'Resources', 'app.asar'), 'package.json').toString('utf8'));
  const productionKey = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).build.mac.extendInfo.SUPublicEDKey;

  if (mode === 'production') {
    check(info.CFBundleIdentifier === PRODUCTION.appId, `CFBundleIdentifier 应为 ${PRODUCTION.appId}，实际 ${info.CFBundleIdentifier}`);
    check(info.CFBundleName === PRODUCTION.productName, `CFBundleName 应为 ${PRODUCTION.productName}`);
    check(info.CFBundleExecutable === PRODUCTION.productName, `CFBundleExecutable 应为 ${PRODUCTION.productName}，实际 ${info.CFBundleExecutable}`);
    check(path.basename(appPath) === `${PRODUCTION.productName}.app`, `应用文件名应为 ${PRODUCTION.productName}.app，实际 ${path.basename(appPath)}`);
    check(info.CFBundleDisplayName === PRODUCTION.displayName, `CFBundleDisplayName 应为 ${PRODUCTION.displayName}，实际 ${info.CFBundleDisplayName}`);
    check(info.NSHumanReadableCopyright === PRODUCTION.copyright, `NSHumanReadableCopyright 应为 ${PRODUCTION.copyright}，实际 ${info.NSHumanReadableCopyright}`);
    check(pkg.productName === PRODUCTION.productName, `包内 productName 应为 ${PRODUCTION.productName}，实际 ${pkg.productName}`);
    check(info.SUFeedURL === PRODUCTION.feedURL, `SUFeedURL 应为生产地址，实际 ${info.SUFeedURL}`);
    check(info.SUPublicEDKey === productionKey, 'SUPublicEDKey 与 package.json 中的生产公钥不一致');
    const text = JSON.stringify(info);
    check(!/e2e|127\.0\.0\.1|localhost/i.test(`${info.CFBundleIdentifier}${info.SUFeedURL}${pkg.productName}`), '生产包中出现测试身份或本地 feed');
    check(!text.includes('BeeLite E2E'), '生产包 Info.plist 中出现测试名称');
  } else if (mode === 'e2e') {
    check(info.CFBundleIdentifier !== PRODUCTION.appId, '测试包不得使用生产 appId');
    check(pkg.productName !== PRODUCTION.productName && info.CFBundleName !== PRODUCTION.productName, '测试包不得使用生产 productName');
    check(info.SUPublicEDKey !== productionKey, '测试包不得使用生产公钥');
    check(typeof info.CFBundleDisplayName === 'string' && info.CFBundleDisplayName !== PRODUCTION.displayName, '测试包的显示名不得与生产包相同');
    if (expect.displayName) check(info.CFBundleDisplayName === expect.displayName, `CFBundleDisplayName 应为 ${expect.displayName}，实际 ${info.CFBundleDisplayName}`);
    if (expect.feed) check(info.SUFeedURL === expect.feed, `SUFeedURL 应为 ${expect.feed}`);
    if (expect.key) check(info.SUPublicEDKey === expect.key, 'SUPublicEDKey 与测试公钥不一致');
  } else {
    throw new Error(`未知模式 ${mode}`);
  }
  for (const [k, v] of Object.entries(SECURITY)) check(info[k] === v, `${k} 应为 ${v}，实际 ${info[k]}`);
  check(info.LSMinimumSystemVersion === '13.0', `LSMinimumSystemVersion 应为 13.0，实际 ${info.LSMinimumSystemVersion}`);
  check(info.CFBundleVersion === pkg.version && info.CFBundleShortVersionString === pkg.version, 'CFBundleVersion / CFBundleShortVersionString 应等于版本号');

  const fw = path.join(appPath, 'Contents', 'Frameworks', 'Sparkle.framework');
  check(existsSync(fw), '缺少 Contents/Frameworks/Sparkle.framework');
  if (existsSync(fw)) {
    const fwInfo = plist(path.join(fw, 'Versions', 'B', 'Resources', 'Info.plist'));
    check(fwInfo.CFBundleShortVersionString === '2.9.6', `Sparkle 版本应为 2.9.6，实际 ${fwInfo.CFBundleShortVersionString}`);
  }
  check(existsSync(path.join(appPath, 'Contents', 'Resources', 'ThirdPartyLicenses', 'Sparkle-LICENSE.txt')), '缺少 Sparkle 许可证');
  const addon = path.join(appPath, 'Contents', 'Frameworks', 'beelite_sparkle.node');
  check(existsSync(addon), '缺少原生桥 beelite_sparkle.node');
  if (existsSync(addon)) {
    const m = /LC_BUILD_VERSION[\s\S]*?minos (\d+)\.(\d+)/.exec(out('/usr/bin/otool', ['-l', addon]).text);
    check(m && (Number(m[1]) < 13 || (Number(m[1]) === 13 && Number(m[2]) === 0)), `原生桥最低系统应不高于 13.0，实际 ${m ? `${m[1]}.${m[2]}` : '未知'}`);
  }
  const cs = out('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  check(cs.ok, `codesign --verify --deep --strict 失败：${cs.text.trim()}`);
  return { errors, info, pkg };
}

if (isMain(import.meta.url)) {
  const [mode, appPath, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const { errors, info } = verifyApp(mode, path.resolve(appPath), { feed: opt('--feed'), key: opt('--key') });
  if (errors.length) {
    console.error(`[verify] ${appPath} 校验失败：\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`[verify] ${mode} 通过：${info.CFBundleIdentifier} ${info.CFBundleShortVersionString}，feed ${info.SUFeedURL}`);
}
