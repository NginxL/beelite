// 已核验的游戏版本（flavor）映射。id 来自上游公开配置 modconfig.json 的 game_version[].id。
// 目录名只对已实际核验的版本给出，用于目录选择时的提示，绝不用于自动绑定。

export interface FlavorDef {
  id: number;
  name: string;
  /** 已核验的版本根目录名；未核验为 null */
  expectedDir: string | null;
  /** TOC 后缀优先级（不含分隔符），之后再回退到无后缀 TOC */
  tocSuffixes: string[];
}

export const FLAVORS: readonly FlavorDef[] = [
  { id: 9, name: '无限', expectedDir: '_forever_', tocSuffixes: ['Forever', 'Camelot'] },
  { id: 2, name: '正式服', expectedDir: '_retail_', tocSuffixes: ['Mainline'] },
  { id: 4, name: '泰坦重铸', expectedDir: null, tocSuffixes: ['Titan', 'Wrath', 'WOTLKC'] },
  { id: 7, name: '熊猫人之谜', expectedDir: null, tocSuffixes: ['Mists'] },
  { id: 8, name: '燃烧的远征', expectedDir: null, tocSuffixes: ['TBC', 'BCC'] },
  { id: 6, name: '经典旧世', expectedDir: null, tocSuffixes: ['Vanilla', 'Classic'] },
  { id: 3, name: '探索赛季', expectedDir: null, tocSuffixes: ['Vanilla', 'Classic'] },
];

export const DEFAULT_FLAVOR_ID = 9;

export function getFlavor(id: number): FlavorDef | undefined {
  return FLAVORS.find((f) => f.id === id);
}

/** 1.60.1 -> 16001，12.1.5 -> 120105 */
export function interfaceFromVersion(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}
