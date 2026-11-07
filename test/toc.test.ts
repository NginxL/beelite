import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToc, selectToc } from '../src/core/toc';
import { FLAVORS } from '../src/core/flavors';

const forever = FLAVORS.find((f) => f.id === 9)!.tocSuffixes;
const retail = FLAVORS.find((f) => f.id === 2)!.tocSuffixes;

test('按 flavor 选择 TOC：无限优先 _Forever，其次 _Camelot，最后通用', () => {
  const files = ['Questie.toc', 'Questie_Camelot.toc', 'Questie_Forever.toc', 'Questie_Mainline.toc', 'Questie.lua'];
  assert.equal(selectToc('Questie', files, forever), 'Questie_Forever.toc');
  assert.equal(selectToc('Questie', ['Questie.toc', 'questie-camelot.toc'], forever), 'questie-camelot.toc');
  assert.equal(selectToc('Questie', files, retail), 'Questie_Mainline.toc');
  assert.equal(selectToc('Questie', ['Questie.toc'], forever), 'Questie.toc');
  assert.equal(selectToc('Questie', ['Other.toc'], forever), null);
});

test('解析 TOC：BOM、颜色码、zhCN 标题、逗号分隔的 Interface', () => {
  const info = parseToc('﻿## Interface: 16001, 11509\n## Title: |cff00ff00Questie|r\n## Title-zhCN: 任务助手\n## Version: 12.6.3\n## Notes: Quest helper\n', 'Questie.toc');
  assert.equal(info.title, '任务助手');
  assert.equal(info.version, '12.6.3');
  assert.deepEqual(info.interfaces, [16001, 11509]);
  assert.equal(parseToc('## Title: |cffff0000Red|r Addon\n', 'x.toc').title, 'Red Addon');
});
