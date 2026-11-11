// 全部更新：整个批次固定在开始时确定的目标根目录；每项开始前确认绑定未变化，变化即安全停止。
// 结果如实汇总：检查失败、更新失败、用户取消、检查后发生变化都不计为成功。
import type { OpResult, UpdateCheckItem } from '../shared/types';
import { actionableUpdate } from '../shared/update-policy';
import { errorMessage, UserError } from './errors';
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
  /**
   * 对固定根目录执行一项更新；project 是计划时清单中的记录，实现应在目录锁内核对它仍是当前记录，
   * 不一致时以 UserError('changed') 结束（计为“排队期间已变化”，不计为成功、失败或取消）。
   * changed：这一项是否确实提交了改动（false 计为“已是最新，未改动”；未给出时计为已更新）
   */
  installOne: (project: ProjectRecord, root: string) => Promise<OpResult & { changed?: boolean }>;
  /**
   * 批次开始时的更新检查（必须是新的检查，不使用缓存结果）。默认直接调用 manager.checkUpdates；
   * 应用中经由检查协调器排队，避免与自动检查叠加并发。批次已在写入闸门内，这里不能等待闸门归零。
   */
  check?: (root: string, flavorId: number) => Promise<UpdateCheckItem[]>;
  /** 检查完成、确定要更新的项目后调用一次（按处理顺序），之后才开始第一项 */
  plan?: (projects: ProjectRecord[]) => void;
  /**
   * 该目录已暂停更新的插件（检查之前读取一次；批次期间不受理暂停与恢复）。读取失败时抛出，整个批次不开始。
   * 有新版本的暂停项不处理，并在结果中逐项说明
   */
  paused?: () => Promise<ReadonlySet<string>>;
}

