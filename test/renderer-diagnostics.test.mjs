// 诊断报告页（0.3.0）：编译后的 renderer/diagnostics.js + 假 DOM + 合成 ports（不经过真实 IPC）。
// 打开不生成；点击一次只请求一次 replace 预览；全文按原文纯文本显示；保存只提交同一 token；全部保存结果分支的固定文案；
// 生成失败保留旧预览；目标 A→B→A 的旧报告提醒；销毁后晚到结果不更新界面；预览过期禁用保存。
// 编译输出默认取 dist/web；AZERCUBE_DIAG_WEB_DIR 可指向独立编译目录（其下应有 renderer/diagnostics.js）。
// 模块状态是单实例：每个页面用带唯一查询串的 URL 重新加载模块，互不影响（同一用例内重新打开页面仍用同一份模块）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeDom } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
installFakeDom(null);
const webDir = process.env.AZERCUBE_DIAG_WEB_DIR || path.join(here, '..', 'dist', 'web');
const moduleUrl = pathToFileURL(path.join(webDir, 'renderer', 'diagnostics.js')).href;
let loads = 0;
/** 全新的模块实例（独立的预览状态） */
const freshModule = () => import(`${moduleUrl}?instance=${++loads}`);

const CANARY = 'zqCanaryErrorText /Users/zq';
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const A = { flavorId: 9, key: '9\n/a', label: '无限 · 目录 A' };
const B = { flavorId: 2, key: '2\n/b', label: '正式服 · 目录 B' };

function reportJson(o = {}) {
  const sec = (state = 'ok', reason = null) => ({ state, reason });
  const r = {
    format: 'azercube-diagnostic',
    schema: 1,
    consistency: 'not-atomic',
    app: { version: '0.3.0', platform: 'darwin' },
    generatedAt: 1_700_000_000_000,
    limits: {},
    settings: { ...sec(), boundFlavorIds: [9], unknownBindings: 0 },
    target: { flavorId: 9, state: 'bound' },
    addons: { ...sec(), total: 3, recoveryEntries: 0, purgeQueued: 0, items: [{ alias: 'p1', modId: '1', fileId: '2', flavorId: 9, folders: ['f1'], foldersOmitted: 0 }], omitted: { limit: 2, byteBudget: 0 } },
    history: { ...sec(), total: 1, invalidEntries: 0, byStatus: {}, unsaved: 0, dropped: 0, storeFailing: false, recentFailures: [], omitted: { limit: 0, byteBudget: 0 } },
    health: { ...sec(), status: 'complete', unavailableReason: null, manifestState: 'ok', counts: { warning: 1, unknown: 0, info: 0 }, truncated: null, scanned: null, invalidIssues: 0, issues: [], omitted: { limit: 0, byteBudget: 0 } },
    ...o,
  };
  return `${JSON.stringify(r, null, 1)}\n`;
}

let tokenSeq = 0;
function readyFor(p, json = reportJson(), extra = {}) {
  return { status: 'ready', token: `tok${++tokenSeq}`, json, bytes: Buffer.byteLength(json, 'utf8'), expiresAt: p.t + 60_000, reused: false, ...extra };
}

function makePorts() {
  const p = {
    target: A,
    listeners: new Set(),
    previewCalls: [],
    saveCalls: [],
    t: 1_000_000,
    timers: [],
    onPreview: null,
    onSave: null,
    preview(req) {
      p.previewCalls.push(req);
      return p.onPreview(req);
    },
    save(token, ...rest) {
      assert.equal(rest.length, 0, '保存只提交 token');
      p.saveCalls.push(token);
      return p.onSave(token);
    },
    getTarget: () => p.target,
    onTargetChange(fn) {
      p.listeners.add(fn);
      return () => p.listeners.delete(fn);
    },
    now: () => p.t,
    setTimer(fn, ms) {
      const h = { fn, ms };
      p.timers.push(h);
      return h;
    },
    clearTimer(h) {
      p.timers = p.timers.filter((x) => x !== h);
    },
    setTarget(t) {
      p.target = t;
      for (const fn of [...p.listeners]) fn();
    },
  };
  p.onPreview = async () => readyFor(p);
  p.onSave = async () => ({ status: 'saved', bytes: 1, previewKept: true });
  return p;
}

