// WTF 恢复的磁盘事务：只使用 mkdtemp 生成的合成游戏目录、备份目录与应用数据目录，不读取真实玩家数据。
// 备份位置的占用与恢复前备份由测试中的简化端口提供（直接复制当前 WTF）；正式的备份服务接入在下一批。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SimulatedCrash, UserError } from '../src/core/errors';
import { chainIds, DEFAULT_BACKUP_LIMITS, idOf, type ManifestEntry } from '../src/core/wtf-backup';
import { strictIo, type PidState } from '../src/core/wtf-restore-io';
import { RestoreRegistry } from '../src/core/wtf-restore-registry';
import {
  CONTROL_DIR, TARGET_LOCK, TX_PREFIX, WtfRestoreTxn,
  type RestoreApplyPorts, type RestoreResolvePorts, type RestoreStep, type RestoreTreeSource,
} from '../src/core/wtf-restore-txn';
import type { BackupLimits, BackupScope } from '../src/shared/backup-types';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const ACK = { gameClosed: true, overwrite: true };
const RACK = { gameClosed: true };
const SNAP_ID = '20260101-000000-aaaaaaaa';
const DEAD_PID = 999_999;
const ALL: BackupScope = { kind: 'all' };

/** 目录树的 路径 → 内容（目录为 <dir>） */
async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string) => {
    for (const n of (await readdir(abs)).sort()) {
      const p = path.join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      if ((await lstat(p)).isDirectory()) {
        out[r] = '<dir>';
        await walk(p, r);
      } else {
        out[r] = await readFile(p, 'utf8');
      }
    }
  };
  await walk(dir, '');
  return out;
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, ...p.split('/'));
    if (c === '<dir>') {
      await mkdir(abs, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
}

/** 清单条目（父目录在前） */
async function manifestOf(dir: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const walk = async (abs: string, rel: string) => {
    for (const n of (await readdir(abs)).sort()) {
      const p = path.join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      if ((await lstat(p)).isDirectory()) {
        out.push({ path: r, type: 'dir' });
        await walk(p, r);
      } else {
        const b = await readFile(p);
        out.push({ path: r, type: 'file', size: b.byteLength, sha256: sha(b) });
      }
    }
  };
  await walk(dir, '');
  return out;
}

async function treeSource(snapDir: string, id: string): Promise<RestoreTreeSource> {
  const wtfDir = path.join(snapDir, 'WTF');
  return { snapshotId: id, wtfDir, wtfId: idOf(await lstat(wtfDir, { bigint: true })), parentChain: await chainIds(snapDir), entries: await manifestOf(wtfDir), recheck: async () => undefined };
}

const CURRENT: Record<string, string> = {
  'Config.wtf': 'cfg-now',
  'Account/ALPHA/direct.txt': 'direct-now',
  'Account/ALPHA/SavedVariables/S.lua': 'sv-now',
  'Account/ALPHA/R/realm.txt': 'realm-now',
  'Account/ALPHA/R/C/AddOns.txt': 'c-now',
  'Account/ALPHA/R/D/AddOns.txt': 'd-now',
  'Account/BRAVO/x.txt': 'bravo-now',
};
const SNAP_ALL: Record<string, string> = {
  'Config.wtf': 'cfg-old',
  'Account/ALPHA/SavedVariables/S.lua': 'sv-old',
  'Account/ALPHA/R/C/AddOns.txt': 'c-old',
  'Account/ALPHA/R/C/old-only.txt': 'only-old',
  Empty: '<dir>',
};

interface Setup {
  base: string;
  root: string;
  wtf: string;
  control: string;
  container: string;
  snapDir: string;
  registryFile: string;
  hook: { fn: ((name: RestoreStep, detail?: string) => Promise<void> | void) | null };
  probe: { fn: (pid: number) => PidState };
  released: { n: number };
  make: (limits?: Partial<BackupLimits>) => WtfRestoreTxn;
  txn: WtfRestoreTxn;
  applyPorts: RestoreApplyPorts;
  resolvePorts: RestoreResolvePorts;
  apply: (txn?: WtfRestoreTxn, extra?: { signal?: AbortSignal; scope?: BackupScope }) => ReturnType<WtfRestoreTxn['apply']>;
  done: () => Promise<void>;
}

async function setup(current: Record<string, string> | null = CURRENT, snapshot: Record<string, string> = SNAP_ALL): Promise<Setup> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-restore-txn-')));
  const root = path.join(base, 'games', '_classic_');
  const wtf = path.join(root, 'WTF');
  await mkdir(root, { recursive: true });
  if (current) await writeTree(wtf, current);
  const container = path.join(base, 'container');
  const snapDir = path.join(container, SNAP_ID);
  await writeTree(path.join(snapDir, 'WTF'), snapshot);
  const appData = path.join(base, 'appData');
  await mkdir(appData);
  const hook: Setup['hook'] = { fn: null };
  const probe: Setup['probe'] = { fn: (pid) => (pid === DEAD_PID ? 'gone' : 'alive') };
  const released = { n: 0 };
  const registryFile = path.join(appData, 'wtf-restore-registry.json');
  const make = (limits?: Partial<BackupLimits>) =>
    new WtfRestoreTxn({ registryFile, limits: { ...DEFAULT_BACKUP_LIMITS, ...limits }, hooks: { step: (n, d) => hook.fn?.(n, d) }, probePid: (pid) => probe.fn(pid) });
  const applyPorts: RestoreApplyPorts = {
    acquireSources: async ({ baseline, safetySnapshotId }) => {
      const snapshot = await treeSource(snapDir, SNAP_ID);
      if (baseline === 'absent' || !safetySnapshotId) return { snapshot, safety: null };
      const dir = path.join(container, safetySnapshotId);
      await mkdir(dir);
      await cp(wtf, path.join(dir, 'WTF'), { recursive: true });
      return { snapshot, safety: await treeSource(dir, safetySnapshotId) };
    },
    checkCapacity: async () => undefined,
    releaseSources: async () => {
      released.n++;
      return null;
    },
  };
  const resolvePorts: RestoreResolvePorts = {
    openSources: async ({ safetySnapshotId }) => ({
      snapshot: await treeSource(snapDir, SNAP_ID),
      safety: safetySnapshotId ? await treeSource(path.join(container, safetySnapshotId), safetySnapshotId).catch(() => null) : null,
    }),
  };
  const txn = make();
  const apply: Setup['apply'] = (t = txn, extra = {}) =>
    t.apply({ flavorId: 9, root, scope: extra.scope ?? ALL, sourceSnapshotId: SNAP_ID, containerPath: container, ack: ACK, signal: extra.signal }, applyPorts);
  return {
    base, root, wtf, control: path.join(root, CONTROL_DIR), container, snapDir, registryFile, hook, probe, released, make, txn, applyPorts, resolvePorts, apply,
    done: () => rm(base, { recursive: true, force: true }),
  };
}

