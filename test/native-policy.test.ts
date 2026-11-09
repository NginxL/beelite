import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { cleanup, tmpDir } from './helpers';

// 编译并运行原生回复策略测试（与 beelite_sparkle.mm 共用 native/src/bl_policy.h）
const SRC = path.join(__dirname, '..', '..', 'native', 'test', 'policy_test.c');
const hasCc = process.platform === 'darwin' && spawnSync('/usr/bin/xcrun', ['--find', 'clang'], { encoding: 'utf8' }).status === 0;

test('原生回复策略：Installing 阶段持有回复、未授权与只检查不下载不安装、解压中无法取消、只检查的取消与会话编号',{ skip: hasCc ? false : '需要 macOS 与 Xcode 命令行工具' }, async () => {
  const dir = await tmpDir();
  try {
    const bin = path.join(dir, 'policy_test');
    const cc = spawnSync('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Werror', SRC, '-o', bin], { encoding: 'utf8' });
    assert.equal(cc.status, 0, cc.stderr);
    const r = spawnSync(bin, [], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /failures: 0/);
  } finally {
    await cleanup(dir);
  }
});
