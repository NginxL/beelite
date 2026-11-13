// WTF 恢复的纯计划：只构造内存中的清单条目，不访问任何文件系统。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { UserError } from '../src/core/errors';
import { planRestore, RESTORE_SAMPLE_MAX, type RestorePlan } from '../src/core/wtf-restore-plan';
import type { ManifestEntry } from '../src/core/wtf-backup';
import type { BackupScope } from '../src/shared/backup-types';

const F = (path: string, content = path): ManifestEntry => ({ path, type: 'file', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
const D = (path: string): ManifestEntry => ({ path, type: 'dir' });
const isCode = (c: string) => (err: unknown) => err instanceof UserError && err.code === c;

/** 候选树的「路径|类型|来源|内容校验值」，按路径排序 */
function shape(p: RestorePlan): string[] {
  return p.entries.map((e) => `${e.path}|${e.type}|${e.origin}${e.type === 'file' ? `|${e.sha256?.slice(0, 8)}` : ''}`).sort();
}
const fileOf = (e: ManifestEntry) => e.sha256?.slice(0, 8);

const ALL: BackupScope = { kind: 'all' };
const ACCOUNT: BackupScope = { kind: 'account', account: 'ALPHA' };
const CHARS: BackupScope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: '白银之手', character: '甲' }, { realm: '奥特兰克', character: '甲' }] };

/** 当前 WTF：根级设置、两个账号、所选与未选角色、服务器直属文件、未选服务器、共享 SavedVariables */
function currentTree(): ManifestEntry[] {
  return [
    F('Config.wtf', 'cfg-now'),
    D('Account'),
    D('Account/ALPHA'),
    F('Account/ALPHA/config-cache.wtf', 'acct-now'),
    F('Account/ALPHA/added-later.txt', 'new'),
    D('Account/ALPHA/SavedVariables'),
    F('Account/ALPHA/SavedVariables/Shared.lua', 'sv-now'),
    F('Account/ALPHA/SavedVariables/Later.lua', 'sv-later'),
    D('Account/ALPHA/白银之手'),
    F('Account/ALPHA/白银之手/realm-cache.wtf', 'realm-now'),
    D('Account/ALPHA/白银之手/甲'),
    F('Account/ALPHA/白银之手/甲/AddOns.txt', 'char-now'),
    F('Account/ALPHA/白银之手/甲/extra.txt', 'char-extra'),
    D('Account/ALPHA/白银之手/乙'),
    F('Account/ALPHA/白银之手/乙/AddOns.txt', 'other-char'),
    D('Account/ALPHA/奥特兰克'),
    D('Account/ALPHA/奥特兰克/甲'),
    F('Account/ALPHA/奥特兰克/甲/bindings-cache.wtf', 'char2-now'),
    D('Account/ALPHA/UnknownDirectory'),
    F('Account/ALPHA/UnknownDirectory/foreign.txt', 'foreign'),
    D('Account/BRAVO'),
    F('Account/BRAVO/config-cache.wtf', 'bravo'),
  ];
}

/** 角色快照：账号直属文件、共享 SavedVariables 与两个所选角色 */
function charsSnapshot(): ManifestEntry[] {
  return [
    D('Account'),
    D('Account/ALPHA'),
    F('Account/ALPHA/config-cache.wtf', 'acct-old'),
    D('Account/ALPHA/SavedVariables'),
    F('Account/ALPHA/SavedVariables/Shared.lua', 'sv-old'),
    D('Account/ALPHA/白银之手'),
    D('Account/ALPHA/白银之手/甲'),
    F('Account/ALPHA/白银之手/甲/AddOns.txt', 'char-old'),
    D('Account/ALPHA/奥特兰克'),
    D('Account/ALPHA/奥特兰克/甲'),
    F('Account/ALPHA/奥特兰克/甲/bindings-cache.wtf', 'char2-now'),
  ];
}

test('all：候选树就是快照，范围内差异按新增 / 覆盖 / 相同 / 删除计数', () => {
  const snap = [F('Config.wtf', 'cfg-old'), D('Account'), D('Account/ALPHA'), F('Account/ALPHA/config-cache.wtf', 'acct-now'), F('Account/ALPHA/only-old.txt', 'x'), D('Empty')];
  const p = planRestore(ALL, snap, currentTree());
  assert.equal(p.baseline, 'present');
  assert.deepEqual(shape(p), snap.map((e) => `${e.path}|${e.type}|snapshot${e.type === 'file' ? `|${fileOf(e)}` : ''}`).sort());
  assert.equal(p.counts.overwriteFiles, 1); // Config.wtf
  assert.equal(p.counts.sameFiles, 1); // config-cache.wtf
  assert.equal(p.counts.addFiles, 1);
  assert.equal(p.counts.addDirs, 1); // Empty
  assert.equal(p.counts.deleteFiles, currentTree().filter((e) => e.type === 'file').length - 2);
  assert.ok(p.samples.delete.includes('Account/BRAVO'));
  assert.deepEqual(p.kept, { files: 0, dirs: 0, bytes: 0 });
});