export async function runUpdateAll(o: UpdateAllOptions): Promise<OpResult> {
  const paused = o.paused ? await o.paused() : new Set<string>();
  const checks = o.check ? await o.check(o.root, o.flavorId) : await o.manager.checkUpdates(o.root, o.flavorId);
  const manifest = await o.manager.readManifestFor(o.root);
  const nameOf = (modId: string) => manifest.projects[modId]?.name ?? modId;
  const checkFailed = checks.filter((c) => c.error).map((c) => `${nameOf(c.modId)}：检查失败（${c.error}）`);
  const skipped = checks.filter((c) => c.skipped).map((c) => `${nameOf(c.modId)}：${c.skipped}，已跳过`);
  // 检查结果对应的本地文件与现在的清单不一致（检查后被改动），或清单中有未被检查的同版本项目：不能据此判断是否最新
  const checked = new Set(checks.map((c) => c.modId));
  const changed = [
    ...checks.filter((c) => !c.skipped && c.installedFileId !== undefined && manifest.projects[c.modId]?.fileId !== c.installedFileId).map((c) => c.modId),
    ...Object.values(manifest.projects).filter((p) => p.flavorId === o.flavorId && !checked.has(p.modId)).map((p) => p.modId),
  ];
  const changedSet = new Set(changed);
  const changedNotes = changed.map((id) => `${nameOf(id)}：检查后发生了变化，未处理，请重新检查`);
  // 后端独立防护：只更新来源版本与本批次版本一致的项目
  const candidates = checks.filter((c) => c.hasUpdate && !changedSet.has(c.modId) && manifest.projects[c.modId]?.flavorId === o.flavorId);
  // 暂停项保留当前版本：与界面、提醒使用同一判定
  const todo = candidates.filter((c) => actionableUpdate({ hasUpdate: c.hasUpdate, paused: paused.has(c.modId) }, null));
  const pausedNotes = candidates.filter((c) => paused.has(c.modId)).map((c) => `${nameOf(c.modId)}：已暂停更新，保留当前版本，未处理`);

  if (todo.length === 0) {
    if (checkFailed.length === 0 && changed.length === 0) {
      if (pausedNotes.length) {
        return { ok: true, message: `没有需要更新的插件：${pausedNotes.length} 个已暂停更新的插件有新版本，未处理`, warnings: [...pausedNotes, ...skipped] };
      }
      return skipped.length
        ? { ok: true, message: `可检查的插件都已是最新版本，跳过 ${skipped.length} 个其他游戏版本来源的插件`, warnings: skipped }
        : { ok: true, message: '所有插件都已是最新版本' };
    }
    if (checkFailed.length === 0) {
      return { ok: false, message: `有 ${changed.length} 个插件在检查后发生了变化，无法确认是否为最新，请重新检查`, warnings: [...changedNotes, ...pausedNotes, ...skipped] };
    }
    return { ok: false, message: `有 ${checkFailed.length} 个插件检查更新失败，无法确认是否为最新`, warnings: [...checkFailed, ...changedNotes, ...pausedNotes, ...skipped] };
  }

  let updated = 0;
  /** 成功结束但没有提交改动（例如检查后远端最新文件已与本地相同） */
  let unchanged = 0;
  let cancelled = 0;
  const failed: string[] = [];
  /** 目录保护（回滚无法判定或目录已暂停写入）：结果未确认，不计为失败或取消 */
  const unconfirmed: string[] = [];
  /** 排队期间被卸载、重装或恢复，未处理 */
  const stale: string[] = [];
  /** 每项返回的提示（例如目录移入备份、没有可备份的内容），逐项收集，后续项目失败或批次停止时不丢失 */
  const notes: string[] = [];
  let stopped = false;
  o.plan?.(todo.map((c) => manifest.projects[c.modId]));
  for (const c of todo) {
    const p = manifest.projects[c.modId];
    if (!(await o.isStillBound())) {
      stopped = true;
      break;
    }
    try {
      const r = await o.installOne(p, o.root);
      for (const w of r.warnings ?? []) notes.push(`${p.name}：${w}`);
      // changed 为 false：成功但没有提交改动；未给出时按已更新计（兼容只返回 OpResult 的实现）
      if (r.ok && r.changed === false) unchanged++;
      else if (r.ok) updated++;
      else cancelled++;
    } catch (err) {
      // 目录保护的诊断优先：结果未确认；用户在任务中取消的这一项计为取消，不计为失败；批次继续处理下一项
      if (err instanceof UserError && err.code === 'blocked') unconfirmed.push(`${p.name}：结果未确认，请以当前插件列表为准。${errorMessage(err)}`);
      else if (err instanceof UserError && err.code === 'cancelled') cancelled++;
      else if (err instanceof UserError && err.code === 'changed') stale.push(`${p.name}：排队期间已变化，未处理。${errorMessage(err)}`);
      else failed.push(`${p.name}：${errorMessage(err)}`);
    }
  }

  const parts = [`已更新 ${updated} 个插件`];
  if (unchanged) parts.push(`${unchanged} 个已是最新，未改动`);
  if (cancelled) parts.push(`取消 ${cancelled} 个`);
  if (failed.length) parts.push(`失败 ${failed.length} 个`);
  if (unconfirmed.length) parts.push(`结果未确认 ${unconfirmed.length} 个`);
  if (stale.length) parts.push(`排队期间已变化未处理 ${stale.length} 个`);
  if (checkFailed.length) parts.push(`检查失败 ${checkFailed.length} 个`);
  if (changed.length) parts.push(`检查后发生变化未处理 ${changed.length} 个`);
  if (pausedNotes.length) parts.push(`已暂停更新未处理 ${pausedNotes.length} 个`);
  if (skipped.length) parts.push(`跳过其他游戏版本来源的 ${skipped.length} 个`);
  const warnings = [...unconfirmed, ...failed, ...stale, ...notes, ...checkFailed, ...changedNotes, ...pausedNotes, ...skipped];
  if (stopped) {
    const rest = todo.length - updated - unchanged - cancelled - failed.length - unconfirmed.length - stale.length;
    parts.push(`游戏目录绑定已变更，剩余 ${rest} 个未处理`);
  }
  return { ok: updated + unchanged === todo.length && checkFailed.length === 0 && changed.length === 0, message: parts.join('，'), warnings };
}
