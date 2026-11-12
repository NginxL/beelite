// 插件管理：安装 / 更新 / 重装、卸载、恢复、启动恢复。所有写操作按目录串行，并通过 journal 事务保护。
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CleanupState, DirState, LocalFolder, LocalState, ManagedProjectView, OpResult, ProfileInfo, RecoveryEntryView, TaskPhase, TocInfo, UpdateCheckItem } from '../shared/types';
import { SimulatedCrash, UserError, errorMessage, isTransientError } from './errors';
import { canonicalFileId } from './file-id';
import { getFlavor } from './flavors';
import { scanAddonHealth, type HealthOptions } from './health';
import type { HealthReport } from '../shared/health-types';
import { inspectLayout, newTxId, pathExists, readFileNoFollow, syncDir, writableLayout, writeFileAtomic, type Layout } from './layout';
import { downloadToFile, type DownloadOptions, type DownloadResult } from './net';
import { foldKey, isValidModuleName, resolveInside } from './paths';
import type { LatestFile } from './provider';
import { commitTexts, emptyManifest, ID_RE, parseJournal, readManifest, serializeManifest, type Journal, type Manifest, type ProjectRecord, type RecoveryEntry } from './store';
import { scanAddOns } from './toc';
import { executeOps, isCrash, prepareOps, rollbackOps, type PlannedOp, type StepHook } from './txn';
import { DEFAULT_LIMITS, extractAddonZip, type ZipLimits } from './zip';

export interface ModSource {
  detail(modId: string, flavorId: number, signal?: AbortSignal): Promise<{ accessible: boolean; name: string; logo: string | null }>;
  latest(modId: string, flavorId: number, signal?: AbortSignal): Promise<LatestFile>;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  detail: string;
}

export interface ManagerOptions {
  source: ModSource;
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  download?: (url: string, dest: string, opts: DownloadOptions) => Promise<DownloadResult>;
  limits?: ZipLimits;
  /** 测试注入：在事务关键步骤调用，可抛错模拟失败或崩溃 */
  hook?: StepHook;
}

/**
 * 安装结果；installed 是本次提交到清单的记录，没有提交（已是最新、用户取消）时缺省；
 * previous 是同一次目录锁内读到的旧记录（首次安装没有），只随 installed 一起给出
 */
export type InstallResult = OpResult & { installed?: ProjectRecord; previous?: ProjectRecord };
/** 卸载已提交：removed 是提交前清单中的记录 */
export type UninstallResult = OpResult & { removed: ProjectRecord };
/** 恢复已提交：restored 是重新登记的项目（未托管目录的条目为 null），label 是回收站条目的名称 */
export type RestoreResult = OpResult & { restored: ProjectRecord | null; label: string };
/**
 * 永久删除已提交（条目已从回收站注销并登记待删除）：label 是回收站条目的名称；
 * diskRemoved 表示这一条目在本次操作中已从磁盘删除，false 时内容仍在待删除队列中，之后自动重试
 */
export type PurgeResult = OpResult & { label: string; diskRemoved: boolean };

/**
 * 安装前在目录锁内核对的条件（读到当前清单之后、下载之前）。不满足时以 UserError('changed') 结束，不写入任何东西。
 * - absent：首次安装，插件尚未在该目录托管；
 * - record：更新或重装，插件仍托管、且安装记录（文件编号 + 安装时间）与受理时一致。
 * 缺省时不核对（只供内部与测试使用）。
 */
export type InstallExpect = { kind: 'absent' } | { kind: 'record'; fileId: string; installedAt: number };

export interface InstallOptions {
  /** 即使已是最新文件也重新下载安装（重装）；仍须满足 expect */
  force?: boolean;
  signal?: AbortSignal;
  onPhase?: (phase: TaskPhase, received?: number, total?: number) => void;
  expect?: InstallExpect;
}

const BLOCKED_PREFIX = '该游戏目录有一个未完成且无法自动判定的操作，已暂停写入以保护插件。';

/** 清理提示的条数上限：超出部分汇总为一条 */
const MAX_CLEANUP_NOTES = 5;

/** 删除空目录；非空或不存在时保持原样 */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined);
}

function boundNotes(notes: string[]): string[] {
  if (notes.length <= MAX_CLEANUP_NOTES) return notes;
  return [...notes.slice(0, MAX_CLEANUP_NOTES - 1), `另有 ${notes.length - MAX_CLEANUP_NOTES + 1} 条清理问题未显示`];
}

/** 不存在视为空目录；其他读取错误如实抛出 */
async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 一次清理待删除队列的结果。failed：删除失败、仍留在队列中的条目（可能已删除一部分）；
 * unsaved：已从磁盘删除，但缩减后的队列没能保存（磁盘上的队列仍登记它们，下次清理时确认移除）
 */
interface DrainResult {
  failed: { id: string; error: string }[];
  unsaved: string[];
  saveError: string | null;
}

/** 保守清理的结果：problems 是暂存与回收站目录的清理问题；drained 是待删除队列的清理结果 */
interface GcReport {
  problems: string[];
  drained: DrainResult;
}

