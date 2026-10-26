/**
 * 供应链证据：立创/嘉立创料号（Cxxxxx）的价格与库存。
 *
 * ## 为什么有这个文件
 *
 * 出生产文件之前，BOM 里每一颗器件都必须回答两个问题：**多少钱**、**有没有货**。
 * 这两个数字一旦靠猜，后果不是"报告难看"，而是**拿着错的成本或缺货的料去下单**。
 * 所以本模块只做一件事：把**真实查到**的价格/库存搬回来，查不到就明说查不到，
 * 绝不用 `0`、`null` 冒充价格，也绝不编造一个"看起来合理"的阶梯价。
 *
 * ## 数据源（本机实测，2026-10-16）
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList` | **200，真实价格阶梯 + 库存**（见下） |
 * | `https://wmsc.lcsc.com/wmsc/search/global?keyword=C23186` | `{"code":404,"msg":"The static resource is unavailable..."}` —— 免申请接口已失效 |
 * | `https://wwwapi.lcsc.com/v1/products/...` | 本机 TLS 直接失败（无法确认入口） |
 * | `https://so.szlcsc.com` / `https://list.szlcsc.com` | WAF 拦截（返回 JS 挑战页，没有数据） |
 * | 本机 EDA bridge `lib_Device.getByLcscIds(['C23186'])` | 只有 LCSC Part Name / Supplier Part / JLCPCB Part Class / Datasheet，**没有价格、没有库存** |
 *
 * 上面那条 JLC 接口在同一集团（嘉立创/立创商城）的 SMT 下单链路上，服务端返回的就是
 * 立创商城的在售价格与库存（`componentSource: "shop"`，`lcscGoodsUrl` 指向立创商城商品页）。
 * 它仍然是**第三方接口、随时可能变**：因此这里把端点、来源、查询时间都写进返回值，
 * 上层据此判断证据是否还能用；接口变了就退化成"价格未知"，而不是悄悄给出旧数。
 *
 * ## 设计约束
 *
 * - **零依赖**：只用 `node:` 内置模块 + 全局 `fetch`；`fetchImpl` 可注入，测试永不打网络。
 * - **单点失败不影响整批**：一颗器件查不到，其它照查；失败的进 `unknown` 并带原因。
 * - **不做"最像的那个"匹配**：关键词搜索会返回模糊结果（查 `C999999999` 会返回 41 条别的料），
 *   因此只接受 `componentCode` 与请求 C 号**完全一致**的行。
 */
import { setTimeout as delay } from 'node:timers/promises';

/** 证据来源标识：写进返回值，方便上层与审计判断"这份价格是哪来的"。 */
export const SUPPLY_SOURCE = Object.freeze({
  id: 'jlcpcb-smt-component-api',
  label: '嘉立创/立创商城 SMT 选料接口（componentSource=shop）',
  endpoint: 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',
  /** 该端点在 2026-10-16 于本机实测返回真实价格阶梯与库存；不构成对它长期可用的承诺。 */
  verifiedAt: '2026-10-16',
});

export const SUPPLY_REASONS = Object.freeze({
  INVALID_ID: 'LCSC_ID_INVALID',
  NOT_FOUND: 'LCSC_PART_NOT_FOUND',
  HTTP_ERROR: 'SUPPLY_HTTP_ERROR',
  TIMEOUT: 'SUPPLY_TIMEOUT',
  MALFORMED: 'SUPPLY_MALFORMED_RESPONSE',
  NO_PRICE: 'SUPPLY_PRICE_MISSING',
  DISABLED: 'SUPPLY_LOOKUP_DISABLED',
});

const DEFAULT_TIMEOUT_MS = 8000;
/** 同一目标并发上限：单批 20 颗也不会把对端打成"请求风暴"。 */
const MAX_CONCURRENCY = 4;
/** 每个请求之间的礼貌间隔（毫秒）。免申请接口更要克制。 */
const POLITE_GAP_MS = 250;
/** 429/5xx 重试次数与基础退避。 */
const MAX_ATTEMPTS = 2;
const RETRY_BASE_MS = 600;
/** 缓存默认有效期（毫秒）：价格/库存过期比没有更危险，所以默认很短。 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

const C_ID = /^C\d{1,12}$/i;
const now = () => new Date().toISOString();
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const finite = (value) => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));

/** 价格保留 6 位小数：真实阶梯价到 0.0001 USD，四舍五入不能把 0.00001 变成 0。 */
const roundPrice = (value) => Number(Number(value).toFixed(6));
const intOrNull = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null);

