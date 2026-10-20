import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CAPABILITY, ORDER_CODES, buildFabricationOrder, deriveBoardFacts } from '../fabrication-order.mjs';

/**
 * 下单参数卡守的是"拿错参数下错板"这类**最贵的错**，以及"拿草稿文件下单"这种低级错。
 * 真实板事实（本板）：60.0×40.0mm、铜层 6。
 */

const realFacts = () => deriveBoardFacts({
  outlinePoints: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
  copperLayerCount: 6,
  designators: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'D1', 'J1'],
  netCount: 13,
  drcReport: { items: [{ disposition: 'must-fix', code: 'Connection Error' }, { disposition: 'fix-or-exempt', code: 'Clearance Error' }] },
  impedanceNets: [{ name: 'USB_DP', impedanceOhm: 90 }],
});

const finalFiles = () => ([
  { kind: 'gerber', name: 'GERBER_CircuitPilot-gerber.zip', path: '/x/GERBER_CircuitPilot-gerber.zip', bytes: 48734 },
  { kind: 'bom', name: 'BOM_CircuitPilot-bom.csv', path: '/x/BOM_CircuitPilot-bom.csv', bytes: 1308 },
  { kind: 'cpl', name: 'CPL_CircuitPilot-cpl.csv', path: '/x/CPL_CircuitPilot-cpl.csv', bytes: 2742 },
]);

test('实测事实来自板子本身：尺寸、层数、位号数、must-fix 条数都不是从参数表抄的', () => {
  const facts = realFacts();
  assert.deepEqual(facts.sizeMm, { x: 60, y: 40 });
  assert.equal(facts.copperLayerCount, 6);
  assert.equal(facts.componentCount, 8);
  assert.equal(facts.netCount, 13);
  assert.equal(facts.drcMustFixCount, 1);
  assert.equal(facts.drcItemCount, 2);
});

test('层数与实测不一致 → 阻断（按错参数下单会得到另一块板）', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: { layers: 4 }, files: finalFiles(), price: { amount: 88, currency: 'CNY', source: 'fab-api' } });
  const hit = card.findings.find((item) => item.code === ORDER_CODES.LAYER_MISMATCH);
  assert.equal(hit.severity, 'blocking');
  assert.match(hit.message, /实测铜层 6 层/);
  assert.equal(card.readyToOrder, false);
});

test('读不到层数/板框一律 unknown，不许默认成"没问题"（`Number(null)===0` 这种坑必须拦住）', () => {
  assert.equal(deriveBoardFacts({ copperLayerCount: null }).copperLayerCount, null, '没读到不许变成 0 层');
  assert.equal(deriveBoardFacts({ copperLayerCount: '' }).copperLayerCount, null, '空串也不许变成 0 层');
  assert.equal(deriveBoardFacts({ copperLayerCount: 6 }).copperLayerCount, 6);
  const card = buildFabricationOrder({ facts: deriveBoardFacts({}), requested: {}, files: finalFiles(), price: { amount: 1 } });
  assert.ok(card.findings.some((item) => item.code === ORDER_CODES.LAYER_MISMATCH && item.severity === 'unknown'));
  assert.ok(card.findings.some((item) => item.code === ORDER_CODES.SIZE_EXCEEDS_CAPABILITY && item.severity === 'unknown'));
  assert.equal(card.readyToOrder, false);
});

test('尺寸超能力上限 → 阻断', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: {}, capability: { ...DEFAULT_CAPABILITY, maxSizeMm: { x: 50, y: 50 } }, files: finalFiles(), price: { amount: 1 } });
  assert.ok(card.findings.some((item) => item.code === ORDER_CODES.SIZE_EXCEEDS_CAPABILITY && item.severity === 'blocking'));
});

test('工艺参数不在能力档 → 阻断，并说清哪个参数', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: { thicknessMm: 3.2, surfaceFinish: '沉银' }, files: finalFiles(), price: { amount: 1 } });
  const hits = card.findings.filter((item) => item.code === ORDER_CODES.PARAM_UNSUPPORTED);
  assert.deepEqual(hits.map((item) => item.field).sort(), ['surfaceFinish', 'thicknessMm']);
});

