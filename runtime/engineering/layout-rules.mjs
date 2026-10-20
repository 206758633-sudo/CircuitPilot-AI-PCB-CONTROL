/**
 * PCBA 布局规则引擎（把 docs/pcb-layout 的 128 条规则变成可执行判定）
 *
 * 设计原则（与本仓库其它工程模块一致）：
 *   1. 规则数值只存在于 rule pack（rules/board-layout-rules.json），代码不另抄一份常量；
 *   2. 判定分四种状态：PASS / FAIL / REVIEW / NA。**REVIEW 不等于 PASS**——
 *      缺少 Gerber、叠层、3D 高度表、网表等证据时一律 REVIEW，绝不靠"看起来没问题"放行；
 *   3. 每条 FAIL 必须带可复现的 evidence（谁、多少毫米、阈值多少），便于改图与复核；
 *   4. 同一输入必须得到逐字节相同的结果（含 auditHash），方便被门禁与审计引用。
 *
 * 输入结构（只填你有的字段；缺的字段会让对应规则变成 REVIEW 而不是蒙混过关）：
 *   {
 *     board: { widthMm, heightMm, thicknessMm, cornerRadiusMm, outlineClosed,
 *              processEdgeMm, panelized, vCutLines:[{axis,positionMm,depthMm}],
 *              warpPercent, padToEdgeMm, copperToEdgeMm,
 *              fiducials:[{x,y,diaMm,maskDiaMm}], toolingHoles:[{x,y,diaMm}],
 *              mountingHoles:[{x,y,diaMm}] },
 *     components: [{
 *       ref, x, y, widthMm, heightMm, rotationDeg?, heightMm3d?, courtyardMm?,
 *       packageClass?: '0402'|'0603'|'SOT-23'|'QFN'|'MODULE'|'CONNECTOR'|'FFC'|'USB'|'SWITCH'|'INDUCTOR'|'CRYSTAL'|'IC'|'LED'|'CAP'|'OTHER',
 *       conn?: { kind:'FFC'|'ZIF'|'USB-C'|'USB-A'|'HEADER'|'JST', openingDir:'+x'|'-x'|'+y'|'-y',
 *                openingNormalityDeg?, plugClearanceMm?, cableKeepout?, massG?, reinforced?,
 *                pin1Marked?, pressClearanceMm? },
 *       antenna?: { endDir:'+x'|'-x'|'+y'|'-y' },
 *       isNoiseSource?: boolean, isMetal?: boolean
 *     }],
 *     rf: { componentRef, overhangMm?, keepout:{x0,y0,x1,y1}, copperInKeepout?,
 *           metalRefs?:[], viaFencePitchMm?, gndCoveragePercent?, maskOpeningInKeepout?,
 *           silkInKeepout?, viasInKeepout?, gndViaRatio?, noiseSourcesNearAntenna? },
 *     silk: { items:[{ref,gapToPadMm?,onPadRefs?,outsideBoard?}], textHeights?:[], minCharGapMm?,
 *             strayLineCount?, overlappingPadCount? },
 *     power: { nets:[{net,currentA,widthMm,layer:'outer'|'inner'}],
 *              decoupling:[{capRef,icRef,distanceMm,icClass?}],
 *              paths:[{net,peakCurrentA,designedForA}] },
 *     testPoints: [{ref,x,y,diaMm,net}], requiredNets?:[],
 *     switches: [{ref, clearanceMm}],
 *     directionClassLimit?: 2, directionClassDegradationApproved?: false,
 *     evidence: { step3d?:{passed}, officialDrc?:{passed}, dfm?:{passed}, dfa?:{passed},
 *                 fai?:{passed}, eco?:{lastChangeId}, highSpeedImpedance?:{defined} }
 *   }
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finding } from './stackup.mjs';

const PACK_URL = new URL('./rules/board-layout-rules.json', import.meta.url);
export const LAYOUT_RULE_PACK_PATH = PACK_URL;

export const LAYOUT_RULE_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });
const STATUS = LAYOUT_RULE_STATUS;
const EPS = 1e-9;
const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const toNum = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const mm = (value) => `${round(value)} mm`;

// ---------------------------------------------------------------------------
// 1. 规则包：唯一数值来源，加载时校验编号连续性与分组计数
// ---------------------------------------------------------------------------
let cachedPack = null;

export function layoutRulePack() {
  if (cachedPack) return cachedPack;
  const raw = JSON.parse(readFileSync(PACK_URL, 'utf8'));
  const problems = validateRulePack(raw);
  if (problems.length) {
    throw Object.assign(new Error(`PCBA 布局规则包不合法：${problems.join('；')}`), { code: 'LAYOUT_RULE_PACK_INVALID', details: problems });
  }
  const rules = Object.freeze(raw.rules.map((rule) => Object.freeze({ ...rule })));
  const counts = {}; const levels = {};
  for (const rule of rules) { counts[rule.group] = (counts[rule.group] || 0) + 1; levels[rule.level] = (levels[rule.level] || 0) + 1; }
  cachedPack = Object.freeze({ ...raw, rules, counts, levels, hash: sha256(JSON.stringify(raw.rules)) });
  return cachedPack;
}

/** 供测试与 CI 校验外部规则包；返回问题列表（空数组 = 合法）。 */
export function validateRulePack(raw) {
  const problems = [];
  if (!raw || !Array.isArray(raw.rules)) return ['缺少 rules 数组'];
  if (raw.total !== raw.rules.length) problems.push(`total 字段 ${raw.total} 与实际 ${raw.rules.length} 条不一致`);
  const ids = new Set(); const noByGroup = {};
  for (const rule of raw.rules) {
    const match = /^([A-Z]{2,5})-(\d{2})$/.exec(String(rule.id || ''));
    if (!match) { problems.push(`编号格式非法：${rule.id}`); continue; }
    if (ids.has(rule.id)) problems.push(`编号重复：${rule.id}`);
    ids.add(rule.id);
    if (!Array.isArray(raw.rules) || !(rule.group === match[1])) problems.push(`编号与分组不一致：${rule.id}`);
    if (!['硬门禁', '推荐'].includes(rule.level)) problems.push(`${rule.id} 等级非法：${rule.level}`);
    if (!rule.name || !rule.value || !rule.check) problems.push(`${rule.id} 缺少 name/value/check 字段`);
    (noByGroup[rule.group] ||= []).push(Number(match[2]));
  }
  for (const [group, list] of Object.entries(noByGroup)) {
    const sorted = [...list].sort((a, b) => a - b);
    if (sorted.some((value, index) => value !== index + 1)) problems.push(`${group} 编号不连续：${sorted.join(',')}`);
  }
  if (raw.counts) for (const [group, expected] of Object.entries(raw.counts)) {
    const actual = noByGroup[group]?.length || 0;
    if (actual !== expected) problems.push(`${group} 计数 ${actual} 与声明 ${expected} 不一致`);
  }
  return problems;
}

/** 只暴露元信息，不把 128 条正文塞进每个 API 响应。 */
export function layoutRulePackSummary() {
  const pack = layoutRulePack();
  return {
    version: pack.version, total: pack.total, counts: pack.counts, levels: pack.levels, hash: pack.hash,
    groups: pack.groupIdOrder.map((id) => ({ id, name: pack.groupNames[id], count: pack.counts[id] || 0 })),
    documents: pack.documents || {},
    policy: { reviewIsNotPass: true, officialDrcRequired: true, valueSource: 'rules/board-layout-rules.json' },
  };
}

// ---------------------------------------------------------------------------
// 2. 几何与判定辅助
// ---------------------------------------------------------------------------
const ok = (evidence, message) => ({ status: STATUS.PASS, evidence, message });
const fail = (message, evidence) => ({ status: STATUS.FAIL, message, evidence });
const review = (message, evidence) => ({ status: STATUS.REVIEW, message, evidence });
const na = (message) => ({ status: STATUS.NA, message });

function rectOf(x0, y0, x1, y1) { return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }; }
function rectOverlap(a, b) {
  const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return dx > EPS && dy > EPS ? { dx, dy, area: dx * dy } : null;
}
/** 边缘到边缘间距：相交/相切返回 0，分离返回欧氏距离。 */
function rectGap(a, b) {
  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(a.y0 - b.y1, b.y0 - a.y1);
  if (dx <= EPS && dy <= EPS) return 0;
  if (dx > EPS && dy > EPS) return Math.hypot(dx, dy);
  return Math.max(dx, dy);
}
function expand(rect, margin) { return { x0: rect.x0 - margin, y0: rect.y0 - margin, x1: rect.x1 + margin, y1: rect.y1 + margin }; }
const EDGE_NORMAL = { left: '-x', right: '+x', bottom: '-y', top: '+y' };
const OPPOSITE = Object.freeze({ '+x': '-x', '-x': '+x', '+y': '-y', '-y': '+y' });

function edgeDistances(rect, board) {
  return { left: rect.x0, right: board.widthMm - rect.x1, bottom: rect.y0, top: board.heightMm - rect.y1 };
}
function nearestEdge(rect, board) {
  const distances = edgeDistances(rect, board);
  let edge = 'left';
  for (const key of ['right', 'bottom', 'top']) if (distances[key] < distances[edge]) edge = key;
  return { edge, distance: distances[edge], distances };
}
function distanceToCorners(rect, board) {
  const corners = [[0, 0], [board.widthMm, 0], [0, board.heightMm], [board.widthMm, board.heightMm]];
  return Math.min(...corners.map(([cx, cy]) => Math.hypot(
    Math.max(rect.x0 - cx, 0, cx - rect.x1),
    Math.max(rect.y0 - cy, 0, cy - rect.y1),
  )));
}
/** 连接器开口方向的探测矩形：从本体表面朝外延伸 depth。 */
function probeRect(c, direction, depth) {
  const r = c.body; const d = Math.max(0, depth);
  if (direction === '+x') return rectOf(r.x1, r.y0, r.x1 + d, r.y1);
  if (direction === '-x') return rectOf(r.x0 - d, r.y0, r.x0, r.y1);
  if (direction === '+y') return rectOf(r.x0, r.y1, r.x1, r.y1 + d);
  if (direction === '-y') return rectOf(r.x0, r.y0 - d, r.x1, r.y0);
  return null;
}
function blockersIn(rect, components, excludeRef) {
  return components.filter((c) => c.ref !== excludeRef && rectOverlap(rect, c.courtyard)).map((c) => c.ref);
}
function fmtList(list) { return list.length ? list.join('、') : '（无）'; }