const q = (root, cls) => root.querySelector(`.${cls}`);
const buttons = (root) => root.all().filter((e) => e.tagName === 'BUTTON');
const notice = (root) => {
  const n = q(root, 'diagnostic-notice');
  return n.hidden ? '' : n.textContent;
};
const shown = (el) => !el.hidden;

/** 新的模块实例上新建界面；fn 结束后销毁 */
async function withPage(fn, p = makePorts()) {
  const D = await freshModule();
  const root = document.createElement('div');
  const c = D.initDiagnostics(root, p);
  try {
    await fn({ D, root, p, c, gen: buttons(root)[0], save: buttons(root)[1] });
  } finally {
    c.dispose();
  }
}

async function generate(ctx, result) {
  if (result) ctx.p.onPreview = async () => result;
  ctx.gen.click();
  await tick();
}

test('打开不生成；点击一次只请求一次 replace；全文原样纯文本；保存提交同一 token；按钮节点保持', async () => {
  await withPage(async ({ root, p, gen, save }) => {
    assert.equal(p.previewCalls.length, 0, '打开页面不请求');
    assert.equal(gen.textContent, '生成报告');
    assert.equal(save.disabled, true);
    assert.equal(shown(q(root, 'diagnostic-json')), false);

    const d = deferred();
    p.onPreview = () => d.promise;
    gen.click();
    gen.click();
    assert.equal(p.previewCalls.length, 1, '生成中不重复请求');
    assert.deepEqual(p.previewCalls[0], { flavorId: 9, mode: 'replace' });
    assert.equal(gen.disabled, true);
    assert.equal(gen.textContent, '生成中…');

    const json = reportJson({ note: '<img src=x onerror=alert(1)><script>x()</script> **md**' });
    const r = readyFor(p, json);
    d.resolve(r);
    await tick();
    const pre = q(root, 'diagnostic-json');
    assert.equal(pre.textContent, json, '全文与主进程给出的字符串完全一致');
    assert.equal(pre.childNodes.length, 1);
    assert.equal(pre.childNodes[0].tagName, undefined, '全文是文本节点，不是元素');
    assert.ok(!root.all().some((e) => e.tagName === 'IMG' || e.tagName === 'SCRIPT'));
    assert.equal(gen.textContent, '重新生成报告');
    assert.equal(save.disabled, false);
    assert.ok(q(root, 'diagnostic-meta').textContent.includes(A.label));
    assert.deepEqual(buttons(root), [gen, save], '按钮节点不重建');

    save.click();
    await tick();
    assert.deepEqual(p.saveCalls, [r.token]);
    assert.ok(notice(root).includes('已保存'));
    assert.equal(pre.textContent, json);
    assert.equal(save.disabled, false, '保存后预览保留，可另存');
  });
});

test('保存中：生成与再次保存都不可用；取消不显示成功、不清全文，之后可重试', async () => {
  await withPage(async (ctx) => {
    const { root, p, gen, save } = ctx;
    await generate(ctx);
    const json = q(root, 'diagnostic-json').textContent;
    const d = deferred();
    p.onSave = () => d.promise;
    save.click();
    save.click();
    gen.click();
    assert.equal(p.saveCalls.length, 1);
    assert.equal(p.previewCalls.length, 1);
    assert.equal(save.textContent, '保存中…');
    assert.equal(gen.disabled, true);
    d.resolve({ status: 'cancelled', previewKept: true });
    await tick();
    assert.ok(notice(root).includes('已取消保存'));
    assert.ok(!notice(root).includes('已保存'));
    assert.equal(q(root, 'diagnostic-json').textContent, json);
    assert.equal(save.disabled, false);
    p.onSave = async () => ({ status: 'saved', bytes: 10, previewKept: true });
    save.click();
    await tick();
    assert.equal(p.saveCalls.length, 2);
    assert.equal(p.saveCalls[0], p.saveCalls[1], '重试仍是同一 token');
    assert.ok(notice(root).includes('已保存'));
  });
});

