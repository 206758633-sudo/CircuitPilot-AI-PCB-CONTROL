/**
 * SPICE 仿真证据管线（只用 Node 内建模块，保持 runtime 零依赖）。
 *
 * 为什么必须存在这个文件：本项目此前所谓"仿真证据"是一个硬编码字符串
 * （engineering/fixtures.mjs 里的 `sha256:fixture-openems-result`），而门禁只检查
 * "hash 字段存在"——**编造的证据和真实的证据在结构上无法区分**。这里把它反过来：
 *
 *   - 证据只能由 `runSimulation()` 产出，它必须真的 spawn 一个求解器进程；
 *   - 证据里绑定网表 sha256、求解器路径与版本、产物 sha256；
 *   - 校验时用当前网表重算 sha256 比对 → 换了网表就自动失效，无法复用旧结论；
 *   - 没有求解器就返回 `SIMULATION_SOLVER_MISSING`（结构化失败），**绝不返回值假装成功**。
 *
 * 真机现状（2026-10-13 实测）：本机与嘉立创EDA 应用内都**没有** ngspice/spice3/xyce，
 * 且 `sch_ManufactureData.getSimulationNetlistFile()` 对本工程返回 undefined
 * （原理图里没有任何仿真模型绑定）。所以真实结论是：仿真验收**当前不可执行**，
 * 而不是"仿真通过"。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SOLVER_CANDIDATES = ['ngspice', 'ngspice-42', 'ngspice-41', 'spice3', 'xyce'];
export const SIMULATION_EVIDENCE_KIND = 'spice-simulation-evidence';
export const DEFAULT_SOLVER_TIMEOUT_MS = 30_000;

export const SIMULATION_CODES = {
  NETLIST_REQUIRED: 'SIMULATION_NETLIST_REQUIRED',
  NETLIST_EMPTY: 'SIMULATION_NETLIST_EMPTY',
  SOLVER_MISSING: 'SIMULATION_SOLVER_MISSING',
  SOLVER_TIMEOUT: 'SIMULATION_SOLVER_TIMEOUT',
  SOLVER_FAILED: 'SIMULATION_SOLVER_FAILED',
  NO_ANALYSIS: 'SIMULATION_NO_ANALYSIS',
  NO_RESULTS: 'SIMULATION_NO_RESULTS',
  EVIDENCE_MISSING: 'SIM_EVIDENCE_MISSING',
  EVIDENCE_FABRICATED: 'SIM_EVIDENCE_FABRICATED',
  EVIDENCE_NOT_RUN: 'SIM_EVIDENCE_NOT_RUN',
  NETLIST_DIGEST_MISMATCH: 'SIM_NETLIST_DIGEST_MISMATCH',
  SOLVER_UNIDENTIFIED: 'SIM_SOLVER_UNIDENTIFIED',
  OUTPUT_EMPTY: 'SIM_OUTPUT_EMPTY',
  OUTPUT_DIGEST_MISSING: 'SIM_OUTPUT_DIGEST_MISSING',
};

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 找求解器。纯函数式注入（`env`/`exists`）以便测试，不去猜"大概装在哪就当作装好了"。
 * @returns {{path: string|null, source: 'env'|'path'|'not-found'|'env-missing', searched: string[]}}
 */
