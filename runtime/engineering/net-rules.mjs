/**
 * 网络/电气驱动规则（NET pack）：网络分类、载流线宽、差分对、目标阻抗、过孔载流。
 *
 * 来源与许可：
 *   - 网络分类的命名规则与目标阻抗默认值参照 easyeda/eext-design-rule-generator
 *     （Apache-2.0，src/core/rules.ts），按本仓库风格重写，未复制其代码；
 *   - 载流公式为 IPC-2221 截面公式，与嘉立创线路/过孔载流计算器一致；
 *   - 阻抗公式为微带/差分近似，仅用于“是否明显偏离目标”的初筛，不替代板厂阻抗计算器。
 *
 * 与 board-layout-rules 的分工：这里只回答“电气约束是否被满足/可判定”，
 * 不判断几何布局，也不写 EDA 规则配置（当前桥只有只读规则读取）。
 *
 * 判定语义：PASS / FAIL / REVIEW / NA；REVIEW 不等于 PASS，缺数据不猜。
 */
import crypto from 'node:crypto';
import { finding } from './stackup.mjs';

export const NET_RULE_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });
const STATUS = NET_RULE_STATUS;
const EPS = 1e-9;
const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const toNum = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.trim().match(/-?[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[0]) : null;
};
const ok = (evidence, message) => ({ status: STATUS.PASS, evidence, message });
const fail = (message, evidence) => ({ status: STATUS.FAIL, message, evidence });
const review = (message, evidence) => ({ status: STATUS.REVIEW, message, evidence });
const na = (message) => ({ status: STATUS.NA, message });

// ---------------------------------------------------------------------------
// 1. 网络分类（命名约定）
// ---------------------------------------------------------------------------
const explicitImpedancePattern = /(?:^|_)Z(\d{2,3})D?(?:_|$)/i;
const groundPattern = /^(?:GND|AGND|DGND|PGND|GNDA|GNDD)(?:$|[_-])/i;
const powerPattern = /(?:^|[_+-])(?:\d+(?:V\d+|V)|VCC|VDD|VSS|VBAT|VIN|VOUT|AVDD|DVDD|PVDD|VBUS|VUSB|VCORE|VDDA|VDDD|VCCA|VSSA|VSYS|VMAIN|VRTC|VIO|VREF|VTT|VPP|VEE|VNN|VPOS|VNEG|PWR|POWER)(?:$|[_-])/i;
const pairSuffixes = [
  { positive: /_DP$/i, negativeSuffix: '_DM', keySuffix: '_D' },
  { positive: /_P$/i, negativeSuffix: '_N', keySuffix: '' },
  { positive: /P$/i, negativeSuffix: 'N', keySuffix: '' },
  { positive: /\+$/, negativeSuffix: '-', keySuffix: '' },
];
const negativeSuffixes = [
  { negative: /_DM$/i, positiveSuffix: '_DP', keySuffix: '_D' },
  { negative: /_N$/i, positiveSuffix: '_P', keySuffix: '' },
  { negative: /N$/i, positiveSuffix: 'P', keySuffix: '' },
  { negative: /-$/, positiveSuffix: '+', keySuffix: '' },
];

export function differentialTarget(net, explicit) {
  if (isNum(explicit)) return explicit;
  if (/PCIE|PCI_E|PEX/i.test(net)) return 85;
  if (/USB/i.test(net)) return 90;
  return 100;
}

function findPair(net, allNets) {
  for (const suffix of pairSuffixes) {
    if (!suffix.positive.test(net)) continue;
    const stem = net.replace(suffix.positive, '');
    const mate = `${stem}${suffix.negativeSuffix}`;
    if (allNets.has(mate)) return { mate, pairName: `${stem}${suffix.keySuffix}` };
  }
  return null;
}
function findPositiveMate(net, allNets) {
  for (const suffix of negativeSuffixes) {
    if (!suffix.negative.test(net)) continue;
    const stem = net.replace(suffix.negative, '');
    const mate = `${stem}${suffix.positiveSuffix}`;
    if (allNets.has(mate)) return { mate, pairName: `${stem}${suffix.keySuffix}` };
  }
  return null;
}

