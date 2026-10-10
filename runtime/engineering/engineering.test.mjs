import assert from 'node:assert/strict';
import test from 'node:test';
import { runEngineeringAnalysis } from './engine.mjs';
import { engineeringFixtures } from './fixtures.mjs';
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
