import { finding } from './stackup.mjs';
const overlap = (a,b,m=0) => a.x - a.w/2-m < b.x+b.w/2 && a.x+a.w/2+m > b.x-b.w/2 && a.y-a.h/2-m < b.y+b.h/2 && a.y+a.h/2+m > b.y-b.h/2;

const MAX_CANDIDATE_POINTS = 200_000;
const MAX_COMPONENTS = 1_000;
const MAX_BOARD_MM = 10_000;
// 均匀空间哈希网格（仅加速索引，不改变碰撞判定，逐字节等价由 layoutEquivalence.test.mjs 保证）。
// 正确性依据（不是“AABB 落在单个格子内”，那个说法不成立：边长等于格子的 AABB 会跨格）：
//   1. 格子边长 cell >= 基准值 >= maxDim（最大器件边长），所以两个相交器件的中心
//      在任一轴上最多相差 (w1+w2)/2 <= maxDim <= cell，即格子下标至多差 1；
//   2. 查询时取“查询 AABB 覆盖的格子 ±1 格”，因此相交器件必在候选里；
//   3. overlap() 还会按 margin 放宽，所以查询范围必须同步按 margin 外扩，
//      否则会漏掉仅因 clearance 而冲突的器件（漏检=允许重叠，是安全缺陷）。
// 多查出来的格子只是交给 overlap() 否定，因此候选集合虽可能更大，判定结果与逐个扫描一致。
const MAX_GRID_CELLS = 4_000_000;
// 丝印碰撞判定使用的间隙，必须与下面 overlap() 的 margin 保持一致，
// 否则候选查询范围会小于真实判定范围，导致漏检。
const SILKSCREEN_MARGIN = 0.1;

function cellCount(span, cell) {
  // 注意：这里必须对 number 调 Number.isFinite。之前写成 String(span/cell) 再判断，
  // 而 Number.isFinite 不做类型转换，对任何字符串都返回 false —— 结果 cellCount 恒为 0，
  // budget 被算成 2000，格子边长变成 base*2000，整块板子只落进一个格子，
  // 空间哈希退化成全量扫描（只剩复杂度，没有任何加速）。
  const ratio = span / cell;
  if (!Number.isFinite(ratio)) return ratio === Infinity ? Infinity : 0; // NaN 也归 0：宁可只查一格，也不做巨大范围的扫描。
  const v = Math.ceil(ratio);
  return v > 0 ? v : 0;
}
function cellSpan(lo, hi, min, cell) {
  let a = Math.floor((lo - min) / cell); let b = Math.floor((hi - min) / cell);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > b) { const t = a; a = b; b = t; }
  return { a, b };
}
// 建索引：格子边长 = maxDim/gridMm 基准值 * budget，budget 只在“自然格数超过预算”时才放大。
// 原实现写成 sqrt(MAX_GRID_CELLS / 自然格数)，语义正好相反：只要自然格数没到预算，
// budget 就会大于 1，把格子放得比需要的更大（实测 300×300 板、gridMm=5 时格子边长 160mm，
// 整块板只剩 6×6 个格子，相当于没有加速）。正确的是 ceil(sqrt(自然格数 / 预算))：
// 未超预算时 budget=1（格子最细），超预算时按倍数放大到预算以内。
// 边长只增不减，且恒有 cell >= maxDim，保证 AABB 判定不会漏候选。
function makeGrid({ widthMm, heightMm, maxDim, gridMm }) {
  const minX = Math.min(0, widthMm), minY = Math.min(0, heightMm);
  const spanX = Math.max(widthMm, 0) - minX, spanY = Math.max(heightMm, 0) - minY;
  const base = Math.max(gridMm, maxDim, Number.MIN_VALUE);
  const naturalCells = (cellCount(spanX, base) + 1) * (cellCount(spanY, base) + 1);
  const budget = Math.max(1, Math.ceil(Math.sqrt(naturalCells / MAX_GRID_CELLS)));
  const cell = base * budget;
  const table = new Map();
  return {
    table, cell, minX, minY,
    add(e) { const cx = Math.floor((e.x - minX) / cell), cy = Math.floor((e.y - minY) / cell); if (!Number.isFinite(cx) || !Number.isFinite(cy)) return; const key = `${cx},${cy}`; const bucket = table.get(key); if (bucket) bucket.push(e); else table.set(key, [e]); },
  };
}
// 查候选只多不少：多查相邻格子只是把多余的器件交给 overlap() 否定，判定结果与逐个扫描一致。
// margin 必须传进来：overlap() 判定时会按 clearance 放宽边界，可能与本次放置冲突的器件
// 中心最远会在 (w_E + w)/2 + margin 处，只按器件自身尺寸取格子会漏掉它们 ——
// 漏检意味着允许重叠，是安全缺陷，而不仅仅是结果不一致。
function gridCandidates(index, x, y, w, h, margin = 0) {
  const sx = cellSpan(x - w / 2 - margin, x + w / 2 + margin, index.minX, index.cell), sy = cellSpan(y - h / 2 - margin, y + h / 2 + margin, index.minY, index.cell);
  if (!sx || !sy) return null;
  const out = [];
  for (let cx = sx.a - 1; cx <= sx.b + 1; cx++) for (let cy = sy.a - 1; cy <= sy.b + 1; cy++) { const bucket = index.table.get(`${cx},${cy}`); if (bucket) for (const e of bucket) out.push(e); }
  return out;
}