async function txDirs(f: Setup): Promise<string[]> {
  return (await readdir(f.control).catch(() => [] as string[])).filter((n) => n.startsWith(TX_PREFIX));
}

/**
 * 模拟持有进程已退出：同时把占用标记（原位，同一 inode）与登记中的标记证明里的 pid 改成不存在的进程，
 * 相当于另一个已经退出的进程留下的、证明一致的标记（测试端口把这个 pid 判为已退出）。只改其中一边会被拒绝
 */
async function orphanLock(f: Setup): Promise<void> {
  const p = path.join(f.control, TARGET_LOCK);
  const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  raw.pid = DEAD_PID;
  await writeFile(p, JSON.stringify(raw));
  await patchRegistry(f, (e) => {
    (e.lock as Record<string, unknown>).pid = DEAD_PID;
  });
}

async function patchRegistry(f: Setup, fn: (entry: Record<string, unknown>) => void): Promise<void> {
  const reg = JSON.parse(await readFile(f.registryFile, 'utf8')) as { entries: Record<string, unknown>[] };
  fn(reg.entries[0]);
  await writeFile(f.registryFile, JSON.stringify(reg));
}

async function crashAt(f: Setup, at: RestoreStep): Promise<{ txn2: WtfRestoreTxn; txid: string }> {
  f.hook.fn = (n) => {
    if (n === at) throw new SimulatedCrash(n);
  };
  await assert.rejects(f.apply(), (err: unknown) => err instanceof SimulatedCrash);
  f.hook.fn = null;
  const txn2 = f.make();
  const txid = (await txn2.pending()).items[0].txid as string;
  return { txn2, txid };
}

