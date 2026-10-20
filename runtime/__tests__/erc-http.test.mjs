import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * A13 ERC 取证 HTTP 契约（离线假桥）：
 * run → 归一化/套豁免/落盘；latest → 读回同 digest；豁免 GET/PUT 往返；无效豁免拒绝。
 * 同时验证"聚合式 ERC 不得被伪装成逐条明细"这条安全边界。
 */
process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-erc-http-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-erc-http-evidence-'));
process.env.CIRCUITPILOT_ERC_EXEMPTIONS = join(mkdtempSync(join(tmpdir(), 'cp-erc-http-exempt-')), 'erc-exemptions.json');
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-erc-http-memo-')), 'memo.json');

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

function fakeBridge() {
  return {
    port: 49630,
    selectedWindowId: 'W-ERC',
    async discover() { return { port: 49630 }; },
    async windows() { return { windows: [{ id: 'W-ERC' }], selectedWindowId: 'W-ERC', selectionRequired: false }; },
    listCommands() { return ['schematic.drc']; },
    async execute(id) {
      if (id === 'project.current') return { result: { uuid: 'P-ERC' } };
      if (id === 'document.current') return { result: { uuid: 'D-ERC', documentType: 1 } };
      if (id === 'schematic.drc') return { result: [{ type: 'error', count: 1, message: 'Pin U1.A3 is floating' }, { type: 'warn', count: 3, message: 'PWR_FLAG missing on net +5V' }] };
      throw Object.assign(new Error(`不应执行的命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

test('ERC HTTP：取证落盘、最新证据读回、豁免写入后重新取证被应用', async (context) => {
  const { server } = createRuntimeServer({ bridge: fakeBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers, body: JSON.stringify(body ?? {}) });
  const get = (path) => fetch(`${base}${path}`, { headers });

  // 1) 首次取证：聚合条目 → aggregateOnly=true，错误 1 / 警告 3，落盘有 digest。
  const run = await (await post('/api/eda/schematic/erc/run')).json();
  assert.equal(run.ok, true);
  assert.equal(run.erc.ran, true);
  assert.equal(run.erc.aggregateOnly, true);
  assert.equal(run.summary.errorsOpen, 1);
  assert.equal(run.summary.warningsOpen, 3);
  assert.match(run.saved.digest, /^[a-f0-9]{64}$/);
  assert.ok(run.saved.path.endsWith('.json'));

  // 2) latest 必须读回同一份证据（不是空壳）。
  const latest = await (await get('/api/eda/schematic/erc/latest')).json();
  assert.equal(latest.ok, true);
  assert.equal(latest.evidence.digest, run.saved.digest);
  assert.equal(latest.evidence.payload.report.counts.error, 1);

  // 3) 豁免：空理由被拒绝；有效豁免写入成功。
  const invalidSave = await put('/api/eda/schematic/erc/exemptions', { exemptions: [{ code: 'ERC_PIN_FLOATING', reason: '' }] });
  assert.equal(invalidSave.status, 400);
  assert.equal((await invalidSave.json()).error.code, 'ERC_EXEMPTION_INVALID');
  const saved = await (await put('/api/eda/schematic/erc/exemptions', { exemptions: [{ code: 'ERC_PIN_FLOATING', reason: 'Rev.A 样机按器件要求保持悬空。' }] })).json();
  assert.equal(saved.saved.count, 1);
  const exemptions = await (await get('/api/eda/schematic/erc/exemptions')).json();
  assert.equal(exemptions.exemptions.length, 1);
  assert.equal(exemptions.invalid.length, 0);

  // 4) 重新取证：豁免生效 → 错误清 0，但豁免项在 findings 里标 exempted。
  const rerun = await (await post('/api/eda/schematic/erc/run')).json();
  assert.equal(rerun.summary.errorsOpen, 0);
  assert.equal(rerun.summary.exempted, 1);
  assert.ok(rerun.erc.findings.some((finding) => finding.exempted === true));
  assert.notEqual(rerun.saved.digest, run.saved.digest, '豁免变化必须体现在证据摘要里');
});
