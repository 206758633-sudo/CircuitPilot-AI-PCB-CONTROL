#!/usr/bin/env node
/**
 * 一键链路验收（F3）。
 *
 * 设计原则（与项目 fail-closed 纪律一致）：
 * 1) 只报告真实跑出来的退出码与测试计数，不解析"看起来通过"的文本；
 * 2) 需要真机 + 用户签发写板批准的链路（R2/R6 写入、live e2e）默认标 SKIPPED，
 *    并写明原因，绝不伪装成 PASS；加 `--live` 才尝试执行（仍要求你已批写板）；
 * 3) 任何必需步骤非 0 退出，脚本整体 exit 1，并写进报告。
 *
 * 用法：
 *   node scripts/acceptance.mjs                 # 离线全量验收（typecheck/vitest/runtime/build/e2e/契约）
 *   node scripts/acceptance.mjs --skip-e2e      # 跳过浏览器 e2e（快速自检）
 *   node scripts/acceptance.mjs --live          # 额外尝试 live e2e（需真机已批准，否则如实失败）
 *   node scripts/acceptance.mjs --out <dir>     # 报告输出目录（默认 artifacts/acceptance）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const cwd = process.cwd();
const outDir = resolve(cwd, argValue('out', 'artifacts/acceptance'));
const runLive = hasFlag('live');
const skipE2e = hasFlag('skip-e2e');

const NODE = process.execPath;
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const startedAt = new Date().toISOString();
const steps = [];

function runStep(id, title, command, commandArgs, options = {}) {
  const required = options.required !== false;
  const note = options.note ?? '';
  const begin = Date.now();
  process.stdout.write(`\n▶ ${id} ${title}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: options.timeoutMs ?? 15 * 60_000,
  });
  const durationMs = Date.now() - begin;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}\n${stderr}`;
  const counts = extractCounts(id, output);
  const step = {
    id,
    title,
    required,
    note,
    command: [command, ...commandArgs].join(' '),
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    counts,
    ok: required ? result.status === 0 : true,
    skipped: false,
  };
  steps.push(step);
  const summary = counts.length ? `（${counts.join('；')}）` : '';
  process.stdout.write(`  exit ${step.exitCode} · ${(durationMs / 1000).toFixed(1)}s${summary}\n`);
  return step;
}

function markSkipped(id, title, reason) {
  steps.push({ id, title, required: false, note: reason, command: '', exitCode: null, durationMs: 0, counts: [], ok: true, skipped: true });
  process.stdout.write(`\n⏭  ${id} ${title} — SKIPPED：${reason}\n`);
}

/**
 * 只提取各测试器自己输出的计数；拿不到就留空（报告里体现"无计数"，不猜）。
 */
function extractCounts(id, output) {
  const counts = [];
  if (id.includes('vitest')) {
    const match = output.match(/Tests\s+(\d+)\s+passed(?:\s*\((\d+)\))?/);
    if (match) counts.push(`vitest ${match[1]}/${match[2] ?? match[1]}`);
    const failed = output.match(/(\d+)\s+failed/);
    if (failed) counts.push(`${failed[1]} failed`);
  } else if (id.includes('runtime') || id.includes('contract')) {
    const pass = output.match(/ℹ pass (\d+)/);
    const fail = output.match(/ℹ fail (\d+)/);
    if (pass) counts.push(`node:test pass ${pass[1]}${fail ? ` / fail ${fail[1]}` : ''}`);
  } else if (id === 'coverage') {
    if (output.includes('所有受控模块不低于地板')) counts.push('coverage 5 模块达标');
    const failMatch = output.match(/(\d+) 个模块?.*FAIL|FAIL (\S+)/);
    if (failMatch) counts.push(`coverage FAIL ${failMatch[0]}`);
  } else if (id === 'long-run-smoke') {
    const match = output.match(/\[H4\] (PASS|FAIL)[^\n]*/);
    if (match) counts.push(`H4 ${match[1]}${match[1] === 'PASS' ? '（短窗，非 24h）' : ''}`);
  } else if (id === 'package-smoke') {
    if (output.includes('SKIPPED')) counts.push('SKIPPED（rustc 不可用，未冒充 PASS）');
    else if (output.includes('[H3] PASS')) counts.push('sidecar health PASS');
  } else if (id === 'f7-ui-render') {
    const match = output.match(/\[F7\] (PASS|FAIL)[^\n]*/);
    if (match) counts.push(`F7 ${match[1] === 'PASS' ? 'PASS（UI 渲染，非真机 EDA）' : 'FAIL'}`);
  } else if (id.includes('e2e') || id === 'c6-project-switch') {
    const passed = output.match(/(\d+)\s+passed/);
    const failed = output.match(/(\d+)\s+failed/);
    const skipped = output.match(/(\d+)\s+skipped/);
    if (passed) counts.push(`e2e passed ${passed[1]}${failed ? ` / failed ${failed[1]}` : ''}${skipped ? ` / skipped ${skipped[1]}` : ''}`);
  }
  return counts;
}

