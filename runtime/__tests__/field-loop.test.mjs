import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { FIELD_LOOP_CODES, buildRegressionCase, createFieldIssue, submitFieldIssue } from '../agents/field-loop.mjs';

test('createFieldIssue：缺字段拒绝；无根因标记 needsInvestigation', () => {
  assert.throws(() => createFieldIssue({ symptom: 'x' }), (error) => error.code === FIELD_LOOP_CODES.INVALID);
  const issue = createFieldIssue({ issueId: 'ISSUE-1', symptom: 'GND 未连通', now: () => new Date('2026-10-21T12:00:00.000Z') });
  assert.equal(issue.needsInvestigation, true);
  assert.equal(issue.createdAt, '2026-10-21T12:00:00.000Z');
});

test('buildRegressionCase：必须带期望 code，且不伪造根因', () => {
  const issue = createFieldIssue({ issueId: 'ISSUE-2', symptom: '引脚悬空', rootCause: '缺少网络连接' });
  assert.throws(() => buildRegressionCase(issue), (error) => error.code === FIELD_LOOP_CODES.INVALID);
  const regression = buildRegressionCase(issue, { expectedCodes: ['NETLIST_PIN_FLOATING', 'NETLIST_PIN_FLOATING'] });
  assert.equal(regression.expected.verdict, 'blocked');
  assert.deepEqual(regression.expected.codes, ['NETLIST_PIN_FLOATING']);
  assert.equal(regression.sourceIssue, 'ISSUE-2');
});

test('submitFieldIssue：问题单落证据 + 知识库失败条目（candidate）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'field-'));
  try {
    const evidenceStore = createEvidenceStore({ root: join(root, 'evidence') });
    const knowledgeStore = createKnowledgeStore({ root: join(root, 'knowledge') });
    const issue = createFieldIssue({ issueId: 'ISSUE-3', boardId: 'main', pcbUuid: 'pcb-a', symptom: 'GND 空网', rootCause: '地网络未布线' });
    const submitted = await submitFieldIssue({ issue, evidenceStore, knowledgeStore, expectedCodes: ['NETLIST_GND_EMPTY'] });
    assert.ok(submitted.evidencePath);
    assert.ok(submitted.knowledgeId);
    const entries = knowledgeStore.query({ text: 'GND 空网' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].review.state, 'candidate');
    assert.equal(entries[0].kind, 'failure');
    await assert.rejects(() => submitFieldIssue({ issue: createFieldIssue({ issueId: 'ISSUE-4', symptom: 'x' }) }), (error) => error.code === FIELD_LOOP_CODES.INVALID);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
