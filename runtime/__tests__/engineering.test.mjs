import assert from 'node:assert/strict';
import test from 'node:test';
import { runEngineeringAnalysis } from '../engineering/engine.mjs';
import { engineeringFixtures } from '../engineering/fixtures.mjs';
import { analyzeHighSpeed } from '../engineering/highspeed.mjs';
import { planLayerTransition } from '../engineering/hdi.mjs';
import { analyzeRf } from '../engineering/rf.mjs';
import { solveLayout } from '../engineering/layout.mjs';
import { finding } from '../engineering/stackup.mjs';
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

// ============================================================================
// 布局求解器空间哈希网格加速的等价性证明
//
// solveLayout 的碰撞检测从「逐个扫描已放置器件」(placed.some(...), O(candidates×placed))
// 换成了均匀空间哈希网格。网格只是索引：它必须只多不少地给出候选，最终仍由同一个
// overlap() 判定。漏检会静默地允许器件重叠 —— 那是安全缺陷，不是性能问题。
// 所以这里用优化前的暴力实现当地面真值，对确定性伪随机输入与退化边界逐字节比对。
// ============================================================================

// ---- 优化前 solveLayout 的逐字复制（暴力 placed.some(...) 版本） ----
const REF_MAX_CANDIDATE_POINTS = 200_000;
const REF_MAX_COMPONENTS = 1_000;
const REF_MAX_BOARD_MM = 10_000;
const refOverlap = (a, b, m = 0) => a.x - a.w/2 - m < b.x + b.w/2 && a.x + a.w/2 + m > b.x - b.w/2 && a.y - a.h/2 - m < b.y + b.h/2 && a.y + a.h/2 + m > b.y - b.h/2;

function solveLayoutBruteForce(input = {}) {
  const rawBoard = input.board || {};
  const widthMm = Number(rawBoard.widthMm); const heightMm = Number(rawBoard.heightMm);
  const board = { ...rawBoard, widthMm, heightMm };
  const placed = []; const findings = [];
  if (!(widthMm > 0) || !(heightMm > 0) || widthMm > REF_MAX_BOARD_MM || heightMm > REF_MAX_BOARD_MM) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `板框尺寸必须是0到${REF_MAX_BOARD_MM}mm之间的有限正数`, 'board')], placements: [], score: 0, deterministic: true };
  const components = [...(input.components || [])];
  if (components.length > REF_MAX_COMPONENTS) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `器件数量超过上限${REF_MAX_COMPONENTS}`, 'components')], placements: [], score: 0, deterministic: true };
  const requestedGrid = Number(input.gridMm); const grid = Number.isFinite(requestedGrid) && requestedGrid >= 0.05 ? requestedGrid : 0.5;
  const requestedClearance = Number(input.clearanceMm); const clearance = Number.isFinite(requestedClearance) && requestedClearance >= 0 ? requestedClearance : 0.5;
  components.sort((a,b) => Number(Boolean(b.fixed)) - Number(Boolean(a.fixed)) || String(a.ref).localeCompare(String(b.ref)));
  for (const component of components) {
    const width = Number(component.widthMm); const height = Number(component.heightMm);
    const base = { ref: component.ref, w: Number.isFinite(width) && width > 0 ? width : 1, h: Number.isFinite(height) && height > 0 ? height : 1, rotation: Number(component.rotation || 0), role: component.role || 'general' };
    const candidates = component.fixed ? [{ x: Number(component.xMm), y: Number(component.yMm) }] : refCandidatePoints(component, board, grid);
    const valid = candidates.filter((p) => p.x-base.w/2 >= clearance && p.y-base.h/2 >= clearance && p.x+base.w/2 <= board.widthMm-clearance && p.y+base.h/2 <= board.heightMm-clearance && !placed.some((q) => refOverlap({ ...base,...p },q,clearance)));
    if (!valid.length) { findings.push(finding('LAYOUT_UNRESOLVED', `${component.ref}没有满足硬约束的位置`, `components.${component.ref}`)); continue; }
    const scored = valid.map((p) => ({ ...p, score: refLayoutScore(component,p,placed,board) })).sort((a,b) => a.score-b.score || a.x-b.x || a.y-b.y)[0]; placed.push({ ...base,...scored });
  }
  return { passed: findings.length === 0 && placed.length === components.length, findings, placements: placed, score: placed.reduce((s,p) => s+p.score,0), deterministic: true };
}
function refCandidatePoints(c,b,g) {
  const region = c.region || { xMin:g,yMin:g,xMax:b.widthMm-g,yMax:b.heightMm-g };
  const xMin=Number(region.xMin), yMin=Number(region.yMin), xMax=Number(region.xMax), yMax=Number(region.yMax);
  if (![xMin,yMin,xMax,yMax].every(Number.isFinite) || xMax<xMin || yMax<yMin) return [];
  const columns = Math.floor((xMax-xMin)/g)+1, rows = Math.floor((yMax-yMin)/g)+1;
  if (!(columns>0) || !(rows>0) || columns*rows > REF_MAX_CANDIDATE_POINTS) return [];
  const out=[]; for(let y=yMin;y<=yMax;y+=g) for(let x=xMin;x<=xMax;x+=g) out.push({x,y}); return out;
}
function refLayoutScore(c,p,placed,b) { let score=Math.abs(p.x-b.widthMm/2)+Math.abs(p.y-b.heightMm/2); if(c.role==='edge-connector') score=Math.min(p.x,b.widthMm-p.x,p.y,b.heightMm-p.y)*100; for(const target of Array.isArray(c.near) ? c.near : []) { const q=placed.find((v)=>v.ref===target); if(q) score+=Math.hypot(p.x-q.x,p.y-q.y)*10; } return score; }
// ---- 暴力参考实现结束 ----

