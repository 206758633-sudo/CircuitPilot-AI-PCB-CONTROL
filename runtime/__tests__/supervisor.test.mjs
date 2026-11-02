import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSupervisorSignals,
  createSupervisor,
  SUPERVISOR_CODES,
} from '../supervisor.mjs';

const NOW = () => new Date('2026-11-02T10:00:00.000Z');
const LATER = () => new Date('2026-11-02T10:05:00.000Z');
const OFFICIAL_DRC = (extra = {}) => ({
  id: 'official-drc-1',
  name: 'DRC',
  description: '官方设计规则检查',
  status: 'fail',
  count: 2,
  source: 'official',
  projectId: 'p1',
  updatedAt: '2026-11-02T09:59:00.000Z',
  evidence: { engine: 'DRC', digest: 'd'.repeat(64) },
  findings: [{
    id: 'f1', title: '间距不足', object: 'U1', rule: 'DRC-001', severity: 'error', suggestion: '调整', status: 'open',
  }],
  ...extra,
});
const ISSUE = (extra = {}) => ({
  id: 'issue-1', fingerprint: 'fp-issue-1', source: 'validation', severity: 'warning', status: 'open',
  summary: '写板失败', detail: 'read-back mismatch', occurrences: 2,
  firstSeenAt: '2026-11-02T09:00:00.000Z', lastOccurredAt: '2026-11-02T09:58:00.000Z',
  context: { projectId: 'p1' }, suggestedAction: '保留现场并复核', handling: [],
  ...extra,
});
const PLAN = (extra = {}) => ({
  requestId: 'apr_0123456789abcdef', status: 'pending', kind: 'pcb', title: '铺铜重建',
  planHash: 'a'.repeat(64), projectId: 'p1', documentUuid: 'doc-1',
  risks: ['会重铺 GND'], missing: [], createdAt: Date.parse('2026-11-02T09:10:00.000Z'),
  expiresAt: Date.parse('2026-11-03T09:10:00.000Z'),
  ...extra,
});

test('Supervisor 信号：只收 official validation，不收 demo/人工记录', () => {
  const signals = buildSupervisorSignals({
    validations: [
      OFFICIAL_DRC(),
      OFFICIAL_DRC({ id: 'demo-1', source: 'demo' }),
      OFFICIAL_DRC({ id: 'manual-1', source: 'manual', status: 'warn' }),
    ],
    issues: [ISSUE()],
    planRequests: [PLAN()],
  }).signals;
  assert.equal(signals.filter((signal) => signal.source === 'validation').length, 1);
  assert.equal(signals.length, 3);
  assert.equal(signals.find((signal) => signal.source === 'validation').severity, 'error');
  assert.equal(signals.find((signal) => signal.source === 'issue').severity, 'warning');
  assert.equal(signals.find((signal) => signal.source === 'plan').severity, 'warning');
});

test('Supervisor 扫描：建单/去重/人工动作/源变化重开/明确通过自动收口', () => {
  const supervisor = createSupervisor({ now: NOW });
  let snapshot = supervisor.scan({ validations: [OFFICIAL_DRC()], issues: [ISSUE()], planRequests: [PLAN()] });
  assert.equal(snapshot.tickets.length, 3);
  assert.equal(snapshot.summary.attention, 3);
  assert.equal(snapshot.summary.bySource.validation, 1);

  const drc = snapshot.tickets.find((ticket) => ticket.source === 'validation');
  const beforeDedupe = drc.ticketId;
  snapshot = supervisor.scan({ validations: [OFFICIAL_DRC()], issues: [ISSUE()], planRequests: [PLAN()] });
  const deduped = snapshot.tickets.find((ticket) => ticket.source === 'validation');
  assert.equal(deduped.ticketId, beforeDedupe);
  assert.equal(deduped.occurrences, 1, '同一信号反复扫描不重复计数');

  const acknowledged = supervisor.ack(deduped.ticketId, { note: '开始定位' });
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.note, '开始定位');

  const resolved = supervisor.resolve(deduped.ticketId, { note: '已修复并重跑' });
  assert.equal(resolved.status, 'done');
  assert.equal(resolved.closedAt, NOW().toISOString());

  // “已解决”只代表人的判断；源仍然是 fail 时必须重新打开，不能让真实失败从队列消失。
  snapshot = supervisor.scan({ validations: [OFFICIAL_DRC()] });
  const stillFailing = snapshot.tickets.find((ticket) => ticket.ticketId === deduped.ticketId);
  assert.equal(stillFailing.status, 'open');
  assert.match(stillFailing.note, /源仍显示未通过/);

  // 源记录更新（updatedAt 变化）属于新一轮失败，应保持打开并累计出现次数。
  snapshot = supervisor.scan({ validations: [OFFICIAL_DRC({ updatedAt: '2026-11-02T10:04:00.000Z' })] });
  const reopened = snapshot.tickets.find((ticket) => ticket.ticketId === deduped.ticketId);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.occurrences, 2);

  // 明确的 pass 才能自动收口；缺失记录不自动收口。
  snapshot = supervisor.scan({ validations: [OFFICIAL_DRC({ status: 'pass', count: 0, findings: [] })] });
  assert.equal(snapshot.tickets.find((ticket) => ticket.ticketId === deduped.ticketId).status, 'done');
  const kept = createSupervisor({ now: NOW });
  kept.scan({ validations: [OFFICIAL_DRC()] });
  assert.equal(kept.scan({}).tickets[0].status, 'open', '源暂时缺失不能当成已解决');
});

