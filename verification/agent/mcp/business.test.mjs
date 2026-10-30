/**
 * task-22 独立复验（三）：业务边界（经官方 MCP Client 端到端）。
 *  - 16KB 结果裁剪（cp_evidence 大索引）；
 *  - approvalMode=off：cp_approve / cp_execute 直接拒绝且不触达 Runtime；
 *  - chat 模式：无批准/未知 planHash/confirm 缺失或 false/缺 requestId 的拒绝；
 *  - Runtime 500 → 业务错误 envelope（协议层仍是 success，不设 isError）；
 *  - 写门禁暂停 → cp_execute job 结果 WRITE_PAUSED，且同 requestId 幂等不重放；
 *  - 无效 agent token → AGENT_TOKEN_INVALID envelope，且不泄漏 token。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDshSdk } from './dsh-sdk.mjs';
import { startFakeRuntime, DESIGN_PLAN_HASH } from './fake-runtime.mjs';
import {
  createTokenFile,
  startMcpClient,
  assertSchema,
} from './mcp-session.mjs';

const sdk = await loadDshSdk();
const CORE = sdk.core;

test.after(async () => {
  await sdk.cleanup();
});

async function withFixture(fn, { serverArgs = [] } = {}) {
  const runtime = await startFakeRuntime();
  const token = createTokenFile({ token: runtime.token });
  try {
    return await fn({ runtime, token });
  } finally {
    token.cleanup();
    await runtime.close();
  }
}

async function openClient({ runtime, token, serverArgs = [] }) {
  return startMcpClient({ sdk, runtime, tokenFile: token.file, serverArgs });
}

/** 调用工具并返回 { result, envelope }，断言协议层是合法 CallToolResult。 */
async function callTool(session, name, args) {
  const result = await session.client.callTool({ name, arguments: args });
  assertSchema(CORE.CallToolResultSchema, result, `CallToolResult(${name})`);
  assert.equal(result.isError, undefined, `${name} 不应设置 isError`);
  const envelope = JSON.parse(result.content[0].text);
  assert.deepEqual(envelope, result.structuredContent);
  return { result, envelope };
}

function assertFailEnvelope(envelope, code, label = code) {
  assert.equal(envelope.ok, false, `${label}: 应为失败 envelope`);
  assert.equal(envelope.code, code, `${label}: code 应为 ${code}，实际 ${envelope.code}`);
  assert.equal(typeof envelope.message, 'string');
  assert.ok(envelope.message.length > 0);
  assert.ok(Array.isArray(envelope.nextActions) && envelope.nextActions.length > 0, `${label}: 应带 nextActions`);
}

test('16KB 裁剪：cp_evidence 大索引返回 truncated=true，结构化结果 ≤ 16384 字节', async () => {
  await withFixture(async ({ runtime, token }) => {
    runtime.setLargeEvidence(50, 1200);
    const session = await openClient({ runtime, token });
    try {
      const { envelope } = await callTool(session, 'cp_evidence', { limit: 50 });
      const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
      assert.equal(envelope.truncated, true, '大结果必须标记 truncated=true');
      assert.ok(bytes <= 16384, `envelope 字节数 ${bytes} 超过 16384`);
      assert.equal(envelope.data?._truncated, true, '裁剪后 data 应为降级预览');
      assert.ok(Array.isArray(envelope.nextActions) && envelope.nextActions.length > 0);
      assert.ok(envelope.summary.length > 0);
      assert.ok(envelope.evidence.length < 50, '证据列表应被裁剪');
      assert.ok(runtime.count('GET /api/evidence/index') === 1);
    } finally {
      await session.close();
    }
  });
});

test('approvalMode=off：cp_approve / cp_execute 拒绝（APPROVAL_MODE_DISABLED），且不触达 Runtime', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token, serverArgs: ['--approval-mode', 'off'] });
    try {
      const approve = await callTool(session, 'cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
      assertFailEnvelope(approve.envelope, 'APPROVAL_MODE_DISABLED');

      const execute = await callTool(session, 'cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-mcp-off-1' });
      assertFailEnvelope(execute.envelope, 'APPROVAL_MODE_DISABLED');

      assert.equal(runtime.count('POST /api/design/approve'), 0, 'off 模式不应触达 Runtime 审批路由');
      assert.equal(runtime.count('POST /api/design/execute'), 0, 'off 模式不应触达 Runtime 执行路由');
      assert.equal(runtime.requests.length, 0, `off 模式拒绝不应访问 Runtime：${runtime.requests.map((item) => item.key)}`);
      assert.equal(runtime.counters.designApprovals, 0);
      assert.equal(runtime.counters.designExecutes, 0);
    } finally {
      await session.close();
    }
  });
});

