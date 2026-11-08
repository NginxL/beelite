// 临时错误分类（0.1.3）：只影响自动检查的重试间隔。用真实 Node fetch 与本机临时 HTTP 服务复现响应体读取中断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isTransientError, UserError } from '../src/core/errors';

test('响应头之后连接中断（真实 fetch：TypeError terminated，cause.code = UND_ERR_SOCKET）判为临时错误', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"code":1,"data":');
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    let err: unknown = null;
    try {
      await res.text();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof TypeError);
    assert.equal((err as Error).message, 'terminated');
    assert.equal(((err as Error & { cause?: { code?: string } }).cause)?.code, 'UND_ERR_SOCKET');
    assert.equal(isTransientError(err), true);
  } finally {
    server.close();
  }
});

test('只认可已知的网络错误码：普通 TypeError、服务端拒绝、数据错误、本地错误都不是临时错误；cause 链有限深度且不怕循环', () => {
  assert.equal(isTransientError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isTransientError(new TypeError('terminated')), false, '没有网络错误码的 terminated 不算');
  assert.equal(isTransientError(new UserError('服务器提示：查询不到当前游戏的插件信息', 'remote')), false);
  assert.equal(isTransientError(new UserError('服务器错误（HTTP 404）')), false);
  assert.equal(isTransientError(new UserError('服务器错误（HTTP 503）', 'http-transient')), true);
  assert.equal(isTransientError(Object.assign(new Error('EACCES'), { code: 'EACCES' })), false);
  assert.equal(isTransientError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })), true);
  assert.equal(isTransientError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  // 循环引用
  const a = new Error('a') as Error & { cause?: unknown };
  const b = new Error('b') as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  assert.equal(isTransientError(a), false);
  // 深度上限：第 7 层的网络错误不再查找
  let deep: Error = Object.assign(new Error('net'), { code: 'ECONNRESET' });
  for (let i = 0; i < 7; i++) deep = new Error(`wrap${i}`, { cause: deep });
  assert.equal(isTransientError(deep), false);
  let shallow: Error = Object.assign(new Error('net'), { code: 'ECONNRESET' });
  for (let i = 0; i < 3; i++) shallow = new Error(`wrap${i}`, { cause: shallow });
  assert.equal(isTransientError(shallow), true);
});
