import { fetchPage, searchWeb } from '../research.mjs';
import { defineCollector } from './collect.mjs';

/**
 * 资料采集器（W3-07）：用联网检索找 datasheet/产品页，抓取正文摘要作为**参考级候选知识**。
 * 只存“URL + 标题 + 摘要 + 抓取时间 + 来源”，不存整页；正式引用前仍需 review。
 */
export function createResearchCollector({
  query,
  provider = null,
  limit = 5,
  maxPages = 2,
  searchImpl = null,
  fetchImpl = null,
  now = () => new Date(),
} = {}) {
  if (!query || String(query).trim().length < 2) throw Object.assign(new Error('资料采集器需要 query'), { code: 'COLLECTOR_INVALID' });
  return defineCollector({
    id: 'web-research',
    kind: 'web-search',
    source: 'internet',
    run: async () => {
      const search = searchImpl
        ? await searchImpl({ query, provider, limit })
        : await searchWeb({ query, provider, limit });
      if (!search || search.ok !== true) {
        return { items: [], evidence: { query, search: { ok: false, code: search?.code ?? 'RESEARCH_SEARCH_FAILED' }, pages: [] } };
      }
      const pages = [];
      for (const result of (search.results ?? []).slice(0, Math.max(1, maxPages))) {
        if (!result?.url || /\.pdf($|\?)/i.test(result.url)) continue;
        const page = fetchImpl ? await fetchImpl({ url: result.url }) : await fetchPage({ url: result.url });
        pages.push({ url: result.url, ok: page?.ok === true, code: page?.ok === true ? null : page?.code ?? 'RESEARCH_FETCH_FAILED', excerpt: page?.ok === true ? String(page.text).slice(0, 1200) : null });
      }
      const fetchedAt = now().toISOString();
      const items = pages.filter((page) => page.ok).map((page) => {
        const matched = (search.results ?? []).find((entry) => entry.url === page.url);
        return {
          kind: 'part',
          title: matched?.title || page.url,
          payload: { url: page.url, title: matched?.title ?? null, snippet: matched?.snippet ?? null, excerpt: page.excerpt },
          provenance: { source: 'web', url: page.url, version: null, fetchedAt, collector: 'web-research' },
          trust: 'unverified',
          ttlDays: 90,
        };
      });
      return { items, evidence: { query, provider: search.provider ?? provider ?? null, search: { ok: true, results: (search.results ?? []).length }, pages } };
    },
  });
}
