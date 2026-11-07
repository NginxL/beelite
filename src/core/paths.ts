import path from 'node:path';
import { UserError } from './errors';

const RESERVED_TOP = new Set(['wtf', 'interface', 'addons', '.beelite']);

/** 大小写与 Unicode 规范化无关的比较键（macOS APFS 默认不区分大小写） */
export function foldKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** 单个路径段是否安全：非空、不是 . / ..、无分隔符、无控制字符、长度合理 */
export function isSafeSegment(seg: string): boolean {
  if (!seg || seg === '.' || seg === '..') return false;
  if (seg.includes('/') || seg.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(seg)) return false;
  if (Buffer.byteLength(seg, 'utf8') > 255) return false;
  return true;
}

/** 可作为 AddOns 一级插件目录的名称 */
export function isValidModuleName(name: string): boolean {
  return isSafeSegment(name) && !name.startsWith('.') && !RESERVED_TOP.has(foldKey(name)) && !name.includes(':');
}

export function assertModuleName(name: string): string {
  if (!isValidModuleName(name)) throw new UserError(`不安全的插件目录名：${JSON.stringify(name)}`);
  return name;
}

/** 将相对路径解析到 base 之下，并确认结果没有离开 base */
export function resolveInside(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  const relCheck = path.relative(base, resolved);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new UserError(`路径越界：${rel}`);
  }
  return resolved;
}
