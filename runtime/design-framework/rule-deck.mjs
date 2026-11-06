/**
 * Rule-as-Code 判定器（复合设计框架的规则执行层）。
 *
 * 输入：板级 IR（runtime/design-framework/board-model.mjs 的产物）+ 151 条布局规则包
 *       （runtime/engineering/rules/board-layout-rules.json，由 02/03 号设计规则文档机械抽取）。
 * 输出：逐条 PASS / FAIL / REVIEW / NA + 证据 + 稳定 digest，供评估台 / 门禁 / 闭环使用。
 *
 * 三条硬原则（与仓库其它工程模块一致）：
 *   1. **没有机器判据就不许给 PASS**：只有文字判定、或 IR 缺必要事实的规则一律 REVIEW
 *      （evidence.reason = NO_MACHINE_CHECKER / FACT_MISSING / CHECKER_ERROR）；
 *   2. **NA 只给"本板确实没有该对象"**：例如板上没有 QFN，SPACE-07 才判 NA；缺数据一律 REVIEW；
 *   3. **判定函数不抛异常**：单条 checker 出错降级为 REVIEW（CHECKER_ERROR），整份 deck 仍然产出。
 *
 * 覆盖范围（当前 32 条机器判据）：MECH(4)/SPACE(12)/ZCLR(3)/CONN(2)/RF(1)/PWR(1)/DFM(4)/DFA(2)/GATE(2)/PRJ(1)。
 * SILK 与 MOVE 依赖的丝印层/变更历史不在板级 IR 内，按 NO_MACHINE_CHECKER 判 REVIEW——
 * 这不是遗漏，而是"没有事实就不猜"：等 IR 扩展或外部证据注入后再升级为机器判定。
 *
 * 纯函数：只读规则包（import 时一次）与 PRJ-02 需要核对的两份源文档；不联网、不取当前时间。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { evaluateFabRules, resolveFabProfile } from '../engineering/fab-rules.mjs';
import { BOARD_MODEL_SCHEMA_VERSION, boardModelDigest, canonicalJson, createBoardModel } from './board-model.mjs';
import { widthForCurrent } from './ipc-rules.mjs';

/* ------------------------------------------------------------------ */
/* 规则包加载与校验                                                    */
/* ------------------------------------------------------------------ */

const RULE_PACK_URL = new URL('../engineering/rules/board-layout-rules.json', import.meta.url);
const REPO_ROOT_URL = new URL('../../', import.meta.url);

export const RULE_PACK_PATH = RULE_PACK_URL;
export const RULE_DECK_CODES = Object.freeze({
  PACK_INVALID: 'RULE_PACK_INVALID',
  MODEL_INVALID: 'RULE_DECK_MODEL_INVALID',
  CHECKER_INVALID: 'RULE_DECK_CHECKER_INVALID',
});

export const RULE_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });
const { PASS, FAIL, REVIEW, NA } = RULE_STATUS;

/** 审查结论里"机器判据缺失"的原因码（写进 evidence.reason）。 */
export const REVIEW_REASONS = Object.freeze({
  NO_MACHINE_CHECKER: 'NO_MACHINE_CHECKER',
  FACT_MISSING: 'FACT_MISSING',
  CHECKER_ERROR: 'CHECKER_ERROR',
});

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const EPS = 1e-9;
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 6) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);
const uniq = (values) => [...new Set(values)];

/**
 * 判定"硬门禁"等级：规则包现在用「硬门禁 / 推荐」，但为兼容其它来源，写法里只要出现
 * 硬门禁/阻断/blocking/error/P0 就按硬门禁处理；"推荐/建议/参考/warning" 不算阻断。
 */
export function isHardGateLevel(level) {
  const text = String(level ?? '').trim();
  if (!text) return true; // 等级缺失时按最严处理，避免"没写等级=不阻断"
  if (/硬门禁|阻断|blocking|critical|error|p0/i.test(text)) return true;
  if (/推荐|建议|参考|warning|suggest|advisory/i.test(text)) return false;
  return true;
}

function loadRulePack() {
  const raw = JSON.parse(readFileSync(RULE_PACK_URL, 'utf8'));
  const problems = [];
  if (!Array.isArray(raw.rules)) problems.push('rules 必须是数组');
  if (raw.total !== raw.rules?.length) problems.push(`total(${raw.total}) 与 rules.length(${raw.rules?.length}) 不一致`);
  const ids = new Set();
  const groupCounts = {};
  const levelCounts = {};
  for (const rule of raw.rules ?? []) {
    for (const field of ['id', 'group', 'name', 'level', 'value', 'check']) {
      if (typeof rule?.[field] !== 'string' || !rule[field].trim()) problems.push(`规则 ${rule?.id ?? '?'} 缺少 ${field}`);
    }
    if (ids.has(rule.id)) problems.push(`规则 id 重复：${rule.id}`);
    ids.add(rule.id);
    if (!Array.isArray(raw.groupIdOrder) || !raw.groupIdOrder.includes(rule.group)) problems.push(`规则 ${rule.id} 的 group ${rule.group} 不在 groupIdOrder 内`);
    groupCounts[rule.group] = (groupCounts[rule.group] ?? 0) + 1;
    levelCounts[rule.level] = (levelCounts[rule.level] ?? 0) + 1;
  }
  for (const [group, count] of Object.entries(raw.counts ?? {})) {
    if ((groupCounts[group] ?? 0) !== count) problems.push(`group ${group} 计数 ${groupCounts[group] ?? 0} ≠ 规则包声明 ${count}`);
  }
  for (const [level, count] of Object.entries(raw.levelCounts ?? {})) {
    if ((levelCounts[level] ?? 0) !== count) problems.push(`level ${level} 计数 ${levelCounts[level] ?? 0} ≠ 规则包声明 ${count}`);
  }
  if (problems.length) {
    throw Object.assign(new Error(`规则包不合法：${problems.slice(0, 8).join('；')}`), { code: RULE_DECK_CODES.PACK_INVALID, details: problems });
  }
  return Object.freeze({
    path: RULE_PACK_URL,
    title: raw.title ?? '',
    version: raw.version ?? '',
    generatedFrom: raw.generatedFrom ?? '',
    generatedFor: raw.generatedFor ?? '',
    usage: raw.usage ?? '',
    total: raw.total,
    documents: Object.freeze({ ...(raw.documents ?? {}) }),
    sourceHashes: Object.freeze({ ...(raw.sourceHashes ?? {}) }),
    groupIdOrder: Object.freeze([...(raw.groupIdOrder ?? [])]),
    groupNames: Object.freeze({ ...(raw.groupNames ?? {}) }),
    levelCounts: Object.freeze({ ...levelCounts }),
    counts: Object.freeze({ ...groupCounts }),
    rules: Object.freeze((raw.rules ?? []).map((rule) => Object.freeze({ ...rule }))),
    digest: sha256(JSON.stringify(raw.rules ?? [])),
  });
}

/** 规则包（加载时校验；不合法直接抛 RULE_PACK_INVALID，绝不在坏规则包上判定）。 */
export const RULE_PACK = loadRulePack();

/* ------------------------------------------------------------------ */
/* 通用结果构造                                                        */
/* ------------------------------------------------------------------ */

const pass = (message, evidence = null) => ({ status: PASS, message, evidence });
const fail = (message, evidence = null) => ({ status: FAIL, message, evidence });
const review = (message, reason = REVIEW_REASONS.FACT_MISSING, evidence = null) => ({
  status: REVIEW,
  message,
  evidence: { reason, ...(evidence ?? {}) },
});
const na = (message, evidence = null) => ({ status: NA, message, evidence });
const noChecker = (message = '规则包只给了文字判定，board IR 也没有对应机器可判字段；本判定器不给 PASS') =>
  review(message, REVIEW_REASONS.NO_MACHINE_CHECKER);

/* ------------------------------------------------------------------ */
/* 几何辅助（单位 mm；坐标原点 = 板框包围盒左下角）                    */
/* ------------------------------------------------------------------ */

const sizeKnown = (component) => component?.sizeUnknown !== true && isNum(component?.widthMm) && isNum(component?.heightMm);
const heightKnown = (component) => isNum(component?.heightMm3d);
const rotationOf = (component) => {
  const raw = Number.isFinite(component?.rotationDeg) ? component.rotationDeg : 0;
  return ((raw % 360) + 360) % 360;
};
const isSwappedRotation = (component) => {
  const rotation = rotationOf(component);
  return Math.abs(rotation - 90) <= EPS || Math.abs(rotation - 270) <= EPS;
};

/** 器件本体矩形（考虑 90°/270° 旋转后的宽高交换）。调用前必须 sizeKnown。 */
function bodyRect(component) {
  const swapped = isSwappedRotation(component);
  const widthMm = swapped ? component.heightMm : component.widthMm;
  const heightMm = swapped ? component.widthMm : component.heightMm;
  return {
    x0: component.xMm - widthMm / 2,
    y0: component.yMm - heightMm / 2,
    x1: component.xMm + widthMm / 2,
    y1: component.yMm + heightMm / 2,
    widthMm,
    heightMm,
  };
}
const expandRect = (rect, marginMm) => ({ x0: rect.x0 - marginMm, y0: rect.y0 - marginMm, x1: rect.x1 + marginMm, y1: rect.y1 + marginMm });

