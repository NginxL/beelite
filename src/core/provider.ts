// 插件数据源：NewBeeBox 客户端的公开匿名接口（不是有稳定合同的开放 API）。
// 只发送必要的请求头，不携带任何账号令牌或客户端标识；所有响应都先校验形状再转换为内部模型。
import type { CategoryInfo, ModDetail, ModFileInfo, ModSummary, SearchQuery, SearchResult, SortOrder } from '../shared/types';
import { UserError } from './errors';
import { canonicalFileId } from './file-id';
import { requestJson, type FetchFn } from './net';

export const API_BASE = 'https://api.newbeebox.com';
export const CONFIG_URL = 'https://cdn2.newbeebox.com/modconfig.json';
const IMAGE_PREFIX = 'https://cdn8.newbeebox.com/';
const CONFIG_TTL_MS = 60 * 60 * 1000;
const SORT_ORDERS: readonly SortOrder[] = ['ranking', 'update', 'total_download', 'favourite'];

export interface RemoteFlavor {
  id: number;
  name: string;
  versions: string[];
}

export interface RemoteConfig {
  flavors: RemoteFlavor[];
  categories: CategoryInfo[];
}

export interface LatestFile extends ModFileInfo {
  downloadUrl: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function idString(v: unknown): string {
  const s = str(v);
  if (!/^\d{1,12}$/.test(s)) throw new UserError('服务器返回的插件编号无效');
  return s;
}
function imageUrl(v: unknown): string | null {
  const s = str(v);
  return s.startsWith(IMAGE_PREFIX) ? s : null;
}

/** 把可能含 HTML 的外部文本转为纯文本 */
export function toPlainText(input: unknown): string {
  const s = str(input);
  return s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function categories(v: unknown): CategoryInfo[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((c) => ({ id: num(c.id), name: str(c.name) })).filter((c) => c.id > 0 && c.name);
}

/** 收费级别必须明确为 0（数字 0 或纯数字字符串 "0"），缺失、null、非法或其他值一律视为不可安装 */
export function isFreeLevel(v: unknown): boolean {
  if (typeof v === 'number') return v === 0;
  if (typeof v === 'string') return /^0+$/.test(v.trim());
  return false;
}

function accessible(x: Obj): boolean {
  return x.is_content_access === true && isFreeLevel(x.subscribe_plan_level);
}

function normalizeSummary(x: Obj): ModSummary {
  const files = Array.isArray(x.file_list) ? x.file_list.filter(isObj) : [];
  const first = files[0];
  const user = isObj(x.user_info) ? x.user_info : null;
  return {
    id: idString(x.id),
    name: str(x.name, '未命名插件'),
    logo: imageUrl(x.logo_url),
    summary: toPlainText(x.description),
    author: str(user?.t_username) || str(x.t_author_name) || str(x.official),
    updatedAt: num(x.update),
    downloads: num(x.total_download_count, num(x.down_total)),
    favorites: num(x.favorite_count),
    categories: categories(x.categories),
    version: first ? str(first.file_display_name) || str(first.file_name) : '',
    gameVersions: first ? strList(first.file_version) : [],
    folders: first ? strList(first.file_folders) : [],
    accessible: accessible(x),
  };
}

/** 统一处理 {code, message, data} 包装；code 不为 1 时把服务端说明原样交给用户 */
function unwrap(resp: unknown): unknown {
  if (!isObj(resp) || typeof resp.code !== 'number') throw new UserError('服务器返回的数据格式不正确');
  if (resp.code !== 1) {
    const msg = str(resp.message).trim();
    throw new UserError(msg ? `服务器提示：${msg}` : `服务器返回错误（code ${resp.code}）`, 'remote');
  }
  return resp.data;
}

export class NewBeeBoxProvider {
  private configCache: { at: number; value: RemoteConfig } | null = null;

  constructor(private readonly fetchFn?: FetchFn) {}

  private post(path: string, body: Obj, signal?: AbortSignal): Promise<unknown> {
    return requestJson(API_BASE + path, body, { fetchFn: this.fetchFn, signal });
  }

  async getConfig(force = false, signal?: AbortSignal): Promise<RemoteConfig> {
    if (!force && this.configCache && Date.now() - this.configCache.at < CONFIG_TTL_MS) return this.configCache.value;
    const raw = await requestJson(CONFIG_URL, undefined, { fetchFn: this.fetchFn, signal });
    const value = parseConfig(raw);
    this.configCache = { at: Date.now(), value };
    return value;
  }

  async flavorVersions(flavorId: number, signal?: AbortSignal): Promise<string[]> {
    const cfg = await this.getConfig(false, signal);
    const f = cfg.flavors.find((x) => x.id === flavorId);
    if (!f || f.versions.length === 0) throw new UserError('远端配置中没有该游戏版本');
    return f.versions;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult> {
    if (!SORT_ORDERS.includes(q.order)) throw new UserError('不支持的排序方式');
    const data = unwrap(
      await this.post('/v3/mod/list', {
        versions: q.flavorId,
        category: q.category,
        order: q.order,
        pay_filter: 0,
        offset: q.offset,
        filter: q.keyword,
      }, signal),
    );
    if (!isObj(data) || !Array.isArray(data.list)) throw new UserError('搜索结果格式不正确');
    if (data.game_version_id !== undefined && num(data.game_version_id) !== q.flavorId) {
      throw new UserError('服务器返回的游戏版本与请求不一致，已丢弃结果');
    }
    const items = data.list.filter(isObj).map(normalizeSummary);
    return { items, total: num(data.total, items.length), offset: q.offset, nextOffset: q.offset + data.list.length };
  }

  async detail(modId: string, flavorId: number, signal?: AbortSignal): Promise<ModDetail> {
    const data = unwrap(await this.post('/v3/mod/detail', { mod_id: Number(idString(modId)), game_version: flavorId }, signal));
    if (!isObj(data) || !isObj(data.result)) throw new UserError('插件详情格式不正确');
    const r = data.result;
    if (r.game_version_id !== undefined && num(r.game_version_id) !== flavorId) throw new UserError('插件详情的游戏版本与请求不一致');
    const base = normalizeSummary(r);
    if (base.id !== modId) throw new UserError('插件详情编号与请求不一致');
    const description = [toPlainText(r.intro), toPlainText(r.description)].filter(Boolean);
    return {
      ...base,
      summary: base.summary || description[0] || '',
      description: [...new Set(description)].join('\n\n'),
      screenshots: Array.isArray(r.screenshot) ? r.screenshot.filter(isObj).map((s) => imageUrl(s.url)).filter((u): u is string => !!u).slice(0, 8) : [],
      flavorId,
    };
  }

  /** 查询指定 flavor 的最新正式文件（strategy=1）；服务端无对应文件时返回 code -4，不做跨版本回退 */
  async latest(modId: string, flavorId: number, signal?: AbortSignal): Promise<LatestFile> {
    const versions = await this.flavorVersions(flavorId, signal);
    const data = unwrap(
      await this.post('/v3/mod_file/mod_file_latest', { mod_id: Number(idString(modId)), game_version_id: flavorId, strategy: 1, type: 3 }, signal),
    );
    return parseLatest(data, modId, versions);
  }
}

export function parseConfig(raw: unknown): RemoteConfig {
  if (!isObj(raw) || !Array.isArray(raw.game_version)) throw new UserError('远端配置格式不正确');
  const flavors = raw.game_version.filter(isObj).map((g) => ({ id: num(g.id), name: str(g.name), versions: strList(g.version) })).filter((g) => g.id > 0);
  const cats = Array.isArray(raw.mod_category) ? raw.mod_category.filter(isObj) : [];
  const categoriesList = cats.map((c) => ({ id: num(c.t_id), name: str(c.t_name) })).filter((c) => c.id > 0 && c.name);
  return { flavors, categories: categoriesList };
}

export function parseLatest(data: unknown, modId: string, flavorVersions: string[]): LatestFile {
  if (!isObj(data)) throw new UserError('文件信息格式不正确');
  // 与本地清单的约定一致（见 file-id.ts）：不合法的编号在下载之前拒绝，不能写进清单
  const fileId = canonicalFileId(data.t_id);
  if (fileId === null) throw new UserError('服务器返回的文件编号无效');
  if (str(data.t_mod_id) !== modId) throw new UserError('文件信息与插件不匹配');
  const downloadUrl = str(data.download_url);
  if (!downloadUrl) throw new UserError('该文件没有可用的下载地址');
  const gameVersions = strList(data.versions);
  return {
    fileId,
    modId,
    displayName: str(data.t_display_name) || str(data.t_file_name) || fileId,
    size: num(data.t_file_length),
    folders: strList(data.file_folders),
    gameVersions,
    releaseType: num(data.t_release_type),
    date: num(data.t_file_date),
    compatible: gameVersions.some((v) => flavorVersions.includes(v)),
    downloadUrl,
  };
}
