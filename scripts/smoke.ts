// 实网 smoke：真实搜索 / 详情 / 下载免费插件（RegionIcons、Questie、Plater）→ 临时模拟游戏目录中安装 → 扫描 → 重装 → 卸载 → 恢复。
// 只在 SMOKE_PARENT（默认 <项目>/.smoke）下新建本次专用子目录 beelite-smoke-XXXXXX，绝不接触真实游戏目录；
// 结束后只删除这个新建的子目录（SMOKE_KEEP=1 时保留）。
// 运行：npm run smoke
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { AddonManager } from '../src/core/manager';
import { NewBeeBoxProvider } from '../src/core/provider';
import { cleanupRunDir, createRunDir } from './smoke-dir';

const FOREVER = 9;
const RETAIL = 2;
const SMALL = '31927'; // Open Maps: Region Icons，约 216 KB
const QUESTIE = '20'; // Questie，约 2.2 MB，包内含反斜杠路径与重复条目
const PLATER = '26'; // Plater，约 5.6 MB，包内透明 TGA 压缩比超过 1000（0.1.0 曾误判）
const PLATER_TGA = ['Plater', 'images', 'transparent.tga'];

const projectRoot = path.join(__dirname, '..', '..');
const smokeParent = path.resolve(process.env.SMOKE_PARENT ?? path.join(projectRoot, '.smoke'));
let smokeDir = '';

function step(msg: string) {
  console.log(`\n▶ ${msg}`);
}

