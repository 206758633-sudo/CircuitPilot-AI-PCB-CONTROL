/**
 * 真机契约样本测试：直接使用曾在嘉立创EDA 3.2.186 真机上取到的返回形状，
 * 锁住"EDA 原始形态 → CircuitPilot 归一化"这条缝——过去正是这里反复踩坑
 * （46 个理论层被当可用层、矩形焊盘旋转角被当尺寸、ERC 聚合计数被当逐条结论）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectRoutableLayers } from '../engineering/route-layers.mjs';
import { padClearanceRadiusMil } from '../pad-geometry.mjs';
import { COMMANDS } from '../bridge.mjs';
import { normalizeErcReport } from '../erc.mjs';
import { mergeErcDetail } from '../eda-erc-detail.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/eda-real/${name}`, import.meta.url), 'utf8'));

test('真机契约（2026-10-20 取证）：pcb.layers.read 返回 260 条层记录，只有 SIGNAL+启用 的 1/2/15/16 可布线', () => {
  const { layers } = fixture('layers-readback.json');
  assert.equal(layers.length, 260);
  const picked = selectRoutableLayers({ layers });
  assert.ok(picked, '必须能选出可布线层');
  assert.deepEqual(picked.layers, [1, 2, 15, 16]);
  assert.equal(picked.innerLayer, 15, '内层必须取真实启用的 15，不是默认的 17');
  const oldAcceptance = selectRoutableLayers(layers.filter((item) => [1, 2, 17, 18].includes(item.id)));
  assert.deepEqual(oldAcceptance.layers, [1, 2], '旧默认 17/18 在 4 层板上不启用，必须被过滤掉（不能拿不存在层布线）');
  assert.equal(oldAcceptance.innerLayer, null, '没有启用内层时不得凭空给一个内层号');
});

test('真机契约：桥层 pcb.layers.read 已归一化 enabled/enabledCopperIds/configuredCount', async () => {
  const { layers } = fixture('layers-readback.json');
  const fakeEda = {
    pcb_Layer: {
      getAllLayers: async () => layers,
      getTheNumberOfCopperLayers: async () => 4,
    },
  };
  const code = COMMANDS['pcb.layers.read'].code;
  // eslint-disable-next-line no-new-func
  const run = new Function('eda', `return (async()=>{${code}})();`);
  const result = await run(fakeEda);
  assert.equal(result.layers.length, 260);
  assert.equal(result.configuredCount, 4);
  assert.deepEqual(result.enabledCopperIds, [1, 2, 15, 16]);
  assert.equal(result.layers.find((item) => item.id === 17).enabled, false);
  assert.equal(result.layers.find((item) => item.id === 15).enabled, true);
});

test('真机契约：矩形焊盘 shape 第三位是旋转角，取内切半径而不是"0 尺寸/长边"', () => {
  // 真机样本：U5/ES7210 0.4mm 间距矩形焊盘（第 58 轮真机读回，单位 mil）
  assert.equal(padClearanceRadiusMil([23.622, 7.874, 0]), 3.937);
  assert.equal(padClearanceRadiusMil([40, 40, 0]), 20);
  // 混合列表里 0 是旋转角，不能被当成 0 尺寸导致半径 0
  assert.equal(padClearanceRadiusMil([0, 40, 40]), 20);
  // 没有正数尺寸时退回默认半径，而不是 0（0 半径 = 间距检查永远通过）
  assert.equal(padClearanceRadiusMil([0, 0, 0]), 5);
});

test('真机契约：schematic.drc 只给聚合计数（1 error + 34 warning）；明细不足时保留聚合余量', () => {
  // 真机 EDA 扩展 API 返回形状（逐条明细只在 UI 面板里）
  const normalized = normalizeErcReport([{ type: 'error', count: 1 }, { type: 'warning', count: 34 }]);
  assert.equal(normalized.aggregateOnly, true);
  assert.deepEqual(normalized.counts, { fatal: 0, error: 1, warning: 34, info: 0, total: 35 });
  assert.equal(normalized.findings.every((item) => item.aggregate === true), true);
  // 面板只抓到 1 条错误 + 5 条警告：错误覆盖完整（1≥1）被替换，警告只覆盖 5<34 必须保留聚合余量
  const detail = {
    ok: true,
    source: 'ui-dom',
    items: [
      { level: 'error', message: 'ERC 错误：电源网络短路', object: 'VCC' },
      ...Array.from({ length: 5 }, (_, index) => ({ level: 'warning', message: `警告 ${index}`, object: `N${index}` })),
    ],
  };
  const merged = mergeErcDetail(normalized, detail);
  assert.ok(merged);
  assert.equal(merged.aggregateOnly, false);
  const errorFindings = merged.findings.filter((item) => item.severity === 'error');
  assert.equal(errorFindings.length, 1);
  assert.equal(errorFindings[0].aggregate, false);
  const warningDetail = merged.findings.filter((item) => item.severity === 'warning' && item.aggregate === false);
  assert.equal(warningDetail.length, 5);
  assert.equal(merged.detailCounts.partial.warning.detailed, 5, '34 条警告里只覆盖 5 条，余量必须如实保留');
  assert.equal(merged.detailCounts.partial.warning.expected, 34);
  assert.ok(merged.findings.some((item) => item.aggregate && item.severity === 'warning'), '未覆盖的 29 条必须保留为聚合条目');
});