test('all：恢复为快照的完整镜像，生成恢复前备份，收尾后不留工作内容与占用', async () => {
  const f = await setup();
  try {
    const steps: string[] = [];
    f.hook.fn = (n) => void steps.push(n);
    const r = await f.apply();
    assert.equal(r.outcome, 'committed');
    assert.equal(r.cleanupPending, false, r.warnings.join('\n'));
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
    assert.ok(r.safetySnapshotId);
    assert.deepEqual(await readTree(path.join(f.container, r.safetySnapshotId as string, 'WTF')), await readTreeOf(CURRENT));
    assert.deepEqual(await txDirs(f), []);
    await assert.rejects(stat(path.join(f.control, TARGET_LOCK)), { code: 'ENOENT' });
    assert.equal((await stat(path.join(f.wtf, 'Config.wtf'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(f.wtf, 'Account'))).mode & 0o777, 0o700);
    assert.equal(f.released.n, 1);
    const p = await f.txn.pending([f.root]);
    assert.equal(p.registryError, null);
    assert.deepEqual(p.items, []);
    assert.equal(p.receipts.at(-1)?.outcome, 'committed');
    for (const s of ['preparing', 'sources-ready', 'staged', 'prepared', 'old-moved', 'new-moved', 'before-commit', 'committed', 'cleanup']) assert.ok(steps.includes(s), s);
  } finally {
    await f.done();
  }
});

async function readTreeOf(files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) out[segs.slice(0, i).join('/')] = '<dir>';
    out[p] = c;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

test('characters：范围内镜像，范围外（其他账号、根级、服务器直属文件、未选角色）字节保持', async () => {
  const snapshot = { 'Account/ALPHA/SavedVariables/S.lua': 'sv-old', 'Account/ALPHA/R/C/AddOns.txt': 'c-old' };
  const f = await setup(CURRENT, snapshot);
  try {
    const scope: BackupScope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: 'R', character: 'C' }] };
    const r = await f.apply(f.txn, { scope });
    assert.equal(r.outcome, 'committed');
    const now = await readTree(f.wtf);
    assert.equal(now['Config.wtf'], 'cfg-now');
    assert.equal(now['Account/BRAVO/x.txt'], 'bravo-now');
    assert.equal(now['Account/ALPHA/R/realm.txt'], 'realm-now');
    assert.equal(now['Account/ALPHA/R/D/AddOns.txt'], 'd-now');
    assert.equal(now['Account/ALPHA/SavedVariables/S.lua'], 'sv-old');
    assert.equal(now['Account/ALPHA/R/C/AddOns.txt'], 'c-old');
    assert.equal(now['Account/ALPHA/direct.txt'], undefined, '快照中没有的账号直属文件被删除');
  } finally {
    await f.done();
  }
});

test('absent：当前没有 WTF 时直接放入快照内容，不生成恢复前备份，不经过 old-moved', async () => {
  const f = await setup(null);
  try {
    const steps: string[] = [];
    f.hook.fn = (n) => void steps.push(n);
    const r = await f.apply();
    assert.equal(r.outcome, 'committed');
    assert.equal(r.safetySnapshotId, null);
    assert.ok(!steps.includes('old-moved'));
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
  } finally {
    await f.done();
  }
});

test('prepared 之后、第一次移动之前出错：不移动，按准备阶段撤回，WTF 未改动', async () => {
  const f = await setup();
  try {
    const before = idOf(await lstat(f.wtf, { bigint: true }));
    f.hook.fn = (n) => {
      if (n === 'prepared') throw new UserError('注入故障', 'test-fault');
    };
    await assert.rejects(f.apply(), isCode('test-fault'));
    assert.equal(idOf(await lstat(f.wtf, { bigint: true })), before);
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
    assert.deepEqual(await txDirs(f), []);
    assert.equal((await f.txn.pending()).receipts.at(-1)?.outcome, 'not-applied');
  } finally {
    await f.done();
  }
});

for (const at of ['old-moved', 'new-moved', 'before-commit'] as const) {
  test(`临界段 ${at} 出错：回滚到恢复前（同一个 WTF 目录、字节不变），清理候选树`, async () => {
    const f = await setup();
    try {
      const before = idOf(await lstat(f.wtf, { bigint: true }));
      f.hook.fn = (n) => {
        if (n === at) throw new Error(`注入故障 ${at}`);
      };
      const r = await f.apply();
      assert.equal(r.outcome, 'rolled-back');
      assert.equal(r.cleanupPending, false, r.warnings.join('\n'));
      assert.equal(idOf(await lstat(f.wtf, { bigint: true })), before);
      assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
      assert.deepEqual(await txDirs(f), []);
      const p = await f.txn.pending();
      assert.deepEqual(p.items, []);
      assert.equal(p.receipts.at(-1)?.outcome, 'rolled-back');
    } finally {
      await f.done();
    }
  });
}

test('准备阶段失败：WTF 未改动，撤回本次内容并释放备份位置占用', async () => {
  const f = await setup();
  try {
    const before = idOf(await lstat(f.wtf, { bigint: true }));
    f.hook.fn = (n) => {
      if (n === 'staged') throw new UserError('注入故障', 'test-fault');
    };
    await assert.rejects(f.apply(), isCode('test-fault'));
    assert.equal(idOf(await lstat(f.wtf, { bigint: true })), before);
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
    assert.deepEqual(await txDirs(f), []);
    assert.equal(f.released.n, 1);
    const p = await f.txn.pending();
    assert.deepEqual(p.items, []);
    assert.equal(p.receipts.at(-1)?.outcome, 'not-applied');
  } finally {
    await f.done();
  }
});