test('account：只替换 Account/ALPHA 子树，其他账号与根级内容保留', () => {
  const snap = [D('Account'), D('Account/ALPHA'), F('Account/ALPHA/config-cache.wtf', 'acct-old'), D('Account/ALPHA/白银之手'), D('Account/ALPHA/白银之手/甲'), F('Account/ALPHA/白银之手/甲/AddOns.txt', 'char-old')];
  const p = planRestore(ACCOUNT, snap, currentTree());
  const s = shape(p);
  assert.ok(s.includes(`Config.wtf|file|baseline|${fileOf(F('x', 'cfg-now'))}`));
  assert.ok(s.includes('Account|dir|baseline'));
  assert.ok(s.includes('Account/BRAVO|dir|baseline'));
  assert.ok(s.includes('Account/ALPHA|dir|snapshot'));
  assert.ok(!s.some((x) => x.startsWith('Account/ALPHA/SavedVariables')), '快照没有的范围内内容被删除');
  assert.ok(!s.some((x) => x.startsWith('Account/ALPHA/UnknownDirectory')));
  assert.ok(!s.some((x) => x.startsWith('Account/ALPHA/白银之手/乙')));
  assert.equal(p.counts.overwriteFiles, 2);
  assert.ok(p.samples.delete.includes('Account/ALPHA/白银之手/乙'));
  assert.deepEqual(p.kept, { files: 2, dirs: 2, bytes: Buffer.byteLength('cfg-now') + Buffer.byteLength('bravo') });
});

test('characters：直属文件、SavedVariables 与所选角色镜像，未选角色、服务器直属文件与未选目录保留', () => {
  const p = planRestore(CHARS, charsSnapshot(), currentTree());
  const s = shape(p);
  const has = (path: string, origin: string) => assert.ok(s.some((x) => x.startsWith(`${path}|`) && x.includes(`|${origin}`)), `${path} 应来自 ${origin}`);
  const gone = (path: string) => assert.ok(!s.some((x) => x.startsWith(`${path}|`)), `${path} 应被删除`);
  has('Config.wtf', 'baseline');
  has('Account/BRAVO/config-cache.wtf', 'baseline');
  has('Account/ALPHA', 'baseline');
  has('Account/ALPHA/白银之手', 'baseline');
  has('Account/ALPHA/白银之手/realm-cache.wtf', 'baseline');
  has('Account/ALPHA/白银之手/乙/AddOns.txt', 'baseline');
  has('Account/ALPHA/UnknownDirectory/foreign.txt', 'baseline');
  has('Account/ALPHA/config-cache.wtf', 'snapshot');
  has('Account/ALPHA/SavedVariables/Shared.lua', 'snapshot');
  has('Account/ALPHA/白银之手/甲/AddOns.txt', 'snapshot');
  gone('Account/ALPHA/added-later.txt');
  gone('Account/ALPHA/SavedVariables/Later.lua');
  gone('Account/ALPHA/白银之手/甲/extra.txt');
  assert.deepEqual(
    { ...p.counts },
    {
      addFiles: 0, overwriteFiles: 3, sameFiles: 1, deleteFiles: 3, addDirs: 0, deleteDirs: 0,
      writeBytes: Buffer.byteLength('acct-old') + Buffer.byteLength('sv-old') + Buffer.byteLength('char-old'),
      deleteBytes: Buffer.byteLength('new') + Buffer.byteLength('sv-later') + Buffer.byteLength('char-extra'),
    },
  );
  // 候选树中每个条目的上级目录都存在
  const paths = new Set(p.entries.map((e) => e.path));
  for (const e of p.entries) if (e.path.includes('/')) assert.ok(paths.has(e.path.slice(0, e.path.lastIndexOf('/'))));
});

test('characters：快照没有 SavedVariables 时删除当前的；当前缺少的途经目录按快照新建', () => {
  const snap = charsSnapshot().filter((e) => !e.path.startsWith('Account/ALPHA/SavedVariables'));
  const cur = currentTree().filter((e) => !e.path.startsWith('Account/ALPHA/奥特兰克'));
  const p = planRestore(CHARS, snap, cur);
  assert.ok(!p.entries.some((e) => e.path.startsWith('Account/ALPHA/SavedVariables')));
  assert.equal(p.entries.find((e) => e.path === 'Account/ALPHA/奥特兰克')?.origin, 'snapshot');
  assert.ok(p.samples.delete.includes('Account/ALPHA/SavedVariables'));
  assert.ok(p.samples.add.includes('Account/ALPHA/奥特兰克'));
  assert.equal(p.counts.deleteDirs, 1);
});

