// 暂停更新与操作记录的界面（0.2.0）：编译后的渲染层（state / local / actions / history）→ 真实 preload → 真实 AppService（假 electron）
// → PolicyStore / HistoryStore / AddonManager → 临时目录。验证行内暂停 / 恢复、所有更新入口一致拦截、策略不可用时 fail closed、
// 操作记录标签页与过期回复丢弃、记录未保存的持续提示与重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, toasts } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));
const { HistoryStore } = require(path.join(here, '..', 'build-test', 'src', 'core', 'history.js'));
const { writeFileAtomic } = require(path.join(here, '..', 'build-test', 'src', 'core', 'layout.js'));

const F = 9;
const OTHER = 6;
const zipOf = (folder, v) => makeZip(addonEntries(folder, v));

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
const A_ = await import(path.join(web, 'actions.js'));
const Hm = await import(path.join(web, 'history.js'));

const view = document.getElementById('test-local');
L.initLocal(view);

async function until(fn, what) {
  for (let i = 0; i < 600; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 目录 A：100（M）与 200（N）装的是文件 1，远端为文件 2 */
async function setup({ history } = {}) {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  const m = makeManager(src);
  src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
  src.set('200', F, { name: 'N', fileId: '1', zip: zipOf('ModN', 'v1') });
  await m.install(A, F, '100');
  await m.install(A, F, '200');
  src.set('100', F, { name: 'M', fileId: '2', zip: zipOf('ModM', 'v2') });
  src.set('200', F, { name: 'N', fileId: '2', zip: zipOf('ModN', 'v2') });
  const h = H.createHarness({ settingsFile: path.join(base, 'settings.json'), source: src, history: history?.(base) });
  await h.policy.reload();
  await h.settings.bind(F, A);
  globalThis.window.beelite = h.api;
  h.api.onAddonWatch((s) => S.applyWatch(s));
  h.api.onActivity((s) => S.applyActivity(s));
  h.api.onHistoryStatus((s) => S.applyHistoryStatus(s));
  dom.modalRoot().replaceChildren();
  dom.toastRoot().replaceChildren();
  S.state.busy.clear();
  S.state.notes.clear();
  S.state.activity = null;
  await S.syncActivity();
  S.state.watch = null;
  S.state.history = null;
  await S.syncHistoryStatus();
  S.state.localError = null;
  S.state.config = {
    flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }, { id: OTHER, name: '经典', versions: [], interfaceNumber: null, online: true }],
    categories: [],
    defaultFlavorId: F,
    configError: null,
  };
  S.state.flavorId = F;
  L.showTab('managed');
  await S.refreshLocal();
  await S.checkUpdates(true);
  dom.toastRoot().replaceChildren();
  H.ipcCalls.length = 0;
  const p = (id) => S.state.local.managed.find((x) => x.modId === id);
  return { base, A, src, h, p };
}

function row(name) {
  const r = view.all().find((e) => e.classList.contains('row') && e.all().some((n) => n.classList.contains('row-name') && n.textContent === name));
  assert.ok(r, `找不到 ${name} 的行`);
  return r;
}
const buttons = (name) => row(name).all().filter((e) => e.tagName === 'BUTTON');
const buttonMap = (name) => Object.fromEntries(buttons(name).map((b) => [b.textContent, b.disabled]));
const clickRow = (name, label) => {
  const b = buttons(name).find((x) => x.textContent === label);
  assert.ok(b, `${name} 没有按钮 ${label}`);
  b.click();
};
const writeCalls = () => H.ipcCalls.filter((c) => !['local:state', 'addon:watchState', 'addon:activityState', 'history:status', 'history:list'].includes(c.channel));

