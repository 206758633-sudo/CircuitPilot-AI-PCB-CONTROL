import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-trace-http-state-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-trace-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-trace-memo-${process.pid}.json`);

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};
const bridge = { port: 1, selectedWindowId: null, async discover() { return { port: 1 }; }, async windows() { return { windows: [], selectedWindowId: null, selectionRequired: true }; }, async execute() { throw Object.assign(new Error('离线'), { code: 'EDA_OFFLINE' }); } };
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start() {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

const version = (id) => ({ id, label: id, kind: 'snapshot', date: '2026-10-20', summary: 's', validationStatus: 'pass', requirements: 1, components: 1, designObjects: 1 });
const change = (id) => ({ id, time: '2026-10-20', source: 'user', actor: 'a', action: 'update', objectType: 'requirement', objectId: 'r1', summary: 's' });
const audit = (id) => ({ id, time: '2026-10-20', type: 'version', title: 't', detail: 'd', status: 'info' });

test('C1：追溯状态 PUT/GET 往返 + 重启后读回（真实 HTTP + 原子落盘）', async (context) => {
  const first = await start();
  context.after(() => new Promise((resolve) => first.server.close(resolve)));
  const empty = await first.call('GET', '/api/trace-state');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.savedAt, null);
  assert.deepEqual(empty.body.state, { versions: [], changes: [], audit: [] });

  const saved = await first.call('PUT', '/api/trace-state', { state: { versions: [version('v1')], changes: [change('c1')], audit: [audit('a1')] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.savedAt);
  const readBack = await first.call('GET', '/api/trace-state');
  assert.deepEqual(readBack.body.state.versions.map((item) => item.id), ['v1']);
  assert.equal(readBack.body.total.audit, 1);

  // 新实例 = 重启：仍能读回（权威副本在磁盘，不依赖进程内存）。
  const second = await start();
  context.after(() => new Promise((resolve) => second.server.close(resolve)));
  const afterRestart = await second.call('GET', '/api/trace-state');
  assert.equal(afterRestart.body.savedAt, saved.body.savedAt);
  assert.deepEqual(afterRestart.body.state.changes.map((item) => item.id), ['c1']);
});

test('C1：追溯状态校验 fail-closed —— 非法形状/重复 id 一律 400 TRACE_STATE_INVALID', async (context) => {
  const { server, call } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const badBody = await call('PUT', '/api/trace-state', { state: 'nope' });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.error.code, 'TRACE_STATE_INVALID');
  const dup = await call('PUT', '/api/trace-state', { state: { audit: [audit('x'), audit('x')] } });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error.code, 'TRACE_STATE_INVALID');
  assert.equal(dup.body.error.details.id, 'x');
});