const REJECT = {
  'token-invalid': ['已失效', false],
  'token-expired': ['已过期', false],
  'owner-mismatch': ['不属于当前窗口', false],
  'owner-gone': ['窗口在选择位置期间', false],
  busy: ['正在进行', true],
  'picker-failed': ['保存对话框', true],
  'invalid-path': ['位置无效', true],
  'protected-roots-unknown': ['无法完整确认', true],
  'protected-location': ['不能保存到', true],
  'parent-unsafe': ['真实的文件夹', true],
  'parent-changed': ['被移动或替换', true],
  'protection-changed': ['备份配置发生了变化', true],
  exists: ['新的文件名', true],
  internal: ['内部错误', true],
};
const FAIL = ['create-failed', 'identity-unknown', 'write-failed', 'sync-failed', 'close-failed', 'parent-sync-failed', 'parent-changed', 'protection-changed', 'content-changed'];
const CLEANUP = {
  'not-created': '没有创建文件',
  removed: '本次创建的文件已删除。',
  'removed-unsynced': '同步未能确认',
  absent: '已不在原位置',
  'retained-unconfirmed': '没有删除它',
  'retained-replaced': '另一个文件',
  'retained-parent-changed': '现在的位置无法确认',
  'remove-failed': '本次创建的文件未能删除',
};

test('保存结果全部分支：固定中文说明；拒绝不说已写入；保留现场不说已删除；预览是否可再保存按 previewKept', async () => {
  const cases = [];
  for (const [code, [frag, kept]] of Object.entries(REJECT)) cases.push([{ status: 'rejected', code, previewKept: kept }, ['没有保存', frag], ['已保存', '已删除']]);
  for (const code of FAIL) cases.push([{ status: 'failed', code, cleanup: 'removed', previewKept: true }, ['保存失败', CLEANUP.removed], ['已保存', '不完整']]);
  for (const [cleanup, frag] of Object.entries(CLEANUP)) {
    // 文件可能已完整写入（例如同步失败），说明不能断言内容不完整
    const forbid = cleanup.startsWith('retained') || cleanup === 'remove-failed' || cleanup === 'absent' ? ['已保存', '已删除', '没有创建', '不完整'] : ['已保存', '不完整'];
    if (cleanup === 'removed') forbid.push('同步');
    if (cleanup === 'retained-parent-changed') forbid.push('原处');
    cases.push([{ status: 'failed', code: 'write-failed', cleanup, previewKept: true }, ['保存失败', '写入失败', frag], forbid]);
  }
  cases.push([{ status: 'unconfirmed', code: 'post-verify-failed', cleanup: 'retained-unconfirmed', previewKept: true }, ['无法确认', '文件已保留'], ['已保存', '已删除']]);
  cases.push([{ status: 'saved', bytes: 123, previewKept: true }, ['已保存', '123 字节', '不会主动上传', '云盘'], ['失败', '只保存在本机', '没有上传']]);
  cases.push([{ status: 'cancelled', previewKept: true }, ['已取消保存', '没有创建文件'], ['已保存']]);
  cases.push([null, ['保存结果未知', '无法确认是否已创建文件'], ['已保存', CANARY]]);

  for (const [result, want, forbid] of cases) {
    await withPage(async (ctx) => {
      const { root, p, save } = ctx;
      await generate(ctx);
      const json = q(root, 'diagnostic-json').textContent;
      p.onSave = result === null ? async () => Promise.reject(new Error(CANARY)) : async () => result;
      save.click();
      await tick();
      const text = notice(root);
      const label = JSON.stringify(result);
      for (const w of want) assert.ok(text.includes(w), `${label} 应包含「${w}」：${text}`);
      for (const f of forbid) assert.ok(!text.includes(f), `${label} 不应包含「${f}」：${text}`);
      assert.ok(!root.textContent.includes('zq'), `${label}: 不回显错误原文`);
      assert.equal(q(root, 'diagnostic-json').textContent, json, `${label}: 全文保留`);
      const kept = result === null || result.previewKept;
      assert.equal(save.disabled, !kept, `${label}: 能否再保存`);
      if (!kept) assert.ok(q(root, 'diagnostic-save-hint').textContent.includes('重新生成'));
    });
  }
});