// 元件标准化：统一成"世界坐标 X/Y 范围 + courtyard"
function normalizeComponent(raw) {
  const widthMm = toNum(raw.widthMm); const heightMm = toNum(raw.heightMm);
  if (!(widthMm > 0) || !(heightMm > 0) || !isNum(toNum(raw.x)) || !isNum(toNum(raw.y))) return null;
  const rotationDeg = ((toNum(raw.rotationDeg) ?? 0) % 360 + 360) % 360;
  const swapped = rotationDeg % 180 !== 0;
  const bodyW = swapped ? heightMm : widthMm;
  const bodyH = swapped ? widthMm : heightMm;
  const explicitCourtyard = raw.courtyardMm !== undefined && raw.courtyardMm !== null;
  const courtyardMm = explicitCourtyard ? Math.max(0, toNum(raw.courtyardMm) ?? 0) : 0.25;
  const body = rectOf(toNum(raw.x) - bodyW / 2, toNum(raw.y) - bodyH / 2, toNum(raw.x) + bodyW / 2, toNum(raw.y) + bodyH / 2);
  const conn = raw.conn && typeof raw.conn === 'object' ? { ...raw.conn, openingDir: String(raw.conn.openingDir || '') } : null;
  const antenna = raw.antenna && typeof raw.antenna === 'object' ? { ...raw.antenna, endDir: String(raw.antenna.endDir || '') } : null;
  return {
    ref: String(raw.ref ?? ''), x: toNum(raw.x), y: toNum(raw.y), bodyW, bodyH, rotationDeg,
    heightMm3d: toNum(raw.heightMm3d), courtyardMm, explicitCourtyard,
    packageClass: String(raw.packageClass || 'OTHER').toUpperCase(),
    conn, antenna, isNoiseSource: raw.isNoiseSource === true, isMetal: raw.isMetal === true,
    body, courtyard: expand(body, courtyardMm), raw,
  };
}

function normalizeContext(input) {
  const source = input && typeof input === 'object' ? input : {};
  const rawBoard = source.board && typeof source.board === 'object' ? source.board : {};
  const widthMm = toNum(rawBoard.widthMm); const heightMm = toNum(rawBoard.heightMm);
  const board = {
    ...rawBoard, widthMm, heightMm,
    thicknessMm: toNum(rawBoard.thicknessMm),
    cornerRadiusMm: toNum(rawBoard.cornerRadiusMm),
    processEdgeMm: toNum(rawBoard.processEdgeMm),
    warpPercent: toNum(rawBoard.warpPercent),
    padToEdgeMm: toNum(rawBoard.padToEdgeMm),
    copperToEdgeMm: toNum(rawBoard.copperToEdgeMm),
    panelized: rawBoard.panelized === true ? true : rawBoard.panelized === false ? false : null,
    outlineClosed: rawBoard.outlineClosed === true ? true : rawBoard.outlineClosed === false ? false : null,
    fiducials: Array.isArray(rawBoard.fiducials) ? rawBoard.fiducials : null,
    toolingHoles: Array.isArray(rawBoard.toolingHoles) ? rawBoard.toolingHoles : null,
    mountingHoles: Array.isArray(rawBoard.mountingHoles) ? rawBoard.mountingHoles : null,
    vCutLines: Array.isArray(rawBoard.vCutLines) ? rawBoard.vCutLines : null,
  };
  const components = (Array.isArray(source.components) ? source.components : []).map(normalizeComponent).filter(Boolean);
  const byRef = new Map(components.map((c) => [c.ref, c]));
  const geometryReady = isNum(widthMm) && widthMm > 0 && isNum(heightMm) && heightMm > 0;
  return {
    input: source, board, components, byRef, geometryReady,
    connectors: components.filter((c) => c.conn),
    rf: source.rf && typeof source.rf === 'object' ? source.rf : null,
    silk: source.silk && typeof source.silk === 'object' ? source.silk : null,
    power: source.power && typeof source.power === 'object' ? source.power : null,
    testPoints: Array.isArray(source.testPoints) ? source.testPoints : null,
    switches: Array.isArray(source.switches) ? source.switches : null,
    evidence: source.evidence && typeof source.evidence === 'object' ? source.evidence : {},
  };
}
const needGeometry = () => review('缺少板框尺寸（widthMm/heightMm），无法做几何判定');
const needComponents = () => review('未提供器件清单（components），无法判定');

