import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-a2-state-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-a2-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-a2-memo-${process.pid}.json`);

const keychain = { async configured() { return false; }, async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; }, async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); }, async remove() { return { configured: false }; } };
const bridge = {
  port: 1, selectedWindowId: 'w1',
  async discover() { return { port: 1 }; },
  async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; },
  async execute(commandId, args) {
    if (commandId !== 'library.device.search') throw Object.assign(new Error(`不应调用 ${commandId}`), { code: 'EDA_OFFLINE' });
    // 真机同款现象：带封装后缀的完整型号 0 命中；去掉括号后命中。
    if (String(args.query).includes('BQ24074')) {
      // 真机同款现象：带封装说明的完整查询 0 命中；去掉括号说明后命中。
      if (args.query === 'BQ24074') return { result: [{ name: 'BQ24074RGTR', lcscId: 'C347222', uuid: 'u-1', libraryUuid: 'lib-1' }] };
      return { result: [] };
    }
    return { result: [] };
  },
};
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start() {
  const { server } = createRuntimeServer({ keychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { server, post };
}

test('A2：0 命中时按确定性回退链重试，并如实标注命中来源与每次尝试', async (context) => {
  const { server, post } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await post('/api/eda/library/search/fallback', { queries: ['BQ24074 (SOT-23)', '不存在的型号XYZ123'] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.queries, 2);
  assert.equal(result.body.hit, 1);
  assert.equal(result.body.fallbackHits, 1);
  assert.equal(result.body.empty, 1);

  const [hit, empty] = result.body.results;
  assert.equal(hit.query, 'BQ24074 (SOT-23)');
  assert.equal(hit.found, 1);
  assert.equal(hit.fallback, true);
  assert.ok(hit.usedQuery && hit.usedQuery !== hit.query, '命中来源必须是变形后的查询');
  assert.ok(hit.attempts.length >= 2, '每次尝试都要保留');
  assert.equal(hit.attempts[0].found, 0);
  assert.equal(hit.candidates[0].lcscId, 'C347222');

  assert.equal(empty.found, 0);
  assert.equal(empty.fallback, false);
  assert.equal(empty.error, 'NO_RESULT', '全空必须明确 NO_RESULT，不猜身份');
  assert.equal(empty.usedQuery, null);
});

test('A2：缺少查询参数返回 400，不发起检索', async (context) => {
  const { server, post } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await post('/api/eda/library/search/fallback', {});
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'SELECTION_QUERY_REQUIRED');
});
