/**
 * Skill 约束补充规则（SKL pack）：把 EASY EDA agent skill 里可判定的工作流/几何不变量
 * 落成只读审计规则。数据来源是 `easyeda pcb check` / `layout-lint` / `zones` 的语义
 * （见 docs/design/eda-skill-constraints.md），不复制其 CLI/端口实现。
 *
 * 覆盖：zone claim/九宫格、layout-lint（手焊通道、no-access）、keepout/no-pours 双层、
 *      晶振禁铺、两轮自检、差分对/等长先声明后测量、丝印镜像、net-class 一致性。
 *
 * 语义：PASS / FAIL / REVIEW / NA；REVIEW 不等于 PASS，缺数据不猜。
 * 全部只读：不写 EDA 配置，不替代 pcb check / DRC / 板厂 DFM。
 */
import crypto from 'node:crypto';
import { finding } from './stackup.mjs';

export const SKILL_RULE_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NA: 'NA' });
const STATUS = SKILL_RULE_STATUS;
const EPS = 1e-9;
const ACCESS_CHANNEL_MIL_DEFAULT = 60;
const MULTI_LAYER = 12;
const REGION_RULE = Object.freeze({ NO_COMPONENTS: 2, NO_WIRES: 5, NO_FILLS: 6, NO_POURS: 7, NO_INNER_ELECTRICAL_LAYERS: 8, FOLLOW_REGION_RULE: 9 });
const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const toNum = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.trim().match(/-?[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[1]) : null;
};
const mm = (value) => `${round(value)} mm`;
const ok = (evidence, message) => ({ status: STATUS.PASS, evidence, message });
const fail = (message, evidence) => ({ status: STATUS.FAIL, message, evidence });
const review = (message, evidence) => ({ status: STATUS.REVIEW, message, evidence });
const na = (message) => ({ status: STATUS.NA, message });
const list = (value) => (Array.isArray(value) ? value : null);

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------
function boundsRect(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x0 = toNum(bounds.minXMm); const y0 = toNum(bounds.minYMm);
  const x1 = toNum(bounds.maxXMm); const y1 = toNum(bounds.maxYMm);
  if ([x0, y0, x1, y1].some((value) => value === null)) return null;
  if (x1 < x0 || y1 < y0) return null;
  return { x0, y0, x1, y1 };
}
function placementRect(placement) {
  if (!placement || typeof placement !== 'object') return null;
  const fromBounds = boundsRect(placement.boundsMm);
  if (fromBounds) return fromBounds;
  const centerX = toNum(placement.centerXMm ?? placement.xMm);
  const centerY = toNum(placement.centerYMm ?? placement.yMm);
  const width = toNum(placement.widthMm);
  const height = toNum(placement.heightMm);
  if (centerX === null || centerY === null || !(width > 0) || !(height > 0)) return null;
  return { x0: centerX - width / 2, y0: centerY - height / 2, x1: centerX + width / 2, y1: centerY + height / 2 };
}
function boardRect(input) {
  const bounds = boundsRect(input?.boundsMm ?? input?.board?.boundsMm);
  if (bounds) return bounds;
  const width = toNum(input?.widthMm ?? input?.board?.widthMm);
  const height = toNum(input?.heightMm ?? input?.board?.heightMm);
  if (!(width > 0) || !(height > 0)) return null;
  const x0 = toNum(input?.originXMm) ?? 0; const y0 = toNum(input?.originYMm) ?? 0;
  return { x0, y0, x1: x0 + width, y1: y0 + height };
}
function inRect(rect, x, y) { return x >= rect.x0 - EPS && x <= rect.x1 + EPS && y >= rect.y0 - EPS && y <= rect.y1 + EPS; }
function rectsOverlap(a, b, margin = 0) {
  return a.x0 - margin < b.x1 && a.x1 + margin > b.x0 && a.y0 - margin < b.y1 && a.y1 + margin > b.y0;
}
function rectContains(outer, inner) {
  return inner.x0 >= outer.x0 - EPS && inner.x1 <= outer.x1 + EPS && inner.y0 >= outer.y0 - EPS && inner.y1 <= outer.y1 + EPS;
}
function rectCenter(rect) { return { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }; }
function overlapsY(a, b) { return a.y0 < b.y1 && a.y1 > b.y0; }
function overlapsX(a, b) { return a.x0 < b.x1 && a.x1 > b.x0; }

