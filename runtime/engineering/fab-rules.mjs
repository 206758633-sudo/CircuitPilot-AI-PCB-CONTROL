/**
 * 板厂工艺能力规则（FAB pack）：把 JLCPCB / PCBWay / Generic 的制造能力数值变成可执行判定。
 *
 * 数据来源：
 *   - 数值：Cimos/kicad-druid（MIT）的 capabilities/JLCPCB.toml + PCBWay.toml 生成对照表，
 *     原始能力页为 jlcpcb.com/capabilities/pcb-capabilities 与 pcbway.com/capabilities.html。
 *     已落盘为 ./rules/fab-capabilities.json（含来源/许可/提取时间）。
 *   - 规则语义参照：easyeda/eext-design-rule-generator（Apache-2.0）与 IPC-2221。
 *
 * 与 board-layout-rules（151 条板级布局规则）的分工：
 *   - 这里只回答“这块板的几何/工艺参数是否落在板厂能力范围内”；
 *   - 不判断布局关系、不替代 DRC、不冒充板厂确认单。
 *
 * 判定语义与仓库其它工程模块一致：PASS / FAIL / REVIEW / NA。
 *   - REVIEW 不等于 PASS：缺数据一律 REVIEW，不靠“看起来没问题”放行；
 *   - NA 只用于“本板确实没有该对象”（如 2 层板没有内层线宽）。
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { finding } from './stackup.mjs';

const PACK_URL = new URL('./rules/fab-capabilities.json', import.meta.url);
export const FAB_PROFILE_PACK_PATH = PACK_URL;

export const FAB_RULE_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });
const STATUS = FAB_RULE_STATUS;
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
const mm = (value) => `${round(value)} mm`;
const ok = (evidence, message) => ({ status: STATUS.PASS, evidence, message });
const fail = (message, evidence) => ({ status: STATUS.FAIL, message, evidence });
const review = (message, evidence) => ({ status: STATUS.REVIEW, message, evidence });
const na = (message) => ({ status: STATUS.NA, message });

/** 把 "0.15mm" / "0.15" / "—" / "n/a" 归一化成 mm 数值；无法解析返回 null（缺数据，不猜）。 */
export function parseMm(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text || /^(—+|–+|n\/a|na|none|-)$/i.test(text)) return null;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(mm|mil)?/i);
  if (!match) return null;
  const valueNum = Number(match[1]);
  if (!Number.isFinite(valueNum)) return null;
  return /mil/i.test(match[2] || '') ? valueNum * 0.0254 : valueNum;
}

let cachedPack = null;

export function validateFabProfilePack(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return ['缺少规则包对象'];
  if (raw.schemaVersion !== 1) problems.push('schemaVersion 必须为 1');
  if (!raw.variants || typeof raw.variants !== 'object') problems.push('缺少 variants');
  if (!raw.fixedLimits || typeof raw.fixedLimits !== 'object') problems.push('缺少 fixedLimits');
  const fabs = Object.keys(raw.variants || {});
  if (!fabs.length) problems.push('variants 为空');
  for (const fab of fabs) {
    const variants = raw.variants[fab];
    const keys = Object.keys(variants || {});
    if (!keys.length) problems.push(`${fab} 没有变体`);
    for (const key of keys) {
      const variant = variants[key];
      for (const field of ['drillHoleMin', 'viaHoleMin', 'traceWidthOuter', 'traceSpacingOuter']) {
        if (!(field in variant)) problems.push(`${fab}/${key} 缺少 ${field}`);
      }
    }
  }
  return problems;
}

export function fabProfilePack() {
  if (cachedPack) return cachedPack;
  const raw = JSON.parse(readFileSync(PACK_URL, 'utf8'));
  const problems = validateFabProfilePack(raw);
  if (problems.length) {
    throw Object.assign(new Error(`板厂能力规则包不合法：${problems.join('；')}`), { code: 'FAB_PROFILE_PACK_INVALID', details: problems });
  }
  cachedPack = Object.freeze({ ...raw, hash: sha256(JSON.stringify(raw)) });
  return cachedPack;
}

