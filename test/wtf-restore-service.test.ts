// WTF 恢复的服务层：真实的 WtfBackupService 备份与恢复服务，只使用 mkdtemp 生成的合成游戏目录、应用数据与备份位置。
// 中断用 SimulatedCrash 钩子模拟（不是真实的进程终止；真实 SIGKILL 由独立探针覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SimulatedCrash, UserError } from '../src/core/errors';
import { LOCK_NAME, PARTIAL_PREFIX, WtfBackupService, type BackupStep, type CopyLedger } from '../src/core/wtf-backup';
import { strictIo } from '../src/core/wtf-restore-io';
import { cleanupSafetyPartial, WtfRestoreService } from '../src/core/wtf-restore-service';
import { CONTROL_DIR, TARGET_LOCK, TX_PREFIX, type RestoreStep } from '../src/core/wtf-restore-txn';
import type { BackupLimits, BackupScope } from '../src/shared/backup-types';

const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const ACK = { gameClosed: true, overwrite: true };
const RACK = { gameClosed: true };
const DEAD = 999_999;
const ALL: BackupScope = { kind: 'all' };

const TREE: Record<string, string> = {
  'Config.wtf': 'cfg-1',
  'Account/ALPHA/config-cache.wtf': 'acct-1',
  'Account/ALPHA/SavedVariables/S.lua': 'sv-1',
  'Account/ALPHA/R/realm.txt': 'realm-1',
  'Account/ALPHA/R/C/AddOns.txt': 'c-1',
  'Account/ALPHA/R/D/AddOns.txt': 'd-1',
  'Account/BRAVO/x.txt': 'bravo-1',
};

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, ...p.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string) => {
    for (const n of (await readdir(abs)).sort()) {
      const p = path.join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      if ((await lstat(p)).isDirectory()) {
        out[r] = '<dir>';
        await walk(p, r);
      } else out[r] = await readFile(p, 'utf8');
    }
  };
  await walk(dir, '');
  return out;
}

async function setup(limits?: Partial<BackupLimits>) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-restore-svc-')));
  const root = path.join(base, 'games', '_classic_');
  const root2 = path.join(base, 'games', '_classic_era_');
  const wtf = path.join(root, 'WTF');
  const appData = path.join(base, 'appData');
  const picked = path.join(base, 'Desktop');
  for (const d of [root2, appData, picked]) await mkdir(d, { recursive: true });
  await writeTree(wtf, TREE);
  await writeTree(path.join(root, 'Interface', 'AddOns'), { 'Foo/Foo.toc': '## Interface: 11500\n' });
  const ctx = { current: root as string | null, bound: [root] as string[] };
  const hook: { fn: ((n: RestoreStep, d?: string) => Promise<void> | void) | null } = { fn: null };
  const backupHook: { fn: ((n: BackupStep, d?: string) => Promise<void> | void) | null } = { fn: null };
  const free = { bytes: 1e15 };
  const clock = { now: Date.now() };
  const make = (over?: Partial<BackupLimits>) => {
    const backup = new WtfBackupService({
      settingsFile: path.join(appData, 'wtf-backup.json'), appDataDir: appData, appVersion: '0.3.0-test',
      resolveRoot: async () => ctx.current, listBoundRoots: async () => [...ctx.bound], limits: over ?? limits,
      hooks: { step: (n, d) => backupHook.fn?.(n, d) },
    });
    const restore = new WtfRestoreService(backup, {
      registryFile: path.join(appData, 'wtf-restore-registry.json'),
      hooks: { step: (n, d) => hook.fn?.(n, d) },
      probePid: (pid) => (pid === DEAD ? 'gone' : 'alive'),
      freeBytes: async () => free.bytes,
      now: () => clock.now,
    });
    return { backup, restore };
  };
  const { backup, restore } = make();
  await backup.configure(9, root, picked);
  const container = path.join(picked, (await readdir(picked))[0]);
  const done = async () => {
    await backup.shutdown();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, root2, wtf, appData, picked, container, ctx, hook, backupHook, free, clock, make, backup, restore, done };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function snapshot(f: Setup, scope: BackupScope = ALL): Promise<string> {
  return (await f.backup.run(9, f.root, scope)).snapshot.id;
}

async function addons(f: Setup): Promise<Record<string, string>> {
  return readTree(path.join(f.root, 'Interface'));
}

