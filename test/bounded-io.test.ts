// 小型数据文件的有界读取与原子写入失败清理（0.2.0）：操作记录与更新策略共用。全部在临时目录中，FIFO 为测试自建。
// - 读取：符号链接、目录、FIFO 立即失败（不等待写端）；fstat 之后文件增长也最多读取上限 + 1 字节并拒绝。
// - 写入：write / fsync / rename 失败时只删除本次创建的临时文件；原文件与目录中的其他文件（包括别人的 .tmp）不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { io } from '../src/core/fsio';
import { HistoryStore } from '../src/core/history';
import { BoundedReadError, readBoundedFile, writeFileAtomic } from '../src/core/layout';
import { PolicyStore } from '../src/core/policy';
import { cleanup, tmpDir } from './helpers';

/** 在限定时间内完成，否则失败（不会让测试一直挂起） */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 自建 FIFO；结束时以非阻塞方式打开一次写端，万一有读端在等待也能放行 */
async function withFifo(fn: (fifo: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await tmpDir();
  const fifo = path.join(dir, 'pipe.json');
  execFileSync('mkfifo', [fifo]);
  try {
    await fn(fifo, dir);
  } finally {
    await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then((fh) => fh.close(), () => undefined);
    await cleanup(dir);
  }
}

test('有界读取：符号链接、目录、FIFO 立即失败，不跟随、不等待写端；不存在为 null；正常文件读回', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'a.json');
    assert.equal(await readBoundedFile(f, 100), null);
    await writeFile(f, '{"x":1}');
    assert.equal(await readBoundedFile(f, 100), '{"x":1}');
    assert.equal(await readBoundedFile(f, 7), '{"x":1}', '恰好等于上限可以读取');
    await assert.rejects(readBoundedFile(f, 6), (e: unknown) => e instanceof BoundedReadError && e.reason === 'too-large');
    const link = path.join(dir, 'link.json');
    await symlink(f, link);
    await assert.rejects(readBoundedFile(link, 100), (e: unknown) => e instanceof BoundedReadError && e.reason === 'symlink');
    await mkdir(path.join(dir, 'd'));
    await assert.rejects(readBoundedFile(path.join(dir, 'd'), 100), (e: unknown) => e instanceof BoundedReadError && e.reason === 'not-file');
  } finally {
    await cleanup(dir);
  }
  await withFifo(async (fifo) => {
    await within(assert.rejects(readBoundedFile(fifo, 100), (e: unknown) => e instanceof BoundedReadError && e.reason === 'not-file'), 2000, 'FIFO');
  });
});

test('有界读取：fstat 之后文件增长，最多读取上限 + 1 字节并拒绝，不按文件实际大小分配', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'grow.json');
  const max = 1000;
  await writeFile(f, 'x'.repeat(max * 5));
  // 取得 FileHandle 的原型：让 fstat 报告增长之前的大小，并记录实际请求读取的字节数
  const probe = await open(f, 'r');
  const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<{ size: number }>; read: (...a: unknown[]) => Promise<{ bytesRead: number }> };
  await probe.close();
  const realStat = proto.stat;
  const realRead = proto.read;
  let requested = 0;
  proto.stat = async function (this: unknown, ...a: unknown[]) {
    const st = await realStat.apply(this, a);
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 10 });
  };
  proto.read = async function (this: unknown, ...a: unknown[]) {
    requested += a[2] as number;
    return realRead.apply(this, a);
  };
  try {
    await assert.rejects(readBoundedFile(f, max), (e: unknown) => e instanceof BoundedReadError && e.reason === 'too-large');
    assert.ok(requested <= max + 1, `最多请求 ${max + 1} 字节，实际 ${requested}`);
  } finally {
    proto.stat = realStat;
    proto.read = realRead;
    await cleanup(dir);
  }
});

test('操作记录与更新策略：路径是 FIFO 时快速失败并 fail closed，不挂起', async () => {
  await withFifo(async (fifo) => {
    const s = new HistoryStore(fifo);
    const v = await within(s.list(9, '/x/_forever_'), 2000, '记录读取');
    assert.match(v.status.loadError ?? '', /不是普通文件/);
    const p = new PolicyStore(fifo);
    await within(p.reload(), 2000, '策略读取');
    assert.match(p.current().error ?? '', /不是普通文件/);
    await within(assert.rejects(p.isPaused(9, '/x/_forever_', '1'), /已停止所有插件更新/), 2000, '策略判断');
  });
});