// ---------------------------------------------------------------------------
// 3. 逐条规则检查器：键 = 规则编号。未注册的规则一律 REVIEW（不臆造结论）。
// ---------------------------------------------------------------------------
const CHECKERS = {
  // ---------- MECH ----------
  'MECH-01': (ctx) => {
    if (!ctx.geometryReady) return needGeometry();
    const { board } = ctx;
    if (board.outlineClosed === null) return review('外形闭合性未验证', { widthMm: board.widthMm, heightMm: board.heightMm });
    if (board.outlineClosed === false) return fail('外形不闭合，存在自交或游离线段', { outlineClosed: false });
    return ok({ widthMm: board.widthMm, heightMm: board.heightMm, outlineClosed: true }, `外形 ${mm(board.widthMm)} × ${mm(board.heightMm)} 已闭合`);
  },
  'MECH-02': (ctx) => {
    const t = ctx.board.thicknessMm;
    if (!isNum(t)) return review('未提供成品板厚');
    if (Math.abs(t - 1.6) > 0.1 + EPS) return fail(`板厚 ${mm(t)} 超出 1.60±0.10 mm`, { thicknessMm: t, target: 1.6, tolerance: 0.1 });
    return ok({ thicknessMm: t }, `板厚 ${mm(t)} 合规`);
  },
  'MECH-03': (ctx) => {
    const warp = ctx.board.warpPercent;
    if (!isNum(warp)) return review('未提供回流后翘曲实测值（需塞尺/平台测量）');
    if (warp > 0.75 + EPS) return fail(`翘曲 ${round(warp, 3)}% 超过 0.75%`, { warpPercent: warp });
    return ok({ warpPercent: warp }, `翘曲 ${round(warp, 3)}% 合规`);
  },
  'MECH-04': (ctx) => {
    const r = ctx.board.cornerRadiusMm;
    if (!isNum(r)) return review('未提供板角圆角半径（需机械层量测）');
    if (r < 1 - EPS) return fail(`板角圆角 R${round(r)} 小于 R1.00`, { cornerRadiusMm: r });
    return ok({ cornerRadiusMm: r }, `圆角 R${round(r)} 合规`);
  },
  'MECH-05': (ctx) => {
    if (!ctx.components.length) return needComponents();
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    const rfGoverned = [];
    for (const c of ctx.components) {
      if (c.conn) continue; // 连接器越边由 MECH-13 单独放行
      if (c.antenna) { rfGoverned.push(c.ref); continue; } // 天线越边是 RF-01/RF-02 的放行项
      const { distance } = nearestEdge(c.courtyard, ctx.board);
      if (distance < 0.5 - EPS) violations.push(`${c.ref}=${mm(distance)}`);
    }
    if (violations.length) return fail(`本体到板边不足 0.50 mm：${violations.join('，')}`, { violations });
    return ok({ checked: ctx.components.filter((c) => !c.conn && !c.antenna).length, rfGoverned },
      `全部器件本体到板边 ≥0.50 mm${rfGoverned.length ? `（天线模组 ${fmtList(rfGoverned)} 的越边量归 RF-01 放行）` : ''}`);
  },
  'MECH-06': (ctx) => {
    const v = ctx.board.padToEdgeMm;
    if (!isNum(v)) return review('未提供焊盘到板边实测值（需 Gerber/开窗层与外形层叠合）');
    if (v < 0.3 - EPS) return fail(`焊盘到板边 ${mm(v)} 小于 0.30 mm`, { padToEdgeMm: v });
    return ok({ padToEdgeMm: v }, `焊盘到板边 ${mm(v)} 合规`);
  },
  'MECH-07': (ctx) => {
    const lines = ctx.board.vCutLines;
    if (!lines || !lines.length) return na('本板无 V-CUT（未拼板），该规则不适用');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const line of lines) {
      const position = toNum(line.positionMm); if (!isNum(position)) continue;
      const margin = 1.0;
      for (const c of ctx.components) {
        const near = line.axis === 'x' ? Math.abs(c.body.y - position) : Math.abs(c.body.x - position);
        if (near < margin + EPS) violations.push(`${c.ref} 距 V-CUT ${mm(near)}`);
      }
    }
    if (violations.length) return fail(`V-CUT 两侧各 1.00 mm 内存在元件：${violations.join('，')}`, { violations });
    return ok({ lineCount: lines.length }, 'V-CUT 两侧各 1.00 mm 内无元件');
  },
  'MECH-08': (ctx) => {
    const lines = ctx.board.vCutLines;
    if (!lines || !lines.length) return na('本板无 V-CUT（未拼板），该规则不适用');
    const t = ctx.board.thicknessMm;
    const depths = lines.map((line) => toNum(line.depthMm)).filter(isNum);
    if (!isNum(t) || !depths.length) return review('缺少板厚或 V-CUT 切入深度实测值');
    const expected = t / 3;
    const bad = depths.filter((d) => Math.abs(d - expected) > 0.1 + EPS);
    if (bad.length) return fail(`V-CUT 深度 ${bad.map(mm).join('、')} 偏离板厚/3=${mm(expected)} ±0.10`, { depths, expected });
    return ok({ depths, expected: round(expected) }, `V-CUT 深度按板厚/3 取值`);
  },
  'MECH-10': (ctx) => {
    const { board } = ctx;
    if (board.panelized === null) return review('未声明是否拼板（panelized）');
    if (board.panelized === false) return fail('未拼板：缺少 ≥5.00 mm 工艺边，贴片/分板无基准', { panelized: false, processEdgeMm: board.processEdgeMm });
    if (!isNum(board.processEdgeMm)) return review('已拼板但未提供工艺边宽度');
    // 工艺边位于单板外形之外，板内器件不受其约束；工艺边内只允许 Mark 与定位孔。
    // 这里不臆测"工艺边被占用"，只校验宽度；占用情况由拼板图（人工）核对。
    if (board.processEdgeMm < 5 - EPS) return fail(`工艺边 ${mm(board.processEdgeMm)} 小于 5.00 mm`, { processEdgeMm: board.processEdgeMm });
    return ok({ processEdgeMm: board.processEdgeMm }, `工艺边 ${mm(board.processEdgeMm)} 合规（工艺边内禁布器件需按拼板图核对）`);
  },
  'MECH-11': (ctx) => {
    const marks = ctx.board.fiducials;
    if (!marks) return review('未提供 Mark 光学点清单（需铜层/开窗层/丝印层叠合）');
    const problems = [];
    if (marks.length < 3) problems.push(`数量 ${marks.length} < 3`);
    for (const mark of marks) {
      const dia = toNum(mark.diaMm); const maskDia = toNum(mark.maskDiaMm);
      if (!isNum(dia) || Math.abs(dia - 1.0) > 0.05 + EPS) problems.push(`Ø${dia} 应为 Ø1.00±0.05`);
      if (!isNum(maskDia) || Math.abs(maskDia - 2.0) > 0.1 + EPS) problems.push(`开窗 Ø${maskDia} 应为 Ø2.00`);
    }
    if (marks.length >= 3) {
      const [a, b, c] = marks;
      if ([a, b, c].every((mark) => isNum(toNum(mark.x)) && isNum(toNum(mark.y)))) {
        const area = Math.abs((toNum(b.x) - toNum(a.x)) * (toNum(c.y) - toNum(a.y)) - (toNum(c.x) - toNum(a.x)) * (toNum(b.y) - toNum(a.y))) / 2;
        if (area < 1) problems.push('三点近似共线，需对角布置');
      }
      const pairs = [];
      for (let i = 0; i < marks.length; i += 1) for (let j = i + 1; j < marks.length; j += 1) {
        if ([marks[i], marks[j]].every((mark) => isNum(toNum(mark.x)) && isNum(toNum(mark.y)))) {
          pairs.push(Math.hypot(toNum(marks[i].x) - toNum(marks[j].x), toNum(marks[i].y) - toNum(marks[j].y)));
        }
      }
      if (pairs.length && Math.max(...pairs) < 30 - EPS) problems.push(`对角间距 ${mm(Math.max(...pairs))} < 30.00 mm`);
    }
    if (problems.length) return fail(`Mark 不合格：${problems.join('；')}`, { problems });
    return ok({ count: marks.length }, `Mark ${marks.length} 个，尺寸与布置合规`);
  },
  'MECH-12': (ctx) => checkToolingHoles(ctx, 'MECH-12'),
  'MECH-13': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const problems = [];
    for (const c of ctx.connectors) {
      const { distance } = nearestEdge(c.body, ctx.board);
      const overhang = Math.max(0, -distance);
      const isUsb = ['USB-C', 'USB-A'].includes(String(c.conn.kind || '').toUpperCase());
      const limit = isUsb ? 0.3 : 0;
      if (overhang > limit + EPS) problems.push(`${c.ref}（${c.conn.kind || '连接器'}）越边 ${mm(overhang)} > ${mm(limit)}`);
      const declared = toNum(c.conn.overhangMm);
      if (isNum(declared) && declared > limit + EPS) problems.push(`${c.ref} 声明越边 ${mm(declared)} > ${mm(limit)}`);
    }
    if (problems.length) return fail(`连接器越边超差：${problems.join('；')}`, { problems });
    return ok({ connectors: ctx.connectors.length }, '连接器越边量合规');
  },
  'MECH-14': (ctx) => {
    const holes = ctx.board.mountingHoles;
    if (!holes) return review('未提供安装孔清单');
    if (holes.length < 2) return fail(`安装孔 ${holes.length} 个，少于 2 个`, { count: holes.length });
    return ok({ count: holes.length }, `安装孔 ${holes.length} 个`);
  },

  // ---------- SPACE ----------
  'SPACE-01': (ctx) => {
    const missing = ctx.components.filter((c) => !c.explicitCourtyard).map((c) => c.ref);
    if (!ctx.components.length) return review('未提供器件清单');
    if (missing.length) return fail(`未显式声明 courtyard 的器件 ${missing.length} 颗：${fmtList(missing)}；引擎只能按默认 0.25 mm 估算`, { missing });
    return ok({ components: ctx.components.length }, '全部器件显式声明 courtyard');
  },
  'SPACE-02': (ctx) => {
    if (!ctx.components.length) return needComponents();
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (let i = 0; i < ctx.components.length; i += 1) for (let j = i + 1; j < ctx.components.length; j += 1) {
      const a = ctx.components[i]; const b = ctx.components[j];
      const overlap = rectOverlap(a.courtyard, b.courtyard);
      if (overlap) violations.push({ a: a.ref, b: b.ref, areaMm2: round(overlap.area, 2), dxMm: round(overlap.dx), dyMm: round(overlap.dy) });
    }
    if (violations.length) {
      const refs = violations.map((v) => `${v.a}↔${v.b}(${v.areaMm2} mm²)`);
      return fail(`courtyard 相交 ${violations.length} 处：${refs.join('，')}`, { violations });
    }
    return ok({ pairsChecked: ctx.components.length * (ctx.components.length - 1) / 2 }, '无 courtyard 相交');
  },
  'SPACE-03': (ctx) => {
    const levels = new Set(ctx.components.map((c) => round(c.courtyardMm, 3)));
    if (!ctx.components.length) return review('未提供器件清单');
    if (levels.size > 1) return fail(`courtyard 外扩值不统一：${[...levels].map((v) => mm(v)).join('、')}`, { levels: [...levels] });
    if (Math.abs([...levels][0] - 0.25) > 0.05 + EPS) return fail(`全板 courtyard 外扩 ${mm([...levels][0])}，不是 Nominal 0.25 mm`, { level: [...levels][0] });
    return ok({ level: 0.25 }, '全板统一 Nominal 0.25 mm');
  },
  'SPACE-04': (ctx) => spacingByClasses(ctx, '0402', '0402', 0.15),
  'SPACE-05': (ctx) => spacingByClasses(ctx, '0402', 'SOT-23', 0.20),
  'SPACE-06': (ctx) => spacingByClasses(ctx, 'SOT-23', 'SOT-23', 0.30),
  'SPACE-07': (ctx) => spacingMatrix(ctx, 'QFN', 0.50),
  'SPACE-08': (ctx) => spacingMatrix(ctx, 'MODULE', 1.0),
  'SPACE-09': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单');
    const violations = [];
    for (const c of ctx.connectors) for (const other of ctx.components) {
      if (other.ref === c.ref) continue;
      const gap = rectGap(c.courtyard, other.courtyard);
      const zif = ['FFC', 'ZIF'].includes(String(c.conn.kind || '').toUpperCase());
      const limit = zif ? 1.5 : 1.0;
      if (gap < limit - EPS) violations.push(`${c.ref}↔${other.ref}=${mm(gap)} < ${mm(limit)}`);
    }
    if (violations.length) return fail(`连接器与器件间距不足：${violations.join('，')}`, { violations });
    return ok({ connectors: ctx.connectors.length }, '连接器与周边器件间距合规');
  },
  'SPACE-10': () => review('需要热源与电解/钽电容清单（热仿真或功耗表）'),
  'SPACE-11': (ctx) => {
    if (!ctx.components.length) return review('未提供器件清单');
    const inductors = ctx.components.filter((c) => c.packageClass === 'INDUCTOR');
    if (!inductors.length) return na('本板无独立电感器件（或未标注 packageClass=INDUCTOR）');
    const violations = [];
    for (const inductor of inductors) for (const other of ctx.components) {
      if (other.ref === inductor.ref) continue;
      const gap = rectGap(inductor.courtyard, other.courtyard);
      if (gap < 2 - EPS) violations.push(`${inductor.ref}↔${other.ref}=${mm(gap)}`);
    }
    if (violations.length) return fail(`电感与其它器件 <2.00 mm：${violations.join('，')}`, { violations });
    return ok({ inductors: inductors.length }, '电感与其它器件 ≥2.00 mm');
  },
  'SPACE-12': (ctx) => {
    const crystals = ctx.components.filter((c) => c.packageClass === 'CRYSTAL');
    if (!crystals.length) return na('本板无独立晶振（或模组内置）');
    const violations = [];
    for (const crystal of crystals) for (const other of ctx.components) {
      if (other.ref === crystal.ref) continue;
      const gap = rectGap(crystal.courtyard, other.courtyard);
      if (gap < 3 - EPS) violations.push(`${crystal.ref}↔${other.ref}=${mm(gap)}`);
    }
    if (violations.length) return fail(`晶振 3.00 mm 内存在器件：${violations.join('，')}`, { violations });
    return ok({ crystals: crystals.length }, '晶振 3.00 mm 内无器件（走线仍需 EDA 复核）');
  },
  'SPACE-13': () => review('需要屏蔽罩框投影（EDA 与结构图）'),
  'SPACE-14': (ctx) => {
    if (!ctx.components.length) return needComponents();
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (let i = 0; i < ctx.components.length; i += 1) for (let j = i + 1; j < ctx.components.length; j += 1) {
      const a = ctx.components[i]; const b = ctx.components[j];
      const gap = rectGap(a.body, b.body);
      const heightDelta = isNum(a.heightMm3d) && isNum(b.heightMm3d) ? Math.abs(a.heightMm3d - b.heightMm3d) : null;
      const limit = heightDelta !== null && heightDelta >= 2 ? 0.5 : 0.3;
      if (gap < limit - EPS) violations.push(`${a.ref}↔${b.ref}=${mm(gap)} < ${mm(limit)}${heightDelta !== null && heightDelta >= 2 ? '（相邻高度差 ≥2 mm）' : ''}`);
    }
    if (violations.length) return fail(`吸嘴空间不足：${violations.join('，')}`, { violations });
    return ok({ pairs: ctx.components.length * (ctx.components.length - 1) / 2 }, '本体间距满足吸嘴空间');
  },
  'SPACE-15': (ctx) => {
    if (!ctx.components.length) return needComponents();
    const heavy = ctx.components.filter((c) => (toNum(c.conn?.massG) ?? 0) > 3 || (isNum(c.heightMm3d) && c.heightMm3d > 5));
    if (!heavy.length) return ok({ heavy: 0 }, '无 >3 g 或 >5 mm 高器件');
    const unhandled = heavy.filter((c) => c.conn?.reinforced !== true).map((c) => c.ref);
    if (unhandled.length) return fail(`大质量/高器件未加固：${fmtList(unhandled)}`, { unhandled });
    return ok({ heavy: heavy.length }, '大质量器件已加固');
  },
  'SPACE-16': (ctx) => {
    if (!ctx.components.length) return needComponents();
    const bad = ctx.components.filter((c) => ![0, 90].includes(c.rotationDeg % 180)).map((c) => `${c.ref}(${c.rotationDeg}°)`);
    if (bad.length) return fail(`存在 180°/270° 摆放：${fmtList(bad)}`, { bad });
    return ok({ components: ctx.components.length }, '角度仅 0°/90°');
  },
  'SPACE-17': () => review('需要极性与阴极方向数据（丝印/封装属性）'),
  'SPACE-18': (ctx) => {
    const needHeight = ctx.components.filter((c) => ['MODULE', 'SHIELD', 'CONNECTOR', 'FFC', 'USB', 'SWITCH', 'INDUCTOR'].includes(c.packageClass));
    if (!needHeight.length) return review('未识别到必须建模高度的器件类别');
    const missing = needHeight.filter((c) => !isNum(c.heightMm3d)).map((c) => c.ref);
    if (missing.length) return fail(`高度包络缺失：${fmtList(missing)}`, { missing });
    return ok({ checked: needHeight.length }, '关键器件高度包络齐全');
  },

  // ---------- CONN ----------
  'CONN-01': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const c of ctx.connectors) {
      const dir = c.conn.openingDir;
      const { edge } = nearestEdge(c.body, ctx.board);
      const outward = EDGE_NORMAL[edge];
      const normality = toNum(c.conn.openingNormalityDeg);
      if (!['+x', '-x', '+y', '-y'].includes(dir)) { violations.push(`${c.ref} 开口方向未声明或非轴向`); continue; }
      if (isNum(normality) && normality > 5 + EPS) violations.push(`${c.ref} 轴线偏离板边法线 ${round(normality)}° > 5°`);
      if (dir !== outward) violations.push(`${c.ref} 开口朝 ${dir}，所在${edge}板边法线为 ${outward}（不垂直/朝板内）`);
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ connectors: ctx.connectors.length }, '全部连接器开口垂直板边并朝外');
  },
  'CONN-02': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const c of ctx.connectors) {
      const depth = Math.max(5, toNum(c.conn.plugClearanceMm) ?? 5);
      const probe = probeRect(c, c.conn.openingDir, depth);
      if (!probe) continue;
      const blockers = blockersIn(probe, ctx.components, c.ref);
      if (blockers.length) violations.push(`${c.ref} 开口前方 ${mm(depth)} 内有：${fmtList(blockers)}`);
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ connectors: ctx.connectors.length }, '开口前方扇区无遮挡');
  },
  'CONN-03': (ctx) => {
    const ffc = ctx.connectors.filter((c) => ['FFC', 'ZIF'].includes(String(c.conn.kind || '').toUpperCase()));
    if (!ffc.length) return na('本板无 FFC/ZIF 连接器');
    const unknown = [];
    const hard = [];
    const soft = [];
    for (const c of ffc) {
      const declared = toNum(c.conn.plugClearanceMm);
      if (!isNum(declared)) { unknown.push(c.ref); continue; }
      if (declared < 5 - EPS) hard.push(`${c.ref}=${mm(declared)}`);
      else if (declared < 8 - EPS) soft.push(`${c.ref}=${mm(declared)}`);
    }
    if (hard.length) return fail(`FFC/ZIF 插线空间 <5.00 mm：${hard.join('，')}`, { hard, soft, unknown });
    if (unknown.length) return review(`未提供 FFC/ZIF 插口前方板外净空：${fmtList(unknown)}`, { unknown });
    if (soft.length) return ok({ soft }, `插线空间达 5.00 mm 下限但未达推荐 8.00 mm：${soft.join('，')}`);
    return ok({ connectors: ffc.length }, 'FFC/ZIF 插线空间 ≥8.00 mm');
  },
  'CONN-04': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const byEdge = groupConnectorsByEdge(ctx);
    const violations = [];
    for (const [edge, list] of byEdge) {
      const sorted = [...list].sort((a, b) => (edge === 'top' || edge === 'bottom' ? a.body.x0 - b.body.x0 : a.body.y0 - b.body.y0));
      for (let i = 1; i < sorted.length; i += 1) {
        const gap = rectGap(sorted[i - 1].courtyard, sorted[i].courtyard);
        if (gap < 3 - EPS) violations.push(`${sorted[i - 1].ref}↔${sorted[i].ref} @${edge} 净距 ${mm(gap)} < 3.00 mm`);
      }
      for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) {
        if (OPPOSITE[sorted[i].conn.openingDir] === sorted[j].conn.openingDir) {
          const gap = rectGap(sorted[i].body, sorted[j].body);
          if (gap < 10 - EPS) violations.push(`${sorted[i].ref}↔${sorted[j].ref} 开口相对，净距 ${mm(gap)} < 10.00 mm`);
        }
      }
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ edges: [...byEdge.keys()] }, '同边净距 ≥3.00 mm，无开口相对');
  },
  'CONN-05': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = ctx.connectors
      .map((c) => ({ ref: c.ref, distance: distanceToCorners(c.courtyard, ctx.board) }))
      .filter((item) => item.distance < 3 - EPS);
    if (violations.length) return fail(`连接器距板角 <3.00 mm：${violations.map((v) => `${v.ref}=${mm(v.distance)}`).join('，')}`, { violations });
    return ok({ connectors: ctx.connectors.length }, '连接器距板角 ≥3.00 mm');
  },
  'CONN-06': (ctx) => {
    const usb = ctx.connectors.filter((c) => ['USB-C', 'USB-A'].includes(String(c.conn.kind || '').toUpperCase()));
    if (!usb.length) return na('本板无 USB 母座');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const c of usb) {
      const rear = probeRect(c, OPPOSITE[c.conn.openingDir], 1.5);
      const blockers = rear ? blockersIn(rear, ctx.components, c.ref) : [];
      if (blockers.length) violations.push(`${c.ref} 后方 1.50 mm 禁布带内有：${fmtList(blockers)}`);
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ usb: usb.length }, 'USB 后方 1.50 mm 禁布带内无器件');
  },
  'CONN-07': (ctx) => {
    const usb = ctx.connectors.filter((c) => ['USB-C', 'USB-A'].includes(String(c.conn.kind || '').toUpperCase()));
    if (!usb.length) return na('本板无 USB 母座');
    const missing = usb.filter((c) => !isNum(toNum(c.conn.plugClearanceMm))).map((c) => c.ref);
    if (missing.length) return review(`USB 插头插入空间为板外空间，需结构/外壳证据；缺：${fmtList(missing)}`);
    const bad = usb.filter((c) => toNum(c.conn.plugClearanceMm) < 10 - EPS).map((c) => `${c.ref}=${mm(toNum(c.conn.plugClearanceMm))}`);
    if (bad.length) return fail(`USB 前方板外净空 <10.00 mm：${bad.join('，')}`, { bad });
    return ok({ usb: usb.length }, 'USB 前方板外净空 ≥10.00 mm');
  },
  'CONN-08': (ctx) => {
    const headers = ctx.connectors.filter((c) => String(c.conn.kind || '').toUpperCase() === 'HEADER');
    if (!headers.length) return na('本板无排针/排母');
    const bad = headers.filter((c) => !isNum(toNum(c.conn.plugClearanceMm)) || toNum(c.conn.plugClearanceMm) < 13.5 - EPS).map((c) => c.ref);
    if (bad.length) return fail(`排针前向净空不足（应 ≥插头长+2.00=13.50 mm）：${fmtList(bad)}`, { bad });
    return ok({ headers: headers.length }, '排针前向净空合规');
  },
  'CONN-09': () => review('需要卡扣式连接器型号与按压方向（JST 类）'),
  'CONN-10': (ctx) => checkDirectionClasses(ctx),
  'CONN-11': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const [edge, list] of groupConnectorsByEdge(ctx)) {
      const directions = new Set(list.map((c) => c.conn.openingDir));
      if (directions.size > 1) violations.push(`${edge} 板边存在 ${directions.size} 种方向：${[...directions].join('/')}（${list.map((c) => c.ref).join('、')}）`);
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ edges: [...groupConnectorsByEdge(ctx).keys()] }, '同一板边内连接器轴线一致');
  },
  'CONN-12': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const c of ctx.connectors) {
      const { edge, distances } = nearestEdge(c.body, ctx.board);
      const dir = c.conn.openingDir;
      const map = { left: distances.left, right: distances.right, top: distances.top, bottom: distances.bottom };
      const inset = map[edge];
      const flush = Math.abs(inset) <= 0.3 + EPS;
      const inward = inset >= 5 - EPS;
      const pointsOutward = dir === EDGE_NORMAL[edge];
      if (!(pointsOutward && (flush || inward))) {
        violations.push(`${c.ref}：开口朝 ${dir}，距${edge}板边 ${mm(inset)}（需 ≥5.00 或齐平且朝外）`);
      }
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ connectors: ctx.connectors.length }, '开口侧板内净空 ≥5.00 mm 或齐平板边');
  },
  'CONN-13': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    if (!ctx.geometryReady) return needGeometry();
    const violations = [];
    for (const [edge, list] of groupConnectorsByEdge(ctx)) {
      const dirs = new Set(list.map((c) => c.conn.openingDir));
      if (dirs.size > 1) violations.push(`${edge} 板边出线方向不一致：${[...dirs].join('/')}`);
      const ffc = list.filter((c) => ['FFC', 'ZIF'].includes(String(c.conn.kind || '').toUpperCase()));
      for (let i = 0; i < ffc.length; i += 1) for (let j = i + 1; j < ffc.length; j += 1) {
        if (ffc[i].conn.openingDir !== ffc[j].conn.openingDir) violations.push(`${ffc[i].ref} 与 ${ffc[j].ref} 两个 FFC 不同向`);
      }
    }
    if (violations.length) return fail(violations.join('；'), { violations });
    return ok({ edges: [...groupConnectorsByEdge(ctx).keys()] }, '同板边同向出线，无需拆板插线');
  },
  'CONN-14': (ctx) => {
    const missing = ctx.connectors.filter((c) => c.conn.cableKeepout !== true).map((c) => c.ref);
    if (!ctx.connectors.length) return review('未提供连接器清单');
    const unknown = missing.filter((ref) => ctx.byRef.get(ref)?.conn?.cableKeepout === undefined);
    const explicit = missing.filter((ref) => ctx.byRef.get(ref)?.conn?.cableKeepout === false);
    if (explicit.length) return fail(`未画线缆禁布区（cable keepout）：${fmtList(explicit)}`, { explicit });
    if (unknown.length) return review(`线缆禁布区状态未提供：${fmtList(unknown)}`);
    return ok({ connectors: ctx.connectors.length }, '全部连接器有线缆禁布区');
  },
  'CONN-15': () => review('需要外壳接地焊盘/过孔数量与释放槽证据'),
  'CONN-16': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    const heavy = ctx.connectors.filter((c) => (toNum(c.conn.massG) ?? 0) > 3);
    if (!heavy.length) return ok({ heavy: 0 }, '无 >3.00 g 连接器');
    const unreinforced = heavy.filter((c) => c.conn.reinforced !== true).map((c) => c.ref);
    if (unreinforced.length) return fail(`>3 g 连接器未加固：${fmtList(unreinforced)}（需螺钉/加强筋/点胶/通孔焊脚）`, { unreinforced });
    return ok({ heavy: heavy.length }, '大质量连接器已加固');
  },
  'CONN-17': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    const unknown = ctx.connectors.filter((c) => c.conn.pin1Marked === undefined).map((c) => c.ref);
    const bad = ctx.connectors.filter((c) => c.conn.pin1Marked === false).map((c) => c.ref);
    if (bad.length) return fail(`缺少 1 脚标识：${fmtList(bad)}`, { bad });
    if (unknown.length) return review(`1 脚标识状态未提供：${fmtList(unknown)}`);
    return ok({ connectors: ctx.connectors.length }, '连接器 1 脚标识齐全');
  },

  // ---------- RF ----------
  'RF-01': (ctx) => {
    const settings = ctx.rf;
    const module = settings?.componentRef ? ctx.byRef.get(String(settings.componentRef)) : ctx.components.find((c) => c.antenna);
    if (!module) return review('未提供天线所在模组（rf.componentRef 或 component.antenna）');
    if (!ctx.geometryReady) return needGeometry();
    const { edge, distance } = nearestEdge(module.body, ctx.board);
    const outward = EDGE_NORMAL[edge];
    const endDir = module.antenna?.endDir;
    const overhang = isNum(toNum(settings?.overhangMm)) ? toNum(settings.overhangMm) : Math.max(0, -distance);
    const detail = { ref: module.ref, edge, outward, endDir, overhangMm: round(overhang) };
    if (!endDir) return review(`未声明天线端朝向（component.antenna.endDir），无法判断是否朝外`, detail);
    if (endDir !== outward) return fail(`天线端朝 ${endDir}，所在${edge}板边法线为 ${outward}（天线朝板内/未朝外）`, detail);
    if (overhang < 2 - EPS) return fail(`天线端伸出板边 ${mm(overhang)} < 2.00 mm`, detail);
    if (overhang > 5 + EPS) return ok(detail, `天线端伸出 ${mm(overhang)}，超出最优区间 2–5 mm（需 RF 复核）`);
    return ok(detail, `天线端朝 ${outward}，伸出板边 ${mm(overhang)}`);
  },
  'RF-02': (ctx) => {
    const module = ctx.rf?.componentRef ? ctx.byRef.get(String(ctx.rf.componentRef)) : ctx.components.find((c) => c.antenna);
    if (!module || !ctx.geometryReady) return review('缺少天线模组或板框，无法计算净空');
    const { distance } = nearestEdge(module.body, ctx.board);
    const overhang = Math.max(0, -distance);
    if (overhang >= 2 - EPS) return na('天线已出边（≥2.00 mm），本条替代方案不适用');
    const declared = toNum(ctx.rf?.antennaToEdgeMm);
    if (!isNum(declared)) return review('天线未出边，且未提供「天线端面到板边 ≥15.00 mm」实测值');
    if (declared < 15 - EPS) return fail(`天线端到板边 ${mm(declared)} < 15.00 mm`, { antennaToEdgeMm: declared });
    return ok({ antennaToEdgeMm: declared }, `天线端到板边 ${mm(declared)} ≥15.00 mm`);
  },
  'RF-03': (ctx) => {
    const settings = ctx.rf;
    const module = settings?.componentRef ? ctx.byRef.get(String(settings.componentRef)) : ctx.components.find((c) => c.antenna);
    if (!module || !ctx.geometryReady) return review('缺少天线模组或板框，无法计算禁布区');
    const keepout = settings?.keepout && ['x0', 'y0', 'x1', 'y1'].every((key) => isNum(toNum(settings.keepout[key]))) ? rectOf(...['x0', 'y0', 'x1', 'y1'].map((key) => toNum(settings.keepout[key]))) : null;
    if (!keepout) return review('未提供天线前向禁布区矩形（rf.keepout）');
    const intruders = blockersIn(keepout, ctx.components, module.ref);
    const metal = Array.isArray(settings?.metalRefs) ? settings.metalRefs : [];
    const detail = { keepout, intruders, metalRefs: metal };
    if (intruders.length || metal.length) return fail(`天线禁布区内有器件/金属：${fmtList([...new Set([...intruders, ...metal])])}`, detail);
    return ok(detail, '天线前向禁布区无器件/金属');
  },
  'RF-04': (ctx) => {
    const value = ctx.rf?.copperInKeepout;
    if (typeof value !== 'boolean') return review('天线区各层禁铜需 Gerber/层叠证据（rf.copperInKeepout 未提供）');
    if (value) return fail('天线区投影内存在铜皮（内层 GND 同样禁）', { copperInKeepout: true });
    return ok({ copperInKeepout: false }, '天线区投影内各层无铜');
  },
  'RF-05': (ctx) => {
    const rf = ctx.rf || {};
    const keys = ['maskOpeningInKeepout', 'silkInKeepout', 'viasInKeepout'];
    const unknown = keys.filter((key) => typeof rf[key] !== 'boolean');
    const bad = keys.filter((key) => rf[key] === true);
    if (bad.length) return fail(`天线区存在工艺开窗/丝印/过孔：${bad.join('、')}`, { bad });
    if (unknown.length) return review(`天线区工艺限制未提供：${unknown.join('、')}`);
    return ok({ checked: keys }, '天线区无开窗/丝印/过孔');
  },
  'RF-06': (ctx) => {
    const ratio = toNum(ctx.rf?.gndViaRatio);
    if (!isNum(ratio)) return review('需要模组 GND 邮票焊盘与对应过孔数量（rf.gndViaRatio）');
    if (ratio < 1 - EPS) return fail(`每 2 个 GND 邮票焊盘仅有 ${round(ratio)} 个过孔（要求 ≥1）`, { gndViaRatio: ratio });
    return ok({ gndViaRatio: ratio }, '模组 GND 邮票孔接地过孔密度合规');
  },
  'RF-07': (ctx) => {
    const pitch = toNum(ctx.rf?.viaFencePitchMm);
    if (!isNum(pitch)) return review('未提供板边 GND 缝合孔间距（rf.viaFencePitchMm）');
    if (pitch > 3 + EPS) return fail(`缝合孔间距 ${mm(pitch)} > 3.00 mm（λg/20 硬门禁取值）`, { viaFencePitchMm: pitch });
    return ok({ viaFencePitchMm: pitch }, `缝合孔间距 ${mm(pitch)} ≤3.00 mm`);
  },
  'RF-08': (ctx) => {
    const metal = ctx.rf?.metalRefs;
    if (!Array.isArray(metal)) return review('未提供模组 5.00 mm 内的金属件清单（螺柱/支架/屏蔽罩）');
    if (metal.length) return fail(`模组 5.00 mm 内有金属件：${fmtList(metal)}`, { metalRefs: metal });
    return ok({ metalRefs: [] }, '模组 5.00 mm 内无金属件');
  },
  'RF-09': () => review('需要 π 匹配网络位号与馈线长度/阻抗（EDA + 仿真）'),
  'RF-10': () => review('需要整机与认证结构证据（电池/金属外壳覆盖）'),
  'RF-11': (ctx) => {
    const coverage = toNum(ctx.rf?.gndCoveragePercent);
    if (!isNum(coverage)) return review('未提供模组下方 GND 覆盖率（rf.gndCoveragePercent）');
    if (coverage < 90 - EPS) return fail(`模组下方 GND 覆盖率 ${round(coverage)}% < 90%`, { gndCoveragePercent: coverage });
    return ok({ gndCoveragePercent: coverage }, `GND 覆盖率 ${round(coverage)}%`);
  },
  'RF-12': (ctx) => {
    const near = ctx.rf?.noiseSourcesNearAntenna;
    if (!Array.isArray(near)) return review('未提供天线 15.00 mm 内噪声源清单（开关电源/电感/晶振/时钟）');
    if (near.length) return fail(`天线 15.00 mm 内有噪声源：${fmtList(near)}`, { near });
    return ok({ near: [] }, '天线 15.00 mm 内无噪声源');
  },
  'RF-13': () => review('需要拼板内各单板天线端面距离实测'),

  // ---------- PWR ----------
  'PWR-01': (ctx) => {
    const list = ctx.power?.decoupling;
    if (!Array.isArray(list) || !list.length) return review('未提供去耦电容与被去耦电源脚的配对距离（power.decoupling）');
    const violations = [];
    for (const entry of list) {
      const distance = toNum(entry.distanceMm);
      const icClass = String(entry.icClass || '').toUpperCase();
      const limit = icClass === 'MODULE' ? 1.5 : ['QFN', 'BGA'].includes(icClass) ? 1.0 : 2.0;
      if (!isNum(distance)) { violations.push(`${entry.capRef || '?'} 距离未知`); continue; }
      if (distance > limit + EPS) violations.push(`${entry.capRef || '?'} 距 ${entry.icRef || '电源脚'} ${mm(distance)} > ${mm(limit)}`);
    }
    if (violations.length) return fail(`去耦超距：${violations.join('，')}`, { violations });
    return ok({ pairs: list.length }, `去耦距离全部合规（共 ${list.length} 对）`);
  },
  'PWR-02': () => review('需要回路面积与 GND 过孔位置（EDA 铜皮量测）'),
  'PWR-03': () => review('需要网表与逐脚电容清单'),
  'PWR-04': () => review('需要 GND 过孔数量与位置'),
  'PWR-05': (ctx) => {
    const nets = ctx.power?.nets;
    if (!Array.isArray(nets) || !nets.length) return review('未提供载流网络（power.nets）');
    const violations = []; const checked = [];
    for (const net of nets) {
      const currentA = toNum(net.currentA); const widthMm = toNum(net.widthMm);
      if (!isNum(currentA) || !isNum(widthMm)) { violations.push(`${net.net || '?'} 缺少电流或线宽`); continue; }
      const required = requiredTraceWidthMm(currentA, net.layer === 'inner' ? 'inner' : 'outer');
      const withMargin = Math.ceil((required * 1.2) / 0.05) * 0.05;
      checked.push({ net: net.net, currentA, requiredMm: round(required), requiredWithMarginMm: round(withMargin), actualMm: round(widthMm) });
      if (widthMm < withMargin - EPS) violations.push(`${net.net} ${round(currentA)}A 需 ≥${mm(withMargin)}，实测 ${mm(widthMm)}`);
    }
    if (violations.length) return fail(`载流线宽不足：${violations.join('，')}`, { checked });
    return ok({ checked }, '载流线宽（含 1.2 倍余量）合规');
  },
  'PWR-06': (ctx) => {
    const planes = ctx.power?.planes;
    if (!Array.isArray(planes) || !planes.length) return review('未提供大电流铺铜/平面数据（power.planes）');
    const bad = planes.filter((plane) => toNum(plane.narrowestMm) !== null && toNum(plane.requiredMm) !== null && toNum(plane.narrowestMm) < toNum(plane.requiredMm) * 1.2 - EPS);
    if (bad.length) return fail(`大电流铺铜最窄处不足：${bad.map((p) => p.net).join('、')}`, { bad });
    return ok({ planes: planes.length }, '大电流路径使用铺铜且宽度合规');
  },
  'PWR-07': () => review('需要开关电源热环路面积实测（铜皮量测）'),
  'PWR-08': () => review('需要电感/SW 节点投影与铜皮数据'),
  'PWR-09': () => review('需要散热过孔阵列数据'),
  'PWR-10': () => review('需要功耗与散热铜箔面积'),
  'PWR-11': (ctx) => {
    const paths = ctx.power?.paths;
    if (!Array.isArray(paths) || !paths.length) return review('未提供大电流路径设计余量（power.paths）');
    const violations = [];
    for (const path of paths) {
      const peak = toNum(path.peakCurrentA); const designed = toNum(path.designedForA);
      if (!isNum(peak) || !isNum(designed)) { violations.push(`${path.net || '?'} 缺少峰值/设计电流`); continue; }
      if (designed < peak * 1.5 - EPS) violations.push(`${path.net || '?'} 仅按 ${round(designed)}A 设计，峰值 ${round(peak)}A 需 ×1.5=${round(peak * 1.5)}A`);
    }
    if (violations.length) return fail(`大电流路径余量不足：${violations.join('，')}`, { violations });
    return ok({ paths: paths.length }, '大电流路径按 1.5× 峰值设计');
  },
  'PWR-12': () => review('需要电源入口保护链路顺序（原理图）'),
  'PWR-13': () => review('需要 EN/BOOT 网络与按键距离（网表 + 布局）'),

  // ---------- SILK ----------
  'SILK-01': (ctx) => {
    const heights = (ctx.silk?.textHeights || []).map(toNum).filter(isNum);
    if (!heights.length) return review('未提供丝印字高实测值');
    const small = heights.filter((value) => value < 0.8 - EPS);
    if (small.length) return fail(`字高 ${mm(Math.min(...small))} < 0.80 mm`, { minHeightMm: Math.min(...heights) });
    const standard = heights.filter((value) => Math.abs(value - 1.0) <= 0.1);
    return ok({ minHeightMm: Math.min(...heights), standardRatio: round(standard.length / heights.length, 2) }, `字高最小 ${mm(Math.min(...heights))}`);
  },
  'SILK-02': () => review('需要丝印线宽数据（EDA 文本属性）'),
  'SILK-03': (ctx) => {
    const gap = toNum(ctx.silk?.minCharGapMm);
    if (!isNum(gap)) return review('未提供最小字符间隙实测值');
    if (gap < 0.15 - EPS) return fail(`最小字符间隙 ${mm(gap)} < 0.15 mm（会粘连）`, { minCharGapMm: gap });
    return ok({ minCharGapMm: gap }, `最小字符间隙 ${mm(gap)}`);
  },
  'SILK-04': (ctx) => {
    const items = ctx.silk?.items || [];
    if (!items.length) return review('未提供丝印到焊盘间距清单');
    const bad = items.filter((item) => isNum(toNum(item.gapToPadMm)) && toNum(item.gapToPadMm) < 0.15 - EPS).map((item) => `${item.ref}=${mm(toNum(item.gapToPadMm))}`);
    if (bad.length) return fail(`丝印到焊盘 <0.15 mm：${bad.join('，')}`, { bad });
    return ok({ items: items.length }, '丝印到焊盘间距 ≥0.15 mm');
  },
  'SILK-05': (ctx) => {
    const count = toNum(ctx.silk?.overlappingPadCount);
    const items = Array.isArray(ctx.silk?.items) ? ctx.silk.items.filter((item) => Array.isArray(item.onPadRefs) && item.onPadRefs.length) : [];
    if (!isNum(count) && !Array.isArray(ctx.silk?.items)) return review('未提供丝印压焊盘检查结果（需开窗层叠合）');
    const refs = items.map((item) => `${item.ref}→${item.onPadRefs.join('/')}`);
    const total = isNum(count) ? count : items.length;
    if (total > 0) return fail(`丝印与焊盘重叠 ${total} 处：${fmtList(refs)}（CAM 会裁掉，位号将消失）`, { count: total, refs });
    return ok({ count: 0 }, '丝印与焊盘重叠 = 0');
  },
  'SILK-06': () => review('需要位号摆放角度统计'),
  'SILK-07': () => review('需要丝印与 courtyard 层叠合'),
  'SILK-08': () => review('需要密集区丝印排布检查'),
  'SILK-09': () => review('需要 IC 1 脚标识（丝印/封装）'),
  'SILK-10': () => review('需要二极管阴极标识'),
  'SILK-11': () => review('需要连接器 1 脚与插入方向标识'),
  'SILK-12': () => review('需要功能名称丝印清单'),
  'SILK-13': (ctx) => {
    const items = ctx.silk?.items || [];
    const runsOff = ctx.silk?.runsOffBoard === true || items.some((item) => item.outsideBoard === true);
    if (!items.length && ctx.silk?.runsOffBoard === undefined) return review('未提供丝印越板边检查结果');
    if (runsOff) return fail('丝印越出板边（会被铣切/裁掉）', { runsOffBoard: true });
    return ok({}, '丝印未越板边');
  },
  'SILK-14': (ctx) => {
    const stray = toNum(ctx.silk?.strayLineCount);
    if (!isNum(stray)) return review('未提供无意义丝印线数量');
    if (stray > 0) return fail(`存在 ${stray} 条无意义丝印线（非封装/非功能性标线）`, { strayLineCount: stray });
    return ok({ strayLineCount: 0 }, '无无意义丝印线');
  },
  'SILK-15': () => review('需要 courtyard 层归属检查（courtyard 不得画在丝印层）'),
  'SILK-16': () => review('需要板边/V-CUT 处丝印裁切检查'),

  // ---------- DFM ----------
  'DFM-01': (ctx) => {
    const m = toNum(ctx.input.dfm?.minTrackWidthMm); const s = toNum(ctx.input.dfm?.minClearanceMm);
    if (!isNum(m) || !isNum(s)) return review('未提供最小线宽/线距实测值（需 DRC 报告）');
    if (m < 0.1 - EPS || s < 0.1 - EPS) return fail(`线宽 ${mm(m)} / 线距 ${mm(s)} 低于 0.10 mm 能力下限`, { minTrackWidthMm: m, minClearanceMm: s });
    return ok({ minTrackWidthMm: m, minClearanceMm: s }, '线宽/线距 ≥0.10 mm');
  },
  'DFM-02': () => review('需要过孔环宽/孔径 DRC 报告'),
  'DFM-03': () => review('需要阻焊桥宽度数据'),
  'DFM-04': () => review('需要过孔盖油/塞孔工艺单'),
  'DFM-05': () => review('需要 QFN 钢网与 paste 数据'),
  'DFM-06': () => review('需要封装 1:1 与实物核对记录'),
  'DFM-07': () => review('需要双面贴装与二次回流工艺确认'),
  'DFM-08': (ctx) => {
    if (ctx.board.panelized === null) return review('未声明是否拼板（panelized）');
    if (ctx.board.panelized === false) return fail('未拼板：缺工艺边与拼板图，贴片/分板无法保证', { panelized: false });
    return ok({ panelized: true, processEdgeMm: ctx.board.processEdgeMm ?? null }, '已拼板');
  },
  'DFM-09': (ctx) => {
    const defined = ctx.evidence?.highSpeedImpedance?.defined;
    if (defined !== true) return review('USB 差分/RF 馈线阻抗未定义（需叠层计算书与测试条）');
    return ok({ defined: true }, '阻抗已定义并计算');
  },
  'DFM-10': () => review('需要表面处理工艺单'),
  'DFM-11': () => review('需要叠层表与板厚结构'),
  'DFM-12': () => review('需要翘曲控制与板厂能力确认'),
  'DFM-13': () => review('需要焊盘一致性比对（库 vs 实物）'),
  'DFM-14': () => review('需要 paste 完整性与开窗检查'),
  'DFM-15': (ctx) => {
    const marks = ctx.board.fiducials;
    if (!marks) return review('未提供 Mark 清单（同 MECH-11）');
    if (marks.length < 3) return fail(`Mark ${marks.length} 个 < 3`, { count: marks.length });
    return ok({ count: marks.length }, 'Mark 数量满足贴片定位');
  },
  'DFM-16': () => review('需要 DFM 清单闭环记录'),

  // ---------- DFA ----------
  'DFA-01': () => review('需要返修空间与热风可达性评审'),
  'DFA-02': () => review('需要热风喷嘴可达性评审'),
  'DFA-03': () => review('需要连接器插头与开口尺寸（同 CONN-03/07）'),
  'DFA-04': (ctx) => {
    const list = ctx.switches;
    if (!Array.isArray(list) || !list.length) return review('未提供按键清单与操作空间（switches）');
    const bad = list.filter((item) => !isNum(toNum(item.clearanceMm)) || toNum(item.clearanceMm) < 8 - EPS).map((item) => `${item.ref}=${item.clearanceMm ?? '?'}`);
    if (bad.length) return fail(`按键 Ø8.00 操作区内有高元件/遮挡：${bad.join('，')}`, { bad });
    return ok({ switches: list.length }, '按键操作空间 ≥Ø8.00 mm');
  },
  'DFA-05': (ctx) => {
    const points = ctx.testPoints;
    if (!points) return review('未提供测试点清单（testPoints）');
    if (!points.length) return fail('板上没有任何测试点', { count: 0 });
    const bad = points.filter((point) => (toNum(point.diaMm) ?? 0) < 1 - EPS).map((point) => point.ref);
    if (bad.length) return fail(`测试点直径 <Ø1.00 mm：${fmtList(bad)}`, { bad });
    return ok({ count: points.length }, `测试点 ${points.length} 个，直径 ≥Ø1.00 mm`);
  },
  'DFA-06': (ctx) => {
    const points = ctx.testPoints;
    const required = ctx.input.requiredNets;
    if (!points) return review('未提供测试点清单');
    if (!Array.isArray(required) || !required.length) return review('未提供必测网络清单（requiredNets），无法判定覆盖率');
    const nets = new Set(points.map((point) => String(point.net || '').toUpperCase()));
    const missing = required.filter((net) => !nets.has(String(net).toUpperCase()));
    if (missing.length) return fail(`缺少必测网络测试点：${fmtList(missing)}`, { missing });
    return ok({ required: required.length }, `必测网络 ${required.length} 个全覆盖`);
  },
  'DFA-07': (ctx) => checkToolingHoles(ctx, 'DFA-07'),
  'DFA-08': () => review('需要治具压接面与避让区评审'),
  'DFA-09': () => review('需要 ESD/TVS 与接口距离（网表 + 布局）'),
  'DFA-10': () => review('需要测试探针垂直空间与高件遮挡检查'),
  'DFA-11': (ctx) => checkDirectionClasses(ctx),
  'DFA-12': () => review('需要装配顺序与防错评审'),
  'DFA-13': (ctx) => {
    if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
    const heavy = ctx.connectors.filter((c) => (toNum(c.conn.massG) ?? 0) > 3);
    const bad = heavy.filter((c) => c.conn.reinforced !== true).map((c) => c.ref);
    if (bad.length) return fail(`插拔类连接器无机械支撑：${fmtList(bad)}`, { bad });
    return ok({ heavy: heavy.length }, '插拔类连接器均有机械支撑');
  },
};

