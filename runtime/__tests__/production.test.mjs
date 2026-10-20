import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileSemanticPlan, inspectProductionArtifacts, normalizeSemanticPlan, planPointToAbsolute, ProductionManager } from '../production.mjs';

function validPlan() {
  return {
    projectId: 'P1', title: 'control board',
    board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
    constraints: { profileId: 'jlc-low-cost-2l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3 },
    components: [
      { ref: 'J1', primitiveId: 'C1', role: 'edge-connector', footprint: 'USB-C', lcscId: 'C165948', placement: { xMm: 2, yMm: 15, rotation: 90 }, sizeMm: { width: 2, height: 8 } },
      { ref: 'U1', primitiveId: 'C2', role: 'mcu', footprint: 'TSSOP-20', lcscId: 'C720477', placement: { xMm: 20, yMm: 15, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
    ],
    nets: [{ name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 3, yMm: 15 }, { ref: 'U1', pin: 'VDD', xMm: 16, yMm: 15 }] }],
    evidence: [{ kind: 'eda-context', digest: 'abc' }], decisions: [{ key: 'board', approved: true }],
  };
}

// 最小可用的**贴装**STEP：含 PRODUCT + 装配引用 + 与 BOM 对应的位号。
// 之前两个测试写的是字符串 'step' 冒充 STEP —— 新校验把这种“扩展名对了就算有3D”拦下来了，
// 所以这里换成真实结构，测试才反映真实放行条件。
const MINIMAL_ASSEMBLED_STEP = [
  'ISO-10303-21;',
  "#1=PRODUCT('U1~TSSOP-20','U1','',(#2));",
  "#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','U1','',#1,$);",
  "#20=MANIFOLD_SOLID_BREP('sol',#21);",
].join('\n');

test('semantic plan rejects missing evidence and unsafe incomplete inputs', () => {
  const plan = validPlan();
  plan.evidence = [];
  plan.constraints.safety = { workingVoltageV: 230 };
  const result = normalizeSemanticPlan(plan);
  assert.equal(result.ready, false);
  assert.ok(result.blocking.some((item) => item.code === 'EVIDENCE_REQUIRED'));
  assert.ok(result.blocking.some((item) => item.code === 'SAFETY_CLEARANCE_REQUIRED'));
});

test('semantic compilation is deterministic and contains no scripts', () => {
  const first = compileSemanticPlan(validPlan());
  const second = compileSemanticPlan(validPlan());
  assert.equal(first.ready, true);
  assert.equal(first.compiledPlanHash, second.compiledPlanHash);
  // 板框现在是单条 pcb.outline.create（Polyline + 坐标开头多边形编码），不再是 4 条 pcb.line.create。
  const outlineOps = first.compiled.operations.filter((item) => item.stage === 'outline');
  assert.equal(outlineOps.length, 1);
  assert.equal(outlineOps[0].type, 'pcb.outline.create');
  assert.equal(outlineOps[0].args.layer, 11);
  assert.equal(first.compiled.operations.some((item) => JSON.stringify(item).includes('script')), false);
  assert.equal(first.quality.metrics.routedNetCount, 1);
  assert.equal(first.quality.humanReviewRequired, true);
});

test('differential impedance blocks quality without board-factory stackup evidence', () => {
  const plan = validPlan();
  plan.nets.push({ name: 'USB_D+', class: 'high-speed', differentialPair: { mate: 'USB_D-', impedanceOhm: 90, toleranceOhm: 10, lengthToleranceMm: 0.5 }, endpoints: [{ ref: 'J1', pin: 'A6', xMm: 3, yMm: 14 }, { ref: 'U1', pin: 'D+', xMm: 16, yMm: 14 }] });
  const result = compileSemanticPlan(plan);
  assert.equal(result.ready, true);
  assert.equal(result.quality.passed, false);
  assert.ok(result.quality.findings.some((item) => item.code === 'IMPEDANCE_STACKUP_REQUIRED'));
});

test('production manifest hashes files and remains unreleased pending online DFM and review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circuitpilot-artifacts-'));
  fs.writeFileSync(path.join(root, 'BOM.csv'), 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n1,U1,TSSOP-20,CH32V003F4P6,C720477\n');
  fs.writeFileSync(path.join(root, 'CPL.csv'), 'Designator,Mid X,Mid Y,Layer,Rotation,SMD\nU1,1,1,Top,0,Yes\n');
  fs.writeFileSync(path.join(root, 'board.GTL'), 'gerber');
  fs.writeFileSync(path.join(root, 'board.DRL'), 'drill');
  fs.writeFileSync(path.join(root, 'board.step'), MINIMAL_ASSEMBLED_STEP);
  const result = inspectProductionArtifacts(root, { projectId: 'P1', documentId: 'D1', sourceDigest: 'S1', semanticPlanHash: 'SP1', compiledPlanHash: 'CP1', executionId: 'E1' });
  assert.equal(result.readyForHumanReview, true);
  assert.equal(result.productionReleased, false);
  assert.equal(result.manifest.files.length, 5);
  assert.match(result.manifest.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.dfm.status, 'manual-review');
  // manifestHash 必须是内容寻址的：同一批文件两次巡检得到同一个哈希，
  // 否则人工终审无法绑定到确定的物料版本。
  const second = inspectProductionArtifacts(root, { projectId: 'P1', documentId: 'D1', sourceDigest: 'S1', semanticPlanHash: 'SP1', compiledPlanHash: 'CP1', executionId: 'E1' });
  assert.equal(second.manifest.manifestHash, result.manifest.manifestHash);
});

