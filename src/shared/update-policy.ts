// 主进程与界面共用的“是否可以更新”判定：检查结果有新版本、该插件没有暂停更新，且更新策略可读取。
// 待更新数量、提醒、全部更新的计划与界面上的更新按钮都按它判断；暂停不改动 hasUpdate，真实的新版本仍可显示。
import type { UpdateCheckItem } from './types';

export function actionableUpdate(item: Pick<UpdateCheckItem, 'hasUpdate' | 'paused'>, policyError: string | null): boolean {
  return item.hasUpdate && !item.paused && policyError === null;
}