// ---- 通用检查实现 ----
/** 出线/插拔方向类别：目标 ≤2 类；本板受板框限制可降级为 3 类，但必须带 ECO 记录。 */
function checkDirectionClasses(ctx) {
  if (!ctx.connectors.length) return review('未提供连接器清单（conn 字段）');
  const classes = new Set(ctx.connectors.map((c) => c.conn.openingDir).filter((dir) => ['+x', '-x', '+y', '-y'].includes(dir)));
  const limitRaw = toNum(ctx.input.directionClassLimit);
  const limit = isNum(limitRaw) && limitRaw >= 1 ? limitRaw : 2;
  const degraded = ctx.input.directionClassDegradationApproved === true;
  const detail = { classes: [...classes], classCount: classes.size, limit, degraded };
  if (classes.size > limit) {
    if (classes.size === 3 && limit === 2 && degraded) {
      return ok(detail, `方向类别 ${classes.size} 类（${[...classes].join('/')}），已按 ECO 记录降级（达标线 ≤2 类）`);
    }
    return fail(`方向类别 ${classes.size} 类（${[...classes].join('/')}）超过上限 ${limit} 类；若因板框受限，须在 ECO 里书面记录降级并置 directionClassDegradationApproved=true`, detail);
  }
  return ok(detail, `方向类别 ${classes.size} 类 ≤ ${limit}`);
}

