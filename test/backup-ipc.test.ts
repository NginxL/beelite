// WTF 配置备份的接入（0.2.0）：真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// 发送方与参数校验；默认关闭、启动与查看状态不读取 WTF；保存位置只来自主进程的选择框（取消不调用核心）；
// 正常备份与校验；任务快照只来自内存且 rev 递增；换绑后按原目标取消；退出与客户端更新等待备份 / 校验完整收尾。
// 全部在临时目录中进行，不读取真实游戏目录或 userData。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createQuitGuard } from '../src/core/gate';
import { LOCK_NAME, PARTIAL_PREFIX, type BackupStep } from '../src/core/wtf-backup';
import type { BackupOutcome, BackupScope, BackupTaskSnapshot } from '../src/shared/types';
import { cleanup, exists, FakeSource, makeGameRoot, tmpDir } from './helpers';
import { createHarness, snapshot } from './ipc-harness';

const F = 9;
/** 0.2.1 起备份范围必须显式给出；默认的全部 WTF 也要明确传入 */
const ALL = { kind: 'all' } as const;
const tick = () => new Promise((r) => setImmediate(r));

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 测试钩子：在指定阶段暂停任务，直到 release */
class Pauser {
  private armed: { at: BackupStep; reached: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> } | null = null;

  arm(at: BackupStep): { reached: Promise<void>; release: () => void } {
    const a = { at, reached: deferred(), gate: deferred() };
    this.armed = a;
    return { reached: a.reached.promise, release: () => a.gate.resolve() };
  }

  async step(name: BackupStep): Promise<void> {
    const a = this.armed;
    if (a && a.at === name) {
      this.armed = null;
      a.reached.resolve();
      await a.gate.promise;
    }
  }
}

/** 记录对 prefix（含其下路径）的文件系统访问；核心在调用时读取 fs/promises 的导出，因此可被替换观察 */
function watchAccess(prefix: string): { calls: string[]; restore: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

/** userData 与游戏目录、保存位置分开（备份位置不能位于应用数据目录之内） */
async function setup() {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const A = await makeGameRoot(path.join(base, 'games', 'A'));
  const B = await makeGameRoot(path.join(base, 'games', 'B'));
  const picked = path.join(base, 'Desktop');
  const other = path.join(base, 'Elsewhere');
  await mkdir(picked);
  await mkdir(other);
  const pause = new Pauser();
  const h = createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource(), backup: { hooks: { step: (name) => pause.step(name) } } });
  await h.settings.bind(F, A);
  const taskPushes = () => h.stub.sent.filter((s) => s.channel === 'backup:task').map((s) => s.payload as BackupTaskSnapshot);
  return { base, userData, A, B, wtf: path.join(A, 'WTF'), picked, other, pause, h, taskPushes };
}

/** 取出 completed 结果；cancelled 视为测试失败 */
function completed<T>(o: BackupOutcome<T>): T {
  if (o.status !== 'completed') assert.fail(`意外取消：${o.message}`);
  return o.result;
}

/** 启用备份并返回备份位置 */
async function enable(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
  f.h.stub.pick = f.picked;
  const s = await f.h.api.backupConfigure(F, f.A);
  f.h.stub.pick = null;
  assert.ok(s && s.status === 'ready' && s.containerPath);
  return s.containerPath;
}

