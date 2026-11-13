// 本地 WTF 恢复的磁盘工具：严格同步、持久写入、整树核对、按清单复制、只删除已核对的内容、目标占用标记。
// - 严格同步：与 layout.syncDir 不同，目录 / 文件 fsync 的任何失败都向上报告（restore-fsync 或结果中的 unsynced）。
//   fsync 只代表系统接受了写入请求，不等于断电安全（macOS 上没有使用 F_FULLFSYNC）。
// - 整树核对基于 wtf-backup 的有界严格遍历（拒绝链接、特殊文件、多硬链接、跨卷、名称冲突）与按身份读取的校验值，
//   函数内部完成闭环：开始与结束都复核上级目录链与根目录身份，结束时重新遍历确认集合与每项身份 / 大小 / 时间未变。
// - 删除只能针对 verifyTree 返回的核对结果：每一步删除前复核上级目录链、根目录与途经的每一级目录身份（不跟随链接）；
//   文件还要复核单一硬链接、大小 / 修改时间 / 状态改变时间，并重新计算校验值；目录只在为空时删除（rmdir），不认识的内容永远不删除。
//   自己删除子项会改变目录的时间，因此目录只比较身份与类型；中断后重新核对（subset）即可继续删除，不会因此卡住。
// - 路径检查基于 Node 路径 API 与 dev:ino 复核，无法完全防御同权限恶意进程在检查与操作之间的竞态替换。
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { errorMessage, UserError } from './errors';
import { io, writeAll } from './fsio';
import {
  chainIds, CREATE_FLAGS, errCode, hashHandle, hashStoredFile, idOf, isCancelled, READ_FLAGS, readMeta, sameChain, sameStat, unlinkIfSame, walkDiff, walkTree,
  type ManifestEntry, type PartialTracker, type WalkEntry, type WalkOptions,
} from './wtf-backup';

