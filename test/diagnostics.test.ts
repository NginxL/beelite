// 诊断报告 A 批（0.3.0）：白名单投影、有界只读适配与预览冻结。全部数据是临时目录中的合成内容，FIFO 为测试自建；
// 临时目录先 realpath（macOS 的 /var → /private/var 是符号链接，否则整条上级目录链会按不安全拒绝）。
// 合成自由文本都含 “zq” 标记：报告中出现任何一处即失败。保存（B 批）尚未实现，这里不测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiagnosticsService, HARD_DIAG_LIMITS, type DiagnosticsOptions, type DiagStep } from '../src/core/diagnostics';
import { DEFAULT_HEALTH_LIMITS, scanAddonHealth } from '../src/core/health';
import { HistoryStore } from '../src/core/history';
import type { DiagnosticReport, DiagPreviewResult } from '../src/shared/diagnostic-types';
import type { HealthReport } from '../src/shared/health-types';
import { cleanup, tmpDir } from './helpers';

const FOREVER = 9;
const RETAIL = 2;

/** 合成的私密文本：全部含 zq，便于整体检查 */
const C = {
  dir: 'zqSecretGamesDir',
  folder: 'ZqPrivateFolder',
  other: 'ZqOtherFolder',
  name: 'zq Private Addon Name',
  version: 'v9.9-zqTok3n',
  logo: 'https://zq.example/logo.png?token=zqLogoQ#zqFrag',
  email: 'zq.alice@example.com',
  bearer: 'Bearer zqBearerToken',
  field: 'zqCredentialField',
  message: 'zqHistoryMessage /Users/zqAliceCanary/WTF/Account/ZQACCOUNT',
  warn: 'zqWarningText',
  dep: 'ZqMissingDep',
  error: 'zqErrorText at /Users/zqAliceCanary',
};

interface Fx {
  base: string;
  userData: string;
  settingsFile: string;
  historyFile: string;
  root: string;
  root2: string;
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function manifestJson(projects: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, lastTxId: null, projects, recovery: [], purgeQueue: [], ...extra });
}

function project(modId: string, fileId: string, folders: string[], o: Record<string, unknown> = {}): Record<string, unknown> {
  return { modId, flavorId: FOREVER, fileId, version: C.version, name: C.name, logo: C.logo, folders, installedAt: 1, ...o };
}

/** 合法全数据：两个绑定 + 一个未知编号绑定、含私密文本的 manifest / TOC；不写操作记录（各用例自己写） */
async function makeFx(): Promise<Fx> {
  const base = await realpath(await tmpDir('beelite-diag-'));
  const userData = path.join(base, 'userData');
  const root = path.join(base, C.dir, '_forever_');
  const root2 = path.join(base, C.dir, '_retail_');
  await mkdir(userData, { recursive: true });
  await mkdir(path.join(root, 'Interface', 'AddOns'), { recursive: true });
  await mkdir(path.join(root, 'Interface', '.beelite'), { recursive: true });
  await mkdir(path.join(root2, 'Interface', 'AddOns'), { recursive: true });
  const settingsFile = path.join(userData, 'settings.json');
  await writeFile(
    settingsFile,
    JSON.stringify({ schema: 1, bindings: { [FOREVER]: root, [RETAIL]: root2, '99': path.join(base, C.dir, 'x') }, lastFlavorId: FOREVER, [C.field]: { token: C.bearer, email: C.email } }),
  );
  await writeFile(
    path.join(root, 'Interface', '.beelite', 'manifest.json'),
    manifestJson({ '123': project('123', '4567', [C.folder, `${C.folder}_Options`]), '88': project('88', '99', [C.other], { name: C.email, version: '1.0' }) }),
  );
  for (const f of [C.folder, `${C.folder}_Options`]) {
    await mkdir(path.join(root, 'Interface', 'AddOns', f));
    await writeFile(path.join(root, 'Interface', 'AddOns', f, `${f}.toc`), `## Interface: 11111\n## Title: ${C.name}\n## Version: ${C.version}\n## Notes: ${C.logo} ${C.email}\n## Dependencies: ${C.dep}\n`);
  }
  return { base, userData, settingsFile, historyFile: path.join(userData, 'operation-history.json'), root, root2 };
}

function healthReport(flavorId: number, root: string, issues: unknown[] = []): HealthReport {
  return {
    root,
    flavorId,
    checkedAt: 1,
    status: 'complete',
    unavailableReason: null,
    message: C.error,
    scope: C.error,
    hasAddons: true,
    manifestState: 'ok',
    reference: { interfaceNumber: null, source: 'addon-library-config' },
    limits: { ...DEFAULT_HEALTH_LIMITS },
    scanned: { entries: 0, folders: 0, tocsRead: 0, tocBytes: 0, interfaceMatched: 0 },
    truncated: { entries: false, tocBudget: false, issues: false },
    counts: { warning: 0, unknown: 0, info: 0 },
    issues: issues as HealthReport['issues'],
  };
}

function svcFor(fx: Fx, o: Partial<DiagnosticsOptions> = {}): { svc: DiagnosticsService; calls: [number, string][] } {
  const calls: [number, string][] = [];
  const health = o.health ?? ((f: number, r: string) => scanAddonHealth(r, f, 16001));
  const svc = new DiagnosticsService({
    appVersion: '0.3.0',
    settingsFile: fx.settingsFile,
    historyFile: fx.historyFile,
    historyInstance: 'current-instance',
    // 合成的应用 bundle；userData 不列入，验证设置所在目录总是受保护
    protectedExtras: async () => [path.join(fx.base, 'App.app')],
    ...o,
    health: (f, r) => {
      calls.push([f, r]);
      return health(f, r);
    },
  });
  return { svc, calls };
}

function ready(r: DiagPreviewResult): { token: string; json: string; report: DiagnosticReport } {
  if (r.status !== 'ready') assert.fail(`预期 ready，实际 ${JSON.stringify(r)}`);
  assert.equal(Buffer.byteLength(r.json, 'utf8'), r.bytes);
  return { token: r.token, json: r.json, report: JSON.parse(r.json) as DiagnosticReport };
}

/** 报告中不得出现合成私密文本或临时目录路径；每个字符串值都必须是枚举 / 别名 / 编号形式 */
function assertClean(json: string, fx: Fx): void {
  assert.ok(!/zq/i.test(json), '报告含合成私密文本');
  assert.ok(!json.includes(fx.base), '报告含临时目录路径');
  assert.ok(!json.includes(path.basename(fx.base)));
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (strings.push(k), walk(x));
  };
  walk(JSON.parse(json));
  for (const s of strings) assert.match(s, /^[a-zA-Z0-9.-]{1,40}$/, `字符串不在白名单形式内：${s}`);
}

