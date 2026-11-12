// 0.2.2：本实例正在取得 / 持有的备份位置占用标记，在查看状态时不被当成“其他艾泽魔方或中断遗留”；外来标记照常告警。
// 只用临时目录；文件系统是真实的，只拦截本次占用标记的排他创建，在 open→fstat 与 fsync 窗口暂停或注入失败，模拟慢存储。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, type BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { LOCK_NAME, WtfBackupService } from '../src/core/wtf-backup';
import type { BackupState } from '../src/shared/backup-types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const tick = () => new Promise<void>((r) => setImmediate(r));
const lockAnomalies = (s: BackupState) => s.anomalies.filter((a) => a.kind === 'lock');
const EXCL = constants.O_CREAT | constants.O_EXCL;

/**
 * 拦截下一次对 lockPath 的排他创建（核心在调用时读取 fs/promises 的导出）：可在 open 之前、首次 fstat 之前与 fsync 之前暂停，
 * 也可让首次 fstat 或 fsync 失败。只影响这一次创建，之后的读取与删除不受影响
 */
function interceptLock(lockPath: string) {
  const real = fsp.open;
  const ctl = {
    atOpen: deferred(),
    openGate: null as Promise<void> | null,
    atStat: deferred(),
    statGate: null as Promise<void> | null,
    failStat: false,
    atSync: deferred(),
    syncGate: null as Promise<void> | null,
    failSync: false,
  };
  let used = false;
  (fsp as { open: typeof fsp.open }).open = (async (...args: Parameters<typeof fsp.open>) => {
    const create = !used && String(args[0]) === lockPath && typeof args[1] === 'number' && (args[1] & EXCL) === EXCL;
    if (!create) return real(...args);
    used = true;
    ctl.atOpen.resolve();
    if (ctl.openGate) await ctl.openGate;
    const fh = await real(...args);
    const stat0 = fh.stat.bind(fh);
    const sync0 = fh.sync.bind(fh);
    let first = true;
    fh.stat = (async (o?: { bigint?: boolean }) => {
      if (first) {
        first = false;
        ctl.atStat.resolve();
        if (ctl.statGate) await ctl.statGate;
        if (ctl.failStat) throw Object.assign(new Error('注入：fstat 失败'), { code: 'EIO' });
      }
      return stat0(o as { bigint: true });
    }) as typeof fh.stat;
    fh.sync = async () => {
      ctl.atSync.resolve();
      if (ctl.syncGate) await ctl.syncGate;
      if (ctl.failSync) throw Object.assign(new Error('注入：fsync 失败'), { code: 'EIO' });
      return sync0();
    };
    return fh;
  }) as typeof fsp.open;
  return { ctl, restore: () => ((fsp as { open: typeof fsp.open }).open = real) };
}

/** 让下一次对 dir 的 opendir 停住（用于让状态扫描在取得标记之前就建立扫描上下文） */
function holdOpendir(dir: string) {
  const real = fsp.opendir;
  const reached = deferred();
  const gate = deferred();
  let used = false;
  (fsp as { opendir: typeof fsp.opendir }).opendir = (async (...args: Parameters<typeof fsp.opendir>) => {
    if (!used && String(args[0]) === dir) {
      used = true;
      reached.resolve();
      await gate.promise;
    }
    return real(...args);
  }) as typeof fsp.opendir;
  return { reached: reached.promise, release: () => gate.resolve(), restore: () => ((fsp as { opendir: typeof fsp.opendir }).opendir = real) };
}