/** 已提交事务的收尾结果：warnings 写入这次操作的结果；drained 是本次清理待删除队列的结果（没有清理时为 null） */
interface PostCommit {
  warnings: string[];
  drained: DrainResult | null;
}

const NO_POST_COMMIT: PostCommit = { warnings: [], drained: null };

export class AddonManager {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly download: NonNullable<ManagerOptions['download']>;
  private readonly limits: ZipLimits;

  constructor(private readonly opts: ManagerOptions) {
    this.download = opts.download ?? downloadToFile;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
  }

  /** 同一目录的写操作串行执行 */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  private async lockKey(root: string): Promise<string> {
    return (await inspectLayout(root, false)).l.interfaceDir;
  }

  private async hook(step: string): Promise<void> {
    await this.opts.hook?.(step);
  }

  // ---------- 启动恢复与状态 ----------

  /**
   * 处理残留 journal，然后做保守清理。必须在锁内调用，且布局已通过 inspectLayout 检查。
   * 任何无法判定的情况都返回 blocked，并保留 journal、暂存与回收内容；已提交 journal 无法移除时如实抛出（不开始新的事务）。
   * 只有确认没有未完成事务、清单可读之后才做清理；清理失败不阻断，结果在 cleanup 中（没有执行清理时为 null）。
   */
  private async recoverLocked(l: Layout): Promise<{ dir: DirState; cleanup: GcReport | null }> {
    const blocked = (message: string) => ({ dir: { status: 'blocked' as const, message }, cleanup: null });
    let journalText: string | null;
    try {
      journalText = await readFileNoFollow(l.journalPath);
    } catch (err) {
      return blocked(`${BLOCKED_PREFIX}${errorMessage(err)}`);
    }
    if (journalText !== null) {
      let journal: Journal;
      try {
        journal = parseJournal(journalText);
      } catch (err) {
        return blocked(`${BLOCKED_PREFIX}${errorMessage(err)}\n事务日志：${l.journalPath}`);
      }
      let committed = false;
      if (journal.state === 'committing') {
        try {
          committed = (await readManifest(l)).manifest.lastTxId === journal.txId;
        } catch (err) {
          return blocked(`${BLOCKED_PREFIX}${errorMessage(err)}`);
        }
      }
      if (!committed) {
        const rb = await rollbackOps(l, journal.ops);
        if (!rb.ok) {
          return blocked(`${BLOCKED_PREFIX}${rb.reason}\n事务日志：${l.journalPath}\n备份与暂存：${l.metaDir}`);
        }
      }
      await unlink(l.manifestTmpPath).catch(() => undefined);
      await unlink(l.journalPath);
      await syncDir(l.metaDir);
    }
    await unlink(l.manifestTmpPath).catch(() => undefined);
    let manifest: Manifest;
    try {
      manifest = (await readManifest(l)).manifest;
    } catch (err) {
      return blocked(errorMessage(err));
    }
    return { dir: { status: 'ok', message: null }, cleanup: await this.gc(l, manifest) };
  }

  /**
   * 保守清理（调用前已确认没有未完成事务、staging/trash 为真实目录）：
   * - staging 只存放下载解压的新内容，整体清空；
   * - trash 中只递归删除 manifest.purgeQueue 明确登记的目录；其他未登记目录仅在为空时删除，非空一律保留。
   * 每一步单独处理失败并记入结果，不抛错；目录无法读取不当作已清空。
   */
  private async gc(l: Layout, manifest: Manifest): Promise<GcReport> {
    const problems: string[] = [];
    try {
      for (const name of await readdirOrEmpty(l.stagingDir)) {
        try {
          await rm(resolveInside(l.stagingDir, name), { recursive: true, force: true });
        } catch (err) {
          problems.push(`下载暂存 ${name} 未能清理：${errorMessage(err)}`);
        }
      }
    } catch (err) {
      problems.push(`无法读取下载暂存目录，暂存内容可能未清理：${errorMessage(err)}`);
    }
    const referenced = new Set(manifest.recovery.map((e) => e.id));
    const queued = new Set(manifest.purgeQueue);
    try {
      for (const name of await readdirOrEmpty(l.trashDir)) {
        if (!referenced.has(name) && !queued.has(name)) await removeIfEmpty(resolveInside(l.trashDir, name));
      }
    } catch (err) {
      problems.push(`无法读取回收站目录，空的回收目录可能未清理：${errorMessage(err)}`);
    }
    return { problems, drained: await this.drainPurgeQueue(l, manifest) };
  }