/** 九宫格词表：left/center/right × top/bottom，加整列/整行/整板。 */
const ZONE_NAMES = new Set([
  'left-top', 'center-top', 'right-top', 'left-bottom', 'center-bottom', 'right-bottom',
  'left', 'center', 'right', 'top', 'bottom', 'full',
  'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right',
]);
function normalizeZone(zone) {
  const text = String(zone || '').trim().toLowerCase();
  return ZONE_NAMES.has(text) ? text : null;
}
function zoneRect(zone, board) {
  const name = normalizeZone(zone);
  if (!name || !board) return null;
  const width = board.x1 - board.x0; const height = board.y1 - board.y0;
  const thirdW = width / 3; const halfH = height / 2;
  const col = name.includes('left') ? 0 : name.includes('right') ? 2 : 1;
  const row = name.includes('top') ? 1 : name.includes('bottom') ? 0 : -1;
  const x0 = board.x0 + col * thirdW; const x1 = board.x0 + (col + 1) * thirdW;
  const y0 = row === 0 ? board.y0 : row === 1 ? board.y0 + halfH : board.y0;
  const y1 = row === 0 ? board.y0 + halfH : row === 1 ? board.y1 : board.y1;
  if (name === 'left' || name === 'center' || name === 'right') return { x0, y0: board.y0, x1, y1: board.y1 };
  if (name === 'top') return { x0: board.x0, y0: board.y0 + halfH, x1: board.x1, y1: board.y1 };
  if (name === 'bottom') return { x0: board.x0, y0: board.y0, x1: board.x1, y1: board.y0 + halfH };
  if (name === 'full') return { ...board };
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------
function claimProblems(claims, placements) {
  const problems = []; const refs = new Set(placements.map((placement) => placement.ref));
  const claimed = new Map();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') { problems.push('claim 不是对象'); continue; }
    if (!claim.module) problems.push('claim 缺 module');
    if (!normalizeZone(claim.zone)) problems.push(`claim ${claim.module || '?'} 的 zone 不在九宫格词表：${claim.zone}`);
    if (!Array.isArray(claim.parts) || !claim.parts.length) problems.push(`claim ${claim.module || '?'} 缺 parts`);
    for (const ref of claim.parts || []) {
      if (!refs.has(ref)) problems.push(`claim ${claim.module || '?'} 引用了不存在的器件 ${ref}`);
      if (claimed.has(ref)) problems.push(`器件 ${ref} 被多个 claim 重复声明`);
      claimed.set(ref, claim.module);
    }
  }
  const unclaimed = placements.map((placement) => placement.ref).filter((ref) => !claimed.has(ref));
  return { problems, unclaimed, claimed };
}

