import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * G6 fail-closed 回归矩阵（离线，不碰真机）。
 *
 * 目的：把"缺批准/缺证据/错批准 → 绝不 2xx 写入"这条红线钉成回归测试。
 * 断言的粒度是**错误码**而不是"状态码 >= 400"：400/404 也可能来自参数校验，
 * 只有明确的 AUTOMATION_APPROVAL_REQUIRED / AUTOMATION_APPROVAL_INVALID 才能证明
 * "是批准闸门拦下的"，而不是碰巧因为别的错误失败。
 *
 * 隔离所有本机状态：否则开发机上的 DRC 豁免/工程记忆会让测试结果依赖这台机器。
 */
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-failclosed-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-failclosed-memo-${process.pid}.json`);
process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-failclosed-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-failclosed-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-failclosed-automation-'));

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

/** 只回答"会话/指纹"所需的最小读命令；任何写入命令直接炸——证明请求没走到真实写入。 */
function createReadOnlyBridge() {
  const executed = [];
  return {
    executed,
    port: 49621,
    selectedWindowId: 'W-FAILCLOSED',
    async discover() { return { port: 49621 }; },
    async windows() { return { windows: [{ id: 'W-FAILCLOSED' }], selectedWindowId: 'W-FAILCLOSED', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id, args = {}) {
      executed.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P-FAILCLOSED' } };
      if (id === 'document.current') return { result: { uuid: 'D-FAILCLOSED', documentType: 3 } };
      throw Object.assign(new Error(`离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function startServer(bridge) {
  const { server } = createRuntimeServer({ bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('G6 矩阵：真实写入缺写板批准 → 409 AUTOMATION_APPROVAL_REQUIRED，且未触发 EDA 写入', async (context) => {
  const bridge = createReadOnlyBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // 每一条都是"会写 EDA"的入口：没有 approvalIds 时必须在碰 EDA 之前拦下。
  const cases = [
    ['/api/eda/pcb/placement/apply', { plan: { placements: [] }, dryRun: false }],
    ['/api/eda/pcb/routing/apply', { plan: { routes: [] }, dryRun: false }],
    ['/api/eda/pcb/routing/rollback', {}],
    ['/api/eda/pcb/routing/finish', {}],
    ['/api/eda/schematic/repair', { dryRun: false }],
  ];
  for (const [path, body] of cases) {
    const response = await post(path, body);
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, 409, `${path} 应 409，实际 ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
    assert.equal(payload.error?.code, 'AUTOMATION_APPROVAL_REQUIRED', `${path} 必须是批准闸门拦下（实际 ${payload.error?.code ?? payload.code}）`);
  }
  // 闸门在读写之前：没有任何写入命令被执行（上面的读命令允许出现）。
  const mutationAttempts = bridge.executed.filter((entry) => /\.(create|modify|delete|save|apply|write)$/.test(entry.id));
  assert.deepEqual(mutationAttempts, [], `缺批准时不得执行任何写入命令，实际：${mutationAttempts.map((entry) => entry.id).join(', ')}`);
});

test('G6 矩阵：伪造/过期批准 → 409 AUTOMATION_APPROVAL_INVALID（校验绑定当前 EDA 指纹）', async (context) => {
  const bridge = createReadOnlyBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/eda/schematic/repair`, {
    method: 'POST', headers,
    body: JSON.stringify({ dryRun: false, approvalIds: ['not-a-real-approval-id'] }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 409, `伪造批准应 409，实际 ${response.status}`);
  assert.equal(payload.error?.code, 'AUTOMATION_APPROVAL_INVALID');
  // 校验确实做了目标指纹绑定：响应里要能看见当前指纹，方便诊断"批准的是哪块板"。
  assert.match(payload.error?.details?.currentFingerprint ?? '', /^[a-f0-9]{16,64}$/);
  assert.ok(Array.isArray(payload.error?.details?.missing) && payload.error.details.missing.length > 0);
});

test('G6 矩阵：dryRun 不写盘 → 不被批准闸门拦截（允许进入后续只读/参数校验）', async (context) => {
  const bridge = createReadOnlyBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/eda/pcb/routing/apply`, {
    method: 'POST', headers,
    body: JSON.stringify({ plan: { routes: [] } }), // 未传 dryRun → 默认 dry-run
  });
  const payload = await response.json().catch(() => ({}));
  assert.notEqual(payload.error?.code, 'AUTOMATION_APPROVAL_REQUIRED', 'dry-run 不该被写板批准闸门拦截');
  assert.notEqual(payload.error?.code, 'AUTOMATION_APPROVAL_INVALID');
});

test('G6 矩阵：运行时会话凭证缺失 → 401，不给任何路由开后门', async (context) => {
  const bridge = createReadOnlyBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [path, method] of [
    ['/api/automation/approvals', 'POST'],
    ['/api/eda/pcb/routing/finish', 'POST'],
    ['/api/production/download?path=%2Fetc%2Fpasswd', 'GET'],
    ['/api/approvals/ledger', 'GET'],
  ]) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 401, `${method} ${path} 无会话凭证必须 401，实际 ${response.status}`);
  }
});
