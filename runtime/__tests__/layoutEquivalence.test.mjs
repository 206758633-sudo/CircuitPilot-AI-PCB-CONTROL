// 布局求解器的“加速等价性”回归测试。
//
// 背景：runtime/engineering/layout.mjs 的碰撞检测从“逐个扫描已放置器件”（O(n²)）
// 改成了空间哈希网格索引。这是一次纯粹的性能优化，因此验收标准不是“看起来更快”，
// 而是**逐字节等价**：任何输入下网格版与暴力版必须给出完全相同的
// placements / findings / score / passed。
//
// 本文件里的 solveLayoutReference 是优化前那一版的逐字复制（见 git HEAD 的旧实现），
// 作为地面真值使用。若两者出现分歧，说明网格漏掉了候选器件（漏检碰撞），属于安全缺陷。
import assert from 'node:assert/strict';
import test from 'node:test';
import { placeSilkscreen, solveLayout } from '../engineering/layout.mjs';
import { finding } from '../engineering/stackup.mjs';

// ---- 以下是优化前暴力实现的逐字复制（地面真值） ----
const refOverlap = (a, b, m = 0) => a.x - a.w / 2 - m < b.x + b.w / 2 && a.x + a.w / 2 + m > b.x - b.w / 2 && a.y - a.h / 2 - m < b.y + b.h / 2 && a.y + a.h / 2 + m > b.y - b.h / 2;
const REF_MAX_CANDIDATE_POINTS = 200_000;
const REF_MAX_COMPONENTS = 1_000;
const REF_MAX_BOARD_MM = 10_000;

function solveLayoutReference(input = {}) {
  const rawBoard = input.board || {};
  const widthMm = Number(rawBoard.widthMm); const heightMm = Number(rawBoard.heightMm);
  const board = { ...rawBoard, widthMm, heightMm };
  const placed = []; const findings = [];
  if (!(widthMm > 0) || !(heightMm > 0) || widthMm > REF_MAX_BOARD_MM || heightMm > REF_MAX_BOARD_MM) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `板框尺寸必须是0到${REF_MAX_BOARD_MM}mm之间的有限正数`, 'board')], placements: [], score: 0, deterministic: true };
  const components = [...(input.components || [])];
  if (components.length > REF_MAX_COMPONENTS) return { passed: false, findings: [finding('LAYOUT_INPUT_INVALID', `器件数量超过上限${REF_MAX_COMPONENTS}`, 'components')], placements: [], score: 0, deterministic: true };
  const requestedGrid = Number(input.gridMm); const grid = Number.isFinite(requestedGrid) && requestedGrid >= 0.05 ? requestedGrid : 0.5;
  const requestedClearance = Number(input.clearanceMm); const clearance = Number.isFinite(requestedClearance) && requestedClearance >= 0 ? requestedClearance : 0.5;
  components.sort((a, b) => Number(Boolean(b.fixed)) - Number(Boolean(a.fixed)) || String(a.ref).localeCompare(String(b.ref)));
  for (const component of components) {
    const width = Number(component.widthMm); const height = Number(component.heightMm);
    const base = { ref: component.ref, w: Number.isFinite(width) && width > 0 ? width : 1, h: Number.isFinite(height) && height > 0 ? height : 1, rotation: Number(component.rotation || 0), role: component.role || 'general' };
    const candidates = component.fixed ? [{ x: Number(component.xMm), y: Number(component.yMm) }] : refCandidatePoints(component, board, grid);
    const valid = candidates.filter((p) => p.x - base.w / 2 >= clearance && p.y - base.h / 2 >= clearance && p.x + base.w / 2 <= board.widthMm - clearance && p.y + base.h / 2 <= board.heightMm - clearance && !placed.some((q) => refOverlap({ ...base, ...p }, q, clearance)));
    if (!valid.length) { findings.push(finding('LAYOUT_UNRESOLVED', `${component.ref}没有满足硬约束的位置`, `components.${component.ref}`)); continue; }
    const scored = valid.map((p) => ({ ...p, score: refLayoutScore(component, p, placed, board) })).sort((a, b) => a.score - b.score || a.x - b.x || a.y - b.y)[0]; placed.push({ ...base, ...scored });
  }
  return { passed: findings.length === 0 && placed.length === components.length, findings, placements: placed, score: placed.reduce((s, p) => s + p.score, 0), deterministic: true };
}
function refCandidatePoints(c, b, g) {
  const region = c.region || { xMin: g, yMin: g, xMax: b.widthMm - g, yMax: b.heightMm - g };
  const xMin = Number(region.xMin), yMin = Number(region.yMin), xMax = Number(region.xMax), yMax = Number(region.yMax);
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax < xMin || yMax < yMin) return [];
  const columns = Math.floor((xMax - xMin) / g) + 1, rows = Math.floor((yMax - yMin) / g) + 1;
  if (!(columns > 0) || !(rows > 0) || columns * rows > REF_MAX_CANDIDATE_POINTS) return [];
  const out = []; for (let y = yMin; y <= yMax; y += g) for (let x = xMin; x <= xMax; x += g) out.push({ x, y }); return out;
}
function refLayoutScore(c, p, placed, b) { let score = Math.abs(p.x - b.widthMm / 2) + Math.abs(p.y - b.heightMm / 2); if (c.role === 'edge-connector') score = Math.min(p.x, b.widthMm - p.x, p.y, b.heightMm - p.y) * 100; for (const target of Array.isArray(c.near) ? c.near : []) { const q = placed.find((v) => v.ref === target); if (q) score += Math.hypot(p.x - q.x, p.y - q.y) * 10; } return score; }
// ---- 暴力参考实现结束 ----