test('取消：复制候选文件时取消即撤回；进入临界段之后的取消被忽略，恢复照常完成', async () => {
  const f = await setup();
  try {
    const ac = new AbortController();
    f.hook.fn = (n) => {
      if (n === 'staging-file') ac.abort();
    };
    await assert.rejects(f.apply(f.txn, { signal: ac.signal }), isCode('backup-cancelled'));
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
    assert.deepEqual(await txDirs(f), []);
    const ac2 = new AbortController();
    f.hook.fn = (n) => {
      if (n === 'prepared') ac2.abort();
    };
    const r = await f.apply(f.txn, { signal: ac2.signal });
    assert.equal(r.outcome, 'committed');
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
  } finally {
    await f.done();
  }
});

test('准备期间当前 WTF 被改动（恢复前备份之后、或候选树完成之后的同大小改写）：拒绝，改动保留', async () => {
  for (const at of ['sources-ready', 'staged'] as const) {
    const f = await setup();
    try {
      f.hook.fn = async (n) => {
        if (n === at) await writeFile(path.join(f.wtf, 'Config.wtf'), 'CFG-NOW');
      };
      await assert.rejects(f.apply(), isCode('restore-changed'), at);
      assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'CFG-NOW');
      assert.deepEqual(await txDirs(f), []);
    } finally {
      await f.done();
    }
  }
});

test('第二次替换前 WTF 位置出现外来目录：不覆盖，保留原件并标为 blocked，之后不能再次恢复', async () => {
  const f = await setup();
  try {
    f.hook.fn = async (n) => {
      if (n === 'old-moved') await writeTree(f.wtf, { 'foreign.txt': 'foreign' });
    };
    const r = await f.apply();
    assert.equal(r.outcome, 'blocked');
    assert.deepEqual(await readTree(f.wtf), { 'foreign.txt': 'foreign' });
    const [tx] = await txDirs(f);
    assert.deepEqual(await readTree(path.join(f.control, tx, 'old')), await readTreeOf(CURRENT));
    const p = await f.txn.pending();
    assert.equal(p.items[0]?.state, 'blocked');
    f.hook.fn = null;
    await assert.rejects(f.apply(), isCode('restore-pending'));
  } finally {
    await f.done();
  }
});

test('资源上限：候选树超出单份大小上限时在复制之前拒绝，WTF 未改动', async () => {
  const f = await setup();
  try {
    const txn = f.make({ maxSnapshotBytes: 20 });
    await assert.rejects(f.apply(txn), isCode('restore-limit'));
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
    assert.deepEqual(await txDirs(f), []);
  } finally {
    await f.done();
  }
});

// ---------- 中断后处理 ----------

const CRASH_CASES: Array<{ at: RestoreStep; outcome: 'cleared' | 'rolled-back' | 'finalized' }> = [
  { at: 'preparing', outcome: 'cleared' },
  { at: 'staged', outcome: 'cleared' },
  { at: 'prepared', outcome: 'rolled-back' },
  { at: 'old-moved', outcome: 'rolled-back' },
  { at: 'new-moved', outcome: 'rolled-back' },
  { at: 'before-commit', outcome: 'rolled-back' },
  { at: 'committed', outcome: 'finalized' },
];

for (const c of CRASH_CASES) {
  test(`在 ${c.at} 中断：只读查看可见，重新确认后按真实的树身份与校验值处理为 ${c.outcome}`, async () => {
    const f = await setup();
    try {
      const before = idOf(await lstat(f.wtf, { bigint: true }));
      f.hook.fn = (n) => {
        if (n === c.at) throw new SimulatedCrash(n);
      };
      await assert.rejects(f.apply(), (err: unknown) => err instanceof SimulatedCrash);
      f.hook.fn = null;
      const txn2 = f.make();
      const view = await txn2.pending([f.root]);
      assert.equal(view.items.length, 1);
      const txid = view.items[0].txid as string;
      // 占用标记仍属于“仍在运行”的本进程：不能重新取得
      await assert.rejects(txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts), isCode('restore-lock'));
      await assert.rejects(txn2.resolve({ flavorId: 9, root: f.root, txid, ack: {} }, f.resolvePorts), isCode('restore-ack'));
      await orphanLock(f);
      const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
      assert.equal(r.outcome, c.outcome, r.message);
      if (c.outcome === 'finalized') {
        assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
      } else {
        assert.equal(idOf(await lstat(f.wtf, { bigint: true })), before);
        assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
      }
      assert.deepEqual(await txDirs(f), []);
      await assert.rejects(stat(path.join(f.control, TARGET_LOCK)), { code: 'ENOENT' });
      assert.deepEqual((await txn2.pending()).items, []);
      // 处理完后可以再次恢复
      const again = await f.apply(txn2);
      assert.equal(again.outcome, 'committed');
    } finally {
      await f.done();
    }
  });
}