test('all：预览给出冻结凭证与差异；执行恢复为备份时的 WTF，生成可校验的恢复前完整备份，插件目录不变', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const backedUp = await readTree(f.wtf);
    await writeFile(path.join(f.wtf, 'Config.wtf'), 'cfg-2');
    await writeFile(path.join(f.wtf, 'new.txt'), 'new');
    const mutated = await readTree(f.wtf);
    const before = await addons(f);
    const p = await f.restore.restorePreview(9, f.root, id);
    assert.ok(p.token);
    assert.equal(p.baseline, 'present');
    assert.equal(p.counts.overwriteFiles, 1);
    assert.equal(p.counts.deleteFiles, 1);
    assert.equal(p.safetyCopy.required, true);
    assert.deepEqual(p.blockers, []);
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.equal(r.outcome, 'committed', r.message);
    assert.equal(r.cleanupPending, false, r.warnings.join('\n'));
    assert.deepEqual(await readTree(f.wtf), backedUp);
    assert.deepEqual(await addons(f), before);
    const state = await f.backup.state(9, f.root);
    const safety = state.snapshots.find((s) => s.id === r.safetySnapshotId);
    assert.equal(safety?.purpose, 'pre-restore');
    assert.deepEqual(safety?.scope, ALL);
    assert.deepEqual(state.anomalies, []);
    assert.equal((await f.backup.verify(9, f.root, r.safetySnapshotId as string)).ok, true);
    assert.deepEqual(await readTree(path.join(f.container, r.safetySnapshotId as string, 'WTF')), mutated);
    await assert.rejects(stat(path.join(f.container, LOCK_NAME)), { code: 'ENOENT' });
    assert.deepEqual((await f.restore.restorePending()).items, []);
    // 恢复之后可以照常备份
    assert.ok(await snapshot(f));
  } finally {
    await f.done();
  }
});

test('characters：范围外的路径与字节完全不变，范围内恢复为备份时的状态', async () => {
  const f = await setup();
  try {
    const scope: BackupScope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: 'R', character: 'C' }] };
    const id = await snapshot(f, scope);
    await writeTree(f.wtf, {
      'Config.wtf': 'cfg-2', 'Account/BRAVO/x.txt': 'bravo-2', 'Account/ALPHA/R/D/AddOns.txt': 'd-2', 'Account/ALPHA/R/realm.txt': 'realm-2',
      'Account/ALPHA/R/C/AddOns.txt': 'c-2', 'Account/ALPHA/SavedVariables/S.lua': 'sv-2', 'Account/ALPHA/SavedVariables/New.lua': 'new',
    });
    const p = await f.restore.restorePreview(9, f.root, id);
    assert.deepEqual(p.scope, scope);
    assert.ok(p.notes.some((n) => n.includes('SavedVariables')));
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.equal(r.outcome, 'committed', r.message);
    const now = await readTree(f.wtf);
    assert.equal(now['Config.wtf'], 'cfg-2');
    assert.equal(now['Account/BRAVO/x.txt'], 'bravo-2');
    assert.equal(now['Account/ALPHA/R/D/AddOns.txt'], 'd-2');
    assert.equal(now['Account/ALPHA/R/realm.txt'], 'realm-2');
    assert.equal(now['Account/ALPHA/R/C/AddOns.txt'], 'c-1');
    assert.equal(now['Account/ALPHA/SavedVariables/S.lua'], 'sv-1');
    assert.equal(now['Account/ALPHA/SavedVariables/New.lua'], undefined);
  } finally {
    await f.done();
  }
});

test('absent：当前没有 WTF 时恢复不生成恢复前备份', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const backedUp = await readTree(f.wtf);
    await rm(f.wtf, { recursive: true });
    const p = await f.restore.restorePreview(9, f.root, id);
    assert.equal(p.baseline, 'absent');
    assert.equal(p.safetyCopy.required, false);
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.equal(r.outcome, 'committed', r.message);
    assert.equal(r.safetySnapshotId, null);
    assert.deepEqual(await readTree(f.wtf), backedUp);
    assert.equal((await f.backup.state(9, f.root)).snapshots.length, 1);
  } finally {
    await f.done();
  }
});

