import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRagIndex } from './index.mjs';
import { EMBED_DIMS } from './embed.mjs';
import { buildCorpus } from './corpus.mjs';
import { knowledgeCorpusDigest } from '../knowledge.mjs';

/**
 * RAG 持久化服务（W3-20 / WP4 P1-9）：
 *   - 首次检索/显式 reindex 时构建；索引落 state，避免每次启动全量重建；
 *   - 索引损坏/维度不符 → 记录 loadError 并在下次检索自动重建（不把"空结果"伪装成"没有知识"）；
 *   - 语料 = 知识库条目 + 指定 Markdown 目录（目录不存在就跳过，不报假错）；
 *   - 修订号失效：索引记录构建时 `knowledgeStore.revision`，检索/状态发现当前 revision 不同就自动
 *     失效重建（不需要用户手动 reindex）；`corpusRevision` 随索引文件持久化。
 *   - 平台 P1-2 语料摘要失效：revision 只活在内存、重启归零，落盘值与新进程的 0 可能恰好相等，
 *     "停机期间离线写入/审核的知识"会被漏建（真实 state 漏了 9 条）。所以索引同时落盘
 *     `knowledgeCorpusDigest`（见 knowledge.mjs），启动后第一次 status/query 重算摘要，
 *     不一致就自动重建，并把 reason 记为 `corpus_digest`。
 */
