import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BRAND_NAME, BRAND_NAME_EN, displayName, PRODUCTION_PRODUCT_NAME, resolveUserData } from '../src/core/identity';

test('显示名：生产包为“艾泽魔方 · AzerCube”，测试包带上自己的名称，与生产包可以区分', () => {
  assert.equal(BRAND_NAME, '艾泽魔方');
  assert.equal(BRAND_NAME_EN, 'AzerCube');
  assert.equal(displayName('BeeLite'), '艾泽魔方 · AzerCube');
  assert.equal(displayName('BeeLite E2E'), '艾泽魔方 BeeLite E2E');
  assert.notEqual(displayName('BeeLite E2E'), displayName('BeeLite'));
});

test('内部身份不随更名改变：生产 productName 仍为 BeeLite（决定默认 userData）', () => {
  assert.equal(PRODUCTION_PRODUCT_NAME, 'BeeLite');
});

test('userData：默认使用由 productName 决定的路径，只有显式覆盖时才改用指定目录', () => {
  const prod = '/Users/x/Library/Application Support/BeeLite';
  assert.equal(resolveUserData(prod, undefined, path.resolve), prod);
  assert.equal(resolveUserData(prod, '', path.resolve), prod);
  assert.equal(resolveUserData(prod, '/tmp/beelite-ui', path.resolve), '/tmp/beelite-ui');
});
