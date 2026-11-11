// WTF 配置备份核心：只使用 mkdtemp 生成的临时目录（独立的游戏目录、应用数据、设置文件与保存位置），不读取真实玩家数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { io, type WriteFn } from '../src/core/fsio';
import { CONTAINER_PREFIX, LOCK_NAME, MANIFEST_NAME, MARKER_NAME, WtfBackupService, type BackupStep } from '../src/core/wtf-backup';
import type { BackupLimits, BackupState } from '../src/shared/backup-types';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 测试钩子：在指定阶段暂停任务，直到 release；onStep 可在任意阶段改动文件 */
class Pauser {
  private armed: { at: BackupStep; reached: ReturnType<typeof deferred<void>>; gate: ReturnType<typeof deferred<void>> } | null = null;
  onStep: ((name: BackupStep, detail?: string) => Promise<void> | void) | null = null;

  arm(at: BackupStep): { reached: Promise<void>; release: () => void } {
    const a = { at, reached: deferred<void>(), gate: deferred<void>() };
    this.armed = a;
    return { reached: a.reached.promise, release: () => a.gate.resolve() };
  }

  async step(name: BackupStep, detail?: string): Promise<void> {
    if (this.onStep) await this.onStep(name, detail);
    const a = this.armed;
    if (a && a.at === name) {
      this.armed = null;
      a.reached.resolve();
      await a.gate.promise;
    }
  }
}

/** tmpParent 仅用于需要较短路径的用例（Unix socket 路径长度有限），仍在其下自建临时目录 */
async function setup(limits?: Partial<BackupLimits>, tmpParent = os.tmpdir()) {
  const base = await realpath(await mkdtemp(path.join(tmpParent, 'azercube-wtf-test-')));
  const root = path.join(base, 'games', '_classic_');
  const root2 = path.join(base, 'games', '_classic_era_');
  const appData = path.join(base, 'appData');
  const picked = path.join(base, 'Desktop');
  const picked2 = path.join(base, 'Documents');
  for (const d of [path.join(root, 'WTF'), path.join(root2, 'WTF'), appData, picked, picked2]) await mkdir(d, { recursive: true });
  const ctx = { current: root, bound: [root] };
  const pause = new Pauser();
  const services: WtfBackupService[] = [];
  const make = () => {
    const s = new WtfBackupService({
      settingsFile: path.join(appData, 'wtf-backup.json'),
      appDataDir: appData,
      appVersion: '0.2.0-test',
      resolveRoot: async () => ctx.current,
      listBoundRoots: async () => [...ctx.bound],
      limits,
      hooks: { step: (name, detail) => pause.step(name, detail) },
    });
    services.push(s);
    return s;
  };
  const svc = make();
  const done = async () => {
    for (const s of services) await s.shutdown();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, root2, wtf: path.join(root, 'WTF'), appData, picked, picked2, ctx, pause, svc, make, done };
}

const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tick = () => new Promise<void>((r) => setImmediate(r));
const mode = async (p: string) => (await stat(p)).mode & 0o777;

/** 只在第一次到达指定阶段（及可选的 detail）时执行一次改动 */
function onceAt(pause: Pauser, at: BackupStep, act: () => Promise<unknown>, detail?: string): () => boolean {
  let fired = false;
  pause.onStep = async (name, d) => {
    if (fired || name !== at || (detail !== undefined && d !== detail)) return;
    fired = true;
    await act();
  };
  return () => fired;
}

/** 同大小改写：翻转最后一个字节 */
async function flip(file: string): Promise<void> {
  const b = await readFile(file);
  b[b.length - 1] ^= 1;
  await writeFile(file, b);
}

async function put(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** 目录树的完整记录：类型、权限、大小、修改时间与内容校验值 */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, rel: string) => {
    const st = await lstat(p);
    if (st.isDirectory()) {
      out.push(`${rel}|dir|${st.mode & 0o777}|${st.mtimeMs}`);
      for (const n of (await readdir(p)).sort()) await walk(path.join(p, n), `${rel}/${n}`);
    } else {
      out.push(`${rel}|${st.isFile() ? 'file' : 'other'}|${st.mode & 0o777}|${st.size}|${st.mtimeMs}|${st.isFile() ? sha(await readFile(p)) : ''}`);
    }
  };
  await walk(dir, '.');
  return out;
}

/** 记录对 prefix（含其下路径）的文件系统访问；核心模块在调用时读取 fs/promises 的导出，因此可被替换观察 */
function watchAccess(prefix: string): { calls: string[]; restore: () => void } {
  const mod = require('node:fs/promises') as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const calls: string[] = [];
  for (const n of ['open', 'opendir', 'lstat', 'stat', 'realpath', 'readdir', 'readFile']) {
    const orig = mod[n] as (...a: unknown[]) => unknown;
    saved.set(n, orig);
    mod[n] = (...args: unknown[]) => {
      const p = String(args[0]);
      if (p === prefix || p.startsWith(prefix + path.sep)) calls.push(`${n}:${p}`);
      return orig(...args);
    };
  }
  return { calls, restore: () => saved.forEach((fn, n) => (mod[n] = fn)) };
}

test('默认关闭：state / taskState 不读取 WTF、不创建容器；configure 也不读取 WTF', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const spy = watchAccess(f.wtf);
  try {
    const s = await f.svc.state(9, f.root);
    assert.equal(s.status, 'disabled');
    assert.equal(s.containerPath, null);
    assert.equal(f.svc.taskState(), null);
    assert.deepEqual(await readdir(f.picked), []);
    const enabled = await f.svc.configure(9, f.root, f.picked);
    assert.equal(enabled.status, 'ready');
    assert.equal(enabled.snapshots.length, 0);
    assert.equal(enabled.canCreate, true);
    assert.deepEqual(spy.calls, [], '启用前后都不应访问 WTF');
  } finally {
    spy.restore();
  }
  const names = await readdir(f.picked);
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(CONTAINER_PREFIX));
  assert.equal(await mode(path.join(f.picked, names[0])), 0o700);
  assert.equal(await mode(path.join(f.picked, names[0], MARKER_NAME)), 0o600);
  assert.equal(await mode(path.join(f.appData, 'wtf-backup.json')), 0o600);
  assert.equal(f.svc.taskState(), null);
  await f.done();
});