/** 两个矩形的最近距离（相交为 0）。 */
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}
function overlapArea(a, b) {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}
/** 矩形到板框四边的最近距离（负数 = 越界）。 */
function rectEdgeClearance(rect, bbox) {
  return Math.min(rect.x0 - bbox.x0, rect.y0 - bbox.y0, bbox.x1 - rect.x1, bbox.y1 - rect.y1);
}
/** 板框包围盒：有点集用点集，没有就用声明宽高（坐标原点 = 左下角）。 */
function boardBBox(model) {
  const outline = Array.isArray(model.board.outline) ? model.board.outline : null;
  if (outline && outline.length >= 3) {
    const xs = outline.map((point) => point[0]);
    const ys = outline.map((point) => point[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), source: 'outline-bbox' };
  }
  return { x0: 0, y0: 0, x1: model.board.widthMm, y1: model.board.heightMm, source: 'declared-size' };
}
function pointRectDistance(point, rect) {
  const dx = Math.max(rect.x0 - point[0], 0, point[0] - rect.x1);
  const dy = Math.max(rect.y0 - point[1], 0, point[1] - rect.y1);
  return Math.hypot(dx, dy);
}
const pointsEqual = (a, b, tolerance = 1e-6) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;

/** 线段相交（端点相触也算；用于板框自交检测）。 */
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  const straddle = (a, b) => (a > EPS && b < -EPS) || (a < -EPS && b > EPS);
  if (straddle(d1, d2) && straddle(d3, d4)) return true;
  const onSegment = (a, b, c) => Math.abs(cross(a, b, c)) <= 1e-9 && Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  if (onSegment(p3, p4, p1)) return true;
  if (onSegment(p3, p4, p2)) return true;
  if (onSegment(p1, p2, p3)) return true;
  if (onSegment(p1, p2, p4)) return true;
  return false;
}

