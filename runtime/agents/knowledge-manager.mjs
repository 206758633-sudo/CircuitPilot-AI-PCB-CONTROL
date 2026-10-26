import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectAll, ingestCollectorItems, runCollector } from '../collectors/collect.mjs';
import { healthMetrics } from '../knowledge-pipeline.mjs';

/**
 * KMA：知识库管理 Agent（W3-18）。
 *
 * 能力：
 *   1) badcase 入库：扫描证据目录里 blocked/unknown 的证据，按"证据类型 + 缺陷码"归并成 failure 候选；
 *   2) 网页知识采集：按主题白名单抓取，产出 unverified 候选；
 *   3) 定期维护：健康度、过期、待审积压、approved 冲突、陈旧候选报告（可落证据）。
 *
 * 红线（不可绕过）：
 *   - 只写 candidate，绝不自动 approved（审核仍需人工 reviewedBy）；
 *   - 抓取/证据缺失时报告失败原因码，不伪造条目；
 *   - 每轮有配额上限，重复运行幂等（同 entityKey 同 payload 不重复入库）；
 *   - 本 agent 不写 EDA、不改设计，只维护知识库。
 */
export const KMA_CODES = Object.freeze({ INVALID: 'KMA_INVALID', SOURCE_UNAVAILABLE: 'KMA_SOURCE_UNAVAILABLE' });

const nowIso = (now) => now().toISOString();
const uniq = (values) => [...new Set(values.filter(Boolean))];

/** 有界扫描证据 JSON 文件（不递归过深、不无限读）。 */
export function readEvidenceJsonFiles(root, { maxFiles = 200, maxDepth = 3, readFile = readFileSync, readdir = readdirSync } = {}) {
  if (!root || typeof root !== 'string') throw Object.assign(new Error('badcase 扫描需要证据目录'), { code: KMA_CODES.INVALID });
  if (!existsSync(root)) return { root, files: [], skipped: [], truncated: false, reason: 'NOT_FOUND' };
  const files = [];
  const skipped = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated) return;
    let items;
    try { items = readdir(dir, { withFileTypes: true }); } catch (error) { skipped.push({ path: dir, reason: `READ_FAILED:${error?.code ?? 'UNKNOWN'}` }); return; }
    for (const item of items.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (truncated) return;
      if (!item.name || String(item.name).startsWith('.')) continue;
      const full = join(dir, item.name);
      const isDir = typeof item.isDirectory === 'function' ? item.isDirectory() : !/\.json$/i.test(item.name);
      if (isDir) { if (depth >= maxDepth) { truncated = true; return; } walk(full, depth + 1); continue; }
      if (!/\.json$/i.test(item.name)) continue;
      if (files.length >= maxFiles) { truncated = true; return; }
      try { files.push({ path: full, data: JSON.parse(readFile(full, 'utf8')) }); } catch (error) { skipped.push({ path: full, reason: `PARSE_FAILED:${String(error?.message || error).slice(0, 80)}` }); }
    }
  };
  walk(root, 0);
  return { root, files, skipped, truncated };
}

/** 把失败证据归并成 failure 候选（同 kind+codes 只产一条，payload 带证据摘要）。 */
export function badcaseItemsFromEvidence({ files = [], now = () => new Date(), maxItems = 30 } = {}) {
  const groups = new Map();
  for (const file of files) {
    const data = file?.data;
    if (!data || typeof data !== 'object') continue;
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const verdict = String(payload.verdict ?? '').toLowerCase();
    const findings = Array.isArray(payload.findings) ? payload.findings.filter((item) => item && typeof item === 'object') : [];
    const codes = uniq(findings.map((item) => String(item.code ?? '').trim()).filter(Boolean)).sort();
    const isBad = verdict === 'blocked' || (verdict === 'unknown' && findings.length > 0);
    if (!isBad) continue;
    const codesForKey = codes.length ? codes : ['UNKNOWN_NO_FINDINGS'];
    const failureId = `EV-${String(data.kind ?? 'unknown')}-${codesForKey.join('+')}`;
    const group = groups.get(failureId) ?? { failureId, evidenceKind: data.kind ?? null, codes: codesForKey, messages: [], paths: [], digests: [] };
    for (const finding of findings.slice(0, 3)) if (finding.message) group.messages.push(String(finding.message).slice(0, 240));
    group.paths.push(String(file.path));
    if (data.digest) group.digests.push(String(data.digest));
    groups.set(failureId, group);
  }
  const fetchedAt = nowIso(now);
  return [...groups.values()].slice(0, maxItems).map((group) => ({
    kind: 'failure',
    title: `Badcase：${group.evidenceKind ?? '证据'} 失败模式 ${group.codes.join('/')}`,
    payload: {
      failureId: group.failureId,
      code: group.codes[0],
      codes: group.codes,
      evidenceKind: group.evidenceKind,
      symptom: uniq(group.messages).slice(0, 3).join('；').slice(0, 400),
      evidenceDigests: uniq(group.digests).slice(0, 5),
      sourcePaths: uniq(group.paths).slice(0, 5),
    },
    provenance: { source: 'evidence', url: group.paths[0] ?? null, version: group.digests[0] ?? null, fetchedAt, collector: 'kma' },
    trust: 'reference',
    ttlDays: 365,
  }));
}

