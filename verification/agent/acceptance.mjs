#!/usr/bin/env node
/**
 * CircuitPilot Agent MVP 验收脚本（task-19，独立验证）。
 *
 * 跑 10 条验收场景，逐条打印 PASS/FAIL 与证据（fake Runtime 的请求记录 + 关键结果字段）。
 * 不连接真实 EDA / 真实 CircuitPilot Runtime / DSH 宿主，不读写 ~/Library：
 * 全部使用 127.0.0.1 随机端口 + mkdtemp 临时目录。
 *
 * 运行：node verification/agent/acceptance.mjs
 * 退出码：0 = 全部 PASS；1 = 存在 FAIL。
 */
import assert from 'node:assert/strict';
import { createToolHarness, startFakeRuntime, waitJob, jsonBytes, BAD_TOKEN, AGENT_TOKEN_HEADER, TEST_TOKEN, DESIGN_PLAN_HASH, MAX_RESULT_BYTES } from './fake-runtime.mjs';

const scenarios = [];
const scenario = (title, fn) => scenarios.push({ title, fn });

async function withRuntime(fn) {
  const runtime = await startFakeRuntime();
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

async function withHarness(options, fn) {
  const harness = await createToolHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

function requestEvidence(runtime) {
  const counts = new Map();
  for (const record of runtime.requests) {
    const key = `${record.method} ${record.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}×${count}`).join(', ');
}

function requireOk(result, label) {
  assert.ok(result && result.ok === true, `${label} 应成功：${JSON.stringify({ code: result?.code, message: result?.message })}`);
  return result;
}

/* ------------------------------------------------------------------ */
/* 10 条验收场景                                                       */
/* ------------------------------------------------------------------ */

scenario('健康公开 + 受保护路由要求 agent token（无/坏 token → 401）', async ({ evidence }) => {
  await withRuntime(async (runtime) => {
    const health = await fetch(`${runtime.url}/api/health`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    evidence(`GET /api/health（无 token）→ ${health.status} ok=${healthBody.ok}`);

    const noToken = await fetch(`${runtime.url}/api/project-state`);
    assert.equal(noToken.status, 401);
    evidence(`GET /api/project-state（无 token）→ ${noToken.status}`);

    const badToken = await fetch(`${runtime.url}/api/project-state`, { headers: { [AGENT_TOKEN_HEADER]: BAD_TOKEN } });
    const badBody = await badToken.json();
    assert.equal(badToken.status, 401);
    assert.equal(badBody.error.code, 'AGENT_TOKEN_INVALID');
    assert.ok(!JSON.stringify(badBody).includes(BAD_TOKEN));
    evidence(`GET /api/project-state（坏 token）→ ${badToken.status} ${badBody.error.code}`);
  });
});

scenario('cp_status 汇总 Runtime/项目/EDA/写门禁/问题/证据', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    const status = requireOk(await harness.callTool('cp_status'), 'cp_status');
    assert.equal(status.data.runtime.reachable, true);
    assert.equal(status.data.project.name, '独立验证板');
    assert.equal(status.data.eda.online, true);
    assert.equal(status.data.writeGate.available, true);
    assert.equal(status.data.issues.open, 2);
    assert.ok(status.evidence.length >= 1);
    evidence(`summary: ${status.summary}`);
    evidence(`data: project=${status.data.project.name} eda=${status.data.eda.online} paused=${status.data.writeGate.paused} issues.open=${status.data.issues.open} evidence=${status.evidence.length}`);
    evidence(`请求: ${requestEvidence(harness.runtime)}`);
  });
});

