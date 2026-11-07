import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NewBeeBoxProvider, toPlainText } from '../src/core/provider';
import { downloadToFile, requestJson, type FetchFn } from '../src/core/net';
import { cleanup, fixture, tmpDir } from './helpers';

type Handler = (url: string, body: Record<string, unknown> | null) => unknown;

function fakeFetch(handler: Handler, calls: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = []): FetchFn {
  return async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const out = handler(url, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const config = fixture('api-config.json');

function provider(handler: Handler, calls?: Parameters<typeof fakeFetch>[1]) {
  return new NewBeeBoxProvider(
    fakeFetch((url, body) => (url.endsWith('/modconfig.json') ? config : handler(url, body)), calls),
  );
}

test('搜索：请求参数与真实响应形状映射，不携带任何账号或客户端标识', async () => {
  const calls: Parameters<typeof fakeFetch>[1] = [];
  const p = provider(() => fixture('api-search-forever.json'), calls);
  const r = await p.search({ flavorId: 9, category: 0, order: 'ranking', keyword: 'openmap', offset: 0 });
  const req = calls.find((c) => c.url.endsWith('/v3/mod/list'))!;
  assert.deepEqual(req.body, { versions: 9, category: 0, order: 'ranking', pay_filter: 0, offset: 0, filter: 'openmap' });
  const headerNames = Object.keys(req.headers).map((h) => h.toLowerCase());
  for (const h of ['authorization', 'boxid', 'boxversion', 'cookie']) assert.ok(!headerNames.includes(h), h);
  assert.equal(r.total, 3);
  assert.equal(r.nextOffset, 3);
  const first = r.items[0];
  assert.equal(first.id, '31505');
  assert.equal(first.version, '0.7.5-cn');
  assert.deepEqual(first.folders, ['OpenMap']);
  assert.deepEqual(first.gameVersions, ['1.60.1']);
  assert.equal(first.accessible, true);
  assert.ok(first.logo?.startsWith('https://cdn8.newbeebox.com/'));
});

test('搜索：服务端返回的 game_version_id 与请求不一致时丢弃结果（防止串 flavor）', async () => {
  const p = provider(() => fixture('api-search-forever.json'));
  await assert.rejects(p.search({ flavorId: 2, category: 0, order: 'ranking', keyword: '', offset: 0 }), /不一致/);
});

test('详情：可访问性字段与付费内容判定', async () => {
  const detail = fixture('api-detail-forever.json') as { data: { result: Record<string, unknown> } };
  const p = provider(() => detail);
  const d = await p.detail('31505', 9);
  assert.equal(d.accessible, true);
  assert.equal(d.flavorId, 9);
  assert.ok(d.description.includes('Questie'));
  const paid = structuredClone(detail);
  paid.data.result.subscribe_plan_level = 2;
  assert.equal((await provider(() => paid).detail('31505', 9)).accessible, false);
  const locked = structuredClone(detail);
  locked.data.result.is_content_access = false;
  assert.equal((await provider(() => locked).detail('31505', 9)).accessible, false);
});

test('latest：按 flavor 请求，校验游戏版本交集；服务端 -4 原样提示且不回退', async () => {
  const calls: Parameters<typeof fakeFetch>[1] = [];
  const file = fixture('api-file-forever.json');
  const p = provider((_u, body) => (body?.game_version_id === 9 ? file : { code: -4, message: '查询不到当前游戏的插件信息', time: 1 }), calls);
  const f = await p.latest('31505', 9);
  assert.equal(f.fileId, '673432');
  assert.equal(f.compatible, true);
  assert.equal(f.size, 90279620);
  assert.deepEqual(f.folders, ['OpenMap']);
  assert.deepEqual(calls.find((c) => c.url.endsWith('mod_file_latest'))!.body, { mod_id: 31505, game_version_id: 9, strategy: 1, type: 3 });
  await assert.rejects(p.latest('31505', 2), /查询不到当前游戏的插件信息/);
  assert.equal(calls.filter((c) => c.url.endsWith('mod_file_latest')).length, 2, '失败后不应再尝试其他 flavor');
});

test('latest：文件声明的版本不属于当前 flavor 时标记为不兼容', async () => {
  const file = fixture('api-file-forever.json') as { data: Record<string, unknown> };
  const p = provider(() => file);
  assert.equal((await p.latest('31505', 2)).compatible, false);
  const wrongMod = structuredClone(file);
  wrongMod.data.t_mod_id = 1;
  await assert.rejects(provider(() => wrongMod).latest('31505', 9), /不匹配/);
});

test('网络：拒绝非白名单域名与跨域重定向', async () => {
  await assert.rejects(requestJson('https://evil.example.com/x', undefined, { fetchFn: fakeFetch(() => ({})) }), /白名单/);
  await assert.rejects(requestJson('http://api.newbeebox.com/x', undefined, { fetchFn: fakeFetch(() => ({})) }), /白名单/);
  const redirect = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/a.zip' } }));
  const dir = await tmpDir();
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/a.zip', path.join(dir, 'a'), { fetchFn: redirect, maxBytes: 100 }), /白名单/);
  await cleanup(dir);
});

test('下载：长度与 Content-MD5 校验，失败不留下半截文件', async () => {
  const dir = await tmpDir();
  const payload = Buffer.from('zip-bytes-here');
  const md5 = createHash('md5').update(payload).digest('base64');
  const ok = fakeFetch(() => new Response(payload, { headers: { 'content-length': String(payload.length), 'content-md5': md5 } }));
  const dest = path.join(dir, 'ok.zip');
  const r = await downloadToFile('https://cdn8.newbeebox.com/x', dest, { fetchFn: ok, maxBytes: 1000, expectedSize: payload.length });
  assert.equal(r.bytes, payload.length);
  assert.deepEqual(await readFile(dest), payload);

  const badMd5 = fakeFetch(() => new Response(payload, { headers: { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' } }));
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/x', path.join(dir, 'b.zip'), { fetchFn: badMd5, maxBytes: 1000 }), /MD5/);
  await assert.rejects(readFile(path.join(dir, 'b.zip')));

  const sizeMismatch = fakeFetch(() => new Response(payload));
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/x', path.join(dir, 'c.zip'), { fetchFn: sizeMismatch, maxBytes: 1000, expectedSize: 999 }), /大小|不完整/);
  await assert.rejects(downloadToFile('https://cdn8.newbeebox.com/x', path.join(dir, 'd.zip'), { fetchFn: sizeMismatch, maxBytes: 5 }), /超出|最大/);
  await cleanup(dir);
});

test('外部描述转为纯文本', () => {
  assert.equal(toPlainText('<p>Hello<script>alert(1)</script></p><img src=x onerror=1>World &amp; more'), 'Hello\nWorld & more');
});