/** 板框自交：去掉闭合重复点后逐对非相邻边求交。 */
function outlineSelfIntersecting(outline) {
  const closed = outline.length >= 2 && pointsEqual(outline[0], outline[outline.length - 1]);
  const points = closed ? outline.slice(0, -1) : outline;
  if (points.length < 3) return true;
  const m = points.length;
  for (let i = 0; i < m; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % m];
    if (pointsEqual(a1, a2)) continue; // 重复/零长边交给"重复线"另行人工确认
    for (let j = i + 1; j < m; j += 1) {
      if (j === i + 1 || (i === 0 && j === m - 1)) continue; // 相邻边共享端点不算自交
      const b1 = points[j];
      const b2 = points[(j + 1) % m];
      if (pointsEqual(b1, b2)) continue;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function componentPairs(components) {
  const pairs = [];
  for (let i = 0; i < components.length; i += 1) {
    for (let j = i + 1; j < components.length; j += 1) pairs.push([components[i], components[j]]);
  }
  return pairs;
}
const sameSide = (a, b) => a.side === b.side;

/* ------------------------------------------------------------------ */
/* 器件类别识别（footprint / mpn / tags 的保守分类）                    */
/* ------------------------------------------------------------------ */

/**
 * 从 footprint/mpn/tags 里识别器件类别。识别不出来就返回 null——**绝不猜**：
 * 需要类别的规则在"有器件但类别不可识别"时判 REVIEW，而不是 NA/PASS。
 */
export function classifyComponent(component) {
  const tags = (Array.isArray(component?.tags) ? component.tags : []).map((tag) => String(tag).toLowerCase());
  const footprint = String(component?.footprint ?? '').toLowerCase();
  const mpn = String(component?.mpn ?? '').toLowerCase();
  const hay = `${footprint} ${mpn} ${tags.join(' ')}`;
  const tagHas = (pattern) => tags.some((tag) => pattern.test(tag));
  if (tagHas(/antenna|天线/) || /(^|[^a-z])antenna([^a-z]|$)/.test(hay)) return 'antenna';
  if (tagHas(/connector|连接器|usb|type-?c|ffc|zif/) || /(^|[^a-z])(usb|type-?c|type-?a|ffc|zif|jst|header|connector|btb|pogopin|hdmi|rj45)([^a-z]|$)/.test(hay)) return 'connector';
  if (tagHas(/crystal|晶振|xtal/) || /crystal|xtal|oscillator|32\.?768|16\.?000|24\.?000/.test(hay)) return 'crystal';
  if (tagHas(/inductor|电感|choke/) || /inductor|ferrite|choke|power-?ind|\d+(?:\.\d+)?\s*(?:uh|µh|mh)\b/.test(hay)) return 'inductor';
  if (tagHas(/shield|屏蔽罩/) || /shield|屏蔽罩/.test(hay)) return 'shield';
  if (tagHas(/module|模组/) || /module|esp32|esp8266|nrf52/.test(hay)) return 'module';
  if (/qfn|dfn/.test(hay)) return 'qfn';
  if (/sot-?23/.test(hay)) return 'sot23';
  if (/0402/.test(hay)) return '0402';
  if (/0603/.test(hay)) return '0603';
  if (/0805/.test(hay)) return '0805';
  if (tagHas(/electrolytic|铝电解|钽/) || /electrolytic|铝电解|钽电容/.test(hay)) return 'electrolytic';
  return null;
}

/* ------------------------------------------------------------------ */
/* 判定器：RULE_CHECKERS（ruleId → (model, ctx) => finding）           */
/* ------------------------------------------------------------------ */

/** 同类别/跨类别器件间距规则（SPACE-04..12 的通用实现）。 */
function spacingRule({ anchorKind, otherKind = null, thresholdMm, label }) {
  return (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const annotated = components.map((component) => ({ component, kind: classifyComponent(component) }));
    const classifiable = annotated.some((entry) => entry.kind !== null);
    const anchors = annotated.filter((entry) => entry.kind === anchorKind);
    if (!anchors.length) {
      if (!classifiable) return review(`器件 footprint/mpn/tags 均无法识别类别，无法确认板上是否存在 ${label}`, REVIEW_REASONS.FACT_MISSING, { classifiable: false });
      return na(`板上没有可识别的 ${label}`);
    }
    const violations = [];
    const unknownPairs = [];
    const unclassifiedRefs = annotated.filter((entry) => entry.kind === null).map((entry) => entry.component.ref);
    let checkedPairs = 0;
    let minGapMm = Infinity;
    for (const [a, b] of componentPairs(annotated)) {
      const matches = otherKind === null
        ? (a.kind === anchorKind) !== (b.kind === anchorKind)
        : (a.kind === anchorKind && b.kind === otherKind) || (a.kind === otherKind && b.kind === anchorKind);
      if (!matches) continue;
      if (!sameSide(a.component, b.component)) continue;
      if (!sizeKnown(a.component) || !sizeKnown(b.component)) {
        unknownPairs.push(`${a.component.ref}↔${b.component.ref}`);
        continue;
      }
      const gapMm = rectGap(bodyRect(a.component), bodyRect(b.component));
      checkedPairs += 1;
      minGapMm = Math.min(minGapMm, gapMm);
      if (gapMm + EPS < thresholdMm) violations.push({ a: a.component.ref, b: b.component.ref, gapMm: round(gapMm), thresholdMm });
    }
    if (violations.length) {
      return fail(`${label} 间距违规 ${violations.length} 对（要求 ≥${thresholdMm} mm）：${violations.map((item) => `${item.a}↔${item.b}=${item.gapMm} mm`).join('、')}`, { violations, checkedPairs, thresholdMm });
    }
    // 类别不可识别的器件可能是锚点（如未标 footprint 的 QFN）→ 缺证据，不得据此 PASS。
    if (unknownPairs.length || unclassifiedRefs.length) {
      return review(`${label} 无法完成全板判定：${unknownPairs.length ? `${uniq(unknownPairs).length} 对器件缺本体尺寸；` : ''}${unclassifiedRefs.length ? `${unclassifiedRefs.length} 个器件类别不可识别；` : ''}需要补 footprint/tags/尺寸后重判`, REVIEW_REASONS.FACT_MISSING, { unknownPairs: uniq(unknownPairs), unclassifiedRefs, checkedPairs, thresholdMm });
    }
    if (!checkedPairs) return na(`没有可判定的 ${label} 配对`);
    return pass(`${label} 间距满足（检查 ${checkedPairs} 对，最小 ${round(minGapMm)} mm ≥ ${thresholdMm} mm）`, { checkedPairs, minGapMm: round(minGapMm), thresholdMm });
  };
}

const MECH05_EDGE_MM = 0.5; // 规则包 MECH-05：元件本体（含 courtyard）到铣切板边 ≥0.50 mm
const MECH02_TARGET_MM = 1.6; // 规则包 MECH-02：成品板厚 1.60 mm
const MECH02_TOLERANCE_MM = 0.1;
const MECH14_HOLE_EDGE_MM = 2.5; // 规则包 MECH-14：孔中心到板边 ≥2.50 mm
const MECH14_HOLE_DIA_RANGE_MM = [2.15, 2.45]; // 规则包 MECH-14：NPTH Ø2.20 或铜柱孔 Ø2.40（±0.05 容差）
const SPACE01_COURTYARD_MM = 0.25; // 规则包 SPACE-01：courtyard = 本体最大包络外扩 0.25 mm（Nominal）
const SPACE01_COURTYARD_TOLERANCE_MM = 0.02;
const SPACE14_NOZZLE_MM = 0.3; // 规则包 SPACE-14：元件本体四周 ≥0.30 mm
const SPACE14_HEIGHT_STEP_MM = 2.0;
const SPACE14_TALL_GAP_MM = 0.5;
const ZCLR_TALL_MM = 5.0; // 规则包 ZCLR-05：高度 >5.00 mm 的器件
const CONN04_SAME_EDGE_GAP_MM = 3.0; // 规则包 CONN-04：同板边连接器净距 ≥3.00 mm
const CONN05_CORNER_MM = 3.0; // 规则包 CONN-05：器件本体到板角 ≥3.00 mm
const RF12_NOISE_MM = 15.0; // 规则包 RF-12：噪声源距天线区 ≥15.00 mm
const DFM11_TARGET_THICKNESS_MM = 1.6; // 规则包 DFM-11：板厚 1.6 mm ±10%
const DFM11_THICKNESS_TOLERANCE_MM = 0.16;
const DFM15_MARK_DIA_MM = 1.0; // 规则包 DFM-15：Ø1.0 mm 裸铜 Mark
const DFM15_MARK_DIA_TOLERANCE_MM = 0.05;
const DFM15_MARK_EDGE_MM = 3.0; // 规则包 DFM-15：板内 Mark 距板边 ≥3.0 mm
const DFA01_REWORK_MM = 2.0; // 规则包 DFA-01：返修空间 ≥2.0 mm
const DFA10_HIGH_MM = 3.0; // 规则包 DFA-10：高元件 ≥3.0 mm
const DFA10_SIGHT_MM = 1.0; // 规则包 DFA-10：高元件水平 1.0 mm 内低元件
const PWR05_WIDTH_MULTIPLIER = 1.2; // 规则包 PWR-05：实取 = 计算值 ×1.2 后向上取 0.05 mm 网格
const PWR05_GRID_MM = 0.05;
const roundUpToGrid = (valueMm, gridMm = PWR05_GRID_MM) => Math.ceil(valueMm / gridMm - 1e-9) * gridMm;

export const RULE_CHECKERS = Object.freeze({
  /* ---------------- MECH：机械/板框/边缘 ---------------- */

  'MECH-01': (model) => {
    const outline = Array.isArray(model.board.outline) ? model.board.outline : null;
    if (!outline) return review('IR 未提供 board.outline 点集，无法验证"外形闭合/无自交/尺寸一致"', REVIEW_REASONS.FACT_MISSING);
    if (outline.length < 3) return fail(`板框点集只有 ${outline.length} 个点（<3），不构成闭合外形`, { pointCount: outline.length });
    const closed = pointsEqual(outline[0], outline[outline.length - 1]);
    const bbox = boardBBox(model);
    const spanX = bbox.x1 - bbox.x0;
    const spanY = bbox.y1 - bbox.y0;
    const declaredMismatch = [];
    if (Math.abs(spanX - model.board.widthMm) > 1e-3) declaredMismatch.push(`outline 宽 ${round(spanX)} ≠ board.widthMm ${model.board.widthMm}`);
    if (Math.abs(spanY - model.board.heightMm) > 1e-3) declaredMismatch.push(`outline 高 ${round(spanY)} ≠ board.heightMm ${model.board.heightMm}`);
    if (!closed) return fail('板框点集首尾不闭合（外形必须闭合、无游离线段）', { pointCount: outline.length, first: outline[0], last: outline[outline.length - 1] });
    if (outlineSelfIntersecting(outline)) return fail('板框存在自交/交叉线段（外形必须无自交）', { pointCount: outline.length });
    if (declaredMismatch.length) return fail(`板框点集与声明尺寸不一致：${declaredMismatch.join('；')}`, { spanXMm: round(spanX), spanYMm: round(spanY), declaredWidthMm: model.board.widthMm, declaredHeightMm: model.board.heightMm });
    return pass('板框点集闭合、无自交，且与声明宽高一致（圆角/重复线/公差未在 IR 内，需 CAD 复核）', {
      pointCount: outline.length, spanXMm: round(spanX), spanYMm: round(spanY), assumption: '以点集包围盒 + 线段自交检测近似外形判定；圆角/重复线/单边公差需 CAD 复核',
    });
  },

  'MECH-02': (model, ctx) => {
    const thicknessMm = model.board.thicknessMm;
    if (!isNum(thicknessMm)) return review('IR 未提供 board.thicknessMm，无法核对成品板厚', REVIEW_REASONS.FACT_MISSING);
    const targetMm = ctx.expectedBoardThicknessMm ?? model.rules.boardThicknessMm ?? MECH02_TARGET_MM;
    const toleranceMm = MECH02_TOLERANCE_MM;
    const problems = [];
    if (Math.abs(thicknessMm - targetMm) > toleranceMm + EPS) problems.push(`板厚 ${round(thicknessMm)} mm 超出 ${targetMm}±${toleranceMm} mm`);
    const copperOz = model.board.copperOz;
    if (isNum(copperOz) && Math.abs(copperOz - 1) > 1e-6) problems.push(`外层铜厚 ${copperOz} oz 与规则包 1 oz 不一致`);
    if (problems.length) return fail(problems.join('；'), { thicknessMm, targetMm, toleranceMm, copperOz: copperOz ?? null });
    if (!isNum(copperOz)) return review('板厚满足，但 IR 未提供 board.copperOz，无法核对"叠层表 1 oz 外层"', REVIEW_REASONS.FACT_MISSING, { thicknessMm, targetMm });
    return pass(`板厚 ${round(thicknessMm)} mm 在 ${targetMm}±${toleranceMm} mm 内，外层铜厚 ${copperOz} oz`, { thicknessMm, targetMm, toleranceMm, copperOz });
  },

  'MECH-05': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const bbox = boardBBox(model);
    const violations = [];
    const unknownRefs = [];
    for (const component of components) {
      if (!sizeKnown(component)) {
        unknownRefs.push(component.ref);
        continue;
      }
      const clearanceMm = rectEdgeClearance(bodyRect(component), bbox);
      if (clearanceMm + EPS < MECH05_EDGE_MM) violations.push({ ref: component.ref, clearanceMm: round(clearanceMm), thresholdMm: MECH05_EDGE_MM });
    }
    if (violations.length) return fail(`器件本体到板边不足 ${MECH05_EDGE_MM} mm：${violations.map((item) => `${item.ref}=${item.clearanceMm} mm`).join('、')}`, { violations, bboxSource: bbox.source });
    if (unknownRefs.length) return review(`有 ${unknownRefs.length} 个器件缺本体尺寸，无法核对板边距`, REVIEW_REASONS.FACT_MISSING, { unknownRefs });
    return pass(`全部器件本体到板边 ≥${MECH05_EDGE_MM} mm`, { thresholdMm: MECH05_EDGE_MM, bboxSource: bbox.source, assumption: '以板框包围盒近似铣切边；异形板/内凹区需 CAD 复核' });
  },

  'MECH-14': (model) => {
    const holes = model.board.mountingHoles ?? [];
    if (!holes.length) return review('IR 未建模安装孔（board.mountingHoles 为空），无法核对"≥2 个安装孔/孔位边距"', REVIEW_REASONS.FACT_MISSING);
    const bbox = boardBBox(model);
    const problems = [];
    if (holes.length < 2) problems.push(`安装孔只有 ${holes.length} 个（要求 ≥2）`);
    const detail = holes.map((hole, index) => {
      const edgeMm = Math.min(hole.x - bbox.x0, hole.y - bbox.y0, bbox.x1 - hole.x, bbox.y1 - hole.y);
      if (edgeMm + EPS < MECH14_HOLE_EDGE_MM) problems.push(`安装孔 #${index + 1} 中心到板边 ${round(edgeMm)} mm < ${MECH14_HOLE_EDGE_MM} mm`);
      if (hole.diaMm < MECH14_HOLE_DIA_RANGE_MM[0] - EPS || hole.diaMm > MECH14_HOLE_DIA_RANGE_MM[1] + EPS) problems.push(`安装孔 #${index + 1} 孔径 ${hole.diaMm} mm 不在 Ø2.20/Ø2.40 规格内`);
      return { x: hole.x, y: hole.y, diaMm: hole.diaMm, edgeMm: round(edgeMm) };
    });
    if (problems.length) return fail(problems.join('；'), { holes: detail, thresholdEdgeMm: MECH14_HOLE_EDGE_MM });
    return pass(`安装孔 ${holes.length} 个，孔径与孔边距满足要求`, { holes: detail, thresholdEdgeMm: MECH14_HOLE_EDGE_MM, assumption: '孔周边 Ø5.00 mm 禁布/3D 装配干涉需 ZCLR-03/08 与结构评审闭合' });
  },

  /* ---------------- SPACE：占位与禁止叠放 ---------------- */

  'SPACE-01': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const missing = components.filter((component) => !isNum(component.courtyardMm)).map((component) => component.ref);
    if (missing.length) return review(`有 ${missing.length} 个器件未建模 courtyardMm（规则要求 courtyard = 本体外扩 ${SPACE01_COURTYARD_MM} mm），无法判定占位框齐全`, REVIEW_REASONS.FACT_MISSING, { missingRefs: missing });
    const deviated = components
      .filter((component) => Math.abs(component.courtyardMm - SPACE01_COURTYARD_MM) > SPACE01_COURTYARD_TOLERANCE_MM + EPS)
      .map((component) => ({ ref: component.ref, courtyardMm: component.courtyardMm }));
    if (deviated.length) return fail(`courtyard 不是 ${SPACE01_COURTYARD_MM}±${SPACE01_COURTYARD_TOLERANCE_MM} mm 的 Nominal 外扩：${deviated.map((item) => `${item.ref}=${item.courtyardMm}`).join('、')}`, { deviated, thresholdMm: SPACE01_COURTYARD_MM });
    return pass(`全部 ${components.length} 个器件都有 ${SPACE01_COURTYARD_MM}±${SPACE01_COURTYARD_TOLERANCE_MM} mm 的 courtyard`, { count: components.length });
  },

  'SPACE-02': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const violations = [];
    const unknownRefs = [];
    for (const [a, b] of componentPairs(components)) {
      if (!sameSide(a, b)) continue;
      if (!sizeKnown(a) || !sizeKnown(b) || !isNum(a.courtyardMm) || !isNum(b.courtyardMm)) {
        unknownRefs.push(`${a.ref}↔${b.ref}`);
        continue;
      }
      const area = overlapArea(expandRect(bodyRect(a), a.courtyardMm), expandRect(bodyRect(b), b.courtyardMm));
      if (area > EPS) violations.push({ a: a.ref, b: b.ref, overlapMm2: round(area) });
    }
    if (violations.length) return fail(`courtyard 相交 ${violations.length} 处（同面不得叠放）：${violations.map((item) => `${item.a}↔${item.b} ${item.overlapMm2} mm²`).join('、')}`, { violations });
    if (unknownRefs.length) return review(`有 ${uniq(unknownRefs).length} 对器件缺尺寸/courtyard，无法确认不叠放`, REVIEW_REASONS.FACT_MISSING, { unknownPairs: uniq(unknownRefs) });
    return pass('同面器件 courtyard 无相交', { assumption: '按 courtyard 矩形相交判 P0；异形本体/凹形 courtyard 未建模' });
  },

  'SPACE-04': spacingRule({ anchorKind: '0402', otherKind: '0402', thresholdMm: 0.15, label: '0402↔0402 本体间距' }),
  'SPACE-05': spacingRule({ anchorKind: '0402', otherKind: 'sot23', thresholdMm: 0.2, label: '0402↔SOT-23 本体间距' }),
  'SPACE-06': spacingRule({ anchorKind: 'sot23', otherKind: 'sot23', thresholdMm: 0.3, label: 'SOT-23↔SOT-23 本体间距' }),
  'SPACE-07': spacingRule({ anchorKind: 'qfn', otherKind: null, thresholdMm: 0.5, label: 'QFN↔其他器件本体间距' }),
  'SPACE-08': spacingRule({ anchorKind: 'module', otherKind: null, thresholdMm: 1.0, label: '模组↔其他器件本体间距' }),
  'SPACE-09': spacingRule({ anchorKind: 'connector', otherKind: null, thresholdMm: 1.0, label: '连接器↔其他器件本体间距' }),
  'SPACE-11': spacingRule({ anchorKind: 'inductor', otherKind: null, thresholdMm: 2.0, label: '电感↔其他器件本体间距' }),
  'SPACE-12': spacingRule({ anchorKind: 'crystal', otherKind: null, thresholdMm: 3.0, label: '晶振↔其他器件本体间距' }),

  'SPACE-14': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const baseViolations = [];
    const unknown = [];
    let checkedPairs = 0;
    for (const [a, b] of componentPairs(components)) {
      if (!sameSide(a, b)) continue;
      if (!sizeKnown(a) || !sizeKnown(b)) {
        unknown.push(`${a.ref}↔${b.ref}`);
        continue;
      }
      checkedPairs += 1;
      const gapMm = rectGap(bodyRect(a), bodyRect(b));
      if (gapMm + EPS < SPACE14_NOZZLE_MM) baseViolations.push({ a: a.ref, b: b.ref, gapMm: round(gapMm), thresholdMm: SPACE14_NOZZLE_MM });
    }
    if (baseViolations.length) return fail(`本体间距 <${SPACE14_NOZZLE_MM} mm 的器件对 ${baseViolations.length} 个：${baseViolations.map((item) => `${item.a}↔${item.b}=${item.gapMm}`).join('、')}`, { violations: baseViolations });
    if (unknown.length) return review(`有 ${uniq(unknown).length} 对器件缺本体尺寸，无法核对吸嘴空间`, REVIEW_REASONS.FACT_MISSING, { unknownPairs: uniq(unknown), checkedPairs });
    const missingHeight = components.filter((component) => !heightKnown(component)).map((component) => component.ref);
    if (missingHeight.length) return review(`本体间距满足 ${SPACE14_NOZZLE_MM} mm，但 ${missingHeight.length} 个器件缺 heightMm3d，无法核对"高差 ≥${SPACE14_HEIGHT_STEP_MM} mm 时间距提至 ${SPACE14_TALL_GAP_MM} mm"`, REVIEW_REASONS.FACT_MISSING, { missingHeightRefs: missingHeight, checkedPairs });
    const tallViolations = [];
    for (const [a, b] of componentPairs(components)) {
      if (!sameSide(a, b)) continue;
      const gapMm = rectGap(bodyRect(a), bodyRect(b));
      if (Math.abs(a.heightMm3d - b.heightMm3d) >= SPACE14_HEIGHT_STEP_MM - EPS && gapMm + EPS < SPACE14_TALL_GAP_MM) {
        tallViolations.push({ a: a.ref, b: b.ref, gapMm: round(gapMm), heightDiffMm: round(Math.abs(a.heightMm3d - b.heightMm3d)), thresholdMm: SPACE14_TALL_GAP_MM });
      }
    }
    if (tallViolations.length) return fail(`高差 ≥${SPACE14_HEIGHT_STEP_MM} mm 的器件对间距 <${SPACE14_TALL_GAP_MM} mm：${tallViolations.map((item) => `${item.a}↔${item.b}=${item.gapMm}`).join('、')}`, { violations: tallViolations });
    return pass('本体间距与高差间距均满足吸嘴要求', { checkedPairs, thresholdMm: SPACE14_NOZZLE_MM, tallThresholdMm: SPACE14_TALL_GAP_MM });
  },

  'SPACE-16': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const violations = components.filter((component) => {
      const rotation = rotationOf(component);
      return !(Math.abs(rotation) <= EPS || Math.abs(rotation - 90) <= EPS);
    });
    if (violations.length) return fail(`出现非 0°/90° 旋转 ${violations.length} 个：${violations.map((component) => `${component.ref}=${rotationOf(component)}°`).join('、')}`, { violations: violations.map((component) => ({ ref: component.ref, rotationDeg: rotationOf(component) })) });
    return pass('全部器件角度为 0°/90°', { assumption: '按规则包字面"仅允许 0°/90°"判定；背面镜像的 180°/270° 布局如需保留须先改规则包' });
  },

  /* ---------------- ZCLR：Z 轴装配净空/高度 ---------------- */

  'ZCLR-01': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const missing = components.filter((component) => !heightKnown(component)).map((component) => component.ref);
    // 缺 heightMm3d = "3D 高度还没读回来"，是**缺证据**而不是设计违规 → REVIEW，绝不判 FAIL。
    if (missing.length) {
      return review(`缺 3D 高度证据（heightMm3d）：${missing.length} 个器件未提供高度，无法判定高度表完整性与干涉余量`, REVIEW_REASONS.FACT_MISSING, {
        missingRefs: missing,
        missingCount: missing.length,
        missingFields: ['heightMm3d'],
        note: '缺字段是"尚未读回 3D 高度"，不是设计违规；补齐高度表后重跑本规则',
      });
    }
    return pass(`全部 ${components.length} 个器件都有 heightMm3d`, { count: components.length, note: '高度来源（datasheet/实测/EDA 3D 模型）不在板级 IR 内，需装配证据链闭合' });
  },

  'ZCLR-02': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const violations = [];
    const unknown = [];
    for (const [a, b] of componentPairs(components)) {
      if (!sameSide(a, b)) continue;
      if (!sizeKnown(a) || !sizeKnown(b)) {
        unknown.push(`${a.ref}↔${b.ref}`);
        continue;
      }
      const area = overlapArea(bodyRect(a), bodyRect(b));
      if (area > EPS) violations.push({ a: a.ref, b: b.ref, overlapMm2: round(area) });
    }
    if (violations.length) return fail(`同面器件本体 XY 投影重叠 ${violations.length} 处（3D 实体干涉）：${violations.map((item) => `${item.a}↔${item.b} ${item.overlapMm2} mm²`).join('、')}`, { violations });
    if (unknown.length) return review(`有 ${uniq(unknown).length} 对器件缺本体尺寸，无法完成 3D 实体干涉检查`, REVIEW_REASONS.FACT_MISSING, { unknownPairs: uniq(unknown) });
    return pass('同面器件本体 XY 投影无重叠', { note: '正反面叠装总高需 ZCLR-06 与外壳内腔数据，本 IR 未建模' });
  },

  'ZCLR-05': (model) => {
    const keepouts = model.board.keepouts ?? [];
    if (!keepouts.length) return review('IR 未建模装配区/屏蔽罩/RF 天线禁布区（board.keepouts 为空），无法核对高件禁区', REVIEW_REASONS.FACT_MISSING);
    const components = model.components ?? [];
    const tall = components.filter((component) => heightKnown(component) && component.heightMm3d > ZCLR_TALL_MM + EPS);
    const unknownHeight = components.filter((component) => !heightKnown(component));
    const violations = [];
    const unknownGeometry = [];
    for (const component of tall) {
      if (!sizeKnown(component)) {
        unknownGeometry.push(component.ref);
        continue;
      }
      for (const keepout of keepouts) {
        const area = overlapArea(bodyRect(component), keepout);
        if (area > EPS) violations.push({ ref: component.ref, keepoutId: keepout.id, heightMm3d: component.heightMm3d, overlapMm2: round(area), reason: keepout.reason ?? null });
      }
    }
    if (violations.length) return fail(`高度 >${ZCLR_TALL_MM} mm 的器件落入禁布区 ${violations.length} 处：${violations.map((item) => `${item.ref}@${item.keepoutId}`).join('、')}`, { violations, thresholdMm: ZCLR_TALL_MM });
    if (unknownGeometry.length) return review(`高件缺本体尺寸，无法核对是否落入禁布区：${unknownGeometry.join('、')}`, REVIEW_REASONS.FACT_MISSING, { unknownGeometry });
    if (unknownHeight.length) return review(`禁布区内无已登记高件，但 ${unknownHeight.length} 个器件缺高度，无法排除高件落入禁布区`, REVIEW_REASONS.FACT_MISSING, { unknownHeightRefs: unknownHeight.map((component) => component.ref) });
    return pass('禁布区（board.keepouts）内没有高度 >5 mm 的器件', { tallChecked: tall.length, keepoutCount: keepouts.length });
  },

  /* ---------------- CONN：连接器朝向与插拔空间 ---------------- */

  'CONN-04': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const connectors = components.filter((component) => classifyComponent(component) === 'connector');
    const unclassifiedRefs = components.filter((component) => classifyComponent(component) === null).map((component) => component.ref);
    if (!connectors.length) {
      if (unclassifiedRefs.length) return review(`有 ${unclassifiedRefs.length} 个器件类别不可识别（可能是连接器），无法确认板上是否有连接器`, REVIEW_REASONS.FACT_MISSING, { unclassifiedRefs });
      return na('板上没有可识别的连接器');
    }
    const unknownSize = connectors.filter((component) => !sizeKnown(component)).map((component) => component.ref);
    if (unknownSize.length) return review(`连接器缺本体尺寸：${unknownSize.join('、')}，无法核对同板边净距`, REVIEW_REASONS.FACT_MISSING, { unknownSize });
    const bbox = boardBBox(model);
    const edgeOf = (component) => {
      const distances = [
        ['left', component.xMm - bbox.x0], ['right', bbox.x1 - component.xMm],
        ['bottom', component.yMm - bbox.y0], ['top', bbox.y1 - component.yMm],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      return distances[0][0];
    };
    const groups = new Map();
    for (const component of connectors) {
      const edge = edgeOf(component);
      if (!groups.has(edge)) groups.set(edge, []);
      groups.get(edge).push(component);
    }
    const violations = [];
    let comparedPairs = 0;
    for (const [edge, group] of groups) {
      const horizontal = edge === 'top' || edge === 'bottom';
      for (const [a, b] of componentPairs(group)) {
        const ra = bodyRect(a);
        const rb = bodyRect(b);
        const perpOverlap = horizontal
          ? Math.min(ra.y1, rb.y1) - Math.max(ra.y0, rb.y0)
          : Math.min(ra.x1, rb.x1) - Math.max(ra.x0, rb.x0);
        if (perpOverlap <= EPS) continue; // 前后错开布置，不构成本条"同板边相邻"
        comparedPairs += 1;
        const alongGap = horizontal
          ? Math.max(0, Math.max(ra.x0 - rb.x1, rb.x0 - ra.x1))
          : Math.max(0, Math.max(ra.y0 - rb.y1, rb.y0 - ra.y1));
        if (alongGap + EPS < CONN04_SAME_EDGE_GAP_MM) violations.push({ edge, a: a.ref, b: b.ref, gapMm: round(alongGap), thresholdMm: CONN04_SAME_EDGE_GAP_MM });
      }
    }
    if (violations.length) return fail(`同板边连接器净距 <${CONN04_SAME_EDGE_GAP_MM} mm：${violations.map((item) => `${item.a}↔${item.b}(${item.edge})=${item.gapMm}`).join('、')}`, { violations });
    if (unclassifiedRefs.length) return review(`已识别连接器之间无违例，但有 ${unclassifiedRefs.length} 个器件类别不可识别（可能是连接器），无法完成全板同边净距判定`, REVIEW_REASONS.FACT_MISSING, { unclassifiedRefs, comparedPairs });
    if (!comparedPairs) return na('没有同板边且投影重叠的相邻连接器配对');
    return pass(`同板边相邻连接器净距 ≥${CONN04_SAME_EDGE_GAP_MM} mm（检查 ${comparedPairs} 对）`, { comparedPairs, thresholdMm: CONN04_SAME_EDGE_GAP_MM, assumption: '以连接器中心最近边归组，忽略翻盖开启包络；FFC/ZIF 需 CONN-03/14 另行复核' });
  },

  'CONN-05': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const bbox = boardBBox(model);
    const corners = [[bbox.x0, bbox.y0], [bbox.x0, bbox.y1], [bbox.x1, bbox.y0], [bbox.x1, bbox.y1]];
    const violations = [];
    const unknownRefs = [];
    for (const component of components) {
      if (!sizeKnown(component)) {
        unknownRefs.push(component.ref);
        continue;
      }
      const rect = bodyRect(component);
      const distanceMm = Math.min(...corners.map((corner) => pointRectDistance(corner, rect)));
      if (distanceMm + EPS < CONN05_CORNER_MM) violations.push({ ref: component.ref, distanceToCornerMm: round(distanceMm), thresholdMm: CONN05_CORNER_MM });
    }
    if (violations.length) return fail(`器件本体到板角 <${CONN05_CORNER_MM} mm：${violations.map((item) => `${item.ref}=${item.distanceToCornerMm}`).join('、')}`, { violations });
    if (unknownRefs.length) return review(`有 ${unknownRefs.length} 个器件缺本体尺寸，无法核对板角净距`, REVIEW_REASONS.FACT_MISSING, { unknownRefs });
    return pass(`全部器件本体到板角 ≥${CONN05_CORNER_MM} mm`, { thresholdMm: CONN05_CORNER_MM, assumption: '以板框包围盒四角近似"最近板角切点"；异形板角需 CAD 复核' });
  },

  /* ---------------- RF：天线与射频 ---------------- */

  'RF-12': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const classified = components.map((component) => ({ component, kind: classifyComponent(component) }));
    const antennas = classified.filter((entry) => entry.kind === 'antenna');
    if (!antennas.length) return review('IR 未声明天线器件（tags 含 antenna / footprint 含 antenna），无法确认 RF 区是否存在', REVIEW_REASONS.FACT_MISSING);
    const noise = classified.filter((entry) => entry.kind === 'inductor' || entry.kind === 'crystal'
      || (Array.isArray(entry.component.tags) && entry.component.tags.some((tag) => /smps|switcher|开关电源|clock|时钟/i.test(String(tag)))));
    if (!noise.length) return pass('存在天线器件，但未识别到开关电源/功率电感/晶振类噪声源', { antennas: antennas.map((entry) => entry.component.ref) });
    const violations = [];
    const unknown = [];
    for (const antenna of antennas) {
      for (const source of noise) {
        if (!sizeKnown(antenna.component) || !sizeKnown(source.component)) {
          unknown.push(`${antenna.component.ref}↔${source.component.ref}`);
          continue;
        }
        const gapMm = rectGap(bodyRect(antenna.component), bodyRect(source.component));
        if (gapMm + EPS < RF12_NOISE_MM) violations.push({ antenna: antenna.component.ref, source: source.component.ref, gapMm: round(gapMm), thresholdMm: RF12_NOISE_MM });
      }
    }
    if (violations.length) return fail(`噪声源距天线 <${RF12_NOISE_MM} mm：${violations.map((item) => `${item.source}↔${item.antenna}=${item.gapMm}`).join('、')}`, { violations });
    if (unknown.length) return review(`有 ${uniq(unknown).length} 对天线/噪声源缺本体尺寸，无法核对 ${RF12_NOISE_MM} mm 距离`, REVIEW_REASONS.FACT_MISSING, { unknownPairs: uniq(unknown) });
    return pass(`识别到的噪声源距天线 ≥${RF12_NOISE_MM} mm`, { antennaCount: antennas.length, noiseCount: noise.length, assumption: '只识别 footprint/tags 显式标注的噪声源；RF 前向禁布区需 RF-03/04/05 与 Gerber 复核' });
  },

  /* ---------------- PWR：电源/去耦/热 ---------------- */

  'PWR-05': (model, ctx) => {
    const nets = (model.nets ?? []).filter((net) => isNum(net.currentA) && net.currentA > 0);
    if (!nets.length) return review('nets 未提供 currentA，无法核对载流走线宽度', REVIEW_REASONS.FACT_MISSING);
    if (!ctx.traceWidths || typeof ctx.traceWidths !== 'object') return review('板级 IR 不含有走线几何，且本次评估未注入 traceWidths（net 名 → 实际线宽），无法核对 PWR-05', REVIEW_REASONS.FACT_MISSING, { nets: nets.map((net) => ({ name: net.name, currentA: net.currentA })) });
    const violations = [];
    const missing = [];
    const checked = [];
    for (const net of nets) {
      const spec = ctx.traceWidths[net.name];
      if (spec === undefined) {
        missing.push(net.name);
        continue;
      }
      const widthMm = typeof spec === 'number' ? spec : spec?.widthMm;
      const layer = spec && typeof spec === 'object' && spec.layer === 'inner' ? 'inner' : 'outer';
      const thicknessOz = spec && typeof spec === 'object' && isNum(spec.thicknessOz) ? spec.thicknessOz : (model.board.copperOz ?? 1);
      const tempRiseC = spec && typeof spec === 'object' && isNum(spec.tempRiseC) ? spec.tempRiseC : 10;
      if (!isNum(widthMm)) {
        missing.push(net.name);
        continue;
      }
      const calculation = widthForCurrent({ currentA: net.currentA, thicknessOz, layer, tempRiseC });
      if (!calculation.ok) {
        missing.push(net.name);
        continue;
      }
      const requiredWidthMm = round(roundUpToGrid(calculation.widthMm * PWR05_WIDTH_MULTIPLIER), 6);
      const entry = { name: net.name, currentA: net.currentA, widthMm, requiredWidthMm, layer, thicknessOz, tempRiseC };
      checked.push(entry);
      if (widthMm + EPS < requiredWidthMm) violations.push({ ...entry, shortfallMm: round(requiredWidthMm - widthMm) });
    }
    if (violations.length) return fail(`载流走线宽度不足（按 IPC-2221 经验式 ×${PWR05_WIDTH_MULTIPLIER} 后取 ${PWR05_GRID_MM} mm 网格）：${violations.map((item) => `${item.name} ${item.widthMm}mm < 需 ${item.requiredWidthMm}mm`).join('、')}`, { violations, checked });
    if (missing.length) return review(`有 ${missing.length} 条载流网络缺实际线宽（traceWidths）：${missing.join('、')}`, REVIEW_REASONS.FACT_MISSING, { missing, checked });
    return pass('载流走线宽度满足 IPC-2221 计算值 ×1.2', { checked, formula: 'I=k·ΔT^0.44·A^0.725 反解；required = ceil(width×1.2 / 0.05)×0.05', assumption: '未考虑铺铜/过孔分流与压降；≥1A 路径的 PWR-06 铺铜要求需另行证据' });
  },

  /* ---------------- DFM：可制造性 ---------------- */

  'DFM-01': (model, ctx) => {
    if (!ctx.fabProfile) return review(`板厂能力 profile 不可用（${ctx.fabProfileError ?? '未提供 fabProfile'}），无法核对最小线宽/线距`, REVIEW_REASONS.FACT_MISSING);
    const minTraceWidthMm = model.rules.minTraceWidthMm;
    if (!isNum(minTraceWidthMm)) return review('IR 未提供 rules.minTraceWidthMm，无法核对最小线宽', REVIEW_REASONS.FACT_MISSING);
    const audit = evaluateFabRules({
      fab: ctx.fabProfile.fab,
      variant: ctx.fabProfile.variant,
      design: { layers: model.board.layers, copperOz: model.board.copperOz ?? undefined, minTraceWidthMm },
    });
    const fabRule = audit.rules.find((rule) => rule.id === 'FAB-01');
    if (!fabRule) return review('板厂规则引擎未返回 FAB-01，无法核对最小线宽', REVIEW_REASONS.FACT_MISSING);
    const ruleThresholdMm = 0.10; // 规则包 DFM-01：常规工艺 0.10/0.10 mm（能力下限 0.09）
    if (minTraceWidthMm + EPS < ruleThresholdMm) {
      return fail(`最小线宽 ${minTraceWidthMm} mm < 规则包下限 ${ruleThresholdMm} mm`, { minTraceWidthMm, thresholdMm: ruleThresholdMm, fabRuleStatus: fabRule.status });
    }
    if (fabRule.status === FAIL) return fail(`最小线宽 ${minTraceWidthMm} mm 低于板厂能力：${fabRule.message}`, { minTraceWidthMm, fabRuleStatus: fabRule.status, fabEvidence: fabRule.evidence });
    if (fabRule.status !== PASS) return review(`最小线宽缺少板厂侧结论（FAB-01=${fabRule.status}）：${fabRule.message}`, REVIEW_REASONS.FACT_MISSING, { minTraceWidthMm, fabRuleStatus: fabRule.status });
    return pass(`最小线宽 ${minTraceWidthMm} mm ≥ 规则下限 ${ruleThresholdMm} mm，且满足 ${ctx.fabProfile.fab} ${ctx.fabProfile.variant} 能力`, { minTraceWidthMm, ruleThresholdMm, fabCapabilityMm: ctx.fabProfile.minTraceWidthOuterMm ?? null, assumption: 'RF/USB 区 ≥0.15 mm、线距与阻焊桥等需 FAB-02/03 与板厂 EQ 复核' });
  },

  'DFM-09': (model) => {
    const controlled = (model.nets ?? []).filter((net) => isNum(net.impedanceOhm));
    if (!controlled.length) return review('nets 未提供 impedanceOhm，无法核对阻抗控制', REVIEW_REASONS.FACT_MISSING);
    const targetOhm = model.rules.targetImpedanceOhm;
    if (!isNum(targetOhm)) return review('IR 未提供 rules.targetImpedanceOhm，无法判定 ±10% 阻抗窗口', REVIEW_REASONS.FACT_MISSING, { controlledNets: controlled.map((net) => ({ name: net.name, impedanceOhm: net.impedanceOhm })) });
    const tolerance = targetOhm * 0.1;
    const violations = controlled.filter((net) => Math.abs(net.impedanceOhm - targetOhm) > tolerance + EPS)
      .map((net) => ({ name: net.name, impedanceOhm: net.impedanceOhm, targetOhm, toleranceOhm: round(tolerance) }));
    if (violations.length) return fail(`阻抗超 ±10%：${violations.map((item) => `${item.name}=${item.impedanceOhm}Ω（目标 ${item.targetOhm}±${item.toleranceOhm}）`).join('、')}`, { violations });
    return pass(`${controlled.length} 条受控网络阻抗在 ${targetOhm}Ω ±10% 内`, { targetOhm, toleranceOhm: round(tolerance), controlledNets: controlled.map((net) => net.name), assumption: '参考面连续/跨分割 0 次与叠层计算书需 DFM-11、板厂阻抗测试条闭合' });
  },

  'DFM-11': (model) => {
    const thicknessMm = model.board.thicknessMm;
    if (!isNum(thicknessMm)) return review('IR 未提供 board.thicknessMm，无法核对板厚与层叠', REVIEW_REASONS.FACT_MISSING);
    const problems = [];
    if (Math.abs(thicknessMm - DFM11_TARGET_THICKNESS_MM) > DFM11_THICKNESS_TOLERANCE_MM + EPS) {
      problems.push(`板厚 ${round(thicknessMm)} mm 超出 ${DFM11_TARGET_THICKNESS_MM}±10%`);
    }
    const stackup = model.stackup;
    if (stackup?.totalThicknessMm != null && Math.abs(stackup.totalThicknessMm - thicknessMm) > 0.15 + EPS) {
      problems.push(`stackup.totalThicknessMm ${stackup.totalThicknessMm} 与 board.thicknessMm ${thicknessMm} 相差 >0.15 mm`);
    }
    if (problems.length) return fail(problems.join('；'), { thicknessMm, layers: model.board.layers, stackupTotalThicknessMm: stackup?.totalThicknessMm ?? null });
    if (model.board.layers === 4) {
      if (!stackup) return review('4 层板未提供 stackup，无法核对 Signal/GND/PWR/Signal 叠层顺序', REVIEW_REASONS.FACT_MISSING, { thicknessMm, layers: 4 });
      const expected = ['signal', 'plane', 'plane', 'signal'];
      const actual = stackup.layers.map((layer) => layer.type);
      if (actual.join(',') !== expected.join(',')) return fail(`4 层叠层顺序 ${actual.join('/')} ≠ 规则要求 Signal/GND/PWR/Signal`, { expected, actual });
    }
    return pass(`板厚 ${round(thicknessMm)} mm 在 1.6±10% 内${model.board.layers === 4 ? '，4 层叠层顺序符合 Signal/GND/PWR/Signal' : ''}`, { thicknessMm, layers: model.board.layers, assumption: 'PP/芯板具体厚度与阻抗层位置需板厂叠层确认单' });
  },

  'DFM-15': (model) => {
    const fiducials = model.board.fiducials ?? [];
    if (!fiducials.length) return review('IR 未建模 Mark 光学点（board.fiducials 为空），无法核对拼板 Mark', REVIEW_REASONS.FACT_MISSING);
    const bbox = boardBBox(model);
    const problems = [];
    if (fiducials.length < 3) problems.push(`Mark 只有 ${fiducials.length} 个（要求 ≥3：对角 2 + 1）`);
    const detail = fiducials.map((fiducial, index) => {
      const edgeMm = Math.min(fiducial.x - bbox.x0, fiducial.y - bbox.y0, bbox.x1 - fiducial.x, bbox.y1 - fiducial.y);
      if (Math.abs(fiducial.diaMm - DFM15_MARK_DIA_MM) > DFM15_MARK_DIA_TOLERANCE_MM + EPS) problems.push(`Mark #${index + 1} 直径 ${fiducial.diaMm} mm ≠ Ø${DFM15_MARK_DIA_MM}±${DFM15_MARK_DIA_TOLERANCE_MM}`);
      if (edgeMm + EPS < DFM15_MARK_EDGE_MM) problems.push(`Mark #${index + 1} 距板边 ${round(edgeMm)} mm < ${DFM15_MARK_EDGE_MM} mm`);
      return { x: fiducial.x, y: fiducial.y, diaMm: fiducial.diaMm, edgeMm: round(edgeMm) };
    });
    if (problems.length) return fail(problems.join('；'), { fiducials: detail });
    const collinear = fiducials.slice(2).every((point) => Math.abs((fiducials[1].x - fiducials[0].x) * (point.y - fiducials[0].y) - (fiducials[1].y - fiducials[0].y) * (point.x - fiducials[0].x)) <= 1e-6);
    if (collinear) return fail('≥3 个 Mark 共线（不得共线，需对角 + 1 分布）', { fiducials: detail });
    return pass(`Mark ${fiducials.length} 个，直径/边距/非共线满足要求`, { fiducials: detail, assumption: 'Mark 周围 2.0 mm 无铜/无丝印/阻焊开窗与拼板定位需 Gerber 与 DFM 工程图复核' });
  },

  /* ---------------- DFA：可装配/可测试 ---------------- */

  'DFA-01': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const sizeUnknownRefs = components.filter((component) => !sizeKnown(component)).map((component) => component.ref);
    if (sizeUnknownRefs.length) return review(`有 ${sizeUnknownRefs.length} 个器件缺本体尺寸，无法核对返修空间`, REVIEW_REASONS.FACT_MISSING, { sizeUnknownRefs });
    const heightUnknownRefs = components.filter((component) => !heightKnown(component)).map((component) => component.ref);
    const violations = [];
    for (const [a, b] of componentPairs(components)) {
      if (!sameSide(a, b)) continue;
      const gapMm = rectGap(bodyRect(a), bodyRect(b));
      if (gapMm > DFA01_REWORK_MM + EPS) continue;
      if (!heightKnown(a) || !heightKnown(b)) continue;
      if (b.heightMm3d > a.heightMm3d / 2 + EPS) violations.push({ ref: a.ref, neighbor: b.ref, gapMm: round(gapMm), neighborHeightMm: b.heightMm3d, ownHeightMm: a.heightMm3d });
      if (a.heightMm3d > b.heightMm3d / 2 + EPS) violations.push({ ref: b.ref, neighbor: a.ref, gapMm: round(gapMm), neighborHeightMm: a.heightMm3d, ownHeightMm: b.heightMm3d });
    }
    if (violations.length) return fail(`返修空间 <${DFA01_REWORK_MM} mm 且相邻件高于本体 1/2：${violations.map((item) => `${item.ref} 旁 ${item.neighbor}=${item.gapMm}mm`).join('、')}`, { violations, thresholdMm: DFA01_REWORK_MM });
    if (heightUnknownRefs.length) return review(`返修间距无已知违例，但 ${heightUnknownRefs.length} 个器件缺高度，无法完成"高于本体 1/2"判定`, REVIEW_REASONS.FACT_MISSING, { heightUnknownRefs });
    return pass(`返修空间 ≥${DFA01_REWORK_MM} mm 或无"高于本体 1/2"的相邻件`, { thresholdMm: DFA01_REWORK_MM, note: 'QFN/BGA 四周 ≥3.0 mm 与 0402 阵列 ≥0.5 mm 的细分要求未在 IR 建模' });
  },

  'DFA-10': (model) => {
    const components = model.components ?? [];
    if (!components.length) return na('板上没有器件，不适用');
    const sizeUnknownRefs = components.filter((component) => !sizeKnown(component)).map((component) => component.ref);
    if (sizeUnknownRefs.length) return review(`有 ${sizeUnknownRefs.length} 个器件缺本体尺寸，无法核对 AOI 遮挡`, REVIEW_REASONS.FACT_MISSING, { sizeUnknownRefs });
    const high = components.filter((component) => heightKnown(component) && component.heightMm3d >= DFA10_HIGH_MM - EPS);
    const heightUnknownRefs = components.filter((component) => !heightKnown(component)).map((component) => component.ref);
    if (!high.length) {
      if (heightUnknownRefs.length) return review(`未识别到 ≥${DFA10_HIGH_MM} mm 高元件，但 ${heightUnknownRefs.length} 个器件缺高度，无法确认`, REVIEW_REASONS.FACT_MISSING, { heightUnknownRefs });
      return na(`没有高度 ≥${DFA10_HIGH_MM} mm 的高元件`);
    }
    const violations = [];
    for (const tall of high) {
      for (const other of components) {
        if (tall.ref === other.ref) continue;
        if (!sameSide(tall, other)) continue;
        if (!heightKnown(other)) continue;
        if (other.heightMm3d >= tall.heightMm3d - EPS) continue; // 只有"高元件遮挡低元件"
        const gapMm = rectGap(bodyRect(tall), bodyRect(other));
        if (gapMm + EPS < DFA10_SIGHT_MM) {
          violations.push({ tall: tall.ref, low: other.ref, gapMm: round(gapMm), reason: `水平距离 <${DFA10_SIGHT_MM} mm` });
          continue;
        }
        const heightDiffMm = tall.heightMm3d - other.heightMm3d;
        if (heightDiffMm > gapMm + EPS) violations.push({ tall: tall.ref, low: other.ref, gapMm: round(gapMm), heightDiffMm: round(heightDiffMm), reason: '45° 视线被遮挡（高差 > 水平距离）' });
      }
    }
    if (violations.length) return fail(`AOI/探针视线遮挡 ${violations.length} 处：${violations.map((item) => `${item.tall}→${item.low}(${item.reason})`).join('、')}`, { violations, sightMm: DFA10_SIGHT_MM });
    if (heightUnknownRefs.length) return review(`已识别高元件无遮挡违例，但 ${heightUnknownRefs.length} 个器件缺高度，无法完成 AOI 视线检查`, REVIEW_REASONS.FACT_MISSING, { heightUnknownRefs });
    return pass(`高元件（≥${DFA10_HIGH_MM} mm）不遮挡低元件（1 mm / 45° 视线）`, { highRefs: high.map((component) => component.ref), sightMm: DFA10_SIGHT_MM });
  },

  /* ---------------- GATE：放行门禁 ---------------- */

  'GATE-02': (model, ctx) => {
    const drc = ctx.drc;
    if (!drc) return review('未提供 DRC 证据（ctx.drc，应由 kicad-drc.mjs 真实执行产出），放行门禁不能判 PASS', REVIEW_REASONS.FACT_MISSING);
    if (drc.ok !== true) return review(`DRC 未成功执行（${drc.code ?? 'DRC_UNKNOWN'}）：${drc.message ?? ''}`, REVIEW_REASONS.FACT_MISSING, { code: drc.code ?? null });
    const counts = drc.counts ?? {};
    const violations = isNum(counts.violations) ? counts.violations : (Array.isArray(drc.findings) ? drc.findings.length : null);
    if (violations === null) return review('DRC 报告缺少可判定的 violations 计数，不能当作 0 违规通过', REVIEW_REASONS.FACT_MISSING, { counts });
    if (violations > 0) return fail(`DRC 报告 ${violations} 条违规（exitCode=${drc.exitCode ?? 'n/a'}）`, { counts, exitCode: drc.exitCode ?? null, reportDigest: drc.reportDigest ?? null });
    return pass('DRC 报告 0 违规（真实执行证据）', { exitCode: drc.exitCode ?? null, counts, reportDigest: drc.reportDigest ?? null });
  },

  'GATE-03': (model, ctx) => {
    const audit = ctx.fabAudit;
    if (!audit || !audit.summary) return review('未提供板厂 DFM 审计证据（ctx.fabAudit，应来自 fab-rules.evaluateFabRules），放行门禁不能判 PASS', REVIEW_REASONS.FACT_MISSING);
    const countOf = (key) => Number(audit.summary[key] ?? audit.summary[String(key).toUpperCase()] ?? 0);
    const failCount = countOf('fail');
    const reviewCount = countOf('review');
    if (failCount > 0) return fail(`板厂 DFM 审计 FAIL ${failCount} 条`, { summary: audit.summary, fab: audit.fab ?? null, variant: audit.variant ?? null });
    if (reviewCount > 0) return review(`板厂 DFM 审计仍有 ${reviewCount} 条 REVIEW，门禁未闭合`, REVIEW_REASONS.FACT_MISSING, { summary: audit.summary, fab: audit.fab ?? null, variant: audit.variant ?? null });
    return pass('板厂 DFM 审计全部 PASS/NA', { summary: audit.summary, fab: audit.fab ?? null, variant: audit.variant ?? null, auditHash: audit.auditHash ?? null });
  },

  /* ---------------- PRJ：工程与交付一致性 ---------------- */

  'PRJ-02': (model, ctx) => {
    const pack = ctx.rulePack;
    const expectedHashes = pack.sourceHashes ?? {};
    const documents = pack.documents ?? {};
    // 规则包 sourceHashes 只登记 02/03 号规则文档（01 号诊断文档通过 id 引用，不在同源校验范围）
    const targets = [documents.rulesA, documents.rulesB].filter(Boolean);
    if (!targets.length) return review('规则包未声明 documents.rulesA/rulesB（02/03 号规则文档路径），无法核对同源', REVIEW_REASONS.FACT_MISSING);
    const verified = [];
    const problems = [];
    for (const documentPath of targets) {
      const basename = documentPath.split('/').pop();
      const expected = expectedHashes[basename];
      if (!expected) {
        return review(`规则包 sourceHashes 未声明 ${basename} 的 sha256，无法核对文档同源`, REVIEW_REASONS.FACT_MISSING, { documentPath });
      }
      const fileUrl = new URL(documentPath, REPO_ROOT_URL);
      if (!existsSync(fileUrl)) {
        return review(`规则文档不存在：${documentPath}`, REVIEW_REASONS.FACT_MISSING, { documentPath });
      }
      const actual = sha256(readFileSync(fileUrl, 'utf8'));
      if (actual !== expected) problems.push(`${basename} 实际 sha256 ${actual.slice(0, 12)}… ≠ 规则包登记 ${String(expected).slice(0, 12)}…`);
      verified.push({ path: documentPath, sha256: actual });
    }
    if (problems.length) return fail(`规则包与源文档不同源：${problems.join('；')}`, { verified, generatedFrom: pack.generatedFrom });
    if (!pack.generatedFrom) return review('规则包未声明 generatedFrom（生成脚本），不满足"规则文档与规则包同源"', REVIEW_REASONS.FACT_MISSING, { verified });
    const generatorUrl = new URL(pack.generatedFrom, REPO_ROOT_URL);
    if (!existsSync(generatorUrl)) return review(`规则包声明的生成脚本不存在：${pack.generatedFrom}`, REVIEW_REASONS.FACT_MISSING, { verified, generatedFrom: pack.generatedFrom });
    return pass('规则包 sourceHashes 与 02/03 号文档实际哈希逐份相等，generatedFrom 脚本存在', { verified, generatedFrom: pack.generatedFrom });
  },
});