async function setup() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-own-lock-')));
  const root = path.join(base, 'games', '_classic_');
  const appData = path.join(base, 'appData');
  const picked = path.join(base, 'Desktop');
  for (const d of [path.join(root, 'WTF', 'Account', 'A'), appData, picked]) await mkdir(d, { recursive: true });
  await writeFile(path.join(root, 'WTF', 'Config.wtf'), 'SET a "1"\n');
  await writeFile(path.join(root, 'WTF', 'Account', 'A', 'bindings-cache.wtf'), 'x\n');
  const svc = new WtfBackupService({
    settingsFile: path.join(appData, 'wtf-backup.json'),
    appDataDir: appData,
    appVersion: '0.2.2-test',
    resolveRoot: async () => root,
    listBoundRoots: async () => [root],
  });
  const enabled = await svc.configure(9, root, picked);
  const container = enabled.containerPath!;
  const lockPath = path.join(container, LOCK_NAME);
  const done = async () => {
    await svc.shutdown();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, svc, container, lockPath, done };
}

/** Promise 当前是否仍未结束 */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 20; i++) await tick();
  return !settled;
}

for (const kind of ['run', 'verify'] as const) {
  test(`本实例${kind === 'run' ? '备份' : '校验'}正在取得占用标记（open→fstat 与慢 fsync）时查看状态：不列为异常；扫描早于取得标记开始也一样；任务正常完成`, async () => {
    const f = await setup();
    let snapshotId = '';
    if (kind === 'verify') snapshotId = (await f.svc.run(9, f.root)).snapshot.id;
    const lock = interceptLock(f.lockPath);
    const statGate = deferred();
    const syncGate = deferred();
    lock.ctl.statGate = statGate.promise;
    lock.ctl.syncGate = syncGate.promise;
    const scan = holdOpendir(f.container);
    try {
      // 扫描上下文在取得标记之前建立：状态读取停在列出备份位置之前
      const early = f.svc.state(9, f.root);
      await scan.reached;
      const task: Promise<unknown> = kind === 'run' ? f.svc.run(9, f.root) : f.svc.verify(9, f.root, snapshotId);
      task.catch(() => undefined);
      // 标记文件已排他创建（还没有写入内容），身份尚未确认
      await lock.ctl.atStat.promise;
      assert.equal((await lstat(f.lockPath)).size, 0);
      const during = f.svc.state(9, f.root);
      assert.ok(await pending(during), '身份确认之前等待，不立即把它列为异常');
      statGate.resolve();
      // 身份已确认，写入后的 fsync 很慢
      await lock.ctl.atSync.promise;
      scan.release();
      const sDuring = await during;
      const sEarly = await early;
      for (const s of [sDuring, sEarly]) {
        assert.deepEqual(lockAnomalies(s), [], JSON.stringify(s.anomalies));
        assert.equal(s.activeTask?.kind, kind);
      }
      const sSync = await f.svc.state(9, f.root);
      assert.deepEqual(lockAnomalies(sSync), []);
      assert.equal(sSync.anomalies.length, 0);
      syncGate.resolve();
      await task;
      const after = await f.svc.state(9, f.root);
      assert.equal(after.anomalies.length, 0);
      assert.equal(after.activeTask, null);
      await assert.rejects(lstat(f.lockPath), /ENOENT/);
    } finally {
      statGate.resolve();
      syncGate.resolve();
      scan.release();
      scan.restore();
      lock.restore();
      await f.done();
    }
  });
}

test('已有外来占用标记：本实例取得失败（EEXIST）期间查看状态等待后仍告警；任务被拒绝，外来标记原样保留', async () => {
  const f = await setup();
  await writeFile(f.lockPath, '{"left":"by other"}');
  const lock = interceptLock(f.lockPath);
  const openGate = deferred();
  lock.ctl.openGate = openGate.promise;
  try {
    const before = await f.svc.state(9, f.root);
    assert.equal(lockAnomalies(before).length, 1);
    const task = f.svc.run(9, f.root);
    await lock.ctl.atOpen.promise;
    const during = f.svc.state(9, f.root);
    assert.ok(await pending(during), '本实例正在取得同一位置的标记：等待结果');
    openGate.resolve();
    await assert.rejects(task, isCode('backup-lock'));
    const s = await during;
    assert.equal(lockAnomalies(s).length, 1, '外来标记不能因为本实例有任务就被认领');
    assert.equal(lockAnomalies(await f.svc.state(9, f.root)).length, 1);
    assert.equal(await readFile(f.lockPath, 'utf8'), '{"left":"by other"}');
  } finally {
    openGate.resolve();
    lock.restore();
    await f.done();
  }
});

