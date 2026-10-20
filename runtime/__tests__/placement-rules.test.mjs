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
  assert.deepEqual(input.components[0], { ref: 'U1', x: 10, y: 10, widthMm: 5, heightMm: 5, rotationDeg: 0 });
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
  assert.ok(audit.evidenceGapFailures >= 1, '缺 courtyard/3D 等证据应记成证据缺口');
  assert.equal(audit.releaseReady, false, '证据不足时规则引擎不能宣称 releaseReady');
  assert.ok(audit.review > 0);
});
