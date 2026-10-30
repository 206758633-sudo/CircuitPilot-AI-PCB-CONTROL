/**
 * task-22 独立复验（一）：用 DSH 内置官方 MCP client（@modelcontextprotocol/client@2.2.0）
 * 的 Client + StdioClientTransport 直连 agent/mcp-server.mjs，验证：
 *  - auto 版本协商：sibling probe 发 server/discover → -32601 → 回退 legacy initialize；
 *  - tools/list 恰好 12 个工具，且过官方 ListToolsResultSchema；
 *  - cp_status 经 fake Runtime 返回结构化 CallToolResult，且过官方 CallToolResultSchema；
 *  - ping；
 *  - 未知工具/坏参数 -32602、重复 initialize -32600、不支持方法 -32601；
 *  - 官方 AbortSignal 取消：无响应、服务端收到 notifications/cancelled、底层 HTTP 请求被 abort；
 *  - token 不泄漏到 stdout/stderr/wire 日志。
 *
 * 只写 verification/agent/mcp/**；不依赖作者单测结论。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDshSdk } from './dsh-sdk.mjs';
import { startFakeRuntime, AGENT_TOKEN_HEADER } from './fake-runtime.mjs';
import {
  createTokenFile,
  startMcpClient,
  readWireLog,
  waitFor,
  assertSchema,
  EXPECTED_TOOL_NAMES,
} from './mcp-session.mjs';

const sdk = await loadDshSdk();
const CORE = sdk.core;

test.after(async () => {
  await sdk.cleanup();
});

let fixtureSeq = 0;

/** 每个用例独立 fake Runtime + 临时 token 文件；结束统一清理。 */
async function withFixture(fn, { serverArgs = [], env = {} } = {}) {
  fixtureSeq += 1;
  const runtime = await startFakeRuntime();
  const token = createTokenFile({ token: runtime.token });
  try {
    return await fn({ runtime, token, wireLogPath: join(token.dir, 'wire.jsonl') });
  } finally {
    token.cleanup();
    await runtime.close();
  }
}

async function openClient({ runtime, token }) {
  const session = await startMcpClient({ sdk, runtime, tokenFile: token.file });
  return session;
}

test('auto 协商：官方 Client 先用 server/discover 探测得到 -32601，再回退 initialize（wire 日志取证）', async () => {
  await withFixture(async ({ runtime, token, wireLogPath }) => {
    const session = await startMcpClient({ sdk, runtime, tokenFile: token.file, wireLogPath });
    try {
      const wireText = readFileSync(wireLogPath, 'utf8');
      const wire = readWireLog(wireLogPath);
      assert.ok(wire.length >= 4, `wire 日志条目过少：${wire.length}`);

      const discoverIn = wire.find((entry) => entry.dir === 'in' && entry.message?.method === 'server/discover');
      assert.ok(discoverIn, 'wire 日志应有 server/discover 请求（现代协议探测）');
      const discoverOut = wire.find(
        (entry) => entry.dir === 'out' && entry.message?.id === discoverIn.message.id && entry.message?.error,
      );
      assert.ok(discoverOut, 'server/discover 应有错误响应');
      assert.equal(discoverOut.message.error.code, -32601, 'legacy 信号必须是 -32601');
      assert.equal(discoverOut.pid, discoverIn.pid, 'discover 的请求/响应应来自同一 probe 进程');
      assert.ok(
        /legacy|2025-era|server\/discover/i.test(discoverOut.message.error.message),
        `discover 错误信息应说明 legacy：${discoverOut.message.error.message}`,
      );

      const initIn = wire.find((entry) => entry.dir === 'in' && entry.message?.method === 'initialize');
      assert.ok(initIn, 'wire 日志应有 initialize 请求');
      assert.notEqual(initIn.pid, discoverIn.pid, 'initialize 应发生在独立的正式会话进程（probe 不是会话进程）');
      const initOut = wire.find(
        (entry) => entry.dir === 'out' && entry.message?.id === initIn.message.id && entry.message?.result,
      );
      assert.ok(initOut, 'initialize 应有 result');
      assertSchema(CORE.InitializeResultSchema, initOut.message.result, 'InitializeResult');
      assert.equal(initOut.message.result.protocolVersion, '2025-11-25');

      const discoverOutIndex = wire.indexOf(discoverOut);
      const initInIndex = wire.indexOf(initIn);
      assert.ok(discoverOutIndex < initInIndex, '必须先完成 discover(-32601) 再 initialize');

      // 客户端视角：协商结果、serverInfo、capabilities。
      assert.equal(session.client.getNegotiatedProtocolVersion(), '2025-11-25');
      assert.ok(sdk.supportedProtocolVersions.includes(session.client.getNegotiatedProtocolVersion()));
      assert.deepEqual(session.client.getServerVersion(), { name: 'circuitpilot-agent', version: '0.1.0' });
      assert.deepEqual(session.client.getServerCapabilities(), { tools: { listChanged: false } });

      // 初始化结果里的 instructions 必须遵守 DSH maxInstructionBytes 默认 32KB。
      const instructions = initOut.message.result.instructions;
      assert.equal(typeof instructions, 'string');
      assert.ok(Buffer.byteLength(instructions, 'utf8') <= 32768, 'instructions 超过 32768 字节');
      assert.ok(instructions.includes('CircuitPilot'), 'instructions 应包含 CircuitPilot 说明');

      // 不泄漏：token 不出现在 wire 日志（含 server stdout 行）与 stderr。
      assert.ok(!wireText.includes(token.token), 'wire 日志包含 token');
      assert.ok(!session.stderrText().includes(token.token), 'stderr 包含 token');
    } finally {
      await session.close();
    }
  });
});

