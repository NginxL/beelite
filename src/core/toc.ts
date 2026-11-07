// 只读解析 TOC 元数据（## Key: Value），不读取也不执行任何 Lua。
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LocalFolder, TocInfo } from '../shared/types';
import { foldKey } from './paths';

const MAX_TOC_BYTES = 256 * 1024;

/** 去掉 WoW 文本里的颜色码与贴图转义 */
export function stripWowEscapes(s: string): string {
  return s
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\|T[^|]*\|t/g, '')
    .replace(/\|A[^|]*\|a/g, '')
    .trim();
}

export function parseToc(text: string, tocFile: string): TocInfo {
  const fields = new Map<string, string>();
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m && !fields.has(m[1].toLowerCase())) fields.set(m[1].toLowerCase(), m[2].trim());
  }
  const pick = (k: string) => fields.get(`${k}-zhcn`) || fields.get(k) || '';
  const interfaces = (fields.get('interface') ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    title: stripWowEscapes(pick('title')),
    version: stripWowEscapes(fields.get('version') ?? ''),
    notes: stripWowEscapes(pick('notes')),
    interfaces,
    tocFile,
  };
}

/** 按 flavor 的后缀优先级挑选目录自己的 TOC：Name_Suffix.toc / Name-Suffix.toc，最后回退 Name.toc */
export function selectToc(folder: string, files: string[], suffixes: readonly string[]): string | null {
  const byKey = new Map(files.map((f) => [foldKey(f), f]));
  for (const suffix of suffixes) {
    for (const sep of ['_', '-']) {
      const hit = byKey.get(foldKey(`${folder}${sep}${suffix}.toc`));
      if (hit) return hit;
    }
  }
  return byKey.get(foldKey(`${folder}.toc`)) ?? null;
}

async function readSmall(file: string): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_TOC_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_TOC_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function readFolderToc(dir: string, folder: string, suffixes: readonly string[]): Promise<TocInfo | null> {
  try {
    const files = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    const toc = selectToc(folder, files, suffixes);
    if (!toc) return null;
    return parseToc(await readSmall(path.join(dir, toc)), toc);
  } catch {
    return null;
  }
}

/** 列出 AddOns 下的一级目录（不跟随符号链接，符号链接只标记不读取） */
export async function scanAddOns(addonsDir: string, suffixes: readonly string[]): Promise<LocalFolder[]> {
  let entries;
  try {
    entries = await readdir(addonsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: LocalFolder[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) {
      out.push({ name: e.name, toc: null, symlink: true });
      continue;
    }
    if (!e.isDirectory()) continue;
    const st = await lstat(path.join(addonsDir, e.name));
    if (!st.isDirectory()) continue;
    out.push({ name: e.name, toc: await readFolderToc(path.join(addonsDir, e.name), e.name, suffixes), symlink: false });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
