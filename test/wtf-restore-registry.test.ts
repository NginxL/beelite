// WTF 恢复的全局登记与候选清单：只使用 mkdtemp 生成的临时目录，不读取真实应用数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { DEFAULT_BACKUP_LIMITS } from '../src/core/wtf-backup';
import { createTargetLock, strictIo, writeDurable, type PidState } from '../src/core/wtf-restore-io';
import {
  parseCandidate, REGISTRY_LOCK_TXID, RESTORE_FORMAT, RestoreRegistry, type RegistryHooks, type RestoreRegEntry,
} from '../src/core/wtf-restore-registry';

const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const DEAD = 999_999;
const probe = (pid: number): PidState => (pid === DEAD ? 'gone' : 'alive');
const FAST = { ms: 5, tries: 3 };

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-restore-reg-')));
  const file = path.join(root, 'wtf-restore-registry.json');
  const make = (hooks: RegistryHooks = {}) => new RestoreRegistry(file, probe, hooks, FAST);
  return { root, file, lockPath: `${file}.lock`, make, done: () => rm(root, { recursive: true, force: true }) };
}

function entry(root: string, letter: string): RestoreRegEntry {
  return {
    txid: letter.repeat(16), nonce: letter.repeat(32), flavorId: 9, root: path.join(root, `game-${letter}`), rootChain: ['1:1'], scope: { kind: 'all' },
    sourceSnapshotId: '20261113-010203-abcdef12', containerPath: path.join(root, 'backups'), safetySnapshotId: null, state: 'preparing', reason: null,
    controlId: null, txdirId: null, lock: null, candidate: null, outcome: null, createdAt: 1, updatedAt: 1,
  };
}

async function withSyncDir(fn: (dir: string, orig: (d: string) => Promise<void>) => Promise<void>, body: () => Promise<void>): Promise<void> {
  const save = strictIo.syncDir;
  strictIo.syncDir = (d) => fn(d, save);
  try {
    await body();
  } finally {
    strictIo.syncDir = save;
  }
}

/** 把标记文件的字段原位改写（同一 inode） */
async function patchLock(p: string, patch: Record<string, unknown>): Promise<void> {
  const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  await writeFile(p, JSON.stringify({ ...raw, ...patch }));
}

