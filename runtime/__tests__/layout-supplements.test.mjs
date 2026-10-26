import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateLayoutSupplements, requiredClearanceMm, requiredThermalCopperMm2 } from '../engineering/layout-supplements.mjs';
import { auditPlacementPlan } from '../placement-rules.mjs';

const statusOf = (audit, id) => audit.rules.find((rule) => rule.id === id)?.status;

test('P2 补充规则：无声明全部 REVIEW，不冒充 PASS', () => {
  const audit = evaluateLayoutSupplements({});
  assert.equal(audit.summary.total, 9);
  assert.equal(audit.summary.REVIEW, 9);
  assert.equal(audit.summary.FAIL, 0);
  assert.equal(audit.passed, true, 'REVIEW 不是阻断 FAIL');
  assert.equal(audit.releaseReady, false, 'REVIEW 不能 releaseReady');
  assert.equal(statusOf(audit, 'SUP-TH-01'), 'REVIEW');
  assert.equal(statusOf(audit, 'SUP-ENCL-01'), 'REVIEW');
  assert.equal(statusOf(audit, 'SUP-IPC-01'), 'REVIEW');
  assert.equal(statusOf(audit, 'SUP-HS-02'), 'REVIEW');
});

test('P2 补充规则：热铜面积/热过孔按功率和阵列阈值判定', () => {
  assert.equal(requiredThermalCopperMm2(1), 100);
  assert.equal(requiredThermalCopperMm2(1.5), 150);
  assert.equal(requiredThermalCopperMm2(2), 200);
  const pass = evaluateLayoutSupplements({ thermal: { components: [{ ref: 'U1', powerW: 2, copperAreaMm2: 220, viaCount: 9, viaPitchMm: 1.1, viaHoleMm: 0.3 }] } });
  assert.equal(statusOf(pass, 'SUP-TH-01'), 'PASS');
  assert.equal(statusOf(pass, 'SUP-TH-02'), 'PASS');
  const fail = evaluateLayoutSupplements({ thermal: { components: [{ ref: 'U1', powerW: 2, copperAreaMm2: 150, viaCount: 4, viaPitchMm: 1.6, viaHoleMm: 0.5 }] } });
  assert.equal(statusOf(fail, 'SUP-TH-01'), 'FAIL');
  assert.equal(statusOf(fail, 'SUP-TH-02'), 'FAIL');
  assert.equal(statusOf(evaluateLayoutSupplements({ thermal: { components: [{ ref: 'U1', powerW: 2 }] } }), 'SUP-TH-01'), 'REVIEW');
});

test('P2 补充规则：PDN/高速/爬电/外壳/EMC 有量测才判定', () => {
  const pass = evaluateLayoutSupplements({
    pdn: { rails: [{ net: 'VBUS', dropV: 0.1, maxDropV: 0.15 }] },
    highSpeed: { groups: [{ name: 'USB', maxSkewMm: 0.5, targetImpedanceOhm: 90, members: [{ net: 'D+', lengthMm: 10, impedanceOhm: 92 }, { net: 'D-', lengthMm: 10.2, impedanceOhm: 89 }] }] },
    creepage: { pairs: [{ netA: 'AC_L', netB: 'AC_N', actualMm: 1.6, requiredMm: 1.5 }] },
    clearance: { pairs: [{ netA: 'AC_L', netB: 'AC_N', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 2.0 }] },
    enclosure: { requiredClearanceMm: 1, actualClearanceMm: 2, internalHeightMm: 8, maxComponentHeightMm: 5 },
    emc: { pairs: [{ from: 'SW1', to: 'ANT1', minMm: 15, actualMm: 18 }] },
  });
  for (const id of ['SUP-PDN-01', 'SUP-HS-01', 'SUP-CREEP-01', 'SUP-IPC-01', 'SUP-ENCL-01', 'SUP-EMC-01']) assert.equal(statusOf(pass, id), 'PASS', id);

  const fail = evaluateLayoutSupplements({
    pdn: { rails: [{ net: 'VBUS', dropV: 0.3, maxDropV: 0.15 }] },
    highSpeed: { groups: [{ name: 'USB', maxSkewMm: 0.2, members: [{ net: 'D+', lengthMm: 10 }, { net: 'D-', lengthMm: 11 }] }] },
    creepage: { pairs: [{ netA: 'AC_L', netB: 'AC_N', actualMm: 0.8, requiredMm: 1.5 }] },
    clearance: { pairs: [{ netA: 'AC_L', netB: 'AC_N', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 0.5 }] },
    enclosure: { requiredClearanceMm: 2, actualClearanceMm: 1, internalHeightMm: 4, maxComponentHeightMm: 5 },
    emc: { pairs: [{ from: 'SW1', to: 'ANT1', minMm: 15, actualMm: 8 }] },
  });
  for (const id of ['SUP-PDN-01', 'SUP-HS-01', 'SUP-CREEP-01', 'SUP-IPC-01', 'SUP-ENCL-01', 'SUP-EMC-01']) assert.equal(statusOf(fail, id), 'FAIL', id);
  assert.equal(fail.summary.blockingFailures, 6);
  assert.equal(fail.passed, false);
});

