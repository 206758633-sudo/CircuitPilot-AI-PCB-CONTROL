import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CONTRACT_CODES, defineAgent, invokeAgent } from '../agents/agent-contract.mjs';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';

const envelope = () => createEvidenceEnvelope({ kind: 'netlist-diff', subject: { type: 'pcb', id: 'p' }, fingerprint: { pcbUuid: 'p' }, source: { agent: 'netlist-auditor', readOnly: true }, verdict: 'pass', findings: [] });

test('defineAgent：只读 agent 可定义；可写 agent 直接拒绝', () => {
  const agent = defineAgent({ id: 'netlist-auditor', run: async () => envelope() });
  assert.equal(agent.readOnly, true);
  assert.throws(() => defineAgent({ id: 'bad', readOnly: false, run: async () => ({}) }), (error) => error.code === AGENT_CONTRACT_CODES.NOT_READONLY);
  assert.throws(() => defineAgent({ id: 'Bad Id', run: async () => ({}) }), (error) => error.code === AGENT_CONTRACT_CODES.INVALID);
});

test('invokeAgent：合规证据通过并返回 verdict', async () => {
  const result = await invokeAgent(defineAgent({ id: 'netlist-auditor', run: async () => envelope() }), {});
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.envelope.kind, 'netlist-diff');
});

test('invokeAgent：agent 抛错 → 结构化失败（不伪造通过）', async () => {
  const result = await invokeAgent(defineAgent({ id: 'rule-runner', run: async () => { throw new Error('bridge 不可用'); } }), {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_FAILED');
});

test('invokeAgent：超时 → AGENT_TIMEOUT', async () => {
  const agent = defineAgent({ id: 'slow', timeoutMs: 10, run: () => new Promise((resolve) => setTimeout(() => resolve(envelope()), 200)) });
  const result = await invokeAgent(agent, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CONTRACT_CODES.TIMEOUT);
});

test('invokeAgent：不符合证据契约 → AGENT_EVIDENCE_INVALID（不放出坏证据）', async () => {
  const result = await invokeAgent(defineAgent({ id: 'auditor', run: async () => ({ schemaVersion: 1, kind: 'netlist-diff', verdict: 'pass' }) }), {});
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CONTRACT_CODES.EVIDENCE_INVALID);
});
