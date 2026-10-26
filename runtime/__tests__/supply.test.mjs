/**
 * supply.mjs 的测试。
 *
 * 两条硬规矩：
 *   1. **绝不打网络**：所有请求都走注入的 `fetchImpl`；测试末尾还会断言
 *      `lookupLcscParts` 的默认分支拿到的是注入实现，而不是 `globalThis.fetch`。
 *   2. **绝不假通过**：每个失败场景都要断言"进 unknown 且有原因"，而不是"没抛异常就算过"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPLY_REASONS,
  SUPPLY_SOURCE,
  formatSupplyEvidence,
  lookupLcscParts,
  normalizeLcscId,
  parseJlcComponentRow,
  selectPartFromPayload,
} from '../engineering/supply.mjs';

/** 本机 2026-10-16 实测回包的裁剪版（C23186 = 5.1kΩ 0603）。 */
const realPayload = (overrides = {}) => ({
  code: 200,
  data: {
    componentPageInfo: {
      total: 1,
      list: [{
        componentId: 23913,
        componentLibraryType: 'base',
        componentCode: 'C23186',
        componentModelEn: '0603WAF5101T5E',
        componentBrandEn: 'UNI-ROYAL',
        erpComponentName: '厚膜电阻 5.1kΩ ±1% 100mW',
        componentSource: 'shop',
        stockCount: 23727575,
        minPurchaseNum: 1,
        leastPatchNumber: 20,
        lossNumber: 10,
        lcscGoodsUrl: 'https://www.lcsc.com/product-detail/chip-resistor-surface-mount_uni-royal-uniroyal-elec-0603waf5101t5e_C23186.html',
        componentPrices: [
          { startNumber: 1, endNumber: 999, productPrice: 0.0015 },
          { startNumber: 1000, endNumber: 4999, productPrice: 0.0012 },
          { startNumber: 5000, endNumber: 9999, productPrice: 0.001 },
          { startNumber: 10000, endNumber: -1, productPrice: 0.0008 },
        ],
        ...overrides,
      }],
    },
  },
});

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(payload); },
});

const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return body; },
});

/** 记录调用次数，断言"重试了几次""有没有真的发请求"。 */
const recordingFetch = (handler) => {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url, options }); return handler(url, options, calls.length); };
  impl.calls = calls;
  return impl;
};

test('成功：真实回包 → 价格阶梯/库存/最小起订量/商品页 URL', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload()));
  const cache = new Map();
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl, cache });

  assert.equal(result.source, SUPPLY_SOURCE.id);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.unknown, []);

  const part = result.parts.C23186;
  assert.equal(part.lcscId, 'C23186');
  assert.equal(part.price, 0.0015);
  assert.equal(part.currency, 'USD');
  assert.equal(part.stock, 23727575);
  assert.equal(part.minQty, 1);
  assert.match(part.url, /_C23186\.html$/);
  assert.deepEqual(part.priceBreaks, [
    { startQty: 1, endQty: 999, unitPrice: 0.0015 },
    { startQty: 1000, endQty: 4999, unitPrice: 0.0012 },
    { startQty: 5000, endQty: 9999, unitPrice: 0.001 },
    { startQty: 10000, endQty: null, unitPrice: 0.0008 },
  ]);

  // 请求形状：POST JSON + keyword 就是 C 号（端点要求）
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, SUPPLY_SOURCE.endpoint);
  assert.equal(fetchImpl.calls[0].options.method, 'POST');
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).keyword, 'C23186');

  // 第二次调用命中缓存：不再打网络
  const again = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl, cache });
  assert.equal(fetchImpl.calls.length, 1, '命中缓存后不应再发请求');
  assert.equal(again.parts.C23186.price, 0.0015);
});

test('成功：buyComponentPrices 优先于 componentPrices（贴片实际结算价）', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload({
    buyComponentPrices: [{ startNumber: 1000, endNumber: 4999, productPrice: 0.0011 }],
  })));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  assert.equal(result.parts.C23186.price, 0.0011);
  assert.deepEqual(result.parts.C23186.priceBreaks, [{ startQty: 1000, endQty: 4999, unitPrice: 0.0011 }]);
});