test('凭证：一次有效，伪造、重复与过期都拒绝', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    await assert.rejects(f.restore.restoreApply('0'.repeat(32), ACK), isCode('restore-token'));
    await assert.rejects(f.restore.restoreApply('../x', ACK), isCode('restore-token'));
    const p = await f.restore.restorePreview(9, f.root, id);
    f.clock.now += 11 * 60 * 1000;
    await assert.rejects(f.restore.restoreApply(p.token, ACK), isCode('restore-token'));
    f.clock.now = Date.now();
    const q = await f.restore.restorePreview(9, f.root, id);
    assert.equal((await f.restore.restoreApply(q.token, ACK)).outcome, 'committed');
    await assert.rejects(f.restore.restoreApply(q.token, ACK), isCode('restore-token'));
  } finally {
    await f.done();
  }
});

test('预览之后当前 WTF、备份内容或绑定（A→B→A）变化：执行拒绝，WTF 不变、不生成恢复前备份', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    await writeFile(path.join(f.wtf, 'Config.wtf'), 'cfg-2');
    // 当前 WTF 的范围外文件被改写
    let p = await f.restore.restorePreview(9, f.root, id);
    await writeFile(path.join(f.wtf, 'Account/BRAVO/x.txt'), 'bravo-X');
    await assert.rejects(f.restore.restoreApply(p.token, ACK), isCode('restore-changed'));
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-2');
    // 备份内容被改写（同大小）
    p = await f.restore.restorePreview(9, f.root, id);
    await writeFile(path.join(f.container, id, 'WTF', 'Config.wtf'), 'cfg-X');
    await assert.rejects(f.restore.restoreApply(p.token, ACK), (err: unknown) => err instanceof UserError && ['restore-changed', 'restore-snapshot'].includes(err.code));
    await writeFile(path.join(f.container, id, 'WTF', 'Config.wtf'), 'cfg-1');
    // 绑定 A→B→A：目录字符串相同也必须重新预览
    p = await f.restore.restorePreview(9, f.root, id);
    f.restore.beginBindingMutation({ flavorId: 9, roots: [f.root, f.root2] })();
    await assert.rejects(f.restore.restoreApply(p.token, ACK), isCode('restore-changed'));
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-2');
    assert.equal((await f.backup.state(9, f.root)).snapshots.length, 1, '没有生成恢复前备份');
    assert.deepEqual((await f.restore.restorePending()).items, []);
    await assert.rejects(stat(path.join(f.container, LOCK_NAME)), { code: 'ENOENT' });
  } finally {
    await f.done();
  }
});

test('份数已满或可用空间不足：预览给出原因且没有凭证，旧备份不被删除', async () => {
  const f = await setup({ maxSnapshots: 2 });
  try {
    const a = await snapshot(f);
    await snapshot(f);
    const p = await f.restore.restorePreview(9, f.root, a);
    assert.equal(p.token, null);
    assert.ok(p.blockers.length > 0);
    assert.equal((await f.backup.state(9, f.root)).snapshots.length, 2);
  } finally {
    await f.done();
  }
  const g = await setup();
  try {
    const id = await snapshot(g);
    g.free.bytes = 0;
    const p = await g.restore.restorePreview(9, g.root, id);
    assert.equal(p.token, null);
    assert.ok(p.blockers.some((b) => b.includes('空间')));
  } finally {
    await g.done();
  }
});

test('绑定写入的短占位与恢复任务双向互斥；占位期间不能预览，恢复期间不能写绑定', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const release = f.restore.beginBindingMutation({ flavorId: 9, roots: [f.root] });
    await assert.rejects(f.restore.restorePreview(9, f.root, id), isCode('restore-busy'));
    release();
    release();
    const p = await f.restore.restorePreview(9, f.root, id);
    let blocked: unknown = null;
    f.hook.fn = (n) => {
      if (n !== 'staged') return;
      try {
        f.restore.beginBindingMutation({ flavorId: 9, roots: [f.root] });
      } catch (err) {
        blocked = err;
      }
      // 无关目录的绑定不受影响
      f.restore.beginBindingMutation({ flavorId: 2, roots: [f.root2] })();
    };
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.ok(isCode('restore-busy')(blocked));
    // 无关目录的绑定递增了代次，但执行中的恢复不受影响（代次只在执行开始前核对）
    assert.equal(r.outcome, 'committed');
  } finally {
    await f.done();
  }
});