test('备份 IPC：只接受主窗口的请求；游戏版本、期望目录、备份编号与任务编号逐一校验；拒绝的请求不弹框、不留闸门计数', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const evil = { sender: {}, senderFrame: { url: 'https://evil.example/' } };
    for (const [channel, args] of [
      ['backup:taskState', []],
      ['backup:state', [F, A]],
      ['backup:configure', [F, A]],
      ['backup:disable', [F, A]],
      ['backup:catalog', [F, A]],
      ['backup:run', [F, A, ALL]],
      ['backup:verify', [F, A, '20260101-000000-00000000']],
      ['backup:cancel', ['x', F, A]],
      ['backup:reveal', [F, A, null]],
    ] as [string, unknown[]][]) {
      await assert.rejects(h.stub.handlers.get(channel)!(evil, ...args), /拒绝来自未知页面/, channel);
    }
    await assert.rejects(h.api.backupState(999, A), /不支持的游戏版本/);
    await assert.rejects(h.api.backupState('9' as unknown as number, A), /不支持的游戏版本/);
    await assert.rejects(h.api.backupRun(F, 'relative/path', ALL), /目标目录参数无效/);
    await assert.rejects(h.api.backupState(F, path.join(f.base, 'elsewhere')), /绑定已变更/);
    for (const bad of ['../..', '/etc', '20260101-000000-0000000G', '20260101-000000-00000000/..', 42, null]) {
      await assert.rejects(h.api.backupVerify(F, A, bad as string), /备份编号无效/, String(bad));
    }
    await assert.rejects(h.api.backupReveal(F, A, '/etc'), /备份编号无效/);
    await assert.rejects(h.api.backupReveal(F, A, '../../etc' as string), /备份编号无效/);
    await assert.rejects(h.api.backupCancel('x'.repeat(65), F, A), /任务编号无效/);
    await assert.rejects(h.api.backupCancel(5 as unknown as string, F, A), /任务编号无效/);
    await assert.rejects(h.api.backupCancel('', F, A), /任务编号无效/);
    // 未启用：查看位置被核心拒绝，没有打开任何路径
    await assert.rejects(h.api.backupReveal(F, A, null), /尚未启用/);
    assert.deepEqual(h.stub.revealed, []);
    assert.equal(h.stub.openDialogs, 0);
    assert.equal(h.gate.activeCount, 0);
    assert.equal(await exists(path.join(f.userData, 'wtf-backup-settings.json')), false);
  } finally {
    await cleanup(f.base);
  }
});

test('默认关闭：启动、任务快照与查看状态都不读取 WTF、不写设置；只有明确启用并手动备份才读取 WTF', async () => {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const A = await makeGameRoot(path.join(base, 'games', 'A'));
  const picked = path.join(base, 'Desktop');
  await mkdir(picked);
  const wtf = path.join(A, 'WTF');
  const spy = watchAccess(wtf);
  try {
    // 启动：构造服务、注册通道、加载 preload
    const h = createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource() });
    await h.settings.bind(F, A);
    assert.deepEqual(await h.api.backupTaskState(), { rev: 0, task: null });
    const s = await h.api.backupState(F, A);
    assert.equal(s.status, 'disabled');
    assert.equal(s.containerPath, null);
    assert.equal(s.activeTask, null);
    assert.equal(await exists(path.join(userData, 'wtf-backup-settings.json')), false, '查看状态不写备份设置');
    assert.deepEqual(await readdir(picked), []);

    // 明确启用：选择框返回位置后新建备份位置；启用与之后查看状态（扫描备份位置）都不读取 WTF
    h.stub.pick = picked;
    const on = await h.api.backupConfigure(F, A);
    assert.equal(on?.status, 'ready');
    const ready = await h.api.backupState(F, A);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.canCreate, true);
    assert.deepEqual(spy.calls, [], '启用与查看状态都不访问 WTF');
    assert.ok(!h.stub.sent.some((x) => x.channel === 'backup:task' && (x.payload as BackupTaskSnapshot).task), '没有任务');

    // 手动备份才读取 WTF（说明上面的观察确实有效）
    await h.api.backupRun(F, A, ALL);
    assert.ok(spy.calls.length > 0);
  } finally {
    spy.restore();
    await cleanup(base);
  }
});

/** 在临时游戏目录中合成账号、服务器与角色目录（同一账号两个服务器有同名角色）和 WTF 根级设置 */
async function addCharacters(root: string): Promise<void> {
  const acct = path.join(root, 'WTF', 'Account', 'TEST');
  for (const [realm, ch] of [['RealmA', 'Bob'], ['RealmB', 'Bob'], ['RealmA', 'Alice']]) {
    await mkdir(path.join(acct, realm, ch), { recursive: true });
    await writeFile(path.join(acct, realm, ch, 'AddOns.txt'), 'Questie: enabled\n');
  }
  await writeFile(path.join(root, 'WTF', 'Config.wtf'), 'SET test "1"\n');
}

