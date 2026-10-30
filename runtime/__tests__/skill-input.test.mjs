import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import {
  adaptBoard,
  adaptPlacements,
  adaptPours,
  adaptRegions,
  adaptTexts,
  adaptTracks,
  buildSkillInput,
} from '../engineering/skill-input.mjs';
import { evaluateSkillRules } from '../engineering/skill-rules.mjs';

process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-skill-input-'));

const placementRead = {
  result: {
    unit: 'mm',
    componentCount: 2,
    components: [
      { designator: 'U1', xMm: 10, yMm: 10, rotationDeg: 90, layer: 1, layerSide: 'top', bboxMm: { xMm: 4, yMm: 2, centerXMm: 10, centerYMm: 10 }, nets: ['GND'] },
      { designator: 'J1', xMm: 20, yMm: 5, rotationDeg: 0, layer: 2, layerSide: 'bottom', bboxMm: { xMm: 6, yMm: 3, centerXMm: 20, centerYMm: 5 }, nets: [] },
    ],
  },
};

const outlineRead = {
  result: {
    count: 1,
    items: [{ primitiveId: 'o1', lineWidthMil: 10, polygon: { polygon: [0, 0, 'L', 1000, 0, 1000, 2000, 0, 2000] } }],
  },
};

test('适配器：placement bbox 中心→min/max，旋转件也按轴对齐 bbox 处理', () => {
  const placements = adaptPlacements(placementRead);
  assert.equal(placements.length, 2);
  assert.deepEqual(placements.map((item) => item.ref), ['J1', 'U1'], '适配器按位号排序，保证两次读回哈希稳定');
  const u1 = placements.find((item) => item.ref === 'U1');
  const j1 = placements.find((item) => item.ref === 'J1');
  assert.equal(u1.rotationDeg, 90);
  assert.deepEqual(u1.boundsMm, { minXMm: 8, minYMm: 9, maxXMm: 12, maxYMm: 11 });
  assert.equal(u1.layerSide, 'top');
  assert.deepEqual(j1.boundsMm, { minXMm: 17, minYMm: 3.5, maxXMm: 23, maxYMm: 6.5 });
});

test('适配器：outline polygon（mil）→ board mm；copper 线宽 mil→mm 且去重', () => {
  const board = adaptBoard(outlineRead);
  assert.equal(board.widthMm, 25.4);
  assert.equal(board.heightMm, 50.8);
  assert.equal(board.boundsMm.maxXMm, 25.4);
  const tracks = adaptTracks({ result: { lines: [
    { net: 'GND', width: 10, layer: 1 },
    { net: 'GND', width: 10, layer: 1 },
    { net: '+5V', width: 20, layer: 2 },
    { net: '', width: 10, layer: 1 },
  ] } });
  assert.deepEqual(tracks, [{ net: '+5V', widthMm: 0.508, layer: 2 }, { net: 'GND', widthMm: 0.254, layer: 1 }]);
});

test('适配器：regions/pours/texts 归一，位号文字能找回器件所在面', () => {
  const regions = adaptRegions({ result: { count: 1, regions: [{ primitiveId: 'r1', layer: 12, rules: [2, 7], regionName: 'KO', lineWidthMil: 10, boundsMm: { minXMm: 0, minYMm: 0, maxXMm: 10, maxYMm: 10 } }] } });
  assert.equal(regions[0].id, 'r1');
  assert.deepEqual(regions[0].rules, [2, 7]);
  const pours = adaptPours({ result: [{ primitiveId: 'p1', net: 'GND', layer: 1, boundsMm: { minXMm: 0, minYMm: 0, maxXMm: 5, maxYMm: 5 } }] });
  assert.equal(pours[0].net, 'GND');
  assert.equal(pours[0].boundsMm.maxXMm, 5);
  const texts = adaptTexts({ result: { count: 2, texts: [
    { primitiveId: 't1', layer: 4, text: 'J1', mirror: true, reverse: false, rotationDeg: 0 },
    { primitiveId: 't2', layer: 3, text: 'LOGO', mirror: false, reverse: true, rotationDeg: 0 },
  ] } }, adaptPlacements(placementRead));
  assert.equal(texts[0].kind, 'designator');
  assert.equal(texts[0].componentLayer, 'bottom');
  assert.equal(texts[1].kind, 'text');
  assert.equal(texts[1].reverse, true);
});

