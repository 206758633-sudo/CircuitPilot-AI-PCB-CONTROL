#!/usr/bin/env node
/**
 * F7：关键只读路径耗时基线 + 回归告警。
 *
 * 原则：
 *  - 只测**只读**端点：不触发写板、不消耗一次性批准、不改工程；
 *  - 本机没有运行时 → 明确 SKIPPED（附原因），不伪造"0ms"；
 *  - 结果落 `artifacts/f7-perf/`，下一次运行自动与上一份基线对比：
 *    p95 超过上一份 2 倍且绝对值 > 50ms 记 WARN（只告警，不改代码、不阻断构建）。
 *
 * 用法：node scripts/perf-baseline.mjs [--iterations=20]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179';
const TOKEN_FILE = process.env.CIRCUITPILOT_TOKEN_FILE || '/tmp/cp_my_token.txt';
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, '').split('='); return [key, value ?? 'true']; }));
const ITERATIONS = Math.max(5, Math.min(200, Number(args.iterations) || 20));
const OUT_DIR = join(process.cwd(), 'artifacts', 'f7-perf');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const token = process.env.CIRCUITPILOT_RUNTIME_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '');
const ENDPOINTS = [
  { id: 'health', path: '/api/health', auth: false },
  { id: 'approvals', path: '/api/automation/approvals', auth: true },
  { id: 'evidence-index', path: '/api/evidence/index', auth: true },
  { id: 'trace-state', path: '/api/trace-state', auth: true },
  { id: 'diagnostics', path: '/api/diagnostics', auth: true },
  { id: 'diagnostics-bundle', path: '/api/diagnostics/bundle', auth: true },
];

const percentile = (sorted, ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];

async function measure(endpoint) {
  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    const response = await fetch(`${BASE}${endpoint.path}`, { headers: endpoint.auth ? { 'x-circuitpilot-token': token } : {} });
    if (!response.ok) throw new Error(`${endpoint.path} 返回 HTTP ${response.status}`);
    await response.json();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { id: endpoint.id, path: endpoint.path, iterations: samples.length, minMs: r2(samples[0]), p50Ms: r2(percentile(samples, 0.5)), p95Ms: r2(percentile(samples, 0.95)), maxMs: r2(samples[samples.length - 1]) };
}
const r2 = (value) => Math.round(value * 100) / 100;

mkdirSync(OUT_DIR, { recursive: true });
const report = { kind: 'perf-baseline', generatedAt: new Date().toISOString(), baseUrl: BASE, iterations: ITERATIONS, endpoints: [], regression: [], verdict: 'pass' };

const alive = await fetch(`${BASE}/api/health`).then((response) => response.ok).catch(() => false);
if (!alive) {
  report.verdict = 'skipped';
  report.reason = `本机运行时不可达：${BASE}（先启动 npm run dev:runtime 再跑基线）`;
} else if (!token) {
  report.verdict = 'skipped';
  report.reason = '缺少运行时令牌（CIRCUITPILOT_RUNTIME_TOKEN 或 /tmp/cp_my_token.txt）';
} else {
  for (const endpoint of ENDPOINTS) {
    try {
      report.endpoints.push(await measure(endpoint));
    } catch (error) {
      report.exceptions = report.exceptions || [];
      report.exceptions.push({ endpoint: endpoint.id, error: String(error?.message || error) });
      report.verdict = 'warn';
    }
  }
  // 与上一份基线对比（只比较同端点同时段；没有上一份就是首次建立基线）
  const previousFiles = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((name) => name.endsWith('.json')).sort() : [];
  const previousPath = previousFiles.length ? join(OUT_DIR, previousFiles[previousFiles.length - 1]) : null;
  if (previousPath) {
    try {
      const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
      report.baselineComparison = { previous: previousPath.split('/').pop() };
      for (const current of report.endpoints) {
        const before = (previous.endpoints || []).find((item) => item.id === current.id);
        if (!before) continue;
        const regressed = current.p95Ms > before.p95Ms * 2 && current.p95Ms > 50;
        if (regressed) {
          report.regression.push({ id: current.id, beforeP95Ms: before.p95Ms, afterP95Ms: current.p95Ms });
          report.verdict = report.verdict === 'skipped' ? 'warn' : 'warn';
        }
      }
    } catch (error) {
      report.baselineComparison = { previous: previousPath.split('/').pop(), error: String(error?.message || error) };
    }
  } else {
    report.baselineComparison = { previous: null, note: '首次运行：建立基线，无回归对比' };
  }
}

writeFileSync(join(OUT_DIR, `perf-${STAMP}.json`), JSON.stringify(report, null, 2));
const md = ['# F7 关键路径耗时基线', '', `- 时间：${report.generatedAt}`, `- 目标：${BASE}（每次 ${ITERATIONS} 次采样，只读端点）`, `- 结论：**${report.verdict.toUpperCase()}**${report.reason ? `（${report.reason}）` : ''}`, '', '| 端点 | min | p50 | p95 | max |', '|---|---|---|---|---|', ...report.endpoints.map((item) => `| ${item.id} | ${item.minMs}ms | ${item.p50Ms}ms | ${item.p95Ms}ms | ${item.maxMs}ms |`), ''];
if (report.regression.length) md.push('## 回归告警', '', ...report.regression.map((item) => `- ${item.id}：p95 ${item.beforeP95Ms}ms → ${item.afterP95Ms}ms（>2× 且 >50ms）`), '');
if (report.baselineComparison?.previous) md.push(`对比基线：${report.baselineComparison.previous}`, '');
md.push('说明：只告警不改代码；阈值 = p95 超过上一份基线 2 倍且绝对值 > 50ms。');
writeFileSync(join(OUT_DIR, `perf-${STAMP}.md`), md.join('\n'));
console.log(`perf baseline: ${report.verdict}`);
console.log(md.slice(2, 12).join('\n'));
process.exit(report.verdict === 'skipped' ? 0 : 0);
