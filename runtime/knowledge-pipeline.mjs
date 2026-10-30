import { collectAll, ingestCollectorItems } from './collectors/collect.mjs';
import { annotateProvenance } from './collectors/compliance.mjs';

/**
 * 知识加工管道（W3-10~W3-14 + W3-18）：采集结果 → 合规标注 → 入库去重 → 冲突/审核队列 → 健康度。
 *
 * 加工规则：
 *   - 每条入库条目必须带 provenance（来源/许可/可信等级）；参考工程只能当基准（allowedAsDesignInput=false）；
 *   - 去重靠 knowledge store 的 fingerprint（同 entityKey+同内容 = duplicate，不产生新版本）；
 *   - 冲突检测按 entityKey 返回多源矛盾清单；审核队列只放 candidate（AI/采集器产物）；
 *   - 健康度给出：过期率/冲突率/审核积压/命中率，供 W3-18 看板。
 */
export const KNOWLEDGE_PIPELINE_CODES = Object.freeze({ INVALID: 'KNOWLEDGE_PIPELINE_INVALID' });
const invalid = (message, details = null) => Object.assign(new Error(message), { code: KNOWLEDGE_PIPELINE_CODES.INVALID, details });

export async function processCollectors({ collectors = [], store, timeoutMs = 15_000, now = () => new Date() } = {}) {
  if (!store || typeof store.save !== 'function') throw invalid('加工管道需要知识库 store');
  if (!Array.isArray(collectors) || !collectors.length) throw invalid('至少需要 1 个采集器');
  const summary = await collectAll({ collectors, timeoutMs });
  const ingested = [];
  const failedCollectors = [];
  for (const result of summary.results) {
    if (!result.ok) { failedCollectors.push({ collector: result.collector, code: result.code, message: result.message }); continue; }
    const normalized = { ...result, items: (result.items ?? []).map((item) => ({ ...item, provenance: annotateProvenance({ ...(item.provenance ?? {}), source: item.provenance?.source ?? result.collector.source, fetchedAt: item.provenance?.fetchedAt ?? now().toISOString(), trust: item.trust ?? 'unverified' }) })) };
    try {
      const write = ingestCollectorItems({ store, result: normalized });
      ingested.push({ collector: result.collector, ...write });
    } catch (error) {
      failedCollectors.push({ collector: result.collector, code: error?.code ?? 'INGEST_FAILED', message: String(error?.message ?? error).slice(0, 200) });
    }
  }
  const entries = ingested.flatMap((item) => item.entries);
  const created = entries.filter((entry) => entry.created !== false).length;
  const duplicates = entries.filter((entry) => entry.created === false).length;
  return {
    totalCollectors: summary.total, okCollectors: summary.ok, failedCollectors,
    itemsCollected: summary.itemCount, created, duplicates,
    dedupeRate: created + duplicates ? Number((duplicates / (created + duplicates)).toFixed(4)) : 0,
    ingested,
  };
}

/** 人工审核队列：candidate 条目 + 冲突/过期标记。 */
export function buildReviewQueue({ store, now = () => new Date() } = {}) {
  if (!store || typeof store.list !== 'function') throw invalid('审核队列需要知识库 store');
  const candidates = store.list({ reviewState: 'candidate', includeExpired: true });
  const conflicts = [];
  const seen = new Set();
  for (const entry of store.list({ includeExpired: true })) {
    const key = entry.entityKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const detected = store.detectConflicts({ entityKey: key });
    if (detected.conflicts.length) conflicts.push({ entityKey: key, conflicts: detected.conflicts.length, ids: detected.conflicts.map((item) => item.id) });
  }
  const expired = store.list({ includeExpired: true }).filter((entry) => entry.expired === true);
  return {
    candidates: candidates.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, trust: entry.trust, entityKey: entry.entityKey, createdAt: entry.createdAt })),
    candidateCount: candidates.length,
    conflicts, conflictCount: conflicts.length,
    expired: expired.map((entry) => ({ id: entry.id, title: entry.title, expiredAt: entry.expiresAt ?? null })),
    expiredCount: expired.length,
    generatedAt: now().toISOString(),
  };
}

/** 健康度指标（W3-18）：覆盖率/过期率/冲突率/命中率/待审数。 */
export function healthMetrics({ store, now = () => new Date() } = {}) {
  if (!store || typeof store.list !== 'function') throw invalid('健康度需要知识库 store');
  const all = store.list({ includeExpired: true });
  const kinds = ['part', 'module', 'rule', 'failure'];
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, all.filter((entry) => entry.kind === kind).length]));
  const approved = all.filter((entry) => entry.review?.state === 'approved');
  const expired = all.filter((entry) => entry.expired === true);
  const entityKeys = [...new Set(all.map((entry) => entry.entityKey).filter(Boolean))];
  let conflictingKeys = 0;
  for (const entityKey of entityKeys) if (store.detectConflicts({ entityKey }).conflicts.length) conflictingKeys += 1;
  const usedIds = new Set();
  for (const entry of all) if (store.listUsages({ id: entry.id }).length) usedIds.add(entry.id);
  const rate = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : 0);
  return {
    total: all.length, byKind,
    coverage: rate(kinds.filter((kind) => byKind[kind] > 0).length, kinds.length),
    approved: approved.length, candidates: all.filter((entry) => entry.review?.state === 'candidate').length,
    expired: expired.length, expiredRate: rate(expired.length, all.length),
    conflictKeys: conflictingKeys, conflictRate: rate(conflictingKeys, entityKeys.length),
    hitRate: rate(usedIds.size, all.length),
    generatedAt: now().toISOString(),
  };
}