process.stdout.write(`CircuitPilot 一键链路验收\nworkdir: ${cwd}\nstartedAt: ${startedAt}\n`);

runStep('typecheck', 'TypeScript 类型检查', npmCmd, ['run', 'typecheck']);
runStep('vitest', '前端单测（vitest）', NPX, ['vitest', 'run']);
runStep('runtime', 'Runtime 测试（node:test）', npmCmd, ['run', 'test:runtime']);
runStep('coverage', 'F6 runtime 覆盖率地板（ratchet）', NODE, ['scripts/coverage-gate.mjs'], { timeoutMs: 10 * 60_000, note: '5 个关键模块 lines/branches/funcs 不得低于实测地板' });
runStep('build', '生产构建（tsc + vite）', npmCmd, ['run', 'build']);
runStep('contract', '路由/消费者契约', NODE, ['--test', 'runtime/__tests__/route-contract.test.mjs']);

if (skipE2e) {
  markSkipped('e2e-app', '浏览器 e2e（app.spec.ts）', '按 --skip-e2e 主动跳过');
} else {
  runStep('e2e-app', '浏览器 e2e（app.spec.ts）', NPX, ['playwright', 'test', 'e2e/app.spec.ts', '--reporter=line'], { timeoutMs: 10 * 60_000 });
  // C6 剩余：真实 Runtime（临时状态目录、4178）+ 真实界面两项目切换与数据隔离；不需要 EDA/写板批准。
  runStep('c6-project-switch', '真实运行时两项目切换（C6，真实 GUI）', NPX, ['playwright', 'test', 'e2e/c6-project-switch.spec.ts', '--reporter=line'], { timeoutMs: 5 * 60_000, note: 'spec 自起真实 Runtime（4178、全新临时状态）并种两项目；验证界面切换 + 服务端切面不串；不连接 EDA' });
  // F7 剩余：180 器件工程的真实浏览器渲染/导航基线（真实 Runtime；不含真机 EDA 读取/布局/DRC）。
  runStep('f7-ui-render', '180 器件 UI 渲染基线（F7，真实 GUI）', NPX, ['playwright', 'test', 'e2e/f7-ui-render.spec.ts', '--reporter=line'], { timeoutMs: 5 * 60_000, note: '真实 Runtime + 真实浏览器渲染 180 器件工程，落 artifacts/f7-perf 基线并做 2× 回归告警；不含真机 EDA 读取/布局/DRC 耗时' });
  runStep('a11y-audit', '全站可访问性静态审计（D9，启发式）', NODE, ['scripts/a11y-audit.mjs'], { note: '静态启发式审计，不是 WCAG 合规认证；发现违规仍 exit 0（advisory）' });
  // E4：故障注入演练（离线 fail-closed 断言 + 运行时可达时 3 次真机只读）
  runStep('fault-drill', '故障注入演练（E4）', NODE, ['scripts/fault-drill.mjs'], { timeoutMs: 5 * 60_000 });
  // H5/H6：诊断包与备份恢复演练（真实执行，产物落 artifacts/）
  runStep('backup-drill', '备份/恢复演练（H6）', NODE, ['scripts/backup-restore-drill.mjs'], { timeoutMs: 10 * 60_000 });
  runStep('package-smoke', '打包/sidecar 冒烟（H3）', NODE, ['scripts/package-smoke.mjs'], { timeoutMs: 5 * 60_000, note: '版本一致性 + staged sidecar 可执行 + sidecar 启动 runtime 后 health' });
  runStep('long-run-smoke', '长时运行内存冒烟（H4，短窗）', NODE, ['scripts/long-run-memory.mjs', '--duration-seconds', '15', '--interval-seconds', '3'], { timeoutMs: 3 * 60_000, note: '短窗只验证采样/流量/health/报告链路；24h 稳定用 npm run drill:longrun -- --hours 24，不冒充通过' });
  runStep('e2e-live-list', 'live e2e 可收集性（不执行）', NPX, ['playwright', 'test', 'e2e/placement-live.spec.ts', 'e2e/sync-verify-live.spec.ts', '--list'], { timeoutMs: 120_000 });
}