test('账号与角色范围：catalog 只读、不入闸、不产生任务且未启用时拒绝；backup:run 缺少或不合法的范围在受理前拒绝（没有任务、不读 WTF）；合法范围交给核心并出现在任务、结果与列表中', async () => {
  const f = await setup();
  const { h, A } = f;
  const isError = (err: unknown) => err instanceof Error;
  try {
    await addCharacters(A);
    await assert.rejects(h.api.backupCatalog(F, A), /尚未启用/);
    await assert.rejects(h.api.backupCatalog(F, path.join(f.base, 'elsewhere')), /绑定已变更/);
    await assert.rejects(h.api.backupCatalog('9' as unknown as number, A), /不支持的游戏版本/);
    await assert.rejects(h.api.backupCatalog(F, 'relative/path'), /目标目录参数无效/);
    const container = await enable(f);
    const pushesBefore = f.taskPushes().length;

    // 范围缺失或不合法：受理前拒绝，不开始任务，也不访问 WTF
    const spy = watchAccess(f.wtf);
    try {
      await assert.rejects(h.invoke('backup:run', F, A), /备份范围参数缺失/);
      for (const bad of [undefined, null]) await assert.rejects(h.invoke('backup:run', F, A, bad), /备份范围参数缺失/, String(bad));
      for (const bad of [
        'all', 42, [], { kind: 'everything' }, { kind: 'all', extra: 1 }, { kind: 'account' }, { kind: 'account', account: '../OTHER' },
        { kind: 'account', account: 'TEST', path: '/etc' }, { kind: 'characters', account: 'TEST', characters: [] },
        { kind: 'characters', account: 'TEST', characters: [{ realm: 'RealmA', character: 'Bob' }, { realm: 'RealmA', character: 'Bob' }] },
        { kind: 'characters', account: 'TEST', characters: [{ realm: 'RealmA/Bob', character: 'x' }] },
      ]) {
        await assert.rejects(h.invoke('backup:run', F, A, bad), isError, JSON.stringify(bad));
      }
      assert.deepEqual(spy.calls, [], '无效范围不读取 WTF');
    } finally {
      spy.restore();
    }
    await tick();
    assert.equal(f.taskPushes().length, pushesBefore, '没有受理任务');
    assert.equal((await h.api.backupTaskState()).task, null);
    assert.equal(h.gate.activeCount, 0);

    // 列表：只读目录名称与元数据，不打开任何文件；不入闸，不产生任务
    const spy2 = watchAccess(f.wtf);
    let c: Awaited<ReturnType<typeof h.api.backupCatalog>>;
    try {
      c = await h.api.backupCatalog(F, A);
      assert.deepEqual(spy2.calls.filter((x) => x.startsWith('open:') || x.startsWith('readFile:')), [], '不读取文件内容');
    } finally {
      spy2.restore();
    }
    assert.equal(c.flavorId, F);
    assert.equal(c.root, A);
    const acct = c.accounts.find((a) => a.account === 'TEST');
    assert.ok(acct && acct.characterError === null);
    assert.deepEqual(acct.realms.flatMap((r) => r.characters.map((ch) => `${r.realm}/${ch}`)).sort(), ['RealmA/Alice', 'RealmA/Bob', 'RealmB/Bob']);
    assert.equal(h.gate.activeCount, 0);
    await tick();
    assert.equal(f.taskPushes().length, pushesBefore, '读取列表不产生任务');

    // 合法范围：同一账号跨服务器的同名角色；任务、推送、结果与列表中的范围一致
    const scope: BackupScope = { kind: 'characters', account: 'TEST', characters: [{ realm: 'RealmA', character: 'Bob' }, { realm: 'RealmB', character: 'Bob' }] };
    const at = f.pause.arm('copy-file');
    const run = h.api.backupRun(F, A, scope);
    await at.reached;
    assert.deepEqual((await h.api.backupTaskState()).task?.scope, scope);
    assert.ok(f.taskPushes().some((p) => p.task?.kind === 'run' && JSON.stringify(p.task.scope) === JSON.stringify(scope)), '推送的任务带范围');
    at.release();
    const r = completed(await run);
    assert.deepEqual(r.snapshot.scope, scope);
    assert.deepEqual((await h.api.backupState(F, A)).snapshots.find((x) => x.id === r.snapshot.id)?.scope, scope);
    const copied = path.join(container, r.snapshot.id, 'WTF');
    assert.ok(await exists(path.join(copied, 'Account', 'TEST', 'RealmA', 'Bob', 'AddOns.txt')));
    assert.ok(await exists(path.join(copied, 'Account', 'TEST', 'RealmB', 'Bob', 'AddOns.txt')));
    assert.ok(await exists(path.join(copied, 'Account', 'TEST', 'SavedVariables', 'Questie.lua')), '含账号共享配置');
    assert.equal(await exists(path.join(copied, 'Account', 'TEST', 'RealmA', 'Alice')), false, '不含未选角色');
    assert.equal(await exists(path.join(copied, 'Config.wtf')), false, '不含 WTF 根级设置');

    // 校验任务没有范围
    const vat = f.pause.arm('verify-file');
    const verify = h.api.backupVerify(F, A, r.snapshot.id);
    await vat.reached;
    assert.equal((await h.api.backupTaskState()).task?.scope, null);
    vat.release();
    assert.equal(completed(await verify).ok, true);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(f.base);
  }
});