  /**
   * 逐项删除待删除队列登记的回收目录（不存在视为已删除），一项失败不影响其他项；不抛错。
   * 有删除成功的项时原子写回只剩失败项的清单（其余内容与 manifest 相同）；写回失败时磁盘上的队列保持原样，
   * 已删除的项在下次清理时确认移除。manifest 必须是当前已提交的清单。
   */
  private async drainPurgeQueue(l: Layout, manifest: Manifest): Promise<DrainResult> {
    const failed: DrainResult['failed'] = [];
    const removed: string[] = [];
    for (const id of manifest.purgeQueue) {
      if (!ID_RE.test(id)) {
        failed.push({ id, error: '待删除编号无效' });
        continue;
      }
      try {
        await rm(resolveInside(l.trashDir, id), { recursive: true, force: true });
        removed.push(id);
      } catch (err) {
        failed.push({ id, error: errorMessage(err) });
      }
    }
    if (removed.length === 0) return { failed, unsaved: [], saveError: null };
    try {
      await this.hook('purge-queue-save');
      // 只缩减待删除队列，不会比已提交的清单更大
      await writeFileAtomic(l.manifestPath, serializeManifest({ ...manifest, purgeQueue: manifest.purgeQueue.filter((id) => !removed.includes(id)) }));
    } catch (err) {
      if (isCrash(err)) throw err;
      return { failed, unsaved: removed, saveError: errorMessage(err) };
    }
    return { failed, unsaved: [], saveError: null };
  }

  /** 恢复残留事务并清理；目录还没有艾泽魔方数据时直接返回 ok，不创建任何东西 */
  private async recoverWithCleanup(root: string): Promise<{ dir: DirState; cleanup: GcReport | null }> {
    const info = await inspectLayout(root, false);
    if (!info.hasInterface || !(await pathExists(info.l.metaDir))) return { dir: { status: 'ok', message: null }, cleanup: null };
    if (!info.hasMeta) {
      // 数据目录不完整：不做任何写入，只报告状态
      if (await pathExists(info.l.journalPath)) return { dir: { status: 'blocked', message: `${BLOCKED_PREFIX}艾泽魔方数据目录不完整。` }, cleanup: null };
      return { dir: { status: 'ok', message: null }, cleanup: null };
    }
    return this.withLock(info.l.interfaceDir, async () => {
      const again = await inspectLayout(root, false);
      return this.recoverLocked(again.l);
    });
  }

  /** 恢复残留事务；目录还没有艾泽魔方数据时直接返回 ok，不创建任何东西 */
  async recover(root: string): Promise<DirState> {
    return (await this.recoverWithCleanup(root)).dir;
  }

  /** 写操作入口：补齐并检查布局、恢复残留事务、读取 manifest（清理未完成不阻断，状态见本地状态） */
  private async openForWrite(root: string): Promise<{ l: Layout; manifest: Manifest }> {
    const l = await writableLayout(root);
    const { dir } = await this.recoverLocked(l);
    if (dir.status !== 'ok') throw new UserError(dir.message ?? BLOCKED_PREFIX, 'blocked');
    return { l, manifest: (await readManifest(l)).manifest };
  }