/* ------------------------------------------------------------------ */
/* 校验：checker 必须都对应规则包里的规则，且数量下限                  */
/* ------------------------------------------------------------------ */

const MIN_MACHINE_CHECKERS = 30;
function validateCheckers() {
  const packIds = new Set(RULE_PACK.rules.map((rule) => rule.id));
  const problems = [];
  for (const [ruleId, checker] of Object.entries(RULE_CHECKERS)) {
    if (typeof checker !== 'function') problems.push(`checker ${ruleId} 不是函数`);
    if (!packIds.has(ruleId)) problems.push(`checker ${ruleId} 不在规则包内（拼写错误或规则已删除）`);
  }
  const machineCheckable = Object.keys(RULE_CHECKERS).length;
  if (machineCheckable < MIN_MACHINE_CHECKERS) problems.push(`机器判据只有 ${machineCheckable} 条，低于下限 ${MIN_MACHINE_CHECKERS}`);
  if (problems.length) {
    throw Object.assign(new Error(`RULE_CHECKERS 不合法：${problems.join('；')}`), { code: RULE_DECK_CODES.CHECKER_INVALID, details: problems });
  }
}
validateCheckers();

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

function resolveRuleProfile(fabProfileRaw) {
  const raw = typeof fabProfileRaw === 'string' ? fabProfileRaw.trim() : '';
  if (!raw) return { profile: null, raw: null, error: '未提供 fabProfile' };
  const separator = raw.indexOf(':');
  const fab = separator >= 0 ? raw.slice(0, separator) : raw;
  const variant = separator >= 0 ? raw.slice(separator + 1) : undefined;
  try {
    return { profile: resolveFabProfile(fab, variant), raw, error: null };
  } catch (error) {
    return { profile: null, raw, error: `${error?.code ?? 'FAB_PROFILE_UNRESOLVED'}: ${error?.message ?? String(error)}` };
  }
}

