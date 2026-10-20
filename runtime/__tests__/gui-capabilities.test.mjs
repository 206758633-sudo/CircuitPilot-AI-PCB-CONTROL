import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { GUI_CAPABILITY_CATALOG, catalogTexts, evaluateGuiCapabilities } from '../gui-capabilities.mjs';
import { GUI_ACTIONS } from '../eda-gui.mjs';
import { assertGuiActionAllowed } from '../automation/safety.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-gui-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-gui-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-gui-memo-')), 'memo.json');
const GUI_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-gui-shots-'));
process.env.CIRCUITPILOT_GUI_EVIDENCE_DIR = GUI_EVIDENCE_DIR;
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

test('E9：目录里的兜底动作必须有 clickText 主文案 + waitText 断言；id 唯一', () => {
  const ids = new Set();
  for (const entry of GUI_CAPABILITY_CATALOG) {
    assert.equal(ids.has(entry.id), false, `重复 id ${entry.id}`);
    ids.add(entry.id);
    if (entry.blocked === true) { assert.ok(entry.reason, `${entry.id} blocked 必须写原因`); continue; }
    assert.ok((entry.click || []).length > 0, `${entry.id} 缺 clickText 文案`);
    assert.ok((entry.waitFor || []).length > 0, `${entry.id} 缺 waitText 断言`);
  }
});

test('E9：下单/支付导航被登记为 blocked（G2 红线），且文案覆盖危险词', () => {
  const entry = GUI_CAPABILITY_CATALOG.find((item) => item.id === 'checkout-nav');
  assert.equal(entry.blocked, true);
  assert.match(entry.reason, /G2|orderEnabled/);
  assert.ok(entry.click.includes('支付') && entry.click.includes('下单'));
});

test('E9：探测结果映射为 available/complete/missingTexts（缺断言不算完成）', () => {
  const probe = {
    matches: [
      { text: '铺铜', found: true, matches: [{ text: '铺铜' }] },
      { text: '重建铺铜', found: false, matches: [] },
      { text: '铺铜管理器', found: true, matches: [{ text: '铺铜管理器' }] },
      { text: 'PCB', found: true, matches: [{ text: 'PCB' }] },
    ],
  };
  const evaluated = evaluateGuiCapabilities({ probe });
  const rebuild = evaluated.entries.find((item) => item.id === 'rebuild-pours');
  assert.equal(rebuild.available, true);
  assert.equal(rebuild.complete, false);
  assert.deepEqual(rebuild.missingTexts, ['重建铺铜']);
  const openPcb = evaluated.entries.find((item) => item.id === 'open-pcb-document');
  assert.equal(openPcb.available, true);
  assert.equal(openPcb.complete, true);
  const blocked = evaluated.entries.find((item) => item.id === 'checkout-nav');
  assert.equal(blocked.available, false);
  assert.equal(evaluated.blockedCount, 2);
});

test('E9：findTexts 是只读 GUI 动作（白名单/安全矩阵），eval 仍默认禁用', () => {
  assert.ok(GUI_ACTIONS.includes('findTexts'));
  assert.deepEqual(assertGuiActionAllowed('findTexts'), { action: 'findTexts', class: 'read' });
  assert.throws(() => assertGuiActionAllowed('eval'), (error) => error.code === 'AUTOMATION_EVAL_DISABLED');
});

test('E9 HTTP：/api/eda/gui/capabilities/probe 返回能力清单，两种 viewport 各探测一次', async (context) => {
  const seenViewports = [];
  const fakeGui = {
    async execute(action, params) {
      if (action === 'findTexts') {
        seenViewports.push(params.viewport ?? null);
        const wanted = params.texts || [];
        return {
          viewport: { width: params.viewport?.width ?? 1280, height: params.viewport?.height ?? 800 },
          matches: wanted.map((text) => ({ text, found: ['铺铜', 'PCB', '导出', 'DRC'].includes(text), matches: [] })),
          emulatedViewport: params.viewport ?? null,
        };
      }
      if (action === 'screenshot') return { base64: Buffer.from('fake-png').toString('base64'), bytes: 8 };
      throw new Error(`unexpected gui action ${action}`);
    },
  };
  const { server } = createRuntimeServer({ gui: fakeGui });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const probe = (body) => fetch(`${base}/api/eda/gui/capabilities/probe`, { method: 'POST', headers, body: JSON.stringify(body) });

  const first = await (await probe({ viewport: { width: 1280, height: 800 } })).json();
  assert.equal(first.ok, true);
  assert.equal(first.viewport.width, 1280);
  assert.ok(first.capabilities.length >= 6);
  assert.equal(first.capabilities.some((item) => item.id === 'checkout-nav' && item.blocked), true);

  const second = await (await probe({ viewport: { width: 1920, height: 1080 } })).json();
  assert.equal(second.viewport.width, 1920);
  assert.deepEqual(seenViewports, [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]);

  const withShot = await (await probe({ viewport: { width: 1280, height: 800 }, captureScreenshot: true })).json();
  assert.equal(typeof withShot.screenshot.sha256, 'string');
  assert.match(withShot.screenshot.path, /cp-gui-shots-.*\.png$/);
});
