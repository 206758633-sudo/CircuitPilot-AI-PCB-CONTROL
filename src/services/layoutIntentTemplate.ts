/**
 * 布局设计意图模板（UI 只负责“给人一个好起点”，不替人做事实声明）。
 *
 * 模板故意保留 `<J1>` / `<VBUS>` 这类占位符：直接提交会被运行时校验拒绝，
 * 不会因为“模板里有空数组”被误认为已经检查过。填多少、删哪些 section 由工程师决定；
 * 运行时仍然对缺失字段保持 REVIEW。
 */
export const LAYOUT_INTENT_TEMPLATE = {
  schemaVersion: 1,
  _instructions: [
    '把 <J1>/<U1>/<VBUS> 等占位符替换成板上的真实位号/网络；不用的 section 整段删掉。',
    'courtyardMm/heightMm3d 必须来自封装/3D，不知道就删掉，规则会保持 REVIEW。',
    'conn/antenna/esd/thermal/pdn/highSpeed/clearance 等是“设计事实”，不要用猜测值填。',
  ],
  components: {
    '<J1>': {
      courtyardMm: 0.25,
      heightMm3d: 3.2,
      side: 'top',
      packageClass: 'connector',
      conn: { kind: 'USB-C', openingDir: '-y', plugClearanceMm: 12, cableKeepout: true, pin1Marked: true },
    },
    '<U1>': {
      courtyardMm: 0.25,
      heightMm3d: 1.2,
      side: 'top',
      packageClass: 'QFN',
    },
  },
  power: {
    decoupling: [
      { capRef: '<C1>', icRef: '<U1>', distanceMm: 0.8, icClass: 'QFN' },
    ],
  },
  rf: { componentRef: '<U1>', keepout: { x0: 0, y0: 0, x1: 10, y1: 10 } },
  testPoints: [{ ref: '<TP1>', diaMm: 1.5, net: '<3V3>' }],
  switches: [{ ref: '<SW1>', clearanceMm: 9 }],
  esd: { devices: [{ ref: '<D1>', distanceMm: 3, gndViaDistanceMm: 1.2, orderBeforeBranch: true }] },
  thermal: {
    components: [
      { ref: '<U1>', powerW: 1.5, copperAreaMm2: 150, viaCount: 9, viaPitchMm: 1.1, viaHoleMm: 0.3 },
    ],
  },
  pdn: { rails: [{ net: '<VBUS>', currentA: 2, resistanceOhm: 0.05, dropV: 0.1, maxDropV: 0.15 }] },
  highSpeed: {
    groups: [
      { name: 'USB2', standard: 'USB2', targetImpedanceOhm: 90, maxSkewMm: 0.5, members: [{ net: '<D+>', lengthMm: 10, impedanceOhm: 92 }, { net: '<D->', lengthMm: 10.2, impedanceOhm: 89 }] },
    ],
  },
  creepage: { pairs: [{ netA: '<AC_L>', netB: '<AC_N>', workingVoltageV: 230, actualMm: 2, requiredMm: 1.5 }] },
  clearance: {
    pairs: [
      { netA: '<AC_L>', netB: '<AC_N>', workingVoltageV: 230, layer: 'external', coating: 'uncoated', altitudeM: 1000, actualMm: 2 },
    ],
  },
  enclosure: { requiredClearanceMm: 1, actualClearanceMm: 2, internalHeightMm: 8, maxComponentHeightMm: 5 },
  emc: { pairs: [{ from: '<SW1>', to: '<ANT1>', minMm: 15, actualMm: 18 }] },
  silk: {},
  dfm: {},
  evidence: {},
};

export const LAYOUT_INTENT_TEMPLATE_TEXT = `${JSON.stringify(LAYOUT_INTENT_TEMPLATE, null, 2)}\n`;
