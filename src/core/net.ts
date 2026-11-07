// 受限的 HTTPS 访问：只允许白名单域名，手动处理重定向并逐跳复核，限制响应体大小与超时。
// 任何失败路径都会中止本次请求并取消响应体，避免连接在后台继续读取。
import { createHash } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { UserError } from './errors';
import { writeAll } from './fsio';

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'api.newbeebox.com',
  'cdn2.newbeebox.com',
  'cdn8.newbeebox.com',
]);

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const USER_AGENT = 'BeeLite/0.1 (macOS addon manager)';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UserError('无效的下载地址');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443') || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new UserError(`拒绝访问不在白名单内的地址：${u.protocol}//${u.hostname}`);
  }
  return u;
}

async function discard(res: Response | null): Promise<void> {
  if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
}

/** 发起请求；GET 会跟随白名单内的重定向，其他方法遇到重定向直接报错 */
async function fetchChecked(fetchFn: FetchFn, url: string, init: RequestInit): Promise<Response> {
  let current = assertAllowedUrl(url).toString();
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchFn(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await discard(res);
      if (!loc || (init.method && init.method !== 'GET')) throw new UserError(`服务器返回了意外的重定向（${res.status}）`);
      current = assertAllowedUrl(new URL(loc, current).toString()).toString();
      continue;
    }
    return res;
  }
  throw new UserError('重定向次数过多');
}

/** 逐块读取响应体，超过上限立即取消 */
async function* readBody(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let done = false;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface JsonRequestOptions {
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function requestJson(url: string, body: unknown | undefined, opts: JsonRequestOptions = {}): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? fetch;
  const own = new AbortController();
  const signals = [own.signal, AbortSignal.timeout(opts.timeoutMs ?? 15000)];
  if (opts.signal) signals.push(opts.signal);
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers, signal: AbortSignal.any(signals) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response | null = null;
  try {
    res = await fetchChecked(fetchFn, url, init);
    if (!res.ok) throw new UserError(`服务器错误（HTTP ${res.status}）`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new UserError('服务器响应过大');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of readBody(res)) {
      total += chunk.byteLength;
      if (total > MAX_JSON_BYTES) throw new UserError('服务器响应过大');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new UserError('服务器返回的数据无法解析');
    }
  } catch (err) {
    await discard(res);
    own.abort();
    throw err;
  }
}

export interface DownloadOptions {
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /** 期望字节数（来自接口），大于 0 时强制校验 */
  expectedSize?: number;
  maxBytes: number;
  idleTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
}

export interface DownloadResult {
  bytes: number;
  md5: string;
}

/** 流式下载到新文件（'wx'，不覆盖已有文件），校验长度、Content-MD5（如有）与落盘大小 */
export async function downloadToFile(url: string, dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  // 先创建目标文件：失败时还没有任何计时器或连接
  const fh: FileHandle = await open(dest, 'wx', 0o644);
  const idleMs = opts.idleTimeoutMs ?? 30000;
  const own = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => own.abort(new UserError('下载长时间没有响应，已中止')), idleMs);
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, own.signal]) : own.signal;
  let res: Response | null = null;
  let ok = false;
  try {
    kick();
    res = await fetchChecked(fetchFn, url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal });
    if (!res.ok || !res.body) throw new UserError(`下载失败（HTTP ${res.status}）`);
    const lenHeader = res.headers.get('content-length');
    const declared = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
    const expected = opts.expectedSize && opts.expectedSize > 0 ? opts.expectedSize : null;
    if (declared !== null && expected !== null && declared !== expected) throw new UserError('下载文件大小与接口记录不一致');
    const total = expected ?? declared ?? 0;
    if (total > opts.maxBytes) throw new UserError('文件超过允许的最大体积');
    const md5Header = res.headers.get('content-md5');
    const hash = createHash('md5');
    let received = 0;
    let lastReport = 0;
    for await (const chunk of readBody(res)) {
      kick();
      received += chunk.byteLength;
      if (received > opts.maxBytes || (total > 0 && received > total)) throw new UserError('下载内容超出预期大小');
      hash.update(chunk);
      await writeAll(fh, chunk);
      const now = Date.now();
      if (opts.onProgress && now - lastReport > 150) {
        lastReport = now;
        opts.onProgress(received, total);
      }
    }
    if (total > 0 && received !== total) throw new UserError('下载不完整，请重试');
    const digest = hash.digest();
    if (md5Header && digest.toString('base64') !== md5Header.trim()) throw new UserError('下载文件校验失败（MD5 不一致）');
    await fh.sync();
    if ((await fh.stat()).size !== received) throw new UserError('下载文件写入不完整');
    opts.onProgress?.(received, total);
    ok = true;
    return { bytes: received, md5: digest.toString('hex') };
  } catch (err) {
    if (signal.aborted && signal.reason instanceof UserError) throw signal.reason;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (!ok) {
      await discard(res);
      own.abort();
    }
    await fh.close();
    if (!ok) await unlink(dest).catch(() => undefined);
  }
}
