/**
 * 元件候选提案（candidate proposal）→ 用户勾选 → 落 plan
 *
 * 设计原则（与全项目一致，宁可保守也不臆造）：
 * 1. **不猜型号**：候选必须来自真实库检索结果（真实 uuid/libraryUuid/LCSC 料号），本模块只做归一化/去重/排名，
 *    绝不凭空生成型号字符串。
 * 2. **不猜价格**：价格/库存只来自 supply 证据（`pricing.entries`）。查不到就是 `unknown` + 理由，
 *    绝不写成 0 或"未知当已定价"。
 * 3. **用户勾选才算数**：本模块只把"被勾选的候选"翻译成 design plan 的操作，
 *    真正的落地仍要走既有 `plan → approve（绑定 planHash）→ execute` 闸门，用户批准的就是这一份确切方案。
 * 4. **缺失要说清**：任何不满足的条件都进 `missing[]` 并让 `ready=false`，不静默通过。
 */
import crypto from 'node:crypto';
import { normalizePlan } from './design.mjs';

export const PROPOSAL_API_VERSION = 1;
export const MAX_PROPOSAL_QUERIES = 8;
export const MAX_PROPOSAL_CANDIDATES = 60;
export const MAX_SELECTION = 40;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

/** 归一化调用方输入：需求文字、检索关键词、精确 LCSC 料号、目标文档、网络名。 */
export function normalizeRequirement(input = {}) {
  const queries = (Array.isArray(input.queries) ? input.queries : [])
    .map((item) => text(item, 200))
    .filter(Boolean)
    .slice(0, MAX_PROPOSAL_QUERIES);
  const lcscIds = (Array.isArray(input.lcscIds) ? input.lcscIds : [])
    .map((item) => text(item, 40).toUpperCase())
    .filter((item) => /^C\d{4,}$/.test(item))
    .slice(0, 200);
  const nets = (Array.isArray(input.nets) ? input.nets : [])
    .map((item) => text(item, 120))
    .filter(Boolean)
    .slice(0, 200);
  return {
    requirement: text(input.requirement, 4000),
    title: text(input.title, 200) || '候选提案落地计划',
    queries,
    lcscIds,
    nets,
    target: input.target === 'pcb' ? 'pcb' : 'schematic',
  };
}

/** 候选的稳定 id：有 LCSC 料号就用料号，否则用库 uuid（同一个候选永远同一个 id）。 */
export function candidateIdOf(candidate = {}) {
  const lcscId = text(candidate.lcscId, 40).toUpperCase();
  if (/^C\d{4,}$/.test(lcscId)) return `lcsc:${lcscId}`;
  const uuid = text(candidate.uuid, 160);
  return uuid ? `uuid:${uuid}` : '';
}

function priceIndexOf(pricing) {
  const entries = Array.isArray(pricing?.entries) ? pricing.entries : [];
  const index = new Map();
  for (const entry of entries) {
    const lcsc = text(entry?.lcsc, 40).toUpperCase();
    if (!lcsc) continue;
    index.set(lcsc, entry);
  }
  return index;
}

/**
 * 把价格证据挂到候选上。
 * 只有 `status === 'priced'` 才算有价格；其余（含无证据、查不到、接口失败）统一 `unknown` 并带理由。
 */
export function attachPriceEvidence(candidate = {}, pricing = null) {
  const lcscId = text(candidate.lcscId, 40).toUpperCase();
  const index = priceIndexOf(pricing);
  const entry = lcscId ? index.get(lcscId) : undefined;
  if (!lcscId) {
    return { status: 'unknown', reason: '候选项没有 LCSC 料号，无法比对价格/库存' };
  }
  if (!entry) {
    if (pricing && pricing.available === false) {
      return { status: 'unknown', reason: `价格/库存查询失败：${text(pricing.error, 200) || '未返回原因'}` };
    }
    return { status: 'unknown', reason: pricing ? '价格/库存证据里没有这个料号（未查询或查不到）' : '未触发价格/库存查询（fetchPricing=false）' };
  }
  if (String(entry.status || '') !== 'priced') {
    return { status: 'unknown', reason: text(entry.reason, 300) || `证据状态为 ${text(entry.status, 40) || 'unknown'}` };
  }
  return {
    status: 'priced',
    lcscId,
    currency: text(entry.currency, 16) || 'USD',
    unitPrice: Number(entry.price),
    stock: Number.isFinite(Number(entry.stock)) ? Number(entry.stock) : null,
    minQty: Number.isFinite(Number(entry.minQty)) ? Number(entry.minQty) : null,
    priceBreaks: Array.isArray(entry.priceBreaks) ? entry.priceBreaks.slice(0, 12) : [],
    source: text(entry.source, 120) || null,
    checkedAt: text(entry.checkedAt, 60) || null,
  };
}