test('备份成功：多账号、中文路径、空目录与源中 .DS_Store；源不变，清单逐文件校验值，权限 0700/0600，查看位置只接受安全编号', async () => {
  const f = await setup();
  const files: Record<string, Buffer> = {
    'Config.wtf': Buffer.from('SET textLocale "zhCN"\n'),
    '.DS_Store': Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]),
    'Account/玩家甲/SavedVariables/Questie.lua': Buffer.from('QuestieConfig = { ["中文"] = true }\n'),
    'Account/ACCOUNT2/服务器/角色/AddOns.txt': Buffer.from([0, 1, 2, 255, 254, 10]),
  };
  for (const [rel, data] of Object.entries(files)) await put(path.join(f.wtf, ...rel.split('/')), data);
  await mkdir(path.join(f.wtf, 'Account', 'ACCOUNT2', 'Empty'));
  const before = await tree(f.wtf);
  const enabled = await f.svc.configure(9, f.root, f.picked);
  const container = enabled.containerPath!;

  const r = await f.svc.run(9, f.root);
  assert.equal(r.snapshot.status, 'structure-ok');
  assert.equal(r.snapshot.fileCount, 4);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(await tree(f.wtf), before, '源目录必须逐字节、逐权限、逐时间不变');

  const snap = path.join(container, r.snapshot.id);
  const manifest = JSON.parse(await readFile(path.join(snap, MANIFEST_NAME), 'utf8')) as { flavorId: number; fileCount: number; entries: { path: string; type: string; size?: number; sha256?: string }[] };
  assert.equal(manifest.flavorId, 9);
  assert.equal(manifest.fileCount, 4);
  for (const [rel, data] of Object.entries(files)) {
    const e = manifest.entries.find((x) => x.path === rel);
    assert.ok(e, rel);
    assert.equal(e.type, 'file');
    assert.equal(e.size, data.length);
    assert.equal(e.sha256, sha(data));
    const copy = path.join(snap, 'WTF', ...rel.split('/'));
    assert.deepEqual(await readFile(copy), data);
    assert.equal(await mode(copy), 0o600);
  }
  assert.ok(manifest.entries.some((x) => x.path === 'Account/ACCOUNT2/Empty' && x.type === 'dir'));
  for (const d of [container, snap, path.join(snap, 'WTF'), path.join(snap, 'WTF', 'Account', 'ACCOUNT2', 'Empty')]) assert.equal(await mode(d), 0o700, d);
  assert.equal(await mode(path.join(snap, MANIFEST_NAME)), 0o600);
  assert.ok(!(await readdir(container)).includes(LOCK_NAME));

  const v = await f.svc.verify(9, f.root, r.snapshot.id);
  assert.equal(v.ok, true);
  assert.equal(v.checkedFiles, 4);
  const s = await f.svc.state(9, f.root);
  assert.equal(s.snapshots.length, 1);
  assert.equal(s.snapshots[0].lastVerify?.ok, true);
  assert.deepEqual(await tree(f.wtf), before);

  assert.equal(await f.svc.revealPath(9, f.root), container);
  assert.equal(await f.svc.revealPath(9, f.root, r.snapshot.id), snap);
  await assert.rejects(f.svc.revealPath(9, f.root, '../../etc'), /备份编号无效/);
  await assert.rejects(f.svc.revealPath(9, f.root, '20000101-000000-00000000'), isCode('backup-snapshot'));
  await f.done();
});

test('限额边界：maxEntries=1、maxSnapshots=1 时单文件首份成功，第二份被拒且旧备份保留；满额提示不称本次失败', async () => {
  const f = await setup({ maxEntries: 1, maxSnapshots: 1 });
  await put(path.join(f.wtf, 'Config.wtf'), 'x');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const first = await f.svc.run(9, f.root);
  assert.equal(first.snapshot.status, 'structure-ok');

  const s = await f.svc.state(9, f.root);
  assert.equal(s.canCreate, false);
  assert.match(s.error ?? '', /已达到备份份数/);
  assert.doesNotMatch(s.error ?? '', /本次备份未完成/);
  await assert.rejects(f.svc.run(9, f.root), (err: unknown) => isCode('backup-limit')(err) && !/本次备份未完成/.test((err as Error).message));
  const names = await readdir(container);
  assert.ok(names.includes(first.snapshot.id));
  assert.ok(!names.some((n) => n.startsWith('.partial-')));
  assert.equal((await f.svc.verify(9, f.root, first.snapshot.id)).ok, true);
  await f.done();
});

test('final-check 阶段外来大文件导致超出总占用：不发布、不删除外来文件，源与历史备份不变', async () => {
  const f = await setup({ maxTotalBytes: 4096 });
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const first = await f.svc.run(9, f.root);
  const before = await tree(f.wtf);
  const history = await tree(path.join(container, first.snapshot.id));

  const foreign = path.join(container, 'foreign.bin');
  f.pause.onStep = async (name) => {
    if (name === 'final-check') await writeFile(foreign, Buffer.alloc(8192, 7));
  };
  await assert.rejects(f.svc.run(9, f.root), (err: unknown) => isCode('backup-container')(err) || isCode('backup-limit')(err));
  f.pause.onStep = null;

  const names = (await readdir(container)).sort();
  assert.deepEqual(names, [MARKER_NAME, first.snapshot.id, 'foreign.bin'].sort(), '不得发布新备份、不得遗留临时目录或占用标记');
  assert.equal((await stat(foreign)).size, 8192);
  assert.deepEqual(await tree(f.wtf), before);
  assert.deepEqual(await tree(path.join(container, first.snapshot.id)), history);
  const s = await f.svc.state(9, f.root);
  assert.equal(s.canCreate, false);
  assert.ok(s.anomalies.some((a) => a.name === 'foreign.bin' && a.kind === 'foreign'));
  await f.done();
});

