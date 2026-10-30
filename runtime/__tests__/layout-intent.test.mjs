import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLayoutIntent, validateLayoutIntent } from '../engineering/layout-intent.mjs';
import { buildPlacementAuditInput } from '../placement-rules.mjs';
import { evaluateLayoutRules } from '../engineering/layout-rules.mjs';

test('布局意图：连接器方向/天线端/去耦配对缺字段或非法值必须拒绝', () => {
  const valid = {
    schemaVersion: 1,
    components: {
      J1: { conn: { kind: 'USB-C', openingDir: '+y', plugClearanceMm: 12, cableKeepout: true, pin1Marked: true } },
      U4: { courtyardMm: 0.25, heightMm3d: 3.2, packageClass: 'MODULE', antenna: { endDir: '+y' } },
    },
    power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: 0.8, icClass: 'MODULE' }] },
    rf: { componentRef: 'U4', keepout: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    testPoints: [{ ref: 'TP1', diaMm: 1.5, net: '3V3' }],
    switches: [{ ref: 'SW1', clearanceMm: 9 }],
    esd: { devices: [{ ref: 'D1', distanceMm: 3, gndViaDistanceMm: 1.2, orderBeforeBranch: true }] },
    clearance: { pairs: [{ netA: 'L', netB: 'N', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 1.3 }] },
  };
  assert.deepEqual(validateLayoutIntent(valid), { ok: true, issues: [] });
  assert.equal(normalizeLayoutIntent(valid), valid);

  for (const bad of [
    { components: { J1: { conn: { openingDir: '+z' } } } },
    { components: { U4: { antenna: { endDir: 'up' } } } },
    { power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: '0.8' }] } },
    { rf: { keepout: { x0: 0, y0: 0, x1: 0, y1: 10 } } },
    { components: { U4: { courtyardMm: -0.1 } } },
    { esd: { devices: [{ ref: 'D1', distanceMm: -1 }] } },
    { clearance: { pairs: [{ netA: 'L', netB: 'N', layer: 'outer' }] } },
    { clearance: { pairs: [{ netA: 'L', netB: 'N', coating: 'painted' }] } },
    { highSpeed: { groups: [{ name: 'USB', standard: 'USB5', members: [{ net: 'D+' }, { net: 'D-' }] }] } },
  ]) assert.equal(validateLayoutIntent(bad).ok, false, JSON.stringify(bad));
  assert.throws(() => normalizeLayoutIntent({ components: { U1: { side: 'middle' } } }), { code: 'LAYOUT_INTENT_INVALID' });
});

test('布局意图：blocks（功能分区）可选 —— 合法通过且向后兼容，跨块/重复/非法 region 拒绝', () => {
  const withBlocks = {
    schemaVersion: 1,
    blocks: [
      { id: 'dcdc', name: 'DC-DC 电源', refs: ['U1', 'C1'], region: { xMinMm: 0, yMinMm: 0, xMaxMm: 20, yMaxMm: 15 }, priority: 1 },
      { id: 'battery', name: '电池管理', refs: ['U2'] },
    ],
  };
  assert.deepEqual(validateLayoutIntent(withBlocks), { ok: true, issues: [] });
  assert.equal(normalizeLayoutIntent(withBlocks), withBlocks);
  assert.deepEqual(validateLayoutIntent({ schemaVersion: 1 }), { ok: true, issues: [] }, '旧意图（没有 blocks）必须保持通过');
  assert.deepEqual(validateLayoutIntent({ blocks: [] }), { ok: true, issues: [] });

  for (const bad of [
    { blocks: '分区' },
    { blocks: ['dcdc'] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1'] }, { id: 'a', name: 'B', refs: ['U2'] }] },
    { blocks: [{ id: '', name: 'A', refs: ['U1'] }] },
    { blocks: [{ id: 'a', refs: ['U1'] }] },
    { blocks: [{ id: 'a', name: '  ', refs: ['U1'] }] },
    { blocks: [{ id: 'a', name: 'A', refs: [] }] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1', 'u1'] }] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1'] }, { id: 'b', name: 'B', refs: ['u1'] }] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 0, yMinMm: 0, xMaxMm: 0, yMaxMm: 10 } }] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 0, yMinMm: 0, xMaxMm: 10 } }] },
    { blocks: [{ id: 'a', name: 'A', refs: ['U1'], priority: 'high' }] },
  ]) assert.equal(validateLayoutIntent(bad).ok, false, JSON.stringify(bad));

  assert.throws(
    () => normalizeLayoutIntent({ blocks: [{ id: 'a', name: 'A', refs: ['U1'] }, { id: 'b', name: 'B', refs: ['U1'] }] }),
    { code: 'LAYOUT_INTENT_INVALID' },
  );
});

test('布局意图合并进审计输入：连接器/天线/去耦/测试点不再因“没有字段”而 REVIEW', () => {
  const outline = { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], closed: true };
  const readback = { components: [
    { primitiveId: 'p1', designator: 'J1', widthMm: 8, heightMm: 6, bboxMm: { xMm: 8, yMm: 6, centerXMm: 20, centerYMm: 2 }, layerSide: 'top' },
    { primitiveId: 'p2', designator: 'U1', widthMm: 10, heightMm: 10, bboxMm: { xMm: 10, yMm: 10, centerXMm: 20, centerYMm: 20 }, layerSide: 'top' },
  ] };
  const plan = { placements: readback.components.map((item) => ({ primitiveId: item.primitiveId, xMm: item.bboxMm.centerXMm, yMm: item.bboxMm.centerYMm })) };
  const intent = {
    components: {
      J1: { courtyardMm: 0.25, conn: { kind: 'USB-C', openingDir: '-y', plugClearanceMm: 12, cableKeepout: true, pin1Marked: true } },
      U1: { courtyardMm: 0.25, heightMm3d: 3.2, packageClass: 'MODULE', antenna: { endDir: '-y' } },
    },
    rf: { componentRef: 'U1', keepout: { x0: 10, y0: 0, x1: 30, y1: 10 } },
    power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: 0.8, icClass: 'MODULE', icClassKnown: true }] },
    testPoints: [{ ref: 'TP1', diaMm: 1.5, net: '3V3' }],
    esd: { devices: [{ ref: 'D1', distanceMm: 3, gndViaDistanceMm: 1.2, orderBeforeBranch: true }] },
  };
  const input = buildPlacementAuditInput({ plan, readback, outline, intent });
  assert.equal(input.components.find((item) => item.ref === 'J1').conn.openingDir, '-y');
  assert.equal(input.components.find((item) => item.ref === 'U1').antenna.endDir, '-y');
  assert.equal(input.rf.componentRef, 'U1');
  assert.equal(input.power.decoupling[0].distanceMm, 0.8);
  assert.equal(input.testPoints.length, 1);
  assert.equal(input.esd.devices.length, 1);
  const audit = evaluateLayoutRules(input);
  assert.notEqual(audit.rules.find((rule) => rule.id === 'CONN-01').status, 'REVIEW');
});
