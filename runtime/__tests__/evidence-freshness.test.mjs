import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidenceFreshness } from '../evidence-freshness.mjs';

const digest = 'a'.repeat(64);
const entry = (overrides = {}) => ({ kind: 'spice-simulation', digest, savedAt: '2026-10-21T08:00:00.000Z', fingerprint: { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1' }, payload: {}, ...overrides });
const now = Date.parse('2026-10-21T09:00:00.000Z');

test('证据新鲜度：归属与时间都匹配时通过', () => {
  const result = assessEvidenceFreshness(entry(), { current: { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1' }, now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ageHours, 1);
});

test('证据新鲜度：过期证据拒绝（默认 24h，可配）', () => {
  const old = entry({ savedAt: '2026-10-19T08:00:00.000Z' });
  const result = assessEvidenceFreshness(old, { current: { projectUuid: 'p1' }, now });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /过期/);
});

test('证据新鲜度：工程/文档不匹配拒绝（防止引用别的板的仿真）', () => {
  const result = assessEvidenceFreshness(entry(), { current: { projectUuid: 'p2', documentUuid: 'd1' }, now });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /其它工程/);
  const docMismatch = assessEvidenceFreshness(entry(), { current: { projectUuid: 'p1', documentUuid: 'd2' }, now });
  assert.match(docMismatch.problems.join(' '), /其它文档/);
});

test('证据新鲜度：证据没绑定工程时拒绝（无法确认归属）', () => {
  const result = assessEvidenceFreshness(entry({ fingerprint: {} }), { current: { projectUuid: 'p1' }, now });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /没有绑定工程/);
});

test('证据新鲜度：没有当前会话时只校验时间/摘要，不臆造归属结论', () => {
  assert.equal(assessEvidenceFreshness(entry(), { now }).ok, true);
  assert.equal(assessEvidenceFreshness({ ...entry(), digest: 'not-a-digest' }, { now }).ok, false);
  assert.equal(assessEvidenceFreshness(null, { now }).ok, false);
});
