// 游戏目录绑定：每个 flavor 记录一个用户手动选择并确认过的版本根目录。
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProfileInfo } from '../shared/types';
import { errorMessage, UserError } from './errors';
import { FLAVORS, getFlavor } from './flavors';
import { pathExists, writeFileAtomic } from './layout';

export interface Settings {
  schema: 1;
  bindings: Record<string, string>;
  lastFlavorId: number | null;
  /** 不认识的顶层字段原样保留，保存时一并写回 */
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function settingsError(file: string, reason: string): UserError {
  return new UserError(`无法读取艾泽魔方设置文件（${file}）：${reason}。为避免覆盖已有的目录绑定，已暂停读取和修改绑定；请修复该文件或恢复备份后点击重试。`, 'settings');
}

/**
 * 严格校验设置内容：任何不合法之处都报错，不丢弃条目（否则保存时会悄悄删掉它们）。
 * 诊断报告复用它做有界读取后的校验；错误说明含文件路径，诊断只取“是否失败”，不使用 message。
 */
export function parseSettings(text: string, file: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw settingsError(file, '内容不是有效的 JSON');
  }
  if (!isPlainObject(raw)) throw settingsError(file, '内容格式不正确');
  if (raw.schema !== 1) throw settingsError(file, '版本标记不正确');
  if (!isPlainObject(raw.bindings)) throw settingsError(file, '目录绑定格式不正确');
  const bindings: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.bindings)) {
    if (!/^\d+$/.test(k) || typeof v !== 'string' || !path.isAbsolute(v)) throw settingsError(file, `目录绑定 ${JSON.stringify(k)} 不合法`);
    bindings[k] = v;
  }
  const last = raw.lastFlavorId;
  if (last !== undefined && last !== null && !(typeof last === 'number' && Number.isInteger(last))) throw settingsError(file, '上次选择的游戏版本不合法');
  return { ...raw, schema: 1, bindings, lastFlavorId: last ?? null };
}

/**
 * 不缓存：每次都从磁盘读取并校验。只有文件不存在才视为首次运行的空配置；
 * 读取失败或内容不合法时一律报错，写入前也会先复核，保证不会覆盖用户原有的配置文件。
 * bind 在本实例内串行（整个 读取 → 核对 → 修改 → 保存 过程），不同游戏版本的绑定修改不会互相覆盖；
 * 应用中只有一个实例，设置文件只经由 bind 修改。直接调用 save 不经过这个队列，调用方自行避免并发
 */
export class SettingsStore {
  /** bind 的串行队列：前一次无论成败都不影响下一次 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return { schema: 1, bindings: {}, lastFlavorId: null };
      throw settingsError(this.file, e.code ? `读取失败（${e.code}）` : errorMessage(err));
    }
    return parseSettings(text, this.file);
  }

  /** 写入前复核磁盘上的当前配置仍可读取且合法，否则拒绝写入 */
  async save(next: Settings): Promise<void> {
    await this.load();
    await writeFileAtomic(this.file, JSON.stringify(next, null, 1));
  }

  async profile(flavorId: number): Promise<ProfileInfo> {
    return profileOf(await this.load(), flavorId);
  }

  /**
   * 绑定或解除绑定。expectCurrent 给出时，只有该版本当前绑定的目录（未绑定为 null）与之相同才写入，
   * 用来防止界面确认期间绑定已被改变。与其他 bind 串行；返回刚保存的结果（不再读取，保存成功就不会报失败）
   */
  bind(flavorId: number, root: string | null, expectCurrent?: string | null): Promise<ProfileInfo> {
    const run = this.queue.then(() => this.doBind(flavorId, root, expectCurrent));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doBind(flavorId: number, root: string | null, expectCurrent?: string | null): Promise<ProfileInfo> {
    const s = await this.load();
    if (expectCurrent !== undefined && (s.bindings[String(flavorId)] ?? null) !== expectCurrent) {
      throw new UserError('游戏目录绑定已变更，未做任何改动，请刷新后重试', 'target');
    }
    if (root) {
      const other = Object.entries(s.bindings).find(([fid, r]) => Number(fid) !== flavorId && r === root);
      if (other) throw new UserError(`该目录已绑定给「${getFlavor(Number(other[0]))?.name ?? other[0]}」，同一目录不能用于两个游戏版本`);
      s.bindings[String(flavorId)] = root;
    }
    else delete s.bindings[String(flavorId)];
    await this.save(s);
    return profileOf(s, flavorId);
  }
}

function profileOf(s: Settings, flavorId: number): ProfileInfo {
  const root = s.bindings[String(flavorId)] ?? null;
  return { flavorId, root, addonsPath: root ? path.join(root, 'Interface', 'AddOns') : null };
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