test('mutate：保存成功时 saved 为 true；没有改动时为 false，且不创建登记文件', async () => {
  const f = await fixture();
  try {
    const reg = f.make();
    const none = await reg.mutate(() => 'x');
    assert.deepEqual(none, { value: 'x', saved: false, warning: null });
    await assert.rejects(stat(f.file), { code: 'ENOENT' });
    const r = await reg.mutate((d) => d.add(entry(f.root, 'a')));
    assert.equal(r.saved, true);
    assert.equal(r.warning, null);
    assert.equal((await reg.load()).entries.length, 1);
    await assert.rejects(stat(f.lockPath), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('mutate：已保存但排他标记的删除未能确认写入磁盘时，返回 saved 与 warning，不静默成功', async () => {
  const f = await fixture();
  try {
    const reg = f.make();
    let n = 0;
    let r: Awaited<ReturnType<typeof reg.mutate>> | null = null;
    // 第 1 次：标记创建；第 2 次：登记写入；第 3 次：标记删除
    await withSyncDir(async (d, orig) => {
      n++;
      if (n === 3) throw Object.assign(new Error('injected'), { code: 'EIO' });
      await orig(d);
    }, async () => {
      r = await reg.mutate((d) => d.add(entry(f.root, 'a')));
    });
    const res = r as unknown as Awaited<ReturnType<typeof reg.mutate>>;
    assert.equal(res.saved, true);
    assert.match(res.warning ?? '', /未能正常释放.*未能确认写入磁盘/);
    assert.equal((await reg.load()).entries.length, 1);
  } finally {
    await f.done();
  }
});

test('mutate：已保存但排他标记被原位改动时，返回 saved 与 warning，被改动的标记保留', async () => {
  const f = await fixture();
  try {
    const reg = f.make();
    let n = 0;
    let r: Awaited<ReturnType<typeof reg.mutate>> | null = null;
    await withSyncDir(async (d, orig) => {
      n++;
      if (n === 2) await patchLock(f.lockPath, { createdAt: 1 });
      await orig(d);
    }, async () => {
      r = await reg.mutate((d) => d.add(entry(f.root, 'a')));
    });
    const res = r as unknown as Awaited<ReturnType<typeof reg.mutate>>;
    assert.equal(res.saved, true);
    assert.match(res.warning ?? '', /未能正常释放/);
    assert.ok(await stat(f.lockPath));
    assert.equal((await reg.load()).entries.length, 1);
  } finally {
    await f.done();
  }
});

test('并发：A 写好临时文件后标记被移除、B 完整保存了自己的条目；A 在 rename 前发现并放弃，B 的条目保留', async () => {
  const f = await fixture();
  try {
    const b = f.make();
    let fired = false;
    const a = f.make({
      step: async (name) => {
        if (name !== 'before-rename' || fired) return;
        fired = true;
        await unlink(f.lockPath);
        const rb = await b.mutate((d) => d.add(entry(f.root, 'b')));
        assert.equal(rb.saved, true);
      },
    });
    await assert.rejects(a.mutate((d) => d.add(entry(f.root, 'a'))), isCode('restore-registry-race'));
    assert.ok(fired);
    assert.deepEqual((await a.load()).entries.map((e) => e.txid), ['b'.repeat(16)]);
    assert.deepEqual((await readdir(f.root)).filter((n) => n.endsWith('.tmp')), [], 'A 的临时文件已删除');
  } finally {
    await f.done();
  }
});

test('并发：标记仍在但登记文件在修改期间被改写时放弃写入，不覆盖', async () => {
  const f = await fixture();
  try {
    const seed = f.make();
    await seed.mutate((d) => d.add(entry(f.root, 'a')));
    let other = '';
    const a = f.make({
      step: async (name) => {
        if (name !== 'before-rename' || other) return;
        other = JSON.stringify({ format: RESTORE_FORMAT, kind: 'registry', schema: 1, entries: [entry(f.root, 'c')], receipts: [] });
        await writeFile(f.file, other);
      },
    });
    await assert.rejects(a.mutate((d) => d.add(entry(f.root, 'b'))), isCode('restore-registry-race'));
    assert.equal(await readFile(f.file, 'utf8'), other);
  } finally {
    await f.done();
  }
});

test('并发：开始时登记不存在、rename 前被别人创建时放弃写入', async () => {
  const f = await fixture();
  try {
    const b = f.make();
    let fired = false;
    const a = f.make({
      step: async (name) => {
        if (name !== 'before-rename' || fired) return;
        fired = true;
        await unlink(f.lockPath);
        await b.mutate((d) => d.add(entry(f.root, 'b')));
      },
    });
    await assert.rejects(a.mutate((d) => d.add(entry(f.root, 'a'))), isCode('restore-registry-race'));
    assert.deepEqual((await a.load()).entries.map((e) => e.txid), ['b'.repeat(16)]);
  } finally {
    await f.done();
  }
});

test('旧标记：只删除登记专用（全 0 编号）、内容完整、持有进程已退出的标记', async () => {
  const f = await fixture();
  try {
    const reg = f.make();
    // 登记专用、持有进程已退出：删除后继续
    await createTargetLock(f.lockPath, REGISTRY_LOCK_TXID, 'a'.repeat(32));
    await patchLock(f.lockPath, { pid: DEAD });
    assert.equal((await reg.mutate((d) => d.add(entry(f.root, 'a')))).saved, true);
    await assert.rejects(stat(f.lockPath), { code: 'ENOENT' });

    const busy = async (patch: Record<string, unknown>, txid = REGISTRY_LOCK_TXID) => {
      await createTargetLock(f.lockPath, txid, 'a'.repeat(32));
      await patchLock(f.lockPath, patch);
      const before = await readFile(f.lockPath, 'utf8');
      await assert.rejects(reg.mutate((d) => d.add(entry(f.root, 'z'))), isCode('restore-registry-busy'), JSON.stringify(patch));
      assert.equal(await readFile(f.lockPath, 'utf8'), before, '标记原样保留');
      await unlink(f.lockPath);
    };
    // 恢复的目标占用标记（非全 0 编号）、持有进程已退出：不是登记的标记，保留
    await busy({ pid: DEAD }, 'f'.repeat(16));
    // 同一进程（可能是同进程中的另一个实例）：不算退出
    await busy({});
    // 持有进程仍在运行
    await busy({ pid: DEAD + 1 });
    // 字段不合法 / 多出字段：无法识别，保留
    await busy({ pid: DEAD, extra: true });
    await busy({ pid: DEAD, createdAt: -1 });
    assert.deepEqual((await reg.load()).entries.map((e) => e.txid), ['a'.repeat(16)]);
  } finally {
    await f.done();
  }
});

test('writeDurable：beforeRename 抛错时目标不变、临时文件删除；所在目录被替换时不经由新目录删除', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'data.json');
    await writeFile(file, 'old');
    await assert.rejects(writeDurable(file, Buffer.from('new'), '测试', { beforeRename: async () => Promise.reject(new UserError('stop', 'test-stop')) }), isCode('test-stop'));
    assert.equal(await readFile(file, 'utf8'), 'old');
    assert.deepEqual((await readdir(f.root)).filter((n) => n.endsWith('.tmp')), []);

    const dir = path.join(f.root, 'sub');
    await mkdir(dir);
    const moved = path.join(f.root, 'sub-moved');
    await assert.rejects(
      writeDurable(path.join(dir, 'data.json'), Buffer.from('new'), '测试', {
        beforeRename: async () => {
          await rename(dir, moved);
          await mkdir(dir);
        },
      }),
      isCode('restore-changed'),
    );
    assert.deepEqual(await readdir(dir), []);
    assert.equal((await readdir(moved)).filter((n) => n.endsWith('.tmp')).length, 1, '临时文件留在被移走的原目录中，没有经由新目录删除');
  } finally {
    await f.done();
  }
});

test('parseCandidate：字段精确、来源合法、大小写重复、缺少上级目录、层数 / 单文件 / 总字节 / 条目数超限都拒绝', () => {
  const txid = 'a'.repeat(16);
  const sha = '0'.repeat(64);
  const doc = (entries: unknown[]) => ({ format: RESTORE_FORMAT, kind: 'candidate', txid, entries });
  const L = { ...DEFAULT_BACKUP_LIMITS, maxEntries: 10, maxDepth: 3, maxFileBytes: 100, maxSnapshotBytes: 150 };
  const ok = parseCandidate(doc([{ path: 'A', type: 'dir', origin: 'snapshot' }, { path: 'A/f', type: 'file', size: 1, sha256: sha, origin: 'baseline' }]), txid, L);
  assert.deepEqual(ok, [{ path: 'A', type: 'dir' }, { path: 'A/f', type: 'file', size: 1, sha256: sha }]);
  const bad: Array<[string, unknown[]]> = [
    ['大小写重复', [{ path: 'A', type: 'dir', origin: 'snapshot' }, { path: 'a', type: 'dir', origin: 'snapshot' }]],
    ['Unicode 重复', [{ path: 'é', type: 'dir', origin: 'snapshot' }, { path: 'é'.normalize('NFD'), type: 'dir', origin: 'snapshot' }]],
    ['缺少上级目录', [{ path: 'no-parent/file', type: 'file', size: 0, sha256: sha, origin: 'snapshot' }]],
    ['上级是文件', [{ path: 'A', type: 'file', size: 0, sha256: sha, origin: 'snapshot' }, { path: 'A/b', type: 'dir', origin: 'snapshot' }]],
    ['层数超限', [{ path: 'a', type: 'dir', origin: 'snapshot' }, { path: 'a/b', type: 'dir', origin: 'snapshot' }, { path: 'a/b/c', type: 'dir', origin: 'snapshot' }, { path: 'a/b/c/d', type: 'dir', origin: 'snapshot' }]],
    ['单文件超限', [{ path: 'f', type: 'file', size: 101, sha256: sha, origin: 'snapshot' }]],
    ['总字节超限', [{ path: 'f', type: 'file', size: 100, sha256: sha, origin: 'snapshot' }, { path: 'g', type: 'file', size: 60, sha256: sha, origin: 'snapshot' }]],
    ['条目数超限', Array.from({ length: 11 }, (_, i) => ({ path: `d${i}`, type: 'dir', origin: 'snapshot' }))],
    ['来源不合法', [{ path: 'A', type: 'dir', origin: 'other' }]],
    ['多出字段', [{ path: 'A', type: 'dir', origin: 'snapshot', size: 0 }]],
    ['校验值不合法', [{ path: 'f', type: 'file', size: 0, sha256: 'xyz', origin: 'snapshot' }]],
    ['路径不安全', [{ path: '../x', type: 'dir', origin: 'snapshot' }]],
  ];
  for (const [name, entries] of bad) assert.throws(() => parseCandidate(doc(entries), txid, L), isCode('restore-corrupt'), name);
  assert.throws(() => parseCandidate({ ...doc([]), txid: 'b'.repeat(16) }, txid, L), isCode('restore-corrupt'));
});