/** 归一化 C 号：大写、去空格。非 C 号返回 null（不猜、不去模糊匹配）。 */
export function normalizeLcscId(value) {
  const raw = text(value).toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const withPrefix = C_ID.test(raw) ? raw : (C_ID.test(`C${raw}`) ? `C${raw}` : null);
  return withPrefix;
}

const normalizeIdList = (lcscIds) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(lcscIds) ? lcscIds : []) {
    const id = normalizeLcscId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/**
 * 缓存读写。`cache` 可以是 Map（键：C 号，值：`{ at, part }`），
 * 也可以是普通对象（键为 C 号，值带毫秒时间戳）。同一进程内跨调用复用。
 */
function cacheGet(cache, key, ttlMs) {
  if (!cache) return null;
  let hit;
  try {
    hit = cache instanceof Map ? cache.get(key) : cache[key];
  } catch { return null; }
  if (!hit || typeof hit !== 'object') return null;
  const at = Number(hit.at);
  if (!Number.isFinite(at)) return null;
  if (Date.now() - at > ttlMs) return null;
  return hit.part && typeof hit.part === 'object' ? hit.part : null;
}

function cacheSet(cache, key, part) {
  if (!cache) return;
  try {
    const record = { at: Date.now(), part };
    if (cache instanceof Map) cache.set(key, record);
    else cache[key] = record;
  } catch { /* 缓存写失败不该让查询失败 */ }
}

const isTimeoutError = (error) => error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'SUPPLY_TIMEOUT';

/**
 * 单次 HTTP。所有失败都翻译成带 `code` 的错误，调用方据此决定重试与原因码。
 * 超时用 `AbortController`（兼容注入的 fetch，不依赖 `AbortSignal.timeout`）。
 */
async function httpJson(url, { fetchImpl, timeoutMs, method = 'GET', headers = null, body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: headers || undefined,
      body: body ?? undefined,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw Object.assign(new Error(`供应链查询超时（${timeoutMs}ms）`), { code: SUPPLY_REASONS.TIMEOUT });
    }
    throw Object.assign(new Error(`供应链查询失败：${text(error?.message) || '网络错误'}`), { code: SUPPLY_REASONS.HTTP_ERROR });
  } finally {
    clearTimeout(timer);
  }
  let payloadText = '';
  try {
    payloadText = await response.text();
  } catch (error) {
    if (isTimeoutError(error)) throw Object.assign(new Error(`读取供应链响应超时（${timeoutMs}ms）`), { code: SUPPLY_REASONS.TIMEOUT });
    throw Object.assign(new Error(`读取供应链响应失败：${text(error?.message) || '连接中断'}`), { code: SUPPLY_REASONS.HTTP_ERROR });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`供应链接口返回 HTTP ${response.status}`), {
      code: SUPPLY_REASONS.HTTP_ERROR, status: response.status, body: payloadText.slice(0, 300),
    });
  }
  try {
    return JSON.parse(payloadText);
  } catch {
    throw Object.assign(new Error('供应链接口返回了非 JSON 响应'), { code: SUPPLY_REASONS.MALFORMED });
  }
}

/** 429 / 5xx 才值得重试；4xx（除 429）是请求本身的问题，重试只会浪费配额。 */
const isRetryable = (error) => error?.status === 429 || (Number.isFinite(error?.status) && error.status >= 500);

/**
 * 把端点返回的一行归一化成"已确认的价格/库存"。
 *
 * 铁律：**没有正数价格就没有价格**。行里价格缺失或为 0 时 `price: null` + `priceUnknownReason`，
 * 而不是给个 0 让下游当"免费"。
 */
