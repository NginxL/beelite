// 游戏版本根目录的布局与安全检查。所有写入都发生在 <root>/Interface 之下：
//   Interface/AddOns            插件目录
//   Interface/.beelite/         本应用的元数据（manifest、journal、staging、trash），与 AddOns 同卷，保证 rename 原子
// 无论只读还是写入，凡是存在的内部目录都必须是真实目录（不是符号链接），元数据文件读取不跟随符号链接。
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UserError } from './errors';
import { io, writeAll } from './fsio';

export interface Layout {
  root: string;
  interfaceDir: string;
  addonsDir: string;
  metaDir: string;
  stagingDir: string;
  trashDir: string;
  manifestPath: string;
  manifestTmpPath: string;
  journalPath: string;
}

export interface LayoutInfo {
  l: Layout;
  hasInterface: boolean;
  hasAddons: boolean;
  /** .beelite 及其 staging/trash 都存在 */
  hasMeta: boolean;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** 目录存在时必须是真实目录；不存在时按需创建。返回是否存在 */
async function checkRealDir(p: string, create: boolean, label: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new UserError(`${label}是符号链接，为避免写到意外位置，艾泽魔方不会使用它：${p}`, 'layout');
    if (!st.isDirectory()) throw new UserError(`${label}不是目录：${p}`, 'layout');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!create) return false;
    await mkdir(p, { mode: 0o755 });
    return true;
  }
}

export function layoutFor(rootReal: string): Layout {
  const interfaceDir = path.join(rootReal, 'Interface');
  const metaDir = path.join(interfaceDir, '.beelite');
  return {
    root: rootReal,
    interfaceDir,
    addonsDir: path.join(interfaceDir, 'AddOns'),
    metaDir,
    stagingDir: path.join(metaDir, 'staging'),
    trashDir: path.join(metaDir, 'trash'),
    manifestPath: path.join(metaDir, 'manifest.json'),
    manifestTmpPath: path.join(metaDir, 'manifest.json.tmp'),
    journalPath: path.join(metaDir, 'journal.json'),
  };
}

/**
 * 检查布局。create=false 时绝不创建任何东西；create=true 时（仅用户发起写操作）补齐缺失目录。
 * 两种模式都会校验已存在的 Interface / AddOns / .beelite / staging / trash 不是符号链接。
 */
export async function inspectLayout(root: string, create: boolean): Promise<LayoutInfo> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new UserError(`游戏目录不存在或无法访问：${root}`, 'layout');
  }
  if (!(await stat(rootReal)).isDirectory()) throw new UserError(`游戏目录不是文件夹：${rootReal}`, 'layout');
  const l = layoutFor(rootReal);
  const hasInterface = await checkRealDir(l.interfaceDir, create, 'Interface 目录');
  if (!hasInterface) return { l, hasInterface, hasAddons: false, hasMeta: false };
  const hasAddons = await checkRealDir(l.addonsDir, create, 'AddOns 目录');
  const meta = await checkRealDir(l.metaDir, create, '艾泽魔方数据目录');
  let hasMeta = false;
  if (meta) {
    const staging = await checkRealDir(l.stagingDir, create, '艾泽魔方暂存目录');
    const trash = await checkRealDir(l.trashDir, create, '艾泽魔方回收目录');
    hasMeta = staging && trash;
  }
  if (hasAddons && meta) {
    const [a, m] = await Promise.all([stat(l.addonsDir), stat(l.metaDir)]);
    if (a.dev !== m.dev) throw new UserError('AddOns 与艾泽魔方数据目录不在同一磁盘卷上，无法保证安全替换，已停止写入', 'layout');
  }
  return { l, hasInterface, hasAddons, hasMeta };
}

/** 写操作使用：确保完整布局存在并通过检查 */
export async function writableLayout(root: string): Promise<Layout> {
  return (await inspectLayout(root, true)).l;
}

/**
 * 确认 rel（相对 base）路径上除最后一段外的每一级都是真实目录。
 * 返回 false 表示某一级不存在；遇到符号链接或非目录直接抛错。
 */
export async function checkParentChain(base: string, rel: string): Promise<boolean> {
  const segs = rel.split('/');
  let cur = base;
  for (const seg of segs.slice(0, -1)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new UserError(`路径中存在符号链接或非目录：${path.relative(base, cur)}`, 'layout');
    }
  }
  return true;
}

