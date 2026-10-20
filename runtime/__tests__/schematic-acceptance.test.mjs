import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPTANCE_CODES, runSchematicAcceptance } from '../schematic-acceptance.mjs';

/** 真实形状的网表：没有 `nets` 键，网络在 designRule.netRule 与引脚网名里。 */
function realShapedNetlist({ extraUnconnected = false } = {}) {
  const components = {
    gge1: { props: { Designator: 'U1', 'Supplier Part': 'C529344', 'Convert to PCB': 'yes' }, pinInfoMap: { A4: { net: 'SDA' }, A5: { net: 'GND' }, ...(extraUnconnected ? { B1: { net: '' } } : {}) } },
    gge2: { props: { Designator: 'U2', 'Supplier Part': 'C49851', 'Convert to PCB': 'yes' }, pinInfoMap: { 1: { net: 'GND' }, 4: { net: 'SDA' } } },
  };
  return JSON.stringify({
    version: '2.0.0',
    components,
    designRule: { trackPhysics: {}, netRule: { SDA: { net: 'SDA', ruleMap: {} }, GND: { net: 'GND', ruleMap: {} } } },
  });
}

const okExecute = (netlistText) => async (commandId) => {
  if (commandId === 'schematic.netlist.export') return { result: { name: 'circuitpilot-netlist', size: netlistText.length, text: netlistText } };
  if (commandId === 'schematic.drc') return { result: [{ type: 'warn', count: 3 }] };
  if (commandId === 'schematic.simulation.netlist.export') return { result: null };
  throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
};

/** 假求解器：按给定节点电压返回证据，让"设计检查点"的判定链可测且不依赖本机装没装 ngspice。 */
const fakeSimulationRun = (operatingPoint) => async () => ({
  ran: true, ok: true, code: null, findings: [],
  evidence: {
    source: 'solver-run', solver: { path: '/fake/ngspice', version: '** ngspice-test' },
    netlist: { bytes: 100, sha256: 'c'.repeat(64), analyses: ['op'] },
    run: { exitCode: 0, signal: null, durationMs: 5 },
    output: { bytes: 50, sha256: 'd'.repeat(64), head: 'x' },
    operatingPoint, evidenceHash: 'e'.repeat(64),
  },
});

test('原理图验收链：好网表放行；本机没有求解器时必须如实说"仿真没有跑"', async () => {
  const report = await runSchematicAcceptance({ execute: okExecute(realShapedNetlist()), discover: () => ({ path: null, source: 'not-found', searched: [] }) });
  assert.equal(report.ready, true, JSON.stringify(report.findings));
  assert.equal(report.netlist.nets, 2);
  assert.equal(report.netlist.netsSource, 'designRule.netRule+pinInfoMap');
  // 网表 sha256 必须随报告给出：门禁指纹靠它才覆盖设计内容（真机曾因缺它导致"改了原理图指纹不变"）
  assert.match(report.netlist.meta.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.simulation, null, '没有仿真证据时不能凭空生成');
  const notRunnable = report.findings.find((f) => f.code === ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE);
  assert.ok(notRunnable, '必须报"仿真不可执行"');
  assert.match(notRunnable.message, /不是"仿真通过"，是"没有仿真"/);
  assert.ok(report.findings.some((f) => f.code === 'SCHEMATIC_ERC_AGGREGATE_ONLY'));
  assert.deepEqual(report.steps.map((s) => s.step), ['netlist', 'erc', 'verify', 'simulation']);
  assert.equal(report.designChecks, null, '连求解器都没有，不许凭空生成设计检查结论');
});

test('EDA 导不出 SPICE 网表但本机有求解器 → 改用设计检查点真跑，并把"没有仿真"如实改成"有范围的仿真"', async () => {
  const report = await runSchematicAcceptance({
    execute: okExecute(realShapedNetlist()),
    discover: () => ({ path: '/fake/ngspice', source: 'path', searched: [] }),
    simulationRun: fakeSimulationRun({ bus1: 3.2984, vdd: 3.3 }),
  });
  assert.equal(report.simulation, null, 'EDA 侧没有仿真网表，这部分证据仍然必须是 null');
  assert.ok(report.designChecks, '必须有设计检查点结论');
  assert.equal(report.designChecks.summary.simulated, true);
  assert.equal(report.designChecks.summary.passed, 1);
  assert.equal(report.ready, true, JSON.stringify(report.findings));
  const note = report.findings.find((f) => f.code === ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE);
  assert.equal(note.severity, 'info');
  assert.match(note.message, /设计检查点/);
  assert.match(note.message, /不等于全电路仿真/, '覆盖范围有限必须写在结论里');
  assert.ok(report.steps.some((step) => step.step === 'design-checks' && step.summary.simulated === true));
});