test('buildSkillInput：EDA 几何 + 设计意图合并，可被 evaluateSkillRules 直接消费', () => {
  const input = buildSkillInput({
    placement: placementRead,
    regions: { result: { count: 0, regions: [] } },
    texts: { result: { count: 0, texts: [] } },
    pours: { result: [] },
    outline: outlineRead,
    design: {
      zones: [{ module: 'A', zone: 'center-bottom', parts: ['U1'] }, { module: 'B', zone: 'right-bottom', parts: ['J1'] }],
      assembly: { profile: 'hand-solder', handSolderParts: ['J1'] },
    },
  });
  assert.equal(input.placements.length, 2);
  assert.equal(input.board.widthMm, 25.4);
  const audit = evaluateSkillRules(input);
  assert.equal(audit.rules.find((rule) => rule.id === 'SKL-01').status, 'PASS');
  assert.equal(audit.rules.find((rule) => rule.id === 'SKL-02').status, 'PASS');
});

function fakeBridge(documentType = 3) {
  const planner = {
    port: 49620,
    selectedWindowId: 'w1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ windowId: 'w1', connected: true, active: true }], activeWindowId: 'w1', count: 1 }; },
    async execute(commandId) {
      if (commandId === 'document.current') return { result: { documentType, uuid: 'pcb-uuid', tabId: 'tab-uuid' } };
      if (commandId === 'pcb.placement.read') return placementRead;
      if (commandId === 'pcb.regions.detail') return { result: { count: 0, regions: [] } };
      if (commandId === 'pcb.texts.detail') return { result: { count: 0, texts: [] } };
      if (commandId === 'pcb.pours.detail') return { result: [] };
      if (commandId === 'pcb.outline.read') return outlineRead;
      if (commandId === 'pcb.copper.read') return { result: { lines: [{ net: 'GND', width: 10, layer: 1 }] } };
      throw Object.assign(new Error(`unexpected command ${commandId}`), { code: 'TEST_UNEXPECTED_COMMAND' });
    },
  };
  return planner;
}

test('HTTP 桥接审计：从假桥采集并评估；非 PCB 文档 409', async (context) => {
  const keychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
  const { server } = createRuntimeServer({ keychain, bridge: fakeBridge(3) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof, 'content-type': 'application/json' };
  const design = {
    zones: [{ module: 'A', zone: 'center-bottom', parts: ['U1'] }, { module: 'B', zone: 'right-bottom', parts: ['J1'] }],
    selfCheck: { saved: true, rounds: [{ artifactSha256: 'a'.repeat(64), readbackSha256: 'a'.repeat(64), findings: [] }, { artifactSha256: 'b'.repeat(64), readbackSha256: 'b'.repeat(64), findings: [], reload: { attempted: true, ok: true } }] },
  };
  const response = await fetch(`${base}/api/engineering/constraint-rules/bridge-audit`, { method: 'POST', headers, body: JSON.stringify({ design }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.collected.components, 2);
  assert.equal(body.collected.board.widthMm, 25.4);
  assert.equal(body.bridge.document.documentType, 3);
  assert.equal(body.audit.rules.find((rule) => rule.id === 'SKL-01').status, 'PASS');
  assert.equal(body.audit.rules.find((rule) => rule.id === 'SKL-07').status, 'PASS');
  assert.equal(body.audit.summary.REVIEW, 3, 'assembly/差分/net-class 缺数据应 REVIEW');

  const { server: server2 } = createRuntimeServer({ keychain, bridge: fakeBridge(15) });
  await new Promise((resolve, reject) => { server2.once('error', reject); server2.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server2.close(resolve)));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const health2 = await (await fetch(`${base2}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const notPcb = await fetch(`${base2}/api/engineering/constraint-rules/bridge-audit`, { method: 'POST', headers: { 'x-circuitpilot-token': health2.sessionProof, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(notPcb.status, 409);
  const notPcbBody = await notPcb.json();
  assert.equal(notPcbBody.error.code, 'NOT_A_PCB_DOCUMENT');
});
