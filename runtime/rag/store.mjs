import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRagIndex } from './index.mjs';
import { EMBED_DIMS } from './embed.mjs';
import { buildCorpus } from './corpus.mjs';

/**
 * RAG 持久化服务（W3-20）：
 *   - 首次检索/显式 reindex 时构建；索引落 state，避免每次启动全量重建；
 *   - 索引损坏/维度不符 → 记录 loadError 并在下次检索自动重建（不把"空结果"伪装成"没有知识"）；
 *   - 语料 = 知识库条目 + 指定 Markdown 目录（目录不存在就跳过，不报假错）。
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

  const build = ({ reason = 'manual' } = {}) => {
    const corpus = buildCorpus({ store: knowledgeStore, dirs, baseDir, maxKnowledge, maxFiles });
    const stats = index.build({ documents: corpus.documents, now });
    corpusStats = corpus.stats;
    if (indexFile) {
      try {
        fileIo.mkdirSync(dirname(indexFile), { recursive: true });
        const tmp = `${indexFile}.tmp-${process.pid}`;
        fileIo.writeFileSync(tmp, `${JSON.stringify(index.toJSON())}\n`, 'utf8');
        fileIo.renameSync(tmp, indexFile);
      } catch { /* 持久化失败不阻断检索；status 里会保留 loadError/build 信息 */ }
    }
    loaded = true;
    return { ...stats, reason, corpus: corpusStats, file: indexFile ?? null };
  };

  const load = () => {
    loaded = true;
    if (!indexFile || !fileIo.existsSync(indexFile)) return index.empty();
    try {
      const stats = index.fromJSON(JSON.parse(fileIo.readFileSync(indexFile, 'utf8')));
      return stats;
    } catch (error) {
      loadError = { code: error?.code ?? 'RAG_INDEX_INVALID', message: String(error?.message || error).slice(0, 240) };
      return index.empty();
    }
  };

  const ensure = () => { if (!loaded) load(); return index.stats(); };

  const status = () => {
    const stats = ensure();
    return { built: stats.chunks > 0, ...stats, dims, file: indexFile ?? null, loadError, corpus: corpusStats, lastQueryAt };
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

  return { status, reindex, query, build, load, get loaded() { return loaded; } };
}
