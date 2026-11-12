// 0.2.2：账号与角色列表的提示与备份实际结果一致（只用临时目录与真实的文件夹、符号链接、硬链接）。
// - 角色识别不满足（识别文件是文件夹）只是不能按角色选择，不断言整账号与全部 WTF 会停止；它们照常成功；
// - 识别文件是链接：整账号与全部 WTF 确实停止，提示如实说明（安全检查不放宽）；
// - WTF/Account 是普通文件：单一硬链接时可改用全部 WTF 且确实成功；多个硬链接时不推荐全部 WTF，全部 WTF 确实停止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../src/core/errors';
import { WtfBackupService } from '../src/core/wtf-backup';

async function setup() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'azercube-catalog-edge-')));
  const root = path.join(base, 'games', '_classic_');
  const wtf = path.join(root, 'WTF');
  const appData = path.join(base, 'appData');
  const picked = path.join(base, 'Desktop');
  for (const d of [wtf, appData, picked]) await mkdir(d, { recursive: true });
  await writeFile(path.join(wtf, 'Config.wtf'), 'SET a "1"\n');
  const svc = new WtfBackupService({
    settingsFile: path.join(appData, 'wtf-backup.json'),
    appDataDir: appData,
    appVersion: '0.2.2-test',
    resolveRoot: async () => root,
    listBoundRoots: async () => [root],
  });
  await svc.configure(9, root, picked);
  const done = async () => {
    await svc.shutdown();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, wtf, svc, done };
}

/** Account/A/Realm 下的普通角色 Bob 与待测角色 Hero */
async function characters(wtf: string): Promise<string> {
  const realm = path.join(wtf, 'Account', 'A', 'Realm');
  await mkdir(path.join(realm, 'Bob'), { recursive: true });
  await writeFile(path.join(realm, 'Bob', 'AddOns.txt'), 'x\n');
  await mkdir(path.join(realm, 'Hero'), { recursive: true });
  await writeFile(path.join(realm, 'Hero', 'config-cache.wtf'), 'x\n');
  return realm;
}

test('识别文件是文件夹：角色未被识别，提示只说明不能按角色选择、不断言整账号与全部 WTF 停止；二者实际都成功', async () => {
  const f = await setup();
  try {
    const realm = await characters(f.wtf);
    // 唯一匹配到的识别名称 AddOns.txt 是普通文件夹（里面是普通文件）
    await rm(path.join(realm, 'Hero', 'config-cache.wtf'));
    await mkdir(path.join(realm, 'Hero', 'AddOns.txt'));
    await writeFile(path.join(realm, 'Hero', 'AddOns.txt', 'inner.txt'), 'x\n');
    const cat = await f.svc.catalog(9, f.root);
    assert.deepEqual(cat.accounts[0].realms, [{ realm: 'Realm', characters: ['Bob'] }]);
    const w = cat.warnings.filter((x) => x.includes('"Hero"'));
    assert.equal(w.length, 1, cat.warnings.join('\n'));
    assert.match(w[0], /^未识别为角色：Account\/"A"\/"Realm"\/"Hero"（识别文件不是普通文件，例如是文件夹），不能按角色选择它；整账号与全部 WTF 备份时按实际内容检查$/);
    assert.doesNotMatch(w[0], /停止/);
    assert.equal((await f.svc.run(9, f.root, { kind: 'account', account: 'A' })).snapshot.status, 'structure-ok');
    assert.equal((await f.svc.run(9, f.root, { kind: 'all' })).snapshot.status, 'structure-ok');
  } finally {
    await f.done();
  }
});

test('识别文件是符号链接：提示整账号与全部 WTF 会停止，二者实际都停止；按角色备份其他角色成功', async () => {
  const f = await setup();
  try {
    const realm = await characters(f.wtf);
    const outside = path.join(f.base, 'outside.txt');
    await writeFile(outside, 'x\n');
    await rm(path.join(realm, 'Hero', 'config-cache.wtf'));
    await symlink(outside, path.join(realm, 'Hero', 'AddOns.txt'));
    const cat = await f.svc.catalog(9, f.root);
    const w = cat.warnings.filter((x) => x.includes('"Hero"'));
    assert.equal(w.length, 1, cat.warnings.join('\n'));
    assert.match(w[0], /^已跳过识别文件不受支持（链接、多硬链接、特殊文件或位于其他磁盘卷）的角色目录：.*"Hero"。按角色备份这个账号的其他角色不受影响；整账号备份与全部 WTF 备份会因此停止$/);
    assert.equal((await f.svc.run(9, f.root, { kind: 'characters', account: 'A', characters: [{ realm: 'Realm', character: 'Bob' }] })).snapshot.status, 'structure-ok');
    await assert.rejects(f.svc.run(9, f.root, { kind: 'account', account: 'A' }), /符号链接/);
    await assert.rejects(f.svc.run(9, f.root, { kind: 'all' }), /符号链接/);
  } finally {
    await f.done();
  }
});

test('WTF/Account 是普通文件：单一硬链接时建议全部 WTF 且确实成功；多个硬链接时不建议全部 WTF，全部 WTF 确实停止', async () => {
  const f = await setup();
  try {
    const account = path.join(f.wtf, 'Account');
    await writeFile(account, 'not a folder\n');
    await assert.rejects(f.svc.catalog(9, f.root), (err: unknown) => err instanceof UserError && err.code === 'backup-catalog' && err.message === 'WTF/Account 不是文件夹，没有可列出的账号；可改用全部 WTF 备份');
    assert.equal((await f.svc.run(9, f.root, { kind: 'all' })).snapshot.status, 'structure-ok');

    await link(account, path.join(f.wtf, '..', 'account-hardlink'));
    await assert.rejects(f.svc.catalog(9, f.root), (err: unknown) => {
      const m = (err as Error).message;
      return err instanceof UserError && err.code === 'backup-catalog' && m === 'WTF/Account 有多个硬链接，无法列出账号；全部 WTF 备份也会因此停止，请先在访达中检查' && !/可改用/.test(m);
    });
    await assert.rejects(f.svc.run(9, f.root, { kind: 'all' }), /有多个硬链接/);
  } finally {
    await f.done();
  }
});
