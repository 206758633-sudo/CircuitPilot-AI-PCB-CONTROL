import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RELEASE_CODES } from '../release-gate.mjs';
import { createRuntimeServer } from '../server.mjs';

/**
 * 第 61 轮放行门证据接线（HTTP 端到端、全离线）：
 *
 *  1. 仿真证据可选输入（body.acceptanceExtraOptions.simulationEvidence）：
 *     服务端 fail-closed 校验 可读/kind/新鲜度/数值/绑定，通过后才映射进 release-gate
 *     的 simulation 子门；且"已消费"仍因为只有关键子电路（整板 SPICE 模型缺失）而 unknown，
 *     绝不产生假 PASS。
 *  2. DRC 证据绑定：报告 pcbUuid 与当前目标不一致 → blocked；缺 pcbUuid → unknown。
 *
 * 用真实 Runtime HTTP 服务 + 假桥（不碰真机 EDA）；只提供离线证据，不触发实机读设计。
 */

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };

/** 假桥：只支撑 currentEdaFingerprint（窗口/工程/文档），不执行任何设计读写命令。 */
function fakeBridge({ projectUuid = 'P-CURRENT', documentUuid = 'PAGE-1' } = {}) {
  return {
    port: 49620,
    selectedWindowId: 'W-EVIDENCE',
    async discover() { this.port = 49620; return { port: 49620 }; },
    async windows() { return { windows: [{ windowId: 'W-EVIDENCE', connected: true }], selectedWindowId: 'W-EVIDENCE', selectionRequired: false }; },
    async execute(id) {
      if (id === 'project.current') return { ok: true, result: { uuid: projectUuid } };
      if (id === 'document.current') return { ok: true, result: { uuid: documentUuid, documentType: 1 } };
      throw Object.assign(new Error(`离线证据测试不应执行桥命令：${id}`), { code: 'EDA_OFFLINE' });
    },
    listCommands() { return []; },
  };
}

