// 诊断报告的接入（0.3.0）：真实 preload → 真实 AppService（假 electron）→ DiagnosticsService → 临时目录。
// 发送方与请求校验（界面不能给出所属者、路径或内容）；所属者来自已校验的窗口，窗口关闭即丢弃预览、不再弹框；
// 保存只经主进程的系统保存框，取消 / 已存在 / 受保护位置 / 保护列表无法读取 / 保存期间保护配置变化都保留预览；
// 健康检查直接进入同目录队列，不经过 SettingsStore / 目标比对 / 数据源；退出与客户端更新等待保存框、写入与收尾。
// 全部在临时目录中进行；应用目录是临时目录中的替身，不读取真实游戏目录、userData 或应用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiagStep } from '../src/core/diagnostics';
import type { DiagnosticReport, DiagPreviewResult } from '../src/shared/types';
import { addUnmanaged, cleanup, exists, FakeSource, makeGameRoot, tmpDir } from './helpers';
import { createHarness, type Harness } from './ipc-harness';

const F = 9;
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ready(r: DiagPreviewResult): { token: string; json: string } {
  if (r.status !== 'ready') assert.fail(`预览被拒绝：${r.code}`);
  return r;
}

/** 诊断核心的阶段钩子：在指定阶段暂停或执行动作 */
class DiagHook {
  fn: ((n: DiagStep) => Promise<void> | void) | null = null;

  pauseAt(at: DiagStep): { reached: Promise<void>; release: () => void } {
    const reached = deferred();
    const gate = deferred();
    this.fn = async (n) => {
      if (n !== at) return;
      this.fn = null;
      reached.resolve();
      await gate.promise;
    };
    return { reached: reached.promise, release: gate.resolve };
  }
}

async function setup() {
  const base = await realpath(await tmpDir());
  const userData = path.join(base, 'userData');
  await mkdir(userData);
  const A = await makeGameRoot(path.join(base, 'games', 'A'));
  await addUnmanaged(A, 'Foo');
  const picked = path.join(base, 'Desktop');
  const out = path.join(base, 'Reports');
  const appBundle = path.join(base, 'App', 'AzerCube.app');
  await mkdir(picked);
  await mkdir(out);
  await mkdir(appBundle, { recursive: true });
  const hook = new DiagHook();
  const source = new FakeSource();
  const h: Harness = createHarness({
    settingsFile: path.join(userData, 'settings.json'),
    source,
    diagnostics: { appPaths: [appBundle], hooks: { step: (n) => hook.fn?.(n) } },
  });
  await h.settings.bind(F, A);
  const done = async () => {
    await h.service.backup.shutdown();
    await cleanup(base);
  };
  return { base, userData, A, picked, out, appBundle, hook, source, h, done };
}

test('诊断 IPC：只接受主窗口；请求只能是 { flavorId, mode }（不能带所属者、路径或内容），不合法时固定拒绝；拒绝不留闸门计数', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const evil = { sender: {}, senderFrame: { url: 'https://evil.example/' } };
    await assert.rejects(h.stub.handlers.get('diagnostic:preview')!(evil, { flavorId: F, mode: 'replace' }), /拒绝来自未知页面/);
    await assert.rejects(h.stub.handlers.get('diagnostic:save')!(evil, 'x'), /拒绝来自未知页面/);
    for (const bad of [
      null, [], { flavorId: F }, { flavorId: F, mode: 'x' }, { flavorId: 999, mode: 'replace' }, { flavorId: '9', mode: 'replace' },
      { flavorId: F, mode: 'replace', owner: 'w1' }, { flavorId: F, mode: 'replace', path: f.out },
    ]) {
      assert.deepEqual(await h.api.diagnosticPreview(bad as never), { status: 'rejected', code: 'invalid-request' }, JSON.stringify(bad));
    }
    // 没有预览时保存：凭证无效，不弹框
    for (const bad of ['x', 5, null]) {
      const r = await h.api.diagnosticSave(bad as string);
      assert.equal(r.status, 'rejected');
      if (r.status === 'rejected') assert.equal(r.code, 'token-invalid');
    }
    assert.equal(h.stub.saveDialogs.length, 0);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await f.done();
  }
});

