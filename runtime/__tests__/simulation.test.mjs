import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SIMULATION_CODES, checkOperatingPoint, detectAnalyses, discoverSolver, parseOperatingPoint,
  parseSolverDiagnostics, runSimulation, sha256Text, verifySimulationEvidence,
} from '../simulation.mjs';

/** 造一个"求解器"脚本：它就是真的可执行文件，我们验证的是管线而不是求解器本身。 */
function stubSolver(body) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-solver-stub-'));
  const path = join(dir, 'ngspice-stub');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return { dir, path };
}

const NGSPICE_LIKE = 'echo "ngspice-42 (stub)"\necho "v(3v3) = 3.301e+00"\necho "v(gnd) = 0.000e+00"\nexit 0';
const NETLIST = '* CircuitPilot sim\n.op\n.end\n';

test('求解器发现：环境变量优先，找不到就如实报 not-found（不猜"大概装了"）', () => {
  const hit = discoverSolver({ env: { CIRCUITPILOT_NGSPICE: '/x/ngspice' }, exists: (path) => path === '/x/ngspice' });
  assert.deepEqual({ path: hit.path, source: hit.source }, { path: '/x/ngspice', source: 'env' });
  const missing = discoverSolver({ env: { CIRCUITPILOT_NGSPICE: '/x/ngspice' }, exists: () => false });
  assert.equal(missing.path, null);
  assert.equal(missing.source, 'env-missing');
  const notFound = discoverSolver({ env: { PATH: '/only/here' }, exists: () => false });
  assert.equal(notFound.path, null);
  assert.equal(notFound.source, 'not-found');
  assert.ok(notFound.searched.includes('/only/here/ngspice'), '必须记录找过哪些路径，否则"没找到"无法复核');
  assert.ok(notFound.searched.includes('/opt/homebrew/bin/ngspice'));
});

test('网表分析指令与求解器输出解析', () => {
  assert.deepEqual(detectAnalyses(NETLIST), ['op']);
  assert.deepEqual(detectAnalyses('.tran 1u 1m\n.ac dec 10 1 1e9\n'), ['tran', 'ac']);
  assert.deepEqual(detectAnalyses('* 没有任何分析\n.end\n'), []);
  const op = parseOperatingPoint('v(3v3) = 3.301e+00\nv(CC1) = -1.2e-03\nnoise here\n');
  assert.deepEqual(op, { '3v3': 3.301, cc1: -0.0012 });
  // 真机 ngspice-46 的表格形态（第一版漏了这个，导致"跑过了但一个数值都没有"）
  const table = '\tNode                                  Voltage\n\t----                                 -------\n\tcc2                              2.500000e+00\n\tcc1                              2.500000e+00\n\tvbus                             5.000000e+00\n\n\tSource                          Current  Voltage  Power\n\tvbus                            -9.8e-04 5.0e+00   -4.9e-03\n';
  assert.deepEqual(parseOperatingPoint(table), { cc2: 2.5, cc1: 2.5, vbus: 5 });
  const diag = parseSolverDiagnostics('Warning: singular matrix\nError: no such device\n');
  assert.deepEqual(diag.errors, ['Error: no such device']);
  assert.deepEqual(diag.warnings, ['Warning: singular matrix']);
});

test('没有求解器时必须结构化失败：绝不返回值冒充"仿真通过"', async () => {
  const result = await runSimulation({ netlistText: NETLIST, env: { CIRCUITPILOT_NGSPICE: '/definitely/missing/ngspice' } });
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.code, SIMULATION_CODES.SOLVER_MISSING);
  assert.equal(result.evidence, null, '失败时不能凭空产出证据对象');
  assert.match(result.message, /不会返回伪造结果/);
});

test('空网表直接拒绝（不能拿"没有网表"当"没有发现问题"）', async () => {
  const result = await runSimulation({ netlistText: '   \n' });
  assert.equal(result.code, SIMULATION_CODES.NETLIST_REQUIRED);
});

test('真跑求解器：证据绑定网表哈希、求解器版本、产物哈希，且能通过校验', async () => {
  const stub = stubSolver(NGSPICE_LIKE);
  try {
    const result = await runSimulation({ netlistText: NETLIST, solverPath: stub.path });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.ran, true);
    const evidence = result.evidence;
    assert.equal(evidence.source, 'solver-run');
    assert.equal(evidence.netlist.sha256, sha256Text(NETLIST));
    assert.deepEqual(evidence.netlist.analyses, ['op']);
    assert.equal(evidence.solver.path, stub.path);
    assert.equal(evidence.solver.version, 'ngspice-42 (stub)', '版本必须取含 ngspice 的那一行，不能取 ****** 横幅');
    assert.equal(evidence.run.exitCode, 0);
    assert.ok(evidence.output.sha256, '必须记录产物哈希');
    assert.deepEqual(evidence.operatingPoint, { '3v3': 3.301, gnd: 0 });
    assert.ok(evidence.evidenceHash);
    const verdict = verifySimulationEvidence(evidence, { netlistText: NETLIST });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.findings));
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});

