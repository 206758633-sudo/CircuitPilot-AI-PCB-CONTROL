/**
 * CircuitPilot Agent MVP 安全验证（task-19，独立验证，不写生产代码）。
 *
 * 重点验证：
 *  - 无 token / 坏 token → 401；真实 token 签发（runtime/agent-token.mjs）可被 HTTP 接受；
 *  - 真实 runtime/agent-auth.mjs 纯函数的 denylist/审批豁免（含 URL 编码/路径绕过变体）；
 *  - HTTP 层：合法 agent token 调签核/设置/POST write-gate → 403 AGENT_ROUTE_FORBIDDEN，
 *    且请求不进入业务处理；对话审批 POST /api/design/approve、/api/pcb/approve 仍放行；
 *  - approvalToken 只在插件内存：不出现在任何工具结果/错误里；
 *  - agent token 不出现在错误 message/nextActions/请求 query/body；
 *  - 写暂停 409 与超时：返回可执行 nextActions，且绝不自动重试写操作。
 *
 * 运行：node --test "verification/agent/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '../../plugin/dsh-circuitpilot/lib/runtime.mjs';
import { ensureAgentTokenFile } from '../../runtime/agent-token.mjs';
import { assertAgentRouteAllowed, isAgentRouteAllowed } from '../../runtime/agent-auth.mjs';
import {
  AGENT_TOKEN_HEADER,
  BAD_TOKEN,
  createToolHarness,
  startFakeRuntime,
  waitJob,
  TEST_TOKEN,
  DESIGN_PLAN_HASH,
} from './fake-runtime.mjs';

async function withHarness(options, fn) {
  const harness = await createToolHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

async function rawRequest(runtime, path, { method = 'GET', token = runtime.token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token !== null && token !== undefined) requestHeaders[AGENT_TOKEN_HEADER] = token;
  const init = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${runtime.url}${path}`, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

test('无 token / 坏 token：HTTP 401，错误不含 token；真实签发的 token 文件可被接受', async () => {
  const runtime = await startFakeRuntime();
  const dir = await mkdtemp(join(tmpdir(), 'cp-verify-sec-'));
  try {
    // 1) token 文件缺失：插件本地就 fail-closed，不发请求
    const missingClient = new RuntimeClient({ baseUrl: runtime.url, tokenFile: join(dir, 'missing-token.json'), timeoutMs: 1000 });
    const missing = await missingClient.get('/api/project-state');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'AGENT_TOKEN_MISSING');
    assert.match(missing.message, /missing-token\.json/);
    assert.equal(runtime.requests.length, 0, '缺少 token 时不得发请求');

    // 2) 坏 token：HTTP 层 401，插件映射 AGENT_TOKEN_INVALID，错误里不回显 token
    const badClient = new RuntimeClient({ baseUrl: runtime.url, token: BAD_TOKEN, timeoutMs: 1000 });
    const rejected = await badClient.get('/api/project-state');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.code, 'AGENT_TOKEN_INVALID');
    assert.ok(!JSON.stringify(rejected).includes(BAD_TOKEN), '401 错误不得包含 token');
    assert.equal(runtime.count('GET /api/project-state'), 1);
    assert.equal(runtime.calls('GET /api/project-state')[0].authorized, false);

    // 3) 用生产模块签发真实 token 文件（0600 / 原子写入），插件按 tokenFile 读取后 HTTP 200
    const issuedFile = join(dir, 'issued', 'agent-token.json');
    const issued = await ensureAgentTokenFile({ file: issuedFile });
    assert.equal(issued.created, true);
    assert.match(issued.token, /^cpa_[0-9a-f]{48}$/);
    const fileStat = await stat(issuedFile);
    assert.equal(fileStat.mode & 0o777, 0o600, 'token 文件权限必须是 0600');

    const runtime2 = await startFakeRuntime({ token: issued.token });
    try {
      const fileClient = new RuntimeClient({ baseUrl: runtime2.url, tokenFile: issuedFile, timeoutMs: 1000 });
      const accepted = await fileClient.get('/api/project-state');
      assert.equal(accepted.ok, true);
      assert.equal(runtime2.calls('GET /api/project-state')[0].headers[AGENT_TOKEN_HEADER], issued.token);
      assert.ok(!JSON.stringify(accepted).includes(issued.token), '成功结果也不得回显 token');
    } finally {
      await runtime2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await runtime.close();
  }
});

test('真实 agent-auth 纯函数：approve 仅 POST 精确路径放行；签核/设置/写门禁/POST /api/agent/* fail-closed', async () => {
  const allowed = [
    ['POST', '/api/design/approve'],
    ['POST', '/api/design/approve/'],
    ['POST', '/api/design/%61pprove'],
    ['POST', '/api/pcb/approve'],
    ['GET', '/api/health'],
    ['GET', '/api/project-state'],
    ['GET', '/api/write-gate'],
    ['POST', '/api/design/plan'],
    ['POST', '/api/eda/gates/evaluate'],
    ['GET', '/api/agent/status'],
    ['GET', '/api/agent/health'],
  ];
  for (const [method, path] of allowed) {
    assert.equal(isAgentRouteAllowed(method, path), true, `${method} ${path} 应放行`);
  }

  const denied = [
    ['GET', '/api/design/approve', '审批豁免只到 POST'],
    ['PUT', '/api/design/approve', '审批豁免只到 POST'],
    ['POST', '/api/design/approve/sub', '审批豁免只到精确路径'],
    ['GET', '/api/pcb/approve', '审批豁免只到 POST'],
    ['POST', '/api/production/signoff', '签核必须由人完成'],
    ['GET', '/api/production/signoff/latest', '签核子树也拒绝'],
    ['POST', '/api/production/reviews/final', '终审必须由人完成'],
    ['POST', '/api/production/order-confirmation', '下单确认必须由人完成'],
    ['POST', '/api/write-gate', 'Agent 不得恢复/修改写暂停'],
    ['PUT', '/api/write-gate', '写门禁写语义全部拒绝'],
    ['GET', '/api/settings', '设置面拒绝'],
    ['POST', '/api/settings/foo', '设置子树拒绝'],
    ['GET', '/api/providers', 'Provider 面拒绝'],
    ['GET', '/api/research/config', '研究配置拒绝'],
    ['GET', '/api/diagnostics/bundle', '诊断包导出拒绝'],
    ['GET', '/api/production/download/x', '文件下载拒绝'],
    ['POST', '/api/agent/status', 'agent status 只读'],
    ['GET', '/api/agent/pair', 'agent 配对拒绝'],
    ['GET', '/api/settings/', '尾斜杠不能绕过'],
    ['GET', '/api/%73ettings', 'URL 编码不能绕过'],
    ['GET', '/api/%2573ettings', '双重编码不能绕过'],
    ['GET', '/api/x/../settings', '路径穿越不能绕过'],
    ['GET', '//api//settings', '重复斜杠不能绕过'],
    ['GET', '/api/settings?next=/api/health', 'query 不能掩盖路径'],
    ['GET', '/api/providers/v1/kimi', 'Provider 子路径拒绝'],
    ['GET', '/api/%zz', '非法编码 fail-closed'],
    ['GET', 'api/settings', '非绝对路径 fail-closed'],
    ['GET', '', '空路径 fail-closed'],
    ['', '/api/health', '空方法 fail-closed'],
  ];
  for (const [method, path, why] of denied) {
    assert.equal(isAgentRouteAllowed(method, path), false, `${method} ${path} 应拒绝（${why}）`);
    assert.throws(
      () => assertAgentRouteAllowed(method, path),
      (error) => error.code === 'AGENT_ROUTE_FORBIDDEN' && error.status === 403,
      `${method} ${path}: assertAgentRouteAllowed 应抛 403 AGENT_ROUTE_FORBIDDEN`,
    );
  }
  assert.equal(isAgentRouteAllowed(null, '/api/health'), false);
});

test('HTTP 层越权：合法 token 调签核/设置/write-gate → 403 AGENT_ROUTE_FORBIDDEN 且不进业务处理；审批豁免仍可用', async () => {
  const runtime = await startFakeRuntime();
  try {
    const escalation = [
      ['POST', '/api/production/signoff'],
      ['GET', '/api/production/reviews/final'],
      ['GET', '/api/settings'],
      ['POST', '/api/settings/agent'],
      ['GET', '/api/providers'],
      ['POST', '/api/write-gate'],
      ['POST', '/api/agent/status'],
    ];
    for (const [method, path] of escalation) {
      const denied = await rawRequest(runtime, path, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(denied.status, 403, `${method} ${path} 应 403，实际 ${denied.status}`);
      assert.equal(denied.body?.error?.code, 'AGENT_ROUTE_FORBIDDEN');
      assert.ok(!denied.text.includes(TEST_TOKEN), `${method} ${path}: 403 响应不得包含 token`);
      assert.equal(runtime.deniedCount(`${method} ${path}`), 1, `${method} ${path}: 应被授权层拒绝`);
      assert.equal(runtime.handledCount(`${method} ${path}`), 0, `${method} ${path}: 不得进入业务 handler`);
    }

    // 只读 write-gate 快照允许；POST 对话审批允许
    const readable = await rawRequest(runtime, '/api/write-gate');
    assert.equal(readable.status, 200);
    assert.equal(readable.body?.ok, true);
    const designApprove = await rawRequest(runtime, '/api/design/approve', { method: 'POST', body: { planHash: DESIGN_PLAN_HASH, confirm: true } });
    assert.equal(designApprove.status, 200, 'approvalMode=chat 的对话审批精确路径应放行');
    assert.ok(designApprove.body?.approval?.token, '审批响应应返回 approvalToken（只进插件内存）');
    const pcbApprove = await rawRequest(runtime, '/api/pcb/approve', { method: 'POST', body: { confirm: true } });
    assert.equal(pcbApprove.status, 200);

    // 认证先于授权：坏 token 打签核路由返回 401，而不是 403（不暴露 denylist 细节）
    const badToken = await rawRequest(runtime, '/api/production/signoff', { method: 'POST', token: BAD_TOKEN, body: {} });
    assert.equal(badToken.status, 401);
    const noToken = await rawRequest(runtime, '/api/production/signoff', { method: 'POST', token: null, body: {} });
    assert.equal(noToken.status, 401);
  } finally {
    await runtime.close();
  }
});

test('approvalToken 不返回给模型：cp_approve/cp_execute/cp_job/错误结果均不含 approval token', async () => {
  await withHarness({}, async (harness) => {
    await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] } });
    const approve = await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
    assert.equal(approve.ok, true);
    const records = harness.runtime.approvalRecords();
    assert.equal(records.length, 1);
    const approvalToken = records[0].approvalToken;
    assert.equal(records[0].used, false);
    assert.equal(approve.data.approvalTokenExposed, false);
    assert.equal(typeof approve.data.approvalId, 'string');
    assert.ok(!JSON.stringify(approve).includes(approvalToken), 'cp_approve 结果不得包含 approvalToken');

    const execute = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-sec-approval' });
    assert.equal(execute.ok, true);
    const waited = await waitJob(harness, execute.data.jobId, 2000);
    assert.equal(waited.data.job.result.ok, true);
    const list = await harness.callTool('cp_job', { action: 'list' });
    for (const [label, value] of [['execute', execute], ['job-wait', waited], ['job-list', list]]) {
      assert.ok(!JSON.stringify(value).includes(approvalToken), `${label} 结果不得包含 approvalToken`);
    }
    // 只有 Runtime 请求体（插件→Runtime 内存通道）里允许出现 approvalToken
    const executeBody = harness.runtime.calls('POST /api/design/execute')[0].body;
    assert.equal(executeBody.approvalToken, approvalToken);

    const unknown = await harness.callTool('cp_approve', { planHash: 'e'.repeat(64), confirm: true });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'PLAN_NOT_KNOWN');
    assert.ok(!JSON.stringify(unknown).includes(approvalToken));
  });
});

test('agent token 不泄露到模型：错误 message 脱敏、请求 query/body 不含 token、成功结果不回显', async () => {
  await withHarness({}, async (harness) => {
    harness.runtime.enqueue('GET /api/project-state', {
      status: 500,
      body: { ok: false, error: { code: 'BACKEND_FAIL', message: `后端异常，请求头令牌=${TEST_TOKEN}` } },
    });
    const status = await harness.callTool('cp_status');
    assert.equal(status.ok, false);
    assert.equal(status.code, 'BACKEND_FAIL');
    assert.match(status.message, /\[REDACTED\]/, '错误 message 中的 agent token 必须被脱敏');
    assert.ok(!JSON.stringify(status).includes(TEST_TOKEN), '工具结果不得包含 agent token');

    // 插件发出的所有请求：token 只能在约定的 header 里，不能进 path/query/body
    for (const record of harness.runtime.requests) {
      assert.equal(record.headers[AGENT_TOKEN_HEADER], TEST_TOKEN);
      assert.ok(!record.path.includes(TEST_TOKEN), `${record.method} ${record.path}: token 不得出现在 path`);
      assert.ok(!JSON.stringify(record.query).includes(TEST_TOKEN), `${record.method} ${record.path}: token 不得出现在 query`);
      assert.ok(!JSON.stringify(record.body ?? null).includes(TEST_TOKEN), `${record.method} ${record.path}: token 不得出现在 body`);
    }
  });
});

test('写暂停：cp_status 给出停止写提示；cp_execute 收到 409 WRITE_PAUSED 后可执行 nextActions 且不自动重试', async () => {
  await withHarness({}, async (harness) => {
    harness.runtime.setGate({ paused: true, reason: '独立验证写暂停' });

    const status = await harness.callTool('cp_status');
    assert.equal(status.ok, true);
    assert.equal(status.data.writeGate.paused, true);
    assert.ok(status.nextActions.some((action) => /写入已暂停/.test(action)), 'cp_status 必须提示写入已暂停');
    assert.ok(status.nextActions.some((action) => /不要执行任何写操作/.test(action)), 'cp_status 必须明确禁止写操作');
    assert.match(status.summary, /写暂停 是/);

    await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] } });
    await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
    const execute = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-sec-paused' });
    assert.equal(execute.ok, true);
    const waited = await waitJob(harness, execute.data.jobId, 2000);
    const jobResult = waited.data.job.result;
    assert.equal(jobResult.ok, false);
    assert.equal(jobResult.code, 'WRITE_PAUSED');
    assert.ok(jobResult.nextActions.length > 0, '写暂停必须给出可执行 nextActions');
    assert.ok(jobResult.nextActions.some((action) => /cp_status|不要自动重试/.test(action)), 'nextActions 应引导先读状态且不重试');
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1, '写暂停后不得自动重试');

    // RuntimeClient 层 409 同样带可执行 nextActions
    harness.runtime.enqueue('GET /api/issue-state', {
      status: 409,
      body: { ok: false, error: { code: 'WRITE_PAUSED', message: '写入已暂停' } },
    });
    const conflict = await harness.client.get('/api/issue-state');
    assert.equal(conflict.ok, false);
    assert.ok(conflict.nextActions.some((action) => /不要自动重试写操作/.test(action)));
  });
});

test('超时写操作：mayHaveTakenEffect=true、nextActions 禁止自动重试、HTTP 只发送一次', async () => {
  await withHarness({ config: { jobTimeoutMs: 120, requestTimeoutMs: 5000 } }, async (harness) => {
    harness.runtime.enqueue('POST /api/production/export', { delayMs: 700, body: { ok: true, exported: true, final: true } });
    const submitted = await harness.callTool('cp_export', { requestId: 'req-sec-export-timeout', confirm: true });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.data.mayHaveTakenEffect, true, '导出是写操作，超时可能已生效');

    const waited = await waitJob(harness, submitted.data.jobId, 2000);
    assert.equal(waited.data.job.state, 'timeout');
    assert.equal(waited.data.job.mayHaveTakenEffect, true);
    assert.ok(waited.nextActions.some((action) => /不要?自动重试|禁止自动重试/.test(action)), '超时必须明确禁止自动重试');

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(harness.runtime.count('POST /api/production/export'), 1, '超时不得自动重发导出请求');
  });
});

test('生产接线静态校验：server.mjs 在分发前用 agent-token 认证 + agent-auth 授权', async () => {
  const source = await readFile(new URL('../../runtime/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{[^}]*AGENT_TOKEN_HEADER[^}]*\}\s*from\s*'\.\/agent-token\.mjs'/, 'server.mjs 必须导入 agent-token 模块');
  assert.match(source, /import\s*\{[^}]*assertAgentRouteAllowed[^}]*\}\s*from\s*'\.\/agent-auth\.mjs'/, 'server.mjs 必须导入 agent-auth 模块');
  assert.match(source, /verifyAgentToken\(request\.headers\[AGENT_TOKEN_HEADER\], agentToken\)/, 'server.mjs 必须校验 agent token');
  assert.match(source, /assertAgentRouteAllowed\(method, url\.pathname\)/, 'server.mjs 必须执行 agent 路由 denylist');
  const verifyIndex = source.indexOf('verifyAgentToken(request.headers[AGENT_TOKEN_HEADER]');
  const authorizeIndex = source.indexOf('assertAgentRouteAllowed(method, url.pathname)');
  const firstDispatchIndex = source.indexOf("method === 'GET' && url.pathname === '/api/project-state'");
  assert.ok(verifyIndex > 0 && authorizeIndex > verifyIndex, '先认证、再授权');
  assert.ok(firstDispatchIndex > authorizeIndex, '认证+授权必须发生在业务分发之前');
});
