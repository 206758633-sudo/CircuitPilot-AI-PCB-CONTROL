import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { createIssueStateStore, ISSUE_LIMIT, normalizeIssueState } from '../issue-state.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-issue-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-issue-evidence-'));
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const ISSUE = (id, extra = {}) => ({ id, fingerprint: `fp-${id}`, source: 'validation', severity: 'warning', status: 'open', summary: `问题 ${id}`, detail: '详情', occurrences: 1, firstSeenAt: '2026-10-20T00:00:00.000Z', lastOccurredAt: '2026-10-20T00:00:00.000Z', context: {}, suggestedAction: '修复', handling: [], ...extra });

async function start(context) {
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    get: () => fetch(`${base}/api/issue-state`, { headers }),
    put: (state) => fetch(`${base}/api/issue-state`, { method: 'PUT', headers, body: JSON.stringify({ state }) }),
  };
}

test('C1 问题记录：校验形状/id/重复，超上限如实截断', () => {
  const normalized = normalizeIssueState({ issues: [ISSUE('i1'), ISSUE('i2')] });
  assert.equal(normalized.total, 2);
  assert.equal(normalized.truncated, 0);
  assert.throws(() => normalizeIssueState(null), (error) => error.code === 'ISSUE_STATE_INVALID');
  assert.throws(() => normalizeIssueState({ issues: 'nope' }), (error) => error.code === 'ISSUE_STATE_INVALID');
  assert.throws(() => normalizeIssueState({ issues: [{ ...ISSUE('') }] }), (error) => error.code === 'ISSUE_STATE_INVALID');
  assert.throws(() => normalizeIssueState({ issues: [ISSUE('dup'), ISSUE('dup')] }), (error) => error.code === 'ISSUE_STATE_INVALID' && error.details.id === 'dup');
  const many = Array.from({ length: ISSUE_LIMIT + 5 }, (_, index) => ISSUE(`i${index}`));
  const truncated = normalizeIssueState({ issues: many });
  assert.equal(truncated.total, ISSUE_LIMIT);
  assert.equal(truncated.truncated, 5);
});

test('C1 问题记录：原子落盘 + 重启读回（同一 store 路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-issue-store-'));
  const file = join(dir, 'issue-state.json');
  const first = createIssueStateStore({ file });
  const saved = first.save({ issues: [ISSUE('persisted')] });
  assert.equal(saved.total, 1);
  assert.ok(saved.savedAt);
  const reopened = createIssueStateStore({ file }).load();
  assert.equal(reopened.total, 1);
  assert.equal(reopened.state.issues[0].id, 'persisted');
});

test('C1 HTTP：GET/PUT 往返、重启后仍读回、非法请求 400', async (context) => {
  const api = await start(context);
  const empty = await (await api.get()).json();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.state.issues, []);
  const saved = await api.put({ issues: [ISSUE('http-1'), ISSUE('http-2', { status: 'investigating' })] });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.total, 2);
  const readBack = await (await api.get()).json();
  assert.equal(readBack.state.issues.length, 2);
  assert.equal(readBack.state.issues[1].status, 'investigating');

  const bad = await api.put({ issues: [{ id: 'ok' }, { id: 'ok' }] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'ISSUE_STATE_INVALID');
});
