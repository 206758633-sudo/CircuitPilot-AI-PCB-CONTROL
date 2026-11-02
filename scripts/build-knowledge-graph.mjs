#!/usr/bin/env node
/**
 * 生成知识库关联图（派生数据，不改变知识正文/审核状态）。
 *
 * 为什么只做“图”而不是再建一套 Wiki：
 *  - 当前知识库的权威来源仍是 docs/knowledge + knowledge/pcb/dataset；
 *  - graph 只是把已有的文档、KP、结构化条目、来源之间的引用抽出来，供导航、审计和后续检索扩展使用；
 *  - 不新增需要人工维护的第三份正文，避免文档/Wiki/条目三套内容漂移。
 *
 * 输出：
 *  - knowledge/pcb/dataset/graph.json     机器可读 nodes/edges + stats
 *  - docs/knowledge/KNOWLEDGE-GRAPH.md   人可读的枢纽、孤岛、互链缺口、来源覆盖报告
 *
 * 用法：
 *   node scripts/build-knowledge-graph.mjs          # 写入
 *   node scripts/build-knowledge-graph.mjs --check  # 校验是否最新
 *
 * 约束：只读 docs/knowledge 与 knowledge/pcb/dataset；不写知识正文、不改审核状态、不调用网络。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = join(ROOT, 'docs/knowledge');
const DATASET_DIR = join(ROOT, 'knowledge/pcb/dataset');
const GRAPH_JSON = join(DATASET_DIR, 'graph.json');
const GRAPH_MD = join(KB_DIR, 'KNOWLEDGE-GRAPH.md');
const IGNORE = new Set(['README.md', 'conflict-register.md', 'KNOWLEDGE-INDEX.md', 'KNOWLEDGE-GRAPH.md']);
const ENTRY_FILES = [
  ['rule', 'rules.json'],
  ['module', 'modules.json'],
  ['case', 'cases.json'],
  ['part', 'parts.json'],
  ['failure', 'failures.json'],
];
const ID_TOKEN = /\b(?:KP-[A-Z0-9-]+|PCB-[A-Z0-9-]+|SCH-[A-Z0-9-]+|CMP-[A-Z0-9-]+)\b/g;

const readJson = (name) => JSON.parse(readFileSync(join(DATASET_DIR, name), 'utf8'));
const rel = (full) => relative(ROOT, full).split('\\').join('/');
const normDocPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const docLink = (path) => `<./${path.replace(/^docs\/knowledge\//, '')}>`;
const docLabel = (path) => basename(path);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md') && !IGNORE.has(name)) out.push(full);
  }
  return out;
};

const parseDoc = (full) => {
  const text = readFileSync(full, 'utf8');
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(full, '.md')).trim();
  const kps = [];
  for (const match of text.matchAll(/^#{1,4}\s+(KP-[A-Z0-9-]*?-\d{2,4})\s+(.+?)\s*$/gm)) {
    kps.push({ id: match[1], title: match[2].replace(/\s+#+\s*$/, '').trim() });
  }
  const rawLinks = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    target = target.split('#')[0];
    if (!/\.md$/i.test(target)) continue;
    const abs = resolve(dirname(full), target);
    if (!abs.startsWith(KB_DIR + sep) || !existsSync(abs)) continue;
    rawLinks.push(rel(abs));
  }
  return {
    full,
    path: rel(full),
    domain: relative(KB_DIR, dirname(full)).split(sep)[0] || 'root',
    title,
    text,
    kps,
    links: [...new Set(rawLinks)],
  };
};

const entryIdOf = (entry, index) => {
  const payload = entry.payload ?? {};
  return String(payload.ruleId ?? payload.moduleId ?? payload.failureId ?? payload.lcscId ?? payload.mpn ?? `${entry.kind}-${index}`);
};

const loadEntries = () => {
  const all = [];
  for (const [fileKind, file] of ENTRY_FILES) {
    for (const [index, entry] of (readJson(file).entries ?? []).entries()) {
      const payload = entry.payload ?? {};
      const id = entryIdOf(entry, index);
      all.push({
        kind: fileKind === 'case' ? 'case' : (entry.kind ?? fileKind),
        fileKind,
        id,
        title: entry.title ?? id,
        doc: normDocPath(entry.doc),
        payload,
      });
    }
  }
  return all;
};

const tokenSet = (text) => new Set(String(text ?? '').match(ID_TOKEN) ?? []);
const collectStrings = (value, out = [], depth = 0) => {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out, depth + 1); return out; }
  if (typeof value === 'object') { for (const item of Object.values(value)) collectStrings(item, out, depth + 1); }
  return out;
};

const buildModel = () => {
  const docs = walk(KB_DIR).map(parseDoc).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  const entries = loadEntries();
  const sourceRegistry = readJson('sources.json');
  const sources = (sourceRegistry.sources ?? []).map((source) => ({ id: source.id, title: source.title ?? source.id, publisher: source.publisher ?? null }));
  const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
  const kpById = new Map();
  for (const doc of docs) for (const kp of doc.kps) kpById.set(kp.id, { ...kp, doc: doc.path });
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const nodes = new Map();
  const edges = new Map();
  const addNode = (node) => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
  const addEdge = (from, to, type) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${type}\u0000${to}`;
    if (!edges.has(key)) edges.set(key, { from, to, type });
  };

  for (const doc of docs) {
    addNode({
      id: `doc:${doc.path}`,
      type: 'doc',
      label: doc.title,
      path: doc.path,
      domain: doc.domain,
      kpCount: doc.kps.length,
      entryCount: 0,
    });
  }
  for (const kp of kpById.values()) {
    addNode({ id: `kp:${kp.id}`, type: 'kp', label: kp.title, doc: kp.doc, path: kp.doc });
  }
  for (const entry of entries) {
    addNode({
      id: `entry:${entry.kind}:${entry.id}`,
      type: entry.kind,
      label: entry.title,
      idValue: entry.id,
      doc: docsByPath.has(entry.doc) ? entry.doc : null,
    });
  }
  for (const source of sources) {
    addNode({ id: `source:${source.id}`, type: 'source', label: source.title, publisher: source.publisher });
  }

  const docsWithEntries = new Set();
  for (const doc of docs) {
    for (const kp of doc.kps) addEdge(`doc:${doc.path}`, `kp:${kp.id}`, 'DOC_HAS_KP');
    for (const target of doc.links) {
      if (docsByPath.has(target)) addEdge(`doc:${doc.path}`, `doc:${target}`, 'DOC_LINKS');
    }
    const tokens = tokenSet(doc.text);
    for (const token of tokens) {
      const kp = kpById.get(token);
      if (kp && kp.doc !== doc.path) addEdge(`doc:${doc.path}`, `kp:${kp.id}`, 'DOC_REFERENCES_KP');
      const entry = entryById.get(token);
      if (entry && entry.doc !== doc.path && docsByPath.has(entry.doc)) {
        addEdge(`doc:${doc.path}`, `entry:${entry.kind}:${entry.id}`, 'DOC_REFERENCES_ENTRY');
      }
    }
  }

  for (const entry of entries) {
    if (docsByPath.has(entry.doc)) {
      addEdge(`doc:${entry.doc}`, `entry:${entry.kind}:${entry.id}`, 'DOC_HAS_ENTRY');
      docsWithEntries.add(entry.doc);
    }
    for (const sourceId of Array.isArray(entry.payload?.sources) ? entry.payload.sources : []) {
      if (sourceById.has(sourceId)) addEdge(`entry:${entry.kind}:${entry.id}`, `source:${sourceId}`, 'ENTRY_SOURCE');
    }
    const strings = collectStrings(entry.payload);
    for (const string of strings) {
      for (const token of tokenSet(string)) {
        const other = entryById.get(token);
        if (other && other.id !== entry.id) addEdge(`entry:${entry.kind}:${entry.id}`, `entry:${other.kind}:${other.id}`, 'ENTRY_REFERENCES_ENTRY');
        const kp = kpById.get(token);
        if (kp) addEdge(`entry:${entry.kind}:${entry.id}`, `kp:${kp.id}`, 'ENTRY_REFERENCES_KP');
      }
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  const degree = new Map();
  for (const edge of sortedEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const docOutbound = new Map(docs.map((doc) => [doc.path, 0]));
  const docInbound = new Map(docs.map((doc) => [doc.path, 0]));
  const kpRefs = new Map([...kpById.keys()].map((id) => [id, 0]));
  const entrySourceCount = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, 0]));
  for (const edge of sortedEdges) {
    if (edge.type === 'DOC_LINKS' || edge.type === 'DOC_REFERENCES_KP' || edge.type === 'DOC_REFERENCES_ENTRY') {
      const fromPath = edge.from.replace(/^doc:/, '');
      if (docOutbound.has(fromPath)) docOutbound.set(fromPath, (docOutbound.get(fromPath) ?? 0) + 1);
      const toPath = edge.to.replace(/^doc:/, '');
      if (docInbound.has(toPath)) docInbound.set(toPath, (docInbound.get(toPath) ?? 0) + 1);
    }
    if ((edge.type === 'DOC_REFERENCES_KP' || edge.type === 'ENTRY_REFERENCES_KP') && edge.to.startsWith('kp:')) {
      const id = edge.to.slice(3);
      if (kpRefs.has(id)) kpRefs.set(id, (kpRefs.get(id) ?? 0) + 1);
    }
    if (edge.type === 'ENTRY_SOURCE') {
      const key = edge.from.replace(/^entry:/, '');
      if (entrySourceCount.has(key)) entrySourceCount.set(key, (entrySourceCount.get(key) ?? 0) + 1);
    }
  }

  const docHub = docs
    .map((doc) => ({ path: doc.path, title: doc.title, domain: doc.domain, degree: degree.get(`doc:${doc.path}`) ?? 0, outbound: docOutbound.get(doc.path) ?? 0, inbound: docInbound.get(doc.path) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path, 'en', { numeric: true }));
  const kpHubs = [...kpById.values()]
    .map((kp) => ({ id: kp.id, title: kp.title, doc: kp.doc, refs: kpRefs.get(kp.id) ?? 0, degree: degree.get(`kp:${kp.id}`) ?? 0 }))
    .sort((a, b) => b.refs - a.refs || b.degree - a.degree || a.id.localeCompare(b.id));
  const orphanKps = kpHubs.filter((kp) => kp.refs === 0).map((kp) => ({ ...kp, doc: kp.doc }));
  const docsWithoutOutbound = docHub.filter((doc) => doc.outbound === 0);
  const docsWithoutEntries = docs.filter((doc) => !docsWithEntries.has(doc.path));
  const entriesWithoutSource = entries.filter((entry) => (entrySourceCount.get(`${entry.kind}:${entry.id}`) ?? 0) === 0);
  const entriesWithUnknownSource = entries.filter((entry) => {
    const refs = Array.isArray(entry.payload?.sources) ? entry.payload.sources : [];
    return refs.some((sourceId) => !sourceById.has(sourceId));
  });
  const sourcesUnused = sources.filter((source) => !entries.some((entry) => Array.isArray(entry.payload?.sources) && entry.payload.sources.includes(source.id)));

  const domainStats = new Map();
  for (const doc of docs) {
    const item = domainStats.get(doc.domain) ?? { domain: doc.domain, docs: 0, kps: 0, entries: 0, crossDocKpRefs: 0, orphanKps: 0, docsWithoutOutbound: 0 };
    item.docs += 1;
    item.kps += doc.kps.length;
    item.entries += entries.filter((entry) => entry.doc === doc.path).length;
    domainStats.set(doc.domain, item);
  }
  for (const doc of docs) {
    const item = domainStats.get(doc.domain);
    item.crossDocKpRefs += [...kpRefs.keys()].filter((id) => kpById.get(id)?.doc === doc.path && kpRefs.get(id) > 0).length;
    item.orphanKps += orphanKps.filter((kp) => kpById.get(kp.id)?.doc === doc.path).length;
    if (!docOutbound.get(doc.path)) item.docsWithoutOutbound += 1;
  }

  const stats = {
    docs: docs.length,
    kps: kpById.size,
    entries: entries.length,
    sources: sources.length,
    nodes: sortedNodes.length,
    edges: sortedEdges.length,
    docsWithoutKp: docs.filter((doc) => doc.kps.length === 0).length,
    docsWithoutEntries: docsWithoutEntries.length,
    docsWithoutOutbound: docsWithoutOutbound.length,
    crossDocKpReferences: sortedEdges.filter((edge) => edge.type === 'DOC_REFERENCES_KP').length,
    crossDocEntryReferences: sortedEdges.filter((edge) => edge.type === 'DOC_REFERENCES_ENTRY').length,
    orphanKps: orphanKps.length,
    entriesWithoutSource: entriesWithoutSource.length,
    entriesWithUnknownSource: entriesWithUnknownSource.length,
    sourcesUnused: sourcesUnused.length,
    entriesByKind: Object.fromEntries(['rule', 'module', 'case', 'part', 'failure'].map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length])),
  };

  return {
    graph: {
      schemaVersion: 1,
      domain: sourceRegistry.domain ?? 'pcb',
      source: 'docs/knowledge + knowledge/pcb/dataset',
      note: '派生索引；权威内容仍以文档/结构化条目为准，不在这里改知识或审核状态。',
      stats,
      nodes: sortedNodes,
      edges: sortedEdges,
    },
    docs,
    docHub,
    kpHubs,
    orphanKps,
    docsWithoutOutbound,
    docsWithoutEntries,
    entries,
    entriesWithoutSource,
    entriesWithUnknownSource,
    sourcesUnused,
    domainStats: [...domainStats.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
  };
};

const renderMarkdown = (model) => {
  const { graph, docHub, kpHubs, orphanKps, docsWithoutOutbound, docsWithoutEntries, entries, entriesWithoutSource, entriesWithUnknownSource, sourcesUnused, domainStats } = model;
  const stats = graph.stats;
  const lines = [];
  const push = (...items) => lines.push(...items);

  push('# 知识库关联图（自动生成）');
  push('');
  push('> 这是派生视图，不是新的知识正文；请勿手工修改。');
  push('> 重新生成：`npm run knowledge:graph`；提交前校验：`npm run knowledge:graph:check`。');
  push('> 权威内容仍是 `docs/knowledge/**` 与 `knowledge/pcb/dataset/*.json`。');
  push('');
  push('## 1. 总览');
  push('');
  push('| 指标 | 数量 |');
  push('|---|---:|');
  push(`| 文档 | ${stats.docs} |`);
  push(`| 知识点（KP） | ${stats.kps} |`);
  push(`| 结构化条目 | ${stats.entries} |`);
  push(`| 来源登记 | ${stats.sources} |`);
  push(`| 节点 / 边 | ${stats.nodes} / ${stats.edges} |`);
  push(`| 跨文档 KP 引用 | ${stats.crossDocKpReferences} |`);
  push(`| 跨文档条目引用 | ${stats.crossDocEntryReferences} |`);
  push(`| 孤岛 KP（无任何跨文档/条目引用） | ${stats.orphanKps} |`);
  push(`| 无跨文档连接的文档 | ${stats.docsWithoutOutbound} |`);
  push(`| 无结构化条目的文档 | ${stats.docsWithoutEntries} |`);
  push(`| 无来源的结构化条目 | ${stats.entriesWithoutSource} |`);
  push(`| 引用了未登记来源的条目 | ${stats.entriesWithUnknownSource} |`);
  push(`| 未被引用的已登记来源 | ${stats.sourcesUnused} |`);
  push('');
  push('## 2. 领域连接');
  push('');
  push('| 领域 | 文档 | KP | 条目 | 有跨文档引用的 KP | 孤岛 KP | 无跨文档连接文档 |');
  push('|---|---:|---:|---:|---:|---:|---:|');
  for (const item of domainStats) {
    push(`| ${escapeCell(item.domain)} | ${item.docs} | ${item.kps} | ${item.entries} | ${item.crossDocKpRefs} | ${item.orphanKps} | ${item.docsWithoutOutbound} |`);
  }
  push('');
  push('## 3. 文档枢纽（按连接度）');
  push('');
  push('连接度 = 文档出链 + 被其他文档引用；用来找“应该优先维护/最容易断链”的入口文档。');
  push('');
  push('| # | 文档 | 领域 | 连接度 | 出链 | 入链 |');
  push('|---:|---|---|---:|---:|---:|');
  for (const [index, doc] of docHub.slice(0, 15).entries()) {
    push(`| ${index + 1} | [${escapeCell(docLabel(doc.path))}](${docLink(doc.path)}) | ${escapeCell(doc.domain)} | ${doc.degree} | ${doc.outbound} | ${doc.inbound} |`);
  }
  push('');
  push('## 4. 知识点枢纽（被引用最多）');
  push('');
  push('| # | KP | 标题 | 所属文档 | 被引用 |');
  push('|---:|---|---|---|---:|');
  for (const [index, kp] of kpHubs.slice(0, 20).entries()) {
    push(`| ${index + 1} | \`${kp.id}\` | ${escapeCell(kp.title)} | [${escapeCell(docLabel(kp.doc))}](${docLink(kp.doc)}) | ${kp.refs} |`);
  }
  push('');
  push('## 5. 孤岛知识点');
  push('');
  if (!orphanKps.length) {
    push('没有孤岛 KP。');
  } else {
    push(`共 ${orphanKps.length} 个 KP 目前没有被其他文档、条目或来源连接。它们不一定是错的，但值得确认是“独立概念”还是“漏了关联”。`);
    push('');
    push('| # | KP | 标题 | 所属文档 |');
    push('|---:|---|---|---|');
    for (const [index, kp] of orphanKps.slice(0, 40).entries()) {
      push(`| ${index + 1} | \`${kp.id}\` | ${escapeCell(kp.title)} | [${escapeCell(docLabel(kp.doc))}](${docLink(kp.doc)}) |`);
    }
    if (orphanKps.length > 40) push(`| … | 其余 ${orphanKps.length - 40} 个见 \`knowledge/pcb/dataset/graph.json\` | | |`);
  }
  push('');
  push('## 6. 文档互链缺口');
  push('');
  if (!docsWithoutOutbound.length) {
    push('所有文档都有至少一条跨文档连接。');
  } else {
    push(`共 ${docsWithoutOutbound.length} 篇文档没有指向其他文档/KP/条目的跨文档链接：`);
    push('');
    push('| 文档 | 领域 | 连接度 |');
    push('|---|---|---:|');
    for (const doc of docsWithoutOutbound.slice(0, 30)) {
      push(`| [${escapeCell(docLabel(doc.path))}](${docLink(doc.path)}) | ${escapeCell(doc.domain)} | ${doc.degree} |`);
    }
    if (docsWithoutOutbound.length > 30) push(`| … | 其余 ${docsWithoutOutbound.length - 30} 篇见 graph.json | |`);
  }
  push('');
  push('## 7. 来源覆盖');
  push('');
  push('| 条目类型 | 总数 | 有来源 | 无来源 |');
  push('|---|---:|---:|---:|');
  for (const kind of ['rule', 'module', 'case', 'part', 'failure']) {
    const all = entries.filter((entry) => entry.kind === kind);
    const without = entriesWithoutSource.filter((entry) => entry.kind === kind).length;
    push(`| ${kind} | ${all.length} | ${all.length - without} | ${without} |`);
  }
  push('');
  push(`- 无来源条目 ${entriesWithoutSource.length} 条：多数是内部规则；只对确实来自公开资料的条目补来源，不批量伪造。`);
  push(`- 引用未登记来源的条目 ${entriesWithUnknownSource.length} 条；未登记来源不能当外部证据。`);
  if (sourcesUnused.length) push(`- 未被任何条目引用的已登记来源：${sourcesUnused.map((source) => `\`${source.id}\``).join('、')}。`);
  push('');
  push('## 8. 怎么用');
  push('');
  push('- **人**：从“文档枢纽”和“知识点枢纽”进入，先看被引用最多的内容；再用孤岛/互链缺口做维护清单。');
  push('- **Agent/RAG**：读取 `knowledge/pcb/dataset/graph.json`，按 `edges` 做相邻节点扩展；图只提供上下文，不作为“已验证知识”依据。');
  push('- **门禁**：仍只认 `approved + 未过期 + trust 合格` 的结构化条目；图不改变审核状态。');
  push('');
  push('## 9. 生成约束');
  push('');
  push('- 只读 `docs/knowledge/**`、`knowledge/pcb/dataset/*.json`；不调用网络、不改正文、不改审核状态。');
  push('- `--check` 会比较两份生成物；任何源文档/条目/来源变化后必须重新生成。');
  push('- 节点 ID：`doc:<路径>`、`kp:<KP-ID>`、`entry:<kind>:<ID>`、`source:<SRC-ID>`；边类型见 `graph.json`。');
  push('');
  return `${lines.join('\n')}\n`;
};

const main = () => {
  const check = process.argv.includes('--check');
  const model = buildModel();
  const graphText = `${JSON.stringify(model.graph, null, 2)}\n`;
  const markdownText = renderMarkdown(model);
  if (check) {
    const currentGraph = existsSync(GRAPH_JSON) ? readFileSync(GRAPH_JSON, 'utf8') : '';
    const currentMarkdown = existsSync(GRAPH_MD) ? readFileSync(GRAPH_MD, 'utf8') : '';
    if (currentGraph !== graphText || currentMarkdown !== markdownText) {
      console.error(JSON.stringify({ ok: false, code: 'KNOWLEDGE_GRAPH_STALE', graph: rel(GRAPH_JSON), markdown: rel(GRAPH_MD), stats: model.graph.stats }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, code: 'KNOWLEDGE_GRAPH_CURRENT', graph: rel(GRAPH_JSON), markdown: rel(GRAPH_MD), stats: model.graph.stats }, null, 2));
    return;
  }
  mkdirSync(dirname(GRAPH_JSON), { recursive: true });
  writeFileSync(GRAPH_JSON, graphText);
  writeFileSync(GRAPH_MD, markdownText);
  console.log(JSON.stringify({ ok: true, code: 'KNOWLEDGE_GRAPH_WRITTEN', graph: rel(GRAPH_JSON), markdown: rel(GRAPH_MD), stats: model.graph.stats }, null, 2));
};

main();
