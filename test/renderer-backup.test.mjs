// 配置备份标签页（0.2.0）：编译后的渲染层（state / local / backup）→ 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// 启动只同步任务快照、打开标签页才读状态且不读 WTF；选择位置即启用、只有创建备份才读 WTF；进度推送不读状态，开始 / 结束各刷新一次；
// 迟到的快照、回复与错误不覆盖新的任务；取消与警告常驻显示；A→B→A 丢弃旧回复；结构检查与内容校验文字分开、当前不一致优先。
// 任务快照的 rev 在主进程实例内单调递增，因此整个文件共用一个主进程实例（每个用例使用自己的游戏目录与保存位置）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { cleanup, FakeSource, makeGameRoot, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const B = await import(path.join(web, 'backup.js'));

async function until(fn, what) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = () => new Promise((r) => setTimeout(r, 100));

/** 测试钩子：在指定阶段暂停任务，直到 release */
class Pauser {
  armed = null;
  arm(at) {
    let reached;
    let release;
    const a = { at, reachedP: new Promise((r) => (reached = r)), gateP: new Promise((r) => (release = r)) };
    a.reached = reached;
    this.armed = a;
    return { reached: a.reachedP, release };
  }
  async step(name) {
    const a = this.armed;
    if (a && a.at === name) {
      this.armed = null;
      a.reached();
      await a.gateP;
    }
  }
}

/** 记录对 prefix（含其下路径）的文件系统访问；核心在调用时读取 fs/promises 的导出 */
function watchAccess(prefix) {
  const mod = require('node:fs/promises');
  const saved = new Map();
  const calls = [];
  for (const n of ['open', 'opendir', 'lstat', 'stat', 'realpath', 'readdir', 'readFile']) {
    const orig = mod[n];
    saved.set(n, orig);
    mod[n] = (...args) => {
      const p = String(args[0]);
      if (p === prefix || p.startsWith(prefix + path.sep)) calls.push(`${n}:${p}`);
      return orig(...args);
    };
  }
  return { calls, restore: () => saved.forEach((fn, n) => (mod[n] = fn)) };
}

const base = await realpath(await tmpDir());
const userData = path.join(base, 'userData');
await mkdir(userData);
const pause = new Pauser();
const h = H.createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource(), backup: { hooks: { step: (n) => pause.step(n) } } });
globalThis.window.beelite = h.api;
h.api.onActivity((s) => S.applyActivity(s));
// 与 main.ts 一致：先订阅任务推送，再获取快照
h.api.onBackupTask((s) => B.applyBackupTask(s));
await B.syncBackupTask();
await S.syncActivity();
S.state.config = {
  flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }],
  categories: [],
  defaultFlavorId: F,
  configError: null,
};
S.state.flavorId = F;
const view = document.getElementById('test-local');
L.initLocal(view);
const coreState = h.service.backup.state.bind(h.service.backup);

test.after(async () => {
  await h.service.backup.shutdown();
  await cleanup(base);
});

const calls = (channel) => H.ipcCalls.filter((c) => c.channel === channel).length;
const button = (label) => view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const tags = () => view.all().filter((e) => e.classList.contains('tag')).map((e) => e.textContent);
const shown = (t) => B.shownBackup(t)?.state ?? null;

/** 新的游戏目录绑定为当前目标，回到“已托管”标签页 */
async function useTarget(name) {
  h.service.backup.state = coreState;
  const root = await makeGameRoot(path.join(base, name));
  await h.settings.bind(F, root);
  L.showTab('managed');
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  dom.toastRoot().replaceChildren();
  return root;
}

/** 打开标签页并经界面启用（主进程的选择框返回 pick-<name>） */
async function enableUi(name) {
  L.showTab('backup');
  const t = S.currentTarget();
  await until(() => shown(t)?.status === 'disabled' && !B.backupLoading(t), '读取状态');
  const picked = path.join(base, `pick-${name}`);
  await mkdir(picked);
  h.stub.pick = picked;
  button('选择保存位置并启用').click();
  await until(() => shown(t)?.status === 'ready', '启用');
  h.stub.pick = null;
  return shown(t).containerPath;
}