export function createRagStore({
  knowledgeStore = null,
  indexFile = null,
  dirs = [],
  baseDir = process.cwd(),
  dims = EMBED_DIMS,
  maxKnowledge = 3000,
  maxFiles = 200,
  now = () => new Date(),
  fileIo = { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync },
} = {}) {
  const index = createRagIndex({ dims });
  let loaded = false;
  let loadError = null;
  let corpusStats = null;
  let lastQueryAt = null;
  let builtRevision = null;
  let builtDigest = null;
  let lastRebuildReason = null;
  let lastRebuildAt = null;

  const currentRevision = () => (
    knowledgeStore && Number.isFinite(knowledgeStore.revision) ? knowledgeStore.revision : null
  );

  /** 当前语料摘要：优先用 knowledge store 的自带实现，兼容注入的极简 store（只有 list）。 */
  const currentCorpusDigest = () => {
    if (!knowledgeStore) return null;
    if (typeof knowledgeStore.corpusDigest === 'function') return knowledgeStore.corpusDigest();
    if (typeof knowledgeStore.list === 'function') return knowledgeCorpusDigest(knowledgeStore.list({ includeExpired: true }));
    return null;
  };

  const build = ({ reason = 'manual' } = {}) => {
    const corpus = buildCorpus({ store: knowledgeStore, dirs, baseDir, maxKnowledge, maxFiles });
    const revisionAtBuild = currentRevision();
    const stats = index.build({ documents: corpus.documents, now });
    builtRevision = revisionAtBuild;
    try {
      builtDigest = currentCorpusDigest();
    } catch {
      // 摘要算不出来（知识库刚坏）不影响本次用刚装配好的语料建索引；下次 status/query 会再校验。
      builtDigest = null;
    }
    corpusStats = corpus.stats;
    lastRebuildReason = reason;
    lastRebuildAt = now().toISOString();
    if (indexFile) {
      try {
        fileIo.mkdirSync(dirname(indexFile), { recursive: true });
        const tmp = `${indexFile}.tmp-${process.pid}`;
        // corpusRevision / knowledgeCorpusDigest 随索引落盘：重启后任一对不上，第一次 status/query 就重建。
        fileIo.writeFileSync(tmp, `${JSON.stringify({
          ...index.toJSON(),
          corpusRevision: revisionAtBuild,
          knowledgeCorpusDigest: builtDigest,
        })}\n`, 'utf8');
        fileIo.renameSync(tmp, indexFile);
      } catch { /* 持久化失败不阻断检索；status 里会保留 loadError/build 信息 */ }
    }
    loaded = true;
    loadError = null;
    return { ...stats, reason, corpus: corpusStats, file: indexFile ?? null, corpusRevision: revisionAtBuild, knowledgeCorpusDigest: builtDigest };
  };

  const load = () => {
    loaded = true;
    if (!indexFile || !fileIo.existsSync(indexFile)) return index.empty();
    try {
      const payload = JSON.parse(fileIo.readFileSync(indexFile, 'utf8'));
      builtRevision = payload && Number.isFinite(payload.corpusRevision) ? payload.corpusRevision : null;
      builtDigest = payload && typeof payload.knowledgeCorpusDigest === 'string' ? payload.knowledgeCorpusDigest : null;
      const stats = index.fromJSON(payload);
      return stats;
    } catch (error) {
      loadError = { code: error?.code ?? 'RAG_INDEX_INVALID', message: String(error?.message || error).slice(0, 240) };
      return index.empty();
    }
  };

  const revisionOutdated = () => {
    const current = currentRevision();
    if (current === null) return false;
    return builtRevision === null || builtRevision !== current;
  };

  /**
   * 平台 P1-2：落盘摘要与当前语料摘要不一致 → 索引失效。
   * 旧索引没有 knowledgeCorpusDigest（null）同样视为失效，重建一次补齐。
   * 摘要计算失败（知识库损坏）由 ensure() 捕获，不让 status/query 抛崩。
   */
  const digestOutdated = () => {
    const current = currentCorpusDigest();
    if (current === null) return false;
    return builtDigest === null || builtDigest !== current;
  };

  /** @returns {{ rebuilt: boolean, reason: string | null }} */
  const ensure = () => {
    if (!loaded) load();
    // 空索引不走"失效重建"：交给 query 的懒构建，status 仍可如实报告 built:false。
    if (index.stats().chunks === 0) return { rebuilt: false, reason: null };
    let outdated = null;
    try {
      // 同进程写入先看 revision（便宜）；重启/离线写入再靠落盘摘要兜底。
      if (revisionOutdated()) outdated = 'corpus_revision';
      else if (digestOutdated()) outdated = 'corpus_digest';
    } catch (error) {
      // 摘要算不出来不能抛崩 status/query：记录错误、保留旧索引只读服务（fail-closed 可观测）。
      loadError = { code: 'RAG_CORPUS_DIGEST_FAILED', message: String(error?.message || error).slice(0, 240) };
      return { rebuilt: false, reason: null };
    }
    if (!outdated) return { rebuilt: false, reason: null };
    try {
      build({ reason: outdated });
      return { rebuilt: true, reason: outdated };
    } catch (error) {
      // 重建失败（知识库文件损坏等）不能把旧索引伪装成“最新”：记录错误供 status 暴露，继续用旧索引只读服务。
      loadError = { code: 'RAG_REBUILD_FAILED', message: String(error?.message || error).slice(0, 240) };
      return { rebuilt: false, reason: null };
    }
  };

  const status = () => {
    ensure();
    const stats = index.stats();
    return {
      built: stats.chunks > 0,
      ...stats,
      dims,
      file: indexFile ?? null,
      loadError,
      corpus: corpusStats,
      lastQueryAt,
      corpusRevision: builtRevision,
      knowledgeRevision: currentRevision(),
      knowledgeCorpusDigest: builtDigest,
      lastRebuildReason,
      lastRebuildAt,
    };
  };

  const reindex = () => {
    loadError = null;
    return build({ reason: 'reindex' });
  };

  const query = ({ query: text, topK = 8, kinds = null, minScore = 0 } = {}) => {
    const ensured = ensure();
    let rebuilt = ensured.rebuilt;
    let reason = ensured.reason;
    if (index.stats().chunks === 0) {
      build({ reason: 'lazy' });
      rebuilt = true;
      reason = 'lazy';
    }
    lastQueryAt = now().toISOString();
    // 调用方（HTTP/对话）能直接看到"这次结果是不是刚因语料变化重建过"，便于解释陈旧/新鲜问题。
    return { ...index.search({ query: text, topK, kinds, minScore }), invalidation: { rebuilt, reason } };
  };

  return {
    status,
    reindex,
    query,
    build,
    load,
    get loaded() { return loaded; },
    get corpusRevision() { return builtRevision; },
    get knowledgeRevision() { return currentRevision(); },
    get knowledgeCorpusDigest() { return builtDigest; },
  };
}