test('HTTP 500：重试一次后进 unknown，绝不给价格', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ code: 500 }, 500));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });

  assert.deepEqual(result.parts, {});
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].lcscId, 'C23186');
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.HTTP_ERROR);
  assert.match(result.unknown[0].detail, /HTTP 500/);
  assert.equal(fetchImpl.calls.length, 2, '5xx 应重试一次');
});

test('HTTP 404 不重试：4xx 重试只会浪费配额', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ code: 404 }, 404));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.HTTP_ERROR);
});

test('超时/中止：AbortError → SUPPLY_TIMEOUT，且不留半截价格', async () => {
  const fetchImpl = recordingFetch(() => {
    // 模拟真实 fetch 在 abort 时的行为（不依赖真实定时器/网络）
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return Promise.reject(error);
  });
  const started = Date.now();
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl, timeoutMs: 50 });
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.TIMEOUT);
  assert.deepEqual(result.parts, {});
  assert.ok(Date.now() - started < 5000, '超时必须是注入实现的即时失败，而不是真等 50ms 网络');
});

test('超时：真实挂起的 fetch 会被 AbortController 打断（不依赖注入实现立即 reject）', async () => {
  let abortedWith = null;
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(jsonResponse(realPayload())), 30_000);
    options.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      abortedWith = options.signal.reason ?? new Error('aborted');
      const error = new Error('aborted');
      error.name = options.signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      reject(error);
    });
  });
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl, timeoutMs: 30 });
  assert.ok(abortedWith, '定时器到点必须真的 abort 掉在途请求');
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.TIMEOUT);
});

test('畸形 JSON：非 JSON 响应 → SUPPLY_MALFORMED_RESPONSE', async () => {
  const fetchImpl = recordingFetch(() => textResponse('<html>WAF challenge</html>'));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.MALFORMED);
  assert.match(result.unknown[0].detail, /非 JSON/);
});

test('结构变了：JSON 但没有 componentPageInfo.list → 同样是畸形而不是"查到 0 条"', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ code: 404, msg: 'The static resource is unavailable.', result: null }));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.MALFORMED);
});

test('未知料号：返回值里没有精确匹配 → SUPPLY_PART_NOT_FOUND，不做模糊替代', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({
    code: 200,
    data: { componentPageInfo: { total: 41, list: [{ componentCode: 'C1396897', stockCount: 0, componentPrices: [{ startNumber: 1, endNumber: -1, productPrice: 0.5 }] }] } },
  }));
  const result = await lookupLcscParts({ lcscIds: ['C999999999'], fetchImpl });
  assert.deepEqual(result.parts, {}, '模糊命中不能当成本料号的价格');
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.NOT_FOUND);
  assert.match(result.unknown[0].detail, /精确匹配/);
});

test('非法料号：不是 Cxxxxx → LCSC_ID_INVALID，且不产生任何请求', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload()));
  const result = await lookupLcscParts({ lcscIds: ['STM32F103C8T6', 'C-1', ''], fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.unknown.length, 2);
  assert.ok(result.unknown.every((item) => item.reason === SUPPLY_REASONS.INVALID_ID));
});

test('价格缺失（行在、价不在）→ price 为 null 并带原因，绝不用 0 冒充', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload({ componentCode: 'C23186', componentPrices: [], buyComponentPrices: [], shopCostPrice: 0 })));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  const part = result.parts.C23186;
  assert.equal(part.price, null);
  assert.notEqual(part.price, 0);
  assert.equal(part.stock, 23727575, '价格缺失不影响库存证据');
  assert.equal(part.priceUnknownReason, SUPPLY_REASONS.NO_PRICE);
  // 没有价格的料号不能进 pricing.entries，否则门禁会以为"有证据"
  const evidence = formatSupplyEvidence(result);
  assert.deepEqual(evidence.entries, []);
  assert.equal(evidence.unknownEntries[0].price, null);
  assert.equal(evidence.unknownEntries[0].reason, undefined, '行在、价不在属于"部分证据"，原因挂在 priceUnknownReason 上');
  assert.equal(evidence.unknownEntries[0].priceUnknownReason, SUPPLY_REASONS.NO_PRICE);
});