test('Supervisor 计划/问题收口：approved/resolved 自动关单，dismiss 后同信号不复活', () => {
  const supervisor = createSupervisor({ now: NOW });
  let snapshot = supervisor.scan({ issues: [ISSUE()], planRequests: [PLAN()] });
  assert.equal(snapshot.tickets.length, 2);
  const issue = snapshot.tickets.find((ticket) => ticket.source === 'issue');
  const plan = snapshot.tickets.find((ticket) => ticket.source === 'plan');
  assert.equal(plan.dueAt, '2026-11-03T09:10:00.000Z');

  supervisor.dismiss(issue.ticketId, { note: '已知噪声' });
  snapshot = supervisor.scan({ issues: [ISSUE()], planRequests: [PLAN()] });
  assert.equal(snapshot.tickets.find((ticket) => ticket.ticketId === issue.ticketId).status, 'dismissed');

  snapshot = supervisor.scan({ issues: [ISSUE({ status: 'resolved', lastOccurredAt: '2026-11-02T10:01:00.000Z' })], planRequests: [PLAN({ status: 'approved', decidedAt: Date.parse('2026-11-02T10:01:00.000Z') })] });
  assert.equal(snapshot.tickets.find((ticket) => ticket.ticketId === issue.ticketId).status, 'dismissed');
  assert.equal(snapshot.tickets.find((ticket) => ticket.ticketId === plan.ticketId).status, 'done');
});

test('Supervisor 持久化：原子落盘 + 重启读回；状态文件损坏 fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-supervisor-'));
  const file = join(dir, 'supervisor-tickets.json');
  const first = createSupervisor({ file, now: NOW });
  const snapshot = first.scan({ validations: [OFFICIAL_DRC()] });
  const ticketId = snapshot.tickets[0].ticketId;
  first.ack(ticketId, { note: '已接单' });

  const reopened = createSupervisor({ file, now: LATER });
  const loaded = reopened.snapshot();
  assert.equal(loaded.tickets.length, 1);
  assert.equal(loaded.tickets[0].ticketId, ticketId);
  assert.equal(loaded.tickets[0].status, 'acknowledged');
  assert.equal(loaded.tickets[0].note, '已接单');

  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{not-json', 'utf8');
  assert.throws(() => createSupervisor({ file: corrupt, now: NOW }), (error) => error.code === SUPERVISOR_CODES.STORE_UNAVAILABLE && error.status === 503);
});

test('Supervisor 人工动作：未知 ticket 404，已关闭 409，非法 close 400', () => {
  const supervisor = createSupervisor({ now: NOW });
  assert.throws(() => supervisor.ack('sup_000000000000'), (error) => error.code === SUPERVISOR_CODES.TICKET_NOT_FOUND && error.status === 404);
  const ticket = supervisor.scan({ validations: [OFFICIAL_DRC()] }).tickets[0];
  supervisor.resolve(ticket.ticketId);
  assert.throws(() => supervisor.ack(ticket.ticketId), (error) => error.code === SUPERVISOR_CODES.TICKET_CLOSED && error.status === 409);
  const fresh = supervisor.scan({ validations: [OFFICIAL_DRC({ updatedAt: '2026-11-02T10:03:00.000Z' })] }).tickets[0];
  assert.throws(() => supervisor.close(fresh.ticketId, { status: 'bogus' }), (error) => error.code === SUPERVISOR_CODES.INVALID && error.status === 400);
});