/** 点击创建备份并等待结果与结束后的刷新 */
async function createUi(t) {
  const before = B.backupNotice();
  button('创建备份').click();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '备份结束');
  return B.backupNotice();
}

/** 统计完整状态的读取次数 */
function countState() {
  const c = { n: 0 };
  h.service.backup.state = (...a) => {
    c.n++;
    return coreState(...a);
  };
  return c;
}

/** 让完整状态的读取停住，逐个放行 */
function holdState() {
  const ctl = { waiting: [] };
  h.service.backup.state = async (...a) => {
    await new Promise((r) => ctl.waiting.push(r));
    return coreState(...a);
  };
  return ctl;
}

async function bindViaUi(root) {
  h.stub.pick = root;
  assert.equal(await S.bindDirectory(), true);
  h.stub.pick = null;
  assert.equal(S.currentTarget().root, root);
}

test('启动只同步任务快照；打开标签页才读取状态且不读 WTF；选择位置即启用；只有创建备份才读取 WTF，且不刷新插件列表', async () => {
  const A = await useTarget('t1');
  const spy = watchAccess(path.join(A, 'WTF'));
  try {
    assert.equal(calls('backup:state'), 0, '启动与其他标签页不读取备份状态');
    L.showTab('backup');
    const t = S.currentTarget();
    await until(() => shown(t)?.status === 'disabled', '读取状态');
    assert.equal(calls('backup:state'), 1);
    const text = view.textContent;
    assert.match(text, /WTF 里保存着账号、角色与插件的设置/);
    assert.match(text, /艾泽魔方不会主动上传/);
    assert.match(text, /云盘同步的文件夹，副本可能会被云盘同步/);
    assert.doesNotMatch(text, /只保存在这台电脑/);
    assert.match(text, /建议先退出游戏/);
    assert.match(text, /不是瞬间快照/);
    assert.match(text, /不提供一键还原/);
    assert.ok(!button('恢复') && !button('还原'), '没有恢复入口');

    const picked = path.join(base, 'pick-t1');
    await mkdir(picked);
    h.stub.pick = picked;
    button('选择保存位置并启用').click();
    await until(() => shown(t)?.status === 'ready', '启用');
    h.stub.pick = null;
    assert.equal(calls('backup:configure'), 1);
    assert.equal(path.dirname(shown(t).containerPath), picked);
    assert.ok(view.textContent.includes(shown(t).containerPath), '显示保存位置');
    assert.ok(button('创建备份') && !button('创建备份').disabled);
    assert.ok(button('在访达中查看'));
    assert.deepEqual(spy.calls, [], '打开与启用都不读取 WTF');

    const n = await createUi(t);
    assert.equal(n.title, '备份已完成');
    assert.equal(shown(t).snapshots.length, 1);
    assert.ok(spy.calls.length > 0, '创建备份才读取 WTF');
    assert.equal(calls('local:state'), 0, '备份不经过插件列表读取（不会恢复或清理游戏目录）');
    assert.equal(h.gate.activeCount, 0);
  } finally {
    spy.restore();
  }
});

