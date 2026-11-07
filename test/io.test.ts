import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { io, type WriteFn } from '../src/core/fsio';
import { downloadToFile, requestJson, type FetchFn } from '../src/core/net';
import { isFreeLevel } from '../src/core/provider';
import { extractAddonZip } from '../src/core/zip';
import { addonEntries, cleanup, exists, makeZip, tmpDir } from './helpers';

const realWrite = io.write;

async function withWrite<T>(impl: WriteFn, fn: () => Promise<T>): Promise<T> {
  io.write = impl;
  try {
    return await fn();
  } finally {
    io.write = realWrite;
  }
}

/** 每次最多写 3 字节的短写实现 */
const shortWrite: WriteFn = (fh, buf, offset, length) => realWrite(fh, buf, offset, Math.min(3, length));
const zeroWrite: WriteFn = async () => ({ bytesWritten: 0 });

test('解压：短写会继续写完，落盘内容与源一致；0 字节写入明确失败', async () => {
  const dir = await tmpDir();
  const payload = 'x'.repeat(5000) + 'END';
  const zip = path.join(dir, 'p.zip');
  await writeFile(zip, makeZip([...addonEntries('A'), { name: 'A/big.lua', data: payload, deflate: true }]));
  await withWrite(shortWrite, () => extractAddonZip(zip, path.join(dir, 'x1')));
  assert.equal(await readFile(path.join(dir, 'x1', 'A', 'big.lua'), 'utf8'), payload);
  await assert.rejects(withWrite(zeroWrite, () => extractAddonZip(zip, path.join(dir, 'x2'))), /写入/);
  await cleanup(dir);
});

function bodyFetch(payload: Buffer, headers: Record<string, string>, flag: { cancelled: boolean; calls: number }): FetchFn {
  return async () => {
    flag.calls++;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(payload.subarray(0, Math.ceil(payload.length / 2)));
      },
      pull(c) {
        c.enqueue(payload.subarray(Math.ceil(payload.length / 2)));
        c.close();
      },
      cancel() {
        flag.cancelled = true;
      },
    });
    return new Response(stream, { headers });
  };
}

test('下载：短写会继续写完；0 字节写入失败且不留下文件', async () => {
  const dir = await tmpDir();
  const payload = Buffer.from('0123456789'.repeat(100));
  const flag = { cancelled: false, calls: 0 };
  const dest = path.join(dir, 'a.bin');
  await withWrite(shortWrite, () => downloadToFile('https://cdn8.newbeebox.com/a', dest, { fetchFn: bodyFetch(payload, {}, flag), maxBytes: 1e6 }));
  assert.deepEqual(await readFile(dest), payload);
  const dest2 = path.join(dir, 'b.bin');
  await assert.rejects(withWrite(zeroWrite, () => downloadToFile('https://cdn8.newbeebox.com/a', dest2, { fetchFn: bodyFetch(payload, {}, flag), maxBytes: 1e6 })), /写入/);
  assert.equal(await exists(dest2), false);
  await cleanup(dir);
});

test('网络失败路径会取消响应体：声明过大、长度与接口不一致、超出上限', async () => {
  const dir = await tmpDir();
  const payload = Buffer.from('abcdefghij');
  let flag = { cancelled: false, calls: 0 };
  await assert.rejects(requestJson('https://api.newbeebox.com/x', {}, { fetchFn: bodyFetch(payload, { 'content-length': String(64 * 1024 * 1024) }, flag) }), /过大/);
  assert.ok(flag.cancelled, '声明过大时应取消响应体');

  flag = { cancelled: false, calls: 0 };
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/a', path.join(dir, 'c'), { fetchFn: bodyFetch(payload, { 'content-length': '10' }, flag), maxBytes: 1e6, expectedSize: 99 }), /不一致/);
  assert.ok(flag.cancelled, '长度与接口记录不一致时应取消响应体');

  flag = { cancelled: false, calls: 0 };
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/a', path.join(dir, 'd'), { fetchFn: bodyFetch(payload, {}, flag), maxBytes: 3 }), /超出/);
  assert.ok(flag.cancelled, '超出上限时应取消响应体');
  await cleanup(dir);
});

test('下载：目标文件已存在时立即失败，不发起请求、不覆盖原文件', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'exists.zip');
  await writeFile(dest, 'original');
  const flag = { cancelled: false, calls: 0 };
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/a', dest, { fetchFn: bodyFetch(Buffer.from('x'), {}, flag), maxBytes: 10, idleTimeoutMs: 600000 }), /EEXIST/);
  assert.equal(flag.calls, 0);
  assert.equal(await readFile(dest, 'utf8'), 'original');
  await cleanup(dir);
});

test('免费判定失败关闭：只接受明确的 0', () => {
  assert.equal(isFreeLevel(0), true);
  assert.equal(isFreeLevel('0'), true);
  for (const v of [undefined, null, '', 'abc', -1, 1, '1', NaN, '0x0', {}, []]) assert.equal(isFreeLevel(v), false, String(v));
});