export function createKnowledgeManager({
  store,
  now = () => new Date(),
  evidenceRoot = null,
  maxEvidenceFiles = 200,
  maxBadcasesPerRun = 30,
  webCollectors = [],
  webTimeoutMs = 20_000,
  webMaxItemsPerRun = 12,
  staleCandidateDays = 30,
  evidenceStore = null,
} = {}) {
  if (!store || typeof store.save !== 'function' || typeof store.list !== 'function') throw Object.assign(new Error('KMA 需要注入 knowledge store'), { code: KMA_CODES.INVALID });

  const saveCandidate = (item) => store.save({
    kind: item.kind,
    title: item.title,
    payload: item.payload,
    provenance: item.provenance,
    trust: item.trust ?? 'unverified',
    ttlDays: item.ttlDays ?? null,
    reviewState: 'candidate',
  });

  const listBadcases = ({ limit = 50 } = {}) => store.list({ kind: 'failure' }).slice(0, Math.max(1, Math.min(500, limit)));

  const ingestBadcases = ({ root = evidenceRoot, files = null } = {}) => {
    let scanned;
    if (Array.isArray(files)) scanned = { root: root ?? '(injected)', files, skipped: [], truncated: false };
    else if (root) scanned = readEvidenceJsonFiles(root, { maxFiles: maxEvidenceFiles });
    else return { ok: false, code: KMA_CODES.SOURCE_UNAVAILABLE, message: '未配置证据目录，无法采集 badcase', created: 0, scanned: 0 };
    if (scanned.reason === 'NOT_FOUND') return { ok: false, code: KMA_CODES.SOURCE_UNAVAILABLE, message: `证据目录不存在：${root}`, created: 0, scanned: 0, root };
    const items = badcaseItemsFromEvidence({ files: scanned.files, now, maxItems: maxBadcasesPerRun });
    const saved = items.map((item) => {
      const result = saveCandidate(item);
      return { id: result.entry.id, created: result.created, failureId: item.payload.failureId };
    });
    return {
      ok: true,
      root: scanned.root,
      scanned: scanned.files.length,
      skipped: scanned.skipped.length,
      truncated: scanned.truncated === true,
      candidates: items.length,
      created: saved.filter((entry) => entry.created).length,
      duplicates: saved.filter((entry) => !entry.created).length,
      entries: saved,
    };
  };

  const ingestWebKnowledge = async ({ collectors = webCollectors, timeoutMs = webTimeoutMs, maxItems = webMaxItemsPerRun } = {}) => {
    if (!Array.isArray(collectors) || !collectors.length) return { ok: true, collectors: 0, created: 0, failed: [], note: '未配置网页采集主题' };
    const summary = await collectAll({ collectors, timeoutMs });
    const created = [];
    const failed = summary.results.filter((result) => !result.ok).map((result) => ({ collector: result.collector.id, code: result.code, message: result.message }));
    let budget = Math.max(1, maxItems);
    for (const result of summary.results) {
      if (!result.ok) continue;
      const limited = { ...result, items: (result.items ?? []).slice(0, budget) };
      budget -= limited.items.length;
      if (!limited.items.length) continue;
      try {
        const ingested = ingestCollectorItems({ store, result: limited });
        created.push(...ingested.entries.map((entry) => ({ ...entry, collector: result.collector.id })));
      } catch (error) {
        failed.push({ collector: result.collector.id, code: error?.code ?? 'KMA_INGEST_FAILED', message: String(error?.message || error).slice(0, 200) });
      }
      if (budget <= 0) break;
    }
    return { ok: true, collectors: collectors.length, okCollectors: summary.ok, failedCollectors: summary.failed, itemCount: summary.itemCount, created: created.filter((entry) => entry.created).length, duplicates: created.filter((entry) => !entry.created).length, failed, entries: created };
  };

  const maintain = ({ saveEvidence = true } = {}) => {
    const metrics = healthMetrics({ store, now });
    const all = store.list({ includeExpired: true });
    const staleBefore = new Date(now().getTime() - staleCandidateDays * 24 * 3600 * 1000).toISOString();
    const staleCandidates = all.filter((entry) => entry.review?.state === 'candidate' && typeof entry.createdAt === 'string' && entry.createdAt < staleBefore).map((entry) => selfRef(entry));
    const expired = all.filter((entry) => entry.expired === true).map((entry) => selfRef(entry));
    const conflicts = [];
    for (const entityKey of uniq(all.filter((entry) => entry.review?.state === 'approved').map((entry) => entry.entityKey))) {
      try {
        const result = store.detectConflicts({ entityKey });
        if (result?.conflicts?.length) conflicts.push(result);
      } catch { /* 冲突检测失败单独报告，不阻断维护 */ }
    }
    const report = {
      generatedAt: nowIso(now),
      metrics,
      staleCandidateDays,
      staleCandidates: { count: staleCandidates.length, ids: staleCandidates.slice(0, 20).map((entry) => entry.id) },
      expired: { count: expired.length, ids: expired.slice(0, 20).map((entry) => entry.id) },
      conflicts: { count: conflicts.length, keys: conflicts.map((item) => item.entityKey) },
      pendingReview: metrics.candidates,
      recommendations: [
        metrics.candidates > 0 ? `待审 ${metrics.candidates} 条：审核后才可用于门禁` : null,
        expired.length ? `${expired.length} 条已过期：需要更新来源或重新采集` : null,
        staleCandidates.length ? `${staleCandidates.length} 条候选超过 ${staleCandidateDays} 天未审：建议清理或复审` : null,
        conflicts.length ? `approved 条目存在 ${conflicts.length} 组冲突：人工裁决` : null,
      ].filter(Boolean),
    };
    if (saveEvidence && evidenceStore) {
      try {
        const saved = evidenceStore.save({ kind: 'knowledge', payload: { report: true, ...report }, fingerprint: { project: 'knowledge-maintenance' }, note: 'KMA 定期维护报告' });
        report.evidencePath = saved.path;
      } catch (error) {
        report.evidenceError = String(error?.message || error).slice(0, 200);
      }
    }
    return { ok: true, ...report };
  };

  const runCycle = async ({ tasks = ['badcases', 'web', 'maintain'] } = {}) => {
    const startedAt = nowIso(now);
    const run = {};
    if (tasks.includes('badcases')) { try { run.badcases = ingestBadcases(); } catch (error) { run.badcases = { ok: false, code: error?.code ?? 'KMA_BADCASE_FAILED', message: String(error?.message || error).slice(0, 200) }; } }
    if (tasks.includes('web')) { try { run.web = await ingestWebKnowledge(); } catch (error) { run.web = { ok: false, code: error?.code ?? 'KMA_WEB_FAILED', message: String(error?.message || error).slice(0, 200) }; } }
    if (tasks.includes('maintain')) { try { run.maintain = maintain(); } catch (error) { run.maintain = { ok: false, code: error?.code ?? 'KMA_MAINTAIN_FAILED', message: String(error?.message || error).slice(0, 200) }; } }
    const cycle = {
      startedAt,
      finishedAt: nowIso(now),
      tasks,
      badcases: run.badcases ?? null,
      web: run.web ?? null,
      maintenance: run.maintain ?? null,
      ok: Object.values(run).every((item) => item?.ok !== false),
    };
    return cycle;
  };

  const status = () => {
    const metrics = healthMetrics({ store, now });
    return {
      totals: { total: metrics.total, candidates: metrics.candidates, approved: metrics.approved, expired: metrics.expired, coverage: metrics.coverage },
      badcases: { count: listBadcases({ limit: 500 }).length, pendingReview: listBadcases({ limit: 500 }).filter((entry) => entry.review?.state === 'candidate').length },
      webCollectors: webCollectors.length,
      evidenceRoot,
    };
  };

  return { listBadcases, ingestBadcases, ingestWebKnowledge, maintain, runCycle, status };
}

/** 只回传可安全给 UI/状态用的字段（避免把整个 payload 塞进状态文件）。 */
function selfRef(entry) {
  return { id: entry.id, kind: entry.kind, title: entry.title, entityKey: entry.entityKey ?? null, review: entry.review?.state ?? 'candidate', createdAt: entry.createdAt ?? null };
}
