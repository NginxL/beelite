// 操作记录（core）：受理 / 结算、跨运行的中断、保存失败与重试、文件损坏不覆盖、有界截断与淘汰、并发不丢记录。
// 全部在临时目录中进行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clipText, HistoryStore } from '../src/core/history';
import { writeFileAtomic } from '../src/core/layout';
import { cleanup, tmpDir } from './helpers';

const F = 9;
const ROOT = '/x/_forever_';
const OTHER = '/y/_forever_';

async function setup() {
  const base = await tmpDir();
  return { base, file: path.join(base, 'operation-history.json') };
}

test('记录：受理写入 accepted，结算按同一编号写入结果；新的在前、按目录隔离', async () => {
  const { base, file } = await setup();
  try {
    const s = new HistoryStore(file);
    const id = await s.begin({ flavorId: F, root: ROOT, kind: 'update', modId: '100', name: 'M', expectedFileId: '1' });
    let v = await s.list(F, ROOT);
    assert.deepEqual(v.entries.map((e) => [e.id, e.status]), [[id, 'accepted']]);
    await s.finish(id, { status: 'succeeded', message: '已更新', previous: { fileId: '1', version: 'v1' }, installed: { fileId: '2', version: 'v2' } });
    await s.finish(id, { status: 'failed', message: '重复结算' });
    await s.record({ flavorId: F, root: OTHER, kind: 'install', modId: '200', name: 'N' }, { status: 'failed', message: '网络中断' });
    v = await s.list(F, ROOT);
    assert.equal(v.entries.length, 1, '另一个目录的记录不出现');
    const e = v.entries[0];
    assert.equal(e.status, 'succeeded', '同一编号只结算一次');
    assert.deepEqual([e.previous, e.installed, e.expectedFileId], [{ fileId: '1', version: 'v1' }, { fileId: '2', version: 'v2' }, '1']);
    assert.equal(e.unsaved, undefined);
    assert.equal((await s.list(F, OTHER)).entries[0].status, 'failed');
    assert.equal((await s.list(6, ROOT)).entries.length, 0, '同一目录的其他游戏版本不串');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.schema, 1);
    assert.equal(raw.entries.length, 2);
    assert.equal(s.status().unsaved, 0);
  } finally {
    await cleanup(base);
  }
});

test('记录：上次运行留下的 accepted 显示为结果未确认，不推测成功或回滚；之后的保存把它定格', async () => {
  const { base, file } = await setup();
  try {
    const old = new HistoryStore(file);
    await old.begin({ flavorId: F, root: ROOT, kind: 'update', modId: '100', name: 'M', expectedFileId: '1' });
    // 进程在这里中断：没有结算
    const now = new HistoryStore(file);
    const v = await now.list(F, ROOT);
    assert.equal(v.entries[0].status, 'unconfirmed');
    assert.match(v.entries[0].message, /上次运行中断/);
    assert.equal(v.entries[0].installed, null, '不补写猜测的结果');
    await now.record({ flavorId: F, root: ROOT, kind: 'install', modId: '200', name: 'N' }, { status: 'succeeded', message: 'ok' });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(raw.entries.map((e: { status: string }) => e.status), ['unconfirmed', 'succeeded']);
  } finally {
    await cleanup(base);
  }
});