test('新树放入后中断、之后 WTF 被改动（例如启动了游戏）：不回滚、不删除，保留现场', async () => {
  const f = await setup();
  try {
    f.hook.fn = (n) => {
      if (n === 'new-moved') throw new SimulatedCrash(n);
    };
    await assert.rejects(f.apply(), (err: unknown) => err instanceof SimulatedCrash);
    f.hook.fn = null;
    await writeFile(path.join(f.wtf, 'Config.wtf'), 'game-wrote');
    await orphanLock(f);
    const txn2 = f.make();
    const txid = (await txn2.pending()).items[0].txid as string;
    const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
    assert.equal(r.outcome, 'blocked');
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'game-wrote');
    const [tx] = await txDirs(f);
    assert.deepEqual(await readTree(path.join(f.control, tx, 'old')), await readTreeOf(CURRENT));
    assert.equal((await txn2.pending()).items[0].state, 'blocked');
  } finally {
    await f.done();
  }
});

test('原件移出后中断、原件被改动：不放回，保留现场', async () => {
  const f = await setup();
  try {
    f.hook.fn = (n) => {
      if (n === 'old-moved') throw new SimulatedCrash(n);
    };
    await assert.rejects(f.apply(), (err: unknown) => err instanceof SimulatedCrash);
    f.hook.fn = null;
    const [tx] = await txDirs(f);
    await writeFile(path.join(f.control, tx, 'old', 'Config.wtf'), 'CFG-NOW');
    await orphanLock(f);
    const txn2 = f.make();
    const txid = (await txn2.pending()).items[0].txid as string;
    const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
    assert.equal(r.outcome, 'blocked');
    await assert.rejects(stat(f.wtf), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.control, tx, 'old', 'Config.wtf'), 'utf8'), 'CFG-NOW');
  } finally {
    await f.done();
  }
});

test('提交记录写入后目录同步失败：不报告成功，登记为 blocked；之后处理时完成收尾', async () => {
  const f = await setup();
  try {
    const save = strictIo.syncDir;
    let failTx = false;
    f.hook.fn = (n) => {
      if (n === 'before-commit') failTx = true;
    };
    strictIo.syncDir = async (dir) => {
      if (failTx && path.basename(dir).startsWith(TX_PREFIX)) {
        failTx = false;
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return save(dir);
    };
    const r = await f.apply().finally(() => {
      strictIo.syncDir = save;
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
    const view = await f.txn.pending();
    assert.equal(view.items[0].state, 'blocked');
    f.hook.fn = null;
    // 同一实例仍精确持有占用标记，可以直接处理
    const res = await f.txn.resolve({ flavorId: 9, root: f.root, txid: r.txid, ack: RACK }, f.resolvePorts);
    assert.equal(res.outcome, 'finalized', res.message);
    assert.deepEqual(await txDirs(f), []);
  } finally {
    await f.done();
  }
});

test('收尾时原件被原地改写：恢复结果仍为已完成，原件保留为待清理，不强删', async () => {
  const f = await setup();
  try {
    f.hook.fn = async (n) => {
      if (n !== 'cleanup') return;
      const [tx] = await txDirs(f);
      await writeFile(path.join(f.control, tx, 'old', 'Config.wtf'), 'CFG-NOW');
    };
    const r = await f.apply();
    assert.equal(r.outcome, 'committed');
    assert.equal(r.cleanupPending, true);
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
    const [tx] = await txDirs(f);
    assert.equal(await readFile(path.join(f.control, tx, 'old', 'Config.wtf'), 'utf8'), 'CFG-NOW');
    assert.equal((await f.txn.pending()).items[0].state, 'cleanup-pending');
    f.hook.fn = null;
    const res = await f.txn.resolve({ flavorId: 9, root: f.root, txid: r.txid, ack: RACK }, f.resolvePorts);
    assert.equal(res.outcome, 'cleanup-pending');
    assert.equal(await readFile(path.join(f.control, tx, 'old', 'Config.wtf'), 'utf8'), 'CFG-NOW');
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')));
  } finally {
    await f.done();
  }
});

// ---------- 外部改动不被覆盖或删除（独立审查复现的路径） ----------

const ACCOUNT_ALPHA: BackupScope = { kind: 'account', account: 'ALPHA' };
const SNAP_ALPHA: Record<string, string> = { 'Account/ALPHA/SavedVariables/S.lua': 'sv-old', 'Account/ALPHA/R/C/AddOns.txt': 'c-old' };
const BRAVO = 'Account/BRAVO/x.txt';

async function bytesEverywhere(f: Setup, needle: string): Promise<number> {
  let n = 0;
  const walk = async (dir: string) => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const p = path.join(dir, name);
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p);
      else if ((await readFile(p, 'utf8')).includes(needle)) n++;
    }
  };
  await walk(f.base);
  return n;
}

