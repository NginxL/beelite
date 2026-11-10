// 系统显示名的本地化：raw Info.plist 中的名称保持 BeeLite（应用文件名、helper 查找与 Sparkle 路径依赖它），
// 访达、程序坞等处的显示名由 Contents/Resources/<语言>.lproj/InfoPlist.strings 提供。
// macOS 只在 raw CFBundleDisplayName 与应用文件名一致时才采用本地化显示名。
// 只能在 afterPack 中调用：electron-builder 在 afterPack 之前按 electronLanguages 删除不匹配的 .lproj（例如 zh-Hans）。
const { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

/**
 * 让主 bundle 的语言目录恰好是 localizations，并在签名之前为每个语言写入 InfoPlist.strings。
 * Electron 自带的其他空 .lproj（例如 en_GB、zh_CN）会参与系统的语言匹配，使本地化显示名找不到，所以删除；
 * 只删除空目录，非空、符号链接或不是目录时拒绝。InfoPlist.strings 已存在时拒绝覆盖，值中不允许出现需要转义的字符。
 * 所有检查都在改动之前完成，拒绝时不删除、不写入任何内容。
 */
function writeLocalizedInfo(appPath, localizations, info) {
  for (const [k, v] of Object.entries(info)) {
    if (/["\\\r\n]/.test(v)) throw new Error(`本地化值 ${k} 含有需要转义的字符`);
  }
  const resources = path.join(appPath, 'Contents', 'Resources');
  const extra = readdirSync(resources).filter((n) => n.endsWith('.lproj') && !localizations.includes(n.slice(0, -'.lproj'.length)));
  for (const name of extra) {
    const dir = path.join(resources, name);
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`主 bundle 中的 ${name} 不是普通目录，拒绝处理`);
    if (readdirSync(dir).length) throw new Error(`主 bundle 中多出的 ${name} 不是空目录，拒绝删除`);
  }
  const text = Object.entries(info).map(([k, v]) => `"${k}" = "${v}";\n`).join('');
  const files = localizations.map((lang) => path.join(resources, `${lang}.lproj`, 'InfoPlist.strings'));
  for (const file of files) {
    const dir = path.dirname(file);
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error(`主 bundle 中的 ${path.basename(dir)} 不是普通目录，拒绝处理`);
    if (existsSync(file)) throw new Error(`应用中已存在 ${path.relative(appPath, file)}，拒绝覆盖`);
  }
  for (const name of extra) rmdirSync(path.join(resources, name));
  for (const file of files) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

module.exports = { writeLocalizedInfo };
