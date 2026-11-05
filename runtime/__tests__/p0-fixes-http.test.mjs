import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

// 每个用例独立状态/证据目录：不能读仓库默认 artifacts（那会把历史官方结果/证据带进断言）。
const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start(context) {
  const root = mkdtempSync(join(tmpdir(), 'cp-p0-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  context.after(() => {
    for (const key of ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  return { base, headers };
}

test('P0-1 复审：官方验证结果经 /api/validation-state 持久化，非法载荷 400 且不覆盖', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.state.validations, []);
  const check = {
    id: 'val-official-1', name: 'DRC（官方）', status: 'pass', kind: 'drc', official: true,
    projectUuid: 'proj-1', summary: '0 errors', recordedAt: '2026-10-29T00:00:00.000Z',
    evidence: { executionId: 'exec-1', planHash: 'a'.repeat(64) },
  };
  const saved = await fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify({ state: { validations: [check] } }) });
  assert.equal(saved.status, 200);
  const reloaded = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(reloaded.state.validations.length, 1);
  assert.equal(reloaded.state.validations[0].id, 'val-official-1');
  const invalid = await fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify({ state: { validations: [{ status: 'pass' }] } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'VALIDATION_STATE_INVALID');
  const after = await (await fetch(`${base}/api/validation-state`, { headers })).json();
  assert.equal(after.state.validations.length, 1, '非法请求不得清掉已持久化的官方结果');
});

test('P0-5 复审：会话暂停与全局暂停互不覆盖，写门禁同时认两者', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(initial.gate.paused, false);
  assert.equal(initial.gate.sessionPaused, false);
  const session = await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: true, scope: 'session', reason: '当前会话先停手' }) });
  assert.equal(session.status, 200);
  const afterSession = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(afterSession.gate.sessionPaused, true);
  assert.equal(afterSession.gate.paused, false, '会话暂停不得污染全局暂停');
  assert.equal(afterSession.gate.sessionReason, '当前会话先停手');
  const global = await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: true, scope: 'global', reason: '全局停手' }) });
  assert.equal(global.status, 200);
  const both = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(both.gate.paused, true);
  assert.equal(both.gate.sessionPaused, true);
  await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: false, scope: 'session' }) });
  await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: false, scope: 'global' }) });
  const cleared = await (await fetch(`${base}/api/write-gate`, { headers })).json();
  assert.equal(cleared.gate.paused, false);
  assert.equal(cleared.gate.sessionPaused, false);
});