function groupConnectorsByEdge(ctx) {
  const groups = new Map();
  for (const c of ctx.connectors) {
    const { edge } = nearestEdge(c.body, ctx.board);
    if (!groups.has(edge)) groups.set(edge, []);
    groups.get(edge).push(c);
  }
  return groups;
}
function spacingByClasses(ctx, classA, classB, limitMm) {
  if (!ctx.components.length) return review('未提供器件清单');
  const a = ctx.components.filter((c) => c.packageClass === classA);
  const b = ctx.components.filter((c) => c.packageClass === classB);
  if (!a.length || !b.length) return na(`本板无 ${classA}↔${classB} 组合（packageClass 未标注时视为不适用）`);
  const violations = [];
  for (const x of a) for (const y of b) {
    if (x.ref === y.ref) continue;
    const gap = rectGap(x.courtyard, y.courtyard);
    if (gap < limitMm - EPS) violations.push(`${x.ref}↔${y.ref}=${mm(gap)}`);
  }
  if (violations.length) return fail(`${classA}↔${classB} 间距 <${mm(limitMm)}：${violations.join('，')}`, { violations });
  return ok({ pairs: a.length * b.length }, `${classA}↔${classB} 间距 ≥${mm(limitMm)}`);
}
function spacingMatrix(ctx, classA, limitMm) {
  if (!ctx.components.length) return review('未提供器件清单');
  const a = ctx.components.filter((c) => c.packageClass === classA);
  if (!a.length) return na(`本板无 ${classA} 器件（packageClass 未标注时视为不适用）`);
  const violations = [];
  for (const x of a) for (const y of ctx.components) {
    if (x.ref === y.ref) continue;
    const gap = rectGap(x.courtyard, y.courtyard);
    if (gap < limitMm - EPS) violations.push(`${x.ref}↔${y.ref}=${mm(gap)}`);
  }
  if (violations.length) return fail(`${classA} 与其它器件间距 <${mm(limitMm)}：${violations.join('，')}`, { violations });
  return ok({ pairs: a.length * (ctx.components.length - 1) }, `${classA} 间距 ≥${mm(limitMm)}`);
}
function checkToolingHoles(ctx, ruleId) {
  const holes = ctx.board.toolingHoles;
  const label = ruleId === 'DFA-07' ? '治具定位孔' : '定位孔';
  if (!holes) return review(`未提供${label}清单`);
  const problems = [];
  if (holes.length < 2) problems.push(`数量 ${holes.length} < 2`);
  for (const hole of holes) {
    const dia = toNum(hole.diaMm);
    if (!isNum(dia) || Math.abs(dia - 3.2) > 0.05 + EPS) problems.push(`Ø${dia} 应为 Ø3.20±0.05`);
    if (ctx.geometryReady && isNum(toNum(hole.x)) && isNum(toNum(hole.y))) {
      const x = toNum(hole.x); const y = toNum(hole.y);
      const outside = x < 0 || y < 0 || x > ctx.board.widthMm || y > ctx.board.heightMm;
      if (outside) {
        // 板外孔只允许落在工艺边上（单板没有空角时，定位孔只能放在拼板工艺边）
        const offX = x < 0 ? -x : x > ctx.board.widthMm ? x - ctx.board.widthMm : 0;
        const offY = y < 0 ? -y : y > ctx.board.heightMm ? y - ctx.board.heightMm : 0;
        const off = Math.max(offX, offY);
        if (!(ctx.board.processEdgeMm >= 5 && off <= ctx.board.processEdgeMm)) {
          problems.push(`孔在板外 ${mm(off)}，但工艺边不足 ${mm(ctx.board.processEdgeMm ?? 0)}（需 ≥5.00 mm）`);
        }
      } else {
        const distance = Math.min(x, y, ctx.board.widthMm - x, ctx.board.heightMm - y);
        if (distance < 3 - EPS) problems.push(`孔距板边 ${mm(distance)} < 3.00 mm`);
        const keepout = rectOf(x - 3, y - 3, x + 3, y + 3);
        const intruders = blockersIn(keepout, ctx.components, null);
        if (intruders.length) problems.push(`孔周 Ø6.00 禁布区内有器件：${fmtList(intruders)}`);
      }
    }
  }
  if (problems.length) return fail(`${label}不合格：${problems.join('；')}`, { problems });
  return ok({ count: holes.length }, `${label} ${holes.length} 个合规`);
}
/** IPC-2221B 载流：A[mil²] = (I/(k·ΔT^0.44))^(1/0.725)，1 oz = 1.37 mil */
export function requiredTraceWidthMm(currentA, layer = 'outer', deltaTC = 10) {
  const k = layer === 'inner' ? 0.024 : 0.048;
  const areaMil2 = (currentA / (k * deltaTC ** 0.44)) ** (1 / 0.725);
  return (areaMil2 / 1.37) * 0.0254;
}