/** 可替换的严格同步实现（测试用来注入失败）；默认目录同步打开目录本身（不跟随链接）后 fsync */
export const strictIo: { syncDir: (dir: string) => Promise<void>; syncFile: (fh: FileHandle) => Promise<void> } = {
  syncDir: async (dir) => {
    const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  syncFile: (fh) => io.sync(fh),
};

export function fsyncFailed(what: string, err: unknown): UserError {
  const c = errCode(err);
  return new UserError(`无法确认${what}已写入磁盘${c ? `（${c}）` : ''}，为避免中断后无法判断状态，已停止`, 'restore-fsync');
}

export async function syncDirStrict(dir: string, what: string): Promise<void> {
  try {
    await strictIo.syncDir(dir);
  } catch (err) {
    throw fsyncFailed(what, err);
  }
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 路径当前的身份；不存在返回 null（不跟随符号链接：链接得到的是链接自身的身份，不会与任何目录相同） */
export async function idOrNull(p: string): Promise<string | null> {
  try {
    return idOf(await lstat(p, { bigint: true }));
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

export interface DurableWriteOptions {
  /**
   * 临时文件已完整写入、fsync 并关闭之后、rename 之前调用（最后一个可以放弃的时机）：调用方在此复核自己的前提
   * （例如占用标记仍完整匹配、目标文件仍是开始时读到的身份与内容）；抛错则放弃本次写入，目标不变。
   */
  beforeRename?: () => Promise<void>;
}

/**
 * 持久写入小文件：同目录排他新建 0600 临时文件、完整写入并严格 fsync，复核（beforeRename 与所在目录的各级身份）后
 * rename 覆盖目标，再核对目标就是本次写入的文件与内容，最后严格同步目录。返回文件身份。
 * - rename 之前的任何失败：目标未改变；只在所在目录的各级身份仍与开始时一致时删除本次的临时文件（不经由被替换的目录删除）。
 * - rename 之后：目标被替换、内容不符或目录同步失败都抛出 restore-fsync-unconfirmed（已写入但未确认），调用方不能当作“没有写入”。
 * 路径检查无法消除同权限恶意进程在最后一次检查与 rename 之间的极短竞态，但能发现跨越每一次 await 的变化。
 */
export async function writeDurable(file: string, data: Uint8Array, what: string, o: DurableWriteOptions = {}): Promise<string> {
  const dir = path.dirname(file);
  const dirChain = await chainIds(dir);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, CREATE_FLAGS, 0o600);
  let id: string;
  try {
    id = idOf(await fh.stat({ bigint: true }));
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw new UserError(`新建的临时文件 ${tmp} 无法确认身份，已保留（${errorMessage(err)}）`, 'restore-unsafe');
  }
  const dirIntact = async () => {
    const now = await chainIds(dir).catch(() => null);
    return !!now && sameChain(now, dirChain);
  };
  const dropTmp = async () => {
    if (await dirIntact()) await unlinkIfSame(tmp, id);
  };
  try {
    await writeAll(fh, data);
    await strictIo.syncFile(fh);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await dropTmp();
    throw err instanceof UserError ? err : fsyncFailed(what, err);
  }
  await fh.close();
  try {
    if (o.beforeRename) await o.beforeRename();
    if (!(await dirIntact())) throw new UserError(`${what}所在的目录被移动或替换，未写入`, 'restore-changed');
    const tst = await lstat(tmp, { bigint: true });
    if (tst.isSymbolicLink() || !tst.isFile() || idOf(tst) !== id) throw new UserError(`${what}的临时文件被替换，未写入`, 'restore-changed');
  } catch (err) {
    await dropTmp();
    throw err;
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await dropTmp();
    throw err;
  }
  const unconfirmed = (detail: string) => new UserError(`${what}已写入，但${detail}`, 'restore-fsync-unconfirmed');
  // 写后核对：目标就是本次的文件、内容逐字节相同
  const after = await readMeta(file, data.byteLength, what).catch(() => null);
  if (!after || idOf(after.st) !== id || !after.data.equals(Buffer.from(data))) throw unconfirmed('写入后目标被替换或内容不符，结果无法确认');
  try {
    await strictIo.syncDir(dir);
  } catch (err) {
    // 新内容已经替换到位，但目录项是否写入磁盘未确认：与“没有写入”区分
    const c = errCode(err);
    throw unconfirmed(`未能确认写入磁盘${c ? `（${c}）` : ''}`);
  }
  return id;
}

/** 读取小型 JSON（不跟随链接、单一硬链接、有上限、读取期间不变）；不存在返回 null，内容不是 JSON 抛出 restore-corrupt */
export async function readJson(file: string, max: number, what: string): Promise<{ value: unknown; st: BigIntStats; sha: string } | null> {
  const meta = await readMeta(file, max, what);
  if (!meta) return null;
  try {
    return { value: JSON.parse(meta.data.toString('utf8')) as unknown, st: meta.st, sha: sha256(meta.data) };
  } catch {
    throw new UserError(`${what}（${file}）不是有效的 JSON`, 'restore-corrupt');
  }
}

/** 读取目录中的名字（有上限），不存在返回 null */
export async function listNames(dir: string, max: number): Promise<string[] | null> {
  let d;
  try {
    d = await opendir(dir);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
  const out: string[] = [];
  try {
    for (let e = await d.read(); e !== null; e = await d.read()) {
      if (out.length >= max) throw new UserError(`${dir} 中的条目过多，无法确认`, 'restore-unsafe');
      out.push(e.name);
    }
  } finally {
    await d.close().catch(() => undefined);
  }
  return out.sort();
}

function changed(what: string, detail: string): UserError {
  return new UserError(`${what}与预期不一致（${detail}）`, 'restore-changed');
}

function absOf(base: string, rel: string): string {
  return rel ? path.join(base, ...rel.split('/')) : base;
}

// ---------- 整树核对 ----------

/** verifyTree 的核对结果：只有它可以交给 removeVerifiedTree 删除 */
export interface VerifiedTree {
  readonly base: string;
  readonly baseId: string;
  /** base 上级目录的各级身份（由近及远，不含 base 自身），核对开始与结束时一致 */
  readonly parentChain: readonly string[];
  /** 核对时清单中的条目（按路径） */
  readonly entries: ReadonlyMap<string, ManifestEntry>;
  /** 核对时的遍历结果（父目录在前）；每个文件都已按此身份重算校验值 */
  readonly walk: readonly WalkEntry[];
}

export interface VerifyExpect {
  /** 调用方固定的 base 上级目录各级身份（chainIds(dirname(base)) 的结果）；必须一致 */
  parentChain: readonly string[];
  /** 调用方已知的 base 身份；给出时必须一致 */
  baseId?: string | null;
}

/**
 * 有界遍历 base，并与清单条目逐项核对：路径逐字节相等、类型与大小一致、每个文件按遍历时的身份重算校验值。
 * exact：集合必须完全相等；subset：只要求遍历到的每一项都在清单中（用于中断后继续删除时识别已部分删除的树）；
 * finder：允许清单外、单一硬链接的普通 .DS_Store（只用于读取备份目录）。
 * 闭环：开始与结束都复核上级目录链与 base 身份（不跟随链接），结束时重新遍历，集合与每项身份 / 大小 / 时间必须与首次一致。
 * 任何不一致抛出 restore-changed（取消照常向上传递）。
 */
export async function verifyTree(
  base: string, entries: readonly ManifestEntry[], o: WalkOptions, mode: 'exact' | 'subset' | 'finder', what: string, expect: VerifyExpect,
): Promise<VerifiedTree> {
  const pin = async (): Promise<string> => {
    const pc = await chainIds(path.dirname(base)).catch(() => null);
    if (!pc || !sameChain(pc, expect.parentChain)) throw changed(what, '上级目录被移动或替换');
    const st = await lstat(base, { bigint: true }).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw changed(what, '不是普通文件夹');
    if (expect.baseId && idOf(st) !== expect.baseId) throw changed(what, '文件夹被移动或替换');
    return idOf(st);
  };
  try {
    const baseId = await pin();
    const walk = await walkTree(base, o);
    const want = new Map(entries.map((e) => [e.path, e]));
    let matched = 0;
    for (const w of walk) {
      const e = want.get(w.rel);
      if (!e) {
        if (mode === 'finder' && w.kind === 'file' && w.st.nlink === 1n && path.posix.basename(w.rel) === '.DS_Store') continue;
        throw changed(what, `多出「${w.rel}」`);
      }
      if (e.type !== w.kind) throw changed(what, `「${w.rel}」的类型不同`);
      matched++;
      if (e.type !== 'file') continue;
      const size = e.size ?? -1;
      if (w.st.size !== BigInt(size)) throw changed(what, `「${w.rel}」的大小不同`);
      const hex = await hashStoredFile(absOf(base, w.rel), w.rel, size, w.st, o.signal);
      if (hex !== e.sha256) throw changed(what, `「${w.rel}」的内容不同`);
    }
    if (mode !== 'subset' && matched !== entries.length) throw changed(what, '缺少条目');
    const again = await walkTree(base, o);
    const moved = walkDiff(walk, again);
    if (moved) throw changed(what, `「${moved}」在核对期间被改动`);
    if ((await pin()) !== baseId) throw changed(what, '文件夹在核对期间被移动或替换');
    return { base, baseId, parentChain: [...expect.parentChain], entries: want, walk };
  } catch (err) {
    if (isCancelled(err) || (err instanceof UserError && err.code === 'restore-changed')) throw err;
    throw changed(what, errorMessage(err));
  }
}

// ---------- 删除已核对的树 ----------

export interface RemoveResult {
  /** base 本身已删除（整棵树都已删除） */
  removed: boolean;
  /** 本次实际删除的条目数（含 base） */
  deleted: number;
  /** 有内容保留时的原因（未删除的内容仍在原处）；null 表示没有保留 */
  kept: string | null;
  /** 已执行的删除未能确认写入磁盘的原因；null 表示已同步或没有删除 */
  unsynced: string | null;
}

/**
 * 删除 verifyTree 核对过的树。子项先于父目录；每一步删除前：
 * - 复核 base 上级目录链（不跟随链接）、base 与条目的每一级途经目录都仍是核对时的身份且不是链接；
 * - 文件：身份、单一硬链接、大小 / 修改时间 / 状态改变时间与核对时一致，并重新计算校验值与清单一致，之后再复核一次路径与身份；
 * - 目录：身份与类型一致，只用 rmdir 删除空目录（其中有不认识的内容时保留）。
 * 已不存在的条目视为已删除（中断后继续）。上级目录链或途经目录变化时立即停止，不再删除任何东西。
 * 删除过内容的目录最后严格同步；失败时在 unsynced 中说明“删除已执行但持久性未确认”。不抛错（取消除外）。
 */
export async function removeVerifiedTree(t: VerifiedTree, signal?: AbortSignal): Promise<RemoveResult> {
  const dirIds = new Map<string, string>(t.walk.filter((e) => e.kind === 'dir').map((e) => [e.rel, idOf(e.st)]));
  dirIds.set('', t.baseId);
  /** 删除过子项的目录（相对 base）与已删除的目录 */
  const touched = new Set<string>();
  const gone = new Set<string>();
  let deleted = 0;
  let kept: string | null = null;
  const keep = (why: string) => {
    if (!kept) kept = why;
  };

  /** 上级目录链、base 与 rel 的每一级途经目录（不含 rel 本身）仍是核对时的身份 */
  const pathIntact = async (rel: string): Promise<boolean> => {
    const pc = await chainIds(path.dirname(t.base)).catch(() => null);
    if (!pc || !sameChain(pc, t.parentChain)) return false;
    const segs = rel ? rel.split('/') : [];
    for (let i = 0; i < segs.length; i++) {
      const anc = segs.slice(0, i).join('/');
      const st = await lstat(absOf(t.base, anc), { bigint: true }).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || idOf(st) !== dirIds.get(anc)) return false;
    }
    return true;
  };
  const moved = `${t.base} 或其上级目录在删除期间被移动或替换，已停止删除，剩余内容保留在原处`;
  const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

  const finish = async (removedBase: boolean): Promise<RemoveResult> => {
    let unsynced: string | null = null;
    // base 已删除时只需同步它的上级目录；否则同步仍存在的、删除过子项的目录
    const dirs = removedBase ? [path.dirname(t.base)] : [...touched].filter((d) => !gone.has(d)).map((d) => absOf(t.base, d));
    if (deleted > 0) {
      for (const d of dirs) {
        try {
          await strictIo.syncDir(d);
        } catch (err) {
          unsynced = `已删除 ${deleted} 项，但删除结果未能确认写入磁盘（${errCode(err) ?? errorMessage(err)}），中断后可能需要重新清理`;
          break;
        }
      }
    }
    return { removed: removedBase, deleted, kept, unsynced };
  };

  try {
    for (const e of [...t.walk].reverse()) {
      if (signal?.aborted) {
        keep('删除已取消，剩余内容保留在原处');
        return finish(false);
      }
      if (!(await pathIntact(e.rel))) {
        keep(moved);
        return finish(false);
      }
      const abs = absOf(t.base, e.rel);
      const st = await lstat(abs, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : undefined));
      if (st === null) continue;
      if (st === undefined || st.isSymbolicLink() || idOf(st) !== idOf(e.st) || (e.kind === 'dir' ? !st.isDirectory() : !st.isFile())) {
        keep(`「${e.rel}」已被替换或无法读取，已保留`);
        continue;
      }
      if (e.kind === 'file') {
        const m = t.entries.get(e.rel);
        if (!m || m.type !== 'file' || st.nlink !== 1n || !sameStat(e.st, st)) {
          keep(`「${e.rel}」在核对之后被改动，已保留`);
          continue;
        }
        const hex = await hashStoredFile(abs, e.rel, m.size ?? -1, e.st, signal).catch(() => null);
        if (hex !== m.sha256) {
          keep(`「${e.rel}」在核对之后被改动，已保留`);
          continue;
        }
        if (!(await pathIntact(e.rel))) {
          keep(moved);
          return finish(false);
        }
        const again = await lstat(abs, { bigint: true }).catch(() => null);
        if (!again || again.isSymbolicLink() || again.nlink !== 1n || !sameStat(e.st, again)) {
          keep(`「${e.rel}」在核对之后被改动，已保留`);
          continue;
        }
        try {
          await unlink(abs);
        } catch (err) {
          if (errCode(err) !== 'ENOENT') keep(`「${e.rel}」无法删除（${errCode(err) ?? errorMessage(err)}），已保留`);
          continue;
        }
      } else {
        try {
          await rmdir(abs);
        } catch (err) {
          if (errCode(err) !== 'ENOENT') keep(`文件夹「${e.rel}」中有无法确认的内容或无法删除，已保留`);
          continue;
        }
        gone.add(e.rel);
      }
      deleted++;
      touched.add(parentOf(e.rel));
    }
    if (kept) return finish(false);
    if (!(await pathIntact(''))) {
      keep(moved);
      return finish(false);
    }
    const bst = await lstat(t.base, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : undefined));
    if (bst === null) return finish(true);
    if (bst === undefined || bst.isSymbolicLink() || !bst.isDirectory() || idOf(bst) !== t.baseId) {
      keep(moved);
      return finish(false);
    }
    try {
      await rmdir(t.base);
    } catch (err) {
      keep(`${t.base} 中有无法确认的内容或无法删除（${errCode(err) ?? errorMessage(err)}），已保留`);
      return finish(false);
    }
    deleted++;
    return finish(true);
  } catch (err) {
    if (isCancelled(err)) throw err;
    keep(`删除时出错（${errorMessage(err)}），剩余内容保留在原处`);
    return finish(false);
  }
}

// ---------- 复制 ----------

/**
 * 从来源目录复制一个清单文件到候选树：来源不跟随链接、单一硬链接、身份 / 大小 / 时间与固定的遍历一致；
 * 目标由 tracker 排他新建（0600）；边写边算校验值，必须与清单一致，写完严格 fsync，读完来源仍未变化。
 * 失败（含取消）时只在以下条件全部满足时删除未写完的目标文件，否则保留并在错误中说明：
 * - 本进程创建的证明：创建后立即固定的目标 inode 与所在目录的完整上级链，删除前目录链不变、路径仍是这个 inode 的单一硬链接普通文件；
 * - 内容：目标的字节恰为来源文件的前缀，且来源仍完整符合清单的身份与校验值（isPrefixCopy）；前缀核对前后目标状态不变；
 * 删除后严格同步所在目录（失败时在错误中说明删除未确认）。前缀只是内容条件，不单独作为所有权依据
 */
export async function copyVerifiedFile(
  srcAbs: string, rel: string, expect: BigIntStats, size: number, sha: string, tracker: PartialTracker, destRel: string, signal: AbortSignal | undefined, onBytes?: (n: number) => void,
): Promise<void> {
  const bad = (d: string) => changed(`来源「${rel}」`, d);
  let fh: FileHandle;
  try {
    fh = await open(srcAbs, READ_FLAGS);
  } catch (err) {
    throw bad(errCode(err) ?? errorMessage(err));
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.nlink !== 1n || !sameStat(expect, st) || st.size !== BigInt(size)) throw bad('身份或大小已变化');
    const out = await tracker.createFile(destRel);
    const dest = tracker.abs(destRel);
    // 创建证明：写入任何内容之前固定目标 inode 与所在目录的完整上级链
    const created = await out.stat({ bigint: true }).then(idOf, () => null);
    const destChain = await chainIds(path.dirname(dest)).catch(() => null);
    try {
      const r = await hashHandle(fh, size, () => bad('大小已变化'), signal, async (chunk) => {
        await writeAll(out, chunk);
        onBytes?.(chunk.byteLength);
      });
      try {
        await strictIo.syncFile(out);
      } catch (err) {
        throw fsyncFailed(`候选文件「${destRel}」`, err);
      }
      if (r.bytes !== size || r.hex !== sha) throw bad('内容与清单不一致');
      if (!sameStat(expect, await fh.stat({ bigint: true }))) throw bad('读取期间发生变化');
    } catch (err) {
      await out.close().catch(() => undefined);
      const note = await dropPartialCopy(dest, created, destChain, srcAbs, expect, size, sha);
      if (note) throw new UserError(`${errorMessage(err)}；${note}`, err instanceof UserError ? err.code : 'restore-changed');
      throw err;
    }
    await out.close();
  } finally {
    await fh.close();
  }
}

