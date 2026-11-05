import type { ComponentItem, SupplyPricingEvidence } from '../types';

/**
 * 全链审计 P0-1（2026-11-05）：六门"可签"的前端输入通道。
 *
 * 修复前验证中心只把 `id/refdes/mpn/package/lcscId/qty` 和没有 boards 的 specInput 传给
 * `/api/eda/gates/collect`，导致 G1（缺板卡规格）、G2（缺 EDA/供应商三源）、G3（缺意图网表）
 * 永远 blocked——门禁结论再对，产品内也没有补输入的地方，签字按钮永远禁用。
 *
 * 这里把"页面状态 → 服务端取证请求"的映射做成纯函数：
 *  · 拿不到的输入一律传 null/不传，让服务端 missing 如实说明缺什么，**绝不补假数据**；
 *  · 供应商证据只来自真实 `supplyPricing` 返回的 priced 条目；查询失败/查不到就是 null。
 */

/** G2 单器件输入：`eda`/`supply`/`datasheet` 三源，缺哪源就 null（服务端按 error/warning 如实判）。 */
export interface GateComponentInput {
  id: string;
  refdes: string;
  mpn: string;
  package: string;
  lcscId: string;
  qty: number;
  eda: { deviceUuid: string | null; symbol: string | null; footprint: string | null; model3D: string | null; lcscId: string | null } | null;
  supply: GateSupplyEvidence | null;
  datasheet: null;
}

/** 供应商证据映射：只保留能回答"可采购/身份"的字段，不冒充封装核验。 */
export interface GateSupplyEvidence {
  lcscId: string;
  status: string;
  price: number | null;
  currency: string | null;
  stock: number | null;
  checkedAt: string | null;
  source: string | null;
  url: string | null;
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};
const normLcsc = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

/** EDA 库里的库元件是 `{name, uuid, libraryUuid}`：审计只吃字符串，取 name 优先、uuid 兜底。 */
const partText = (part: { name?: string; uuid?: string } | undefined | null): string | null => text(part?.name) || text(part?.uuid);

/** 供应商定价/库存证据 → 按 LCSC 料号索引（大小写不敏感）。没有 priced 条目的料号不生成证据。 */
export function buildSupplyEvidenceMap(pricing: SupplyPricingEvidence | null | undefined): Map<string, GateSupplyEvidence> {
  const map = new Map<string, GateSupplyEvidence>();
  if (!pricing) return map;
  const source = text(pricing.sourceLabel) || text(pricing.source);
  for (const entry of pricing.entries || []) {
    const lcscId = text(entry.lcsc);
    // 只有 priced 才是"有价格/库存证据"；unknown 条目代表查不到，不能当供应源。
    if (!lcscId || entry.status !== 'priced') continue;
    map.set(normLcsc(lcscId), {
      lcscId,
      status: entry.status,
      price: typeof entry.price === 'number' ? entry.price : null,
      currency: text(entry.currency),
      stock: typeof entry.stock === 'number' ? entry.stock : null,
      checkedAt: text(entry.checkedAt) || text(pricing.checkedAt),
      source,
      url: text(entry.url),
    });
  }
  return map;
}

/**
 * 组件清单 → G2 输入。`easyEdaBinding` 存在才映射 eda；供应商证据按 lcscId 精确匹配。
 * 没绑 EDA / 没查定价的器件照实传 null——G2 会报 `LIB_EDA_SOURCE_MISSING`/`LIB_SUPPLY_SOURCE_MISSING`，
 * 而不是被前端"补一个看起来有的对象"骗成 pass。
 */
export function buildGateComponents(components: readonly ComponentItem[], pricing: SupplyPricingEvidence | null | undefined): GateComponentInput[] {
  const supplyByLcsc = buildSupplyEvidenceMap(pricing);
  return components.map((item) => {
    const lcscId = text(item.lcscId) || '';
    const binding = item.easyEdaBinding ?? null;
    return {
      id: item.id,
      refdes: item.refdes,
      mpn: item.mpn,
      package: item.package,
      lcscId,
      qty: item.qty,
      eda: binding ? {
        deviceUuid: text(binding.uuid),
        symbol: partText(binding.symbol),
        footprint: partText(binding.footprint),
        model3D: partText(binding.model3D),
        lcscId: lcscId || null,
      } : null,
      supply: lcscId ? supplyByLcsc.get(normLcsc(lcscId)) ?? null : null,
      datasheet: null,
    };
  });
}