test('生成失败保留旧预览与 token；异常不回显原文', async () => {
  await withPage(async (ctx) => {
    const { root, p, save } = ctx;
    const first = readyFor(p);
    await generate(ctx, first);
    for (const failing of [async () => ({ status: 'rejected', code: 'stale' }), async () => Promise.reject(new Error(CANARY))]) {
      p.onPreview = failing;
      ctx.gen.click();
      await tick();
      assert.ok(notice(root).includes('没有生成新报告'));
      assert.ok(notice(root).includes('之前生成的报告'));
      assert.ok(!root.textContent.includes('zq'));
      assert.equal(q(root, 'diagnostic-json').textContent, first.json);
      assert.equal(save.disabled, false);
    }
    save.click();
    await tick();
    assert.deepEqual(p.saveCalls, [first.token]);
  });
  // 没有旧预览时也给出明确说明
  await withPage(async (ctx) => {
    await generate(ctx, { status: 'rejected', code: 'internal' });
    assert.ok(notice(ctx.root).includes('没有生成新报告'));
    assert.equal(ctx.save.disabled, true);
  });
});

test('摘要：设置损坏只含应用摘要、健康检查仍在进行 / 另一目标进行中、省略计数；格式无法识别时仍显示原文', async () => {
  const skipped = { state: 'skipped', reason: 'settings-unavailable' };
  const bad = reportJson({
    settings: { state: 'unavailable', reason: 'invalid-format', boundFlavorIds: [], unknownBindings: 0 },
    target: { flavorId: 9, state: 'settings-unavailable' },
    addons: { ...skipped, total: 0, items: [], omitted: { limit: 0, byteBudget: 0 } },
    history: { ...skipped, total: 0, recentFailures: [], omitted: { limit: 0, byteBudget: 0 } },
    health: { ...skipped, status: null, counts: null, issues: [], omitted: { limit: 0, byteBudget: 0 } },
  });
  await withPage(async (ctx) => {
    await generate(ctx, readyFor(ctx.p, bad));
    const s = q(ctx.root, 'diagnostic-summary-box').textContent;
    assert.ok(s.includes('设置无法读取，报告只含应用摘要'));
    assert.ok(s.includes('内容格式不正确'));
    assert.ok(s.includes('未采集'));
    assert.ok(s.includes('设置无法读取，未检查与游戏目录有关的部分'));
  });
  for (const [reason, frag] of [['still-running', '仍在后台进行'], ['busy', '另一个目标的健康检查仍在进行']]) {
    await withPage(async (ctx) => {
      const json = reportJson({ health: { state: 'unavailable', reason, status: null, counts: null, issues: [], omitted: { limit: 0, byteBudget: 0 } } });
      await generate(ctx, readyFor(ctx.p, json));
      const s = q(ctx.root, 'diagnostic-summary-box').textContent;
      assert.ok(s.includes(frag), reason);
      assert.ok(!s.includes('不代表插件或游戏一定正常') || !s.includes('已完成'), '不冒充已完成');
    });
  }
  await withPage(async (ctx) => {
    await generate(ctx);
    assert.ok(q(ctx.root, 'diagnostic-summary-box').textContent.includes('另有 2 项因数量上限未列出'));
  });
  await withPage(async (ctx) => {
    const raw = '{"format":"something-else","zz":"<b>x</b>"}\n';
    await generate(ctx, readyFor(ctx.p, raw));
    assert.ok(q(ctx.root, 'diagnostic-summary-box').textContent.includes('报告格式无法识别'));
    assert.equal(q(ctx.root, 'diagnostic-json').textContent, raw);
  });
});

