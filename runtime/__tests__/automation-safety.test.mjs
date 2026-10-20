import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutors } from '../automation/executors.mjs';
import { runRecipe } from '../automation/runner.mjs';
import {
  assertEdaTarget, assertGuiActionAllowed, assertNotCheckoutTarget, assertShortcutAllowed, assertSafeText,
  findCheckoutTarget, findDangerousText,
} from '../automation/safety.mjs';

test('G2：支付/下单确认页的 URL/标题是硬停止条件（与 EDA 目标锁定叠加）', () => {
  for (const target of [
    { url: 'https://easyeda.com/checkout' },
    { url: 'https://easyeda.com/order/confirm', title: '' },
    { title: '收银台' },
    { url: 'https://example.com/settle' },
  ]) {
    assert.ok(findCheckoutTarget(target), `应命中支付页特征：${JSON.stringify(target)}`);
    assert.throws(() => assertNotCheckoutTarget(target), (error) => error.code === 'AUTOMATION_CHECKOUT_BLOCKED');
  }
  assert.equal(findCheckoutTarget({ url: 'https://easyeda.com/editor#id=abc', title: '嘉立创EDA' }), null);
  assert.doesNotThrow(() => assertNotCheckoutTarget({ url: 'https://easyeda.com/editor', title: '原理图' }));
  // 非 EDA 页面仍被目标锁定拒绝（两道门独立生效）。
  assert.throws(() => assertEdaTarget({ url: 'https://example.com/checkout' }), (error) => error.code === 'AUTOMATION_TARGET_NOT_EDA');
});

test('G2：危险文案黑名单覆盖支付/下单/删除/退出等变体，正常菜单文案不误伤', () => {
  for (const text of ['支付', '去支付', '确认支付', '立即下单', '提交订单', '确认订单', '收银台', '结算', '立即购买', 'Place Order', 'checkout', 'pay now', '删除工程', '退出']) {
    assert.ok(findDangerousText(text), `危险文案必须命中：${text}`);
    assert.throws(() => assertSafeText(text), (error) => error.code === 'AUTOMATION_DANGEROUS_TEXT');
  }
  for (const text of ['更新/转换原理图到 PCB', '铺铜管理器', '重建所有', '设计', '工具']) {
    assert.equal(findDangerousText(text), null, `正常文案不能被误伤：${text}`);
  }
});

test('G2：GUI 执行器在危险文案/支付页前停手，绝不把点击事件发给 EDA', async () => {
  const calls = [];
  const gui = { execute: async (action, params) => { calls.push({ action, params }); return { ok: true }; } };
  const executors = createExecutors({ bridge: null, gui, targetLock: true });
  await assert.rejects(() => executors.gui({ action: 'clickText', params: { text: '立即下单' } }), (error) => error.code === 'AUTOMATION_DANGEROUS_TEXT');
  await assert.rejects(() => executors.gui({ action: 'click', params: { x: 1, y: 2, target: { url: 'https://easyeda.com/checkout' } } }), (error) => error.code === 'AUTOMATION_CHECKOUT_BLOCKED');
  assert.deepEqual(calls, [], '被拒绝的动作不能到达 GUI 通道');
  // 只读动作不需要写批准也能正常执行。
  await executors.gui({ action: 'state', params: {} });
  assert.equal(calls.length, 1);
});

test('G2：配方跑起来也无法越过参数卡——危险 clickText / 支付页目标在 runner 预检即失败', async () => {
  const calls = [];
  const gui = { execute: async () => { calls.push('clicked'); return {}; } };
  const recipe = (params) => ({
    id: 'test-checkout-guard', title: '试图支付', version: 1,
    steps: [{
      id: 'click',
      action: { kind: 'gui', action: 'clickText', params },
      expect: { readback: { kind: 'gui', action: 'state' }, assertions: [{ path: 'url', op: 'matches', value: 'easyeda' }] },
    }],
  });
  const dangerous = await runRecipe({ recipe: recipe({ text: '确认支付' }), executors: createExecutors({ gui }), approvals: { write: true } });
  assert.equal(dangerous.ok, false);
  assert.match(dangerous.failedStep?.failures?.join(' ') || '', /危险入口/);

  const checkout = await runRecipe({ recipe: recipe({ text: '设计', target: { url: 'https://easyeda.com/checkout' } }), executors: createExecutors({ gui }), approvals: { write: true } });
  assert.equal(checkout.ok, false);
  assert.match(checkout.failedStep?.failures?.join(' ') || '', /支付\/下单确认页/);
  assert.deepEqual(calls, [], 'runner 必须在预检拦截，不能先点再发现');
});