/** 只回元信息，不把 30 条限值全文塞进每个 API 响应。 */
export function fabProfileSummary() {
  const pack = fabProfilePack();
  return {
    schemaVersion: pack.schemaVersion,
    kind: pack.kind,
    hash: pack.hash,
    extractedAt: pack.extractedAt,
    source: pack.source,
    fabs: Object.keys(pack.variants),
    variants: Object.fromEntries(Object.entries(pack.variants).map(([fab, variants]) => [fab, Object.keys(variants)])),
    fixedLimitCount: Object.keys(pack.fixedLimits).length,
    rules: FAB_RULES.map((rule) => ({ id: rule.id, name: rule.name, level: rule.level })),
    policy: { reviewIsNotPass: true, notADrcReplacement: true, humanConfirmationRequired: true },
  };
}

function variantLayers(variant) {
  const match = String(variant).match(/^(\d+)L/i);
  return match ? Number(match[1]) : null;
}
function variantCopperOz(variant) {
  const match = String(variant).match(/(\d+)oz/i);
  return match ? Number(match[1]) : null;
}

/**
 * 取指定 fab + 变体的归一化能力值。
 * 变体可按前缀匹配（如 "4L" → "4L-1oz (default)"），但默认值必须显式。
 */
export function resolveFabProfile(fab = 'JLCPCB', variant = '4L-1oz') {
  const pack = fabProfilePack();
  const variants = pack.variants[fab];
  if (!variants) {
    throw Object.assign(new Error(`未知板厂：${fab}（可选：${Object.keys(pack.variants).join('、')}）`), { code: 'FAB_PROFILE_UNKNOWN_FAB' });
  }
  const keys = Object.keys(variants);
  const resolved = keys.find((key) => key === variant) || keys.find((key) => key.startsWith(String(variant))) || null;
  if (!resolved) {
    throw Object.assign(new Error(`未知变体：${variant}（${fab} 可选：${keys.join('、')}）`), { code: 'FAB_PROFILE_UNKNOWN_VARIANT' });
  }
  const variantData = variants[resolved];
  const limit = (name) => parseMm(pack.fixedLimits[name]?.[fab]);
  const profile = {
    fab,
    variant: resolved,
    packHash: pack.hash,
    layers: variantLayers(resolved),
    copperOz: variantCopperOz(resolved),
    minTraceWidthOuterMm: parseMm(variantData.traceWidthOuter),
    minTraceWidthInnerMm: parseMm(variantData.traceWidthInner),
    minSpacingOuterMm: parseMm(variantData.traceSpacingOuter),
    minSpacingInnerMm: parseMm(variantData.traceSpacingInner),
    minDrillHoleMm: parseMm(variantData.drillHoleMin),
    minViaHoleMm: parseMm(variantData.viaHoleMin),
    minViaAnnularMm: limit('Via annular ring — min'),
    minPthHoleMm: limit('PTH hole — min'),
    maxPthHoleMm: limit('PTH hole — max'),
    minPthAnnularMm: limit('PTH annular ring — min'),
    minNpthHoleMm: limit('NPTH hole — min'),
    minNpthAnnularMm: limit('NPTH annular ring — min'),
    minPlatedSlotWidthMm: limit('Plated slot width — min'),
    minNonPlatedSlotWidthMm: limit('Non-plated slot width — min'),
    minSmdPadMm: limit('SMD pad size — min'),
    minSilkLineWidthMm: limit('Silk line width — min'),
    minSilkTextHeightMm: limit('Silk text height — min'),
    minPadToSilkMm: limit('Pad to silkscreen'),
    minTraceToEdgeMm: limit('Trace to board edge (routed)'),
    blindBuriedAllowed: pack.processNotes['Blind/buried vias allowed']?.[fab] === 'yes',
    processNotes: pack.processNotes,
    fixedLimits: pack.fixedLimits,
  };
  return Object.freeze(profile);
}

// ---------------------------------------------------------------------------
// 规则：编号 FAB-01 .. FAB-16
// ---------------------------------------------------------------------------
const readArea = (raw, area) => {
  if (isNum(raw)) return raw;
  if (raw && typeof raw === 'object') return toNum(raw[area] ?? raw[`${area}Mm`] ?? null);
  return null;
};