export const SKILL_RULES = [
  {
    id: 'SKL-01', group: 'SKL', name: '功能分区 claim 完整性', level: '推荐',
    check: ({ input }) => {
      const claims = list(input.zones);
      const placements = list(input.placements);
      if (!claims) return review('未提供功能分区 claim（zones）');
      if (!placements) return review('未提供器件布局读回（placements）');
      if (!claims.length) return review('zones 为空：未声明功能分区');
      if (!placements.length) return na('本板没有器件');
      const { problems, unclaimed } = claimProblems(claims, placements);
      if (problems.length) return review(`claim 数据不完整：${problems.join('；')}`);
      if (unclaimed.length) return review(`存在未归属功能分区的器件：${unclaimed.join('、')}`, { unclaimed });
      return ok({ modules: claims.map((claim) => claim.module) }, `全部 ${placements.length} 个器件已归属 ${claims.length} 个功能分区`);
    },
  },
  {
    id: 'SKL-02', group: 'SKL', name: 'zone 九宫格违规', level: '硬门禁',
    check: ({ input }) => {
      const claims = list(input.zones); const placements = list(input.placements);
      const board = boardRect(input);
      if (!claims) return review('未提供功能分区 claim（zones）');
      if (!placements) return review('未提供器件布局读回（placements）');
      if (!claims.length) return review('zones 为空：无法判定分区违规');
      if (!board) return review('未提供板框尺寸/包围盒，无法解析九宫格矩形');
      const { problems } = claimProblems(claims, placements);
      if (problems.length) return review(`claim 数据不完整：${problems.join('；')}`);
      const byRef = new Map(placements.map((placement) => [placement.ref, placement]));
      const violations = []; const missing = [];
      for (const claim of claims) {
        const rect = zoneRect(claim.zone, board);
        if (!rect) { missing.push(`${claim.module}:非法 zone`); continue; }
        for (const ref of claim.parts) {
          const placement = byRef.get(ref);
          const partRect = placementRect(placement);
          if (!partRect) { missing.push(ref); continue; }
          const center = rectCenter(partRect);
          if (!inRect(rect, center.x, center.y)) violations.push(`${claim.module}/${ref} 中心 (${round(center.x, 2)},${round(center.y, 2)}) 不在 ${claim.zone} 区内`);
        }
      }
      if (missing.length) return review(`器件缺布局坐标，无法判定：${missing.join('、')}`);
      if (violations.length) return fail(`功能分区违规：${violations.join('；')}`, { violations });
      return ok({ checked: placements.length }, '所有 claim 器件都在其九宫格区内');
    },
  },
  {
    id: 'SKL-03', group: 'SKL', name: 'layout-lint 手焊通道', level: '推荐',
    check: ({ input }) => {
      const placements = list(input.placements); const board = boardRect(input);
      const assembly = input.assembly && typeof input.assembly === 'object' ? input.assembly : null;
      if (!placements) return review('未提供器件布局读回（placements）');
      if (!assembly) return review('未提供装配策略 assembly（手焊 profile/手焊件清单）');
      const handSolder = list(assembly.handSolderParts) || [];
      if (!handSolder.length) return na('assembly.handSolderParts 为空：本板无手焊件');
      if (!board) return review('未提供板框尺寸，无法计算通道');
      const accessChannelMm = (toNum(assembly.accessChannelMil) ?? ACCESS_CHANNEL_MIL_DEFAULT) * 0.0254;
      const rects = new Map();
      for (const placement of placements) { const rect = placementRect(placement); if (rect) rects.set(placement.ref, rect); }
      const missing = handSolder.filter((ref) => !rects.has(ref));
      if (missing.length) return review(`手焊件缺布局坐标：${missing.join('、')}`);
      const blocked = []; const checked = [];
      for (const ref of handSolder) {
        const rect = rects.get(ref);
        const others = [...rects.entries()].filter(([other]) => other !== ref).map(([, otherRect]) => otherRect);
        const leftObstacles = others.filter((other) => overlapsY(other, rect)).map((other) => other.x1).filter((x) => x <= rect.x0);
        const rightObstacles = others.filter((other) => overlapsY(other, rect)).map((other) => other.x0).filter((x) => x >= rect.x1);
        const bottomObstacles = others.filter((other) => overlapsX(other, rect)).map((other) => other.y1).filter((y) => y <= rect.y0);
        const topObstacles = others.filter((other) => overlapsX(other, rect)).map((other) => other.y0).filter((y) => y >= rect.y1);
        const free = {
          left: rect.x0 - Math.max(board.x0, ...leftObstacles),
          right: Math.min(board.x1, ...rightObstacles) - rect.x1,
          bottom: rect.y0 - Math.max(board.y0, ...bottomObstacles),
          top: Math.min(board.y1, ...topObstacles) - rect.y1,
        };
        const best = Math.max(free.left, free.right, free.bottom, free.top);
        checked.push({ ref, accessMm: round(best, 2), requiredMm: round(accessChannelMm, 3) });
        if (best + EPS < accessChannelMm) blocked.push(`${ref} 四侧最大净空 ${mm(best)} < 手焊通道 ${mm(accessChannelMm)}`);
      }
      if (blocked.length) return fail(`手焊通道不足（no-access）：${blocked.join('；')}`, { checked });
      return ok({ checked }, `手焊件均满足 ${mm(accessChannelMm)} 通道要求`);
    },
  },
  {
    id: 'SKL-04', group: 'SKL', name: 'layout-lint 禁布区（no-access）', level: '硬门禁',
    check: ({ input }) => {
      const regions = list(input.regions); const placements = list(input.placements);
      if (!regions) return review('未提供区域详情（regions）');
      if (!placements) return review('未提供器件布局读回（placements）');
      const noComponentRegions = regions.filter((region) => Array.isArray(region.rules) && region.rules.includes(REGION_RULE.NO_COMPONENTS));
      if (!noComponentRegions.length) return na('没有 NO_COMPONENTS 禁布区');
      const rects = noComponentRegions.map((region) => ({ id: region.id || region.primitiveId || 'region', rect: boundsRect(region.boundsMm) }));
      if (rects.some((item) => !item.rect)) return review('部分禁布区缺 boundsMm，无法判定器件是否落入');
      const violations = [];
      for (const placement of placements) {
        const partRect = placementRect(placement);
        if (!partRect) { violations.push(`${placement.ref} 缺布局坐标`); continue; }
        for (const region of rects) {
          if (rectsOverlap(partRect, region.rect)) violations.push(`${placement.ref} 落在禁布区 ${region.id} 内`);
        }
      }
      if (violations.some((violation) => violation.includes('缺布局坐标'))) return review(`部分器件缺布局坐标：${violations.join('；')}`);
      if (violations.length) return fail(`器件落入禁布区：${violations.join('；')}`, { violations });
      return ok({ regions: rects.map((item) => item.id) }, '没有器件落入 NO_COMPONENTS 禁布区');
    },
  },
  {
    id: 'SKL-05', group: 'SKL', name: 'keepout / no-pours 双层', level: '硬门禁',
    check: ({ input }) => {
      const regions = list(input.regions); const pours = list(input.pours);
      if (!regions) return review('未提供区域详情（regions）');
      const noPourRegions = regions.filter((region) => Array.isArray(region.rules) && (region.rules.includes(REGION_RULE.NO_POURS) || region.rules.includes(REGION_RULE.NO_FILLS)));
      if (!noPourRegions.length) return na('没有 NO_POURS/NO_FILLS 区域');
      const missingBounds = noPourRegions.filter((region) => !boundsRect(region.boundsMm));
      if (missingBounds.length) return review('部分禁铺区缺 boundsMm');
      if (pours === null) return review('未提供覆铜详情（pours），无法核对禁铺区里是否真有覆铜');
      const problems = [];
      for (const region of noPourRegions) {
        const rect = boundsRect(region.boundsMm);
        const id = region.id || region.primitiveId || 'region';
        const layer = toNum(region.layer);
        if (layer !== MULTI_LAYER) {
          const complementLayer = layer === 1 ? 2 : layer === 2 ? 1 : null;
          const complement = complementLayer === null ? null : noPourRegions.find((other) => {
            if (other === region || toNum(other.layer) !== complementLayer) return false;
            const otherRect = boundsRect(other.boundsMm);
            return otherRect && rect && rectsOverlap(rect, otherRect);
          });
          if (!complement) problems.push(`${id} 只约束单层（layer=${region.layer}），且缺少另一外层同位置的 NO_POURS 区，no-pours 必须覆盖多层（layer=${MULTI_LAYER}）`);
        }
        for (const pour of pours) {
          const pourRect = boundsRect(pour.boundsMm);
          if (!pourRect) continue;
          const layerMatches = region.layer === MULTI_LAYER || toNum(pour.layer) === toNum(region.layer);
          if (layerMatches && rectsOverlap(rect, pourRect)) problems.push(`${id} 内存在覆铜 ${pour.id || pour.primitiveId || pour.net || ''}（net=${pour.net ?? '?'}, layer=${pour.layer ?? '?'}）`);
        }
      }
      if (problems.length) return fail(`禁铺区不满足：${problems.join('；')}`, { regions: noPourRegions.length });
      return ok({ regions: noPourRegions.length, pours: pours.length }, 'NO_POURS 区域覆盖多层且区内无覆铜');
    },
  },
  {
    id: 'SKL-06', group: 'SKL', name: '晶振区禁铺', level: '硬门禁',
    check: ({ input }) => {
      const placements = list(input.placements); const regions = list(input.regions); const pours = list(input.pours);
      if (!placements) return review('未提供器件布局读回（placements）');
      const explicit = list(input.crystalRefs);
      const crystals = explicit && explicit.length ? explicit : placements.filter((placement) => /^[YX]\d+$/i.test(String(placement.ref || ''))).map((placement) => placement.ref);
      if (!crystals.length) return na('本板没有晶振（Y*/X* 且未显式声明）');
      if (!regions) return review('未提供区域详情（regions），无法核对晶振禁铺');
      const crystalRects = new Map();
      for (const ref of crystals) {
        const placement = placements.find((item) => item.ref === ref);
        const rect = placementRect(placement);
        if (!rect) return review(`晶振 ${ref} 缺布局坐标`);
        crystalRects.set(ref, rect);
      }
      const noPourRegions = regions.filter((region) => Array.isArray(region.rules) && (region.rules.includes(REGION_RULE.NO_POURS) || region.rules.includes(REGION_RULE.NO_FILLS)));
      const problems = [];
      for (const [ref, crystalRect] of crystalRects) {
        const covering = noPourRegions.filter((region) => {
          const rect = boundsRect(region.boundsMm);
          return rect && rectContains(rect, crystalRect);
        });
        if (!covering.length) problems.push(`${ref} 没有完全覆盖的禁铺区`);
        if (pours) {
          for (const pour of pours) {
            const pourRect = boundsRect(pour.boundsMm);
            if (pourRect && rectsOverlap(pourRect, crystalRect)) problems.push(`${ref} 区域内有覆铜 ${pour.id || pour.net || ''}`);
          }
        }
      }
      if (problems.length) return fail(`晶振禁铺不满足：${problems.join('；')}`, { crystals: [...crystalRects.keys()] });
      return ok({ crystals: [...crystalRects.keys()], keepouts: noPourRegions.length }, '晶振区被 NO_POURS 区完整覆盖且无覆铜');
    },
  },
  {
    id: 'SKL-07', group: 'SKL', name: '两轮自检 artifact 契约', level: '硬门禁',
    check: ({ input }) => {
      const selfCheck = input.selfCheck && typeof input.selfCheck === 'object' ? input.selfCheck : null;
      if (!selfCheck || !Array.isArray(selfCheck.rounds)) return review('未提供两轮自检证据 selfCheck.rounds');
      if (selfCheck.saved !== true) return fail('保存未确认（selfCheck.saved 必须为 true）', { saved: selfCheck.saved });
      const rounds = selfCheck.rounds;
      if (rounds.length < 2) return fail(`只完成 ${rounds.length} 轮自检，必须两轮`, { rounds: rounds.length });
      const problems = []; const checked = [];
      for (const [index, round] of rounds.slice(0, 2).entries()) {
        const label = `第 ${index + 1} 轮`;
        const artifact = String(round?.artifactSha256 || '');
        const readback = String(round?.readbackSha256 || '');
        if (!/^[a-f0-9]{64}$/i.test(artifact)) problems.push(`${label} artifactSha256 缺失或非法`);
        if (!/^[a-f0-9]{64}$/i.test(readback)) problems.push(`${label} readbackSha256 缺失或非法`);
        if (artifact && readback && artifact.toLowerCase() !== readback.toLowerCase()) problems.push(`${label} 读回哈希与 artifact 不一致（保存/重载未落盘）`);
        if (Array.isArray(round?.findings) && round.findings.length && index === 1) problems.push(`第 2 轮仍有 ${round.findings.length} 条 findings`);
        checked.push({ round: index + 1, artifactHash: artifact.slice(0, 12), readbackHash: readback.slice(0, 12), findings: Array.isArray(round?.findings) ? round.findings.length : null });
      }
      const reload = rounds[1]?.reload && typeof rounds[1].reload === 'object' ? rounds[1].reload : null;
      if (problems.length) return fail(`两轮自检不完整：${problems.join('；')}`, { checked });
      if (!reload || reload.attempted !== true) return review('两轮已完成且哈希一致，但第 2 轮未执行 save→reload 重载（降级证据）', { checked });
      if (reload.ok !== true) return fail('第 2 轮 reload 失败', { checked });
      return ok({ checked, reload }, '两轮自检 artifact/readback 哈希一致，且已重载');
    },
  },
  {
    id: 'SKL-08', group: 'SKL', name: '差分对/等长先声明后测量', level: '硬门禁',
    check: ({ input }) => {
      const pairs = list(input.diffPairs); const groups = list(input.equalLengthGroups);
      if (pairs === null && groups === null) return review('未提供差分对/等长组测量数据');
      const problems = []; const checked = []; const missing = [];
      for (const pair of pairs || []) {
        const label = pair.name || `${pair.positive}/${pair.negative}`;
        if (pair.routed !== true) continue;
        if (pair.declaredBeforeRouting !== true) problems.push(`${label} 已布线但未证明"布线前已声明"`);
        const lengthP = toNum(pair.lengthPMm); const lengthN = toNum(pair.lengthNMm); const maxSkew = toNum(pair.maxSkewMm);
        if (lengthP === null || lengthN === null || maxSkew === null) { missing.push(label); continue; }
        const skew = Math.abs(lengthP - lengthN);
        checked.push({ pair: label, skewMm: round(skew, 3), maxSkewMm: maxSkew });
        if (skew > maxSkew + EPS) problems.push(`${label} 等长偏差 ${mm(skew)} > ${mm(maxSkew)}`);
      }
      for (const group of groups || []) {
        const label = group.name || 'equal-length';
        if (group.routed !== true) continue;
        if (group.declaredBeforeRouting !== true) problems.push(`${label} 等长组已布线但未证明"布线前已声明"`);
        const lengths = group.lengthsMm && typeof group.lengthsMm === 'object' ? group.lengthsMm : null;
        const maxSpread = toNum(group.maxSpreadMm);
        if (!lengths || maxSpread === null) { missing.push(label); continue; }
        const values = Object.values(lengths).map(toNum).filter(isNum);
        if (values.length < 2) { missing.push(label); continue; }
        const spread = Math.max(...values) - Math.min(...values);
        checked.push({ group: label, spreadMm: round(spread, 3), maxSpreadMm: maxSpread });
        if (spread > maxSpread + EPS) problems.push(`${label} 组内长度差 ${mm(spread)} > ${mm(maxSpread)}`);
      }
      if (missing.length) return review(`测量数据不完整：${missing.join('、')}`, { checked, missing });
      if (problems.length) return fail(`差分对/等长声明或测量不满足：${problems.join('；')}`, { checked });
      return ok({ checked }, '差分对/等长组均满足"先声明后测量"与偏差要求');
    },
  },
  {
    id: 'SKL-09', group: 'SKL', name: '丝印镜像/反显', level: '推荐',
    check: ({ input }) => {
      const texts = list(input.silkTexts);
      if (!texts) return review('未提供丝印文字详情 silkTexts');
      if (!texts.length) return na('本板没有丝印文字');
      const problems = []; const checked = []; const missing = [];
      for (const text of texts) {
        const layer = toNum(text.layer) === 3 || text.layer === 'top' ? 'top'
          : toNum(text.layer) === 4 || text.layer === 'bottom' ? 'bottom' : null;
        if (!layer) continue;
        if (typeof text.mirror !== 'boolean' || typeof text.reverse !== 'boolean') { missing.push(text.id || text.text || 'text'); continue; }
        const id = text.id || text.text || 'text';
        const kind = text.kind || 'text';
        checked.push({ id, layer, mirror: text.mirror, reverse: text.reverse });
        if (text.reverse === true) problems.push(`${id} reverse=true（反显）`);
        if (layer === 'top' && text.mirror === true) problems.push(`${id} 顶层丝印 mirror=true`);
        if (kind === 'designator' && text.componentLayer && text.componentLayer !== layer) problems.push(`${id} 位号在 ${layer} 丝印，但器件在 ${text.componentLayer} 面`);
        if (kind === 'designator') {
          const rotation = ((toNum(text.rotationDeg) ?? 0) % 360 + 360) % 360;
          if (rotation !== 0) problems.push(`${id} 位号旋转 ${rotation}°（应为 0°/可读方向）`);
        }
      }
      if (missing.length) return review(`部分丝印缺 layer/mirror/reverse：${missing.join('、')}`);
      if (problems.length) return fail(`丝印镜像/反显违规：${problems.join('；')}`, { checked });
      return ok({ checked, note: '底层 mirror 的平台语义未验证，本规则刻意不判底层 mirror' }, '丝印没有反显/顶层镜像/位号跨面问题');
    },
  },
  {
    id: 'SKL-10', group: 'SKL', name: 'net-class 一致性', level: '硬门禁',
    check: ({ input }) => {
      const netClasses = list(input.netClasses);
      const assignments = list(input.netClassAssignments);
      const tracks = list(input.tracks);
      const map = input.netClassMap && typeof input.netClassMap === 'object' ? input.netClassMap : null;
      if (!netClasses) return review('未提供网络类声明 netClasses');
      if (!assignments && !(map && tracks)) return review('未提供 netClassAssignments，或 netClassMap+tracks');
      const byName = new Map(netClasses.map((item) => [item.name, item]));
      const entries = assignments || tracks.map((track) => ({ net: track.net, className: map[track.net], actualWidthMm: track.widthMm }));
      if (!entries.length) return na('没有可核对的网络');
      const problems = []; const checked = []; const missing = [];
      const tolerancePercent = toNum(input.tolerancePercent) ?? 5;
      for (const entry of entries) {
        const label = entry.net || '?';
        const declared = byName.get(entry.className);
        const actual = toNum(entry.actualWidthMm);
        if (!declared) { missing.push(label); continue; }
        const declaredWidth = toNum(declared.widthMm);
        if (!(declaredWidth > 0) || actual === null) { missing.push(label); continue; }
        const allowed = Math.max(declaredWidth * tolerancePercent / 100, 0.02);
        checked.push({ net: label, className: entry.className, declaredWidthMm: declaredWidth, actualWidthMm: actual });
        if (Math.abs(actual - declaredWidth) > allowed + EPS) problems.push(`${label} 实际 ${mm(actual)} ≠ class ${entry.className} 声明 ${mm(declaredWidth)}（容差 ±${tolerancePercent}%）`);
      }
      if (missing.length) return review(`缺少 class 或实测线宽：${missing.join('、')}`);
      if (problems.length) return fail(`net-class 与实测不一致：${problems.join('；')}`, { checked });
      return ok({ checked }, '所有网络实测线宽与 net-class 声明一致');
    },
  },
];