export function parseJlcComponentRow(row, { lcscId, checkedAt = now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const code = normalizeLcscId(row.componentCode);
  if (!code || (lcscId && code !== lcscId)) return null; // 模糊匹配一律拒绝

  const breakSource = Array.isArray(row.buyComponentPrices) && row.buyComponentPrices.length
    ? row.buyComponentPrices
    : (Array.isArray(row.componentPrices) ? row.componentPrices : []);
  const priceBreaks = breakSource
    .filter((item) => item && finite(item.productPrice) && Number(item.productPrice) > 0)
    .map((item) => ({
      startQty: intOrNull(item.startNumber) ?? 1,
      endQty: Number(item.endNumber) < 0 ? null : intOrNull(item.endNumber),
      unitPrice: roundPrice(item.productPrice),
    }))
    .sort((a, b) => a.startQty - b.startQty);
  // 去掉重复起始量（端点偶尔把同一档返回两次）
  const deduped = priceBreaks.filter((item, index) => index === 0 || item.startQty !== priceBreaks[index - 1].startQty);

  const firstBreak = deduped[0] || null;
  const rowPrice = finite(row.shopCostPrice) && Number(row.shopCostPrice) > 0 ? Number(row.shopCostPrice) : null;
  const price = firstBreak?.unitPrice ?? rowPrice;
  const minQty = intOrNull(row.minPurchaseNum) ?? intOrNull(row.preMinPurchaseNum) ?? firstBreak?.startQty ?? null;
  const stockRaw = intOrNull(row.stockCount);

  return {
    lcscId: code,
    price: price === null ? null : roundPrice(price),
    currency: 'USD', // 该端点返回美元（国际站口径）；货币写死在这里，不允许下游猜
    priceBreaks: deduped.length ? deduped : undefined,
    stock: stockRaw,
    minQty,
    // ---- 检索用的元数据（B9 替代候选）：端点原样字段，缺失就是 undefined，不猜 ----
    model: text(row.componentModelEn) || text(row.componentModel) || undefined,
    package: text(row.componentSpecificationEn) || text(row.componentSpecification) || undefined,
    brand: text(row.componentBrandEn) || text(row.componentBrand) || undefined,
    description: text(row.erpComponentName) || text(row.describe) || undefined,
    url: text(row.lcscGoodsUrl) || undefined,
    // ---- 诚实性元数据（不属于门禁格式，但被 evidence 原样带出去）----
    checkedAt,
    source: SUPPLY_SOURCE.id,
    ...(price === null
      ? { priceUnknownReason: SUPPLY_REASONS.NO_PRICE, priceUnknownDetail: '接口返回的行里没有正数价格（阶梯价与单价都为空）：价格未知，不是 0' }
      : {}),
    ...(stockRaw === null
      ? { stockUnknownReason: 'SUPPLY_STOCK_MISSING', stockUnknownDetail: '接口返回的行里没有库存字段：库存未知，不是 0' }
      : {}),
  };
}

/** 从原始 payload 里按精确 C 号取行。返回 `{ row }` 或 `{ reason, detail }`。 */
export function selectPartFromPayload(payload, lcscId) {
  const list = payload?.data?.componentPageInfo?.list;
  if (!Array.isArray(list)) {
    return { reason: SUPPLY_REASONS.MALFORMED, detail: '响应里没有 data.componentPageInfo.list（接口结构可能已变）' };
  }
  const row = list.find((item) => normalizeLcscId(item?.componentCode) === lcscId);
  if (!row) {
    return {
      reason: SUPPLY_REASONS.NOT_FOUND,
      detail: `接口返回 ${list.length} 条结果但没有 componentCode=${lcscId} 的精确匹配（不做模糊替代）`,
    };
  }
  return { row };
}

/**
 * 查询一批 LCSC 料号的价格与库存。
 *
 * @param {object} [options]
 * @param {string[]} [options.lcscIds] C 号数组
 * @param {typeof fetch} [options.fetchImpl] 注入的 fetch（测试必用；默认 globalThis.fetch）
 * @param {number} [options.timeoutMs] 单请求超时
 * @param {Map|object|null} [options.cache] 可选缓存（见 `cacheGet`）
 * @param {number} [options.cacheTtlMs] 缓存有效期
 * @param {boolean} [options.enabled] 置 false 时一个网络请求都不发（离线/隐私模式）
 * @returns {Promise<{source:string, sourceLabel:string, endpoint:string, checkedAt:string, parts:Record<string,object>, unknown:{lcscId:string,reason:string,detail:string}[]}>}
 */
export async function lookupLcscParts({
  lcscIds = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cache = null,
  cacheTtlMs = DEFAULT_TTL_MS,
  enabled = true,
} = {}) {
  const checkedAt = now();
  const ids = normalizeIdList(lcscIds);
  const requested = Array.isArray(lcscIds) ? lcscIds : [];
  const parts = {};
  const unknown = [];

  // 输入里非法的 C 号也要有交代：静默丢弃等于"这颗器件凭空消失"。
  const requestedRaw = requested.filter((item) => text(item));
  const invalid = requestedRaw.filter((item) => !normalizeLcscId(item));
  for (const raw of new Set(invalid)) {
    unknown.push({ lcscId: text(raw), reason: SUPPLY_REASONS.INVALID_ID, detail: '不是 LCSC 料号（应形如 C23186），不做猜测匹配' });
  }

  const result = {
    source: SUPPLY_SOURCE.id,
    sourceLabel: SUPPLY_SOURCE.label,
    endpoint: SUPPLY_SOURCE.endpoint,
    checkedAt,
    parts,
    unknown,
  };

  if (!ids.length) return result;
  if (typeof fetchImpl !== 'function') {
    // 显式传 null/非函数 = 拒绝出网；省略参数才会退回 globalThis.fetch（生产路径）。
    for (const id of ids) unknown.push({ lcscId: id, reason: SUPPLY_REASONS.DISABLED, detail: '没有可用的 fetch 实现（Node 版本不支持全局 fetch，或调用方显式传了非函数）：未做任何查询' });
    return result;
  }
  if (enabled !== true) {
    for (const id of ids) unknown.push({ lcscId: id, reason: SUPPLY_REASONS.DISABLED, detail: '供应链查询被显式关闭：未做任何网络请求' });
    return result;
  }

  const pending = [];
  for (const id of ids) {
    const cached = cacheGet(cache, id, cacheTtlMs);
    if (cached) {
      parts[id] = cached;
      continue;
    }
    pending.push(id);
  }

  const fetchOne = async (id) => {
    const body = JSON.stringify({
      currentPage: 1,
      pageSize: 20,
      keyword: id,
      componentLibraryType: null,
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      origin: 'https://jlcpcb.com',
      referer: 'https://jlcpcb.com/',
    };
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const payload = await httpJson(SUPPLY_SOURCE.endpoint, { fetchImpl, timeoutMs, method: 'POST', headers, body });
        const selected = selectPartFromPayload(payload, id);
        if (!selected.row) return { id, error: Object.assign(new Error(selected.detail), { code: selected.reason }) };
        const part = parseJlcComponentRow(selected.row, { lcscId: id, checkedAt });
        if (!part) return { id, error: Object.assign(new Error('解出的行与请求的料号不一致（接口结构可能已变）'), { code: SUPPLY_REASONS.MALFORMED }) };
        return { id, part };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
        await delay(RETRY_BASE_MS * attempt);
      }
    }
    return { id, error: lastError || Object.assign(new Error('未知失败'), { code: SUPPLY_REASONS.HTTP_ERROR }) };
  };

  // 有界并发：不设上限的话 200 颗 BOM 会瞬间打出一个请求风暴。
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const id = pending[index];
      if (index > 0) await delay(POLITE_GAP_MS);
      const outcome = await fetchOne(id);
      if (outcome.part) {
        parts[id] = outcome.part;
        cacheSet(cache, id, outcome.part);
      } else {
        unknown.push({ lcscId: id, reason: outcome.error?.code || SUPPLY_REASONS.HTTP_ERROR, detail: text(outcome.error?.message) || '查询失败' });
      }
    }
  });
  await Promise.all(workers);

  unknown.sort((a, b) => String(a.lcscId).localeCompare(String(b.lcscId)));
  return result;
}

