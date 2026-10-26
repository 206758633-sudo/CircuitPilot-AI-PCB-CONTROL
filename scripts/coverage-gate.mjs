#!/usr/bin/env node
// F6：runtime 覆盖率地板（ratchet）。
//
// 只统计"新增/关键"模块，不是全仓一刀切：
//   - runtime 还有大量真机/HTTP 路径天然离线不可达，用单一全局阈值只会要么虚低要么假高；
//   - 这些模块是最近几个阶段（C3/C5/C6/E10/E11）真正承载业务逻辑的，阈值 = 实测值向下取整，
//     是"不许回退"的地板，不是粉饰性的目标值；提高覆盖率后请同步上调。
//
// 数据来自 Node 内置覆盖率（--experimental-test-coverage），跑完整 runtime 测试集，解析覆盖率表格。
// 任一模块缺失/低于门槛 → exit 1，并落一份报告到 artifacts/f6-coverage/。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outDir = path.join(root, 'artifacts', 'f6-coverage');

/** 每个模块的地板（2026-10-20 实测值向下取整；只许升不许降）。 */
const THRESHOLDS = [
  { file: 'runtime/automation/orchestration.mjs', lines: 95, branches: 84, funcs: 100 },
  { file: 'runtime/automation/audit-bundle.mjs', lines: 90, branches: 68, funcs: 90 },
  { file: 'runtime/timeline.mjs', lines: 88, branches: 50, funcs: 100 },
  { file: 'runtime/project-state.mjs', lines: 87, branches: 68, funcs: 90 },
  { file: 'runtime/evidence-index.mjs', lines: 92, branches: 71, funcs: 91 },
];

const node = process.execPath;
const args = ['--test', '--experimental-test-coverage', '--test-timeout=120000'];
for (const target of THRESHOLDS) args.push(`--test-coverage-include=${target.file}`);
args.push('runtime/**/*.test.mjs');

process.stdout.write(`[F6] 跑完整 runtime 测试集并统计 ${THRESHOLDS.length} 个模块覆盖率…\n`);
const started = Date.now();
const result = spawnSync(node, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const durationMs = Date.now() - started;

if (result.status !== 0) {
  process.stdout.write(output.split('\n').slice(-40).join('\n'));
  console.error(`[F6] runtime 测试本身失败（exit ${result.status}），覆盖率无从判定`);
  process.exit(1);
}

/** 解析 node 覆盖率表格行：|   audit-bundle.mjs  |  92.78 |    70.59 |   92.86 | ... | */
function parseCoverage(text) {
  const rows = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^ℹ\s*/, '');
    const match = line.match(/^\s*([\w./-]+\.mjs)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (match) rows.set(match[1], { lines: Number(match[2]), branches: Number(match[3]), funcs: Number(match[4]) });
  }
  return rows;
}

const coverage = parseCoverage(output);
const checks = [];
let failed = false;
for (const target of THRESHOLDS) {
  const name = path.basename(target.file);
  const actual = coverage.get(name);
  const row = { file: target.file, thresholds: { lines: target.lines, branches: target.branches, funcs: target.funcs }, actual: actual ?? null, ok: false, problems: [] };
  if (!actual) {
    row.problems.push('覆盖率报告里没有该文件（可能没被任何测试加载）');
  } else {
    for (const metric of ['lines', 'branches', 'funcs']) {
      if (actual[metric] < target[metric]) row.problems.push(`${metric} ${actual[metric]}% < 地板 ${target[metric]}%`);
    }
    row.ok = row.problems.length === 0;
  }
  if (!row.ok) failed = true;
  checks.push(row);
  const actualText = actual ? `lines ${actual.lines}% / branch ${actual.branches}% / funcs ${actual.funcs}%` : '缺失';
  process.stdout.write(`  ${row.ok ? 'PASS' : 'FAIL'} ${name}：${actualText}（地板 ${target.lines}/${target.branches}/${target.funcs}）${row.problems.length ? ` — ${row.problems.join('；')}` : ''}\n`);
}

fs.mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  durationMs,
  policy: 'per-module ratchet floor（实测值向下取整，只许升不许降），不是全局目标值',
  checks,
  ok: !failed,
};
const stamp = report.generatedAt.replace(/[:.]/g, '-');
const jsonPath = path.join(outDir, `coverage-runtime-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
const mdPath = path.join(outDir, `coverage-runtime-${stamp}.md`);
fs.writeFileSync(mdPath, [
  '# F6 runtime 覆盖率地板报告',
  '',
  `- 生成时间：${report.generatedAt}`,
  `- 耗时：${(durationMs / 1000).toFixed(1)}s`,
  `- 策略：${report.policy}`,
  '',
  '| 模块 | 实际 lines/branch/funcs | 地板 lines/branch/funcs | 结果 |',
  '| --- | --- | --- | --- |',
  ...checks.map((row) => `| ${row.file} | ${row.actual ? `${row.actual.lines}/${row.actual.branches}/${row.actual.funcs}` : '缺失'} | ${row.thresholds.lines}/${row.thresholds.branches}/${row.thresholds.funcs} | ${row.ok ? 'PASS' : `FAIL：${row.problems.join('；')}`} |`),
  '',
  failed ? '结论：**FAIL**（覆盖率回退或模块未被加载，禁止合并）' : '结论：**PASS**（所有受控模块不低于地板）',
  '',
].join('\n'));
process.stdout.write(`[F6] 报告：${path.relative(root, mdPath)}\n`);
if (failed) {
  process.exit(1);
}
process.stdout.write('[F6] 所有受控模块不低于地板。\n');
