import assert from 'node:assert/strict';
import test from 'node:test';
import { engineeringProfiles, runEngineeringAnalysis } from './engine.mjs';
import { engineeringFixtures, rf24gFixture } from './fixtures.mjs';
import { analyzeHighSpeed } from './highspeed.mjs';
import { planLayerTransition } from './hdi.mjs';
import { analyzeRf } from './rf.mjs';
import { solveLayout } from './layout.mjs';

test('three golden fixtures emit provenance, hashes and controlled operations', () => {
  for (const [id, build] of Object.entries(engineeringFixtures)) {
    const report=runEngineeringAnalysis(build());
    assert.equal(report.reportHash.length,64,id); assert.equal(report.humanReviewRequired,true); assert.equal(report.officialDrcRequired,true); assert.equal(report.onlineDfmRequired,true);
    assert.ok(report.operations.every((o)=>['pcb.component.modify','pcb.line.create','pcb.via.create'].includes(o.type)));
  }
});

test('high-speed hard gates catch return path, spacing and skew',()=>{
  const result=analyzeHighSpeed({profileId:'usb2',pairGapMm:0.15,geometry:{widthMm:0.18,copperThicknessMm:0.035,heightMm:0.18,er:4.1},segments:[{lengthMm:1,widthMm:0.18,neighborSpacingMm:0.1,referenceContinuous:false},{lengthMm:3,widthMm:0.18,neighborSpacingMm:0.1,referenceContinuous:true}]});
  assert.equal(result.passed,false); assert.deepEqual(new Set(result.findings.map((f)=>f.code)),new Set(['RETURN_PATH_DISCONTINUITY','CROSSTALK_CLEARANCE','LENGTH_SKEW'])); assert.equal(result.provenance.requiresFabricatorStackup,true);
});

test('HDI planner enforces adjacent microvia and stack limit',()=>{
  const result=planLayerTransition({fromLayer:1,toLayer:3,layerCount:4,maxStackedMicrovias:1,viaTypes:[{type:'microvia',fromLayer:1,toLayer:2,drillMm:0.1,diameterMm:0.25},{type:'microvia',fromLayer:2,toLayer:3,drillMm:0.1,diameterMm:0.25}]});
  assert.equal(result.passed,false); assert.ok(result.findings.some((f)=>f.code==='MICROVIA_STACK_LIMIT'));
});

test('RF gate requires external simulation and antenna evidence',()=>{
  const result=analyzeRf({frequencyGHz:2.4,geometry:{widthMm:0.3,gapMm:0.15,heightMm:0.18,er:4.1},viaFence:{lengthMm:10,pitchMm:1}});
  assert.equal(result.passed,false); assert.ok(result.findings.some((f)=>f.code==='RF_SIMULATION_REQUIRED')); assert.ok(result.findings.some((f)=>f.code==='ANTENNA_KEEPOUT_UNVERIFIED'));
});

test('layout solver is deterministic and collision free',()=>{
  const input={board:{widthMm:20,heightMm:10},gridMm:0.5,clearanceMm:0.5,components:[{ref:'A',widthMm:2,heightMm:2},{ref:'B',widthMm:2,heightMm:2,near:['A']}]};
  assert.deepEqual(solveLayout(input),solveLayout(input)); assert.equal(solveLayout(input).passed,true);
});

test('仿真证据门禁：编造的哈希过不了闸，真实求解器证据才放行（demo 模式只降级为警告）', async () => {
  const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { runSimulation } = await import('../simulation.mjs');
  const base = { frequencyGHz: 2.4, targetOhm: 50, toleranceOhm: 5, geometry: { widthMm: 0.3, gapMm: 0.05, heightMm: 0.18, er: 4.1 }, antennaKeepout: { verified: true, evidence: 'fixture:antenna-drawing-rev-a' }, viaFence: { lengthMm: 20, pitchMm: 1 } };
  const netlist = '* sim\n.op\n.end\n';

  // 旧世界：填个字符串就算有证据 → 现在必须被拒
  const fake = analyzeRf({ ...base, simulationEvidence: { source: 'fixture', hash: 'sha256:fixture-openems-result', solver: 'openEMS' } });
  assert.equal(fake.passed, false, '样板证据不能当验收结论');
  assert.ok(fake.findings.some((f) => f.code === 'RF_SIMULATION_EVIDENCE_REJECTED'), fake.findings.map((f) => f.code).join(','));

  // demo 模式：降级成警告，报告不再被否，但结论仍然明说"不是求解器产出"
  const demo = analyzeRf({ ...base, demo: true, simulationEvidence: { source: 'fixture', hash: 'x', solver: 'openEMS' } });
  assert.ok(demo.findings.some((f) => f.code === 'RF_SIMULATION_DEMO_EVIDENCE' && f.severity === 'warning'), JSON.stringify(demo.findings));
  assert.equal(demo.findings.every((f) => f.severity !== 'blocking'), true);

  // 真实求解器证据（用可执行桩验证的是管线本身）→ 不该再有仿真类 finding
  const dir = mkdtempSync(join(tmpdir(), 'cp-eng-solver-'));
  const stub = join(dir, 'ngspice-stub');
  writeFileSync(stub, '#!/bin/sh\necho "ngspice-42 (stub)"\necho "v(x) = 1.0e+00"\nexit 0\n', 'utf8');
  chmodSync(stub, 0o755);
  try {
    const { evidence } = await runSimulation({ netlistText: netlist, solverPath: stub });
    const real = analyzeRf({ ...base, simulationEvidence: evidence, simulationNetlistText: netlist });
    assert.equal(real.findings.some((f) => f.code.startsWith('RF_SIMULATION')), false, JSON.stringify(real.findings));
    // 网表对不上 → 立刻失效
    const stale = analyzeRf({ ...base, simulationEvidence: evidence, simulationNetlistText: `${netlist}* 改了\n` });
    assert.ok(stale.findings.some((f) => f.code === 'RF_SIMULATION_EVIDENCE_REJECTED' && /不是针对当前原理图/.test(f.message)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('能力清单里的仿真可用性必须来自真实探测，不能硬写', async () => {
  const { discoverSolver } = await import('../simulation.mjs');
  const spice = engineeringProfiles().solvers.spice;
  assert.equal(spice, discoverSolver().path ? 'available' : 'solver-not-installed');
  assert.equal(engineeringProfiles().solvers.spiceEvidence, 'run-and-hash-bound');
});

test('RF 样板（demo）报告：设计项通过，但必须留下"仿真仍是样板"的警告', () => {
  const report = runEngineeringAnalysis(rf24gFixture());
  assert.ok(report.findings.some((f) => f.code === 'RF_SIMULATION_DEMO_EVIDENCE' && f.severity === 'warning'), report.findings.map((f) => `${f.code}:${f.severity}`).join(','));
  assert.equal(report.findings.some((f) => f.severity === 'blocking'), false, report.findings.filter((f) => f.severity === 'blocking').map((f) => f.code).join(','));
  assert.equal(report.passed, true, '警告不该否决整份报告（原先是 findings.length===0，连 warning 也一起否）');
  assert.equal(report.humanReviewRequired, true);
});
