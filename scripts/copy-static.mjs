// 把渲染层静态文件复制到 dist/web
import { copyFile, mkdir } from 'node:fs/promises';

const src = new URL('../src/renderer/', import.meta.url);
const out = new URL('../dist/web/', import.meta.url);
await mkdir(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  await copyFile(new URL(f, src), new URL(f, out));
}
