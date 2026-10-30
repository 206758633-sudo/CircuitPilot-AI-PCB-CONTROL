import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { createValidationStateStore, VALIDATION_LIMIT, normalizeValidationState } from '../validation-state.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-validation-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-validation-evidence-'));
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const CHECK = (id, extra = {}) => ({ id, name: 'DRC', description: '官方 DRC', status: 'pass', count: 0, findings: [], source: 'official', projectId: 'p1', evidence: { engine: 'DRC', digest: 'd'.repeat(64) }, ...extra });

async function start(context) {
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    get: () => fetch(`${base}/api/validation-state`, { headers }),
    put: (state) => fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify({ state }) }),
  };
}

test('P0-1 验证结果：校验形状/id/name/重复，超上限如实截断', () => {
  const normalized = normalizeValidationState({ validations: [CHECK('v1'), CHECK('v2')] });
  assert.equal(normalized.total, 2);
  assert.throws(() => normalizeValidationState(null), (error) => error.code === 'VALIDATION_STATE_INVALID');
  assert.throws(() => normalizeValidationState({ validations: 'nope' }), (error) => error.code === 'VALIDATION_STATE_INVALID');
  assert.throws(() => normalizeValidationState({ validations: [{ ...CHECK('') }] }), (error) => error.code === 'VALIDATION_STATE_INVALID');
  assert.throws(() => normalizeValidationState({ validations: [{ id: 'x' }] }), (error) => error.code === 'VALIDATION_STATE_INVALID');
  assert.throws(() => normalizeValidationState({ validations: [CHECK('dup'), CHECK('dup')] }), (error) => error.code === 'VALIDATION_STATE_INVALID' && error.details.id === 'dup');
  const many = Array.from({ length: VALIDATION_LIMIT + 3 }, (_, index) => CHECK(`v${index}`));
  const truncated = normalizeValidationState({ validations: many });
  assert.equal(truncated.total, VALIDATION_LIMIT);
  assert.equal(truncated.truncated, 3);
});

test('P0-1 验证结果：原子落盘 + 重启读回（official 证据字段不丢）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-validation-store-'));
  const file = join(dir, 'validation-state.json');
  const first = createValidationStateStore({ file });
  assert.equal(first.save({ validations: [CHECK('persisted')] }).total, 1);
  const reopened = createValidationStateStore({ file }).load();
  assert.equal(reopened.total, 1);
  assert.equal(reopened.state.validations[0].source, 'official');
  assert.equal(reopened.state.validations[0].projectId, 'p1');
  assert.equal(reopened.state.validations[0].evidence.digest, 'd'.repeat(64));
});

test('P0-1 HTTP：GET/PUT 往返、重启后仍读回、非法请求 400', async (context) => {
  const api = await start(context);
  const empty = await (await api.get()).json();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.state.validations, []);
  const saved = await api.put({ validations: [CHECK('http-1'), CHECK('http-2', { name: 'ERC', status: 'fail', count: 2 })] });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.total, 2);
  const readBack = await (await api.get()).json();
  assert.equal(readBack.state.validations.length, 2);
  assert.equal(readBack.state.validations[1].name, 'ERC');
  assert.equal(readBack.state.validations[1].count, 2);

  const bad = await api.put({ validations: [{ id: 'ok' }] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'VALIDATION_STATE_INVALID');
});