/**
 * 复制失败后删除本次未写完的目标文件（条件见 copyVerifiedFile）。返回 null 表示已删除并同步，或文件不存在；
 * 否则返回保留说明（无法证明属于本次、内容不是来源前缀、来源已变化、目录被移动或替换、删除未确认）
 */
async function dropPartialCopy(
  dest: string, created: string | null, destChain: string[] | null, srcAbs: string, expect: BigIntStats, size: number, sha: string,
): Promise<string | null> {
  const dir = path.dirname(dest);
  const kept = `未写完的候选文件无法确认只含本次写入的内容，已保留：${dest}`;
  const chainOk = async () => {
    const now = await chainIds(dir).catch(() => null);
    return !!destChain && !!now && sameChain(now, destChain);
  };
  if (!created || !(await chainOk())) return kept;
  const st = await lstat(dest, { bigint: true }).catch((err: unknown) => (errCode(err) === 'ENOENT' ? null : undefined));
  if (st === null) return null;
  if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1n || idOf(st) !== created) return kept;
  if (!(await isPrefixCopy(dest, st, srcAbs, expect, size, sha))) return kept;
  const again = await lstat(dest, { bigint: true }).catch(() => null);
  if (!again || again.isSymbolicLink() || again.nlink !== 1n || !sameStat(st, again) || !(await chainOk())) return kept;
  if (!(await unlinkIfSame(dest, created))) return kept;
  try {
    await strictIo.syncDir(dir);
  } catch (err) {
    return `未写完的候选文件已删除，但删除结果未能确认写入磁盘（${errCode(err) ?? errorMessage(err)}）：${dest}`;
  }
  return null;
}

