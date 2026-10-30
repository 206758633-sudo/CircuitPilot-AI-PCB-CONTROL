#!/usr/bin/env node
// H3：打包/签名/sidecar 端到端冒烟（不生成完整 .app，但把"打包产物可启动"验证到能验证的最深处）。
//
// 验证链：
//   1. 版本一致性：package.json = src-tauri/tauri.conf.json = runtime/version.mjs（release 前最容易漂移的点）；
//   2. sidecar 真实存在：跑 stage-runtime-sidecar.mjs（Tauri externalBin 的唯一 Node 来源），
//      执行 staged 的 node 二进制 --version，确认它真能跑且与当前 Node 一致；
//   3. 用 staged sidecar 启动真实 runtime（隔离的临时状态目录 + 随机端口），请求 /api/health：
//      service/version 正确，随后关闭进程。
//
// 边界（不冒充）：
//   - 不做 codesign/notarize 校验、不生成 .app/.dmg（那需要证书与网络，属发布流程）；
//   - 若本机没有 Rust/Cargo（无法确定 target triple）→ 输出 SKIPPED + 原因，exit 0，不标 PASS。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outDir = path.join(root, 'artifacts', 'h3-package');
const jsonOut = path.join(outDir, `package-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function finish(report, code = 0) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`[H3] 报告：${path.relative(root, jsonOut)}`);
  process.exit(code);
}

function fail(message, report) {
  console.error(`[H3] FAIL：${message}`);
  finish({ ...report, ok: false, error: message }, 1);
}

function readTriple() {
  try {
    const output = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
    if (output.status !== 0) return null;
    const match = /^host:\s*(\S+)$/m.exec(output.stdout || '');
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const startedAt = new Date().toISOString();
const report = { ok: false, startedAt, checks: [], version: null };

// 1) 版本一致性
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const runtimeVersionSource = fs.readFileSync(path.join(root, 'runtime', 'version.mjs'), 'utf8');
const runtimeVersion = /RUNTIME_VERSION\s*=\s*'([^']+)'/.exec(runtimeVersionSource)?.[1] ?? null;
report.version = { packageJson: pkg.version, tauri: tauri.version, runtime: runtimeVersion };
const versions = [report.version.packageJson, report.version.tauri, report.version.runtime];
report.checks.push({ id: 'version-consistency', ok: versions.every((value) => value && value === versions[0]), detail: report.version });
if (!report.checks.at(-1).ok) fail(`版本不一致：package.json=${pkg.version} tauri=${tauri.version} runtime=${runtimeVersion}`, report);

// 2) sidecar 真实二进制
const triple = readTriple();
if (!triple) {
  console.log('[H3] SKIPPED：本机没有可用的 Rust/Cargo（无法确定 target triple），打包冒烟需要 Rust 工具链');
  finish({ ...report, ok: true, skipped: true, reason: 'rustc 不可用，无法确定 target triple；打包冒烟未执行（不冒充 PASS）' });
}
const stage = spawnSync(process.execPath, [path.join(scriptDir, 'stage-runtime-sidecar.mjs')], { cwd: root, encoding: 'utf8' });
if (stage.status !== 0) fail(`sidecar 暂存失败：${(stage.stderr || stage.stdout || '').slice(-500)}`, report);
const stagedBinary = path.join(root, 'src-tauri', 'binaries', `node-${triple}`);
if (!fs.existsSync(stagedBinary)) fail(`sidecar 不存在：${path.relative(root, stagedBinary)}`, report);
const stagedVersion = spawnSync(stagedBinary, ['--version'], { encoding: 'utf8' });
const stagedVersionText = (stagedVersion.stdout || '').trim().replace(/^v/, '');
report.checks.push({
  id: 'sidecar-binary-runs',
  ok: stagedVersion.status === 0 && stagedVersionText === process.version.replace(/^v/, ''),
  detail: { path: path.relative(root, stagedBinary), stagedVersion: stagedVersionText, hostVersion: process.version.replace(/^v/, ''), exitCode: stagedVersion.status },
});
if (!report.checks.at(-1).ok) fail(`staged sidecar 无法运行或版本不一致：${JSON.stringify(report.checks.at(-1).detail)}`, report);

// 3) 用 sidecar 启动真实 runtime + health
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-h3-package-'));
const stateDir = path.join(tmp, 'state');
const automationDir = path.join(tmp, 'automation');
const evidenceDir = path.join(tmp, 'evidence');
for (const dir of [stateDir, automationDir, evidenceDir]) fs.mkdirSync(dir, { recursive: true });
const port = 43000 + Math.floor(Math.random() * 2000);
const token = `h3-smoke-${Date.now().toString(36)}`;
const child = spawn(stagedBinary, [path.join(root, 'runtime', 'server.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    CIRCUITPILOT_RUNTIME_PORT: String(port),
    CIRCUITPILOT_RUNTIME_TOKEN: token,
    CIRCUITPILOT_STATE_DIR: stateDir,
    CIRCUITPILOT_AUTOMATION_DIR: automationDir,
    CIRCUITPILOT_EVIDENCE_DIR: evidenceDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += chunk; });
child.stderr.on('data', (chunk) => { childOutput += chunk; });
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 20_000;
let health = null;
try {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  child.kill('SIGTERM');
}
report.checks.push({
  id: 'sidecar-runtime-health',
  ok: Boolean(health) && health.service === 'circuitpilot-runtime' && health.version === runtimeVersion,
  detail: { port, health: health ? { service: health.service, version: health.version, host: health.host } : null, childExitCode: child.exitCode, outputTail: childOutput.slice(-400) },
});
if (!report.checks.at(-1).ok) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fail(`用 staged sidecar 启动 runtime 后 health 不合格：${JSON.stringify(report.checks.at(-1).detail)}`, report);
}
fs.rmSync(tmp, { recursive: true, force: true });
report.ok = true;
report.finishedAt = new Date().toISOString();
console.log(`[H3] PASS：版本一致（${runtimeVersion}）、sidecar 可执行、用 sidecar 启动 runtime 后 health 正常（${base}/api/health）`);
finish(report);