test('生成与保存：同一凭证的冻结字节原样写入新文件；系统保存框带父窗口；取消与已存在文件都保留预览、不覆盖', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const p = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    const report = JSON.parse(p.json) as DiagnosticReport;
    assert.equal(report.format, 'azercube-diagnostic');
    assert.equal(report.target.state, 'bound');
    assert.ok(!p.json.includes(f.base), '报告不含路径');
    // 取消
    h.stub.savePick = null;
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'cancelled', previewKept: true });
    assert.deepEqual(await readdir(f.out), []);
    // 保存
    const file = path.join(f.out, 'report.json');
    h.stub.savePick = file;
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'saved', bytes: Buffer.byteLength(p.json), previewKept: true });
    assert.equal(await readFile(file, 'utf8'), p.json);
    assert.equal(h.stub.saveDialogs.length, 2);
    assert.ok(h.stub.saveDialogs.every((d) => d.withWindow && d.defaultPath?.endsWith('.json')));
    // 已存在：不覆盖
    await writeFile(file, 'mine');
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'rejected', code: 'exists', previewKept: true });
    assert.equal(await readFile(file, 'utf8'), 'mine');
    // reuse 返回同一份冻结预览
    const again = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'reuse' }));
    assert.equal(again.token, p.token);
    assert.equal(again.json, p.json);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await f.done();
  }
});

test('受保护位置：游戏目录、userData、应用目录、备份位置（关闭后仍登记）都拒绝；备份设置或恢复登记无法读取时保存拒绝并保留预览', async () => {
  const f = await setup();
  const { h } = f;
  try {
    h.stub.pick = f.picked;
    const cfg = await h.api.backupConfigure(F, f.A);
    h.stub.pick = null;
    assert.ok(cfg?.containerPath);
    assert.equal((await h.api.backupDisable(F, f.A)).enabled, false);
    const p = ready(await h.api.diagnosticPreview({ flavorId: null, mode: 'replace' }));
    for (const target of [
      path.join(f.A, 'diag.json'),
      path.join(f.A, 'Interface', 'AddOns', 'diag.json'),
      path.join(f.userData, 'diag.json'),
      path.join(f.appBundle, 'diag.json'),
      path.join(cfg.containerPath, 'diag.json'),
    ]) {
      h.stub.savePick = target;
      assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'rejected', code: 'protected-location', previewKept: true }, target);
      assert.equal(await exists(target), false);
    }
    const ok = path.join(f.out, 'ok.json');
    // 备份设置损坏：无法完整确认受保护位置
    const backupSettings = path.join(f.userData, 'wtf-backup-settings.json');
    const saved = await readFile(backupSettings, 'utf8');
    await writeFile(backupSettings, '{bad');
    h.stub.savePick = ok;
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'rejected', code: 'protected-roots-unknown', previewKept: true });
    await writeFile(backupSettings, saved);
    // 恢复登记损坏
    const registry = path.join(f.userData, 'wtf-restore-registry.json');
    await writeFile(registry, '{"format":"x"}');
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'rejected', code: 'protected-roots-unknown', previewKept: true });
    assert.equal(await exists(ok), false);
    await writeFile(registry, '{bad');
    assert.equal((await h.api.diagnosticSave(p.token)).status, 'rejected');
    assert.equal(await exists(ok), false);
  } finally {
    await f.done();
  }
});

