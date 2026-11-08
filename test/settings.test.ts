// 设置文件保护回归（0.1.2）：只有文件不存在才视为首次运行；读取失败或内容不合法时明确报错，
// bind / unbind / save 都不会覆盖原文件，修复文件后可直接重试。所有文件都在临时目录中。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MutationGate } from '../src/core/gate';
import { SettingsStore } from '../src/core/profiles';
import { recoverBoundRoots } from '../src/core/startup';
import { cleanup, FakeSource, makeGameRoot, tmpDir } from './helpers';
import { createHarness } from './ipc-harness';

const SETTINGS_ERR = /无法读取蜂简设置文件.*请修复该文件或恢复备份后点击重试/s;

async function setup() {
  const base = await realpath(await tmpDir());
  return { base, file: path.join(base, 'settings.json') };
}

/** 所有写入路径都必须被拒绝，并且文件逐字节不变 */
async function assertNoWrite(store: SettingsStore, file: string, root: string): Promise<void> {
  const before = await readFile(file);
  await assert.rejects(store.load(), SETTINGS_ERR);
  await assert.rejects(store.profile(9), SETTINGS_ERR);
  await assert.rejects(store.bind(9, root), SETTINGS_ERR);
  await assert.rejects(store.bind(2, null), SETTINGS_ERR);
  await assert.rejects(store.save({ schema: 1, bindings: { 9: root }, lastFlavorId: null }), SETTINGS_ERR);
  assert.deepEqual(await readFile(file), before);
}

test('设置：文件不存在视为首次运行，绑定后创建文件', async () => {
  const { base, file } = await setup();
  try {
    const s = new SettingsStore(file);
    assert.deepEqual((await s.load()).bindings, {});
    const root = await makeGameRoot(base);
    await s.bind(9, root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bindings, { 9: root });
  } finally {
    await cleanup(base);
  }
});

test('设置：0.1.0/0.1.1 写出的 schema 1 文件可直接使用；未知顶层字段在保存时原样保留', async () => {
  const { base, file } = await setup();
  try {
    const old = { schema: 1, bindings: { 2: '/Applications/World of Warcraft/_retail_' }, lastFlavorId: null, future: { keep: [1, 2] } };
    await writeFile(file, JSON.stringify(old, null, 1));
    const s = new SettingsStore(file);
    assert.equal((await s.profile(2)).root, '/Applications/World of Warcraft/_retail_');
    const root = await makeGameRoot(base);
    await s.bind(9, root);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(after.bindings, { 2: old.bindings[2], 9: root });
    assert.deepEqual(after.future, old.future);
    assert.equal(after.schema, 1);
    // 不带 lastFlavorId 的文件同样兼容
    await writeFile(file, JSON.stringify({ schema: 1, bindings: {} }));
    assert.equal((await s.load()).lastFlavorId, null);
  } finally {
    await cleanup(base);
  }
});

test('设置：内容损坏或结构不合法时报错，bind/unbind/save 都不覆盖原文件；修复后可重试', async () => {
  const { base, file } = await setup();
  try {
    const root = await makeGameRoot(base);
    const s = new SettingsStore(file);
    const bad = [
      '{"schema":1,"bindings":{"2":"/x/_retail_"',
      '',
      '[]',
      'null',
      '{"schema":2,"bindings":{}}',
      '{"bindings":{"2":"/x/_retail_"}}',
      '{"schema":1,"bindings":[]}',
      '{"schema":1,"bindings":{"2":"relative/_retail_"}}',
      '{"schema":1,"bindings":{"retail":"/x/_retail_"}}',
      '{"schema":1,"bindings":{"2":5}}',
      '{"schema":1,"bindings":{},"lastFlavorId":"9"}',
    ];
    for (const text of bad) {
      await writeFile(file, text);
      await assertNoWrite(s, file, root);
    }
    // 修复后重试成功，原有绑定仍在
    await writeFile(file, JSON.stringify({ schema: 1, bindings: { 2: '/x/_retail_' }, lastFlavorId: null }));
    await s.bind(9, root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bindings, { 2: '/x/_retail_', 9: root });
  } finally {
    await cleanup(base);
  }
});

test('设置：曾经读取成功之后文件被损坏，写入前的复核仍会拒绝覆盖（不依赖缓存）', async () => {
  const { base, file } = await setup();
  try {
    const root = await makeGameRoot(base);
    const s = new SettingsStore(file);
    await writeFile(file, JSON.stringify({ schema: 1, bindings: { 2: '/x/_retail_' }, lastFlavorId: null }));
    assert.equal((await s.profile(2)).root, '/x/_retail_');
    await writeFile(file, '{"schema":1,"bindings":');
    await assertNoWrite(s, file, root);
  } finally {
    await cleanup(base);
  }
});