test('absent：当前没有 WTF 时候选树只含快照内容，全部计为新增', () => {
  const p = planRestore(CHARS, charsSnapshot(), null);
  assert.equal(p.baseline, 'absent');
  assert.ok(p.entries.every((e) => e.origin === 'snapshot'));
  assert.equal(p.entries.length, charsSnapshot().length);
  assert.equal(p.counts.addFiles, 4);
  assert.equal(p.counts.deleteFiles + p.counts.overwriteFiles + p.counts.sameFiles, 0);
  assert.deepEqual(p.kept, { files: 0, dirs: 0, bytes: 0 });
});

test('范围内的类型变化按镜像处理：SavedVariables 是文件、角色目录内文件变文件夹、与所选服务器同名的账号直属文件', () => {
  const cur = [
    D('Account'),
    D('Account/ALPHA'),
    F('Account/ALPHA/SavedVariables', 'was-a-file'),
    F('Account/ALPHA/奥特兰克', 'direct-file-named-like-realm'),
    D('Account/ALPHA/白银之手'),
    D('Account/ALPHA/白银之手/甲'),
    D('Account/ALPHA/白银之手/甲/AddOns.txt'),
  ];
  const p = planRestore(CHARS, charsSnapshot(), cur);
  assert.equal(p.entries.find((e) => e.path === 'Account/ALPHA/SavedVariables')?.type, 'dir');
  assert.equal(p.entries.find((e) => e.path === 'Account/ALPHA/奥特兰克')?.type, 'dir');
  assert.equal(p.entries.find((e) => e.path === 'Account/ALPHA/白银之手/甲/AddOns.txt')?.type, 'file');
  assert.ok(p.samples.delete.includes('Account/ALPHA/SavedVariables'));
  assert.ok(p.samples.delete.includes('Account/ALPHA/白银之手/甲/AddOns.txt'));
});

test('冲突拒绝：快照的账号直属文件与当前未选服务器目录同名', () => {
  const snap = [...charsSnapshot(), F('Account/ALPHA/UnknownDirectory', 'file-in-backup')];
  assert.throws(() => planRestore(CHARS, snap, currentTree()), isCode('restore-conflict'));
});

test('冲突拒绝：当前服务器目录下与所选角色同名的直属文件', () => {
  const cur = currentTree().filter((e) => !e.path.startsWith('Account/ALPHA/奥特兰克/甲'));
  cur.push(F('Account/ALPHA/奥特兰克/甲', 'realm-direct-file'));
  assert.throws(() => planRestore(CHARS, charsSnapshot(), cur), isCode('restore-conflict'));
});

test('冲突拒绝：账号、服务器、角色、Account 目录只差大小写或 Unicode 形式', () => {
  const rename = (from: string, to: string) => currentTree().map((e) => (e.path === from || e.path.startsWith(`${from}/`) ? { ...e, path: to + e.path.slice(from.length) } : e));
  assert.throws(() => planRestore(ACCOUNT, charsSnapshot(), rename('Account/ALPHA', 'Account/alpha')), isCode('restore-conflict'));
  assert.throws(() => planRestore(CHARS, charsSnapshot(), rename('Account/ALPHA', 'Account/alpha')), isCode('restore-conflict'));
  assert.throws(() => planRestore(CHARS, charsSnapshot(), rename('Account', 'ACCOUNT')), isCode('restore-conflict'));
  const realm: BackupScope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: 'Silver', character: 'Ab' }] };
  const snap = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/Silver'), D('Account/ALPHA/Silver/Ab'), F('Account/ALPHA/Silver/Ab/AddOns.txt')];
  const cur = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/silver'), D('Account/ALPHA/silver/Ab')];
  assert.throws(() => planRestore(realm, snap, cur), isCode('restore-conflict'));
  const cur2 = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/Silver'), D('Account/ALPHA/Silver/ab')];
  assert.throws(() => planRestore(realm, snap, cur2), isCode('restore-conflict'));
  // NFC 与 NFD 形式的同一角色名
  const nfd: BackupScope = { kind: 'characters', account: 'ALPHA', characters: [{ realm: 'Silver', character: 'Ré' }] };
  const snap3 = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/Silver'), D('Account/ALPHA/Silver/Ré'), F('Account/ALPHA/Silver/Ré/AddOns.txt')];
  const cur3 = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/Silver'), D(`Account/ALPHA/Silver/${'Ré'.normalize('NFD')}`)];
  assert.throws(() => planRestore(nfd, snap3, cur3), isCode('restore-conflict'));
});