async function main() {
  if (smokeParent.startsWith('/Applications')) throw new Error('SMOKE_PARENT 不能位于 /Applications');
  smokeDir = await createRunDir(smokeParent);
  const root = path.join(smokeDir, '_forever_');
  const addons = path.join(root, 'Interface', 'AddOns');
  const wtfFile = path.join(root, 'WTF', 'Account', 'SMOKE', 'SavedVariables', 'Questie.lua');
  console.log(`临时游戏根：${root}`);
  await mkdir(addons, { recursive: true });
  await mkdir(path.dirname(wtfFile), { recursive: true });
  await writeFile(wtfFile, 'QuestieConfig = { smoke = true }\n');
  await mkdir(path.join(addons, 'ManualAddon'));
  await writeFile(path.join(addons, 'ManualAddon', 'ManualAddon.toc'), '## Title: 手动安装的插件\n## Interface: 16001\n');

  const provider = new NewBeeBoxProvider();
  const manager = new AddonManager({ source: provider, confirm: async (r) => (console.log(`  [自动确认] ${r.message}`), true) });

  step('远端配置');
  const cfg = await provider.getConfig(true);
  const forever = cfg.flavors.find((f) => f.id === FOREVER);
  assert.ok(forever && forever.versions.includes('1.60.1'), '配置中应有无限 1.60.1');
  console.log(`  flavor 数 ${cfg.flavors.length}，分类数 ${cfg.categories.length}，无限版本 ${forever.versions.join(',')}`);

  step('搜索（无限 / 正式服 / 分类 / 排序 / 分页）');
  const s1 = await provider.search({ flavorId: FOREVER, category: 0, order: 'ranking', keyword: 'openmap', offset: 0 });
  assert.ok(s1.items.some((i) => i.id === '31505'), '无限搜索 openmap 应包含 31505');
  console.log(`  无限 openmap：${s1.total} 条，前 3：${s1.items.slice(0, 3).map((i) => `${i.id} ${i.name}`).join(' | ')}`);
  const s2 = await provider.search({ flavorId: RETAIL, category: 0, order: 'total_download', keyword: '', offset: 0 });
  console.log(`  正式服 下载量排序：${s2.total} 条，第一：${s2.items[0]?.name}`);
  const p1 = await provider.search({ flavorId: FOREVER, category: 1011, order: 'update', keyword: '', offset: 0 });
  const p2 = await provider.search({ flavorId: FOREVER, category: 1011, order: 'update', keyword: '', offset: p1.nextOffset });
  assert.ok(p2.items.length > 0 && p2.items[0].id !== p1.items[0].id, '第二页应返回不同结果');
  console.log(`  地图分类：共 ${p1.total} 条，第 1 页 ${p1.items.length} 条，第 2 页首条 ${p2.items[0].name}`);

  step('详情与最新文件');
  const d = await provider.detail(SMALL, FOREVER);
  assert.equal(d.accessible, true);
  const lf = await provider.latest(SMALL, FOREVER);
  assert.equal(lf.compatible, true);
  console.log(`  ${d.name}：文件 ${lf.fileId} ${lf.displayName}，${lf.size} 字节，目录 ${lf.folders.join(',')}`);
  await assert.rejects(provider.latest('31505', RETAIL), /服务器提示/);
  console.log('  31505 在正式服无文件：服务端拒绝，未回退 ✓');

  step('首次接入扫描（不应创建 .beelite）');
  const st0 = await manager.localState({ flavorId: FOREVER, root, addonsPath: addons }, FOREVER);
  assert.deepEqual(st0.unmanaged.map((u) => u.name), ['ManualAddon']);
  assert.equal(await readdir(path.join(root, 'Interface')).then((n) => n.includes('.beelite')), false);
  console.log('  未托管：ManualAddon ✓');

  step(`安装 ${SMALL}、${QUESTIE} 与 ${PLATER}（真实下载）`);
  for (const id of [SMALL, QUESTIE, PLATER]) {
    let last = '';
    const r = await manager.install(root, FOREVER, id, {
      onPhase: (ph, rec, tot) => {
        const line = ph === 'downloading' && tot ? `${ph} ${Math.round(((rec ?? 0) / tot) * 100)}%` : ph;
        if (line !== last && (ph !== 'downloading' || /(0|50|100)%$/.test(line))) console.log(`  [${id}] ${line}`);
        last = line;
      },
    });
    assert.ok(r.ok, r.message);
    console.log(`  ${r.message}${r.warnings?.length ? `（提示：${r.warnings.join('；')}）` : ''}`);
  }
  const toc = await readFile(path.join(addons, 'RegionIcons', 'RegionIcons.toc'), 'utf8');
  assert.match(toc, /16001/);
  assert.ok((await readdir(path.join(addons, 'Questie'))).includes('addon_version.txt'), 'Questie 反斜杠条目应正确解压');
  const tga = await readFile(path.join(addons, ...PLATER_TGA));
  const expectedTgaLen = 18 + tga[0] + tga.readUInt16LE(12) * tga.readUInt16LE(14) * (tga[16] / 8);
  assert.equal(tga.length, expectedTgaLen, 'Plater 透明贴图长度应与 TGA 头一致');
  const tgaCrc = (zlib.crc32(tga) >>> 0).toString(16).padStart(8, '0');
  console.log(`  Plater 透明贴图：${tga.length} 字节，CRC32 ${tgaCrc} ✓`);

  step('扫描已安装');
  const st1 = await manager.localState({ flavorId: FOREVER, root, addonsPath: addons }, FOREVER);
  console.log(`  已托管：${st1.managed.map((m) => `${m.name}(${m.version}) [${m.folders.map((f) => f.name).join(',')}]`).join(' | ')}`);
  console.log(`  未托管：${st1.unmanaged.map((u) => u.name).join(',')}`);
  assert.equal(st1.managed.length, 3);
  assert.deepEqual(st1.managed.find((m) => m.modId === PLATER)?.folders.map((f) => f.name), ['Plater']);
  assert.deepEqual(st1.unmanaged.map((u) => u.name), ['ManualAddon']);

  step('检查更新与强制重装');
  const checks = await manager.checkUpdates(root);
  console.log(`  ${checks.map((c) => `${c.modId}: ${c.hasUpdate ? '有更新' : '最新'}${c.error ? ` (${c.error})` : ''}`).join('，')}`);
  const re = await manager.install(root, FOREVER, SMALL, { force: true });
  assert.ok(re.ok);
  console.log(`  ${re.message}`);

  step('卸载 → 回收站 → 恢复');
  await manager.uninstallProject(root, QUESTIE);
  assert.equal((await readdir(addons)).includes('Questie'), false);
  const st2 = await manager.localState({ flavorId: FOREVER, root, addonsPath: addons }, FOREVER);
  const entry = st2.recovery.find((e) => e.modId === QUESTIE && e.kind === 'uninstall')!;
  assert.ok(entry);
  const rr = await manager.restore(root, entry.id);
  console.log(`  ${rr.message}`);
  assert.ok((await readdir(addons)).includes('Questie'));
  await manager.uninstallProject(root, PLATER);
  assert.equal((await readdir(addons)).includes('Plater'), false);
  const stP = await manager.localState({ flavorId: FOREVER, root, addonsPath: addons }, FOREVER);
  const plEntry = stP.recovery.find((e) => e.modId === PLATER && e.kind === 'uninstall')!;
  assert.ok(plEntry);
  console.log(`  ${(await manager.restore(root, plEntry.id)).message}`);
  assert.ok((await readFile(path.join(addons, ...PLATER_TGA))).equals(tga), '恢复后 Plater 贴图字节应不变');
  const st3 = await manager.localState({ flavorId: FOREVER, root, addonsPath: addons }, FOREVER);
  assert.equal(st3.managed.length, 3);

  step('完整性检查');
  assert.equal(await readFile(wtfFile, 'utf8'), 'QuestieConfig = { smoke = true }\n', 'WTF 不应被修改');
  assert.deepEqual(await readdir(path.join(root, 'Interface', '.beelite', 'staging')), []);
  console.log('  WTF 未改动，暂存区已清空 ✓');
  console.log(`\n✅ smoke 通过。临时目录：${smokeDir}`);
}

main()
  .then(async () => {
    if (!process.env.SMOKE_KEEP) await cleanupRunDir(smokeDir, smokeParent);
    else console.log('（SMOKE_KEEP=1，已保留临时目录）');
  })
  .catch((err) => {
    console.error(`\n❌ smoke 失败：${err instanceof Error ? err.stack : err}\n临时目录保留在：${smokeDir}`);
    process.exit(1);
  });