  /** 只读汇总本地状态：扫描 AddOns 不依赖艾泽魔方数据是否存在；没有 manifest 时全部视为未托管 */
  async localState(profile: ProfileInfo & { root: string }, flavorId: number): Promise<LocalState> {
    const suffixes = getFlavor(flavorId)?.tocSuffixes ?? [];
    const empty: LocalState = { flavorId, profile, dir: null, managed: [], unmanaged: [], recovery: [], cleanup: null, error: null };
    let dir: DirState;
    let report: GcReport | null;
    let info;
    try {
      ({ dir, cleanup: report } = await this.recoverWithCleanup(profile.root));
      info = await inspectLayout(profile.root, false);
    } catch (err) {
      return { ...empty, error: errorMessage(err) };
    }
    const l = info.l;
    let manifest = emptyManifest();
    if (info.hasMeta || (await pathExists(l.metaDir))) {
      try {
        manifest = (await readManifest(l)).manifest;
      } catch (err) {
        dir = { status: 'blocked', message: errorMessage(err) };
      }
    }
    const folders = info.hasAddons ? await scanAddOns(l.addonsDir, suffixes) : [];
    const onDisk = new Map(folders.map((f) => [foldKey(f.name), f]));
    const owned = new Set<string>();
    const managed: ManagedProjectView[] = [];
    for (const p of Object.values(manifest.projects)) {
      let toc: TocInfo | null = null;
      const fs = p.folders.map((name) => {
        owned.add(foldKey(name));
        const hit = onDisk.get(foldKey(name));
        if (hit && !toc && hit.toc) toc = hit.toc;
        return { name, present: !!hit };
      });
      managed.push({ modId: p.modId, flavorId: p.flavorId, name: p.name, logo: p.logo, fileId: p.fileId, version: p.version, folders: fs, installedAt: p.installedAt, toc });
    }
    managed.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const unmanaged: LocalFolder[] = folders.filter((f) => !owned.has(foldKey(f.name)));
    const recovery: RecoveryEntryView[] = manifest.recovery
      .map((e) => ({ id: e.id, kind: e.kind, createdAt: e.createdAt, label: e.label, folders: e.folders, modId: e.project?.modId ?? null }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return { flavorId, profile, dir, managed, unmanaged, recovery, cleanup: cleanupState(report, manifest), error: null };
  }

  // ---------- 提交 ----------

  /**
   * 记录目录身份、写 journal、执行 rename，最后原子提交 manifest。
   * 未提交前失败会按身份逆序回滚；回滚无法判定时保留 journal 与原件并抛出 blocked。
   * manifest 提交之后不再抛错（模拟崩溃除外）、不回滚：事务日志未能移除与 afterCommit 的收尾问题都在返回的 warnings 中。
   * 事务日志未能移除时不执行 afterCommit，由下一次恢复识别为已提交并收尾。
   */
  private async commit(l: Layout, txId: string, kind: string, planned: PlannedOp[], trashIds: string[], next: Manifest, afterCommit: () => Promise<PostCommit>): Promise<PostCommit> {
    next.lastTxId = txId;
    const ops = await prepareOps(l, planned);
    const journal: Journal = { schema: 1, txId, kind, state: 'prepared', trashIds, ops, createdAt: Date.now() };
    // 写 journal、移动任何目录之前确认三段元数据都不超过读取上限；超过即拒绝，什么都不写
    const texts = commitTexts(next, journal);
    await writeFileAtomic(l.journalPath, texts.prepared);
    let committed = false;
    try {
      await this.hook('journal-written');
      await executeOps(l, ops, this.opts.hook);
      await writeFileAtomic(l.manifestTmpPath, texts.manifest, `${l.manifestTmpPath}.part`);
      await this.hook('manifest-tmp-written');
      await writeFileAtomic(l.journalPath, texts.committing);
      await this.hook('committing');
      await rename(l.manifestTmpPath, l.manifestPath);
      await syncDir(l.metaDir);
      committed = true;
      await this.hook('manifest-committed');
      await unlink(l.journalPath);
    } catch (err) {
      if (isCrash(err)) throw err;
      // manifest 已提交即事务成功；残留 journal 会在下次恢复时被识别为已提交并清理（无法清理时下次写入不会开始）
      if (committed) return { warnings: [`操作已提交，但事务日志未能移除（${errorMessage(err)}），下次刷新或写入这个目录时会先自动收尾`], drained: null };
      const rb = await rollbackOps(l, ops);
      if (!rb.ok) throw new UserError(`${BLOCKED_PREFIX}${rb.reason}\n原因：${errorMessage(err)}`, 'blocked');
      await unlink(l.manifestTmpPath).catch(() => undefined);
      await unlink(l.journalPath);
      throw err;
    }
    try {
      return await afterCommit();
    } catch (err) {
      if (isCrash(err)) throw err;
      return { warnings: [`操作已提交，但收尾时出错（${errorMessage(err)}），下次刷新或写入这个目录时会重试清理`], drained: null };
    }
  }

  private async diskNames(l: Layout): Promise<Map<string, string>> {
    const names = await readdir(l.addonsDir);
    return new Map(names.filter((n) => !n.startsWith('.')).map((n) => [foldKey(n), n]));
  }

  private owners(manifest: Manifest, exceptModId?: string): Map<string, ProjectRecord> {
    const m = new Map<string, ProjectRecord>();
    for (const p of Object.values(manifest.projects)) {
      if (p.modId === exceptModId) continue;
      for (const f of p.folders) m.set(foldKey(f), p);
    }
    return m;
  }

  // ---------- 安装 / 更新 ----------

  async install(root: string, flavorId: number, modId: string, o: InstallOptions = {}): Promise<InstallResult> {
    const phase = o.onPhase ?? (() => undefined);
    phase('checking');
    // 免费与可访问性复核、按 flavor 取最新文件（服务端没有该版本文件时会直接报错，不做回退）
    const detail = await this.opts.source.detail(modId, flavorId, o.signal);
    if (!detail.accessible) throw new UserError('该插件不是免费公开内容，艾泽魔方不提供安装');
    const latest = await this.opts.source.latest(modId, flavorId, o.signal);
    // 文件编号会提交到清单：必须已是规范形式（与 parseLatest 的输出一致），否则在下载与加锁之前拒绝
    if (canonicalFileId(latest.fileId) !== latest.fileId) throw new UserError('服务器返回的文件编号无效');
    if (!latest.compatible) {
      throw new UserError(`该文件声明的游戏版本（${latest.gameVersions.join('、') || '未知'}）与当前游戏版本不匹配，已停止安装`);
    }

    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const existing = manifest.projects[modId];
      if (existing && existing.flavorId !== flavorId) {
        throw new UserError(
          `「${existing.name}」已以「${getFlavor(existing.flavorId)?.name ?? existing.flavorId}」版本安装在这个目录，与当前游戏版本不同，艾泽魔方不会用当前版本的文件更新或重装它。如需改用当前版本，请先卸载再安装。`,
          'flavor-mismatch',
        );
      }
      const expect = o.expect;
      if (expect?.kind === 'absent' && existing) {
        throw new UserError(`「${existing.name}」已经安装在这个目录，未做任何改动`, 'changed');
      }
      if (expect?.kind === 'record') {
        if (!existing) throw new UserError(`「${detail.name}」已不在这个目录的艾泽魔方管理列表中（可能已被卸载），未做任何改动`, 'changed');
        if (existing.fileId !== expect.fileId || existing.installedAt !== expect.installedAt) {
          throw new UserError(`「${existing.name}」在操作受理后已被重新安装、更新或恢复，未做任何改动，请刷新后重试`, 'changed');
        }
      }
      if (existing && !o.force && existing.fileId === latest.fileId) {
        return { ok: true, message: `「${existing.name}」已是最新版本` };
      }

      const txId = newTxId();
      const stageRoot = path.join(l.stagingDir, txId);
      const backupId = `${txId}-b`;
      const takeoverId = `${txId}-t`;
      try {
        await mkdir(stageRoot, { mode: 0o755 });
        phase('downloading', 0, latest.size);
        const zipPath = path.join(stageRoot, 'package.zip');
        await this.download(latest.downloadUrl, zipPath, {
          expectedSize: latest.size,
          maxBytes: this.limits.maxArchiveBytes,
          signal: o.signal,
          onProgress: (r, t) => phase('downloading', r, t),
        });
        await this.hook('downloaded');
        phase('verifying');
        const zip = await extractAddonZip(zipPath, path.join(stageRoot, 'x'), this.limits);
        await unlink(zipPath).catch(() => undefined);
        await this.hook('extracted');
        o.signal?.throwIfAborted();

        // 冲突计算（大小写不敏感）
        const disk = await this.diskNames(l);
        const others = this.owners(manifest, modId);
        const oldFolders = existing?.folders ?? [];
        const oldKeys = new Set(oldFolders.map(foldKey));
        const blocked = zip.modules.filter((m) => others.has(foldKey(m)));
        if (blocked.length) {
          const owner = others.get(foldKey(blocked[0]))!;
          throw new UserError(`目录 ${blocked.join('、')} 已属于已安装的「${owner.name}」，为避免互相覆盖已停止安装。请先卸载「${owner.name}」。`, 'conflict');
        }
        const takeover = zip.modules.filter((m) => disk.has(foldKey(m)) && !oldKeys.has(foldKey(m))).map((m) => disk.get(foldKey(m))!);
        const backup = oldFolders.filter((f) => disk.has(foldKey(f))).map((f) => disk.get(foldKey(f))!);
        const actual = new Set(zip.modules.map(foldKey));
        const declared = new Set(latest.folders.map(foldKey));
        const diff = latest.folders.length > 0 && (declared.size !== actual.size || [...actual].some((k) => !declared.has(k)));

        if (takeover.length || diff) {
          const lines: string[] = [];
          if (takeover.length) lines.push(`以下目录已存在但不由艾泽魔方管理，继续将把它们移入回收站（可恢复）并由本插件接管：\n${takeover.join('、')}`);
          if (diff) lines.push(`压缩包实际包含的目录与服务器记录不一致。\n服务器：${latest.folders.join('、') || '（无）'}\n压缩包：${zip.modules.join('、')}`);
          const ok = await this.opts.confirm({ title: '确认安装', message: `安装「${detail.name}」前需要确认`, detail: lines.join('\n\n') });
          if (!ok) {
            await rm(stageRoot, { recursive: true, force: true });
            return { ok: false, message: '已取消安装，未做任何改动' };
          }
        }

        phase('installing');
        const planned: PlannedOp[] = [];
        const trashIds: string[] = [];
        const next: Manifest = structuredClone(manifest);
        if (backup.length) {
          await mkdir(path.join(l.trashDir, backupId), { mode: 0o755 });
          trashIds.push(backupId);
          for (const f of backup) planned.push({ from: `AddOns/${f}`, to: `.beelite/trash/${backupId}/${f}` });
        }
        if (takeover.length) {
          await mkdir(path.join(l.trashDir, takeoverId), { mode: 0o755 });
          trashIds.push(takeoverId);
          for (const f of takeover) planned.push({ from: `AddOns/${f}`, to: `.beelite/trash/${takeoverId}/${f}` });
        }
        for (const m of zip.modules) planned.push({ from: `.beelite/staging/${txId}/x/${m}`, to: `AddOns/${m}` });

        const now = Date.now();
        /** 本次替换下来、登记待删除的旧更新前备份 */
        let superseded: string[] = [];
        if (backup.length && existing) {
          // 同一插件只保留最近一份更新前备份；旧备份进入待删除队列，随 manifest 一起原子提交
          superseded = next.recovery.filter((e) => e.kind === 'update-backup' && e.project?.modId === modId).map((e) => e.id);
          next.recovery = next.recovery.filter((e) => !superseded.includes(e.id));
          next.purgeQueue.push(...superseded);
          // 备份记录只登记实际移入备份的目录
          next.recovery.push({ id: backupId, kind: 'update-backup', createdAt: now, label: `${existing.name} ${existing.version}（更新前备份）`, folders: backup, project: { ...existing, folders: backup } });
        }
        if (takeover.length) {
          next.recovery.push({ id: takeoverId, kind: 'takeover', createdAt: now, label: `安装「${detail.name}」时接管的目录`, folders: takeover, project: null });
        }
        next.projects[modId] = { modId, flavorId, fileId: latest.fileId, version: latest.displayName, name: detail.name, logo: detail.logo, folders: zip.modules, installedAt: now };

        const post = await this.commit(l, txId, existing ? 'update' : 'install', planned, trashIds, next, async () => {
          const notes: string[] = [];
          try {
            await rm(stageRoot, { recursive: true, force: true });
          } catch (err) {
            notes.push(`本次下载的暂存文件未能清理（${errorMessage(err)}），之后写入这个目录时会重试`);
          }
          return { warnings: notes, drained: await this.drainPurgeQueue(l, next) };
        });
        phase('done');
        // 只把实际移入备份的目录说成“已备份”；更新前已不在 AddOns 中的旧目录单独说明，不承诺可以找回
        const retired = existing ? backup.filter((f) => !actual.has(foldKey(f))) : [];
        const missingOld = existing ? oldFolders.filter((f) => !disk.has(foldKey(f)) && !actual.has(foldKey(f))) : [];
        const warnings = [...zip.warnings];
        if (retired.length) warnings.push(`新版本不再包含 ${retired.join('、')}，已随旧版本一起移入备份`);
        if (missingOld.length) warnings.push(`新版本不再包含 ${missingOld.join('、')}；它们在更新前已不在 AddOns 中，没有可备份的内容`);
        // 收尾问题不影响已提交的安装：旧的更新前备份只报告本次替换下来的那一份
        warnings.push(...post.warnings);
        if (superseded.length) {
          if (post.drained) warnings.push(...ownPurgeNotes(post.drained, superseded, '旧的更新前备份'));
          else warnings.push('旧的更新前备份尚未删除，已登记待清理，之后刷新或写入这个目录时会自动重试');
        }
        return {
          ok: true,
          message: !existing
            ? `「${detail.name}」${latest.displayName} 安装完成`
            : existing.fileId === latest.fileId
              ? `「${detail.name}」${latest.displayName} 已重新安装`
              : `「${detail.name}」已更新到 ${latest.displayName}`,
          warnings,
          installed: { ...next.projects[modId], folders: [...zip.modules] },
          ...(existing ? { previous: { ...existing, folders: [...existing.folders] } } : {}),
        };
      } catch (err) {
        // 没有残留 journal 说明没有进入或已完整回滚提交阶段：只清理本次下载的暂存内容与空的回收目录。
        // 有残留 journal（模拟崩溃或回滚无法判定）时一律保留现场。
        if (!isCrash(err) && !(await pathExists(l.journalPath))) {
          await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
          await removeIfEmpty(path.join(l.trashDir, backupId));
          await removeIfEmpty(path.join(l.trashDir, takeoverId));
        }
        throw err;
      }
    });
  }

