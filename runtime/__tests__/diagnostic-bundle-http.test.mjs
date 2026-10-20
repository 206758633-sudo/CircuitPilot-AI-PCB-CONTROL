import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-bundle-evidence-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-bundle-automation-'));
process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-bundle-state-'));

const SECRET = 'super-secret-bundle-token-123456';
const keychain = { async configured() { return false; }, async store() { return { configured: true }; }, async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); }, async remove() { return { configured: false }; } };
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

test('H5：GET /api/diagnostics/bundle 返回脱敏有界诊断包', async (context) => {
  const { server } = createRuntimeServer({
    keychain,
    bridge: { port: 1, async discover() { return { port: 1 }; }, async windows() { return { windows: [], selectedWindowId: null, selectionRequired: false }; } },
    // 故意把敏感值放进诊断数据：HTTP 响应必须已被脱敏。
    diagnostics: async () => ({ checkedAt: '2026-10-20T00:00:00.000Z', token: SECRET, nested: { apiKey: SECRET }, detail: '正常诊断字段' }),
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/api/diagnostics/bundle`, { headers: { origin: TRUSTED_ORIGIN } });
  assert.equal(unauthorized.status, 401, '无令牌不允许导出诊断包');

  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const response = await fetch(`${base}/api/diagnostics/bundle`, { headers: { origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  const bundle = payload.bundle;
  assert.equal(bundle.kind, 'circuitpilot-diagnostic-bundle');
  assert.match(bundle.bundleHash, /^[a-f0-9]{64}$/);
  assert.equal(bundle.redaction.applied, true);
  assert.equal(bundle.runtime.version.length > 0, true);
  assert.equal(typeof bundle.recentErrors.length, 'number');
  // 证据/追溯/journal 段允许 available:false（测试环境没有历史数据），但必须有原因，不能是空对象。
  for (const section of ['evidence', 'trace', 'journal']) {
    if (bundle[section].available === false) assert.ok(bundle[section].reason, `${section} 不可用时必须写原因`);
  }
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(SECRET), '响应中不得出现未脱敏的 token/apiKey');
  assert.ok(serialized.includes('正常诊断字段'), '非敏感字段应保留');
});
