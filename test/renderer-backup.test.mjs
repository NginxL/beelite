// 配置备份页（0.2.1 起为左侧独立页面）：编译后的渲染层（state / local / backup）→ 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// 启动只同步任务快照、进入页面才读状态且不读 WTF；重复进入不重读，页面隐藏时任务开始 / 结束 / 进度都不读状态；
// 选择位置即启用；读取账号与角色只读目录名称与元数据，只有创建备份才读取文件内容；进度推送不读状态，开始 / 结束各刷新一次；迟到的快照、回复与错误不覆盖新的任务；
// 状态读取失败或正在刷新时保留旧内容但不能创建、读取账号与角色或重新校验；一次最多选 256 个角色；
// 取消与警告常驻显示；A→B→A 丢弃旧回复；结构检查与内容校验文字分开、当前不一致优先。
// 备份范围：默认全部 WTF；窄范围只有点击“读取账号与角色”才读取列表，不默认选择账号或角色；同一账号跨服务器同名角色不混淆；
// 目标变化、关闭备份使列表与选择作废（范围类型保留）；重新读取只保留仍存在的选择；读取失败不能按窄范围创建；
// 任务卡片显示任务自己的范围，主体重绘与进度推送都不重建“取消”按钮、不改变焦点。
// 任务快照的 rev 在主进程实例内单调递增，因此整个文件共用一个主进程实例（每个用例使用自己的游戏目录与保存位置）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, FakeElement, installFakeDom, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { cleanup, exists, FakeSource, makeGameRoot, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;

const dom = installFakeDom(null);
// 记录焦点：渲染层只在恢复同一控件时调用 focus
let focused = null;
FakeElement.prototype.focus = function focus() {
  focused = this;
  globalThis.document.activeElement = this;
};
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const B = await import(path.join(web, 'backup.js'));

/**
 * 轮询直到条件成立。默认预算与原来相同（至少轮询 1000 次，每次间隔 5ms）；timeoutMs 另设真实时钟的截止时间，
 * 两者都用完才判为超时，只给真实文件较多、在全量并行测试下可能较慢的场景放宽，仍然有界
 */