export function discoverSolver({ env = process.env, exists = existsSync } = {}) {
  const searched = [];
  const explicit = String(env.CIRCUITPILOT_NGSPICE || '').trim();
  if (explicit) {
    searched.push(explicit);
    if (exists(explicit)) return { path: explicit, source: 'env', searched };
    return { path: null, source: 'env-missing', searched };
  }
  const dirs = [...new Set([...(String(env.PATH || '').split(':').filter(Boolean)), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
  const names = [...SOLVER_CANDIDATES, ...(env.CIRCUITPILOT_SPICE_BIN ? [String(env.CIRCUITPILOT_SPICE_BIN)] : [])];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      searched.push(candidate);
      if (exists(candidate)) return { path: candidate, source: 'path', searched };
    }
  }
  return { path: null, source: 'not-found', searched };
}

/** 网表里声明了哪些分析（.op/.tran/.ac/.dc/.noise/.tf）—— 记录事实，不替网表编分析。 */
export function detectAnalyses(netlistText) {
  const found = [];
  for (const [flag, name] of [['.op', 'op'], ['.tran', 'tran'], ['.ac', 'ac'], ['.dc', 'dc'], ['.noise', 'noise'], ['.tf', 'tf']]) {
    if (new RegExp(`^\\s*\\${flag}\\b`, 'im').test(netlistText)) found.push(name);
  }
  return found;
}

/**
 * 解析 ngspice 输出里的工作点数值。真机实测 ngspice-46 有两种形态，必须都认：
 *   1) 批处理 `-b -o log` 的工作点**表格**（真机就是这样，只有这一种）：
 *        \tNode                                  Voltage
 *        \t----                                 -------
 *        \tcc1                              2.500000e+00
 *   2) 交互/`.print` 形态的 `v(node) = 3.301e+00`
 * 第一版只认第 2 种，于是在真实求解器上拿到了"ran:true 但一个数值都没有"——
 * 这种"跑过了但读不出结论"最容易被当成通过。
 */
export function parseOperatingPoint(text) {
  const values = {};
  const lines = String(text || '').split('\n');
  const assign = (name, raw) => {
    const value = Number(raw);
    if (!name || !Number.isFinite(value)) return;
    values[String(name).trim().toLowerCase()] = value;
  };
  // 形态 2：v(node) = value
  const pattern = /^\s*v\s*\(\s*([^)]+?)\s*\)\s*=\s*(-?[\d.]+(?:e[+-]?\d+)?)/gim;
  let match;
  while ((match = pattern.exec(String(text || '')))) assign(match[1], match[2]);
  // 形态 1：Node/Voltage 表（遇到非两列的行即结束，例如后面的 Source/Resistor 分区）
  let inTable = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, ' ').trim();
    if (/^node\b/i.test(line) && /voltage/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line || /^[-\s]+$/.test(line)) continue; // 分隔行是 `----   -------`（带空格），只判全横线会把它当成表格结束
    const row = /^(\S+)\s+(-?[\d.]+(?:e[+-]?\d+)?)$/i.exec(line);
    if (!row) { inTable = false; continue; }
    assign(row[1], row[2]);
  }
  return values;
}

/** 求解器输出的报错行（ngspice 用 `Error:` / `Warning:` 前缀）。 */
export function parseSolverDiagnostics(text) {
  const errors = []; const warnings = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (/^error/i.test(trimmed)) errors.push(trimmed.slice(0, 200));
    else if (/^warning/i.test(trimmed)) warnings.push(trimmed.slice(0, 200));
  }
  return { errors, warnings };
}

function execute(command, args, { cwd, timeoutMs, input } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const budget = Math.max(1, Number(timeoutMs) || DEFAULT_SOLVER_TIMEOUT_MS);
    let child;
    try {
      // detached: 让求解器自成进程组。真机上求解器常会再派生子进程（ngspice 会拉起自己的 shell），
      // 只 kill 直接子进程的话，孙进程仍抱着管道 → 'close' 事件被拖到孙进程退出，
      // 「超时」会晚来好几秒（本文件的测试就抓到了这个：设 400ms 超时实测 10.4s）。
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ spawnError: error, stdout: '', stderr: '', durationMs: Date.now() - startedAt, timedOut: false });
      return;
    }
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ } }
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* 释放管道，避免孙进程继续占着 */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, budget);
    const settle = (payload) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ...payload, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => settle({ spawnError: error }));
    // 用 'exit' 结算（进程真的没了），再留一点点时间收尾输出；只等 'close' 会被孙进程拖住。
    child.on('exit', (code, signal) => { setTimeout(() => settle({ code, signal }), 50); });
    child.on('close', (code, signal) => settle({ code, signal }));
    // 求解器（或测试桩）可能不读 stdin 就退出，此时写入会异步触发 EPIPE。
    // 不监听 'error' 会变成 Node 的 uncaughtException，让整条测试进程崩掉；
    // 这不是"求解器结果"，而是"输入管道提前关闭"，交给 exit/close 结算即可。
    child.stdin?.on('error', () => { /* EPIPE：子进程已退出，不读输入 */ });
    try { child.stdin.end(input === undefined ? '' : input); } catch { /* 求解器可能不读 stdin */ }
  });
}

function failure(code, message, extra = {}) {
  return {
    ok: false, ran: false, code, message,
    evidence: null,
    findings: [{ code, message, severity: 'blocking', field: 'simulation' }],
    ...extra,
  };
}

async function solverVersion(path, run, timeoutMs) {
  // 版本探测必须用**比主运行更短**的预算：真机上求解器卡住时，我们不能先用 10s 探版本、
  // 再花掉主预算——那会让"超时"这个结论来得莫名其妙地晚（测试里就抓到过一次 10s）。
  const budget = Math.max(200, Math.min(5_000, Number(timeoutMs) || 5_000));
  const result = await run(path, ['--version'], { timeoutMs: budget });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.timedOut) return { version: null, reason: `version 命令 ${budget}ms 未返回` };
  if (result.spawnError) return { version: null, reason: `version 命令无法启动：${result.spawnError.message}` };
  if (!text) return { version: null, reason: 'version 命令无输出' };
  // ngspice --version 的第一行是 `******` 横幅（真机实测），取它是把横幅当版本号。
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const banner = lines.find((line) => /ngspice|spice|xyce/i.test(line)) || lines[0];
  return { version: banner.slice(0, 120), reason: null };
}

