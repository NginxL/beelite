// 0.2.2 配置备份页：编译后的渲染层（state / local / backup）→ 真实 preload → 真实 AppService（假 electron）→ WtfBackupService → 临时目录。
// - 启用 / 关闭的设置已保存、收尾之前用户经顶部入口解除绑定：结果说已启用 / 已关闭并说明状态未能读取，不说“未做任何改动”，
//   不覆盖当前显示的目录；保存之前绑定变化仍是失败且没有改动；取消选择没有任何结果；
// - 账号与角色列表跳过的条目：提示按位置说明影响，不再笼统推荐扩大范围；三种范围的实际结果与提示一致（真实符号链接）；
// - 「备份限制」展开状态在主体重绘、范围切换、local 事件后保持；已被替换的旧节点晚到的 toggle 事件不覆盖当前状态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, installFakeDom, toasts } from './fake-dom.mjs';

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

const base = await realpath(await tmpDir());
const userData = path.join(base, 'userData');
await mkdir(userData);
const pause = new Pauser();
const h = H.createHarness({ settingsFile: path.join(userData, 'settings.json'), source: new FakeSource(), backup: { hooks: { step: (n) => pause.step(n) } } });
globalThis.window.beelite = h.api;
h.api.onActivity((s) => S.applyActivity(s));
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
L.initLocal(document.getElementById('test-local'));

test.after(async () => {
  await h.service.backup.shutdown();
  await cleanup(base);
});

const button = (label) => view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const shown = (t) => B.shownBackup(t)?.state ?? null;
const settingsOf = async () => JSON.parse(await readFile(path.join(userData, 'wtf-backup-settings.json'), 'utf8'));
function fire(el, ev) {
  for (const fn of el.listeners[ev] ?? []) fn({ target: el });
}
function chooseKind(kind) {
  const r = view.all().find((e) => e.tagName === 'INPUT' && e.type === 'radio' && e.value === kind);
  assert.ok(r, kind);
  r.checked = true;
  fire(r, 'change');
}

/** 新的游戏目录绑定为当前目标并打开配置备份页，等待读取到状态 */
async function useTarget(name, status = 'disabled') {
  B.setBackupPageOpen(false);
  const root = await makeGameRoot(path.join(base, name));
  await h.settings.bind(F, root);
  await S.refreshLocal();
  B.setBackupPageOpen(true);
  const t = S.currentTarget();
  await until(() => shown(t)?.status === status && !B.backupLoading(t), '读取状态');
  dom.toastRoot().replaceChildren();
  return { root, t };
}

/** 经顶部入口的同一函数解除绑定（含确认框） */
async function unbindViaUi() {
  const u = S.unbindDirectory();
  await until(() => /解除游戏目录绑定/.test(dom.modalRoot().textContent), '确认框');
  clickModalButton(dom, '解除绑定');
  await u;
}

test('启用 / 关闭已保存、收尾前解除绑定：结果是已启用 / 已关闭并说明状态未能读取，不说未做任何改动；不覆盖当前目录；重新绑定显示正确状态', async () => {
  const { root, t } = await useTarget('commit-race');
  const picked = path.join(base, 'pick-commit-race');
  await mkdir(picked);

  // 启用：设置已保存，占用标记释放之前暂停
  let p = pause.arm('before-lock-release');
  h.stub.pick = picked;
  const enabling = B.enableBackup(t, null, false);
  await p.reached;
  await unbindViaUi();
  assert.equal(S.currentTarget(), null);
  p.release();
  await enabling;
  h.stub.pick = null;
  let n = B.backupNotice();
  assert.equal(n.kind, 'warn');
  assert.equal(n.title, '已启用 WTF 配置备份');
  const container = (await readdir(picked)).map((x) => path.join(picked, x))[0];
  assert.ok(container);
  assert.ok(n.lines.includes(`保存位置：${container}`), n.lines.join('\n'));
  assert.ok(n.lines.includes('设置已保存；保存之后，这个游戏版本绑定的目录已变更，没有读取原目录当前的备份状态'), n.lines.join('\n'));
  assert.doesNotMatch([n.title, ...n.lines].join('\n'), /未做任何改动|未能启用/);
  assert.equal(n.origin.root, root);
  assert.ok(toasts(dom).some((x) => x.includes(`${root}：已启用 WTF 配置备份`)), '结果属于原目录：另行提示');
  assert.equal(B.shownBackup(t), null, '没有把原目录的状态套到当前（未绑定）界面');
  let cfg = await settingsOf();
  assert.deepEqual(cfg.targets.map((x) => [x.root, x.enabled, x.containerPath]), [[root, true, container]]);

  // 重新绑定原目录：显示已启用
  await h.settings.bind(F, root);
  await S.refreshLocal();
  await until(() => shown(t)?.status === 'ready' && !B.backupLoading(t), '重新绑定后读取');
  assert.equal(shown(t).containerPath, container);

  // 关闭：同样的时序
  p = pause.arm('before-lock-release');
  const disabling = B.disableBackup(t, container);
  await until(() => /关闭此目录的 WTF 配置备份/.test(dom.modalRoot().textContent), '关闭确认框');
  clickModalButton(dom, '关闭备份');
  await p.reached;
  await unbindViaUi();
  p.release();
  await disabling;
  n = B.backupNotice();
  assert.equal(n.kind, 'warn');
  assert.equal(n.title, '已关闭 WTF 配置备份，已有备份仍保留');
  assert.ok(n.lines.includes(`保留位置：${container}`));
  assert.ok(n.lines.includes('设置已保存；保存之后，这个游戏版本绑定的目录已变更，没有读取原目录当前的备份状态'));
  assert.doesNotMatch(n.lines.join('\n'), /未做任何改动|未能关闭/);
  cfg = await settingsOf();
  assert.deepEqual(cfg.targets.map((x) => [x.root, x.enabled]), [[root, false]]);
  await h.settings.bind(F, root);
  await S.refreshLocal();
  await until(() => shown(t)?.status === 'disabled' && shown(t)?.containerPath === container && !B.backupLoading(t), '重新绑定后显示已关闭');
});

