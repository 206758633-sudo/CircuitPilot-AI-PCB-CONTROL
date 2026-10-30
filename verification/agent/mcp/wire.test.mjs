/**
 * task-22 独立复验（二）：裸 JSON-RPC stdio 会话（不经 SDK）逐条校验
 * agent/mcp-server.mjs 的 wire 行为，并用官方 @modelcontextprotocol/core
 * 的 zod schema 校验 InitializeResult / ListToolsResult / CallToolResult。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadDshSdk } from './dsh-sdk.mjs';
import { startFakeRuntime } from './fake-runtime.mjs';
import {
  createTokenFile,
  startRawSession,
  waitFor,
  assertSchema,
  EXPECTED_TOOL_NAMES,
  sleep,
  SERVER_PATH,
} from './mcp-session.mjs';

const sdk = await loadDshSdk();
const CORE = sdk.core;
const execFileAsync = promisify(execFile);

test.after(async () => {
  await sdk.cleanup();
});

async function withFixture(fn) {
  const runtime = await startFakeRuntime();
  const token = createTokenFile({ token: runtime.token });
  try {
    return await fn({ runtime, token });
  } finally {
    token.cleanup();
    await runtime.close();
  }
}

async function openRaw({ runtime, token, serverArgs = [] }) {
  return startRawSession({ runtime, tokenFile: token.file, serverArgs });
}

async function initializeRaw(session, protocolVersion = '2025-11-25', clientInfo = { name: 'raw-verifier', version: '1.0.0' }) {
  const reply = await session.request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo,
  });
  return reply;
}

/** 发送一条原始消息，等待「发送之后」出现的满足条件的响应（用于 id=null 的解析错误）。 */
async function sendAndWaitForReply(session, rawText, predicate, timeoutMs = 3000) {
  const mark = session.messages.length;
  session.sendRaw(rawText);
  const entry = await session.waitForMessage(
    (candidate) => predicate(candidate.message) && session.messages.indexOf(candidate) >= mark,
    { timeoutMs },
  );
  return entry.message;
}

test('全链路：server/discover(-32601) → initialize → notifications/initialized → tools/list(12) → ping；官方 schema 全过', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openRaw({ runtime, token });
    try {
      const discover = await session.request('server/discover', {
        _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'raw-verifier', version: '1.0.0' } },
      });
      assert.equal(discover.id, 1);
      assert.equal(discover.result, undefined);
      assert.equal(discover.error.code, -32601);
      assertSchema(CORE.JSONRPCErrorResponseSchema ?? CORE.JSONRPCErrorSchema, discover, 'DiscoverError');

      const init = await initializeRaw(session);
      assert.equal(init.id, 2);
      assertSchema(CORE.InitializeResultSchema, init.result, 'InitializeResult');
      assert.equal(init.result.protocolVersion, '2025-11-25');
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
      assert.deepEqual(init.result.serverInfo, { name: 'circuitpilot-agent', version: '0.1.0' });
      assert.ok(Buffer.byteLength(init.result.instructions, 'utf8') <= 32768);
      assert.ok(init.result.instructions.includes('CircuitPilot'));

      session.notify('notifications/initialized');
      const list = await session.request('tools/list', {});
      assertSchema(CORE.ListToolsResultSchema, list.result, 'ListToolsResult');
      assert.deepEqual(list.result.tools.map((tool) => tool.name), [...EXPECTED_TOOL_NAMES]);

      const ping = await session.request('ping', {});
      assert.deepEqual(ping.result, {});
      assert.equal(ping.error, undefined);

      assert.deepEqual(session.nonJsonLines, [], 'stdout 必须只有 JSON-RPC 行');
      const exit = await session.close();
      assert.equal(exit.code, 0, '正常关闭（stdin EOF）应以 0 退出');
    } finally {
      await session.close();
    }
  });
});

test('initialize 版本协商：支持旧版本回显；未知版本回落到 2025-11-25；非法 params 为 -32602 且可重试', async () => {
  await withFixture(async ({ runtime, token }) => {
    // 1) 支持的旧版本：原样回显。
    {
      const session = await openRaw({ runtime, token });
      try {
        const init = await initializeRaw(session, '2024-10-07');
        assert.equal(init.result.protocolVersion, '2024-10-07');
      } finally {
        await session.close();
      }
    }
    // 2) 未知/过新版本：回落到 server 默认 legacy 版本（不报错）。
    {
      const session = await openRaw({ runtime, token });
      try {
        const init = await initializeRaw(session, '2026-07-28');
        assert.equal(init.result.protocolVersion, '2025-11-25');
      } finally {
        await session.close();
      }
    }
    // 3) 非法 initialize：-32602，且 state 未置 initialized，可以重试。
    {
      const session = await openRaw({ runtime, token });
      try {
        const bad = await session.request('initialize', { capabilities: {} });
        assert.equal(bad.error.code, -32602);
        assert.match(bad.error.message, /protocolVersion/);
        const badType = await session.request('initialize', 'not-an-object');
        assert.equal(badType.error.code, -32602);
        const retry = await initializeRaw(session);
        assert.equal(retry.result.protocolVersion, '2025-11-25');
      } finally {
        await session.close();
      }
    }
  });
});