test('取消：准备阶段可以取消（WTF 不变、占用释放、之后可以备份）；替换阶段不可取消，结果照常提交', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    await writeFile(path.join(f.wtf, 'Config.wtf'), 'cfg-2');
    let p = await f.restore.restorePreview(9, f.root, id);
    f.hook.fn = (n) => {
      if (n !== 'staging-file') return;
      const t = f.backup.taskState();
      assert.equal(t?.cancellable, true);
      assert.equal(f.backup.cancel(t?.id ?? '', 9, f.root), true);
    };
    await assert.rejects(f.restore.restoreApply(p.token, ACK), isCode('backup-cancelled'));
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-2');
    await assert.rejects(stat(path.join(f.container, LOCK_NAME)), { code: 'ENOENT' });
    assert.deepEqual((await f.restore.restorePending()).items, []);
    assert.ok(await snapshot(f));
    p = await f.restore.restorePreview(9, f.root, id);
    let refused: boolean | null = null;
    f.hook.fn = (n) => {
      if (n !== 'prepared') return;
      const t = f.backup.taskState();
      assert.equal(t?.cancellable, false);
      assert.equal(t?.phase, 'swapping');
      refused = f.backup.cancel(t?.id ?? '', 9, f.root);
    };
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.equal(refused, false);
    assert.equal(r.outcome, 'committed');
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-1');
  } finally {
    await f.done();
  }
});

test('退出：临界段中的 shutdown 等待恢复完成，不中止', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const p = await f.restore.restorePreview(9, f.root, id);
    let shut: Promise<void> | null = null;
    f.hook.fn = (n) => {
      if (n === 'old-moved') shut = f.backup.shutdown();
    };
    const r = await f.restore.restoreApply(p.token, ACK);
    assert.equal(r.outcome, 'committed');
    await shut;
    await assert.rejects(f.restore.restorePreview(9, f.root, id), isCode('backup-busy'));
  } finally {
    await f.done();
  }
});

test('恢复登记损坏：只读查看给出全局错误，预览与执行都拒绝；诊断保护列表抛错', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    await writeFile(path.join(f.appData, 'wtf-restore-registry.json'), '{"format":"x"}');
    const v = await f.restore.restorePending();
    assert.ok(v.registryError);
    await assert.rejects(f.restore.restorePreview(9, f.root, id), isCode('restore-registry'));
    await assert.rejects(f.restore.pendingProtectionPaths(), isCode('restore-registry'));
  } finally {
    await f.done();
  }
});

/** 模拟持有进程已退出：目标占用、登记证明、备份位置占用与 journal 中的占用证明里的 pid 一起改成不存在的进程 */
async function orphanAll(f: Setup): Promise<void> {
  const control = path.join(f.root, CONTROL_DIR);
  const patch = async (file: string, fn: (v: Record<string, unknown>) => void) => {
    const v = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    fn(v);
    await writeFile(file, JSON.stringify(v));
  };
  await patch(path.join(control, TARGET_LOCK), (v) => (v.pid = DEAD));
  await patch(path.join(f.appData, 'wtf-restore-registry.json'), (v) => {
    const e = (v.entries as Record<string, unknown>[])[0];
    (e.lock as Record<string, unknown>).pid = DEAD;
  });
  if (await stat(path.join(f.container, LOCK_NAME)).then(() => true, () => false)) await patch(path.join(f.container, LOCK_NAME), (v) => (v.pid = DEAD));
  const [tx] = (await readdir(control)).filter((n) => n.startsWith(TX_PREFIX));
  await patch(path.join(control, tx, 'journal.json'), (v) => {
    if (typeof v.sourceHold === 'string') {
      const h = JSON.parse(v.sourceHold) as Record<string, unknown>;
      h.pid = DEAD;
      v.sourceHold = JSON.stringify(h);
    }
  });
}