scenario('cp_design_plan 返回 planHash/ready/missing 与审批提示（只出计划，不执行）', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    const plan = requireOk(await harness.callTool('cp_design_plan', {
      mode: 'normalize',
      plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }, { type: 'net.label' }], assumptions: ['使用当前页'] },
    }), 'cp_design_plan');
    assert.equal(plan.data.planHash, DESIGN_PLAN_HASH);
    assert.equal(plan.data.ready, true);
    assert.equal(plan.data.counts.operations, 2);
    assert.ok(plan.nextActions.some((action) => /批准/.test(action)));
    assert.equal(harness.runtime.count('POST /api/design/execute'), 0, '计划不得执行写操作');
    evidence(`planHash=${plan.data.planHash.slice(0, 12)}… ready=${plan.data.ready} operations=${plan.data.counts.operations}`);
    evidence(`nextActions[0]: ${plan.nextActions[0]}`);
    evidence(`请求: ${requestEvidence(harness.runtime)}`);
  });
});

scenario('cp_approve 必须 confirm=true + 本会话 planHash；approvalToken 不返回给模型', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    const noConfirm = await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH });
    assert.equal(noConfirm.code, 'INVALID_ARGUMENTS');
    evidence(`cp_approve(缺 confirm) → ${noConfirm.code}`);

    await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } });
    const falseConfirm = await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: false });
    assert.equal(falseConfirm.code, 'CONFIRM_REQUIRED');
    evidence(`cp_approve(confirm=false) → ${falseConfirm.code}`);

    const unknown = await harness.callTool('cp_approve', { planHash: 'f'.repeat(64), confirm: true });
    assert.equal(unknown.code, 'PLAN_NOT_KNOWN');
    evidence(`cp_approve(未知 planHash) → ${unknown.code}`);

    const approve = requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'cp_approve');
    const runtimeToken = harness.runtime.approvalRecords()[0].approvalToken;
    assert.ok(runtimeToken.startsWith('rt-approval-'));
    assert.equal(approve.data.approvalTokenExposed, false);
    assert.ok(!JSON.stringify(approve).includes(runtimeToken), 'approvalToken 不得出现在工具结果');
    evidence(`approvalId=${approve.data.approvalId} targetFingerprint=${approve.data.targetFingerprint} windowId=${approve.data.windowId}`);
    evidence(`approvalTokenExposed=${approve.data.approvalTokenExposed}，Runtime 侧 token 未出现在工具结果`);
  });
});

scenario('设计闭环：plan → approve → execute → cp_job 完成，证据与结果结构可核对', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    requireOk(await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] } }), 'plan');
    requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'approve');
    const execute = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-design-1' }), 'execute');
    assert.match(execute.data.jobId, /^job_/);
    const waited = await waitJob(harness, execute.data.jobId, 2000);
    const result = waited.data.job.result;
    assert.equal(waited.data.job.state, 'done');
    assert.equal(result.ok, true);
    assert.equal(result.data.execution.id, 'design-exec-1');
    assert.equal(result.data.execution.state, 'completed');
    assert.equal(result.evidence.length, 1);
    assert.ok(result.evidence[0].kind === 'design-execution' && result.evidence[0].ref.includes('/api/design/executions/'));
    evidence(`jobId=${execute.data.jobId} state=${waited.data.job.state} execution=${result.data.execution.id}/${result.data.execution.state}`);
    evidence(`evidence=${JSON.stringify(result.evidence)}`);
    const body = harness.runtime.calls('POST /api/design/execute')[0].body;
    assert.equal(body.approvalToken.length > 0, true);
    assert.ok(body.plan && typeof body.plan === 'object', '执行必须使用插件缓存计划');
    evidence(`execute 请求绑定: approvalToken=${String(body.approvalToken).slice(0, 12)}… targetFingerprint=${body.targetFingerprint} windowId=${body.windowId}`);
    evidence(`执行计划来自插件缓存（模型无法替换）：plan keys=${Object.keys(body.plan).join('/')}`);
  });
});