test('设置：路径是目录（EISDIR）时读取失败，不创建、不删除、不改名任何东西', async () => {
  const { base, file } = await setup();
  try {
    const root = await makeGameRoot(base);
    await mkdir(file);
    await writeFile(path.join(file, 'keep.txt'), 'x');
    const s = new SettingsStore(file);
    await assert.rejects(s.load(), /EISDIR/);
    await assert.rejects(s.bind(9, root), SETTINGS_ERR);
    await assert.rejects(s.bind(9, null), SETTINGS_ERR);
    await assert.rejects(s.save({ schema: 1, bindings: {}, lastFlavorId: null }), SETTINGS_ERR);
    assert.deepEqual(await readdir(file), ['keep.txt']);
    assert.deepEqual((await readdir(base)).sort(), ['_forever_', 'settings.json']);
  } finally {
    await cleanup(base);
  }
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test('设置：没有读权限（EACCES）时报错且不覆盖；恢复权限后可重试', { skip: isRoot ? 'root 用户不受文件权限限制' : false }, async () => {
  const { base, file } = await setup();
  try {
    const root = await makeGameRoot(base);
    const original = JSON.stringify({ schema: 1, bindings: { 2: '/x/_retail_' }, lastFlavorId: null });
    await writeFile(file, original);
    await chmod(file, 0o000);
    const s = new SettingsStore(file);
    await assert.rejects(s.load(), /EACCES/);
    await assert.rejects(s.bind(9, root), SETTINGS_ERR);
    await assert.rejects(s.bind(2, null), SETTINGS_ERR);
    await assert.rejects(s.save({ schema: 1, bindings: {}, lastFlavorId: null }), SETTINGS_ERR);
    await chmod(file, 0o644);
    assert.equal(await readFile(file, 'utf8'), original);
    await s.bind(9, root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bindings, { 2: '/x/_retail_', 9: root });
  } finally {
    await chmod(file, 0o644).catch(() => undefined);
    await cleanup(base);
  }
});

test('设置：解绑时当前绑定与期望不同则拒绝，文件不变', async () => {
  const { base, file } = await setup();
  try {
    const s = new SettingsStore(file);
    await s.bind(9, '/x/a');
    const before = await readFile(file);
    await assert.rejects(s.bind(9, null, '/x/b'), /绑定已变更/);
    await assert.rejects(s.bind(2, null, '/x/a'), /绑定已变更/);
    assert.deepEqual(await readFile(file), before);
    await s.bind(9, null, '/x/a');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bindings, {});
  } finally {
    await cleanup(base);
  }
});

test('设置：IPC 层读取本地状态时报错且可重试；选择目录前即拒绝；解绑不改动文件', async () => {
  const { base, file } = await setup();
  try {
    const root = await makeGameRoot(base);
    await writeFile(file, '{"schema":1,"bindings":{"9":');
    const before = await readFile(file);
    const h = createHarness({ settingsFile: file, source: new FakeSource() });
    h.stub.pick = root;
    await assert.rejects(h.api.localState(9), SETTINGS_ERR);
    await assert.rejects(h.api.bindProfile(9), SETTINGS_ERR);
    assert.equal(h.stub.openDialogs, 0, '设置无法读取时不弹出目录选择');
    await assert.rejects(h.api.unbindProfile(9, root), SETTINGS_ERR);
    await assert.rejects(h.api.uninstallProject('100', 9, root), SETTINGS_ERR);
    assert.deepEqual(await readFile(file), before);
    assert.equal(h.gate.activeCount, 0);
    // 用户修复文件后点击重试
    await writeFile(file, JSON.stringify({ schema: 1, bindings: { 9: root }, lastFlavorId: null }));
    const st = await h.api.localState(9);
    assert.equal(st.profile.root, root);
  } finally {
    await cleanup(base);
  }
});

test('启动恢复：设置无法读取时跳过恢复但不抛出，闸门已释放且未冻结，原文件不变', async () => {
  const { base, file } = await setup();
  try {
    await writeFile(file, 'not json');
    const before = await readFile(file);
    const gate = new MutationGate();
    const recovered: string[] = [];
    const warns: unknown[][] = [];
    const r = await recoverBoundRoots({ gate, settings: new SettingsStore(file), recover: async (root) => void recovered.push(root), warn: (...a) => void warns.push(a) });
    assert.match(r.settingsError ?? '', SETTINGS_ERR);
    assert.deepEqual(recovered, []);
    assert.equal(gate.activeCount, 0);
    assert.equal(gate.frozen, false);
    assert.equal(warns.length, 1);
    assert.deepEqual(await readFile(file), before);
    // 之后的写操作照常可以进入闸门（客户端更新的排空也不会卡住）
    gate.enter()();
    await gate.drained();
  } finally {
    await cleanup(base);
  }
});

test('启动恢复：设置正常时按去重后的绑定目录恢复；准备步骤或单个目录恢复失败都不影响启动', async () => {
  const { base, file } = await setup();
  try {
    await writeFile(file, JSON.stringify({ schema: 1, bindings: { 9: '/x/a', 2: '/x/b', 3: '/x/a' }, lastFlavorId: null }));
    const gate = new MutationGate();
    const recovered: string[] = [];
    let activeDuring = -1;
    const r = await recoverBoundRoots({
      gate,
      settings: new SettingsStore(file),
      prepare: async () => {
        throw new Error('测试绑定失败');
      },
      recover: async (root) => {
        activeDuring = gate.activeCount;
        recovered.push(root);
        if (root === '/x/b') throw new Error('恢复失败');
      },
    });
    assert.equal(r.settingsError, null);
    assert.deepEqual(recovered.sort(), ['/x/a', '/x/b']);
    assert.equal(activeDuring, 1, '恢复期间计入写操作');
    assert.equal(gate.activeCount, 0);
  } finally {
    await cleanup(base);
  }
});