test('换了网表，旧证据必须失效（SIM_NETLIST_DIGEST_MISMATCH）', async () => {
  const stub = stubSolver(NGSPICE_LIKE);
  try {
    const { evidence } = await runSimulation({ netlistText: NETLIST, solverPath: stub.path });
    const verdict = verifySimulationEvidence(evidence, { netlistText: `${NETLIST}* 又改了一版\n` });
    assert.equal(verdict.ok, false);
    const finding = verdict.findings.find((item) => item.code === SIMULATION_CODES.NETLIST_DIGEST_MISMATCH);
    assert.ok(finding);
    assert.equal(finding.severity, 'blocking');
    assert.match(finding.message, /不是针对当前原理图跑的/);
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});

test('超时真的杀掉进程，并如实报 SIMULATION_SOLVER_TIMEOUT', async () => {
  const stub = stubSolver('sleep 5\nexit 0');
  try {
    const startedAt = Date.now();
    const result = await runSimulation({ netlistText: NETLIST, solverPath: stub.path, timeoutMs: 400 });
    assert.equal(result.code, SIMULATION_CODES.SOLVER_TIMEOUT);
    assert.ok(Date.now() - startedAt < 3_000, '不能等到求解器自己跑完才算超时');
    assert.match(result.message, /SIGKILL/);
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});

test('求解器非零退出＝失败，并带上退出码与 stderr 尾巴', async () => {
  const stub = stubSolver('echo "Error: bad netlist" 1>&2\nexit 3');
  try {
    const result = await runSimulation({ netlistText: NETLIST, solverPath: stub.path });
    assert.equal(result.code, SIMULATION_CODES.SOLVER_FAILED);
    assert.match(result.message, /退出码 3/);
    assert.match(result.message, /bad netlist/);
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});

test('样板/手工来源的证据，无论哈希多整齐都必须判为伪造（demo 模式才降级成警告）', () => {
  const fixture = { source: 'fixture', ran: true, solver: { path: 'openEMS' }, netlist: { sha256: 'abc' }, output: { bytes: 12, sha256: 'def' } };
  const production = verifySimulationEvidence(fixture, { netlistText: NETLIST });
  assert.equal(production.ok, false);
  const finding = production.findings.find((item) => item.code === SIMULATION_CODES.EVIDENCE_FABRICATED);
  assert.equal(finding.severity, 'blocking');
  assert.match(finding.message, /不能证明跑过仿真/);
  const demo = verifySimulationEvidence(fixture, { allowFixture: true });
  assert.equal(demo.ok, true, 'demo 模式只把"来源是样板"降级成警告');
  assert.equal(demo.findings.find((item) => item.code === SIMULATION_CODES.EVIDENCE_FABRICATED).severity, 'warning');
  // 但"证据与当前网表不匹配"在 demo 模式下依然是阻断项：降级的是来源，不是绑定关系。
  const demoMismatch = verifySimulationEvidence(fixture, { netlistText: NETLIST, allowFixture: true });
  assert.equal(demoMismatch.ok, false);
  assert.equal(demoMismatch.findings.find((item) => item.code === SIMULATION_CODES.NETLIST_DIGEST_MISMATCH).severity, 'blocking');
  assert.equal(verifySimulationEvidence(undefined).findings[0].code, SIMULATION_CODES.EVIDENCE_MISSING);
  assert.equal(verifySimulationEvidence({ source: 'solver-run' }).ok, false, '缺 ran/求解器/产物哈希一样不放行');
});

test('仿真"通过"必须落到具体数值区间上', () => {
  const ok = checkOperatingPoint({ '3v3': 3.301, gnd: 0 }, { '3v3': [3.1, 3.5], gnd: [-0.05, 0.05] });
  assert.equal(ok.ok, true);
  const bad = checkOperatingPoint({ '3v3': 4.9 }, { '3v3': [3.1, 3.5] });
  assert.equal(bad.ok, false);
  assert.equal(bad.findings[0].code, 'SIM_RAIL_OUT_OF_RANGE');
  const missing = checkOperatingPoint({}, { vbus: [4.5, 5.5] });
  assert.equal(missing.findings[0].code, SIMULATION_CODES.NO_RESULTS);
});
