// 插件压缩包的校验与解压。先完整检查中央目录（路径、类型、重复、体积、结构），通过后再解压并逐条校验 CRC32。
// 压缩包内的任何内容都不会被执行。
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { UserError } from './errors';
import { writeAll } from './fsio';
import { foldKey, isSafeSegment, isValidModuleName, resolveInside } from './paths';

export interface ZipLimits {
  maxArchiveBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxRatio: number;
  /** 小于该大小的条目不做压缩比检查 */
  ratioMinBytes: number;
}

export const DEFAULT_LIMITS: ZipLimits = {
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxRatio: 1000,
  ratioMinBytes: 1024 * 1024,
};

export interface ZipExtractResult {
  /** 将要安装到 AddOns 的一级目录（按压缩包内实际名称） */
  modules: string[];
  warnings: string[];
  fileCount: number;
  totalBytes: number;
}

type Decision = { kind: 'skip' } | { kind: 'dir'; rel: string } | { kind: 'file'; rel: string; size: number; crc: number };

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function reject(msg: string): never {
  throw new UserError(`压缩包校验失败：${msg}`, 'zip');
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject_) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: false, validateEntrySizes: true }, (err, zf) => {
      if (err || !zf) reject_(new UserError(`压缩包无法读取：${err?.message ?? '未知错误'}`, 'zip'));
      else resolve(zf);
    });
  });
}

async function eachEntry(file: string, fn: (entry: yauzl.Entry, zf: yauzl.ZipFile, index: number) => Promise<void>): Promise<void> {
  const zf = await openZip(file);
  await new Promise<void>((resolve, reject_) => {
    let index = 0;
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      zf.close();
      reject_(err instanceof UserError ? err : new UserError(`压缩包校验失败：${err instanceof Error ? err.message : String(err)}`, 'zip'));
    };
    zf.on('error', fail);
    zf.on('end', () => {
      if (!failed) resolve();
    });
    zf.on('entry', (entry: yauzl.Entry) => {
      fn(entry, zf, index++).then(() => zf.readEntry(), fail);
    });
    zf.readEntry();
  });
}

/** 判断 rel（形如 Top/xxx.toc）是不是 Top 目录自己的 TOC：Top.toc / Top_Suffix.toc / Top-Suffix.toc */
export function isOwnToc(top: string, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.toc')) return false;
  const stem = fileName.slice(0, -4);
  if (foldKey(stem) === foldKey(top)) return true;
  const t = foldKey(top);
  const s = foldKey(stem);
  return (s.startsWith(t + '_') || s.startsWith(t + '-')) && s.length > t.length + 1;
}

