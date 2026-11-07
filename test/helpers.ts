// 测试辅助：最小 ZIP 写入器（可构造各种畸形条目）、临时目录与假数据源。
import { mkdtemp, mkdir, rm, writeFile, readdir, lstat, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { AddonManager, type ConfirmRequest, type ModSource } from '../src/core/manager';
import type { LatestFile } from '../src/core/provider';
import type { StepHook } from '../src/core/txn';

export interface ZipEntrySpec {
  name: string;
  data?: string | Buffer;
  /** Unix 模式（含类型位），例如 0o120777 表示符号链接 */
  mode?: number;
  /** 覆盖写入的 CRC，用于构造 CRC 错误 */
  crc?: number;
  /** 覆盖声明的解压大小 */
  declaredSize?: number;
  encrypted?: boolean;
  deflate?: boolean;
}

export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data) : e.data ?? Buffer.alloc(0);
    const method = e.deflate ? 8 : 0;
    const packed = e.deflate ? zlib.deflateRawSync(raw) : raw;
    // 传统加密条目在数据前有 12 字节加密头
    const body = e.encrypted ? Buffer.concat([Buffer.alloc(12, 7), packed]) : packed;
    const crc = e.crc ?? zlib.crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const flags = 0x800 | (e.encrypted ? 1 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);
    const isDir = e.name.endsWith('/');
    const mode = e.mode ?? (isDir ? 0o040755 : 0o100644);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** 一个标准插件目录的条目 */
export function addonEntries(folder: string, version = '1.0', extra: ZipEntrySpec[] = []): ZipEntrySpec[] {
  return [
    { name: `${folder}/` },
    { name: `${folder}/${folder}.toc`, data: `## Interface: 16001\n## Title: ${folder}\n## Version: ${version}\n${folder}.lua\n` },
    { name: `${folder}/${folder}.lua`, data: `-- ${folder} ${version}\n`, deflate: true },
    ...extra,
  ];
}

export async function tmpDir(prefix = 'beelite-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 构造一个模拟的游戏版本根目录（含 WTF 以验证不被触碰） */
export async function makeGameRoot(base: string): Promise<string> {
  const root = path.join(base, '_forever_');
  await mkdir(path.join(root, 'Interface', 'AddOns'), { recursive: true });
  await mkdir(path.join(root, 'WTF', 'Account', 'TEST', 'SavedVariables'), { recursive: true });
  await writeFile(path.join(root, 'WTF', 'Account', 'TEST', 'SavedVariables', 'Questie.lua'), 'QuestieConfig = {}\n');
  return root;
}

export async function addUnmanaged(root: string, folder: string, content = 'old'): Promise<void> {
  const dir = path.join(root, 'Interface', 'AddOns', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${folder}.toc`), `## Title: ${folder} (${content})\n`);
}

export async function listAddOns(root: string): Promise<string[]> {
  return (await readdir(path.join(root, 'Interface', 'AddOns'))).filter((n) => !n.startsWith('.')).sort();
}

export async function readAddonFile(root: string, folder: string, file: string): Promise<string> {
  return readFileSync(path.join(root, 'Interface', 'AddOns', folder, file), 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  return lstat(p).then(() => true, () => false);
}

export interface FakeMod {
  name: string;
  fileId: string;
  zip: Buffer;
  folders?: string[];
  versions?: string[];
  accessible?: boolean;
}

/** 假数据源：按 flavor 提供文件；没有该 flavor 的文件时像服务端一样报错 */
export class FakeSource implements ModSource {
  mods = new Map<string, Map<number, FakeMod>>();
  calls: string[] = [];

  set(modId: string, flavorId: number, mod: FakeMod): void {
    if (!this.mods.has(modId)) this.mods.set(modId, new Map());
    this.mods.get(modId)!.set(flavorId, mod);
  }

  private get(modId: string, flavorId: number): FakeMod {
    const m = this.mods.get(modId)?.get(flavorId);
    if (!m) throw new Error('服务器提示：查询不到当前游戏的插件信息');
    return m;
  }

  async detail(modId: string, flavorId: number) {
    this.calls.push(`detail:${modId}:${flavorId}`);
    const m = this.get(modId, flavorId);
    return { accessible: m.accessible ?? true, name: m.name, logo: null };
  }

  async latest(modId: string, flavorId: number): Promise<LatestFile> {
    this.calls.push(`latest:${modId}:${flavorId}`);
    const m = this.get(modId, flavorId);
    const versions = m.versions ?? ['1.60.1'];
    return {
      fileId: m.fileId,
      modId,
      displayName: `v${m.fileId}`,
      size: m.zip.length,
      folders: m.folders ?? [],
      gameVersions: versions,
      releaseType: 1,
      date: 0,
      compatible: versions.includes(flavorId === 9 ? '1.60.1' : '12.1.5'),
      downloadUrl: `https://cdn8.newbeebox.com/mod_file/${modId}/${m.fileId}`,
    };
  }

  /** 供 AddonManager 使用的下载函数：把内存中的 zip 写到目标路径 */
  download = async (url: string, dest: string) => {
    const [, modId, fileId] = /mod_file\/(\d+)\/(\d+)$/.exec(url)!;
    for (const byFlavor of this.mods.get(modId)?.values() ?? []) {
      if (byFlavor.fileId === fileId) {
        await writeFile(dest, byFlavor.zip, { flag: 'wx' });
        return { bytes: byFlavor.zip.length, md5: '' };
      }
    }
    throw new Error('not found');
  };
}

export function makeManager(source: FakeSource, opts: { confirm?: (r: ConfirmRequest) => Promise<boolean>; hook?: StepHook } = {}): AddonManager {
  return new AddonManager({ source, download: source.download, confirm: opts.confirm ?? (async () => true), hook: opts.hook });
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { copyFile };