test('取得标记后、fsync 期间标记被外来文件替换：查看状态告警；任务停止并保留外来文件', async () => {
  const f = await setup();
  const lock = interceptLock(f.lockPath);
  const syncGate = deferred();
  lock.ctl.syncGate = syncGate.promise;
  try {
    const task = f.svc.run(9, f.root);
    await lock.ctl.atSync.promise;
    const ours = await lstat(f.lockPath, { bigint: true });
    await unlink(f.lockPath);
    await writeFile(f.lockPath, 'foreign');
    const foreign: BigIntStats = await lstat(f.lockPath, { bigint: true });
    assert.notEqual(foreign.ino, ours.ino, '本次的文件仍被打开，新文件不会复用它的编号');
    const s = await f.svc.state(9, f.root);
    assert.equal(lockAnomalies(s).length, 1, '替换后的文件不是本实例的标记');
    syncGate.resolve();
    // 任务按真实身份核对：替换后的标记不是本次的，停止且不删除它
    await assert.rejects(task, /占用标记/);
    assert.equal(await readFile(f.lockPath, 'utf8'), 'foreign', '外来文件保留');
    const after = await f.svc.state(9, f.root);
    assert.equal(after.activeTask, null);
    assert.equal(lockAnomalies(after).length, 1);
  } finally {
    syncGate.resolve();
    lock.restore();
    await f.done();
  }
});

test('取得标记时 fsync 失败：任务失败，本次文件已删除，不留下本实例的身份；之后出现的标记照常告警', async () => {
  const f = await setup();
  const lock = interceptLock(f.lockPath);
  lock.ctl.failSync = true;
  try {
    await assert.rejects(f.svc.run(9, f.root), /注入：fsync 失败/);
    await assert.rejects(lstat(f.lockPath), /ENOENT/);
    assert.equal((await f.svc.state(9, f.root)).anomalies.length, 0);
    await writeFile(f.lockPath, 'later');
    assert.equal(lockAnomalies(await f.svc.state(9, f.root)).length, 1);
  } finally {
    lock.restore();
    await f.done();
  }
});

test('取得标记时首次 fstat 失败：文件无法确认归属，保留并在错误与状态中说明，不被静默忽略', async () => {
  const f = await setup();
  const lock = interceptLock(f.lockPath);
  lock.ctl.failStat = true;
  try {
    await assert.rejects(f.svc.run(9, f.root), (err: unknown) => /注入：fstat 失败/.test((err as Error).message) && (err as Error).message.includes(`新建的文件 ${f.lockPath} 无法确认身份，已保留`));
    assert.ok((await lstat(f.lockPath)).isFile(), '无法确认归属的文件保留');
    const s = await f.svc.state(9, f.root);
    assert.equal(s.activeTask, null);
    assert.equal(lockAnomalies(s).length, 1);
    assert.equal(s.canCreate, false);
  } finally {
    lock.restore();
    await f.done();
  }
});

test('fsync 期间取消：取得完成后任务以取消结束、释放本次标记；状态没有残留异常', async () => {
  const f = await setup();
  const lock = interceptLock(f.lockPath);
  const syncGate = deferred();
  lock.ctl.syncGate = syncGate.promise;
  try {
    const task = f.svc.run(9, f.root);
    await lock.ctl.atSync.promise;
    const info = f.svc.taskState()!;
    assert.equal(f.svc.cancel(info.id, 9, f.root), true);
    assert.deepEqual(lockAnomalies(await f.svc.state(9, f.root)), []);
    syncGate.resolve();
    await assert.rejects(task);
    await assert.rejects(lstat(f.lockPath), /ENOENT/);
    const after = await f.svc.state(9, f.root);
    assert.equal(after.anomalies.length, 0);
    assert.equal(after.activeTask, null);
  } finally {
    syncGate.resolve();
    lock.restore();
    await f.done();
  }
});
