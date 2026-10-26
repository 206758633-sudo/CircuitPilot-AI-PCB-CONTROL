import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPlacementPlan, buildPlacementAuditInput, outlineBounds } from '../placement-rules.mjs';

const outline = { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }], closed: true };
const readback = {
  components: [
    { primitiveId: 'p1', ref: 'U1', widthMm: 5, heightMm: 5, rotationDeg: 0 },
    { primitiveId: 'p2', ref: 'C1', widthMm: 1, heightMm: 0.5, rotationDeg: 0 },
  ],
};

test('A9：布局计划翻译成规则引擎输入（板框/器件几何来自读回，缺尺寸不编造）', () => {
  assert.deepEqual(outlineBounds(outline), { widthMm: 50, heightMm: 40, minX: 0, minY: 0 });
  assert.equal(outlineBounds({ points: [] }), null);
  const input = buildPlacementAuditInput({ plan: { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 10, yMm: 10 }, { primitiveId: 'unknown', ref: 'X1', xMm: 1, yMm: 1 }] }, readback, outline });
  assert.equal(input.board.widthMm, 50);
  assert.equal(input.board.heightMm, 40);
  assert.equal(input.components.length, 1, '读回没有的器件不能编造几何');
  assert.deepEqual(input.components[0], { ref: 'U1', x: 10, y: 10, widthMm: 5, heightMm: 5, rotationDeg: 0, side: 'top', bboxIncludesPads: false });
});

test('A9：出框布局命中硬门禁 → 审计不通过（阻断写回）', () => {
  const audit = auditPlacementPlan({ plan: { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 1, yMm: 1 }] }, readback, outline });
  assert.equal(audit.ok, false);
  assert.ok(audit.blockingFailures >= 1);
  assert.ok(audit.blocking.some((item) => /MECH-05/.test(String(item.ruleId))), '应命中板边器件硬门禁');
});

test('A9：板内布局不因"证据不足"被误判为违规（REVIEW 不等于 PASS，但也不冒充违规）', () => {
  const audit = auditPlacementPlan({ plan: { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 25, yMm: 20 }] }, readback, outline });
  assert.equal(audit.ok, true);
  assert.equal(audit.blockingFailures, 0);
  assert.equal(audit.releaseReady, false, '证据不足时规则引擎不能宣称 releaseReady');
  assert.ok(audit.review > 0, '缺 courtyard/3D 等证据应保持 REVIEW');
});


test('P0：排版审计输入保留顶层/底层，上下层投影不判 courtyard 叠放', () => {
  const sideReadback = { components: [
    { primitiveId: 'p1', ref: 'U1', widthMm: 10, heightMm: 10, rotationDeg: 0, layerSide: 'bottom' },
    { primitiveId: 'p2', ref: 'U2', widthMm: 10, heightMm: 10, rotationDeg: 0, layerSide: 'top' },
  ] };
  const input = buildPlacementAuditInput({
    plan: { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 20, yMm: 20 }, { primitiveId: 'p2', ref: 'U2', xMm: 20, yMm: 20 }] },
    readback: sideReadback,
    outline,
  });
  assert.deepEqual(input.components.map((item) => item.side), ['bottom', 'top']);
  const audit = auditPlacementPlan({ plan: { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 20, yMm: 20 }, { primitiveId: 'p2', ref: 'U2', xMm: 20, yMm: 20 }] }, readback: sideReadback, outline });
  assert.equal(audit.blockingFailures, 0, JSON.stringify(audit.blocking));
});

