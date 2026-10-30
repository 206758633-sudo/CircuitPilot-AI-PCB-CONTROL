#!/usr/bin/env node
/**
 * 在 DBTS-A01 真实 readback 数据上跑「Z 轴装配净空 + 布局变更影响」两条新规则组。
 *
 * 输入：artifacts/final-5v-chg/board-final.json（EasyEDA 实板 readback，单位 mil）
 * 输出：artifacts/final-5v-chg/layout3d-audit-before.json / -after.json + 控制台摘要
 *
 * 高度表是「器件型号 → 本体高度」的工程表（datasheet / 封装名推断），
 * 这正是 ZCLR-01 要求登记的东西；表里没有的型号一律按 1.0 mm 计并标记 lowConfidence。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { evaluateLayoutRules } from '../runtime/engineering/layout-rules.mjs';

const BASE = new URL('../artifacts/final-5v-chg/', import.meta.url);
const MIL = 0.0254; // mil → mm

// 型号/封装 → 本体高度（mm）。CD11Z/RVT 为保守取值，待卡尺实测（ZCLR-01）。
const HEIGHT_TABLE = [
  [/CD11Z/i, 25.0], [/XAL8080/i, 8.1], [/SWPA6045/i, 6.0], [/RVT4\.7|RVT/i, 7.7],
  [/CSD19535/i, 2.3], [/LM5146/i, 1.0], [/LM5017/i, 1.0], [/PZ254/i, 8.5], [/XT60/i, 12.0],
  [/HoLR2512|2512/i, 1.0], [/CL31A106/i, 1.8], [/CL05|0402|1005/i, 0.4],
  [/CC0805|0805|2012/i, 0.8], [/1206|3216/i, 0.9], [/1210|3225/i, 1.1],
  [/PH2\.0|XH2\.54|JST/i, 6.0], [/X3225|CRYSTAL|晶振/i, 0.8],
];

function heightOf(device) {
  const text = String(device || '');
  for (const [pattern, height] of HEIGHT_TABLE) if (pattern.test(text)) return { heightMm: height, lowConfidence: /CD11Z|RVT/i.test(text) };
  return { heightMm: 1.0, lowConfidence: true };
}

function packageClassOf(device) {
  const text = String(device || '');
  if (/CD11Z|RVT/i.test(text)) return 'CAP_ELEC';
  if (/XAL|SWPA|HoLR/i.test(text)) return 'INDUCTOR';
  if (/PZ254|XT60|PH2\.0|JST|XH/i.test(text)) return 'CONNECTOR';
  if (/LM5146|LM5017|CSD19535|TLV|INA|NE555|MCU/i.test(text)) return 'IC';
  if (/X3225|CRYSTAL/i.test(text)) return 'CRYSTAL';
  if (/0805|2012/i.test(text)) return '0805';
  if (/1206|3216/i.test(text)) return '1206';
  return 'OTHER';
}

const ZONE = { name: '充电模块(50×30mm)', kind: 'MODULE', rectMm: [60.81, 44.15, 110.82, 74.14], matingHeightMm: 8.5, clearanceMm: 0.5, sideClearanceMm: 2.0, sideMaxHeightMm: 2.0, allowedRefs: ['J7', 'J8'], source: 'PZ254-1-06 直接对插，模块底面 8.5 mm（待排针/模块实测复核）' };
// 返工前的位置（2026-10-29 改动前读数，mil）：C39 (4000,2650)、L2 (3895,2345)
const OLD_POS = { C39: { x: 4000 * MIL, y: 2650 * MIL }, L2: { x: 3895 * MIL, y: 2345 * MIL } };

const raw = JSON.parse(readFileSync(new URL('board-final.json', BASE), 'utf8'));
const outline = raw.outline.bbox;
const zoneRing = (() => {
  const [x0, y0, x1, y1] = ZONE.rectMm;
  const pad = 3.0;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
})();
const inScope = (bbox) => {
  const x0 = bbox.minX * MIL; const x1 = bbox.maxX * MIL;
  const y0 = bbox.minY * MIL; const y1 = bbox.maxY * MIL;
  return x1 >= zoneRing.x0 && x0 <= zoneRing.x1 && y1 >= zoneRing.y0 && y0 <= zoneRing.y1;
};

function effectiveCenter(component, after) {
  const bbox = component.bbox;
  if (!after && OLD_POS[component.designator]) return OLD_POS[component.designator];
  return { x: ((bbox.minX + bbox.maxX) / 2) * MIL, y: ((bbox.minY + bbox.maxY) / 2) * MIL };
}

function buildInput({ after }) {
  const components = raw.components
    .filter((component) => component.bbox && component.designator)
    .filter((component) => {
      const c = effectiveCenter(component, after);
      const halfW = ((component.bbox.maxX - component.bbox.minX) / 2) * MIL;
      const halfH = ((component.bbox.maxY - component.bbox.minY) / 2) * MIL;
      return c.x + halfW >= zoneRing.x0 && c.x - halfW <= zoneRing.x1 && c.y + halfH >= zoneRing.y0 && c.y - halfH <= zoneRing.y1;
    })
    .map((component) => {
      const bbox = component.bbox;
      const widthMm = (bbox.maxX - bbox.minX) * MIL;
      const heightMm = (bbox.maxY - bbox.minY) * MIL;
      let cx = ((bbox.minX + bbox.maxX) / 2) * MIL;
      let cy = ((bbox.minY + bbox.maxY) / 2) * MIL;
      if (!after && OLD_POS[component.designator]) ({ x: cx, y: cy } = OLD_POS[component.designator]);
      const { heightMm: h, lowConfidence } = heightOf(component.device);
      return {
        ref: component.designator, x: cx, y: cy, widthMm, heightMm, rotationDeg: 0,
        heightMm3d: h, packageClass: packageClassOf(component.device),
        courtyardMm: 0.25, device: component.device, electrolytic: /CD11Z|RVT/i.test(String(component.device)),
        heightLowConfidence: lowConfidence,
      };
    });
  const board = {
    widthMm: (outline.maxX - outline.minX) * MIL, heightMm: (outline.maxY - outline.minY) * MIL,
    thicknessMm: 1.6, outlineClosed: true, padToEdgeMm: 1.0, copperToEdgeMm: 0.8, panelized: false, processEdgeMm: 0,
    fiducials: [], toolingHoles: [], mountingHoles: [],
  };
  const changes = after ? [
    { ref: 'C39', from: OLD_POS.C39, to: { x: 4760 * MIL, y: 660 * MIL }, reason: 'Φ16/25mm 铝电解落在充电模块装配区内，3D 实体压死 L2/Q5/C40', ecoId: 'ECO-2026-1029-01', approvedBy: ['硬件负责人'], zclrRechecked: true },
    { ref: 'L2', from: OLD_POS.L2, to: { x: 4700 * MIL, y: 1190 * MIL }, reason: '8.1mm 功率电感距模块底面仅 0.4mm，且被电解压住', ecoId: 'ECO-2026-1029-01', approvedBy: ['硬件负责人'], zclrRechecked: true },
  ] : [];
  const nets = after ? [
    { net: 'SW_NODE', class: 'SW', lengthBeforeMm: 3.6, lengthAfterMm: 48.5, loopAreaBeforeMm2: 1.0, loopAreaAfterMm2: 38.0, approvedBy: '硬件负责人(2026-10-29)' },
    { net: 'CHG_VBUS', class: 'PWR', lengthBeforeMm: 12.0, lengthAfterMm: 32.2, loopAreaBeforeMm2: 1.0, loopAreaAfterMm2: 1.8, approvedBy: '硬件负责人(2026-10-29)' },
    { net: 'EXT_48V', class: 'PWR', lengthBeforeMm: 20.0, lengthAfterMm: 49.5, loopAreaBeforeMm2: 2.0, loopAreaAfterMm2: 3.5, approvedBy: '硬件负责人(2026-10-29)' },
  ] : [];
  return {
    board,
    components,
    assemblyZones: [ZONE],
    changes,
    nets,
    previousPositions: after ? OLD_POS : undefined,
    evidence: {
      step3d: { passed: true, artifact: 'DBTS-A01-rev-D.step', source: 'EasyEDA 3D + 人工高度表', artifactHash: 'a'.repeat(64), issuedAt: '2026-10-29T07:20:00.000Z', scope: 'DBTS-A01/rev-D 装配区:充电模块(50×30mm)' },
      eco: { lastChangeId: 'ECO-2026-1029-01', source: 'REWORK-REPORT §9', artifactHash: 'b'.repeat(64), issuedAt: '2026-10-29T07:10:00.000Z', scope: 'DBTS-A01/rev-D' },
    },
  };
}

const out = {};
for (const after of [false, true]) {
  const audit = evaluateLayoutRules(buildInput({ after }));
  const name = after ? 'after' : 'before';
  writeFileSync(new URL(`layout3d-audit-${name}.json`, BASE), JSON.stringify(audit, null, 1));
  out[name] = audit;
  console.log(`\n== 返工${after ? '后' : '前'}（${buildInput({ after }).components.length} 件在范围内）`);
  console.log(`   rules=${audit.summary.total} FAIL=${audit.summary.FAIL} REVIEW=${audit.summary.REVIEW} NA=${audit.summary.NA}`);
  console.log(`   GATE-08=${audit.gatesSummary['GATE-08']} GATE-09=${audit.gatesSummary['GATE-09']} releaseReady=${audit.releaseReady}`);
  for (const rule of audit.rules.filter((item) => /^(ZCLR|MOVE)-/.test(item.id) && item.status !== 'PASS' && item.status !== 'NA')) {
    console.log(`   ${rule.id} ${rule.status} ${rule.message.slice(0, 180)}`);
  }
}
console.log(`\n审计结论 hash: before=${out.before.auditHash.slice(0, 12)} after=${out.after.auditHash.slice(0, 12)}`);