for (const at of ['sources-ready', 'old-moved', 'committed'] as const) {
  test(`在 ${at} 中断后：原目录已解绑也全局可见；重新确认后按登记处理，备份位置的占用按精确证明释放，之后可以备份`, async () => {
    const f = await setup();
    try {
      const id = await snapshot(f);
      await writeFile(path.join(f.wtf, 'Config.wtf'), 'cfg-2');
      const mutated = await readTree(f.wtf);
      const p = await f.restore.restorePreview(9, f.root, id);
      f.hook.fn = (n) => {
        if (n === at) throw new SimulatedCrash(n);
      };
      await assert.rejects(f.restore.restoreApply(p.token, ACK), (err: unknown) => err instanceof SimulatedCrash);
      f.hook.fn = null;
      await f.backup.shutdown();
      // 解绑原目录、另一个目录成为当前绑定
      f.ctx.current = f.root2;
      f.ctx.bound = [f.root2];
      const next = f.make();
      const view = await next.restore.restorePending();
      assert.equal(view.items.length, 1);
      assert.equal(view.items[0].root, f.root);
      const txid = view.items[0].txid as string;
      // 持有进程仍是“存活”的本进程：拒绝，不猜测
      await assert.rejects(next.restore.restoreResolve(txid, RACK), isCode('restore-lock'));
      await assert.rejects(next.restore.restoreResolve(txid, {}), isCode('restore-ack'));
      await orphanAll(f);
      const r = await next.restore.restoreResolve(txid, RACK);
      assert.equal(r.outcome, at === 'committed' ? 'finalized' : at === 'sources-ready' ? 'cleared' : 'rolled-back', r.message);
      if (at === 'committed') assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-1');
      else assert.deepEqual(await readTree(f.wtf), mutated);
      await assert.rejects(stat(path.join(f.container, LOCK_NAME)), { code: 'ENOENT' });
      assert.deepEqual((await next.restore.restorePending()).items, []);
      // 重新绑定原目录后可以照常备份与校验
      f.ctx.current = f.root;
      f.ctx.bound = [f.root];
      const again = (await next.backup.run(9, f.root, ALL)).snapshot.id;
      assert.equal((await next.backup.verify(9, f.root, again)).ok, true);
      await next.backup.shutdown();
    } finally {
      await f.done();
    }
  });
}

test('备份位置占用的属于其他用途或内容被改动：不删除，保留为待处理', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const p = await f.restore.restorePreview(9, f.root, id);
    f.hook.fn = (n) => {
      if (n === 'sources-ready') throw new SimulatedCrash(n);
    };
    await assert.rejects(f.restore.restoreApply(p.token, ACK), (err: unknown) => err instanceof SimulatedCrash);
    f.hook.fn = null;
    await f.backup.shutdown();
    await orphanAll(f);
    // 备份位置的占用标记被原位改动（txid 不同）
    const lockFile = path.join(f.container, LOCK_NAME);
    const v = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
    v.txid = 'f'.repeat(16);
    await writeFile(lockFile, JSON.stringify(v));
    const next = f.make();
    const txid = (await next.restore.restorePending()).items[0].txid as string;
    const r = await next.restore.restoreResolve(txid, RACK);
    assert.equal(r.outcome, 'cleanup-pending', r.message);
    assert.deepEqual(JSON.parse(await readFile(lockFile, 'utf8')), v);
    await next.backup.shutdown();
  } finally {
    await f.done();
  }
});

test('备份位置占用的删除未能确认写入磁盘：恢复已完成但待收尾；处理时同步后完成', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const p = await f.restore.restorePreview(9, f.root, id);
    const save = strictIo.syncDir;
    let armed = false;
    f.hook.fn = (n) => {
      if (n === 'cleanup') armed = true;
    };
    strictIo.syncDir = async (dir) => {
      if (armed && dir === f.container) {
        armed = false;
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return save(dir);
    };
    const r = await f.restore.restoreApply(p.token, ACK).finally(() => {
      strictIo.syncDir = save;
    });
    assert.equal(r.outcome, 'committed');
    assert.equal(r.cleanupPending, true);
    assert.equal((await f.restore.restorePending()).items.length, 1);
    f.hook.fn = null;
    const res = await f.restore.restoreResolve(r.txid, RACK);
    assert.equal(res.outcome, 'finalized', res.message);
    assert.deepEqual((await f.restore.restorePending()).items, []);
  } finally {
    await f.done();
  }
});

test('诊断保护列表：备份位置含已关闭的记录；恢复登记含未完成恢复的目录与备份位置；备份设置损坏时抛错', async () => {
  const f = await setup();
  try {
    await f.backup.disable(9, f.root);
    assert.deepEqual(await f.backup.registeredProtectionPaths(), [f.container]);
    assert.deepEqual(await f.restore.pendingProtectionPaths(), []);
    await writeFile(path.join(f.appData, 'wtf-backup.json'), 'not json');
    await assert.rejects(f.backup.registeredProtectionPaths(), isCode('backup-settings'));
  } finally {
    await f.done();
  }
});