test('保存之前绑定变化：仍是失败且没有任何改动（新建的位置撤回）；取消选择没有任何结果', async () => {
  const { root, t } = await useTarget('pre-commit');
  const picked = path.join(base, 'pick-pre-commit');
  await mkdir(picked);
  const before = await settingsOf().catch(() => null);
  const p = pause.arm('configure-before-commit');
  h.stub.pick = picked;
  const enabling = B.enableBackup(t, null, false);
  await p.reached;
  await unbindViaUi();
  p.release();
  await enabling;
  h.stub.pick = null;
  const n = B.backupNotice();
  assert.equal(n.kind, 'error');
  assert.equal(n.title, '未能启用备份');
  assert.match(n.lines.join('\n'), /游戏目录绑定已变更，未做任何改动/);
  assert.deepEqual(await readdir(picked), [], '新建的备份位置已撤回');
  assert.deepEqual(await settingsOf().catch(() => null), before);
  assert.equal((before?.targets ?? []).some((x) => x.root === root), false);

  // 取消选择：主进程返回 null，不产生结果
  await h.settings.bind(F, root);
  await S.refreshLocal();
  await until(() => shown(t)?.status === 'disabled' && !B.backupLoading(t), '重新绑定');
  const prev = B.backupNotice();
  await B.enableBackup(t, null, false);
  assert.equal(B.backupNotice(), prev);
  assert.deepEqual(await settingsOf().catch(() => null), before);
});

test('账号与角色列表：跳过的条目按位置说明影响，不再笼统推荐指定账号或全部 WTF；三种范围的实际结果与说明一致', async () => {
  const { root, t } = await useTarget('catalog-links');
  const wtf = path.join(root, 'WTF');
  const outside = path.join(base, 'outside-dir');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'AddOns.txt'), 'x\n');
  for (const [acct, realm, ch] of [['ACC', 'RealmA', 'Bob'], ['ACC2', 'RealmB', 'Carol']]) {
    await mkdir(path.join(wtf, 'Account', acct, realm, ch), { recursive: true });
    await writeFile(path.join(wtf, 'Account', acct, realm, ch, 'AddOns.txt'), 'x\n');
  }
  // ACC：所选服务器下一个未选的角色是链接；ACC2：账号直属的服务器目录是链接
  await symlink(outside, path.join(wtf, 'Account', 'ACC', 'RealmA', 'Linked'));
  await symlink(outside, path.join(wtf, 'Account', 'ACC2', 'LinkRealm'));
  const picked = path.join(base, 'pick-catalog');
  await mkdir(picked);
  h.stub.pick = picked;
  await B.enableBackup(t, null, false);
  h.stub.pick = null;
  await until(() => shown(t)?.status === 'ready', '启用');
  chooseKind('characters');
  button('读取账号与角色').click();
  await until(() => !B.catalogLoading(t) && B.backupCatalogShown(t)?.data, '读取列表');

  const text = view.textContent;
  assert.match(text, /读取时有以下情况，相关条目不会出现在列表中：/);
  assert.doesNotMatch(text, /可改用指定账号或全部 WTF|需要时可改用/);
  const warnings = B.backupCatalogShown(t).data.warnings;
  const linked = warnings.find((w) => w.includes('Linked'));
  const linkRealm = warnings.find((w) => w.includes('LinkRealm'));
  assert.match(linked, /^已跳过符号链接：.*"Linked"。按角色备份这个账号的其他角色不受影响；整账号备份与全部 WTF 备份会因此停止$/);
  assert.match(linkRealm, /^已跳过符号链接：.*"LinkRealm"。这个账号的按角色备份、整账号备份与全部 WTF 备份都会因此停止$/);

  // 说明与实际一致：严格检查没有放宽
  const run = (scope) => h.api.backupRun(F, root, scope);
  const ok = await run({ kind: 'characters', account: 'ACC', characters: [{ realm: 'RealmA', character: 'Bob' }] });
  assert.equal(ok.status, 'completed');
  for (const scope of [
    { kind: 'account', account: 'ACC' },
    { kind: 'all' },
    { kind: 'characters', account: 'ACC2', characters: [{ realm: 'RealmB', character: 'Carol' }] },
    { kind: 'account', account: 'ACC2' },
  ]) {
    await assert.rejects(run(scope), /符号链接/, JSON.stringify(scope));
  }
});