if (runLive) {
  runStep('e2e-live', '真机 live e2e（R1/R4 只读验收）', NPX, ['playwright', 'test', 'e2e/placement-live.spec.ts', 'e2e/sync-verify-live.spec.ts', '--reporter=line'], { timeoutMs: 10 * 60_000 });
} else {
  markSkipped('e2e-live', '真机 live e2e（R1/R4 只读验收）', '需要本机嘉立创EDA 打开目标板 + CDP 9222；加 --live 显式执行');
}

if (runLive) {
  runStep('live-chain', '真机只读链路矩阵（R1/R4/R5/R6，F3）', NODE, ['scripts/live-chain-report.mjs'], { timeoutMs: 5 * 60_000 });
} else {
  markSkipped('live-chain', '真机只读链路矩阵（R1/R4/R5/R6，F3）', '需要本机运行时 + 嘉立创EDA；加 --live 显式执行（只读，不写板）');
}

markSkipped('real-write', '真机写板验收（R2 落板 / R6 铺铜）', '需要用户显式签发写板批准；AI 不得自批，故本脚本不自动执行');
markSkipped('automation-matrix', '自动化配方矩阵（plan→write→finish/rollback 全链路）', '写阶段同样需要用户签发写板批准；读/校验阶段已由 runtime 测试覆盖（multilayer-http 20/20）');
markSkipped('hardware', '真机板验收（DRC/ERC/制造包）', '依赖真机 EDA 当前文档指纹；DRC/DFM/签核/导出链路已有离线测试与路由，真机验收待人工批准');

const finishedAt = new Date().toISOString();
const failed = steps.filter((step) => !step.ok);
const ok = failed.length === 0;
const report = {
  schemaVersion: 1,
  kind: 'circuitpilot-acceptance-report',
  startedAt,
  finishedAt,
  cwd,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  ok,
  totals: {
    steps: steps.length,
    ran: steps.filter((step) => !step.skipped).length,
    skipped: steps.filter((step) => step.skipped).length,
    failed: failed.length,
  },
  steps,
};

mkdirSync(outDir, { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const jsonPath = join(outDir, `acceptance-${stamp}.json`);
const mdPath = join(outDir, `acceptance-${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const md = [
  '# CircuitPilot 链路验收报告',
  '',
  `- 时间：${startedAt} → ${finishedAt}`,
  `- 结论：**${ok ? 'PASS（离线必需步骤全绿）' : `FAIL（${failed.length} 个必需步骤失败）`}**`,
  `- 步骤：共 ${steps.length}，执行 ${report.totals.ran}，跳过 ${report.totals.skipped}（跳过原因见下）`,
  `- 环境：node ${process.version} · ${process.platform} ${process.arch}`,
  '',
  '| 步骤 | 结果 | 计数 | 证据/说明 |',
  '|---|---|---|---|',
  ...steps.map((step) => `| ${step.id} ${step.title} | ${step.skipped ? 'SKIPPED' : step.exitCode === 0 ? 'PASS' : 'FAIL'} | ${step.counts.join('；') || '—'} | ${step.skipped ? step.note : step.command} |`),
  '',
  '> SKIPPED 不是 PASS：真机写板与 live 验收需要用户显式签发写板批准 + 本机 EDA 环境。',
  '',
].join('\n');
writeFileSync(mdPath, md, 'utf8');

process.stdout.write(`\n================ 验收结论 ================\n`);
for (const step of steps) {
  process.stdout.write(`${step.skipped ? 'SKIP' : step.exitCode === 0 ? 'PASS' : 'FAIL'}  ${step.id}  ${step.counts.join('；')}\n`);
}
process.stdout.write(`\n报告：${jsonPath}\n      ${mdPath}\n`);
if (!ok) {
  process.stdout.write(`\n失败步骤：${failed.map((step) => step.id).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('\n离线必需步骤全部通过（跳过的真机项不在此列）。\n');