test('P2 补充规则 FAIL 计入排版审计阻断与 releaseReady', () => {
  const outline = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }], closed: true };
  const readback = { components: [{ primitiveId: 'p1', designator: 'U1', widthMm: 5, heightMm: 5, bboxMm: { xMm: 5, yMm: 5, centerXMm: 10, centerYMm: 10 } }] };
  const plan = { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 10, yMm: 10 }] };
  const withFail = auditPlacementPlan({ plan, readback, outline, intent: { thermal: { components: [{ ref: 'U1', powerW: 2, copperAreaMm2: 50 }] } } });
  assert.ok(withFail.blocking.some((item) => item.ruleId === 'SUP-TH-01'));
  assert.equal(withFail.supplementFailures, 1);
  assert.equal(withFail.releaseReady, false);
  const noFacts = auditPlacementPlan({ plan, readback, outline });
  assert.equal(noFacts.supplementFailures, 0);
  assert.ok(noFacts.supplements.rules.every((rule) => rule.status === 'REVIEW'));
});

test('P2 高速组长度：意图未填时用铜线按网络累加，仍缺则 REVIEW', () => {
  const outline = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }], closed: true };
  const readback = { components: [{ primitiveId: 'p1', designator: 'U1', widthMm: 5, heightMm: 5, bboxMm: { xMm: 5, yMm: 5, centerXMm: 10, centerYMm: 10 } }] };
  const plan = { placements: [{ primitiveId: 'p1', ref: 'U1', xMm: 10, yMm: 10 }] };
  const copper = { lines: [
    { net: 'D+', x1: 0, y1: 0, x2: 100, y2: 0 },
    { net: 'D-', x1: 0, y1: 0, x2: 100, y2: 0 },
  ] };
  const audit = auditPlacementPlan({ plan, readback, outline, copper, intent: { highSpeed: { groups: [{ name: 'USB', maxSkewMm: 0.1, members: [{ net: 'D+' }, { net: 'D-' }] }] } } });
  assert.equal(audit.supplements.rules.find((rule) => rule.id === 'SUP-HS-01').status, 'PASS');
  const unknown = auditPlacementPlan({ plan, readback, outline, copper: { lines: [] }, intent: { highSpeed: { groups: [{ name: 'USB', maxSkewMm: 0.1, members: [{ net: 'D+' }, { net: 'D-' }] }] } } });
  assert.equal(unknown.supplements.rules.find((rule) => rule.id === 'SUP-HS-01').status, 'REVIEW');
});

test('P2 IPC-2221 电气间隙：按电压/层/涂覆/海拔查表，不补默认值', () => {
  assert.deepEqual(requiredClearanceMm({ workingVoltageV: 5, layer: 'internal' }), { ok: true, requiredMm: 0.05, column: '内层', rowMaxV: 15, basis: 'IPC-2221 表 6-1（Sierra Circuits 转述，证据等级 B）' });
  assert.equal(requiredClearanceMm({ workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000 }).requiredMm, 1.25);
  assert.equal(requiredClearanceMm({ workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 4000 }).requiredMm, 6.4);
  assert.equal(requiredClearanceMm({ workingVoltageV: 230, layer: 'external', coating: 'coated' }).requiredMm, 0.4);
  assert.equal(requiredClearanceMm({ workingVoltageV: 501, layer: 'internal' }).ok, false);
  assert.equal(requiredClearanceMm({ workingVoltageV: 230, layer: 'external', coating: 'uncoated' }).ok, false);

  const missing = evaluateLayoutSupplements({ clearance: { pairs: [{ netA: 'L', netB: 'N' }] } });
  assert.equal(statusOf(missing, 'SUP-IPC-01'), 'REVIEW');
  const empty = evaluateLayoutSupplements({ clearance: { pairs: [] } });
  assert.equal(statusOf(empty, 'SUP-IPC-01'), 'NA');
  const pass = evaluateLayoutSupplements({ clearance: { pairs: [{ netA: 'L', netB: 'N', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 1.3 }] } });
  assert.equal(statusOf(pass, 'SUP-IPC-01'), 'PASS');
  const fail = evaluateLayoutSupplements({ clearance: { pairs: [{ netA: 'L', netB: 'N', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 1.2 }] } });
  assert.equal(statusOf(fail, 'SUP-IPC-01'), 'FAIL');
});

test('P2 USB 差分对：只对显式 standard=USB2/3/4 的组套用 TI 阈值', () => {
  const base = { name: 'USB3', standard: 'USB3', targetImpedanceOhm: 90, members: [{ net: 'D+', impedanceOhm: 92 }, { net: 'D-', impedanceOhm: 89 }] };
  const pass = evaluateLayoutSupplements({ highSpeed: { groups: [{ ...base, intraPairSkewMm: 0.05, pairGapMm: 1.0, planeEdgeClearanceMm: 3, stubMm: 0.2 }] } });
  assert.equal(statusOf(pass, 'SUP-HS-02'), 'PASS');
  const fail = evaluateLayoutSupplements({ highSpeed: { groups: [{ ...base, intraPairSkewMm: 0.3, pairGapMm: 0.5, planeEdgeClearanceMm: 1, stubMm: 0.8 }] } });
  assert.equal(statusOf(fail, 'SUP-HS-02'), 'FAIL');
  const missing = evaluateLayoutSupplements({ highSpeed: { groups: [base] } });
  assert.equal(statusOf(missing, 'SUP-HS-02'), 'REVIEW');
  const generic = evaluateLayoutSupplements({ highSpeed: { groups: [{ name: 'SPI', members: [{ net: 'CLK' }, { net: 'MOSI' }] }] } });
  assert.equal(statusOf(generic, 'SUP-HS-02'), 'NA', '未声明 USB 标准不能硬套 USB 阈值');
  const usb2 = evaluateLayoutSupplements({ highSpeed: { groups: [{ ...base, standard: 'USB2' }] } });
  assert.equal(statusOf(usb2, 'SUP-HS-02'), 'PASS');
});
