// 元数据大小（0.1.8）：提交的 manifest 与 journal 不得超过自身的读取上限。写 journal、移动任何目录之前按实际写入格式
// 校验下一份 manifest 与 prepared / committing 两个状态的 journal；超限即拒绝，插件、原有记录、备份与 WTF 均不改动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { assertMetadataFits, MAX_METADATA_BYTES } from '../src/core/layout';
import { commitTexts, emptyManifest, parseJournal, parseManifest, type Journal, type Manifest } from '../src/core/store';
import { addonEntries, addUnmanaged, cleanup, exists, FakeSource, makeGameRoot, makeManager, makeZip, tmpDir } from './helpers';

const F = 9;
const MiB = 1024 * 1024;

const tooLarge = (e: unknown) => e instanceof UserError && e.code === 'metadata-too-large' && /超过 16 MiB 的记录上限，本次操作未提交/.test(e.message);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 递归读取目录为 {相对路径: 内容摘要} */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = '';
        await walk(path.join(d, e.name), r);
      } else out[r] = sha(await readFile(path.join(d, e.name)));
    }
  };
  await walk(dir, '');
  return out;
}

/** 游戏目录中所有会被检查的内容：manifest 原始字节、AddOns、回收站、WTF；另外确认没有残留 journal、临时清单与暂存 */
async function state(root: string) {
  const meta = path.join(root, 'Interface', '.beelite');
  return {
    manifest: sha(await readFile(path.join(meta, 'manifest.json'))),
    addons: await tree(path.join(root, 'Interface', 'AddOns')),
    trash: await tree(path.join(meta, 'trash')),
    wtf: await tree(path.join(root, 'WTF')),
    journal: await exists(path.join(meta, 'journal.json')),
    manifestTmp: await exists(path.join(meta, 'manifest.json.tmp')),
    staging: await readdir(path.join(meta, 'staging')),
  };
}

function journalOf(kind: string): Journal {
  return { schema: 1, txId: 'mabc123-0a1b2c', kind, state: 'prepared', trashIds: [], ops: [], createdAt: 1 };
}

test('元数据上限：等于上限可以写出，超过 1 字节拒绝；按 UTF-8 字节而不是字符数计算', () => {
  assertMetadataFits('a'.repeat(MAX_METADATA_BYTES), '插件清单');
  assert.throws(() => assertMetadataFits('a'.repeat(MAX_METADATA_BYTES + 1), '插件清单'), tooLarge);
  // 每个汉字 3 字节：字符数远小于上限，字节数恰好不超过 / 超过上限
  const fit = Math.floor(MAX_METADATA_BYTES / 3);
  assertMetadataFits('艾'.repeat(fit), '插件清单');
  assert.ok(fit + 1 < MAX_METADATA_BYTES);
  assert.throws(() => assertMetadataFits('艾'.repeat(fit + 1), '插件清单'), tooLarge);
});

test('提交文本：沿用原有写入格式；committing 比 prepared 长 2 字节，prepared 不超限但 committing 超限时也拒绝', () => {
  const next: Manifest = { ...emptyManifest(), lastTxId: 'mabc123-0a1b2c' };
  const base = Buffer.byteLength(JSON.stringify(journalOf('')));
  const padded = (bytes: number) => journalOf('k'.repeat(bytes - base));

  // prepared = 上限 - 2，committing 恰好等于上限：可以提交
  const ok = commitTexts(next, padded(MAX_METADATA_BYTES - 2));
  assert.equal(Buffer.byteLength(ok.prepared), MAX_METADATA_BYTES - 2);
  assert.equal(Buffer.byteLength(ok.committing), MAX_METADATA_BYTES);
  assert.equal(ok.prepared, JSON.stringify(padded(MAX_METADATA_BYTES - 2)), 'prepared 与原写入格式逐字节一致');
  assert.equal(ok.manifest, JSON.stringify(next, null, 1), 'manifest 与原写入格式逐字节一致');
  assert.equal(parseJournal(ok.committing).state, 'committing');
  assert.deepEqual(parseManifest(ok.manifest), next);

  // prepared = 上限 - 1，committing = 上限 + 1：拒绝
  assert.throws(() => commitTexts(next, padded(MAX_METADATA_BYTES - 1)), tooLarge);

  // 下一份清单超限同样拒绝
  const big: Manifest = { ...next, recovery: [{ id: 'mabc123-0a1b2d', kind: 'uninstall', createdAt: 1, label: '艾'.repeat(Math.ceil(MAX_METADATA_BYTES / 3)), folders: ['A'], project: null }] };
  assert.throws(() => commitTexts(big, journalOf('')), tooLarge);
});

