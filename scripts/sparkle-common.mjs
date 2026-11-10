// Sparkle 官方发布包的固定来源与校验信息（2.9.6，Sparkle-for-Swift-Package-Manager.zip）。
// 该归档包含 Sparkle.xcframework、LICENSE 与官方工具 bin/（generate_keys、sign_update 等）。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPARKLE_VERSION = '2.9.6';
export const SPARKLE_URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-for-Swift-Package-Manager.zip`;
export const SPARKLE_SHA256 = '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(PROJECT_ROOT, 'native', 'vendor');
export const FRAMEWORK_PATH = path.join(VENDOR_DIR, 'Sparkle.framework');
export const TOOLS_DIR = path.join(VENDOR_DIR, 'bin');
export const SPARKLE_LICENSE = path.join(VENDOR_DIR, 'Sparkle-LICENSE');
export const ADDON_PATH = path.join(PROJECT_ROOT, 'native', 'build', 'Release', 'beelite_sparkle.node');

// 生产身份：productName / 可执行文件 / 应用文件名沿用 BeeLite（userData 与更新信任链不变）。
// raw CFBundleDisplayName 也是 BeeLite，与应用文件名一致，系统才会采用本地化显示名；
// 用户在访达、程序坞看到的品牌由各语言的 InfoPlist.strings 提供（见 brand-localization.cjs，0.1.8 起）
export const PRODUCTION = {
  productName: 'BeeLite',
  rawDisplayName: 'BeeLite',
  developmentRegion: 'en',
  localizations: ['en', 'zh-Hans', 'zh-Hant'],
  localizedInfo: { CFBundleName: '艾泽魔方', CFBundleDisplayName: '艾泽魔方 · AzerCube' },
  copyright: 'Copyright © 2026 AzerCube',
  appId: 'app.beelite.addons',
  feedURL: 'https://github.com/NginxL/beelite/releases/latest/download/appcast.xml',
  keyAccount: 'app.beelite.addons',
};

export async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