test('enabled:false → 一个请求都不发，全部记 DISABLED', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload()));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl, enabled: false });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.DISABLED);
});

test('多颗器件：一颗失败不拖累其它，重复 C 号只查一次', async () => {
  const fetchImpl = recordingFetch((url, options) => {
    const keyword = JSON.parse(options.body).keyword;
    if (keyword === 'C529344') return jsonResponse({ code: 200, data: { componentPageInfo: { total: 0, list: [] } } });
    return jsonResponse(realPayload({ componentCode: keyword, componentPrices: [{ startNumber: 1, endNumber: -1, productPrice: 1.25 }] }));
  });
  const result = await lookupLcscParts({ lcscIds: ['C23186', 'C1525', 'C529344', 'c23186'], fetchImpl });
  assert.deepEqual(Object.keys(result.parts).sort(), ['C1525', 'C23186']);
  assert.equal(result.parts.C1525.price, 1.25);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].lcscId, 'C529344');
  assert.equal(fetchImpl.calls.length, 3, '重复的 c23186 只查一次');
});

test('normalizeLcscId：容错但绝不猜测', () => {
  assert.equal(normalizeLcscId(' c23186 '), 'C23186');
  assert.equal(normalizeLcscId('23186'), 'C23186');
  assert.equal(normalizeLcscId('C9999999999999999999'), null);
  assert.equal(normalizeLcscId('UNKNOWN'), null);
  assert.equal(normalizeLcscId(null), null);
});

test('selectPartFromPayload / parseJlcComponentRow 的边界', () => {
  assert.equal(selectPartFromPayload(null, 'C23186').reason, SUPPLY_REASONS.MALFORMED);
  assert.equal(selectPartFromPayload(realPayload(), 'C1525').reason, SUPPLY_REASONS.NOT_FOUND);
  assert.equal(parseJlcComponentRow(realPayload().data.componentPageInfo.list[0], { lcscId: 'C1525' }), null, 'C 号不一致必须拒绝');
  assert.equal(parseJlcComponentRow(null, { lcscId: 'C23186' }), null);
  // 阶梯价全为 0 时，价格必须是 null 而不是 0
  const zero = parseJlcComponentRow({ componentCode: 'C1', componentPrices: [{ startNumber: 1, endNumber: -1, productPrice: 0 }], stockCount: 5 }, { lcscId: 'C1' });
  assert.equal(zero.price, null);
  assert.equal(zero.stock, 5);
});

test('formatSupplyEvidence：映射成 gateSupply 认得的形状，并能真的通过门禁', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(realPayload()));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  const evidence = formatSupplyEvidence(result);

  assert.deepEqual(Object.keys(evidence.entries[0]).filter((key) => ['lcsc', 'price', 'currency', 'stock'].includes(key)).sort(), ['currency', 'lcsc', 'price', 'stock']);
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.entries[0].lcsc, 'C23186');
  assert.equal(evidence.entries[0].status, 'priced');
  assert.equal(evidence.entries[0].checkedAt, result.checkedAt);
  assert.equal(evidence.freshnessKnown, true);
  assert.deepEqual(evidence.summary, { requested: 1, priced: 1, unknown: 0 });

  const { gateSupply } = await import('../release-gate.mjs');
  const bom = { headers: ['Designator', 'Supplier Part'], rows: [{ Designator: 'R1', 'Supplier Part': 'C23186' }] };
  const gate = gateSupply({ bom, pricing: evidence });
  assert.equal(gate.status, 'pass', JSON.stringify(gate.findings));
  assert.equal(gate.evidence.priced, 1);
});

