// WTF 恢复的磁盘工具：只使用 mkdtemp 生成的临时目录，不读取真实玩家数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { chainIds, idOf, PartialTracker, type ManifestEntry, type WalkOptions } from '../src/core/wtf-backup';
import {
  assertTargetLock, copyVerifiedFile, createTargetLock, probePid, readTargetLock, releaseTargetLock, removeVerifiedTree, strictIo, verifyTree, writeDurable, type VerifiedTree,
} from '../src/core/wtf-restore-io';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const OPTS: WalkOptions = { maxEntries: 100, maxDepth: 10, rejectHardlinks: true, label: '测试' };
const eio = () => Object.assign(new Error('injected sync failure'), { code: 'EIO' });

const FILES: Record<string, string> = { 'top.txt': 'top', 'sub/file': 'original', 'sub/deep/inner.txt': 'inner' };
const ENTRIES: ManifestEntry[] = [
  { path: 'sub', type: 'dir' },
  { path: 'sub/deep', type: 'dir' },
  ...Object.entries(FILES).map(([p, c]): ManifestEntry => ({ path: p, type: 'file', size: Buffer.byteLength(c), sha256: sha(c) })),
];

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-restore-io-')));
  const base = path.join(root, 'tx', 'candidate');
  for (const [p, c] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(base, p)), { recursive: true });
    await writeFile(path.join(base, p), c);
  }
  const parentChain = await chainIds(path.dirname(base));
  const verify = (mode: 'exact' | 'subset' = 'exact') => verifyTree(base, ENTRIES, OPTS, mode, '候选树', { parentChain });
  return { root, base, parentChain, verify, done: () => rm(root, { recursive: true, force: true }) };
}

async function withSyncDir(fn: (dir: string) => Promise<void>, body: () => Promise<void>): Promise<void> {
  const save = strictIo.syncDir;
  strictIo.syncDir = fn;
  try {
    await body();
  } finally {
    strictIo.syncDir = save;
  }
}

test('verifyTree：exact 核对集合与内容，返回可删除的核对结果；多出、缺少、内容不同都拒绝', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    assert.equal(t.walk.length, ENTRIES.length);
    assert.equal(t.baseId, idOf(await lstat(f.base, { bigint: true })));
    await writeFile(path.join(f.base, 'extra.txt'), 'x');
    await assert.rejects(f.verify(), isCode('restore-changed'));
    await unlink(path.join(f.base, 'extra.txt'));
    await unlink(path.join(f.base, 'top.txt'));
    await assert.rejects(f.verify(), isCode('restore-changed'));
    const sub = await f.verify('subset');
    assert.equal(sub.walk.length, ENTRIES.length - 1);
    await writeFile(path.join(f.base, 'sub/file'), 'ORIGINAL');
    await assert.rejects(f.verify('subset'), isCode('restore-changed'));
  } finally {
    await f.done();
  }
});

test('verifyTree：上级目录链或 base 身份与调用方固定的不一致时拒绝', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    await assert.rejects(verifyTree(f.base, ENTRIES, OPTS, 'exact', '候选树', { parentChain: f.parentChain, baseId: '1:1' }), isCode('restore-changed'));
    await rename(path.join(f.root, 'tx'), path.join(f.root, 'tx2'));
    await mkdir(path.join(f.root, 'tx'));
    await rename(path.join(f.root, 'tx2', 'candidate'), f.base);
    // base 本身身份未变，但上级目录已被替换
    assert.equal(idOf(await lstat(f.base, { bigint: true })), t.baseId);
    await assert.rejects(f.verify(), isCode('restore-changed'));
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：完整删除核对过的树，并同步上级目录', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    const synced: string[] = [];
    await withSyncDir(async (d) => void synced.push(d), async () => {
      const r = await removeVerifiedTree(t);
      assert.deepEqual(r, { removed: true, deleted: ENTRIES.length + 1, kept: null, unsynced: null });
    });
    assert.deepEqual(synced, [path.dirname(f.base)]);
    assert.deepEqual(await readdir(path.dirname(f.base)), []);
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：base 被换成指向移走原件的符号链接时不删除任何东西', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    const moved = path.join(f.root, 'moved');
    await rename(f.base, moved);
    await symlink(moved, f.base, 'dir');
    const r = await removeVerifiedTree(t);
    assert.equal(r.removed, false);
    assert.equal(r.deleted, 0);
    assert.ok(r.kept);
    for (const [p, c] of Object.entries(FILES)) assert.equal(await readFile(path.join(moved, p), 'utf8'), c);
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：途经目录被换成符号链接、上级目录被替换时不沿链接删除', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    const moved = path.join(f.root, 'moved-sub');
    await rename(path.join(f.base, 'sub'), moved);
    await symlink(moved, path.join(f.base, 'sub'), 'dir');
    const r = await removeVerifiedTree(t);
    assert.equal(r.removed, false);
    assert.ok(r.kept);
    assert.equal(await readFile(path.join(moved, 'file'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(moved, 'deep/inner.txt'), 'utf8'), 'inner');
  } finally {
    await f.done();
  }
  const g = await fixture();
  try {
    const t = await g.verify();
    // 整个上级目录被移走并在原位置放入链接：上级链不一致，什么都不删除
    const away = path.join(g.root, 'tx-away');
    await rename(path.join(g.root, 'tx'), away);
    await symlink(away, path.join(g.root, 'tx'), 'dir');
    const r = await removeVerifiedTree(t);
    assert.equal(r.deleted, 0);
    assert.equal(await readFile(path.join(away, 'candidate/sub/file'), 'utf8'), 'original');
  } finally {
    await g.done();
  }
});

