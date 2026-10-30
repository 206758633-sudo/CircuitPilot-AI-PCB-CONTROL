/**
 * stdio 集成测试：启动真实 MCP server 子进程 + fake HTTP Runtime，验证
 * DSH 式协商、工具发现、只读调用、对话审批链路、错误/取消语义与 stdout 纯净度。
 *
 * 这些测试覆盖 agent/mcp-server.mjs 的“真实协议”行为；进程内协议单测见
 * mcp-server.test.mjs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_TOKEN_SECRET,
  DESIGN_PLAN_HASH,
  TEST_TOKEN,
  makeTempDir,
  removeDir,
  startFakeRuntime,
  writeTokenFile,
} from './helpers/fake-runtime.mjs';
import { openMcpSession } from './helpers/mcp-session.mjs';
import { TOOL_NAMES } from '../../plugin/dsh-circuitpilot/lib/tools.mjs';

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

async function waitFor(predicate, { timeoutMs = 4_000, intervalMs = 20, label = '条件' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

/** 每个测试都保证关闭子进程与 fake runtime，避免文件描述符/进程泄漏。 */
async function withStdioEnv({ args = [], env = {}, runtimeOptions, tokenFile = 'valid' } = {}, fn) {
  const dir = await makeTempDir();
  const runtime = await startFakeRuntime(runtimeOptions);
  const resolvedTokenFile = tokenFile === 'valid' ? await writeTokenFile(dir) : tokenFile;
  const session = await openMcpSession({
    args: tokenFile ? ['--token-file', resolvedTokenFile, ...args] : [...args],
    env: { CIRCUITPILOT_RUNTIME_URL: runtime.url, ...env },
  });
  try {
    return await fn({ session, runtime, dir });
  } finally {
    await session.close().catch(() => {});
    await runtime.close().catch(() => {});
    await removeDir(dir);
  }
}

function assertStdoutPurity(session) {
  assert.deepEqual(session.invalidJsonLines, [], `stdout 出现非 JSON 行：${session.invalidJsonLines.join('\n')}`);
  assert.ok(session.rawLines.length > 0);
  for (const line of session.rawLines) {
    assert.doesNotThrow(() => JSON.parse(line), `stdout 行不是合法 JSON：${line.slice(0, 200)}`);
    assert.equal(line.includes('[circuitpilot-mcp]'), false, 'stdout 不允许出现日志');
  }
}

/* ------------------------------------------------------------------ */
/* 主链路                                                              */
/* ------------------------------------------------------------------ */

test('stdio：DSH 式协商（server/discover → initialize）→ tools/list → cp_status', async () => {
  await withStdioEnv({}, async ({ session, runtime }) => {
    // 1) DSH 的 stdio auto 协商会先发 server/discover：必须是 -32601（明确 legacy 信号）。
    const probe = await session.request(
      'server/discover',
      { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'dsh-mcp-client', version: '0.0.1' } } },
      { id: 'server-discover-probe-1' },
    );
    assert.equal(probe.result, undefined);
    assert.equal(probe.error.code, -32601);

    // 2) 回退到 legacy initialize：版本回显 2025-11-25，声明 tools 能力与 instructions。
    const init = await session.handshake();
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.ok(init.result.serverInfo.name.length > 0);
    assert.ok(Buffer.byteLength(init.result.instructions, 'utf8') <= 32_768);

    // 3) tools/list 必须恰好是 12 个 CircuitPilot 工具。
    const listed = await session.request('tools/list');
    assert.equal(listed.result.tools.length, 12);
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [...TOOL_NAMES]);

    // 4) 只读工具真实走 Runtime HTTP；token 必须带上，且只能出现在 Runtime 侧。
    const status = await session.request('tools/call', { name: 'cp_status', arguments: {} });
    const value = status.result.structuredContent;
    assert.equal(value.ok, true);
    assert.equal(value.data.runtime.reachable, true);
    assert.equal(value.data.project.name, 'PCBA Demo');
    assert.equal(status.result.isError, undefined);
    assert.deepEqual(JSON.parse(status.result.content[0].text), value);

    const healthRequests = runtime.requests.filter((entry) => entry.pathname === '/api/health');
    assert.ok(healthRequests.length >= 1);
    for (const entry of runtime.requests) {
      assert.equal(entry.headers['x-circuitpilot-agent-token'], TEST_TOKEN);
    }

    assertStdoutPurity(session);
    // 日志只出现在 stderr，且不泄露 agent token。
    assert.match(session.stderr, /initialize: client=dsh-mcp-client-test/);
    assert.equal(session.stderr.includes(TEST_TOKEN), false);

    const exit = await session.close();
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  });
});