test('原子写入：write / fsync / rename 失败只清理本次的临时文件；原文件与他人的文件不变', async () => {
  const dir = await tmpDir();
  const realWrite = io.write;
  const realSync = io.sync;
  try {
    const target = path.join(dir, 'data.json');
    await writeFile(target, 'original');
    const foreign = path.join(dir, 'data.json.deadbeef.tmp');
    await writeFile(foreign, 'someone else');
    const listing = async () => (await readdir(dir)).sort();
    const before = await listing();

    io.write = async () => ({ bytesWritten: 0 });
    await assert.rejects(writeFileAtomic(target, 'new'), /写入/);
    io.write = realWrite;
    assert.deepEqual(await listing(), before, 'write 失败：没有遗留临时文件');

    io.sync = async () => {
      throw Object.assign(new Error('fsync 失败（测试）'), { code: 'EIO' });
    };
    await assert.rejects(writeFileAtomic(target, 'new'), /fsync/);
    io.sync = realSync;
    assert.deepEqual(await listing(), before, 'fsync 失败：没有遗留临时文件');

    // rename 失败：目标是非空目录
    const dirTarget = path.join(dir, 'occupied');
    await mkdir(dirTarget);
    await writeFile(path.join(dirTarget, 'keep'), 'k');
    const before2 = await listing();
    await assert.rejects(writeFileAtomic(dirTarget, 'new'));
    assert.deepEqual(await listing(), before2, 'rename 失败：没有遗留临时文件');
    assert.deepEqual(await readdir(dirTarget), ['keep']);

    assert.equal(await readFile(target, 'utf8'), 'original');
    assert.equal(await readFile(foreign, 'utf8'), 'someone else', '他人的临时文件不被删除');
    await writeFileAtomic(target, 'new');
    assert.equal(await readFile(target, 'utf8'), 'new');
    assert.deepEqual(await listing(), before2, '成功写入后也没有遗留临时文件（rename 失败用例的目录仍保留）');
  } finally {
    io.write = realWrite;
    io.sync = realSync;
    await cleanup(dir);
  }
});

/** 让随机临时文件名按给定顺序出现（替换 node:crypto 的 randomBytes），返回恢复函数 */
function scriptRandom(hex: string[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('node:crypto') as { randomBytes: (n: number) => Buffer };
  const real = mod.randomBytes;
  let i = 0;
  mod.randomBytes = (n: number) => (i < hex.length ? Buffer.from(hex[i++], 'hex') : real(n));
  return () => {
    mod.randomBytes = real;
  };
}

test('原子写入：随机临时文件名与已有文件冲突时绝不删除它；有限次重选后成功，或以 EEXIST 失败且原文件不变', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'history.json');
  const taken = `${target}.deadbeef.tmp`;
  try {
    await writeFile(target, 'original target');
    await writeFile(taken, 'existing unrelated temp');

    // 一直冲突：失败，目标与已有临时文件都不变
    let restore = scriptRandom(Array(10).fill('deadbeef'));
    try {
      await assert.rejects(writeFileAtomic(target, 'replacement'), (e: NodeJS.ErrnoException) => e.code === 'EEXIST');
    } finally {
      restore();
    }
    assert.equal(await readFile(target, 'utf8'), 'original target');
    assert.equal(await readFile(taken, 'utf8'), 'existing unrelated temp');

    // 冲突一次后换名成功：已有文件不变，没有遗留本次临时文件
    restore = scriptRandom(['deadbeef', 'cafebabe']);
    try {
      await writeFileAtomic(target, 'replacement');
    } finally {
      restore();
    }
    assert.equal(await readFile(target, 'utf8'), 'replacement');
    assert.equal(await readFile(taken, 'utf8'), 'existing unrelated temp');
    assert.deepEqual((await readdir(dir)).sort(), ['history.json', 'history.json.deadbeef.tmp']);
  } finally {
    await cleanup(dir);
  }
});

test('原子写入：显式临时路径（仅用于 .beelite 中 manifest 的保留路径）沿用先删除上次残留再创建的语义', async () => {
  const dir = await tmpDir();
  try {
    const target = path.join(dir, 'manifest.json.tmp');
    const part = `${target}.part`;
    await writeFile(part, '上次中断留下的半成品');
    await writeFileAtomic(target, 'new manifest', part);
    assert.equal(await readFile(target, 'utf8'), 'new manifest');
    assert.deepEqual(await readdir(dir), ['manifest.json.tmp']);
  } finally {
    await cleanup(dir);
  }
});

test('操作记录与更新策略：保存持续失败时不累积临时文件', async () => {
  const dir = await tmpDir();
  const realWrite = io.write;
  try {
    const history = new HistoryStore(path.join(dir, 'operation-history.json'));
    const policy = new PolicyStore(path.join(dir, 'addon-policy.json'));
    await policy.reload();
    io.write = async () => ({ bytesWritten: 0 });
    for (let i = 0; i < 3; i++) {
      await history.record({ flavorId: 9, root: '/x/_forever_', kind: 'install', modId: String(i + 1), name: `M${i}` }, { status: 'succeeded', message: 'ok' });
      await assert.rejects(policy.set(9, '/x/_forever_', String(i + 1), true), /保存更新策略失败/);
    }
    await history.retry();
    assert.equal(history.status().unsaved, 3);
    assert.deepEqual(await readdir(dir), [], '没有任何临时文件或半成品');
  } finally {
    io.write = realWrite;
    await cleanup(dir);
  }
});
