#!/usr/bin/env node
/**
 * E4：无人值守故障注入演练（离线，真实运行时装配，非模拟路由）。
 *
 * 目标：证明"失败会自停/留证据/不假通过"，而不是"每个功能都能成功"。
 *
 * Part A —— 故障注入（in-process runtime + 注入故障的 bridge）：
 *   1. EDA 断连（EDA_OFFLINE）→ read 配方必须 failed，不得 completed；
 *   2. 桥接错误（BRIDGE_HTTP_ERROR）→ failed；
 *   3. 写配方无批准 → needs_approval 且 0 次写命令；
 *   4. 伪造/复用批准 → 409 AUTOMATION_APPROVAL_INVALID；
 *   5. 追溯存储损坏 → 读取报 STORE_*，不得返回假空状态；
 *   6. 未知配方 → 404，不执行。
 *
 * Part B —— 真机只读（可选）：运行时 4179 可达时，连跑 3 次只读配方并校验 journal 哈希链。
 *
 * 产物：artifacts/e4-drill/fault-drill-<时间>.json|md；任一 fail-closed 断言失败 exit 1。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeServer } from '../runtime/server.mjs';

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
// 固定注入运行时令牌：避免“HTTP 令牌发放被禁用/被环境变量影响”导致 401 的旁观噪声，
// 让演练专注在故障分支本身是否 fail-closed。
const DRILL_TOKEN = 'e4-fault-drill-token';
const OUT_DIR = join(process.cwd(), 'artifacts', 'e4-drill');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LIVE_BASE = process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179';
const TOKEN_FILE = process.env.CIRCUITPILOT_TOKEN_FILE || '/tmp/cp_my_token.txt';
const rows = [];
const record = (row) => { rows.push(row); return row; };

const baseBridge = (state) => ({
  port: 49620,
  selectedWindowId: 'window-drill',
  async discover() {},
  async windows() { return { selectionRequired: false, windows: [{ id: 'window-drill' }] }; },
  async execute(commandId) {
    if (commandId === 'project.current') return { ok: true, result: { uuid: 'p-drill', data: [{ uuid: 'p-drill', name: '演练板' }] } };
    if (commandId === 'document.current') return { ok: true, result: { uuid: 'd-drill' } };
    return { ok: true, result: {} };
  },
});

async function startServer({ bridge, stateDir }) {
  const automationDir = mkdtempSync(join(tmpdir(), 'cp-drill-automation-'));
  const previousState = process.env.CIRCUITPILOT_STATE_DIR;
  const previousAutomation = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_STATE_DIR = stateDir;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  const { server } = createRuntimeServer({ bridge, runtimeToken: DRILL_TOKEN });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': DRILL_TOKEN, origin: TRUSTED_ORIGIN };
  return {
    base,
    headers,
    async post(path, body) { const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }); return { status: response.status, body: await response.json() }; },
    async get(path) { const response = await fetch(`${base}${path}`, { headers }); return { status: response.status, body: await response.json() }; },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(automationDir, { recursive: true, force: true });
      if (previousState === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previousState;
      if (previousAutomation === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR; else process.env.CIRCUITPILOT_AUTOMATION_DIR = previousAutomation;
    },
  };
}

const dirs = [];
const newDir = () => { const dir = mkdtempSync(join(tmpdir(), 'cp-drill-state-')); dirs.push(dir); return dir; };

// ---------- Part A ----------
try {
  // 1. EDA 断连
  {
    const stateDir = newDir();
    const bridge = baseBridge();
    bridge.execute = async () => { throw Object.assign(new Error('无法连接嘉立创EDA桥接'), { code: 'EDA_OFFLINE' }); };
    const server = await startServer({ bridge, stateDir });
    const result = await server.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'drill-offline-1' });
    const stateText = result.body?.run?.state ?? result.body?.error?.code ?? 'unknown';
    const failedClosed = stateText !== 'completed' && stateText !== 'ok';
    record({ id: 'eda-offline', kind: 'fault', expected: 'read 配方不得 completed', observed: { http: result.status, state: stateText }, pass: failedClosed });
    await server.close();
  }

  // 2. 桥接错误（延迟后失败）
  {
    const stateDir = newDir();
    const bridge = baseBridge();
    bridge.execute = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); throw Object.assign(new Error('桥接返回 500'), { code: 'BRIDGE_HTTP_ERROR' }); };
    const server = await startServer({ bridge, stateDir });
    const result = await server.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'drill-bridge-err-1' });
    const stateText = result.body?.run?.state ?? result.body?.error?.code ?? 'unknown';
    record({ id: 'bridge-http-error', kind: 'fault', expected: 'read 配方不得 completed', observed: { http: result.status, state: stateText }, pass: stateText !== 'completed' });
    await server.close();
  }

  // 3. 写配方无批准：0 次写命令
  {
    const stateDir = newDir();
    let writeCalls = 0;
    const bridge = baseBridge();
    bridge.execute = async (commandId) => {
      if (['pcb.pour.deleteAdded', 'pcb.save', 'pcb.pour.create', 'pcb.line.create', 'pcb.via.create'].includes(commandId)) writeCalls += 1;
      if (commandId === 'project.current') return { ok: true, result: { uuid: 'p-drill', data: [{ uuid: 'p-drill', name: '演练板' }] } };
      if (commandId === 'document.current') return { ok: true, result: { uuid: 'd-drill' } };
      return { ok: true, result: {} };
    };
    const server = await startServer({ bridge, stateDir });
    const result = await server.post('/api/automation/run', { recipeId: 'pcb-rebuild-pours', params: {}, runId: 'drill-no-approval-1' });
    detect: {
      const stateText = result.body?.run?.state ?? result.body?.error?.code ?? 'unknown';
      record({ id: 'write-without-approval', kind: 'fault', expected: 'needs_approval + 0 次写命令', observed: { http: result.status, state: stateText, writeCalls }, pass: stateText === 'needs_approval' && writeCalls === 0 });
    }
    await server.close();
  }

  // 4. 伪造/无效批准
  {
    const stateDir = newDir();
    const server = await startServer({ bridge: baseBridge(), stateDir });
    const issued = await server.post('/api/automation/approvals', { scope: 'write', note: 'E4 演练：故意用错 id' });
    const fakeId = `${issued.body?.approval?.approvalId || 'missing-approval'}-tampered`;
    const result = await server.post('/api/automation/run', { recipeId: 'pcb-rebuild-pours', params: {}, runId: 'drill-bad-approval-1', approvalIds: [fakeId] });
    record({ id: 'tampered-approval', kind: 'fault', expected: '409 AUTOMATION_APPROVAL_INVALID', observed: { http: result.status, code: result.body?.error?.code }, pass: result.status === 409 && result.body?.error?.code === 'AUTOMATION_APPROVAL_INVALID' });
    await server.close();
  }

  // 5. 追溯存储损坏：不得返回假空状态
  {
    const stateDir = newDir();
    writeFileSync(join(stateDir, 'trace-state.json'), '{broken-json', 'utf8');
    const server = await startServer({ bridge: baseBridge(), stateDir });
    const result = await server.get('/api/trace-state');
    const code = result.body?.error?.code || '';
    record({ id: 'corrupt-trace-store', kind: 'fault', expected: '400/500 + STORE_* 错误，不得返回空状态', observed: { http: result.status, code }, pass: result.status >= 400 && /STORE_/.test(code) });
    await server.close();
  }

  // 6. 未知配方
  {
    const stateDir = newDir();
    const server = await startServer({ bridge: baseBridge(), stateDir });
    const result = await server.post('/api/automation/run', { recipeId: 'no-such-recipe', params: {}, runId: 'drill-unknown-1' });
    record({ id: 'unknown-recipe', kind: 'fault', expected: '404 AUTOMATION_RECIPE_NOT_FOUND', observed: { http: result.status, code: result.body?.error?.code }, pass: result.status === 404 && result.body?.error?.code === 'AUTOMATION_RECIPE_NOT_FOUND' });
    await server.close();
  }
} catch (error) {
  record({ id: 'drill-setup', kind: 'fault', expected: '演练脚本本身不崩溃', observed: { error: String(error?.message || error) }, pass: false });
}

// ---------- Part B：真机只读（可选） ----------
const live = { attempted: false, runs: [], reason: null };
try {
  const token = process.env.CIRCUITPILOT_RUNTIME_TOKEN || (await import('node:fs')).readFileSync(TOKEN_FILE, 'utf8').trim();
  const health = await fetch(`${LIVE_BASE}/api/health`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (!health?.ok) {
    live.reason = `运行时不可达：${LIVE_BASE}`;
  } else {
    live.attempted = true;
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now();
      const response = await fetch(`${LIVE_BASE}/api/automation/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-circuitpilot-token': token }, body: JSON.stringify({ recipeId: 'eda-read-project', params: {}, runId: `drill-live-read-${STAMP}-${index}` }) });
      const payload = await response.json();
      const runId = payload?.run?.runId || payload?.runId || null;
      let chainOk = null;
      if (runId) {
        const detail = await fetch(`${LIVE_BASE}/api/automation/runs/${runId}`, { headers: { 'x-circuitpilot-token': token } }).then((res) => res.json()).catch(() => null);
        chainOk = detail?.run?.chain?.ok ?? null;
      }
      const completed = payload?.run?.state === 'completed';
      live.runs.push({ http: response.status, state: payload?.run?.state ?? null, runId, chainOk, durationMs: Date.now() - started });
      record({ id: `live-readonly-${index + 1}`, kind: 'live-readonly', expected: '真机只读配方 completed + journal 链 ok', observed: { http: response.status, state: payload?.run?.state ?? null, chainOk }, pass: completed && chainOk === true });
    }
  }
} catch (error) {
  live.reason = String(error?.message || error);
}

const failed = rows.filter((row) => !row.pass);
const report = { kind: 'fault-drill', generatedAt: new Date().toISOString(), live, rows, verdict: failed.length ? 'fail' : 'pass' };
import { mkdirSync } from 'node:fs';
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, `fault-drill-${STAMP}.json`), JSON.stringify(report, null, 2));
const md = ['# E4 故障注入演练报告', '', `- 时间：${report.generatedAt}`, `- 结论：**${report.verdict.toUpperCase()}**`, `- 真机只读：${live.attempted ? `${live.runs.filter((run) => run.state === 'completed').length}/3 次 completed` : `SKIPPED（${live.reason}）`}`, '', '| 场景 | 类型 | 期望（fail-closed） | 观察 | 结果 |', '|---|---|---|---|---|', ...rows.map((row) => `| ${row.id} | ${row.kind} | ${row.expected} | ${JSON.stringify(row.observed)} | ${row.pass ? 'PASS' : 'FAIL'} |`), '', '说明：故障注入在进程内真实装配运行时（非 mock 路由）；真机只读仅在 4179 可达时执行，不可达如实 SKIPPED。写板/支付路径仍需人工批准，不在本演练内。'];
writeFileSync(join(OUT_DIR, `fault-drill-${STAMP}.md`), md.join('\n'));
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: failed.length === 0, verdict: report.verdict, report: join(OUT_DIR, `fault-drill-${STAMP}.json`) }, null, 2));
process.exit(failed.length ? 1 : 0);
