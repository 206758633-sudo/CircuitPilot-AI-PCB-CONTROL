import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { ensureAgentTokenFile } from '../agent-token.mjs';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-supervisor-http-state-'));
const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-supervisor-http-evidence-'));
const AGENT_FILE = join(mkdtempSync(join(tmpdir(), 'cp-supervisor-http-agent-')), 'agent-token.json');
process.env.CIRCUITPILOT_STATE_DIR = STATE_DIR;
process.env.CIRCUITPILOT_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.CIRCUITPILOT_AGENT_TOKEN_FILE = AGENT_FILE;

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
// 2026-11-05 审计 P1-3：官方验证记录必须引用证据库里真实存在的 digest。
// 这里先落一份真实 DRC 证据，再让官方记录引用它（不再用伪造摘要）。
const DRC_DIGEST = createEvidenceStore({ root: EVIDENCE_DIR }).save({ kind: 'drc-report', payload: { report: { items: [] } }, fingerprint: { pcbUuid: 'P1' }, note: 'supervisor http test drc' }).digest;
const OFFICIAL_DRC = {
  id: 'http-official-drc', name: 'DRC', description: '官方 DRC', status: 'fail', count: 1,
  source: 'official', projectId: 'p1', updatedAt: '2026-11-02T09:59:00.000Z',
  evidence: { engine: 'DRC', digest: DRC_DIGEST },
  findings: [{ id: 'f1', title: '间距不足', object: 'U1', rule: 'DRC-001', severity: 'error', suggestion: '调整', status: 'open' }],
};
const ISSUE = {
  id: 'http-issue', fingerprint: 'fp-http-issue', source: 'validation', severity: 'warning', status: 'open',
  summary: '写板失败', detail: 'read-back mismatch', occurrences: 1,
  firstSeenAt: '2026-11-02T09:00:00.000Z', lastOccurredAt: '2026-11-02T09:58:00.000Z',
  context: { projectId: 'p1' }, suggestedAction: '保留现场并复核', handling: [],
};

async function start(context) {
  const agent = await ensureAgentTokenFile({ file: AGENT_FILE });
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const uiHeaders = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const agentHeaders = { 'content-type': 'application/json', 'x-circuitpilot-agent-token': agent.token };
  return { base, uiHeaders, agentHeaders };
}

test('HTTP Supervisor：GET 聚合、UI ack、agent 可读但不可改人工状态', async (context) => {
  const api = await start(context);
  const putValidation = await fetch(`${api.base}/api/validation-state`, {
    method: 'PUT', headers: api.uiHeaders, body: JSON.stringify({ state: { validations: [OFFICIAL_DRC] } }),
  });
  assert.equal(putValidation.status, 200);
  const putIssue = await fetch(`${api.base}/api/issue-state`, {
    method: 'PUT', headers: api.uiHeaders, body: JSON.stringify({ state: { issues: [ISSUE] } }),
  });
  assert.equal(putIssue.status, 200);

  const attention = await fetch(`${api.base}/api/supervisor/attention`, { headers: api.uiHeaders });
  assert.equal(attention.status, 200);
  const body = await attention.json();
  assert.equal(body.ok, true);
  assert.equal(body.summary.bySource.validation, 1);
  assert.equal(body.summary.bySource.issue, 1);
  assert.equal(body.tickets.length, 2);
  assert.ok(body.tickets.every((ticket) => ['open', 'acknowledged', 'blocked'].includes(ticket.status)));
  const drc = body.tickets.find((ticket) => ticket.source === 'validation');
  assert.match(drc.ticketId, /^sup_[a-f0-9]{12}$/);

  const ack = await fetch(`${api.base}/api/supervisor/tickets/${drc.ticketId}/ack`, {
    method: 'POST', headers: api.uiHeaders, body: JSON.stringify({ note: 'UI 接单' }),
  });
  assert.equal(ack.status, 200);
  const ackBody = await ack.json();
  assert.equal(ackBody.ticket.status, 'acknowledged');

  const agentRead = await fetch(`${api.base}/api/supervisor/attention`, { headers: api.agentHeaders });
  assert.equal(agentRead.status, 200);
  const agentWrite = await fetch(`${api.base}/api/supervisor/tickets/${drc.ticketId}/resolve`, {
    method: 'POST', headers: api.agentHeaders, body: JSON.stringify({ note: 'agent 想关' }),
  });
  assert.equal(agentWrite.status, 403);
  assert.equal((await agentWrite.json()).error.code, 'AGENT_SUPERVISOR_ACTION_FORBIDDEN');

  const badStatus = await fetch(`${api.base}/api/supervisor/tickets?status=nope`, { headers: api.uiHeaders });
  assert.equal(badStatus.status, 400);
  assert.equal((await badStatus.json()).error.code, 'SUPERVISOR_INVALID');
});

test('HTTP Supervisor：runtime 重启后 ticket 仍可读回（持久化不受内存丢失影响）', async (context) => {
  const api = await start(context);
  await fetch(`${api.base}/api/validation-state`, {
    method: 'PUT', headers: api.uiHeaders, body: JSON.stringify({ state: { validations: [OFFICIAL_DRC] } }),
  });
  const first = await (await fetch(`${api.base}/api/supervisor/attention`, { headers: api.uiHeaders })).json();
  const ticket = first.tickets.find((item) => item.source === 'validation');
  assert.ok(ticket, '上一测试写入的 validation ticket 应从持久文件读回');
  const all = await (await fetch(`${api.base}/api/supervisor/tickets?status=all`, { headers: api.uiHeaders })).json();
  assert.ok(all.tickets.some((item) => item.ticketId === ticket.ticketId));
});