test('任务占位与取消：taskState 是克隆；重复受理被拒；只有 id+flavor+root 一致才取消；Promise 在收尾后才结束', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const p = f.pause.arm('copy-file');
  const run = f.svc.run(9, f.root);
  let settled = false;
  const outcome = run.then(
    () => null,
    (e: unknown) => e,
  );
  void outcome.then(() => (settled = true));
  await p.reached;

  const t = f.svc.taskState()!;
  assert.equal(t.kind, 'run');
  assert.equal(t.root, f.root);
  assert.equal(t.phase, 'copying');
  t.phase = 'cleanup';
  t.cancelling = true;
  assert.equal(f.svc.taskState()!.phase, 'copying', 'taskState 返回的对象不能修改内部状态');
  assert.equal(f.svc.taskState()!.cancelling, false);
  assert.ok((await readdir(container)).some((n) => n.startsWith('.partial-')));
  assert.ok((await readdir(container)).includes(LOCK_NAME));

  await assert.rejects(f.svc.run(9, f.root), isCode('backup-busy'));
  await assert.rejects(f.svc.verify(9, f.root, '20000101-000000-00000000'), isCode('backup-busy'));
  await assert.rejects(f.svc.disable(9, f.root), isCode('backup-busy'));
  assert.equal(f.svc.cancel('other-id', 9, f.root), false);
  assert.equal(f.svc.cancel(t.id, 10, f.root), false);
  assert.equal(f.svc.cancel(t.id, 9, f.root2), false);
  assert.equal(f.svc.cancel(t.id, 9, f.root), true);
  assert.equal(f.svc.taskState()!.cancelling, true);

  await tick();
  assert.equal(settled, false, '任务仍停在钩子中，Promise 不能提前结束');
  p.release();
  assert.ok(isCode('backup-cancelled')(await outcome));
  assert.equal(f.svc.taskState(), null);
  assert.deepEqual(await readdir(container), [MARKER_NAME], '临时目录与占用标记都已收尾');
  await f.done();
});

test('换绑：已受理任务仍可用原 root 取消；旧取消不影响新任务；新目录不继承启用，切回原目录保留启用', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'old\n');
  await put(path.join(f.root2, 'WTF', 'Config.wtf'), 'new\n');
  const firstContainer = (await f.svc.configure(9, f.root, f.picked)).containerPath!;

  const p1 = f.pause.arm('copy-file');
  const run1 = f.svc.run(9, f.root).then(
    () => null,
    (e: unknown) => e,
  );
  await p1.reached;
  const t1 = f.svc.taskState()!;

  f.ctx.current = f.root2;
  f.ctx.bound = [f.root2];
  await assert.rejects(f.svc.state(9, f.root), isCode('target'));
  const fresh = await f.svc.state(9, f.root2);
  assert.equal(fresh.status, 'disabled', '新目录不能继承旧目录的启用状态');
  assert.equal(fresh.activeTask?.id, t1.id);
  assert.equal(f.svc.cancel(t1.id, 9, f.root), true, '换绑后仍可用受理时的目录取消');
  p1.release();
  assert.ok(isCode('backup-cancelled')(await run1));

  await f.svc.configure(9, f.root2, f.picked2);
  const p2 = f.pause.arm('copy-file');
  const run2 = f.svc.run(9, f.root2);
  await p2.reached;
  assert.equal(f.svc.cancel(t1.id, 9, f.root), false, '旧任务的取消不能作用于新任务');
  assert.equal(f.svc.taskState()!.cancelling, false);
  p2.release();
  assert.equal((await run2).snapshot.status, 'structure-ok');

  f.ctx.current = f.root;
  f.ctx.bound = [f.root];
  const back = await f.svc.state(9, f.root);
  assert.equal(back.status, 'ready');
  assert.equal(back.containerPath, firstContainer);
  assert.equal(back.snapshots.length, 0);
  await f.done();
});

test('跨实例：容器占用标记互斥；既有旧标记保留不回收，可查看位置并另选新位置继续；shutdown 取消并等待，之后拒绝新任务', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const other = f.make();

  const p = f.pause.arm('copy-file');
  const runA = f.svc.run(9, f.root);
  await p.reached;
  await assert.rejects(other.run(9, f.root), (err: unknown) => isCode('backup-lock')(err) && (err as Error).message.includes(path.join(container, LOCK_NAME)));
  const seen = await other.state(9, f.root);
  assert.equal(seen.canCreate, false);
  assert.ok(seen.anomalies.some((a) => a.kind === 'lock'));
  p.release();
  await runA;
  assert.equal((await other.run(9, f.root)).snapshot.status, 'structure-ok');

  // 模拟上次中断遗留的占用标记：不判断、不回收
  const stale = path.join(container, LOCK_NAME);
  await writeFile(stale, '{"left":"by crash"}');
  await assert.rejects(f.svc.run(9, f.root), isCode('backup-lock'));
  await assert.rejects(f.svc.verify(9, f.root, (await f.svc.state(9, f.root)).snapshots[0].id), isCode('backup-lock'));
  assert.equal(await readFile(stale, 'utf8'), '{"left":"by crash"}');
  assert.equal(await f.svc.revealPath(9, f.root), container);
  const moved = await f.svc.configure(9, f.root, f.picked2);
  assert.notEqual(moved.containerPath, container);
  assert.equal((await f.svc.run(9, f.root)).snapshot.status, 'structure-ok');
  assert.equal(await readFile(stale, 'utf8'), '{"left":"by crash"}', '旧位置的标记仍保留');

  const q = f.pause.arm('copy-file');
  const runB = f.svc.run(9, f.root).then(
    () => null,
    (e: unknown) => e,
  );
  await q.reached;
  let closed = false;
  const sd = f.svc.shutdown().then(() => (closed = true));
  await tick();
  assert.equal(closed, false, 'shutdown 必须等待任务收尾');
  q.release();
  await sd;
  assert.ok(isCode('backup-cancelled')(await runB));
  assert.deepEqual((await readdir(moved.containerPath!)).filter((n) => n.startsWith('.partial-') || n === LOCK_NAME), []);
  await assert.rejects(f.svc.run(9, f.root), isCode('backup-busy'));
  await f.done();
});

test('校验保护：容器后来成为另一个已绑定游戏目录时 verify 在写占用标记前拒绝；清单游戏版本被改后 state 标为无效、verify 不通过', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const r = await f.svc.run(9, f.root);

  f.ctx.bound = [f.root, container];
  const realWrite = io.write;
  let writes = 0;
  io.write = (fh, buf, offset, length) => {
    writes++;
    return realWrite(fh, buf, offset, length);
  };
  try {
    await assert.rejects(f.svc.verify(9, f.root, r.snapshot.id), isCode('backup-location'));
    await assert.rejects(f.svc.run(9, f.root), isCode('backup-location'));
  } finally {
    io.write = realWrite;
  }
  assert.equal(writes, 0, '被拒绝前不得写入任何占用标记');
  assert.ok(!(await readdir(container)).includes(LOCK_NAME));
  f.ctx.bound = [f.root];

  const manifestPath = path.join(container, r.snapshot.id, MANIFEST_NAME);
  const m = JSON.parse(await readFile(manifestPath, 'utf8')) as { flavorId: number };
  m.flavorId = 2;
  await writeFile(manifestPath, JSON.stringify(m, null, 1));
  const s = await f.svc.state(9, f.root);
  assert.equal(s.snapshots[0].status, 'invalid');
  assert.equal(s.canCreate, false);
  const v = await f.svc.verify(9, f.root, r.snapshot.id);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /游戏版本/);
  const after = await f.svc.state(9, f.root);
  assert.equal(after.snapshots[0].status, 'invalid');
  assert.equal(after.snapshots[0].lastVerify?.ok, false, '创建时的通过记录必须被本次不通过覆盖');
  await f.done();
});

