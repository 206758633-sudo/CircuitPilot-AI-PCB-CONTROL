import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceStateStore, normalizeTraceState, TRACE_LIMITS, TRACE_STATE_CODES } from '../trace-state.mjs';

const version = (id) => ({ id, label: id, kind: 'snapshot', date: '2026-10-20', summary: 's', validationStatus: 'pass', requirements: 1, components: 1, designObjects: 1 });
const change = (id) => ({ id, time: '2026-10-20', source: 'user', actor: 'a', action: 'update', objectType: 'requirement', objectId: 'r1', summary: 's' });
const audit = (id) => ({ id, time: '2026-10-20', type: 'version', title: 't', detail: 'd', status: 'info' });

test('C1：追溯状态校验 fail-closed —— 形状错误/缺 id/id 重复一律 TRACE_STATE_INVALID', () => {
  assert.throws(() => normalizeTraceState(null), (error) => error.code === TRACE_STATE_CODES.INVALID);
  assert.throws(() => normalizeTraceState({ versions: 'x' }), (error) => error.code === TRACE_STATE_CODES.INVALID && error.details.field === 'versions');
  assert.throws(() => normalizeTraceState({ changes: [{ id: '' }] }), (error) => error.code === TRACE_STATE_CODES.INVALID);
  assert.throws(() => normalizeTraceState({ audit: [audit('a1'), audit('a1')] }), (error) => error.code === TRACE_STATE_CODES.INVALID && error.details.id === 'a1');
});

test('C1：追溯状态归一化保留条目并报告超限截断（版本 500 / 修改 2000 / 审计 2000）', () => {
  const versions = Array.from({ length: TRACE_LIMITS.versions + 3 }, (_, index) => version(`v${index}`));
  const changes = Array.from({ length: TRACE_LIMITS.changes + 2 }, (_, index) => change(`c${index}`));
  const result = normalizeTraceState({ versions, changes, audit: [audit('a1')] });
  assert.equal(result.state.versions.length, TRACE_LIMITS.versions);
  assert.equal(result.truncated.versions, 3);
  assert.equal(result.state.changes.length, TRACE_LIMITS.changes);
  assert.equal(result.truncated.changes, 2);
  assert.equal(result.truncated.audit, 0);
});

test('C1：追溯状态原子落盘，重启后读回一致（真文件）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cp-trace-')), 'trace-state.json');
  const first = createTraceStateStore({ file });
  assert.equal(first.load().savedAt, null);
  const saved = first.save({ versions: [version('v1')], changes: [change('c1')], audit: [audit('a1')] });
  assert.ok(saved.savedAt);
  const second = createTraceStateStore({ file });
  const loaded = second.load();
  assert.deepEqual(loaded.state.versions.map((item) => item.id), ['v1']);
  assert.deepEqual(loaded.state.changes.map((item) => item.id), ['c1']);
  assert.deepEqual(loaded.state.audit.map((item) => item.id), ['a1']);
  assert.equal(loaded.savedAt, saved.savedAt);
});

test('C1：损坏的追溯状态文件大声失败（STORE_CORRUPT），不假装空状态', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cp-trace-bad-')), 'trace-state.json');
  writeFileSync(file, '{ not-json', 'utf8');
  assert.throws(() => createTraceStateStore({ file }).load(), (error) => error.code === 'STORE_CORRUPT');
});
