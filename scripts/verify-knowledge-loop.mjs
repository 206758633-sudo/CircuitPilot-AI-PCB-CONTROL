#!/usr/bin/env node
/**
 * 知识闭环验证（W3-16 接线后的实机检查）：
 *   1) 生产知识库（artifacts/knowledge，全部 candidate）→ 编排层引用必须被拒绝（fail-closed，不伪造门禁依据）；
 *   2) 临时副本中把一条 rule 条目审核为 approved → 同样流程必须通过，且 usage.jsonl 记下是谁引用的。
 * 输出证据：artifacts/evidence/knowledge-loop/knowledge-loop-<ts>.json（不发散、不改生产库）。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../runtime/knowledge.mjs';
import { createEvidenceEnvelope } from '../runtime/evidence-contract.mjs';
import { runDesignPipeline } from '../runtime/agents/orchestrator.mjs';
import { createEvidenceStore } from '../runtime/evidence-store.mjs';

const spec = { schemaVersion: 1, project: { name: 'knowledge-loop' } };
const envelope = (kind) => createEvidenceEnvelope({ kind, subject: { type: 'pcb', id: 'kb-loop' }, fingerprint: { pcbUuid: 'kb-loop' }, source: { agent: 'verify-knowledge-loop', readOnly: true }, verdict: 'pass', findings: [] });

const prod = createKnowledgeStore({ root: 'artifacts/knowledge' });
const rule = prod.list({ kind: 'rule' })[0];
if (!rule) throw new Error('生产知识库缺少 rule 条目');
const run = async (store, knowledgeStore) => runDesignPipeline({
  spec, knowledgeStore,
  steps: [
    { id: 'netlist-auditor', run: async () => envelope('netlist-diff') },
    { id: 'rule-runner', citations: [{ knowledgeId: rule.id, usedFor: '解释 ERC 规则命中' }], run: async () => envelope('rules') },
  ],
});

const candidateRun = await run(prod, prod);
const tempRoot = mkdtempSync(join(tmpdir(), 'cp-kb-loop-'));
let approvedRun; let usageLines = [];
try {
  cpSync('artifacts/knowledge', tempRoot, { recursive: true });
  const temp = createKnowledgeStore({ root: tempRoot });
  const reviewed = temp.review(rule.id, { state: 'approved', reviewedBy: 'verify-script' });
  if (reviewed?.review?.state !== 'approved') throw new Error(`临时审核失败：${JSON.stringify(reviewed)}`);
  approvedRun = await run(temp, temp);
  const usagePath = join(tempRoot, 'usage.jsonl');
  usageLines = existsSync(usagePath) ? readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const summary = {
  generatedAt: new Date().toISOString(),
  ruleId: rule.id,
  candidate: { verdict: candidateRun.verdict, evidenceCount: candidateRun.evidence.length, failedSteps: candidateRun.failedSteps.map((item) => item.code) },
  approvedTempCopy: { verdict: approvedRun?.verdict, evidenceCount: approvedRun?.evidence.length, citations: approvedRun?.evidence?.find((item) => item.kind === 'rules')?.citations ?? [] },
  usage: usageLines,
  conclusion: candidateRun.verdict === 'unknown' && approvedRun?.verdict === 'pass' && usageLines.length === 1
    ? 'fail-closed 生效：candidate 不能作为门禁依据；人工审核后引用被接受并留 usage 记录'
    : '闭环验证未达到预期，需检查',
};
const store = createEvidenceStore({ root: 'artifacts/evidence' });
const saved = store.save({ kind: 'knowledge', payload: summary, fingerprint: { project: 'knowledge-loop' }, note: '知识引用闭环：candidate 拒绝 / approved 接受 + usage' });
console.log(JSON.stringify({ ok: summary.conclusion.startsWith('fail-closed'), file: saved.path, summary }, null, 2));
