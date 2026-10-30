import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * P0-8：全局写暂停必须由 Runtime 权威执行。
 *
 * 修复前 `writePaused` 只是浏览器 localStorage 里一个变量：设置页写着"阻断所有 EDA 写命令"，
 * 但脚本/curl 直接打 HTTP 仍能签发写批准、写板。这里把三条验收路由钉成回归：
 * 暂停 → `/api/automation/approvals`、`/api/automation/run`、`/api/eda/pcb/placement/apply`
 * 全部 409 `EDA_WRITE_PAUSED`；恢复后不再被写暂停拦截。
 */

const STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-write-gate-state-'));
process.env.CIRCUITPILOT_STATE_DIR = STATE_DIR;
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-write-gate-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-write-gate-automation-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-write-gate-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-write-gate-memo-${process.pid}.json`);

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

function createReadOnlyBridge() {
  const executed = [];
  return {
    executed,
    port: 49622,
    selectedWindowId: 'W-WRITEGATE',
    async discover() { return { port: 49622 }; },
    async windows() { return { windows: [{ id: 'W-WRITEGATE' }], selectedWindowId: 'W-WRITEGATE', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id) {
      executed.push({ id });
      if (id === 'project.current') return { result: { uuid: 'P-WRITEGATE' } };
      if (id === 'document.current') return { result: { uuid: 'D-WRITEGATE', documentType: 3 } };
      throw Object.assign(new Error(`离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function startServer(bridge) {
  const { server } = createRuntimeServer({ bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function session(base) {
  return fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
}

test('暂停写入后：签发批准/自动化运行/布局写回全部 409 EDA_WRITE_PAUSED；恢复后放行', async (context) => {
  const bridge = createReadOnlyBridge();
  const first = await startServer(bridge);
  context.after(() => new Promise((resolve) => first.server.close(resolve)));
  const health = await session(first.base);
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${first.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // 暂停
  const paused = await post('/api/write-gate', { paused: true, reason: '演练：暂停全部写板', actor: '测试' });
  assert.equal(paused.status, 200);
  const pausedBody = await paused.json();
  assert.equal(pausedBody.gate.paused, true);
  assert.equal(pausedBody.gate.reason, '演练：暂停全部写板');
  assert.ok(existsSync(join(STATE_DIR, 'write-gate.json')), '暂停状态必须落盘（重启不丢）');
  assert.equal(JSON.parse(readFileSync(join(STATE_DIR, 'write-gate.json'), 'utf8')).paused, true);

  const readBack = await (await fetch(`${first.base}/api/write-gate`, { headers })).json();
  assert.equal(readBack.gate.paused, true);

  // 三条验收路由 + 其它写入口：必须在碰 EDA 之前被写暂停拦下。
  const blocked = [
    ['/api/automation/approvals', { scope: 'write', note: '暂停期间不应签发' }],
    ['/api/automation/run', { recipeId: 'pcb-import-changes', params: {} }],
    ['/api/eda/pcb/placement/apply', { plan: { placements: [] }, dryRun: false }],
    ['/api/eda/schematic/repair', { dryRun: false }],
    ['/api/eda/pcb/routing/finish', {}],
    ['/api/eda/pcb/layers', { layers: 4 }],
    ['/api/pcb/execute', {}],
    ['/api/design/execute', {}],
    ['/api/eda/gui/execute', { action: 'click', params: { x: 1, y: 1 } }],
  ];
  for (const [path, body] of blocked) {
    const response = await post(path, body);
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, 409, `${path} 应 409，实际 ${response.status} ${JSON.stringify(payload).slice(0, 240)}`);
    assert.equal(payload.error?.code, 'EDA_WRITE_PAUSED', `${path} 必须是写暂停拦下（实际 ${payload.error?.code ?? payload.code}）`);
    assert.equal(payload.error?.details?.reason, '演练：暂停全部写板', `${path} 的 409 必须带暂停原因`);
  }

  // 暂停只挡写入：只读 GUI 动作仍可用（离线桥会抛 EDA_OFFLINE，证明穿过了写门禁而不是被 409 拦）。
  const screenshot = await post('/api/eda/gui/execute', { action: 'screenshot', params: {} });
  const screenshotBody = await screenshot.json().catch(() => ({}));
  assert.notEqual(screenshot.status, 409, '只读 GUI 动作不应被写暂停拦截');
  assert.notEqual(screenshotBody.error?.code, 'EDA_WRITE_PAUSED');

  // 写暂停期间没有任何写命令真正打到桥。
  assert.deepEqual(bridge.executed.filter((entry) => /\.(create|modify|delete|save|apply|write)$/.test(entry.id)), []);

  // 恢复：同一个进程内立即生效，签发写批准重新可用（不再返回 EDA_WRITE_PAUSED）。
  const resumed = await post('/api/write-gate', { paused: false, actor: '测试' });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).gate.paused, false);
  const approval = await post('/api/automation/approvals', { scope: 'write', note: '恢复后签发' });
  const approvalBody = await approval.json().catch(() => ({}));
  assert.notEqual(approval.status, 409, `恢复后签发批准不应再被写暂停拦截：${JSON.stringify(approvalBody).slice(0, 240)}`);
  assert.notEqual(approvalBody.error?.code, 'EDA_WRITE_PAUSED');
});

test('暂停状态跨 Runtime 重启保留（磁盘权威，不是内存开关）', async (context) => {
  const bridge = createReadOnlyBridge();
  const first = await startServer(bridge);
  const health = await session(first.base);
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  await fetch(`${first.base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: true, reason: '重启验证' }) });
  await new Promise((resolve) => first.server.close(resolve));

  const second = await startServer(bridge);
  context.after(() => new Promise((resolve) => second.server.close(resolve)));
  const health2 = await session(second.base);
  const headers2 = { 'content-type': 'application/json', 'x-circuitpilot-token': health2.sessionProof };
  const gate = await (await fetch(`${second.base}/api/write-gate`, { headers: headers2 })).json();
  assert.equal(gate.gate.paused, true, '重启后写暂停必须仍然生效');
  assert.equal(gate.gate.reason, '重启验证');

  const blocked = await fetch(`${second.base}/api/eda/pcb/placement/apply`, { method: 'POST', headers: headers2, body: JSON.stringify({ plan: { placements: [] }, dryRun: false }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error?.code, 'EDA_WRITE_PAUSED');
  // 收尾：恢复，避免影响同一 state 目录下的后续断言。
  await fetch(`${second.base}/api/write-gate`, { method: 'POST', headers: headers2, body: JSON.stringify({ paused: false }) });
});

test('权威门禁文件损坏时 fail-closed：GET 报告已暂停 + loadError，写路由仍 409（不得静默放行）', async (context) => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(STATE_DIR, 'write-gate.json'), '{ 不是合法 JSON', 'utf8');
  const bridge = createReadOnlyBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await session(base);
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const gate = await fetch(`${base}/api/write-gate`, { headers }).then((response) => response.json());
  assert.equal(gate.gate.paused, true, '状态文件损坏时必须按暂停处理（fail-closed）');
  assert.ok(gate.gate.loadError, '必须透出 loadError，让 UI 能显示异常而不是假装正常');
  const blocked = await fetch(`${base}/api/eda/pcb/placement/apply`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error?.code, 'EDA_WRITE_PAUSED');
  // 显式恢复必须能重写文件并清掉 loadError（否则损坏后永远无法解除）。
  const restored = await fetch(`${base}/api/write-gate`, { method: 'POST', headers, body: JSON.stringify({ paused: false }) }).then((response) => response.json());
  assert.equal(restored.gate.paused, false);
  assert.equal(restored.gate.loadError, undefined);
});