/** 按命名规则分类网络；不猜，孤立差分后缀只给 warning。 */
export function classifyNets(nets = []) {
  const list = (Array.isArray(nets) ? nets : []).map((net) => String(net ?? '').trim()).filter(Boolean);
  const allNets = new Set(list);
  return list.map((net) => {
    const warnings = [];
    if (groundPattern.test(net)) return { net, category: 'ground', warnings };
    if (powerPattern.test(net)) return { net, category: 'power', warnings };
    const explicit = explicitImpedancePattern.exec(net);
    const explicitTarget = explicit ? Number(explicit[1]) : undefined;
    const positive = findPair(net, allNets);
    if (positive) return { net, category: 'differential', targetOhms: differentialTarget(net, explicitTarget), mate: positive.mate, polarity: 'positive', pairName: positive.pairName, warnings };
    const negative = findPositiveMate(net, allNets);
    if (negative) return { net, category: 'differential', targetOhms: differentialTarget(net, explicitTarget), mate: negative.mate, polarity: 'negative', pairName: negative.pairName, warnings };
    if (explicit) return { net, category: 'impedance', targetOhms: explicitTarget, warnings };
    if (/(?:_P|_N|_DP|_DM|\+|-)$/i.test(net)) warnings.push('疑似差分网络，但未找到对应的另一端');
    return { net, category: 'signal', warnings };
  });
}

// ---------------------------------------------------------------------------
// 2. 电气公式
// ---------------------------------------------------------------------------
/**
 * IPC-2221 载流线宽：f(mil²) = (I / (k·ΔT^0.44))^(1/0.725)，再按铜厚换算成宽度。
 * k = 0.048（外层）/ 0.024（内层）。
 */
export function traceWidthForCurrent({ currentA, copperThicknessUm = 35, external = true, tempRiseC = 10, ambientC = 25 } = {}) {
  const current = toNum(currentA); const thickness = toNum(copperThicknessUm); const rise = toNum(tempRiseC);
  if (!(current > 0) || !(thickness > 0) || !(rise > 0)) return null;
  const k = external ? 0.048 : 0.024;
  const areaMil2 = Math.pow(current / (k * Math.pow(rise, 0.44)), 1 / 0.725);
  const areaCm2 = (areaMil2 * 2.54 * 2.54) / 1e6;
  const copperCm = 1e-4 * thickness;
  const widthMm = areaCm2 / copperCm / 0.1;
  return {
    widthMm,
    widthMil: widthMm / 0.0254,
    crossSectionMil2: areaMil2,
    copperThicknessUm: thickness,
    external: external === true,
    tempRiseC: rise,
    ambientC: toNum(ambientC) ?? 25,
  };
}

/** 单个过孔的最大载流（嘉立创过孔载流计算器同式）。 */
export function viaCurrentCapacity({ temperatureRiseC = 10, apertureDiameterMm, copperThicknessUm = 25 } = {}) {
  const rise = toNum(temperatureRiseC); const diameter = toNum(apertureDiameterMm); const thickness = toNum(copperThicknessUm);
  if (!(rise > 0) || !(diameter > 0) || !(thickness > 0)) return null;
  const c = 3140 * diameter * (1 / 25.4) * thickness / 25.4;
  return { maxCurrentA: 0.02 * Math.pow(rise, 0.44) * Math.pow(c, 0.725), diameterMm: diameter, copperThicknessUm: thickness };
}