test('prepared 钩子中改写 live 范围外文件（同 inode）：不移动、不提交，新字节留在 live', async () => {
  const f = await setup(CURRENT, SNAP_ALPHA);
  try {
    f.hook.fn = async (n) => {
      if (n === 'prepared') await writeFile(path.join(f.wtf, BRAVO), 'bravo-NEW');
    };
    await assert.rejects(f.apply(f.txn, { scope: ACCOUNT_ALPHA }), isCode('restore-changed'));
    assert.equal(await readFile(path.join(f.wtf, BRAVO), 'utf8'), 'bravo-NEW');
    assert.equal(await readFile(path.join(f.wtf, 'Account/ALPHA/R/C/AddOns.txt'), 'utf8'), 'c-now');
    assert.deepEqual(await txDirs(f), []);
  } finally {
    await f.done();
  }
});

for (const at of ['new-moved', 'before-commit'] as const) {
  test(`${at} 钩子中改写新 live 的范围外文件（同 inode）：不写 committed、不回滚，新字节保留并登记 blocked`, async () => {
    const f = await setup(CURRENT, SNAP_ALPHA);
    try {
      f.hook.fn = async (n) => {
        if (n === at) await writeFile(path.join(f.wtf, BRAVO), 'bravo-NEW');
      };
      const r = await f.apply(f.txn, { scope: ACCOUNT_ALPHA });
      assert.equal(r.outcome, 'blocked', r.message);
      assert.equal(await readFile(path.join(f.wtf, BRAVO), 'utf8'), 'bravo-NEW');
      assert.equal(await bytesEverywhere(f, 'bravo-NEW'), 1);
      const [tx] = await txDirs(f);
      const journal = JSON.parse(await readFile(path.join(f.control, tx, 'journal.json'), 'utf8')) as { state: string };
      assert.notEqual(journal.state, 'committed');
      assert.equal((await f.txn.pending()).items[0].state, 'blocked');
      assert.deepEqual(await readTree(path.join(f.control, tx, 'old')), await readTreeOf(CURRENT));
    } finally {
      await f.done();
    }
  });
}