/** 备料风险提示：只陈述证据，不代替用户决策。 */
function stockNote(price) {
  if (price.status !== 'priced') return null;
  if (!Number.isFinite(price.stock)) return null;
  if (price.stock <= 0) return '库存为 0：需要先补料或换型号';
  if (price.stock < 1000) return `库存偏低（${price.stock}）：量产前建议确认补料`;
  return null;
}

/**
 * 生成提案：真实候选取交集/去重后编号，排名只依据"证据完整度"，不做型号好坏的主观排序。
 */
export function buildPartProposal({ requirement = '', title = '', queries = [], lcscIds = [], nets = [], target = 'schematic', candidates = [], pricing = null, createdAt = null } = {}) {
  const seen = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const uuid = text(candidate?.uuid, 160);
    const libraryUuid = text(candidate?.libraryUuid, 160);
    if (!uuid || !libraryUuid) continue; // 缺库身份无法落板，直接丢弃（不编造）
    const key = uuid;
    if (seen.has(key)) continue;
    const lcscId = /^C\d{4,}$/i.test(text(candidate?.lcscId, 40)) ? text(candidate.lcscId, 40).toUpperCase() : null;
    const price = attachPriceEvidence({ ...candidate, lcscId }, pricing);
    const entry = {
      candidateId: candidateIdOf({ lcscId, uuid }),
      name: text(candidate?.name, 200) || uuid,
      uuid,
      libraryUuid,
      lcscId,
      manufacturer: text(candidate?.manufacturer, 120) || null,
      manufacturerPart: text(candidate?.manufacturerPart, 160) || null,
      description: text(candidate?.description, 500) || null,
      footprintName: text(candidate?.footprintName, 200) || text(candidate?.footprint?.name, 200) || null,
      symbolName: text(candidate?.symbolName, 200) || text(candidate?.symbol?.name, 200) || null,
      datasheet: text(candidate?.datasheet, 500) || null,
      price,
      stockNote: stockNote(price),
    };
    seen.set(key, entry);
    if (seen.size >= MAX_PROPOSAL_CANDIDATES) break;
  }

  const list = [...seen.values()]
    .map((entry, index) => ({
      ...entry,
      // rank 只反映"证据是否够用户决策"：有价有库 > 有价有库但无料号。
      rank: index + 1,
      evidence: {
        libraryIdentity: true,
        lcscId: Boolean(entry.lcscId),
        price: entry.price.status === 'priced',
        confirmed: false, // 永远由用户勾选后才为 true
      },
    }));

  const payload = {
    apiVersion: PROPOSAL_API_VERSION,
    requirement: text(requirement, 4000),
    title: text(title, 200) || '候选提案落地计划',
    queries: [...queries],
    lcscIds: [...lcscIds],
    nets: [...nets],
    target: target === 'pcb' ? 'pcb' : 'schematic',
    createdAt: createdAt ? text(createdAt, 60) : new Date().toISOString(),
    candidates: list,
  };
  return {
    ...payload,
    proposalId: digest(payload).slice(0, 32),
    summary: {
      candidates: list.length,
      withLcscId: list.filter((item) => item.lcscId).length,
      priced: list.filter((item) => item.price.status === 'priced').length,
      unknownPrice: list.filter((item) => item.price.status !== 'priced').length,
      stockWarnings: list.filter((item) => item.stockNote).length,
    },
  };
}

/**
 * 用户勾选 → 落 plan。
 * 产出的是既有 `reviewed-netlist` 计划（元件创建操作），可以直接送 `/api/design/plan → approve → execute`。
 * 任何不满足的条件都进 missing[]（ready=false），绝不静默生成"看起来能跑"的计划。
 */
