/**
 * 知识库关联图门禁：
 *  - 生成物必须与源文档/数据集同步（--check）；
 *  - 图里的节点/边不能悬空，文档/KP/来源必须可回溯；
 *  - 生成的 Markdown 链接必须真实存在。
 *
 * 这里只校验派生图，不修改知识正文，也不改变审核状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { markdownDocumentsInDirs } from '../rag/corpus.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const KB = join(ROOT, 'docs/knowledge');
const DATASET = join(ROOT, 'knowledge/pcb/dataset');
const GRAPH = join(DATASET, 'graph.json');
const GRAPH_MD = join(KB, 'KNOWLEDGE-GRAPH.md');
const IGNORE = new Set(['README.md', 'conflict-register.md', 'KNOWLEDGE-INDEX.md', 'KNOWLEDGE-GRAPH.md']);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md') && !IGNORE.has(name)) out.push(full);
  }
  return out;
};
const rel = (full) => relative(ROOT, full).split('\\').join('/');
const readJson = (name) => JSON.parse(readFileSync(join(DATASET, name), 'utf8'));

test('知识库关联图 --check：生成物与源数据同步', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/build-knowledge-graph.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `图生成物过期：${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, 'KNOWLEDGE_GRAPH_CURRENT');
});

test('知识库关联图：节点 ID 唯一、边无悬空、统计与源数据一致', () => {
  const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));
  const docs = walk(KB);
  const kps = [];
  for (const full of docs) {
    for (const match of readFileSync(full, 'utf8').matchAll(/^#{1,4}\s+(KP-[A-Z0-9-]*?-\d{2,4})\s+(.+?)\s*$/gm)) kps.push({ id: match[1], doc: rel(full) });
  }
  const entries = ['rules', 'modules', 'cases', 'parts', 'failures'].flatMap((name) => readJson(`${name}.json`).entries ?? []);
  const sources = readJson('sources.json').sources ?? [];

  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.stats.docs, docs.length);
  assert.equal(graph.stats.kps, kps.length);
  assert.equal(graph.stats.entries, entries.length);
  assert.equal(graph.stats.sources, sources.length);
  assert.ok(graph.stats.edges > 0);

  const ids = new Set();
  for (const node of graph.nodes) {
    assert.ok(node.id, '节点缺少 id');
    assert.ok(!ids.has(node.id), `重复节点：${node.id}`);
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from), `边起点不存在：${edge.from}`);
    assert.ok(ids.has(edge.to), `边终点不存在：${edge.to}`);
    assert.ok(edge.type, '边缺少 type');
  }

  const docPaths = new Set(docs.map((full) => rel(full)));
  for (const node of graph.nodes.filter((item) => item.type === 'doc')) {
    assert.ok(docPaths.has(node.path), `图里的文档不存在：${node.path}`);
    assert.ok(existsSync(join(ROOT, node.path)), `文档文件缺失：${node.path}`);
  }
  for (const node of graph.nodes.filter((item) => item.type === 'kp')) {
    assert.ok(docPaths.has(node.doc), `KP 所属文档不存在：${node.id}`);
  }
  for (const node of graph.nodes.filter((item) => item.type === 'source')) {
    assert.ok(sources.some((source) => `source:${source.id}` === node.id), `来源节点未登记：${node.id}`);
  }

  const edgeTypes = new Set(graph.edges.map((edge) => edge.type));
  for (const type of ['DOC_HAS_KP', 'DOC_HAS_ENTRY', 'DOC_LINKS', 'ENTRY_SOURCE']) {
    assert.ok(edgeTypes.has(type), `缺少边类型：${type}`);
  }
});

test('知识库关联图：Markdown 中的文档链接全部可解析', () => {
  const text = readFileSync(GRAPH_MD, 'utf8');
  const links = [...text.matchAll(/\[[^\]]*\]\(<\.\/([^>]+)>\)/g)].map((match) => match[1]);
  assert.ok(links.length > 0, '关联图没有任何文档链接');
  for (const link of new Set(links)) {
    const target = resolve(KB, link);
    assert.ok(target.startsWith(KB + '/'), `链接越界：${link}`);
    assert.ok(existsSync(target), `关联图链接失效：${link}`);
    assert.equal(basename(target).endsWith('.md'), true, `链接不是 Markdown：${link}`);
  }
  assert.match(text, /## 1\. 总览/);
  assert.match(text, /## 8\. 怎么用/);
});

test('RAG 语料排除导航索引/关联图，避免派生标题污染检索', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-rag-'));
  try {
    writeFileSync(join(dir, 'KNOWLEDGE-INDEX.md'), '# 知识点总索引\n');
    writeFileSync(join(dir, 'KNOWLEDGE-GRAPH.md'), '# 知识库关联图\n');
    writeFileSync(join(dir, 'real.md'), '# 真实知识\n去耦电容靠近电源引脚。\n');
    const result = markdownDocumentsInDirs({ dirs: [dir], baseDir: dir });
    assert.deepEqual(result.documents.map((document) => document.path), ['real.md']);
    assert.deepEqual(result.skipped.map((item) => item.reason).sort(), ['DERIVED_GRAPH', 'NAVIGATION_INDEX']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