test('chat 模式拒绝：未知 planHash、confirm=false、缺 confirm、无批准执行、缺 requestId', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      // 未知 planHash（没有先生成计划）
      const unknownPlan = await callTool(session, 'cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
      assertFailEnvelope(unknownPlan.envelope, 'PLAN_NOT_KNOWN');

      // confirm=false
      const notConfirmed = await callTool(session, 'cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: false });
      assertFailEnvelope(notConfirmed.envelope, 'CONFIRM_REQUIRED');

      // 缺 confirm（inputSchema 必填校验）
      const missingConfirm = await callTool(session, 'cp_approve', { planHash: DESIGN_PLAN_HASH });
      assertFailEnvelope(missingConfirm.envelope, 'INVALID_ARGUMENTS');

      // 无批准直接执行
      const noApproval = await callTool(session, 'cp_execute', {
        planHash: DESIGN_PLAN_HASH,
        requestId: 'req-mcp-chat-no-approval',
      });
      assertFailEnvelope(noApproval.envelope, 'APPROVAL_REQUIRED');

      // 缺 requestId（inputSchema 必填校验）
      const missingRequestId = await callTool(session, 'cp_execute', { planHash: DESIGN_PLAN_HASH });
      assertFailEnvelope(missingRequestId.envelope, 'INVALID_ARGUMENTS');

      assert.equal(runtime.counters.designApprovals, 0);
      assert.equal(runtime.counters.designExecutes, 0);
      assert.equal(runtime.count('POST /api/design/approve'), 0);
      assert.equal(runtime.count('POST /api/design/execute'), 0);
    } finally {
      await session.close();
    }
  });
});

test('Runtime 500：cp_status 返回业务错误 envelope（code/message/nextActions），协议层仍为 success', async () => {
  await withFixture(async ({ runtime, token }) => {
    runtime.enqueue('GET /api/project-state', {
      status: 500,
      body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'fake runtime boom' } },
    });
    const session = await openClient({ runtime, token });
    try {
      const { result, envelope } = await callTool(session, 'cp_status', {});
      assertFailEnvelope(envelope, 'INTERNAL_ERROR');
      assert.match(envelope.message, /fake runtime boom|Runtime/);
      assert.equal(result.isError, undefined);
      assert.equal(runtime.calls('GET /api/project-state')[0].status, 500);
    } finally {
      await session.close();
    }
  });
});

test('写门禁暂停：cp_execute job 结果为 WRITE_PAUSED；同 requestId 幂等返回同一 job，不重放执行', async () => {
  await withFixture(async ({ runtime, token }) => {
    const session = await openClient({ runtime, token });
    try {
      const plan = await callTool(session, 'cp_design_plan', {
        mode: 'normalize',
        plan: { title: 'mcp-verify', operations: [{ type: 'wire.create' }] },
      });
      assert.equal(plan.envelope.ok, true);
      const planHash = plan.envelope.data.planHash;
      assert.equal(planHash, DESIGN_PLAN_HASH);
      assert.equal(runtime.count('POST /api/design/plan'), 1);

      const approve = await callTool(session, 'cp_approve', { planHash, confirm: true });
      assert.equal(approve.envelope.ok, true);
      assert.equal(approve.envelope.data.approvalTokenExposed, false);
      assert.equal(typeof approve.envelope.data.approvalId, 'string');
      assert.ok(!JSON.stringify(approve.envelope).includes('rt-approval-mcp'), '批准 token 不得出现在工具结果');

      runtime.setGate({ paused: true, reason: 'verifier pause' });
      const execute = await callTool(session, 'cp_execute', { planHash, requestId: 'req-mcp-paused-1' });
      assert.equal(execute.envelope.ok, true);
      const jobId = execute.envelope.data.jobId;
      assert.equal(typeof jobId, 'string');

      const waited = await callTool(session, 'cp_job', { action: 'wait', jobId, timeoutMs: 5000 });
      assert.equal(waited.envelope.ok, true);
      assert.equal(waited.envelope.data.timedOut, false);
      const snapshot = waited.envelope.data.job;
      assert.equal(snapshot.state, 'done');
      assertFailEnvelope(snapshot.result, 'WRITE_PAUSED');
      assert.equal(runtime.count('POST /api/design/execute'), 1);
      assert.equal(runtime.counters.designExecutes, 0, '被门禁拒绝，不应计数为已执行');

      // 同 requestId 重复提交：返回同一 job（幂等），不得再次触达 Runtime 执行路由。
      const replay = await callTool(session, 'cp_execute', { planHash, requestId: 'req-mcp-paused-1' });
      assert.equal(replay.envelope.ok, true);
      assert.equal(replay.envelope.data.deduped, true);
      assert.equal(replay.envelope.data.jobId, jobId);
      assert.equal(runtime.count('POST /api/design/execute'), 1, '同 requestId 不得重复执行');
    } finally {
      await session.close();
    }
  });
});

test('无效 agent token：业务错误 envelope AGENT_TOKEN_INVALID，且 stdout/stderr/envelope 均不泄漏 token', async () => {
  await withFixture(async ({ runtime }) => {
    // token 文件里的 token 与 Runtime 期望的不一致 → 401。
    const wrongToken = createTokenFile();
    const session = await startMcpClient({ sdk, runtime, tokenFile: wrongToken.file });
    try {
      const { result, envelope } = await callTool(session, 'cp_status', {});
      assertFailEnvelope(envelope, 'AGENT_TOKEN_INVALID');
      assert.equal(result.isError, undefined);
      const serialized = JSON.stringify(envelope);
      assert.ok(!serialized.includes(wrongToken.token), '工具结果泄漏 token');
      assert.ok(!session.stderrText().includes(wrongToken.token), 'stderr 泄漏 token');
      assert.equal(runtime.count('GET /api/health'), 1);
      assert.equal(runtime.count('GET /api/project-state'), 1);
    } finally {
      await session.close();
      wrongToken.cleanup();
    }
  });
});