/** 微带线特征阻抗（Hammerstad 近似），仅做初筛。 */
export function microstripImpedance({ widthMm, heightMm, thicknessMm = 0.035, er } = {}) {
  const width = toNum(widthMm); const height = toNum(heightMm); const thickness = toNum(thicknessMm); const erValue = toNum(er);
  if (!(width > 0) || !(height > 0) || !(thickness > 0) || !(erValue >= 1)) return null;
  const u0 = Math.max(0.01, width / height);
  const th = Math.max(0.0001, thickness / height);
  const coth = 1 / Math.tanh(Math.sqrt(6.517 * u0));
  const u = u0 + Math.max(0, (th / Math.PI) * Math.log(1 + (4 * Math.E) / (th * th * coth * coth)));
  let effectiveEr = (erValue + 1) / 2 + ((erValue - 1) / 2) * (1 / Math.sqrt(1 + 12 / u) + (u < 1 ? 0.04 * (1 - u) ** 2 : 0));
  effectiveEr += Math.min(0.18, 0.045 * (erValue - 1));
  const z0 = u <= 1
    ? (60 / Math.sqrt(effectiveEr)) * Math.log(8 / u + 0.25 * u)
    : (120 * Math.PI) / (Math.sqrt(effectiveEr) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
  return { impedanceOhm: z0, effectiveEr, widthMm: width, heightMm: height };
}

/** 差分阻抗近似：2·Z0·(1 − 0.48·e^(−0.96·gap/height))。 */
export function differentialImpedance({ widthMm, gapMm, heightMm, thicknessMm = 0.035, er } = {}) {
  const single = microstripImpedance({ widthMm, heightMm, thicknessMm, er });
  const gap = toNum(gapMm); const height = toNum(heightMm);
  if (!single || !(height > 0)) return null;
  const ratio = Math.max(0.02, (gap ?? 0.15) / height);
  return { impedanceOhm: 2 * single.impedanceOhm * (1 - 0.48 * Math.exp(-0.96 * ratio)), singleEndedOhm: single.impedanceOhm, gapMm: gap };
}

// ---------------------------------------------------------------------------
// 3. 规则：NET-01 .. NET-05
// ---------------------------------------------------------------------------
function normalizeCopper(input) {
  const copper = input && typeof input === 'object' ? input : {};
  return {
    thicknessUm: toNum(copper.thicknessUm) ?? 35,
    external: copper.external !== false,
    tempRiseC: toNum(copper.tempRiseC) ?? 10,
    ambientC: toNum(copper.ambientC) ?? 25,
  };
}

function pairProblems(classified, pairs) {
  const problems = [];
  const byNet = new Map(classified.map((entry) => [entry.net, entry]));
  for (const pair of pairs) {
    const positive = byNet.get(pair.positive);
    const negative = byNet.get(pair.negative);
    if (!positive) problems.push(`差分对 ${pair.name || pair.positive} 缺少正端 ${pair.positive}`);
    if (!negative) problems.push(`差分对 ${pair.name || pair.positive} 缺少负端 ${pair.negative}`);
    if (positive && positive.category !== 'differential') problems.push(`${pair.positive} 未被识别为差分网络`);
    if (negative && negative.category !== 'differential') problems.push(`${pair.negative} 未被识别为差分网络`);
    if (positive && negative && positive.mate !== pair.negative) problems.push(`${pair.positive} 的配对端是 ${positive.mate}，与声明的 ${pair.negative} 不一致`);
  }
  return problems;
}

export const NET_RULES = [
  {
    id: 'NET-01', group: 'NET', name: '网络分类完整性', level: '推荐',
    check: ({ nets, classified }) => {
      if (!Array.isArray(nets) || !nets.length) return review('未提供网络清单 nets');
      const warnings = classified.filter((entry) => entry.warnings.length).map((entry) => `${entry.net}：${entry.warnings.join('；')}`);
      if (warnings.length) return review(`网络命名存在歧义：${warnings.join('；')}`, { warnings });
      const counts = classified.reduce((acc, entry) => { acc[entry.category] = (acc[entry.category] || 0) + 1; return acc; }, {});
      return ok({ counts, total: classified.length }, `已分类 ${classified.length} 个网络：${Object.entries(counts).map(([category, count]) => `${category} ${count}`).join('、')}`);
    },
  },
  {
    id: 'NET-02', group: 'NET', name: '电源网载流线宽', level: '硬门禁',
    check: ({ input, copper, classified }) => {
      const entries = Array.isArray(input.power) ? input.power : null;
      const powerNets = classified.filter((entry) => entry.category === 'power').map((entry) => entry.net);
      if (!entries) {
        if (powerNets.length) return review(`检测到电源网（${powerNets.join('、')}），但未提供载流数据 power`);
        return na('本板没有电源网');
      }
      if (!entries.length) return na('power 为空（本板无电源网）');
      const problems = []; const checked = [];
      for (const entry of entries) {
        const current = toNum(entry.currentA); const actual = toNum(entry.actualWidthMm);
        if (!(current > 0) || !(actual > 0)) { problems.push(`电源网 ${entry.net || '?'} 缺电流或实际线宽`); continue; }
        const required = traceWidthForCurrent({
          currentA: current,
          copperThicknessUm: toNum(entry.copperThicknessUm) ?? copper.thicknessUm,
          external: entry.external !== false,
          tempRiseC: toNum(entry.tempRiseC) ?? copper.tempRiseC,
          ambientC: copper.ambientC,
        });
        if (!required) { problems.push(`电源网 ${entry.net || '?'} 载流参数非法`); continue; }
        checked.push({ net: entry.net, currentA: current, actualWidthMm: actual, requiredWidthMm: round(required.widthMm, 3) });
        if (actual + EPS < required.widthMm) problems.push(`电源网 ${entry.net || '?'} 实际 ${round(actual, 3)}mm 小于 ${round(required.widthMm, 3)}mm（${current}A / ΔT ${required.tempRiseC}°C）`);
      }
      if (problems.some((problem) => problem.includes('缺'))) return review(`电源载流数据不完整：${problems.join('；')}`);
      if (problems.length) return fail(`电源线宽不满足载流要求：${problems.join('；')}`, { checked });
      return ok({ checked }, '电源网线宽满足 IPC-2221 载流要求');
    },
  },
  {
    id: 'NET-03', group: 'NET', name: '差分对配对', level: '硬门禁',
    check: ({ input, classified }) => {
      const declared = Array.isArray(input.pairs) ? input.pairs : null;
      const expected = new Map();
      for (const entry of classified) {
        if (entry.category !== 'differential' || !entry.pairName) continue;
        if (!expected.has(entry.pairName)) expected.set(entry.pairName, { positive: null, negative: null });
        if (entry.polarity === 'positive') expected.get(entry.pairName).positive = entry.net;
        else expected.get(entry.pairName).negative = entry.net;
      }
      if (!declared) {
        if (expected.size) return review(`检测到 ${expected.size} 组差分对，但未提供声明 pairs`);
        return na('本板没有差分对');
      }
      const problems = pairProblems(classified, declared);
      if (problems.length) return fail(`差分对声明与网络不一致：${problems.join('；')}`, { declared, detected: Array.from(expected.entries()).map(([name, pair]) => ({ name, ...pair })) });
      const missing = Array.from(expected.entries()).filter(([name]) => !declared.some((pair) => (pair.name || '') === name)).map(([name]) => name);
      if (missing.length) return review(`检测到未声明的差分对：${missing.join('、')}`, { missing });
      return ok({ pairs: declared.map((pair) => pair.name || `${pair.positive}/${pair.negative}`) }, '差分对声明与网络分类一致');
    },
  },
  {
    id: 'NET-04', group: 'NET', name: '目标阻抗匹配', level: '硬门禁',
    check: ({ input }) => {
      const entries = Array.isArray(input.impedance) ? input.impedance : null;
      if (!entries) return review('未提供阻抗检查数据 impedance');
      if (!entries.length) return na('impedance 为空（本板无阻抗要求）');
      const tolerancePercent = toNum(input.tolerancePercent) ?? 10;
      const problems = []; const checked = []; const missing = [];
      for (const entry of entries) {
        const target = toNum(entry.targetOhms); const width = toNum(entry.actualWidthMm);
        const stackup = entry.stackup && typeof entry.stackup === 'object' ? entry.stackup : null;
        const height = stackup ? toNum(stackup.heightMm) : null;
        const er = stackup ? toNum(stackup.er) : null;
        if (!(target > 0) || !(width > 0) || !stackup || !(height > 0) || !(er >= 1)) {
          missing.push(entry.net || entry.name || '?');
          continue;
        }
        const calculated = entry.kind === 'differential'
          ? differentialImpedance({ widthMm: width, gapMm: toNum(entry.gapMm), heightMm: height, thicknessMm: toNum(stackup.copperThicknessMm) ?? 0.035, er })
          : microstripImpedance({ widthMm: width, heightMm: height, thicknessMm: toNum(stackup.copperThicknessMm) ?? 0.035, er });
        if (!calculated) { missing.push(entry.net || entry.name || '?'); continue; }
        const deviation = Math.abs(calculated.impedanceOhm - target) / target * 100;
        checked.push({ net: entry.net, targetOhms: target, calculatedOhm: round(calculated.impedanceOhm, 2), deviationPercent: round(deviation, 2), tolerancePercent });
        if (deviation > tolerancePercent + EPS) problems.push(`${entry.net || '?'} 计算 ${round(calculated.impedanceOhm, 2)}Ω，目标 ${target}Ω，偏差 ${round(deviation, 2)}% 超过 ±${tolerancePercent}%`);
      }
      if (missing.length) return review(`阻抗数据不完整（缺目标/线宽/叠层）：${missing.join('、')}`, { checked, missing });
      if (problems.length) return fail(`阻抗偏离目标：${problems.join('；')}`, { checked });
      return ok({ checked }, '阻抗在容差范围内');
    },
  },
  {
    id: 'NET-05', group: 'NET', name: '过孔载流', level: '硬门禁',
    check: ({ input }) => {
      const entries = Array.isArray(input.vias) ? input.vias : null;
      if (!entries) return review('未提供过孔载流数据 vias');
      if (!entries.length) return na('本板没有需要载流校核的过孔');
      const problems = []; const checked = []; const missing = [];
      for (const entry of entries) {
        const current = toNum(entry.currentA); const diameter = toNum(entry.diameterMm ?? entry.holeDiameterMm);
        const thickness = toNum(entry.copperThicknessUm) ?? 25; const rise = toNum(entry.tempRiseC) ?? 10;
        if (!(current > 0) || !(diameter > 0)) { missing.push(entry.id || entry.net || '?'); continue; }
        const capacity = viaCurrentCapacity({ temperatureRiseC: rise, apertureDiameterMm: diameter, copperThicknessUm: thickness });
        if (!capacity) { missing.push(entry.id || entry.net || '?'); continue; }
        checked.push({ id: entry.id || entry.net, currentA: current, maxCurrentA: round(capacity.maxCurrentA, 3), diameterMm: diameter });
        if (capacity.maxCurrentA + EPS < current) problems.push(`过孔 ${entry.id || '?'} 载流 ${round(capacity.maxCurrentA, 3)}A 小于 ${current}A`);
      }
      if (missing.length) return review(`过孔载流数据不完整：${missing.join('、')}`, { checked, missing });
      if (problems.length) return fail(`过孔载流不足：${problems.join('；')}`, { checked });
      return ok({ checked }, '过孔载流满足要求');
    },
  },
];

export function evaluateNetRules(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const nets = Array.isArray(source.nets) ? source.nets.map((net) => String(net ?? '').trim()).filter(Boolean) : null;
  const classified = nets ? classifyNets(nets) : [];
  const copper = normalizeCopper(source.copper);
  const ctx = { input: source, copper, nets, classified };
  const rules = NET_RULES.map((rule) => {
    const result = rule.check(ctx);
    return {
      id: rule.id, group: rule.group, name: rule.name, level: rule.level,
      status: result.status, message: result.message, evidence: result.evidence ?? null,
    };
  });
  const count = (status) => rules.filter((rule) => rule.status === status).length;
  const summary = {
    total: rules.length,
    PASS: count(STATUS.PASS), FAIL: count(STATUS.FAIL), REVIEW: count(STATUS.REVIEW), NA: count(STATUS.NA),
    blockingFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level === '硬门禁').length,
    warningFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level !== '硬门禁').length,
  };
  const findings = rules.filter((rule) => rule.status === STATUS.FAIL).map((rule) => finding(
    `NET_RULE_${rule.id}`,
    rule.message,
    `netRules.${rule.id}`,
    rule.level === '硬门禁' ? 'blocking' : 'warning',
  ));
  const core = {
    kind: 'net-rule-audit', schemaVersion: 1,
    nets: nets || [], classified,
    rules, summary, findings,
    passed: summary.blockingFailures === 0,
    releaseReady: summary.FAIL === 0 && summary.REVIEW === 0,
    humanReviewRequired: true,
    policy: 'REVIEW 不等于 PASS：网络/载流/阻抗数据缺失时必须在网表、板厂计算器或实测中闭合；本审计不替代 EDA DRC。',
  };
  return { ...core, auditHash: sha256(JSON.stringify(core)) };
}