test('6 MiB 名称：首次安装可读；更新将使清单超限时拒绝且不改动任何内容，之后仍可正常管理与卸载', async () => {
  const base = await tmpDir();
  try {
    const root = await makeGameRoot(base);
    const src = new FakeSource();
    const m = makeManager(src);
    const name = 'N'.repeat(6 * MiB);
    src.set('26', F, { name, fileId: '1', zip: makeZip(addonEntries('SizeFixture', 'v1')) });
    assert.equal((await m.install(root, F, '26', { expect: { kind: 'absent' } })).ok, true);
    const old = (await m.readManifestFor(root)).projects['26'];

    src.set('26', F, { name, fileId: '2', zip: makeZip(addonEntries('SizeFixture', 'v2')) });
    const before = await state(root);
    await assert.rejects(m.install(root, F, '26', { expect: { kind: 'record', fileId: old.fileId, installedAt: old.installedAt } }), tooLarge);
    assert.deepEqual(await state(root), before, '清单、AddOns、回收站、WTF 均未改动，没有残留');
    assert.deepEqual(before.staging, []);
    assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'SizeFixture', 'SizeFixture.lua'), 'utf8'), /v1/);

    const local = await m.localState({ flavorId: F, root, addonsPath: null }, F);
    assert.deepEqual(local.dir, { status: 'ok', message: null });
    assert.deepEqual(local.managed.map((p) => [p.modId, p.fileId]), [['26', '1']]);

    // 卸载后的清单（项目移入回收站记录，名称两份）不超限：照常执行
    assert.equal((await m.uninstallProject(root, '26')).ok, true);
    const after = await m.readManifestFor(root);
    assert.deepEqual(Object.keys(after.projects), []);
    assert.deepEqual(after.recovery.map((e) => [e.kind, e.folders]), [['uninstall', ['SizeFixture']]]);
  } finally {
    await cleanup(base);
  }
});

test('已有更新前备份：新的更新将使清单超限时拒绝，原有备份记录与回收站内容保持不变', async () => {
  const base = await tmpDir();
  try {
    const root = await makeGameRoot(base);
    const src = new FakeSource();
    const m = makeManager(src);
    const name = 'N'.repeat(4 * MiB);
    src.set('26', F, { name, fileId: '1', zip: makeZip(addonEntries('SizeFixture', 'v1')) });
    await m.install(root, F, '26');
    // 第一次更新：当前项目 + 备份标签 + 备份项目，约 12 MiB，可以提交
    src.set('26', F, { name, fileId: '2', zip: makeZip(addonEntries('SizeFixture', 'v2')) });
    assert.equal((await m.install(root, F, '26')).ok, true);
    const backups = (await m.readManifestFor(root)).recovery;
    assert.deepEqual(backups.map((e) => [e.kind, e.project?.fileId]), [['update-backup', '1']]);

    // 远端名称变得更长：新的项目记录（9 MiB）加上本次备份（2 × 4 MiB）超限
    src.set('26', F, { name: 'M'.repeat(9 * MiB), fileId: '3', zip: makeZip(addonEntries('SizeFixture', 'v3')) });
    const before = await state(root);
    await assert.rejects(m.install(root, F, '26'), tooLarge);
    assert.deepEqual(await state(root), before, '原有备份、清单、AddOns、WTF 均未改动');
    const kept = await m.readManifestFor(root);
    assert.deepEqual(kept.recovery, backups, '原有更新前备份仍登记');
    assert.equal(kept.projects['26'].fileId, '2');
    assert.ok(Object.keys(before.trash).some((k) => k.endsWith(`${backups[0].id}/SizeFixture/SizeFixture.lua`)), '旧备份内容仍在回收站');
    assert.match(await readFile(path.join(root, 'Interface', 'AddOns', 'SizeFixture', 'SizeFixture.lua'), 'utf8'), /v2/);
  } finally {
    await cleanup(base);
  }
});

test('清单接近上限：卸载目录 / 插件超限时拒绝并清理空的回收目录；永久删除使清单变小，照常执行', async () => {
  const base = await tmpDir();
  try {
    const root = await makeGameRoot(base);
    const meta = path.join(root, 'Interface', '.beelite');
    const src = new FakeSource();
    const m = makeManager(src);
    src.set('1', F, { name: 'M1', fileId: '1', zip: makeZip(addonEntries('M1')) });
    await m.install(root, F, '1');
    await addUnmanaged(root, 'Loose');

    // 测试直接写一份合法、距上限只差 64 字节的清单：一条带超长标签的回收项
    const bigId = 'mabc123-0a1b2c';
    await mkdir(path.join(meta, 'trash', bigId, 'Old'), { recursive: true });
    const manifest = await m.readManifestFor(root);
    const entry = { id: bigId, kind: 'uninstall' as const, createdAt: 1, label: '', folders: ['Old'], project: null };
    const shell = Buffer.byteLength(JSON.stringify({ ...manifest, recovery: [entry] }, null, 1));
    entry.label = 'L'.repeat(MAX_METADATA_BYTES - 64 - shell);
    const text = JSON.stringify({ ...manifest, recovery: [entry] }, null, 1);
    assert.equal(Buffer.byteLength(text), MAX_METADATA_BYTES - 64);
    await writeFile(path.join(meta, 'manifest.json'), text);

    const before = await state(root);
    await assert.rejects(m.uninstallFolder(root, 'Loose'), tooLarge);
    assert.deepEqual(await state(root), before, '卸载目录被拒绝：没有改动，空的回收目录已清理');

    await assert.rejects(m.uninstallProject(root, '1'), tooLarge);
    const local = await m.localState({ flavorId: F, root, addonsPath: null }, F);
    assert.deepEqual(local.dir, { status: 'ok', message: null });
    assert.deepEqual(await state(root), before, '卸载插件被拒绝：没有改动，留下的空回收目录在下一次读取状态时清理');

    assert.equal((await m.purge(root, bigId)).ok, true);
    const after = await m.readManifestFor(root);
    assert.deepEqual(after.recovery, []);
    assert.ok((await readFile(path.join(meta, 'manifest.json'))).length < 4096, '清单变小');
    assert.equal(await exists(path.join(meta, 'trash', bigId)), false);
    assert.equal((await m.uninstallFolder(root, 'Loose')).ok, true, '腾出空间后照常卸载');
  } finally {
    await cleanup(base);
  }
});