/**
 * 纯内容比较：候选文件是否逐字节等于来源文件的开头（来源须完整符合清单的身份与校验值）。
 * 这不是所有权证明：同权限的外部进程可以放入内容相同的文件。调用方不得只凭它授权删除未知身份的文件，
 * 必须另有持久记录的创建身份等证据；无法确认时返回 false。
 */
export async function isPrefixCopy(candAbs: string, candSt: BigIntStats, srcAbs: string, expect: BigIntStats, size: number, sha: string): Promise<boolean> {
  if (candSt.size > BigInt(size)) return false;
  let src: FileHandle | null = null;
  let cand: FileHandle | null = null;
  try {
    src = await open(srcAbs, READ_FLAGS);
    cand = await open(candAbs, READ_FLAGS);
    const sst = await src.stat({ bigint: true });
    const cst = await cand.stat({ bigint: true });
    if (!sst.isFile() || sst.nlink !== 1n || !sameStat(expect, sst) || !cst.isFile() || cst.nlink !== 1n || !sameStat(candSt, cst)) return false;
    const n = Number(cst.size);
    const cbuf = Buffer.alloc(Math.max(1, Math.min(n, 1024 * 1024)));
    const c = cand;
    let off = 0;
    let same = true;
    const r = await hashHandle(src, size, () => new UserError('来源大小已变化', 'restore-changed'), undefined, async (chunk) => {
      if (same && off < n) {
        const take = Math.min(chunk.byteLength, n - off);
        let done = 0;
        while (done < take) {
          const want = Math.min(cbuf.length, take - done);
          const { bytesRead } = await c.read(cbuf, 0, want, off + done);
          if (bytesRead !== want || !cbuf.subarray(0, want).equals(chunk.subarray(done, done + want))) {
            same = false;
            break;
          }
          done += want;
        }
      }
      off += chunk.byteLength;
    });
    return same && r.bytes === size && r.hex === sha && sameStat(expect, await src.stat({ bigint: true })) && sameStat(candSt, await c.stat({ bigint: true }));
  } catch {
    return false;
  } finally {
    await src?.close().catch(() => undefined);
    await cand?.close().catch(() => undefined);
  }
}