test('工具结果 wire 形状：成功 envelope 与 Runtime 500 业务错误 envelope 均过官方 CallToolResultSchema（协议层 success、无 isError）', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openRaw({ runtime, token });
    try {
      await initializeRaw(session);
      session.notify('notifications/initialized');

      const okReply = await session.request('tools/call', { name: 'cp_status', arguments: {} });
      assert.equal(okReply.error, undefined);
      assertSchema(CORE.CallToolResultSchema, okReply.result, 'CallToolResult(ok)');
      const okEnvelope = JSON.parse(okReply.result.content[0].text);
      assert.deepEqual(okEnvelope, okReply.result.structuredContent);
      assert.equal(okEnvelope.ok, true);
      assert.equal(okReply.result.isError, undefined);

      runtime.enqueue('GET /api/project-state', {
        status: 500,
        body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'fake runtime boom' } },
      });
      const errReply = await session.request('tools/call', { name: 'cp_status', arguments: {} });
      assert.equal(errReply.error, undefined, '业务错误必须走 CallToolResult envelope，而不是 JSON-RPC error');
      assertSchema(CORE.CallToolResultSchema, errReply.result, 'CallToolResult(business-error)');
      const errEnvelope = errReply.result.structuredContent;
      assert.equal(errEnvelope.ok, false);
      assert.equal(errEnvelope.code, 'INTERNAL_ERROR');
      assert.match(errEnvelope.message, /fake runtime boom|Runtime/);
      assert.ok(Array.isArray(errEnvelope.nextActions) && errEnvelope.nextActions.length > 0);
      assert.equal(errReply.result.isError, undefined);
      assert.equal(JSON.parse(errReply.result.content[0].text).ok, false);
    } finally {
      await session.close();
    }
  });
});

test('协议错误矩阵：未初始化 -32600、未知方法 -32601、未知工具/坏参数 -32602、重复 initialize -32600、非法 JSON -32700、batch -32600、坏 jsonrpc -32600', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openRaw({ runtime, token });
    try {
      // 未初始化时 ping 允许，tools/list 拒绝。
      const pingBeforeInit = await session.request('ping', {});
      assert.deepEqual(pingBeforeInit.result, {});
      const listBeforeInit = await session.request('tools/list', {});
      assert.equal(listBeforeInit.error.code, -32600);
      assert.match(listBeforeInit.error.message, /尚未初始化/);

      await initializeRaw(session);
      session.notify('notifications/initialized');

      const duplicateInit = await session.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'again', version: '1' },
      });
      assert.equal(duplicateInit.error.code, -32600);

      const unknownMethod = await session.request('resources/list', {});
      assert.equal(unknownMethod.error.code, -32601);

      const unknownTool = await session.request('tools/call', { name: 'cp_nope', arguments: {} });
      assert.equal(unknownTool.error.code, -32602);
      assert.match(unknownTool.error.message, /未知工具/);

      const missingName = await session.request('tools/call', {});
      assert.equal(missingName.error.code, -32602);
      assert.match(missingName.error.message, /name/);

      const badArgs = await session.request('tools/call', { name: 'cp_status', arguments: [] });
      assert.equal(badArgs.error.code, -32602);
      assert.match(badArgs.error.message, /arguments/);

      // 解析错误 -32700：id 为 null。
      const parseError = await sendAndWaitForReply(
        session,
        '{this is not json',
        (message) => message?.error?.code === -32700,
      );
      assert.ok(parseError.id === null || parseError.id === undefined, '解析错误响应不应伪造 id');
      assertSchema(CORE.JSONRPCErrorResponseSchema ?? CORE.JSONRPCErrorSchema, parseError, 'ParseError');

      // JSON-RPC batch 已从 MCP 移除：-32600。
      const batchError = await sendAndWaitForReply(
        session,
        '[{"jsonrpc":"2.0","id":901,"method":"ping"}]',
        (message) => message?.error?.code === -32600,
      );
      assert.ok(batchError.id === null || batchError.id === undefined);
      assert.match(batchError.error.message, /批量/);

      // 缺 jsonrpc：-32600，带原 id。
      const badVersion = await sendAndWaitForReply(
        session,
        '{"id":902,"method":"ping"}',
        (message) => message?.id === 902,
      );
      assert.equal(badVersion.error.code, -32600);
      assert.match(badVersion.error.message, /jsonrpc/);

      // 未知通知（无 id）必须静默忽略，不得产生响应。
      session.notify('notifications/whatever', { x: 1 });
      await sleep(200);
      assert.equal(session.messages.some((entry) => entry.message?.method === 'notifications/whatever'), false);

      // 之后 session 仍健康。
      assert.deepEqual((await session.request('ping', {})).result, {});
    } finally {
      await session.close();
    }
  });
});

