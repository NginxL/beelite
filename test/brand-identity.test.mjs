// 0.1.7 更名：用户可见品牌改为「艾泽魔方 · AzerCube」，安装、数据与更新信任身份保持 BeeLite 不变；测试包身份与生产包可以区分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appcastTitles } from '../scripts/release-lib.mjs';
import { PRODUCTION } from '../scripts/sparkle-common.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('生产身份：productName / appId / 更新渠道 / 公钥不变，只新增显示名与版权', () => {
  assert.equal(pkg.name, 'beelite');
  assert.equal(pkg.productName, 'BeeLite');
  assert.equal(pkg.build.productName, 'BeeLite');
  assert.equal(pkg.build.appId, 'app.beelite.addons');
  assert.equal(pkg.build.mac.extendInfo.SUFeedURL, 'https://github.com/NginxL/beelite/releases/latest/download/appcast.xml');
  assert.equal(pkg.build.mac.extendInfo.SUPublicEDKey, '1QVzcH29FNZEGtdtqFiWCYM5a51IpLd6CsanZIcXXTI=');
  assert.equal(pkg.build.mac.extendInfo.CFBundleDisplayName, '艾泽魔方');
  assert.ok(!('CFBundleName' in pkg.build.mac.extendInfo), '不覆盖 CFBundleName');
  assert.ok(!('CFBundleExecutable' in pkg.build.mac.extendInfo), '不覆盖 CFBundleExecutable');
  assert.ok(!('SUBundleName' in pkg.build.mac.extendInfo) && !('SUDefaultsDomain' in pkg.build.mac.extendInfo), '不改变 Sparkle 的名称与偏好域');
  assert.equal(pkg.build.mac.artifactName, undefined, '安装包文件名沿用默认的 BeeLite-<版本>-<架构>-mac.zip');
  assert.equal(pkg.build.copyright, 'Copyright © 2026 AzerCube');
  assert.deepEqual(
    { productName: PRODUCTION.productName, appId: PRODUCTION.appId, keyAccount: PRODUCTION.keyAccount, feedURL: PRODUCTION.feedURL, displayName: PRODUCTION.displayName, copyright: PRODUCTION.copyright },
    { productName: pkg.build.productName, appId: pkg.build.appId, keyAccount: pkg.build.appId, feedURL: pkg.build.mac.extendInfo.SUFeedURL, displayName: pkg.build.mac.extendInfo.CFBundleDisplayName, copyright: pkg.build.copyright },
    '发布校验所用的生产身份与打包配置一致',
  );
});

test('测试包身份：productName、appId 与显示名都与生产包不同，显示名显式覆盖而不继承生产值', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'build-e2e.mjs'), 'utf8');
  const constant = (name) => new RegExp(`const ${name} = '([^']+)';`).exec(src)?.[1];
  assert.equal(constant('PRODUCT'), 'BeeLite E2E');
  assert.equal(constant('APP_ID'), 'app.beelite.addons.e2e');
  assert.equal(constant('DISPLAY_NAME'), 'AzerCube E2E');
  assert.notEqual(constant('DISPLAY_NAME'), PRODUCTION.displayName);
  assert.match(src, /CFBundleDisplayName: DISPLAY_NAME/);
  assert.match(src, /displayName: DISPLAY_NAME \}\)/, '构建后按测试显示名校验');
});

test('appcast 标题：生产为新品牌，测试 feed 带上测试 productName；篡改用例以同一函数定位', () => {
  assert.deepEqual(appcastTitles({ mode: 'production', productName: 'BeeLite', version: '0.1.7' }), { title: '艾泽魔方 · AzerCube', itemTitle: '艾泽魔方 0.1.7' });
  assert.deepEqual(appcastTitles({ mode: 'e2e', productName: 'BeeLite E2E', version: '0.9.2' }), { title: '艾泽魔方 BeeLite E2E', itemTitle: '艾泽魔方 0.9.2' });
  const src = readFileSync(path.join(ROOT, 'scripts', 'build-e2e.mjs'), 'utf8');
  assert.match(src, /appcastTitles\(\{ mode: 'e2e'/);
  assert.match(src, /if \(tamperedFeed === okFeed\) throw/);
});