/**
 * 对一块板执行全部 151 条规则。
 *
 * @param {object} model 板级 IR（createBoardModel 产物；也接受原始输入，内部会归一化）
 * @param {object} [options]
 * @param {string} [options.fabProfile] 覆盖 IR 里的 rules.fabProfile（形如 'JLCPCB:4L-1oz'）
 * @param {boolean} [options.includeNa=true] false 时 findings 不返回 NA（summary 仍统计全部）
 * @param {object} [options.traceWidths] net 名 → 实际线宽（number 或 {widthMm, layer, thicknessOz, tempRiseC}），PWR-05 用
 * @param {object} [options.drc] kicad-drc.runKicadDrc 的返回，GATE-02 用
 * @param {object} [options.fabAudit] fab-rules.evaluateFabRules 的返回，GATE-03 用
 * @param {number} [options.expectedBoardThicknessMm] 覆盖 MECH-02 的板厚目标（默认 IR rules / 规则包 1.6）
 * @returns {{ok:boolean, code?:string, findings:Array, summary:object, digest:string, modelDigest?:string, pack:object}}
 */
export function evaluateRuleDeck(model, options = {}) {
  const {
    fabProfile, includeNa = true, traceWidths = null, drc = null, fabAudit = null,
    expectedBoardThicknessMm = null,
  } = options ?? {};
  let boardModel;
  try {
    boardModel = model && model.schemaVersion === BOARD_MODEL_SCHEMA_VERSION ? model : createBoardModel(model ?? {});
  } catch (error) {
    return {
      ok: false,
      code: RULE_DECK_CODES.MODEL_INVALID,
      message: `板级 IR 不合法，无法执行规则判定：${error?.message ?? String(error)}`,
      findings: [],
      summary: null,
      digest: null,
      modelDigest: null,
      pack: { version: RULE_PACK.version, title: RULE_PACK.title, digest: RULE_PACK.digest },
    };
  }
  const profileInfo = resolveRuleProfile(fabProfile ?? boardModel.rules.fabProfile);
  const ctx = {
    rulePack: RULE_PACK,
    fabProfile: profileInfo.profile,
    fabProfileRaw: profileInfo.raw,
    fabProfileError: profileInfo.error,
    traceWidths,
    drc,
    fabAudit,
    expectedBoardThicknessMm: isNum(expectedBoardThicknessMm) ? expectedBoardThicknessMm : null,
  };
  const findings = RULE_PACK.rules.map((rule) => {
    const checker = RULE_CHECKERS[rule.id];
    let outcome;
    if (typeof checker !== 'function') {
      outcome = noChecker(`规则 ${rule.id}（${rule.name}）没有机器判据：规则包为文字判定，board IR 也缺对应事实，判 REVIEW 而非 PASS`);
    } else {
      try {
        outcome = checker(boardModel, ctx);
      } catch (error) {
        outcome = review(`checker ${rule.id} 执行异常：${error?.message ?? String(error)}`, REVIEW_REASONS.CHECKER_ERROR);
      }
    }
    if (!outcome || !RULE_STATUS[outcome.status] || ![PASS, FAIL, REVIEW, NA].includes(outcome.status)) {
      outcome = review(`checker ${rule.id} 返回了非法状态 ${JSON.stringify(outcome?.status ?? null)}`, REVIEW_REASONS.CHECKER_ERROR);
    }
    return {
      ruleId: rule.id,
      group: rule.group,
      groupName: rule.groupName ?? RULE_PACK.groupNames[rule.group] ?? rule.group,
      name: rule.name,
      level: rule.level,
      status: outcome.status,
      message: outcome.message ?? '',
      evidence: outcome.evidence ?? null,
      machineCheckable: typeof checker === 'function',
    };
  });
  const count = (status) => findings.filter((finding) => finding.status === status).length;
  const machineCheckable = findings.filter((finding) => finding.machineCheckable).length;
  const blocking = findings.filter((finding) => finding.status === FAIL && isHardGateLevel(finding.level)).length;
  const summary = {
    total: RULE_PACK.total,
    pass: count(PASS),
    fail: count(FAIL),
    review: count(REVIEW),
    na: count(NA),
    blocking,
    machineCheckable,
    coverageRatio: RULE_PACK.total > 0 ? machineCheckable / RULE_PACK.total : 0,
    releaseReady: blocking === 0 && count(REVIEW) === 0,
  };
  const digest = sha256(canonicalJson(findings.map((finding) => ({
    ruleId: finding.ruleId,
    group: finding.group,
    status: finding.status,
    message: finding.message,
    evidence: finding.evidence,
  }))));
  const visibleFindings = includeNa ? findings : findings.filter((finding) => finding.status !== NA);
  return {
    ok: true,
    findings: visibleFindings,
    summary,
    digest,
    modelDigest: boardModelDigest(boardModel),
    pack: { version: RULE_PACK.version, title: RULE_PACK.title, digest: RULE_PACK.digest },
  };
}

