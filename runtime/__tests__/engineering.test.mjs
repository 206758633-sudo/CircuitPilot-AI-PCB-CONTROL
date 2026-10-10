import assert from 'node:assert/strict';
import test from 'node:test';
import { runEngineeringAnalysis } from '../engineering/engine.mjs';
import { engineeringFixtures } from '../engineering/fixtures.mjs';
import { analyzeHighSpeed } from '../engineering/highspeed.mjs';
import { planLayerTransition } from '../engineering/hdi.mjs';
import { analyzeRf } from '../engineering/rf.mjs';
import { solveLayout } from '../engineering/layout.mjs';
import { createRuntimeServer } from '../server.mjs';

test('three golden fixtures emit provenance, hashes and allowlisted operations', () => {
  for (const [id, build] of Object.entries(engineeringFixtures)) {
    const report=runEngineeringAnalysis(build());
    assert.equal(report.passed,true,id); assert.equal(report.reportHash,runEngineeringAnalysis(build()).reportHash,`${id} report must be deterministic`);
    assert.equal(report.reportHash.length,64,id); assert.equal(report.humanReviewRequired,true); assert.equal(report.officialDrcRequired,true); assert.equal(report.onlineDfmRequired,true);
    assert.ok(report.operations.every((o)=>['pcb.component.modify','pcb.line.create','pcb.via.create'].includes(o.type)));
  }
});

test('engineering hard gates detect high-speed, HDI and RF violations',()=>{
  const hs=analyzeHighSpeed({profileId:'usb2',pairGapMm:0.15,geometry:{widthMm:0.18,copperThicknessMm:0.035,heightMm:0.18,er:4.1},segments:[{lengthMm:1,widthMm:0.18,neighborSpacingMm:0.1,referenceContinuous:false},{lengthMm:3,widthMm:0.18,neighborSpacingMm:0.1,referenceContinuous:true}]});
  assert.deepEqual(new Set(hs.findings.map((f)=>f.code)),new Set(['RETURN_PATH_DISCONTINUITY','CROSSTALK_CLEARANCE','LENGTH_SKEW']));
  const hdi=planLayerTransition({fromLayer:1,toLayer:3,layerCount:4,maxStackedMicrovias:1,viaTypes:[{type:'microvia',fromLayer:1,toLayer:2,drillMm:0.1,diameterMm:0.25},{type:'microvia',fromLayer:2,toLayer:3,drillMm:0.1,diameterMm:0.25}]}); assert.ok(hdi.findings.some((f)=>f.code==='MICROVIA_STACK_LIMIT'));
  const rf=analyzeRf({frequencyGHz:2.4,geometry:{widthMm:0.3,gapMm:0.15,heightMm:0.18,er:4.1},viaFence:{lengthMm:10,pitchMm:1}}); assert.ok(rf.findings.some((f)=>f.code==='RF_SIMULATION_REQUIRED')); assert.ok(rf.findings.some((f)=>f.code==='ANTENNA_KEEPOUT_UNVERIFIED'));
});

test('constraint layout is deterministic',()=>{
  const input={board:{widthMm:20,heightMm:10},gridMm:0.5,clearanceMm:0.5,components:[{ref:'A',widthMm:2,heightMm:2},{ref:'B',widthMm:2,heightMm:2,near:['A']}]}; assert.deepEqual(solveLayout(input),solveLayout(input)); assert.equal(solveLayout(input).passed,true);
});

test('hostile engineering inputs fail closed instead of exhausting the process',{timeout:5_000},()=>{
  const component={ref:'A',widthMm:2,heightMm:2};
  // gridMm:-1 previously stepped the wrong way forever; the loop now clamps to a safe default.
  const negativeGrid=solveLayout({board:{widthMm:20,heightMm:20},gridMm:-1,clearanceMm:0.5,components:[component]});
  assert.equal(negativeGrid.passed,true);
  // A huge board with a fine grid previously allocated >1e9 candidate points.
  const overBudget=solveLayout({board:{widthMm:2_000,heightMm:2_000},gridMm:0.06,clearanceMm:0.5,components:[component]});
  assert.equal(overBudget.passed,false);
  assert.ok(overBudget.findings.some((f)=>f.code==='LAYOUT_UNRESOLVED'));
  assert.equal(solveLayout({board:{widthMm:-5,heightMm:20}}).findings[0].code,'LAYOUT_INPUT_INVALID');
  // layerCount previously sized an Array directly: 1e9 killed the process.
  const hugeLayers=planLayerTransition({fromLayer:1,toLayer:2,layerCount:1e9,viaTypes:[]});
  assert.equal(hugeLayers.passed,false); assert.equal(hugeLayers.findings[0].code,'LAYER_COUNT_INVALID');
  assert.equal(planLayerTransition({fromLayer:2,toLayer:2,layerCount:4,viaTypes:[]}).passed,true);
  assert.ok(planLayerTransition({fromLayer:1,toLayer:2,layerCount:4,viaTypes:[]}).findings.some((f)=>f.code==='LAYER_TRANSITION_UNREACHABLE'));
  // A negative via cost previously made Dijkstra record a cycle, so reconstruction looped forever.
  const negativeCost=planLayerTransition({fromLayer:1,toLayer:3,layerCount:4,viaTypes:[{type:'through',fromLayer:1,toLayer:3,cost:-5}]});
  assert.ok(negativeCost.findings.some((f)=>f.code==='VIA_COST_INVALID'));
  // Out-of-range layer numbers must be rejected rather than silently producing "unreachable".
  const outOfRange=planLayerTransition({fromLayer:1,toLayer:9,layerCount:4,viaTypes:[]});
  assert.ok(outOfRange.findings.some((f)=>f.code==='LAYER_ENDPOINT_INVALID'));
});

test('runtime exposes profiles and authenticated fixture analysis', async (context) => {
  const keychain={async configured(){return false;},async read(){throw new Error('unused');}};
  const {server}=createRuntimeServer({keychain}); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); context.after(()=>new Promise((resolve)=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`; const health=await (await fetch(`${base}/api/health`,{headers:{origin:'http://127.0.0.1:4177'}})).json();
  const profiles=await (await fetch(`${base}/api/engineering/profiles`,{headers:{'x-circuitpilot-token':health.sessionProof}})).json(); assert.deepEqual(profiles.fixtures,['HS-USB2-4L','HDI-BGA-6L','RF-24G-4L']);
  const response=await fetch(`${base}/api/engineering/analyze`,{method:'POST',headers:{'content-type':'application/json','x-circuitpilot-token':health.sessionProof},body:JSON.stringify({fixtureId:'HDI-BGA-6L'})}); const result=await response.json(); assert.equal(response.status,200); assert.equal(result.analysis.kind,'advanced-pcb-engineering-report'); assert.equal(result.analysis.reportHash.length,64);
});