// ---------------------------------------------------------------------------
// 4. 门禁：GATE-01..07 由其它规则状态 + 外部证据聚合，不独立臆造
// ---------------------------------------------------------------------------
function evaluateGates(ctx, statusOf) {
  const evidence = ctx.evidence || {};
  const evidenceGate = (id, key, label) => {
    const record = evidence[key];
    if (!record || typeof record !== 'object') return { id, status: STATUS.REVIEW, message: `${label}未执行/未提供证据（evidence.${key}）`, evidence: null };
    if (record.passed === true) return { id, status: STATUS.PASS, message: `${label}已通过`, evidence: record };
    if (record.passed === false) return { id, status: STATUS.FAIL, message: `${label}未通过`, evidence: record };
    return { id, status: STATUS.REVIEW, message: `${label}证据不完整`, evidence: record };
  };
  const gates = [];
  // GATE-01：3D 干涉，先看几何规则，再看整机 STEP 证据
  const interferenceRules = ['SPACE-02', 'SPACE-07', 'SPACE-08', 'SPACE-09', 'SPACE-18', 'MECH-05'];
  const failedInterference = interferenceRules.filter((id) => statusOf(id) === STATUS.FAIL);
  const reviewInterference = interferenceRules.filter((id) => statusOf(id) === STATUS.REVIEW);
  const step3d = evidence.step3d;
  let gate01;
  if (step3d?.passed === false) gate01 = { id: 'GATE-01', status: STATUS.FAIL, message: '整机 STEP 3D 干涉未清零', evidence: step3d };
  else if (failedInterference.length) gate01 = { id: 'GATE-01', status: STATUS.FAIL, message: `布局几何干涉未清零（${failedInterference.join('、')}）`, evidence: { failedInterference } };
  else if (step3d?.passed === true && !reviewInterference.length) gate01 = { id: 'GATE-01', status: STATUS.PASS, message: '3D 干涉检查通过', evidence: step3d };
  else gate01 = { id: 'GATE-01', status: STATUS.REVIEW, message: `3D 干涉证据不足${reviewInterference.length ? `（${reviewInterference.join('、')} 待复核）` : ''}`, evidence: { step3d: step3d ?? null, reviewInterference } };
  gates.push(gate01);
  gates.push(evidenceGate('GATE-02', 'officialDrc', '官方 DRC 门禁'));
  gates.push(evidenceGate('GATE-03', 'dfm', '板厂 DFM 门禁'));
  gates.push(evidenceGate('GATE-04', 'dfa', 'DFA 装配评审门禁'));
  gates.push(evidenceGate('GATE-05', 'fai', '首件 FAI 门禁'));
  const eco = evidence.eco;
  gates.push(eco?.lastChangeId
    ? { id: 'GATE-06', status: STATUS.PASS, message: `ECO 变更单 ${eco.lastChangeId} 已记录`, evidence: eco }
    : { id: 'GATE-06', status: STATUS.REVIEW, message: '未提供 ECO 变更记录（用 evidence.eco.lastChangeId）', evidence: null });
  const gateStatus = (id) => gates.find((gate) => gate.id === id)?.status || STATUS.REVIEW;
  // GATE-07：8 条不可投产红线
  const redLines = [
    { key: '3D 干涉未清零', hit: gate01.status === STATUS.FAIL },
    { key: '丝印压焊盘未清零', hit: statusOf('SILK-05') === STATUS.FAIL },
    { key: '去耦电容超距', hit: statusOf('PWR-01') === STATUS.FAIL },
    { key: 'RF 天线禁布区被金属侵占', hit: statusOf('RF-03') === STATUS.FAIL || statusOf('RF-04') === STATUS.FAIL },
    { key: '拼板/工艺边缺失', hit: statusOf('MECH-10') === STATUS.FAIL },
    { key: '无 Mark 与定位孔', hit: statusOf('MECH-11') === STATUS.FAIL || statusOf('MECH-12') === STATUS.FAIL },
    { key: 'USB 差分阻抗未定义', hit: statusOf('DFM-09') === STATUS.REVIEW ? null : statusOf('DFM-09') === STATUS.FAIL },
    { key: '首件 FAI 未通过', hit: evidence.fai?.passed === true ? false : evidence.fai?.passed === false ? true : null },
  ];
  const hardHits = redLines.filter((item) => item.hit === true).map((item) => item.key);
  const unknown = redLines.filter((item) => item.hit === null).map((item) => item.key);
  const gate07 = hardHits.length
    ? { id: 'GATE-07', status: STATUS.FAIL, message: `不可投产红线命中 ${hardHits.length} 条：${hardHits.join('、')}`, evidence: { hardHits, unknown } }
    : (unknown.length
      ? { id: 'GATE-07', status: STATUS.REVIEW, message: `红线未闭合：${unknown.join('、')}`, evidence: { unknown } }
      : { id: 'GATE-07', status: STATUS.PASS, message: '8 条红线全部清除', evidence: {} });
  gates.push(gate07);
  return { gates, redLines };
}