test('完全属于范围的内容只差拼写时按快照拼写镜像，并显示在差异中', () => {
  const cur = currentTree().map((e) => (e.path.startsWith('Account/ALPHA/SavedVariables') ? { ...e, path: e.path.replace('SavedVariables', 'savedvariables') } : e));
  const p = planRestore(CHARS, charsSnapshot(), cur);
  assert.ok(p.entries.some((e) => e.path === 'Account/ALPHA/SavedVariables' && e.origin === 'snapshot'));
  assert.ok(!p.entries.some((e) => e.path.startsWith('Account/ALPHA/savedvariables')));
  assert.ok(p.samples.add.includes('Account/ALPHA/SavedVariables'));
  assert.ok(p.samples.delete.includes('Account/ALPHA/savedvariables'));
  assert.ok(p.samples.overwrite.includes('Account/ALPHA/SavedVariables/Shared.lua'));
  // 只有空目录改了拼写也不能显示为没有变化
  const snapOnly = [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/Empty')];
  const q = planRestore(ACCOUNT, snapOnly, [D('Account'), D('Account/ALPHA'), D('Account/ALPHA/empty')]);
  assert.equal(q.counts.addDirs, 1);
  assert.equal(q.counts.deleteDirs, 1);
  // 同一文件只差拼写计为覆盖，不计删除
  const r = planRestore(ACCOUNT, [D('Account'), D('Account/ALPHA'), F('Account/ALPHA/A.txt', 'x')], [D('Account'), D('Account/ALPHA'), F('Account/ALPHA/a.txt', 'x')]);
  assert.equal(r.counts.overwriteFiles, 1);
  assert.equal(r.counts.deleteFiles, 0);
  assert.equal(r.entries.find((e) => e.path.endsWith('.txt'))?.path, 'Account/ALPHA/A.txt');
});

test('冲突拒绝：Account 或按角色恢复时的所选账号不是文件夹', () => {
  assert.throws(() => planRestore(CHARS, charsSnapshot(), [F('Account', 'file')]), isCode('restore-conflict'));
  assert.throws(() => planRestore(CHARS, charsSnapshot(), [D('Account'), F('Account/ALPHA', 'file')]), isCode('restore-conflict'));
  // 整账号范围内账号本身是文件属于范围内的类型变化
  const p = planRestore(ACCOUNT, [D('Account'), D('Account/ALPHA')], [D('Account'), F('Account/ALPHA', 'file')]);
  assert.equal(p.entries.find((e) => e.path === 'Account/ALPHA')?.type, 'dir');
});

test('输入校验：快照超出范围、缺少上级目录、重复条目、范围内当前文件缺少校验值都拒绝', () => {
  assert.throws(() => planRestore(CHARS, [...charsSnapshot(), F('Config.wtf')], currentTree()), isCode('restore-plan'));
  assert.throws(() => planRestore(CHARS, [...charsSnapshot(), D('Account/ALPHA/白银之手/乙')], currentTree()), isCode('restore-plan'));
  assert.throws(() => planRestore(ALL, [F('a/b.txt')], null), isCode('restore-plan'));
  assert.throws(() => planRestore(ALL, [F('A.txt'), F('a.txt')], null), isCode('restore-plan'));
  assert.throws(() => planRestore(ALL, [{ path: 'x', type: 'file', size: 1 }], null), isCode('restore-plan'));
  assert.throws(() => planRestore(ALL, [F('../x')], null), isCode('restore-plan'));
  assert.throws(() => planRestore(ALL, [], [{ path: 'Config.wtf', type: 'file', size: 1 }]), isCode('restore-plan'));
  // 范围外的当前文件可以不带校验值
  const p = planRestore(ACCOUNT, [D('Account'), D('Account/ALPHA')], [{ path: 'Config.wtf', type: 'file', size: 3 }]);
  assert.equal(p.entries.find((e) => e.path === 'Config.wtf')?.origin, 'baseline');
});

test('差异示例有上限并标记截断', () => {
  const snap: ManifestEntry[] = [];
  for (let i = 0; i < RESTORE_SAMPLE_MAX + 5; i++) snap.push(F(`f${String(i).padStart(3, '0')}.txt`));
  const p = planRestore(ALL, snap, null);
  assert.equal(p.samples.add.length, RESTORE_SAMPLE_MAX);
  assert.equal(p.samples.truncated, true);
  assert.equal(p.samples.add[0], 'f000.txt');
});
