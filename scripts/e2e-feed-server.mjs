// E2E 用本地 feed 服务器：只监听 127.0.0.1，只提供指定目录下的普通文件（不列目录、不跟随越界路径）。
// 用法：node scripts/e2e-feed-server.mjs <目录> [--port 47831] [--rate <字节/秒>]
// --rate 可限制下载速度，便于在下载过程中触发插件操作或取消。
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = await realpath(path.resolve(process.argv[2] ?? '.'));
const port = Number(arg('--port', '47831'));
const rate = Number(arg('--rate', '0'));

const server = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const file = path.resolve(root, name);
    if (!name || path.dirname(file) !== root) throw new Error('forbidden');
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not file');
    const type = file.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': String(st.size), 'cache-control': 'no-store' });
    console.log(`[feed] ${req.method} /${name} ${st.size}`);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, rate > 0 ? { highWaterMark: Math.max(1024, Math.floor(rate / 10)) } : {});
    if (rate > 0) {
      stream.on('data', (chunk) => {
        stream.pause();
        res.write(chunk);
        setTimeout(() => stream.resume(), (chunk.length / rate) * 1000);
      });
      stream.on('end', () => res.end());
    } else {
      stream.pipe(res);
    }
  } catch {
    console.log(`[feed] 404 ${req.url}`);
    res.writeHead(404).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`[feed] http://127.0.0.1:${port}/ -> ${root}`));