function compareMin(value, threshold, label) {
  if (value === null || value === undefined) return null;
  if (threshold === null || threshold === undefined) return null;
  return value + EPS < threshold ? `${label} ${mm(value)} 小于下限 ${mm(threshold)}` : null;
}
function compareMax(value, threshold, label) {
  if (value === null || value === undefined) return null;
  if (threshold === null || threshold === undefined) return null;
  return value > threshold + EPS ? `${label} ${mm(value)} 超过上限 ${mm(threshold)}` : null;
}
function collectProblems(list) {
  const problems = list.filter(Boolean);
  return problems.length ? problems : null;
}

export const FAB_RULES = [
  {
    id: 'FAB-01', group: 'FAB', name: '最小走线宽度', level: '硬门禁',
    check: ({ design, profile }) => {
      const raw = design.minTraceWidthMm;
      if (raw === undefined) return review('未提供实际最小走线宽度 minTraceWidthMm');
      const outer = readArea(raw, 'outer'); const inner = readArea(raw, 'inner');
      if (outer === null && inner === null) return review('minTraceWidthMm 无法解析（需要数字或 {outer,inner}）');
      const problems = collectProblems([
        compareMin(outer, profile.minTraceWidthOuterMm, '外层线宽'),
        compareMin(inner, profile.minTraceWidthInnerMm, '内层线宽'),
      ]);
      if (problems) return fail(`线宽小于 ${profile.fab} ${profile.variant} 的能力：${problems.join('；')}`, { outer, inner, thresholdOuter: profile.minTraceWidthOuterMm, thresholdInner: profile.minTraceWidthInnerMm });
      if (outer === null && profile.minTraceWidthOuterMm !== null) return review('未提供外层线宽，无法判定外层能力');
      return ok({ outer, inner, thresholdOuter: profile.minTraceWidthOuterMm, thresholdInner: profile.minTraceWidthInnerMm }, `线宽满足 ${profile.fab} ${profile.variant} 下限`);
    },
  },
  {
    id: 'FAB-02', group: 'FAB', name: '最小走线间距', level: '硬门禁',
    check: ({ design, profile }) => {
      const raw = design.minSpacingMm;
      if (raw === undefined) return review('未提供实际最小走线间距 minSpacingMm');
      const outer = readArea(raw, 'outer'); const inner = readArea(raw, 'inner');
      if (outer === null && inner === null) return review('minSpacingMm 无法解析（需要数字或 {outer,inner}）');
      const problems = collectProblems([
        compareMin(outer, profile.minSpacingOuterMm, '外层间距'),
        compareMin(inner, profile.minSpacingInnerMm, '内层间距'),
      ]);
      if (problems) return fail(`间距小于 ${profile.fab} ${profile.variant} 的能力：${problems.join('；')}`, { outer, inner });
      return ok({ outer, inner }, '间距满足板厂能力下限');
    },
  },
  {
    id: 'FAB-03', group: 'FAB', name: '过孔孔径', level: '硬门禁',
    check: ({ design, profile }) => {
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes');
      const vias = holes.filter((hole) => String(hole?.type || '').toLowerCase() === 'via');
      if (!vias.length) return na('本板没有过孔');
      const problems = [];
      const checked = [];
      for (const via of vias) {
        const diameter = toNum(via.diameterMm);
        if (diameter === null) { problems.push(`${via.id || 'via'} 缺直径`); continue; }
        checked.push({ id: via.id || 'via', diameterMm: diameter });
        const problem = compareMin(diameter, profile.minViaHoleMm, `过孔 ${via.id || ''} 孔径`);
        if (problem) problems.push(problem);
      }
      if (problems.some((problem) => problem.includes('缺直径'))) return review(`部分过孔缺直径：${problems.join('；')}`);
      if (problems.length) return fail(`过孔孔径小于 ${profile.fab} ${profile.variant} 下限：${problems.join('；')}`, { checked, threshold: profile.minViaHoleMm });
      return ok({ checked, threshold: profile.minViaHoleMm }, '过孔孔径满足能力下限');
    },
  },
  {
    id: 'FAB-04', group: 'FAB', name: '过孔 annular ring', level: '硬门禁',
    check: ({ design, profile }) => {
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes');
      const vias = holes.filter((hole) => String(hole?.type || '').toLowerCase() === 'via');
      if (!vias.length) return na('本板没有过孔');
      const missing = vias.filter((via) => toNum(via.annularRingMm) === null);
      if (missing.length) return review(`过孔缺 annular ring 实测值：${missing.map((via) => via.id || 'via').join('、')}`);
      const problems = vias.map((via) => compareMin(toNum(via.annularRingMm), profile.minViaAnnularMm, `过孔 ${via.id || ''} annular ring`)).filter(Boolean);
      if (problems.length) return fail(`annular ring 小于 ${profile.fab} 下限：${problems.join('；')}`, { threshold: profile.minViaAnnularMm });
      return ok({ threshold: profile.minViaAnnularMm }, '过孔 annular ring 满足能力下限');
    },
  },
  {
    id: 'FAB-05', group: 'FAB', name: 'PTH 孔径', level: '硬门禁',
    check: ({ design, profile }) => {
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes');
      const pth = holes.filter((hole) => String(hole?.type || '').toUpperCase() === 'PTH');
      if (!pth.length) return na('本板没有 PTH');
      const missing = pth.filter((hole) => toNum(hole.diameterMm) === null);
      if (missing.length) return review(`PTH 缺孔径：${missing.map((hole) => hole.id || 'PTH').join('、')}`);
      const problems = pth.flatMap((hole) => [compareMin(toNum(hole.diameterMm), profile.minPthHoleMm, `PTH ${hole.id || ''} 孔径`), compareMax(toNum(hole.diameterMm), profile.maxPthHoleMm, `PTH ${hole.id || ''} 孔径`)]).filter(Boolean);
      if (problems.length) return fail(`PTH 孔径超出 ${profile.fab} 能力：${problems.join('；')}`, { thresholdMin: profile.minPthHoleMm, thresholdMax: profile.maxPthHoleMm });
      return ok({ thresholdMin: profile.minPthHoleMm, thresholdMax: profile.maxPthHoleMm }, 'PTH 孔径在能力范围内');
    },
  },
  {
    id: 'FAB-06', group: 'FAB', name: 'PTH annular ring', level: '硬门禁',
    check: ({ design, profile }) => {
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes');
      const pth = holes.filter((hole) => String(hole?.type || '').toUpperCase() === 'PTH');
      if (!pth.length) return na('本板没有 PTH');
      const missing = pth.filter((hole) => toNum(hole.annularRingMm) === null);
      if (missing.length) return review(`PTH 缺 annular ring 实测值：${missing.map((hole) => hole.id || 'PTH').join('、')}`);
      const problems = pth.map((hole) => compareMin(toNum(hole.annularRingMm), profile.minPthAnnularMm, `PTH ${hole.id || ''} annular ring`)).filter(Boolean);
      if (problems.length) return fail(`PTH annular ring 小于 ${profile.fab} 下限：${problems.join('；')}`, { threshold: profile.minPthAnnularMm });
      return ok({ threshold: profile.minPthAnnularMm }, 'PTH annular ring 满足能力下限');
    },
  },
  {
    id: 'FAB-07', group: 'FAB', name: 'NPTH 孔径', level: '硬门禁',
    check: ({ design, profile }) => {
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes');
      const npth = holes.filter((hole) => String(hole?.type || '').toUpperCase() === 'NPTH');
      if (!npth.length) return na('本板没有 NPTH');
      const missing = npth.filter((hole) => toNum(hole.diameterMm) === null);
      if (missing.length) return review(`NPTH 缺孔径：${missing.map((hole) => hole.id || 'NPTH').join('、')}`);
      const problems = npth.map((hole) => compareMin(toNum(hole.diameterMm), profile.minNpthHoleMm, `NPTH ${hole.id || ''} 孔径`)).filter(Boolean);
      if (problems.length) return fail(`NPTH 孔径小于 ${profile.fab} 下限：${problems.join('；')}`, { threshold: profile.minNpthHoleMm });
      return ok({ threshold: profile.minNpthHoleMm }, 'NPTH 孔径满足能力下限');
    },
  },
  {
    id: 'FAB-08', group: 'FAB', name: '金属化槽', level: '硬门禁',
    check: ({ design, profile }) => {
      const slots = design.slots;
      if (!Array.isArray(slots)) return review('未提供槽清单 slots');
      const plated = slots.filter((slot) => slot?.plated === true);
      if (!plated.length) return na('本板没有金属化槽');
      const problems = [];
      for (const slot of plated) {
        const width = toNum(slot.widthMm); const length = toNum(slot.lengthMm);
        if (width === null) { problems.push(`${slot.id || 'slot'} 缺槽宽`); continue; }
        const widthProblem = compareMin(width, profile.minPlatedSlotWidthMm, `金属化槽 ${slot.id || ''} 宽度`);
        if (widthProblem) problems.push(widthProblem);
        if (length !== null && length + EPS < width * 2) problems.push(`金属化槽 ${slot.id || ''} 长宽比不足（长 ${mm(length)} < 2×宽 ${mm(width * 2)}）`);
      }
      if (problems.some((problem) => problem.includes('缺槽宽'))) return review(`部分金属化槽缺宽度：${problems.join('；')}`);
      if (problems.length) return fail(`金属化槽不满足 ${profile.fab} 能力：${problems.join('；')}`, { thresholdWidth: profile.minPlatedSlotWidthMm });
      return ok({ thresholdWidth: profile.minPlatedSlotWidthMm }, '金属化槽满足宽度与长宽比要求');
    },
  },
  {
    id: 'FAB-09', group: 'FAB', name: '非金属化槽', level: '硬门禁',
    check: ({ design, profile }) => {
      const slots = design.slots;
      if (!Array.isArray(slots)) return review('未提供槽清单 slots');
      const nonPlated = slots.filter((slot) => slot?.plated === false);
      if (!nonPlated.length) return na('本板没有非金属化槽');
      const problems = nonPlated.map((slot) => compareMin(toNum(slot.widthMm), profile.minNonPlatedSlotWidthMm, `非金属化槽 ${slot.id || ''} 宽度`)).filter(Boolean);
      if (nonPlated.some((slot) => toNum(slot.widthMm) === null)) return review('部分非金属化槽缺宽度');
      if (problems.length) return fail(`非金属化槽宽度小于 ${profile.fab} 下限：${problems.join('；')}`, { threshold: profile.minNonPlatedSlotWidthMm });
      return ok({ threshold: profile.minNonPlatedSlotWidthMm }, '非金属化槽满足能力下限');
    },
  },
  {
    id: 'FAB-10', group: 'FAB', name: 'SMD 焊盘最小尺寸', level: '硬门禁',
    check: ({ design, profile }) => {
      if (profile.minSmdPadMm === null) return na(`${profile.fab} 未声明 SMD 焊盘最小尺寸`);
      const pads = design.smdPads;
      if (!Array.isArray(pads)) return review('未提供 SMD 焊盘清单 smdPads');
      if (!pads.length) return na('本板没有 SMD 焊盘');
      const problems = [];
      const missing = [];
      for (const pad of pads) {
        const width = toNum(pad.widthMm); const height = toNum(pad.heightMm);
        if (width === null || height === null) { missing.push(pad.id || 'pad'); continue; }
        const minSide = Math.min(width, height);
        const problem = compareMin(minSide, profile.minSmdPadMm, `SMD 焊盘 ${pad.id || ''} 短边`);
        if (problem) problems.push(problem);
      }
      if (missing.length) return review(`部分 SMD 焊盘缺宽高：${missing.join('、')}`);
      if (problems.length) return fail(`SMD 焊盘小于 ${profile.fab} 下限：${problems.join('；')}`, { threshold: profile.minSmdPadMm });
      return ok({ threshold: profile.minSmdPadMm }, 'SMD 焊盘满足最小尺寸');
    },
  },
  {
    id: 'FAB-11', group: 'FAB', name: '丝印线宽与字高', level: '推荐',
    check: ({ design, profile }) => {
      const silk = design.silk;
      if (!silk || typeof silk !== 'object') return review('未提供丝印参数 silk');
      const lineWidth = toNum(silk.lineWidthMm); const textHeight = toNum(silk.textHeightMm);
      if (lineWidth === null && textHeight === null) return review('丝印参数缺 lineWidthMm / textHeightMm');
      const problems = collectProblems([
        compareMin(lineWidth, profile.minSilkLineWidthMm, '丝印线宽'),
        compareMin(textHeight, profile.minSilkTextHeightMm, '丝印字高'),
      ]);
      if (problems) return fail(`丝印参数小于 ${profile.fab} 建议值：${problems.join('；')}`, { lineWidthMm: lineWidth, textHeightMm: textHeight, thresholdLine: profile.minSilkLineWidthMm, thresholdHeight: profile.minSilkTextHeightMm });
      return ok({ lineWidthMm: lineWidth, textHeightMm: textHeight }, '丝印线宽与字高满足建议值');
    },
  },
  {
    id: 'FAB-12', group: 'FAB', name: '焊盘到丝印间距', level: '推荐',
    check: ({ design, profile }) => {
      const silk = design.silk;
      const gap = silk && typeof silk === 'object' ? toNum(silk.padToSilkMm) : null;
      if (gap === null) return review('未提供焊盘到丝印间距 silk.padToSilkMm');
      const problem = compareMin(gap, profile.minPadToSilkMm, '焊盘到丝印');
      if (problem) return fail(`焊盘到丝印间距小于 ${profile.fab} 下限：${problem}`, { padToSilkMm: gap, threshold: profile.minPadToSilkMm });
      return ok({ padToSilkMm: gap, threshold: profile.minPadToSilkMm }, '焊盘到丝印满足能力下限');
    },
  },
  {
    id: 'FAB-13', group: 'FAB', name: '走线到板边', level: '硬门禁',
    check: ({ design, profile }) => {
      const value = toNum(design.traceToEdgeMm);
      if (value === null) return review('未提供走线到板边实测值 traceToEdgeMm');
      const problem = compareMin(value, profile.minTraceToEdgeMm, '走线到板边');
      if (problem) return fail(`走线到板边小于 ${profile.fab} 下限：${problem}`, { traceToEdgeMm: value, threshold: profile.minTraceToEdgeMm });
      return ok({ traceToEdgeMm: value, threshold: profile.minTraceToEdgeMm }, '走线到板边满足能力下限');
    },
  },
  {
    id: 'FAB-14', group: 'FAB', name: '盲埋孔禁令', level: '硬门禁',
    check: ({ design, profile }) => {
      if (design.blindBuriedVias === undefined) return review('未声明是否使用盲埋孔 blindBuriedVias');
      if (design.blindBuriedVias === true && !profile.blindBuriedAllowed) return fail(`${profile.fab} ${profile.variant} 标准工艺不允许盲埋孔`, { blindBuriedVias: true, allowed: false });
      return ok({ blindBuriedVias: design.blindBuriedVias === true, allowed: profile.blindBuriedAllowed }, '盲埋孔使用符合板厂能力');
    },
  },
  {
    id: 'FAB-15', group: 'FAB', name: '小孔/小过孔加价提示', level: '推荐',
    check: ({ design, profile }) => {
      if (profile.fab !== 'JLCPCB') return na(`${profile.fab} 无此加价规则`);
      const holes = design.holes;
      if (!Array.isArray(holes)) return review('未提供孔清单 holes，无法判断小孔加价');
      const vias = holes.filter((hole) => String(hole?.type || '').toLowerCase() === 'via');
      if (!vias.length) return na('本板没有过孔');
      const risky = vias.filter((via) => {
        const hole = toNum(via.diameterMm);
        const dia = toNum(via.outerDiameterMm ?? via.padDiameterMm);
        return hole !== null && hole + EPS < 0.3 && (dia === null || dia + EPS < 0.45);
      });
      const riskyIds = Array.from(new Set(risky.map((via) => via.id || 'via')));
      if (riskyIds.length) return review(`JLCPCB 对小孔（<0.3mm 且过孔直径 <0.45mm）会加收四线 Kelvin 测试/小孔费用：${riskyIds.join('、')}`, { risky: riskyIds.join(',') });
      return ok({ checked: vias.length }, '未触发 JLCPCB 小孔加价规则');
    },
  },
  {
    id: 'FAB-16', group: 'FAB', name: '变体与层数/铜厚一致性', level: '硬门禁',
    check: ({ design, profile }) => {
      const layers = toNum(design.layers); const copperOz = toNum(design.copperOz);
      const problems = [];
      if (layers !== null && profile.layers !== null && layers !== profile.layers) problems.push(`设计层数 ${layers} 与变体 ${profile.variant} 的 ${profile.layers} 层不一致`);
      if (copperOz !== null && profile.copperOz !== null && copperOz !== profile.copperOz) problems.push(`设计铜厚 ${copperOz}oz 与变体 ${profile.variant} 的 ${profile.copperOz}oz 不一致`);
      if (problems.length) return fail(problems.join('；'), { layers, copperOz, variantLayers: profile.layers, variantCopperOz: profile.copperOz });
      if (layers === null && copperOz === null) return review('未提供设计层数/铜厚，无法核对变体');
      return ok({ layers, copperOz, variantLayers: profile.layers, variantCopperOz: profile.copperOz }, '设计层数/铜厚与选定变体一致');
    },
  },
];