test('源中的符号链接（WTF 根、子文件、子目录）、多硬链接文件与 Unix socket 都整份拒绝；源与外部文件不变，不发布、不留占用', async () => {
  const f = await setup(undefined, '/tmp');
  const outside = path.join(f.base, 'outside');
  await put(path.join(outside, 'secret.lua'), 'outside\n');
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const outsideBefore = await tree(outside);
  const realWtf = path.join(f.base, 'wtf-real');
  const sock = path.join(f.wtf, 's.sock');
  const server = net.createServer();
  const cases: { name: string; arrange: () => Promise<void>; restore: () => Promise<void> }[] = [
    {
      name: 'WTF 根是符号链接',
      arrange: async () => {
        await rename(f.wtf, realWtf);
        await symlink(realWtf, f.wtf);
      },
      restore: async () => {
        await unlink(f.wtf);
        await rename(realWtf, f.wtf);
      },
    },
    { name: '子文件是符号链接', arrange: () => symlink(path.join(outside, 'secret.lua'), path.join(f.wtf, 'link.lua')), restore: () => unlink(path.join(f.wtf, 'link.lua')) },
    { name: '子目录是符号链接', arrange: () => symlink(outside, path.join(f.wtf, 'Account')), restore: () => unlink(path.join(f.wtf, 'Account')) },
    { name: '普通文件有多个硬链接', arrange: () => link(path.join(outside, 'secret.lua'), path.join(f.wtf, 'hard.lua')), restore: () => unlink(path.join(f.wtf, 'hard.lua')) },
    {
      name: 'Unix socket',
      arrange: () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(sock, () => resolve());
        }),
      restore: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(sock, { force: true });
      },
    },
  ];
  try {
    for (const c of cases) {
      await c.arrange();
      const before = await tree(f.wtf);
      await assert.rejects(f.svc.run(9, f.root), isCode('backup-unsupported-entry'), c.name);
      assert.deepEqual(await tree(f.wtf), before, c.name);
      assert.deepEqual(await readdir(container), [MARKER_NAME], `${c.name}：不发布、不留临时目录或占用标记`);
      await c.restore();
    }
  } finally {
    server.close();
  }
  assert.deepEqual(await tree(outside), outsideBefore);
  assert.equal((await f.svc.run(9, f.root)).snapshot.status, 'structure-ok', '恢复为普通文件后可以正常备份');
  await f.done();
});

test('备份中的硬链接与符号链接（负载、清单、位置标记）不被 state / verify 当作正常；原文件不被改动', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const r = await f.svc.run(9, f.root);
  const snap = path.join(container, r.snapshot.id);
  const payload = path.join(snap, 'WTF', 'Config.wtf');
  const original = await readFile(payload);
  const extra = path.join(f.base, 'extra-link');
  const cases: { name: string; arrange: () => Promise<void>; restore: () => Promise<void> }[] = [
    { name: '负载有多个硬链接', arrange: () => link(payload, extra), restore: () => unlink(extra) },
    { name: '清单有多个硬链接', arrange: () => link(path.join(snap, MANIFEST_NAME), extra), restore: () => unlink(extra) },
    {
      name: '负载被换成符号链接',
      arrange: async () => {
        await rename(payload, extra);
        await symlink(extra, payload);
      },
      restore: async () => {
        await unlink(payload);
        await rename(extra, payload);
      },
    },
  ];
  for (const c of cases) {
    await c.arrange();
    const s = await f.svc.state(9, f.root);
    assert.notEqual(s.snapshots[0].status, 'structure-ok', c.name);
    assert.equal(s.canCreate, false, c.name);
    assert.equal((await f.svc.verify(9, f.root, r.snapshot.id)).ok, false, c.name);
    await c.restore();
    assert.deepEqual(await readFile(payload), original, c.name);
  }

  await link(path.join(container, MARKER_NAME), extra);
  assert.equal((await f.svc.state(9, f.root)).status, 'unavailable', '位置标记有多个硬链接时不能使用该位置');
  await assert.rejects(f.svc.verify(9, f.root, r.snapshot.id), isCode('backup-container'));
  await assert.rejects(f.svc.run(9, f.root), isCode('backup-container'));
  await unlink(extra);

  assert.equal((await f.svc.state(9, f.root)).snapshots[0].status, 'structure-ok');
  assert.equal((await f.svc.verify(9, f.root, r.snapshot.id)).ok, true);
  await f.done();
});

test('位置规则：拒绝当前与其他已绑定游戏目录内、应用数据目录内及指向它们的链接；游戏目录的上级与桌面允许；失败不改设置', async () => {
  const f = await setup();
  f.ctx.bound = [f.root, f.root2];
  await mkdir(path.join(f.root, 'Interface', 'AddOns'), { recursive: true });
  await mkdir(path.join(f.appData, 'sub'));
  const sneaky = path.join(f.base, 'sneaky');
  await symlink(path.join(f.root, 'Interface'), sneaky);
  const wtfLink = path.join(f.base, 'wtf-link');
  await symlink(f.wtf, wtfLink);
  assert.equal((await f.svc.configure(9, f.root, f.picked)).status, 'ready');
  const settings = path.join(f.appData, 'wtf-backup.json');
  const saved = await readFile(settings);

  const rejected = [f.root, f.wtf, path.join(f.root, 'Interface', 'AddOns'), f.root2, path.join(f.root2, 'WTF'), f.appData, path.join(f.appData, 'sub'), sneaky, wtfLink];
  for (const bad of rejected) await assert.rejects(f.svc.configure(9, f.root, bad), isCode('backup-location'), bad);
  assert.deepEqual(await readFile(settings), saved);
  for (const dir of [f.root, f.wtf, path.join(f.root, 'Interface'), path.join(f.root, 'Interface', 'AddOns'), f.root2, path.join(f.root2, 'WTF'), path.join(f.appData, 'sub')]) {
    assert.ok(!(await readdir(dir)).some((n) => n.startsWith(CONTAINER_PREFIX)), dir);
  }
  assert.deepEqual((await readdir(f.appData)).sort(), ['sub', 'wtf-backup.json']);

  const sibling = await f.svc.configure(9, f.root, path.dirname(f.root));
  assert.equal(path.dirname(sibling.containerPath!), path.dirname(f.root), '游戏目录的上级目录中新建专属容器是允许的');
  await f.done();
});

