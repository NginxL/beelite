import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { displayName, resolveUserData } from '../src/core/identity';

test('显示名：生产包为“蜂简 BeeLite”，测试包带上自己的名称', () => {
  assert.equal(displayName('BeeLite'), '蜂简 BeeLite');
  assert.equal(displayName('BeeLite E2E'), '蜂简 BeeLite E2E');
});

test('userData：默认使用由 productName 决定的路径，只有显式覆盖时才改用指定目录', () => {
  const prod = '/Users/x/Library/Application Support/BeeLite';
  assert.equal(resolveUserData(prod, undefined, path.resolve), prod);
  assert.equal(resolveUserData(prod, '', path.resolve), prod);
  assert.equal(resolveUserData(prod, '/tmp/beelite-ui', path.resolve), '/tmp/beelite-ui');
});
