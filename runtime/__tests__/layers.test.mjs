import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDA_COPPER_LAYER_COUNTS, LAYER_IDS, PLAN_COPPER_LAYER_COUNTS, copperLayerIds, countCopperLayers, isCopperLayerId, isEdaCopperLayerCount, isPlanCopperLayerCount,
  layerIdToStackupIndex, layerRole, stackupIndexToLayerId, validateLayerReferences,
} from '../engineering/layers.mjs';
import { normalizePcbPlan } from '../pcb.mjs';

/** 一个能被 validateStackup 接受的四层叠层：铜/介质交替，介质带厚度与介电常数。 */
function fourLayerStackup() {
  return {
    id: 'jlCPCB-4L-1.6mm',
    source: '嘉立创四层板标准叠层（本地保守配置）',
    layers: [
      { name: 'L1', type: 'copper', thicknessUm: 35 },
      { name: 'prepreg-1', type: 'dielectric', thicknessMm: 0.2, er: 4.3 },
      { name: 'L2', type: 'copper', thicknessUm: 35 },
      { name: 'core', type: 'dielectric', thicknessMm: 1.0, er: 4.3 },
      { name: 'L3', type: 'copper', thicknessUm: 35 },
      { name: 'prepreg-2', type: 'dielectric', thicknessMm: 0.2, er: 4.3 },
      { name: 'L4', type: 'copper', thicknessUm: 35 },
    ],
  };
}

const board4 = { widthMm: 60, heightMm: 40, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 };
const board2 = { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
const outline = { type: 'pcb.outline.create', args: { layer: LAYER_IDS.BOARD_OUTLINE, originXMm: 0, originYMm: 0, widthMm: 60, heightMm: 40 } };
const save = { type: 'pcb.save', args: {} };
const drc = { type: 'pcb.drc', args: {} };
const lineOn = (layer) => ({ type: 'pcb.line.create', args: { net: 'USB_DP', layer, startX: 1, startY: 1, endX: 10, endY: 1, lineWidth: 0.2, primitiveLock: false } });

test('内层铜层编号从 15 起，不是从 3 起（官方 EPCB_LayerId）', () => {
  assert.equal(LAYER_IDS.TOP, 1);
  assert.equal(LAYER_IDS.BOTTOM, 2);
  assert.equal(LAYER_IDS.INNER_1, 15);
  assert.equal(LAYER_IDS.LAST_INNER, 44);
  // 3/4/5/6 是丝印与阻焊，这段断言存在的意义就是钉死“它们不是内层铜”。
  assert.equal(layerRole(3), 'top-silkscreen');
  assert.equal(layerRole(4), 'bottom-silkscreen');
  assert.equal(layerRole(5), 'top-solder-mask');
  assert.equal(layerRole(11), 'board-outline');
  assert.equal(layerRole(15), 'inner-copper');
  assert.equal(layerRole(44), 'inner-copper');
});

test('按叠层顺序换算铜层编号：2/4/6/8 层', () => {
  assert.deepEqual(copperLayerIds(2), [1, 2]);
  assert.deepEqual(copperLayerIds(4), [1, 15, 16, 2]);
  assert.deepEqual(copperLayerIds(6), [1, 15, 16, 17, 18, 2]);
  assert.deepEqual(copperLayerIds(8), [1, 15, 16, 17, 18, 19, 20, 2]);
  // 关键：四层板的“第 2 个铜层”是 15，把叠层序号 2 当层号用会落到丝印上。
  assert.equal(stackupIndexToLayerId(4, 1), 15);
  assert.notEqual(stackupIndexToLayerId(4, 1), 2);
  assert.equal(layerIdToStackupIndex(4, 16), 2);
  assert.equal(layerIdToStackupIndex(4, 3), -1);
});

test('执行放行范围已与 EDA 能力对齐（2..32 偶数），但仍是两个独立常量', () => {
  assert.ok(isEdaCopperLayerCount(32));
  assert.ok(isPlanCopperLayerCount(10), '叠层证据模型已覆盖 2..32，10 层应放行');
  assert.ok(isPlanCopperLayerCount(32));
  assert.ok(!isPlanCopperLayerCount(3), '奇数层不是合法铜层数');
  assert.ok(!isPlanCopperLayerCount(34), '超出官方 setTheNumberOfCopperLayers 上限');
  assert.ok(!isEdaCopperLayerCount(0));
  assert.throws(() => copperLayerIds(3), /COPPER_LAYER_COUNT_UNSUPPORTED/);
  // 换算能力覆盖到 32。
  assert.equal(copperLayerIds(10).length, 10);
  assert.equal(copperLayerIds(32).length, 32);
  // 两者语义不同（EDA 能做什么 / 我们放行什么），刻意分开维护；当前值恰好一致。
  assert.deepEqual([...PLAN_COPPER_LAYER_COUNTS], [...EDA_COPPER_LAYER_COUNTS]);
});

test('四层板把叠层序号当 layer 用会被拦下（会静默画到丝印层的缺陷）', () => {
  const violations = validateLayerReferences(board4, [outline, lineOn(3), lineOn(5), save, drc]);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.reason), ['LAYER_IS_NOT_COPPER:top-silkscreen', 'LAYER_IS_NOT_COPPER:top-solder-mask']);
  // 板框层是合法例外，内层铜层合法。
  assert.equal(validateLayerReferences(board4, [outline]).length, 0);
  assert.equal(validateLayerReferences(board4, [lineOn(16)]).length, 0);
});

