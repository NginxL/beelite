// smoke 运行目录：只在指定父目录下用 mkdtemp 新建本次专用子目录，并写入标记文件；
// 清理时只删除带有本次标记、且确实是该父目录直接子目录的目录，绝不删除用户已有目录。
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = '.beelite-smoke-run';

export async function createRunDir(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(await realpath(parent), 'beelite-smoke-'));
  await writeFile(path.join(dir, MARKER), dir, { flag: 'wx' });
  return dir;
}

export async function cleanupRunDir(dir: string, parent: string): Promise<void> {
  const parentReal = await realpath(parent);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`拒绝清理：${dir} 不是普通目录`);
  const dirReal = await realpath(dir);
  if (path.dirname(dirReal) !== parentReal || !path.basename(dirReal).startsWith('beelite-smoke-')) {
    throw new Error(`拒绝清理非本次 smoke 创建的目录：${dir}`);
  }
  const marker = await readFile(path.join(dirReal, MARKER), 'utf8').catch(() => null);
  if (marker !== dirReal) throw new Error(`拒绝清理：${dir} 缺少本次运行标记`);
  await rm(dirReal, { recursive: true, force: true });
}