test('进度推送不读取状态，开始与结束各刷新一次；迟到的快照、回复与错误不覆盖进行中的任务；取消显示服务端完整说明', async () => {
  await useTarget('t3');
  await enableUi('t3');
  const t = S.currentTarget();
  const counter = countState();
  const at = pause.arm('copy-file');
  button('创建备份').click();
  await at.reached;
  await until(() => B.backupTask() && counter.n === 1 && !B.backupLoading(t), '开始后的刷新完成');

  // 进度推送前后“取消”按钮是同一个元素且仍在页面中（焦点与进行中的点击不会因重建而丢失）
  const cancelBtn = button('取消');
  const tagEl = view.all().find((e) => e.classList.contains('tag-task'));
  assert.ok(cancelBtn && tagEl);
  for (let i = 0; i < 5; i++) h.service.pushBackupTask();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(counter.n, 1, '进度推送只更新任务卡片');
  assert.equal(button('取消'), cancelBtn, '同一任务的进度不重建取消按钮');
  assert.ok(view.all().includes(cancelBtn), '按钮仍在页面中');
  assert.equal(view.all().find((e) => e.classList.contains('tag-task')), tagEl);
  assert.match(view.textContent, /正在备份/);
  assert.match(view.textContent, /正在复制/);
  assert.match(view.textContent, /0 \/ 1 个文件/, '进度文字来自最新的推送');
  assert.equal(B.backupTabBadge(), '进行中');

  // 迟到的旧快照、迟到的查询回复与查询失败
  assert.equal(B.applyBackupTask({ rev: 1, task: null }), false);
  const real = globalThis.window.beelite;
  globalThis.window.beelite = { ...real, backupTaskState: async () => ({ rev: 1, task: null }) };
  await B.syncBackupTask();
  assert.ok(B.backupTask(), '迟到的回复不清除任务');
  globalThis.window.beelite = { ...real, backupTaskState: async () => { throw new Error('迟到的失败'); } };
  await B.syncBackupTask();
  globalThis.window.beelite = real;
  assert.ok(B.backupTask());
  L.showTab('backup');
  assert.doesNotMatch(view.textContent, /未能同步/, '迟到的失败不覆盖已收到的任务');
  await until(() => !B.backupLoading(t), '重新打开的读取完成');
  const afterReopen = counter.n;

  const reopenedBtn = button('取消');
  reopenedBtn.click();
  await until(() => B.backupTask()?.cancelling, '取消中');
  assert.equal(button('正在取消'), reopenedBtn, '取消标记就地更新同一个按钮');
  assert.ok(reopenedBtn.disabled);
  assert.match(view.textContent, /正在取消…/);
  assert.equal(counter.n, afterReopen, '取消标记只更新任务卡片');
  const cancel = H.ipcCalls.find((c) => c.channel === 'backup:cancel');
  assert.deepEqual(cancel.args.slice(1), [F, t.root]);
  const before = B.backupNotice();
  at.release();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '结束');
  assert.equal(counter.n, afterReopen + 1, '结束时刷新一次');
  const n = B.backupNotice();
  assert.equal(n.kind, 'info');
  assert.match(n.title, /备份已取消/);
  assert.match(n.lines.join('\n'), /备份任务已取消/);
  assert.match(view.textContent, /备份已取消/);
  assert.doesNotMatch(view.textContent, /备份未完成/, '取消不显示为失败');
  assert.equal(shown(t).snapshots.length, 0);
});

test('收尾警告常驻：备份已完成但占用标记被替换时完整显示警告，刷新后仍在，关闭后才消失；位置中的异常显示且不能新建', async () => {
  await useTarget('t5');
  const container = await enableUi('t5');
  const t = S.currentTarget();
  const lock = path.join(container, 'BACKUP-IN-PROGRESS.lock');
  const at = pause.arm('before-lock-release');
  const before = B.backupNotice();
  button('创建备份').click();
  await at.reached;
  await rm(lock);
  await writeFile(lock, '别人的标记');
  at.release();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '结束');
  const n = B.backupNotice();
  assert.equal(n.kind, 'warn');
  assert.match(n.title, /备份已完成，但/);
  assert.ok(n.lines.some((l) => /占用标记/.test(l)), '警告原文保留');
  assert.equal(shown(t).snapshots.length, 1);

  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t), '刷新');
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t), '再次刷新');
  assert.equal(B.backupNotice(), n, '刷新不清除结果');
  assert.match(view.textContent, /备份已完成，但收尾时有需要你检查的情况/);
  assert.ok(tags().includes('占用标记'), '位置中的占用标记列为需要检查的项目');
  assert.match(view.textContent, /不会自动删除或修改它们/);
  assert.ok(button('创建备份').disabled);
  button('知道了').click();
  assert.equal(B.backupNotice(), null);
  await rm(lock);
});

