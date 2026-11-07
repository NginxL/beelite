// 游戏目录绑定：每个 flavor 记录一个用户手动选择并确认过的版本根目录。
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProfileInfo } from '../shared/types';
import { UserError } from './errors';
import { FLAVORS, getFlavor } from './flavors';
import { pathExists, writeFileAtomic } from './layout';

export interface Settings {
  schema: 1;
  bindings: Record<string, string>;
  lastFlavorId: number | null;
}

export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    if (this.cache) return this.cache;
    let s: Settings = { schema: 1, bindings: {}, lastFlavorId: null };
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>;
      if (raw && typeof raw.bindings === 'object' && raw.bindings) {
        for (const [k, v] of Object.entries(raw.bindings)) {
          if (/^\d+$/.test(k) && typeof v === 'string' && path.isAbsolute(v)) s.bindings[k] = v;
        }
      }
      if (typeof raw.lastFlavorId === 'number') s.lastFlavorId = raw.lastFlavorId;
    } catch {
      s = { schema: 1, bindings: {}, lastFlavorId: null };
    }
    this.cache = s;
    return s;
  }

  async save(next: Settings): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(next, null, 1));
    this.cache = next;
  }

  async profile(flavorId: number): Promise<ProfileInfo> {
    const s = await this.load();
    const root = s.bindings[String(flavorId)] ?? null;
    return { flavorId, root, addonsPath: root ? path.join(root, 'Interface', 'AddOns') : null };
  }

  async bind(flavorId: number, root: string | null): Promise<ProfileInfo> {
    const s = structuredClone(await this.load());
    if (root) {
      const other = Object.entries(s.bindings).find(([fid, r]) => Number(fid) !== flavorId && r === root);
      if (other) throw new UserError(`该目录已绑定给「${getFlavor(Number(other[0]))?.name ?? other[0]}」，同一目录不能用于两个游戏版本`);
      s.bindings[String(flavorId)] = root;
    }
    else delete s.bindings[String(flavorId)];
    await this.save(s);
    return this.profile(flavorId);
  }
}

export interface RootInspection {
  root: string;
  warnings: string[];
}

/**
 * 把用户选择的目录规范化为版本根目录：选中 Interface/AddOns 或 Interface 时自动上移。
 * 只做只读检查，不创建任何目录。
 */
export async function inspectPickedRoot(picked: string, flavorId: number, otherBindings: Record<string, string>): Promise<RootInspection> {
  let real: string;
  try {
    real = await realpath(picked);
  } catch {
    throw new UserError('选择的目录不存在');
  }
  if (!(await lstat(real)).isDirectory()) throw new UserError('请选择一个文件夹');
  const base = path.basename(real).toLowerCase();
  const parentBase = path.basename(path.dirname(real)).toLowerCase();
  if (base === 'addons' && parentBase === 'interface') real = path.dirname(path.dirname(real));
  else if (base === 'interface') real = path.dirname(real);
  if (real === path.parse(real).root) throw new UserError('不能选择磁盘根目录');

  const flavor = getFlavor(flavorId);
  const name = path.basename(real);
  // 同一个目录只能属于一个游戏版本，避免不同版本的插件混装进同一个 AddOns
  for (const [fid, r] of Object.entries(otherBindings)) {
    if (Number(fid) !== flavorId && r === real) {
      throw new UserError(`该目录已绑定给「${getFlavor(Number(fid))?.name ?? fid}」，不能同时用于「${flavor?.name ?? flavorId}」。请选择对应版本自己的目录，或先解除另一版本的绑定。`);
    }
  }
  // 已核验的版本目录名选反了（例如把 _forever_ 选给正式服）直接拒绝
  const owner = FLAVORS.find((f) => f.expectedDir === name);
  if (owner && owner.id !== flavorId) {
    throw new UserError(`${name} 是「${owner.name}」的游戏目录，不能绑定给「${flavor?.name ?? flavorId}」。`);
  }

  // 以下情况允许用户在确认对话框中继续
  const warnings: string[] = [];
  if (flavor?.expectedDir && name !== flavor.expectedDir) {
    warnings.push(`「${flavor.name}」通常位于名为 ${flavor.expectedDir} 的目录，而你选择的是 ${name}。只有确认这是自定义的${flavor.name}目录时才继续。`);
  }
  if (!flavor?.expectedDir && !/^_[a-z_]+_$/.test(name)) {
    warnings.push(`魔兽世界的版本目录通常形如 _xxx_，而你选择的是 ${name}。`);
  }
  if (!(await pathExists(path.join(real, 'Interface'))) && !(await pathExists(path.join(real, 'WTF')))) {
    warnings.push('该目录下没有 Interface 或 WTF 文件夹，可能还没有运行过游戏或不是游戏目录。安装时会创建 Interface/AddOns。');
  }
  return { root: real, warnings };
}
