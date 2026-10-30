#!/usr/bin/env node
// H4：长期运行内存采样（可复现脚本）。
//
// 用途：给"24h 内存稳定"验收提供可执行手段，而不是口头承诺。
//   - 短窗冒烟（默认 30s）：验证采样、读写流量、RSS 输出与报告链路都真实工作；
//   - 真实验收：--hours 24（或 --duration-seconds 86400），按间隔采样 child RSS + health，
//     报告首/末采样、峰值与增长率；只有进程挂掉/health 失败才 exit 1，内存增长超阈值记 WARN（不伪造稳定结论）。
//   - 边界写进报告：短窗冒烟不等于 24h 稳定；GC/页缓存噪声需要更长窗口才能看出趋势。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return fallback;
  const raw = args[index].includes('=') ? args[index].split('=')[1] : args[index + 1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const durationSeconds = args.includes('--hours') || args.some((arg) => arg.startsWith('--hours='))
  ? Math.round(argValue('hours', 24) * 3600)
  : argValue('duration-seconds', 30);
const intervalSeconds = argValue('interval-seconds', durationSeconds <= 120 ? 5 : 60);
const outDir = path.join(root, 'artifacts', 'h4-longrun');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

function rssBytesOf(pid) {
  try {
    const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kb = Number.parseInt(String(ps.stdout || '').trim(), 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

const startedAt = new Date().toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-h4-longrun-'));
const stateDir = path.join(tmp, 'state');
const automationDir = path.join(tmp, 'automation');
const evidenceDir = path.join(tmp, 'evidence');
for (const dir of [stateDir, automationDir, evidenceDir]) fs.mkdirSync(dir, { recursive: true });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const token = `h4-smoke-${Date.now().toString(36)}`;
const child = spawn(process.execPath, [path.join(root, 'runtime', 'server.mjs')], {
  cwd: root,
  env: { ...process.env, CIRCUITPILOT_RUNTIME_PORT: String(port), CIRCUITPILOT_RUNTIME_TOKEN: token, CIRCUITPILOT_STATE_DIR: stateDir, CIRCUITPILOT_AUTOMATION_DIR: automationDir, CIRCUITPILOT_EVIDENCE_DIR: evidenceDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += chunk; });
child.stderr.on('data', (chunk) => { childOutput += chunk; });

const samples = [];
const requestCounts = { health: 0, approvals: 0, diagnostics: 0, timeline: 0 };
const errors = [];
const requestJson = async (pathname) => {
  const response = await fetch(base + pathname, { headers: { 'x-circuitpilot-token': token } });
  if (!response.ok) throw new Error(`${pathname} → HTTP ${response.status}`);
  return response.json();
};
async function waitHealthy() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { await requestJson('/api/health'); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
}

let healthy = false;
try {
  healthy = await waitHealthy();
  if (!healthy) throw new Error(`runtime 未在 20s 内就绪：${childOutput.slice(-400)}`);
  const start = Date.now();
  while (Date.now() - start < durationSeconds * 1000) {
    const rss = rssBytesOf(child.pid);
    const elapsed = Math.round((Date.now() - start) / 1000);
    samples.push({ elapsedSeconds: elapsed, rssBytes: rss, healthOk: null });
    try {
      await requestJson('/api/health'); requestCounts.health += 1;
      await requestJson('/api/automation/approvals'); requestCounts.approvals += 1;
      await requestJson('/api/diagnostics'); requestCounts.diagnostics += 1;
      await requestJson('/api/timeline?limit=50'); requestCounts.timeline += 1;
      samples.at(-1).healthOk = true;
    } catch (error) {
      samples.at(-1).healthOk = false;
      errors.push({ elapsedSeconds: elapsed, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(intervalSeconds * 1000, durationSeconds * 1000 - (Date.now() - start)))));
  }
} finally {
  child.kill('SIGTERM');
}
const finishedAt = new Date().toISOString();
const rssSamples = samples.map((sample) => sample.rssBytes).filter((value) => Number.isFinite(value));
const firstRss = rssSamples[0] ?? null;
const lastRss = rssSamples.at(-1) ?? null;
const peakRss = rssSamples.length ? Math.max(...rssSamples) : null;
const growthBytes = firstRss !== null && lastRss !== null ? lastRss - firstRss : null;
const growthPercent = firstRss ? (growthBytes / firstRss) * 100 : null;
const warnings = [];
if (growthBytes !== null && growthBytes > 64 * 1024 * 1024) warnings.push(`RSS 增长 ${(growthBytes / 1024 / 1024).toFixed(1)}MB 超过 64MB：${durationSeconds >= 3600 ? '长窗增长值得排查' : '短窗噪声也可能导致，需更长窗口复核'}`);
if (errors.length) warnings.push(`采样期间出现 ${errors.length} 次请求失败（见 errors）`);
const report = {
  ok: healthy && errors.length === 0 && samples.length > 0,
  mode: durationSeconds >= 3600 ? 'long-run' : 'smoke',
  startedAt, finishedAt,
  durationSeconds, intervalSeconds,
  port,
  samples: samples.map((sample) => ({ ...sample, rssMB: sample.rssBytes === null ? null : Number((sample.rssBytes / 1024 / 1024).toFixed(1)) })),
  requestCounts,
  summary: {
    samples: samples.length,
    firstRssMB: firstRss === null ? null : Number((firstRss / 1024 / 1024).toFixed(1)),
    lastRssMB: lastRss === null ? null : Number((lastRss / 1024 / 1024).toFixed(1)),
    peakRssMB: peakRss === null ? null : Number((peakRss / 1024 / 1024).toFixed(1)),
    growthMB: growthBytes === null ? null : Number((growthBytes / 1024 / 1024).toFixed(1)),
    growthPercent: growthPercent === null ? null : Number(growthPercent.toFixed(1)),
  },
  errors,
  warnings,
  boundary: durationSeconds >= 3600
    ? '长窗采样；24h 结论仍要求不间断运行 24h（中途机器休眠/网络异常会导致采样断点，报告会显示）'
    : '短窗冒烟 ≠ 24h 稳定验证：只证明采样/流量/health/报告链路真实可用；24h 稳定请用 --hours 24 跑完整窗口',
  childOutputTail: childOutput.slice(-600),
};
fs.mkdirSync(outDir, { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const jsonPath = path.join(outDir, `longrun-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
const mdPath = path.join(outDir, `longrun-${stamp}.md`);
const lines = [
  '# H4 长期运行内存采样报告',
  '',
  `- 模式：**${report.mode}**（${durationSeconds}s，间隔 ${intervalSeconds}s）`,
  `- 采样：${report.summary.samples} 次 · RSS 首 ${report.summary.firstRssMB}MB → 末 ${report.summary.lastRssMB}MB · 峰值 ${report.summary.peakRssMB}MB · 增长 ${report.summary.growthMB}MB（${report.summary.growthPercent}%）`,
  `- 流量：${Object.entries(requestCounts).map(([key, value]) => `${key} ${value}`).join(' · ')}`,
  `- 边界：${report.boundary}`,
  '',
  warnings.length ? `## WARN\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : '## 结果\n- 无错误、无超过阈值的 RSS 增长警告',
  '',
  '| 秒 | RSS MB | health |',
  '| --- | --- | --- |',
  ...samples.map((sample) => `| ${sample.elapsedSeconds} | ${sample.rssMB} | ${sample.healthOk === null ? '—' : sample.healthOk ? 'ok' : 'fail'} |`),
  '',
].join('\n');
fs.writeFileSync(mdPath, lines);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[H4] ${report.ok ? 'PASS' : 'FAIL'} · ${report.mode} · ${durationSeconds}s · RSS ${report.summary.firstRssMB}→${report.summary.lastRssMB}MB · 峰值 ${report.summary.peakRssMB}MB · 请求 ${Object.values(requestCounts).reduce((sum, value) => sum + value, 0)} 次`);
console.log(`[H4] 报告：${path.relative(root, mdPath)}`);
if (!report.ok) process.exit(1);