test('保护配置在保存期间变化：选择之后关闭备份（不只绑定）按 protection-changed 拒绝；绑定写入进行中时保护列表不可用', async () => {
  const f = await setup();
  const { h } = f;
  try {
    h.stub.pick = f.picked;
    assert.ok((await h.api.backupConfigure(F, f.A))?.containerPath);
    h.stub.pick = null;
    const p = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    const file = path.join(f.out, 'r.json');
    h.stub.savePick = file;
    f.hook.fn = async (n) => {
      if (n !== 'save-before-open') return;
      f.hook.fn = null;
      await h.api.backupDisable(F, f.A);
    };
    const r = await h.api.diagnosticSave(p.token);
    assert.deepEqual(r, { status: 'rejected', code: 'protection-changed', previewKept: true });
    assert.equal(await exists(file), false);

    // 绑定的实际写入进行中（写入段内）：保护列表抛错 → 无法确认
    const reached = deferred();
    const go = deferred();
    const orig = h.settings.bind.bind(h.settings);
    h.settings.bind = async (...a: Parameters<typeof orig>) => {
      reached.resolve();
      await go.promise;
      return orig(...a);
    };
    const unbinding = h.api.unbindProfile(F, f.A);
    await reached.promise;
    assert.deepEqual(await h.api.diagnosticSave(p.token), { status: 'rejected', code: 'protected-roots-unknown', previewKept: true });
    go.resolve();
    await unbinding;
    h.settings.bind = orig;
    assert.equal(await exists(file), false);
    // 写入段结束后可以保存（之前的预览仍可用）
    assert.equal((await h.api.diagnosticSave(p.token)).status, 'saved');
    assert.equal(await readFile(file, 'utf8'), p.json);
  } finally {
    await f.done();
  }
});

test('所属者：来自已校验的窗口；另一个窗口不能使用或复用它的预览；窗口关闭即丢弃预览；已关闭的窗口不能再生成或弹框', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const p1 = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    // 新窗口（旧窗口尚未销毁）：不能保存或复用旧窗口的预览
    const { old: w1 } = h.replaceWindow();
    const r = await h.api.diagnosticSave(p1.token);
    assert.deepEqual(r, { status: 'rejected', code: 'owner-mismatch', previewKept: true });
    assert.deepEqual(await h.api.diagnosticPreview({ flavorId: F, mode: 'reuse' }), { status: 'rejected', code: 'preview-exists' });
    assert.equal(h.stub.saveDialogs.length, 0);
    // 旧窗口不再是主窗口：请求被拒绝
    await assert.rejects(h.invokeAs(w1, 'diagnostic:save', p1.token), /拒绝来自未知页面/);
    // 新窗口显式替换
    const p2 = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    assert.notEqual(p2.token, p1.token);
    // 窗口关闭：预览丢弃；之后的窗口不能使用它
    h.replaceWindow({ destroyOld: true });
    const after = await h.api.diagnosticSave(p2.token);
    assert.equal(after.status, 'rejected');
    if (after.status === 'rejected') assert.equal(after.code, 'token-invalid');
    // 主窗口的页面已销毁（窗口对象尚在）：不建立所属者、不弹框
    const p3 = ready(await h.api.diagnosticPreview({ flavorId: null, mode: 'replace' }));
    h.contents()!.destroy();
    assert.deepEqual(await h.api.diagnosticPreview({ flavorId: null, mode: 'replace' }), { status: 'rejected', code: 'owner-gone' });
    assert.deepEqual(await h.api.diagnosticSave(p3.token), { status: 'rejected', code: 'owner-gone', previewKept: false });
    assert.equal(h.stub.saveDialogs.length, 0);
  } finally {
    await f.done();
  }
});

test('保存框打开期间窗口关闭：选择结果不再使用（owner-gone），不创建文件', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const p = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    const opened = deferred();
    const answer = deferred();
    const file = path.join(f.out, 'late.json');
    h.stub.saveDialog = async () => {
      opened.resolve();
      await answer.promise;
      return { canceled: false, filePath: file };
    };
    const saving = h.api.diagnosticSave(p.token);
    await opened.promise;
    h.closeWindow();
    answer.resolve();
    const r = await saving;
    assert.equal(r.status, 'rejected');
    if (r.status === 'rejected') assert.equal(r.code, 'owner-gone');
    assert.equal(await exists(file), false);
    assert.equal(h.gate.activeCount, 0);
  } finally {
    await f.done();
  }
});

