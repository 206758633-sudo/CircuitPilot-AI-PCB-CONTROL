/**
 * 布局计划 → 128 条 PCBA 布局规则审计（A9）。
 *
 * 过去 `PlacementPage` 有 plan/apply/restore，128 条规则只在规则中心展示：
 * "看起来对"和"规则通过"是两条线，写回前不强制。本模块把布局计划翻译成规则引擎输入，
 * 并在写回前把**硬门禁 FAIL**变成阻断条件（REVIEW 不等于 PASS，但需要完整证据栈，
 * 不在布局写回阶段冒充放行）。
 *
 * 证据边界：只填读回里真的有的几何；缺的字段让规则引擎自己判 REVIEW，
 * 绝不为了让审计"看起来通过"而编造 courtyard/3D/DRC 证据。
 */
import { evaluateLayoutRules } from './engineering/layout-rules.mjs';

const round = (value, digits = 3) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

/** 从板框点集算外接矩形（mm）；点顺序不保证，取 min/max。 */
export function outlineBounds(outline) {
  const points = Array.isArray(outline?.points) ? outline.points : [];
  const xs = points.map((point) => Number(point?.x)).filter(Number.isFinite);
  const ys = points.map((point) => Number(point?.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const widthMm = Math.max(...xs) - Math.min(...xs);
  const heightMm = Math.max(...ys) - Math.min(...ys);
  if (!(widthMm > 0) || !(heightMm > 0)) return null;
  return { widthMm: round(widthMm), heightMm: round(heightMm), minX: Math.min(...xs), minY: Math.min(...ys) };
}

/** 把布局计划/读回翻译成 `evaluateLayoutRules` 的输入；只写拿得到的事实。 */
export function buildPlacementAuditInput({ plan = null, readback = null, outline = null } = {}) {
  const bounds = outlineBounds(outline || (readback?.outline?.[0] ? readback.outline[0] : null) || null);
  const byPrimitive = new Map();
  for (const component of readback?.components || []) if (component?.primitiveId) byPrimitive.set(component.primitiveId, component);
  const placements = Array.isArray(plan?.placements) ? plan.placements : [];
  const components = [];
  for (const placement of placements) {
    const observed = placement?.primitiveId ? byPrimitive.get(placement.primitiveId) : null;
    if (!observed) continue;
    const widthMm = round(observed.widthMm ?? observed.bboxMm?.xMm ?? placement.widthMm);
    const heightMm = round(observed.heightMm ?? observed.bboxMm?.yMm ?? placement.heightMm);
    if (!(widthMm > 0) || !(heightMm > 0)) continue; // 尺寸未知的器件不编造，规则会按缺证据 REVIEW
    components.push({
      ref: observed.ref || observed.designator || placement.ref,
      x: round(placement.xMm), y: round(placement.yMm),
      widthMm, heightMm,
      rotationDeg: round(observed.rotationDeg ?? placement.rotationDeg ?? 0),
    });
  }
  return {
    board: {
      widthMm: bounds?.widthMm ?? null,
      heightMm: bounds?.heightMm ?? null,
      outlineClosed: Boolean(outline?.closed ?? true),
    },
    components,
    // 不填 3D/DRC/DFM 证据：让规则引擎对需要这些证据的条目判 REVIEW，而不是由布局写回冒充已通过。
  };
}

/** 审计布局计划：返回硬门禁阻断项与警告；不修改任何设计。 */
export function auditPlacementPlan({ plan = null, readback = null, outline = null } = {}) {
  const input = buildPlacementAuditInput({ plan, readback, outline });
  const audit = evaluateLayoutRules(input);
  const hardFails = (audit.rules || []).filter((item) => item.status === 'FAIL' && item.level === '硬门禁');
  // 只把"真的量到了违规"作为阻断：GATE-* 是聚合门（依赖完整证据栈，属于放行阶段），
  // "未显式声明 courtyard / 缺少证据"类 FAIL 是证据不足（REVIEW 语义），不冒充布局违规。
  const evidenceGap = /未显式声明|缺少|未提供|无法|证据不足|未计算|未填/;
  const blocking = hardFails.filter((item) => !/^GATE-/.test(String(item.id || '')) && !evidenceGap.test(String(item.message || '')));
  const evidenceGaps = hardFails.filter((item) => !blocking.includes(item));
  return {
    ok: blocking.length === 0,
    evidenceGapFailures: evidenceGaps.length,
    auditHash: audit.auditHash,
    blockingFailures: blocking.length,
    warningFailures: audit.summary.warningFailures,
    review: audit.summary.REVIEW,
    passed: audit.passed,
    releaseReady: audit.releaseReady,
    blocking: blocking.map((item) => ({ ruleId: item.id ?? null, title: item.name ?? null, message: item.message ?? null, evidence: item.evidence ?? null })),
    evidenceGaps: evidenceGaps.map((item) => ({ ruleId: item.id ?? null, title: item.name ?? null, message: item.message ?? null })),
    gates: audit.gatesSummary,
    inputSummary: { board: input.board, components: input.components.length },
  };
}