test('启用过程中换绑或保存位置被搬走：拒绝、原设置保留、不读 WTF；撤回不经由被替换的父路径删除，现场保留并说明', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'Config.wtf'), 'x');
  await f.svc.configure(9, f.root, f.picked);
  const settings = path.join(f.appData, 'wtf-backup.json');
  const saved = await readFile(settings);
  const moved = path.join(f.base, 'Moved');
  const spy = watchAccess(f.wtf);
  try {
    for (const at of ['configure-before-create', 'configure-before-commit'] as const) {
      onceAt(f.pause, at, async () => {
        f.ctx.current = f.root2;
      });
      await assert.rejects(f.svc.configure(9, f.root, f.picked2), isCode('target'), at);
      f.pause.onStep = null;
      f.ctx.current = f.root;
      assert.deepEqual(await readdir(f.picked2), [], `${at}：本次新建的容器已撤回`);
      assert.deepEqual(await readFile(settings), saved, at);
    }

    const fired = onceAt(f.pause, 'configure-before-commit', async () => {
      await rename(f.picked2, moved);
      await symlink(moved, f.picked2);
    });
    await assert.rejects(f.svc.configure(9, f.root, f.picked2), (err: unknown) => isCode('backup-path-changed')(err) && /已保留/.test((err as Error).message));
    f.pause.onStep = null;
    assert.ok(fired());
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], '启用过程不读取 WTF');
  const kept = await readdir(moved);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith(CONTAINER_PREFIX));
  assert.ok((await readdir(path.join(moved, kept[0]))).includes(MARKER_NAME), '搬走后的新容器与标记都保留');
  assert.deepEqual(await readFile(settings), saved);
  assert.deepEqual(await readdir(f.appData), ['wtf-backup.json'], '设置占用标记已释放');
  await f.done();
});

test('源在复制、复核、写清单、发布前与最终检查阶段被同大小改写、新增或删除：备份失败、不发布；其他游戏目录与旧备份不变', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'A.lua'), 'AAAA');
  await put(path.join(f.wtf, 'B.lua'), 'BBBB');
  await put(path.join(f.root2, 'WTF', 'Other.lua'), 'other');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const old = await f.svc.run(9, f.root);
  const oldTree = await tree(path.join(container, old.snapshot.id));
  const otherTree = await tree(path.join(f.root2, 'WTF'));
  let n = 0;
  const rewrite = (rel: string) => writeFile(path.join(f.wtf, rel), String(++n).padStart(4, 'z'));
  const cases: { at: BackupStep; detail?: string; what: string; act: () => Promise<void> }[] = [
    { at: 'copy-file', detail: 'A.lua', what: '复制前同大小改写', act: () => rewrite('A.lua') },
    { at: 'source-recheck', what: '新增文件', act: () => writeFile(path.join(f.wtf, 'New.lua'), 'new') },
    { at: 'manifest-write', what: '删除文件', act: () => unlink(path.join(f.wtf, 'New.lua')) },
    { at: 'before-publish', what: '同大小改写', act: () => rewrite('B.lua') },
    { at: 'final-check', what: '同大小改写', act: () => rewrite('A.lua') },
  ];
  for (const c of cases) {
    const fired = onceAt(f.pause, c.at, c.act, c.detail);
    await assert.rejects(f.svc.run(9, f.root), isCode('backup-source-changed'), `${c.at} ${c.what}`);
    f.pause.onStep = null;
    assert.ok(fired(), c.at);
    assert.deepEqual((await readdir(container)).sort(), [MARKER_NAME, old.snapshot.id].sort(), c.at);
    assert.deepEqual(await tree(path.join(container, old.snapshot.id)), oldTree, c.at);
  }
  assert.deepEqual(await tree(path.join(f.root2, 'WTF')), otherTree);
  await f.done();
});

test('本次临时目录的负载或清单在核对阶段被同大小改写或多出条目：不发布、不记成功；外来文件不被删除', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'A.lua'), 'AAAA');
  await put(path.join(f.wtf, 'B.lua'), 'BBBB');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const partial = async () => path.join(container, (await readdir(container)).find((x) => x.startsWith('.partial-'))!);
  let foreign = '';
  const cases: { at: BackupStep; what: string; act: () => Promise<void> }[] = [
    { at: 'target-recheck', what: '负载同大小改写', act: async () => flip(path.join(await partial(), 'WTF', 'A.lua')) },
    { at: 'target-recheck', what: '清单同大小改写', act: async () => flip(path.join(await partial(), MANIFEST_NAME)) },
    { at: 'final-check', what: '负载同大小改写', act: async () => flip(path.join(await partial(), 'WTF', 'B.lua')) },
    { at: 'final-check', what: '清单同大小改写', act: async () => flip(path.join(await partial(), MANIFEST_NAME)) },
    {
      at: 'target-recheck',
      what: '多出外来文件',
      act: async () => {
        foreign = path.join(await partial(), 'WTF', 'foreign.lua');
        await writeFile(foreign, 'not ours');
      },
    },
  ];
  for (const c of cases) {
    const fired = onceAt(f.pause, c.at, c.act);
    await assert.rejects(f.svc.run(9, f.root), isCode('backup-verify-failed'), `${c.at} ${c.what}`);
    f.pause.onStep = null;
    assert.ok(fired(), c.at);
    const s = await f.svc.state(9, f.root);
    assert.equal(s.snapshots.length, 0, `${c.at} ${c.what}：不得发布`);
  }
  assert.equal(await readFile(foreign, 'utf8'), 'not ours', '外来文件与其所在的临时目录保留');
  const s = await f.svc.state(9, f.root);
  assert.ok(s.anomalies.some((a) => a.kind === 'incomplete'));
  assert.equal(s.canCreate, false);
  await f.done();
});