test('闸门：保存框挂起时退出 / 更新等待；重复保存不再弹框；选择之后的写入阶段仍在闸门内，完整收尾后才排空', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const p = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    const opened = deferred();
    const answer = deferred();
    const file = path.join(f.out, 'gate.json');
    h.stub.saveDialog = async () => {
      opened.resolve();
      await answer.promise;
      return { canceled: false, filePath: file };
    };
    const saving = h.api.diagnosticSave(p.token);
    await opened.promise;
    assert.equal(h.gate.activeCount, 1);
    // 同时再保存：busy，不弹第二个框
    const dup = await h.api.diagnosticSave(p.token);
    assert.equal(dup.status, 'rejected');
    if (dup.status === 'rejected') assert.equal(dup.code, 'busy');
    assert.equal(h.stub.saveDialogs.length, 1);
    const { token, drained } = h.gate.freezeAndDrain();
    let done = false;
    void drained.then(() => (done = true));
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(done, false);
    // 选择之后在写入一半时暂停：仍未排空
    const mid = f.hook.pauseAt('save-write');
    answer.resolve();
    await mid.reached;
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(done, false);
    assert.equal(h.gate.activeCount, 1);
    mid.release();
    assert.equal((await saving).status, 'saved');
    await drained;
    assert.equal(await readFile(file, 'utf8'), p.json);
    // 冻结期间不受理新的生成与保存
    await assert.rejects(h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }), /正在更新或退出/);
    await assert.rejects(h.api.diagnosticSave(p.token), /正在更新或退出/);
    h.gate.unfreeze(token);
  } finally {
    await f.done();
  }
});

test('健康检查：直接进入同目录队列，不经过 SettingsStore / 目标比对 / 数据源；操作记录只读内存状态；设置损坏时仍生成应用摘要', async () => {
  const f = await setup();
  const { h } = f;
  try {
    const counts = { load: 0, profile: 0, retry: 0, list: 0 };
    const load = h.settings.load.bind(h.settings);
    const profile = h.settings.profile.bind(h.settings);
    const retry = h.history.retry.bind(h.history);
    const list = h.history.list.bind(h.history);
    h.settings.load = async () => (counts.load++, load());
    h.settings.profile = async (id: number) => (counts.profile++, profile(id));
    h.history.retry = async () => (counts.retry++, retry());
    h.history.list = async (id: number, root: string) => (counts.list++, list(id, root));
    const health: { root: string; flavorId: number }[] = [];
    const orig = h.service.manager.health.bind(h.service.manager);
    h.service.manager.health = (root, flavorId, ref) => {
      health.push({ root, flavorId });
      return orig(root, flavorId, ref);
    };
    const p = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    const report = JSON.parse(p.json) as DiagnosticReport;
    assert.deepEqual(health, [{ root: f.A, flavorId: F }]);
    assert.ok(report.health.scanned && report.health.scanned.tocsRead >= 1, JSON.stringify(report.health));
    assert.deepEqual(counts, { load: 0, profile: 0, retry: 0, list: 0 });
    assert.deepEqual(f.source.calls, []);
    // 设置损坏：不报错，只生成应用摘要部分
    await writeFile(path.join(f.userData, 'settings.json'), '{bad');
    const q = ready(await h.api.diagnosticPreview({ flavorId: F, mode: 'replace' }));
    assert.equal((JSON.parse(q.json) as DiagnosticReport).target.state, 'settings-unavailable');
    assert.equal(health.length, 1);
    assert.deepEqual(counts, { load: 0, profile: 0, retry: 0, list: 0 });
  } finally {
    await f.done();
  }
});