export function evaluateSkillRules(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const ctx = { input: source };
  const rules = SKILL_RULES.map((rule) => {
    const result = rule.check(ctx);
    return { id: rule.id, group: rule.group, name: rule.name, level: rule.level, status: result.status, message: result.message, evidence: result.evidence ?? null };
  });
  const count = (status) => rules.filter((rule) => rule.status === status).length;
  const summary = {
    total: rules.length,
    PASS: count(STATUS.PASS), FAIL: count(STATUS.FAIL), REVIEW: count(STATUS.REVIEW), NA: count(STATUS.NA),
    blockingFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level === '硬门禁').length,
    warningFailures: rules.filter((rule) => rule.status === STATUS.FAIL && rule.level !== '硬门禁').length,
  };
  const findings = rules.filter((rule) => rule.status === STATUS.FAIL).map((rule) => finding(
    `SKILL_RULE_${rule.id}`,
    rule.message,
    `engine.constraints.${rule.id}`,
    rule.level === '硬门禁' ? 'blocking' : 'warning',
  ));
  const core = {
    kind: 'eda-constraint-audit', schemaVersion: 1,
    rules, summary, findings,
    passed: summary.blockingFailures === 0,
    releaseReady: summary.FAIL === 0 && summary.REVIEW === 0,
    humanReviewRequired: true,
    policy: 'REVIEW 不等于 PASS；zone/keepout/两轮自检/丝印/net-class 的最终判据仍是 EDA pcb check、DRC 与板厂 DFM。',
  };
  return { ...core, auditHash: sha256(JSON.stringify(core)) };
}

