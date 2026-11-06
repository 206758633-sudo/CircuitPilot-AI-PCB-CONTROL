import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  KNOWLEDGE_CODES,
  KNOWLEDGE_CORE_KINDS,
  KNOWLEDGE_EXTENDED_KINDS,
  KNOWLEDGE_KIND_SPECS,
  KNOWLEDGE_KINDS,
  createKnowledgeStore,
} from '../knowledge.mjs';
import { knowledgeDocumentsFromStore } from '../rag/corpus.mjs';

/**
 * 知识类型谱 v2（P0 风险知识化）回归：
 *   - 4 核心 + 4 扩展共 8 类，kind 只表达身份/生命周期，主题放 payload.topic；
 *   - 每个 kind 有稳定身份字段，缺失即 KEY_MISSING（不落无法去重的知识）；
 *   - 同 entityKey 多版本、审核/TTL/门禁可用性与 RAG 语料对扩展类型同样成立。
 */

const EXTENDED_ENTRIES = Object.freeze([
  {
    kind: 'repair',
    title: '修复杂志：补板框尺寸缺失',
    payload: {
      strategyId: 'repair:MISSING_OUTLINE',
      errorCode: 'MISSING_OUTLINE',
      preconditions: ['board.outline 缺失', '未锁定结构图'],
      actions: ['用 DXF 点集生成 outline', '无 DXF 时按结构图宽高生成'],
      riskLevel: 'low',
      sideEffects: [],
      verifyBy: 'design-spec.outline',
      topic: 'fix',
    },
  },
  {
    kind: 'assumption',
    title: '先验：ESP32 + USB-C + 3.3V 典型 2 层叠层',
    payload: {
      assumptionId: 'board-class:esp32-usbc-3v3-2l',
      scope: { boardType: 'mcu-usb', layers: 2, process: 'jlc-1.6mm' },
      parameter: 'stackup',
      value: { layers: 2, thicknessMm: 1.6, copperOz: 1 },
      rationale: '同类板 10/12 例采用 2 层 1.6mm',
      confidence: 0.8,
      verifyBy: 'engineering.stackup',
      topic: 'precedent',
    },
  },
  {
    kind: 'decision',
    title: '决策：CircuitPilot Runtime 必须带 agent-* 路由',
    payload: {
      decisionId: 'decision:runtime-agent-routes',
      topic: 'eda-compat',
      context: '旧构建 0.8.15 缺 project-state/issue-state 等路由',
      options: ['兼容旧构建', '换用 0.2.x Runtime'],
      chosen: '换用 0.2.x Runtime 并 fail-closed',
      rationale: '旧构建没有 agent 通道，兼容会导致静默 404',
      evidenceRefs: ['docs/agent/plugin-compat.md'],
    },
  },
  {
    kind: 'eval-case',
    title: '金板用例：两板批量校验必须区分“任务完成”和“板子通过”',
    payload: {
      caseId: 'eval:batch-validation-board-pass',
      input: { boards: ['pcb-a', 'pcb-b'], targets: ['drc'] },
      expected: [{ board: 'pcb-a', ok: true }, { board: 'pcb-b', ok: false, failedTargets: ['drc'] }],
      goldenEvidence: 'artifacts/agent-eda-batch-20261029.json',
      severity: 'error',
      topic: 'golden-board',
    },
  },
]);

const provenance = () => ({ source: 'unit-test', collector: 'knowledge-kinds-v2' });
const makeStore = () => createKnowledgeStore({ root: mkdtempSync(join(tmpdir(), 'cp-knowledge-v2-')) });

test('类型谱 v2：4 核心 + 4 扩展 = 8 类，身份字段与主题标签齐备', () => {
  assert.deepEqual([...KNOWLEDGE_CORE_KINDS], ['part', 'module', 'rule', 'failure']);
  assert.deepEqual([...KNOWLEDGE_EXTENDED_KINDS], ['repair', 'assumption', 'decision', 'eval-case']);
  assert.deepEqual([...KNOWLEDGE_KINDS], [...KNOWLEDGE_CORE_KINDS, ...KNOWLEDGE_EXTENDED_KINDS]);
  assert.equal(KNOWLEDGE_KINDS.length, 8);
  assert.equal(new Set(KNOWLEDGE_KINDS).size, 8);
  for (const kind of KNOWLEDGE_KINDS) {
    const spec = KNOWLEDGE_KIND_SPECS[kind];
    assert.ok(spec, `缺少 ${kind} 的类型谱`);
    assert.equal(typeof spec.identity, 'string');
    assert.ok(Array.isArray(spec.identityFields) && spec.identityFields.length > 0, `${kind} 缺少身份字段`);
    assert.ok(Array.isArray(spec.topics), `${kind}.topics 必须是数组`);
  }
  assert.equal(KNOWLEDGE_KIND_SPECS.assumption.topics.includes('precedent'), true);
  assert.equal(KNOWLEDGE_KIND_SPECS.failure.topics.includes('anti-pattern'), true);
  assert.equal(KNOWLEDGE_KIND_SPECS.decision.topics.includes('eda-compat'), true);
});