// ---------------------------------------------------------------------------
// 5. 主入口
// ---------------------------------------------------------------------------
/** 规则分组 → 覆盖它的门禁（用于给 REVIEW 规则标注"由谁签字覆盖"）。 */
const GROUP_GATE_COVER = {
  MECH: ['GATE-01', 'GATE-02'], SPACE: ['GATE-01', 'GATE-02'], CONN: ['GATE-01', 'GATE-04'],
  RF: ['GATE-01', 'GATE-02'], PWR: ['GATE-02'], SILK: ['GATE-02'], DFM: ['GATE-03'], DFA: ['GATE-04'], GATE: [],
};

const REQUIRE_HINTS = {
  MECH: '需要 EDA 板框/机械层/Gerber 或结构图',
  SPACE: '需要 courtyard 属性、3D 高度表与封装库',
  CONN: '需要在连接器上标注 kind/openingDir/插拔净空/线缆 keepout',
  RF: '需要天线禁布区几何、层叠/铜皮数据与仿真证据',
  PWR: '需要网表、电源脚与去耦配对、铜皮量测',
  SILK: '需要丝印层与开窗层叠合检查结果',
  DFM: '需要 Gerber、钻孔、叠层、阻抗计算书与板厂 DFM 报告',
  DFA: '需要 1:1 装配评审、测试点与治具方案',
  GATE: '需要对应门禁的签核证据（evidence.*）',
};