  // ---------- 卸载 / 恢复 ----------

  async uninstallProject(root: string, modId: string): Promise<UninstallResult> {
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const project = manifest.projects[modId];
      if (!project) throw new UserError('该插件不在艾泽魔方管理列表中');
      const disk = await this.diskNames(l);
      const present = project.folders.filter((f) => disk.has(foldKey(f))).map((f) => disk.get(foldKey(f))!);
      const missing = project.folders.filter((f) => !disk.has(foldKey(f)));
      const txId = newTxId();
      const next: Manifest = structuredClone(manifest);
      delete next.projects[modId];
      const planned = present.map((f) => ({ from: `AddOns/${f}`, to: `.beelite/trash/${txId}/${f}` }));
      if (present.length) {
        await mkdir(path.join(l.trashDir, txId), { mode: 0o755 });
        // 恢复时只会重新登记这些实际移入回收站的目录，已缺失的目录不再归属该项目
        next.recovery.push({ id: txId, kind: 'uninstall', createdAt: Date.now(), label: `${project.name} ${project.version}`, folders: present, project: { ...project, folders: present } });
      }
      const post = await this.commit(l, txId, 'uninstall', planned, present.length ? [txId] : [], next, async () => NO_POST_COMMIT);
      const note = missing.length ? `（${missing.join('、')} 已不在 AddOns 中，不会被恢复）` : '';
      return {
        ok: true,
        message: present.length ? `已卸载「${project.name}」，可在回收站恢复${note}` : `已移除「${project.name}」的记录（目录已不存在）`,
        ...(post.warnings.length ? { warnings: post.warnings } : {}),
        removed: { ...project, folders: [...project.folders] },
      };
    });
  }

  async uninstallFolder(root: string, folder: string): Promise<OpResult> {
    if (!isValidModuleName(folder)) throw new UserError('目录名无效');
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const owner = this.owners(manifest).get(foldKey(folder));
      if (owner) throw new UserError(`目录 ${folder} 属于「${owner.name}」，请从已托管列表卸载整个插件`);
      const disk = await this.diskNames(l);
      if (disk.get(foldKey(folder)) !== folder) throw new UserError(`目录 ${folder} 不存在`);
      const txId = newTxId();
      await mkdir(path.join(l.trashDir, txId), { mode: 0o755 });
      const next: Manifest = structuredClone(manifest);
      next.recovery.push({ id: txId, kind: 'uninstall', createdAt: Date.now(), label: folder, folders: [folder], project: null });
      let post: PostCommit;
      try {
        post = await this.commit(l, txId, 'uninstall-folder', [{ from: `AddOns/${folder}`, to: `.beelite/trash/${txId}/${folder}` }], [txId], next, async () => NO_POST_COMMIT);
      } catch (err) {
        if (!isCrash(err) && !(await pathExists(l.journalPath))) await removeIfEmpty(path.join(l.trashDir, txId));
        throw err;
      }
      return { ok: true, message: `已将 ${folder} 移入回收站`, ...(post.warnings.length ? { warnings: post.warnings } : {}) };
    });
  }

  async restore(root: string, entryId: string): Promise<RestoreResult> {
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const entry = manifest.recovery.find((e) => e.id === entryId);
      if (!entry) throw new UserError('回收站中没有这一项');
      const disk = await this.diskNames(l);
      const owners = this.owners(manifest);
      const conflicts: string[] = [];
      for (const f of entry.folders) {
        const owner = owners.get(foldKey(f));
        if (owner) conflicts.push(`${f}（属于已安装的「${owner.name}」）`);
        else if (disk.has(foldKey(f))) conflicts.push(`${f}（AddOns 中已存在同名目录）`);
      }
      if (entry.project && manifest.projects[entry.project.modId]) conflicts.push(`「${entry.project.name}」当前已安装，请先卸载当前版本`);
      if (conflicts.length) throw new UserError(`无法恢复，未做任何改动：\n${conflicts.join('\n')}`, 'conflict');
      for (const f of entry.folders) {
        if (!(await pathExists(resolveInside(l.trashDir, `${entry.id}/${f}`)))) throw new UserError(`回收站中的 ${f} 已丢失，无法恢复，未做任何改动`);
      }
      const txId = newTxId();
      const next: Manifest = structuredClone(manifest);
      next.recovery = next.recovery.filter((e) => e.id !== entry.id);
      if (entry.project) {
        // 只登记这次实际恢复的目录（manifest 校验保证 project.folders ⊆ entry.folders）
        const restored = new Set(entry.folders.map(foldKey));
        next.projects[entry.project.modId] = { ...entry.project, folders: entry.project.folders.filter((f) => restored.has(foldKey(f))) };
      }
      const planned = entry.folders.map((f) => ({ from: `.beelite/trash/${entry.id}/${f}`, to: `AddOns/${f}` }));
      const post = await this.commit(l, txId, 'restore', planned, [entry.id], next, async () => {
        await removeIfEmpty(resolveInside(l.trashDir, entry.id));
        return NO_POST_COMMIT;
      });
      const restored = entry.project ? next.projects[entry.project.modId] : null;
      return {
        ok: true,
        message: `已恢复：${entry.label}`,
        ...(post.warnings.length ? { warnings: post.warnings } : {}),
        restored: restored ? { ...restored, folders: [...restored.folders] } : null,
        label: entry.label,
      };
    });
  }

  async purge(root: string, entryId: string): Promise<PurgeResult> {
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const entry = manifest.recovery.find((e) => e.id === entryId);
      if (!entry) throw new UserError('回收站中没有这一项');
      const next: Manifest = structuredClone(manifest);
      next.recovery = next.recovery.filter((e) => e.id !== entryId);
      next.purgeQueue.push(entryId);
      const post = await this.commit(l, newTxId(), 'purge', [], [], next, async () => ({ warnings: [], drained: await this.drainPurgeQueue(l, next) }));
      // 只按本条目自己的删除结果说明（队列中可能还有其他条目的失败）；已提交即不能再从回收站恢复
      const diskRemoved = !!post.drained && !post.drained.failed.some((f) => f.id === entryId);
      const warnings = [...post.warnings, ...(post.drained ? ownPurgeNotes(post.drained, [entryId], '这一条目') : [])];
      return {
        ok: true,
        message: diskRemoved ? `已永久删除：${entry.label}` : `「${entry.label}」已从回收站移除并登记待清理，磁盘删除尚未完成`,
        ...(warnings.length ? { warnings } : {}),
        label: entry.label,
        diskRemoved,
      };
    });
  }

  // ---------- 更新检查 ----------

  /** 检查 root 中托管插件的更新；flavorId 是该目录当前绑定的游戏版本，来源版本不同的项目不查询、不视为可更新 */
  async checkUpdates(root: string, flavorId: number, signal?: AbortSignal): Promise<UpdateCheckItem[]> {
    return (await this.checkUpdatesDetailed(root, flavorId, signal)).items;
  }

  /**
   * 同 checkUpdates，另外返回检查所依据的清单指纹。只读：不创建目录、不恢复事务、不写任何文件。
   * signal 中止后不再发起剩余项目的查询，并以中止错误结束（不会返回不完整的结果）。
   */
  async checkUpdatesDetailed(root: string, flavorId: number, signal?: AbortSignal): Promise<{ items: UpdateCheckItem[]; fingerprint: string }> {
    signal?.throwIfAborted();
    const manifest = await this.readOnlyManifest(root);
    signal?.throwIfAborted();
    const out: UpdateCheckItem[] = [];
    const projects: ProjectRecord[] = [];
    for (const p of Object.values(manifest.projects)) {
      if (p.flavorId === flavorId) projects.push(p);
      else {
        const from = getFlavor(p.flavorId)?.name ?? String(p.flavorId);
        out.push({ modId: p.modId, hasUpdate: false, latestFileId: null, latestVersion: null, error: null, skipped: `按「${from}」版本安装，与当前游戏版本不同，不检查更新`, installedFileId: p.fileId, name: p.name });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < projects.length && !signal?.aborted) {
        const p = projects[next++];
        const base = { modId: p.modId, installedFileId: p.fileId, name: p.name };
        try {
          const latest = await this.opts.source.latest(p.modId, p.flavorId, signal);
          out.push({ ...base, hasUpdate: latest.compatible && latest.fileId !== p.fileId, latestFileId: latest.fileId, latestVersion: latest.displayName, error: latest.compatible ? null : '最新文件不支持当前游戏版本' });
        } catch (err) {
          if (signal?.aborted) break;
          out.push({ ...base, hasUpdate: false, latestFileId: null, latestVersion: null, error: errorMessage(err), transient: isTransientError(err) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    signal?.throwIfAborted();
    return { items: out, fingerprint: manifestFingerprint(manifest) };
  }

  /** 当前清单（只读），与 checkUpdatesDetailed 读取同一份清单 */
  async readCheckedManifest(root: string): Promise<{ manifest: Manifest; fingerprint: string }> {
    const manifest = await this.readOnlyManifest(root);
    return { manifest, fingerprint: manifestFingerprint(manifest) };
  }

  /** 读取 manifest（只读） */
  async readManifestFor(root: string): Promise<Manifest> {
    return this.readOnlyManifest(root);
  }

  /**
   * 只读健康检查：在同一目录的写操作队列中执行，不与本应用的安装、更新、卸载、恢复交错；
   * 只排队等待，不恢复事务、不清理暂存与回收站（不经过 openForWrite / recoverLocked / gc）。
   * 目录布局本身无法检查（例如不存在、内部目录是符号链接）时拿不到队列键，直接交给扫描如实返回无法检查。
   */
  async health(root: string, flavorId: number, interfaceNumber: number | null, options?: HealthOptions): Promise<HealthReport> {
    let key: string;
    try {
      key = await this.lockKey(root);
    } catch {
      return scanAddonHealth(root, flavorId, interfaceNumber, options);
    }
    return this.withLock(key, () => scanAddonHealth(root, flavorId, interfaceNumber, options));
  }

  /**
   * 检查、读回与批次共用的只读清单读取：按数据目录中实际的 manifest.json 读取，不要求 staging/trash 存在
   * （它们缺失时由下一次写操作补齐）。没有数据目录或清单时为空清单；不创建目录、不恢复事务。
   * 已存在的内部目录仍须是真实目录，清单读取不跟随符号链接，读取失败如实抛出。
   */
  private async readOnlyManifest(root: string): Promise<Manifest> {
    const info = await inspectLayout(root, false);
    if (!info.hasInterface || !(await pathExists(info.l.metaDir))) return emptyManifest();
    return (await readManifest(info.l)).manifest;
  }
}

/**
 * 清单指纹：最后提交的事务编号与所有托管项目（编号、来源版本、文件编号、目录）。
 * 任何安装、更新、卸载、恢复都会提交新事务；同一文件编号的重装也会改变事务编号。待删除队列的清理不影响指纹。
 */
export function manifestFingerprint(m: Manifest): string {
  const projects = Object.values(m.projects)
    .map((p) => [p.modId, p.flavorId, p.fileId, [...p.folders].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify([m.lastTxId, projects])).digest('hex').slice(0, 32);
}

/**
 * 本地状态中的待清理信息：本次执行了清理时按清理结果给出；没有执行清理（例如目录暂停写入）时只按清单中的待删除队列计数，
 * 标为未检查（不能据此说磁盘上还有内容）。没有任何待清理内容时为 null
 */
function cleanupState(report: GcReport | null, manifest: Manifest): CleanupState | null {
  if (!report) return manifest.purgeQueue.length ? { checked: false, pending: manifest.purgeQueue.length, unsaved: 0, problems: [] } : null;
  const { failed, unsaved, saveError } = report.drained;
  const problems = [...report.problems, ...failed.map((f) => `回收站条目 ${f.id} 未能从磁盘删除：${f.error}`)];
  if (saveError) problems.push(`${unsaved.length} 项已从磁盘删除，但待删除记录未能保存：${saveError}`);
  if (failed.length === 0 && unsaved.length === 0 && problems.length === 0) return null;
  return { checked: true, pending: failed.length, unsaved: unsaved.length, problems: boundNotes(problems) };
}

/** 本次操作登记的待删除条目的清理说明（其他条目的问题只在本地状态中显示，不重复写入每次操作的结果） */
function ownPurgeNotes(drained: DrainResult, ids: string[], what: string): string[] {
  const notes: string[] = [];
  const failed = drained.failed.filter((f) => ids.includes(f.id));
  if (failed.length) notes.push(`${what}未能从磁盘删除完（${failed[0].error}），已登记待清理，之后刷新或写入这个目录时会自动重试`);
  if (drained.saveError && drained.unsaved.some((id) => ids.includes(id))) {
    notes.push(`${what}已从磁盘删除，但清理状态尚未保存（${drained.saveError}），刷新后会重新确认`);
  }
  return notes;
}

export { SimulatedCrash };
export type { RecoveryEntry };
