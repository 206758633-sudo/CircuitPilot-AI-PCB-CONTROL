import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { ALTERNATIVES_CODES, buildAlternativeQuery, findAlternatives, rankAlternativeRows } from '../engineering/supply-alternatives.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-alt-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-alt-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-alt-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const row = (overrides) => ({
  lcscId: 'C1', price: 0.1, currency: 'USD', stock: 100, minQty: 1, checkedAt: '2026-10-19T12:00:00Z', source: 'jlcpcb-smt-component-api', ...overrides,
});

test('B9：关键词优先真实型号，其次 value + package；太短直接判无效', () => {
  assert.equal(buildAlternativeQuery({ mpn: 'AMS1117-3.3', value: '3.3V', package: 'SOT-223' }), 'AMS1117-3.3');
  assert.equal(buildAlternativeQuery({ value: '5.1k', package: '0603' }), '5.1k 0603');
  assert.equal(buildAlternativeQuery({ model: '  ' }), null);
  assert.equal(buildAlternativeQuery({ value: 'a' }), null);
});

test('B9：候选排序——有货按库存降序、库存未知/为 0 靠后；原料号与重复排除', () => {
  const candidates = rankAlternativeRows({
    rows: [
      row({ lcscId: 'C2', stock: 50, price: 0.2 }),
      row({ lcscId: 'C1', stock: 999999 }),
      row({ lcscId: 'C3', stock: 500, price: 0.3 }),
      row({ lcscId: 'C4', stock: null, price: 0.01 }),
      row({ lcscId: 'C5', stock: 0, price: 0.01 }),
      row({ lcscId: 'C3', stock: 1 }),
    ],
    excludeLcscIds: ['C1'],
  });
  assert.deepEqual(candidates.map((item) => item.lcscId), ['C3', 'C2', 'C4', 'C5']);
  assert.equal(candidates[0].equivalence, 'unverified');
  assert.equal(candidates[0].match, 'keyword');
  assert.equal(candidates.at(-2).stockUnknown, true);
  assert.equal(candidates.at(-1).inStock, false);
});

test('B9：逐条查询，空/失败/无效都带原因，不把失败当成功', async () => {
  const calls = [];
  const outcome = await findAlternatives({
    items: [
      { lcscId: 'C100', mpn: 'GOOD-MODEL' },
      { lcscId: 'C200', mpn: 'EMPTY-MODEL' },
      { lcscId: 'C300', mpn: 'FAIL-MODEL' },
      { lcscId: 'C400', value: '' },
    ],
    search: async ({ query }) => {
      calls.push(query);
      if (query === 'FAIL-MODEL') throw Object.assign(new Error('接口 500'), { code: 'SUPPLY_HTTP_ERROR' });
      if (query === 'EMPTY-MODEL') return { rows: [row({ lcscId: 'C200' })], checkedAt: 'now', source: 'test' };
      return { rows: [row({ lcscId: 'C101', stock: 88 }), row({ lcscId: 'C100', stock: 1 })], checkedAt: 'now', source: 'test' };
    },
  });
  assert.deepEqual(calls.sort(), ['EMPTY-MODEL', 'FAIL-MODEL', 'GOOD-MODEL']);
  const good = outcome.results[0];
  assert.equal(good.status, 'found');
  assert.deepEqual(good.candidates.map((item) => item.lcscId), ['C101']);
  assert.equal(outcome.results[1].status, 'empty');
  assert.equal(outcome.results[1].code, ALTERNATIVES_CODES.EMPTY);
  assert.equal(outcome.results[2].status, 'failed');
  assert.equal(outcome.results[2].code, 'SUPPLY_HTTP_ERROR');
  assert.equal(outcome.results[3].status, 'invalid');
  assert.equal(outcome.results[3].code, ALTERNATIVES_CODES.QUERY_INVALID);
  assert.deepEqual(outcome.summary, { requested: 4, found: 1, empty: 1, invalid: 1, failed: 1, candidates: 1 });
});

test('B9 HTTP：/api/supply/alternatives 返回真实检索形状的候选（注入检索，不打网络）', async (context) => {
  const fakeSearch = async ({ query }) => ({
    checkedAt: '2026-10-19T12:00:00Z',
    source: 'jlcpcb-smt-component-api',
    rows: query.includes('AMS1117')
      ? [row({ lcscId: 'C6186', model: 'AMS1117-3.3', package: 'SOT-223', price: 0.1004, stock: 1072751 }), row({ lcscId: 'C347222', model: 'AMS1117-3.3', package: 'SOT-223', stock: 656577 })]
      : [],
  });
  const { server } = createRuntimeServer({ alternativeSearch: fakeSearch });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/supply/alternatives`, {
    method: 'POST', headers,
    body: JSON.stringify({ items: [{ lcscId: 'C23186', mpn: 'AMS1117-3.3', package: 'SOT-223' }, { lcscId: 'C999999', value: '' }], maxCandidates: 2 }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.requested, 2);
  assert.equal(payload.summary.found, 1);
  assert.equal(payload.summary.invalid, 1);
  const candidates = payload.results[0].candidates;
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => item.lcscId), ['C6186', 'C347222']);
  assert.equal(candidates[0].equivalence, 'unverified');
  assert.equal(candidates[0].match, 'keyword');
  assert.equal(candidates[0].inStock, true);

  const bad = await fetch(`${base}/api/supply/alternatives`, { method: 'POST', headers, body: JSON.stringify({ items: [] }) });
  assert.equal(bad.status, 400);
});
