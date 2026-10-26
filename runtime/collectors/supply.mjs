import { lookupLcscParts } from '../engineering/supply.mjs';
import { defineCollector } from './collect.mjs';

/**
 * 供应链采集器（W3-06）：料号 → 价格/库存/最小起订/封装/品牌/URL 的参考级候选知识。
 * 复用 `engineering/supply.mjs`（已做 C 号精确匹配、价格未知≠0、库存未知≠0 的诚实性处理）。
 * 不访问 EDA、不写设计，只出候选条目；TTL 30 天（价格库存会变）。
 */
export function createSupplyCollector({ lcscIds = [], lookupImpl = null, cache = null, now = () => new Date() } = {}) {
  const ids = (Array.isArray(lcscIds) ? lcscIds : []).map((value) => String(value ?? '').trim()).filter(Boolean);
  if (!ids.length) throw Object.assign(new Error('供应链采集器需要至少 1 个 C 号'), { code: 'COLLECTOR_INVALID' });
  return defineCollector({
    id: 'lcsc-supply',
    kind: 'part',
    source: 'lcsc',
    run: async ({ timeoutMs = 15_000 } = {}) => {
      const result = lookupImpl ? await lookupImpl({ lcscIds: ids }) : await lookupLcscParts({ lcscIds: ids, cache, timeoutMs });
      const parts = Object.values(result?.parts ?? {});
      const fetchedAt = now().toISOString();
      const items = parts.map((part) => ({
        kind: 'part',
        title: part.model || part.lcscId,
        payload: {
          lcscId: part.lcscId,
          mpn: part.model ?? null,
          footprint: part.package ?? null,
          brand: part.brand ?? null,
          description: part.description ?? null,
          price: part.price ?? null,
          currency: part.currency ?? null,
          stock: part.stock ?? null,
          minQty: part.minQty ?? null,
          priceUnknownReason: part.priceUnknownReason ?? null,
          stockUnknownReason: part.stockUnknownReason ?? null,
        },
        provenance: { source: 'lcsc', url: part.url ?? null, version: null, fetchedAt, collector: 'lcsc-supply' },
        trust: 'unverified',
        ttlDays: 30,
      }));
      return {
        items,
        evidence: { source: result?.source ?? 'lcsc', checkedAt: result?.checkedAt ?? fetchedAt, requested: ids, found: items.length, unknown: result?.unknown ?? [] },
      };
    },
  });
}
