import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { auditPinEvidence, assertPinEvidenceForNetlist, buildPinEvidence } from '../pin-evidence.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-pin-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-pin-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-pin-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const PADS = [
  { designator: 'U1', pad: '1', net: '3V3', layer: 1, throughHole: false },
  { designator: 'U1', pad: '2', net: 'GND', layer: 1, throughHole: false },
  { designator: 'R1', pad: '1', net: 'BOOT', layer: 1, throughHole: false },
];

const fakeBridge = (pads = PADS) => ({
  port: 49634,
  selectedWindowId: 'W-PIN',
  async discover() { return { port: 49634 }; },
  async windows() { return { windows: [{ id: 'W-PIN' }], selectedWindowId: 'W-PIN', selectionRequired: false }; },
  async execute(command) {
    if (command === 'project.current') return { result: { uuid: 'P-PIN', data: [{ uuid: 'P-PIN', name: '引脚测试板' }] } };
    if (command === 'document.current') return { result: { uuid: 'D-PIN', documentType: 3 } };
    if (command === 'pcb.copper.read') return { result: { lines: [], vias: [], pads } };
    return { result: {} };
  },
});

async function start(context, pads, chat = null) {
  const { server } = createRuntimeServer({ bridge: fakeBridge(pads), chat });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    post: (body) => fetch(`${base}/api/eda/pins/evidence`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
    postJson: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
  };
}

test('A4：焊盘证据表按位号/脚号聚合，网络计数正确', () => {
  const evidence = buildPinEvidence({ pads: PADS });
  assert.equal(evidence.rows.length, 3);
  assert.equal(evidence.components.length, 2);
  assert.deepEqual(evidence.components.find((item) => item.designator === 'U1'), { designator: 'U1', pins: 2, withNet: 2, assumed: 0 });
  const audit = auditPinEvidence(evidence);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.counts, { components: 2, pins: 3, withNet: 3, assumed: 0, unknown: 0 });
});

test('A4：没有网络的焊盘默认阻断；显式 assumption 带理由后放行并计入 assumed', () => {
  const pads = [...PADS, { designator: 'U1', pad: '3', net: '', layer: 1 }];
  const blocked = auditPinEvidence(buildPinEvidence({ pads }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.some((item) => item.code === 'PIN_NET_UNKNOWN'), true);
  assert.equal(blocked.counts.unknown, 1);

  const assumed = auditPinEvidence(buildPinEvidence({ pads, assumptions: [{ designator: 'U1', pad: '3', reason: 'NC 未用脚' }] }));
  assert.equal(assumed.ok, true);
  assert.equal(assumed.counts.assumed, 1);
});

test('A4：空证据不通过（不能把"没读到"当成"没问题"）', () => {
  const audit = auditPinEvidence(buildPinEvidence({ pads: [] }));
  assert.equal(audit.ok, false);
  assert.equal(audit.blockers[0].code, 'PIN_EVIDENCE_EMPTY');
});

test('A4：原理图/PCB 位号覆盖差异如实报出（只原理图 / 只 PCB）', () => {
  const evidence = buildPinEvidence({ pads: PADS, schematicParts: [{ designator: 'U1' }, { designator: 'C9' }] });
  assert.deepEqual(evidence.schematic.onlySchematic, ['C9']);
  assert.deepEqual(evidence.schematic.onlyPcb, ['R1']);
  const audit = auditPinEvidence(evidence);
  assert.equal(audit.warnings.filter((item) => item.code === 'PIN_SCHEMATIC_MISMATCH').length, 2);
});

test('A4：assertPinEvidenceForNetlist 在证据不足时抛 PIN_EVIDENCE_BLOCKED（网表生成前置门禁）', () => {
  const evidence = buildPinEvidence({ pads: [{ designator: 'U1', pad: '1', net: '' }] });
  assert.throws(() => assertPinEvidenceForNetlist(evidence), (error) => error.code === 'PIN_EVIDENCE_BLOCKED' && /拒绝生成网表/.test(error.message));
  assert.equal(assertPinEvidenceForNetlist(buildPinEvidence({ pads: PADS })).ok, true);
});

test('A4 HTTP：/api/eda/pins/evidence 返回证据表与审计，未知网络显式阻断', async (context) => {
  const api = await start(context);
  const response = await api.post({});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.audit.ok, true);
  assert.equal(body.evidence.rows.length, 3);

  const blockedApi = await start(context, [...PADS, { designator: 'R2', pad: '1', net: '' }]);
  const blocked = await (await blockedApi.post({})).json();
  assert.equal(blocked.ok, true);
  assert.equal(blocked.audit.ok, false);
  assert.equal(blocked.audit.blockers.some((item) => item.code === 'PIN_NET_UNKNOWN'), true);
});

const fakeChat = { netlist: async (body) => ({ status: 'ready', explanation: 'ok', blockers: [], netlist: { title: 't', components: [], nets: [], assumptions: [] }, compilation: null, receivedEvidence: Boolean(body.pinEvidence) }) };

test('A4 门禁：/api/design/netlist/ai 带通过审计的引脚证据才生成，并回填证据摘要', async (context) => {
  const api = await start(context, PADS, fakeChat);
  const evidence = buildPinEvidence({ pads: PADS });
  const response = await api.postJson('/api/design/netlist/ai', { pinEvidence: evidence });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.netlist.status, 'ready');
  assert.equal(typeof body.netlist.pinEvidence.digest, 'string');
  assert.equal(body.netlist.pinEvidence.counts.pins, 3);
});

test('A4 门禁：引脚证据审计不通过 ⇒ 409 PIN_EVIDENCE_BLOCKED（不生成网表）', async (context) => {
  const api = await start(context, PADS, fakeChat);
  const badEvidence = buildPinEvidence({ pads: [...PADS, { designator: 'R2', pad: '1', net: '' }] });
  const response = await api.postJson('/api/design/netlist/ai', { pinEvidence: badEvidence });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'PIN_EVIDENCE_BLOCKED');
});

test('A4 门禁：要求证据却没给 ⇒ 409 PIN_EVIDENCE_REQUIRED', async (context) => {
  const api = await start(context, PADS, fakeChat);
  const response = await api.postJson('/api/design/netlist/ai', { requirePinEvidence: true });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'PIN_EVIDENCE_REQUIRED');
});
