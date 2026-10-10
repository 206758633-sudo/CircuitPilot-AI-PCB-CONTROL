import { finding } from './stackup.mjs';
const overlap = (a,b,m=0) => a.x - a.w/2-m < b.x+b.w/2 && a.x+a.w/2+m > b.x-b.w/2 && a.y-a.h/2-m < b.y+b.h/2 && a.y+a.h/2+m > b.y-b.h/2;

const MAX_CANDIDATE_POINTS = 200_000;
const MAX_COMPONENTS = 1_000;
const MAX_BOARD_MM = 10_000;

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
  for (const component of components) {
    const width = Number(component.widthMm); const height = Number(component.heightMm);
    const base = { ref: component.ref, w: Number.isFinite(width) && width > 0 ? width : 1, h: Number.isFinite(height) && height > 0 ? height : 1, rotation: Number(component.rotation || 0), role: component.role || 'general' };
    const candidates = component.fixed ? [{ x: Number(component.xMm), y: Number(component.yMm) }] : candidatePoints(component, board, grid);
    const valid = candidates.filter((p) => p.x-base.w/2 >= clearance && p.y-base.h/2 >= clearance && p.x+base.w/2 <= board.widthMm-clearance && p.y+base.h/2 <= board.heightMm-clearance && !placed.some((q) => overlap({ ...base,...p },q,clearance)));
    if (!valid.length) { findings.push(finding('LAYOUT_UNRESOLVED', `${component.ref}没有满足硬约束的位置`, `components.${component.ref}`)); continue; }
    const scored = valid.map((p) => ({ ...p, score: layoutScore(component,p,placed,board) })).sort((a,b) => a.score-b.score || a.x-b.x || a.y-b.y)[0]; placed.push({ ...base,...scored });
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
  for(const p of placements) { const candidates=[[p.x,p.y-p.h/2-offsetMm],[p.x,p.y+p.h/2+offsetMm],[p.x-p.w/2-offsetMm-textWidthMm/2,p.y],[p.x+p.w/2+offsetMm+textWidthMm/2,p.y]].map(([x,y])=>({ref:p.ref,x,y,w:textWidthMm,h:textHeightMm})); const chosen=candidates.find((c)=>![...forbidden,...labels].some((f)=>overlap(c,f,0.1))); if(chosen) labels.push(chosen); else findings.push(finding('SILKSCREEN_UNRESOLVED', `${p.ref}丝印没有无碰撞锚点`, `silkscreen.${p.ref}`)); }
  return { passed: findings.length===0, findings, labels };
}