export function skillRuleSummary() {
  return {
    rules: SKILL_RULES.map((rule) => ({ id: rule.id, name: rule.name, level: rule.level })),
    fixtures: Object.keys(SKILL_RULE_FIXTURES),
    policy: '只读审计；REVIEW 不等于 PASS；不替代 EDA pcb check/DRC/板厂 DFM。',
  };
}

// ---------------------------------------------------------------------------
// 样板
// ---------------------------------------------------------------------------
function passFixture() {
  return {
    board: { widthMm: 100, heightMm: 80 },
    placements: [
      { ref: 'U1', xMm: 20, yMm: 20, widthMm: 6, heightMm: 6, layer: 1 },
      { ref: 'ANT1', xMm: 80, yMm: 60, widthMm: 8, heightMm: 4, layer: 1 },
      { ref: 'J1', xMm: 50, yMm: 12, widthMm: 10, heightMm: 5, layer: 1 },
      { ref: 'Y1', xMm: 24, yMm: 57, widthMm: 3, heightMm: 2, layer: 1 },
    ],
    zones: [
      { module: 'MCU', zone: 'left-bottom', parts: ['U1'] },
      { module: 'RF', zone: 'right-top', parts: ['ANT1'] },
      { module: 'CONN', zone: 'center-bottom', parts: ['J1'] },
      { module: 'CLOCK', zone: 'left-top', parts: ['Y1'] },
    ],
    assembly: { profile: 'hand-solder', handSolderParts: ['J1'], accessChannelMil: 60 },
    regions: [
      { id: 'CrystalKeepout', layer: 12, rules: [7], boundsMm: { minXMm: 20, minYMm: 53, maxXMm: 30, maxYMm: 61 } },
      { id: 'NoComponentCorner', layer: 12, rules: [2], boundsMm: { minXMm: 92, minYMm: 72, maxXMm: 98, maxYMm: 78 } },
    ],
    pours: [],
    selfCheck: {
      saved: true,
      rounds: [
        { round: 1, artifactSha256: 'a'.repeat(64), readbackSha256: 'a'.repeat(64), findings: [], fixesApplied: [] },
        { round: 2, artifactSha256: 'b'.repeat(64), readbackSha256: 'b'.repeat(64), findings: [], fixesApplied: [], reload: { attempted: true, ok: true } },
      ],
    },
    diffPairs: [{ name: 'USB', positive: 'USB_DP', negative: 'USB_DM', routed: true, declaredBeforeRouting: true, lengthPMm: 20, lengthNMm: 20.05, maxSkewMm: 0.1 }],
    equalLengthGroups: [{ name: 'DDR', nets: ['D0', 'D1'], routed: true, declaredBeforeRouting: true, lengthsMm: { D0: 10, D1: 10.05 }, maxSpreadMm: 0.1 }],
    silkTexts: [{ id: 'T1', text: 'R1', layer: 3, kind: 'designator', mirror: false, reverse: false, rotationDeg: 0, componentLayer: 'top' }],
    netClasses: [{ name: 'PWR', widthMm: 0.4 }],
    netClassMap: { '+3V3': 'PWR' },
    tracks: [{ net: '+3V3', widthMm: 0.4 }],
  };
}