test('「备份限制」展开状态：主体重绘、范围切换、local 事件后保持；旧节点晚到的 toggle 不覆盖当前状态', async () => {
  const { root, t } = await useTarget('details');
  const picked = path.join(base, 'pick-details');
  await mkdir(picked);
  h.stub.pick = picked;
  await B.enableBackup(t, null, false);
  h.stub.pick = null;
  await until(() => shown(t)?.status === 'ready', '启用');
  const details = () => {
    const all = view.all().filter((e) => e.tagName === 'DETAILS' && e.classList.contains('backup-limits'));
    assert.equal(all.length, 1);
    return all[0];
  };
  const el1 = details();
  assert.equal(el1.open, false);
  assert.equal('open' in el1.attrs, false, '布尔属性，不设置 open 特性');

  // 用户展开；toggle 事件尚未派发时主体就因范围切换重绘
  el1.open = true;
  chooseKind('account');
  const el2 = details();
  assert.notEqual(el2, el1, '主体重绘重建了节点');
  assert.equal(el2.open, true, '重绘前读取了展开状态');
  fire(el1, 'toggle');
  S.emit('local');
  const el3 = details();
  assert.equal(el3.open, true, 'local 事件后保持展开');

  // 用户收起后立即重绘；之后两个旧节点的 toggle 才到达（el1 仍是展开的），不能把状态改回展开
  el3.open = false;
  S.emit('backup');
  const el4 = details();
  assert.equal(el4.open, false);
  fire(el1, 'toggle');
  fire(el3, 'toggle');
  chooseKind('all');
  assert.equal(details().open, false, '旧节点的事件被忽略');

  // 页面暂时没有这个面板（解除绑定）时旧节点的事件才到达：重绘前没有可读取的节点，只能靠忽略旧事件保持收起
  await h.settings.bind(F, null);
  await S.refreshLocal();
  assert.equal(view.all().some((e) => e.tagName === 'DETAILS'), false);
  fire(el1, 'toggle');
  await h.settings.bind(F, root);
  await S.refreshLocal();
  await until(() => shown(t)?.status === 'ready' && !B.backupLoading(t), '重新绑定');
  assert.equal(details().open, false, '旧节点（仍是展开的）晚到的事件没有改回展开');

  // 当前节点自己的 toggle 正常记录
  const el5 = details();
  el5.open = true;
  fire(el5, 'toggle');
  S.emit('backup');
  assert.equal(details().open, true);
  // 离开页面再回来（同一会话）：保持
  B.setBackupPageOpen(false);
  B.setBackupPageOpen(true);
  await until(() => !B.backupLoading(t), '重新读取');
  assert.equal(details().open, true);
});

test('启用已保存、保存后备份状态为不可用（标记在收尾前被移走）：结果是已启用，并说明备份状态当前不可用，不错指为未保存', async () => {
  const { root, t } = await useTarget('saved-unavailable');
  const picked = path.join(base, 'pick-saved-unavailable');
  await mkdir(picked);
  const p = pause.arm('before-lock-release');
  h.stub.pick = picked;
  const enabling = B.enableBackup(t, null, false);
  await p.reached;
  const [name] = await readdir(picked);
  const marker = path.join(picked, name, '.azercube-wtf-backup.json');
  await rename(marker, `${marker}.moved`);
  p.release();
  await enabling;
  h.stub.pick = null;
  const n = B.backupNotice();
  assert.equal(n.kind, 'warn');
  assert.equal(n.title, '已启用 WTF 配置备份');
  const unavailable = n.lines.filter((l) => l.startsWith('设置已保存，但备份状态当前不可用：'));
  assert.equal(unavailable.length, 1, n.lines.join('\n'));
  assert.match(unavailable[0], /标记缺失或不符/);
  assert.doesNotMatch(n.lines.join('\n'), /备份位置当前不可用|未做任何改动|未能启用/);
  assert.equal(shown(t)?.status, 'unavailable', '当前目录采用返回的状态');
  assert.equal((await settingsOf()).targets.find((x) => x.root === root)?.enabled, true);
  await rename(`${marker}.moved`, marker);
});
