import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiagnosticBundle, BUNDLE_LIMITS, DIAGNOSTIC_BUNDLE_CODES, DIAGNOSTIC_BUNDLE_KIND } from '../diagnostic-bundle.mjs';

const traceFixture = (count) => ({
  savedAt: '2026-10-20T00:00:00.000Z',
  state: {
    versions: Array.from({ length: count }, (_, index) => ({ id: `v${index}`, label: `版本${index}`, at: '2026-10-20T00:00:00.000Z' })),
    changes: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, at: '2026-10-20T00:00:00.000Z', summary: `变更${index}` })),
    audit: Array.from({ length: count }, (_, index) => ({ id: `a${index}`, at: '2026-10-20T00:00:00.000Z', action: `动作${index}` })),
  },
  truncated: { versions: false, changes: true, audit: false },
});

test('H5：诊断包脱敏 token/API Key/邮箱，且不含工程文件内容', () => {
  const bundle = buildDiagnosticBundle({
    version: '0.2.0',
    diagnostics: { token: 'super-secret-token-value', nested: { apiKey: 'sk-live-1234567890' }, email: 'someone@example.com', detail: '正常字段' },
    recentErrors: [{ code: 'BRIDGE_HTTP_ERROR', message: '调用失败 token=super-secret-token-value', at: '2026-10-20T00:00:00.000Z' }],
    now: '2026-10-20T00:00:00.000Z',
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.kind, DIAGNOSTIC_BUNDLE_KIND);
  assert.equal(bundle.redaction.applied, true);
  for (const secret of ['super-secret-token-value', 'sk-live-1234567890', 'someone@example.com']) assert.ok(!serialized.includes(secret), `诊断包不应包含 ${secret}`);
  assert.ok(serialized.includes('正常字段'), '非敏感字段应保留，便于定位');
});

test('H5：各段有硬上限并如实标记截断', () => {
  const bundle = buildDiagnosticBundle({
    version: '0.2.0',
    trace: traceFixture(200),
    evidence: { complete: true, entries: Array.from({ length: 100 }, (_, index) => ({ kind: index % 2 ? 'drc-report' : 'dfm-evidence', digest: `d${index}`, relativePath: `evidence/${index}.json` })) },
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(bundle.trace.counts.versions, 200);
  assert.equal(bundle.trace.versions.length, BUNDLE_LIMITS.traceVersions);
  assert.equal(bundle.trace.changes.length, BUNDLE_LIMITS.traceChanges);
  assert.equal(bundle.trace.truncated, true);
  assert.equal(bundle.evidence.total, 100);
  assert.ok(bundle.evidence.kinds.length <= BUNDLE_LIMITS.evidenceKinds);
  for (const kind of bundle.evidence.kinds) assert.ok(kind.samples.length <= BUNDLE_LIMITS.evidenceEntriesPerKind);
});

test('H5：缺版本/非法错误列表拒绝生成（fail-closed）', () => {
  assert.throws(() => buildDiagnosticBundle({}), (error) => error.code === DIAGNOSTIC_BUNDLE_CODES.INVALID);
  assert.throws(() => buildDiagnosticBundle({ version: '0.2.0', recentErrors: 'not-array' }), (error) => error.code === DIAGNOSTIC_BUNDLE_CODES.INVALID);
});

test('H5：缺失的数据段明确写 available:false + 原因，不伪造空结果', () => {
  const bundle = buildDiagnosticBundle({ version: '0.2.0', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(bundle.evidence.available, false);
  assert.match(bundle.evidence.reason, /未提供/);
  assert.equal(bundle.trace.available, false);
  assert.equal(bundle.journal.available, false);
  assert.equal(bundle.diagnostics.available, false);
});

test('H5：bundleHash 只随内容变化，不随时间变化（可复现）', () => {
  const input = { version: '0.2.0', diagnostics: { checkedAt: '固定', node: { status: 'pass' } }, trace: traceFixture(2) };
  const a = buildDiagnosticBundle({ ...input, now: '2026-10-20T00:00:00.000Z' });
  const b = buildDiagnosticBundle({ ...input, now: '2026-10-20T01:00:00.000Z' });
  assert.equal(a.bundleHash, b.bundleHash);
  const c = buildDiagnosticBundle({ ...input, version: '0.2.1', now: '2026-10-20T00:00:00.000Z' });
  assert.notEqual(a.bundleHash, c.bundleHash);
  assert.match(a.bundleHash, /^[a-f0-9]{64}$/);
});