/**
 * 真跑一次仿真并产出可校验的证据。
 * @param {{netlistText: string, solverPath?: string, timeoutMs?: number, workDir?: string, keepWorkDir?: boolean, run?: Function, env?: object, now?: () => number}} options
 */
export async function runSimulation({
  netlistText, solverPath, timeoutMs = DEFAULT_SOLVER_TIMEOUT_MS, workDir,
  keepWorkDir = false, run = execute, env = process.env, now = Date.now,
} = {}) {
  if (typeof netlistText !== 'string' || !netlistText.trim()) return failure(SIMULATION_CODES.NETLIST_REQUIRED, '缺少 SPICE 网表文本，无法仿真');
  const solver = solverPath ? { path: solverPath, source: 'explicit', searched: [solverPath] } : discoverSolver({ env });
  if (!solver.path) {
    return failure(SIMULATION_CODES.SOLVER_MISSING, `本机没有可用的 SPICE 求解器（尝试过 ${solver.searched.length} 个路径，如 ${solver.searched.slice(0, 3).join(' / ')}）。仿真结论必须由真实求解器产出，这里不会返回伪造结果。`, { searched: solver.searched.slice(0, 24) });
  }
  let dir = workDir;
  let cleanup = false;
  if (!dir) { dir = mkdtempSync(join(tmpdir(), 'circuitpilot-sim-')); cleanup = true; }
  const netlistPath = join(dir, 'circuit.cir');
  const logPath = join(dir, 'solver.log');
  const analyses = detectAnalyses(netlistText);
  const findings = [];
  if (!analyses.length) findings.push({ code: SIMULATION_CODES.NO_ANALYSIS, message: '网表里没有任何分析指令（.op/.tran/.ac/.dc），求解器不会产出结果', severity: 'warning', field: 'netlistText' });
  try {
    writeFileSync(netlistPath, netlistText, 'utf8');
    const version = await solverVersion(solver.path, run, timeoutMs);
    const invoked = await run(solver.path, ['-b', '-o', logPath, netlistPath], { cwd: dir, timeoutMs });
    if (invoked.timedOut) return failure(SIMULATION_CODES.SOLVER_TIMEOUT, `求解器 ${timeoutMs}ms 未结束，已 SIGKILL 终止`, { durationMs: invoked.durationMs });
    if (invoked.spawnError) return failure(SIMULATION_CODES.SOLVER_FAILED, `求解器无法启动：${invoked.spawnError.message}`, { durationMs: invoked.durationMs });
    if (invoked.code !== 0) return failure(SIMULATION_CODES.SOLVER_FAILED, `求解器退出码 ${invoked.code}（signal=${invoked.signal ?? 'none'}）：${String(invoked.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, { durationMs: invoked.durationMs });
    let logText = '';
    try { logText = readFileSync(logPath, 'utf8'); } catch { logText = ''; }
    const output = `${logText}\n${invoked.stdout || ''}`.trim();
    if (!output) return failure(SIMULATION_CODES.OUTPUT_EMPTY, '求解器正常退出但没有任何输出，无法作为验收证据', { durationMs: invoked.durationMs });
    const operatingPoint = parseOperatingPoint(output);
    const diagnostics = parseSolverDiagnostics(output);
    if (diagnostics.errors.length) findings.push({ code: SIMULATION_CODES.SOLVER_FAILED, message: `求解器输出里有 ${diagnostics.errors.length} 条错误：${diagnostics.errors.slice(0, 3).join(' | ').slice(0, 300)}`, severity: 'blocking', field: 'solverOutput' });
    if (!Object.keys(operatingPoint).length) findings.push({ code: SIMULATION_CODES.NO_RESULTS, message: '没有解析到任何工作点数值（v(node) = …）', severity: 'warning', field: 'solverOutput' });
    const evidence = {
      schemaVersion: 1,
      kind: SIMULATION_EVIDENCE_KIND,
      source: 'solver-run',
      ran: true,
      generatedAt: new Date(now()).toISOString(),
      solver: { path: solver.path, source: solver.source, version: version.version, versionUnavailableReason: version.reason },
      netlist: { bytes: Buffer.byteLength(netlistText, 'utf8'), sha256: sha256Text(netlistText), analyses },
      run: { command: [solver.path, '-b', '-o', '<log>', '<netlist>'], exitCode: invoked.code, signal: invoked.signal ?? null, durationMs: invoked.durationMs, timeoutMs },
      output: { bytes: Buffer.byteLength(output, 'utf8'), sha256: sha256Text(output), head: output.slice(0, 400) },
      operatingPoint,
      diagnostics,
      findings,
    };
    evidence.evidenceHash = sha256Text(JSON.stringify({ netlist: evidence.netlist, solver: evidence.solver, output: evidence.output, operatingPoint: evidence.operatingPoint, run: evidence.run }));
    return { ok: findings.every((f) => f.severity !== 'blocking'), ran: true, code: null, message: null, evidence, findings, workDir: keepWorkDir ? dir : null };
  } finally {
    if (cleanup && !keepWorkDir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不该掩盖主流程结果 */ } }
  }
}

/**
 * 校验一份仿真证据能不能用于门禁。**这是"编造证据"唯一的结构性出口检查**：
 * fixture/manual 来源的证据，无论哈希多整齐，都不可能在生产门禁上通过。
 */
export function verifySimulationEvidence(evidence, { netlistText, allowFixture = false } = {}) {
  const findings = [];
  // demo 模式把"证据来源/结构"类问题整体降级为警告——它本来就是给演示用的；
  // 但"这份证据绑定的不是当前网表"永远阻断：demo 可以不自证真实，但不能张冠李戴。
  const severityFor = (code) => (allowFixture && code !== SIMULATION_CODES.NETLIST_DIGEST_MISMATCH ? 'warning' : 'blocking');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, findings: [{ code: SIMULATION_CODES.EVIDENCE_MISSING, message: '没有仿真证据', severity: 'blocking', field: 'simulationEvidence' }] };
  }
  if (evidence.source !== 'solver-run') {
    const code = String(evidence.source || '').toLowerCase() === 'fixture' ? SIMULATION_CODES.EVIDENCE_FABRICATED : SIMULATION_CODES.EVIDENCE_FABRICATED;
    findings.push({
      code, severity: severityFor(code), field: 'simulationEvidence',
      message: allowFixture
        ? `这是样板（${evidence.source || 'unknown'}）数据，不是求解器产出：只能在 demo 模式下展示，不能当作验收结论`
        : `证据来源是 ${evidence.source || '未知'} 而不是真实求解器运行（solver-run）——哈希再整齐也不能证明跑过仿真`,
    });
  }
  if (evidence.ran !== true) findings.push({ code: SIMULATION_CODES.EVIDENCE_NOT_RUN, severity: severityFor(SIMULATION_CODES.EVIDENCE_NOT_RUN), message: '证据标记为未实际运行', field: 'simulationEvidence' });
  if (!evidence.solver?.path) findings.push({ code: SIMULATION_CODES.SOLVER_UNIDENTIFIED, severity: severityFor(SIMULATION_CODES.SOLVER_UNIDENTIFIED), message: '证据没有记录求解器路径', field: 'simulationEvidence.solver' });
  if (!evidence.output?.sha256) findings.push({ code: SIMULATION_CODES.OUTPUT_DIGEST_MISSING, severity: severityFor(SIMULATION_CODES.OUTPUT_DIGEST_MISSING), message: '证据没有记录产物哈希', field: 'simulationEvidence.output' });
  if (typeof netlistText === 'string' && netlistText.trim()) {
    const digest = sha256Text(netlistText);
    if (evidence.netlist?.sha256 !== digest) {
      findings.push({
        code: SIMULATION_CODES.NETLIST_DIGEST_MISMATCH, severity: 'blocking', field: 'simulationEvidence.netlist',
        message: `证据绑定的网表 sha256 ${String(evidence.netlist?.sha256 || '(空)').slice(0, 12)}… ≠ 当前网表 ${digest.slice(0, 12)}…：这份仿真结论不是针对当前原理图跑的`,
      });
    }
  }
  if (!evidence.output?.bytes) findings.push({ code: SIMULATION_CODES.OUTPUT_EMPTY, severity: severityFor(SIMULATION_CODES.OUTPUT_EMPTY), message: '证据里的求解器输出为空', field: 'simulationEvidence.output' });
  return { ok: findings.every((f) => f.severity !== 'blocking'), findings };
}

/** 工作点数值是否落在期望区间（例：{'3v3': [3.1, 3.5]}）。仿真"通过"必须落到具体数值上。 */
export function checkOperatingPoint(operatingPoint, expectations = {}) {
  const findings = [];
  for (const [node, range] of Object.entries(expectations)) {
    const key = String(node).toLowerCase();
    const value = operatingPoint?.[key];
    if (!Number.isFinite(value)) {
      findings.push({ code: SIMULATION_CODES.NO_RESULTS, message: `仿真结果里没有节点 ${node} 的数值`, severity: 'blocking', field: `operatingPoint.${key}` });
      continue;
    }
    const [min, max] = range;
    if (value < min || value > max) findings.push({ code: 'SIM_RAIL_OUT_OF_RANGE', message: `节点 ${node} 实测 ${value} 不在 [${min}, ${max}]`, severity: 'blocking', field: `operatingPoint.${key}` });
  }
  return { ok: findings.length === 0, findings };
}
