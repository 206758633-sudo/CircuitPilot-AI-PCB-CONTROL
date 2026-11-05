import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { inspectProductionArtifacts } from '../production.mjs';

/**
 * 2026-11-05 全链闭环审计（docs/implementation/full-audit-2026-11-05/）修复回归。
 *
 * 覆盖 5 条"代码层可闭环、无需真机"的断点：
 *  1. 交付 P0-2：签核/导出/归档的 manifest 哈希域必须都含 projectName，否则合法签核永远导出失败；
 *  2. 交付 P1-1：旧 W5 signoff-record（decision:reject）不得遮蔽有效交付签核；
 *  3. 交付 P1-3：PUT /api/validation-state 不得接受伪造/跨项目的 official 记录；
 *  4. PCB P0-2：placement/apply 的写板批准不能被 body.pcbUuid 重定向到另一块板；
 *  5. PCB P1-5：pour/create 请求指定 pcbUuid 时必须真的切到那块板，不能静默写活动板。
 */

const ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), 'cp-audit-artifacts-'));
process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-audit-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-audit-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-audit-automation-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-audit-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-audit-memo-${process.pid}.json`);
process.env.CIRCUITPILOT_ARTIFACTS_DIR = ARTIFACTS_DIR;

const GERBER_FILE = join(ARTIFACTS_DIR, 'GERBER_CircuitPilot-gerber.zip');
writeFileSync(GERBER_FILE, Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));
const ARTIFACTS = [{ kind: 'gerber', path: GERBER_FILE, name: 'GERBER_CircuitPilot-gerber.zip', bytes: 64 }];

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

/** 假桥：只在内存里模拟"当前活动文档"，记录所有写命令，离线可复现。 */
function createFakeBridge({ documents, projectUuid = 'P-AUDIT' } = {}) {
  const calls = [];
  let current = { documentType: 3, uuid: documents?.[0] || 'D1' };
  return {
    port: 49631,
    selectedWindowId: 'W-AUDIT',
    calls,
    async discover() { return { port: 49631 }; },
    async windows() { return { windows: [{ id: 'W-AUDIT' }], selectedWindowId: 'W-AUDIT', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(commandId, args = {}) {
      calls.push({ commandId, args });
      if (commandId === 'project.current') return { result: { uuid: projectUuid, data: [{ itemType: 'Board', pcb: { uuid: documents?.[0] || 'D1' } }] } };
      if (commandId === 'document.current') return { result: current };
      if (commandId === 'pcb.open') {
        current = { documentType: 3, uuid: String(args.documentUuid) };
        return { result: { opened: true } };
      }
      if (commandId === 'pcb.placement.read') {
        return { result: { components: [], componentCount: 0, outline: [] } };
      }
      if (commandId === 'pcb.pours.detail') throw Object.assign(new Error('离线测试不执行读命令'), { code: 'EDA_OFFLINE' });
      throw Object.assign(new Error(`离线测试不执行 EDA 命令：${commandId}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function startServer(bridge) {
  const { server } = createRuntimeServer({ bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  return { server, base, headers };
}

test('交付 P0-2：正式导出的 manifest 重算包含 projectName（否则合法签核必然 MISMATCH）', async (context) => {
  const { server, base, headers } = await startServer(createFakeBridge());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  // 模拟 readiness/签核侧的完整 binding：six-domain + projectName（production.mjs 的哈希域包含它）。
  const binding = {
    projectId: 'proj-1',
    projectName: '智能衣橱助手',
    documentId: 'doc-1',
    sourceDigest: 'd'.repeat(64),
    semanticPlanHash: 'a'.repeat(64),
    compiledPlanHash: 'b'.repeat(64),
    executionId: 'exec-1',
  };
  const expected = inspectProductionArtifacts(ARTIFACTS_DIR, binding).manifest.manifestHash;
  const response = await fetch(`${base}/api/production/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requested: 'final',
      manifestHash: expected,
      binding,
      artifacts: ARTIFACTS,
      artifactsDir: ARTIFACTS_DIR,
      acceptance: null,
      design: null,
      placementVerification: null,
    }),
  });
  const result = await response.json();
  // 修复前：exportBinding 丢掉 projectName → 重算哈希不同 → RELEASE_MANIFEST_MISMATCH。
  // 修复后：绑定成立，后续可能因缺人工 DFM/签核被 RELEASE_DECISION_BLOCKED，但不该是 MISMATCH。
  assert.notEqual(result.code, 'RELEASE_MANIFEST_MISMATCH', `导出不应再因 projectName 域丢失而 mismatch：${JSON.stringify(result.manifestBinding || {})}`);
  if (result.manifestBinding) assert.equal(result.manifestBinding.ok, true, 'manifest 绑定应成立');
});

test('交付 P1-1：旧 W5 signoff-record（reject）不能遮蔽有效交付签核', async (context) => {
  const { server, base, headers } = await startServer(createFakeBridge());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const manifestHash = 'm'.repeat(64);
  const signoffResponse = await fetch(`${base}/api/production/signoff`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      passed: true,
      roles: [{ role: '硬件设计', name: '张工', conclusion: '通过' }],
      manifestHash,
      operator: '张工',
    }),
  });
  assert.equal(signoffResponse.status, 200);
  const validDigest = (await signoffResponse.json()).evidence.digest;
  // 再写入一条"更新的"旧 W5 门禁终审记录（真实机器上这类文件会遮蔽有效签核）。
  const store = createEvidenceStore({ root: process.env.CIRCUITPILOT_EVIDENCE_DIR });
  store.save({
    kind: 'signoff',
    payload: { kind: 'signoff-record', pcbUuid: 'P-AUDIT', decision: 'reject', signedBy: '旧门禁', gateVerdict: 'blocked', reportDigest: 'x'.repeat(64) },
    fingerprint: { pcbUuid: 'P-AUDIT' },
    note: '旧 W5 门禁终审（reject）',
  });
  const latest = await fetch(`${base}/api/production/signoff/latest`, { headers }).then((response) => response.json());
  assert.equal(latest.evidence?.digest, validDigest, 'latest 必须跳过旧 reject 记录，返回有效交付签核');
  assert.equal(latest.evidence?.payload?.passed, true);
});

test('交付 P1-3：伪造/跨项目的 official 验证记录被 409 拒绝，真实证据可通过', async (context) => {
  const { server, base, headers } = await startServer(createFakeBridge());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const store = createEvidenceStore({ root: process.env.CIRCUITPILOT_EVIDENCE_DIR });
  const real = store.save({ kind: 'drc-report', payload: { report: { items: [] }, pcbUuid: 'D1' }, fingerprint: { pcbUuid: 'D1' }, note: 'test drc' });
  const official = (digest, projectId = 'proj-1', engine = 'DRC') => ({
    state: {
      validations: [{
        id: `official-drc-${projectId}`, name: 'DRC', description: '官方 DRC', status: 'pass', count: 0, findings: [],
        source: 'official', projectId, evidence: { engine, digest },
      }],
    },
  });
  const put = (body) => fetch(`${base}/api/validation-state`, { method: 'PUT', headers, body: JSON.stringify(body) });

  const forged = await put(official('f'.repeat(64)));
  assert.equal(forged.status, 409);
  assert.equal((await forged.json()).error.code, 'VALIDATION_EVIDENCE_UNKNOWN');

  const missingEngine = await put(official(real.digest, 'proj-1', ''));
  assert.equal(missingEngine.status, 400);
  assert.equal((await missingEngine.json()).error.code, 'VALIDATION_EVIDENCE_ENGINE_INVALID');

  const accepted = await put(official(real.digest));
  assert.equal(accepted.status, 200, '真实存在的证据摘要应允许写入');
  // 跨项目借同一份证据：新项目不能复用 proj-1 已声称的 digest。
  const borrowed = await put(official(real.digest, 'proj-2'));
  assert.equal(borrowed.status, 409);
  assert.equal((await borrowed.json()).error.code, 'VALIDATION_EVIDENCE_CROSS_PROJECT');
});

test('PCB P0-2：placement/apply 的批准不能被 body.pcbUuid 重定向到另一块板', async (context) => {
  const bridge = createFakeBridge({ documents: ['D1', 'D2'] });
  const { server, base, headers } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const approval = await fetch(`${base}/api/automation/approvals`, {
    method: 'POST', headers, body: JSON.stringify({ scope: 'write', note: '布局写回' }),
  }).then((response) => response.json());
  assert.equal(approval.ok, true);
  assert.equal(approval.approval.target.documentUuid, 'D1');
  const apply = (pcbUuid) => fetch(`${base}/api/eda/pcb/placement/apply`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ dryRun: false, approvalIds: [approval.approval.approvalId], pcbUuid, plan: { placements: [{ ref: 'U1', xMm: 1, yMm: 1, rotationDeg: 0 }] } }),
  });
  const redirected = await apply('D2');
  assert.equal(redirected.status, 409);
  const redirectedBody = await redirected.json();
  assert.equal(redirectedBody.error.code, 'AUTOMATION_APPROVAL_INVALID');
  assert.equal(redirectedBody.error.details?.approvedDocumentUuid, 'D1');
  assert.ok(!bridge.calls.some((call) => call.commandId === 'pcb.open' && call.args.documentUuid === 'D2'), '被拒绝的请求不能在切板后才失败');

  const sameBoard = await apply('D1');
  const sameBoardBody = await sameBoard.json();
  assert.notEqual(sameBoardBody.error?.code, 'AUTOMATION_APPROVAL_INVALID', '同一块板的批准不应被目标绑定拦下');
});

test('PCB P1-5：pour/create 指定 pcbUuid 时必须真的切到那块板', async (context) => {
  const bridge = createFakeBridge({ documents: ['D1', 'D2'] });
  const { server, base, headers } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const approval = await fetch(`${base}/api/automation/approvals`, {
    method: 'POST', headers, body: JSON.stringify({ scope: 'write', note: '新建覆铜' }),
  }).then((response) => response.json());
  await fetch(`${base}/api/eda/pcb/pour/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      approvalIds: [approval.approval.approvalId],
      pcbUuid: 'D2',
      net: 'GND',
      layer: 1,
      outline: [[0, 0], [10, 0], [10, 10], [0, 10]],
    }),
  });
  assert.ok(bridge.calls.some((call) => call.commandId === 'pcb.open' && call.args.documentUuid === 'D2'), '必须显式打开请求指定的板，不能静默使用活动板');
});
