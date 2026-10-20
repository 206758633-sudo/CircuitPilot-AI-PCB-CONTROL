import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-rpf-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-rpf-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-rpf-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

// 30 个断网，每个网络两块相隔很远的焊盘（2 个孤岛）。目标是 NET30——它不在前 24 条里。
// 旧实现先用默认 maxConnections=24 截断再按 nets 过滤 ⇒ 永远查不到 NET30（假功能）。
function geometry() {
  const pads = [];
  for (let index = 1; index <= 30; index += 1) {
    const net = `NET${String(index).padStart(2, '0')}`;
    pads.push({ designator: `R${index}A`, pad: '1', net, layer: 1, x: index * 100, y: 100, radius: 5 });
    pads.push({ designator: `R${index}B`, pad: '2', net, layer: 1, x: index * 100 + 30, y: 100, radius: 5 });
  }
  return { lines: [], vias: [], pads };
}

const fakeBridge = {
  port: 49631,
  selectedWindowId: 'W-RPF',
  async discover() { return { port: 49631 }; },
  async windows() { return { windows: [{ id: 'W-RPF' }], selectedWindowId: 'W-RPF', selectionRequired: false }; },
  async execute(command) {
    if (command === 'project.current') return { result: { uuid: 'P-RPF', data: [{ uuid: 'P-RPF', name: '布线过滤测试板' }] } };
    if (command === 'document.current') return { result: { uuid: 'D-RPF', documentType: 3 } };
    if (command === 'pcb.copper.read') return { result: geometry() };
    return { result: {} };
  },
};

test('A10：routing/plan 的 nets 过滤在全部断网中查找（不再被默认 24 条截断）', async (context) => {
  const { server } = createRuntimeServer({ bridge: fakeBridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/eda/pcb/routing/plan`, { method: 'POST', headers, body: JSON.stringify({ nets: ['NET30'], maxConnections: 4 }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requested, 1, 'nets 过滤必须真的找到目标网络，而不是返回 0 条');
  assert.equal(body.routes.length, 1);
  assert.equal(body.routes[0].net, 'NET30');
  // 目标网络在两焊盘之间（30 mil），默认间距 6 mil 下应可规划；若规划器拒绝，也必须给出 reason 而不是空结果。
  assert.equal(typeof body.routes[0].ok, 'boolean');
  assert.equal(body.brokenNets.length >= 30, true);
});