// 确定性 PRNG：无依赖、可复现，不使用 Math.random。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pickFrom = (rand, list) => list[Math.floor(rand() * list.length)];

function makeLayoutCase(rand) {
  const widthMm = pickFrom(rand, [4, 8, 12, 30, 80, 300]);
  const heightMm = pickFrom(rand, [4, 8, 12, 30, 80, 300]);
  const count = Math.floor(rand() * 13);
  const components = [];
  for (let i = 0; i < count; i++) {
    const component = {
      ref: `R${String.fromCharCode(65 + i)}`,
      widthMm: pickFrom(rand, [0.2, 0.5, 1, 3, 8, 25, 60]),
      heightMm: pickFrom(rand, [0.2, 0.5, 1, 3, 8, 25, 60]),
      role: pickFrom(rand, ['general', 'edge-connector', 'connector']),
    };
    if (rand() < 0.25) { component.fixed = true; component.xMm = rand() * widthMm; component.yMm = rand() * heightMm; }
    if (rand() < 0.2) component.near = [`R${String.fromCharCode(65 + Math.floor(rand() * Math.max(1, i)))}`];
    if (rand() < 0.15) component.region = { xMin: rand() * widthMm, yMin: rand() * heightMm, xMax: rand() * widthMm, yMax: rand() * heightMm };
    if (rand() < 0.1) component.rotation = pickFrom(rand, [0, 90, 180]);
    components.push(component);
  }
  return {
    board: { widthMm, heightMm },
    gridMm: pickFrom(rand, [0.05, 0.5, 1, 2.5, 10]),
    clearanceMm: pickFrom(rand, [0, 0.25, 1, 5, 30]),
    components,
  };
}

test('网格加速的布局求解器与暴力扫描逐字节等价（确定性伪随机输入）', () => {
  for (let round = 0; round < 80; round++) {
    // 每轮用同一 seed 生成两份相同输入，保证两边拿到逐字节相同的 case。
    const build = () => makeLayoutCase(mulberry32(0x1a70 + round));
    const actual = solveLayout(build());
    const expected = solveLayoutBruteForce(build());
    assert.deepEqual(actual.placements, expected.placements, `第 ${round} 轮 placements 出现分歧`);
    assert.deepEqual(actual.findings, expected.findings, `第 ${round} 轮 findings 出现分歧`);
    assert.deepEqual(actual, expected, `第 ${round} 轮整体结果出现分歧`);
  }
});

