#!/usr/bin/env node
/**
 * 复合设计框架 CLI（零依赖）：
 *   node scripts/design-framework.mjs --eval [--dir eval/golden] [--json]
 *   node scripts/design-framework.mjs --case eval/golden/01-fixable-overlap.json [--json]
 *   node scripts/design-framework.mjs --model <model.json> [--max-iterations 4] [--json]
 *   node scripts/design-framework.mjs --status
 *
 * 退出码：0 = 通过/未被阻断；1 = blocked 或评估失败；2 = 用法/内部错误。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEvaluationReport, frameworkStatus, loadGoldenCases, runGoldenEvaluation, runDesignLoop } from '../runtime/design-framework/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GOLDEN_DIR = join(ROOT, 'eval/golden');

function parseArgs(argv) {
  const args = { mode: 'help', json: false, dir: DEFAULT_GOLDEN_DIR, file: null, maxIterations: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--eval') args.mode = 'eval';
    else if (arg === '--case') { args.mode = 'case'; args.file = argv[++index]; }
    else if (arg === '--model') { args.mode = 'model'; args.file = argv[++index]; }
    else if (arg === '--status') args.mode = 'status';
    else if (arg === '--dir') args.dir = resolve(argv[++index] ?? DEFAULT_GOLDEN_DIR);
    else if (arg === '--max-iterations') args.maxIterations = Number.parseInt(argv[++index] ?? '4', 10);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function printHelp() {
  process.stdout.write([
    '复合设计框架 CLI',
    '',
    '用法：',
    '  node scripts/design-framework.mjs --eval [--dir <金板目录>] [--json]',
    '  node scripts/design-framework.mjs --case <用例.json> [--json]',
    '  node scripts/design-framework.mjs --model <模型.json> [--max-iterations N] [--json]',
    '  node scripts/design-framework.mjs --status [--json]',
    '',
    '边界：不写 EDA、不自动签核；外部工具缺失时 fail-closed。',
  ].join('\n') + '\n');
}

function summarizeLoop(result) {
  return {
    ok: result.ok,
    status: result.status,
    iterations: result.summary.iterations,
    repairs: result.repairs.map((repair) => ({ strategy: repair.strategy, iteration: repair.iteration, riskLevel: repair.riskLevel })),
    blocking: result.summary.blocking,
    review: result.summary.review,
    ruleCoverage: result.summary.ruleCoverage,
    finalDigest: result.summary.finalDigest,
    planOperations: result.plan.operations.length,
    skipped: result.plan.skipped,
    iterationsDetail: result.iterations,
    digest: result.digest,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { printHelp(); return 0; }
  if (args.mode === 'status') {
    const status = frameworkStatus();
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (args.mode === 'eval') {
    const report = runGoldenEvaluation({ dir: args.dir, runLoop: runDesignLoop });
    process.stdout.write(args.json ? `${JSON.stringify(report.metrics, null, 2)}\n` : `${formatEvaluationReport(report)}\n`);
    return report.metrics.failed === 0 ? 0 : 1;
  }
  if (args.mode === 'case') {
    if (!args.file) throw new Error('--case 需要用例 JSON 路径');
    const caseDef = readJson(resolve(args.file));
    if (caseDef.id && caseDef.model) {
      const result = runDesignLoop(caseDef.model, { maxIterations: args.maxIterations, ...(caseDef.options ?? {}) });
      const summary = summarizeLoop(result);
      process.stdout.write(args.json ? `${JSON.stringify(summary, null, 2)}\n` : `用例 ${caseDef.id}：status=${result.status} · iterations=${result.summary.iterations} · repairs=${result.repairs.length} · blocking=${result.summary.blocking} · review=${result.summary.review}\n${JSON.stringify(summary, null, 2)}\n`);
      return result.status === 'blocked' ? 1 : 0;
    }
    // 兼容直接传 model JSON
    const result = runDesignLoop(caseDef, { maxIterations: args.maxIterations });
    process.stdout.write(args.json ? `${JSON.stringify(summarizeLoop(result), null, 2)}\n` : `${JSON.stringify(summarizeLoop(result), null, 2)}\n`);
    return result.status === 'blocked' ? 1 : 0;
  }
  if (args.mode === 'model') {
    if (!args.file) throw new Error('--model 需要模型 JSON 路径');
    const model = readJson(resolve(args.file));
    const result = runDesignLoop(model, { maxIterations: args.maxIterations });
    process.stdout.write(args.json ? `${JSON.stringify(summarizeLoop(result), null, 2)}\n` : `${JSON.stringify(summarizeLoop(result), null, 2)}\n`);
    return result.status === 'blocked' ? 1 : 0;
  }
  printHelp();
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`design-framework: ${error?.code ?? 'ERROR'}: ${error?.message ?? error}\n`);
  process.exitCode = 2;
}