test('stdio：initialize 回显客户端 offer 的旧版本；未来版本回落到 2025-11-25', async () => {
  const legacy = await openMcpSession();
  try {
    const init = await legacy.handshake({ protocolVersion: '2025-06-18' });
    assert.equal(init.result.protocolVersion, '2025-06-18');
  } finally {
    await legacy.close();
  }

  const future = await openMcpSession();
  try {
    const init = await future.handshake({ protocolVersion: '2026-07-28' });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(future.invalidJsonLines.length, 0);
  } finally {
    await future.close();
  }
});

test('stdio：探针进程语义——只发 server/discover 后关闭 stdin 也能干净退出', async () => {
  const session = await openMcpSession();
  const probe = await session.request('server/discover', {}, { id: 'probe-only' });
  assert.equal(probe.error.code, -32601);
  // 模拟 DSH 一次性探测 sibling：拿到 -32601 立即结束 stdin。
  const exit = await session.close();
  assert.equal(exit.code, 0);
  assert.deepEqual(session.invalidJsonLines, []);
});

/* ------------------------------------------------------------------ */
/* 认证与 Runtime 故障                                                 */
/* ------------------------------------------------------------------ */

test('stdio：token 文件缺失时 cp_status 返回 AGENT_TOKEN_MISSING，进程不崩溃', async () => {
  await withStdioEnv({ tokenFile: '/tmp/circuitpilot-mcp-missing-token-file.json' }, async ({ session, runtime }) => {
    await session.handshake();
    const response = await session.request('tools/call', { name: 'cp_status', arguments: {} });
    const value = response.result.structuredContent;
    assert.equal(value.ok, false);
    assert.equal(value.code, 'AGENT_TOKEN_MISSING');
    assert.ok(value.nextActions.length > 0);
    // token 不可用时不应发起任何 Runtime 请求。
    assert.equal(runtime.requests.length, 0);
    // server 仍然可服务后续请求。
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

test('stdio：Runtime 拒绝 token（401）时返回失败 envelope，不泄露 token', async () => {
  // fake runtime 期望另一个 token，测试 token 文件里的 TEST_TOKEN 会被 401。
  await withStdioEnv({ runtimeOptions: { token: 'cpa_expected_token_9999' } }, async ({ session }) => {
    await session.handshake();
    const response = await session.request('tools/call', { name: 'cp_status', arguments: {} });
    const value = response.result.structuredContent;
    assert.equal(value.ok, false);
    assert.equal(typeof value.code, 'string');
    assert.ok(value.code.length > 0);
    for (const line of session.rawLines) {
      assert.equal(line.includes(TEST_TOKEN), false, 'MCP 响应不能包含 agent token');
    }
    assert.equal(session.stderr.includes(TEST_TOKEN), false, 'stderr 不能包含 agent token');
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

test('stdio：Runtime 5xx 时返回领域错误 envelope，server 保持可服务', async () => {
  const runtimeOptions = {
    routes: {
      'GET /api/health': () => ({ status: 503, body: { ok: false, code: 'RUNTIME_DEGRADED', message: 'Runtime 维护中' } }),
    },
  };
  await withStdioEnv({ runtimeOptions }, async ({ session }) => {
    await session.handshake();
    const response = await session.request('tools/call', { name: 'cp_status', arguments: {} });
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.code, 'RUNTIME_DEGRADED');
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 对话审批链路                                                        */
/* ------------------------------------------------------------------ */

test('stdio：plan → approve(confirm) → execute → cp_job wait 全链路；审批 token 不泄露', async () => {
  await withStdioEnv({}, async ({ session, runtime }) => {
    await session.handshake();

    const plan = await session.request('tools/call', {
      name: 'cp_design_plan',
      arguments: { mode: 'normalize', plan: { blocks: {}, nets: [], operations: [] } },
    });
    const planValue = plan.result.structuredContent;
    assert.equal(planValue.ok, true);
    assert.equal(planValue.data.planHash, DESIGN_PLAN_HASH);

    // 未确认时不允许批准：工具层返回 CONFIRM_REQUIRED（不是协议错误）。
    const noConfirm = await session.request('tools/call', {
      name: 'cp_approve',
      arguments: { planHash: DESIGN_PLAN_HASH },
    });
    assert.equal(noConfirm.result.structuredContent.ok, false);
    assert.equal(noConfirm.result.structuredContent.code, 'INVALID_ARGUMENTS');

    const approved = await session.request('tools/call', {
      name: 'cp_approve',
      arguments: { planHash: DESIGN_PLAN_HASH, confirm: true, note: 'user said approve' },
    });
    const approvalValue = approved.result.structuredContent;
    assert.equal(approvalValue.ok, true);
    assert.equal(approvalValue.data.approvalId, 'apv-1');
    assert.equal(approvalValue.data.approvalTokenExposed, false);

    // 审批 token 只用于 Runtime 调用，绝不能出现在任何 MCP stdout 行或 stderr。
    for (const line of session.rawLines) {
      assert.equal(line.includes(APPROVAL_TOKEN_SECRET), false, 'MCP 响应不能包含审批 token');
    }
    assert.equal(session.stderr.includes(APPROVAL_TOKEN_SECRET), false);

    const executed = await session.request('tools/call', {
      name: 'cp_execute',
      arguments: { planHash: DESIGN_PLAN_HASH, requestId: 'mcp-req-0001' },
    });
    const executeValue = executed.result.structuredContent;
    assert.equal(executeValue.ok, true);
    assert.equal(typeof executeValue.data.jobId, 'string');

    // 同 requestId 幂等：重复提交返回同一 job，不重复执行。
    const deduped = await session.request('tools/call', {
      name: 'cp_execute',
      arguments: { planHash: DESIGN_PLAN_HASH, requestId: 'mcp-req-0001' },
    });
    assert.equal(deduped.result.structuredContent.data.jobId, executeValue.data.jobId);
    assert.equal(deduped.result.structuredContent.data.deduped, true);

    const waited = await session.request('tools/call', {
      name: 'cp_job',
      arguments: { action: 'wait', jobId: executeValue.data.jobId, timeoutMs: 5_000 },
    });
    const jobValue = waited.result.structuredContent;
    assert.equal(jobValue.ok, true);
    assert.equal(jobValue.data.job.state, 'done');
    assert.equal(jobValue.data.job.result.ok, true);

    // Runtime 侧必须收到带 planHash/confirm 的审批请求与带 approvalToken 的执行请求。
    const approveRequests = runtime.requests.filter((entry) => entry.pathname === '/api/design/approve');
    assert.equal(approveRequests.length, 1);
    assert.equal(approveRequests[0].body.planHash, DESIGN_PLAN_HASH);
    assert.equal(approveRequests[0].body.confirm, true);
    assert.equal(approveRequests[0].body.approvalMode, 'chat');

    const executeRequests = runtime.requests.filter((entry) => entry.pathname === '/api/design/execute');
    assert.equal(executeRequests.length, 1, '同 requestId 不能重复执行');
    assert.equal(executeRequests[0].body.approvalToken, APPROVAL_TOKEN_SECRET);

    assertStdoutPurity(session);
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

test('stdio：--approval-mode off 时 cp_approve 拒绝且不调用 Runtime 审批路由', async () => {
  await withStdioEnv({ args: ['--approval-mode', 'off'] }, async ({ session, runtime }) => {
    await session.handshake();
    const plan = await session.request('tools/call', {
      name: 'cp_design_plan',
      arguments: { mode: 'normalize', plan: { blocks: {} } },
    });
    assert.equal(plan.result.structuredContent.ok, true);

    const approved = await session.request('tools/call', {
      name: 'cp_approve',
      arguments: { planHash: DESIGN_PLAN_HASH, confirm: true },
    });
    const value = approved.result.structuredContent;
    assert.equal(value.ok, false);
    assert.equal(value.code, 'APPROVAL_MODE_DISABLED');
    assert.equal(runtime.requests.filter((entry) => entry.pathname === '/api/design/approve').length, 0);
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 取消                                                                */
/* ------------------------------------------------------------------ */

test('stdio：notifications/cancelled 中止执行中的 Runtime 请求且不返回响应', async () => {
  const runtimeOptions = {
    routes: {
      'GET /api/health': () => ({ delayMs: 3_000, body: { ok: true, version: 'slow' } }),
    },
  };
  await withStdioEnv({ runtimeOptions }, async ({ session, runtime }) => {
    await session.handshake();

    // 该请求不会收到响应：只挂 catch 防 unhandled rejection，不 await（关闭会话时统一清理）。
    session
      .request('tools/call', { name: 'cp_status', arguments: {} }, { id: 'cancel-me', timeoutMs: 8_000 })
      .catch(() => undefined);
    // 等 Runtime 真正收到 /api/health 再取消，避免取消发生在请求发出之前。
    await waitFor(
      () => runtime.requests.some((entry) => entry.pathname === '/api/health'),
      { label: 'Runtime 收到 /api/health' },
    );
    session.notify('notifications/cancelled', { requestId: 'cancel-me', reason: 'test cancel' });

    await session.expectNoResponse('cancel-me', { timeoutMs: 800 });
    // 底层 HTTP 请求应被 abort（fake runtime 记录 aborted）。
    await waitFor(
      () => runtime.requests.some((entry) => entry.pathname === '/api/health' && entry.aborted === true),
      { label: 'Runtime 请求被 abort', timeoutMs: 5_000 },
    );
    // 取消后 server 保持可服务。
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    const exit = await session.close();
    assert.equal(exit.code, 0);
  });
});

/* ------------------------------------------------------------------ */
/* CLI 模式与退出语义                                                  */
/* ------------------------------------------------------------------ */

test('CLI：--approval-mode 非法时退出码 2，stdout 为空，stderr 给出配置错误', async () => {
  const session = await openMcpSession({ args: ['--approval-mode', 'bogus'] });
  const exit = await session.exitPromise;
  assert.equal(exit.code, 2);
  assert.deepEqual(session.rawLines, []);
  assert.match(session.stderr, /配置错误/);
  assert.match(session.stderr, /approvalMode/);
});

test('CLI：--help / --version / --print-config 只写 stderr 并退出 0', async () => {
  const help = await openMcpSession({ args: ['--help'] });
  const helpExit = await help.exitPromise;
  assert.equal(helpExit.code, 0);
  assert.deepEqual(help.rawLines, []);
  assert.match(help.stderr, /用法: node agent\/mcp-server\.mjs/);

  const version = await openMcpSession({ args: ['--version'] });
  const versionExit = await version.exitPromise;
  assert.equal(versionExit.code, 0);
  assert.deepEqual(version.rawLines, []);
  assert.match(version.stderr, /circuitpilot-agent 0\.1\.0/);

  const printConfig = await openMcpSession({ args: ['--print-config', '--token', 'cpa_secret_token_abcdef'] });
  const printExit = await printConfig.exitPromise;
  assert.equal(printExit.code, 0);
  assert.deepEqual(printConfig.rawLines, []);
  assert.match(printConfig.stderr, /"tokenSource": "explicit-token"/);
  assert.equal(printConfig.stderr.includes('cpa_secret_token_abcdef'), false);
});

test('stdio：stdin EOF 后进程干净退出（code 0），期间 stdout 只有 JSON 行', async () => {
  const session = await openMcpSession();
  await session.handshake();
  // 让 server 侧至少处理过一个请求。
  await session.request('ping');
  const exit = await session.close();
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.deepEqual(session.invalidJsonLines, []);
  assert.deepEqual(session.unsolicited, []);
  for (const line of session.rawLines) assert.doesNotThrow(() => JSON.parse(line));
});