// ---------- 目标占用标记 ----------

export const LOCK_FORMAT = 'azercube-wtf-restore';
const MAX_LOCK_BYTES = 4096;

export interface TargetLockInfo {
  txid: string;
  nonce: string;
  /** 每次取得时新生成；只有持有者知道，释放与复核时比对 */
  owner: string;
  pid: number;
  createdAt: number;
}

export interface HeldTargetLock extends TargetLockInfo {
  path: string;
  id: string;
  /** 创建时标记所在目录的各级身份（由近及远）；复核与释放时必须一致 */
  parentChain: readonly string[];
}

/** 排他新建目标占用标记（0600）并严格同步；已存在报 restore-lock；新建后无法确认身份时保留文件并报错 */
export async function createTargetLock(p: string, txid: string, nonce: string): Promise<HeldTargetLock> {
  const info: TargetLockInfo = { txid, nonce, owner: randomBytes(16).toString('hex'), pid: process.pid, createdAt: Date.now() };
  const parentChain = await chainIds(path.dirname(p));
  let fh: FileHandle;
  try {
    fh = await open(p, CREATE_FLAGS, 0o600);
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw new UserError(`占用标记已存在，可能另一项恢复正在进行或上次意外中断（${p}）`, 'restore-lock-busy');
    throw err;
  }
  let id: string;
  try {
    id = idOf(await fh.stat({ bigint: true }));
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw new UserError(`新建的恢复占用标记 ${p} 无法确认身份，已保留（${errorMessage(err)}）`, 'restore-lock');
  }
  try {
    await writeAll(fh, Buffer.from(JSON.stringify({ format: LOCK_FORMAT, kind: 'lock', ...info })));
    await strictIo.syncFile(fh);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlinkIfSame(p, id);
    throw err instanceof UserError ? err : fsyncFailed('恢复占用标记', err);
  }
  await fh.close();
  try {
    await syncDirStrict(path.dirname(p), '恢复占用标记');
  } catch (err) {
    // 标记的目录项未能确认写入：删除本次创建的标记后报错（删除本身同样未确认，调用方按失败处理）
    await unlinkIfSame(p, id);
    throw err;
  }
  const now = await chainIds(path.dirname(p)).catch(() => null);
  if (!now || !sameChain(now, parentChain)) {
    // 目录在创建期间被替换：不经由可能被替换的路径删除任何东西
    throw new UserError(`恢复占用标记所在的目录在创建期间被移动或替换，标记已保留：${p}`, 'restore-lock');
  }
  return { ...info, path: p, id, parentChain };
}