scenario('approvalToken 一次性：Runtime 拒绝重放（409 APPROVAL_CONSUMED）；插件拒绝复用已用批准', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    // 运行时层：直接 HTTP 重放同一个 approvalToken
    const approve = await harness.client.post('/api/design/approve', {
      plan: { kind: 'simple-control-board' },
      planHash: DESIGN_PLAN_HASH,
      confirm: true,
      targetFingerprint: 'tf-design-verify',
      windowId: 'win-verify-1',
    });
    assert.equal(approve.ok, true);
    const approvalToken = approve.data.approval.token;
    const first = await harness.client.post('/api/design/execute', { plan: { kind: 'simple-control-board' }, approvalToken, targetFingerprint: 'tf-design-verify', windowId: 'win-verify-1' });
    assert.equal(first.ok, true);
    const replay = await harness.client.post('/api/design/execute', { plan: { kind: 'simple-control-board' }, approvalToken, targetFingerprint: 'tf-design-verify', windowId: 'win-verify-1' });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 409);
    assert.equal(replay.code, 'APPROVAL_CONSUMED');
    evidence(`Runtime 重放: 第 1 次 ${first.status} ok=${first.ok}，第 2 次 ${replay.status} ${replay.code}`);

    // 插件层：execute 后批准标记已用，换 requestId 再执行仍被拒绝
    requireOk(await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } }), 'plan');
    requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'approve');
    const execute = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-once-1' }), 'execute');
    await waitJob(harness, execute.data.jobId, 2000);
    const reuse = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-once-2' });
    assert.equal(reuse.ok, false);
    assert.equal(reuse.code, 'APPROVAL_REQUIRED');
    evidence(`插件复用已用批准 → ${reuse.code}（消息：${reuse.message}）`);
  });
});

scenario('requestId 幂等：同 id 只执行一次并返回同一 job', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    requireOk(await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } }), 'plan');
    requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'approve');
    const first = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-idem-1' }), 'execute#1');
    await waitJob(harness, first.data.jobId, 2000);
    const second = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-idem-1' }), 'execute#2');
    assert.equal(second.data.deduped, true);
    assert.equal(second.data.jobId, first.data.jobId);
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1);
    evidence(`jobId=${first.data.jobId}（两次相同），deduped=${second.data.deduped}`);
    evidence(`POST /api/design/execute 实际次数=${harness.runtime.count('POST /api/design/execute')}`);
  });
});

scenario('16KB 结果裁剪：truncated=true 且 JSON 字节数 ≤ 16384（保留证据下钻入口）', async ({ evidence }) => {
  await withHarness({}, async (harness) => {
    harness.runtime.setLargeEvidence(50, 1200);
    const evidenceResult = requireOk(await harness.callTool('cp_evidence', { limit: 50 }), 'cp_evidence');
    const bytes = jsonBytes(evidenceResult);
    assert.equal(evidenceResult.truncated, true);
    assert.ok(bytes <= MAX_RESULT_BYTES, `${bytes} > ${MAX_RESULT_BYTES}`);
    assert.ok(evidenceResult.evidence.length >= 1);
    evidence(`原始证据 50 条 → 结果 ${bytes} 字节（上限 ${MAX_RESULT_BYTES}），truncated=${evidenceResult.truncated}`);
    evidence(`裁剪后仍保留 evidence 引用 ${evidenceResult.evidence.length} 条，如 ${evidenceResult.evidence[0].kind}`);
  });
});

scenario('超时：job state=timeout、mayHaveTakenEffect=true、不自动重试写操作', async ({ evidence }) => {
  await withHarness({ config: { jobTimeoutMs: 120, requestTimeoutMs: 5000 } }, async (harness) => {
    harness.runtime.enqueue('POST /api/design/execute', { delayMs: 700, body: { ok: true, execution: { id: 'late-exec', state: 'completed' } } });
    requireOk(await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } }), 'plan');
    requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'approve');
    const submitted = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-timeout-1' }), 'execute');
    const waited = await waitJob(harness, submitted.data.jobId, 2000);
    assert.equal(waited.data.job.state, 'timeout');
    assert.equal(waited.data.job.mayHaveTakenEffect, true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1);
    evidence(`jobId=${submitted.data.jobId} state=${waited.data.job.state} mayHaveTakenEffect=${waited.data.job.mayHaveTakenEffect}`);
    evidence(`nextActions[0]: ${waited.nextActions[0]}`);
    evidence(`超时后 POST /api/design/execute 次数=${harness.runtime.count('POST /api/design/execute')}（未重试）`);
  });
});

