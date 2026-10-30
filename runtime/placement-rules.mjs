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
import { adaptPlacements, adaptTexts } from './engineering/skill-input.mjs';
import { buildDrcEvidence } from './engineering/drc-evidence.mjs';
import { evaluateLayoutSupplements } from './engineering/layout-supplements.mjs';

const round = (value, digits = 3) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);
const MIL_TO_MM = 25.4 / 1000;
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);

/** 从封装名猜 packageClass：只映射规则包真正用到的类别，未知一律 OTHER。 */
function classifyFootprint(name) {
  const text = String(name || '').toUpperCase();
  if (/^C?0402|R0402/.test(text)) return '0402';
  if (/^C?0603|R0603/.test(text)) return '0603';
  if (/QFN/.test(text)) return 'QFN';
  if (/WLCSP|BGA/.test(text)) return 'BGA';
  if (/SOT-23|SOT-223/.test(text)) return 'SOT-23';
  if (/WIRELM|ESP32|MODULE/.test(text)) return 'MODULE';
  if (/IND-SMD|INDUCTOR/.test(text)) return 'INDUCTOR';
  if (/CRYSTAL|XTAL/.test(text)) return 'CRYSTAL';
  if (/FPC-SMD/.test(text)) return 'FFC';
  if (/USB|TYPE-C/.test(text)) return 'USB';
  if (/SWITCH|TACT/.test(text)) return 'SWITCH';
  if (/SOD|SMA|SMB|SMC/.test(text)) return 'DIODE';
  if (/ESOP|SOIC|SOP-/.test(text)) return 'SOIC';
  if (/CONN|WAFER|X9821|SH1\.0|ZH1\.5|GH1\.25/.test(text)) return 'CONNECTOR';
  return 'OTHER';
}

function padBoxesMm(copper) {
  const pads = Array.isArray(copper?.pads) ? copper.pads : [];
  return pads.map((pad) => {
    const xMm = num(pad?.x) === null ? null : pad.x * MIL_TO_MM;
    const yMm = num(pad?.y) === null ? null : pad.y * MIL_TO_MM;
    const radiusMm = num(pad?.radius) === null ? 0 : pad.radius * MIL_TO_MM;
    if (xMm === null || yMm === null) return null;
    return {
      designator: String(pad.designator || ''),
      net: String(pad.net || ''),
      layer: num(pad.layer),
      xMm, yMm, radiusMm,
      minX: xMm - radiusMm, minY: yMm - radiusMm, maxX: xMm + radiusMm, maxY: yMm + radiusMm,
    };
  }).filter(Boolean);
}

