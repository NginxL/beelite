// 0.1.8 系统显示名本地化的写入：只在临时目录中的模拟应用里写文件，用系统 plutil 解析，不打包、不签名、不启动应用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION } from '../scripts/sparkle-common.mjs';

const require = createRequire(import.meta.url);
const { writeLocalizedInfo } = require('../scripts/brand-localization.cjs');

/** 模拟应用；lprojs 是预先建好的空语言目录（真实打包产物经 electronLanguages 筛选后带有空的 en、en_GB、zh_CN） */
function fakeApp(t, lprojs = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beelite-brand-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'BeeLite.app');
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  for (const lang of lprojs) mkdirSync(path.join(app, 'Contents', 'Resources', `${lang}.lproj`));
  return app;
}

const resourcesOf = (app) => path.join(app, 'Contents', 'Resources');
const stringsPath = (app, lang) => path.join(resourcesOf(app), `${lang}.lproj`, 'InfoPlist.strings');

function parse(file) {
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('为三种语言写入相同的 InfoPlist.strings，系统 plutil 解析结果恰好是两个本地化名称', (t) => {
  const app = fakeApp(t);
  writeLocalizedInfo(app, PRODUCTION.localizations, PRODUCTION.localizedInfo);
  assert.deepEqual(readdirSync(path.join(app, 'Contents', 'Resources')).sort(), ['en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj']);
  for (const lang of PRODUCTION.localizations) {
    assert.deepEqual(parse(stringsPath(app, lang)), PRODUCTION.localizedInfo);
    assert.equal(readFileSync(stringsPath(app, lang), 'utf8'), '"CFBundleName" = "艾泽魔方";\n"CFBundleDisplayName" = "艾泽魔方 · AzerCube";\n');
  }
});

test('与真实打包产物相同的空 en / en_GB / zh_CN：删除多出的空目录，保留 en 并写入，其他资源不动', (t) => {
  const app = fakeApp(t, ['en', 'en_GB', 'zh_CN']);
  writeFileSync(path.join(resourcesOf(app), 'app.asar'), 'asar');
  writeLocalizedInfo(app, PRODUCTION.localizations, PRODUCTION.localizedInfo);
  assert.deepEqual(readdirSync(resourcesOf(app)).sort(), ['app.asar', 'en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj']);
  assert.equal(readFileSync(path.join(resourcesOf(app), 'app.asar'), 'utf8'), 'asar');
  for (const lang of PRODUCTION.localizations) assert.deepEqual(parse(stringsPath(app, lang)), PRODUCTION.localizedInfo);
});

test('多出的语言目录不是空目录时拒绝：内容保留，其他空目录也不删除，什么都不写', (t) => {
  const app = fakeApp(t, ['en', 'en_GB', 'zh_CN']);
  writeFileSync(path.join(resourcesOf(app), 'zh_CN.lproj', 'locale.pak'), 'pak');
  assert.throws(() => writeLocalizedInfo(app, PRODUCTION.localizations, PRODUCTION.localizedInfo), /zh_CN\.lproj 不是空目录，拒绝删除/);
  assert.equal(readFileSync(path.join(resourcesOf(app), 'zh_CN.lproj', 'locale.pak'), 'utf8'), 'pak');
  assert.deepEqual(readdirSync(resourcesOf(app)).sort(), ['en.lproj', 'en_GB.lproj', 'zh_CN.lproj']);
  assert.deepEqual(readdirSync(path.join(resourcesOf(app), 'en.lproj')), []);
});

test('语言目录是符号链接时拒绝，不跟随、不删除链接与目标', (t) => {
  const app = fakeApp(t, ['en']);
  const target = path.join(path.dirname(app), 'outside');
  mkdirSync(target);
  symlinkSync(target, path.join(resourcesOf(app), 'en_GB.lproj'));
  assert.throws(() => writeLocalizedInfo(app, PRODUCTION.localizations, PRODUCTION.localizedInfo), /en_GB\.lproj 不是普通目录/);
  assert.ok(lstatSync(path.join(resourcesOf(app), 'en_GB.lproj')).isSymbolicLink());
  assert.ok(existsSync(target));

  const app2 = fakeApp(t);
  const target2 = path.join(path.dirname(app2), 'outside2');
  mkdirSync(target2);
  symlinkSync(target2, path.join(resourcesOf(app2), 'zh-Hans.lproj'));
  assert.throws(() => writeLocalizedInfo(app2, PRODUCTION.localizations, PRODUCTION.localizedInfo), /zh-Hans\.lproj 不是普通目录/);
  assert.deepEqual(readdirSync(target2), [], '不通过链接写入外部目录');
  assert.ok(!existsSync(stringsPath(app2, 'en')));
});

test('任一语言已有 InfoPlist.strings 时拒绝覆盖，什么都不写', (t) => {
  const app = fakeApp(t);
  mkdirSync(path.dirname(stringsPath(app, 'zh-Hant')), { recursive: true });
  writeFileSync(stringsPath(app, 'zh-Hant'), '"CFBundleName" = "旧";\n');
  assert.throws(() => writeLocalizedInfo(app, PRODUCTION.localizations, PRODUCTION.localizedInfo), /zh-Hant\.lproj\/InfoPlist\.strings，拒绝覆盖/);
  assert.equal(readFileSync(stringsPath(app, 'zh-Hant'), 'utf8'), '"CFBundleName" = "旧";\n');
  assert.ok(!existsSync(stringsPath(app, 'en')) && !existsSync(stringsPath(app, 'zh-Hans')));
});

test('值中含有需要转义的字符时拒绝，什么都不写', (t) => {
  const app = fakeApp(t);
  for (const bad of ['a"b', 'a\\b', 'a\nb']) {
    assert.throws(() => writeLocalizedInfo(app, ['en'], { CFBundleName: bad }), /需要转义/);
  }
  assert.deepEqual(readdirSync(path.join(app, 'Contents', 'Resources')), []);
});