test('取消（wire 级）：notifications/cancelled 后无 JSON-RPC 响应，底层 Runtime 请求被 abort，server 继续服务', async () => {
  await withFixture(async ({ runtime, token }) => {
    runtime.enqueue('GET /api/health', { delayMs: 1500 });
    const session = await openRaw({ runtime, token });
    try {
      await initializeRaw(session);
      session.notify('notifications/initialized');

      const callId = 700;
      session.sendRaw(JSON.stringify({
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name: 'cp_status', arguments: {} },
      }));
      assert.ok(
        await runtime.waitForRequest((item) => item.path === '/api/health'),
        '取消前请求应已到达 Runtime',
      );

      session.notify('notifications/cancelled', { requestId: callId, reason: 'verifier-cancel' });
      await sleep(700);

      const response = session.messages.find(
        (entry) => entry.message?.id === callId && (entry.message.result !== undefined || entry.message.error !== undefined),
      );
      assert.equal(response, undefined, '被取消请求不得写 JSON-RPC 响应');
      assert.ok(runtime.abortedPaths.includes('/api/health'), '取消应 abort 底层 HTTP 请求');
      await waitFor(
        () => /收到取消通知/.test(session.stderrText()) && /已中止执行/.test(session.stderrText()),
        { timeoutMs: 3000, label: 'stderr 取消日志' },
      );
      assert.equal(session.child.exitCode, null, '取消不应导致 server 退出');

      const ping = await session.request('ping', {});
      assert.deepEqual(ping.result, {});

      const exit = await session.close();
      assert.equal(exit.code, 0);
    } finally {
      await session.close();
    }
  });
});

test('token 不泄漏 + stdout 纯净：完整会话（含错误路径）后 stdout 全为 JSON-RPC 且不含 token，stderr 也不含', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openRaw({ runtime, token });
    try {
      await initializeRaw(session);
      session.notify('notifications/initialized');
      await session.request('tools/list', {});
      await session.request('tools/call', { name: 'cp_status', arguments: {} });
      await session.request('tools/call', { name: 'cp_unknown_tool', arguments: {} });
      await session.request('resources/list', {});
      await sleep(100);
      assert.deepEqual(session.nonJsonLines, [], 'stdout 出现非 JSON 行');

      const stdoutText = session.messages.map((entry) => entry.raw).join('\n');
      assert.ok(!stdoutText.includes(token.token), 'stdout 含 token');
      assert.ok(!session.stderrText().includes(token.token), 'stderr 含 token');
      const exit = await session.close();
      assert.equal(exit.code, 0);
    } finally {
      await session.close();
    }
  });
});

test('CLI 边界：--print-config/--version/--help 只写 stderr、stdout 为空且不输出 token；配置错误退出码 2', async () => {
  const token = createTokenFile();
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };

    const printConfig = await execFileAsync(
      process.execPath,
      [SERVER_PATH, '--token-file', token.file, '--print-config'],
      { env, encoding: 'utf8' },
    );
    assert.equal(printConfig.stdout, '', '--print-config 不得写 stdout');
    const config = JSON.parse(printConfig.stderr);
    assert.equal(config.tokenSource, 'token-file');
    assert.ok(!config.token);
    assert.ok(!printConfig.stderr.includes(token.token), '--print-config 输出含 token');
    assert.equal(config.approvalMode, 'chat');

    const version = await execFileAsync(
      process.execPath,
      [SERVER_PATH, '--token-file', token.file, '--version'],
      { env, encoding: 'utf8' },
    );
    assert.equal(version.stdout, '');
    assert.match(version.stderr, /circuitpilot-agent 0\.1\.0/);

    const help = await execFileAsync(
      process.execPath,
      [SERVER_PATH, '--token-file', token.file, '--help'],
      { env, encoding: 'utf8' },
    );
    assert.equal(help.stdout, '');
    assert.match(help.stderr, /MCP stdio server/);
    assert.ok(!help.stderr.includes(token.token));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [SERVER_PATH, '--token-file', token.file, '--max-result-bytes', '1'],
        { env, encoding: 'utf8' },
      ),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /配置错误/);
        assert.ok(!error.stderr.includes(token.token));
        return true;
      },
    );
  } finally {
    token.cleanup();
  }
});
