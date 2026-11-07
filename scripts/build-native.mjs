// 编译客户端更新原生桥：针对 Electron 头文件（版本取自已安装的 electron 包）、arm64、macOS 13.0。
// 编译后校验架构、最低系统版本与 Sparkle 链接方式。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ADDON_PATH, FRAMEWORK_PATH, PROJECT_ROOT } from './sparkle-common.mjs';

const MAX_MINOS = [13, 0];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败：${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  return r.stdout;
}

if (!existsSync(FRAMEWORK_PATH)) {
  console.error('[native] 缺少 native/vendor/Sparkle.framework，请先运行 node scripts/fetch-sparkle.mjs');
  process.exit(1);
}

const electronVersion = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const nodeGyp = path.join(PROJECT_ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
spawnSync(process.execPath, [nodeGyp, 'rebuild', `--target=${electronVersion}`, '--arch=arm64', '--dist-url=https://electronjs.org/headers', '--directory', path.join(PROJECT_ROOT, 'native')], {
  stdio: 'inherit',
  env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.0' },
}).status === 0 || (console.error('[native] 编译失败'), process.exit(1));

const archs = run('/usr/bin/lipo', ['-archs', ADDON_PATH]).trim();
if (archs !== 'arm64') throw new Error(`原生桥架构应为 arm64，实际 ${archs}`);
const loadCmds = run('/usr/bin/otool', ['-l', ADDON_PATH]);
const m = /LC_BUILD_VERSION[\s\S]*?minos (\d+)\.(\d+)/.exec(loadCmds);
if (!m) throw new Error('无法读取原生桥的最低系统版本');
const minos = [Number(m[1]), Number(m[2])];
if (minos[0] > MAX_MINOS[0] || (minos[0] === MAX_MINOS[0] && minos[1] > MAX_MINOS[1])) throw new Error(`原生桥最低系统 ${minos.join('.')} 高于 13.0`);
const libs = run('/usr/bin/otool', ['-L', ADDON_PATH]);
if (!libs.includes('@rpath/Sparkle.framework/Versions/B/Sparkle')) throw new Error('原生桥未按 @rpath 链接 Sparkle.framework');
if (!loadCmds.includes('path @loader_path')) throw new Error('原生桥缺少 @loader_path rpath');
console.log(`[native] 已编译：Electron ${electronVersion}，arm64，minos ${minos.join('.')}`);