test('重新校验期间改动已检文件、清单、增删文件或替换目录：verify 不通过，lastVerify 记为不通过', async () => {
  const f = await setup();
  await put(path.join(f.wtf, 'A.lua'), 'AAAA');
  await put(path.join(f.wtf, 'B.lua'), 'BBBB');
  const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await f.svc.run(9, f.root)).snapshot.id);
  const cases: { at: BackupStep; detail?: string; what: string; act: (snap: string) => Promise<void> }[] = [
    { at: 'verify-file', detail: 'B.lua', what: '改写已校验过的文件', act: (s) => flip(path.join(s, 'WTF', 'A.lua')) },
    { at: 'verify-final', what: '改写清单', act: (s) => flip(path.join(s, MANIFEST_NAME)) },
    { at: 'verify-final', what: '新增文件', act: (s) => writeFile(path.join(s, 'WTF', 'new.lua'), 'n') },
    { at: 'verify-final', what: '删除文件', act: (s) => unlink(path.join(s, 'WTF', 'B.lua')) },
    {
      at: 'verify-final',
      what: '替换 WTF 目录',
      act: async (s) => {
        await rename(path.join(s, 'WTF'), path.join(f.base, `stash-${path.basename(s)}`));
        await mkdir(path.join(s, 'WTF'), { mode: 0o700 });
      },
    },
  ];
  for (const [i, c] of cases.entries()) {
    const snap = path.join(container, ids[i]);
    const fired = onceAt(f.pause, c.at, () => c.act(snap), c.detail);
    const v = await f.svc.verify(9, f.root, ids[i]);
    f.pause.onStep = null;
    assert.ok(fired(), c.what);
    assert.equal(v.ok, false, c.what);
    const rec = (await f.svc.state(9, f.root)).snapshots.find((s) => s.id === ids[i])?.lastVerify;
    assert.equal(rec?.ok, false, `${c.what}：不能保留创建时的通过记录`);
  }
  await f.done();
});

test('设置文件损坏或有多个硬链接时失败关闭且原字节不变；合法的未知顶层字段在启用与关闭后保留', async () => {
  const f = await setup();
  const settings = path.join(f.appData, 'wtf-backup.json');
  const good = { flavorId: 9, root: f.root2, enabled: false, containerPath: path.join(f.picked2, `${CONTAINER_PREFIX}0123456789abcdef`), containerId: '0123456789abcdef', createdAt: 1 };
  const bad: [string, string][] = [
    ['无效 JSON', '{"schema":1,"targets":['],
    ['记录缺少字段', JSON.stringify({ schema: 1, targets: [{ flavorId: 9 }] })],
    ['多条记录中一条有未知字段', JSON.stringify({ schema: 1, targets: [good, { ...good, root: f.root, extra: true }] })],
    ['容器名与编号不符', JSON.stringify({ schema: 1, targets: [{ ...good, containerId: 'fedcba9876543210' }] })],
  ];
  for (const [name, text] of bad) {
    await writeFile(settings, text);
    const s = await f.svc.state(9, f.root);
    assert.equal(s.status, 'unavailable', name);
    assert.match(s.error ?? '', /备份设置/, name);
    assert.ok(!(s.error ?? '').includes('"schema"'), `${name}：错误说明不含设置内容`);
    await assert.rejects(f.svc.configure(9, f.root, f.picked), isCode('backup-settings'), name);
    await assert.rejects(f.svc.disable(9, f.root), isCode('backup-settings'), name);
    await assert.rejects(f.svc.run(9, f.root), isCode('backup-settings'), name);
    assert.equal(await readFile(settings, 'utf8'), text, `${name}：不得改写`);
    assert.deepEqual(await readdir(f.picked), [], name);
    assert.deepEqual(await readdir(f.appData), ['wtf-backup.json'], `${name}：设置占用标记已释放`);
  }

  await writeFile(settings, JSON.stringify({ schema: 1, targets: [good], futureField: { keep: [1, 2] } }));
  await f.svc.configure(9, f.root, f.picked);
  let saved = JSON.parse(await readFile(settings, 'utf8')) as { futureField: unknown; targets: { root: string; enabled: boolean }[] };
  assert.deepEqual(saved.futureField, { keep: [1, 2] });
  assert.deepEqual(saved.targets[0], good, '其他目录的记录原样保留');
  assert.equal(saved.targets.find((t) => t.root === f.root)?.enabled, true);
  await f.svc.disable(9, f.root);
  saved = JSON.parse(await readFile(settings, 'utf8')) as typeof saved;
  assert.deepEqual(saved.futureField, { keep: [1, 2] });
  assert.deepEqual(saved.targets[0], good);
  assert.equal(saved.targets.find((t) => t.root === f.root)?.enabled, false);

  const before = await readFile(settings);
  const alias = path.join(f.base, 'settings-alias.json');
  await link(settings, alias);
  assert.equal((await f.svc.state(9, f.root)).status, 'unavailable');
  await assert.rejects(f.svc.disable(9, f.root), isCode('backup-settings'));
  assert.deepEqual(await readFile(settings), before);
  await unlink(alias);
  assert.equal((await f.svc.state(9, f.root)).status, 'disabled');
  await f.done();
});

test('小上限边界：单文件、单份、条目、深度、清单与实际总占用在上限内成功，超出时失败；源与旧备份不变，不发布、不留占用', async () => {
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`File-${String(i).padStart(2, '0')}.lua`, 'x']));
  const cases: { name: string; limits: Partial<BackupLimits>; base: Record<string, string>; extra: Record<string, string> }[] = [
    { name: '单文件（等于上限）', limits: { maxFileBytes: 4 }, base: { 'A.lua': 'AAAA' }, extra: { 'B.lua': 'BBBBB' } },
    { name: '单份字节（等于上限）', limits: { maxSnapshotBytes: 8 }, base: { 'A.lua': 'AAAA', 'B.lua': 'BBBB' }, extra: { 'C.lua': 'C' } },
    { name: '条目数（等于上限）', limits: { maxEntries: 3 }, base: { 'A.lua': 'a', 'B.lua': 'b', 'C.lua': 'c' }, extra: { 'D.lua': 'd' } },
    { name: '目录层数（等于上限）', limits: { maxDepth: 2 }, base: { 'X/a.lua': 'a' }, extra: { 'X/Y/b.lua': 'b' } },
    // 单文件清单约 330 字节；21 个文件条目约 3 KiB
    { name: '清单大小', limits: { maxManifestBytes: 2000 }, base: { 'A.lua': 'a' }, extra: many },
    // 已用占用（标记、旧备份与本次占用标记）至少数百字节，再加 2900 字节必然超过 3000
    { name: '实际总占用', limits: { maxTotalBytes: 3000 }, base: { 'A.lua': 'a' }, extra: { 'Big.lua': 'z'.repeat(2900) } },
  ];
  for (const c of cases) {
    const f = await setup(c.limits);
    try {
      for (const [rel, data] of Object.entries(c.base)) await put(path.join(f.wtf, ...rel.split('/')), data);
      const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
      const first = await f.svc.run(9, f.root);
      assert.equal(first.snapshot.status, 'structure-ok', `${c.name}：上限内应成功`);
      const history = await tree(path.join(container, first.snapshot.id));
      for (const [rel, data] of Object.entries(c.extra)) await put(path.join(f.wtf, ...rel.split('/')), data);
      const source = await tree(f.wtf);
      await assert.rejects(f.svc.run(9, f.root), isCode('backup-limit'), c.name);
      assert.deepEqual(await tree(f.wtf), source, c.name);
      assert.deepEqual(await tree(path.join(container, first.snapshot.id)), history, c.name);
      assert.deepEqual((await readdir(container)).sort(), [MARKER_NAME, first.snapshot.id].sort(), `${c.name}：不发布、不留临时目录或占用标记`);
    } finally {
      await f.done();
    }
  }
});