test('formatSupplyEvidence：部分查不到 → 门禁逐颗点名，绝不把未知当"有证据"', async () => {
  const fetchImpl = recordingFetch((url, options) => {
    const keyword = JSON.parse(options.body).keyword;
    if (keyword === 'C23186') return jsonResponse(realPayload());
    // 关键词搜索的模糊结果：没有一条 componentCode 等于请求的 C 号
    return jsonResponse({ code: 200, data: { componentPageInfo: { total: 41, list: [{ componentCode: 'C1396897', stockCount: 0 }] } } });
  });
  const result = await lookupLcscParts({ lcscIds: ['C23186', 'C529344', 'nope'], fetchImpl });
  const evidence = formatSupplyEvidence(result);

  assert.deepEqual(evidence.entries.map((entry) => entry.lcsc), ['C23186']);
  assert.equal(evidence.freshnessKnown, true, '有带时间的真实证据即可判定新鲜度');
  assert.deepEqual(evidence.summary, { requested: 3, priced: 1, unknown: 2 });
  assert.ok(evidence.unknownEntries.every((entry) => entry.price === null && entry.reason));
  const reasons = evidence.unknownEntries.map((entry) => entry.reason).sort();
  assert.deepEqual(reasons, [SUPPLY_REASONS.INVALID_ID, SUPPLY_REASONS.NOT_FOUND].sort());

  const { gateSupply } = await import('../release-gate.mjs');
  const bom = {
    headers: ['Designator', 'Supplier Part'],
    rows: [{ Designator: 'R1', 'Supplier Part': 'C23186' }, { Designator: 'U1', 'Supplier Part': 'C529344' }],
  };
  const gate = gateSupply({ bom, pricing: evidence });
  assert.equal(gate.status, 'warn');
  assert.match(gate.findings[0].message, /C529344/, '查不到的料号必须被点名，而不是静默放过');
});

test('formatSupplyEvidence：一条真实证据都没有 → 门禁输出"不猜价格"警告', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ code: 200, data: { componentPageInfo: { total: 41, list: [{ componentCode: 'C1396897', stockCount: 0 }] } } }));
  const result = await lookupLcscParts({ lcscIds: ['C999999'], fetchImpl });
  const evidence = formatSupplyEvidence(result);

  assert.deepEqual(evidence.entries, []);
  assert.equal(evidence.freshnessKnown, false, '没有任何带时间的证据时不能说"新鲜度已知"');

  const { gateSupply } = await import('../release-gate.mjs');
  const bom = { headers: ['Designator', 'Supplier Part'], rows: [{ Designator: 'R1', 'Supplier Part': 'C23186' }] };
  const gate = gateSupply({ bom, pricing: evidence });
  assert.equal(gate.status, 'warn');
  assert.match(gate.findings[0].message, /不猜价格/);
});

test('formatSupplyEvidence：空结果也要是合法证据（不抛异常）', () => {
  const evidence = formatSupplyEvidence(null);
  assert.deepEqual(evidence.entries, []);
  assert.deepEqual(evidence.unknownEntries, []);
  assert.equal(evidence.checkedAt, null);
  assert.equal(evidence.freshnessKnown, false);
  assert.equal(evidence.source, SUPPLY_SOURCE.id);
});

test('不打真实网络：默认 fetchImpl 缺失时明确报错，不偷偷用 globalThis.fetch', async () => {
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl: null });
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.DISABLED);
  // 显式传 undefined 会退回 globalThis.fetch（生产路径）；测试里一律显式注入，避免真打网络
  assert.equal(typeof globalThis.fetch, 'function');
});

test('断网/连接失败：TypeError: fetch failed → SUPPLY_HTTP_ERROR', async () => {
  const fetchImpl = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
  const result = await lookupLcscParts({ lcscIds: ['C23186'], fetchImpl });
  assert.equal(result.unknown[0].reason, SUPPLY_REASONS.HTTP_ERROR);
  assert.match(result.unknown[0].detail, /fetch failed/);
});
