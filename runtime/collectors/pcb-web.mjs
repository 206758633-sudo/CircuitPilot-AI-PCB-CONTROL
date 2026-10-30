import { fetchPage, searchWeb } from '../research.mjs';
import { defineCollector } from './collect.mjs';

/**
 * 定时网页知识采集（KMA 专用）：按主题检索 PCB 工程知识，白名单域名 + 配额抓取正文摘要。
 *
 * 边界：
 *   - 只存 URL/标题/主题/摘要/抓取时间，不存整页；一律 `unverified` + candidate，交人工审核；
 *   - 域名白名单（可配置）阻挡随机站点；fetchPage 自带 SSRF/体积/超时防护；
 *   - 每主题最多 maxPages 页、每次搜索最多 limit 条；失败返回原因码，绝不把"没抓到"当"没知识"。
 */
export const PCB_WEB_SOURCE = 'pcb-web';
export const DEFAULT_PCB_WEB_DOMAINS = Object.freeze([
  'jlcpcb.com',
  'pcbway.com',
  'altium.com',
  'resources.altium.com',
  'en.wikipedia.org',
  'ipc.org',
  'mouser.com',
  'digikey.com',
  'ti.com',
  'analog.com',
  'st.com',
  'nxp.com',
]);

export const DEFAULT_PCB_TOPICS = Object.freeze([
  { id: 'drc', query: 'PCB design rule checking', kind: 'rule', sources: [{ url: 'https://en.wikipedia.org/wiki/Design_rule_checking', title: 'Design rule checking（Wikipedia）' }, { url: 'https://jlcpcb.com/capabilities/pcb-capabilities', title: 'JLCPCB PCB capabilities' }] },
  { id: 'dfm', query: 'design for manufacturability PCB', kind: 'rule', sources: [{ url: 'https://en.wikipedia.org/wiki/Design_for_manufacturability', title: 'Design for manufacturability（Wikipedia）' }, { url: 'https://jlcpcb.com/capabilities/pcb-capabilities', title: 'JLCPCB PCB capabilities' }] },
  { id: 'impedance', query: 'characteristic impedance PCB trace', kind: 'rule', sources: [{ url: 'https://en.wikipedia.org/wiki/Characteristic_impedance', title: 'Characteristic impedance（Wikipedia）' }] },
  { id: 'stackup-emc', query: 'PCB stackup electromagnetic compatibility', kind: 'module', sources: [{ url: 'https://en.wikipedia.org/wiki/Printed_circuit_board', title: 'Printed circuit board（Wikipedia）' }, { url: 'https://en.wikipedia.org/wiki/Electromagnetic_compatibility', title: 'Electromagnetic compatibility（Wikipedia）' }] },
  { id: 'solder-defect', query: 'PCB tombstoning solder defect', kind: 'failure', sources: [{ url: 'https://en.wikipedia.org/wiki/Tombstoning', title: 'Tombstoning（Wikipedia）' }, { url: 'https://en.wikipedia.org/wiki/Solder_paste', title: 'Solder paste（Wikipedia）' }] },
  { id: 'thermal', query: 'PCB thermal management design', kind: 'module', sources: [{ url: 'https://en.wikipedia.org/wiki/Thermal_management_(electronics)', title: 'Thermal management（Wikipedia）' }] },
]);