test('写入注入：短写结果正确；复制阶段零写与 ENOSPC 失败时释放占用与临时目录，源与历史备份不变', async () => {
  const f = await setup();
  const realWrite = io.write;
  try {
    const data = Buffer.alloc(5000, 0x41);
    data.write('END', 4997);
    await put(path.join(f.wtf, 'Big.lua'), data);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    io.write = (fh, buf, offset, length) => realWrite(fh, buf, offset, Math.min(3, length));
    const first = await f.svc.run(9, f.root).finally(() => {
      io.write = realWrite;
    });
    const snap = path.join(container, first.snapshot.id);
    assert.deepEqual(await readFile(path.join(snap, 'WTF', 'Big.lua')), data);
    const manifest = JSON.parse(await readFile(path.join(snap, MANIFEST_NAME), 'utf8')) as { entries: { path: string; sha256?: string }[] };
    assert.equal(manifest.entries.find((e) => e.path === 'Big.lua')?.sha256, sha(data));
    assert.equal((await f.svc.verify(9, f.root, first.snapshot.id)).ok, true);
    const history = await tree(snap);
    const source = await tree(f.wtf);

    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const failures: [string, WriteFn, (err: unknown) => boolean][] = [
      ['零写', async () => ({ bytesWritten: 0 }), (e) => /写入/.test((e as Error).message)],
      [
        'ENOSPC',
        async () => {
          throw enospc;
        },
        (e) => (e as NodeJS.ErrnoException).code === 'ENOSPC',
      ],
    ];
    for (const [name, impl, check] of failures) {
      const fired = onceAt(f.pause, 'copy-file', async () => {
        io.write = impl;
      });
      try {
        await assert.rejects(f.svc.run(9, f.root), check, name);
      } finally {
        io.write = realWrite;
        f.pause.onStep = null;
      }
      assert.ok(fired(), `${name}：注入发生在复制阶段`);
      assert.deepEqual((await readdir(container)).sort(), [MARKER_NAME, first.snapshot.id].sort(), `${name}：占用标记与临时目录已收尾`);
      assert.deepEqual(await tree(snap), history, name);
      assert.deepEqual(await tree(f.wtf), source, name);
    }
  } finally {
    io.write = realWrite;
    await f.done();
  }
});

test('清理时临时目录或其 WTF 被搬走并以符号链接指回：不经由被替换的路径删除，搬走的数据、清单与外来文件都保留', async () => {
  for (const inner of ['', 'WTF']) {
    const name = inner ? '临时目录内的 WTF' : '临时目录本身';
    const f = await setup();
    try {
      await put(path.join(f.wtf, 'A.lua'), 'AAAA');
      const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
      const source = await tree(f.wtf);
      const stolen = path.join(f.base, 'stolen');
      const fired = onceAt(f.pause, 'final-check', async () => {
        const partial = path.join(container, (await readdir(container)).find((x) => x.startsWith('.partial-'))!);
        const target = inner ? path.join(partial, inner) : partial;
        await rename(target, stolen);
        await symlink(stolen, target);
        await writeFile(path.join(stolen, 'foreign.txt'), 'keep me');
      });
      await assert.rejects(f.svc.run(9, f.root), (err: unknown) => /保留现场/.test((err as Error).message), name);
      assert.ok(fired(), name);
      assert.equal(await readFile(path.join(stolen, 'foreign.txt'), 'utf8'), 'keep me', name);
      assert.equal(await readFile(inner ? path.join(stolen, 'A.lua') : path.join(stolen, 'WTF', 'A.lua'), 'utf8'), 'AAAA', `${name}：搬走的数据保留`);
      if (!inner) assert.ok((await readdir(stolen)).includes(MANIFEST_NAME), `${name}：搬走的清单保留`);
      assert.ok(!(await readdir(container)).includes(LOCK_NAME), `${name}：占用标记已释放`);
      assert.equal((await f.svc.state(9, f.root)).snapshots.length, 0);
      assert.deepEqual(await tree(f.wtf), source, name);
    } finally {
      f.pause.onStep = null;
      await f.done();
    }
  }
});

test('取消在历史占用扫描中立即传播；verify 暂停后取消也收尾且不更新校验记录', async () => {
  const f = await setup();
  const mod = require('node:fs/promises') as Record<string, unknown>;
  const realLstat = mod.lstat as (...a: unknown[]) => unknown;
  try {
    for (let i = 0; i < 4; i++) await put(path.join(f.wtf, 'Account', `F${i}.lua`), `v${i}`);
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await f.svc.run(9, f.root)).snapshot.id);
    const history = await Promise.all(ids.map((id) => tree(path.join(container, id))));
    const source = await tree(f.wtf);

    // 读取到历史备份内部的第一个条目时取消，之后不应再读取历史条目
    const inHistory = (p: string) => ids.some((id) => p.startsWith(path.join(container, id) + path.sep));
    let seen = 0;
    let after = 0;
    let cancelled = false;
    mod.lstat = (...args: unknown[]) => {
      if (inHistory(String(args[0]))) {
        if (cancelled) after++;
        else if (++seen === 1) {
          const t = f.svc.taskState();
          cancelled = !!t && f.svc.cancel(t.id, t.flavorId, t.root);
        }
      }
      return realLstat(...args);
    };
    try {
      await assert.rejects(f.svc.run(9, f.root), isCode('backup-cancelled'));
    } finally {
      mod.lstat = realLstat;
    }
    assert.ok(cancelled, '取消发生在读取历史备份条目时');
    assert.ok(after <= 1, `取消后不应继续扫描历史条目（实际 ${after} 次）`);
    assert.equal(f.svc.taskState(), null);
    assert.deepEqual((await readdir(container)).sort(), [MARKER_NAME, ...ids].sort());
    assert.deepEqual(await Promise.all(ids.map((id) => tree(path.join(container, id)))), history);
    assert.deepEqual(await tree(f.wtf), source);

    const before = (await f.svc.state(9, f.root)).snapshots.find((s) => s.id === ids[0])?.lastVerify;
    assert.equal(before?.ok, true);
    const p = f.pause.arm('verify-file');
    const verifying = f.svc.verify(9, f.root, ids[0]).then(
      () => null,
      (e: unknown) => e,
    );
    try {
      await p.reached;
      const t = f.svc.taskState()!;
      assert.equal(t.kind, 'verify');
      assert.equal(f.svc.cancel(t.id, 9, f.root), true);
    } finally {
      p.release();
    }
    assert.ok(isCode('backup-cancelled')(await verifying));
    assert.equal(f.svc.taskState(), null);
    assert.ok(!(await readdir(container)).includes(LOCK_NAME));
    const afterRec = (await f.svc.state(9, f.root)).snapshots.find((s) => s.id === ids[0])?.lastVerify;
    assert.deepEqual(afterRec, before, '取消的校验不能更新校验记录');
  } finally {
    mod.lstat = realLstat;
    await f.done();
  }
});

