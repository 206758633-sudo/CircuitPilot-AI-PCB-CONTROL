import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * P0-6：正式生产导出解锁链路。
 *
 * 修复前三个死锁：①闸门请求不带 `requested`，`selfDraftReplacedPaths` 恒为 [] →
 * 目录里的自产 DRAFT 产物永远 `RELEASE_ARTIFACT_DRAFT_MARKER`；②readiness 看 `manufacturing/`、
 * 导出/门禁看 `deliverables/`，交接的 manifestHash 永远对不上；③门禁报告里的 `outputDecision`
 * 计算时又漏传 `draftPathsReplaced`，即使按钮条件满足也会再被拦。
 *
 * 这里用真实 HTTP 路由覆盖前两条：同一 `CIRCUITPILOT_ARTIFACTS_DIR` 下，缺省请求即按 final
 * 承认"本次将覆盖的自产草稿"；显式 draft 请求则仍如实报告草稿标记。
 */

const ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), 'cp-artifacts-root-'));
process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-p06-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-p06-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-p06-automation-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-p06-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-p06-memo-${process.pid}.json`);
process.env.CIRCUITPILOT_ARTIFACTS_DIR = ARTIFACTS_DIR;

const DRAFT_FILES = [
  'GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip',
  'BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv',
  'CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv',
  'STEP_CircuitPilot-step-DRAFT-NOT-FOR-ORDER.step',
];
const artifacts = [];
for (const name of DRAFT_FILES) {
  const path = join(ARTIFACTS_DIR, name);
  if (name.startsWith('GERBER_')) writeFileSync(path, Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));
  else if (name.startsWith('BOM_')) writeFileSync(path, 'No,Quantity,Designator,Value,Supplier Part,Supplier\n1,1,U1,,C100000,LCSC\n');
  else if (name.startsWith('CPL_')) writeFileSync(path, 'Designator,Mid X,Mid Y,Layer,Rotation\nU1,10mm,-20mm,T,0\n');
  else writeFileSync(path, 'ISO-10303-21;\nHEADER;\n');
  artifacts.push({ kind: name.startsWith('GERBER_') ? 'gerber' : name.startsWith('BOM_') ? 'bom' : name.startsWith('CPL_') ? 'cpl' : 'step', path, name, bytes: 64 });
}
mkdirSync(join(ARTIFACTS_DIR, 'pcb-3d'), { recursive: true });

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

function createOfflineBridge() {
  return {
    port: 49631,
    selectedWindowId: 'W-P06',
    async discover() { return { port: 49631 }; },
    async windows() { return { windows: [{ id: 'W-P06' }], selectedWindowId: 'W-P06', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id) {
      throw Object.assign(new Error(`P0-6 离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function startServer() {
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('P0-6：统一产物根 + 闸门缺省按 final 承认自产草稿替换；显式 draft 仍如实报草稿', async (context) => {
  const { server, base } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', 'origin': TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // ① readiness/inspect 与导出现在看同一个根：CIRCUITPILOT_ARTIFACTS_DIR 就是产物根。
  const inspected = await post('/api/production/artifacts/inspect', { binding: {} });
  assert.equal(inspected.status, 200);
  const inspection = (await inspected.json()).inspection;
  const inspectedNames = inspection.manifest.files.map((file) => file.name || file.path).join(' ');
  assert.match(inspectedNames, /GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER/, 'inspect 必须读取统一产物根');

  // 证据显式置 null = “没有”，避免离线测试触发 EDA 会话；这里只关心产物草稿裁决。
  const evidenceBody = { acceptance: null, design: null, placementVerification: null, artifacts, artifactsDir: ARTIFACTS_DIR };

  // ② 闸门请求不带 requested（UI 真实请求形状）：必须按 final 承认“本次将覆盖的自产草稿”。
  const gateDefault = await post('/api/eda/release/gate', evidenceBody);
  assert.equal(gateDefault.status, 200);
  const gateReport = await gateDefault.json();
  const blockerCodes = gateReport.blockers.map((item) => item.code);
  assert.ok(!blockerCodes.includes('RELEASE_ARTIFACT_DRAFT_MARKER'), `缺省闸门不应再被自产草稿挡住，实际：${blockerCodes.join('、')}`);

  // ③ 显式 draft：不声明“将被覆盖”，必须继续如实报草稿标记。
  const gateDraft = await post('/api/eda/release/gate', { ...evidenceBody, requested: 'draft' });
  assert.equal(gateDraft.status, 200);
  const draftCodes = (await gateDraft.json()).blockers.map((item) => item.code);
  assert.ok(draftCodes.includes('RELEASE_ARTIFACT_DRAFT_MARKER'), `显式 draft 请求必须如实报草稿，实际：${draftCodes.join('、')}`);
});

test('P0-6：门禁输出决策与替换清单同源（outputDecision 不再被草稿标记单独拦死）', async (context) => {
  const { server, base } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', 'origin': TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/production/release`, {
    method: 'POST',
    headers,
    // 缺省 requested 也必须视为 final（与 decideProductionOutput/正式导出同一默认最严口径）。
    body: JSON.stringify({ acceptance: null, design: null, placementVerification: null, artifacts, artifactsDir: ARTIFACTS_DIR }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requested, 'final');
  assert.ok(!body.blockers.includes('RELEASE_ARTIFACT_DRAFT_MARKER'));
  assert.equal(body.outputDecision?.allowed !== true || body.outputDecision.outputClass === 'final', true);
});

test('P0-6 默认产物根：仓库路径含空格时不得用 URL.pathname（会编码成 %20 指向错误目录）', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /fileURLToPath\(new URL\('\.\.\/deliverables\/', import\.meta\.url\)\)/);
  assert.doesNotMatch(source, /new URL\('\.\.\/deliverables\/', import\.meta\.url\)\.pathname/);
});