/** 读取占用标记：不存在为 null；内容无法识别时 info 为 null（保留，不当作任何人的标记） */
export async function readTargetLock(p: string): Promise<{ st: BigIntStats; info: TargetLockInfo | null } | null> {
  let r;
  try {
    r = await readJson(p, MAX_LOCK_BYTES, '恢复占用标记');
  } catch (err) {
    const st = await lstat(p, { bigint: true }).catch(() => null);
    if (!st) throw err;
    return { st, info: null };
  }
  if (!r) return null;
  const v = r.value as Record<string, unknown> | null;
  const hex = (x: unknown, n: number) => typeof x === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
  const keys = ['format', 'kind', 'txid', 'nonce', 'owner', 'pid', 'createdAt'];
  if (
    typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every((k) => k in v) ||
    v.format !== LOCK_FORMAT || v.kind !== 'lock' || !hex(v.txid, 16) || !hex(v.nonce, 32) || !hex(v.owner, 32) ||
    typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid <= 0 ||
    typeof v.createdAt !== 'number' || !Number.isSafeInteger(v.createdAt) || v.createdAt < 0
  ) {
    return { st: r.st, info: null };
  }
  return { st: r.st, info: { txid: v.txid as string, nonce: v.nonce as string, owner: v.owner as string, pid: v.pid, createdAt: v.createdAt } };
}