test('设计检查点实测超出规范 → 阻断（仿真真的会拦住真实缺陷）', async () => {
  const report = await runSchematicAcceptance({
    execute: okExecute(realShapedNetlist()),
    discover: () => ({ path: '/fake/ngspice', source: 'path', searched: [] }),
    simulationRun: fakeSimulationRun({ bus1: 0, vdd: 3.3 }),
  });
  assert.equal(report.ready, false);
  const blocking = report.findings.find((f) => f.code === 'SPICE_CHECK_FAILED');
  assert.ok(blocking, JSON.stringify(report.findings.map((f) => f.code)));
  assert.equal(blocking.severity, 'blocking');
  assert.match(blocking.field, /^design-checks:/);
  assert.match(blocking.message, /不满足 I2C 开漏总线空闲电平/);
});

test('缺 execute 直接拒绝：验收不能被"没有数据"糊过去', async () => {
  await assert.rejects(() => runSchematicAcceptance({}), (error) => error.code === ACCEPTANCE_CODES.EXECUTE_REQUIRED);
});

test('网表导出失败＝阻断，且不能因此跳过 ERC 与仿真步骤的记录', async () => {
  const report = await runSchematicAcceptance({
    execute: async (commandId) => {
      if (commandId === 'schematic.netlist.export') throw Object.assign(new Error('EDA 未连接'), { code: 'EDA_UNAVAILABLE' });
      if (commandId === 'schematic.drc') return { result: [{ type: 'error', count: 1 }] };
      return { result: null };
    },
  });
  assert.equal(report.ready, false);
  assert.ok(report.findings.some((f) => f.code === ACCEPTANCE_CODES.NETLIST_EXPORT_FAILED));
  assert.equal(report.netlist, null);
  assert.equal(report.steps.find((s) => s.step === 'netlist').ok, false);
  assert.equal(report.steps.find((s) => s.step === 'simulation').ok, false);
});

test('与语义计划比对出的缺失元件会阻断验收（R1/R2 那种情况）', async () => {
  const plan = { components: [{ ref: 'U1', lcsc: 'C529344' }, { ref: 'U2', lcsc: 'C49851' }, { ref: 'R1', lcsc: 'C25905' }], nets: [{ name: 'SDA' }, { name: 'GND' }] };
  const report = await runSchematicAcceptance({ execute: okExecute(realShapedNetlist()), plan });
  assert.equal(report.ready, false);
  const missing = report.findings.find((f) => f.code === 'SCHEMATIC_COMPONENT_MISSING');
  assert.ok(missing);
  assert.match(missing.message, /R1/);
});

test('未连接引脚只警告；显式 skipSimulation 也必须留痕，不能被当成"仿真通过"', async () => {
  const report = await runSchematicAcceptance({ execute: okExecute(realShapedNetlist({ extraUnconnected: true })), skipSimulation: true });
  assert.equal(report.ready, true, JSON.stringify(report.findings));
  assert.ok(report.findings.some((f) => f.code === 'SCH_PIN_NO_NET' && f.severity === 'warning'));
  const skipped = report.findings.find((f) => f.code === ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE);
  assert.match(skipped.message, /不要把它当成"仿真通过"/);
});

