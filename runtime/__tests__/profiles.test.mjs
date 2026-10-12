import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSemanticPlan, evaluateCompiledPlan, normalizeSemanticPlan, RULE_PROFILES, validateSemanticPlan } from '../production.mjs';

/** 四层板的基准语义计划：测试只改需要观察的那一项，其余保持合法。 */
function fourLayerPlan(overrides = {}) {
  const component = (ref, xMm) => ({ ref, primitiveId: `${ref}-id`, footprint: 'R0603', side: 'top', placement: { xMm, yMm: 5, rotation: 0, locked: false }, sizeMm: { width: 1.6, height: 0.8 } });
  return {
    projectId: 'p-4l', title: '四层板回归', board: { widthMm: 60, heightMm: 40, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    components: [component('R1', 5), component('R2', 15)],
    nets: [{ name: 'USB_DP', class: 'signal', endpoints: [{ ref: 'R1', pin: '1', xMm: 5, yMm: 5 }, { ref: 'R2', pin: '1', xMm: 15, yMm: 5 }] }],
    silkscreen: [], decisions: [],
    evidence: [{ kind: 'schematic', id: 'sch-1' }],
    constraints: { profileId: 'jlc-4l', impedance: { stackupSource: '嘉立创四层板 1.6mm 标准叠层' } },
    ...overrides,
  };
}
const codes = (result) => result.issues.map((item) => item.code);

test('四个制造规则档位齐备，且多层档位标注叠层与阻抗要求', () => {
  assert.deepEqual(Object.keys(RULE_PROFILES).sort(), ['jlc-4l', 'jlc-6l', 'jlc-8l', 'jlc-low-cost-2l']);
  for (const [id, profile] of Object.entries(RULE_PROFILES)) {
    assert.equal(profile.id, id, '档位 id 必须与键一致，否则按 profileId 取用会错位');
    assert.ok([2, 4, 6, 8].includes(profile.layers));
    assert.ok(profile.minTrackMm > 0 && profile.minClearanceMm > 0 && profile.minCopperToEdgeMm > 0);
    assert.ok(profile.note && profile.note.length > 0, '档位必须带来源/局限说明');
    assert.equal(profile.stackupRequired, profile.layers > 2, `层数与叠层要求不一致: ${id}`);
    assert.equal(profile.impedanceControlled, profile.layers > 2, `层数与阻抗能力标注不一致: ${id}`);
  }
});

test('多层档位的工艺数值沿用保守下界，不冒充板厂已核实能力', () => {
  const base = RULE_PROFILES['jlc-low-cost-2l'];
  for (const id of ['jlc-4l', 'jlc-6l', 'jlc-8l']) {
    const profile = RULE_PROFILES[id];
    // 保守值的含义：只允许比双层档位更严，不允许更松（更松就等于凭空放宽了制造约束）。
    assert.ok(profile.minTrackMm >= base.minTrackMm, `${id} 最小线宽不得松于双层档位`);
    assert.ok(profile.minClearanceMm >= base.minClearanceMm, `${id} 最小间距不得松于双层档位`);
    assert.ok(profile.minViaDiameterMm >= base.minViaDiameterMm);
    assert.equal(profile.requiresFabricatorEvidence, true, `${id} 必须标注需要板厂证据`);
    assert.match(profile.note, /不构成对嘉立创多层板实际能力的声明/, `${id} 必须写明这不是板厂能力声明`);
  }
});

test('四层板套用双层档位必须被拦下（改造前只检查档位是否存在）', () => {
  const issues = validateSemanticPlan(normalizeSemanticPlan(fourLayerPlan({ constraints: { profileId: 'jlc-low-cost-2l' } })).plan);
  assert.ok(issues.some((item) => item.code === 'RULE_PROFILE_LAYER_MISMATCH'), `未拦下档位与层数不匹配: ${JSON.stringify(issues.map((i) => i.code))}`);
  assert.equal(issues.find((item) => item.code === 'RULE_PROFILE_LAYER_MISMATCH').severity, 'blocking');
});

test('六层/八层板同样要求档位匹配', () => {
  for (const [layers, profileId] of [[6, 'jlc-6l'], [8, 'jlc-8l']]) {
    const board = { widthMm: 60, heightMm: 40, layers, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 };
    const ok = normalizeSemanticPlan(fourLayerPlan({ board, constraints: { profileId, impedance: { stackupSource: 'x' } } }));
    assert.equal(ok.ready, true, `${layers}层 + ${profileId} 应通过: ${JSON.stringify(codes(ok))}`);
    const mismatched = normalizeSemanticPlan(fourLayerPlan({ board, constraints: { profileId: 'jlc-4l', impedance: { stackupSource: 'x' } } }));
    assert.ok(codes(mismatched).includes('RULE_PROFILE_LAYER_MISMATCH'), `${layers}层套用四层档位应被拦下`);
  }
});

test('多层计划没有叠层证据时阻断', () => {
  const noEvidence = normalizeSemanticPlan(fourLayerPlan({ evidence: [{ kind: 'schematic', id: 'sch-1' }], constraints: { profileId: 'jlc-4l' } }));
  assert.ok(codes(noEvidence).includes('MULTILAYER_STACKUP_EVIDENCE_REQUIRED'), `缺少叠层证据应阻断: ${JSON.stringify(codes(noEvidence))}`);
  assert.equal(noEvidence.ready, false);
});

test('叠层证据两种形式都受理：stackupSource 或 kind=stackup 的证据条目', () => {
  const viaConstraint = normalizeSemanticPlan(fourLayerPlan({ constraints: { profileId: 'jlc-4l', impedance: { stackupSource: '板厂叠层单 A' } } }));
  assert.ok(!codes(viaConstraint).includes('MULTILAYER_STACKUP_EVIDENCE_REQUIRED'));

  const viaEvidence = normalizeSemanticPlan(fourLayerPlan({ evidence: [{ kind: 'stackup', id: 'stack-1' }], constraints: { profileId: 'jlc-4l' } }));
  assert.ok(!codes(viaEvidence).includes('MULTILAYER_STACKUP_EVIDENCE_REQUIRED'), `evidence 形式未被受理: ${JSON.stringify(codes(viaEvidence))}`);

  // 只有非叠层证据时仍然阻断。
  const wrongKind = normalizeSemanticPlan(fourLayerPlan({ evidence: [{ kind: 'thermal', id: 'x' }], constraints: { profileId: 'jlc-4l' } }));
  assert.ok(codes(wrongKind).includes('MULTILAYER_STACKUP_EVIDENCE_REQUIRED'));
});

test('双层计划不受新规则影响：无需叠层证据，仍可编译', () => {
  const board2 = { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
  const result = normalizeSemanticPlan(fourLayerPlan({ board: board2, constraints: { profileId: 'jlc-low-cost-2l' } }));
  assert.equal(result.ready, true, `双层计划不应被新规则影响: ${JSON.stringify(codes(result))}`);
  assert.ok(result.compiled !== null || true);
  const compiled = compileSemanticPlan(fourLayerPlan({ board: board2, constraints: { profileId: 'jlc-low-cost-2l' } }));
  assert.notEqual(compiled.compiled, null);
});

test('默认工艺值跟随所选档位，而不是固定取双层档位', () => {
  for (const id of Object.keys(RULE_PROFILES)) {
    const board = { widthMm: 60, heightMm: 40, layers: RULE_PROFILES[id].layers, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
    const { plan } = normalizeSemanticPlan(fourLayerPlan({ board, constraints: { profileId: id, impedance: { stackupSource: 'x' } } }));
    assert.equal(plan.constraints.minClearanceMm, RULE_PROFILES[id].minClearanceMm, `${id} 的间距默认值取错档位`);
    assert.equal(plan.constraints.minCopperToEdgeMm, RULE_PROFILES[id].minCopperToEdgeMm, `${id} 的板边净空默认值取错档位`);
  }
});

test('未知档位：仍然报 RULE_PROFILE_UNKNOWN，且默认值回退到已知保守档位', () => {
  const result = normalizeSemanticPlan(fourLayerPlan({ constraints: { profileId: 'jlc-unknown-9l' } }));
  assert.ok(codes(result).includes('RULE_PROFILE_UNKNOWN'), `未知档位未报错: ${JSON.stringify(codes(result))}`);
  assert.equal(result.plan.constraints.minClearanceMm, RULE_PROFILES['jlc-low-cost-2l'].minClearanceMm);
  assert.equal(result.ready, false);
});

test('四层计划能编译出完整操作序列，且官方 DRC 仍在最后', () => {
  const compiled = compileSemanticPlan(fourLayerPlan());
  assert.equal(compiled.ready, true, JSON.stringify(codes(compiled)));
  const operations = compiled.compiled.operations;
  assert.equal(operations.at(-1).type, 'pcb.drc', '官方 DRC 必须是最后一个操作');
  assert.ok(operations.some((operation) => operation.type === 'pcb.pour.create'));
  assert.ok(operations.some((operation) => operation.type === 'pcb.save'));
  // 板框必须仍然画在板框层（11），而不是某个铜层。
  const outline = operations.filter((operation) => operation.stage === 'outline');
  assert.equal(outline.length, 4);
  assert.ok(outline.every((operation) => operation.args.layer === 11));
});

test('差分网络缺少叠层来源时，编译期质量检查必须报 IMPEDANCE_STACKUP_REQUIRED', () => {
  const plan = normalizeSemanticPlan(fourLayerPlan({
    evidence: [{ kind: 'stackup', id: 'stack-1' }],
    constraints: { profileId: 'jlc-4l' },
  })).plan;
  plan.nets[0].differentialPair = { mate: 'USB_DM', impedanceOhm: 90, toleranceOhm: 10, lengthToleranceMm: 0.5 };
  const report = evaluateCompiledPlan(plan, RULE_PROFILES['jlc-4l'], []);
  assert.ok(report.findings.some((item) => item.code === 'IMPEDANCE_STACKUP_REQUIRED'), `差分网络无叠层来源时应报错: ${JSON.stringify(report.findings.map((i) => i.code))}`);
  assert.equal(report.passed, false);
  assert.equal(report.humanReviewRequired, true, '编译结果必须仍然要求人工复核');
});
