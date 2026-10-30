import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvidenceStore } from '../evidence-store.mjs';
import { createRuntimeServer } from '../server.mjs';

/**
 * P0-5：门禁评估报告不再污染交付签核。task-16 之后 G1/G5/G6 已接入生产者，
 * "没喂证据"时必须判 unknown（GATE_EVIDENCE_MISSING），不能再报 not-implemented。
 *
 * 修复前 `evaluate()` 把 gate-report 以 kind:'signoff' 落盘，release/export/readiness 都用
 * 不过滤的 `latest('signoff')` → 用户在验证中心点一次"评估"，真实三方签核立刻被遮蔽。
 */

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-p05-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-p05-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-p05-automation-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-p05-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-p05-memo-${process.pid}.json`);

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const PCB_UUID = 'pcb-p05-0001';
const MANIFEST_HASH = 'a'.repeat(64);

function createOfflineBridge() {
  return {
    port: 49641,
    selectedWindowId: 'W-P05',
    async discover() { return { port: 49641 }; },
    async windows() { return { windows: [{ id: 'W-P05' }], selectedWindowId: 'W-P05', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id) { throw Object.assign(new Error(`P0-5 离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' }); },
  };
}

test('P0-5：点"评估"不遮蔽交付签核；缺证据的 G1/G5/G6 明确判 unknown（不再报未实现）', async (context) => {
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (path) => fetch(`${base}${path}`, { headers: { origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof } }).then((response) => response.json());

  // 1) 真实三方签核落盘。
  const signed = await post('/api/production/signoff', {
    passed: true,
    manifestHash: MANIFEST_HASH,
    pcbUuid: PCB_UUID,
    roles: [
      { role: '硬件设计', name: '张三', conclusion: '通过' },
      { role: '制造工艺', name: '李四', conclusion: '通过' },
      { role: '项目负责人', name: '王五', conclusion: '通过' },
    ],
  });
  assert.equal(signed.status, 200);
  const signoffDigest = (await signed.json()).evidence.digest;
  assert.ok(signoffDigest);

  // 2) 用户点一次"评估并归档报告"（门禁多半 unknown，但仍会落报告）。
  const evaluated = await post('/api/eda/gates/evaluate', { pcbUuid: PCB_UUID });
  assert.equal(evaluated.status, 200);
  const evaluatedBody = await evaluated.json();
  assert.equal(evaluatedBody.report.verdict, 'unknown');
  // task-16：G1/G5/G6 已有生产者，不再报 not-implemented；没喂证据时只能是 unknown。
  assert.deepEqual(evaluatedBody.report.notImplementedGates, []);
  for (const id of ['G1', 'G5', 'G6']) {
    const gate = evaluatedBody.report.gates.find((item) => item.id === id);
    assert.equal(gate.implemented, true);
    assert.equal(gate.verdict, 'unknown');
    assert.ok(gate.reasons.some((reason) => reason.code === 'GATE_EVIDENCE_MISSING'), `${id} 缺证据必须给 GATE_EVIDENCE_MISSING`);
  }

  // 3) 最新交付签核仍是真实签核（gate-report 不遮蔽）。
  const latest = await get('/api/production/signoff/latest');
  assert.equal(latest.evidence?.digest, signoffDigest);
  assert.equal(latest.evidence?.payload?.kind, 'signoff-record');

  // 4) 门禁状态同样把未实现门与证据不足门分开。
  const status = await get(`/api/eda/gates/status?pcbUuid=${encodeURIComponent(PCB_UUID)}`);
  assert.deepEqual(status.report.notImplementedGates, []);
  for (const id of ['G1', 'G5', 'G6']) assert.equal(status.report.gates.find((gate) => gate.id === id).verdict, 'unknown');

  // 5) P0-9：门禁建议只来自 approved + 未过期知识；candidate 不进门禁建议，审核后进入并写 usage。
  const created = await post('/api/knowledge/entries', {
    kind: 'rule',
    title: '缺证据时先补官方 DRC 报告',
    payload: { ruleId: 'GATE_EVIDENCE_MISSING', value: '先跑官方 DRC 并把报告落盘，再回来评估门禁' },
    provenance: { source: 'p0-9-http-test' },
    trust: 'reference',
  });
  assert.equal(created.status, 200);
  const entry = (await created.json()).entry;
  const beforeReview = await get(`/api/eda/gates/status?pcbUuid=${encodeURIComponent(PCB_UUID)}`);
  assert.equal(beforeReview.knowledgeAdvice.suggested.length, 0, 'candidate 不得进入门禁建议');
  assert.ok(beforeReview.knowledgeAdvice.unusableSkipped >= 1);

  const reviewed = await post(`/api/knowledge/entries/${encodeURIComponent(entry.id)}/review`, { state: 'approved', reviewedBy: 'lead' });
  assert.equal(reviewed.status, 200);
  const afterReview = await get(`/api/eda/gates/status?pcbUuid=${encodeURIComponent(PCB_UUID)}`);
  const statusAdvice = afterReview.knowledgeAdvice.suggested.find((item) => item.knowledgeId === entry.id);
  assert.ok(statusAdvice, 'approved 条目必须进入门禁建议');
  assert.equal(statusAdvice.review, 'approved');
  assert.match(statusAdvice.citation, /^knowledge:kn-rule-/);
  // GET 只读不写 usage；真正“采用建议”的评估（POST）才写 usage，避免只读请求产生副作用。
  assert.deepEqual((await get(`/api/knowledge/usage?id=${encodeURIComponent(entry.id)}`)).usages, []);
  const evaluatedAgain = await post('/api/eda/gates/evaluate', { pcbUuid: PCB_UUID });
  assert.equal(evaluatedAgain.status, 200);
  const evaluateAdvice = (await evaluatedAgain.json()).knowledgeAdvice.suggested.find((item) => item.knowledgeId === entry.id);
  assert.ok(evaluateAdvice, '评估时必须给出 approved 知识的门禁建议');
  const usage = await get(`/api/knowledge/usage?id=${encodeURIComponent(entry.id)}`);
  assert.ok(usage.usages.length >= 1, '门禁建议必须写 usage');
  assert.equal(usage.usages[0].outcome, 'used');
  assert.match(usage.usages[0].note, /门禁建议：G[1-6]\/GATE_EVIDENCE_MISSING/);
});

