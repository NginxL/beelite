// 插件管理：安装 / 更新 / 重装、卸载、恢复、启动恢复。所有写操作按目录串行，并通过 journal 事务保护。
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DirState, LocalFolder, LocalState, ManagedProjectView, OpResult, ProfileInfo, RecoveryEntryView, TaskPhase, TocInfo, UpdateCheckItem } from '../shared/types';
import { SimulatedCrash, UserError, errorMessage, isTransientError } from './errors';
import { getFlavor } from './flavors';
import { inspectLayout, newTxId, pathExists, readFileNoFollow, syncDir, writableLayout, writeFileAtomic, type Layout } from './layout';
import { downloadToFile, type DownloadOptions, type DownloadResult } from './net';
import { foldKey, isValidModuleName, resolveInside } from './paths';
import type { LatestFile } from './provider';
import { emptyManifest, ID_RE, parseJournal, readManifest, type Journal, type Manifest, type ProjectRecord, type RecoveryEntry } from './store';
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

/** 安装结果；installed 是本次提交到清单的记录，没有提交（已是最新、用户取消）时缺省 */
export type InstallResult = OpResult & { installed?: ProjectRecord };

export interface InstallOptions {
  force?: boolean;
  signal?: AbortSignal;
  onPhase?: (phase: TaskPhase, received?: number, total?: number) => void;
}

const BLOCKED_PREFIX = '该游戏目录有一个未完成且无法自动判定的操作，已暂停写入以保护插件。';

