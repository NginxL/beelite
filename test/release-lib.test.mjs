import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSigningKey, parseSignOutput, productionDownloadUrl, resolveDownloadUrl, threePart } from '../scripts/release-lib.mjs';

const KEY = '1QVzcH29FNZEGtdtqFiWCYM5a51IpLd6CsanZIcXXTI=';
const OTHER = 'AAAAcH29FNZEGtdtqFiWCYM5a51IpLd6CsanZIcXXTI=';

test('签名账户公钥与包内公钥一致时通过', () => {
  assert.equal(checkSigningKey(() => `${KEY}\n`, KEY, 'app.beelite.addons'), KEY);
});

test('签名账户公钥与包内公钥不一致时拒绝（避免发布客户端会拒绝的更新）', () => {
  assert.throws(() => checkSigningKey(() => OTHER, KEY, 'app.beelite.addons'), /不一致/);
});

test('签名账户不存在或无法读取、或返回内容不是公钥时拒绝', () => {
  assert.throws(
    () =>
      checkSigningKey(() => {
        throw new Error('generate_keys 失败');
      }, KEY, 'missing'),
    /无法读取签名账户 missing 的公钥/,
  );
  assert.throws(() => checkSigningKey(() => 'not a key', KEY, 'x'), /格式不正确/);
});

test('生产下载地址固定为本仓库对应版本的 Release 资产，拒绝任何不同的覆盖值', () => {
  const zipName = 'BeeLite-0.1.1-arm64-mac.zip';
  const expected = 'https://github.com/NginxL/beelite/releases/download/v0.1.1/BeeLite-0.1.1-arm64-mac.zip';
  assert.equal(productionDownloadUrl('0.1.1', zipName), expected);
  assert.equal(resolveDownloadUrl({ mode: 'production', override: undefined, version: '0.1.1', zipName }), expected);
  assert.equal(resolveDownloadUrl({ mode: 'production', override: expected, version: '0.1.1', zipName }), expected);
  for (const bad of [
    'http://127.0.0.1:47831/BeeLite-0.1.1-arm64-mac.zip',
    'https://github.com/someone/beelite/releases/download/v0.1.1/BeeLite-0.1.1-arm64-mac.zip',
    'https://github.com/NginxL/beelite/releases/download/v0.1.0/BeeLite-0.1.1-arm64-mac.zip',
    'https://github.com/NginxL/beelite/releases/latest/download/BeeLite-0.1.1-arm64-mac.zip',
  ]) {
    assert.throws(() => resolveDownloadUrl({ mode: 'production', override: bad, version: '0.1.1', zipName }), /生产发布的下载地址必须是/, bad);
  }
});

test('e2e 模式必须显式提供 http(s) 下载地址', () => {
  const url = 'http://127.0.0.1:47831/BeeLite-E2E-0.9.2-arm64-mac.zip';
  assert.equal(resolveDownloadUrl({ mode: 'e2e', override: url, version: '0.9.2', zipName: 'x.zip' }), url);
  assert.throws(() => resolveDownloadUrl({ mode: 'e2e', override: undefined, version: '0.9.2', zipName: 'x.zip' }), /显式提供/);
  assert.throws(() => resolveDownloadUrl({ mode: 'e2e', override: 'file:///tmp/x.zip', version: '0.9.2', zipName: 'x.zip' }), /不支持/);
});

test('解析 sign_update 输出与最低系统版本格式', () => {
  assert.deepEqual(parseSignOutput('sparkle:edSignature="abc+/=" length="123"'), { signature: 'abc+/=', length: 123 });
  assert.throws(() => parseSignOutput('error'), /无法解析/);
  assert.equal(threePart('13.0'), '13.0.0');
  assert.equal(threePart('13.0.1'), '13.0.1');
});

test('入口判断在路径含空格时仍然正确（脚本被直接运行时执行，被导入时不执行）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'beelite release lib '));
  try {
    const lib = pathToFileURL(fileURLToPath(new URL('../scripts/release-lib.mjs', import.meta.url))).href;
    const sub = path.join(dir, 'with space');
    await mkdir(sub);
    const script = path.join(sub, 'entry.mjs');
    await writeFile(script, `import { isMain } from ${JSON.stringify(lib)};\nexport const ran = isMain(import.meta.url);\nif (ran) console.log('MAIN');\n`);
    const direct = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /MAIN/);
    const importer = path.join(sub, 'importer.mjs');
    await writeFile(importer, `import { ran } from ${JSON.stringify(pathToFileURL(script).href)};\nconsole.log(ran ? 'RAN' : 'NOT');\n`);
    const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
    assert.equal(imported.stdout.trim(), 'NOT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