async function withRuntimeServer(bridge, run) {
  const saved = {
    state: process.env.CIRCUITPILOT_STATE_DIR,
    evidence: process.env.CIRCUITPILOT_EVIDENCE_DIR,
    releases: process.env.CIRCUITPILOT_RELEASES_DIR,
  };
  const root = mkdtempSync(join(tmpdir(), 'cp-gate-evidence-'));
  const deliverables = join(root, 'deliverables');
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_RELEASES_DIR = join(root, 'releases');
  const { server, sessionToken } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const callGate = async (body) => {
    const response = await fetch(`${base}/api/eda/release/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-circuitpilot-token': sessionToken },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    return { status: response.status, payload };
  };
  try {
    await run({ callGate, root, deliverables });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (saved.state === undefined) delete process.env.CIRCUITPILOT_STATE_DIR;
    else process.env.CIRCUITPILOT_STATE_DIR = saved.state;
    if (saved.evidence === undefined) delete process.env.CIRCUITPILOT_EVIDENCE_DIR;
    else process.env.CIRCUITPILOT_EVIDENCE_DIR = saved.evidence;
    if (saved.releases === undefined) delete process.env.CIRCUITPILOT_RELEASES_DIR;
    else process.env.CIRCUITPILOT_RELEASES_DIR = saved.releases;
    rmSync(root, { recursive: true, force: true });
  }
}

const NETLIST_SHA = 'a'.repeat(64);
const TARGET_PCB = '0123456789abcdef0123456789abcdef';
const OTHER_PCB = 'fedcba984548e1a0';

/** 模拟 T3 artifacts/spice/simulation-evidence-*.json 的真实形状（数值全部来自真实 ngspice 结构）。 */
function t3Evidence({ projectUuid = 'P-CURRENT', pageUuid = 'PAGE-1', status = 'ok', runs, results } = {}) {
  return {
    schemaVersion: 1,
    kind: 'spice-simulation-evidence',
    task: 'T3',
    generatedAt: new Date().toISOString(),
    status,
    environment: {
      ngspicePath: '/opt/homebrew/bin/ngspice',
      targetPageUuid: pageUuid,
      expectedProjectUuid: projectUuid,
      project: { projectUuid, pageUuid, boardName: 'Board1_1' },
    },
    netlist: { sha256: NETLIST_SHA, format: 'easyeda-netlist-json@2.0.0', parseable: true, componentCount: 64, netCount: 34 },
    edaSimulationNetlist: { available: false, reason: 'EDA_SPICE_NETLIST_EXPORT_NULL' },
    deck: { subcircuit: 'USB-C VBUS → IP2312(U2) → VBAT', decks: [{ kind: 'op' }, { kind: 'tran' }], usedComponents: [{ ref: 'U2' }, { ref: 'CN5' }], usedNets: [{ name: 'VBUS' }] },
    runs: runs ?? [{ kind: 'op', exitCode: 0 }, { kind: 'tran', exitCode: 0 }],
    results: results ?? { operatingPoint: { vbus: 5, vbat_pack: 3.74 }, measurements: { vbat_end: 4.13835, ichg_10: -0.5 } },
  };
}

/** 最小离线门禁体：不触发实机读设计，只保留放行门/证据接线关心的输入。 */
function offlineGateBody(extra = {}) {
  return {
    pageUuid: 'PAGE-1',
    pcbUuid: TARGET_PCB,
    userConfirmed: true,
    acceptance: { ready: true, netlist: { components: 64, nets: 34, namedPins: 95 }, findings: [] },
    design: { designators: ['U1', 'U2'], placement: [], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: NETLIST_SHA },
    placementVerification: { ok: true, checkedCount: 1, findings: [] },
    exemptions: [],
    artifacts: [],
    ...extra,
  };
}

const gateById = (payload, id) => (payload.gates || []).find((gate) => gate.id === id);
const codesOf = (gate) => (gate?.findings || []).map((item) => item.code);

test('仿真证据正常消费：校验通过 → 映射进 simulation 子门；但只有子电路仍 unknown，不是假 PASS', async () => {
  await withRuntimeServer(fakeBridge(), async ({ callGate, root }) => {
    const evidencePath = join(root, 'simulation-evidence-test.json');
    writeFileSync(evidencePath, JSON.stringify(t3Evidence()));
    const { status, payload } = await callGate(offlineGateBody({ acceptanceExtraOptions: { simulationEvidence: evidencePath } }));
    assert.equal(status, 200, JSON.stringify(payload).slice(0, 500));

    const simulation = gateById(payload, 'simulation');
    assert.ok(simulation, 'simulation 子门必须存在');
    assert.equal(simulation.status, 'unknown', '已消费的关键子电路仿真不能变成 pass');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_COVERAGE_PARTIAL), JSON.stringify(codesOf(simulation)));
    assert.ok(!codesOf(simulation).includes(RELEASE_CODES.SIMULATION_NOT_RUN), '已消费时不应再报"没跑仿真"');
    assert.equal(simulation.evidence.evidencePath, evidencePath);
    assert.equal(simulation.evidence.partial, true);
    assert.equal(simulation.evidence.binding.netlistSha256MatchedLive, true, '证据网表必须与实时导出网表 sha256 绑定');
    assert.equal(simulation.evidence.binding.projectUuid, 'P-CURRENT');

    // 报告级自证：消费了哪份证据、覆盖范围、绑定结果。
    assert.equal(payload.evidenceBinding.simulation.consumed, true);
    assert.equal(payload.evidenceBinding.simulation.evidencePath, evidencePath);
    assert.equal(payload.evidenceBinding.targetPcbUuid, TARGET_PCB);
    // 整板仍然没放行。
    assert.equal(payload.ready, false);
  });
});

test('仿真证据绑定不符：别的工程的证据 → unknown 且带明确原因，不消费、不产生假 PASS', async () => {
  await withRuntimeServer(fakeBridge(), async ({ callGate, root }) => {
    const evidencePath = join(root, 'simulation-evidence-other-project.json');
    writeFileSync(evidencePath, JSON.stringify(t3Evidence({ projectUuid: 'P-OTHER' })));
    const { status, payload } = await callGate(offlineGateBody({ acceptanceExtraOptions: { simulationEvidence: evidencePath } }));
    assert.equal(status, 200, JSON.stringify(payload).slice(0, 500));
    const simulation = gateById(payload, 'simulation');
    assert.equal(simulation.status, 'unknown');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND), JSON.stringify(codesOf(simulation)));
    const finding = simulation.findings.find((item) => item.code === RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND);
    assert.match(finding.message, /P-OTHER/);
    assert.match(finding.message, /P-CURRENT/);
    assert.equal(payload.evidenceBinding.simulation.consumed, false);
    assert.equal(payload.evidenceBinding.simulation.rejected[0].code, RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND);
  });
});

test('仿真证据缺失：不提供输入时保持 NOT_RUN（"没提供"与"不可用"要区分）', async () => {
  await withRuntimeServer(fakeBridge(), async ({ callGate }) => {
    const { payload } = await callGate(offlineGateBody());
    const simulation = gateById(payload, 'simulation');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_NOT_RUN));
    assert.equal(payload.evidenceBinding.simulation, null);
  });
});

test('仿真证据不可用（文件不存在/kind 错/run 非 0）：如实报 INVALID，不降级成 NOT_RUN', async () => {
  await withRuntimeServer(fakeBridge(), async ({ callGate, root }) => {
    const missing = await callGate(offlineGateBody({ acceptanceExtraOptions: { simulationEvidence: join(root, 'nope.json') } }));
    let simulation = gateById(missing.payload, 'simulation');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_EVIDENCE_INVALID), JSON.stringify(codesOf(simulation)));

    const wrongKindPath = join(root, 'wrong-kind.json');
    writeFileSync(wrongKindPath, JSON.stringify({ ...t3Evidence(), kind: 'generic-report' }));
    const wrongKind = await callGate(offlineGateBody({ acceptanceExtraOptions: { simulationEvidence: wrongKindPath } }));
    simulation = gateById(wrongKind.payload, 'simulation');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_EVIDENCE_INVALID));

    const failedRunPath = join(root, 'failed-run.json');
    writeFileSync(failedRunPath, JSON.stringify(t3Evidence({ runs: [{ kind: 'op', exitCode: 1 }] })));
    const failedRun = await callGate(offlineGateBody({ acceptanceExtraOptions: { simulationEvidence: failedRunPath } }));
    simulation = gateById(failedRun.payload, 'simulation');
    assert.ok(codesOf(simulation).includes(RELEASE_CODES.SIMULATION_EVIDENCE_INVALID));
    assert.match(simulation.findings[0].message, /exit1/);
  });
});

/** 证据库里的 DRC 条目形状：{kind:'drc-report', fingerprint:{pcbUuid}, payload:{report}}。 */
function drcEvidenceEntry(pcbUuid) {
  return {
    schemaVersion: 1,
    kind: 'drc-report',
    savedAt: new Date().toISOString(),
    digest: 'd'.repeat(64),
    fingerprint: pcbUuid ? { pcbUuid } : {},
    note: 'pcb drc job report',
    payload: {
      report: { ok: true, items: [], reportedCount: 0, truncated: false, countsConsistent: true, digest: 'e'.repeat(64) },
      ...(pcbUuid ? { pcbUuid } : {}),
    },
  };
}

test('DRC 绑定：报告 pcbUuid 与当前目标一致 → 通过；不一致 → blocked；缺 pcbUuid → unknown', async () => {
  await withRuntimeServer(fakeBridge(), async ({ callGate }) => {
    const matched = await callGate(offlineGateBody({ drcReport: drcEvidenceEntry(TARGET_PCB) }));
    let drc = gateById(matched.payload, 'drc');
    assert.equal(drc.status, 'pass', JSON.stringify(drc.findings));
    assert.equal(drc.evidence.binding.matched, true);
    assert.equal(drc.evidence.binding.evidencePcbUuid, TARGET_PCB);

    const mismatch = await callGate(offlineGateBody({ drcReport: drcEvidenceEntry(OTHER_PCB) }));
    drc = gateById(mismatch.payload, 'drc');
    assert.equal(drc.status, 'blocked', '另一块板的 DRC 报告不能当当前板结论');
    const mismatchFinding = drc.findings.find((item) => item.code === RELEASE_CODES.DRC_EVIDENCE_PCB_MISMATCH);
    assert.ok(mismatchFinding, JSON.stringify(codesOf(drc)));
    assert.match(mismatchFinding.message, new RegExp(OTHER_PCB));
    assert.match(mismatchFinding.message, new RegExp(TARGET_PCB));
    assert.equal(drc.evidence.binding.matched, false);

    const unbound = await callGate(offlineGateBody({ drcReport: drcEvidenceEntry(null) }));
    drc = gateById(unbound.payload, 'drc');
    assert.equal(drc.status, 'unknown', '缺 pcbUuid 时不能猜成当前板');
    assert.ok(codesOf(drc).includes(RELEASE_CODES.DRC_EVIDENCE_UNBOUND), JSON.stringify(codesOf(drc)));
  });
});
