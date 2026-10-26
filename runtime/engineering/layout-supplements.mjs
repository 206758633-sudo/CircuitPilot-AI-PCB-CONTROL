/**
 * 排版补充规则族（P2）。
 *
 * 这 9 条不在 128 条板级规则包内：它们依赖的是**封装/网表之外的设计事实**
 * （热功耗、铜面积、热过孔、PDN 压降、高速长度/阻抗、USB 几何、爬电/电气间隙、外壳间隙、EMC），
 * 只能从设计意图 JSON 声明取得。缺声明 = REVIEW；声明了但超限 = FAIL。
 *
 * 不把这些塞进 128 条硬门禁，是为了不改变既有规则包 hash/总数；
 * 调用方在 auditPlacementPlan 的 `supplements` 字段单独展示，仍然计入
 * `passed/releaseReady`（有 FAIL 就不放行，但 REVIEW 不冒充 PASS）。
 */
export const SUPPLEMENT_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });

const EPS = 1e-9;
const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const list = (value) => (Array.isArray(value) ? value : null);
const result = (id, title, status, message, evidence = null) => ({ id, title, status, message, ...(evidence ? { evidence } : {}) });

/** 热铜面积：1 W 需 100 mm²；每增加 0.5 W 加 50 mm²（与 PWR-10 同口径）。 */
export function requiredThermalCopperMm2(powerW) {
  const p = num(powerW);
  if (p === null || p <= 0) return null;
  if (p <= 1) return 100;
  return 100 + Math.ceil((p - 1) / 0.5 - EPS) * 50;
}

/**
 * IPC-2221 电气间隙表（Sierra Circuits 转述，B 级证据；量产/安规必须回 IPC 原文复核）。
 *
 * 只做“给定电压/层位/涂覆/海拔 → 最小裸板间隙”的查表，不猜缺失分类；
 * >500 V 的线性斜率不自动外推，交由标准原文/认证机构给出要求值。
 */
export const IPC2221_CLEARANCE_BASIS = 'IPC-2221 表 6-1（Sierra Circuits 转述，证据等级 B）';
const IPC2221_CLEARANCE_ROWS = Object.freeze([
  { maxV: 15, internal: 0.05, externalUncoatedSea: 0.1, externalUncoatedHigh: 0.1, externalCoated: 0.05 },
  { maxV: 30, internal: 0.05, externalUncoatedSea: 0.1, externalUncoatedHigh: 0.1, externalCoated: 0.05 },
  { maxV: 50, internal: 0.1, externalUncoatedSea: 0.6, externalUncoatedHigh: 0.6, externalCoated: 0.13 },
  { maxV: 100, internal: 0.1, externalUncoatedSea: 0.6, externalUncoatedHigh: 1.5, externalCoated: 0.13 },
  { maxV: 150, internal: 0.2, externalUncoatedSea: 0.6, externalUncoatedHigh: 3.2, externalCoated: 0.4 },
  { maxV: 170, internal: 0.2, externalUncoatedSea: 1.25, externalUncoatedHigh: 6.4, externalCoated: 0.4 },
  { maxV: 250, internal: 0.2, externalUncoatedSea: 1.25, externalUncoatedHigh: 6.4, externalCoated: 0.4 },
  { maxV: 300, internal: 0.2, externalUncoatedSea: 1.25, externalUncoatedHigh: 12.5, externalCoated: 0.4 },
  { maxV: 500, internal: 0.25, externalUncoatedSea: 2.5, externalUncoatedHigh: 12.5, externalCoated: 0.8 },
]);

