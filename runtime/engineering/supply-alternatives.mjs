/**
 * B9：缺货/过期料号的**替代候选**（来自真实关键词检索）。
 *
 * 纪律（fail-closed，宁可少列不可瞎列）：
 *   1. 候选来自真实接口关键词命中（searchLcscByKeyword），**不是本地编的"相似型号"**；
 *   2. 关键词命中 ≠ 等价替代：每条显式带 `equivalence:'unverified'`，等价性必须由人/工程确认；
 *   3. 原料号本身永远排除；库存为 0 或未知的候选保留但排序靠后并标 `inStock:false/stockUnknown`；
 *   4. 查询失败/关键词无效逐条记录原因（不整体成功、不伪造空数组）；
 *   5. 最多每批 10 个缺料、每个 5 个候选，避免一次点击打出请求风暴。
 */
export const ALTERNATIVES_CODES = Object.freeze({
  QUERY_INVALID: 'ALTERNATIVES_QUERY_INVALID',
  LOOKUP_FAILED: 'ALTERNATIVES_LOOKUP_FAILED',
  EMPTY: 'ALTERNATIVES_EMPTY',
});

const MAX_ITEMS = 10;
const MAX_CANDIDATES = 5;

/** 从 BOM/器件行构造关键词：优先真实型号（MPN），否则 value + package。小于 2 字符返回 null。 */
export function buildAlternativeQuery(item = {}) {
  const model = String(item.model || item.mpn || '').trim();
  const value = String(item.value || '').trim();
  const packageName = String(item.package || '').trim();
  const query = model || [value, packageName].filter(Boolean).join(' ');
  return query.length >= 2 ? query : null;
}

/**
 * 排序 + 过滤。排序不是"推荐"，只是把更可能可用的放前面：
 * 有正库存 > 库存未知 > 库存 0；同档按价格升序（未知价最后），最后按 C 号稳定排序。
 */
export function rankAlternativeRows({ rows = [], excludeLcscIds = [], maxCandidates = MAX_CANDIDATES } = {}) {
  const excluded = new Set((Array.isArray(excludeLcscIds) ? excludeLcscIds : []).map((item) => String(item).toUpperCase()));
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const lcscId = String(row?.lcscId || '').toUpperCase();
    if (!lcscId || excluded.has(lcscId) || seen.has(lcscId)) continue;
    seen.add(lcscId);
    const stock = row.stock === null || row.stock === undefined ? null : (Number.isFinite(Number(row.stock)) ? Number(row.stock) : null);
    const price = Number.isFinite(Number(row.price)) && Number(row.price) > 0 ? Number(row.price) : null;
    candidates.push({
      lcscId,
      model: row.model ?? null,
      package: row.package ?? null,
      brand: row.brand ?? null,
      description: row.description ?? null,
      price,
      currency: row.currency ?? null,
      stock,
      minQty: row.minQty ?? null,
      url: row.url ?? null,
      checkedAt: row.checkedAt ?? null,
      source: row.source ?? null,
      match: 'keyword',
      equivalence: 'unverified',
      inStock: stock !== null && stock > 0,
      stockUnknown: stock === null,
    });
  }
  const rank = (item) => (item.inStock ? 0 : item.stockUnknown ? 1 : 2);
  candidates.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.inStock && b.inStock && a.stock !== b.stock) return b.stock - a.stock;
    if (a.price !== b.price) return (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY);
    return a.lcscId.localeCompare(b.lcscId);
  });
  return candidates.slice(0, Math.max(1, Number(maxCandidates) || MAX_CANDIDATES));
}

/**
 * 对一批缺料查替代候选。
 * @param {object} input
 * @param {Array<{lcscId?:string,mpn?:string,value?:string,package?:string}>} input.items
 * @param {(input:{query:string})=>Promise<{rows:Array,checkedAt:string,source:string}>} input.search 注入的检索（测试必注入；生产用 searchLcscByKeyword 包装）
 * @param {(item:object)=>string[]} [input.excludeForItem] 每个 item 要额外排除的 C 号
 */
export async function findAlternatives({ items = [], search, excludeForItem = () => [], maxCandidates = MAX_CANDIDATES } = {}) {
  if (typeof search !== 'function') throw Object.assign(new Error('缺少检索实现'), { code: ALTERNATIVES_CODES.LOOKUP_FAILED });
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  const results = [];
  for (const item of list) {
    const lcscId = String(item?.lcscId || '').trim().toUpperCase() || null;
    const query = buildAlternativeQuery(item);
    if (!query) {
      results.push({ lcscId, query: null, status: 'invalid', code: ALTERNATIVES_CODES.QUERY_INVALID, message: '没有可用于检索的型号/值+封装（关键词至少 2 字符）', candidates: [] });
      continue;
    }
    try {
      const found = await search({ query });
      const candidates = rankAlternativeRows({ rows: found?.rows ?? [], excludeLcscIds: [lcscId, ...excludeForItem(item)].filter(Boolean), maxCandidates });
      results.push({
        lcscId, query, status: candidates.length ? 'found' : 'empty',
        ...(candidates.length ? {} : { code: ALTERNATIVES_CODES.EMPTY, message: '关键词有响应但没有可列出的候选（可能全部被排除/无 C 号）' }),
        checkedAt: found?.checkedAt ?? null,
        source: found?.source ?? null,
        candidates,
      });
    } catch (error) {
      results.push({ lcscId, query, status: 'failed', code: error?.code || ALTERNATIVES_CODES.LOOKUP_FAILED, message: String(error?.message || error).slice(0, 300), candidates: [] });
    }
  }
  return {
    results,
    summary: {
      requested: list.length,
      found: results.filter((item) => item.status === 'found').length,
      empty: results.filter((item) => item.status === 'empty').length,
      invalid: results.filter((item) => item.status === 'invalid').length,
      failed: results.filter((item) => item.status === 'failed').length,
      candidates: results.reduce((sum, item) => sum + item.candidates.length, 0),
    },
  };
}
