// 更新策略（core）：按 游戏版本 + 目录 + 插件 隔离；文件不存在即没有暂停项；损坏 / 写入失败时策略未知并拒绝，原文件不变；
// 数量上限只拒绝新增，不影响恢复；未知字段保留。全部在临时目录中进行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../src/core/layout';
import { PolicyStore } from '../src/core/policy';
import { cleanup, tmpDir } from './helpers';

const F = 9;
const A = '/x/_forever_';
const B = '/y/_forever_';

async function setup() {
  const base = await tmpDir();
  return { base, file: path.join(base, 'addon-policy.json') };
}

test('策略：读取之前视为未知；文件不存在时没有暂停项且不创建文件', async () => {
  const { base, file } = await setup();
  try {
    const p = new PolicyStore(file);
    assert.match(p.current().error ?? '', /尚未读取/);
    await p.reload();
    assert.equal(p.current().error, null);
    assert.equal(await p.isPaused(F, A, '100'), false);
    await assert.rejects(readFile(file), /ENOENT/);
  } finally {
    await cleanup(base);
  }
});

test('策略：暂停 / 恢复按 版本 + 目录 + 插件 隔离并持久保存；重复操作无改动', async () => {
  const { base, file } = await setup();
  try {
    const p = new PolicyStore(file);
    let changes = 0;
    p.onChange(() => changes++);
    assert.equal(await p.set(F, A, '100', true), true);
    assert.equal(await p.set(F, A, '100', true), false);
    assert.equal(await p.isPaused(F, A, '100'), true);
    assert.equal(await p.isPaused(F, B, '100'), false, '另一个目录不受影响');
    assert.equal(await p.isPaused(6, A, '100'), false, '另一个游戏版本不受影响');
    assert.equal(await p.isPaused(F, A, '200'), false);
    assert.deepEqual([...(await p.pausedIn(F, A))], ['100']);
    assert.deepEqual(p.current().pausedIn(F, A), ['100']);
    assert.ok(changes >= 1);
    // 新的运行读取到同样的策略
    const q = new PolicyStore(file);
    assert.equal(await q.isPaused(F, A, '100'), true);
    assert.equal(await q.set(F, A, '100', false), true);
    assert.equal(await new PolicyStore(file).isPaused(F, A, '100'), false);
  } finally {
    await cleanup(base);
  }
});

test('策略：文件损坏 / 内容不合法时一律拒绝（不当作没有暂停），原文件不变；修复后重新读取恢复', async () => {
  for (const bad of ['{"schema":1,"paused":[', JSON.stringify({ schema: 2, paused: [] }), JSON.stringify({ schema: 1, paused: [{ flavorId: F, root: 'relative', modId: '1', pausedAt: 0 }] })]) {
    const { base, file } = await setup();
    try {
      await writeFile(file, bad);
      const p = new PolicyStore(file);
      await p.reload();
      assert.match(p.current().error ?? '', /无法读取插件更新策略文件/);
      await assert.rejects(p.isPaused(F, A, '100'), /已停止所有插件更新/);
      await assert.rejects(p.pausedIn(F, A), /已停止所有插件更新/);
      await assert.rejects(p.set(F, A, '100', true), /已停止所有插件更新/);
      await assert.rejects(p.set(F, A, '100', false), /已停止所有插件更新/);
      assert.equal(await readFile(file, 'utf8'), bad);
      await writeFile(file, JSON.stringify({ schema: 1, paused: [{ flavorId: F, root: A, modId: '100', pausedAt: 1 }] }));
      await p.reload();
      assert.equal(p.current().error, null);
      assert.equal(p.current().isPaused(F, A, '100'), true);
    } finally {
      await cleanup(base);
    }
  }
});

test('策略：保存失败时抛出，暂停状态与文件都不变', async () => {
  const { base, file } = await setup();
  try {
    let fail = false;
    const p = new PolicyStore(file, { write: async (f, t) => (fail ? Promise.reject(new Error('只读磁盘')) : writeFileAtomic(f, t)) });
    await p.set(F, A, '100', true);
    const before = await readFile(file, 'utf8');
    fail = true;
    await assert.rejects(p.set(F, A, '200', true), /保存更新策略失败，暂停状态保持不变/);
    await assert.rejects(p.set(F, A, '100', false), /保存更新策略失败/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(p.current().isPaused(F, A, '100'), true);
    assert.equal(p.current().isPaused(F, A, '200'), false);
  } finally {
    await cleanup(base);
  }
});

test('策略：达到上限时拒绝新增、不淘汰旧暂停项；恢复不受上限影响；未知字段保留', async () => {
  const { base, file } = await setup();
  try {
    await writeFile(file, JSON.stringify({ schema: 1, paused: [], note: 'keep' }));
    const p = new PolicyStore(file, { limits: { maxEntries: 2 } });
    await p.set(F, A, '1', true);
    await p.set(F, A, '2', true);
    await assert.rejects(p.set(F, A, '3', true), /上限/);
    assert.deepEqual([...(await p.pausedIn(F, A))].sort(), ['1', '2']);
    assert.equal(await p.set(F, A, '1', false), true);
    assert.equal(await p.set(F, A, '3', true), true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).note, 'keep');
  } finally {
    await cleanup(base);
  }
});