export async function extractAddonZip(zipPath: string, destDir: string, limits: ZipLimits = DEFAULT_LIMITS): Promise<ZipExtractResult> {
  const st = await stat(zipPath);
  if (st.size > limits.maxArchiveBytes) reject('文件过大');

  // 第一遍：只读中央目录，做全部结构检查
  const decisions: Decision[] = [];
  const seen = new Map<string, { name: string; isDir: boolean; size: number; crc: number }>();
  const dirActual = new Map<string, string>();
  const fileKeys = new Set<string>();
  const tops = new Map<string, string>();
  const tocTops = new Set<string>();
  const ignored: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  await eachEntry(zipPath, async (entry, _zf, index) => {
    if (index + 1 > limits.maxEntries) reject('条目数量过多');
    if (entry.generalPurposeBitFlag & 0x1) reject('不支持加密的压缩包');
    const raw = entry.fileName;
    const isDir = raw.endsWith('/');
    const rel = isDir ? raw.slice(0, -1) : raw;
    if (rel === '') return void decisions.push({ kind: 'skip' });
    if (Buffer.byteLength(rel, 'utf8') > 1024) reject(`路径过长：${rel.slice(0, 80)}…`);
    const segs = rel.split('/');
    if (!segs.every(isSafeSegment) || segs[0].includes(':')) reject(`包含不安全的路径：${JSON.stringify(raw)}`);

    if ((entry.versionMadeBy >> 8) === 3) {
      const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) reject(`包含符号链接：${rel}`);
      if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) reject(`包含特殊文件：${rel}`);
      if (mode === S_IFDIR && !isDir) reject(`目录条目格式异常：${rel}`);
    }

    // 系统垃圾文件与压缩包根部的零散文件不安装
    if (segs[0] === '__MACOSX' || segs[segs.length - 1] === '.DS_Store') return void decisions.push({ kind: 'skip' });
    if (segs.length === 1 && !isDir) {
      ignored.push(rel);
      return void decisions.push({ kind: 'skip' });
    }

    const size = entry.uncompressedSize;
    if (!isDir) {
      if (entry.compressedSize === 0 && size > 0) reject(`条目大小异常：${rel}`);
      if (size >= limits.ratioMinBytes && size / Math.max(1, entry.compressedSize) > limits.maxRatio) reject(`压缩比异常（疑似压缩炸弹）：${rel}`);
    }

    const key = foldKey(rel);
    const prev = seen.get(key);
    if (prev) {
      const identical = prev.name === rel && prev.isDir === isDir && (isDir || (prev.size === size && prev.crc === entry.crc32));
      if (!identical) reject(`包含重复或仅大小写不同的条目：${rel}`);
      return void decisions.push({ kind: 'skip' });
    }
    seen.set(key, { name: rel, isDir, size, crc: entry.crc32 });

    // 目录/文件同名冲突与父目录大小写一致性
    for (let i = 1; i <= (isDir ? segs.length : segs.length - 1); i++) {
      const parentRel = segs.slice(0, i).join('/');
      const pk = foldKey(parentRel);
      if (fileKeys.has(pk)) reject(`文件与目录同名：${parentRel}`);
      const actual = dirActual.get(pk);
      if (actual !== undefined && actual !== parentRel) reject(`包含仅大小写不同的目录：${parentRel}`);
      dirActual.set(pk, parentRel);
    }
    if (!isDir) {
      if (dirActual.has(key)) reject(`文件与目录同名：${rel}`);
      fileKeys.add(key);
      totalBytes += size;
      fileCount++;
      if (totalBytes > limits.maxTotalBytes) reject('解压后体积过大');
    }

    const top = segs[0];
    tops.set(foldKey(top), top);
    if (!isDir && segs.length === 2 && isOwnToc(top, segs[1])) tocTops.add(foldKey(top));
    decisions.push(isDir ? { kind: 'dir', rel } : { kind: 'file', rel, size, crc: entry.crc32 });
  });

  const modules = [...tops.values()].sort((a, b) => a.localeCompare(b));
  if (modules.length === 0) reject('压缩包中没有插件目录');
  for (const m of modules) {
    if (!isValidModuleName(m)) reject(`一级目录名不允许作为插件目录：${m}（压缩包结构可能不是插件包）`);
  }
  if (tocTops.size === 0) reject('没有找到插件的 TOC 文件，压缩包可能多套了一层目录或不是插件包');
  const warnings: string[] = [];
  const noToc = modules.filter((m) => !tocTops.has(foldKey(m)));
  if (noToc.length) warnings.push(`以下目录没有自己的 TOC 文件，游戏不会把它们当作插件加载：${noToc.join('、')}`);
  if (ignored.length) warnings.push(`已忽略压缩包根部的零散文件：${ignored.slice(0, 5).join('、')}${ignored.length > 5 ? ' 等' : ''}`);

  // 第二遍：解压到全新的暂存目录，写入时禁止覆盖，逐条核对大小与 CRC32
  await mkdir(destDir, { recursive: false, mode: 0o755 });
  await eachEntry(zipPath, async (entry, zf, index) => {
    const d = decisions[index];
    if (!d || d.kind === 'skip') return;
    const target = resolveInside(destDir, d.rel);
    if (d.kind === 'dir') {
      await mkdir(target, { recursive: true, mode: 0o755 });
      return;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject_) =>
      zf.openReadStream(entry, (err, s) => (err || !s ? reject_(err ?? new Error('无法读取条目')) : resolve(s))),
    );
    const fh = await open(target, 'wx', 0o644);
    let crc = 0;
    let bytes = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > d.size) reject(`条目实际大小超出声明：${d.rel}`);
        crc = zlib.crc32(chunk, crc);
        await writeAll(fh, chunk);
      }
      // 以落盘结果为准：文件实际大小必须与声明一致
      if ((await fh.stat()).size !== d.size) reject(`条目写入不完整：${d.rel}`);
    } finally {
      await fh.close();
    }
    if (bytes !== d.size) reject(`条目大小不一致：${d.rel}`);
    if (crc >>> 0 !== d.crc >>> 0) reject(`CRC 校验失败：${d.rel}`);
  });

  return { modules, warnings, fileCount, totalBytes };
}