test('P1-15 复审：联网检索开关由 Runtime 持久化，status 反映真实配置', async (context) => {
  const { base, headers } = await start(context);
  const initial = await (await fetch(`${base}/api/research/config`, { headers })).json();
  assert.equal(initial.config.enabled, false, '联网默认关闭');
  const statusOff = await (await fetch(`${base}/api/research/status`, { headers })).json();
  assert.equal(statusOff.research.enabled, false);
  const enabled = await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, actor: '测试' }) });
  assert.equal(enabled.status, 200);
  const after = await (await fetch(`${base}/api/research/config`, { headers })).json();
  assert.equal(after.config.enabled, true);
  const statusOn = await (await fetch(`${base}/api/research/status`, { headers })).json();
  assert.equal(statusOn.research.enabled, true);
  const invalid = await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: 'yes' }) });
  assert.equal(invalid.status, 400);
  await fetch(`${base}/api/research/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: false }) });
});

test('P0-2 复审：门禁取证路由落证据、缺输入只报 missing，不伪造通过', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/eda/gates/collect`, { method: 'POST', headers, body: JSON.stringify({ pcbUuid: 'pcb-test-1', projectId: 'proj-test-1' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.evidenceReport, '取证必须返回证据汇总');
  assert.equal(body.evidenceReport.complete, false, '没有 spec/ERC/DRC 等输入时不能判 complete');
  assert.equal(body.report.verdict, 'unknown', '门禁裁决只能是 unknown，绝不能凭空 pass');
  const missingKinds = new Set(body.missing.map((item) => item.kind));
  for (const kind of ['rules', 'design-spec', 'placement', 'fabrication-release']) {
    assert.ok(missingKinds.has(kind), `${kind} 缺失必须如实登记`);
  }
  assert.deepEqual(body.evidenceReport.producedKinds, []);
  for (const kind of ['rules', 'design-spec', 'placement', 'fabrication-release']) {
    assert.ok(body.evidenceReport.missingKinds.includes(kind), `${kind} 必须进入 missingKinds`);
  }
});

test('P1-4 复审：PCB 写锁状态可查、解除路由可调用（无锁时是幂等空操作）', async (context) => {
  const { base, headers } = await start(context);
  const status = await (await fetch(`${base}/api/pcb/write-lock`, { headers })).json();
  assert.equal(status.ok, true);
  assert.equal(status.writeLock.safetyLocked, false);
  const release = await fetch(`${base}/api/pcb/write-lock/release`, { method: 'POST', headers, body: JSON.stringify({ operator: '测试', note: '确认现场安全' }) });
  assert.equal(release.status, 200);
  const after = await (await fetch(`${base}/api/pcb/write-lock`, { headers })).json();
  assert.equal(after.writeLock.safetyLocked, false);
});

test('2026-11-05 六门 G1 闭环：服务端从 EDA 只读板框/层数自动生成 design-spec（不信任客户端自报）', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-g1-http-'));
  const ENV = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  context.after(() => {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const bridge = {
    port: 49631,
    selectedWindowId: 'W-G1',
    async discover() { return { port: 49631 }; },
    async windows() { return { windows: [{ id: 'W-G1' }], selectedWindowId: 'W-G1', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(command) {
      calls.push(command);
      if (command === 'pcb.outline.read') return { result: { count: 1, boundsMm: { minXMm: 0, minYMm: 0, maxXMm: 60, maxYMm: 40 }, items: [] } };
      if (command === 'pcb.layers.copperCount') return { result: 4 };
      if (command === 'pcb.placement.read') return { result: { components: [], componentCount: 0, outline: [] } };
      if (command === 'schematic.netlist.export') throw Object.assign(new Error('离线测试不导出网表'), { code: 'EDA_OFFLINE' });
      if (command === 'project.current') return { result: { uuid: 'proj-g1', data: [{ itemType: 'Board', pcb: { uuid: 'pcb-g1' } }] } };
      if (command === 'document.current') return { result: { documentType: 3, uuid: 'pcb-g1' } };
      throw Object.assign(new Error(`离线测试不执行 ${command}`), { code: 'EDA_OFFLINE' });
    },
  };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/eda/gates/collect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pcbUuid: 'pcb-g1', projectId: 'proj-g1', readActualNetlist: false,
      specInput: { project: { id: 'proj-g1', name: 'G1 测试板' }, requirements: [{ id: 'r1', category: 'power', requirement: 'power · 输入：5V' }] },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.boards.source, 'eda', '板卡规格必须来自 EDA 只读回读，不用手填/猜测');
  assert.equal(body.boards.boards[0].layers, 4);
  assert.equal(body.boards.boards[0].outline.widthMm, 60);
  assert.equal(body.boards.boards[0].outline.heightMm, 40);
  assert.ok(calls.includes('pcb.outline.read') && calls.includes('pcb.layers.copperCount'));
  assert.ok((body.saved ?? []).some((item) => item.kind === 'design-spec'), 'design-spec 证据必须落盘（合格与否由内容决定，不伪造 pass）');
});

test('2026-11-05 审计 P1-8：项目状态里无法核验的阶段证据被剔除（客户端不能自报"原理图已生成"）', async (context) => {
  const { base, headers } = await start(context);
  const forged = {
    projects: [{
      id: 'proj-forge', name: '伪造证据项目', stage: '生产',
      edaWorkspace: { schematicStatus: 'generated', schematicExecutedAt: new Date().toISOString(), schematicExecutionId: 'whatever-id', pcbPlacementExecutedAt: new Date().toISOString(), pcbPlacementApprovalId: 'fake-approval' },
    }],
    activeProjectId: 'proj-forge', requirements: [], components: [], assets: [],
  };
  const put = await fetch(`${base}/api/project-state`, { method: 'PUT', headers, body: JSON.stringify({ state: forged }) });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.ok(Array.isArray(putBody.evidenceRejected) && putBody.evidenceRejected.length >= 2, '伪造的阶段证据必须被剔除并如实回报');
  assert.ok(putBody.evidenceRejected.some((item) => item.field === 'edaWorkspace.schematicStatus'));
  assert.ok(putBody.evidenceRejected.some((item) => item.field === 'edaWorkspace.pcbPlacementExecutedAt'));
  const readBack = await (await fetch(`${base}/api/project-state`, { headers })).json();
  const savedProject = readBack.state.projects.find((item) => item.id === 'proj-forge');
  assert.equal(savedProject.edaWorkspace.schematicStatus, undefined, '伪造字段不得落盘');
  assert.equal(savedProject.edaWorkspace.schematicExecutionId, undefined);
  assert.equal(savedProject.edaWorkspace.pcbPlacementApprovalId, undefined);
  assert.equal(savedProject.edaWorkspace.pcbPlacementExecutedAt, undefined);
  assert.equal(savedProject.name, '伪造证据项目', '其它正常字段必须保留（剔除不等于整包拒绝）');
});

test('2026-11-05 平台闭环 P1-4：research 的 allowResearch 还须服从 Runtime 权威开关（不能绕过设置页）', async (context) => {
  const { base, headers } = await start(context);
  const blocked = await fetch(`${base}/api/research/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'WS2812B datasheet', allowResearch: true }) });
  assert.equal(blocked.status, 403);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error.code, 'RESEARCH_DISABLED');
  assert.equal(blockedBody.error.details?.configEnabled, false, '必须说明是 Runtime 开关未开启，而不是请求没带 allowResearch');
});

test('2026-11-05 审计（设计 P1-6）：netlist-diff/rules 证据被放行裁决消费，不再是无生产者的死门', async (context) => {
  const { createEvidenceStore } = await import('../evidence-store.mjs');
  const { createEvidenceEnvelope } = await import('../evidence-contract.mjs');
  const { base, headers } = await start(context);
  const store = createEvidenceStore({ root: process.env.CIRCUITPILOT_EVIDENCE_DIR });
  const pcbUuid = 'pcb-p16';
  const netlistEnvelope = createEvidenceEnvelope({
    kind: 'netlist-diff', subject: { type: 'pcb', id: pcbUuid }, fingerprint: { pcbUuid },
    source: { agent: 'netlist-auditor', readOnly: true }, verdict: 'pass', findings: [],
  });
  const rulesEnvelope = createEvidenceEnvelope({
    kind: 'rules', subject: { type: 'pcb', id: pcbUuid }, fingerprint: { pcbUuid },
    source: { agent: 'rule-runner', readOnly: true }, verdict: 'pass', findings: [],
  });
  store.save({ kind: 'netlist-diff', payload: netlistEnvelope, fingerprint: { pcbUuid }, note: 'test' });
  store.save({ kind: 'rules', payload: rulesEnvelope, fingerprint: { pcbUuid }, note: 'test' });

  const response = await fetch(`${base}/api/eda/release/gate`, {
    method: 'POST', headers,
    body: JSON.stringify({ pcbUuid, acceptance: null, design: null, placementVerification: null, artifacts: [], artifactsDir: process.env.CIRCUITPILOT_ARTIFACTS_DIR || undefined }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const gateIds = (body.gates ?? []).map((gate) => gate.id);
  assert.ok(gateIds.includes('netlist'), 'netlist 子门必须被真实证据驱动（不再缺席）');
  assert.ok(gateIds.includes('rules'), 'rules 子门必须被真实证据驱动（不再缺席）');
  assert.ok(body.evidenceBinding?.netlist, '放行报告要记录消费了哪份 netlist 证据');
  assert.ok(body.evidenceBinding?.rules, '放行报告要记录消费了哪份 rules 证据');
});