export function selectProposalToPlan({ proposal = null, selectedIds = [], title = null, nets = null } = {}) {
  const missing = [];
  const candidates = Array.isArray(proposal?.candidates) ? proposal.candidates : [];
  if (!proposal || !candidates.length) missing.push('proposal:候选提案为空或不可用');

  const wanted = (Array.isArray(selectedIds) ? selectedIds : []).map((item) => text(item, 160)).filter(Boolean);
  if (!wanted.length) missing.push('selection:未勾选任何候选');
  if (wanted.length > MAX_SELECTION) missing.push(`selection:一次最多勾选 ${MAX_SELECTION} 个`);

  // 同一 candidateId 重复出现 = 用量（例如补光 5 颗 WS2812）。勾选就是勾选，不替用户合并数量。
  const byId = new Map(candidates.map((item) => [item.candidateId, item]));
  const counts = new Map();
  for (const id of wanted) {
    const hit = byId.get(id);
    if (!hit) {
      missing.push(`unknown-selection:${id}`);
      continue;
    }
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const selected = [...counts.entries()].map(([id, quantity]) => ({ ...byId.get(id), quantity }));

  const plannedNets = (Array.isArray(nets) ? nets : Array.isArray(proposal?.nets) ? proposal.nets : [])
    .map((item) => text(item, 120))
    .filter(Boolean);
  // reviewed-netlist 要求 nets 非空：网络名由用户/上游给出，本模块不替用户发明网络。
  if (!plannedNets.length) missing.push('nets:需要至少一个网络名（本模块不臆造网络）');

  const operations = [];
  let slot = 0;
  for (const candidate of selected) {
    for (let copy = 1; copy <= candidate.quantity; copy += 1) {
      operations.push({
        type: 'component.create',
        stage: 'placement',
        args: {
          component: { libraryUuid: candidate.libraryUuid, uuid: candidate.uuid },
          // 只给一个确定性的栅格位置，避免"随手摆"；布局优化由布局页/后续流程负责。
          x: 600 + (slot % 6) * 700,
          y: 600 + Math.floor(slot / 6) * 700,
          subPartName: '',
          rotation: 0,
          mirror: false,
          addIntoBom: true,
          addIntoPcb: true,
        },
        // 留痕：这一操作来自哪一条勾选的第几颗，便于审计"用户勾了什么、勾了几颗"
        source: { candidateId: candidate.candidateId, lcscId: candidate.lcscId, name: candidate.name, copy, quantity: candidate.quantity },
      });
      slot += 1;
    }
  }

  if (operations.length && !allHaveLibraryIdentity(selected)) missing.push('selection:候选项缺少库身份（libraryUuid/uuid）');

  const normalized = normalizePlan({
    kind: 'reviewed-netlist',
    title: text(title, 200) || text(proposal?.title, 200) || '候选提案落地计划',
    nets: plannedNets,
    operations: operations.map(({ type, args }) => ({ type, args })),
  });
  for (const item of normalized.missing) missing.push(`plan:${item}`);

  const selection = {
    selected: selected.map((item) => ({
      candidateId: item.candidateId,
      name: item.name,
      lcscId: item.lcscId,
      uuid: item.uuid,
      libraryUuid: item.libraryUuid,
      quantity: item.quantity,
      price: item.price,
      stockNote: item.stockNote,
    })),
    confirmedByUser: selected.length > 0,
    totalParts: operations.length,
  };

  return {
    apiVersion: PROPOSAL_API_VERSION,
    proposalId: text(proposal?.proposalId, 64) || null,
    selection,
    plan: normalized.plan,
    planHash: normalized.planHash,
    planning: { ready: missing.length === 0, missing },
    notes: [
      '勾选只是"选择要用的型号"；真正落板仍需走 approve（审批令牌绑定 planHash）与 execute。',
      '价格/库存为查询时刻证据，下单前请复核；unknown 表示没有证据，不代表没有价格。',
    ],
  };
}

function allHaveLibraryIdentity(selected) {
  return selected.every((item) => text(item.libraryUuid, 160) && text(item.uuid, 160));
}

export default { PROPOSAL_API_VERSION, normalizeRequirement, candidateIdOf, attachPriceEvidence, buildPartProposal, selectProposalToPlan };