test('退化边界下网格与暴力扫描等价（间隙 0 / 恰好相切 / 大于格子 / 板框刚好 / 重复坐标）', () => {
  const cases = {
    'clearance=0 且恰好相切': { board: { widthMm: 10, heightMm: 10 }, gridMm: 1, clearanceMm: 0, components: [{ ref: 'A', widthMm: 2, heightMm: 2, fixed: true, xMm: 3, yMm: 5 }, { ref: 'B', widthMm: 2, heightMm: 2 }] },
    'clearance=0.5 且间隙恰好等于 clearance': { board: { widthMm: 12, heightMm: 12 }, gridMm: 1, clearanceMm: 0.5, components: [{ ref: 'A', widthMm: 2, heightMm: 2, fixed: true, xMm: 3, yMm: 6 }, { ref: 'B', widthMm: 2, heightMm: 2 }] },
    '器件远大于格子边长': { board: { widthMm: 40, heightMm: 40 }, gridMm: 0.5, clearanceMm: 0.5, components: [{ ref: 'BIG', widthMm: 30, heightMm: 30 }, { ref: 'S', widthMm: 1, heightMm: 1 }] },
    '板框刚好放得下（唯一解）': { board: { widthMm: 3, heightMm: 3 }, gridMm: 0.5, clearanceMm: 0.5, components: [{ ref: 'ONLY', widthMm: 2, heightMm: 2 }] },
    '板框差一点点（无解）': { board: { widthMm: 2.9, heightMm: 2.9 }, gridMm: 0.5, clearanceMm: 0.5, components: [{ ref: 'NOPE', widthMm: 2, heightMm: 2 }] },
    '多个 fixed 器件坐标完全重复': { board: { widthMm: 20, heightMm: 20 }, gridMm: 1, clearanceMm: 0.5, components: [{ ref: 'A', widthMm: 4, heightMm: 4, fixed: true, xMm: 10, yMm: 10 }, { ref: 'B', widthMm: 4, heightMm: 4, fixed: true, xMm: 10, yMm: 10 }, { ref: 'C', widthMm: 4, heightMm: 4, fixed: true, xMm: 10, yMm: 10 }] },
    '重复 ref 的自动器件': { board: { widthMm: 8, heightMm: 8 }, gridMm: 1, clearanceMm: 0.5, components: [{ ref: 'X', widthMm: 2, heightMm: 2 }, { ref: 'X', widthMm: 2, heightMm: 2 }, { ref: 'X', widthMm: 2, heightMm: 2 }] },
    '尺寸非法（0/负数/NaN）回退为 1mm': { board: { widthMm: 10, heightMm: 10 }, gridMm: 0.5, clearanceMm: 0, components: [{ ref: 'A', widthMm: 0, heightMm: -5 }, { ref: 'B', widthMm: Number.NaN, heightMm: Number.POSITIVE_INFINITY }, { ref: 'C' }] },
    'gridMm 越界会被入口收敛（-1/0/0.01）': { board: { widthMm: 10, heightMm: 10 }, gridMm: -1, clearanceMm: 0, components: [{ ref: 'A', widthMm: 2, heightMm: 2 }, { ref: 'B', widthMm: 2, heightMm: 2 }] },
    'clearance 非法会被入口收敛（NaN/-3）': { board: { widthMm: 10, heightMm: 10 }, gridMm: 1, clearanceMm: Number.NaN, components: [{ ref: 'A', widthMm: 2, heightMm: 2 }, { ref: 'B', widthMm: 2, heightMm: 2 }] },
    'region 为空/反向': { board: { widthMm: 10, heightMm: 10 }, gridMm: 1, clearanceMm: 0, components: [{ ref: 'A', widthMm: 2, heightMm: 2, region: { xMin: 8, yMin: 8, xMax: 2, yMax: 2 } }, { ref: 'B', widthMm: 2, heightMm: 2, region: { xMin: Number.NaN, yMin: 1, xMax: 5, yMax: 5 } }] },
    '板框非法（0/负/NaN/超上限）': { board: { widthMm: 10_001, heightMm: 10 }, gridMm: 1, clearanceMm: 0, components: [{ ref: 'A', widthMm: 2, heightMm: 2 }] },
    '器件数超过 MAX_COMPONENTS': { board: { widthMm: 10, heightMm: 10 }, gridMm: 1, clearanceMm: 0, components: Array.from({ length: 1_001 }, (_, i) => ({ ref: `N${i}`, widthMm: 1, heightMm: 1 })) },
    // 关键回归：clearance 远大于格子边长时，查询范围必须按 clearance 外扩。只按器件自身
    // 尺寸取格子会漏掉“仅因 clearance 而冲突”的器件 —— 漏检意味着允许器件重叠。
    '大 clearance（远大于格子）：只有按 clearance 才冲突': { board: { widthMm: 10_000, heightMm: 10_000 }, gridMm: 5, clearanceMm: 100, components: [{ ref: 'A', widthMm: 5, heightMm: 5, fixed: true, xMm: 105, yMm: 5_000 }, { ref: 'B', widthMm: 5, heightMm: 5, fixed: true, xMm: 195, yMm: 5_000 }] },
  };
  for (const [name, input] of Object.entries(cases)) {
    const actual = solveLayout(input);
    const expected = solveLayoutBruteForce(input);
    assert.deepEqual(actual.placements, expected.placements, `${name}: placements 出现分歧`);
    assert.deepEqual(actual.findings, expected.findings, `${name}: findings 出现分歧`);
    assert.deepEqual(actual, expected, `${name}: 整体结果出现分歧`);
  }
  // 防止上面的用例空转：确认「恰好相切」真的产生了相切而不是分开。
  const touching = solveLayout(cases['clearance=0 且恰好相切']);
  const [a, b] = touching.placements;
  assert.equal(touching.passed, true);
  assert.equal(b.x - a.x, 2, 'B 应紧贴 A（中心距 = 两者半宽之和）');
  assert.equal(refOverlap(a, b, 0), false, '恰好相切不算重叠（严格不等号）');
  const gapped = solveLayout(cases['clearance=0.5 且间隙恰好等于 clearance']);
  const [ga, gb] = gapped.placements;
  assert.equal(gb.x - ga.x, 3, '中心距 = 半宽和 + clearance');
  assert.equal(refOverlap(ga, gb, 0.5), false, '间隙恰好等于 clearance 时不算冲突');
  const duplicates = solveLayout(cases['多个 fixed 器件坐标完全重复']);
  assert.equal(duplicates.placements.length, 1);
  assert.equal(duplicates.findings.filter((f) => f.code === 'LAYOUT_UNRESOLVED').length, 2);
  // 确认“大 clearance”用例不是空转：参考实现必须判定 B 与 A 冲突（否则该用例测不到东西）。
  const wideGap = solveLayout(cases['大 clearance（远大于格子）：只有按 clearance 才冲突']);
  assert.equal(wideGap.passed, false);
  assert.deepEqual(wideGap.findings.map((f) => f.code), ['LAYOUT_UNRESOLVED']);
  assert.equal(wideGap.placements.length, 1);
});

