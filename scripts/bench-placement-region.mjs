#!/usr/bin/env node
/**
 * 布局候选点规模基准（无 EDA、无网络、确定性）。
 *
 * 背景：300×200mm 的普通板在 0.5mm 网格上有约 24 万个候选点。旧实现给每个器件都
 * 先铺满整板再按上限判失败，导致"整板一个器件都放不下"；本脚本固定同一块板/同一组
 * 区域，输出放置数、耗时与告警数，方便改布局算法后对比是否退化。
 *
 * 用法：
 *   node scripts/bench-placement-region.mjs
 *   node scripts/bench-placement-region.mjs --components 200
 */
import { planOutlinePlacement } from '../runtime/placement.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const componentCount = Math.max(1, Math.floor(Number(args.get('--components')) || 120));

const outline = { points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }], closed: true };
const components = Array.from({ length: componentCount }, (_, index) => ({
  ref: `U${index + 1}`,
  primitiveId: `p${index}`,
  widthMm: 5,
  heightMm: 5,
  current: { xMm: 20 + (index % 10) * 20, yMm: 20 + Math.floor(index / 10) * 15, rotationDeg: 0 },
  side: 'top',
  // 每个功能块区域固定 35×90mm：在板内，但整板候选数远超 maxCandidates。
  region: { xMinMm: 10 + (index % 5) * 40, yMinMm: 10, xMaxMm: 45 + (index % 5) * 40, yMaxMm: 100 },
}));

const started = performance.now();
const plan = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
const elapsedMs = Math.round(performance.now() - started);

console.log(JSON.stringify({
  board: '300x200mm',
  gridMm: 0.5,
  componentCount,
  placed: plan.placements.length,
  unplaced: plan.unplaced.length,
  unplacedReasons: [...new Set(plan.unplaced.map((item) => item.reason))],
  elapsedMs,
  coarsened: plan.findings.some((item) => item.code === 'PLACEMENT_CANDIDATE_GRID_COARSENED'),
  ok: plan.ok,
}, null, 2));
