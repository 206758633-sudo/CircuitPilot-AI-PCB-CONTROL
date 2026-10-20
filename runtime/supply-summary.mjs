/**
 * B3：把供应链价格/库存证据汇成"下单卡可展示"的摘要。
 *
 * 原则：
 *   - 只知道**单价合计**，不是板厂/整单报价；货币混用或任一缺价就报 unknown，不把 null 当 0；
 *   - 缺货（stock===0）与库存未知分开列，不合并成"没货"；
 *   - 证据有 TTL：超过 `staleAfterHours` 标 stale（下单前必须重查），不静默当最新；
 *   - 没有证据 ⇒ known:false + 原因，不用空对象冒充。
 */
const HOUR_MS = 60 * 60 * 1000;
const text = (value) => String(value ?? '').trim();

export const SUPPLY_SUMMARY_CODES = Object.freeze({
  NO_EVIDENCE: 'SUPPLY_EVIDENCE_MISSING',
  PRICE_UNKNOWN: 'SUPPLY_PRICE_UNKNOWN_AT_ORDER',
  STOCK_OUT: 'SUPPLY_STOCK_OUT',
  STOCK_UNKNOWN: 'SUPPLY_STOCK_UNKNOWN',
  STALE: 'SUPPLY_EVIDENCE_STALE',
  MIXED_CURRENCY: 'SUPPLY_PRICE_MIXED_CURRENCY',
});

/**
 * @param {object|null} pricing `formatSupplyEvidence` 的输出
 * @param {{staleAfterHours?:number, now?:number}} [options]
 */
export function summarizeSupplyEvidence(pricing, { staleAfterHours = 24, now = Date.now() } = {}) {
  const findings = [];
  const entries = Array.isArray(pricing?.entries) ? pricing.entries.filter((entry) => entry && entry.status === 'priced') : [];
  const unknownEntries = Array.isArray(pricing?.unknownEntries) ? pricing.unknownEntries : [];
  if (!pricing || typeof pricing !== 'object' || (entries.length === 0 && unknownEntries.length === 0)) {
    return {
      schemaVersion: 1, kind: 'supply-summary', known: false,
      pricedCount: 0, unknownCount: unknownEntries.length, outOfStock: [], stockUnknown: [],
      totalKnownAmount: null, currency: null, checkedAt: null, stale: null, ageHours: null,
      findings: [{ code: SUPPLY_SUMMARY_CODES.NO_EVIDENCE, severity: 'warning', message: '没有供应链价格/库存证据：下单卡无法给出总价或缺货项（先查价再生成）' }],
    };
  }
  const currencies = [...new Set(entries.map((entry) => text(entry.currency)).filter(Boolean))];
  const mixedCurrency = currencies.length > 1;
  const totalKnownAmount = !mixedCurrency && entries.length && entries.every((entry) => Number.isFinite(Number(entry.price)))
    ? Math.round(entries.reduce((sum, entry) => sum + Number(entry.price), 0) * 100) / 100
    : null;
  const currency = mixedCurrency ? null : (currencies[0] || null);
  const outOfStock = entries.filter((entry) => Number.isFinite(Number(entry.stock)) && Number(entry.stock) <= 0).map((entry) => ({ lcsc: entry.lcsc, stock: Number(entry.stock), price: entry.price ?? null }));
  const stockUnknown = entries.filter((entry) => !Number.isFinite(Number(entry.stock))).map((entry) => ({ lcsc: entry.lcsc, reason: text(entry.stockUnknownReason) || '库存未知' }));
  if (unknownEntries.length) findings.push({ code: SUPPLY_SUMMARY_CODES.PRICE_UNKNOWN, severity: 'warning', message: `${unknownEntries.length} 个料号没有价格证据（总价只能部分合计，不能当整单报价）`, items: unknownEntries.slice(0, 20).map((entry) => ({ lcsc: entry.lcsc, reason: entry.reason || entry.priceUnknownReason || 'unknown' })) });
  if (outOfStock.length) findings.push({ code: SUPPLY_SUMMARY_CODES.STOCK_OUT, severity: 'warning', message: `${outOfStock.length} 个已定价料号库存为 0：下单前必须换料/补货`, items: outOfStock.slice(0, 20) });
  if (stockUnknown.length) findings.push({ code: SUPPLY_SUMMARY_CODES.STOCK_UNKNOWN, severity: 'info', message: `${stockUnknown.length} 个料号库存未知（不是"有货"）`, items: stockUnknown.slice(0, 20) });
  const checkedAt = text(pricing.checkedAt) || null;
  const ageMs = checkedAt ? now - Date.parse(checkedAt) : NaN;
  const ageHours = Number.isFinite(ageMs) ? Math.round((ageMs / HOUR_MS) * 10) / 10 : null;
  const stale = ageHours === null ? null : ageHours > staleAfterHours;
  if (stale === true) findings.push({ code: SUPPLY_SUMMARY_CODES.STALE, severity: 'warning', message: `价格/库存证据已 ${ageHours} 小时（阈值 ${staleAfterHours} 小时）：下单前必须重新查价`, checkedAt, ageHours, staleAfterHours });
  if (stale === null) findings.push({ code: SUPPLY_SUMMARY_CODES.STALE, severity: 'info', message: '证据没有可解析的查询时间：不能判断是否过期，请重新查价', checkedAt });
  if (mixedCurrency) findings.push({ code: SUPPLY_SUMMARY_CODES.MIXED_CURRENCY, severity: 'warning', message: `价格证据混用货币（${currencies.join('、')}）：不做合计，避免把 USD 与 CNY 加在一起`, currencies });
  return {
    schemaVersion: 1,
    kind: 'supply-summary',
    known: totalKnownAmount !== null,
    pricedCount: entries.length,
    unknownCount: unknownEntries.length,
    totalKnownAmount,
    currency,
    outOfStock,
    stockUnknown,
    checkedAt,
    ageHours,
    stale,
    staleAfterHours,
    findings,
  };
}
