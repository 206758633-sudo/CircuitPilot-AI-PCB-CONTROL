/**
 * PCBA 布局规则引擎的样板输入（fixture）
 *
 * 两个样板都来自真实评审（docs/pcb-layout/01-布局诊断.md 与 02 号文档 §5 的裁定值）：
 *   - defectiveTestBoard(): 2026-10-18 3D 渲染图对应的现状板（≈70×48 mm）。
 *     数值由图像目视量测（≈24 px/mm，±10%），只用于证明"规则能接住已知缺陷"，
 *     不得当作 EDA 实测值使用。
 *   - rectifiedTestBoard(): 按 02 §5.1/§5.2 裁定值收敛后的骨架（板框加大到 80×55 mm），
 *     用于证明同一套规则在改图后可以被满足（否则规则就是不可执行的空话）。
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const courtyard = 0.25;

const DOC_FILES = ['02-设计规则A-机械占位连接器RF.md', '03-设计规则B-电气丝印制造装配.md'];
function docHashes() {
  const hashes = {};
  for (const file of DOC_FILES) {
    try {
      hashes[file] = crypto.createHash('sha256').update(readFileSync(new URL(`../../../docs/pcb-layout/${file}`, import.meta.url))).digest('hex');
    } catch { hashes[file] = '0'.repeat(64); }
  }
  return hashes;
}
const hex64 = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

/** 交付链（PRJ 组）的样板输入：complete=false 复现真机上的三个硬伤（重复图纸/规则分叉/缺 Gerber）。 */
function projectHealth({ complete = true } = {}) {
  const designs = [
    { id: 'P1', name: 'P1 电源输入与保护', kind: 'SCHEMATIC', refs: ['CN1', 'CN2', 'CN3'] },
    { id: 'P2', name: 'P2 功率开关', kind: 'SCHEMATIC', refs: ['Q5', 'Q6', 'L1'] },
    { id: 'P6', name: 'P6 充电', kind: 'SCHEMATIC', refs: ['U9', 'J7', 'J8', 'C39', 'L2'] },
  ];
  const boards = complete
    ? [{ id: 'PCB1', name: 'PCB1', primary: true, pcbUuid: '9ab008aa6dfb92c2' }]
    : [
      { id: 'PCB1', name: 'PCB1', primary: true, pcbUuid: '9ab008aa6dfb92c2' },
      { id: 'PCB1_1', name: 'PCB1_1', primary: true, pcbUuid: '084751e2c073fcf2' },
    ];
  if (!complete) designs.push({ id: 'P6-old', name: 'P6 充电', kind: 'SCHEMATIC', refs: ['J7', 'J8', 'L2'] });
  const deliverables = complete
    ? [
      { kind: 'GERBER', path: 'artifacts/final-5v-chg/gerber/DBTS-A01-Gerber.zip', sha256: hex64('gerber'), issuedAt: '2026-10-29T15:30:00.000Z', passed: true },
      { kind: 'BOM', path: 'artifacts/final-5v-chg/BOM_DBTS-A01_5V_外置充电模块.xlsx', sha256: hex64('bom'), issuedAt: '2026-10-29T15:30:00.000Z', passed: true },
      { kind: 'DRC', path: 'artifacts/final-5v-chg/drc-final.json', sha256: hex64('drc'), issuedAt: '2026-10-29T15:20:00.000Z', passed: true },
      { kind: 'DFM', path: 'artifacts/final-5v-chg/dfm-final.txt', sha256: hex64('dfm'), issuedAt: '2026-10-29T15:20:00.000Z', passed: true },
      { kind: 'NETLIST', path: 'artifacts/final-5v-chg/net-report.json', sha256: hex64('netlist'), issuedAt: '2026-10-29T15:20:00.000Z', passed: true },
      { kind: 'STEP3D', path: 'artifacts/final-5v-chg/DBTS-A01-装配区高度复核.png', sha256: hex64('step3d'), issuedAt: '2026-10-29T15:40:00.000Z', passed: true },
    ]
    : [
      { kind: 'BOM', path: 'artifacts/final-5v-chg/BOM_DBTS-A01_5V_外置充电模块.xlsx', sha256: hex64('bom'), issuedAt: '2026-10-29T15:30:00.000Z', passed: true },
      { kind: 'DRC', path: 'artifacts/final-5v-chg/drc-final.json', sha256: hex64('drc'), issuedAt: '2026-10-29T15:20:00.000Z', passed: true },
      { kind: 'DFM', path: 'artifacts/final-5v-chg/dfm-final.txt', sha256: hex64('dfm'), issuedAt: '2026-10-29T15:20:00.000Z', passed: true },
      { kind: 'STEP3D', path: 'artifacts/final-5v-chg/DBTS-A01-装配区高度复核.png', sha256: hex64('step3d'), issuedAt: '2026-10-29T15:40:00.000Z', passed: true },
    ];
  return {
    project: { designs, boards },
    docs: complete
      ? { packHash: hex64('pack'), docHashes: docHashes(), generatedFrom: 'scripts/build-rule-json.py' }
      : { packHash: hex64('pack'), docHashes: Object.fromEntries(DOC_FILES.map((file) => [file, '0'.repeat(64)])), generatedFrom: '手工维护的 JSON' },
    deliverables,
    stageGates: complete
      ? { postRouteChecked: true, equivalentEvidence: [] }
      : { postRouteChecked: false, equivalentEvidence: ['DRC', 'DFM', 'NETLIST'] },
    records: complete
      ? [{ file: 'projects/dual-battery-tsb/README.md', updatedAt: '2026-10-29T16:20:00.000Z', numbers: { components: 99, tracks: 1267, vias: 207, dfmWarn: 149 } }]
      : [{ file: 'projects/dual-battery-tsb/README.md', updatedAt: '2026-10-28T20:00:00.000Z', numbers: { components: 98, tracks: 1240, vias: 203, dfmWarn: 146 } }],
    latestSnapshot: { updatedAt: '2026-10-29T15:20:00.000Z', numbers: { components: 99, tracks: 1267, vias: 207, dfmWarn: 149 } },
    inferredParts: complete
      ? [{ ref: 'J7/J8', what: '充电模块 6 脚信号分配', inferred: true, safeDefault: 'J12 默认开路，6S 电池不经模块', verifySteps: ['万用表通断逐脚核对', '空载上电测 27 V 与 25.2 V'] }]
      : [{ ref: 'J7/J8', what: '充电模块 6 脚信号分配', inferred: true, safeDefault: '', verifySteps: [] }],
  };
}
const cap = (ref, x, y) => ({ ref, x, y, widthMm: 1.0, heightMm: 0.5, packageClass: '0402', courtyardMm: courtyard, heightMm3d: 0.5 });