export function solveLayout(input = {}) {
  const rawBoard = input.board || {};
  const widthMm = Number(rawBoard.widthMm); const heightMm = Number(rawBoard.heightMm);
  const board = { ...rawBoard, widthMm, heightMm };
  const placed = []; const findings = [];
  if (!(widthMm > 0) || !(heightMm > 0) || widthMm > MAX_BOARD_MM || heightMm > MAX_BOARD_MM) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `板框尺寸必须是0到${MAX_BOARD_MM}mm之间的有限正数`, 'board')], placements: [], score: 0, deterministic: true };
  const components = [...(input.components || [])];
  if (components.length > MAX_COMPONENTS) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `器件数量超过上限${MAX_COMPONENTS}`, 'components')], placements: [], score: 0, deterministic: true };
  // 负数或 0 的 gridMm 会让下面的候选点循环永不收敛（负数步长）或除零，必须在入口收敛成安全值。
  const requestedGrid = Number(input.gridMm); const grid = Number.isFinite(requestedGrid) && requestedGrid >= 0.05 ? requestedGrid : 0.5;
  const requestedClearance = Number(input.clearanceMm); const clearance = Number.isFinite(requestedClearance) && requestedClearance >= 0 ? requestedClearance : 0.5;
  components.sort((a,b) => Number(Boolean(b.fixed)) - Number(Boolean(a.fixed)) || String(a.ref).localeCompare(String(b.ref)));
  const bases = components.map((component) => {
    const width = Number(component.widthMm); const height = Number(component.heightMm);
    return { component, base: { ref: component.ref, w: Number.isFinite(width) && width > 0 ? width : 1, h: Number.isFinite(height) && height > 0 ? height : 1, rotation: Number(component.rotation || 0), role: component.role || 'general' } };
  });
  let maxDim = 0; for (const b of bases) { if (b.base.w > maxDim) maxDim = b.base.w; if (b.base.h > maxDim) maxDim = b.base.h; }
  const index = makeGrid({ widthMm, heightMm, maxDim, gridMm: grid });
  for (const { component, base } of bases) {
    const candidates = component.fixed ? [{ x: Number(component.xMm), y: Number(component.yMm) }] : candidatePoints(component, board, grid);
    // 命中格子只用于缩小扫描范围，最终判定仍由同一个 overlap() 给出，因此结果与逐个扫描 placed 完全一致。
    const valid = candidates.filter((p) => p.x-base.w/2 >= clearance && p.y-base.h/2 >= clearance && p.x+base.w/2 <= board.widthMm-clearance && p.y+base.h/2 <= board.heightMm-clearance && !(gridCandidates(index, p.x, p.y, base.w, base.h, clearance) ?? placed).some((q) => overlap({ ...base,...p },q,clearance)));
    if (!valid.length) { findings.push(finding('LAYOUT_UNRESOLVED', `${component.ref}没有满足硬约束的位置`, `components.${component.ref}`)); continue; }
    const scored = valid.map((p) => ({ ...p, score: layoutScore(component,p,placed,board) })).sort((a,b) => a.score-b.score || a.x-b.x || a.y-b.y)[0]; const entry = { ...base,...scored }; placed.push(entry); index.add(entry);
  }
  return { passed: findings.length === 0 && placed.length === components.length, findings, placements: placed, score: placed.reduce((s,p) => s+p.score,0), deterministic: true };
}
function candidatePoints(c,b,g) {
  const region = c.region || { xMin:g,yMin:g,xMax:b.widthMm-g,yMax:b.heightMm-g };
  const xMin=Number(region.xMin), yMin=Number(region.yMin), xMax=Number(region.xMax), yMax=Number(region.yMax);
  if (![xMin,yMin,xMax,yMax].every(Number.isFinite) || xMax<xMin || yMax<yMin) return [];
  const columns = Math.floor((xMax-xMin)/g)+1, rows = Math.floor((yMax-yMin)/g)+1;
  // 放弃超预算的网格，而不是把整个进程拖进 OOM；调用方会得到 LAYOUT_UNRESOLVED 而不是崩溃。
  if (!(columns>0) || !(rows>0) || columns*rows > MAX_CANDIDATE_POINTS) return [];
  const out=[]; for(let y=yMin;y<=yMax;y+=g) for(let x=xMin;x<=xMax;x+=g) out.push({x,y}); return out;
}
function layoutScore(c,p,placed,b) { let score=Math.abs(p.x-b.widthMm/2)+Math.abs(p.y-b.heightMm/2); if(c.role==='edge-connector') score=Math.min(p.x,b.widthMm-p.x,p.y,b.heightMm-p.y)*100; for(const target of Array.isArray(c.near) ? c.near : []) { const q=placed.find((v)=>v.ref===target); if(q) score+=Math.hypot(p.x-q.x,p.y-q.y)*10; } return score; }

