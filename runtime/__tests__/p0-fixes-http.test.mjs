import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

// 每个用例独立状态/证据目录：不能读仓库默认 artifacts（那会把历史官方结果/证据带进断言）。
const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start(context) {
  const root = mkdtempSync(join(tmpdir(), 'cp-p0-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  context.after(() => {
    for (const key of ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  return { base, headers };
}

test('P0-1 复审：官方验证结果经 /api/validation-state 持久化，非法载荷 400 且不覆盖', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.state.validations, []);
  const check = {
    id: 'val-official-1', name: 'DRC（官方）', status: 'pass', kind: 'drc', official: true,
    projectUuid: 'proj-1', summary: '0 errors', recordedAt: '2026-10-29T00:00:00.000Z',
    evidence: { executionId: 'exec-1', planHash: 'a'.repeat(64) },
  };
  const saved = await fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify({ state: { validations: [check] } }) });
  assert.equal(saved.status, 200);
  const reloaded = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(reloaded.state.validations.length, 1);
  assert.equal(reloaded.state.validations[0].id, 'val-official-1');
  const invalid = await fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify({ state: { validations: [{ status: 'pass' }] } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'VALIDATION_STATE_INVALID');
  const after = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(after.state.validations.length, 1, '非法请求不得清掉已持久化的官方结果');
});

test('P0-5 复审：会话暂停与全局暂停互不覆盖，写门禁同时认两者', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(initial.gate.paused, false);
  assert.equal(initial.gate.sessionPaused, false);
  const session = await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: true, scope: 'session', reason: '当前会话先停手' }) });
  assert.equal(session.status, 200);
  const afterSession = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(afterSession.gate.sessionPaused, true);
  assert.equal(afterSession.gate.paused, false, '会话暂停不得污染全局暂停');
  assert.equal(afterSession.gate.sessionReason, '当前会话先停手');
  const global = await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: true, scope: 'global', reason: '全局停手' }) });
  assert.equal(global.status, 200);
  const both = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(both.gate.paused, true);
  assert.equal(both.gate.sessionPaused, true);
  await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: false, scope: 'session' }) });
  await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: false, scope: 'global' }) });
  const cleared = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(cleared.gate.paused, false);
  assert.equal(cleared.gate.sessionPaused, false);
});

test('P1-15 复审：联网检索开关由 Runtime 持久化，status 反映真实配置', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/research/config`, { headers })).json();
  assert.equal(initial.config.enabled, false, '联网默认关闭');
  const statusOff = await (await fetch(`${base}/api/research/status`, { headers })).json();
  assert.equal(statusOff.research.enabled, false);
  const enabled = await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, actor: '测试' }) });
  assert.equal(enabled.status, 200);
  const after = await (await fetch(`${base}/api/research/config`, { headers })).json();
  assert.equal(after.config.enabled, true);
  const statusOn = await (await fetch(`${base}/api/research/status`, { headers })).json();
  assert.equal(statusOn.research.enabled, true);
  const invalid = await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: 'yes' }) });
  assert.equal(invalid.status, 400);
  await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: false }) });
});

test('P0-2 复审：门禁取证路由落证据、缺输入只报 missing，不伪造通过', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/eda/gates/collect`, { method: 'POST', headers, body: JSON.stringify({ pcbUuid: 'pcb-test-1', projectId: 'proj-test-1' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.evidenceReport, '取证必须返回证据汇总');
  assert.equal(body.evidenceReport.complete, false, '没有 spec/ERC/DRC 等输入时不能判 complete');
  assert.equal(body.report.verdict, 'unknown', '门禁裁决只能是 unknown，绝不能凭空 pass');
  const missingKinds = new Set(body.missing.map((item) => item.kind));
  for (const kind of ['rules', 'design-spec', 'placement', 'fabrication-release']) {
    assert.ok(missingKinds.has(kind), `${kind} 缺失必须如实登记`);
  }
  assert.deepEqual(body.evidenceReport.producedKinds, []);
  for (const kind of ['rules', 'design-spec', 'placement', 'fabrication-release']) {
    assert.ok(body.evidenceReport.missingKinds.includes(kind), `${kind} 必须进入 missingKinds`);
  }
});

test('P1-4 复审：PCB 写锁状态可查、解除路由可调用（无锁时是幂等空操作）', async (context) => {
  const { base, headers } = await start(context);
  const status = await (await fetch(`${base}/api/pcb/write-lock`, { headers })).json();
  assert.equal(status.ok, true);
  assert.equal(status.writeLock.safetyLocked, false);
  const release = await fetch(`${base}/api/pcb/write-lock/release`, { method: 'POST', headers, body: JSON.stringify({ operator: '测试', note: '确认现场安全' }) });
  assert.equal(release.status, 200);
  const after = await (await fetch(`${base}/api/pcb/write-lock`, { headers })).json();
  assert.equal(after.writeLock.safetyLocked, false);
});