/** 给页面展示的映射覆盖度（让用户知道 G2 还缺哪些器件的哪一源）。 */
export function summarizeGateComponentSources(components: readonly GateComponentInput[]): { total: number; withEda: number; withSupply: number; withBoth: number } {
  const withEda = components.filter((item) => Boolean(item.eda)).length;
  const withSupply = components.filter((item) => Boolean(item.supply)).length;
  const withBoth = components.filter((item) => Boolean(item.eda) && Boolean(item.supply)).length;
  return { total: components.length, withEda, withSupply, withBoth };
}

/** G1 板卡规格：层数 >=2、宽高为正数才完整；不完整返回 board=null + 缺什么。 */
export interface BoardSpecDraft {
  id?: string | null;
  name?: string | null;
  layers: string | number;
  widthMm: string | number;
  heightMm: string | number;
}
export interface BoardSpecBuild {
  board: { id: string; name: string; layers: number; outline: { widthMm: number; heightMm: number } } | null;
  missing: string[];
}

export function buildBoardSpec(draft: BoardSpecDraft): BoardSpecBuild {
  const missing: string[] = [];
  const id = text(draft.id);
  const name = text(draft.name) || id;
  if (!id) missing.push('PCB uuid（先选择/绑定板）');
  if (!name) missing.push('板名');
  const layers = Number(draft.layers);
  if (!Number.isInteger(layers) || layers < 2) missing.push('层数（>=2 的整数）');
  const widthMm = Number(draft.widthMm);
  if (!Number.isFinite(widthMm) || widthMm <= 0) missing.push('板宽 widthMm（正数）');
  const heightMm = Number(draft.heightMm);
  if (!Number.isFinite(heightMm) || heightMm <= 0) missing.push('板高 heightMm（正数）');
  if (missing.length) return { board: null, missing };
  return { board: { id: id!, name: name!, layers, outline: { widthMm, heightMm } }, missing };
}

/** 意图网表输入：空串 = 不传；JSON 非法要阻断本次取证（不把坏 JSON 当意图网表）。 */
export function parseIntentNetlistText(value: string): { netlist: unknown | null; error: string | null } {
  const raw = value.trim();
  if (!raw) return { netlist: null, error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { netlist: null, error: `意图网表必须是 JSON 对象/数组，当前是 ${parsed === null ? 'null' : typeof parsed}` };
    return { netlist: parsed, error: null };
  } catch (caught) {
    return { netlist: null, error: `JSON 解析失败：${caught instanceof Error ? caught.message : '未知错误'}` };
  }
}

/** G3 的跨页交接键：EDA 页写、验证中心读（只用于填充默认输入，不参与门禁裁决）。 */
export const REVIEWED_NETLIST_HANDOFF_KEY = 'circuitpilot:reviewed-netlist';

export interface ReviewedNetlistHandoff {
  netlist: Record<string, unknown>;
  plan: Record<string, unknown> | null;
  createdAt: string;
}

/** EDA 页生成/校验成功后写一份已审核网表；没有网表就不写（不能拿空对象冒充意图网表）。 */
export function saveReviewedNetlistHandoff(input: { netlist?: Record<string, unknown> | null; plan?: unknown }): ReviewedNetlistHandoff | null {
  if (!input.netlist || typeof input.netlist !== 'object') return null;
  const plan = input.plan && typeof input.plan === 'object' ? input.plan as Record<string, unknown> : null;
  const handoff: ReviewedNetlistHandoff = { netlist: input.netlist, plan, createdAt: new Date().toISOString() };
  try { window.sessionStorage.setItem(REVIEWED_NETLIST_HANDOFF_KEY, JSON.stringify(handoff)); } catch { /* 存储不可用不阻塞页面 */ }
  return handoff;
}

export function readReviewedNetlistHandoff(): ReviewedNetlistHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(REVIEWED_NETLIST_HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReviewedNetlistHandoff>;
    if (!parsed.netlist || typeof parsed.netlist !== 'object') return null;
    return { netlist: parsed.netlist as Record<string, unknown>, plan: parsed.plan && typeof parsed.plan === 'object' ? parsed.plan as Record<string, unknown> : null, createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '' };
  } catch { return null; }
}

/** 交接网表 → 文本框 JSON；用户之后可手改，取证时按改后的内容解析。 */
export function formatIntentNetlistText(handoff: ReviewedNetlistHandoff): string {
  return JSON.stringify(handoff.netlist, null, 2);
}
