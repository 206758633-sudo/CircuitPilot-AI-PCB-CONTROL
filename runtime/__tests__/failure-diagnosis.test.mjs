import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { diagnoseFailure, sanitizeFailureContext, toIssueRecord } from '../failure-diagnosis.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-diag-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-diag-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-diag-memo-')), 'memo.json');

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

test('失败诊断：已知错误码给出建议与修复入口，未知错误码按 error 处理不降级', () => {
  const known = diagnoseFailure({ source: 'runtime', error: { code: 'AUTOMATION_APPROVAL_REQUIRED', message: '需要写板批准' }, context: { recipeId: 'pcb-rebuild-pours', runId: 'run-1' } });
  assert.equal(known.known, true);
  assert.equal(known.severity, 'error');
  assert.equal(known.repair?.page, 'automation');
  assert.match(known.suggestedAction, /人工/);
  assert.equal(known.context.recipeId, 'pcb-rebuild-pours');
  assert.equal(known.context.runId, 'run-1');

  const unknown = diagnoseFailure({ source: 'eda', error: { code: 'WEIRD_FROM_EDA', message: '爆炸了' } });
  assert.equal(unknown.known, false);
  assert.equal(unknown.severity, 'error', '未知失败不能降级成 warning/info');
  assert.equal(unknown.repair, null);
  assert.match(unknown.suggestedAction, /人工排查/);

  const stable = diagnoseFailure({ source: 'eda', error: { code: 'WEIRD_FROM_EDA', message: '爆炸了' } });
  assert.equal(unknown.fingerprint, stable.fingerprint, '同 source/code/operation 必须得到同指纹，便于聚合复发');
});

test('失败诊断：上下文白名单且绝不含令牌/密钥字段', () => {
  const context = sanitizeFailureContext({
    runId: 'run-1',
    token: 'super-secret-token',
    approvalToken: 'another-secret',
    apiKey: 'sk-xxx',
    nested: { token: 'hidden' },
    evidencePath: '/tmp/evidence.json',
    unknownField: 'should-be-dropped',
  });
  assert.equal(context.token, undefined);
  assert.equal(context.approvalToken, undefined);
  assert.equal(context.apiKey, undefined);
  assert.equal(context.nested, undefined);
  assert.equal(context.unknownField, undefined);
  assert.equal(context.runId, 'run-1');
  assert.equal(context.evidencePath, '/tmp/evidence.json');
  assert.ok(!JSON.stringify(context).includes('secret'));
});

test('失败诊断：IssueRecord 带证据上下文与修复入口，缺 code 时拒绝', () => {
  const diagnosis = diagnoseFailure({ source: 'validation', error: { code: 'PRODUCTION_GATE_BLOCKED', message: '闸门阻断' }, context: { evidencePath: '/tmp/drc.json' } });
  const record = toIssueRecord(diagnosis);
  assert.equal(record.severity, 'error');
  assert.equal(record.status, 'open');
  assert.equal(record.code, 'PRODUCTION_GATE_BLOCKED');
  assert.equal(record.context.repairPage, 'validation');
  assert.equal(record.context.evidencePath, '/tmp/drc.json');
  assert.equal(record.occurrences, 1);
  assert.throws(() => toIssueRecord({}), { code: 'FAILURE_DIAGNOSIS_INVALID' });
});

test('失败诊断 HTTP：200 返回统一结构；缺 error/数组 error 返回 400', async (context) => {
  const { server } = createRuntimeServer({ chat: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (body) => fetch(`${base}/api/diagnostics/failure`, { method: 'POST', headers, body: JSON.stringify(body) });

  const ok = await post({ source: 'runtime', error: { code: 'STORE_CORRUPT', message: '状态文件损坏', details: { file: 'state.json' } }, context: { token: 'must-not-leak', runId: 'r-9' } });
  assert.equal(ok.status, 200);
  const { diagnosis } = await ok.json();
  assert.equal(diagnosis.code, 'STORE_CORRUPT');
  assert.equal(diagnosis.severity, 'critical');
  assert.equal(diagnosis.repair.page, 'settings');
  assert.equal(diagnosis.context.token, undefined);
  assert.equal(diagnosis.context.runId, 'r-9');

  const invalid = await post({ source: 'runtime', error: ['not-an-object'] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'FAILURE_DIAGNOSIS_INVALID');
});

test('失败诊断库（E12）：真机高频错误码全部有登记，未知码仍 fail-closed', () => {
  // 这些 code 都是真机日志/证据里实际出现过的，不允许再落进"未分类失败"。
  const known = [
    'BRIDGE_HTTP_ERROR', 'EDA_REQUEST_ABANDONED', 'EDA_JOB_BUSY', 'EDA_GUI_ELEMENT_NOT_FOUND',
    'EDA_GUI_ACTION_NOT_ALLOWED', 'EDA_DOCUMENT_REQUIRED', 'EDA_CAPABILITY_PROBE_FAILED', 'EDA_EXPORT_BUFFER_LOST',
    'TARGET_DRIFT', 'EXECUTION_BUSY', 'SAVE_FAILED', 'READBACK_UNCHANGED', 'READBACK_PRIMITIVE_MISSING',
    'READBACK_NO_CONNECT_MISSING', 'READBACK_WIRE_GEOMETRY_MISSING',
    'NET_CONNECT_CONNECTIONS_INVALID', 'NET_CONNECT_WRITE_FAILED', 'NET_CONNECT_VERIFY_FAILED', 'NET_CONNECT_ROLLBACK_INCOMPLETE',
    'PLACEMENT_WRITE_VERIFY_BLOCKED', 'PLACEMENT_WRITE_READBACK_MISMATCH', 'PLACEMENT_WRITE_ROLLBACK_FAILED',
    'ROUTING_PLAN_REJECTED', 'ROUTING_READBACK_MISMATCH',
    'PRODUCTION_OUTPUT_BLOCKED', 'RELEASE_DECISION_BLOCKED', 'PRODUCTION_EXPORT_VERIFY_FAILED',
    'AUTOMATION_RECIPE_INVALID', 'STORE_CORRUPT', 'PROVIDER_AUTH_FAILED',
  ];
  for (const code of known) {
    const diagnosis = diagnoseFailure({ source: 'eda', error: { code, message: '样本' } });
    assert.equal(diagnosis.known, true, `${code} 必须有诊断条目`);
    assert.ok(diagnosis.suggestedAction.length > 10, `${code} 必须有可执行建议`);
    assert.ok(diagnosis.summary && !diagnosis.summary.includes('未分类'), `${code} 不能落进未分类`);
  }
  // 关键语义：写命令中止/桥 500 的处理建议必须包含"先读回确认"，防止盲目重放。
  assert.match(diagnoseFailure({ source: 'eda', error: { code: 'EDA_REQUEST_ABANDONED', message: 'aborted' } }).suggestedAction, /读回|确认/);
  assert.match(diagnoseFailure({ source: 'eda', error: { code: 'BRIDGE_HTTP_ERROR', message: '500' } }).suggestedAction, /读回|重试/);
});