export function placeSilkscreen({ placements = [], forbidden = [], textWidthMm = 3, textHeightMm = 1, offsetMm = 1 }) {
  const labels=[]; const findings=[];
  // 丝印碰撞同样只做加速：forbidden 与已选 labels 放进同一个索引，
  // 因为 labels 会随循环增长，这里用与 placed 相同的“只增不减”格子边长策略。
  const entries=[...forbidden,...placements.map((p)=>({ ref:p.ref, x:Number(p.x), y:Number(p.y), w:textWidthMm, h:textHeightMm }))];
  let maxDim=0; for(const e of entries){ if(Number(e.w)>maxDim) maxDim=Number(e.w); if(Number(e.h)>maxDim) maxDim=Number(e.h); }
  const index=makeGrid({ widthMm:0, heightMm:0, maxDim, gridMm:Math.max(textWidthMm,textHeightMm,Number.MIN_VALUE) });
  for(const f of forbidden){ if(Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y))) index.add({ ref:f.ref, x:Number(f.x), y:Number(f.y), w:Number(f.w), h:Number(f.h) }); }
  for(const p of placements) { const candidates=[[p.x,p.y-p.h/2-offsetMm],[p.x,p.y+p.h/2+offsetMm],[p.x-p.w/2-offsetMm-textWidthMm/2,p.y],[p.x+p.w/2+offsetMm+textWidthMm/2,p.y]].map(([x,y])=>({ref:p.ref,x,y,w:textWidthMm,h:textHeightMm})); const chosen=candidates.find((c)=>!(gridCandidates(index,c.x,c.y,c.w,c.h,SILKSCREEN_MARGIN) ?? [...forbidden,...labels]).some((f)=>overlap(c,f,SILKSCREEN_MARGIN))); if(chosen) { labels.push(chosen); index.add(chosen); } else findings.push(finding('SILKSCREEN_UNRESOLVED', `${p.ref}丝印没有无碰撞锚点`, `silkscreen.${p.ref}`)); }
  return { passed: findings.length===0, findings, labels };
}