test('启用：保存位置只来自主进程的文件夹选择框；取消返回 null 且不调用核心；目标已变化或闸门冻结时不弹框；界面多传的路径被忽略', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const original = h.service.backup.configure.bind(h.service.backup);
    let coreCalls = 0;
    h.service.backup.configure = (...a: Parameters<typeof original>) => {
      coreCalls++;
      return original(...a);
    };

    // 用户取消选择
    assert.equal(await h.api.backupConfigure(F, A), null);
    assert.equal(h.stub.openDialogs, 1);
    assert.ok(h.stub.openDialogProps[0].includes('openDirectory'));
    assert.equal(coreCalls, 0, '取消时不调用核心');
    assert.equal(await exists(path.join(f.userData, 'wtf-backup-settings.json')), false);
    assert.equal(h.gate.activeCount, 0);

    // 期望目录不是当前绑定：选择框之前拒绝
    await assert.rejects(h.api.backupConfigure(F, f.B), /绑定已变更/);
    // 闸门冻结（客户端更新或退出）：同步拒绝，不弹框
    const token = h.gate.freeze();
    await assert.rejects(h.api.backupConfigure(F, A), /正在更新或退出，暂时不能执行此操作/);
    h.gate.unfreeze(token);
    assert.equal(h.stub.openDialogs, 1);
    assert.equal(coreCalls, 0);

    // 界面多传一个路径：只用选择框返回的位置
    h.stub.pick = f.picked;
    const s = await h.invoke('backup:configure', F, A, f.other) as Awaited<ReturnType<typeof h.api.backupConfigure>>;
    assert.ok(s && s.status === 'ready');
    assert.equal(path.dirname(s.containerPath!), f.picked);
    assert.deepEqual(await readdir(f.other), [], '界面给出的路径没有被使用');
    assert.equal(coreCalls, 1);

    // 关闭：只改设置，备份位置保留
    const off = await h.api.backupDisable(F, A);
    assert.equal(off.status, 'disabled');
    assert.equal(off.containerPath, s.containerPath);
    assert.ok(await exists(s.containerPath!));
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(f.base);
  }
});