/**
 * 把查询结果整理成 `gateSupply()` 认得的 pricing 证据。
 *
 * `runtime/release-gate.mjs` 只读三个字段：
 *   - `pricing.entries[]`，每条用 `lcsc` 标识料号（命中即算"这颗粒有价格/库存记录"）；
 *   - `pricing.freshnessKnown`，为 `false` 时告警"没有更新时间"；
 *   - 整体为空时告警"没有价格/库存证据……本系统不猜价格"。
 * 因此这里的形状**必须**是 `{ entries, freshnessKnown, ... }`，不能自创字段名。
 *
 * 只有**真的查到**（有正价格）的料号才进 `entries`：查不到的进 `unknownEntries`，
 * 既不会让门禁误以为"有证据"，也不会把未知悄悄丢掉。
 */
export function formatSupplyEvidence(result) {
  const checkedAt = text(result?.checkedAt) || null;
  const parts = result?.parts && typeof result.parts === 'object' ? result.parts : {};
  const entries = [];
  const unknownEntries = [];

  for (const [key, part] of Object.entries(parts)) {
    const lcsc = normalizeLcscId(part?.lcscId || key) || String(key).toUpperCase();
    const hasPrice = finite(part?.price) && Number(part.price) > 0;
    const entry = {
      lcsc,
      status: hasPrice ? 'priced' : 'unknown',
      price: hasPrice ? roundPrice(part.price) : null,
      currency: text(part?.currency) || null,
      stock: Number.isFinite(Number(part?.stock)) ? Math.trunc(Number(part.stock)) : null,
      minQty: intOrNull(part?.minQty),
      source: text(part?.source) || text(result?.source) || null,
      checkedAt: text(part?.checkedAt) || checkedAt,
    };
    if (Array.isArray(part?.priceBreaks) && part.priceBreaks.length) {
      entry.priceBreaks = part.priceBreaks.map((item) => ({ ...item }));
    }
    if (text(part?.url)) entry.url = text(part.url);
    // 价格未知的原因要一路带到报告里，避免下游把 null 读成"0 元"
    if (!hasPrice && text(part?.priceUnknownReason)) entry.priceUnknownReason = text(part.priceUnknownReason);
    if (entry.stock === null && text(part?.stockUnknownReason)) entry.stockUnknownReason = text(part.stockUnknownReason);
    if (hasPrice) entries.push(entry);
    else unknownEntries.push(entry);
  }

  for (const item of Array.isArray(result?.unknown) ? result.unknown : []) {
    unknownEntries.push({
      lcsc: normalizeLcscId(item?.lcscId) || text(item?.lcscId) || null,
      status: 'unknown',
      price: null,
      currency: null,
      stock: null,
      minQty: null,
      source: text(result?.source) || null,
      checkedAt,
      reason: text(item?.reason) || SUPPLY_REASONS.HTTP_ERROR,
      detail: text(item?.detail) || null,
    });
  }

  const freshnessKnown = entries.length > 0 && entries.every((entry) => Boolean(entry.checkedAt));
  return {
    kind: 'supply-pricing-evidence',
    schemaVersion: 1,
    source: text(result?.source) || SUPPLY_SOURCE.id,
    ...(text(result?.sourceLabel) ? { sourceLabel: text(result.sourceLabel) } : {}),
    ...(text(result?.endpoint) ? { endpoint: text(result.endpoint) } : {}),
    checkedAt,
    freshnessKnown,
    /** 门禁认这个字段名 —— 只有真查到价格的料号在这里。 */
    entries,
    /** 本模块额外的诚实字段：查不到的料号 + 原因（门禁忽略，人要看）。 */
    unknownEntries,
    summary: {
      requested: entries.length + unknownEntries.length,
      priced: entries.length,
      unknown: unknownEntries.length,
    },
  };
}

