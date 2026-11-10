// electron-builder afterPack：在签名之前，把官方 Sparkle.framework 与客户端更新原生桥放进 Contents/Frameworks，
// 并附上 Sparkle 许可证；生产包另外写入系统显示名的本地化（测试包不继承）。
// 签名由 electron-builder 按嵌套顺序完成，这里不签名、不改动其他文件。
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeLocalizedInfo } = require('./brand-localization.cjs');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'native', 'vendor');
const FRAMEWORK = path.join(VENDOR, 'Sparkle.framework');
const ADDON = path.join(ROOT, 'native', 'build', 'Release', 'beelite_sparkle.node');
const STAMP = path.join(VENDOR, '.sparkle-version');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  for (const p of [FRAMEWORK, ADDON, STAMP]) {
    if (!existsSync(p)) throw new Error(`缺少 ${path.relative(ROOT, p)}，请先运行 npm run native`);
  }
  if (!readFileSync(STAMP, 'utf8').startsWith('2.9.6 ')) throw new Error('native/vendor 中的 Sparkle 版本不是 2.9.6');
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  const dest = path.join(frameworks, 'Sparkle.framework');
  if (existsSync(dest) || existsSync(path.join(frameworks, 'beelite_sparkle.node'))) throw new Error('应用中已存在 Sparkle 组件，拒绝覆盖');
  const r = spawnSync('/usr/bin/ditto', [FRAMEWORK, dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('复制 Sparkle.framework 失败');
  copyFileSync(ADDON, path.join(frameworks, 'beelite_sparkle.node'));
  const licenses = path.join(appPath, 'Contents', 'Resources', 'ThirdPartyLicenses');
  mkdirSync(licenses, { recursive: true });
  copyFileSync(path.join(VENDOR, 'Sparkle-LICENSE'), path.join(licenses, 'Sparkle-LICENSE.txt'));
  // 只有 appId 与应用文件名都是生产值时才写入本地化显示名；E2E 等测试包保持自己的显示名
  const { PRODUCTION } = await import(pathToFileURL(path.join(__dirname, 'sparkle-common.mjs')).href);
  const { id, productFilename } = context.packager.appInfo;
  if (id === PRODUCTION.appId && productFilename === PRODUCTION.productName) {
    writeLocalizedInfo(appPath, PRODUCTION.localizations, PRODUCTION.localizedInfo);
  }
};
