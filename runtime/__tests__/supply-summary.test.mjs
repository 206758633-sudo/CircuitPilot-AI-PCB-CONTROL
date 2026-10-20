import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { deriveBoardFacts } from '../fabrication-order.mjs';
import { summarizeSupplyEvidence } from '../supply-summary.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-supply-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-supply-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-supply-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const NOW = Date.parse('2026-10-19T12:00:00Z');

const pricing = (overrides = {}) => ({
  kind: 'supply-pricing-evidence',
  checkedAt: '2026-10-19T11:00:00Z',
  entries: [
    { lcsc: 'C1', status: 'priced', price: 1.5, currency: 'CNY', stock: 100, checkedAt: '2026-10-19T11:00:00Z' },
    { lcsc: 'C2', status: 'priced', price: 2.25, currency: 'CNY', stock: 0, checkedAt: '2026-10-19T11:00:00Z' },
  ],
  unknownEntries: [],
  ...overrides,
});

test('B3：已定价料号可给出"已知单价合计"并单独列出缺货项', () => {
  const summary = summarizeSupplyEvidence(pricing(), { now: NOW, staleAfterHours: 24 });
  assert.equal(summary.known, true);
  assert.equal(summary.totalKnownAmount, 3.75);
  assert.equal(summary.currency, 'CNY');
  assert.equal(summary.pricedCount, 2);
  assert.deepEqual(summary.outOfStock, [{ lcsc: 'C2', stock: 0, price: 2.25 }]);
  assert.equal(summary.stale, false);
  assert.equal(summary.findings.some((item) => item.code === 'SUPPLY_STOCK_OUT'), true);
});

test('B3：缺价料号让合计不完整（仍显示已知合计，但明确标 warning）', () => {
  const summary = summarizeSupplyEvidence(pricing({ unknownEntries: [{ lcsc: 'C9', status: 'unknown', reason: 'HTTP_ERROR' }] }), { now: NOW });
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.findings.some((item) => item.code === 'SUPPLY_PRICE_UNKNOWN_AT_ORDER'), true);
});

test('B3：超过 TTL 的价格证据标 stale（下单前必须重查）', () => {
  const summary = summarizeSupplyEvidence(pricing({ checkedAt: '2026-10-17T00:00:00Z' }), { now: NOW, staleAfterHours: 24 });
  assert.equal(summary.stale, true);
  assert.equal(summary.findings.some((item) => item.code === 'SUPPLY_EVIDENCE_STALE'), true);
});

test('B3：货币混用不做合计（不把 USD 与 CNY 加在一起）', () => {
  const summary = summarizeSupplyEvidence(pricing({
    entries: [
      { lcsc: 'C1', status: 'priced', price: 1, currency: 'CNY', stock: 10, checkedAt: '2026-10-19T11:00:00Z' },
      { lcsc: 'C2', status: 'priced', price: 2, currency: 'USD', stock: 10, checkedAt: '2026-10-19T11:00:00Z' },
    ],
  }), { now: NOW });
  assert.equal(summary.known, false);
  assert.equal(summary.totalKnownAmount, null);
  assert.equal(summary.currency, null);
  assert.equal(summary.findings.some((item) => item.code === 'SUPPLY_PRICE_MIXED_CURRENCY'), true);
});

test('B3：没有供应链证据 ⇒ known:false + 明确原因（不把空当 0 元）', () => {
  const summary = summarizeSupplyEvidence(null, { now: NOW });
  assert.equal(summary.known, false);
  assert.equal(summary.totalKnownAmount, null);
  assert.equal(summary.findings[0].code, 'SUPPLY_EVIDENCE_MISSING');
});

test('B3 HTTP：/api/production/order-card 接收 pricingEvidence 并回填 supplySummary', async (context) => {
  const fakeBridge = { port: 1, selectedWindowId: 'W', async discover() { return { port: 1 }; }, async windows() { return { windows: [], selectedWindowId: 'W', selectionRequired: false }; }, async execute() { return { result: {} }; } };
  const { server } = createRuntimeServer({ bridge: fakeBridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const facts = deriveBoardFacts({ outlinePoints: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }], copperLayerCount: 2, designators: ['U1', 'R1'], netCount: 3, drcReport: null });
  const response = await fetch(`${base}/api/production/order-card`, { method: 'POST', headers, body: JSON.stringify({ facts, requested: { quantity: 10 }, pricingEvidence: pricing() }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.supplySummary.known, true);
  assert.equal(body.supplySummary.totalKnownAmount, 3.75);
  assert.equal(body.supplySummary.outOfStock.length, 1);

  const missing = await (await fetch(`${base}/api/production/order-card`, { method: 'POST', headers, body: JSON.stringify({ facts, requested: { quantity: 10 } }) })).json();
  assert.equal(missing.supplySummary, undefined);
});