/** 标记内容的每个字段都与持有记录一致 */
export function sameLockInfo(a: TargetLockInfo | null | undefined, b: TargetLockInfo): boolean {
  return !!a && a.txid === b.txid && a.nonce === b.nonce && a.owner === b.owner && a.pid === b.pid && a.createdAt === b.createdAt;
}

/** 占用标记仍是本次取得的那一个：所在目录各级身份、标记身份与内容的每个字段都一致；否则抛出 restore-lock */
export async function assertTargetLock(l: HeldTargetLock): Promise<void> {
  const bad = () => new UserError(`恢复占用标记 ${l.path} 或其所在目录被改动，已停止`, 'restore-lock');
  const chain = await chainIds(path.dirname(l.path)).catch(() => null);
  if (!chain || !sameChain(chain, l.parentChain)) throw bad();
  const r = await readTargetLock(l.path).catch(() => null);
  if (!r || idOf(r.st) !== l.id || !sameLockInfo(r.info, l)) throw bad();
}

/**
 * released：已删除并确认写入磁盘；unsynced：已删除，但删除结果未能确认写入磁盘（中断后标记可能重新出现，
 * 由处理未完成恢复时按持有者规则识别）；kept：标记已被改动、无法确认或无法删除，原样保留
 */
export interface LockReleaseResult {
  status: 'released' | 'unsynced' | 'kept';
  note: string | null;
}

