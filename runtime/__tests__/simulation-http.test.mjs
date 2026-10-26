import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { sha256Text } from '../simulation.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-sim-state-'));
const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-sim-evidence-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-sim-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const NETLIST = '* test\nV1 in 0 3.3\n.op\n.end\n';

const fakeBridge = (exportText) => ({
  port: 49633,
  selectedWindowId: 'W-SIM',
  async discover() { return { port: 49633 }; },
  async windows() { return { windows: [{ id: 'W-SIM' }], selectedWindowId: 'W-SIM', selectionRequired: false }; },
  async execute(command) {
    if (command === 'project.current') return { result: { uuid: 'P-SIM', data: [{ uuid: 'P-SIM', name: '仿真测试板' }] } };
    if (command === 'document.current') return { result: { uuid: 'D-SIM', documentType: 1 } };
    if (command === 'schematic.simulation.netlist.export') return { result: exportText ? { name: 'sim.cir', size: exportText.length, inline: true, text: exportText } : null };
    if (command === 'schematic.parts.read') return { result: [] };
    return { result: {} };
  },
});

function fakeEvidence(netlistText, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'spice-simulation-evidence',
    source: 'solver-run',
    ran: true,
    generatedAt: new Date().toISOString(),
    solver: { path: '/fake/bin/ngspice', source: 'fake', version: '42' },
    netlist: { bytes: Buffer.byteLength(netlistText, 'utf8'), sha256: sha256Text(netlistText), analyses: ['op'] },
    run: { command: ['/fake/bin/ngspice', '-b'], exitCode: 0, durationMs: 12 },
    output: { bytes: 64, sha256: sha256Text('solver-output') },
    operatingPoint: { '3v3': 3.3 },
    diagnostics: { errors: [], warnings: [] },
    findings: [],
    evidenceHash: sha256Text('evidence'),
    ...overrides,
  };
}

async function start(context, { exportText = NETLIST, simulationRun } = {}) {
  const { server } = createRuntimeServer({ bridge: fakeBridge(exportText), simulationRun: simulationRun || (async ({ netlistText }) => ({ ok: true, ran: true, code: null, message: null, evidence: fakeEvidence(netlistText), findings: [] })) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
    get: (path) => fetch(`${base}${path}`, { headers }),
  };
}

test('A14：EDA 导不出仿真网表时结构化失败（SIMULATION_NETLIST_REQUIRED，不伪造通过）', async (context) => {
  const api = await start(context, { exportText: null });
  const response = await api.post('/api/eda/schematic/simulation/run', {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'SIMULATION_NETLIST_REQUIRED');
  assert.match(body.error.message, /不可执行/);
});

test('A14：真实求解器证据 → 校验通过 → 落盘，latest 可读回', async (context) => {
  const api = await start(context);
  const response = await api.post('/api/eda/schematic/simulation/run', {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.ran, true);
  assert.equal(body.verification.ok, true);
  assert.equal(body.evidence.operatingPoint['3v3'], 3.3);
  assert.ok(body.saved?.path, '必须落盘证据');
  assert.equal(existsSync(body.saved.path), true);

  const latest = await (await api.get('/api/eda/schematic/simulation/latest')).json();
  assert.equal(latest.evidence.digest, body.saved.digest);
});

test('A14：求解器缺失 → 409 结构化失败（不写"通过"）', async (context) => {
  const api = await start(context, {
    simulationRun: async () => ({ ok: false, ran: false, code: 'SIMULATION_SOLVER_MISSING', message: '本机没有可用 SPICE 求解器', evidence: null, findings: [{ code: 'SIMULATION_SOLVER_MISSING', message: '没有求解器', severity: 'blocking' }] }),
  });
  const response = await api.post('/api/eda/schematic/simulation/run', {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'SIMULATION_SOLVER_MISSING');
  assert.match(body.error.message, /仿真未跑成/);
});

test('A14：证据网表哈希对不上 → 409 SIMULATION_EVIDENCE_INVALID（换原理图后旧证据失效）', async (context) => {
  const api = await start(context, {
    simulationRun: async ({ netlistText }) => ({ ok: true, ran: true, code: null, message: null, evidence: fakeEvidence(netlistText, { kind: 'changed', netlist: { bytes: 1, sha256: sha256Text('other-netlist'), analyses: [] } }), findings: [] }),
  });
  const response = await api.post('/api/eda/schematic/simulation/run', {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'SIMULATION_EVIDENCE_INVALID');
  assert.equal(body.error.details.verification.ok, false);
});