test('备份与校验：源不变；任务快照只来自内存（进度推送不调用 state），rev 连续递增并以无任务结束；在访达中显示只用登记路径', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const container = await enable(f);
    const before = await snapshot(f.wtf);
    const original = h.service.backup.state.bind(h.service.backup);
    let stateCalls = 0;
    h.service.backup.state = (...a: Parameters<typeof original>) => {
      stateCalls++;
      return original(...a);
    };
    const sentBefore = f.taskPushes().length;

    const r = completed(await h.api.backupRun(F, A, ALL));
    assert.equal(r.snapshot.status, 'structure-ok');
    assert.deepEqual(r.snapshot.scope, ALL);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(await snapshot(f.wtf), before, '源 WTF 不变');
    assert.ok(await exists(path.join(container, r.snapshot.id)));
    assert.equal(await exists(path.join(container, LOCK_NAME)), false);
    await tick();
    const pushes = f.taskPushes().slice(sentBefore);
    assert.ok(pushes.some((p) => p.task?.kind === 'run' && p.task.id === r.taskId && p.task.root === A && p.task.flavorId === F));
    assert.equal(pushes[pushes.length - 1].task, null, '结束时推送无任务');
    const all = f.taskPushes();
    all.forEach((p, i) => assert.equal(p.rev, i + 1, '每次推送 rev 加 1'));
    assert.deepEqual(await h.api.backupTaskState(), all[all.length - 1]);
    assert.equal(stateCalls, 0, '任务推送不扫描备份位置');

    const v = completed(await h.api.backupVerify(F, A, r.snapshot.id));
    assert.equal(v.ok, true);
    assert.equal(v.checkedFiles, 1);
    assert.equal(stateCalls, 0);
    const s = await h.api.backupState(F, A);
    assert.equal(s.snapshots.length, 1);
    assert.equal(s.snapshots[0].lastVerify?.ok, true);
    assert.equal(s.activeTask, null);

    await h.api.backupReveal(F, A, null);
    await h.api.backupReveal(F, A, r.snapshot.id);
    await assert.rejects(h.api.backupReveal(F, A, '20000101-000000-00000000'), /找不到该备份/);
    assert.deepEqual(h.stub.revealed, [container, path.join(container, r.snapshot.id)]);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(f.base);
  }
});

test('换绑后取消：按原任务编号、原游戏版本与原目录取消，不要求与当前绑定相同；其他组合不影响任务；取消后临时内容与占用标记已收尾', async () => {
  const f = await setup();
  const { h, A, B } = f;
  try {
    const container = await enable(f);
    const at = f.pause.arm('copy-file');
    const run = h.api.backupRun(F, A, ALL);
    await at.reached;
    const task = (await h.api.backupTaskState()).task;
    assert.ok(task && task.kind === 'run');
    assert.equal(task.root, A);
    assert.equal(h.gate.activeCount, 1, '备份在闸门内');
    assert.ok(await exists(path.join(container, LOCK_NAME)));

    // 进行中换绑：查看原目录被拒绝，新目录不受影响
    await h.settings.bind(F, B);
    await assert.rejects(h.api.backupState(F, A), /绑定已变更/);
    assert.equal((await h.api.backupState(F, B)).status, 'disabled');
    // 运行期间不能再次启用或备份
    await assert.rejects(h.api.backupRun(F, B, ALL), /已有备份或校验任务/);
    await assert.rejects(h.api.backupConfigure(F, B), /已有备份或校验任务/);

    assert.equal(await h.api.backupCancel('other-task', F, A), false);
    assert.equal(await h.api.backupCancel(task.id, F, B), false, '当前绑定不是任务的目录');
    assert.equal(await h.api.backupCancel(task.id, 2, A), false);
    assert.equal((await h.api.backupTaskState()).task?.cancelling, false, '不匹配的取消不影响任务');
    assert.equal(await h.api.backupCancel(task.id, F, A), true);
    await tick();
    assert.equal(f.taskPushes().at(-1)?.task?.cancelling, true);

    at.release();
    const out = await run;
    assert.equal(out.status, 'cancelled', '取消以结构化结果返回，不是错误');
    assert.match(out.status === 'cancelled' ? out.message : '', /备份任务已取消/);
    assert.equal((await h.api.backupTaskState()).task, null);
    assert.equal(h.gate.activeCount, 0);
    assert.equal(await exists(path.join(container, LOCK_NAME)), false, '占用标记已释放');
    assert.ok(!(await readdir(container)).some((n) => n.startsWith(PARTIAL_PREFIX)), '临时目录已清理');
  } finally {
    await cleanup(f.base);
  }
});