const hostAllowed = (url, domains) => {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

const entityKeyFor = (topicId, url) => `WEB-${topicId}-${url}`;

const NAV_JUNK = /^(jump to content|main menu|move to sidebar|hide|navigation|main page|contents|current events|random article|about wikipedia|contact us|contribute|help|learn to edit|community|portal|recent changes|upload file|special pages|search|donate|create account|log in|personal tools|toggle|submenu|account restriction|get coupon|country|region|language|currency|usd|usd \$|the currency)/i;

/** 从网页正文里抽“关于该主题的句子”，过滤导航/广告噪声；抽不到时退回前 N 字符。 */
export function extractRelevantExcerpt(text, { topicId = '', maxChars = 400 } = {}) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const keys = ['pcb', 'circuit', 'design', 'rule', 'clearance', 'impedance', 'manufactur', 'solder', 'thermal', 'stackup', 'board', 'trace', 'pad', 'mask', 'tombston', 'emc', 'drill', 'layer', 'via', 'fabricat'];
  if (/impedance/i.test(topicId)) keys.push('impedance', 'characteristic', 'transmission');
  if (/thermal/i.test(topicId)) keys.push('thermal', 'heat', 'temperature');
  if (/solder/i.test(topicId)) keys.push('tombston', 'solder', 'reflow');
  const sentences = normalized.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 25 && sentence.length <= 600);
  const scored = sentences
    .filter((sentence) => !NAV_JUNK.test(sentence.trim()))
    .map((sentence, index) => ({ sentence, index, score: keys.reduce((sum, key) => sum + (sentence.toLowerCase().includes(key) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence.trim());
  const joined = scored.join(' ');
  if (joined.length >= 80) return joined.slice(0, maxChars);
  return normalized.slice(0, maxChars);
}

export function createPcbWebCollector({
  topic,
  domains = DEFAULT_PCB_WEB_DOMAINS,
  limit = 5,
  maxPages = 2,
  maxExcerptChars = 1000,
  searchImpl = null,
  fetchImpl = null,
  now = () => new Date(),
  ttlDays = 90,
} = {}) {
  if (!topic || !topic.id || (!topic.query && !Array.isArray(topic.sources))) throw Object.assign(new Error('PCB 网页采集需要 topic.id 且（topic.query 或 topic.sources）'), { code: 'COLLECTOR_INVALID' });
  if (!Array.isArray(domains) || !domains.length) throw Object.assign(new Error('域名白名单不能为空'), { code: 'COLLECTOR_INVALID' });
  return defineCollector({
    id: `pcb-web-${topic.id}`,
    kind: topic.kind || 'module',
    source: PCB_WEB_SOURCE,
    run: async () => {
      // 两种模式：优先抓“人工挑选的权威页面”（稳定、可解释）；没有 sources 才退回联网检索。
      const curated = Array.isArray(topic.sources) ? topic.sources.filter((source) => source?.url && hostAllowed(source.url, domains)).slice(0, Math.max(1, maxPages)) : [];
      let candidates = curated.map((source) => ({ url: source.url, title: source.title ?? source.url }));
      let searchEvidence = { ok: true, mode: 'curated', results: candidates.length };
      if (!candidates.length) {
        const search = searchImpl
          ? await searchImpl({ query: topic.query, limit })
          : await searchWeb({ query: topic.query, limit });
        if (!search || search.ok !== true) {
          return { items: [], evidence: { topic, search: { ok: false, mode: 'search', code: search?.code ?? 'RESEARCH_SEARCH_FAILED' }, pages: [] } };
        }
        candidates = (search.results ?? [])
          .filter((result) => result?.url && hostAllowed(result.url, domains) && !/\.pdf($|\?)/i.test(result.url))
          .slice(0, Math.max(1, maxPages));
        searchEvidence = { ok: true, mode: 'search', provider: search.provider ?? null, results: (search.results ?? []).length, allowed: candidates.length };
      }
      const pages = [];
      for (const result of candidates) {
        const page = fetchImpl ? await fetchImpl({ url: result.url }) : await fetchPage({ url: result.url });
        pages.push({ url: result.url, ok: page?.ok === true, code: page?.ok === true ? null : page?.code ?? 'RESEARCH_FETCH_FAILED', text: page?.ok === true ? String(page.text ?? '') : '' });
      }
      const fetchedAt = now().toISOString();
      const items = pages.filter((page) => page.ok).map((page) => {
        const matched = candidates.find((result) => result.url === page.url);
        const excerpt = extractRelevantExcerpt(page.text, { topicId: topic.id, maxChars: topic.kind === 'rule' ? Math.max(240, Math.min(maxExcerptChars, 400)) : maxExcerptChars });
        return {
          kind: topic.kind === 'failure' ? 'failure' : topic.kind === 'rule' ? 'rule' : 'part',
          title: `${matched?.title || page.url}（${topic.id}）`,
          payload: topic.kind === 'failure'
            ? { failureId: entityKeyFor(topic.id, page.url), code: `WEB_${topic.id.toUpperCase().replace(/-/g, '_')}`, symptom: excerpt.slice(0, 240), sourceUrl: page.url }
            : topic.kind === 'rule'
              ? { ruleId: entityKeyFor(topic.id, page.url), topic: topic.id, excerpt: excerpt.slice(0, 400), sourceUrl: page.url }
              : { url: page.url, topic: topic.id, title: matched?.title ?? null, excerpt },
          provenance: { source: 'web', url: page.url, title: matched?.title ?? null, version: null, fetchedAt, collector: PCB_WEB_SOURCE, topic: topic.id },
          trust: 'unverified',
          ttlDays,
        };
      });
      return { items, evidence: { topic, search: searchEvidence, pages: pages.map((page) => ({ url: page.url, ok: page.ok, code: page.code })), fetchedAt } };
    },
  });
}

/** 按主题列表批量创建（供定时任务/手动触发使用）。 */
export function createPcbWebCollectors({ topics = DEFAULT_PCB_TOPICS, ...options } = {}) {
  return topics.map((topic) => createPcbWebCollector({ topic, ...options }));
}
