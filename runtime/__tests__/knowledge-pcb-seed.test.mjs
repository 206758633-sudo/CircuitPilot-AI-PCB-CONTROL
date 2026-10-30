import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createKnowledgeStore, KNOWLEDGE_KINDS } from '../knowledge.mjs';
import { createRagIndex } from '../rag/index.mjs';
import { knowledgeDocumentsFromStore } from '../rag/corpus.mjs';
import { DATASET_FILES, loadDataset, seedLocal, validateDataset } from '../../scripts/seed-knowledge-pcb.mjs';

/**
 * K1 知识灌库回归：
 *   - 数据集自检（字段/唯一 entityKey/doc 指针存在）；
 *   - 灌库后条目仍是 candidate + reference（AI/脚本不得自证），且幂等；
 *   - RAG 混合索引能检索到 PCB/原理图/元件三类知识（防止"灌了但搜不到"）。
 */

const dataset = loadDataset();
const tempRoots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-pcb-kb-'));
  tempRoots.push(root);
  return root;
};
after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

test('数据集：四类知识齐全、entityKey 唯一、每条 doc 指针存在', () => {
  assert.ok(dataset.entries.length >= 180, `条目数 ${dataset.entries.length} < 180`);
  for (const kind of KNOWLEDGE_KINDS) assert.ok(dataset.entries.some((entry) => entry.kind === kind), `缺少 ${kind} 条目`);
  for (const [kind, names] of Object.entries(DATASET_FILES)) {
    for (const name of names) assert.ok(dataset.files.some((item) => item.kind === kind && item.file.endsWith(name)), `缺少数据集 ${name}`);
  }
  assert.ok(dataset.entries.some((entry) => entry.datasetFile === 'cases.json'), '缺少参考设计案例条目');
  const problems = validateDataset(dataset.entries);
  assert.deepEqual(problems, []);
  for (const entry of dataset.entries) assert.ok(existsSync(join(process.cwd(), entry.doc)), `文档不存在：${entry.doc}`);
});

test('灌库：全部 candidate + reference，provenance 指向知识文档；重复灌入幂等', () => {
  const root = makeRoot();
  const first = seedLocal({ root, entries: dataset.entries, now: () => new Date('2026-10-22T03:40:00Z') });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.created, dataset.entries.length);
  assert.equal(first.updated, 0);

  const store = createKnowledgeStore({ root });
  const all = store.list({ includeExpired: true });
  assert.equal(all.length, dataset.entries.length);
  for (const entry of all) {
    assert.equal(entry.review.state, 'candidate', `${entry.id} 不得自动 approved`);
    assert.equal(entry.trust, 'reference');
    assert.equal(entry.provenance.source, 'curated-pcb-engineering');
    assert.match(entry.provenance.url, /^docs\/knowledge\/(pcb|schematic|components|cases|checklists)\//);
    assert.equal(store.isUsableForGate(entry), false, `${entry.id} candidate 不应门禁可用`);
  }

  const second = seedLocal({ root, entries: dataset.entries, now: () => new Date('2026-10-22T03:41:00Z') });
  assert.equal(second.ok, true);
  assert.equal(second.created, 0);
  assert.equal(second.updated, dataset.entries.length);
  assert.equal(createKnowledgeStore({ root }).list({ includeExpired: true }).length, dataset.entries.length, '幂等灌库不得新增条目');
});

test('RAG：PCB/原理图/元件关键词都能检索到新知识', () => {
  const root = makeRoot();
  seedLocal({ root, entries: dataset.entries });
  const store = createKnowledgeStore({ root });
  const documents = knowledgeDocumentsFromStore(store, { limit: 2000 });
  const index = createRagIndex();
  index.build({ documents });

  const cases = [
    { query: '去耦电容 摆放 距离', expect: /去耦|decoupl/i },
    { query: 'USB-C CC 5.1k 下拉 不供电', expect: /USB-C|CC|5\.1k/i },
    { query: '立碑 回流焊 一端翘起', expect: /立碑|TOMBSTONE/i },
    { query: '四层板 叠层 阻抗 50 欧姆', expect: /叠层|阻抗|四层/i },
    { query: 'LDO 热耗 压差 结温', expect: /LDO|热耗|压差|结温/i },
  ];
  for (const item of cases) {
    const result = index.search({ query: item.query, topK: 5 });
    assert.ok(result.results.length > 0, `检索无结果：${item.query}`);
    assert.ok(
      result.results.some((hit) => item.expect.test(`${hit.title}\n${hit.heading}\n${hit.text}`)),
      `检索未命中期望知识：${item.query} → ${result.results.map((hit) => hit.title).join(' | ')}`,
    );
  }
});