/** 查 IPC-2221 最小电气间隙；分类不全时返回 {ok:false,reason}，不补默认值。 */
export function requiredClearanceMm({ workingVoltageV, layer, coating = 'uncoated', altitudeM } = {}) {
  const voltage = num(workingVoltageV);
  if (voltage === null || voltage < 0) return { ok: false, reason: 'workingVoltageV 缺失/非法' };
  if (voltage > 500) return { ok: false, reason: '>500 V 不自动外推，需按 IPC 原文/认证要求填写 requiredMm' };
  if (!['internal', 'external'].includes(layer)) return { ok: false, reason: 'layer 必须是 internal/external' };
  const row = IPC2221_CLEARANCE_ROWS.find((item) => voltage <= item.maxV);
  if (!row) return { ok: false, reason: '电压不在 IPC-2221 表范围内' };
  let requiredMm;
  let column;
  if (layer === 'internal') {
    requiredMm = row.internal;
    column = '内层';
  } else if (coating === 'coated') {
    requiredMm = row.externalCoated;
    column = '外层永久聚合物涂覆';
  } else {
    const altitude = num(altitudeM);
    if (altitude === null) return { ok: false, reason: '外层未涂覆需 altitudeM（≤3050 m / >3050 m）' };
    if (altitude > 3050) {
      requiredMm = row.externalUncoatedHigh;
      column = '外层未涂覆 >3050 m';
    } else {
      requiredMm = row.externalUncoatedSea;
      column = '外层未涂覆 ≤3050 m';
    }
  }
  return { ok: true, requiredMm, column, rowMaxV: row.maxV, basis: IPC2221_CLEARANCE_BASIS };
}

function clearanceRules(ctx) {
  const pairs = list(ctx.input?.clearance?.pairs);
  if (!pairs) return result('SUP-IPC-01', 'IPC-2221 电气间隙', SUPPLEMENT_STATUS.REVIEW, '未提供 clearance.pairs（电压/层位/涂覆/海拔/实测）');
  if (!pairs.length) return result('SUP-IPC-01', 'IPC-2221 电气间隙', SUPPLEMENT_STATUS.NA, '没有需要按电压分档的电气间隙对');
  const bad = [];
  const unknown = [];
  const evidence = [];
  for (const pair of pairs) {
    const name = `${pair?.netA || '?'}↔${pair?.netB || '?'}`;
    const actual = num(pair?.actualMm);
    let required = num(pair?.requiredMm);
    let basis = '显式 requiredMm';
    if (required === null) {
      const calc = requiredClearanceMm(pair);
      if (!calc.ok) { unknown.push(`${name}（${calc.reason}）`); continue; }
      required = calc.requiredMm;
      basis = `${calc.column}，${calc.basis}`;
    }
    if (actual === null) { unknown.push(`${name}（actualMm 未量测）`); continue; }
    evidence.push({ name, actualMm: actual, requiredMm: required, basis });
    if (actual + EPS < required) bad.push(`${name} ${actual} mm < ${required} mm（${basis}）`);
  }
  if (bad.length) return result('SUP-IPC-01', 'IPC-2221 电气间隙', SUPPLEMENT_STATUS.FAIL, `电气间隙不足：${bad.join('，')}`, { bad, unknown, pairs: evidence, basis: IPC2221_CLEARANCE_BASIS, evidenceLevel: 'B' });
  if (unknown.length) return result('SUP-IPC-01', 'IPC-2221 电气间隙', SUPPLEMENT_STATUS.REVIEW, `电气间隙缺分类/量测：${unknown.join('，')}`, { unknown, pairs: evidence, basis: IPC2221_CLEARANCE_BASIS, evidenceLevel: 'B' });
  return result('SUP-IPC-01', 'IPC-2221 电气间隙', SUPPLEMENT_STATUS.PASS, `电气间隙合规（${evidence.length} 对）`, { pairs: evidence, basis: IPC2221_CLEARANCE_BASIS, evidenceLevel: 'B' });
}

