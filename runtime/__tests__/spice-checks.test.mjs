import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPICE_CHECK_CODES, ccRdCheck, checksFromDesign, i2cPullupCheck, runSpiceChecks,
} from '../spice-checks.mjs';

/** 假求解器：按节点表返回证据，用来单独验证"判定链"，真跑 ngspice 放在真机脚本里。 */
function fakeSolver(operatingPoint, { ran = true, code = null, hash = 'a'.repeat(64) } = {}) {
  const calls = [];
  const run = async (options) => {
    calls.push(options);
    if (!ran) return { ran: false, ok: false, code: code || 'SOLVER_FAILED', message: '假失败', evidence: null, findings: [] };
    return {
      ran: true, ok: true, code: null, findings: [],
      evidence: {
        source: 'solver-run', solver: { path: '/opt/homebrew/bin/ngspice', version: '** ngspice-46' },
        netlist: { bytes: options.netlistText.length, sha256: 'b'.repeat(64), analyses: ['op'] },
        run: { exitCode: 0, signal: null, durationMs: 15 },
        output: { bytes: 100, sha256: hash, head: 'x' },
        operatingPoint, evidenceHash: hash,
      },
    };
  };
  return { run, calls };
}

test('CC Rd 检查：设计里没有 Rd 就真的不建这个电阻（仿真必须反映现状，不是"应该的样子"）', () => {
  const missing = ccRdCheck({ hasRd: false });
  assert.equal(missing.applies, true);
  assert.equal(/RD\d/.test(missing.netlistText), false, '缺 Rd 时网表里不能偷偷补上电阻');
  assert.equal(missing.expectations.cc1[0], 0.25);
  assert.equal(missing.expectations.cc1[1], 0.61);
  assert.match(missing.defect, /缺少 5100Ω 下拉电阻/);
  assert.match(missing.recommendation, /CC1→GND、CC2→GND/);
  const present = ccRdCheck({ hasRd: true });
  assert.equal(/RD1 cc1 0 5100/.test(present.netlistText), true);
  assert.equal(present.defect, null);
  assert.equal(ccRdCheck({ ccNets: [] }).applies, false);
});

test('I2C 上拉检查：没有上拉时网表里只有漏电，上限是 0.7×VDD', () => {
  const missing = i2cPullupCheck({ pullupOhm: null });
  assert.equal(/RPU\d/.test(missing.netlistText), false);
  assert.equal(missing.expectations.bus1[0], 2.31);
  assert.equal(missing.expectations.bus1[1], 3.3);
  assert.match(missing.defect, /缺少上拉电阻/);
  assert.match(missing.note, /上升时间.*尚未实现/, '必须写清这项检查没覆盖什么');
  const present = i2cPullupCheck({ pullupOhm: 4700 });
  assert.equal(/RPU1 vdd bus1 4700/.test(present.netlistText), true);
  assert.equal(present.defect, null);
});

test('从真实设计推断检查：本板没有电阻 → 两项检查都指向"缺器件"', () => {
  const nets = [{ name: 'CC1' }, { name: 'CC2' }, { name: 'SDA' }, { name: 'SCL' }, { name: '3V3' }, { name: 'GND' }];
  const components = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'D1', 'J1'].map((designator) => ({ designator }));
  const checks = checksFromDesign({ nets, components });
  assert.equal(checks.length, 2);
  assert.equal(checks[0].id, 'cc-rd');
  assert.equal(checks[0].defect !== null, true, '没有电阻 → CC 缺 Rd');
  assert.equal(checks[1].id, 'i2c-pullup');
  assert.equal(checks[1].defect !== null, true, '没有电阻 → I2C 缺上拉');
  // 只有"电阻存在"不足以证明 Rd 存在：必须按真实连通性判定（某颗电阻两端分别在 CC 与 GND 上）
  const withoutPins = checksFromDesign({ nets, components: [...components, { designator: 'R1' }, { designator: 'R2' }, { designator: 'R3' }] });
  assert.equal(withoutPins[0].defect !== null, true, '没有引脚连通性证据时不能假设 Rd 存在');
  // 真机命名：USB_CC1 / USB_CC2（后缀匹配），R19/R20 分别接 GND
  const usbNets = [{ name: 'USB_CC1' }, { name: 'USB_CC2' }, { name: 'GND' }];
  const usbComponents = [
    { designator: 'U1', pins: [{ pin: '1', net: 'USB_CC1' }] },
    { designator: 'R19', pins: [{ pin: '1', net: 'USB_CC1' }, { pin: '2', net: 'GND' }] },
    { designator: 'R20', pins: [{ pin: '1', net: 'USB_CC2' }, { pin: '2', net: 'GND' }] },
  ];
  const connected = checksFromDesign({ nets: usbNets, components: usbComponents });
  assert.equal(connected[0].applies, true, 'USB_CC1/USB_CC2 必须按后缀匹配到 CC 检查');
  assert.equal(connected[0].defect, null, 'CC→GND 电阻存在 → Rd 检查按已有 Rd 建网表');
  assert.match(connected[0].note, /USB_CC1→R19/);
  assert.equal(checksFromDesign({ nets: [{ name: 'GND' }], components: [] })[0].applies, false);
});

