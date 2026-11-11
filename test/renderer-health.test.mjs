// 健康检查标签页（0.2.0）：编译后的渲染层（state / local / health）→ 真实 preload → 真实 AppService（假 electron）→ 临时目录。
// 打开标签页不读取、只有点击才检查；检查不经过本地状态读取；重复点击不并发；切换版本 / 换目录丢弃旧回复；
// 错误状态与重试；参考版本未知的说明；提示按纯文本显示；之后的插件写操作把结果标为上次检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, installFakeDom } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;
const OTHER = 6;
const zipOf = (folder, v) => makeZip(addonEntries(folder, v));

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const Hh = await import(path.join(web, 'health.js'));

const view = document.getElementById('test-local');
L.initLocal(view);

async function until(fn, what) {
  for (let i = 0; i < 600; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}
const tick = () => new Promise((r) => setImmediate(r));

async function addNeeds(root) {
  const dir = path.join(root, 'Interface', 'AddOns', 'Needs');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'Needs.toc'), '## Interface: 16001\n## Title: <b>Needs</b>\n## Dependencies: MissingLib, <img onerror=x>\n');
}

async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
  await makeManager(src).install(A, F, '100');
  await addNeeds(A);
  const h = H.createHarness({ settingsFile: path.join(base, 'settings.json'), source: src });
  await h.policy.reload();
  await h.settings.bind(F, A);
  globalThis.window.beelite = h.api;
  h.api.onActivity((s) => S.applyActivity(s));
  dom.toastRoot().replaceChildren();
  S.state.busy.clear();
  S.state.activity = null;
  await S.syncActivity();
  S.state.localError = null;
  S.state.config = {
    flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }, { id: OTHER, name: '经典', versions: [], interfaceNumber: null, online: true }],
    categories: [],
    defaultFlavorId: F,
    configError: null,
  };
  S.state.flavorId = F;
  Hh.resetHealth();
  L.showTab('managed');
  await S.refreshLocal();
  H.ipcCalls.length = 0;
  return { base, A, src, h };
}

const calls = (channel) => H.ipcCalls.filter((c) => c.channel === channel).length;
const button = (label) => view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);

/** 让主进程的检查停住，直到 release（多次调用总是包装最初的实现，不叠加） */
const baseHealth = new WeakMap();
function holdHealth(h) {
  const manager = h.service.manager;
  if (!baseHealth.has(manager)) baseHealth.set(manager, manager.health.bind(manager));
  const original = baseHealth.get(manager);
  const ctl = { started: 0, release: null };
  manager.health = async (...a) => {
    ctl.started++;
    await new Promise((r) => (ctl.release = r));
    return original(...a);
  };
  return ctl;
}

test('打开标签页不读取；点击才检查一次，不读取本地状态；结果显示状态、计数、范围、参考未知说明，提示按纯文本显示', async () => {
  const { base, h } = await setup();
  try {
    L.showTab('health');
    await tick();
    assert.equal(calls('health:check'), 0, '打开标签页不检查');
    assert.match(view.textContent, /尚未检查/);
    assert.match(view.textContent, /检查范围/);
    assert.ok(button('开始检查'));

    button('开始检查').click();
    const t = S.currentTarget();
    await until(() => Hh.shownHealth(t)?.report, '检查完成');
    assert.equal(calls('health:check'), 1);
    assert.equal(calls('local:state'), 0, '检查前后都不读取本地状态（不会触发恢复）');
    const r = Hh.shownHealth(t).report;
    const text = view.textContent;
    assert.match(text, /适配参考版本未知，本次未比较 Interface/);
    assert.match(text, new RegExp(`需要留意 ${r.counts.warning} · 无法确认 ${r.counts.unknown} · 参考信息 ${r.counts.info}`));
    assert.ok(text.includes(r.scope), '显示检查范围');
    if (r.status === 'complete') assert.match(text, /已完成范围内的检查，不代表游戏内运行正常/);
    const evil = r.issues.find((i) => i.message.includes('<img onerror=x>'));
    assert.ok(evil, '核心给出了包含原样文本的提示');
    assert.ok(text.includes(evil.message), '提示原样作为文本出现（没有当作 HTML 解析）');
    assert.ok(button('重新检查'));
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await cleanup(base);
  }
});