test('扩展四类：save/list/get/query 正常，id 与 entityKey 由身份字段派生', () => {
  const store = makeStore();
  for (const entry of EXTENDED_ENTRIES) {
    const { entry: saved, created } = store.save({ ...entry, provenance: provenance(), trust: 'reference', ttlDays: 30 });
    assert.equal(created, true);
    assert.equal(saved.kind, entry.kind);
    assert.match(saved.id, new RegExp(`^kn-${entry.kind}-[a-f0-9]{16}$`));
    const spec = KNOWLEDGE_KIND_SPECS[entry.kind];
    const listed = store.list({ kind: entry.kind });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].entityKey, entry.payload[spec.identityFields[0]]);
    assert.equal(store.get(saved.id).title, entry.title);
    assert.equal(store.query({ kind: entry.kind, text: entry.payload.topic }).length, 1);
  }
  // 八类都可枚举（核心类为空也不报错）
  for (const kind of KNOWLEDGE_KINDS) assert.ok(Array.isArray(store.list({ kind })));
  assert.equal(store.list({ includeExpired: true }).length, EXTENDED_ENTRIES.length);
});

test('扩展四类：缺少身份字段时抛 KNOWLEDGE_KEY_MISSING（不落无法去重的知识）', () => {
  const store = makeStore();
  for (const entry of EXTENDED_ENTRIES) {
    const spec = KNOWLEDGE_KIND_SPECS[entry.kind];
    const brokenPayload = { ...entry.payload };
    for (const field of spec.identityFields) delete brokenPayload[field];
    assert.throws(
      () => store.save({ kind: entry.kind, title: entry.title, payload: brokenPayload, provenance: provenance(), trust: 'reference' }),
      (error) => error.code === KNOWLEDGE_CODES.KEY_MISSING && error.details?.kind === entry.kind,
      `${entry.kind} 缺身份字段必须 fail-closed`,
    );
  }
});

test('扩展类型：同 entityKey 不同 payload = 多版本；同内容重复保存只更新元数据', () => {
  const store = makeStore();
  const base = EXTENDED_ENTRIES[0];
  const first = store.save({ ...base, provenance: provenance(), trust: 'reference' });
  const second = store.save({ ...base, payload: { ...base.payload, riskLevel: 'medium' }, provenance: provenance(), trust: 'reference' });
  assert.notEqual(first.entry.id, second.entry.id);
  assert.equal(second.created, true);
  const versions = store.list({ kind: 'repair' });
  assert.equal(versions.length, 2);
  assert.deepEqual([...new Set(versions.map((entry) => entry.entityKey))], [base.payload.strategyId]);

  const duplicate = store.save({ ...base, provenance: provenance(), trust: 'reference' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(store.list({ kind: 'repair' }).length, 2);
});

test('扩展类型：审核/TTL/门禁可用性沿用同一套规则', () => {
  const store = makeStore();
  const entry = EXTENDED_ENTRIES[2];
  const saved = store.save({ ...entry, provenance: provenance(), trust: 'reference', ttlDays: 1 });
  assert.equal(store.isUsableForGate(saved.entry), false, 'candidate 不可用于门禁');
  const approved = store.review(saved.entry.id, { state: 'approved', reviewedBy: '维护者' });
  assert.equal(approved.review.state, 'approved');
  assert.equal(store.isUsableForGate(approved), true);
  // 只读查询绝不能把 candidate 当作可用
  assert.equal(store.list({ kind: 'decision' })[0].review.state, 'approved');
});

test('扩展类型进入 RAG 语料并带 knowledgeKind 元数据', () => {
  const store = makeStore();
  for (const entry of EXTENDED_ENTRIES) store.save({ ...entry, provenance: provenance(), trust: 'reference' });
  const documents = knowledgeDocumentsFromStore(store);
  const byKind = new Map(documents.map((document) => [document.meta?.knowledgeKind, document]));
  for (const entry of EXTENDED_ENTRIES) {
    const document = byKind.get(entry.kind);
    assert.ok(document, `${entry.kind} 未进入 RAG 语料`);
    assert.match(document.text, new RegExp(entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(document.meta.gateUsable, false);
  }
});