test('new-moved 时原件被原地改写后出错：先核对原件，不移动任何东西，恢复后的 WTF 保持在原位', async () => {
  const f = await setup();
  try {
    f.hook.fn = async (n) => {
      if (n !== 'new-moved') return;
      const [tx] = await txDirs(f);
      await writeFile(path.join(f.control, tx, 'old', BRAVO), 'bravo-NEW');
      throw new Error('注入故障');
    };
    const r = await f.apply();
    assert.equal(r.outcome, 'blocked', r.message);
    assert.deepEqual(await readTree(f.wtf), await readTree(path.join(f.snapDir, 'WTF')), 'WTF 没有被移走');
    const [tx] = await txDirs(f);
    assert.equal(await readFile(path.join(f.control, tx, 'old', BRAVO), 'utf8'), 'bravo-NEW');
    await assert.rejects(stat(path.join(f.control, tx, 'candidate')), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('只读查看：工作目录无法检查（不是文件夹、条目过多）时如实列出，不当作没有未完成的恢复', async () => {
  const f = await setup();
  try {
    await writeFile(f.control, 'not a directory');
    let view = await f.txn.pending([f.root]);
    assert.equal(view.scanErrors.length, 1);
    assert.equal(view.scanErrors[0].root, f.root);
    assert.equal(await readFile(f.control, 'utf8'), 'not a directory', '只读查看不修改文件');
    await unlink(f.control);
    await mkdir(f.control);
    for (let i = 0; i < 257; i++) await writeFile(path.join(f.control, `x${i}`), '');
    view = await f.txn.pending([f.root]);
    assert.equal(view.scanErrors.length, 1);
    await rm(f.control, { recursive: true });
    view = await f.txn.pending([f.root]);
    assert.deepEqual(view.scanErrors, []);
  } finally {
    await f.done();
  }
});

test('staged 钩子中改写候选文件（同 inode）：拒绝，改写的候选内容保留为待清理，不被删除', async () => {
  const f = await setup();
  try {
    f.hook.fn = async (n) => {
      if (n !== 'staged') return;
      const [tx] = await txDirs(f);
      await writeFile(path.join(f.control, tx, 'candidate', 'Config.wtf'), 'CFG-OLD');
    };
    await assert.rejects(f.apply(), isCode('restore-changed'));
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
    const [tx] = await txDirs(f);
    assert.equal(await readFile(path.join(f.control, tx, 'candidate', 'Config.wtf'), 'utf8'), 'CFG-OLD');
    assert.equal((await f.txn.pending()).items[0].state, 'cleanup-pending');
  } finally {
    await f.done();
  }
});

test('已提交后中断、之后 live 被移走：处理时不回滚，原件保留并提示', async () => {
  const f = await setup();
  try {
    const { txn2, txid } = await crashAt(f, 'committed');
    await rename(f.wtf, path.join(f.base, 'moved-wtf'));
    await orphanLock(f);
    const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
    assert.equal(r.outcome, 'cleanup-pending', r.message);
    await assert.rejects(stat(f.wtf), { code: 'ENOENT' });
    const [tx] = await txDirs(f);
    assert.deepEqual(await readTree(path.join(f.control, tx, 'old')), await readTreeOf(CURRENT));
    assert.deepEqual(await readTree(path.join(f.base, 'moved-wtf')), await readTree(path.join(f.snapDir, 'WTF')));
  } finally {
    await f.done();
  }
});

test('准备阶段中断后候选清单被替换为外来内容：不删除，保留为待清理', async () => {
  const f = await setup();
  try {
    const { txn2, txid } = await crashAt(f, 'staged');
    const [tx] = await txDirs(f);
    await writeFile(path.join(f.control, tx, 'candidate.json'), 'not json, foreign');
    await orphanLock(f);
    const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
    assert.equal(r.outcome, 'cleanup-pending', r.message);
    assert.equal(await readFile(path.join(f.control, tx, 'candidate.json'), 'utf8'), 'not json, foreign');
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
  } finally {
    await f.done();
  }
});

test('准备阶段中断后候选树被换成字节相同的副本（不同 inode）：不认领、不删除', async () => {
  const f = await setup();
  try {
    const { txn2, txid } = await crashAt(f, 'staged');
    const [tx] = await txDirs(f);
    const cand = path.join(f.control, tx, 'candidate');
    await cp(cand, `${cand}-copy`, { recursive: true });
    await rm(cand, { recursive: true });
    await rename(`${cand}-copy`, cand);
    await orphanLock(f);
    const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
    assert.equal(r.outcome, 'cleanup-pending', r.message);
    assert.deepEqual(await readTree(cand), await readTree(path.join(f.snapDir, 'WTF')));
  } finally {
    await f.done();
  }
});

test('已提交后原件缺少文件：完整核对失败时不写删除标记，再次处理仍保留剩余原件', async () => {
  const f = await setup();
  try {
    const { txn2, txid } = await crashAt(f, 'committed');
    const [tx] = await txDirs(f);
    await unlink(path.join(f.control, tx, 'old', 'Config.wtf'));
    await orphanLock(f);
    for (let i = 0; i < 2; i++) {
      const r = await txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts);
      assert.equal(r.outcome, 'cleanup-pending', r.message);
      const journal = JSON.parse(await readFile(path.join(f.control, tx, 'journal.json'), 'utf8')) as { discardOld: boolean };
      assert.equal(journal.discardOld, false);
      assert.equal(await readFile(path.join(f.control, tx, 'old', 'Account/BRAVO/x.txt'), 'utf8'), 'bravo-now');
    }
  } finally {
    await f.done();
  }
});

test('收尾时工作目录同步失败：结果已确定，保留待处理；再次处理时重新同步并完成，不猜测结果', async () => {
  const f = await setup();
  try {
    const save = strictIo.syncDir;
    let armed = false;
    f.hook.fn = (n) => {
      if (n === 'cleanup') armed = true;
    };
    strictIo.syncDir = async (dir) => {
      if (armed && dir === f.control) {
        armed = false;
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return save(dir);
    };
    const r = await f.apply().finally(() => {
      strictIo.syncDir = save;
    });
    assert.equal(r.outcome, 'committed');
    assert.equal(r.cleanupPending, true);
    const item = (await f.txn.pending()).items[0];
    assert.equal(item.outcome, 'committed');
    assert.deepEqual(await txDirs(f), []);
    f.hook.fn = null;
    const res = await f.txn.resolve({ flavorId: 9, root: f.root, txid: r.txid, ack: RACK }, f.resolvePorts);
    assert.equal(res.outcome, 'finalized', res.message);
    assert.deepEqual((await f.txn.pending()).items, []);
    assert.equal((await f.txn.pending()).receipts.at(-1)?.outcome, 'committed');
  } finally {
    await f.done();
  }
});

test('目标占用的删除未能确认写入磁盘：登记保留为待处理；再次处理时同步后完成', async () => {
  const f = await setup();
  try {
    const save = strictIo.syncDir;
    let armed = false;
    let seen = 0;
    f.hook.fn = (n) => {
      if (n === 'cleanup') armed = true;
    };
    strictIo.syncDir = async (dir) => {
      // 收尾中对工作目录的第二次同步是占用标记删除之后的那一次
      if (armed && dir === f.control && ++seen === 2) {
        armed = false;
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return save(dir);
    };
    const r = await f.apply().finally(() => {
      strictIo.syncDir = save;
    });
    assert.equal(r.outcome, 'committed');
    assert.equal(r.cleanupPending, true);
    await assert.rejects(stat(path.join(f.control, TARGET_LOCK)), { code: 'ENOENT' });
    assert.equal((await f.txn.pending()).items.length, 1, '占用删除未确认时不能结束登记');
    f.hook.fn = null;
    const res = await f.txn.resolve({ flavorId: 9, root: f.root, txid: r.txid, ack: RACK }, f.resolvePorts);
    assert.equal(res.outcome, 'finalized', res.message);
    assert.deepEqual((await f.txn.pending()).items, []);
    await assert.rejects(stat(path.join(f.control, TARGET_LOCK)), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('占用标记被复制到新 inode（字段与登记证明一致、持有进程已退出）：不重新取得，标记保留', async () => {
  const f = await setup();
  try {
    const { txn2, txid } = await crashAt(f, 'preparing');
    await orphanLock(f);
    const p = path.join(f.control, TARGET_LOCK);
    const text = await readFile(p, 'utf8');
    await writeFile(`${p}.copy`, text);
    await rename(`${p}.copy`, p);
    await assert.rejects(txn2.resolve({ flavorId: 9, root: f.root, txid, ack: RACK }, f.resolvePorts), isCode('restore-lock'));
    assert.equal(await readFile(p, 'utf8'), text);
    // 只改了标记、没有对应登记证明的 pid 同样拒绝
    const g = await setup();
    try {
      const c = await crashAt(g, 'preparing');
      const q = path.join(g.control, TARGET_LOCK);
      const raw = JSON.parse(await readFile(q, 'utf8')) as Record<string, unknown>;
      raw.pid = DEAD_PID;
      await writeFile(q, JSON.stringify(raw));
      await assert.rejects(c.txn2.resolve({ flavorId: 9, root: g.root, txid: c.txid, ack: RACK }, g.resolvePorts), isCode('restore-lock'));
    } finally {
      await g.done();
    }
  } finally {
    await f.done();
  }
});

test('未登记的旧占用标记（持有进程已退出）：新的恢复不删除它', async () => {
  const f = await setup();
  try {
    await mkdir(f.control);
    await writeFile(path.join(f.control, '.azercube-wtf-restore.json'), JSON.stringify({ format: 'azercube-wtf-restore', kind: 'control', schema: 1 }));
    const lock = { format: 'azercube-wtf-restore', kind: 'lock', txid: 'f'.repeat(16), nonce: 'e'.repeat(32), owner: 'd'.repeat(32), pid: DEAD_PID, createdAt: 1 };
    await writeFile(path.join(f.control, TARGET_LOCK), JSON.stringify(lock));
    await assert.rejects(f.apply(), isCode('restore-lock-busy'));
    assert.deepEqual(JSON.parse(await readFile(path.join(f.control, TARGET_LOCK), 'utf8')), lock);
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
  } finally {
    await f.done();
  }
});

test('登记损坏：全局禁止恢复，只读查看给出固定错误，文件不被改写', async () => {
  const f = await setup();
  try {
    await writeFile(f.registryFile, '{"format":"x"}');
    await assert.rejects(f.apply(), isCode('restore-registry'));
    const view = await f.txn.pending([f.root]);
    assert.ok(view.registryError);
    assert.equal(await readFile(f.registryFile, 'utf8'), '{"format":"x"}');
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
  } finally {
    await f.done();
  }
});

test('只读查看列出未登记的工作目录；存在时不能开始新的恢复', async () => {
  const f = await setup();
  try {
    await mkdir(path.join(f.control, `${TX_PREFIX}0123456789abcdef`), { recursive: true });
    await writeFile(path.join(f.control, '.azercube-wtf-restore.json'), JSON.stringify({ format: 'azercube-wtf-restore', kind: 'control', schema: 1 }));
    const view = await f.txn.pending([f.root]);
    assert.equal(view.items[0]?.state, 'unregistered');
    assert.equal(view.items[0]?.txid, '0123456789abcdef');
    await assert.rejects(f.apply(), isCode('restore-pending'));
    assert.deepEqual(await readTree(f.wtf), await readTreeOf(CURRENT));
  } finally {
    await f.done();
  }
});

test('登记的跨实例修改互斥：两个实例同时登记不会互相覆盖', async () => {
  const f = await setup();
  try {
    const a = new RestoreRegistry(f.registryFile);
    const b = new RestoreRegistry(f.registryFile);
    const mk = (txid: string, root: string) => ({
      txid, nonce: 'b'.repeat(32), flavorId: 9, root, rootChain: ['1:2'], scope: ALL, sourceSnapshotId: SNAP_ID, containerPath: f.container,
      safetySnapshotId: null, state: 'preparing' as const, reason: null, controlId: null, txdirId: null, lock: null, candidate: null, outcome: null, createdAt: 1, updatedAt: 1,
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).mutate((d) => d.add(mk(`${'0'.repeat(15)}${i}`, `/r/${i}`)))));
    assert.equal((await a.load()).entries.length, 6);
  } finally {
    await f.done();
  }
});
