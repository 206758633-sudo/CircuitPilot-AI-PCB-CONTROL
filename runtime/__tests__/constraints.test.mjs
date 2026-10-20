import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkConstraints, normalizeConstraints } from '../constraints.mjs';
import { gateFabricationRelease } from '../release-gate.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-con-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-con-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-con-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const requirement = (overrides) => ({ id: 'r1', category: '结构', name: '板框尺寸', value: '50×40', unit: 'mm', status: 'confirmed', kind: 'hard', blocking: true, source: '用户', note: '', updatedAt: '2026-10-19T00:00:00Z', ...overrides });

test('A1：需求归一化为可校验约束（板框/电流/GPIO/接口/温度；软约束与未确认不冒充硬门禁）', () => {
  const constraints = normalizeConstraints([
    requirement({ id: 'b', name: '板框尺寸', value: '50×40', unit: 'mm' }),
    requirement({ id: 'p', name: '总电流预算', value: '800', unit: 'mA' }),
    requirement({ id: 'g', name: '可用 GPIO', value: '12', unit: '个' }),
    requirement({ id: 'i', name: '通信接口', value: 'USB-C、UART', unit: '' }),
    requirement({ id: 't', name: '工作温度', value: '85', unit: '°C' }),
    requirement({ id: 's', name: '外壳颜色', value: '白色', unit: '', kind: 'soft' }),
    requirement({ id: 'u', name: '待确认项', value: '3', unit: '个', status: 'suggested' }),
  ]);
  assert.equal(constraints[0].type, 'board.minSize');
  assert.equal(constraints[0].minWidthMm, 50);
  assert.equal(constraints[0].minHeightMm, 40);
  assert.equal(constraints[1].type, 'power.maxTotalMa');
  assert.equal(constraints[1].limitMa, 800);
  assert.equal(constraints[2].type, 'gpio.minAvailable');
  assert.deepEqual(constraints[3].required, ['USB-C', 'UART']);
  assert.equal(constraints[4].type, 'temperature.maxC');
  assert.equal(constraints[5].type, 'unclassified');
  assert.match(constraints[5].reason, /软约束/);
  assert.equal(constraints[6].type, 'unclassified');
  assert.match(constraints[6].reason, /未确认/);
});

test('A1：逐条比对——通过/超预算/板框偏小/缺事实 unknown 都如实给出', () => {
  const pass = checkConstraints({
    constraints: [
      { type: 'board.minSize', name: '板框', minWidthMm: 50, minHeightMm: 40, blocking: true },
      { type: 'power.maxTotalMa', name: '电流', limitMa: 800, blocking: true },
      { type: 'gpio.minAvailable', name: 'GPIO', required: 8, blocking: true },
    ],
    facts: { board: { widthMm: 60, heightMm: 45 }, power: { totalMa: 620 }, mcu: { gpioAvailable: 12 } },
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.report.every((item) => item.status === 'pass'), true);

  const fail = checkConstraints({
    constraints: [
      { type: 'board.minSize', name: '板框', minWidthMm: 50, minHeightMm: 40, blocking: true },
      { type: 'power.maxTotalMa', name: '电流', limitMa: 500, blocking: true },
    ],
    facts: { board: { widthMm: 30, heightMm: 20 }, power: { totalMa: 900 } },
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.fails.length, 2);
  assert.match(fail.report[0].message, /小于需求/);
  assert.match(fail.report[1].message, /超过预算/);

  const unknown = checkConstraints({ constraints: [{ type: 'gpio.minAvailable', name: 'GPIO', required: 8, blocking: true }], facts: {} });
  assert.equal(unknown.ok, false, '缺事实必须 fail-closed，不能默认通过');
  assert.equal(unknown.unknowns.length, 1);
  assert.match(unknown.unknowns[0].message, /拿不到/);
});

test('A1：放行闸门接入约束子门——改小电流预算/板框会被阻断并列入 blockers', () => {
  const blocked = gateFabricationRelease({
    acceptance: null, drcReport: null, exemptions: [], placementVerification: null, artifacts: [], design: {},
    constraints: [
      { type: 'power.maxTotalMa', name: '总电流预算', limitMa: 500, blocking: true },
      { type: 'board.minSize', name: '板框尺寸', minWidthMm: 50, minHeightMm: 40, blocking: true },
    ],
    designFacts: { power: { totalMa: 800 }, board: { widthMm: 30, heightMm: 20 } },
  });
  const constraintsGate = blocked.gates.find((item) => item.id === 'constraints');
  assert.equal(constraintsGate.status, 'blocked');
  assert.equal(constraintsGate.evidence.report.length, 2);
  assert.ok(blocked.blockers.some((item) => item.code === 'RELEASE_CONSTRAINT_FAILED'));
  assert.match(blocked.blockers.find((item) => item.code === 'RELEASE_CONSTRAINT_FAILED').message, /超过预算|小于需求/);

  // 满足约束时，约束子门自己必须 pass（整体仍可能因缺 DRC 等被拦，不能因此把约束判失败）。
  const satisfied = gateFabricationRelease({
    constraints: [{ type: 'board.minSize', name: '板框尺寸', minWidthMm: 50, minHeightMm: 40, blocking: true }],
    designFacts: { board: { widthMm: 60, heightMm: 45 } },
  });
  assert.equal(satisfied.gates.find((item) => item.id === 'constraints').status, 'pass');
  assert.equal(satisfied.blockers.some((item) => item.code === 'RELEASE_CONSTRAINT_FAILED'), false);
});

test('A1 HTTP：/api/eda/release/gate 接收结构化约束与设计事实并阻断', async (context) => {
  const { server } = createRuntimeServer({ bridge: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const body = {
    // 三类证据显式提供，避免门禁去连真机；这里只验证约束子门接线。
    acceptance: { ready: false, netlist: {}, designChecks: [] },
    design: {},
    placementVerification: { ok: false, violations: [] },
    artifacts: [],
    constraints: [{ id: 'c1', name: '总电流预算', kind: 'hard', value: '500', unit: 'mA', blocking: true, status: 'confirmed' }],
    designFacts: { power: { totalMa: 900 } },
  };
  const response = await fetch(`${base}/api/eda/release/gate`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, false);
  const constraintsGate = result.gates.find((item) => item.id === 'constraints');
  assert.equal(constraintsGate.status, 'blocked');
  assert.ok(result.blockers.some((item) => item.code === 'RELEASE_CONSTRAINT_FAILED'));
});
