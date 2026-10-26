/**
 * 扩展市场 provider（market-api）。
 *
 * 2026-10-23 真机侦察结论（docs/design/extension-market/recon.md §2）：
 *   GET https://pro.lceda.cn/api/extensions/editor/search?page=1&pageSize=20[&keywords=x]
 *   匿名可读，无需 cookie/token；result={page,pageSize,total,totalPage,lists[]}。
 *   - 列表字段含 display_name/name/uuid/version/publisher/install_num/file_path/updated_at；
 *   - engines.eda / change_log / categories / keywords 只在 detail 接口里 → 本 provider 不臆造，
 *     列表层拿不到的字段一律 null/unknown。
 *
 * 边界：
 *   - 只允许 GET；不携带任何登录态；不下载 .eext；
 *   - 失败抛结构化错误码，由上层失败隔离；
 *   - 默认关闭（上层用 CIRCUITPILOT_EXTENSION_MARKET=on 才装配），与项目“联网默认关闭”的作风一致。
 */
export const MARKET_API_CODES = Object.freeze({
  DISABLED: 'EXT_MARKET_DISABLED',
  UNAVAILABLE: 'EXT_SOURCE_UNAVAILABLE',
  PARSE_FAILED: 'EXT_SOURCE_PARSE_FAILED',
  HTTP_ERROR: 'EXT_SOURCE_HTTP_ERROR',
});

export const MARKET_SEARCH_URL = 'https://pro.lceda.cn/api/extensions/editor/search';
export const MARKET_ITEM_URL = 'https://jlc-ext.com/';

const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });

/** 构造 provider；fetchImpl 可注入（测试/离线夹具）。 */
export function createMarketApiProvider({ fetchImpl = globalThis.fetch, enabled = true, page = 1, pageSize = 50, keywords = '', timeoutMs = 12_000 } = {}) {
  return Object.freeze({
    id: 'market-catalog',
    kind: 'market-api',
    source: MARKET_SEARCH_URL,
    readOnly: true,
    timeoutMs,
    async run() {
      if (!enabled) throw coded(MARKET_API_CODES.DISABLED, '市场采集被策略关闭（CIRCUITPILOT_EXTENSION_MARKET!=on）');
      if (typeof fetchImpl !== 'function') throw coded(MARKET_API_CODES.UNAVAILABLE, '当前运行环境没有 fetch');
      const url = new URL(MARKET_SEARCH_URL);
      url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
      url.searchParams.set('pageSize', String(Math.max(1, Math.min(100, Number(pageSize) || 50))));
      if (String(keywords).trim()) url.searchParams.set('keywords', String(keywords).trim());
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
      } catch (error) {
        throw coded(MARKET_API_CODES.UNAVAILABLE, `市场接口不可达：${String(error?.message || error).slice(0, 160)}`);
      }
      if (!response?.ok) throw coded(MARKET_API_CODES.HTTP_ERROR, `市场接口返回 HTTP ${response?.status ?? 'unknown'}`, { status: response?.status ?? null });
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw coded(MARKET_API_CODES.PARSE_FAILED, `市场接口返回非 JSON：${String(error?.message || error).slice(0, 160)}`);
      }
      const lists = payload?.result?.lists;
      if (!Array.isArray(lists)) throw coded(MARKET_API_CODES.PARSE_FAILED, '市场接口缺少 result.lists');
      return {
        items: lists,
        degraded: null,
        meta: {
          total: Number(payload?.result?.total) || lists.length,
          page: Number(payload?.result?.page) || page,
          pageSize: Number(payload?.result?.pageSize) || pageSize,
          // 列表接口不返回兼容范围/更新日志：明确标注缺字段，后续按需走 detail 接口补。
          missingFields: ['engines.eda', 'categories', 'keywords', 'change_log'],
          help: '需要兼容版本时改走 GET /api/extensions/detail?uuid=&version=',
        },
      };
    },
  });
}

/** 把市场列表项归一化成能力卡（不猜详情字段）。 */
export function marketItemToCapability(item = {}, { now = () => new Date(), edaVersion = null } = {}) {
  const uuid = String(item.uuid ?? item.ext_uuid ?? '').trim() || null;
  const extensionId = String(item.name ?? uuid ?? '').trim() || 'unknown-market-extension';
  const name = String(item.display_name ?? item.name ?? extensionId).trim();
  const version = String(item.version ?? '').trim() || null;
  const publisher = String(item.publisher ?? item.nickname ?? item.username ?? '').trim() || null;
  const summary = String(item.description ?? '').trim().slice(0, 240);
  void now;
  void edaVersion;
  return {
    schemaVersion: 1,
    extensionId,
    uuid,
    name,
    version,
    versionParsed: /^\d+\.\d+\.\d+/.test(version ?? ''),
    publisher: publisher ? { name: publisher, verified: false } : null,
    summary,
    tags: [], // 交给上层用 tags.mjs 统一推导（列表没有 keywords/categories，只能按名称）
    entryPoints: [{ kind: 'market', label: '市场安装', bridgeCommand: null }],
    preconditions: [{ id: 'installed', label: '需先安装', checkable: true }],
    sideEffects: 'unknown',
    installPolicy: 'manual-only',
    compat: { edaVersionRange: null, testedEdaVersions: [], status: 'unknown', reason: 'MARKET_LIST_HAS_NO_ENGINE_RANGE' },
    status: 'unverified',
    lastVerifiedAt: String(item.updated_at ?? '') || null,
    lastVerifiedBy: 'extension-registry@0.1.0',
    trust: 'unverified',
    market: {
      installNum: Number(item.install_num) || null,
      averageScore: Number(item.average_score) || null,
      updatedAt: String(item.updated_at ?? '') || null,
      filePath: typeof item.file_path === 'string' ? item.file_path : null,
      detailUrl: uuid ? `https://pro.lceda.cn/api/extensions/detail?uuid=${encodeURIComponent(uuid)}` : null,
      pageUrl: MARKET_ITEM_URL,
    },
    provenance: { source: 'market-api', path: null, url: MARKET_ITEM_URL, fetchedAt: new Date().toISOString(), digest: null },
  };
}