// ---------- C1：恢复前备份的临时目录、占用证明与读取上限 ----------

const SAFETY_ID = '20261113-121314-abcdef12';

/** 直接经由 restoreBridge 生成一份恢复前备份；inject 在第二个文件复制之前执行（此时第一个文件已复制完） */
async function bridgeCopy(f: Setup, inject: (partialWtf: string) => Promise<void>) {
  const bridge = f.backup.restoreBridge();
  const rec = await bridge.enabledRecord(9, f.root);
  const ctr = await bridge.openContainer(rec);
  const task = bridge.begin('restore', 9, f.root, null, ALL);
  let n = 0;
  f.backupHook.fn = async (name) => {
    if (name === 'copy-file' && ++n === 2) await inject(path.join(ctr.path, PARTIAL_PREFIX + SAFETY_ID, 'WTF'));
  };
  try {
    const lock = await bridge.acquireLock(ctr.path, { token: 'a'.repeat(32), createdAt: 1 }, { taskKind: 'restore', taskId: task.info.id, txid: 'a'.repeat(16), nonce: 'b'.repeat(32), pid: process.pid, appVersion: 't' });
    const ledger: CopyLedger = { rootId: null, entries: new Map() };
    const error = await bridge.copy(task, rec, ctr, lock, {
      scope: ALL, id: SAFETY_ID, restoreTx: 'a'.repeat(16), ledger, cleanupPartial: (p) => cleanupSafetyPartial(bridge.limits, p),
    }).then(() => null, (err: unknown) => err as Error);
    return { error, partial: path.join(ctr.path, PARTIAL_PREFIX + SAFETY_ID) };
  } finally {
    f.backupHook.fn = null;
    bridge.end(task);
  }
}

test('恢复前备份复制失败：只含本次写入内容的临时目录被删除；已复制的文件被原地改写（同 inode）时整体保留', async () => {
  const f = await setup();
  try {
    const ok = await bridgeCopy(f, async () => {
      throw new UserError('注入故障', 'test-fault');
    });
    assert.ok(isCode('test-fault')(ok.error));
    await assert.rejects(stat(ok.partial), { code: 'ENOENT' });
    // 源 WTF 不变
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-1');
  } finally {
    await f.done();
  }
  const g = await setup();
  try {
    const kept = await bridgeCopy(g, async (partialWtf) => {
      const file = path.join(partialWtf, 'Config.wtf');
      const before = (await lstat(file, { bigint: true })).ino;
      await writeFile(file, 'CFG-X');
      assert.equal((await lstat(file, { bigint: true })).ino, before);
      throw new UserError('注入故障', 'test-fault');
    });
    assert.ok(isCode('test-fault')(kept.error));
    assert.match(kept.error?.message ?? '', /已保留/);
    assert.equal(await readFile(path.join(kept.partial, 'WTF', 'Config.wtf'), 'utf8'), 'CFG-X');
  } finally {
    await g.done();
  }
});

test('恢复前备份复制失败：已复制的文件或子目录被字节相同、身份不同的副本替换时不认领，整个临时目录保留', async () => {
  const f = await setup();
  try {
    const r = await bridgeCopy(f, async (partialWtf) => {
      const file = path.join(partialWtf, 'Config.wtf');
      await rename(file, `${file}.moved`);
      await cp(`${file}.moved`, file);
      await rm(`${file}.moved`);
      throw new UserError('注入故障', 'test-fault');
    });
    assert.ok(isCode('test-fault')(r.error));
    assert.match(r.error?.message ?? '', /已保留/);
    assert.equal(await readFile(path.join(r.partial, 'WTF', 'Config.wtf'), 'utf8'), 'cfg-1');
  } finally {
    await f.done();
  }
  const g = await setup();
  try {
    const r = await bridgeCopy(g, async (partialWtf) => {
      const dir = path.join(partialWtf, 'Account');
      await rename(dir, `${dir}.moved`);
      await cp(`${dir}.moved`, dir, { recursive: true });
      await rm(`${dir}.moved`, { recursive: true });
      throw new UserError('注入故障', 'test-fault');
    });
    assert.ok(isCode('test-fault')(r.error));
    assert.match(r.error?.message ?? '', /已保留/);
    assert.ok((await stat(path.join(r.partial, 'WTF', 'Account'))).isDirectory());
    assert.ok((await stat(path.join(r.partial, 'WTF', 'Config.wtf'))).isFile());
  } finally {
    await g.done();
  }
});