/**
 * 规则覆盖明细（按 group），供评估台/UI 展示"哪些规则已有机器判据、哪些仍是人工"。
 * @returns {{total:number, machineCheckable:number, coverageRatio:number,
 *            groups:Array<{group:string, groupName:string, total:number, machineCheckable:number,
 *                          coverageRatio:number, implementedRuleIds:string[], unimplementedRuleIds:string[]}>,
 *            implementedRuleIds:string[], unimplementedRuleIds:string[]}}
 */
export function ruleDeckCoverage() {
  const byGroup = new Map();
  for (const rule of RULE_PACK.rules) {
    if (!byGroup.has(rule.group)) byGroup.set(rule.group, { group: rule.group, groupName: rule.groupName ?? RULE_PACK.groupNames[rule.group] ?? rule.group, total: 0, implementedRuleIds: [], unimplementedRuleIds: [] });
    const entry = byGroup.get(rule.group);
    entry.total += 1;
    if (typeof RULE_CHECKERS[rule.id] === 'function') entry.implementedRuleIds.push(rule.id);
    else entry.unimplementedRuleIds.push(rule.id);
  }
  const groups = RULE_PACK.groupIdOrder.filter((group) => byGroup.has(group)).map((group) => {
    const entry = byGroup.get(group);
    const machineCheckable = entry.implementedRuleIds.length;
    return {
      group: entry.group,
      groupName: entry.groupName,
      total: entry.total,
      machineCheckable,
      coverageRatio: entry.total ? machineCheckable / entry.total : 0,
      implementedRuleIds: entry.implementedRuleIds,
      unimplementedRuleIds: entry.unimplementedRuleIds,
    };
  });
  const implementedRuleIds = RULE_PACK.rules.filter((rule) => typeof RULE_CHECKERS[rule.id] === 'function').map((rule) => rule.id);
  const machineCheckable = implementedRuleIds.length;
  return {
    total: RULE_PACK.total,
    machineCheckable,
    coverageRatio: RULE_PACK.total ? machineCheckable / RULE_PACK.total : 0,
    groups,
    implementedRuleIds,
    unimplementedRuleIds: RULE_PACK.rules.filter((rule) => typeof RULE_CHECKERS[rule.id] !== 'function').map((rule) => rule.id),
  };
}