test('要求阻抗控制但没有阻抗证据 → 阻断（不能默认板厂替我们搞定）', () => {
  const noImpedance = deriveBoardFacts({ outlinePoints: [{ x: 0, y: 0 }, { x: 60, y: 40 }], copperLayerCount: 6, drcReport: { items: [] }, impedanceNets: [] });
  const card = buildFabricationOrder({ facts: noImpedance, requested: { impedanceControl: true }, files: finalFiles(), price: { amount: 1 } });
  assert.ok(card.findings.some((item) => item.code === ORDER_CODES.IMPEDANCE_WITHOUT_EVIDENCE && item.severity === 'blocking'));
  // 有证据就放行这一条
  const withEvidence = buildFabricationOrder({ facts: realFacts(), requested: { impedanceControl: true }, files: finalFiles(), price: { amount: 1 } });
  assert.equal(withEvidence.findings.some((item) => item.code === ORDER_CODES.IMPEDANCE_WITHOUT_EVIDENCE), false);
});

test('草稿文件 / 缺文件 → 阻断：这才是"走向生产"真正容易翻车的地方', () => {
  const draftFiles = finalFiles().map((file) => ({ ...file, name: file.name.replace('.', '-DRAFT-NOT-FOR-ORDER.') }));
  const card = buildFabricationOrder({ facts: realFacts(), requested: {}, files: draftFiles, price: { amount: 1 } });
  assert.equal(card.findings.filter((item) => item.code === ORDER_CODES.FILE_IS_DRAFT).length, 3);
  assert.equal(card.files.every((file) => file.draft === true), true);

  const missing = buildFabricationOrder({ facts: realFacts(), requested: {}, files: [{ kind: 'gerber', name: 'g.zip', path: '/x/g.zip' }], price: { amount: 1 } });
  assert.deepEqual(missing.findings.filter((item) => item.code === ORDER_CODES.FILE_MISSING).map((item) => item.field).sort(), ['bom', 'cpl']);
});

test('must-fix 未清 / 没有 DRC 报告 → 不许放行；有未清项时给出条数', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: {}, files: finalFiles(), price: { amount: 1 } });
  assert.match(card.findings.find((item) => item.code === ORDER_CODES.MUST_FIX_OPEN).message, /1 条必须修/);
  const noReport = buildFabricationOrder({ facts: deriveBoardFacts({ outlinePoints: [{ x: 0, y: 0 }, { x: 60, y: 40 }], copperLayerCount: 6 }), requested: {}, files: finalFiles(), price: { amount: 1 } });
  assert.ok(noReport.findings.some((item) => item.code === ORDER_CODES.MUST_FIX_OPEN && item.severity === 'unknown'));
});

test('价格没有来源就写 unknown 并说明原因，绝不给一个"看起来合理"的数', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: {}, files: finalFiles(), price: null });
  assert.equal(card.price.status, 'unknown');
  assert.match(card.price.reason, /不猜价格/);
  assert.ok(card.findings.some((item) => item.code === ORDER_CODES.PRICE_UNKNOWN && item.severity === 'warning'));
});

test('假设必须显式列出：能力档是示例值、数量是示例值，都要能被看见', () => {
  const card = buildFabricationOrder({ facts: realFacts(), requested: {}, files: finalFiles(), price: { amount: 1 } });
  assert.ok(card.assumptions.some((item) => item.field === 'capability' && item.why.includes('板厂官网')));
  assert.ok(card.assumptions.some((item) => item.field === 'quantity'));
  assert.equal(card.capability.provenance, 'assumed-default');
});

test('全部自洽时才 readyToOrder（本板真机数据 + 正式文件 + 清干净 DRC + 有报价）', () => {
  const clean = deriveBoardFacts({
    outlinePoints: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
    copperLayerCount: 6, designators: ['U1'], netCount: 13,
    drcReport: { items: [{ disposition: 'fix-or-exempt', code: 'Clearance Error' }] },
    impedanceNets: [{ name: 'USB_DP', impedanceOhm: 90 }],
  });
  const card = buildFabricationOrder({ facts: clean, requested: { layers: 6, quantity: 10 }, files: finalFiles(), price: { amount: 123.45, currency: 'CNY', source: 'fab-api' } });
  assert.equal(card.counts.blocking, 0);
  assert.equal(card.counts.unknown, 0);
  assert.equal(card.readyToOrder, true);
  assert.equal(card.humanSignoffRequired, true);
  assert.match(card.nextStep, /人工签字/);
});