/** 目录身份：同卷 rename 前后保持不变的 dev:ino；不存在返回 null（不跟随符号链接） */
export async function identityOf(p: string): Promise<string | null> {
  try {
    const st = await lstat(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 元数据文件（manifest、journal）的大小上限，读取与写入共用：超过它的内容不会被写出，也不会被读入 */
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;

/** 写入前确认元数据文本按 UTF-8 不超过读取上限；超过时拒绝，调用方不得写出任何内容 */
export function assertMetadataFits(text: string, what: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
    throw new UserError(`${what}将超过 ${MAX_METADATA_BYTES / 1024 / 1024} MiB 的记录上限，本次操作未提交，插件与原有记录均未改动`, 'metadata-too-large');
  }
}

/** 读取小型元数据文件；O_NOFOLLOW 保证不会跟随符号链接，文件不存在返回 null */
export async function readFileNoFollow(p: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new UserError(`元数据文件是符号链接，拒绝读取：${p}`, 'layout');
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UserError(`元数据不是普通文件：${p}`, 'layout');
    if (st.size > MAX_METADATA_BYTES) throw new UserError(`元数据文件过大：${p}`, 'layout');
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

export async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // 某些文件系统不支持目录 fsync，忽略
  }
}

/** 随机临时文件名与已有文件冲突时重新选择的次数 */
const TEMP_ATTEMPTS = 5;

/**
 * 独占创建临时文件（O_EXCL，不跟随已有链接）。
 * - 默认（随机名称）：绝不预先删除；名称已存在时换一个随机名称重试，有限次后以 EEXIST 失败，已有文件保持原样。
 * - 显式 tmp：只有 manager 提交 manifest 时使用（Interface/.beelite/manifest.json.tmp.part），这是本应用在自己数据目录中
 *   保留的固定路径，残留只可能是之前中断留下的半成品，因此沿用“先删除再独占创建”的语义。其他调用方不要传入 tmp。
 */
async function createTemp(target: string, tmp?: string): Promise<{ tmpPath: string; fh: FileHandle }> {
  if (tmp !== undefined) {
    await unlink(tmp).catch(() => undefined);
    return { tmpPath: tmp, fh: await open(tmp, 'wx', 0o644) };
  }
  for (let attempt = 1; ; attempt++) {
    const tmpPath = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      return { tmpPath, fh: await open(tmpPath, 'wx', 0o644) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= TEMP_ATTEMPTS) throw err;
    }
  }
}

/**
 * 写临时文件 + fsync + rename，保证读者只看到完整的旧内容或新内容。临时文件的创建规则见 createTemp。
 * 写入、fsync 或 rename 失败时只删除本次创建、且身份（dev:ino）仍相同的临时文件；无法确认身份时保留，不删除任何其他文件。
 */
export async function writeFileAtomic(target: string, data: string, tmp?: string): Promise<void> {
  const { tmpPath, fh } = await createTemp(target, tmp);
  let created: string | null = null;
  try {
    try {
      const st = await fh.stat({ bigint: true });
      created = `${st.dev}:${st.ino}`;
      await writeAll(fh, Buffer.from(data, 'utf8'));
      await io.sync(fh);
    } finally {
      await fh.close();
    }
    await rename(tmpPath, target);
  } catch (err) {
    if (created !== null && (await identityOf(tmpPath).catch(() => null)) === created) await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  await syncDir(path.dirname(target));
}

/** readBoundedFile 失败的原因：symlink 符号链接；not-file 不是普通文件（含 FIFO、目录）；too-large 超过上限；io 读取失败 */
export class BoundedReadError extends Error {
  constructor(readonly reason: 'symlink' | 'not-file' | 'too-large' | 'io', message: string, readonly code?: string) {
    super(message);
    this.name = 'BoundedReadError';
  }
}

const READ_CHUNK = 64 * 1024;

/**
 * 读取小型数据文件：O_NOFOLLOW | O_NONBLOCK 打开（符号链接立即失败，FIFO 不会等待写端），确认是普通文件后
 * 最多读取 maxBytes + 1 字节；超过 maxBytes（包括读取期间增长）即拒绝，不按文件大小一次分配。文件不存在返回 null。
 */
export async function readBoundedFile(p: string, maxBytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new BoundedReadError('symlink', '是符号链接', code);
    throw new BoundedReadError('io', code ? `读取失败（${code}）` : String(err), code);
  }
  try {
    let st;
    try {
      st = await fh.stat();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new BoundedReadError('io', code ? `读取失败（${code}）` : String(err), code);
    }
    if (!st.isFile()) throw new BoundedReadError('not-file', '不是普通文件');
    if (st.size > maxBytes) throw new BoundedReadError('too-large', `超过 ${maxBytes} 字节的上限`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(READ_CHUNK, maxBytes + 1 - total);
      const buf = Buffer.alloc(want);
      let n: number;
      try {
        n = (await fh.read(buf, 0, want, null)).bytesRead;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw new BoundedReadError('io', code ? `读取失败（${code}）` : String(err), code);
      }
      if (n === 0) break;
      chunks.push(n === want ? buf : buf.subarray(0, n));
      total += n;
      if (total > maxBytes) throw new BoundedReadError('too-large', `超过 ${maxBytes} 字节的上限`);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await fh.close();
  }
}

export function newTxId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}
