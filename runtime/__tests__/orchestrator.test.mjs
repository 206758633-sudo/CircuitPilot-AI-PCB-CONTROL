import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';
import { planPipeline, runDesignPipeline } from '../agents/orchestrator.mjs';

const spec = { schemaVersion: 1, project: { name: 'demo' } };
const passEnvelope = (kind) => createEvidenceEnvelope({ kind, subject: { type: 'pcb', id: 'pcb-a' }, fingerprint: { pcbUuid: 'pcb-a' }, source: { agent: 'fake', readOnly: true }, verdict: 'pass', findings: [] });
const blockedEnvelope = (kind) => createEvidenceEnvelope({ kind, subject: { type: 'pcb', id: 'pcb-a' }, fingerprint: { pcbUuid: 'pcb-a' }, source: { agent: 'fake', readOnly: true }, verdict: 'blocked', findings: [{ code: 'RULE_ERROR', severity: 'error', message: '未处理' }] });

test('planPipeline：默认编排步骤与必需证据', () => {
  const plan = planPipeline();
  assert.deepEqual(plan.steps, ['librarian', 'netlist-auditor', 'rule-runner']);
  assert.deepEqual(plan.requiredKinds, ['netlist-diff', 'rules']);
});

test('runDesignPipeline：全部 pass → pass', async () => {
  const result = await runDesignPipeline({ spec, steps: [
    { id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') },
    { id: 'rule-runner', run: async () => passEnvelope('rules') },
  ] });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.ok, true);
  assert.equal(result.evidence.length, 2);
});

test('runDesignPipeline：缺必需证据/agent 抛错 → unknown（不伪造通过）', async () => {
  const missing = await runDesignPipeline({ spec, steps: [{ id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') }] });
  assert.equal(missing.verdict, 'unknown');
  const failed = await runDesignPipeline({ spec, steps: [
    { id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') },
    { id: 'rule-runner', run: async () => { throw new Error('bridge 不可用'); } },
  ] });
  assert.equal(failed.verdict, 'unknown');
  assert.equal(failed.failedSteps.length, 1);
  assert.equal(failed.failedSteps[0].id, 'rule-runner');
});

test('runDesignPipeline：任一 blocked → blocked；证据契约非法 → unknown', async () => {
  const blocked = await runDesignPipeline({ spec, steps: [
    { id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') },
    { id: 'rule-runner', run: async () => blockedEnvelope('rules') },
  ] });
  assert.equal(blocked.verdict, 'blocked');
  const invalid = await runDesignPipeline({ spec, steps: [{ id: 'netlist-auditor', run: async () => ({ kind: 'netlist-diff', verdict: 'pass' }) }] });
  assert.equal(invalid.verdict, 'unknown');
});

test('runDesignPipeline：步骤知识引用经核验后进证据并记录 usage（W3-16）', async () => {
  const usage = [];
  const entry = { id: 'kn-rule-1', kind: 'rule', trust: 'approved', review: { state: 'approved', reviewedBy: 'human' }, expired: false, digest: 'd1', entityKey: 'ERC_ERROR' };
  const knowledgeStore = {
    get: (id) => (id === 'kn-rule-1' ? entry : null),
    isUsableForGate: (item) => item === entry,
    recordUsage: (record) => usage.push(record),
  };
  const result = await runDesignPipeline({ spec, knowledgeStore, steps: [
    { id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') },
    { id: 'rule-runner', citations: [{ knowledgeId: 'kn-rule-1', usedFor: '解释 ERC_ERROR' }], run: async () => passEnvelope('rules') },
  ] });
  assert.equal(result.verdict, 'pass');
  const ruleEvidence = result.evidence.find((item) => item.kind === 'rules');
  assert.equal(ruleEvidence.citations.length, 1);
  assert.equal(ruleEvidence.citations[0].knowledgeId, 'kn-rule-1');
  assert.deepEqual(usage.map((item) => item.id), ['kn-rule-1']);
  assert.equal(usage[0].agent, 'rule-runner');
});

test('runDesignPipeline：知识引用无效/缺知识库 → 该证据作废，门禁 unknown（不伪造）', async () => {
  const knowledgeStore = { get: () => null, isUsableForGate: () => false, recordUsage: () => {} };
  const invalidCitation = await runDesignPipeline({ spec, knowledgeStore, steps: [
    { id: 'rule-runner', citations: [{ knowledgeId: 'kn-missing' }], run: async () => passEnvelope('rules') },
  ] });
  assert.equal(invalidCitation.verdict, 'unknown');
  assert.equal(invalidCitation.evidence.length, 0);
  assert.equal(invalidCitation.failedSteps[0].id, 'rule-runner');

  const noStore = await runDesignPipeline({ spec, steps: [
    { id: 'rule-runner', citations: [{ knowledgeId: 'kn-rule-1' }], run: async () => passEnvelope('rules') },
  ] });
  assert.equal(noStore.verdict, 'unknown');
  assert.equal(noStore.evidence.length, 0);
});

test('runDesignPipeline：RAG 检索命中附到证据；声明检索却未注入/检索抛错 → unknown（W3-20）', async () => {
  const rag = {
    search: ({ query, topK }) => ({ mode: 'hybrid', results: [
      { chunkId: 'kn:1#0', docId: 'kn:1', title: 'ERC 悬空引脚规则', heading: 'ERC', kind: 'knowledge', path: null, knowledgeId: 'kn-1', score: 0.8, text: '悬空引脚必须处理' },
      { chunkId: 'doc:1#0', docId: 'doc:1', title: 'DRC 说明', heading: 'DRC', kind: 'doc', path: 'docs/drc.md', knowledgeId: null, score: 0.6, text: '间距 0.2mm' },
    ].slice(0, topK) }),
  };
  const result = await runDesignPipeline({ spec, rag, steps: [
    { id: 'netlist-auditor', run: async () => passEnvelope('netlist-diff') },
    { id: 'rule-runner', ragQuery: '悬空引脚 怎么处理', ragTopK: 1, run: async () => passEnvelope('rules') },
  ] });
  assert.equal(result.verdict, 'pass');
  const ruleEvidence = result.evidence.find((item) => item.kind === 'rules');
  assert.equal(ruleEvidence.retrieval.query, '悬空引脚 怎么处理');
  assert.equal(ruleEvidence.retrieval.results.length, 1);
  assert.equal(ruleEvidence.retrieval.results[0].knowledgeId, 'kn-1');

  const noRag = await runDesignPipeline({ spec, steps: [
    { id: 'rule-runner', ragQuery: '悬空引脚', run: async () => passEnvelope('rules') },
  ] });
  assert.equal(noRag.verdict, 'unknown');
  assert.equal(noRag.failedSteps[0].id, 'rule-runner');

  const broken = await runDesignPipeline({ spec, rag: { search: () => { throw new Error('索引损坏'); } }, steps: [
    { id: 'rule-runner', ragQuery: '悬空引脚', run: async () => passEnvelope('rules') },
  ] });
  assert.equal(broken.verdict, 'unknown');
  assert.equal(broken.evidence.length, 0);
});