test('结构检查与内容校验分开显示：未校验、校验通过、内容不一致；当前结构不一致优先于之前的校验结果', async () => {
  await useTarget('t2');
  const container = await enableUi('t2');
  const t = S.currentTarget();
  await createUi(t);
  const id = shown(t).snapshots[0].id;
  assert.ok(tags().includes('上次内容校验通过'), '创建时已完整核对本次备份');

  // 内存中的校验记录不再存在（相当于重新启动应用之后）
  h.service.backup.verified.clear();
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t) && shown(t).snapshots[0].lastVerify === null, '刷新');
  assert.ok(tags().includes('结构检查通过，尚未校验内容'));
  assert.ok(!tags().includes('上次内容校验通过'));

  let before = B.backupNotice();
  button('重新校验').click();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '校验');
  assert.match(B.backupNotice().title, /内容校验通过/);
  assert.ok(tags().includes('上次内容校验通过'));
  assert.match(view.textContent, /本次运行期间；之后的改动需要重新校验/);

  // 同样大小改动内容：结构仍一致，只有重新校验能发现
  const file = path.join(container, id, 'WTF', 'Account', 'TEST', 'SavedVariables', 'Questie.lua');
  await writeFile(file, 'QuestieConfig = []\n');
  before = B.backupNotice();
  button('重新校验').click();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '再次校验');
  const n = B.backupNotice();
  assert.equal(n.kind, 'warn');
  assert.match(n.title, /内容与清单不一致/);
  assert.match(n.lines[0], /Questie\.lua/);
  assert.ok(tags().includes('上次内容校验未通过'));

  // 大小也变了：当前结构不一致优先
  await writeFile(file, 'QuestieConfig = { changed = true }\n');
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t) && shown(t).snapshots[0].status === 'mismatch', '刷新');
  assert.ok(tags().includes('与清单不一致'));
  assert.ok(!tags().some((x) => /上次内容校验/.test(x)), '之前的校验结果不再作为当前状态显示');
});

test('A 的备份进行中换绑到 B：任务卡片标明原目录，A 的结果不写到 B；A→B→A 期间迟到的状态回复全部丢弃', async () => {
  const A = await useTarget('t4a');
  await enableUi('t4a');
  const tA = S.currentTarget();
  const Bdir = await makeGameRoot(path.join(base, 't4b'));

  const at = pause.arm('copy-file');
  button('创建备份').click();
  await at.reached;
  await bindViaUi(Bdir);
  const tB = S.currentTarget();
  await until(() => shown(tB)?.status === 'disabled' && !B.backupLoading(tB), 'B 的状态');
  assert.equal(B.shownBackup(tA), null);
  assert.match(view.textContent, /原目录（不是当前显示的目录）/);
  assert.ok(view.textContent.includes(A), '任务卡片显示原目录');
  assert.ok(button('取消'), '可以取消原目录的任务');

  const before = B.backupNotice();
  at.release();
  await until(() => B.backupNotice() !== before && !B.backupTask(), 'A 的备份结束');
  const n = B.backupNotice();
  assert.equal(n.title, '备份已完成');
  assert.deepEqual(n.origin, tA);
  assert.ok(toasts(dom).some((x) => x.includes(A) && x.includes('备份已完成')), '另行提示原目录');
  await settle();
  assert.equal(shown(tB).status, 'disabled', 'B 仍未启用');
  assert.equal(shown(tB).snapshots.length, 0);

  // A→B→A：每次换绑发起的读取都停住，按顺序放行
  const ctl = holdState();
  await bindViaUi(A);
  assert.equal(B.shownBackup(tA), null, '切回 A 不复活之前的状态');
  await bindViaUi(Bdir);
  await bindViaUi(A);
  await until(() => ctl.waiting.length === 3, '三次读取');
  ctl.waiting[0]();
  await settle();
  assert.equal(B.shownBackup(tA), null, '第一次（已作废）的 A 回复被丢弃');
  ctl.waiting[1]();
  await settle();
  assert.equal(B.shownBackup(tA), null, 'B 的回复被丢弃');
  ctl.waiting[2]();
  await until(() => shown(tA)?.status === 'ready' && !B.backupLoading(tA), '最新的 A 回复');
  assert.equal(shown(tA).snapshots.length, 1);
  h.service.backup.state = coreState;
});
