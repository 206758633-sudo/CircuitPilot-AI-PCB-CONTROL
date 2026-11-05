import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * 2026-11-05 平台闭环（P1-6）：Supervisor 的源可用性必须随队列下发。
 * 修复前 plan 源启动损坏 → 静默省略成空数组，UI 只看到"没有计划待办"，
 * 无法区分"真的没有"与"这个源读不了（不是没有待办）"。
 */
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start(context, { corruptPlanStore = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-sup-sources-'));
  const keys = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CIRCUITPILOT_STATE_DIR = root;
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  if (corruptPlanStore) writeFileSync(join(root, 'agent-plan-requests.json'), '{"schemaVersion":1,"data":{', 'utf8');
  context.after(() => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  return { base, headers };
}

test('Supervisor sources：正常时三类源都 available=true', async (context) => {
  const { base, headers } = await start(context);
  const body = await (await fetch(`${base}/api/supervisor/attention`, { headers })).json();
  assert.equal(body.ok, true);
  assert.equal(body.sources.validations.available, true);
  assert.equal(body.sources.issues.available, true);
  assert.equal(body.sources.planRequests.available, true);
});

test('Supervisor sources：plan 源损坏时不伪装成"没有待办"，显式 unavailable + reason', async (context) => {
  const { base, headers } = await start(context, { corruptPlanStore: true });
  const response = await fetch(`${base}/api/supervisor/attention`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sources.planRequests.available, false);
  assert.ok(body.sources.planRequests.reason, '必须给出稳定 code');
  assert.ok(body.sources.planRequests.detail, '必须给出可读原因');
  assert.equal(body.sources.validations.available, true);
  assert.equal(body.sources.issues.available, true);
});