test('不符合约定的预览（大小不一致或超过 512 KiB）只显示不保存', async () => {
  for (const make of [(p) => readyFor(p, reportJson(), { bytes: 1 }), (p) => { const big = reportJson({ pad: 'x'.repeat(512 * 1024) }); return readyFor(p, big); }]) {
    await withPage(async (ctx) => {
      const r = make(ctx.p);
      await generate(ctx, r);
      assert.equal(q(ctx.root, 'diagnostic-json').textContent, r.json);
      assert.equal(ctx.save.disabled, true);
      assert.ok(q(ctx.root, 'diagnostic-save-hint').textContent.includes('不符合约定'));
      ctx.save.click();
      await tick();
      assert.equal(ctx.p.saveCalls.length, 0);
    });
  }
});

test('目标 A→B→A：原报告持续标为之前生成的报告；全文节点不重建；重新生成后清除', async () => {
  await withPage(async (ctx) => {
    const { root, p } = ctx;
    await generate(ctx);
    const pre = q(root, 'diagnostic-json');
    const ctxBox = q(root, 'diagnostic-context');
    assert.equal(shown(ctxBox), false);
    p.setTarget(B);
    assert.equal(shown(ctxBox), true);
    assert.ok(ctxBox.textContent.includes('当前目标已变化'));
    assert.ok(ctxBox.textContent.includes(A.label));
    assert.ok(!ctxBox.textContent.includes(B.label));
    p.setTarget(A);
    assert.equal(shown(ctxBox), true, '变回原目标仍提醒');
    assert.ok(ctxBox.textContent.includes('曾经变化'));
    assert.equal(q(root, 'diagnostic-json'), pre);
    assert.ok(q(root, 'diagnostic-meta').textContent.includes(A.label));
    await generate(ctx);
    assert.equal(shown(ctxBox), false);
  });
});

test('生成中换目标：结果按发起时的目标命名并标为之前的报告', async () => {
  for (const [path2, expect] of [[[B], '当前目标已变化'], [[B, A], '曾经变化']]) {
    await withPage(async ({ root, p, gen }) => {
      const d = deferred();
      p.onPreview = () => d.promise;
      gen.click();
      for (const t of path2) p.setTarget(t);
      d.resolve(readyFor(p));
      await tick();
      assert.ok(q(root, 'diagnostic-meta').textContent.includes(A.label));
      assert.ok(!q(root, 'diagnostic-meta').textContent.includes(B.label));
      assert.ok(q(root, 'diagnostic-context').textContent.includes(expect));
    });
  }
});

test('销毁后晚到结果不更新原界面，也不留订阅与计时器；重新打开显示原报告与原目标', async () => {
  const D = await freshModule();
  const p = makePorts();
  const root = document.createElement('div');
  const c = D.initDiagnostics(root, p);
  const d = deferred();
  p.onPreview = () => d.promise;
  buttons(root)[0].click();
  c.dispose();
  assert.equal(p.listeners.size, 0);
  p.setTarget(B);
  const r = readyFor(p);
  d.resolve(r);
  await tick();
  assert.equal(q(root, 'diagnostic-json').textContent, '', '已销毁的界面不更新');
  assert.equal(p.timers.length, 0);

  const root2 = document.createElement('div');
  const c2 = D.initDiagnostics(root2, p);
  try {
    assert.equal(p.previewCalls.length, 1, '重新打开不自动生成');
    assert.equal(q(root2, 'diagnostic-json').textContent, r.json);
    assert.ok(q(root2, 'diagnostic-meta').textContent.includes(A.label));
    assert.ok(q(root2, 'diagnostic-context').textContent.includes('当前目标已变化'));
    assert.equal(buttons(root2)[0].textContent, '重新生成报告');
  } finally {
    c2.dispose();
  }
  assert.equal(p.timers.length, 0, '销毁清除计时器');
});