test('设置占用标记：两个实例同时修改时后者被拒；释放时标记被替换则明确“已保存但占用未释放”，之后不再默默修改设置', async () => {
  const f = await setup();
  try {
    f.ctx.bound = [f.root, f.root2];
    const other = f.make();
    const settings = path.join(f.appData, 'wtf-backup.json');
    const lockPath = `${settings}.lock`;

    const p = f.pause.arm('configure-before-commit');
    const first = f.svc.configure(9, f.root, f.picked).then(
      (s) => s,
      (e: unknown) => e,
    );
    try {
      await p.reached;
      await assert.rejects(other.configure(9, f.root, f.picked2), (err: unknown) => isCode('backup-lock')(err) && (err as Error).message.includes(lockPath));
    } finally {
      p.release();
    }
    assert.equal(((await first) as BackupState).status, 'ready');
    f.ctx.current = f.root2;
    assert.equal((await other.configure(9, f.root2, f.picked2)).status, 'ready');
    let saved = JSON.parse(await readFile(settings, 'utf8')) as { targets: { root: string; enabled: boolean }[] };
    assert.deepEqual(saved.targets.map((t) => t.root).sort(), [f.root, f.root2].sort(), '两个实例的启用记录都保存');

    const fired = onceAt(f.pause, 'before-lock-release', async () => {
      await unlink(lockPath);
      await writeFile(lockPath, 'replaced');
    });
    await assert.rejects(other.disable(9, f.root2), (err: unknown) => isCode('backup-lock')(err) && /备份设置已保存/.test((err as Error).message) && /未能正常释放/.test((err as Error).message));
    f.pause.onStep = null;
    assert.ok(fired());
    saved = JSON.parse(await readFile(settings, 'utf8')) as typeof saved;
    assert.equal(saved.targets.find((t) => t.root === f.root2)?.enabled, false, '已保存的修改有效');
    assert.equal(saved.targets.find((t) => t.root === f.root)?.enabled, true);
    assert.equal((await other.state(9, f.root2)).status, 'disabled');
    assert.equal(await readFile(lockPath, 'utf8'), 'replaced', '无法确认的占用标记保留');

    const frozen = await readFile(settings);
    const pickedBefore = await readdir(f.picked2);
    await assert.rejects(f.svc.disable(9, f.root2), isCode('backup-lock'));
    await assert.rejects(other.configure(9, f.root2, f.picked2), isCode('backup-lock'));
    assert.deepEqual(await readFile(settings), frozen, '残留标记存在时不得修改设置');
    assert.deepEqual(await readdir(f.picked2), pickedBefore, '残留标记存在时不得新建容器');
  } finally {
    f.pause.onStep = null;
    await f.done();
  }
});

test('重启后的遗留状态（非断电测试）：旧临时目录与旧占用标记只标为异常、不删除；查看不读 WTF；各阶段注入错误后释放占用、历史不变', async () => {
  const f = await setup();
  try {
    await put(path.join(f.wtf, 'Config.wtf'), 'SET a "1"\n');
    const container = (await f.svc.configure(9, f.root, f.picked)).containerPath!;
    const first = await f.svc.run(9, f.root);
    await f.svc.shutdown();
    const history = await tree(path.join(container, first.snapshot.id));
    const source = await tree(f.wtf);
    const leftover = path.join(container, '.partial-20200101-000000-deadbeef');
    await put(path.join(leftover, 'WTF', 'x.lua'), 'half');
    const staleLock = path.join(container, LOCK_NAME);
    await writeFile(staleLock, 'from a previous run');

    const restarted = f.make();
    const spy = watchAccess(f.wtf);
    const [s, revealed] = await Promise.all([restarted.state(9, f.root), restarted.revealPath(9, f.root)]).finally(() => spy.restore());
    assert.deepEqual(spy.calls, [], '查看状态与位置不访问 WTF');
    assert.equal(revealed, container);
    assert.equal(s.canCreate, false);
    assert.deepEqual(s.anomalies.map((a) => a.kind).sort(), ['incomplete', 'lock']);
    assert.equal(s.snapshots[0].status, 'structure-ok');

    await assert.rejects(restarted.run(9, f.root), isCode('backup-lock'));
    assert.equal(await readFile(staleLock, 'utf8'), 'from a previous run');
    await unlink(staleLock); // 用户确认后手动处理
    await assert.rejects(restarted.run(9, f.root), isCode('backup-container'));
    assert.equal(await readFile(path.join(leftover, 'WTF', 'x.lua'), 'utf8'), 'half', '遗留的临时目录不被自动删除');
    await rm(leftover, { recursive: true }); // 用户在访达中清理

    for (const at of ['manifest-write', 'final-check'] as const) {
      const fired = onceAt(f.pause, at, async () => {
        throw new Error(`injected at ${at}`);
      });
      await assert.rejects(restarted.run(9, f.root), new RegExp(`injected at ${at}`));
      f.pause.onStep = null;
      assert.ok(fired(), at);
      assert.deepEqual((await readdir(container)).sort(), [MARKER_NAME, first.snapshot.id].sort(), `${at}：占用标记与临时目录已收尾`);
      assert.deepEqual(await tree(path.join(container, first.snapshot.id)), history, at);
    }
    assert.deepEqual(await tree(f.wtf), source);
    assert.equal((await restarted.run(9, f.root)).snapshot.status, 'structure-ok');
  } finally {
    f.pause.onStep = null;
    await f.done();
  }
});