test('实测在规范内 → 通过；超出规范 → 阻断并给出建议，结论绑定证据哈希', async () => {
  const solver = fakeSolver({ cc1: 0.4173, cc2: 0.4173 });
  const passed = await runSpiceChecks({ checks: [ccRdCheck({ hasRd: true })], solverPath: '/opt/homebrew/bin/ngspice', run: solver.run });
  assert.equal(passed.ok, true);
  assert.equal(passed.summary.passed, 1);
  assert.equal(passed.summary.simulated, true);
  assert.ok(passed.findings.some((finding) => finding.code === SPICE_CHECK_CODES.CHECK_PASSED && finding.severity === 'info'));
  assert.equal(passed.results[0].measurements.cc1, 0.4173);
  assert.match(passed.results[0].evidence.evidenceHash, /^a{64}$/);
  assert.equal(solver.calls[0].solverPath, '/opt/homebrew/bin/ngspice');

  const failing = fakeSolver({ cc1: 5, cc2: 5 });
  const failed = await runSpiceChecks({ checks: [ccRdCheck({ hasRd: false })], run: failing.run });
  assert.equal(failed.ok, false);
  assert.equal(failed.summary.failed, 1);
  const blocking = failed.findings.find((finding) => finding.code === SPICE_CHECK_CODES.CHECK_FAILED);
  assert.equal(blocking.severity, 'blocking');
  assert.match(blocking.message, /实测 cc1=5V/);
  assert.ok(failed.findings.some((finding) => finding.code === SPICE_CHECK_CODES.RECOMMENDATION));
});

test('没跑起来必须是"没跑"而不是"通过"（求解器缺失/失败/无结果）', async () => {
  const missing = fakeSolver({}, { ran: false, code: 'SOLVER_MISSING' });
  const result = await runSpiceChecks({ checks: [ccRdCheck({ hasRd: true })], run: missing.run });
  assert.equal(result.ok, false);
  assert.equal(result.summary.notRun, 1);
  assert.equal(result.summary.simulated, false);
  assert.ok(result.findings.some((finding) => finding.code === SPICE_CHECK_CODES.SOLVER_MISSING && finding.severity === 'blocking'));
  assert.match(result.findings[0].message, /这不是通过/);

  // 一个检查都没有可跑的（全部不适用）时也不许判通过
  const none = await runSpiceChecks({ checks: [{ id: 'x', applies: false, reason: '不适用' }], run: missing.run });
  assert.equal(none.ok, false);
  assert.equal(none.summary.simulated, false);
  assert.equal(none.summary.notApplicable, 1);

  // 求解器跑起来了但一个节点都没读出来 → 不能算通过（真机上第一版解析器就是这个下场）
  const empty = fakeSolver({});
  const emptyResult = await runSpiceChecks({ checks: [ccRdCheck({ hasRd: true })], run: empty.run });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.summary.failed, 1);
  assert.match(emptyResult.findings[0].message, /没有读到任何节点电压/);
});