function rectGapMm(a, b) {
  if (!a || !b) return null;
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
  return Math.hypot(dx, dy);
}
function rectsIntersectMm(a, b) {
  if (!a || !b) return false;
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
const POWER_NET = /^(\+?\d+V\d*|VCC|VDD|VBUS|VBAT|VIN|VOUT|VSYS|PWR|3V3|5V|12V)/i;

/** 铜线按网络累加长度（mil→mm）；只用于补齐设计意图里没填的高速组长度。 */
function copperLengthByNetMm(copper) {
  const lengths = new Map();
  for (const line of Array.isArray(copper?.lines) ? copper.lines : []) {
    const net = String(line?.net || '');
    const x1 = num(line?.x1); const y1 = num(line?.y1); const x2 = num(line?.x2); const y2 = num(line?.y2);
    if (!net || x1 === null || y1 === null || x2 === null || y2 === null) continue;
    lengths.set(net, (lengths.get(net) || 0) + Math.hypot(x2 - x1, y2 - y1) * MIL_TO_MM);
  }
  return lengths;
}

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
export function buildPlacementAuditInput({ plan = null, readback = null, outline = null, texts = null, pads = null, copper = null, intent = null, drcReport = null, drcScope = null } = {}) {
  const bounds = outlineBounds(outline || (readback?.outline?.[0] ? readback.outline[0] : null) || null);
  const byPrimitive = new Map();
  for (const component of readback?.components || []) if (component?.primitiveId) byPrimitive.set(component.primitiveId, component);
  const placements = Array.isArray(plan?.placements) ? plan.placements : [];

  // 封装名 → packageClass：让 SPACE-04..08/11/12/18 真正有输入，而不是永远 NA/REVIEW。
  const footprintByDesignator = new Map();
  for (const component of unwrap(pads)?.components || []) if (component?.designator) footprintByDesignator.set(String(component.designator), component.footprint?.name ?? null);
  const classOf = (ref) => classifyFootprint(footprintByDesignator.get(String(ref || '')));

  const components = [];
  for (const placement of placements) {
    const observed = placement?.primitiveId ? byPrimitive.get(placement.primitiveId) : null;
    if (!observed) continue;
    const widthMm = round(observed.widthMm ?? observed.bboxMm?.xMm ?? placement.widthMm);
    const heightMm = round(observed.heightMm ?? observed.bboxMm?.yMm ?? placement.heightMm);
    if (!(widthMm > 0) || !(heightMm > 0)) continue; // 尺寸未知的器件不编造，规则会按缺证据 REVIEW
    const rawSide = observed.layerSide ?? observed.side;
    const side = typeof rawSide === 'number' ? (rawSide === 2 ? 'bottom' : 'top') : (String(rawSide || '').toLowerCase() === 'bottom' ? 'bottom' : 'top');
    const heightMm3d = Number(observed.heightMm3d);
    const courtyardMm = Number(observed.courtyardMm);
    const ref = observed.ref || observed.designator || placement.ref;
    const packageClass = classOf(ref);
    components.push({
      ref,
      x: round(placement.xMm), y: round(placement.yMm),
      widthMm, heightMm,
      rotationDeg: round(observed.rotationDeg ?? placement.rotationDeg ?? 0),
      side,
      // pcb.placement.read 的 bboxMm 含焊盘；标记后 SPACE-14 不会把焊盘包络当本体硬判 FAIL。
      bboxIncludesPads: Boolean(observed.bboxMm),
      ...(packageClass && packageClass !== 'OTHER' ? { packageClass } : {}),
      ...(Number.isFinite(heightMm3d) && heightMm3d > 0 ? { heightMm3d } : {}),
      ...(Number.isFinite(courtyardMm) && courtyardMm >= 0 ? { courtyardMm, explicitCourtyard: true } : {}),
    });
  }

  const board = {
    widthMm: bounds?.widthMm ?? null,
    heightMm: bounds?.heightMm ?? null,
    originXMm: bounds?.minX ?? null,
    originYMm: bounds?.minY ?? null,
    outlineClosed: Boolean(outline?.closed ?? true),
  };

  // 设计意图里的组件补丁：只覆盖声明字段，几何仍以读回为准（意图不能改坐标）。
  if (intent && typeof intent === 'object' && intent.components && typeof intent.components === 'object') {
    for (const component of components) {
      const patch = intent.components[component.ref];
      if (!patch || typeof patch !== 'object') continue;
      for (const key of ['heightMm3d', 'courtyardMm', 'packageClass', 'side', 'conn', 'antenna', 'isNoiseSource', 'isMetal']) {
        if (patch[key] !== undefined) component[key] = patch[key];
      }
      component.explicitCourtyard = Number.isFinite(Number(component.courtyardMm)) && Number(component.courtyardMm) >= 0;
    }
  }
  const componentByRef = new Map(components.map((component) => [component.ref, component]));
  const bodyBox = (component) => component ? {
    minX: component.x - component.widthMm / 2, maxX: component.x + component.widthMm / 2,
    minY: component.y - component.heightMm / 2, maxY: component.y + component.heightMm / 2,
  } : null;
  const courtyardBox = (component) => {
    const body = bodyBox(component);
    const pad = Number(component?.courtyardMm);
    return body && Number.isFinite(pad) && pad >= 0 ? { minX: body.minX - pad, maxX: body.maxX + pad, minY: body.minY - pad, maxY: body.maxY + pad } : null;
  };

  const padFacts = padBoxesMm(unwrap(copper));
  const silkPresent = texts !== null && texts !== undefined;
  let silk = null;
  if (silkPresent) {
    const placementFacts = adaptPlacements(readback);
    const textFacts = adaptTexts(texts, placementFacts);
    const silkItems = [];
    const designators = [];
    for (const text of textFacts) {
      const rawBounds = text.boundsMm;
      const textBounds = rawBounds ? { minX: rawBounds.minXMm, minY: rawBounds.minYMm, maxX: rawBounds.maxXMm, maxY: rawBounds.maxYMm } : null;
      const textSide = text.layer === 3 ? 'top' : text.layer === 4 ? 'bottom' : null;
      const component = text.componentRef ? componentByRef.get(text.componentRef) : null;
      const body = bodyBox(component);
      const sidePads = padFacts.filter((pad) => !textSide || pad.layer === 12 || (textSide === 'top' ? pad.layer === 1 : pad.layer === 2));
      const onPadRefs = textBounds ? [...new Set(sidePads.filter((pad) => rectsIntersectMm(textBounds, pad)).map((pad) => pad.designator))] : [];
      const padGaps = textBounds ? sidePads.map((pad) => rectGapMm(textBounds, pad)).filter((gap) => gap !== null) : [];
      const courtyardOverlapRefs = textBounds ? components.filter((item) => {
        if (!item.explicitCourtyard) return false;
        const box = courtyardBox(item);
        return box && rectsIntersectMm(textBounds, box);
      }).map((item) => item.ref) : [];
      const courtyardKnown = components.length > 0 && components.every((item) => item.explicitCourtyard === true);
      let edgeDistanceMm = null; let outsideBoard = null;
      if (textBounds && bounds && board.originXMm !== null && board.originYMm !== null) {
        const left = textBounds.minX - board.originXMm;
        const bottom = textBounds.minY - board.originYMm;
        const right = board.originXMm + board.widthMm - textBounds.maxX;
        const top = board.originYMm + board.heightMm - textBounds.maxY;
        edgeDistanceMm = round(Math.min(left, bottom, right, top));
        outsideBoard = left < -1e-6 || bottom < -1e-6 || right < -1e-6 || top < -1e-6;
      }
      const gapToBodyMm = textBounds && body ? rectGapMm(textBounds, body) : null;
      const placementRelative = textBounds && body
        ? (textBounds.minY >= body.maxY - 1e-9 || textBounds.maxX <= body.minX + 1e-9)
        : null;
      const sideMismatch = textSide && component ? textSide !== component.side : null;
      const item = {
        ref: text.componentRef || text.id,
        text: text.text,
        kind: text.kind,
        layer: text.layer,
        boundsMm: rawBounds,
        outsideBoard,
        edgeDistanceMm,
        gapToPadMm: padGaps.length ? round(Math.min(...padGaps)) : null,
        onPadRefs,
        courtyardOverlapRefs,
        courtyardKnown,
        gapToBodyMm: gapToBodyMm === null ? null : round(gapToBodyMm),
        placementRelative,
        sideMismatch,
      };
      silkItems.push(item);
      if (text.kind === 'designator' && textBounds) designators.push({
        ref: text.componentRef, rotationDeg: text.rotationDeg, mirror: text.mirror,
        gapToBodyMm: item.gapToBodyMm, placementRelative, sideMismatch,
      });
    }
    silk = {
      textCount: textFacts.length,
      items: silkItems,
      designators,
      textHeights: textFacts.map((text) => (text.boundsMm ? text.boundsMm.maxYMm - text.boundsMm.minYMm : text.fontSizeMm)).filter((value) => Number.isFinite(value) && value > 0),
      lineWidthsMm: textFacts.map((text) => text.lineWidthMm).filter((value) => Number.isFinite(value) && value > 0),
      overlappingPadCount: silkItems.filter((item) => item.onPadRefs.length > 0).length,
      runsOffBoard: silkItems.some((item) => item.outsideBoard === true),
    };
  }

  const power = buildPowerFacts({ copper: unwrap(copper), classOf });
  const input = {
    board,
    components,
    ...(silk ? { silk } : {}),
    ...(power ? { power } : {}),
    // 不填 3D/DFM 证据：让规则引擎对需要这些证据的条目判 REVIEW，而不是由布局写回冒充已通过。
  };
  if (drcReport !== null && drcReport !== undefined) {
    const built = buildDrcEvidence(drcReport, { scope: String(drcScope || 'PCB/unspecified') });
    if (built.ok) input.evidence = { officialDrc: built.evidence };
  }
  if (intent && typeof intent === 'object') {
    if (intent.silk && typeof intent.silk === 'object') input.silk = { ...(input.silk || {}), ...intent.silk };
    if (intent.power && typeof intent.power === 'object') input.power = { ...(input.power || {}), ...intent.power };
    if (intent.board && typeof intent.board === 'object') input.board = { ...input.board, ...intent.board };
    for (const key of ['rf', 'testPoints', 'switches', 'dfm', 'esd', 'requiredNets', 'directionClassLimit', 'thermal', 'pdn', 'highSpeed', 'creepage', 'enclosure', 'emc']) {
      if (intent[key] !== undefined) input[key] = intent[key];
    }
    if (intent.evidence && typeof intent.evidence === 'object') input.evidence = { ...(input.evidence || {}), ...intent.evidence };
  }
  // 高速组长度：意图没填的，用铜线按网络累加补齐；仍没有就保持 null 让 SUP-HS-01 REVIEW。
  if (input.highSpeed && Array.isArray(input.highSpeed.groups) && copper) {
    // 不原地改调用方的 intent：高速组复制一份再补长度。
    input.highSpeed = {
      ...input.highSpeed,
      groups: input.highSpeed.groups.map((group) => ({ ...group, members: (group?.members || []).map((member) => ({ ...member })) })),
    };
    const lengths = copperLengthByNetMm(copper);
    for (const group of input.highSpeed.groups) {
      for (const member of group?.members || []) {
        if (num(member?.lengthMm) !== null || !member?.net) continue;
        const computed = lengths.get(String(member.net));
        if (computed !== undefined) { member.lengthMm = round(computed); member.lengthSource = 'copper.lines'; }
      }
    }
  }
  return input;
}

/** 从 copper.pads 的“电容-电源脚”最近距离生成 PWR-01 输入；不猜电流/平面。 */
function buildPowerFacts({ copper = null, classOf }) {
  const pads = Array.isArray(copper?.pads) ? copper.pads : [];
  if (!pads.length) return null;
  const byDesignator = new Map();
  for (const pad of pads) {
    const ref = String(pad?.designator || '');
    if (!ref) continue;
    const x = num(pad.x); const y = num(pad.y);
    if (x === null || y === null) continue;
    const radius = num(pad.radius) ?? 0;
    if (!byDesignator.has(ref)) byDesignator.set(ref, []);
    byDesignator.get(ref).push({ net: String(pad.net || ''), xMm: x * MIL_TO_MM, yMm: y * MIL_TO_MM, radiusMm: radius * MIL_TO_MM });
  }
  const entries = [];
  for (const [capRef, capPads] of byDesignator) {
    if (!/^C\d/i.test(capRef)) continue;
    for (const capPad of capPads) {
      if (!capPad.net || !POWER_NET.test(capPad.net) || /GND/i.test(capPad.net)) continue;
      let best = null;
      for (const [icRef, icPads] of byDesignator) {
        if (icRef === capRef) continue;
        const icClass = classOf(icRef);
        // 去耦对象必须是 IC/模组的电源脚，不能把同网络的电阻/连接器/电感当成电源脚。
        if (!['QFN', 'BGA', 'MODULE', 'SOT-23', 'SOIC'].includes(icClass)) continue;
        for (const icPad of icPads) {
          if (icPad.net !== capPad.net) continue;
          const distanceMm = Math.hypot(capPad.xMm - icPad.xMm, capPad.yMm - icPad.yMm) - capPad.radiusMm - icPad.radiusMm;
          if (!best || distanceMm < best.distanceMm) best = { icRef, distanceMm, icClass, icClassKnown: Boolean(icClass && icClass !== 'OTHER') };
        }
      }
      if (best) entries.push({ capRef, icRef: best.icRef, net: capPad.net, distanceMm: round(Math.max(0, best.distanceMm)), icClass: best.icClass, icClassKnown: best.icClassKnown, auto: true });
    }
  }
  return entries.length ? { decoupling: entries.sort((a, b) => a.capRef.localeCompare(b.capRef, 'en', { numeric: true })) } : null;
}

/** 审计布局计划：返回硬门禁阻断项与警告；不修改任何设计。 */
export function auditPlacementPlan({ plan = null, readback = null, outline = null, texts = null, pads = null, copper = null, intent = null, drcReport = null, drcScope = null } = {}) {
  const input = buildPlacementAuditInput({ plan, readback, outline, texts, pads, copper, intent, drcReport, drcScope });
  const audit = evaluateLayoutRules(input);
  const hardFails = (audit.rules || []).filter((item) => item.status === 'FAIL' && item.level === '硬门禁');
  // 只把"真的量到了违规"作为阻断：GATE-* 是聚合门（依赖完整证据栈，属于放行阶段），
  // "未显式声明 courtyard / 缺少证据"类 FAIL 是证据不足（REVIEW 语义），不冒充布局违规。
  const evidenceGap = /未显式声明|缺少|未提供|无法|证据不足|未计算|未填/;
  const blocking = hardFails.filter((item) => !/^GATE-/.test(String(item.id || '')) && !evidenceGap.test(String(item.message || '')));
  const evidenceGaps = hardFails.filter((item) => !blocking.includes(item));
  const supplements = evaluateLayoutSupplements(input);
  const supplementFails = supplements.rules.filter((item) => item.status === 'FAIL');
  const supplementBlocking = supplementFails.map((item) => ({ ruleId: item.id, title: item.title, message: item.message, evidence: item.evidence ?? null }));
  return {
    ok: blocking.length === 0 && supplementFails.length === 0,
    evidenceGapFailures: evidenceGaps.length,
    auditHash: audit.auditHash,
    summary: audit.summary,
    blockingFailures: blocking.length + supplementFails.length,
    warningFailures: audit.summary.warningFailures,
    review: audit.summary.REVIEW,
    passed: audit.passed && supplementFails.length === 0,
    releaseReady: audit.releaseReady && supplementFails.length === 0,
    blocking: [...blocking.map((item) => ({ ruleId: item.id ?? null, title: item.name ?? null, message: item.message ?? null, evidence: item.evidence ?? null })), ...supplementBlocking],
    evidenceGaps: evidenceGaps.map((item) => ({ ruleId: item.id ?? null, title: item.name ?? null, message: item.message ?? null })),
    gates: audit.gatesSummary,
    supplements,
    supplementFailures: supplementFails.length,
    inputSummary: { board: input.board, components: input.components.length, silkTexts: input.silk?.textCount ?? null, decouplingPairs: input.power?.decoupling?.length ?? null },
  };
}
