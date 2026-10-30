import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRagIndex } from './index.mjs';
import { EMBED_DIMS } from './embed.mjs';
import { buildCorpus } from './corpus.mjs';

/**
 * RAG 持久化服务（W3-20 / WP4 P1-9）：
 *   - 首次检索/显式 reindex 时构建；索引落 state，避免每次启动全量重建；
 *   - 索引损坏/维度不符 → 记录 loadError 并在下次检索自动重建（不把"空结果"伪装成"没有知识"）；
 *   - 语料 = 知识库条目 + 指定 Markdown 目录（目录不存在就跳过，不报假错）；
 *   - 修订号失效：索引记录构建时 `knowledgeStore.revision`，检索/状态发现当前 revision 不同就自动
 *     失效重建（不需要用户手动 reindex）；`corpusRevision` 随索引文件持久化，重启后不一致也会重建一次。
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

  const currentRevision = () => (
    knowledgeStore && Number.isFinite(knowledgeStore.revision) ? knowledgeStore.revision : null
  );

  const build = ({ reason = 'manual' } = {}) => {
    const corpus = buildCorpus({ store: knowledgeStore, dirs, baseDir, maxKnowledge, maxFiles });
    const revisionAtBuild = currentRevision();
    const stats = index.build({ documents: corpus.documents, now });
    builtRevision = revisionAtBuild;
    corpusStats = corpus.stats;
    if (indexFile) {
      try {
        fileIo.mkdirSync(dirname(indexFile), { recursive: true });
        const tmp = `${indexFile}.tmp-${process.pid}`;
        // corpusRevision 随索引落盘：重启后如果知识库 revision 对不上，第一次检索会重建（安全方向）。
        fileIo.writeFileSync(tmp, `${JSON.stringify({ ...index.toJSON(), corpusRevision: revisionAtBuild })}\n`, 'utf8');
        fileIo.renameSync(tmp, indexFile);
      } catch { /* 持久化失败不阻断检索；status 里会保留 loadError/build 信息 */ }
    }
    loaded = true;
    loadError = null;
    return { ...stats, reason, corpus: corpusStats, file: indexFile ?? null, corpusRevision: revisionAtBuild };
  };

  const load = () => {
    loaded = true;
    if (!indexFile || !fileIo.existsSync(indexFile)) return index.empty();
    try {
      const payload = JSON.parse(fileIo.readFileSync(indexFile, 'utf8'));
      builtRevision = payload && Number.isFinite(payload.corpusRevision) ? payload.corpusRevision : null;
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

  const ensure = () => {
    if (!loaded) load();
    // 有内容且语料修订号变化 → 自动失效重建（status/query 都会触发）。
    if (index.stats().chunks > 0 && revisionOutdated()) {
      try {
        build({ reason: 'corpus_revision' });
      } catch (error) {
        // 重建失败（知识库文件损坏等）不能把旧索引伪装成“最新”：记录错误供 status 暴露，继续用旧索引只读服务。
        loadError = { code: 'RAG_REBUILD_FAILED', message: String(error?.message || error).slice(0, 240) };
      }
    }
    return index.stats();
  };

  const status = () => {
    const stats = ensure();
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
    };
  };

  const reindex = () => {
    loadError = null;
    return build({ reason: 'reindex' });
  };

  const query = ({ query: text, topK = 8, kinds = null, minScore = 0 } = {}) => {
    ensure();
    if (index.stats().chunks === 0) build({ reason: 'lazy' });
    lastQueryAt = now().toISOString();
    return index.search({ query: text, topK, kinds, minScore });
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
  };
}