/** 目录树快照：路径、类型、大小、mtime、内容哈希或链接目标；不读特殊文件 */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, rel: string): Promise<void> => {
    const st = await lstat(p);
    const head = `${rel}|${st.mode.toString(8)}|${st.mtimeMs}`;
    if (st.isSymbolicLink()) out.push(`${head}|link:${await readlink(p)}`);
    else if (st.isFile()) out.push(`${head}|${st.size}|${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    else if (st.isDirectory()) {
      out.push(`${head}|dir`);
      for (const n of (await readdir(p)).sort()) await walk(path.join(p, n), `${rel}/${n}`);
    } else out.push(`${head}|special`);
  };
  await walk(dir, '.');
  return out;
}

async function mkfifo(p: string): Promise<void> {
  execFileSync('mkfifo', [p]);
}

/** 结束时以非阻塞方式打开一次写端，万一有读端在等待也能放行 */
async function releaseFifo(p: string): Promise<void> {
  await open(p, constants.O_WRONLY | constants.O_NONBLOCK).then((fh) => fh.close(), () => undefined);
}

test('合法全数据：自由文本全部不透传；公开数字编号、匿名目录关联与状态计数保留；源数据不变', async () => {
  const fx = await makeFx();
  try {
    // 时序：之前的运行（old）先留下 accepted；当前运行（cur）之后完成其他记录，最后才受理一项进行中的操作。
    // cur 的每次写入都会把 old 的 accepted 按读取语义写回为 unconfirmed；cur 自己最后的 accepted 之后不再有写入
    const old = new HistoryStore(fx.historyFile);
    await old.begin({ flavorId: FOREVER, root: fx.root, kind: 'update', modId: '123', name: C.name });
    const cur = new HistoryStore(fx.historyFile);
    const failed = await cur.begin({ flavorId: FOREVER, root: fx.root, kind: 'install', modId: '123', target: C.folder, name: C.name });
    await cur.finish(failed, { status: 'failed', message: C.message, warnings: [C.warn, C.bearer], previous: { fileId: '1', version: C.version } });
    await cur.record({ flavorId: FOREVER, root: fx.root, kind: 'update', modId: '88', name: C.email }, { status: 'succeeded', message: C.logo, installed: { fileId: '99', version: C.version } });
    // 其他目录的记录不计入
    await cur.record({ flavorId: RETAIL, root: fx.root2, kind: 'install', modId: '5', name: C.name }, { status: 'failed', message: C.message });
    await cur.begin({ flavorId: FOREVER, root: fx.root, kind: 'uninstall', modId: '88', name: C.name });

    const before = await snapshot(fx.base);
    const { svc, calls } = svcFor(fx, { historyInstance: cur.instance, historyStatus: () => ({ unsaved: 0, dropped: 0, failing: false }) });
    const { json, report } = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
    assert.deepEqual(await snapshot(fx.base), before, '源数据被改动');
    assertClean(json, fx);
    assert.ok(json.endsWith('}\n'));
    assert.equal(calls.length, 1);

    assert.equal(report.app.version, '0.3.0');
    assert.equal(report.consistency, 'not-atomic');
    assert.deepEqual(report.settings, { state: 'ok', reason: null, boundFlavorIds: [RETAIL, FOREVER], unknownBindings: 1 });
    assert.deepEqual(report.target, { flavorId: FOREVER, state: 'bound' });

    assert.equal(report.addons.state, 'ok');
    assert.equal(report.addons.total, 2);
    assert.deepEqual(
      report.addons.items.map((i) => [i.alias, i.modId, i.fileId, i.flavorId, i.folders]),
      [
        ['p1', '88', '99', FOREVER, ['f1']],
        ['p2', '123', '4567', FOREVER, ['f2', 'f3']],
      ],
    );

    assert.equal(report.history.state, 'ok');
    assert.equal(report.history.total, 4);
    assert.equal(report.history.byStatus.failed, 1);
    assert.equal(report.history.byStatus.succeeded, 1);
    assert.equal(report.history.byStatus.accepted, 1, '本次运行中的 accepted 仍是进行中');
    assert.equal(report.history.byStatus.unconfirmed, 1, '其他实例的 accepted 不当作成功');
    assert.deepEqual(report.history.recentFailures.map((f) => [f.kind, f.status, f.modId]).sort(), [
      ['install', 'failed', '123'],
      ['update', 'unconfirmed', '123'],
    ]);
    assert.equal(report.history.storeFailing, false);

    assert.deepEqual([report.health.state, report.health.status, report.health.manifestState], ['ok', 'complete', 'ok']);
    const kinds = report.health.issues.map((i) => i.kind);
    assert.ok(kinds.includes('dep-required-missing'));
    assert.ok(kinds.includes('interface-mismatch'));
    assert.ok(kinds.includes('registered-missing'));
    const dep = report.health.issues.find((i) => i.kind === 'dep-required-missing')!;
    assert.ok(dep.folder === 'f2' || dep.folder === 'f3', '依赖提示的目录别名与插件清单一致');
    assert.match(dep.related ?? '', /^f\d+$/);
    assert.equal(report.health.issues.find((i) => i.kind === 'registered-missing')!.folder, 'f1');
    assert.deepEqual(report.health.issues.find((i) => i.kind === 'interface-mismatch')!.declared, [11111]);
  } finally {
    await cleanup(fx.base);
  }
});

test('设置无法读取：仍生成应用摘要，固定原因，不读取任何游戏目录', async () => {
  const cases: [string, (fx: Fx) => Promise<string | void>, string, Partial<DiagnosticsOptions>?][] = [
    ['bad-json', (fx) => writeFile(fx.settingsFile, `{"zq":`), 'invalid-format'],
    ['future-schema', (fx) => writeFile(fx.settingsFile, JSON.stringify({ schema: 2, bindings: {}, zq: C.bearer })), 'unsupported-schema'],
    ['bad-binding', (fx) => writeFile(fx.settingsFile, JSON.stringify({ schema: 1, bindings: { [FOREVER]: 'zq/relative' } })), 'invalid-format'],
    [
      'fifo',
      async (fx) => {
        await rm(fx.settingsFile);
        await mkfifo(fx.settingsFile);
      },
      'not-file',
    ],
    [
      'directory',
      async (fx) => {
        await rm(fx.settingsFile);
        await mkdir(fx.settingsFile);
      },
      'not-file',
    ],
    [
      'symlink',
      async (fx) => {
        const secret = path.join(fx.base, 'zq-secret.json');
        await writeFile(secret, await readFile(fx.settingsFile));
        await rm(fx.settingsFile);
        await symlink(secret, fx.settingsFile);
      },
      'symlink',
    ],
    [
      'parent-symlink',
      async (fx) => {
        const link = path.join(fx.base, 'zq-link');
        await symlink(fx.userData, link);
        return path.join(link, 'settings.json');
      },
      'parent-unsafe',
    ],
    ['too-large', async () => undefined, 'too-large', { limits: { maxSettingsBytes: 64 } }],
  ];
  for (const [name, setup, reason, extra] of cases) {
    const fx = await makeFx();
    try {
      const alt = await setup(fx);
      const settingsFile = typeof alt === 'string' ? alt : fx.settingsFile;
      const before = await snapshot(fx.base);
      const { svc, calls } = svcFor(fx, { settingsFile, ...extra });
      const { json, report } = ready(await within(svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }), 5000, name));
      assert.deepEqual(await snapshot(fx.base), before, `${name}: 源数据被改动`);
      assertClean(json, fx);
      assert.deepEqual(report.settings, { state: 'unavailable', reason, boundFlavorIds: [], unknownBindings: 0 }, name);
      assert.equal(report.target.state, 'settings-unavailable', name);
      for (const s of [report.addons, report.history, report.health]) assert.deepEqual([s.state, s.reason], ['skipped', 'settings-unavailable'], name);
      assert.equal(calls.length, 0, `${name}: 不应启动健康检查`);
      if (name === 'fifo') await releaseFifo(fx.settingsFile);
    } finally {
      await cleanup(fx.base);
    }
  }
});

test('设置不存在（含上级目录不存在）：按未绑定处理，absent 与不安全区分', async () => {
  const fx = await makeFx();
  try {
    const { svc, calls } = svcFor(fx, { settingsFile: path.join(fx.base, 'missing', 'settings.json') });
    const { report } = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
    assert.deepEqual([report.settings.state, report.settings.reason], ['absent', 'absent']);
    assert.equal(report.target.state, 'not-bound');
    assert.deepEqual([report.addons.state, report.addons.reason], ['skipped', 'not-bound']);
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(fx.base);
  }
});

test('未选择或未绑定目标：只有应用摘要，不扫描磁盘；应用版本只接受数字 x.y.z', async () => {
  const fx = await makeFx();
  try {
    const { svc, calls } = svcFor(fx, { appVersion: '0.3.0-zq.token' });
    const a = ready(await svc.preview({ flavorId: null, mode: 'reuse', owner: 1 }));
    assert.equal(a.report.target.state, 'not-selected');
    assert.equal(a.report.app.version, 'unknown');
    const b = ready(await svc.preview({ flavorId: 4, mode: 'replace', owner: 1 }));
    assert.equal(b.report.target.state, 'not-bound');
    assert.equal(calls.length, 0);
    assertClean(b.json, fx);
  } finally {
    await cleanup(fx.base);
  }
});

test('manifest 异常：FIFO、符号链接、上级链接、超限、坏 JSON、未来版本、非数字 fileId、未完成操作均为固定原因', async () => {
  const mpath = (fx: Fx) => path.join(fx.root, 'Interface', '.beelite', 'manifest.json');
  const cases: [string, (fx: Fx) => Promise<void>, string, string, Partial<DiagnosticsOptions>?][] = [
    [
      'fifo',
      async (fx) => {
        await rm(mpath(fx));
        await mkfifo(mpath(fx));
      },
      'unavailable',
      'not-file',
    ],
    [
      'symlink',
      async (fx) => {
        const secret = path.join(fx.base, 'zq-manifest.json');
        await writeFile(secret, await readFile(mpath(fx)));
        await rm(mpath(fx));
        await symlink(secret, mpath(fx));
      },
      'unavailable',
      'symlink',
    ],
    [
      'parent-symlink',
      async (fx) => {
        const meta = path.join(fx.root, 'Interface', '.beelite');
        const elsewhere = path.join(fx.base, 'zq-meta');
        await mkdir(elsewhere);
        await writeFile(path.join(elsewhere, 'manifest.json'), await readFile(mpath(fx)));
        await rm(meta, { recursive: true });
        await symlink(elsewhere, meta);
      },
      'unavailable',
      'parent-unsafe',
    ],
    ['too-large', async () => undefined, 'unavailable', 'too-large', { limits: { maxManifestBytes: 32 } }],
    ['bad-json', (fx) => writeFile(mpath(fx), '{"zq'), 'unavailable', 'invalid-format'],
    ['future-schema', (fx) => writeFile(mpath(fx), JSON.stringify({ schema: 2, zq: 1 })), 'unavailable', 'unsupported-schema'],
    ['bad-file-id', (fx) => writeFile(mpath(fx), manifestJson({ '1': project('1', 'zq123', ['A']) })), 'unavailable', 'invalid-format'],
    ['journal', (fx) => writeFile(path.join(fx.root, 'Interface', '.beelite', 'journal.json'), '{}'), 'unavailable', 'pending-operation'],
    ['meta-absent', (fx) => rm(path.join(fx.root, 'Interface', '.beelite'), { recursive: true }), 'absent', 'absent'],
  ];
  for (const [name, setup, state, reason, extra] of cases) {
    const fx = await makeFx();
    try {
      await setup(fx);
      const before = await snapshot(fx.base);
      const { svc } = svcFor(fx, { health: async (f, r) => healthReport(f, r), ...extra });
      const { json, report } = ready(await within(svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }), 5000, name));
      assert.deepEqual(await snapshot(fx.base), before, `${name}: 源数据被改动`);
      assertClean(json, fx);
      assert.deepEqual([report.addons.state, report.addons.reason, report.addons.items.length], [state, reason, 0], name);
      assert.equal(report.settings.state, 'ok', `${name}: 其他部分不受影响`);
      assert.equal(report.health.state, 'ok', name);
      if (name === 'fifo') await releaseFifo(mpath(fx));
    } finally {
      await cleanup(fx.base);
    }
  }
});

test('操作记录异常：FIFO、符号链接、坏 JSON、未来版本、超限只给固定原因，不写入', async () => {
  const cases: [string, (fx: Fx) => Promise<void>, string, Partial<DiagnosticsOptions>?][] = [
    ['fifo', (fx) => mkfifo(fx.historyFile), 'not-file'],
    [
      'symlink',
      async (fx) => {
        const secret = path.join(fx.base, 'zq-history.json');
        await writeFile(secret, JSON.stringify({ schema: 1, entries: [] }));
        await symlink(secret, fx.historyFile);
      },
      'symlink',
    ],
    ['bad-json', (fx) => writeFile(fx.historyFile, `{"zq": "${C.message}"`), 'invalid-format'],
    ['future-schema', (fx) => writeFile(fx.historyFile, JSON.stringify({ schema: 2, entries: [] })), 'unsupported-schema'],
    ['entries-not-array', (fx) => writeFile(fx.historyFile, JSON.stringify({ schema: 1, entries: C.message })), 'invalid-format'],
    ['too-large', (fx) => writeFile(fx.historyFile, JSON.stringify({ schema: 1, entries: [], pad: 'x'.repeat(200) })), 'too-large', { limits: { maxHistoryBytes: 100 } }],
  ];
  for (const [name, setup, reason, extra] of cases) {
    const fx = await makeFx();
    try {
      await setup(fx);
      const before = await snapshot(fx.base);
      const { svc } = svcFor(fx, { health: async (f, r) => healthReport(f, r), ...extra });
      const { json, report } = ready(await within(svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }), 5000, name));
      assert.deepEqual(await snapshot(fx.base), before, `${name}: 源数据被改动`);
      assertClean(json, fx);
      assert.deepEqual([report.history.state, report.history.reason, report.history.total], ['unavailable', reason, 0], name);
      assert.equal(report.addons.state, 'ok', name);
      if (name === 'fifo') await releaseFifo(fx.historyFile);
    } finally {
      await cleanup(fx.base);
    }
  }
});

test('数量与大小上限：插件 500、每插件目录、健康提示 200、最近失败默认 20 / 最多 100；超出字节上限按条目省略且 JSON 有效', async () => {
  const fx = await makeFx();
  try {
    const projects: Record<string, unknown> = {};
    for (let i = 1; i <= 600; i++) projects[String(i)] = project(String(i), String(i * 10), [`${C.folder}${i}`]);
    projects['601'] = project('601', '1', Array.from({ length: 50 }, (_, k) => `${C.other}${k}`));
    await writeFile(path.join(fx.root, 'Interface', '.beelite', 'manifest.json'), manifestJson(projects));
    const entries = Array.from({ length: 150 }, (_, i) => ({ id: `x${i}`, instance: 'old', flavorId: FOREVER, root: fx.root, kind: 'install', status: 'failed', modId: String(i + 1), name: C.name, message: C.message, startedAt: i, finishedAt: 1000 + i }));
    entries.push({ ...entries[0], kind: 'zq-evil', id: 'bad' });
    await writeFile(fx.historyFile, JSON.stringify({ schema: 1, entries }));
    const issues: unknown[] = Array.from({ length: 300 }, (_, i) => ({ kind: 'dep-required-missing', severity: 'warning', folder: `${C.folder}${i}`, detail: C.dep, message: C.message }));
    issues.push({ kind: 'zq-evil', severity: 'warning', folder: C.folder, detail: null, message: C.message }, { kind: 'toc-none', severity: 'zq', folder: null, detail: null, message: '' });
    const health = async (f: number, r: string) => healthReport(f, r, issues);

    const { report, json } = ready(await svcFor(fx, { health }).svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
    assertClean(json, fx);
    assert.ok(Buffer.byteLength(json) <= HARD_DIAG_LIMITS.maxReportBytes);
    assert.equal(report.addons.total, 601);
    assert.equal(report.addons.items.length, 500);
    assert.equal(report.addons.omitted.limit, 101);
    const many = report.addons.items.find((i) => i.modId === '601');
    assert.equal(many, undefined, '按编号排序后第 601 个被数量上限省略');
    assert.equal(report.history.recentFailures.length, 20);
    assert.equal(report.history.omitted.limit, 130);
    assert.equal(report.history.recentFailures[0].modId, '150', '新的在前');
    assert.equal(report.history.invalidEntries, 1);
    assert.equal(report.history.state, 'partial');
    assert.equal(report.health.issues.length, 200);
    assert.equal(report.health.omitted.limit, 100);
    assert.equal(report.health.invalidIssues, 2);
    assert.equal(new Set(report.health.issues.map((i) => i.related)).size, 1, '同一依赖名归为同一别名');

    // 每插件目录上限：只保留编号 601 的项目
    await writeFile(path.join(fx.root, 'Interface', '.beelite', 'manifest.json'), manifestJson({ '601': projects['601'] }));
    const more = ready(await svcFor(fx, { health, limits: { recentFailures: 100 } }).svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 })).report;
    assert.equal(more.addons.items[0].folders.length, HARD_DIAG_LIMITS.maxFoldersPerAddon);
    assert.equal(more.addons.items[0].foldersOmitted, 50 - HARD_DIAG_LIMITS.maxFoldersPerAddon);
    assert.equal(more.history.recentFailures.length, 100);
    assert.equal(more.history.omitted.limit, 50);

    // 调低报告大小上限：按条目省略并计数，整份仍是有效 JSON
    await writeFile(path.join(fx.root, 'Interface', '.beelite', 'manifest.json'), manifestJson(projects));
    const small = 16 * 1024;
    const tiny = await svcFor(fx, { health, limits: { maxReportBytes: small } }).svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 });
    const t = ready(tiny);
    assert.ok(Buffer.byteLength(t.json) <= small);
    assert.ok(t.report.history.omitted.byteBudget > 0);
    assert.equal(t.report.history.recentFailures.length + t.report.history.omitted.byteBudget, 20);
    assertClean(t.json, fx);

    // 上限只能调低
    for (const limits of [{ maxAddons: 501 }, { recentFailures: 101 }, { maxReportBytes: 512 * 1024 + 1 }, { healthWaitMs: 0 }]) {
      assert.throws(() => svcFor(fx, { limits }), RangeError);
    }
  } finally {
    await cleanup(fx.base);
  }
});

test('健康检查：超时只报告仍在进行；同时只有一个检查；另一目标不启动新检查；换绑后的旧结果不采用', async () => {
  const fx = await makeFx();
  try {
    let resolveFirst!: (r: HealthReport) => void;
    let n = 0;
    const health = (f: number, r: string): Promise<HealthReport> => {
      n++;
      if (n === 1) return new Promise((res) => (resolveFirst = res));
      return Promise.resolve(healthReport(f, r));
    };
    let epoch = 0;
    let onHistory: (() => void) | null = null;
    const { svc, calls } = svcFor(fx, {
      health,
      epoch: () => epoch,
      limits: { healthWaitMs: 30 },
      // 在开始等待健康检查之前安排完成（定时器一定晚于同步取得进行中检查），避免依赖采集耗时
      hooks: {
        step: (name) => {
          if (name === 'after-history' && onHistory) {
            onHistory();
            onHistory = null;
          }
        },
      },
    });
    const r1 = ready(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 })).report;
    assert.deepEqual([r1.health.state, r1.health.reason], ['unavailable', 'still-running']);
    const r2 = ready(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 })).report;
    assert.deepEqual([r2.health.reason, calls.length], ['still-running', 1], '仍在进行时不叠加新检查');
    const r3 = ready(await svc.preview({ flavorId: RETAIL, mode: 'replace', owner: 1 })).report;
    assert.deepEqual([r3.health.reason, calls.length], ['busy', 1], '另一目标不启动新检查，也不采用 A 的结果');

    // 采集开始前绑定已变化（A→B→A）：之前启动的检查结束后也不采用
    epoch = 1;
    onHistory = () => void setTimeout(() => resolveFirst(healthReport(FOREVER, fx.root)), 1);
    const r4 = ready(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 })).report;
    assert.deepEqual([r4.health.state, r4.health.reason], ['unavailable', 'mismatch']);

    await new Promise((res) => setImmediate(res));
    const r5 = ready(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 })).report;
    assert.deepEqual([r5.health.state, calls.length], ['ok', 2], '上一个检查结束后才启动新的检查');

    // 结果目标不符、检查抛错（含私密文本）：固定原因
    const other = svcFor(fx, { health: async (f) => healthReport(f, fx.root2) }).svc;
    assert.equal(ready(await other.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 })).report.health.reason, 'mismatch');
    const failing = svcFor(fx, { health: async () => Promise.reject(new Error(C.error)) }).svc;
    const f = ready(await failing.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
    assert.equal(f.report.health.reason, 'failed');
    assertClean(f.json, fx);
  } finally {
    await cleanup(fx.base);
  }
});

test('采集期间绑定计数或设置内容变化：放弃结果（stale），原预览保持可用', async () => {
  const fx = await makeFx();
  try {
    let epoch = 0;
    let mutate: (() => Promise<void>) | null = null;
    const { svc } = svcFor(fx, {
      health: async (f, r) => healthReport(f, r),
      epoch: () => epoch,
      hooks: { step: async (name) => void (name === 'after-manifest' && mutate && (await mutate())) },
    });
    const p1 = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));

    mutate = async () => void epoch++;
    assert.deepEqual(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 }), { status: 'rejected', code: 'stale' });
    const settings = JSON.parse(await readFile(fx.settingsFile, 'utf8')) as Record<string, unknown>;
    mutate = () => writeFile(fx.settingsFile, JSON.stringify({ ...settings, lastFlavorId: RETAIL }));
    assert.deepEqual(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 }), { status: 'rejected', code: 'stale' });

    assert.deepEqual(svc.checkToken(p1.token, 1), { status: 'ok', bytes: Buffer.byteLength(p1.json) });
    const again = await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 });
    assert.ok(again.status === 'ready' && again.reused && again.token === p1.token && again.json === p1.json);
  } finally {
    await cleanup(fx.base);
  }
});

test('预览冻结：reuse 返回同一字节；替换须显式；所属者、过期、关闭窗口与并发生成', async () => {
  const fx = await makeFx();
  try {
    let now = 1_000_000;
    let onStep: ((name: string) => Promise<void> | void) | null = null;
    const { svc } = svcFor(fx, {
      health: async (f, r) => healthReport(f, r),
      now: () => now,
      limits: { previewTtlMs: 60_000 },
      hooks: { step: async (name) => void (await onStep?.(name)) },
    });
    for (const bad of [{ flavorId: 12345, mode: 'reuse', owner: 1 }, { flavorId: FOREVER, mode: 'zq', owner: 1 }, { flavorId: FOREVER, mode: 'reuse', owner: {} }, { flavorId: FOREVER, mode: 'reuse', owner: '' }]) {
      assert.deepEqual(await svc.preview(bad as never), { status: 'rejected', code: 'invalid-request' });
    }

    const p1 = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 'w1' }));
    const r = await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 'w1' });
    assert.ok(r.status === 'ready' && r.reused && r.token === p1.token && r.json === p1.json);
    assert.ok(!p1.json.includes('w1'), '所属者不进入报告');
    assert.deepEqual(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 'w2' }), { status: 'rejected', code: 'preview-exists' });
    assert.deepEqual(svc.checkToken(p1.token, 'w2'), { status: 'rejected', code: 'owner-mismatch' });
    assert.deepEqual(svc.checkToken('zq', 'w1'), { status: 'rejected', code: 'token-invalid' });

    // 生成中：其他生成请求为 busy；生成中关闭窗口：结果不采用，原预览不受影响
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    onStep = (name) => (name === 'after-settings' ? gate : undefined);
    const pending = svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 'w2' });
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 'w1' }), { status: 'rejected', code: 'busy' });
    svc.dropOwner('w2');
    release();
    assert.deepEqual(await pending, { status: 'rejected', code: 'owner-gone' });
    onStep = null;
    assert.deepEqual(svc.checkToken(p1.token, 'w1'), { status: 'ok', bytes: p1.json.length });

    // 显式替换
    const p2 = ready(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 'w3' }));
    assert.notEqual(p2.token, p1.token);
    assert.deepEqual(svc.checkToken(p1.token, 'w1'), { status: 'rejected', code: 'token-invalid' }, '显式替换后旧 token 失效');

    // 过期
    now += 60_000;
    assert.deepEqual(svc.checkToken(p2.token, 'w3'), { status: 'rejected', code: 'token-expired' });
    const p3 = await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 'w3' });
    assert.ok(p3.status === 'ready' && !p3.reused && p3.token !== p2.token);

    // 关闭窗口丢弃它的预览
    svc.dropOwner('w3');
    assert.deepEqual(svc.checkToken(p3.status === 'ready' ? p3.token : '', 'w3'), { status: 'rejected', code: 'token-invalid' });
  } finally {
    await cleanup(fx.base);
  }
});

// ---------- 保存（B 批） ----------

type Steps = Partial<Record<DiagStep, () => Promise<void> | void>>;

/** 生成一份预览；steps 可在之后修改，按步骤名注入外部改动或故障 */
async function saveSetup(fx: Fx, o: Partial<DiagnosticsOptions> = {}, steps: Steps = {}) {
  const out = path.join(fx.base, 'out');
  await mkdir(out, { recursive: true });
  const { svc } = svcFor(fx, { health: async (f, r) => healthReport(f, r), hooks: { step: async (name) => void (await steps[name]?.()) }, ...o });
  const p = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
  return { svc, p, out, bytes: Buffer.from(p.json, 'utf8') };
}

const pick = (p: string | null) => async () => p;

/** 保存结果只含固定枚举与数字：不含路径分隔符或合成私密文本 */
function assertNoLeak(r: unknown): void {
  const s = JSON.stringify(r);
  assert.ok(!/zq|\/|\\/i.test(s), `保存结果含路径或私密文本：${s}`);
}

const boom = () => {
  throw new Error(C.error);
};

/** 以同一 inode 改写文件开头 7 字节（不改变长度） */
async function overwriteHead(t: string): Promise<void> {
  const h = await open(t, 'r+');
  try {
    await h.write('FOREIGN', 0, 'utf8');
  } finally {
    await h.close();
  }
}

test('保存 S01/T01/S02/T03：同一字节、0600、源变化后仍是预览内容；取消无副作用；无效 token 不弹框', async () => {
  const fx = await makeFx();
  try {
    const { svc, p, out, bytes } = await saveSetup(fx);
    // 预览之后源数据变化：保存的仍是冻结字节，不重新采集
    await writeFile(path.join(fx.root, 'Interface', '.beelite', 'manifest.json'), manifestJson({ '1': project('1', '2', ['A']) }));
    let picks = 0;
    const counted = (t: string | null) => async () => (picks++, t);

    assert.deepEqual(await svc.save('zq', 1, counted(path.join(out, 'x.json'))), { status: 'rejected', code: 'token-invalid', previewKept: false });
    assert.deepEqual(await svc.save(p.token, 2, counted(path.join(out, 'x.json'))), { status: 'rejected', code: 'owner-mismatch', previewKept: true });
    assert.equal(picks, 0, '无效 token / 所属者不弹框');

    assert.deepEqual(await svc.save(p.token, 1, counted(null)), { status: 'cancelled', previewKept: true });
    assert.deepEqual(await readdir(out), []);

    const target = path.join(out, 'diag.json');
    const r = await svc.save(p.token, 1, pick(target));
    assert.deepEqual(r, { status: 'saved', bytes: bytes.length, previewKept: true });
    assert.deepEqual(await readFile(target), bytes);
    const st = await lstat(target);
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o077, 0, '只有所有者可读写');
    assert.equal(st.mode & 0o600, 0o600);

    // 同一预览另存一份；已有文件不覆盖
    assert.equal((await svc.save(p.token, 1, pick(path.join(out, 'diag2.json')))).status, 'saved');
    assert.deepEqual(await readFile(path.join(out, 'diag2.json')), bytes);
    assert.deepEqual(await svc.save(p.token, 1, pick(target)), { status: 'rejected', code: 'exists', previewKept: true });
    assert.deepEqual(await readFile(target), bytes);
    assert.deepEqual(await svc.save(p.token, 1, pick('relative/zq.json')), { status: 'rejected', code: 'invalid-path', previewKept: true });
    assert.deepEqual(await svc.save(p.token, 1, pick(`${out}/../out/x.json`)), { status: 'rejected', code: 'invalid-path', previewKept: true });
  } finally {
    await cleanup(fx.base);
  }
});

test('保存 D06/D07：设置或保护列表无法完整确认时拒绝（不当作空集合），预览保留，不创建文件', async () => {
  const cases: [string, (fx: Fx) => Promise<void>, Partial<DiagnosticsOptions>?][] = [
    ['bad-json', (fx) => writeFile(fx.settingsFile, '{')],
    ['future-schema', (fx) => writeFile(fx.settingsFile, JSON.stringify({ schema: 2, bindings: {} }))],
    [
      'symlink',
      async (fx) => {
        const secret = path.join(fx.base, 'zq-settings.json');
        await writeFile(secret, JSON.stringify({ schema: 1, bindings: {} }));
        await rm(fx.settingsFile);
        await symlink(secret, fx.settingsFile);
      },
    ],
    [
      'fifo',
      async (fx) => {
        await rm(fx.settingsFile);
        await mkfifo(fx.settingsFile);
      },
    ],
    [
      'too-large',
      async (fx) => {
        const s = JSON.parse(await readFile(fx.settingsFile, 'utf8')) as Record<string, unknown>;
        await writeFile(fx.settingsFile, JSON.stringify({ ...s, pad: 'x'.repeat(5000) }));
      },
      { limits: { maxSettingsBytes: 4096 } },
    ],
    ['extras-throw', async () => undefined, { protectedExtras: async () => Promise.reject(new Error(C.error)) }],
    ['extras-relative', async () => undefined, { protectedExtras: async () => ['zq/relative'] }],
    ['extras-unnormalized', async () => undefined, { protectedExtras: async () => ['/tmp/../zq'] }],
    ['extras-not-array', async () => undefined, { protectedExtras: async () => null as unknown as string[] }],
  ];
  for (const [name, setup, extra] of cases) {
    const fx = await makeFx();
    try {
      const { svc, p, out } = await saveSetup(fx, extra);
      await setup(fx);
      let picks = 0;
      const r = await within(svc.save(p.token, 1, async () => (picks++, path.join(out, 'diag.json'))), 5000, name);
      assert.deepEqual(r, { status: 'rejected', code: 'protected-roots-unknown', previewKept: true }, name);
      assert.equal(picks, 1, name);
      assert.deepEqual(await readdir(out), [], `${name}: 不应创建文件`);
      assert.deepEqual(svc.checkToken(p.token, 1).status, 'ok', name);
      assertNoLeak(r);
      if (name === 'fifo') await releaseFifo(fx.settingsFile);
    } finally {
      await cleanup(fx.base);
    }
  }
});

test('保存 S04/S05：全部绑定（含未知版本与旧格式编号）、保护列表、设置目录及其别名都受保护；同前缀的兄弟目录允许', async () => {
  const fx = await makeFx();
  try {
    const unknownFlavor = path.join(fx.base, C.dir, 'x');
    const legacy = path.join(fx.base, 'legacy');
    const s = JSON.parse(await readFile(fx.settingsFile, 'utf8')) as { bindings: Record<string, string> };
    await writeFile(fx.settingsFile, JSON.stringify({ ...s, bindings: { ...s.bindings, '99': unknownFlavor, '09': legacy } }));
    const bundle = path.join(fx.base, 'App.app');
    const disabled = path.join(fx.base, 'backup-disabled');
    const restore = path.join(fx.base, 'restore-protect');
    const { svc, p, out } = await saveSetup(fx, { protectedExtras: async () => [bundle, disabled, restore] });

    const denied = [
      path.join(fx.userData, 'diag.json'),
      path.join(fx.root, 'diag.json'),
      path.join(fx.root, 'Interface', 'AddOns', 'diag.json'),
      path.join(fx.root2, 'diag.json'),
      path.join(unknownFlavor, 'diag.json'),
      path.join(legacy, 'sub', 'diag.json'),
      path.join(bundle, 'Contents', 'diag.json'),
      path.join(disabled, 'diag.json'),
      path.join(restore, 'deep', 'diag.json'),
    ];
    for (const t of denied) {
      await mkdir(path.dirname(t), { recursive: true });
      const before = await readdir(path.dirname(t));
      const r = await svc.save(p.token, 1, pick(t));
      assert.deepEqual(r, { status: 'rejected', code: 'protected-location', previewKept: true }, t);
      assert.deepEqual(await readdir(path.dirname(t)), before, t);
    }

    // 大小写别名（仅在大小写不敏感的卷上存在）
    const caseAlias = path.join(path.dirname(fx.root), '_FOREVER_');
    if (await lstat(caseAlias).then(() => true, () => false)) {
      assert.equal((await svc.save(p.token, 1, pick(path.join(caseAlias, 'diag.json')))).status, 'rejected');
      assert.deepEqual(await readdir(fx.root), ['Interface']);
    }
    // 经由符号链接到达游戏目录：上级链不安全
    await symlink(fx.root, path.join(out, 'glink'));
    assert.deepEqual(await svc.save(p.token, 1, pick(path.join(out, 'glink', 'diag.json'))), { status: 'rejected', code: 'parent-unsafe', previewKept: true });
    assert.deepEqual(await readdir(fx.root), ['Interface']);

    // 名称前缀相同的兄弟目录不受影响
    for (const dir of [`${disabled}2`, path.join(fx.base, C.dir, '_forever_2'), `${bundle}.bak`, path.join(fx.base, 'userData-other')]) {
      await mkdir(dir, { recursive: true });
      const r = await svc.save(p.token, 1, pick(path.join(dir, 'diag.json')));
      assert.equal(r.status, 'saved', dir);
    }
  } finally {
    await cleanup(fx.base);
  }
});

test('保存 S03：已有文件、符号链接、FIFO、目录一律不覆盖、不跟随', async () => {
  const fx = await makeFx();
  try {
    const { svc, p, out } = await saveSetup(fx);
    const secret = path.join(fx.base, 'zq-secret.txt');
    await writeFile(secret, 'secret');
    await writeFile(path.join(out, 'file.json'), 'old');
    await symlink(secret, path.join(out, 'link.json'));
    await symlink(path.join(fx.base, 'missing'), path.join(out, 'dangling.json'));
    await mkfifo(path.join(out, 'fifo.json'));
    await mkdir(path.join(out, 'dir.json'));
    const before = await snapshot(fx.base);
    for (const n of ['file.json', 'link.json', 'dangling.json', 'fifo.json', 'dir.json']) {
      const r = await within(svc.save(p.token, 1, pick(path.join(out, n))), 5000, n);
      assert.deepEqual(r, { status: 'rejected', code: 'exists', previewKept: true }, n);
    }
    assert.deepEqual(await snapshot(fx.base), before);
    await releaseFifo(path.join(out, 'fifo.json'));
  } finally {
    await cleanup(fx.base);
  }
});

test('保存 S06/T02/T04：选择期间新增绑定、窗口关闭、过期、父目录被替换、目标被抢先创建；保存与生成互斥', async () => {
  const fx = await makeFx();
  try {
    let now = 1_000_000;
    const steps: Steps = {};
    const { svc, p, out } = await saveSetup(fx, { now: () => now }, steps);
    const target = path.join(out, 'diag.json');

    // 选择期间新增绑定：选择之后读取的完整集合包含它
    const newGame = path.join(fx.base, 'newgame');
    const r1 = await svc.save(p.token, 1, async () => {
      await mkdir(newGame);
      const s = JSON.parse(await readFile(fx.settingsFile, 'utf8')) as { bindings: Record<string, string> };
      await writeFile(fx.settingsFile, JSON.stringify({ ...s, bindings: { ...s.bindings, '7': newGame } }));
      return path.join(newGame, 'diag.json');
    });
    assert.deepEqual(r1, { status: 'rejected', code: 'protected-location', previewKept: true });
    assert.deepEqual(await readdir(newGame), []);

    // 两次检查之间父目录被替换
    steps['save-before-open'] = async () => {
      await rename(out, `${out}-old`);
      await mkdir(out);
    };
    assert.deepEqual(await svc.save(p.token, 1, pick(target)), { status: 'rejected', code: 'parent-changed', previewKept: true });
    assert.deepEqual([await readdir(out), await readdir(`${out}-old`)], [[], []]);

    // 创建之前目标被别人创建：不覆盖
    steps['save-before-open'] = () => writeFile(target, 'foreign');
    assert.deepEqual(await svc.save(p.token, 1, pick(target)), { status: 'rejected', code: 'exists', previewKept: true });
    assert.equal(await readFile(target, 'utf8'), 'foreign');
    await unlink(target);
    delete steps['save-before-open'];

    // 保存进行中：生成与另一次保存都 busy；之后取消
    let release!: (v: string | null) => void;
    const pending = svc.save(p.token, 1, () => new Promise((res) => (release = res)));
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(await svc.preview({ flavorId: FOREVER, mode: 'replace', owner: 1 }), { status: 'rejected', code: 'busy' });
    assert.deepEqual(await svc.save(p.token, 1, pick(target)), { status: 'rejected', code: 'busy', previewKept: true });
    release(null);
    assert.deepEqual(await pending, { status: 'cancelled', previewKept: true });

    // 选择期间过期
    const expired = await svc.save(p.token, 1, async () => ((now += HARD_DIAG_LIMITS.previewTtlMs), target));
    assert.deepEqual(expired, { status: 'rejected', code: 'token-expired', previewKept: false });
    assert.deepEqual(await readdir(out), []);

    // 选择期间窗口关闭：不写入，也不复活预览
    now = 1_000_000;
    const p2 = ready(await svc.preview({ flavorId: FOREVER, mode: 'reuse', owner: 1 }));
    const gone = await svc.save(p2.token, 1, async () => (svc.dropOwner(1), target));
    assert.deepEqual(gone, { status: 'rejected', code: 'owner-gone', previewKept: false });
    assert.deepEqual(await readdir(out), []);
    assert.equal(svc.checkToken(p2.token, 1).status, 'rejected');
  } finally {
    await cleanup(fx.base);
  }
});

test('保存 S07–S10：写入、fsync、关闭、目录 fsync 失败只清本次文件；身份未知、外来替换、同 inode 改动、父目录替换、删除失败如实保留', async () => {
  const failures: [DiagStep, string][] = [
    ['save-write', 'write-failed'],
    ['save-sync', 'sync-failed'],
    ['save-close', 'close-failed'],
    ['save-parent-sync', 'parent-sync-failed'],
  ];
  for (const [step, code] of failures) {
    const fx = await makeFx();
    try {
      const steps: Steps = {};
      steps[step] = boom;
      const { svc, p, out } = await saveSetup(fx, {}, steps);
      const r = await svc.save(p.token, 1, pick(path.join(out, 'diag.json')));
      assert.deepEqual(r, { status: 'failed', code, cleanup: 'removed', previewKept: true }, step);
      assert.deepEqual(await readdir(out), [], step);
      assertNoLeak(r);
    } finally {
      await cleanup(fx.base);
    }
  }

  const retained: [string, (target: string, out: string) => Steps, Record<string, unknown>, (target: string, out: string) => Promise<void>][] = [
    [
      'identity-unknown',
      () => ({ 'save-fstat': boom }),
      { status: 'failed', code: 'identity-unknown', cleanup: 'retained-unconfirmed' },
      async (t) => assert.ok((await lstat(t)).isFile(), '身份未知的文件不删除'),
    ],
    [
      'replaced-after-open',
      (t) => ({
        'save-after-open': async () => {
          await unlink(t);
          await writeFile(t, 'sentinel');
        },
      }),
      // 写入之前的复核发现路径已换成别的文件：不写入任何内容
      { status: 'failed', code: 'content-changed', cleanup: 'retained-replaced' },
      async (t) => assert.equal(await readFile(t, 'utf8'), 'sentinel'),
    ],
    [
      'replaced-during-write',
      (t) => ({
        'save-write': async () => {
          await unlink(t);
          await writeFile(t, 'sentinel');
          throw new Error(C.error);
        },
      }),
      { status: 'failed', code: 'write-failed', cleanup: 'retained-replaced' },
      async (t) => assert.equal(await readFile(t, 'utf8'), 'sentinel'),
    ],
    [
      'same-inode-changed',
      (t) => ({ 'save-write': boom, 'save-before-cleanup': () => appendFile(t, 'foreign') }),
      { status: 'failed', code: 'write-failed', cleanup: 'retained-unconfirmed' },
      async (t) => assert.ok((await readFile(t, 'utf8')).endsWith('foreign')),
    ],
    [
      'parent-replaced',
      (_t, out) => ({
        'save-write': boom,
        'save-before-cleanup': async () => {
          await rename(out, `${out}-old`);
          await mkdir(out);
        },
      }),
      { status: 'failed', code: 'write-failed', cleanup: 'retained-parent-changed' },
      async (_t, out) => assert.deepEqual(await readdir(`${out}-old`), ['diag.json']),
    ],
    [
      'remove-failed',
      () => ({ 'save-write': boom, 'save-unlink': boom }),
      { status: 'failed', code: 'write-failed', cleanup: 'remove-failed' },
      async (t) => assert.ok((await lstat(t)).isFile()),
    ],
    [
      'post-verify',
      (t) => ({ 'save-before-verify': () => appendFile(t, 'foreign') }),
      { status: 'unconfirmed', code: 'post-verify-failed', cleanup: 'retained-unconfirmed' },
      async (t) => assert.ok((await readFile(t, 'utf8')).endsWith('foreign')),
    ],
    // 回归 1：已写入的前缀被同 inode 改写后写入失败——改写后的状态不能当作“本次写入”的证明，保留外来字节
    [
      'same-inode-edit-then-fail',
      (t) => ({
        'save-write': async () => {
          await overwriteHead(t);
          throw new Error(C.error);
        },
      }),
      { status: 'failed', code: 'write-failed', cleanup: 'retained-unconfirmed' },
      async (t) => assert.equal((await readFile(t, 'utf8')).slice(0, 7), 'FOREIGN'),
    ],
    // 回归 2：同样改写但写入继续：下一段写入前读回发现不一致，不再写、不报告成功、不覆写修复
    [
      'same-inode-edit-success-path',
      (t) => ({ 'save-write': () => overwriteHead(t) }),
      { status: 'failed', code: 'content-changed', cleanup: 'retained-unconfirmed' },
      async (t) => assert.equal((await readFile(t, 'utf8')).slice(0, 7), 'FOREIGN'),
    ],
    // 回归 4：创建之后、写入之前所在目录被移走并换成指向它的符号链接：不写入报告内容
    [
      'parent-symlinked-after-open',
      (_t, out) => ({
        'save-fstat': async () => {
          await rename(out, `${out}-moved`);
          await symlink(`${out}-moved`, out);
        },
      }),
      { status: 'failed', code: 'parent-changed', cleanup: 'retained-parent-changed' },
      async (_t, out) => assert.equal((await lstat(path.join(`${out}-moved`, 'diag.json'))).size, 0),
    ],
    // 回归 5：删除前的注入点里本次文件被换成外来文件：最终复核在注入点之后，外来文件保留
    [
      'replaced-at-unlink',
      (t) => ({
        'save-write': boom,
        'save-unlink': async () => {
          await unlink(t);
          await writeFile(t, 'sentinel');
        },
      }),
      { status: 'failed', code: 'write-failed', cleanup: 'retained-replaced' },
      async (t) => assert.equal(await readFile(t, 'utf8'), 'sentinel'),
    ],
  ];
  for (const [name, mk, expect, check] of retained) {
    const fx = await makeFx();
    try {
      const out = path.join(fx.base, 'out');
      const target = path.join(out, 'diag.json');
      const { svc, p } = await saveSetup(fx, {}, mk(target, out));
      const r = await svc.save(p.token, 1, pick(target));
      assert.deepEqual(r, { ...expect, previewKept: true }, name);
      await check(target, out);
      assertNoLeak(r);
      assert.equal(svc.checkToken(p.token, 1).status, 'ok', `${name}: 预览保留`);
    } finally {
      await cleanup(fx.base);
    }
  }
});

test('保存（回归 3）：保护集合读取期间绑定或设置变化、创建之后变更计数变化，一律不写入受保护位置', async () => {
  const addBinding = async (fx: Fx, dir: string) => {
    const s = JSON.parse(await readFile(fx.settingsFile, 'utf8')) as { bindings: Record<string, string> };
    await writeFile(fx.settingsFile, JSON.stringify({ ...s, bindings: { ...s.bindings, '99': dir } }));
  };
  const bundle = (fx: Fx) => path.join(fx.base, 'App.app');

  // 第二次读取保护列表期间另一操作合法绑定了导出目录并递增计数
  {
    const fx = await makeFx();
    try {
      const out = path.join(fx.base, 'out');
      let epoch = 0;
      let calls = 0;
      const { svc, p } = await saveSetup(fx, {
        epoch: () => epoch,
        protectedExtras: async () => {
          if (++calls === 2) {
            await addBinding(fx, out);
            epoch++;
          }
          return [bundle(fx)];
        },
      });
      const r = await svc.save(p.token, 1, pick(path.join(out, 'diag.json')));
      assert.deepEqual(r, { status: 'rejected', code: 'protection-changed', previewKept: true });
      assert.equal(calls, 2);
      assert.deepEqual(await readdir(out), []);
    } finally {
      await cleanup(fx.base);
    }
  }

  // 读取期间设置内容被人工改动（计数不变）：同样拒绝
  {
    const fx = await makeFx();
    try {
      const out = path.join(fx.base, 'out');
      let calls = 0;
      const { svc, p } = await saveSetup(fx, {
        protectedExtras: async () => {
          if (++calls === 1) await addBinding(fx, out);
          return [bundle(fx)];
        },
      });
      const r = await svc.save(p.token, 1, pick(path.join(out, 'diag.json')));
      assert.deepEqual(r, { status: 'rejected', code: 'protection-changed', previewKept: true });
      assert.deepEqual(await readdir(out), []);
    } finally {
      await cleanup(fx.base);
    }
  }

  // 创建之后、第二段写入之前计数变化：不再写入，本次部分文件确认无误后删除
  {
    const fx = await makeFx();
    try {
      let epoch = 0;
      const steps: Steps = { 'save-write': () => void epoch++ };
      const { svc, p, out } = await saveSetup(fx, { epoch: () => epoch }, steps);
      const r = await svc.save(p.token, 1, pick(path.join(out, 'diag.json')));
      assert.deepEqual(r, { status: 'failed', code: 'protection-changed', cleanup: 'removed', previewKept: true });
      assert.deepEqual(await readdir(out), []);
    } finally {
      await cleanup(fx.base);
    }
  }

  // 计数读取异常：按已变化处理
  {
    const fx = await makeFx();
    try {
      let n = 0;
      const { svc, p, out } = await saveSetup(fx, {
        epoch: () => {
          if (++n > 2) throw new Error(C.error);
          return 0;
        },
      });
      const r = await svc.save(p.token, 1, pick(path.join(out, 'diag.json')));
      assert.equal(r.status, 'rejected');
      assertNoLeak(r);
      assert.deepEqual(await readdir(out), []);
    } finally {
      await cleanup(fx.base);
    }
  }
});