async function until(fn, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    if (fn()) return;
    if (i >= 1000 && Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** 真实复制数百个文件的场景（全量测试并行时磁盘负载较高）使用的等待预算 */
const LARGE_TIMEOUT_MS = 30000;
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
// 与 main.ts 一致：先初始化页面（不打开），再订阅任务推送、获取快照
const view = document.getElementById('test-backup');
B.initBackup(view);
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
const localView = document.getElementById('test-local');
L.initLocal(localView);
const coreState = h.service.backup.state.bind(h.service.backup);
const coreCatalog = h.service.backup.catalog.bind(h.service.backup);

test.after(async () => {
  await h.service.backup.shutdown();
  await cleanup(base);
});

const calls = (channel) => H.ipcCalls.filter((c) => c.channel === channel).length;
const button = (label) => view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const tags = () => view.all().filter((e) => e.classList.contains('tag')).map((e) => e.textContent);
const shown = (t) => B.shownBackup(t)?.state ?? null;
const radio = (kind) => view.all().find((e) => e.tagName === 'INPUT' && e.type === 'radio' && e.value === kind);
const accountSelect = () => view.all().find((e) => e.tagName === 'SELECT');
const checkbox = (realm, ch) => view.all().find((e) => e.tagName === 'INPUT' && e.type === 'checkbox' && e.attrs['aria-label'] === `${ch}（${realm}）`);
/** 模拟用户操作表单控件（假 DOM 的 click 只触发 click 监听） */
function fire(el, ev) {
  for (const fn of el.listeners[ev] ?? []) fn({ target: el });
}
function chooseKind(kind) {
  const r = radio(kind);
  assert.ok(r, `范围选项 ${kind}`);
  r.checked = true;
  fire(r, 'change');
}
function chooseAccount(name) {
  const s = accountSelect();
  assert.ok(s, '账号下拉框');
  s.value = name;
  fire(s, 'change');
}
function toggle(realm, ch, on = true) {
  const c = checkbox(realm, ch);
  assert.ok(c, `角色 ${ch}（${realm}）`);
  c.checked = on;
  fire(c, 'change');
}
function inTree(el) {
  for (let n = el; n; n = n.parentNode) if (n === view) return true;
  return false;
}

/** 合成账号、服务器与角色目录（同一账号两个服务器有同名角色）、另一个账号与 WTF 根级设置 */
async function addCharacters(root) {
  const wtf = path.join(root, 'WTF');
  for (const [acct, realm, ch] of [['TEST', 'RealmA', 'Bob'], ['TEST', 'RealmB', 'Bob'], ['TEST', 'RealmA', 'Alice'], ['OTHER', 'RealmA', 'Carol']]) {
    await mkdir(path.join(wtf, 'Account', acct, realm, ch), { recursive: true });
    await writeFile(path.join(wtf, 'Account', acct, realm, ch, 'AddOns.txt'), 'Questie: enabled\n');
  }
  await writeFile(path.join(wtf, 'Config.wtf'), 'SET test "1"\n');
}

/** 新的游戏目录绑定为当前目标，离开配置备份页 */
async function useTarget(name, chars = false) {
  h.service.backup.state = coreState;
  h.service.backup.catalog = coreCatalog;
  B.setBackupPageOpen(false);
  const root = await makeGameRoot(path.join(base, name));
  if (chars) await addCharacters(root);
  await h.settings.bind(F, root);
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  dom.toastRoot().replaceChildren();
  return root;
}

/** 进入页面并经界面启用（主进程的选择框返回 pick-<name>） */
async function enableUi(name) {
  B.setBackupPageOpen(true);
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
async function createUi(t, timeoutMs) {
  const before = B.backupNotice();
  button('创建备份').click();
  await until(() => B.backupNotice() !== before && !B.backupTask() && !B.backupLoading(t), '备份结束', timeoutMs);
  return B.backupNotice();
}

/**
 * 用例收尾：主进程仍有备份 / 校验任务时（例如等待超时后任务还在后台运行），按主进程快照中的原任务编号、版本与目录取消，
 * 并等待它完整收尾、界面不再占用，避免连带影响共用同一服务实例的后续用例。没有任务时立即返回；不关闭服务
 */
async function drainBackup() {
  const { task } = await h.api.backupTaskState();
  if (task && !task.cancelling) await h.api.backupCancel(task.id, task.flavorId, task.root);
  await until(() => h.service.backup.taskState() === null && !B.backupActive(), '原任务收尾', 2 * LARGE_TIMEOUT_MS);
}

/** 点击读取账号与角色并等待完成 */
async function readCatalog(t, label = '读取账号与角色', timeoutMs) {
  const b = button(label);
  assert.ok(b, label);
  b.click();
  await until(() => !B.catalogLoading(t) && B.backupCatalogShown(t), '读取账号与角色', timeoutMs);
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

test('我的插件只有五个标签页；进入配置备份页才读取状态且不读 WTF，重复进入不重读；选择位置即启用；全部 WTF 时只有创建备份才读取 WTF，且不刷新插件列表', async () => {
  const A = await useTarget('t1');
  const tabLabels = localView.all().filter((e) => e.classList.contains('tab')).map((e) => e.textContent.replace(/\d+$/, ''));
  assert.deepEqual(tabLabels, ['已托管', '未托管', '回收站', '操作记录', '健康检查']);
  assert.doesNotMatch(localView.textContent, /配置备份/);
  const spy = watchAccess(path.join(A, 'WTF'));
  try {
    assert.equal(calls('backup:state'), 0, '启动与其他页面不读取备份状态');
    B.setBackupPageOpen(true);
    const t = S.currentTarget();
    await until(() => shown(t)?.status === 'disabled', '读取状态');
    assert.equal(calls('backup:state'), 1);
    B.setBackupPageOpen(true);
    await settle();
    assert.equal(calls('backup:state'), 1, '已打开时再次进入不重新读取');
    const text = view.textContent;
    assert.ok(text.includes(`${A}/WTF`), '显示真正的备份来源');
    assert.match(text, /WTF 里保存着账号、角色与插件的设置/);
    assert.match(text, /艾泽魔方不会主动上传/);
    assert.match(text, /云盘同步的文件夹，副本可能会被云盘同步/);
    assert.doesNotMatch(text, /只保存在这台电脑/);
    assert.match(text, /建议先退出游戏/);
    assert.match(text, /不是瞬间快照/);
    assert.match(text, /不提供一键还原/);
    assert.match(text, /启用后可以选择备份全部 WTF、指定账号或指定角色/);
    assert.ok(!radio('account'), '未启用时没有范围选择');
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
    assert.ok(radio('all').checked, '默认全部 WTF');
    assert.ok(button('创建备份') && !button('创建备份').disabled);
    assert.match(view.textContent, /将备份：全部 WTF/);
    assert.ok(button('在访达中查看'));
    assert.deepEqual(spy.calls, [], '打开与启用都不读取 WTF');
    assert.equal(calls('backup:catalog'), 0);

    const n = await createUi(t);
    assert.equal(n.title, '备份已完成');
    assert.ok(n.lines.includes('范围：全部 WTF'), '结果中的范围来自主进程');
    assert.deepEqual(H.ipcCalls.find((c) => c.channel === 'backup:run').args[2], { kind: 'all' }, '每次都传完整的范围');
    assert.equal(shown(t).snapshots.length, 1);
    assert.match(view.textContent, /范围：全部 WTF/);
    assert.ok(spy.calls.length > 0, '创建备份才读取 WTF');
    assert.equal(calls('local:state'), 0, '备份不经过插件列表读取（不会恢复或清理游戏目录）');
    assert.equal(calls('backup:catalog'), 0, '全部 WTF 不读取账号与角色');
    assert.equal(h.gate.activeCount, 0);
  } finally {
    spy.restore();
  }
});

test('页面隐藏时任务开始、进度与结束都不读取状态；返回时读取一次并按最新快照显示任务卡片', async () => {
  const A = await useTarget('t6');
  await enableUi('t6');
  const t = S.currentTarget();
  await until(() => !B.backupLoading(t), '读取完成');
  B.setBackupPageOpen(false);
  const counter = countState();
  const at = pause.arm('copy-file');
  const run = h.api.backupRun(F, A, { kind: 'all' });
  await at.reached;
  await until(() => B.backupTask(), '收到任务');
  assert.equal(B.backupNavBadge(), '进行中');
  for (let i = 0; i < 5; i++) h.service.pushBackupTask();
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(!button('取消'), '页面隐藏：没有任务卡片');
  at.release();
  await run;
  await until(() => !B.backupTask(), '任务结束');
  await settle();
  assert.equal(counter.n, 0, '隐藏期间不读取完整状态');
  assert.equal(B.backupNavBadge(), null);
  B.setBackupPageOpen(true);
  await until(() => counter.n === 1 && !B.backupLoading(t), '返回读取一次');
  assert.equal(shown(t).snapshots.length, 1);
  assert.equal(calls('backup:catalog'), 0);
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
  assert.ok(inTree(cancelBtn), '按钮仍在页面中');
  assert.equal(view.all().find((e) => e.classList.contains('tag-task')), tagEl);
  assert.match(view.textContent, /正在备份/);
  assert.match(view.textContent, /正在复制/);
  assert.match(view.textContent, /范围：全部 WTF/);
  assert.match(view.textContent, /0 \/ 1 个文件/, '进度文字来自最新的推送');
  assert.equal(B.backupNavBadge(), '进行中');

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
  // 离开再返回：重新读取一次，任务卡片按最新快照重建
  B.setBackupPageOpen(false);
  B.setBackupPageOpen(true);
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
  assert.match(n.lines.join('\n'), /本次请求的范围：全部 WTF/);
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

test('指定角色：切换范围不读取；点击才读取列表且不读文件内容；账号与角色都不默认选择；同一账号跨服务器的同名角色分别选择；结果与列表的范围来自主进程', async () => {
  const A = await useTarget('s1', true);
  const container = await enableUi('s1');
  const t = S.currentTarget();
  chooseKind('characters');
  assert.equal(B.backupSelection().kind, 'characters');
  assert.equal(calls('backup:catalog'), 0, '切换范围不读取');
  assert.ok(button('创建备份').disabled, '还没有列表');
  assert.match(view.textContent, /请先点击“读取账号与角色”/);
  assert.match(view.textContent, /可能含有其他角色的数据/, '角色范围直接说明共享配置');
  assert.match(view.textContent, /不解析也不裁剪/);
  assert.match(view.textContent, /不含其他角色目录、服务器目录下的直属文件/);

  const spy = watchAccess(path.join(A, 'WTF'));
  try {
    await readCatalog(t);
    assert.deepEqual(spy.calls.filter((x) => x.startsWith('open:') || x.startsWith('readFile:')), [], '只读目录名称与元数据');
  } finally {
    spy.restore();
  }
  assert.equal(calls('backup:catalog'), 1);
  const c = B.backupCatalogShown(t).data;
  assert.deepEqual(c.accounts.map((a) => a.account).sort(), ['OTHER', 'TEST']);
  assert.equal(B.backupSelection().account, null, '不默认选择账号');
  assert.ok(accountSelect(), '账号下拉框');
  assert.ok(!checkbox('RealmA', 'Bob'), '未选择账号时不显示角色');
  assert.match(view.textContent, /请选择账号/);
  assert.ok(button('创建备份').disabled);

  chooseAccount('TEST');
  assert.deepEqual(B.backupSelection().chars, [], '不默认选择角色');
  assert.ok(checkbox('RealmA', 'Bob') && checkbox('RealmB', 'Bob') && checkbox('RealmA', 'Alice'));
  assert.ok(!checkbox('RealmA', 'Carol'), '只列出所选账号的角色');
  assert.match(view.textContent, /请至少选择一个角色/);
  assert.ok(button('创建备份').disabled);
  toggle('RealmA', 'Bob');
  toggle('RealmB', 'Bob');
  assert.match(view.textContent, /已选 2 \/ 256 个角色/);
  assert.ok(!checkbox('RealmA', 'Alice').checked, '同名角色互不影响，其他角色未选');
  assert.ok(!button('创建备份').disabled);
  assert.match(view.textContent, /将备份：账号「TEST」的 2 个角色/);

  const n = await createUi(t);
  const sent = H.ipcCalls.find((c2) => c2.channel === 'backup:run').args[2];
  assert.equal(sent.kind, 'characters');
  assert.equal(sent.account, 'TEST');
  assert.deepEqual(sent.characters.map((x) => `${x.realm}/${x.character}`).sort(), ['RealmA/Bob', 'RealmB/Bob']);
  assert.equal(n.title, '备份已完成');
  assert.ok(n.lines.some((l) => /^范围：账号「TEST」的 2 个角色/.test(l)), '结果中的范围来自主进程');
  const snap = shown(t).snapshots[0];
  assert.equal(snap.scope.kind, 'characters');
  assert.match(view.textContent, /范围：账号「TEST」的 2 个角色/);
  const copied = path.join(container, snap.id, 'WTF');
  assert.ok(await exists(path.join(copied, 'Account', 'TEST', 'RealmB', 'Bob', 'AddOns.txt')));
  assert.equal(await exists(path.join(copied, 'Account', 'TEST', 'RealmA', 'Alice')), false);
  assert.equal(await exists(path.join(copied, 'Account', 'OTHER')), false);
  assert.equal(await exists(path.join(copied, 'Config.wtf')), false);

  // 换账号清空角色选择
  chooseAccount('OTHER');
  assert.deepEqual(B.backupSelection().chars, []);
  assert.ok(button('创建备份').disabled);
  // 同一目标只切换页面：选择保留，不重新读取
  B.setBackupPageOpen(false);
  B.setBackupPageOpen(true);
  await until(() => !B.backupLoading(t), '读取状态');
  assert.equal(B.backupSelection().account, 'OTHER');
  assert.equal(calls('backup:catalog'), 1);
});

test('指定账号的任务进行中：任务卡片显示任务自己的范围，与之后改动的页面选择分离；表单与读取被禁用；主体重绘与进度不重建取消按钮、不改变焦点', async () => {
  await useTarget('s2', true);
  await enableUi('s2');
  const t = S.currentTarget();
  chooseKind('account');
  await readCatalog(t);
  chooseAccount('TEST');
  assert.match(view.textContent, /将备份：账号「TEST」的完整目录/);
  const at = pause.arm('copy-file');
  const before = B.backupNotice();
  button('创建备份').click();
  await at.reached;
  await until(() => B.backupTask() && !B.backupLoading(t), '任务开始');
  assert.deepEqual(B.backupTask().scope, { kind: 'account', account: 'TEST' });
  assert.match(view.textContent, /范围：账号「TEST」（完整账号目录）/);
  assert.ok(radio('all').disabled && accountSelect().disabled && button('重新读取账号与角色').disabled, '任务期间表单与读取禁用');
  // 绕过禁用直接调用：任务期间不读取、不改选择
  await B.loadCatalog(t);
  assert.equal(calls('backup:catalog'), 1);

  const cancelBtn = button('取消');
  globalThis.document.activeElement = cancelBtn;
  focused = null;
  // 主体重绘（刷新状态、backup 事件）与进度推送
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t), '刷新');
  S.emit('backup');
  for (let i = 0; i < 3; i++) h.service.pushBackupTask();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(button('取消'), cancelBtn, '同一个取消按钮');
  assert.ok(inTree(cancelBtn), '仍在页面中');
  assert.equal(globalThis.document.activeElement, cancelBtn, '焦点不变');
  assert.equal(focused, null, '重绘没有把焦点移到别处');
  assert.equal(B.backupSelection().account, 'TEST');
  assert.match(view.textContent, /范围：账号「TEST」（完整账号目录）/, '任务卡片的范围来自任务');

  at.release();
  await until(() => !B.backupTask() && !B.backupLoading(t) && B.backupNotice() !== before, '结束');
  assert.equal(B.backupNotice().title, '备份已完成');
  // 任务结束后改选择：已完成的结果与列表仍显示原范围
  chooseKind('characters');
  assert.ok(B.backupNotice().lines.includes('范围：账号「TEST」（完整账号目录）'));
  assert.match(view.textContent, /范围：账号「TEST」（完整账号目录）/);
  globalThis.document.activeElement = undefined;
});

test('主体重绘把焦点还给同一个控件：键盘切换范围、选择账号后焦点仍在对应控件上；读取完成不抢走其他地方的焦点', async () => {
  await useTarget('s3', true);
  await enableUi('s3');
  const t = S.currentTarget();
  const r = radio('account');
  globalThis.document.activeElement = r;
  focused = null;
  chooseKind('account');
  assert.notEqual(radio('account'), r, '主体已重绘');
  assert.equal(focused, radio('account'), '焦点回到同一个选项');
  // 焦点在页面之外：读取完成后不移动焦点
  const outside = new FakeElement('input');
  globalThis.document.activeElement = outside;
  focused = null;
  await readCatalog(t);
  assert.equal(focused, null, '没有抢焦点');
  assert.equal(globalThis.document.activeElement, outside);
  globalThis.document.activeElement = undefined;
});

test('A→B→A、切换版本、解除绑定与关闭备份都使列表、选择与在途读取作废，范围类型保留，不会改成全部 WTF', async () => {
  const A = await useTarget('s4', true);
  await enableUi('s4');
  const tA = S.currentTarget();
  const Bdir = await makeGameRoot(path.join(base, 's4b'));
  chooseKind('account');
  await readCatalog(tA);
  chooseAccount('TEST');

  // 在途读取停住，期间 A→B→A：迟到的回复被丢弃
  const held = [];
  h.service.backup.catalog = async (...a) => {
    await new Promise((r) => held.push(r));
    return coreCatalog(...a);
  };
  button('重新读取账号与角色').click();
  await until(() => held.length === 1, '读取停住');
  await bindViaUi(Bdir);
  await bindViaUi(A);
  await until(() => shown(tA)?.status === 'ready' && !B.backupLoading(tA), 'A 的状态');
  assert.equal(B.backupCatalogShown(tA), null, '列表已作废');
  assert.equal(B.catalogLoading(tA), false, '在途读取已作废');
  assert.equal(B.backupSelection().account, null, '选择已作废');
  assert.equal(B.backupSelection().kind, 'account', '范围类型保留');
  held[0]();
  await settle();
  assert.equal(B.backupCatalogShown(tA), null, '迟到的列表被丢弃');
  assert.ok(button('创建备份').disabled, '不能拿旧列表创建');
  assert.match(view.textContent, /请先点击“读取账号与角色”/);
  h.service.backup.catalog = coreCatalog;

  // 切换版本再切回
  await readCatalog(tA);
  chooseAccount('TEST');
  S.setFlavor(F);
  await until(() => S.currentTarget() && shown(S.currentTarget())?.status === 'ready' && !B.backupLoading(S.currentTarget()), '切换版本后的状态');
  assert.equal(B.backupCatalogShown(tA), null);
  assert.equal(B.backupSelection().account, null);
  assert.equal(B.backupSelection().kind, 'account');

  // 解除绑定
  await readCatalog(tA);
  chooseAccount('TEST');
  await h.settings.bind(F, null);
  await S.refreshLocal();
  assert.equal(S.currentTarget(), null);
  assert.equal(B.backupSelection().account, null);
  assert.match(view.textContent, /请先选择游戏目录/);
  await h.settings.bind(F, A);
  await S.refreshLocal();
  await until(() => shown(tA)?.status === 'ready' && !B.backupLoading(tA), '重新绑定后的状态');
  assert.equal(B.backupCatalogShown(tA), null);

  // 关闭备份
  await readCatalog(tA);
  chooseAccount('TEST');
  button('关闭备份').click();
  await tick();
  clickModalButton(dom, '关闭备份');
  await until(() => shown(tA)?.status === 'disabled', '已关闭');
  assert.equal(B.backupCatalogShown(tA), null, '关闭后列表作废');
  assert.equal(B.backupSelection().account, null);
  assert.equal(B.backupSelection().kind, 'account');
  assert.ok(!radio('account'), '未启用时没有范围选择');
});

test('重新读取只保留仍存在的精确选择并提示失效项；读取失败时不能按窄范围创建，也不拿旧列表组装范围', async () => {
  const A = await useTarget('s5', true);
  await enableUi('s5');
  const t = S.currentTarget();
  chooseKind('characters');
  await readCatalog(t);
  chooseAccount('TEST');
  toggle('RealmA', 'Bob');
  toggle('RealmA', 'Alice');
  assert.equal(B.backupSelection().chars.length, 2);

  // Alice 被改名：重新读取后只保留 Bob，明确提示 Alice 失效，不替换成别的角色
  const acct = path.join(A, 'WTF', 'Account', 'TEST', 'RealmA');
  await rename(path.join(acct, 'Alice'), path.join(acct, 'Alicia'));
  await readCatalog(t, '重新读取账号与角色');
  assert.deepEqual(B.backupSelection().chars, [{ realm: 'RealmA', character: 'Bob' }]);
  assert.match(view.textContent, /之前选择的角色「Alice（RealmA）」已不在列表中/);
  assert.ok(checkbox('RealmA', 'Alicia') && !checkbox('RealmA', 'Alicia').checked, '新名称不会被自动选中');
  assert.ok(!button('创建备份').disabled);

  // 读取失败：错误显示，窄范围不能创建
  h.service.backup.catalog = async () => {
    throw new Error('模拟的读取失败');
  };
  await readCatalog(t, '重新读取账号与角色');
  assert.equal(B.backupCatalogShown(t).data, null);
  assert.match(view.textContent, /账号与角色读取失败：模拟的读取失败/);
  assert.ok(button('创建备份').disabled);
  const runs = calls('backup:run');
  await B.runBackup(t);
  assert.equal(calls('backup:run'), runs, '不发送范围');
  h.service.backup.catalog = coreCatalog;

  // 改回全部 WTF 仍可创建
  chooseKind('all');
  assert.ok(!button('创建备份').disabled);
});

test('一次最多选 256 个角色（跨服务器合计）：达到上限后未选的不能再勾选、已选的仍可取消；试图勾选第 257 个不生效；256 个可以创建；减选后恢复', async () => {
  const A = await useTarget('s6');
  const acct = path.join(A, 'WTF', 'Account', 'TEST');
  const all = [];
  for (const [realm, n] of [['RealmA', 129], ['RealmB', 128]]) {
    for (let i = 0; i < n; i++) {
      const ch = `Char${String(i).padStart(3, '0')}`;
      await mkdir(path.join(acct, realm, ch), { recursive: true });
      await writeFile(path.join(acct, realm, ch, 'AddOns.txt'), 'x\n');
      all.push([realm, ch]);
    }
  }
  await enableUi('s6');
  const t = S.currentTarget();
  // 真实复制 256 个角色目录：读取列表与备份使用较长的等待预算；无论成功或失败，都等原任务收尾后再进入下一个用例
  try {
    chooseKind('characters');
    await readCatalog(t, undefined, LARGE_TIMEOUT_MS);
    chooseAccount('TEST');
    assert.match(view.textContent, /已选 0 \/ 256 个角色/);
    for (const [realm, ch] of all.slice(0, 256)) toggle(realm, ch);
    assert.equal(B.backupSelection().chars.length, 256);
    assert.match(view.textContent, /已选 256 \/ 256 个角色，已达到一次可选的上限/, '跨服务器合计');
    const [lastRealm, lastCh] = all[256];
    const rest = checkbox(lastRealm, lastCh);
    assert.ok(rest.disabled && !rest.checked, '未选的角色不能再勾选');
    assert.ok(!checkbox(all[0][0], all[0][1]).disabled, '已选的仍可取消');
    // 过期的界面绕过禁用触发勾选：仍不能新增
    rest.checked = true;
    fire(rest, 'change');
    assert.equal(B.backupSelection().chars.length, 256);
    assert.ok(!checkbox(lastRealm, lastCh).checked);

    // 取消一个后可以再选别的
    toggle(all[0][0], all[0][1], false);
    assert.match(view.textContent, /已选 255 \/ 256 个角色/);
    assert.ok(!checkbox(lastRealm, lastCh).disabled);
    toggle(lastRealm, lastCh);
    assert.equal(B.backupSelection().chars.length, 256);
    assert.ok(!button('创建备份').disabled, '256 个可以创建');
    const n = await createUi(t, LARGE_TIMEOUT_MS);
    assert.equal(n.title, '备份已完成');
    const sent = H.ipcCalls.filter((c) => c.channel === 'backup:run').at(-1).args[2];
    assert.equal(sent.kind, 'characters');
    assert.equal(sent.characters.length, 256);
    assert.deepEqual([...new Set(sent.characters.map((c) => c.realm))].sort(), ['RealmA', 'RealmB']);

    // 备份结束后选择仍是 256 个：再试图勾选第 257 个仍不生效，下一次提交仍是 256 个
    const extra = checkbox(all[0][0], all[0][1]);
    assert.ok(extra.disabled && !extra.checked);
    extra.checked = true;
    fire(extra, 'change');
    assert.equal(B.backupSelection().chars.length, 256);
    // 减选后恢复可勾选
    toggle(lastRealm, lastCh, false);
    assert.match(view.textContent, /已选 255 \/ 256 个角色/);
    assert.ok(!checkbox(all[0][0], all[0][1]).disabled);
    assert.ok(!button('创建备份').disabled);
  } finally {
    await drainBackup();
  }
});

test('状态正在刷新或读取失败：旧备份列表仍显示，但创建、读取账号与角色、重新校验都暂停（按钮与动作入口）；范围选择不变；刷新成功后恢复，结构异常的备份仍可重新校验', async () => {
  await useTarget('s7', true);
  const container = await enableUi('s7');
  const t = S.currentTarget();
  chooseKind('all');
  await createUi(t);
  const id = shown(t).snapshots[0].id;
  chooseKind('account');
  await readCatalog(t);
  chooseAccount('TEST');
  const blocked = () => [button('创建备份').disabled, button('重新读取账号与角色').disabled, button('重新校验').disabled];
  assert.deepEqual(blocked(), [false, false, false]);

  // 正在刷新
  const ctl = holdState();
  button('刷新备份状态').click();
  await until(() => ctl.waiting.length === 1, '读取停住');
  assert.deepEqual(blocked(), [true, true, true], '刷新期间暂停');
  ctl.waiting[0]();
  await until(() => !B.backupLoading(t), '刷新完成');
  assert.deepEqual(blocked(), [false, false, false]);

  // 读取失败：保留上次的内容，操作暂停
  h.service.backup.state = async () => {
    throw new Error('模拟的状态读取失败');
  };
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t) && B.shownBackup(t)?.error, '读取失败');
  assert.equal(shown(t).status, 'ready', '保留上次的内容');
  assert.ok(view.textContent.includes(id), '旧备份仍显示');
  assert.match(view.textContent, /无法读取备份状态：模拟的状态读取失败/);
  assert.match(view.textContent, /刷新成功之前，不能创建备份、读取账号与角色或重新校验/);
  assert.deepEqual(blocked(), [true, true, true]);
  assert.ok(!button('刷新备份状态').disabled, '可以重试');
  // 过期界面的闭包或直接调用：都不发出请求
  const count = () => ({ run: calls('backup:run'), catalog: calls('backup:catalog'), verify: calls('backup:verify') });
  const before = count();
  await B.runBackup(t);
  await B.loadCatalog(t);
  await B.verifyBackup(t, id);
  assert.deepEqual(count(), before);
  assert.deepEqual(B.backupSelection(), { kind: 'account', account: 'TEST', chars: [] }, '选择保留，不改成全部 WTF');
  assert.ok(B.backupCatalogShown(t)?.data, '列表保留');

  // 刷新成功后恢复
  h.service.backup.state = coreState;
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t) && !B.shownBackup(t).error, '恢复');
  assert.deepEqual(blocked(), [false, false, false]);

  // 备份本身结构异常（状态读取成功，s.error 为诊断）：不能新建，但仍可重新校验查看原因
  await writeFile(path.join(container, id, 'WTF', 'Account', 'TEST', 'SavedVariables', 'Questie.lua'), 'QuestieConfig = { changed = true }\n');
  button('刷新备份状态').click();
  await until(() => !B.backupLoading(t) && shown(t).snapshots[0].status === 'mismatch', '刷新');
  assert.ok(shown(t).error, '有结构异常的诊断');
  assert.ok(button('创建备份').disabled);
  assert.ok(!button('重新校验').disabled, '仍可重新校验');
  const nb = B.backupNotice();
  button('重新校验').click();
  await until(() => B.backupNotice() !== nb && !B.backupTask() && !B.backupLoading(t), '校验');
  assert.match(B.backupNotice().title, /内容与清单不一致/);
});