test('恢复前备份复制中断（模拟崩溃）：处理时临时目录保留并给出精确位置，不宣称已清理；移走后再次处理完成，之后可以备份', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f);
    const p = await f.restore.restorePreview(9, f.root, id);
    let n = 0;
    f.backupHook.fn = (name) => {
      if (name === 'copy-file' && ++n === 2) throw new SimulatedCrash(name);
    };
    await assert.rejects(f.restore.restoreApply(p.token, ACK), (err: unknown) => err instanceof SimulatedCrash);
    f.backupHook.fn = null;
    await f.backup.shutdown();
    await orphanAll(f);
    const next = f.make();
    const txid = (await next.restore.restorePending()).items[0].txid as string;
    const r = await next.restore.restoreResolve(txid, RACK);
    assert.equal(r.outcome, 'cleanup-pending', r.message);
    const partial = (await readdir(f.container)).find((x) => x.startsWith(PARTIAL_PREFIX)) as string;
    assert.ok(partial);
    assert.ok(r.message.includes(path.join(f.container, partial)));
    const item = (await next.restore.restorePending()).items[0];
    assert.equal(item.containerPath, f.container);
    assert.ok(item.reason?.includes(partial));
    assert.equal((await next.backup.state(9, f.root)).canCreate, false);
    // 用户移走临时目录后再次处理
    await rm(path.join(f.container, partial), { recursive: true });
    const r2 = await next.restore.restoreResolve(txid, RACK);
    assert.equal(r2.outcome, 'cleared', r2.message);
    await assert.rejects(stat(path.join(f.container, LOCK_NAME)), { code: 'ENOENT' });
    assert.deepEqual((await next.restore.restorePending()).items, []);
    assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-1');
    assert.ok((await next.backup.run(9, f.root, ALL)).snapshot.id);
    await next.backup.shutdown();
  } finally {
    await f.done();
  }
});

for (const field of ['taskId', 'appVersion'] as const) {
  test(`备份位置占用标记的 ${field} 被原位改写：不再认作本次的占用，不删除，保留为待处理`, async () => {
    const f = await setup();
    try {
      const id = await snapshot(f);
      const p = await f.restore.restorePreview(9, f.root, id);
      const lockFile = path.join(f.container, LOCK_NAME);
      let patched = '';
      f.hook.fn = async (n) => {
        if (n !== 'sources-ready') return;
        const v = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
        v[field] = `${String(v[field])}-x`;
        patched = JSON.stringify(v);
        await writeFile(lockFile, patched);
      };
      await assert.rejects(f.restore.restoreApply(p.token, ACK), isCode('restore-changed'));
      assert.equal(await readFile(lockFile, 'utf8'), patched);
      assert.equal((await f.restore.restorePending()).items.length, 1);
      assert.equal(await readFile(path.join(f.wtf, 'Config.wtf'), 'utf8'), 'cfg-1');
    } finally {
      await f.done();
    }
  });
}

test('当前 WTF 的总大小超出上限：预览在读取任何文件内容之前拒绝', async () => {
  const f = await setup();
  try {
    const id = await snapshot(f, { kind: 'account', account: 'BRAVO' });
    const small = f.make({ maxSnapshotBytes: 12 });
    const mod = require('node:fs/promises') as Record<string, unknown>;
    const orig = mod.open as (...a: unknown[]) => unknown;
    const opened: string[] = [];
    mod.open = (...args: unknown[]) => {
      if (String(args[0]).startsWith(f.wtf + path.sep)) opened.push(String(args[0]));
      return orig(...args);
    };
    try {
      await assert.rejects(small.restore.restorePreview(9, f.root, id), isCode('restore-limit'));
    } finally {
      mod.open = orig;
    }
    assert.deepEqual(opened, [], '没有打开当前 WTF 中的任何文件');
    await small.backup.shutdown();
  } finally {
    await f.done();
  }
});

test('只读查看：已绑定目录的工作目录无法检查时列入 scanErrors', async () => {
  const f = await setup();
  try {
    await writeFile(path.join(f.root, CONTROL_DIR), 'not a directory');
    const v = await f.restore.restorePending();
    assert.equal(v.scanErrors.length, 1);
    assert.equal(v.registryError, null);
  } finally {
    await f.done();
  }
});