test('行内暂停：保留当前版本，真实新版本仍显示；更新 / 重装 / 发现页按钮与直接调用一致拦截；计数排除；恢复后立即可更新', async () => {
  const { base, A, h, p } = await setup();
  try {
    assert.equal(S.updateCount(), 2);
    assert.deepEqual(buttonMap('M'), { 更新: false, 暂停更新: false, 重装: false, 卸载: false });

    clickRow('M', '暂停更新');
    await until(() => S.isPaused('100') && !S.state.busy.size, '暂停生效');
    assert.deepEqual(writeCalls().map((c) => c.channel), ['policy:set']);
    assert.match(row('M').textContent, /已暂停更新/);
    assert.match(row('M').textContent, /有新版本 v2/, '暂停不掩盖真实的新版本');
    assert.doesNotMatch(row('M').textContent, /已是最新/);
    assert.deepEqual(buttonMap('M'), { 恢复更新: false, 重装: true, 卸载: false });
    assert.equal(S.updateCount(), 1);
    assert.equal(S.pendingByFlavor().get(F), 1);
    assert.equal(S.currentWatchEntry().pending, 1, '主进程的待更新数同样排除');
    assert.match(view.querySelector('.local-toolbar').textContent, /全部更新 \(1\)/);
    const disc = A_.modActionButton({ id: '100', accessible: true });
    assert.deepEqual([disc.textContent, disc.disabled], ['已暂停更新', true]);

    // 按钮之外的入口：不发请求
    H.ipcCalls.length = 0;
    await A_.updateProject(p('100'), false);
    await A_.updateProject(p('100'), true);
    assert.deepEqual(writeCalls(), []);
    assert.ok(toasts(dom).some((t) => t.includes('已暂停更新')));
    // 绕过界面直接走 IPC：主进程拒绝
    await assert.rejects(h.api.update('100', F, true, { fileId: p('100').fileId, installedAt: p('100').installedAt }, A), /已暂停更新/);

    // 全部更新只处理未暂停的插件
    await L.doUpdateAll();
    assert.equal(p('200').fileId, '2');
    assert.equal(p('100').fileId, '1');
    assert.ok(toasts(dom).some((t) => /已暂停更新未处理 1 个/.test(t)));

    clickRow('M', '恢复更新');
    await until(() => !S.isPaused('100') && !S.state.busy.size, '恢复生效');
    assert.equal(S.updateCount(), 1);
    assert.equal(buttonMap('M')['更新'], false);
    assert.equal(A_.modActionButton({ id: '100', accessible: true }).textContent, '更新');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('策略无法读取：不显示为可更新或已是最新，所有更新入口禁用并提示；重试读取后恢复', async () => {
  const { base, h, p } = await setup();
  try {
    const file = path.join(base, 'addon-policy.json');
    await writeFile(file, '{"schema":1,"paused":[');
    await S.reloadPolicy();
    assert.ok(S.state.watch.policyError);
    assert.equal(S.updateCount(), 0);
    assert.match(view.textContent, /更新策略无法读取，已停止所有插件更新/);
    assert.deepEqual(buttonMap('M'), { 暂不可更新: true, 暂停更新: true, 重装: true, 卸载: false });
    assert.equal(A_.modActionButton({ id: '100', accessible: true }).textContent, '暂不可更新');
    H.ipcCalls.length = 0;
    await A_.updateProject(p('100'), false);
    assert.deepEqual(writeCalls(), []);

    dom.toastRoot().replaceChildren();
    await S.checkUpdates(false);
    assert.ok(toasts(dom).some((t) => t.includes('有新版本')));
    assert.ok(!toasts(dom).some((t) => t.includes('所有插件均为最新')));

    await writeFile(file, JSON.stringify({ schema: 1, paused: [] }));
    const retry = view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === '重试');
    assert.ok(retry, '提示中有重试按钮');
    retry.click();
    await until(() => !S.state.watch.policyError && !S.state.busy.size, '重新读取成功');
    assert.equal(S.updateCount(), 2);
    assert.equal(buttonMap('M')['更新'], false);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('策略无法读取且没有新版本：行内与手动检查都不说“已是最新”，提示无法确认可更新状态', async () => {
  const { base, src, h } = await setup();
  try {
    src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
    src.set('200', F, { name: 'N', fileId: '1', zip: zipOf('ModN', 'v1') });
    await S.checkUpdates(true);
    assert.match(row('M').textContent, /已是最新/, '策略正常时照常显示');
    await writeFile(path.join(base, 'addon-policy.json'), 'broken');
    await S.reloadPolicy();
    assert.ok(S.state.watch.policyError);
    for (const name of ['M', 'N']) {
      assert.doesNotMatch(row(name).textContent, /已是最新/, name);
      assert.match(row(name).textContent, /无法确认可更新状态/, name);
    }
    dom.toastRoot().replaceChildren();
    await S.checkUpdates(false);
    const t = toasts(dom).join(' | ');
    assert.match(t, /更新策略不可用，无法确认可更新状态/);
    assert.doesNotMatch(t, /均为最新|已是最新/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('手动检查：可更新与检查失败同时存在时分别列出数量，不出现自相矛盾的“其余”说法', async () => {
  const { base, src, h } = await setup();
  try {
    src.mods.delete('200'); // N 的查询失败
    dom.toastRoot().replaceChildren();
    await S.checkUpdates(false);
    const t = toasts(dom).join(' | ');
    assert.match(t, /发现 1 个插件可更新；1 个插件检查失败/);
    assert.doesNotMatch(t, /其余|均为最新/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('在别处换绑 A→B（检查协调器还没有 B 的条目）：B 立即可操作且不继承 A 的暂停；切回 A 暂停仍在；快照获取失败时更新关闭并可重新同步', async () => {
  const { base, A, src, h } = await setup();
  try {
    clickRow('M', '暂停更新');
    await until(() => S.isPaused('100') && !S.state.busy.size, '暂停生效');
    const B = await makeGameRoot(path.join(base, 'B'));
    await makeManager(src).install(B, F, '100');
    await h.settings.bind(F, B); // 不经过界面的绑定变更
    await S.refreshLocal();
    assert.equal(S.currentTarget().root, B);
    assert.equal(S.currentWatchEntry(), undefined, '检查协调器尚未同步到 B');
    assert.equal(S.policyBlock(), null, '暂停列表已知，不因缺少检查条目而卡在“同步中”');
    assert.equal(S.isPaused('100'), false, 'B 不继承 A 的暂停');
    assert.deepEqual(buttonMap('M'), { 暂停更新: false, 重装: false, 卸载: false });

    await h.settings.bind(F, A);
    await S.refreshLocal();
    assert.equal(S.isPaused('100'), true, '切回 A 暂停仍在');

    // 快照获取失败：暂停状态未知，更新与重装关闭，页面提供重新同步
    const realApi = globalThis.window.beelite;
    globalThis.window.beelite = { ...realApi, watchState: async () => { throw new Error('读取失败（测试）'); } };
    S.state.watch = null;
    S.state.watchError = null;
    await S.syncWatch();
    assert.match(S.policyBlock() ?? '', /未能同步/);
    assert.equal(buttonMap('M')['重装'], true);
    assert.match(view.textContent, /插件更新状态未能同步/);
    globalThis.window.beelite = realApi;
    const retry = view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === '重新同步');
    assert.ok(retry);
    retry.click();
    await until(() => S.state.watch && !S.state.watchError, '重新同步成功');
    assert.equal(S.policyBlock(), null);
    assert.equal(S.isPaused('100'), true);
    assert.doesNotMatch(view.textContent, /插件更新状态未能同步/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('操作记录标签页：显示当前目标的记录与回执版本；切换版本后旧回复被丢弃', async () => {
  const { base, h, p } = await setup();
  try {
    await A_.updateProject(p('200'), false);
    L.showTab('history');
    await until(() => (Hm.shownHistory()?.entries.length ?? 0) >= 1, '记录已读取');
    const text = view.textContent;
    assert.match(text, /成功/);
    assert.match(text, /v1（文件 1） → v2（文件 2）/);
    assert.match(text, /“成功”只表示已确认提交/);

    // 读取进行中切换游戏版本：回复到达后不显示
    const pending = Hm.loadHistory({ flavorId: F, root: S.currentTarget().root });
    S.setFlavor(OTHER);
    await pending;
    assert.equal(Hm.shownHistory(), null, '旧目标的记录被丢弃');
    S.setFlavor(F);
    await until(() => !S.state.localLoading && S.currentTarget(), '切回');
    L.showTab('managed');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('操作记录未保存：插件操作照常完成，页面持续提示，点击重试保存后提示消失', async () => {
  const ctl = { fail: true };
  const { base, h } = await setup({
    history: (dir) => new HistoryStore(path.join(dir, 'operation-history.json'), {
      write: async (f, t) => (ctl.fail ? Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) : writeFileAtomic(f, t)),
    }),
  });
  try {
    clickRow('M', '暂停更新');
    await until(() => S.isPaused('100') && !S.state.busy.size, '暂停生效');
    assert.ok(toasts(dom).some((t) => t.includes('操作记录未能保存')), '单独提示');
    await until(() => S.historyProblem() !== null, '状态推送');
    assert.match(view.textContent, /尚未保存/);
    // 刷新后仍提示（不是一次性的 toast）
    await S.refreshLocal();
    assert.match(view.textContent, /尚未保存/);

    ctl.fail = false;
    const btn = view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === '重试保存记录');
    assert.ok(btn);
    btn.click();
    await until(() => S.historyProblem() === null && !S.state.busy.size, '保存成功');
    assert.doesNotMatch(view.textContent, /尚未保存/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
