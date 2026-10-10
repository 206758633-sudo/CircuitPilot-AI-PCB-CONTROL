import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileSemanticPlan, inspectProductionArtifacts, normalizeSemanticPlan, ProductionManager } from '../production.mjs';

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
  assert.equal(first.compiled.operations.filter((item) => item.stage === 'outline').length, 4);
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
  fs.writeFileSync(path.join(root, 'board.step'), 'step');
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
  fs.writeFileSync(path.join(root, 'board.step'), 'step');
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
