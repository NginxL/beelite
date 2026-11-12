// 0.2.2：编译后的渲染层（state / local / history）→ 真实 preload → 真实 AppService（假 electron）→ 临时目录。
// - 操作记录：同一目标已有记录时再次读取失败，保留旧记录并显示失败与重试；重试成功后提示消失；
// - 永久删除未完成（回收目录真实无权限）：结果不显示为成功，提示常驻页面，插件列表照常；回收站为空时不说“回收站是空的”；修复后“重试清理”完成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickModalButton, installFakeDom } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(path.join(here, '..', 'build-test', 'test', 'ipc-harness.js'));
const { addonEntries, addUnmanaged, cleanup, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } = require(path.join(here, '..', 'build-test', 'test', 'helpers.js'));

const F = 9;
const zipOf = (folder, v) => makeZip(addonEntries(folder, v));
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dom = installFakeDom(null);
const web = path.join(here, '..', 'dist', 'web', 'renderer');
const S = await import(path.join(web, 'state.js'));
const L = await import(path.join(web, 'local.js'));
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

/** 目录 A：托管插件 100（M），回收站中有一个未托管目录 Old */
async function setup() {
  const base = await realpath(await tmpDir());
  const A = await makeGameRoot(path.join(base, 'A'));
  const src = new FakeSource();
  const m = makeManager(src);
  src.set('100', F, { name: 'M', fileId: '1', zip: zipOf('ModM', 'v1') });
  await m.install(A, F, '100');
  await addUnmanaged(A, 'Old');
  const settingsFile = path.join(base, 'settings.json');
  const h = H.createHarness({ settingsFile, source: src });
  await h.policy.reload();
  await h.settings.bind(F, A);
  // 经由 IPC 移入回收站：操作记录中有一条
  await h.api.uninstallFolder('Old', F, A);
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
    flavors: [{ id: F, name: '无限', versions: ['1.60.1'], interfaceNumber: 16001, online: true }],
    categories: [],
    defaultFlavorId: F,
    configError: null,
  };
  S.state.flavorId = F;
  L.showTab('managed');
  await S.refreshLocal();
  dom.toastRoot().replaceChildren();
  return { base, A, h, settingsFile };
}

const buttonByText = (text) => view.all().find((e) => e.tagName === 'BUTTON' && e.textContent === text);
const toastList = () => dom.toastRoot().childNodes.map((t) => ({ cls: t.className, text: t.textContent }));