function thermalRules(ctx) {
  const items = list(ctx.input?.thermal?.components);
  if (!items) return [
    result('SUP-TH-01', '热功耗铜箔面积', SUPPLEMENT_STATUS.REVIEW, '未提供 thermal.components（功耗/铜面积）'),
    result('SUP-TH-02', '散热过孔阵列', SUPPLEMENT_STATUS.REVIEW, '未提供 thermal.components（过孔数量/间距/孔径）'),
  ];
  if (!items.length) return [
    result('SUP-TH-01', '热功耗铜箔面积', SUPPLEMENT_STATUS.NA, '没有发热器件'),
    result('SUP-TH-02', '散热过孔阵列', SUPPLEMENT_STATUS.NA, '没有发热器件'),
  ];
  const areaProblems = [];
  const areaUnknown = [];
  const viaProblems = [];
  const viaUnknown = [];
  for (const item of items) {
    const ref = item?.ref || '?';
    const required = requiredThermalCopperMm2(item?.powerW);
    const area = num(item?.copperAreaMm2);
    if (required === null || area === null) areaUnknown.push(`${ref}（功耗或铜面积未量测）`);
    else if (area + EPS < required) areaProblems.push(`${ref} ${area} mm² < ${required} mm²（${item.powerW} W）`);
    const count = num(item?.viaCount);
    const pitch = num(item?.viaPitchMm);
    const hole = num(item?.viaHoleMm);
    if (count === null || pitch === null || hole === null) viaUnknown.push(`${ref}（过孔数量/间距/孔径未量测）`);
    else {
      if (count < 9) viaProblems.push(`${ref} 过孔 ${count} 个 < 9`);
      if (pitch < 1.0 - EPS || pitch > 1.2 + EPS) viaProblems.push(`${ref} 过孔间距 ${pitch} mm 不在 1.0–1.2 mm`);
      if (hole < 0.25 - EPS || hole > 0.35 + EPS) viaProblems.push(`${ref} 过孔孔径 ${hole} mm 不在 0.25–0.35 mm`);
    }
  }
  return [
    areaProblems.length ? result('SUP-TH-01', '热功耗铜箔面积', SUPPLEMENT_STATUS.FAIL, `热铜面积不足：${areaProblems.join('，')}`, { problems: areaProblems, unknown: areaUnknown })
      : areaUnknown.length ? result('SUP-TH-01', '热功耗铜箔面积', SUPPLEMENT_STATUS.REVIEW, `热铜面积缺量测：${areaUnknown.join('，')}`, { unknown: areaUnknown })
        : result('SUP-TH-01', '热功耗铜箔面积', SUPPLEMENT_STATUS.PASS, `热铜面积合规（${items.length} 颗）`),
    viaProblems.length ? result('SUP-TH-02', '散热过孔阵列', SUPPLEMENT_STATUS.FAIL, `散热过孔不合格：${viaProblems.join('，')}`, { problems: viaProblems, unknown: viaUnknown })
      : viaUnknown.length ? result('SUP-TH-02', '散热过孔阵列', SUPPLEMENT_STATUS.REVIEW, `散热过孔缺量测：${viaUnknown.join('，')}`, { unknown: viaUnknown })
        : result('SUP-TH-02', '散热过孔阵列', SUPPLEMENT_STATUS.PASS, `散热过孔合规（${items.length} 颗）`),
  ];
}

function pdnRule(ctx) {
  const rails = list(ctx.input?.pdn?.rails);
  if (!rails) return result('SUP-PDN-01', 'PDN 直流压降', SUPPLEMENT_STATUS.REVIEW, '未提供 pdn.rails（电流/电阻/压降）');
  if (!rails.length) return result('SUP-PDN-01', 'PDN 直流压降', SUPPLEMENT_STATUS.NA, '没有 PDN 轨');
  const bad = [];
  const unknown = [];
  for (const rail of rails) {
    const net = rail?.net || '?';
    const drop = num(rail?.dropV);
    const max = num(rail?.maxDropV);
    if (drop === null || max === null) { unknown.push(`${net}（压降/上限未量测）`); continue; }
    if (drop > max + EPS) bad.push(`${net} 压降 ${drop} V > ${max} V`);
  }
  if (bad.length) return result('SUP-PDN-01', 'PDN 直流压降', SUPPLEMENT_STATUS.FAIL, `PDN 压降超限：${bad.join('，')}`, { bad, unknown });
  if (unknown.length) return result('SUP-PDN-01', 'PDN 直流压降', SUPPLEMENT_STATUS.REVIEW, `PDN 压降缺量测：${unknown.join('，')}`, { unknown });
  return result('SUP-PDN-01', 'PDN 直流压降', SUPPLEMENT_STATUS.PASS, `PDN 压降合规（${rails.length} 条轨）`);
}