export function evaluateFabRules(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const profile = resolveFabProfile(source.fab || 'JLCPCB', source.variant || '4L-1oz');
  const design = source.design && typeof source.design === 'object' ? source.design : {};
  const ctx = { design, profile };
  const rules = FAB_RULES.map((rule) => {
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
    `FAB_RULE_${rule.id}`,
    rule.message,
    `fabRules.${rule.id}`,
    rule.level === '硬门禁' ? 'blocking' : 'warning',
  ));
  const core = {
    kind: 'fab-rule-audit', schemaVersion: 1,
    fab: profile.fab, variant: profile.variant,
    pack: { hash: profile.packHash },
    rules, summary, findings,
    passed: summary.blockingFailures === 0,
    releaseReady: summary.FAIL === 0 && summary.REVIEW === 0,
    humanReviewRequired: true,
    policy: 'REVIEW 不等于 PASS：缺数据的规则必须在板厂确认单/DRC/实测中闭合；本审计不替代 EDA DRC 与板厂 DFM。',
  };
  return { ...core, auditHash: sha256(JSON.stringify(core)) };
}

// ---------------------------------------------------------------------------
// 样板：供测试与 HTTP fixture 使用
// ---------------------------------------------------------------------------
function compliantDesign() {
  return {
    layers: 4, copperOz: 1,
    minTraceWidthMm: { outer: 0.12, inner: 0.12 },
    minSpacingMm: { outer: 0.12, inner: 0.12 },
    holes: [
      { id: 'V1', type: 'via', diameterMm: 0.3, outerDiameterMm: 0.5, annularRingMm: 0.1 },
      { id: 'P1', type: 'PTH', diameterMm: 0.6, annularRingMm: 0.2 },
      { id: 'N1', type: 'NPTH', diameterMm: 1.0, annularRingMm: 0.5 },
    ],
    smdPads: [{ id: 'R1', widthMm: 0.8, heightMm: 0.6 }],
    silk: { lineWidthMm: 0.15, textHeightMm: 1.0, padToSilkMm: 0.2 },
    traceToEdgeMm: 0.3,
    slots: [{ id: 'S1', plated: true, widthMm: 0.5, lengthMm: 2.0 }],
    blindBuriedVias: false,
  };
}