test('tools/list：恰好 12 个工具、名称/输入 schema 合法、过官方 ListToolsResultSchema', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      const result = await session.client.listTools();
      assertSchema(CORE.ListToolsResultSchema, result, 'ListToolsResult');
      assert.equal(result.tools.length, 12, `工具数应为 12，实际 ${result.tools.length}`);
      assert.deepEqual(result.tools.map((tool) => tool.name), [...EXPECTED_TOOL_NAMES]);
      assert.equal(new Set(result.tools.map((tool) => tool.name)).size, 12, '工具名重复');

      for (const tool of result.tools) {
        assert.match(tool.name, /^cp_[a-z_]+$/, `工具名不合法：${tool.name}`);
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 0, `工具 ${tool.name} 缺 description`);
        assert.equal(tool.inputSchema?.type, 'object', `工具 ${tool.name} inputSchema.type 必须是 object`);
        assert.equal(typeof tool.inputSchema?.properties, 'object', `工具 ${tool.name} inputSchema 缺 properties`);
        assert.ok(tool.inputSchema.properties !== null, `工具 ${tool.name} properties 不应为 null`);
        if (tool.outputSchema !== undefined) {
          assert.equal(tool.outputSchema.type, 'object', `工具 ${tool.name} outputSchema.type 必须是 object`);
        }
      }

      const statusTool = result.tools.find((tool) => tool.name === 'cp_status');
      assert.ok(statusTool.annotations, 'cp_status 应带 annotations（只读提示）');
      assert.equal(statusTool.annotations.readOnlyHint, true);
    } finally {
      await session.close();
    }
  });
});

test('cp_status：经 fake Runtime 返回结构化结果，过官方 CallToolResultSchema，token 头正确', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      const result = await session.client.callTool({ name: 'cp_status', arguments: {} });
      assertSchema(CORE.CallToolResultSchema, result, 'CallToolResult');
      assert.equal(result.isError, undefined, '业务工具结果不应设置 isError（业务错误走 envelope）');
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      const envelope = JSON.parse(result.content[0].text);
      assert.deepEqual(envelope, result.structuredContent, 'content[0].text 必须与 structuredContent 同源');
      assert.equal(envelope.ok, true);
      assert.equal(typeof envelope.summary, 'string');
      assert.ok(envelope.summary.length > 0);
      assert.equal(envelope.data.project.id, 'p-mcp-verify');
      assert.equal(envelope.data.project.name, 'MCP独立验证板');
      assert.equal(envelope.data.project.stage, 'PCB');
      assert.equal(envelope.data.project.projectCount, 1);
      assert.equal(envelope.data.eda.online, true);
      assert.equal(envelope.data.writeGate.paused, false);

      // fake Runtime 收到的是真实工具调用序列，且带合法 agent token。
      assert.equal(runtime.count('GET /api/health'), 1);
      assert.equal(runtime.count('GET /api/project-state'), 1);
      assert.equal(runtime.count('GET /api/write-gate'), 1);
      const stateReq = runtime.calls('GET /api/project-state')[0];
      assert.equal(stateReq.headers[AGENT_TOKEN_HEADER], runtime.token);
    } finally {
      await session.close();
    }
  });
});

test('ping：官方 Client 的 ping 请求返回空 result', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      const result = await session.client.ping();
      assert.deepEqual(result, {});
    } finally {
      await session.close();
    }
  });
});