function failFixture() {
  const input = structuredClone(passFixture());
  input.placements[0] = { ...input.placements[0], xMm: 90, yMm: 70 };
  input.placements.push({ ref: 'U2', xMm: 50, yMm: 50, widthMm: 4, heightMm: 4, layer: 1 });
  input.assembly.handSolderParts = ['J1', 'U1'];
  input.placements.push(
    { ref: 'B1', xMm: 42.5, yMm: 12, widthMm: 3, heightMm: 5, layer: 1 },
    { ref: 'B2', xMm: 57.5, yMm: 12, widthMm: 3, heightMm: 5, layer: 1 },
    { ref: 'B3', xMm: 50, yMm: 7.5, widthMm: 10, heightMm: 3, layer: 1 },
    { ref: 'B4', xMm: 50, yMm: 16.5, widthMm: 10, heightMm: 3, layer: 1 },
  );
  input.assembly.handSolderParts = ['J1'];
  input.regions = [
    { id: 'CrystalKeepout', layer: 1, rules: [7], boundsMm: { minXMm: 10, minYMm: 10, maxXMm: 40, maxYMm: 40 } },
    { id: 'BlockU1', layer: 12, rules: [2], boundsMm: { minXMm: 80, minYMm: 60, maxXMm: 100, maxYMm: 80 } },
  ];
  input.pours = [{ id: 'P1', net: 'GND', layer: 1, boundsMm: { minXMm: 20, minYMm: 20, maxXMm: 30, maxYMm: 30 } }];
  input.selfCheck = { saved: false, rounds: [{ round: 1, artifactSha256: 'c'.repeat(64), readbackSha256: 'd'.repeat(64), findings: [{ code: 'X' }], fixesApplied: [] }] };
  input.diffPairs = [{ name: 'USB', positive: 'USB_DP', negative: 'USB_DM', routed: true, declaredBeforeRouting: false, lengthPMm: 20, lengthNMm: 22, maxSkewMm: 0.1 }];
  input.equalLengthGroups = [{ name: 'DDR', nets: ['D0', 'D1'], routed: true, declaredBeforeRouting: false, lengthsMm: { D0: 10, D1: 11 }, maxSpreadMm: 0.1 }];
  input.silkTexts = [{ id: 'T1', text: 'R1', layer: 3, kind: 'designator', mirror: true, reverse: true, rotationDeg: 90, componentLayer: 'bottom' }];
  input.netClassMap = { '+3V3': 'PWR' };
  input.tracks = [{ net: '+3V3', widthMm: 0.2 }];
  return input;
}

export const SKILL_RULE_FIXTURES = {
  'SKILL-PASS': passFixture,
  'SKILL-FAIL': failFixture,
  'SKILL-REVIEW': () => ({}),
};
