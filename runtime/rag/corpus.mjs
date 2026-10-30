import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * RAG 语料装配：知识库条目 + 工程 Markdown 文档。
 * 只读、可注入文件系统；每类来源都有数量/体积上限，避免一次检索把整个磁盘读进来。
 */

const textOfPayload = (payload) => {
  try { return JSON.stringify(payload ?? {}); } catch { return ''; }
};

export function knowledgeDocumentsFromStore(store, { limit = 3000, includeExpired = false } = {}) {
  if (!store || typeof store.list !== 'function') throw Object.assign(new Error('RAG 语料需要 knowledge store'), { code: 'RAG_CORPUS_INVALID' });
  // P0-9：过期条目默认不进 RAG 语料（过期知识不能当依据）；candidate 仍可检索，但 meta 明确标出
  // review/trust/gateUsable，调用方必须看得见"这条还没审核"。
  const gateUsable = typeof store.isUsableForGate === 'function' ? (entry) => store.isUsableForGate(entry) : () => false;
  return store.list({ includeExpired: true })
    .filter((entry) => includeExpired || entry.expired !== true)
    .slice(0, limit).map((entry) => {
    const provenance = entry.provenance && typeof entry.provenance === 'object' ? entry.provenance : {};
    const lines = [
      entry.title ?? '',
      `类型：${entry.kind ?? ''}`,
      `可信等级：${entry.trust ?? ''}`,
      `审核状态：${entry.review?.state ?? 'candidate'}`,
      entry.entityKey ? `实体：${entry.entityKey}` : '',
      textOfPayload(entry.payload),
      provenance.source ? `来源：${provenance.source}` : '',
      provenance.url ? `链接：${provenance.url}` : '',
    ];
    return {
      id: `kn:${entry.id}`,
      title: entry.title ?? entry.id,
      kind: 'knowledge',
      path: provenance.url ?? null,
      text: lines.filter(Boolean).join('\n'),
      meta: { knowledgeId: entry.id, knowledgeKind: entry.kind ?? null, trust: entry.trust ?? null, review: entry.review?.state ?? 'candidate', gateUsable: gateUsable(entry), expired: entry.expired === true, entityKey: entry.entityKey ?? null },
      provenance,
    };
  });
}

export function markdownDocumentsInDirs({ dirs = [], maxFiles = 200, maxBytesPerFile = 512 * 1024, baseDir = process.cwd(), readFile = readFileSync, readdir = readdirSync } = {}) {
  if (!Array.isArray(dirs)) throw Object.assign(new Error('RAG 文档目录必须是数组'), { code: 'RAG_CORPUS_INVALID' });
  const documents = [];
  const skipped = [];
  let truncated = false;
  const walk = (dir) => {
    if (truncated || !existsSync(dir)) return;
    let items;
    try { items = readdir(dir, { withFileTypes: true }); } catch (error) { skipped.push({ path: dir, reason: `READ_FAILED:${error?.code ?? 'UNKNOWN'}` }); return; }
    for (const item of items.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (truncated) return;
      if (!item.name || String(item.name).startsWith('.')) continue;
      const full = resolve(dir, item.name);
      // 知识点总索引是导航文件，不是知识正文；若进入 RAG，会把每个 KP 标题重复成“命中”，污染 Hit@1 评估。
      if (item.name === 'KNOWLEDGE-INDEX.md') {
        skipped.push({ path: full, reason: 'NAVIGATION_INDEX' });
        continue;
      }
      const isDir = typeof item.isDirectory === 'function' ? item.isDirectory() : !/\.[a-z0-9]+$/i.test(item.name);
      if (isDir) { walk(full); continue; }
      if (!/\.md$/i.test(item.name)) continue;
      if (documents.length >= maxFiles) { truncated = true; return; }
      try {
        const raw = readFile(full, 'utf8');
        if (typeof raw !== 'string') { skipped.push({ path: full, reason: 'NOT_TEXT' }); continue; }
        const text = raw.slice(0, maxBytesPerFile);
        const titleMatch = /^#{1,3}\s+(.+)$/m.exec(text);
        documents.push({
          id: `doc:${relative(baseDir, full).replace(/\\/g, '/')}`,
          title: titleMatch ? titleMatch[1].trim() : item.name.replace(/\.md$/i, ''),
          kind: 'doc',
          path: relative(baseDir, full).replace(/\\/g, '/'),
          text,
          meta: { file: relative(baseDir, full).replace(/\\/g, '/') },
          provenance: { source: 'repo-docs', url: relative(baseDir, full).replace(/\\/g, '/') },
        });
      } catch (error) { skipped.push({ path: full, reason: `READ_FAILED:${String(error?.message || error).slice(0, 80)}` }); }
    }
  };
  for (const dir of dirs) walk(resolve(baseDir, dir));
  return { documents, skipped, truncated };
}

export function buildCorpus({ store, dirs = [], baseDir = process.cwd(), maxKnowledge = 3000, maxFiles = 200 } = {}) {
  const knowledge = store ? knowledgeDocumentsFromStore(store, { limit: maxKnowledge }) : [];
  const totalKnowledge = store ? store.list({ includeExpired: true }).length : 0;
  const markdown = dirs.length ? markdownDocumentsInDirs({ dirs, baseDir, maxFiles }) : { documents: [], skipped: [], truncated: false };
  const documents = [...knowledge, ...markdown.documents].filter((document) => document.text.trim().length > 0);
  return {
    documents,
    stats: { knowledge: knowledge.length, docs: markdown.documents.length, skipped: markdown.skipped.length, truncated: markdown.truncated === true, expiredExcluded: Math.max(0, totalKnowledge - knowledge.length) },
  };
}