function highSpeedRule(ctx) {
  const groups = list(ctx.input?.highSpeed?.groups);
  if (!groups) return result('SUP-HS-01', '高速组内等长/阻抗', SUPPLEMENT_STATUS.REVIEW, '未提供 highSpeed.groups（组内长度/阻抗）');
  if (!groups.length) return result('SUP-HS-01', '高速组内等长/阻抗', SUPPLEMENT_STATUS.NA, '没有高速组');
  const bad = [];
  const unknown = [];
  for (const group of groups) {
    const name = group?.name || '?';
    const members = list(group?.members);
    const maxSkew = num(group?.maxSkewMm);
    if (!members || members.length < 2 || maxSkew === null) { unknown.push(`${name}（成员/最大偏斜未提供）`); continue; }
    const lengths = members.map((member) => num(member?.lengthMm));
    if (lengths.some((length) => length === null)) { unknown.push(`${name}（组内长度未量测）`); continue; }
    const skew = Math.max(...lengths) - Math.min(...lengths);
    if (skew > maxSkew + EPS) bad.push(`${name} 偏斜 ${skew.toFixed(3)} mm > ${maxSkew} mm`);
    const target = num(group?.targetImpedanceOhm);
    if (target !== null) {
      const off = members.filter((member) => {
        const z = num(member?.impedanceOhm);
        return z !== null && Math.abs(z - target) / target > 0.10 + EPS;
      }).map((member) => member?.net || '?');
      if (off.length) bad.push(`${name} 阻抗偏离 ±10%：${off.join('、')}`);
    }
  }
  if (bad.length) return result('SUP-HS-01', '高速组内等长/阻抗', SUPPLEMENT_STATUS.FAIL, `高速组不合格：${bad.join('，')}`, { bad, unknown });
  if (unknown.length) return result('SUP-HS-01', '高速组内等长/阻抗', SUPPLEMENT_STATUS.REVIEW, `高速组缺量测：${unknown.join('，')}`, { unknown });
  return result('SUP-HS-01', '高速组内等长/阻抗', SUPPLEMENT_STATUS.PASS, `高速组合规（${groups.length} 组）`);
}

/**
 * USB2/3/4 差分对几何（TI SLLA414A / USB-IF 参考设计阈值）。
 *
 * 仅当 group.standard 明确声明为 USB2/USB3/USB4 时参与判定；其它高速组交给
 * SUP-HS-01 的通用等长/阻抗规则，避免把“没说标准”的组硬套 USB 数值。
 * 缺失的几何事实一律 REVIEW，不默认成 0/不默认成通过。
 */
const USB_GEOMETRY_LIMITS = Object.freeze({
  USB2: { impedanceTolerance: 0.15, requireGeometry: false },
  USB3: { impedanceTolerance: 0.15, requireGeometry: true, intraPairSkewMm: 0.127, pairGapMm: 0.762, planeEdgeClearanceMm: 2.286, stubMm: 0.381 },
  USB4: { impedanceTolerance: 0.15, requireGeometry: true, intraPairSkewMm: 0.127, pairGapMm: 0.762, planeEdgeClearanceMm: 2.286, stubMm: 0.381 },
});