test('操作记录：同一目标再次读取失败时保留上次记录，显示失败原因与重试；重试成功后提示消失', async () => {
  const { base, h, settingsFile } = await setup();
  try {
    L.showTab('history');
    await until(() => (Hm.shownHistory()?.entries.length ?? 0) >= 1, '首次读取');
    const before = Hm.shownHistory();
    assert.match(view.textContent, /移入回收站/);
    assert.doesNotMatch(view.textContent, /刷新操作记录失败/);

    // 设置文件无法读取：经由真实 preload → AppService → SettingsStore 失败
    const good = await readFile(settingsFile, 'utf8');
    await writeFile(settingsFile, '{ 损坏');
    const t = S.currentTarget();
    await assert.doesNotReject(Hm.loadHistory(t));
    assert.equal(Hm.shownHistory(), before, '旧记录保留');
    const text = view.textContent;
    assert.match(text, /刷新操作记录失败，显示的是上次结果：/);
    assert.match(text, /移入回收站/, '仍可查看上次的记录');
    const retry = buttonByText('重试');
    assert.ok(retry, '有重试入口');
    assert.equal(retry.disabled, false);

    // 重试仍失败：提示保持
    retry.click();
    await until(() => !buttonByText('读取中'), '重试结束');
    assert.match(view.textContent, /刷新操作记录失败/);

    await writeFile(settingsFile, good);
    buttonByText('重试').click();
    await until(() => !/刷新操作记录失败/.test(view.textContent), '重试成功后提示消失');
    assert.match(view.textContent, /移入回收站/);
    L.showTab('managed');
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('永久删除未完成（真实无权限）：结果为警告而非成功，页面常驻待清理提示且插件列表照常；修复后点“重试清理”完成', { skip: asRoot }, async () => {
  const { base, A, h } = await setup();
  const entry = S.state.local.recovery[0];
  const stuck = path.join(A, 'Interface', '.beelite', 'trash', entry.id, 'Old');
  await chmod(stuck, 0o500);
  try {
    L.showTab('recovery');
    const p = L.purge(entry);
    clickModalButton(dom, '继续');
    await until(() => dom.modalRoot().childNodes.filter((o) => !o.classList.contains('modal-out')).length === 1 && /再次确认/.test(dom.modalRoot().textContent), '第二次确认');
    clickModalButton(dom, '永久删除');
    await p;
    const shown = toastList();
    assert.equal(shown[0].cls, 'toast toast-warn', '结果不是绿色的成功提示');
    assert.match(shown[0].text, /已从回收站移除并登记待清理，磁盘删除尚未完成/);
    assert.ok(shown.slice(1).some((t) => t.cls === 'toast toast-warn' && /未能从磁盘删除完/.test(t.text)));
    assert.equal(shown.some((t) => /已永久删除/.test(t.text)), false);

    // 刷新后：插件列表照常，回收站说明没有可恢复条目但有待清理内容，顶部提示常驻
    assert.deepEqual(S.state.local.managed.map((x) => x.modId), ['100']);
    assert.equal(S.state.local.cleanup.pending, 1);
    const text = view.textContent;
    assert.match(text, /没有可恢复的条目/);
    assert.match(text, /另有 1 项已申请永久删除、尚未清理完成的内容（不能恢复）/);
    assert.doesNotMatch(text, /回收站是空的/);
    assert.match(text, /清理未完成，不影响插件管理：1 项已申请永久删除的回收站内容尚未清理完成（已不能恢复）/);
    assert.doesNotMatch(text, /已永久删除/, '未完成的删除不称已永久删除');
    assert.match(text, /没有写入权限/);
    await S.refreshLocal();
    assert.match(view.textContent, /清理未完成/, '刷新后仍提示');

    await chmod(stuck, 0o755);
    buttonByText('重试清理').click();
    await until(() => !S.state.localLoading && S.state.local.cleanup === null, '清理完成');
    assert.doesNotMatch(view.textContent, /清理未完成/);
    assert.match(view.textContent, /回收站是空的/);

    // 操作记录如实说明
    const e = (await h.api.historyList(F, A)).entries.find((x) => x.kind === 'purge');
    assert.match(e.message, /磁盘删除尚未完成/);
    assert.equal(e.warnings.length, 1);
    L.showTab('managed');
  } finally {
    await chmod(stuck, 0o755).catch(() => undefined);
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('待清理与目录暂停写入同时存在（真实无权限 + 损坏的事务日志）：不说不影响插件管理、不提供重试清理，待清理数说明尚未检查；暂停写入的提示保留', { skip: asRoot }, async () => {
  const { base, A, h } = await setup();
  const entry = S.state.local.recovery[0];
  const meta = path.join(A, 'Interface', '.beelite');
  const stuck = path.join(meta, 'trash', entry.id, 'Old');
  await chmod(stuck, 0o500);
  try {
    await h.api.purge(entry.id, F, A);
    await writeFile(path.join(meta, 'journal.json'), '{ 损坏');
    await S.refreshLocal();
    assert.equal(S.state.local.dir.status, 'blocked');
    assert.equal(S.state.local.cleanup.checked, false);
    L.showTab('recovery');
    const text = view.textContent;
    assert.match(text, /游戏目录当前不可写入，已禁用所有写操作/, '目录保护的提示保留');
    assert.match(text, /有未完成的清理：1 项已申请永久删除、登记待清理（已不能恢复），磁盘上的内容尚未检查确认/);
    assert.match(text, /这个目录当前暂停写入（原因见下方），清理不会进行；请先处理目录保护的原因/);
    assert.doesNotMatch(text, /不影响插件管理|已永久删除|尚未清理完成（已不能恢复）/);
    assert.equal(buttonByText('重试清理'), undefined, '暂停写入时不鼓励反复重试清理');

    // 事务保护的原因处理后，刷新继续清理
    await chmod(stuck, 0o755);
    await rm(path.join(meta, 'journal.json'));
    await S.refreshLocal();
    assert.equal(S.state.local.dir.status, 'ok');
    assert.equal(S.state.local.cleanup, null);
    L.showTab('managed');
  } finally {
    await chmod(stuck, 0o755).catch(() => undefined);
    h.service.watch.stop();
    await cleanup(base);
  }
});

test('永久删除完成：结果仍为成功提示，没有待清理提示', async () => {
  const { base, h } = await setup();
  try {
    const entry = S.state.local.recovery[0];
    const p = L.purge(entry);
    clickModalButton(dom, '继续');
    await until(() => /再次确认/.test(dom.modalRoot().textContent), '第二次确认');
    clickModalButton(dom, '永久删除');
    await p;
    const shown = toastList();
    assert.deepEqual(shown.map((t) => t.cls), ['toast toast-success']);
    assert.match(shown[0].text, /^已永久删除：Old/);
    assert.equal(S.state.local.cleanup, null);
    assert.doesNotMatch(view.textContent, /清理未完成/);
  } finally {
    h.service.watch.stop();
    await cleanup(base);
  }
});
