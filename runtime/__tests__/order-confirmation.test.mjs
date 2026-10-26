import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { validateOrderConfirmation } from '../order-confirmation.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-oc-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-oc-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-oc-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const readyCard = () => ({
  kind: 'fabrication-order-card',
  generatedAt: '2026-10-19T11:00:00Z',
  readyToOrder: true,
  counts: { blocking: 0, unknown: 0, warning: 1 },
  parameters: { layers: 6, quantity: 10, surfaceFinish: 'HASL' },
  price: { status: 'unknown', reason: '没有报价来源' },
  humanSignoffRequired: true,
  files: [{ kind: 'gerber', name: 'GERBER_x.zip', draft: false }],
});

test('E3/R10：ready 卡 + 确认人 + 支付人工声明 ⇒ 规范化并带"系统不代下单/不代付"事实', () => {
  const normalized = validateOrderConfirmation({ card: readyCard(), operator: '张三', note: '已核对层数与尺寸', paymentManual: true });
  assert.equal(normalized.operator, '张三');
  assert.deepEqual(normalized.acknowledged, { orderExecutedBySystem: false, paymentExecutedBySystem: false, humanExecutor: '张三' });
  assert.equal(normalized.paymentManual, true);
  assert.equal(normalized.card.readyToOrder, true);
});

test('E3/R10：不可下单的卡拒绝确认（ORDER_CONFIRMATION_BLOCKED）', () => {
  const card = { ...readyCard(), readyToOrder: false, counts: { blocking: 2, unknown: 1, warning: 0 } };
  assert.throws(() => validateOrderConfirmation({ card, operator: '张三', paymentManual: true }), (error) => error.code === 'ORDER_CONFIRMATION_BLOCKED' && /不可下单/.test(error.message));
});

test('E3/R10：缺确认人 / 未声明支付人工 ⇒ 输入错误 400', () => {
  assert.throws(() => validateOrderConfirmation({ card: readyCard(), operator: '  ', paymentManual: true }), (error) => error.code === 'ORDER_CONFIRMATION_INPUT_INVALID');
  assert.throws(() => validateOrderConfirmation({ card: readyCard(), operator: '张三', paymentManual: false }), (error) => error.code === 'ORDER_CONFIRMATION_INPUT_INVALID');
});

test('E3/R10 HTTP：确认落盘为 order-confirmation 证据，latest 可读回且不含下单/支付能力', async (context) => {
  const fakeBridge = { port: 1, selectedWindowId: 'W', async discover() { return { port: 1 }; }, async windows() { return { windows: [], selectedWindowId: 'W', selectionRequired: false }; }, async execute() { return { result: {} }; } };
  const { server } = createRuntimeServer({ bridge: fakeBridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

  const saved = await (await post('/api/production/order-confirmation', { card: readyCard(), operator: '李四', note: '已核对', paymentManual: true })).json();
  assert.equal(saved.ok, true);
  assert.match(saved.confirmation.digest, /^[0-9a-f]{64}$/);
  assert.equal(saved.confirmation.payload.acknowledged.paymentExecutedBySystem, false);
  assert.equal(saved.confirmation.payload.card.readyToOrder, true);

  const latest = await (await fetch(`${base}/api/production/order-confirmation/latest`, { headers })).json();
  assert.equal(latest.evidence.digest, saved.confirmation.digest);
  assert.equal('orderAction' in latest.evidence.payload, false);
  assert.equal('paymentToken' in latest.evidence.payload, false);

  const blocked = await post('/api/production/order-confirmation', { card: { ...readyCard(), readyToOrder: false }, operator: '李四', paymentManual: true });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'ORDER_CONFIRMATION_BLOCKED');

  const invalid = await post('/api/production/order-confirmation', { card: readyCard(), operator: '', paymentManual: true });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'ORDER_CONFIRMATION_INPUT_INVALID');
});
