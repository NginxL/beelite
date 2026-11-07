// 下载并校验官方 Sparkle 2.9.6，解出 Sparkle.framework（保留符号链接）、LICENSE 与官方工具到 native/vendor。
// 只访问固定的官方 GitHub release 地址；SHA256 不符即失败。不执行归档中的任何脚本。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FRAMEWORK_PATH, SPARKLE_LICENSE, SPARKLE_SHA256, SPARKLE_URL, SPARKLE_VERSION, TOOLS_DIR, VENDOR_DIR, sha256 } from './sparkle-common.mjs';

const STAMP = path.join(VENDOR_DIR, '.sparkle-version');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${r.status}）`);
}

async function main() {
  const stampValue = `${SPARKLE_VERSION} ${SPARKLE_SHA256}`;
  if (existsSync(STAMP) && (await readFile(STAMP, 'utf8')).trim() === stampValue && existsSync(FRAMEWORK_PATH)) {
    console.log(`[sparkle] 已就绪：Sparkle ${SPARKLE_VERSION}`);
    return;
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'beelite-sparkle-'));
  try {
    const zip = path.join(tmp, 'sparkle.zip');
    const res = await fetch(SPARKLE_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`下载 Sparkle 失败：HTTP ${res.status}`);
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
    const actual = await sha256(zip);
    if (actual !== SPARKLE_SHA256) throw new Error(`Sparkle 归档校验失败：期望 ${SPARKLE_SHA256}，实际 ${actual}`);
    const out = path.join(tmp, 'x');
    run('/usr/bin/ditto', ['-x', '-k', zip, out]);
    await rm(VENDOR_DIR, { recursive: true, force: true });
    await mkdir(VENDOR_DIR, { recursive: true });
    run('/usr/bin/ditto', [path.join(out, 'Sparkle.xcframework', 'macos-arm64_x86_64', 'Sparkle.framework'), FRAMEWORK_PATH]);
    run('/usr/bin/ditto', [path.join(out, 'bin'), TOOLS_DIR]);
    await cp(path.join(out, 'LICENSE'), SPARKLE_LICENSE);
    await writeFile(STAMP, `${stampValue}\n`);
    console.log(`[sparkle] 已校验并解出 Sparkle ${SPARKLE_VERSION}（SHA256 ${SPARKLE_SHA256}）`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[sparkle] ${err.message}`);
  process.exit(1);
});
