// 生成应用图标 build/icon.png（1024×1024）：深色圆角底 + 蜂蜜色蜂巢六边形。无第三方依赖。
import { mkdir, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';

const N = 1024;
const SS = 3; // 超采样抗锯齿
const BG = [28, 31, 37];
const HONEY = [245, 179, 1];
const DARK = [20, 22, 26];

function inRoundRect(x, y, margin, r) {
  const lo = margin, hi = N - margin;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 尖顶正六边形 */
function inHex(x, y, cx, cy, r) {
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  return dx <= (Math.sqrt(3) / 2) * r && dy <= r - dx / Math.sqrt(3);
}

function color(x, y) {
  if (!inRoundRect(x, y, 64, 200)) return null;
  const c = N / 2;
  const r = 300;
  if (inHex(x, y, c, c, r)) {
    if (inHex(x, y, c, c, r - 150)) return HONEY; // 中心
    if (inHex(x, y, c, c, r - 70)) return DARK; // 内环
    return HONEY; // 外框
  }
  return BG;
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const col = color(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (col) {
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
    }
    const n = SS * SS;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    const cov = a / 255;
    raw[o] = cov ? Math.round(r / cov) : 0;
    raw[o + 1] = cov ? Math.round(g / cov) : 0;
    raw[o + 2] = cov ? Math.round(b / cov) : 0;
    raw[o + 3] = Math.round(a / n);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
await mkdir(new URL('../build/', import.meta.url), { recursive: true });
await writeFile(new URL('../build/icon.png', import.meta.url), png);
console.log('build/icon.png', png.length, 'bytes');
