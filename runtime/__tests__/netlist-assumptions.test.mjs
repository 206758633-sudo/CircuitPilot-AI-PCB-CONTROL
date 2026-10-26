import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { auditNetlistAssumptions, classifyAssumption } from '../netlist-assumptions.mjs';
import { planPinFirstNetlistFlow } from '../automation/pin-first-flow.mjs';
import { buildPinEvidence } from '../pin-evidence.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-assume-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-assume-evidence-'));
process.env.CIRCULTPILOT_RELEASES_DIR = mkdtempSync(join(tmpdir(), 'cp-assume-releases-'));
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const PADS = [
  { designator: 'U1', pad: '1', net: '3V3', layer: 1 },
  { designator: 'U1', pad: '2', net: 'GND', layer: 1 },
  { designator: 'R1', pad: '1', net: 'BOOT', layer: 1 },
];

const fakeChat = (assumptions) => ({ netlist: async () => ({ status: 'ready', explanation: 'ok', blockers: [], netlist: { title: 't', components: [], nets: [], assumptions } }) });

async function start(context, assumptions = ['电源轨由 3V3 单独走线', '未用脚按 NC 处理']) {
  const { server } = createRuntimeServer({ chat: fakeChat(assumptions), bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

test('A4 assumption 分类：电源/地/信号/未用脚按关键词标注，未知不硬猜', () => {
  assert.equal(classifyAssumption('3V3 电源上拉'), 'power');
  assert.equal(classifyAssumption('GND 接地'), 'ground');
  assert.equal(classifyAssumption('I2C 总线信号'), 'signal');
  assert.equal(classifyAssumption('未用脚按 NC 处理'), 'no-connect');
  assert.equal(classifyAssumption('这里有一个工程判断'), 'unknown');
  const audit = auditNetlistAssumptions(['VCC 供电单独走', '悬空脚 NC', '某个判断'], { defaultSource: 'inferred' });
  assert.equal(audit.counts.total, 3);
  assert.equal(audit.counts.marked, 2);
  assert.equal(audit.counts.unmarked, 1);
  assert.equal(audit.ok, true);
  assert.equal(audit.strictOk, false);
  assert.ok(audit.warnings.some((item) => item.code === 'NETLIST_ASSUMPTION_UNMARKED'));
  for (const item of audit.items) assert.ok(Array.isArray(item.text) || typeof item.text === 'string');
  const explicit = auditNetlistAssumptions(['VCC 供电'], { defaultSource: 'explicit' });
  assert.equal(explicit.items[0].source, 'explicit');
  assert.equal(explicit.counts.explicit, 1);
  const dirty = auditNetlistAssumptions(['', null], {});
  assert.equal(dirty.ok, false);
  assert.equal(dirty.blockers[0].code, 'NETLIST_ASSUMPTION_EMPTY');
  assert.equal(auditNetlistAssumptions(null, {}).counts.total, 0);
  assert.equal(auditNetlistAssumptions(null, {}).ok, true);
});

test('A4 两阶段计划：缺落板/缺证据 → executable:false + 明确 blockers；证据齐 → 4 阶段可执行', () => {
  const empty = planPinFirstNetlistFlow({});
  assert.equal(empty.executable, false);
  assert.equal(empty.autoExecute, false);
  assert.equal(empty.stages.length, 4);
  assert.ok(empty.blockers.some((item) => item.code === 'PIN_FLOW_PCB_NOT_PLACED'));
  assert.ok(empty.blockers.some((item) => item.code === 'PIN_FLOW_PIN_EVIDENCE_MISSING'));

  const evidence = buildPinEvidence({ pads: PADS });
  const complete = planPinFirstNetlistFlow({ pcbExecutionId: 'pcb-exec-1', pinEvidence: evidence, pinAudit: { ok: true, blockers: [] }, assumptionAudit: auditNetlistAssumptions(['VCC 供电'], { defaultSource: 'explicit' }) });
  assert.equal(complete.executable, true);
  assert.equal(complete.stages.map((stage) => stage.id).join(','), 'pcb-placement,pin-evidence,pin-audit,netlist-ai');
  assert.equal(complete.stages[0].requiresApproval, true);
  assert.match(complete.planId, /^[0-9a-f]{64}$/);

  const blockedAudit = planPinFirstNetlistFlow({ pcbExecutionId: 'pcb-exec-1', pinEvidence: evidence, pinAudit: { ok: false, blockers: [{ message: '1 个焊盘无网络' }] } });
  assert.equal(blockedAudit.executable, false);
  assert.ok(blockedAudit.blockers.some((item) => item.code === 'PIN_FLOW_PIN_AUDIT_BLOCKED'));

  const unmarked = planPinFirstNetlistFlow({ pcbExecutionId: 'pcb-exec-1', pinEvidence: evidence, pinAudit: { ok: true }, assumptionAudit: auditNetlistAssumptions(['某个判断'], {}) });
  assert.ok(unmarked.blockers.some((item) => item.code === 'PIN_FLOW_ASSUMPTIONS_UNMARKED'));
});

test('A4 HTTP：网表返回 assumptionAudit；strictAssumptions 未标注方向 409；两阶段计划路由只出计划', async (context) => {
  const post = await start(context);
  const response = await post('/api/design/netlist/ai', {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.netlist.assumptionAudit.counts.marked, 2);
  assert.equal(body.netlist.assumptionAudit.counts.unmarked, 0);
  assert.equal(body.netlist.assumptionAudit.items[0].source, 'inferred');

  const strict = await post('/api/design/netlist/ai', { strictAssumptions: true });
  assert.equal(strict.status, 200, '两条 assumption 都有方向，strict 应通过');

  const post2 = await start(context, ['某个未标明方向的判断']);
  const failed = await post2('/api/design/netlist/ai', { strictAssumptions: true });
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error.code, 'NETLIST_ASSUMPTION_UNMARKED');

  const flow = await post('/api/automation/flows/pin-first-netlist', { pcbExecutionId: null, assumptions: ['VCC 供电'] });
  assert.equal(flow.status, 200);
  const flowBody = await flow.json();
  assert.equal(flowBody.plan.executable, false);
  assert.equal(flowBody.plan.autoExecute, false);
  assert.ok(flowBody.plan.blockers.length >= 1);
});