test('规模守卫：接近 MAX_COMPONENTS 的器件在细网格大板上仍能在预算内完成且无碰撞', { timeout: 120_000 }, () => {
  const components = [];
  for (let i = 0; i < REF_MAX_COMPONENTS; i++) components.push({ ref: `U${String(i).padStart(4, '0')}`, widthMm: 2, heightMm: 1.5, role: 'general' });
  const input = { board: { widthMm: 90, heightMm: 90 }, gridMm: 1, clearanceMm: 0.3, components };
  const started = Date.now();
  const result = solveLayout(input);
  const elapsed = Date.now() - started;
  assert.equal(result.passed, true);
  assert.equal(result.placements.length, REF_MAX_COMPONENTS);
  // 旧实现是 O(candidates × placed)：同样输入要跑数分钟以上。这里用宽松预算拦回归，
  // 不追求精确性能断言，避免在慢机器/并发负载下变成随机失败。
  assert.ok(elapsed < 30_000, `应在预算内完成，实际 ${elapsed}ms`);
  for (let i = 0; i < result.placements.length; i++) {
    for (let j = i + 1; j < result.placements.length; j++) {
      assert.equal(refOverlap(result.placements[i], result.placements[j], 0), false, `${result.placements[i].ref} 与 ${result.placements[j].ref} 重叠`);
    }
  }
});