function usbGeometryRule(ctx) {
  const groups = list(ctx.input?.highSpeed?.groups);
  if (!groups) return result('SUP-HS-02', 'USB 差分对/参考平面几何', SUPPLEMENT_STATUS.REVIEW, '未提供 highSpeed.groups（USB 阻抗/对内偏斜/对间距/平面边距/stub）');
  const usbGroups = groups.filter((group) => ['USB2', 'USB3', 'USB4'].includes(group?.standard));
  if (!usbGroups.length) return result('SUP-HS-02', 'USB 差分对/参考平面几何', SUPPLEMENT_STATUS.NA, '没有声明 standard=USB2/USB3/USB4 的高速组');
  const bad = [];
  const unknown = [];
  for (const group of usbGroups) {
    const name = `${group.name || '?'}(${group.standard})`;
    const limits = USB_GEOMETRY_LIMITS[group.standard];
    const target = num(group.targetImpedanceOhm);
    if (target === null || target <= 0) { unknown.push(`${name}（targetImpedanceOhm 未提供/非正数）`); continue; }
    const members = list(group.members) || [];
    const impedances = members.map((member) => ({ net: member?.net || '?', value: num(member?.impedanceOhm) }));
    if (!impedances.length || impedances.some((item) => item.value === null)) { unknown.push(`${name}（至少有 1 个成员未提供 impedanceOhm）`); continue; }
    const off = impedances.filter((item) => Math.abs(item.value - target) / target > limits.impedanceTolerance + EPS).map((item) => item.net);
    if (off.length) bad.push(`${name} 阻抗偏离 ±${Math.round(limits.impedanceTolerance * 100)}%：${off.join('、')}`);
    if (!limits.requireGeometry) continue;
    const skew = num(group.intraPairSkewMm);
    const gap = num(group.pairGapMm);
    const edge = num(group.planeEdgeClearanceMm);
    const stub = num(group.stubMm);
    if (skew === null || gap === null || edge === null || stub === null) {
      unknown.push(`${name}（对内偏斜/对间距/平面边距/stub 未量测全）`);
      continue;
    }
    if (skew > limits.intraPairSkewMm + EPS) bad.push(`${name} 对内偏斜 ${skew} mm > ${limits.intraPairSkewMm} mm`);
    if (gap < limits.pairGapMm - EPS) bad.push(`${name} 对间距 ${gap} mm < ${limits.pairGapMm} mm`);
    if (edge < limits.planeEdgeClearanceMm - EPS) bad.push(`${name} 参考平面边缘 ${edge} mm < ${limits.planeEdgeClearanceMm} mm`);
    if (stub > limits.stubMm + EPS) bad.push(`${name} stub ${stub} mm > ${limits.stubMm} mm`);
  }
  if (bad.length) return result('SUP-HS-02', 'USB 差分对/参考平面几何', SUPPLEMENT_STATUS.FAIL, `USB 差分对不合格：${bad.join('，')}`, { bad, unknown, basis: 'TI SLLA414A / USB-IF 参考设计', evidenceLevel: 'A' });
  if (unknown.length) return result('SUP-HS-02', 'USB 差分对/参考平面几何', SUPPLEMENT_STATUS.REVIEW, `USB 差分对缺量测：${unknown.join('，')}`, { unknown, basis: 'TI SLLA414A / USB-IF 参考设计', evidenceLevel: 'A' });
  return result('SUP-HS-02', 'USB 差分对/参考平面几何', SUPPLEMENT_STATUS.PASS, `USB 差分对合规（${usbGroups.length} 组）`, { basis: 'TI SLLA414A / USB-IF 参考设计', evidenceLevel: 'A' });
}

function creepageRule(ctx) {
  const pairs = list(ctx.input?.creepage?.pairs);
  if (!pairs) return result('SUP-CREEP-01', '爬电/电气间隙', SUPPLEMENT_STATUS.REVIEW, '未提供 creepage.pairs（电压/间距）');
  if (!pairs.length) return result('SUP-CREEP-01', '爬电/电气间隙', SUPPLEMENT_STATUS.NA, '没有高压隔离对');
  const bad = [];
  const unknown = [];
  for (const pair of pairs) {
    const name = `${pair?.netA || '?'}↔${pair?.netB || '?'}`;
    const actual = num(pair?.actualMm);
    const required = num(pair?.requiredMm);
    if (actual === null || required === null) { unknown.push(`${name}（实测/要求未提供）`); continue; }
    if (actual + EPS < required) bad.push(`${name} ${actual} mm < ${required} mm`);
  }
  if (bad.length) return result('SUP-CREEP-01', '爬电/电气间隙', SUPPLEMENT_STATUS.FAIL, `爬电间距不足：${bad.join('，')}`, { bad, unknown });
  if (unknown.length) return result('SUP-CREEP-01', '爬电/电气间隙', SUPPLEMENT_STATUS.REVIEW, `爬电间距缺量测：${unknown.join('，')}`, { unknown });
  return result('SUP-CREEP-01', '爬电/电气间隙', SUPPLEMENT_STATUS.PASS, `爬电间距合规（${pairs.length} 对）`);
}