/** 仅当标记仍是本次取得的那一个时删除；否则保留。不抛错 */
export async function releaseTargetLock(l: HeldTargetLock): Promise<LockReleaseResult> {
  try {
    await assertTargetLock(l);
  } catch {
    return { status: 'kept', note: `恢复占用标记 ${l.path} 已被改动或无法确认，已保留，请在访达中检查` };
  }
  const chain = await chainIds(path.dirname(l.path)).catch(() => null);
  if (!chain || !sameChain(chain, l.parentChain)) return { status: 'kept', note: `恢复占用标记 ${l.path} 所在的目录被移动或替换，已保留，请在访达中检查` };
  if (!(await unlinkIfSame(l.path, l.id))) return { status: 'kept', note: `无法删除恢复占用标记 ${l.path}，已保留` };
  try {
    await strictIo.syncDir(path.dirname(l.path));
  } catch (err) {
    return { status: 'unsynced', note: `恢复占用标记 ${l.path} 已删除，但删除结果未能确认写入磁盘（${errCode(err) ?? errorMessage(err)}）` };
  }
  return { status: 'released', note: null };
}

export type PidState = 'gone' | 'alive' | 'unknown';

/** 进程是否已退出：只有 pid 为正整数且 kill(pid, 0) 报 ESRCH 才是 gone；存活、无权限或其他错误都不算退出 */
export function probePid(pid: number): PidState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const c = errCode(err);
    if (c === 'ESRCH') return 'gone';
    if (c === 'EPERM') return 'alive';
    return 'unknown';
  }
}