/** 现状板：把 13 处已确认缺陷编码进去，规则引擎应当判出 blocking。 */
export function defectiveTestBoard() {
  return {
    ...projectHealth({ complete: false }),
    board: {
      widthMm: 70, heightMm: 48, thicknessMm: 1.6, cornerRadiusMm: 0.4, outlineClosed: true,
      processEdgeMm: 0, panelized: false, warpPercent: 0.4,
      padToEdgeMm: 0.2, copperToEdgeMm: 0.2,
      fiducials: [], toolingHoles: [], mountingHoles: [],
    },
    directionClassLimit: 2,
    components: [
      // U4 模组：天线端朝上（+y），指向板内 —— RF-01 的根因
      { ref: 'U4', x: 44, y: 26, widthMm: 18, heightMm: 25.5, heightMm3d: 3.2, packageClass: 'MODULE', courtyardMm: courtyard, antenna: { endDir: '+y' } },
      // J52：越上板边 2 mm，翻盖前方无空间
      { ref: 'J52', x: 9.5, y: 47, widthMm: 17, heightMm: 6, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '+y', overhangMm: 1.6, plugClearanceMm: 0, cableKeepout: false, massG: 1, pin1Marked: false } },
      // 顶部 Type-C：与模组天线端（y=38.75）几乎相接
      { ref: 'U1', x: 44, y: 41.5, widthMm: 8.94, heightMm: 7.35, heightMm3d: 3.1, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'USB-C', openingDir: '+y', overhangMm: 0.3, plugClearanceMm: 12, cableKeepout: false, massG: 1.8, pin1Marked: true } },
      // 模组三面邻件：U5（SOT-23-6）、Q1（SOT-23-3）、U10（QFN）
      { ref: 'U5', x: 34, y: 37.5, widthMm: 2.9, heightMm: 2.8, heightMm3d: 1.1, packageClass: 'SOT-23', courtyardMm: courtyard },
      { ref: 'Q1', x: 40, y: 39.5, widthMm: 2.9, heightMm: 2.8, heightMm3d: 1.0, packageClass: 'SOT-23', courtyardMm: courtyard },
      { ref: 'U10', x: 55.5, y: 30, widthMm: 5, heightMm: 5, heightMm3d: 0.9, packageClass: 'QFN', courtyardMm: courtyard },
      // USB1：斜置 25°、越下板边 1 mm、后方 0402 阵列紧贴
      { ref: 'USB1', x: 8, y: 2, widthMm: 13, heightMm: 6, heightMm3d: 6.2, packageClass: 'USB', courtyardMm: courtyard,
        conn: { kind: 'USB-A', openingDir: '-y', openingNormalityDeg: 25, overhangMm: 0.2, plugClearanceMm: 11, cableKeepout: false, massG: 5, reinforced: false, pin1Marked: true } },
      cap('C1', 8, 5.8),
      // 右下两个 FFC 开口相对、净距 2 mm
      { ref: 'FFC-1', x: 45, y: 3, widthMm: 25, heightMm: 6, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '-y', overhangMm: 0, plugClearanceMm: 0, cableKeepout: false, massG: 1, pin1Marked: false } },
      { ref: 'FFC-2', x: 45, y: 11, widthMm: 25, heightMm: 6, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '+y', overhangMm: 0, plugClearanceMm: 0, cableKeepout: false, massG: 1, pin1Marked: false } },
      // 左侧 J7 与 J1 互相穿插
      { ref: 'J7', x: 2, y: 24, widthMm: 6, heightMm: 8, heightMm3d: 5.0, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'JST', openingDir: '-x', plugClearanceMm: 4, cableKeepout: false, massG: 1, pin1Marked: false, pressClearanceMm: 1 } },
      { ref: 'J1', x: 2, y: 18, widthMm: 6, heightMm: 8, heightMm3d: 5.0, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'JST', openingDir: '-x', plugClearanceMm: 4, cableKeepout: false, massG: 1, pin1Marked: false, pressClearanceMm: 1 } },
      // 电感紧邻未来的天线区；开关挤在模组旁
      { ref: 'L2', x: 60, y: 42, widthMm: 6, heightMm: 6, heightMm3d: 3.5, packageClass: 'INDUCTOR', courtyardMm: courtyard, isNoiseSource: true },
      { ref: 'SW1', x: 58, y: 20, widthMm: 6, heightMm: 6, heightMm3d: 2.0, packageClass: 'SWITCH', courtyardMm: courtyard },
      { ref: 'SW2', x: 66, y: 20, widthMm: 6, heightMm: 6, heightMm3d: 2.0, packageClass: 'SWITCH', courtyardMm: courtyard },
      { ref: 'LED5', x: 18, y: 20, widthMm: 1.6, heightMm: 0.8, heightMm3d: 0.8, packageClass: '0402', courtyardMm: courtyard },
      // 去耦电容散落在板面中左部，离模组电源脚十几毫米
      cap('C62', 20, 8), cap('C63', 21.6, 8), cap('C75', 23.2, 8), cap('C78', 24.8, 8),
    ],
    rf: {
      componentRef: 'U4', overhangMm: 0,
      keepout: { x0: 35, y0: 38.75, x1: 53, y1: 52 },
      copperInKeepout: true, metalRefs: ['U1'], viaFencePitchMm: 6,
      gndCoveragePercent: 85, noiseSourcesNearAntenna: ['L2'],
      maskOpeningInKeepout: false, silkInKeepout: true, viasInKeepout: false,
    },
    silk: {
      items: [
        { ref: 'R59', gapToPadMm: -0.2, onPadRefs: ['R59'] },
        { ref: 'LED5', gapToPadMm: 0.05, onPadRefs: ['LED5'] },
        { ref: 'UR52-C15', gapToPadMm: 0.3, outsideBoard: true },
      ],
      textHeights: [0.9, 0.9, 0.7], minCharGapMm: 0.1, overlappingPadCount: 4, strayLineCount: 2, runsOffBoard: true,
    },
    power: {
      nets: [{ net: 'VBUS', currentA: 3, widthMm: 0.4, layer: 'outer' }],
      decoupling: [
        { capRef: 'C62', icRef: 'U4-3V3', distanceMm: 12.5, icClass: 'MODULE' },
        { capRef: 'C63', icRef: 'U4-3V3', distanceMm: 13.1, icClass: 'MODULE' },
        { capRef: 'C75', icRef: 'U4-3V3', distanceMm: 14.0, icClass: 'MODULE' },
        { capRef: 'C78', icRef: 'U4-3V3', distanceMm: 15.2, icClass: 'MODULE' },
      ],
      paths: [{ net: 'VBUS', peakCurrentA: 3, designedForA: 3 }],
    },
    testPoints: [],
    requiredNets: ['VBUS', '3V3', 'GND', 'EN', 'IO0', 'TXD', 'RXD'],
    switches: [{ ref: 'SW1', clearanceMm: 5 }, { ref: 'SW2', clearanceMm: 5 }],
  };
}