test('四层计划必须有可验证叠层，且叠层铜层数与 board.layers 一致', () => {
  const ops = [outline, lineOn(15), lineOn(16), save, drc];

  const noStackup = normalizePcbPlan({ board: board4, operations: ops });
  assert.equal(noStackup.ready, false);
  assert.ok(noStackup.missing.some((item) => item.startsWith('stackup:')), `缺少叠层未被拦下: ${noStackup.missing}`);

  const wrongCount = normalizePcbPlan({ board: board4, operations: ops, stackup: { id: 'x', source: 'y', layers: [{ type: 'copper', thicknessUm: 35 }] } });
  assert.equal(wrongCount.ready, false);

  const good = normalizePcbPlan({ board: board4, operations: ops, stackup: fourLayerStackup() });
  assert.equal(good.ready, true, `合法的四层计划应可执行: ${good.missing}`);
  assert.equal(countCopperLayers(fourLayerStackup()), 4);
  assert.equal(good.plan.stackup.id, 'jlCPCB-4L-1.6mm');
  // 叠层进入计划，因此叠层变化会改变计划哈希（批准绑定不可绕过）。
  const other = normalizePcbPlan({ board: board4, operations: ops, stackup: { ...fourLayerStackup(), id: 'changed' } });
  assert.notEqual(good.planHash, other.planHash);
});

test('四层计划里出现非铜层引用时不 ready，并指出确切操作序号', () => {
  const bad = normalizePcbPlan({ board: board4, operations: [outline, lineOn(3), save, drc], stackup: fourLayerStackup() });
  assert.equal(bad.ready, false);
  assert.ok(bad.missing.includes('operation-1:LAYER_IS_NOT_COPPER:top-silkscreen:3'), `未指出确切违规操作: ${bad.missing}`);
});

test('两层板行为不变：仍放行，且叠层不是必需项', () => {
  const result = normalizePcbPlan({ board: board2, operations: [{ type: 'pcb.importChanges', args: {} }, outline, save, drc] });
  assert.equal(result.ready, true, `两层计划不应受影响: ${result.missing}`);
  assert.equal(result.plan.board.layers, 2);
  assert.equal('stackup' in result.plan, false, '两层计划不应被强加 stackup 字段（否则会改变既有计划哈希）');
  assert.deepEqual(copperLayerIds(2), [1, 2]);
  assert.ok(isCopperLayerId(1, 2) && isCopperLayerId(2, 2));
  assert.ok(!isCopperLayerId(15, 2), '两层板不存在内层铜');
});

test('非法层数继续被拒；合法高层数只因缺叠层证据被拒', () => {
  for (const layers of [3, 5, 34, 0, -2, 3.5, 'four']) {
    const result = normalizePcbPlan({ board: { ...board2, layers }, operations: [outline, save, drc] });
    assert.equal(result.ready, false, `layers=${layers} 不应被放行`);
    assert.ok(result.missing.includes('board-rules'), `layers=${layers} 应报 board-rules: ${result.missing}`);
  }
  // 10 层是合法层数：拒绝的原因必须是“缺叠层证据”，而不是“层数不支持”。
  const ten = normalizePcbPlan({ board: { ...board2, layers: 10 }, operations: [outline, save, drc] });
  assert.equal(ten.ready, false);
  assert.ok(!ten.missing.includes('board-rules'), `10 层不该被当成非法层数: ${ten.missing}`);
  assert.ok(ten.missing.some((item) => item.startsWith('stackup:')), `应因缺叠层被拒: ${ten.missing}`);
});