test('检查进行中重复点击不再发起；后端也只扫描一次', async () => {
  const { base, h } = await setup();
  try {
    const ctl = holdHealth(h);
    L.showTab('health');
    button('开始检查').click();
    await until(() => ctl.started === 1, '检查开始');
    const t = S.currentTarget();
    assert.equal(Hh.healthChecking(t), true);
    const busy = view.all().find((e) => e.tagName === 'BUTTON' && /检查中/.test(e.textContent));
    assert.ok(busy?.disabled, '按钮显示检查中并禁用');
    busy.click();
    await Hh.runHealthCheck(t);
    // 直接调用 IPC 的重复请求同样复用主进程中进行中的检查
    const direct = h.api.healthCheck(t.flavorId, t.root);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(calls('health:check'), 2, '界面只发出一次，另一次是直接调用');
    assert.equal(ctl.started, 1, '主进程只扫描一次');
    ctl.release();
    await direct;
    await until(() => !Hh.healthChecking(t), '检查结束');
  } finally {
    await cleanup(base);
  }
});

test('检查进行中切换游戏版本或换目录：旧回复被丢弃，新目标不显示旧结果', async () => {
  const { base, h, src } = await setup();
  try {
    let ctl = holdHealth(h);
    L.showTab('health');
    const tA = S.currentTarget();
    button('开始检查').click();
    await until(() => ctl.started === 1, '检查开始');
    S.setFlavor(OTHER);
    ctl.release();
    await until(() => calls('local:state') >= 1 && !S.state.localLoading, '切换完成');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(Hh.shownHealth(tA), null, '切换版本后的旧回复不显示');
    S.setFlavor(F);
    await until(() => !S.state.localLoading && S.currentTarget(), '切回');
    assert.equal(Hh.shownHealth(S.currentTarget()), null);
    assert.match(view.textContent, /尚未检查/);

    // 同一版本换目录：A 的回复不显示到 B
    const B = await makeGameRoot(path.join(base, 'B'));
    await makeManager(src).install(B, F, '100');
    ctl = holdHealth(h);
    button('开始检查').click();
    await until(() => ctl.started === 1, 'A 的检查开始');
    await h.settings.bind(F, B);
    await S.refreshLocal();
    const tB = S.currentTarget();
    assert.equal(tB.root, B);
    ctl.release();
    for (let i = 0; i < 40; i++) await tick();
    assert.equal(Hh.shownHealth(tB), null, 'B 没有显示 A 的结果');
    assert.doesNotMatch(view.textContent, /MissingLib/);
    assert.ok(button('开始检查'), 'B 可以开始自己的检查');
  } finally {
    await cleanup(base);
  }
});

/** 经真实的界面绑定流程（系统目录选择 → 确认 → 主进程绑定 → 刷新本地状态）把当前版本绑定到 root */
async function bindViaUi(h, root) {
  h.stub.pick = root;
  assert.equal(await S.bindDirectory(), true);
  assert.equal(S.currentTarget().root, root);
}

/** 点击开始检查并等结果 */
async function checkNow() {
  const t = S.currentTarget();
  button(Hh.shownHealth(t) ? '重新检查' : '开始检查').click();
  await until(() => Hh.shownHealth(t)?.report && !Hh.healthChecking(t), '检查完成');
}