scenario('安全边界：签核/设置/POST write-gate → 403 AGENT_ROUTE_FORBIDDEN；写暂停 409 有可执行 nextActions', async ({ evidence }) => {
  await withRuntime(async (runtime) => {
    const forbidden = [
      ['POST', '/api/production/signoff'],
      ['POST', '/api/write-gate'],
      ['GET', '/api/settings'],
    ];
    for (const [method, path] of forbidden) {
      const response = await fetch(`${runtime.url}${path}`, {
        method,
        headers: { [AGENT_TOKEN_HEADER]: TEST_TOKEN, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ paused: false, confirm: true }) : undefined,
      });
      const body = await response.json();
      assert.equal(response.status, 403, `${method} ${path} 应 403`);
      assert.equal(body.error.code, 'AGENT_ROUTE_FORBIDDEN');
      assert.equal(runtime.handledCount(`${method} ${path}`), 0, '越权请求不得进入业务处理');
      evidence(`${method} ${path} → 403 ${body.error.code}（业务 handler 调用 0 次）`);
    }

    runtime.setGate({ paused: true, reason: '验收写暂停' });
    const harness = await createToolHarness({ runtime });
    try {
      const status = requireOk(await harness.callTool('cp_status'), 'cp_status');
      assert.equal(status.data.writeGate.paused, true);
      assert.ok(status.nextActions.some((action) => /写入已暂停/.test(action)));
      evidence(`cp_status: paused=${status.data.writeGate.paused} nextActions=${JSON.stringify(status.nextActions.slice(0, 2))}`);

      requireOk(await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } }), 'plan');
      requireOk(await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true }), 'approve');
      const execute = requireOk(await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'accept-paused-1' }), 'execute');
      const waited = await waitJob(harness, execute.data.jobId, 2000);
      const result = waited.data.job.result;
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WRITE_PAUSED');
      assert.ok(result.nextActions.length > 0);
      assert.equal(harness.runtime.count('POST /api/design/execute'), 1);
      evidence(`cp_execute → ${result.code}，nextActions=${JSON.stringify(result.nextActions)}`);
      evidence(`写暂停后 execute 请求次数=${harness.runtime.count('POST /api/design/execute')}（未重试）`);
    } finally {
      harness.jobs.cancelAll();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 运行器                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = new Date();
  console.log('CircuitPilot Agent MVP 独立验收（fake Runtime；不连真实 EDA / DSH / 4178）');
  console.log(`时间: ${startedAt.toISOString()}  场景数: ${scenarios.length}`);
  console.log('='.repeat(78));
  let passed = 0;
  const failures = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const item = scenarios[index];
    const id = String(index + 1).padStart(2, '0');
    const evidence = [];
    const started = Date.now();
    try {
      await item.fn({ evidence: (line) => evidence.push(line) });
      passed += 1;
      console.log(`[${id}] PASS  ${item.title}  (${Date.now() - started}ms)`);
      for (const line of evidence) console.log(`         证据: ${line}`);
    } catch (error) {
      failures.push({ id, title: item.title, error });
      console.log(`[${id}] FAIL  ${item.title}  (${Date.now() - started}ms)`);
      for (const line of evidence) console.log(`         证据: ${line}`);
      console.log(`         失败: ${error?.message ?? error}`);
      if (error?.stack) console.log(error.stack.split('\n').slice(1, 3).map((line) => `         ${line.trim()}`).join('\n'));
    }
    console.log('-'.repeat(78));
  }
  const failed = failures.length;
  const verdict = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`结果: ${passed}/${scenarios.length} PASS，${failed} FAIL → 验收结论 ${verdict}`);
  if (failed > 0) {
    console.log('失败场景:');
    for (const failure of failures) console.log(`  - [${failure.id}] ${failure.title}: ${failure.error?.message ?? failure.error}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('验收脚本自身异常:', error);
  process.exitCode = 1;
});
