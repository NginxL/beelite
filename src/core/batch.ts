// 全部更新：整个批次固定在开始时确定的目标根目录；每项开始前确认绑定未变化，变化即安全停止。
// 结果如实汇总：检查失败、更新失败、用户取消都不计为成功。
import type { OpResult } from '../shared/types';
import { errorMessage } from './errors';
import type { AddonManager } from './manager';
import type { ProjectRecord } from './store';

export interface UpdateAllOptions {
  manager: AddonManager;
  /** 批次开始时确定的目标根目录，所有写入只针对它 */
  root: string;
  /** 该目录当前绑定的游戏版本；来源版本不同的项目跳过，不用当前版本的文件更新 */
  flavorId: number;
  /** 每项开始前调用：该根目录是否仍是用户当前绑定的目录 */
  isStillBound: () => Promise<boolean>;
  /** 对固定根目录执行一项更新 */
  installOne: (project: ProjectRecord, root: string) => Promise<OpResult>;
}

export async function runUpdateAll(o: UpdateAllOptions): Promise<OpResult> {
  const checks = await o.manager.checkUpdates(o.root, o.flavorId);
  const manifest = await o.manager.readManifestFor(o.root);
  const nameOf = (modId: string) => manifest.projects[modId]?.name ?? modId;
  const checkFailed = checks.filter((c) => c.error).map((c) => `${nameOf(c.modId)}：检查失败（${c.error}）`);
  const skipped = checks.filter((c) => c.skipped).map((c) => `${nameOf(c.modId)}：${c.skipped}，已跳过`);
  // 后端独立防护：只更新来源版本与本批次版本一致的项目
  const todo = checks.filter((c) => c.hasUpdate && manifest.projects[c.modId]?.flavorId === o.flavorId);

  if (todo.length === 0) {
    if (checkFailed.length === 0) {
      return skipped.length
        ? { ok: true, message: `可检查的插件都已是最新版本，跳过 ${skipped.length} 个其他游戏版本来源的插件`, warnings: skipped }
        : { ok: true, message: '所有插件都已是最新版本' };
    }
    return { ok: false, message: `有 ${checkFailed.length} 个插件检查更新失败，无法确认是否为最新`, warnings: [...checkFailed, ...skipped] };
  }

  let updated = 0;
  let cancelled = 0;
  const failed: string[] = [];
  let stopped = false;
  for (const c of todo) {
    const p = manifest.projects[c.modId];
    if (!(await o.isStillBound())) {
      stopped = true;
      break;
    }
    try {
      const r = await o.installOne(p, o.root);
      if (r.ok) updated++;
      else cancelled++;
    } catch (err) {
      failed.push(`${p.name}：${errorMessage(err)}`);
    }
  }

  const parts = [`已更新 ${updated} 个插件`];
  if (cancelled) parts.push(`取消 ${cancelled} 个`);
  if (failed.length) parts.push(`失败 ${failed.length} 个`);
  if (checkFailed.length) parts.push(`检查失败 ${checkFailed.length} 个`);
  if (skipped.length) parts.push(`跳过其他游戏版本来源的 ${skipped.length} 个`);
  const warnings = [...failed, ...checkFailed, ...skipped];
  if (stopped) {
    const rest = todo.length - updated - cancelled - failed.length;
    parts.push(`游戏目录绑定已变更，剩余 ${rest} 个未处理`);
  }
  return { ok: updated === todo.length && checkFailed.length === 0, message: parts.join('，'), warnings };
}