test('同一版本经界面换绑 A→B→A：已完成的 A 结果在换绑时作废，切回 A 不复活；同一目标的普通刷新保留结果', async () => {
  const { base, A, h, src } = await setup();
  try {
    const B = await makeGameRoot(path.join(base, 'B'));
    await makeManager(src).install(B, F, '100');
    L.showTab('health');
    await checkNow();
    const tA = S.currentTarget();
    await S.refreshLocal();
    assert.ok(Hh.shownHealth(tA)?.report, '目标不变的刷新不清除结果');
    assert.equal(Hh.shownHealth(tA).stale, false);

    await bindViaUi(h, B);
    assert.equal(Hh.shownHealth(S.currentTarget()), null);
    await bindViaUi(h, A);
    assert.equal(Hh.shownHealth(S.currentTarget()), null, '切回 A 不显示换绑之前的结果');
    assert.match(view.textContent, /尚未检查/);
    assert.ok(button('开始检查'));
    assert.equal(calls('health:check'), 1, '换绑与刷新没有触发检查');
  } finally {
    await cleanup(base);
  }
});

test('A 的检查进行中经界面换绑到 B 再切回 A：迟到的 A 回复被丢弃，不显示也不占用检查', async () => {
  const { base, A, h, src } = await setup();
  try {
    const B = await makeGameRoot(path.join(base, 'B'));
    await makeManager(src).install(B, F, '100');
    const ctl = holdHealth(h);
    L.showTab('health');
    button('开始检查').click();
    await until(() => ctl.started === 1, 'A 的检查开始');
    await bindViaUi(h, B);
    assert.equal(Hh.healthChecking(S.currentTarget()), false);
    await bindViaUi(h, A);
    const tA = S.currentTarget();
    assert.equal(Hh.healthChecking(tA), false, '换绑之前发起的检查已作废');
    ctl.release();
    for (let i = 0; i < 40; i++) await tick();
    assert.equal(Hh.shownHealth(tA), null, '迟到的回复不显示');
    assert.match(view.textContent, /尚未检查/);
  } finally {
    await cleanup(base);
  }
});

test('解除绑定再重新绑定同一目录、设置读取失败后恢复：旧结果都作废', async () => {
  const { base, A, h } = await setup();
  try {
    L.showTab('health');
    await checkNow();
    const run = S.unbindDirectory();
    clickModalButton(dom, '解除绑定');
    await run;
    assert.equal(S.currentTarget(), null);
    await bindViaUi(h, A);
    assert.equal(Hh.shownHealth(S.currentTarget()), null, '解除绑定前的结果不复活');

    await checkNow();
    const settingsFile = path.join(base, 'settings.json');
    const good = await readFile(settingsFile);
    await writeFile(settingsFile, '{"schema":1,"bindings":');
    await S.refreshLocal();
    assert.equal(S.currentTarget(), null, '读取失败：没有当前目标');
    await writeFile(settingsFile, good);
    await S.refreshLocal();
    assert.equal(S.currentTarget().root, A);
    assert.equal(Hh.shownHealth(S.currentTarget()), null, '读取失败期间无法确认目标，恢复后不沿用旧结果');
  } finally {
    await cleanup(base);
  }
});

test('检查失败显示原因并可重新检查；之后的插件写操作把结果标为上次检查、可能已过期', async () => {
  const { base, h } = await setup();
  try {
    const manager = h.service.manager;
    const original = manager.health.bind(manager);
    manager.health = async () => {
      throw new Error('读取失败（测试）');
    };
    L.showTab('health');
    const t = S.currentTarget();
    button('开始检查').click();
    await until(() => Hh.shownHealth(t)?.error, '失败');
    assert.match(view.textContent, /检查失败：读取失败（测试）/);
    manager.health = original;
    button('重新检查').click();
    await until(() => Hh.shownHealth(t)?.report, '重试成功');
    assert.equal(Hh.shownHealth(t).stale, false);
    assert.doesNotMatch(view.textContent, /可能已过期/);

    await S.runWrite(S.modKey(t, '100'), () => h.api.uninstallProject('100', t.flavorId, t.root));
    assert.equal(Hh.shownHealth(t).stale, true);
    assert.match(view.textContent, /上次检查/);
    assert.match(view.textContent, /可能已过期，请重新检查/);
  } finally {
    await cleanup(base);
  }
});