/** 删除空目录；非空或不存在时保持原样 */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined);
}

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
   * 任何无法判定的情况都返回 blocked，并保留 journal、暂存与回收内容。
   */
  private async recoverLocked(l: Layout): Promise<DirState> {
    let journalText: string | null;
    try {
      journalText = await readFileNoFollow(l.journalPath);
    } catch (err) {
      return { status: 'blocked', message: `${BLOCKED_PREFIX}${errorMessage(err)}` };
    }
    if (journalText !== null) {
      let journal: Journal;
      try {
        journal = parseJournal(journalText);
      } catch (err) {
        return { status: 'blocked', message: `${BLOCKED_PREFIX}${errorMessage(err)}\n事务日志：${l.journalPath}` };
      }
      let committed = false;
      if (journal.state === 'committing') {
        try {
          committed = (await readManifest(l)).manifest.lastTxId === journal.txId;
        } catch (err) {
          return { status: 'blocked', message: `${BLOCKED_PREFIX}${errorMessage(err)}` };
        }
      }
      if (!committed) {
        const rb = await rollbackOps(l, journal.ops);
        if (!rb.ok) {
          return { status: 'blocked', message: `${BLOCKED_PREFIX}${rb.reason}\n事务日志：${l.journalPath}\n备份与暂存：${l.metaDir}` };
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
      return { status: 'blocked', message: errorMessage(err) };
    }
    await this.gc(l, manifest);
    return { status: 'ok', message: null };
  }

  /**
   * 保守清理（调用前已确认没有未完成事务、staging/trash 为真实目录）：
   * - staging 只存放下载解压的新内容，整体清空；
   * - trash 中只递归删除 manifest.purgeQueue 明确登记的目录；其他未登记目录仅在为空时删除，非空一律保留。
   */
  private async gc(l: Layout, manifest: Manifest): Promise<void> {
    for (const name of await readdir(l.stagingDir).catch(() => [] as string[])) {
      await rm(resolveInside(l.stagingDir, name), { recursive: true, force: true });
    }
    const referenced = new Set(manifest.recovery.map((e) => e.id));
    const queued = new Set(manifest.purgeQueue);
    for (const name of await readdir(l.trashDir).catch(() => [] as string[])) {
      if (!referenced.has(name) && !queued.has(name)) await removeIfEmpty(resolveInside(l.trashDir, name));
    }
    await this.drainPurgeQueue(l, manifest);
  }

  private async drainPurgeQueue(l: Layout, manifest: Manifest): Promise<void> {
    if (manifest.purgeQueue.length === 0) return;
    for (const id of manifest.purgeQueue) {
      if (ID_RE.test(id)) await rm(resolveInside(l.trashDir, id), { recursive: true, force: true });
    }
    await writeFileAtomic(l.manifestPath, JSON.stringify({ ...manifest, purgeQueue: [] }, null, 1));
  }

  /** 恢复残留事务；目录还没有蜂简数据时直接返回 ok，不创建任何东西 */
  async recover(root: string): Promise<DirState> {
    const info = await inspectLayout(root, false);
    if (!info.hasInterface || !(await pathExists(info.l.metaDir))) return { status: 'ok', message: null };
    if (!info.hasMeta) {
      // 数据目录不完整：不做任何写入，只报告状态
      if (await pathExists(info.l.journalPath)) return { status: 'blocked', message: `${BLOCKED_PREFIX}蜂简数据目录不完整。` };
      return { status: 'ok', message: null };
    }
    return this.withLock(info.l.interfaceDir, async () => {
      const again = await inspectLayout(root, false);
      return this.recoverLocked(again.l);
    });
  }

  /** 写操作入口：补齐并检查布局、恢复残留事务、读取 manifest */
  private async openForWrite(root: string): Promise<{ l: Layout; manifest: Manifest }> {
    const l = await writableLayout(root);
    const state = await this.recoverLocked(l);
    if (state.status !== 'ok') throw new UserError(state.message ?? BLOCKED_PREFIX, 'blocked');
    return { l, manifest: (await readManifest(l)).manifest };
  }

  /** 只读汇总本地状态：扫描 AddOns 不依赖蜂简数据是否存在；没有 manifest 时全部视为未托管 */
  async localState(profile: ProfileInfo & { root: string }, flavorId: number): Promise<LocalState> {
    const suffixes = getFlavor(flavorId)?.tocSuffixes ?? [];
    const empty: LocalState = { flavorId, profile, dir: null, managed: [], unmanaged: [], recovery: [], error: null };
    let dir: DirState;
    let info;
    try {
      dir = await this.recover(profile.root);
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
    return { flavorId, profile, dir, managed, unmanaged, recovery, error: null };
  }

  // ---------- 提交 ----------

  /**
   * 记录目录身份、写 journal、执行 rename，最后原子提交 manifest。
   * 未提交前失败会按身份逆序回滚；回滚无法判定时保留 journal 与原件并抛出 blocked。
   */
  private async commit(l: Layout, txId: string, kind: string, planned: PlannedOp[], trashIds: string[], next: Manifest, afterCommit: () => Promise<void>): Promise<void> {
    next.lastTxId = txId;
    const ops = await prepareOps(l, planned);
    const journal: Journal = { schema: 1, txId, kind, state: 'prepared', trashIds, ops, createdAt: Date.now() };
    await writeFileAtomic(l.journalPath, JSON.stringify(journal));
    let committed = false;
    try {
      await this.hook('journal-written');
      await executeOps(l, ops, this.opts.hook);
      await writeFileAtomic(l.manifestTmpPath, JSON.stringify(next, null, 1), `${l.manifestTmpPath}.part`);
      await this.hook('manifest-tmp-written');
      await writeFileAtomic(l.journalPath, JSON.stringify({ ...journal, state: 'committing' }));
      await this.hook('committing');
      await rename(l.manifestTmpPath, l.manifestPath);
      await syncDir(l.metaDir);
      committed = true;
      await this.hook('manifest-committed');
      await unlink(l.journalPath);
    } catch (err) {
      if (isCrash(err)) throw err;
      // manifest 已提交即事务成功；残留 journal 会在下次恢复时被识别为已提交并清理
      if (committed) return;
      const rb = await rollbackOps(l, ops);
      if (!rb.ok) throw new UserError(`${BLOCKED_PREFIX}${rb.reason}\n原因：${errorMessage(err)}`, 'blocked');
      await unlink(l.manifestTmpPath).catch(() => undefined);
      await unlink(l.journalPath);
      throw err;
    }
    await afterCommit().catch(() => undefined);
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
    if (!detail.accessible) throw new UserError('该插件不是免费公开内容，蜂简不提供安装');
    const latest = await this.opts.source.latest(modId, flavorId, o.signal);
    if (!latest.compatible) {
      throw new UserError(`该文件声明的游戏版本（${latest.gameVersions.join('、') || '未知'}）与当前游戏版本不匹配，已停止安装`);
    }

    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const existing = manifest.projects[modId];
      if (existing && existing.flavorId !== flavorId) {
        throw new UserError(
          `「${existing.name}」已以「${getFlavor(existing.flavorId)?.name ?? existing.flavorId}」版本安装在这个目录，与当前游戏版本不同，蜂简不会用当前版本的文件更新或重装它。如需改用当前版本，请先卸载再安装。`,
          'flavor-mismatch',
        );
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
          if (takeover.length) lines.push(`以下目录已存在但不由蜂简管理，继续将把它们移入回收站（可恢复）并由本插件接管：\n${takeover.join('、')}`);
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
        if (backup.length && existing) {
          // 同一插件只保留最近一份更新前备份；旧备份进入待删除队列，随 manifest 一起原子提交
          const superseded = next.recovery.filter((e) => e.kind === 'update-backup' && e.project?.modId === modId).map((e) => e.id);
          next.recovery = next.recovery.filter((e) => !superseded.includes(e.id));
          next.purgeQueue.push(...superseded);
          // 备份记录只登记实际移入备份的目录
          next.recovery.push({ id: backupId, kind: 'update-backup', createdAt: now, label: `${existing.name} ${existing.version}（更新前备份）`, folders: backup, project: { ...existing, folders: backup } });
        }
        if (takeover.length) {
          next.recovery.push({ id: takeoverId, kind: 'takeover', createdAt: now, label: `安装「${detail.name}」时接管的目录`, folders: takeover, project: null });
        }
        next.projects[modId] = { modId, flavorId, fileId: latest.fileId, version: latest.displayName, name: detail.name, logo: detail.logo, folders: zip.modules, installedAt: now };

        await this.commit(l, txId, existing ? 'update' : 'install', planned, trashIds, next, async () => {
          await rm(stageRoot, { recursive: true, force: true });
          await this.drainPurgeQueue(l, next);
        });
        phase('done');
        const retired = existing ? oldFolders.filter((f) => !actual.has(foldKey(f))) : [];
        const warnings = [...zip.warnings];
        if (retired.length) warnings.push(`新版本不再包含 ${retired.join('、')}，已随旧版本一起移入备份`);
        return {
          ok: true,
          message: !existing
            ? `「${detail.name}」${latest.displayName} 安装完成`
            : existing.fileId === latest.fileId
              ? `「${detail.name}」${latest.displayName} 已重新安装`
              : `「${detail.name}」已更新到 ${latest.displayName}`,
          warnings,
          installed: { ...next.projects[modId], folders: [...zip.modules] },
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

  async uninstallProject(root: string, modId: string): Promise<OpResult> {
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const project = manifest.projects[modId];
      if (!project) throw new UserError('该插件不在蜂简管理列表中');
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
      await this.commit(l, txId, 'uninstall', planned, present.length ? [txId] : [], next, async () => undefined);
      const note = missing.length ? `（${missing.join('、')} 已不在 AddOns 中，不会被恢复）` : '';
      return { ok: true, message: present.length ? `已卸载「${project.name}」，可在回收站恢复${note}` : `已移除「${project.name}」的记录（目录已不存在）` };
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
      try {
        await this.commit(l, txId, 'uninstall-folder', [{ from: `AddOns/${folder}`, to: `.beelite/trash/${txId}/${folder}` }], [txId], next, async () => undefined);
      } catch (err) {
        if (!isCrash(err) && !(await pathExists(l.journalPath))) await removeIfEmpty(path.join(l.trashDir, txId));
        throw err;
      }
      return { ok: true, message: `已将 ${folder} 移入回收站` };
    });
  }

  async restore(root: string, entryId: string): Promise<OpResult> {
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
      await this.commit(l, txId, 'restore', planned, [entry.id], next, async () => {
        await removeIfEmpty(resolveInside(l.trashDir, entry.id));
      });
      return { ok: true, message: `已恢复：${entry.label}` };
    });
  }

  async purge(root: string, entryId: string): Promise<OpResult> {
    return this.withLock(await this.lockKey(root), async () => {
      const { l, manifest } = await this.openForWrite(root);
      const entry = manifest.recovery.find((e) => e.id === entryId);
      if (!entry) throw new UserError('回收站中没有这一项');
      const next: Manifest = structuredClone(manifest);
      next.recovery = next.recovery.filter((e) => e.id !== entryId);
      next.purgeQueue.push(entryId);
      await this.commit(l, newTxId(), 'purge', [], [], next, async () => {
        await this.drainPurgeQueue(l, next);
      });
      return { ok: true, message: `已永久删除：${entry.label}` };
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
    const info = await inspectLayout(root, false);
    if (!info.hasMeta) {
      signal?.throwIfAborted();
      return { items: [], fingerprint: manifestFingerprint(emptyManifest()) };
    }
    const { manifest } = await readManifest(info.l);
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

  /** 当前清单（只读），与 checkUpdatesDetailed 的判定一致：蜂简数据目录不完整时视为空清单 */
  async readCheckedManifest(root: string): Promise<{ manifest: Manifest; fingerprint: string }> {
    const info = await inspectLayout(root, false);
    const manifest = info.hasMeta ? (await readManifest(info.l)).manifest : emptyManifest();
    return { manifest, fingerprint: manifestFingerprint(manifest) };
  }

  /** 读取 manifest（只读） */
  async readManifestFor(root: string): Promise<Manifest> {
    const info = await inspectLayout(root, false);
    if (!(await pathExists(info.l.metaDir))) return emptyManifest();
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

export { SimulatedCrash };
export type { RecoveryEntry };
