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

const courtyard = 0.25;
const cap = (ref, x, y) => ({ ref, x, y, widthMm: 1.0, heightMm: 0.5, packageClass: '0402', courtyardMm: courtyard, heightMm3d: 0.5 });

/** 现状板：把 13 处已确认缺陷编码进去，规则引擎应当判出 blocking。 */
export function defectiveTestBoard() {
  return {
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
      step3d: { passed: true, artifact: 'STEP_rev-C' },
      officialDrc: { passed: true, reportId: 'DRC-2026-1019-03' },
      dfm: { passed: true, reportId: 'DFM-JLC-2026-1019' },
      dfa: { passed: true, reviewId: 'DFA-2026-1019' },
      fai: { passed: true, lot: 'FAI-5pcs' },
      eco: { lastChangeId: 'ECO-2026-1019-01' },
      highSpeedImpedance: { defined: true },
    },
    dfm: { minTrackWidthMm: 0.15, minClearanceMm: 0.15 },
  };
}

export const LAYOUT_RULE_FIXTURES = Object.freeze({
  'ESP32-TEST-BOARD': defectiveTestBoard,
  'ESP32-TEST-BOARD-RECTIFIED': rectifiedTestBoard,
});