test('readiness ignores client-supplied verdicts and only accepts server-side references', () => {
  const manager = new ProductionManager({ artifactsRoot: '/missing' });
  // 修复前这正是漏洞形状：客户端直接提交“全部通过”的判定就能拿到 ready:true。
  assert.throws(() => manager.readiness({ semantic: { ready: true, quality: { passed: true } }, artifacts: { readyForHumanReview: true, manifest: { dfm: { status: 'passed' } } }, officialDrc: { passed: true }, finalReviewApproved: true }), { code: 'PRODUCTION_PLAN_UNKNOWN' });
  // 提交一个未登记的计划哈希同样被拒，无法凭空造出门禁结论。
  assert.throws(() => manager.readiness({ semanticPlanHash: 'fabricated', compiledPlanHash: 'fabricated', pcbExecutionId: 'fabricated', reviewHash: 'fabricated' }), { code: 'PRODUCTION_PLAN_UNKNOWN' });
});

test('readiness recomputes every gate server-side and can never self-certify online DFM', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circuitpilot-readiness-'));
  fs.writeFileSync(path.join(root, 'BOM.csv'), 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n1,U1,TSSOP-20,CH32V003F4P6,C720477\n');
  fs.writeFileSync(path.join(root, 'CPL.csv'), 'Designator,Mid X,Mid Y,Layer,Rotation,SMD\nU1,1,1,Top,0,Yes\n');
  fs.writeFileSync(path.join(root, 'board.GTL'), 'gerber');
  fs.writeFileSync(path.join(root, 'board.DRL'), 'drill');
  fs.writeFileSync(path.join(root, 'board.step'), MINIMAL_ASSEMBLED_STEP);
  const pcb = { get(id) { return id === 'E1' ? { id: 'E1', drc: { passed: true, findings: [] } } : null; } };
  const manager = new ProductionManager({ artifactsRoot: root, pcb });
  const compiled = manager.compile(validPlan());
  const binding = { projectId: 'P1', documentId: 'D1', sourceDigest: 'S1', semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, executionId: 'E1' };
  const inspection = manager.artifacts(binding);
  assert.equal(inspection.readyForHumanReview, true);

  // 没有真实PCB执行记录时，DRC门禁必须不通过。
  const noExecution = manager.readiness({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, binding });
  assert.equal(noExecution.gates.find((gate) => gate.id === 'official-pcb-drc').passed, false);
  assert.equal(noExecution.ready, false);
  assert.equal(noExecution.orderEnabled, false);

  const review = manager.finalReview({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', manifestHash: inspection.manifest.manifestHash, reviewer: 'e2e' });
  const full = manager.readiness({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', reviewHash: review.reviewHash, binding });
  // 本地校验、官方DRC、物料和人工终审全部通过，online-dfm 仍然为假：本地检查不能冒充在线DFM。
  assert.deepEqual(full.gates.filter((gate) => !gate.passed).map((gate) => gate.id), ['online-dfm']);
  assert.equal(full.ready, false);

  // 物料清单变化后，同一份人工终审必须失效（不能被复用到另一批物料上）。
  fs.writeFileSync(path.join(root, 'BOM.csv'), 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n2,U1,TSSOP-20,CH32V003F4P6,C720477\n');
  const stale = manager.readiness({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', reviewHash: review.reviewHash, binding });
  assert.deepEqual(stale.gates.filter((gate) => !gate.passed).map((gate) => gate.id).sort(), ['human-final-review', 'online-dfm']);
  assert.equal(stale.ready, false);

  // 终审无法绕过服务端绑定：没有PCB执行记录时拒绝登记，缺少物料哈希也拒绝登记。
  const orphan = new ProductionManager({ artifactsRoot: root });
  orphan.compile(validPlan());
  assert.throws(() => orphan.finalReview({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', manifestHash: inspection.manifest.manifestHash }), { code: 'PRODUCTION_EXECUTION_UNKNOWN' });
  assert.throws(() => manager.finalReview({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', manifestHash: '' }), { code: 'PRODUCTION_MANIFEST_REQUIRED' });
});

function writeArtifacts(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-artifacts-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  return root;
}

const GOOD_STEP = [
  'ISO-10303-21;',
  "#1=PRODUCT('U1~TSSOP-20','U1','',(#2));",
  "#2=PRODUCT_CONTEXT('',#3,'mechanical');",
  "#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','U1','',#1,$);",
  "#20=MANIFOLD_SOLID_BREP('sol',#21);",
].join('\n');

test('板框坐标系：带回读却不声明坐标系必须阻断（改造前两套坐标都能“通过”）', () => {
  const plan = validPlan();
  plan.board.outlineBoundsMm = { minXMm: -0.127, minYMm: -40.127, maxXMm: 60.127, maxYMm: 0.127 };
  const result = normalizeSemanticPlan(plan);
  assert.equal(result.ready, false);
  assert.ok(result.blocking.some((item) => item.code === 'PLAN_FRAME_REQUIRED'));
});

test('板框坐标系：声明 Y 向上并绑定回读角点后放行，且编译成绝对坐标（器件与铺铜一起平移）', () => {
  const plan = validPlan();
  const bounds = { minXMm: 0, minYMm: -30, maxXMm: 45, maxYMm: 0 };
  plan.board = { ...plan.board, outlineBoundsMm: bounds, frame: { yAxis: 'up', originXMm: 0, originYMm: -30 } };
  const result = compileSemanticPlan(plan);
  assert.equal(result.ready, true, JSON.stringify(result.blocking));
  const placement = result.compiled.operations.find((op) => op.type === 'pcb.component.modify' && op.ref === 'U1');
  assert.equal(placement.args.property.x.toFixed(3), '20.000');
  assert.equal(placement.args.property.y.toFixed(3), '-15.000');
  assert.equal(result.compiled.frame.yAxis, 'up');
  const pour = result.compiled.operations.find((op) => op.type === 'pcb.pour.create');
  assert.ok(pour.args.outline.every(([, y]) => y <= bounds.maxYMm + 1e-6 && y >= bounds.minYMm - 1e-6), '铺铜必须跟器件在同一坐标系');
});

test('板框坐标系：绝对坐标落到真实板框外、原点与回读不符，都必须抓到', () => {
  const bounds = { minXMm: 0, minYMm: -30, maxXMm: 45, maxYMm: 0 };
  const outside = validPlan();
  outside.board = { ...outside.board, outlineBoundsMm: bounds, frame: { yAxis: 'up', originXMm: 0, originYMm: -30 } };
  outside.components[1].placement = { xMm: 20, yMm: 45, rotation: 0 };
  assert.ok(normalizeSemanticPlan(outside).blocking.some((item) => item.code === 'PLACEMENT_OUTSIDE_ACTUAL_OUTLINE'));
  const mismatch = validPlan();
  mismatch.board = { ...mismatch.board, outlineBoundsMm: bounds, frame: { yAxis: 'up', originXMm: 0, originYMm: 0 } };
  assert.ok(normalizeSemanticPlan(mismatch).blocking.some((item) => item.code === 'PLAN_FRAME_MISMATCH_WITH_READBACK'));
});

test('planPointToAbsolute：up 翻转、down 直移、无坐标系时绝不猜测', () => {
  assert.deepEqual(planPointToAbsolute({ xMm: 2, yMm: 5 }, { yAxis: 'up', originXMm: -1, originYMm: -30 }, { heightMm: 30 }), { xMm: 1, yMm: -5 });
  assert.deepEqual(planPointToAbsolute({ xMm: 2, yMm: 5 }, { yAxis: 'down', originXMm: -1, originYMm: -30 }, { heightMm: 30 }), { xMm: 1, yMm: -25 });
  assert.deepEqual(planPointToAbsolute({ xMm: 2, yMm: 5 }, null, { heightMm: 30 }), { xMm: 2, yMm: 5 });
});

test('产物内容校验：光板 STEP（无装配引用）必须判失败，含器件装配且位号对得上才通过', () => {
  const bom = 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n1,"U1",TSSOP-20,STM32,C123\n';
  const cpl = 'Designator,Mid X,Mid Y,Layer,Rotation,SMD\n"U1",10,-20,T,0,Yes\n';
  const good = inspectProductionArtifacts(writeArtifacts({ 'BOM_board.csv': bom, 'CPL_board.csv': cpl, 'board.step': GOOD_STEP }));
  assert.deepEqual(good.manifest.contentValidation.findings, []);
  assert.deepEqual(good.manifest.contentValidation.step.missingRefs, []);
  assert.equal(good.manifest.contentValidation.step.assemblyUsages, 1);
  assert.equal(good.manifest.checks.find((check) => check.id === 'step').passed, true);

  const bare = inspectProductionArtifacts(writeArtifacts({ 'BOM_board.csv': bom, 'CPL_board.csv': cpl, 'board.step': "ISO-10303-21;\n#20=MANIFOLD_SOLID_BREP('sol',#21);" }));
  const codes = bare.manifest.contentValidation.findings.map((finding) => finding.code);
  assert.ok(codes.includes('STEP_NO_ASSEMBLY'), '光板必须被拦下，而不是“扩展名对了就算有3D”');
  assert.equal(bare.manifest.checks.find((check) => check.id === 'step').passed, false);
  assert.equal(bare.readyForHumanReview, false);
});

test('产物内容校验：重复扩展名与草稿标记必须报出；CPL 里 SMD=No 的插件件不计入贴装件', () => {
  const bom = 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n1,"U1",TSSOP-20,STM32,C123\n';
  const cpl = 'Designator,Mid X,Mid Y,Layer,Rotation,SMD\n"U1",10,-20,T,0,Yes\n"J1",30,-36,T,0,No\n';
  const result = inspectProductionArtifacts(writeArtifacts({ 'BOM_x-DRAFT-NOT-FOR-ORDER.csv.csv': bom, 'CPL_x.csv': cpl, 'board.step': GOOD_STEP }));
  const codes = result.manifest.contentValidation.findings.map((finding) => finding.code);
  assert.ok(codes.includes('ARTIFACT_NAME_DEGENERATE'));
  assert.ok(codes.includes('ARTIFACT_DRAFT_MARKER'));
  assert.equal(result.manifest.contentValidation.cplRefCount, 1, 'SMD=No 的插件件不能被算成贴装件');
});

test('readiness accepts bound manual DFM evidence but ignores unbound evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circuitpilot-readiness-dfm-'));
  fs.writeFileSync(path.join(root, 'BOM.csv'), 'Quantity,Designator,Footprint,Manufacturer Part,Supplier Part\n1,U1,TSSOP-20,CH32V003F4P6,C720477\n');
  fs.writeFileSync(path.join(root, 'CPL.csv'), 'Designator,Mid X,Mid Y,Layer,Rotation,SMD\nU1,1,1,Top,0,Yes\n');
  fs.writeFileSync(path.join(root, 'board.GTL'), 'gerber');
  fs.writeFileSync(path.join(root, 'board.DRL'), 'drill');
  fs.writeFileSync(path.join(root, 'board.step'), MINIMAL_ASSEMBLED_STEP);
  const pcb = { get(id) { return id === 'E1' ? { id: 'E1', drc: { passed: true, findings: [] } } : null; } };
  const manager = new ProductionManager({ artifactsRoot: root, pcb });
  const compiled = manager.compile(validPlan());
  const binding = { projectId: 'P1', documentId: 'D1', sourceDigest: 'S1', semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, executionId: 'E1' };
  const inspection = manager.artifacts(binding);
  const review = manager.finalReview({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', manifestHash: inspection.manifest.manifestHash, reviewer: 'e2e' });
  const reference = { semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', reviewHash: review.reviewHash, binding };
  const dfm = { digest: 'dfm-digest', savedAt: '2026-10-19T00:00:00.000Z', fingerprint: { planHash: compiled.planHash }, payload: { passed: true } };

  // 绑定到本计划的 DFM 证据：online-dfm 通过，全部门禁通过（自动下单仍禁用）。
  const bound = manager.readiness(reference, { dfm });
  assert.equal(bound.gates.find((gate) => gate.id === 'online-dfm').passed, true);
  assert.equal(bound.ready, true);
  assert.equal(bound.orderEnabled, false);
  assert.equal(bound.referenced.dfmHash, 'dfm-digest');

  // 绑定到别的计划的 DFM 证据：不许拿来充数。
  const unbound = manager.readiness(reference, { dfm: { ...dfm, fingerprint: { planHash: 'another-plan' } } });
  assert.equal(unbound.gates.find((gate) => gate.id === 'online-dfm').passed, false);
  assert.match(unbound.gates.find((gate) => gate.id === 'online-dfm').reason, /未绑定/);
  assert.equal(unbound.ready, false);

  // 即使客户端伪造 payload.passed=true，没有绑定计划也无法通过。
  const spoofed = manager.readiness(reference, { dfm: { payload: { passed: true } } });
  assert.equal(spoofed.gates.find((gate) => gate.id === 'online-dfm').passed, false);

  // 落盘签核证据可以替代内存 reviewHash：绑定计划 + 物料清单后 human-final-review 通过，
  // 重启/换会话不需要重新签核（这是"签核可追溯"的最低要求）。
  const signoff = { digest: 'sign-digest', savedAt: '2026-10-19T00:00:00.000Z', fingerprint: { planHash: compiled.planHash, pcbUuid: null, manifestHash: inspection.manifest.manifestHash }, payload: { passed: true, roles: [{ role: '硬件设计', name: '李工' }, { role: '制造工艺', name: '王工' }, { role: '项目负责人', name: '张工' }], manifestHash: inspection.manifest.manifestHash } };
  const bySignoff = manager.readiness({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', binding }, { dfm, signoff });
  assert.equal(bySignoff.gates.find((gate) => gate.id === 'human-final-review').passed, true);
  assert.equal(bySignoff.gates.find((gate) => gate.id === 'human-final-review').source, 'persisted-signoff');
  assert.equal(bySignoff.ready, true);
  assert.equal(bySignoff.orderEnabled, false);

  // 签核绑定到别的物料清单 → 不能算通过。
  const wrongManifest = manager.readiness({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'E1', binding }, { dfm, signoff: { ...signoff, payload: { ...signoff.payload, manifestHash: 'other-manifest' } } });
  assert.equal(wrongManifest.gates.find((gate) => gate.id === 'human-final-review').passed, false);
  assert.match(wrongManifest.gates.find((gate) => gate.id === 'human-final-review').reason, /物料清单/);
});
