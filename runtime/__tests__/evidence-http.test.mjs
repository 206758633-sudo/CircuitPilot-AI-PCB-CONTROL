import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeServer } from '../server.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
const fakeGui = { async execute() { return {}; } };

const drcItems = [
  { errorType: 'Clearance', objects: [{ type: 'pcb_PrimitiveLine' }], signature: 'sig-1', instanceKey: 'clearance-1' },
  { errorType: 'Connection', objects: [], signature: 'sig-2', instanceKey: 'connection-1' },
];
const fakeBridge = {
  port: 49620,
  selectedWindowId: 'window-1',
  async discover() {},
  async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; },
  async execute(command) {
    switch (command) {
      case 'document.current': return { ok: true, result: { documentType: 3, uuid: 'pcb-1' } };
      case 'project.current': return { ok: true, result: { uuid: 'project-1', data: [{ uuid: 'project-1', name: '测试板' }] } };
      case 'pcb.drc.job.start': return { ok: true, result: { state: 'running' } };
      case 'pcb.job.poll': return { ok: true, result: { state: 'done', items: drcItems, reportedCount: drcItems.length, truncated: false } };
      default: return { ok: true, result: {} };
    }
  },
};

async function startServer(context) {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-http-'));
  const evidence = createEvidenceStore({ root: join(root, 'evidence') });
  // 豁免文件默认在用户 home 下：测试必须隔离，否则会读写这台机器的真实豁免清单。
  const previousExemptions = process.env.CIRCUITPILOT_DRC_EXEMPTIONS;
  process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(root, 'drc-exemptions.json');
  const previousStateDir = process.env.CIRCUITPILOT_STATE_DIR;
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  // 真机教训：这套用例的假桥返回 project.current = 'project-1'，而路由会在指纹读取时
  // rememberProject。没有隔离时它会把开发机真实的 ~/.circuitpilot/last-project.json 覆盖成
  // "project-1"，下次会话自愈就会去开一个不存在的工程。
  const previousMemo = process.env.CIRCUITPILOT_PROJECT_MEMO;
  process.env.CIRCUITPILOT_PROJECT_MEMO = join(root, 'project-memo.json');
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: fakeGui, evidence });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previousExemptions === undefined) delete process.env.CIRCUITPILOT_DRC_EXEMPTIONS;
    else process.env.CIRCUITPILOT_DRC_EXEMPTIONS = previousExemptions;
    if (previousStateDir === undefined) delete process.env.CIRCUITPILOT_STATE_DIR;
    else process.env.CIRCUITPILOT_STATE_DIR = previousStateDir;
    if (previousMemo === undefined) delete process.env.CIRCUITPILOT_PROJECT_MEMO;
    else process.env.CIRCUITPILOT_PROJECT_MEMO = previousMemo;
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const healthResponse = await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } });
  const health = await healthResponse.json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, headers, post, evidence };
}

test('DRC 报告 HTTP：跑完落盘并给出 saved.digest；latest 能读回同一份', async (context) => {
  const { base, headers, post } = await startServer(context);
  const started = await (await post('/api/eda/pcb/drc/start', {})).json();
  assert.equal(started.ok, true);
  assert.ok(started.jobId);
  const reported = await (await post('/api/eda/pcb/drc/report', { jobId: started.jobId, pcbUuid: 'pcb-1' })).json();
  assert.equal(reported.state, 'done');
  assert.ok(reported.saved?.digest, 'DRC 报告必须落盘并返回 digest');
  assert.ok(reported.saved.path.endsWith('.json'));
  const latest = await (await fetch(`${base}/api/eda/pcb/drc/latest?pcbUuid=pcb-1`, { headers })).json();
  assert.equal(latest.evidence.digest, reported.saved.digest);
  assert.equal(latest.evidence.payload.report.items.length, drcItems.length);
  const otherPcb = await (await fetch(`${base}/api/eda/pcb/drc/latest?pcbUuid=pcb-2`, { headers })).json();
  assert.equal(otherPcb.evidence, null);
});