export function evaluateLayoutRules(input = {}) {
  const pack = layoutRulePack();
  const ctx = normalizeContext(input);
  const statusOfMap = new Map();
  const rules = pack.rules.map((rule) => {
    if (rule.group === 'GATE') return { rule, result: null };
    const checker = CHECKERS[rule.id];
    let result;
    try {
      result = checker ? checker(ctx) : review(`未注册自动检查器；${REQUIRE_HINTS[rule.group] || '需要人工复核'}`);
    } catch (error) {
      result = review(`检查器执行异常：${error.message}`);
    }
    return { rule, result };
  });
  // GATE 依赖其它规则状态，先算出非门禁规则的状态
  for (const item of rules) {
    if (item.rule.group === 'GATE') continue;
    statusOfMap.set(item.rule.id, item.result.status);
  }
  const { gates, redLines } = evaluateGates(ctx, (id) => statusOfMap.get(id));
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  const finalRules = rules.map(({ rule, result }) => {
    const resolved = rule.group === 'GATE'
      ? (() => {
        const gate = gateById.get(rule.id);
        if (!gate) return { status: STATUS.REVIEW, message: '门禁状态未计算', evidence: null };
        return { status: gate.status, message: gate.message, evidence: gate.evidence };
      })()
      : result;
    // REVIEW 规则如实保留"本引擎未验证"，但标注它由哪个门禁的外部签字证据覆盖，
    // 这样 releaseReady 可以基于门禁判定，又不会把 REVIEW 洗成 PASS。
    const coveredBy = resolved.status === STATUS.REVIEW
      ? (GROUP_GATE_COVER[rule.group] || []).filter((gateId) => gateById.get(gateId)?.status === STATUS.PASS)
      : [];
    return {
      id: rule.id, group: rule.group, groupName: rule.groupName, level: rule.level, name: rule.name,
      value: rule.value, basis: rule.basis, status: resolved.status, message: resolved.message || '',
      evidence: resolved.evidence ?? null, coveredBy,
    };
  });
  const findings = finalRules
    .filter((rule) => rule.status === STATUS.FAIL)
    .map((rule) => finding(
      `LAYOUT_RULE_${rule.id.replace('-', '_')}`,
      `${rule.id} ${rule.name}：${rule.message}`,
      `layoutRules.${rule.id}`,
      rule.level === '硬门禁' ? 'blocking' : 'warning',
    ));
  const summary = summarize(finalRules);
  const gatesSummary = Object.fromEntries(gates.map((gate) => [gate.id, gate.status]));
  const auditCore = {
    kind: 'pcba-layout-rule-audit', schemaVersion: 1,
    packVersion: pack.version, packHash: pack.hash,
    board: { widthMm: ctx.board.widthMm, heightMm: ctx.board.heightMm, thicknessMm: ctx.board.thicknessMm },
    rules: finalRules, gates, gatesSummary, redLines, summary, findings,
    passed: summary.blockingFailures === 0,
    // 放行判据是门禁：GATE-01..07 全 PASS 且无硬门禁 FAIL。
    // 单条 REVIEW 不等于 PASS，但若其对应门禁已有签字证据（如 GATE-02 官方 DRC），
    // 则该规则由外部检查覆盖（会在 coveredBy 里写明），引擎自身仍不宣称已验证。
    releaseReady: summary.blockingFailures === 0 && gates.every((gate) => gate.status === STATUS.PASS),
    uncoveredReviews: finalRules.filter((rule) => rule.status === STATUS.REVIEW && !rule.coveredBy.length).length,
    humanReviewRequired: true,
    officialDrcRequired: true,
    policy: 'REVIEW 不等于 PASS：缺少证据的规则必须在 EDA / 板厂 / 网表 / 3D 环境闭合；门禁 PASS 只代表对应外部证据已签字',
  };
  return { ...auditCore, auditHash: sha256(JSON.stringify(auditCore)) };
}

function summarize(rules) {
  const byGroup = {};
  for (const rule of rules) {
    const bucket = (byGroup[rule.group] ||= { PASS: 0, FAIL: 0, REVIEW: 0, NA: 0, total: 0 });
    bucket[rule.status] += 1; bucket.total += 1;
  }
  const count = (status) => rules.filter((rule) => rule.status === status).length;
  return {
    total: rules.length,
    PASS: count(STATUS.PASS), FAIL: count(STATUS.FAIL), REVIEW: count(STATUS.REVIEW), NA: count(STATUS.NA),
    blockingFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level === '硬门禁').length,
    warningFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level !== '硬门禁').length,
    byGroup,
  };
}