test('P0-5 兼容：修复前的三方签核（payload 无 kind、有 passed+roles）仍被认作交付签核', async (context) => {
  // 修复前 /api/production/signoff 落盘的 payload 没有 kind 字段；升级后不能把真实历史签核
  // 一律判成“无效签核”（那会让 readiness/release 在升级后莫名 blocked）。
  const store = createEvidenceStore({ root: process.env.CIRCUITPILOT_EVIDENCE_DIR });
  const legacy = store.save({
    kind: 'signoff',
    payload: { passed: true, operator: 'human', manifestHash: MANIFEST_HASH, conclusion: '人工终审通过', roles: [{ role: '硬件设计', name: '张三', conclusion: '通过' }] },
    fingerprint: { manifestHash: MANIFEST_HASH },
    note: 'legacy signoff（无 kind）',
  });
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const latest = await fetch(`${base}/api/production/signoff/latest`, { headers: { origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof } }).then((response) => response.json());
  assert.equal(latest.evidence?.digest, legacy.digest, '旧格式三方签核必须继续可用');
});

test('P0-5 复审：更旧的交付签核不被更新写入的 gate-report 遮蔽（向前找有效签核）', async (context) => {
  const store = createEvidenceStore({ root: process.env.CIRCUITPILOT_EVIDENCE_DIR });
  const signoff = store.save({
    kind: 'signoff',
    payload: { kind: 'signoff-record', passed: true, operator: 'human', manifestHash: MANIFEST_HASH, roles: [{ role: '硬件设计', name: '李四', conclusion: '通过' }] },
    fingerprint: { manifestHash: MANIFEST_HASH },
    note: '有效交付签核（比下面的报告旧）',
  });
  store.save({
    kind: 'signoff',
    payload: { kind: 'gate-report', pcbUuid: 'PCB-P05', report: { verdict: 'unknown' }, evidenceRefs: [] },
    fingerprint: { pcbUuid: 'PCB-P05' },
    note: '较新的门禁评估报告（不构成交付签核）',
  });
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const latest = await fetch(`${base}/api/production/signoff/latest`, { headers: { origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof } }).then((response) => response.json());
  assert.equal(latest.evidence?.digest, signoff.digest, '有效交付签核不能被更新的 gate-report 遮蔽');
});