test('真跑求解器时：证据进报告，工作点数值不符期望＝阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-accept-solver-'));
  const stub = join(dir, 'ngspice-stub');
  writeFileSync(stub, '#!/bin/sh\necho "ngspice-42 (stub)"\necho "v(3v3) = 4.9e+00"\nexit 0\n', 'utf8');
  chmodSync(stub, 0o755);
  try {
    const execute = async (commandId) => {
      if (commandId === 'schematic.netlist.export') { const text = realShapedNetlist(); return { result: { text, size: text.length } }; }
      if (commandId === 'schematic.drc') return { result: [{ type: 'warn', count: 1 }] };
      if (commandId === 'schematic.simulation.netlist.export') return { result: { text: '* sim\n.op\n.end\n', size: 15 } };
      throw new Error(`未知命令 ${commandId}`);
    };
    const report = await runSchematicAcceptance({ execute, solverPath: stub, expectations: { '3v3': [3.1, 3.5] } });
    assert.equal(report.simulation.source, 'solver-run');
    assert.ok(report.simulation.evidenceHash);
    assert.equal(report.ready, false, '4.9V 超出 [3.1,3.5] 必须阻断');
    assert.ok(report.findings.some((f) => f.code === 'SIM_RAIL_OUT_OF_RANGE'));
    const clean = await runSchematicAcceptance({ execute, solverPath: stub, expectations: { '3v3': [4.5, 5.5] } });
    assert.equal(clean.ready, true, JSON.stringify(clean.findings));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * 真机根因回归（2026-10-13）：活动文档不是原理图时，导出命令**不报错也不返回内容**。
 * 改造前这会被下游读成"网表 0 个器件"，是"读错文档 ⇒ 假证据"的典型；有时还要白等 60s 超时。
 */
test('活动文档不是原理图时：如实报 NETLIST_WRONG_DOCUMENT，并且根本不去导出', async () => {
  const calls = [];
  const execute = async (commandId) => {
    calls.push(commandId);
    if (commandId === 'document.current') return { result: { uuid: 'pcb-1', documentType: 3 } };
    if (commandId === 'schematic.netlist.export') return { result: { name: 'x', size: 0, text: '' } };
    if (commandId === 'schematic.drc') return { result: [{ type: 'warn', count: 0 }] };
    if (commandId === 'schematic.simulation.netlist.export') return { result: null };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const report = await runSchematicAcceptance({ execute, discover: () => ({ path: null, source: 'not-found', searched: [] }) });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes(ACCEPTANCE_CODES.NETLIST_WRONG_DOCUMENT), JSON.stringify(codes));
  assert.ok(!codes.includes(ACCEPTANCE_CODES.NETLIST_EMPTY), '不能把"读错文档"报成"空网表"');
  assert.ok(!calls.includes('schematic.netlist.export'), '文档不对就不该去导出（真机上那次要白等 60s）');
  assert.equal(report.ready, false);
});

test('document.current 不可用时：退回原行为（照常导出），不因为探针失败就放弃验收', async () => {
  const calls = [];
  const netlist = realShapedNetlist();
  const execute = async (commandId, args) => {
    calls.push(commandId);
    if (commandId === 'document.current') throw Object.assign(new Error('该命令在此上下文不可用'), { code: 'UNKNOWN_COMMAND' });
    if (commandId === 'schematic.netlist.export') return { result: { name: 'circuitpilot-netlist', size: netlist.length, text: netlist } };
    if (commandId === 'schematic.drc') return { result: [{ type: 'warn', count: 0 }] };
    if (commandId === 'schematic.simulation.netlist.export') return { result: null };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const report = await runSchematicAcceptance({ execute, discover: () => ({ path: null, source: 'not-found', searched: [] }) });
  assert.ok(calls.includes('schematic.netlist.export'));
  assert.equal(report.netlist.components, 2);
  assert.ok(!report.findings.some((item) => item.code === ACCEPTANCE_CODES.NETLIST_WRONG_DOCUMENT));
});

test('大网表（inline=false）：必须走分片取回并拼成完整网表，不能误报为空', async () => {
  const full = realShapedNetlist();
  const half = Math.floor(full.length / 2);
  const calls = [];
  const execute = async (commandId, args) => {
    calls.push([commandId, args]);
    if (commandId === 'document.current') return { result: { documentType: 1 } };
    if (commandId === 'schematic.netlist.export') return { result: { name: 'n', size: full.length, inline: false, exportId: 'exp-1', chunkSize: half, chunks: 2 } };
    if (commandId === 'schematic.netlist.chunk') {
      assert.equal(args.exportId, 'exp-1');
      return { result: { index: args.index, total: 2, text: args.index === 0 ? full.slice(0, half) : full.slice(half) } };
    }
    if (commandId === 'schematic.drc') return { result: [{ type: 'warn', count: 0 }] };
    if (commandId === 'schematic.simulation.netlist.export') return { result: null };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const report = await runSchematicAcceptance({ execute, discover: () => ({ path: null, source: 'not-found', searched: [] }) });
  assert.equal(report.netlist.components, 2);
  const netlistStep = report.steps.find((item) => item.step === 'netlist');
  assert.equal(netlistStep.inline, false);
  assert.equal(netlistStep.chunks, 2);
  assert.equal(calls.filter(([id]) => id === 'schematic.netlist.chunk').length, 2);
  assert.ok(!report.findings.some((item) => item.code === ACCEPTANCE_CODES.NETLIST_EMPTY));
});

test('大网表分片取回失败：必须报"分片取回失败"，不能把半截网表当完整结果', async () => {
  const execute = async (commandId) => {
    if (commandId === 'document.current') return { result: { documentType: 1 } };
    if (commandId === 'schematic.netlist.export') return { result: { name: 'n', size: 900000, inline: false, exportId: 'exp-lost', chunks: 4 } };
    if (commandId === 'schematic.netlist.chunk') return { result: { error: 'EDA_EXPORT_BUFFER_LOST' } };
    if (commandId === 'schematic.drc') return { result: [] };
    if (commandId === 'schematic.simulation.netlist.export') return { result: null };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const report = await runSchematicAcceptance({ execute, discover: () => ({ path: null, source: 'not-found', searched: [] }) });
  assert.equal(report.netlist, null);
  const finding = report.findings.find((item) => item.code === ACCEPTANCE_CODES.NETLIST_EMPTY);
  assert.ok(finding);
  assert.match(finding.message, /分片取回失败/);
  assert.equal(report.steps.find((item) => item.step === 'netlist').reason, 'EDA_EXPORT_BUFFER_LOST');
});