test('结构化结果：取消保留完整收尾说明；已发布后才收到取消仍为 completed；普通失败照常报错，不当作取消', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const container = await enable(f);
    const lock = path.join(container, LOCK_NAME);

    // 1. 取消，且占用标记在收尾前被替换：cancelled 的说明包含保留标记的提示
    let at = f.pause.arm('copy-file');
    const cancelled = h.api.backupRun(F, A, ALL);
    await at.reached;
    const task = (await h.api.backupTaskState()).task!;
    assert.equal(await h.api.backupCancel(task.id, F, A), true);
    await rm(lock);
    await writeFile(lock, '别人的标记');
    at.release();
    const c = await cancelled;
    assert.equal(c.status, 'cancelled');
    assert.match(c.status === 'cancelled' ? c.message : '', /备份任务已取消[\s\S]*占用标记/);
    await rm(lock);

    // 2. 已发布、正在释放占用标记时才收到取消：仍是 completed，备份存在
    at = f.pause.arm('before-lock-release');
    const late = h.api.backupRun(F, A, ALL);
    await at.reached;
    const t2 = (await h.api.backupTaskState()).task!;
    assert.equal(await h.api.backupCancel(t2.id, F, A), true);
    at.release();
    const done = completed(await late);
    assert.ok(await exists(path.join(container, done.snapshot.id)));

    // 3. 复制期间源被改动：普通失败以错误返回
    at = f.pause.arm('copy-file');
    const failing = h.api.backupRun(F, A, ALL);
    await at.reached;
    await writeFile(path.join(f.wtf, 'Account', 'TEST', 'SavedVariables', 'Questie.lua'), 'QuestieConfig = { changed = true }\n');
    at.release();
    await assert.rejects(failing, /发生了变化/);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(f.base);
  }
});

test('退出：同一次 before-quit 中先中止备份，退出保护等待备份收尾（临时内容清理、占用标记释放）与闸门排空后才 quit', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const container = await enable(f);
    const at = f.pause.arm('copy-file');
    const run = h.api.backupRun(F, A, ALL);
    await at.reached;
    assert.ok(readdirSync(container).some((n) => n.startsWith(PARTIAL_PREFIX)));

    let quits = 0;
    let atQuit: { lock: boolean; partial: boolean; task: unknown } | null = null;
    const guard = createQuitGuard(h.gate, () => {
      quits++;
      atQuit = {
        lock: existsSync(path.join(container, LOCK_NAME)),
        partial: readdirSync(container).some((n) => n.startsWith(PARTIAL_PREFIX)),
        task: h.service.backup.taskState(),
      };
    });
    // 与 main 的监听顺序一致：先 shutdown（不等待），再退出保护
    let prevented = 0;
    const ev = { preventDefault: () => void prevented++ };
    void h.service.backup.shutdown();
    guard(ev);
    assert.equal(prevented, 1);
    assert.equal((await h.api.backupTaskState()).task?.cancelling, true, '退出时已中止任务');
    await assert.rejects(h.api.backupVerify(F, A, '20260101-000000-00000000'), /正在更新或退出/);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(quits, 0, '任务收尾前不能退出');

    at.release();
    assert.equal((await run).status, 'cancelled');
    await until(() => quits === 1, '排空后退出');
    assert.deepEqual(atQuit, { lock: false, partial: false, task: null }, '退出时备份已完整收尾');
  } finally {
    await cleanup(f.base);
  }
});

test('客户端更新等待：重新校验会写占用标记，也在闸门内；冻结排空要等校验完整结束、占用标记释放', async () => {
  const f = await setup();
  const { h, A } = f;
  try {
    const container = await enable(f);
    const r = completed(await h.api.backupRun(F, A, ALL));
    const at = f.pause.arm('verify-file');
    const verify = h.api.backupVerify(F, A, r.snapshot.id);
    await at.reached;
    assert.equal(h.gate.activeCount, 1);
    assert.ok(await exists(path.join(container, LOCK_NAME)));

    const { token, drained } = h.gate.freezeAndDrain();
    let done = false;
    void drained.then(() => (done = true));
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(done, false, '校验进行中不能排空');

    at.release();
    assert.equal(completed(await verify).ok, true);
    await drained;
    assert.equal(await exists(path.join(container, LOCK_NAME)), false);
    h.gate.unfreeze(token);
  } finally {
    await cleanup(f.base);
  }
});