test('记录：保存失败不抛出，记录留在内存中继续显示为未保存；重试成功后写入磁盘', async () => {
  const { base, file } = await setup();
  try {
    let fail = true;
    const s = new HistoryStore(file, { write: async (f, t) => (fail ? Promise.reject(Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' })) : writeFileAtomic(f, t)) });
    const seen: number[] = [];
    s.onStatus((st) => seen.push(st.unsaved));
    await s.record({ flavorId: F, root: ROOT, kind: 'uninstall', modId: '100', name: 'M' }, { status: 'succeeded', message: '已卸载' });
    assert.equal(s.status().unsaved, 1);
    assert.match(s.status().saveError ?? '', /磁盘空间不足/);
    const v = await s.list(F, ROOT);
    assert.deepEqual(v.entries.map((e) => [e.status, e.unsaved]), [['succeeded', true]]);
    await assert.rejects(readFile(file), /ENOENT/);
    fail = false;
    const st = await s.retry();
    assert.deepEqual([st.unsaved, st.saveError], [0, null]);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).entries[0].status, 'succeeded');
    assert.ok(seen.length >= 2, '状态变化有通知');
  } finally {
    await cleanup(base);
  }
});

test('记录：文件损坏、未知版本、符号链接都不当作首次运行，不覆盖；新的记录在内存中可见，修复后可重试', async () => {
  for (const kind of ['json', 'schema', 'symlink', 'entry'] as const) {
    const { base, file } = await setup();
    try {
      const target = path.join(base, 'elsewhere.json');
      if (kind === 'json') await writeFile(file, '{"schema":1,"entries":[');
      if (kind === 'schema') await writeFile(file, JSON.stringify({ schema: 2, entries: [] }));
      if (kind === 'entry') await writeFile(file, JSON.stringify({ schema: 1, entries: [{ id: 'x' }] }));
      if (kind === 'symlink') {
        await writeFile(target, JSON.stringify({ schema: 1, entries: [] }));
        await symlink(target, file);
      }
      const before = kind === 'symlink' ? await readFile(target, 'utf8') : await readFile(file, 'utf8');
      const s = new HistoryStore(file);
      await s.record({ flavorId: F, root: ROOT, kind: 'install', modId: '100', name: 'M' }, { status: 'succeeded', message: 'ok' });
      assert.match(s.status().loadError ?? '', /操作记录文件无法读取/, kind);
      assert.equal(s.status().unsaved, 1, kind);
      const v = await s.list(F, ROOT);
      assert.deepEqual(v.entries.map((e) => [e.status, e.unsaved]), [['succeeded', true]], kind);
      assert.equal(kind === 'symlink' ? await readFile(target, 'utf8') : await readFile(file, 'utf8'), before, `${kind}：原文件不被覆盖`);
      // 用户把文件移走后重试
      await writeFile(path.join(base, 'moved'), '');
      await import('node:fs/promises').then((f) => f.rm(file));
      const st = await s.retry();
      assert.deepEqual([st.loadError, st.unsaved], [null, 0], kind);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).entries.length, 1, kind);
    } finally {
      await cleanup(base);
    }
  }
});

test('记录：名称、说明与提示按 UTF-8 字节截断并明确标注；提示条数超限时说明省略数量', async () => {
  const { base, file } = await setup();
  try {
    const s = new HistoryStore(file, { limits: { maxNameBytes: 64, maxMessageBytes: 128, maxWarningBytes: 64, maxWarnings: 3, maxWarningsTotalBytes: 1024 } });
    const long = '插件名称很长'.repeat(30);
    await s.record(
      { flavorId: F, root: ROOT, kind: 'update', modId: '100', name: long },
      { status: 'succeeded', message: '说明'.repeat(200), warnings: ['提示'.repeat(100), 'b', 'c', 'd', 'e'] },
    );
    const e = (await s.list(F, ROOT)).entries[0];
    assert.equal(e.truncated, true);
    assert.ok(Buffer.byteLength(e.name) <= 64 && e.name.endsWith('（已截断）'));
    assert.ok(Buffer.byteLength(e.message) <= 128 && e.message.endsWith('（已截断）'));
    assert.equal(e.warnings.length, 4);
    assert.ok(Buffer.byteLength(e.warnings[0]) <= 64);
    assert.equal(e.warnings[3], '另有 2 条提示未保存（已截断）');
    // 不拆开多字节字符
    const c = clipText('一二三四五六七八九十', 20);
    assert.ok(!c.text.includes('�'));
    assert.ok(Buffer.byteLength(c.text) <= 20);
    // 重新读取（新的运行）仍能通过严格校验
    assert.equal((await new HistoryStore(file, { limits: { maxNameBytes: 64, maxMessageBytes: 128, maxWarningBytes: 64, maxWarnings: 3 } }).list(F, ROOT)).entries.length, 1);
  } finally {
    await cleanup(base);
  }
});