/** 整改后骨架：板框加大到 80×55 mm，出线方向 3 类（已记录 ECO 降级）。 */
export function rectifiedTestBoard() {
  return {
    ...projectHealth({ complete: true }),
    board: {
      widthMm: 80, heightMm: 55, thicknessMm: 1.6, cornerRadiusMm: 2.0, outlineClosed: true,
      processEdgeMm: 5, panelized: true, warpPercent: 0.4,
      padToEdgeMm: 0.5, copperToEdgeMm: 0.5,
      fiducials: [
        { x: 4, y: 4, diaMm: 1.0, maskDiaMm: 2.0 }, { x: 76, y: 4, diaMm: 1.0, maskDiaMm: 2.0 },
        { x: 4, y: 51, diaMm: 1.0, maskDiaMm: 2.0 }, { x: 76, y: 51, diaMm: 1.0, maskDiaMm: 2.0 },
      ],
      toolingHoles: [{ x: 40, y: -2.4, diaMm: 3.2 }, { x: 40, y: 57.4, diaMm: 3.2 }],
      mountingHoles: [{ x: 8, y: 8, diaMm: 2.2 }, { x: 72, y: 8, diaMm: 2.2 }, { x: 8, y: 47, diaMm: 2.2 }, { x: 72, y: 47, diaMm: 2.2 }],
      vCutLines: [],
    },
    directionClassLimit: 2, directionClassDegradationApproved: true,
    changes: [], nets: [],
    components: [
      // 模组右上角，天线端朝右板边（+x）并伸出 2.25 mm
      { ref: 'U4', x: 69.5, y: 45.5, widthMm: 25.5, heightMm: 18, heightMm3d: 3.2, packageClass: 'MODULE', courtyardMm: courtyard, antenna: { endDir: '+x' } },
      // 上板边：J52 → Type-C → J7，全部 +Y 朝上
      { ref: 'J52', x: 12, y: 52, widthMm: 17, heightMm: 6, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '+y', overhangMm: 0, plugClearanceMm: 8, cableKeepout: true, massG: 1, pin1Marked: true } },
      { ref: 'U1', x: 30.5, y: 51.325, widthMm: 8.94, heightMm: 7.35, heightMm3d: 3.1, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'USB-C', openingDir: '+y', overhangMm: 0.25, plugClearanceMm: 12, cableKeepout: true, massG: 1.8, pin1Marked: true } },
      { ref: 'J7', x: 44, y: 51, widthMm: 6, heightMm: 8, heightMm3d: 5.0, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'JST', openingDir: '+y', plugClearanceMm: 4, cableKeepout: true, massG: 1, pin1Marked: true, pressClearanceMm: 4 } },
      // 下板边：USB1 → FFC-1，全部 −Y 朝下
      { ref: 'USB1', x: 12, y: 3, widthMm: 13, heightMm: 6, heightMm3d: 6.2, packageClass: 'USB', courtyardMm: courtyard,
        conn: { kind: 'USB-A', openingDir: '-y', overhangMm: 0, plugClearanceMm: 11, cableKeepout: true, massG: 5, reinforced: true, pin1Marked: true } },
      { ref: 'FFC-1', x: 35, y: 3, widthMm: 25, heightMm: 6, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '-y', overhangMm: 0, plugClearanceMm: 8, cableKeepout: true, massG: 1, pin1Marked: true } },
      // 左板边：FFC-2（竖直）与 J1，全部 −X 朝左
      { ref: 'FFC-2', x: 3, y: 22, widthMm: 6, heightMm: 25, heightMm3d: 3.0, packageClass: 'FFC', courtyardMm: courtyard,
        conn: { kind: 'FFC', openingDir: '-x', overhangMm: 0, plugClearanceMm: 8, cableKeepout: true, massG: 1, pin1Marked: true } },
      { ref: 'J1', x: 3, y: 42, widthMm: 6, heightMm: 8, heightMm3d: 5.0, packageClass: 'CONNECTOR', courtyardMm: courtyard,
        conn: { kind: 'JST', openingDir: '-x', plugClearanceMm: 4, cableKeepout: true, massG: 1, pin1Marked: true, pressClearanceMm: 4 } },
      // 去耦：紧贴模组电源脚对侧（≤1.5 mm）
      cap('C62', 49, 40), cap('C63', 50.75, 40), cap('C75', 52.5, 40), cap('C78', 54.25, 40),
      // 电感与噪声源远离天线区
      { ref: 'L2', x: 72, y: 30, widthMm: 6, heightMm: 6, heightMm3d: 3.5, packageClass: 'INDUCTOR', courtyardMm: courtyard, isNoiseSource: false },
      { ref: 'SW1', x: 58, y: 18, widthMm: 6, heightMm: 6, heightMm3d: 2.0, packageClass: 'SWITCH', courtyardMm: courtyard },
      { ref: 'SW2', x: 66, y: 18, widthMm: 6, heightMm: 6, heightMm3d: 2.0, packageClass: 'SWITCH', courtyardMm: courtyard },
      { ref: 'LED5', x: 48, y: 10, widthMm: 1.6, heightMm: 0.8, heightMm3d: 0.8, packageClass: '0402', courtyardMm: courtyard },
    ],
    rf: {
      componentRef: 'U4', overhangMm: 2.25,
      keepout: { x0: 80, y0: 35, x1: 95, y1: 55 },
      copperInKeepout: false, metalRefs: [], viaFencePitchMm: 2.5, gndCoveragePercent: 95,
      noiseSourcesNearAntenna: [], maskOpeningInKeepout: false, silkInKeepout: false, viasInKeepout: false,
    },
    silk: {
      items: [{ ref: 'U4', gapToPadMm: 0.3, onPadRefs: [] }, { ref: 'J52', gapToPadMm: 0.3, onPadRefs: [] }],
      textHeights: [1.0, 1.0, 0.8], minCharGapMm: 0.2, overlappingPadCount: 0, strayLineCount: 0, runsOffBoard: false,
    },
    power: {
      nets: [{ net: 'VBUS', currentA: 3, widthMm: 2.0, layer: 'outer' }],
      decoupling: [
        { capRef: 'C62', icRef: 'U4-3V3', distanceMm: 1.2, icClass: 'MODULE' },
        { capRef: 'C63', icRef: 'U4-3V3', distanceMm: 1.3, icClass: 'MODULE' },
      ],
      paths: [{ net: 'VBUS', peakCurrentA: 3, designedForA: 4.5 }],
    },
    testPoints: [
      { ref: 'TP1', x: 20, y: 15, diaMm: 1.5, net: 'VBUS' }, { ref: 'TP2', x: 24, y: 15, diaMm: 1.5, net: '3V3' },
      { ref: 'TP3', x: 28, y: 15, diaMm: 1.5, net: 'GND' }, { ref: 'TP4', x: 32, y: 15, diaMm: 1.5, net: 'EN' },
      { ref: 'TP5', x: 36, y: 15, diaMm: 1.5, net: 'IO0' }, { ref: 'TP6', x: 20, y: 19, diaMm: 1.5, net: 'TXD' },
      { ref: 'TP7', x: 24, y: 19, diaMm: 1.5, net: 'RXD' }, { ref: 'TP8', x: 28, y: 19, diaMm: 1.5, net: 'GND' },
      { ref: 'TP9', x: 32, y: 19, diaMm: 1.5, net: 'GND' },
    ],
    requiredNets: ['VBUS', '3V3', 'GND', 'EN', 'IO0', 'TXD', 'RXD'],
    switches: [{ ref: 'SW1', clearanceMm: 9 }, { ref: 'SW2', clearanceMm: 9 }],
    evidence: {
      // 门禁证据必须带 provenance：source / artifactHash / issuedAt / scope。
      // 只有 {passed:true} 的裸布尔值会被规则引擎判 REVIEW（不能用一个布尔值放行）。
      step3d: { passed: true, artifact: 'STEP_rev-C', source: 'SolidWorks/STEP-Interference', artifactHash: 'a'.repeat(64), issuedAt: '2026-10-19T09:00:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      officialDrc: { passed: true, reportId: 'DRC-2026-1019-03', source: 'JLCEDA-DRC', artifactHash: 'b'.repeat(64), issuedAt: '2026-10-19T09:10:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      dfm: { passed: true, reportId: 'DFM-JLC-2026-1019', source: 'JLC-DFM', artifactHash: 'c'.repeat(64), issuedAt: '2026-10-19T09:20:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      dfa: { passed: true, reviewId: 'DFA-2026-1019', source: 'DFA-Review', artifactHash: 'd'.repeat(64), issuedAt: '2026-10-19T09:30:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      fai: { passed: true, lot: 'FAI-5pcs', source: 'FAI-Report', artifactHash: 'e'.repeat(64), issuedAt: '2026-10-19T09:40:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      eco: { lastChangeId: 'ECO-2026-1019-01', source: 'ECO-System', artifactHash: 'f'.repeat(64), issuedAt: '2026-10-19T09:50:00.000Z', scope: 'ESP32-TEST-BOARD-RECTIFIED/rev-C' },
      highSpeedImpedance: { defined: true },
    },
    dfm: { minTrackWidthMm: 0.15, minClearanceMm: 0.15 },
  };
}

/**
 * DBTS-A01 双电池无缝切换测试板：外置 6S 充电模块「排针对插装配区」真机案例。
 *
 * 数据全部来自 2026-10-29 的实板返工（EasyEDA readback ≈ mil→mm ×0.0254，y 轴向上取正）：
 *   - 装配区：x 60.81–110.82 / y 44.15–74.14 mm（= 2394–4363 / 1738–2919 mil），
 *     由 J7/J8 两组 1×6 排针（PZ254-1-06，排距 47.00 mm）直接对插模块，模块底面 8.5 mm。
 *   - 旧位：C39（Φ16 / 20 mm 铝电解）压在 L2（8.1 mm 功率电感）与 Q5、C40 上 → 2D 重叠 + 3D 实体互穿 + 模块压死。
 *   - 新位：C39 → (120.90, 16.76)、L2 → (119.38, 30.23)，均迁出装配区；SW_NODE 由 3.6 mm 拉长到 48.5 mm。
 *
 * before = 返工前（应判 ZCLR-03/05/07 + ZCLR-02 FAIL）；after = 返工后（净空闭环、搬迁已具名接受）。
 */
const dbtsAssemblyZone = {
  name: '充电模块(50×30mm)',
  kind: 'MODULE',
  rectMm: [60.81, 44.15, 110.82, 74.14],
  matingHeightMm: 8.5,
  clearanceMm: 0.5,
  sideClearanceMm: 2.0,
  sideMaxHeightMm: 2.0,
  allowedRefs: ['J7', 'J8'], // 排针本体：其高度就是插合高度
  source: 'PZ254-1-06 直接对插，模块 PCB 底面 8.5 mm（游标卡尺实测）',
};

function dbtsModuleBoard({ after = false, delivery = null } = {}) {
  const c39 = after
    ? { ref: 'C39', x: 120.9, y: 16.76 }
    : { ref: 'C39', x: 101.6, y: 67.31 };
  const l2 = after
    ? { ref: 'L2', x: 119.38, y: 30.23 }
    : { ref: 'L2', x: 98.93, y: 59.56 };
  const deliveryBlock = delivery === 'before'
    ? projectHealth({ complete: false })
    : delivery === 'after'
      ? projectHealth({ complete: true })
      : {};
  const board = {
    ...deliveryBlock,
    board: {
      widthMm: 130.5, heightMm: 88.5, thicknessMm: 1.6, cornerRadiusMm: 0, outlineClosed: true,
      processEdgeMm: 0, panelized: false, warpPercent: 0.3,
      padToEdgeMm: 1.2, copperToEdgeMm: 0.8,
      fiducials: [], toolingHoles: [], mountingHoles: [],
    },
    assemblyZones: [dbtsAssemblyZone],
    components: [
      { ...c39, widthMm: 16.26, heightMm: 16.26, heightMm3d: 25.0, packageClass: 'CAP_ELEC', courtyardMm: 0.25, electrolytic: true, device: 'CD11Z 63V1000uF' },
      { ...l2, widthMm: 8.89, heightMm: 8.38, heightMm3d: 8.1, packageClass: 'INDUCTOR', courtyardMm: 0.25, device: 'XAL8080-223MED 22uH' },
      { ref: 'Q5', x: 100.0, y: 61.0, widthMm: 10.0, heightMm: 6.5, heightMm3d: 2.3, packageClass: 'IC', courtyardMm: 0.25 },
      // 实板 bbox x 102.26–111.10 / y 73.26–80.16 mm（Φ6.3 SMD 铝电解 RVT 4.7µF/100V，本体高 7.7 mm，非 2.5 mm）
      { ref: 'C40', x: 106.68, y: 76.71, widthMm: 8.84, heightMm: 6.9, heightMm3d: 7.7, packageClass: 'CAP_ELEC', courtyardMm: 0.25, electrolytic: true, device: 'RVT4.7UF100V67RV0118' },
      // 实板 bbox x 69.52–77.20 / y 39.37–45.67 mm（SWPA6045 6.0 mm），下沿侵入装配区 1.52 mm
      { ref: 'L1', x: 73.36, y: 42.52, widthMm: 7.68, heightMm: 6.3, heightMm3d: 6.0, packageClass: 'INDUCTOR', courtyardMm: 0.25, device: 'SWPA6045S101MT' },
      { ref: 'J7', x: 109.22, y: 55.6, widthMm: 2.54, heightMm: 15.24, heightMm3d: 8.5, packageClass: 'CONNECTOR', courtyardMm: 0.25,
        conn: { kind: 'HEADER', openingDir: '+y', plugClearanceMm: 5, cableKeepout: false, massG: 2, reinforced: true, pin1Marked: true } },
      { ref: 'J8', x: 62.2, y: 55.6, widthMm: 2.54, heightMm: 15.24, heightMm3d: 8.5, packageClass: 'CONNECTOR', courtyardMm: 0.25,
        conn: { kind: 'HEADER', openingDir: '+y', plugClearanceMm: 5, cableKeepout: false, massG: 2, reinforced: true, pin1Marked: true } },
    ],
    nets: after
      ? [
        { net: 'SW_NODE', class: 'SW', lengthBeforeMm: 3.6, lengthAfterMm: 48.5, loopAreaBeforeMm2: 1.0, loopAreaAfterMm2: 38.0, approvedBy: '硬件负责人(2026-10-29)' },
        { net: 'CHG_VBUS', class: 'PWR', lengthBeforeMm: 12.0, lengthAfterMm: 32.2, approvedBy: '硬件负责人(2026-10-29)' },
        { net: 'EXT_48V', class: 'PWR', lengthBeforeMm: 20.0, lengthAfterMm: 49.5, approvedBy: '硬件负责人(2026-10-29)' },
      ]
      : [],
    changes: after
      ? [
        { ref: 'C39', from: { x: 101.6, y: 67.31 }, to: { x: 120.9, y: 16.76 }, reason: 'Φ16/20mm 电解落在充电模块装配区内，3D 实体压死 L2/Q5/C40', ecoId: 'ECO-2026-1029-01', approvedBy: ['硬件负责人'], zclrRechecked: true },
        { ref: 'L2', from: { x: 98.93, y: 59.56 }, to: { x: 119.38, y: 30.23 }, reason: '8.1mm 功率电感在装配区内距模块底面仅 0.4mm，且被电解压住', ecoId: 'ECO-2026-1029-01', approvedBy: ['硬件负责人'], zclrRechecked: true },
      ]
      : [],
    previousPositions: after ? { C39: { x: 101.6, y: 67.31 }, L2: { x: 98.93, y: 59.56 } } : undefined,
    evidence: {
      step3d: { passed: true, artifact: 'DBTS-A01-rev-D.step', source: 'SolidWorks/STEP-Interference', artifactHash: 'd'.repeat(64), issuedAt: '2026-10-29T07:20:00.000Z', scope: 'DBTS-A01/rev-D 装配区:充电模块(50×30mm) C39/L2 迁出' },
      eco: { lastChangeId: 'ECO-2026-1029-01', source: 'ECO-System', artifactHash: 'f'.repeat(64), issuedAt: '2026-10-29T07:10:00.000Z', scope: 'DBTS-A01/rev-D' },
    },
  };
  return board;
}

export function dbtsModuleBoardBefore() { return dbtsModuleBoard({ after: false }); }
export function dbtsModuleBoardAfter() { return dbtsModuleBoard({ after: true }); }
/** 返工前：工程里还有重复旧图纸与备用板、规则包与文档分叉、Gerber 缺失 → GATE-10 FAIL。 */
export function dbtsDeliveryBefore() { return dbtsModuleBoard({ after: false, delivery: 'before' }); }
/** 返工后：工程唯一、规则同源、6 类交付物齐备、门禁证据闭合 → GATE-10 PASS。 */
export function dbtsDeliveryAfter() { return dbtsModuleBoard({ after: true, delivery: 'after' }); }

export const LAYOUT_RULE_FIXTURES = Object.freeze({
  'ESP32-TEST-BOARD': defectiveTestBoard,
  'ESP32-TEST-BOARD-RECTIFIED': rectifiedTestBoard,
  'DBTS-A01-MODULE-BEFORE': dbtsModuleBoardBefore,
  'DBTS-A01-MODULE-AFTER': dbtsModuleBoardAfter,
  'DBTS-A01-DELIVERY-BEFORE': dbtsDeliveryBefore,
  'DBTS-A01-DELIVERY-AFTER': dbtsDeliveryAfter,
});