test('P1：丝印文字带包围盒 → SILK 规则拿到可量事实（字高/线宽/到板边/到本体）', () => {
  const boardOutline = { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], closed: true };
  const boardReadback = { components: [{ primitiveId: 'p1', designator: 'U1', widthMm: 4, heightMm: 4, bboxMm: { xMm: 4, yMm: 4, centerXMm: 10, centerYMm: 10 }, layerSide: 'top', courtyardMm: 0.25 }] };
  const plan = { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 10, yMm: 10 }] };
  const texts = { count: 1, texts: [{ primitiveId: 't1', layer: 3, text: 'U1', mirror: false, rotationDeg: 0, fontSizeMil: 40, lineWidthMil: 6, boundsMm: { minXMm: 9.5, minYMm: 12.4, maxXMm: 10.5, maxYMm: 13.4 } }] };
  const input = buildPlacementAuditInput({ plan, readback: boardReadback, outline: boardOutline, texts });
  assert.equal(input.silk.textCount, 1);
  assert.equal(input.silk.textHeights[0].toFixed(4), '1.0000');
  assert.equal(input.silk.lineWidthsMm[0].toFixed(4), '0.1524');
  assert.equal(input.silk.designators.length, 1);
  assert.equal(input.silk.designators[0].gapToBodyMm, 0.4);
  assert.equal(input.components[0].explicitCourtyard, true);
  assert.equal(input.silk.items[0].courtyardKnown, true, '显式 courtyard 必须让 SILK-07 拿到可用事实');
  const audit = auditPlacementPlan({ plan, readback: boardReadback, outline: boardOutline, texts });
  assert.doesNotMatch(JSON.stringify(audit.blocking), /SILK-/);
});

test('P1：铜焊盘 → 去耦电容-电源脚最近距离输入；不把电阻/连接器当电源脚', () => {
  const boardOutline = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }], closed: true };
  const readback = { components: [
    { primitiveId: 'p1', designator: 'C1', widthMm: 1, heightMm: 0.5, bboxMm: { xMm: 1, yMm: 0.5, centerXMm: 5, centerYMm: 5 } },
    { primitiveId: 'p2', designator: 'U1', widthMm: 5, heightMm: 5, bboxMm: { xMm: 5, yMm: 5, centerXMm: 8, centerYMm: 8 } },
    { primitiveId: 'p3', designator: 'R1', widthMm: 1, heightMm: 0.5, bboxMm: { xMm: 1, yMm: 0.5, centerXMm: 5.5, centerYMm: 5.5 } },
  ] };
  const plan = { placements: readback.components.map((item) => ({ primitiveId: item.primitiveId, ref: item.designator, xMm: item.bboxMm.centerXMm, yMm: item.bboxMm.centerYMm })) };
  const pads = { components: [
    { designator: 'C1', footprint: { name: 'C0402' } },
    { designator: 'U1', footprint: { name: 'ESOP-8' } },
    { designator: 'R1', footprint: { name: 'R0402' } },
  ] };
  const copper = { pads: [
    { designator: 'C1', net: '+3V3', x: 200, y: 200, radius: 10, layer: 1 },
    { designator: 'R1', net: '+3V3', x: 210, y: 200, radius: 10, layer: 1 },
    { designator: 'U1', net: '+3V3', x: 260, y: 200, radius: 10, layer: 1 },
  ] };
  const input = buildPlacementAuditInput({ plan, readback, outline: boardOutline, pads, copper });
  assert.equal(input.power.decoupling.length, 1);
  assert.equal(input.power.decoupling[0].icRef, 'U1', '不能把同网络电阻 R1 当成去耦目标');
  assert.equal(input.power.decoupling[0].icClass, 'SOIC');
});

test('P1：传入官方 DRC 报告时 GATE-02 拿到带 provenance 的证据（空结果才 PASS）', () => {
  const boardOutline = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }], closed: true };
  const readback = { components: [{ primitiveId: 'p1', designator: 'U1', widthMm: 5, heightMm: 5, bboxMm: { xMm: 5, yMm: 5, centerXMm: 10, centerYMm: 10 } }] };
  const plan = { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 10, yMm: 10 }] };
  const clean = auditPlacementPlan({ plan, readback, outline: boardOutline, drcReport: { items: [] }, drcScope: 'BOARD-A/rev-C' });
  assert.equal(clean.gates['GATE-02'], 'PASS');
  const dirty = auditPlacementPlan({ plan, readback, outline: boardOutline, drcReport: { items: [{ name: 'Clearance' }] }, drcScope: 'BOARD-A/rev-C' });
  assert.equal(dirty.gates['GATE-02'], 'FAIL');
});