/** 规则元信息：给 GET /api/engineering/net-rules 用，避免服务端重复维护规则清单。 */
export function netRuleSummary() {
  return {
    rules: NET_RULES.map((rule) => ({ id: rule.id, name: rule.name, level: rule.level })),
    fixtures: Object.keys(NET_RULE_FIXTURES),
    policy: 'REVIEW 不等于 PASS；本审计不替代 EDA DRC 与板厂阻抗计算器。',
  };
}

// ---------------------------------------------------------------------------
// 4. 样板
// ---------------------------------------------------------------------------
function usb3PassFixture() {
  const stackup = { heightMm: 0.18, er: 4.1, copperThicknessMm: 0.035 };
  const single = microstripImpedance({ widthMm: 0.2, heightMm: stackup.heightMm, thicknessMm: stackup.copperThicknessMm, er: stackup.er });
  return {
    nets: ['GND', '+3V3', 'USB3_SSTX_P', 'USB3_SSTX_N', 'CLK_Z50', 'GPIO12'],
    copper: { thicknessUm: 35, external: true, tempRiseC: 10, ambientC: 25 },
    power: [{ net: '+3V3', currentA: 1.0, actualWidthMm: 0.4 }],
    pairs: [{ name: 'USB3_SSTX', positive: 'USB3_SSTX_P', negative: 'USB3_SSTX_N', targetOhms: 90 }],
    impedance: [{ net: 'CLK_Z50', targetOhms: single.impedanceOhm, actualWidthMm: 0.2, stackup }],
    vias: [],
  };
}

function usb3FailFixture() {
  const stackup = { heightMm: 0.18, er: 4.1, copperThicknessMm: 0.035 };
  return {
    nets: ['GND', '+3V3', 'USB0_DP', 'GPIO12'],
    copper: { thicknessUm: 35, external: true, tempRiseC: 10, ambientC: 25 },
    power: [{ net: '+3V3', currentA: 3.0, actualWidthMm: 0.05 }],
    pairs: [{ name: 'USB0', positive: 'USB0_DP', negative: 'USB0_DM', targetOhms: 90 }],
    impedance: [{ net: 'CLK_Z50', targetOhms: 50, actualWidthMm: 0.5, stackup }],
    vias: [{ id: 'V1', currentA: 5.0, diameterMm: 0.2, copperThicknessUm: 25, tempRiseC: 10 }],
  };
}

export const NET_RULE_FIXTURES = {
  'NET-USB3-PASS': usb3PassFixture,
  'NET-USB3-FAIL': usb3FailFixture,
  'NET-REVIEW': () => ({ nets: ['CLK_Z50'], copper: { thicknessUm: 35 } }),
};