test('未知工具 / 坏参数：JSON-RPC -32602，且连接保持可用', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      await assert.rejects(
        session.client.callTool({ name: 'cp_not_a_tool', arguments: {} }),
        (error) => {
          assert.equal(error.code, -32602);
          assert.match(String(error.message), /未知工具/);
          return true;
        },
      );
      await assert.rejects(
        session.client.callTool({ name: 'cp_status', arguments: 'not-an-object' }),
        (error) => {
          assert.equal(error.code, -32602);
          assert.match(String(error.message), /arguments/);
          return true;
        },
      );
      // 协议级错误不应击穿会话。
      assert.deepEqual(await session.client.ping(), {});
      // 未知工具不应触发任何 Runtime 请求。
      assert.equal(runtime.requests.length, 0, `未知工具不应访问 Runtime，实际 ${runtime.requests.map((r) => r.key)}`);
    } finally {
      await session.close();
    }
  });
});

test('重复 initialize：-32600，且会话仍可继续使用', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      await assert.rejects(
        session.client.request({
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'second-initialize', version: '1' },
          },
        }),
        (error) => {
          assert.equal(error.code, -32600);
          assert.match(String(error.message), /initialize 只能发送一次/);
          return true;
        },
      );
      assert.deepEqual(await session.client.ping(), {});
      const tools = await session.client.listTools();
      assert.equal(tools.tools.length, 12);
    } finally {
      await session.close();
    }
  });
});

test('未实现的能力（resources/list）：-32601 Method not found', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      await assert.rejects(
        session.client.request({ method: 'resources/list', params: {} }),
        (error) => {
          assert.equal(error.code, -32601);
          assert.match(String(error.message), /不支持的方法/);
          return true;
        },
      );
    } finally {
      await session.close();
    }
  });
});

test('取消：官方 AbortSignal → 无 JSON-RPC 响应、notifications/cancelled 送达、底层 Runtime 请求被 abort', async () => {
  await withFixture(async ({ runtime, token, wireLogPath }) => {
    runtime.enqueue('GET /api/health', { delayMs: 1500 });
    const session = await startMcpClient({ sdk, runtime, tokenFile: token.file, wireLogPath });
    try {
      const controller = new AbortController();
      const callPromise = session.client.callTool(
        { name: 'cp_status', arguments: {} },
        { signal: controller.signal },
      );

      const reached = await runtime.waitForRequest((item) => item.path === '/api/health');
      assert.ok(reached, '取消前 cp_status 应已到达 Runtime（GET /api/health）');
      controller.abort(new Error('verifier-cancel'));

      await assert.rejects(callPromise, (error) => {
        assert.ok(error, 'abort 后 callTool 必须 reject');
        return true;
      });

      assert.ok(await runtime.waitForAbort('/api/health', 2000), '取消应穿透并 abort 底层 Runtime HTTP 请求');
      await waitFor(
        () => /收到取消通知/.test(session.stderrText()) && /已中止执行/.test(session.stderrText()),
        { timeoutMs: 3000, label: 'server stderr 取消日志' },
      );

      const wire = readWireLog(wireLogPath);
      const callIn = wire.find((entry) => entry.dir === 'in' && entry.message?.method === 'tools/call');
      assert.ok(callIn, 'wire 日志应有 tools/call 请求');
      const callId = callIn.message.id;
      const cancelIn = wire.find(
        (entry) => entry.dir === 'in'
          && entry.message?.method === 'notifications/cancelled'
          && entry.message?.params?.requestId === callId,
      );
      assert.ok(cancelIn, `wire 日志应有针对 requestId=${callId} 的 notifications/cancelled`);
      const responseForCall = wire.find(
        (entry) => entry.dir === 'out'
          && entry.message?.id === callId
          && (entry.message.result !== undefined || entry.message.error !== undefined),
      );
      assert.equal(responseForCall, undefined, '被取消的请求不得出现 JSON-RPC 响应');

      // 取消不应杀死 server：后续请求仍然可用。
      assert.deepEqual(await session.client.ping(), {});
    } finally {
      await session.close();
    }
  });
});

test('token 不泄漏：官方 Client + wire 代理全流程后，token 不出现在 server stdout/stderr', async () => {
  await withFixture(async ({ runtime, token, wireLogPath }) => {
    const session = await startMcpClient({ sdk, runtime, tokenFile: token.file, wireLogPath });
    try {
      await session.client.listTools();
      const status = await session.client.callTool({ name: 'cp_status', arguments: {} });
      assert.equal(status.structuredContent.ok, true);
      assert.equal(runtime.count('GET /api/health'), 1);
    } finally {
      await session.close();
    }
    const wireText = readFileSync(wireLogPath, 'utf8');
    const stdoutLines = readWireLog(wireLogPath)
      .filter((entry) => entry.dir === 'out')
      .map((entry) => entry.raw);
    assert.ok(stdoutLines.length > 0);
    assert.ok(!wireText.includes(token.token), 'wire 日志（含 server stdout）含 token');
    assert.ok(!stdoutLines.join('\n').includes(token.token), 'server stdout 含 token');
    assert.ok(!session.stderrText().includes(token.token), 'server stderr 含 token');
  });
});
