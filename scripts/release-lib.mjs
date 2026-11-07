// 发布脚本共用的纯函数（无副作用，便于测试）。
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_RELEASE_BASE = 'https://github.com/NginxL/beelite/releases/download';

/**
 * 判断当前模块是否作为脚本直接运行。用 pathToFileURL 兼容空格等字符；
 * Node 会解析主模块路径中的符号链接（例如 /var -> /private/var），因此先取 realpath 再比较。
 */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  let entry = path.resolve(process.argv[1]);
  try {
    entry = realpathSync(entry);
  } catch {
    // 入口文件不存在时按原路径比较
  }
  return pathToFileURL(entry).href === importMetaUrl;
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildAppcast(o) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>${xml(o.title)}</title>
    <item>
      <title>${xml(o.itemTitle)}</title>
      <pubDate>${xml(o.pubDate)}</pubDate>
      <sparkle:version>${xml(o.version)}</sparkle:version>
      <sparkle:shortVersionString>${xml(o.shortVersion)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${xml(o.minimumSystemVersion)}</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <enclosure url="${xml(o.url)}" length="${o.length}" type="application/octet-stream" sparkle:edSignature="${xml(o.signature)}"/>
    </item>
  </channel>
</rss>
`;
}

/** 解析 sign_update 对归档的输出：sparkle:edSignature="..." length="..." */
export function parseSignOutput(text) {
  const sig = /sparkle:edSignature="([A-Za-z0-9+/=]+)"/.exec(text);
  const len = /length="(\d+)"/.exec(text);
  if (!sig || !len) throw new Error('无法解析 sign_update 的输出');
  return { signature: sig[1], length: Number(len[1]) };
}

/** LSMinimumSystemVersion "13.0" -> Sparkle 要求的三段式 "13.0.0" */
export function threePart(v) {
  const parts = String(v).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

export function productionDownloadUrl(version, zipName) {
  return `${PRODUCTION_RELEASE_BASE}/v${version}/${encodeURIComponent(zipName)}`;
}

/**
 * 决定 appcast 中的下载地址。
 * 生产：只能是本仓库对应版本 Release 中的该文件；提供了不同的覆盖值时拒绝。
 * e2e：必须显式提供 http(s) 地址。
 */
export function resolveDownloadUrl({ mode, override, version, zipName }) {
  if (mode === 'production') {
    const expected = productionDownloadUrl(version, zipName);
    if (override !== undefined && override !== expected) {
      throw new Error(`生产发布的下载地址必须是 ${expected}，拒绝使用 ${override}`);
    }
    return expected;
  }
  if (!override) throw new Error('e2e 模式需要显式提供 --download-url');
  const u = new URL(override);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`不支持的下载地址：${override}`);
  return override;
}

/**
 * 确认签名账户的公钥与应用内置的 SUPublicEDKey 一致。
 * readPublicKey 只读查询公钥（官方 generate_keys --account <账户> -p），账户不存在时应抛错。
 */
export function checkSigningKey(readPublicKey, expectedKey, account) {
  let actual;
  try {
    actual = String(readPublicKey()).trim();
  } catch (err) {
    throw new Error(`无法读取签名账户 ${account} 的公钥（账户不存在或 Keychain 拒绝访问）：${err instanceof Error ? err.message : err}`);
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(actual)) throw new Error(`签名账户 ${account} 返回的公钥格式不正确`);
  if (actual !== expectedKey) {
    throw new Error(`签名账户 ${account} 的公钥（${actual}）与应用内置的 SUPublicEDKey（${expectedKey}）不一致，拒绝生成会被客户端拒绝的更新`);
  }
  return actual;
}