function enclosureRule(ctx) {
  const enclosure = ctx.input?.enclosure;
  if (!enclosure || typeof enclosure !== 'object') return result('SUP-ENCL-01', '外壳/线缆空间', SUPPLEMENT_STATUS.REVIEW, '未提供 enclosure（外壳间隙/内部高度）');
  const clearance = num(enclosure.actualClearanceMm);
  const required = num(enclosure.requiredClearanceMm);
  const height = num(enclosure.internalHeightMm);
  const maxHeight = num(enclosure.maxComponentHeightMm);
  if (clearance === null || required === null || height === null || maxHeight === null) return result('SUP-ENCL-01', '外壳/线缆空间', SUPPLEMENT_STATUS.REVIEW, '外壳间隙/内部高度/最高器件未量测');
  const bad = [];
  if (clearance + EPS < required) bad.push(`最小间隙 ${clearance} mm < ${required} mm`);
  if (height + EPS < maxHeight) bad.push(`内部高度 ${height} mm < 最高器件 ${maxHeight} mm`);
  if (bad.length) return result('SUP-ENCL-01', '外壳/线缆空间', SUPPLEMENT_STATUS.FAIL, `外壳空间不足：${bad.join('，')}`, { bad });
  return result('SUP-ENCL-01', '外壳/线缆空间', SUPPLEMENT_STATUS.PASS, '外壳/线缆空间合规');
}

function emcRule(ctx) {
  const pairs = list(ctx.input?.emc?.pairs);
  if (!pairs) return result('SUP-EMC-01', 'EMC 噪声源/敏感体间距', SUPPLEMENT_STATUS.REVIEW, '未提供 emc.pairs（噪声源/敏感体/间距）');
  if (!pairs.length) return result('SUP-EMC-01', 'EMC 噪声源/敏感体间距', SUPPLEMENT_STATUS.NA, '没有需要隔离的 EMC 对');
  const bad = [];
  const unknown = [];
  for (const pair of pairs) {
    const name = `${pair?.from || '?'}↔${pair?.to || '?'}`;
    const actual = num(pair?.actualMm);
    const min = num(pair?.minMm);
    if (actual === null || min === null) { unknown.push(`${name}（实测/最小间距未提供）`); continue; }
    if (actual + EPS < min) bad.push(`${name} ${actual} mm < ${min} mm`);
  }
  if (bad.length) return result('SUP-EMC-01', 'EMC 噪声源/敏感体间距', SUPPLEMENT_STATUS.FAIL, `EMC 间距不足：${bad.join('，')}`, { bad, unknown });
  if (unknown.length) return result('SUP-EMC-01', 'EMC 噪声源/敏感体间距', SUPPLEMENT_STATUS.REVIEW, `EMC 间距缺量测：${unknown.join('，')}`, { unknown });
  return result('SUP-EMC-01', 'EMC 噪声源/敏感体间距', SUPPLEMENT_STATUS.PASS, `EMC 间距合规（${pairs.length} 对）`);
}

export function evaluateLayoutSupplements(input = {}) {
  const ctx = { input };
  const rules = [
    ...thermalRules(ctx),
    pdnRule(ctx),
    highSpeedRule(ctx),
    usbGeometryRule(ctx),
    creepageRule(ctx),
    clearanceRules(ctx),
    enclosureRule(ctx),
    emcRule(ctx),
  ];
  const summary = { total: rules.length, PASS: 0, FAIL: 0, REVIEW: 0, NA: 0, blockingFailures: 0 };
  for (const rule of rules) {
    summary[rule.status] += 1;
    if (rule.status === SUPPLEMENT_STATUS.FAIL) summary.blockingFailures += 1;
  }
  return { kind: 'pcba-layout-supplement-audit', rules, summary, passed: summary.blockingFailures === 0, releaseReady: summary.blockingFailures === 0 && summary.REVIEW === 0 };
}