test('DFM 证据 HTTP：必须显式 passed；落盘后 latest 可读回且指纹绑定 planHash', async (context) => {
  const { base, headers, post } = await startServer(context);
  const invalid = await post('/api/production/dfm-evidence', { operator: '王工', conclusion: '看起来没问题' });
  assert.equal(invalid.status, 400);
  const invalidJson = await invalid.json();
  assert.equal(invalidJson.error.code, 'DFM_EVIDENCE_INVALID');

  const created = await (await post('/api/production/dfm-evidence', { passed: true, operator: '王工', conclusion: '在线 DFM 无阻断', planHash: 'plan-1', artifacts: [{ name: 'dfm.png' }] })).json();
  assert.equal(created.evidence.payload.passed, true);
  assert.ok(created.evidence.digest);
  const latest = await (await fetch(`${base}/api/production/dfm-evidence/latest?planHash=plan-1`, { headers })).json();
  assert.equal(latest.evidence.digest, created.evidence.digest);
  const miss = await (await fetch(`${base}/api/production/dfm-evidence/latest?planHash=plan-2`, { headers })).json();
  assert.equal(miss.evidence, null);
});

test('终审签核 HTTP：未通过/缺清单哈希一律拒绝，通过则落盘并可读', async (context) => {
  const { base, headers, post } = await startServer(context);
  const failed = await post('/api/production/signoff', { passed: false, roles: [{ role: '硬件设计', name: '李工' }], manifestHash: 'm-1' });
  assert.equal(failed.status, 400);
  const missingManifest = await post('/api/production/signoff', { passed: true, roles: [{ role: '硬件设计', name: '李工' }] });
  assert.equal(missingManifest.status, 400);
  const roles = [
    { role: '硬件设计', name: '李工', conclusion: '通过' },
    { role: '制造/工艺', name: '王工', conclusion: '通过' },
    { role: '项目负责人', name: '张工', conclusion: '通过' },
  ];
  const created = await (await post('/api/production/signoff', { passed: true, roles, manifestHash: 'm-1', planHash: 'plan-1' })).json();
  assert.equal(created.evidence.payload.roles.length, 3);
  const latest = await (await fetch(`${base}/api/production/signoff/latest?manifestHash=m-1`, { headers })).json();
  assert.equal(latest.evidence.digest, created.evidence.digest);

  // 放行批准入统一账本：三方签核后 scope=release 的 issued 记录必须出现，并绑定清单哈希。
  const ledger = await (await fetch(`${base}/api/approvals/ledger`, { headers })).json();
  const release = ledger.entries.find((entry) => entry.scope === 'release' && entry.action === 'issued');
  assert.ok(release, `账本里应有 release 签发记录：${JSON.stringify(ledger.entries)}`);
  assert.equal(release.bindings.manifestHash, 'm-1');
  assert.equal(release.bindings.planHash, 'plan-1');
  assert.equal(ledger.chain.ok, true);
});

test('DRC 豁免 HTTP：缺理由/风险拒绝写入；合法条目落盘并可读回（配额/理由/风险都在）', async (context) => {
  const { base, headers, post } = await startServer(context);
  const putExemptions = (exemptions) => fetch(`${base}/api/eda/pcb/drc/exemptions`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ exemptions }) });
  const invalid = await putExemptions([{ scope: 'kind', match: { errorType: 'Clearance' }, maxCount: 3, reason: '短', risk: '短' }]);
  assert.notEqual(invalid.status, 200);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, 'DRC_EXEMPTION_INVALID');

  const validRow = { scope: 'kind', match: { errorType: 'Clearance', ruleName: '间距' }, maxCount: 3, reason: '板厂确认该间距在其工艺能力内，样机阶段接受。', risk: '极端情况下高压区爬电裕量不足，量产前必须改板。', approvedBy: '李工' };
  const savedResponse = await putExemptions([validRow]);
  const saved = await savedResponse.json();
  assert.equal(saved.count, 1, `HTTP ${savedResponse.status} ${JSON.stringify(saved).slice(0, 400)}`);
  assert.ok(saved.path.endsWith('drc-exemptions.json'));

  const listed = await (await fetch(`${base}/api/eda/pcb/drc/exemptions`, { headers })).json();
  assert.equal(listed.exists, true);
  assert.equal(listed.exemptions.length, 1);
  assert.equal(listed.invalid.length, 0);
  assert.equal(listed.exemptions[0].approvedBy, '李工');
});