function defectiveDesign() {
  return {
    layers: 4, copperOz: 1,
    minTraceWidthMm: { outer: 0.05, inner: 0.05 },
    minSpacingMm: { outer: 0.05, inner: 0.05 },
    holes: [
      { id: 'V1', type: 'via', diameterMm: 0.1, outerDiameterMm: 0.3, annularRingMm: 0.03 },
      { id: 'P1', type: 'PTH', diameterMm: 0.1, annularRingMm: 0.05 },
      { id: 'N1', type: 'NPTH', diameterMm: 0.3, annularRingMm: 0.2 },
    ],
    smdPads: [{ id: 'R1', widthMm: 0.1, heightMm: 0.1 }],
    silk: { lineWidthMm: 0.1, textHeightMm: 0.6, padToSilkMm: 0.05 },
    traceToEdgeMm: 0.1,
    slots: [{ id: 'S1', plated: true, widthMm: 0.2, lengthMm: 0.3 }],
    blindBuriedVias: true,
  };
}

export const FAB_RULE_FIXTURES = {
  'JLC-4L-PASS': () => ({ fab: 'JLCPCB', variant: '4L-1oz', design: compliantDesign() }),
  'JLC-4L-FAIL': () => ({ fab: 'JLCPCB', variant: '4L-1oz', design: defectiveDesign() }),
  'PCBWAY-4L-PASS': () => {
    const design = compliantDesign();
    design.holes = design.holes.map((hole) => (hole.type === 'via' ? { ...hole, annularRingMm: 0.2 } : hole));
    return { fab: 'PCBWay', variant: '4L-1oz', design };
  },
};