/**
 * B9：关键词检索（替代料候选）。与精确查询严格分开：
 *   - 精确查询（lookupLcscParts）只认 componentCode 与请求 C 号完全一致；
 *   - 这里返回的是**关键词命中的多行**，每行仍按 parseJlcComponentRow 归一化（无价格/库存就标未知），
 *     但调用方**不得**把关键词命中当成"等价替代"——等价性需要工程确认，结果里显式标 unmatched。
 *
 * 失败一律抛带 code 的错误（与 httpJson 共用 SUPPLY_REASONS），不返回空成功。
 */
export async function searchLcscByKeyword({ query, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, pageSize = 20 } = {}) {
  const keyword = text(query);
  if (keyword.length < 2) throw Object.assign(new Error('关键词至少 2 个字符'), { code: SUPPLY_REASONS.MALFORMED, detail: 'ALTERNATIVE_QUERY_INVALID' });
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('没有可用的 fetch 实现：未做任何查询'), { code: SUPPLY_REASONS.DISABLED });
  const checkedAt = now();
  const body = JSON.stringify({ currentPage: 1, pageSize: Math.max(1, Math.min(50, Number(pageSize) || 20)), keyword, componentLibraryType: null });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    origin: 'https://jlcpcb.com',
    referer: 'https://jlcpcb.com/',
  };
  const payload = await httpJson(SUPPLY_SOURCE.endpoint, { fetchImpl, timeoutMs, method: 'POST', headers, body });
  const list = payload?.data?.componentPageInfo?.list;
  if (!Array.isArray(list)) {
    throw Object.assign(new Error('响应里没有 data.componentPageInfo.list（接口结构可能已变）'), { code: SUPPLY_REASONS.MALFORMED });
  }
  const rows = [];
  for (const row of list) {
    const part = parseJlcComponentRow(row, { checkedAt });
    if (part) rows.push(part);
  }
  return {
    source: SUPPLY_SOURCE.id,
    sourceLabel: SUPPLY_SOURCE.label,
    endpoint: SUPPLY_SOURCE.endpoint,
    checkedAt,
    query: keyword,
    rawCount: list.length,
    rows,
  };
}