test('记录：长中文版本名称按与读取相同的上限截断并标注，文件编号保持原值；写出的文件能读回，之后仍可继续保存', async () => {
  const { base, file } = await setup();
  try {
    const s = new HistoryStore(file);
    const long = '版本'.repeat(100); // 600 字节
    await s.record(
      { flavorId: F, root: ROOT, kind: 'update', modId: '100', name: 'M' },
      { status: 'succeeded', message: 'ok', previous: { fileId: '123456789012345', version: long }, installed: { fileId: '2', version: long } },
    );
    assert.equal(s.status().saveError, null);
    const fresh = new HistoryStore(file);
    const e = (await fresh.list(F, ROOT)).entries[0];
    assert.equal(fresh.status().loadError, null, '自己写出的文件能读回');
    assert.equal(e.truncated, true);
    assert.equal(e.previous?.fileId, '123456789012345');
    assert.equal(e.installed?.fileId, '2');
    for (const v of [e.previous!, e.installed!]) {
      assert.ok(Buffer.byteLength(v.version) <= 256);
      assert.ok(v.version.endsWith('（已截断）'));
    }
    await fresh.record({ flavorId: F, root: ROOT, kind: 'install', modId: '200', name: 'N' }, { status: 'succeeded', message: 'ok' });
    assert.equal(fresh.status().unsaved, 0);
    assert.equal((await new HistoryStore(file).list(F, ROOT)).entries.length, 2);
  } finally {
    await cleanup(base);
  }
});

test('记录：超过条数或字节上限时只淘汰最旧的已结束记录，进行中的不淘汰', async () => {
  const { base, file } = await setup();
  try {
    const s = new HistoryStore(file, { limits: { maxFinished: 3 } });
    const active = await s.begin({ flavorId: F, root: ROOT, kind: 'update', modId: '999', name: '进行中' });
    for (let i = 0; i < 6; i++) await s.record({ flavorId: F, root: ROOT, kind: 'install', modId: String(i), name: `M${i}` }, { status: 'succeeded', message: 'ok' });
    const v = await s.list(F, ROOT);
    assert.deepEqual(v.entries.map((e) => e.name), ['M5', 'M4', 'M3', '进行中']);
    assert.equal(v.entries[3].id, active);

    const small = path.join(base, 'small.json');
    const t = new HistoryStore(small, { limits: { maxFileBytes: 4096 } });
    for (let i = 0; i < 40; i++) await t.record({ flavorId: F, root: ROOT, kind: 'install', modId: String(i), name: `插件${i}` }, { status: 'succeeded', message: '完成'.repeat(20) });
    const text = await readFile(small, 'utf8');
    assert.ok(Buffer.byteLength(text) <= 4096);
    const names = (await t.list(F, ROOT)).entries.map((e) => e.name);
    assert.equal(names[0], '插件39', '最新的保留');
    assert.ok(names.length < 40);
    assert.equal(t.status().unsaved, 0);
  } finally {
    await cleanup(base);
  }
});

test('记录：两个目录并发受理与结算，写入串行，不丢记录', async () => {
  const { base, file } = await setup();
  try {
    await mkdir(base, { recursive: true });
    const s = new HistoryStore(file);
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const root = i % 2 ? ROOT : OTHER;
      const id = await s.begin({ flavorId: F, root, kind: 'install', modId: String(100 + i), name: `M${i}` });
      await s.finish(id, { status: i % 3 ? 'succeeded' : 'failed', message: 'x' });
    }));
    const a = await s.list(F, ROOT);
    const b = await s.list(F, OTHER);
    assert.equal(a.entries.length + b.entries.length, 20);
    assert.ok([...a.entries, ...b.entries].every((e) => e.status !== 'accepted'));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).entries.length, 20);
  } finally {
    await cleanup(base);
  }
});