/** 确定性 PRNG：失败可复现，不依赖 Math.random。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

function makeRandomInput(rand, round) {
  // 板框尺寸跨度很大：小到放不下器件，大到 10_000mm 上限附近。
  const widthMm = pick(rand, [8, 20, 50, 120, 400, 3000]);
  const heightMm = pick(rand, [8, 20, 50, 120, 400, 3000]);
  const count = Math.floor(rand() * 10);
  const components = [];
  for (let i = 0; i < count; i++) {
    const fixed = rand() < 0.25;
    const component = {
      ref: `R${String.fromCharCode(65 + i)}`,
      widthMm: pick(rand, [0.5, 1, 3, 8, 25, 60]),
      heightMm: pick(rand, [0.5, 1, 3, 8, 25, 60]),
      role: pick(rand, ['general', 'edge-connector', 'connector']),
      near: rand() < 0.3 ? [`R${String.fromCharCode(65 + Math.floor(rand() * Math.max(1, i)))}`] : undefined,
    };
    if (fixed) { component.fixed = true; component.xMm = rand() * widthMm; component.yMm = rand() * heightMm; }
    if (rand() < 0.25) component.region = { xMin: rand() * widthMm, yMin: rand() * heightMm, xMax: rand() * widthMm, yMax: rand() * heightMm };
    components.push(component);
  }
  return {
    // 第 0 轮刻意给极端 clearance/gridMm：间隙远大于器件与网格是网格漏检的高危组合。
    board: { widthMm, heightMm },
    gridMm: round === 0 ? 10 : pick(rand, [0.5, 1, 2, 5, 10, 25]),
    clearanceMm: round === 0 ? 40 : pick(rand, [0, 0.5, 1, 3, 10, 30, 80]),
    components,
  };
}

test('网格索引与暴力扫描在 300 组随机输入上逐字节等价', () => {
  for (let round = 0; round < 300; round++) {
    // 每轮用独立且确定的种子重建两份完全相同的输入副本，确保两边拿到同一输入。
    const actualInput = makeRandomInput(mulberry32(0x5eed17 + round), round);
    const expectedInput = makeRandomInput(mulberry32(0x5eed17 + round), round);
    assert.deepEqual(solveLayout(actualInput), solveLayoutReference(expectedInput), `第 ${round} 轮出现分歧`);
  }
});

test('大间隙（clearance 远大于器件与网格边长）不会漏检碰撞', () => {
  // 为什么必须用这块“大板”：网格的格子边长 = max(gridMm, 最大器件边长) * budget，
  // 而 budget 是按 MAX_GRID_CELLS 预算放大的。小板（如 200×200）算出来 budget≈95，
  // 格子边长高达 950mm，所有器件都落进同一格，反而掩盖了漏检。
  // 只有格子边长真正退化到基准值（budget=1）时，漏检才会暴露：
  // 板 10000×10000、器件 5×5、gridMm=5 → cell=5（10000/5 的格数刚好撞上 4_000_000 预算）。
  // A 放在 (105,5000) 会真正写入网格第 21 格；B 放在 (195,5000)，
  // 与 A 中心距 90mm < (5+5)/2+100 = 105mm，按 clearance 判定确实冲突，
  // 但 B 的查询只覆盖第 37~40 格 —— 不按 clearance 外扩就会漏掉第 21 格里的 A。
  const build = () => ({
    board: { widthMm: 10_000, heightMm: 10_000 },
    gridMm: 5,
    clearanceMm: 100,
    components: [
      { ref: 'A', widthMm: 5, heightMm: 5, fixed: true, xMm: 105, yMm: 5000 },
      { ref: 'B', widthMm: 5, heightMm: 5, fixed: true, xMm: 195, yMm: 5000 },
    ],
  });
  const expected = solveLayoutReference(build());
  // 先确认这个用例真的在检验东西：参考实现必须判定 B 与 A 冲突。
  assert.equal(expected.passed, false);
  assert.deepEqual(expected.findings.map((item) => item.code), ['LAYOUT_UNRESOLVED']);
  assert.equal(expected.placements.length, 1);
  assert.deepEqual(solveLayout(build()), expected, '网格索引漏掉了 clearance 范围内的冲突器件');
});

test('网格加速在规模上仍然可用（150 器件全部落位）', () => {
  const components = [];
  for (let i = 0; i < 150; i++) components.push({ ref: `U${i}`, widthMm: 2, heightMm: 1.5, role: 'general' });
  const started = Date.now();
  const result = solveLayout({ board: { widthMm: 300, heightMm: 300 }, gridMm: 5, clearanceMm: 0.3, components });
  const elapsed = Date.now() - started;
  assert.equal(result.passed, true);
  assert.equal(result.placements.length, 150);
  // 宽松上限：只用来拦住 O(n²) 级别的爆炸，不做性能断言（避免在慢机器上变成随机失败）。
  assert.ok(elapsed < 15_000, `应能在一段合理时间内完成，实际 ${elapsed}ms`);
});



test('随机等价性：同一输入重复求解结果稳定', () => {
  const build = () => makeRandomInput(mulberry32(0xabcdef), 1);
  assert.deepEqual(solveLayout(build()), solveLayout(build()));
});

// 丝印放置同样换成了网格索引（runtime/engineering/engine.mjs 会调用它，属于出厂路径），
// 因此同样需要“加速前后逐字节等价”的证明。
function placeSilkscreenReference({ placements = [], forbidden = [], textWidthMm = 3, textHeightMm = 1, offsetMm = 1 }) {
  const labels = []; const findings = [];
  for (const p of placements) {
    const candidates = [[p.x, p.y - p.h / 2 - offsetMm], [p.x, p.y + p.h / 2 + offsetMm], [p.x - p.w / 2 - offsetMm - textWidthMm / 2, p.y], [p.x + p.w / 2 + offsetMm + textWidthMm / 2, p.y]].map(([x, y]) => ({ ref: p.ref, x, y, w: textWidthMm, h: textHeightMm }));
    const chosen = candidates.find((c) => ![...forbidden, ...labels].some((f) => refOverlap(c, f, 0.1)));
    if (chosen) labels.push(chosen); else findings.push(finding('SILKSCREEN_UNRESOLVED', `${p.ref}丝印没有无碰撞锚点`, `silkscreen.${p.ref}`));
  }
  return { passed: findings.length === 0, findings, labels };
}

test('丝印放置的网格索引与暴力扫描等价', () => {
  for (let round = 0; round < 200; round++) {
    const build = () => {
      const rand = mulberry32(0x51c0 + round);
      const placements = []; const forbidden = [];
      const count = Math.floor(rand() * 8);
      for (let i = 0; i < count; i++) placements.push({ ref: `R${i}`, x: pick(rand, [5, 10, 30, 100, 500, 9000]), y: pick(rand, [5, 10, 30, 100, 500, 9000]), w: pick(rand, [1, 2, 5, 40]), h: pick(rand, [0.5, 1, 3, 20]) });
      for (let i = 0; i < Math.floor(rand() * 4); i++) forbidden.push({ ref: `F${i}`, x: pick(rand, [4, 11, 31, 101]), y: pick(rand, [6, 9, 29, 99]), w: pick(rand, [1, 3, 12]), h: pick(rand, [1, 2, 9]) });
      return { placements, forbidden, textWidthMm: pick(rand, [1, 3, 12]), textHeightMm: pick(rand, [0.5, 1, 5]), offsetMm: pick(rand, [0, 0.5, 1, 5]) };
    };
    assert.deepEqual(placeSilkscreen(build()), placeSilkscreenReference(build()), `丝印第 ${round} 轮出现分歧`);
  }
});