test('removeVerifiedTree：核对后被原地改写（同一 inode、同样大小）的文件保留，其余已核对内容照常删除', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    const file = path.join(f.base, 'sub/file');
    const before = idOf(await lstat(file, { bigint: true }));
    await writeFile(file, 'MODIFIED');
    assert.equal(idOf(await lstat(file, { bigint: true })), before);
    const r = await removeVerifiedTree(t);
    assert.equal(r.removed, false);
    assert.ok(r.kept);
    assert.equal(await readFile(file, 'utf8'), 'MODIFIED');
    await assert.rejects(stat(path.join(f.base, 'top.txt')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(f.base, 'sub/deep')), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：核对后放入的外来文件、多出的硬链接都不删除', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    await writeFile(path.join(f.base, 'sub/deep/foreign.txt'), 'foreign');
    await link(path.join(f.base, 'top.txt'), path.join(f.root, 'top-link'));
    const r = await removeVerifiedTree(t);
    assert.equal(r.removed, false);
    assert.equal(await readFile(path.join(f.base, 'sub/deep/foreign.txt'), 'utf8'), 'foreign');
    assert.equal(await readFile(path.join(f.base, 'top.txt'), 'utf8'), 'top');
    await assert.rejects(stat(path.join(f.base, 'sub/deep/inner.txt')), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('中断后继续：部分已删除的树重新核对（subset）后可以删完；自己删除子项改变目录时间不影响', async () => {
  const f = await fixture();
  try {
    await f.verify();
    // 模拟上次删除到一半：删掉一个文件与一个空目录
    await unlink(path.join(f.base, 'sub/deep/inner.txt'));
    await rmdir(path.join(f.base, 'sub/deep'));
    await assert.rejects(f.verify('exact'), isCode('restore-changed'));
    const t = await f.verify('subset');
    const r = await removeVerifiedTree(t);
    assert.equal(r.removed, true);
    assert.equal(r.kept, null);
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：删除后目录同步失败时如实报告已删除但未确认写入磁盘', async () => {
  const f = await fixture();
  try {
    const t = await f.verify();
    let r: Awaited<ReturnType<typeof removeVerifiedTree>> | null = null;
    await withSyncDir(async () => {
      throw eio();
    }, async () => {
      r = await removeVerifiedTree(t);
    });
    const res = r as unknown as Awaited<ReturnType<typeof removeVerifiedTree>>;
    assert.equal(res.removed, true);
    assert.equal(res.kept, null);
    assert.match(res.unsynced ?? '', /已删除.*未能确认写入磁盘.*EIO/);
    await assert.rejects(stat(f.base), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('removeVerifiedTree：部分保留且同步失败时两者分别报告', async () => {
  const f = await fixture();
  try {
    const t: VerifiedTree = await f.verify();
    await writeFile(path.join(f.base, 'sub/foreign'), 'x');
    let res: Awaited<ReturnType<typeof removeVerifiedTree>> | null = null;
    await withSyncDir(async () => {
      throw eio();
    }, async () => {
      res = await removeVerifiedTree(t);
    });
    const r = res as unknown as Awaited<ReturnType<typeof removeVerifiedTree>>;
    assert.equal(r.removed, false);
    assert.ok(r.kept);
    assert.ok(r.deleted > 0);
    assert.ok(r.unsynced);
  } finally {
    await f.done();
  }
});

test('目标占用标记：排他创建、读取、只释放自己的；同步失败如实报告', async () => {
  const f = await fixture();
  try {
    const p = path.join(f.root, 'RESTORE.lock');
    const l = await createTargetLock(p, 'a'.repeat(16), 'b'.repeat(32));
    assert.equal((await stat(p)).mode & 0o777, 0o600);
    await assert.rejects(createTargetLock(p, 'c'.repeat(16), 'd'.repeat(32)), isCode('restore-lock-busy'));
    const read = await readTargetLock(p);
    assert.equal(read?.info?.owner, l.owner);
    assert.equal(read?.info?.pid, process.pid);
    // 持有者令牌不同（他人重建的同名标记）：保留
    const other = { ...l, owner: 'e'.repeat(32) };
    assert.equal((await releaseTargetLock(other)).status, 'kept');
    assert.ok(await readTargetLock(p));
    // 删除后目录同步失败：标记已删除，但如实报告未确认
    let r: Awaited<ReturnType<typeof releaseTargetLock>> | null = null;
    await withSyncDir(async () => {
      throw eio();
    }, async () => {
      r = await releaseTargetLock(l);
    });
    assert.equal((r as unknown as Awaited<ReturnType<typeof releaseTargetLock>>).status, 'unsynced');
    assert.equal(await readTargetLock(p), null);
    const l2 = await createTargetLock(p, 'a'.repeat(16), 'b'.repeat(32));
    assert.deepEqual(await releaseTargetLock(l2), { status: 'released', note: null });
    // 内容无法识别的标记：info 为 null
    await writeFile(p, 'not json');
    assert.equal((await readTargetLock(p))?.info, null);
  } finally {
    await f.done();
  }
});

test('目标占用标记：原位改写任一字段（身份与持有者令牌不变）都不再被认作自己的标记，不会被删除', async () => {
  const f = await fixture();
  try {
    const p = path.join(f.root, 'RESTORE.lock');
    const mutations: Record<string, unknown> = { txid: 'f'.repeat(16), nonce: 'f'.repeat(32), pid: process.pid + 1, createdAt: 1 };
    for (const [field, value] of Object.entries(mutations)) {
      const l = await createTargetLock(p, 'a'.repeat(16), 'b'.repeat(32));
      const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
      raw[field] = value;
      await writeFile(p, JSON.stringify(raw));
      assert.equal(idOf(await lstat(p, { bigint: true })), l.id, `${field}：同一 inode`);
      await assert.rejects(assertTargetLock(l), isCode('restore-lock'), field);
      assert.equal((await releaseTargetLock(l)).status, 'kept', field);
      assert.ok(await readTargetLock(p), `${field}：标记保留`);
      await unlink(p);
    }
    // 多出字段或元数据不合法：无法识别
    for (const bad of [{ extra: 1 }, { pid: 0 }, { pid: -5 }, { createdAt: -1 }, { createdAt: 1.5 }]) {
      const l = await createTargetLock(p, 'a'.repeat(16), 'b'.repeat(32));
      const raw = { ...(JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>), ...bad };
      await writeFile(p, JSON.stringify(raw));
      assert.equal((await readTargetLock(p))?.info, null, JSON.stringify(bad));
      assert.equal((await releaseTargetLock(l)).status, 'kept');
      await unlink(p);
    }
  } finally {
    await f.done();
  }
});

test('目标占用标记：所在目录被移走并换成指向它的链接时，复核失败且不经由链接删除', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, 'control');
    await mkdir(dir);
    const l = await createTargetLock(path.join(dir, 'RESTORE.lock'), 'a'.repeat(16), 'b'.repeat(32));
    const moved = path.join(f.root, 'control-moved');
    await rename(dir, moved);
    await symlink(moved, dir, 'dir');
    await assert.rejects(assertTargetLock(l), isCode('restore-lock'));
    assert.equal((await releaseTargetLock(l)).status, 'kept');
    assert.ok(await readTargetLock(path.join(moved, 'RESTORE.lock')));
  } finally {
    await f.done();
  }
});

test('目标占用标记：创建时目录同步失败则不留下标记并报错', async () => {
  const f = await fixture();
  try {
    const p = path.join(f.root, 'RESTORE.lock');
    await withSyncDir(async () => {
      throw eio();
    }, async () => {
      await assert.rejects(createTargetLock(p, 'a'.repeat(16), 'b'.repeat(32)), isCode('restore-fsync'));
    });
    assert.equal(await readTargetLock(p), null);
  } finally {
    await f.done();
  }
});

test('writeDurable：写入 0600 并同步；同步失败报错且不留临时文件', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'journal.json');
    await writeDurable(file, Buffer.from('{"a":1}'), '测试日志');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const save = strictIo.syncFile;
    strictIo.syncFile = async () => {
      throw eio();
    };
    try {
      await assert.rejects(writeDurable(file, Buffer.from('{"a":2}'), '测试日志'), isCode('restore-fsync'));
    } finally {
      strictIo.syncFile = save;
    }
    assert.equal(await readFile(file, 'utf8'), '{"a":1}');
    assert.deepEqual((await readdir(f.root)).filter((n) => n.endsWith('.tmp')), []);
    await withSyncDir(async () => {
      throw eio();
    }, async () => {
      // 目录同步失败：内容已替换到位但未确认，错误码与“没有写入”区分
      await assert.rejects(writeDurable(file, Buffer.from('{"a":3}'), '测试日志'), isCode('restore-fsync-unconfirmed'));
    });
    assert.equal(await readFile(file, 'utf8'), '{"a":3}');
  } finally {
    await f.done();
  }
});

/** 复制到候选树时在文件同步处注入失败；inject 可在失败之前改动目标（模拟外部写入或目录替换） */
async function copyFailure(inject: (ctx: { dest: string; candidate: string; moved: string }) => Promise<void>) {
  const f = await fixture();
  const container = path.join(f.root, 'tx2');
  await mkdir(container);
  const candidate = path.join(container, 'candidate');
  const moved = path.join(f.root, 'moved-candidate');
  const source = path.join(f.root, 'source');
  await writeFile(source, 'ORIGINAL-BYTES');
  const tracker = new PartialTracker(candidate, container, await chainIds(container));
  await tracker.mkdir('');
  const dest = path.join(candidate, 'file');
  const save = strictIo.syncFile;
  strictIo.syncFile = async () => {
    await inject({ dest, candidate, moved });
    throw eio();
  };
  let error: unknown = null;
  try {
    await copyVerifiedFile(source, 'source', await lstat(source, { bigint: true }), 14, sha('ORIGINAL-BYTES'), tracker, 'file', undefined);
  } catch (err) {
    error = err;
  } finally {
    strictIo.syncFile = save;
  }
  assert.ok(error instanceof UserError);
  return { f, dest, moved, error: error as UserError };
}

test('copyVerifiedFile 失败：本次创建、内容是来源前缀的未写完文件被删除', async () => {
  const c = await copyFailure(async () => undefined);
  try {
    await assert.rejects(stat(c.dest), { code: 'ENOENT' });
  } finally {
    await c.f.done();
  }
});

test('copyVerifiedFile 失败：目标在失败前被原地改写（同 inode）时保留外部内容', async () => {
  const c = await copyFailure(async ({ dest }) => {
    const before = idOf(await lstat(dest, { bigint: true }));
    await writeFile(dest, 'EXTERNAL-DATA');
    assert.equal(idOf(await lstat(dest, { bigint: true })), before);
  });
  try {
    assert.equal(await readFile(c.dest, 'utf8'), 'EXTERNAL-DATA');
    assert.match(c.error.message, /已保留/);
  } finally {
    await c.f.done();
  }
});

test('copyVerifiedFile 失败：候选目录被移走并换成指向它的链接时不经由链接删除', async () => {
  const c = await copyFailure(async ({ candidate, moved }) => {
    await rename(candidate, moved);
    await symlink(moved, candidate, 'dir');
  });
  try {
    assert.equal(await readFile(path.join(c.moved, 'file'), 'utf8'), 'ORIGINAL-BYTES');
    assert.match(c.error.message, /已保留/);
  } finally {
    await c.f.done();
  }
});

test('probePid：只有正整数 pid 且进程不存在才算已退出', () => {
  assert.equal(probePid(process.pid), 'alive');
  assert.equal(probePid(0), 'unknown');
  assert.equal(probePid(-1), 'unknown');
  assert.equal(probePid(1.5), 'unknown');
});