test('生成完成后销毁、无人订阅期间换目标（同一游戏版本），重新打开：保留原报告与 token，并提示是之前生成的报告', async () => {
  const D = await freshModule();
  const p = makePorts();
  const root = document.createElement('div');
  const c = D.initDiagnostics(root, p);
  const r = readyFor(p);
  p.onPreview = async () => r;
  buttons(root)[0].click();
  await tick();
  assert.equal(q(root, 'diagnostic-context').hidden, true);
  c.dispose();
  // 同一版本、同一标签，只是目标键变化（例如换绑了目录）；此时没有界面订阅
  p.setTarget({ ...A, key: '9\n/a-rebound' });

  const root2 = document.createElement('div');
  const c2 = D.initDiagnostics(root2, p);
  try {
    assert.equal(p.previewCalls.length, 1, '重新打开不自动生成');
    assert.equal(q(root2, 'diagnostic-json').textContent, r.json, '原报告全文保留');
    assert.ok(q(root2, 'diagnostic-meta').textContent.includes(`${r.bytes} 字节`));
    const ctx = q(root2, 'diagnostic-context');
    assert.equal(ctx.hidden, false, '重新打开时按当前目标核对保留的报告');
    assert.ok(ctx.textContent.includes('当前目标已变化'));
    const save = buttons(root2)[1];
    assert.equal(save.disabled, false);
    save.click();
    await tick();
    assert.deepEqual(p.saveCalls, [r.token], '仍保存原 token');
  } finally {
    c2.dispose();
  }
});

test('重新打开时目标未变：不显示目标变化提醒', async () => {
  const D = await freshModule();
  const p = makePorts();
  const root = document.createElement('div');
  const c = D.initDiagnostics(root, p);
  buttons(root)[0].click();
  await tick();
  c.dispose();
  const root2 = document.createElement('div');
  const c2 = D.initDiagnostics(root2, p);
  try {
    assert.equal(q(root2, 'diagnostic-context').hidden, true);
    assert.notEqual(q(root2, 'diagnostic-json').textContent, '');
  } finally {
    c2.dispose();
  }
});

test('预览过期：保存不可用并提示重新生成；新预览替换旧计时器', async () => {
  await withPage(async (ctx) => {
    const { root, p, save } = ctx;
    await generate(ctx, readyFor(p, reportJson(), { expiresAt: p.t + 1000 }));
    assert.equal(p.timers.length, 1);
    assert.equal(p.timers[0].ms, 1000);
    assert.equal(save.disabled, false);
    p.t += 1000;
    // 合成计时器：到期执行后从列表移除（与真实计时器触发后不再存在一致）
    p.timers.shift().fn();
    assert.equal(save.disabled, true);
    assert.ok(q(root, 'diagnostic-save-hint').textContent.includes('已过期'));
    save.click();
    await tick();
    assert.equal(p.saveCalls.length, 0);
    await generate(ctx, readyFor(p, reportJson(), { expiresAt: p.t + 5000 }));
    assert.equal(p.timers.length, 1, '旧计时器已清除');
    assert.equal(p.timers[0].ms, 5000);
    assert.equal(save.disabled, false);
  });
});

test('保护集合无法确认：拒绝并保留预览，可之后重试同一 token', async () => {
  await withPage(async (ctx) => {
    const { root, p, save } = ctx;
    await generate(ctx);
    const json = q(root, 'diagnostic-json').textContent;
    p.onSave = async () => ({ status: 'rejected', code: 'protected-roots-unknown', previewKept: true });
    save.click();
    await tick();
    assert.ok(notice(root).includes('无法完整确认'));
    assert.ok(notice(root).includes('预览已保留'));
    assert.equal(q(root, 'diagnostic-json').textContent, json);
    assert.equal(save.disabled, false);
    p.onSave = async () => ({ status: 'saved', bytes: 5, previewKept: true });
    save.click();
    await tick();
    assert.equal(p.saveCalls[0], p.saveCalls[1]);
  });
});
