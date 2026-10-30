/**
 * CircuitPilot Agent MVP 契约验证（task-19，独立验证，不写生产代码）。
 *
 * 用 fake-runtime.mjs 提供的本地随机端口 HTTP 服务 + 真实插件 lib，验证
 * docs/agent/agent-contract.md 的可执行契约：
 *  - 12 个 cp_* 工具目录、参数校验、只读 happy path、统一结果 envelope；
 *  - plan → approve → execute → job 闭环与 approvalToken 不暴露；
 *  - maxResultBytes（默认 16KB）裁剪、requestId 幂等、超时 mayHaveTakenEffect 不自动重试；
 *  - 401/409/500 错误映射与 token 脱敏。
 *
 * 运行：node --test "verification/agent/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeRuntime, createToolHarness, jsonBytes, waitJob, TEST_TOKEN, DESIGN_PLAN_HASH, PCB_PLAN_HASH, MAX_RESULT_BYTES } from './fake-runtime.mjs';
import { TOOL_NAMES, TOOL_ROUTES } from '../../plugin/dsh-circuitpilot/lib/tools.mjs';

async function withHarness(options, fn) {
  const harness = await createToolHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

function assertEnvelope(result, label) {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), `${label}: 结果必须是对象`);
  assert.equal(typeof result.ok, 'boolean', `${label}: ok 必须是 boolean`);
  if (result.ok) {
    // 契约 §5：成功结果 { ok, summary, data, evidence, nextActions, truncated }
    assert.equal(typeof result.summary, 'string', `${label}: 成功结果 summary 必须是字符串`);
  } else {
    // 契约 §5：错误统一 { ok:false, code, message, nextActions }（无 summary）
    assert.equal(typeof result.code, 'string', `${label}: 失败结果必须带 code`);
    assert.equal(typeof result.message, 'string', `${label}: 失败结果必须带 message`);
  }
  assert.ok('data' in result, `${label}: 必须包含 data 字段`);
  assert.ok(Array.isArray(result.evidence), `${label}: evidence 必须是数组`);
  assert.ok(Array.isArray(result.nextActions), `${label}: nextActions 必须是数组`);
  assert.equal(typeof result.truncated, 'boolean', `${label}: truncated 必须是 boolean`);
  assert.doesNotThrow(() => JSON.stringify(result), `${label}: 结果必须 JSON 可序列化`);
}

test('工具目录：12 个 cp_* 工具，名称/类型/inputSchema/execute 稳定', async () => {
  const expectedTypes = {
    cp_status: 'read',
    cp_project_context: 'read',
    cp_issues: 'read',
    cp_evidence: 'read',
    cp_knowledge: 'read',
    cp_design_plan: 'plan',
    cp_pcb_plan: 'plan',
    cp_approve: 'approve',
    cp_execute: 'execute',
    cp_validation: 'execute',
    cp_export: 'execute',
    cp_job: 'read',
  };
  await withHarness({}, async (harness) => {
    assert.equal(TOOL_NAMES.length, 12);
    assert.deepEqual(harness.tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.deepEqual(Object.keys(TOOL_ROUTES).sort(), [...TOOL_NAMES].sort());
    for (const tool of harness.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20, `${tool.name}: description 过短`);
      assert.equal(tool.type, expectedTypes[tool.name], `${tool.name}: type 不符合契约`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name}: inputSchema 必须是 object`);
      assert.equal(typeof tool.execute, 'function', `${tool.name}: 缺少 execute`);
    }
    // 写/长任务都必须要求 requestId（schema.required 或 handler 校验）
    for (const name of ['cp_execute', 'cp_validation', 'cp_export']) {
      const schema = harness.byName[name].inputSchema;
      assert.ok(schema.required.includes('requestId'), `${name}: 必须要求 requestId`);
    }
    // 批准必须要求 planHash + confirm
    const approveSchema = harness.byName.cp_approve.inputSchema;
    assert.ok(approveSchema.required.includes('planHash'));
    assert.ok(approveSchema.required.includes('confirm'));
    assert.equal(harness.runtime.requests.length, 0, '只构造工具不应产生 Runtime 请求');
  });
});

test('参数校验：必填/类型/枚举/范围错误返回 INVALID_ARGUMENTS，且不发网络请求', async () => {
  await withHarness({}, async (harness) => {
    const cases = [
      ['cp_approve', {}, '缺 planHash/confirm'],
      ['cp_approve', { planHash: 'c'.repeat(64), confirm: 'yes' }, 'confirm 类型错误'],
      ['cp_execute', { planHash: 'c'.repeat(64) }, '缺 requestId'],
      ['cp_export', { requestId: 'req-1' }, '缺 confirm'],
      ['cp_pcb_plan', {}, '缺 plan'],
      ['cp_validation', {}, '缺 requestId'],
      ['cp_validation', { requestId: 'req-1', targets: ['erc', 'bogus'] }, 'targets 枚举非法'],
      ['cp_job', {}, '缺 action'],
      ['cp_issues', { limit: 999 }, 'limit 超上限'],
      ['cp_evidence', { digest: 42 }, 'digest 类型错误'],
      ['cp_design_plan', { mode: 'ai', requirements: 123 }, 'requirements 类型错误'],
    ];
    for (const [name, args, label] of cases) {
      const result = await harness.callTool(name, args);
      assertEnvelope(result, `${name} ${label}`);
      assert.equal(result.ok, false, `${name} ${label}: 应被拒绝`);
      assert.equal(result.code, 'INVALID_ARGUMENTS', `${name} ${label}: 应返回 INVALID_ARGUMENTS，实际 ${result.code}`);
    }
    assert.equal(harness.runtime.requests.length, 0, '参数校验失败不得发请求');
  });
});

test('read happy path：cp_status / cp_project_context 汇总真实 HTTP 数据，每个请求都带 agent token 头', async () => {
  await withHarness({}, async (harness) => {
    const status = await harness.callTool('cp_status');
    assertEnvelope(status, 'cp_status');
    assert.equal(status.ok, true);
    assert.match(status.summary, /在线/);
    assert.equal(status.data.runtime.reachable, true);
    assert.equal(status.data.runtime.version, '0.1.0-verify');
    assert.equal(status.data.project.name, '独立验证板');
    assert.equal(status.data.project.stage, 'PCB');
    assert.equal(status.data.eda.online, true);
    assert.equal(status.data.writeGate.available, true);
    assert.equal(status.data.writeGate.paused, false);
    assert.equal(status.data.issues.open, 2, '只统计 open/investigating');
    assert.equal(status.data.issues.bySeverity.error, 1);
    assert.equal(status.evidence.length, 2);
    assert.ok(status.nextActions.length > 0);

    const ctx = await harness.callTool('cp_project_context');
    assertEnvelope(ctx, 'cp_project_context');
    assert.equal(ctx.ok, true);
    assert.equal(ctx.data.project.name, '独立验证板');
    assert.equal(ctx.data.counts.requirements, 3);
    assert.equal(ctx.data.project.components, 2);
    assert.equal(ctx.data.edaWorkspace.boardName, '独立验证板');

    const requestKeys = harness.runtime.requests.map((item) => `${item.method} ${item.path}`);
    assert.ok(requestKeys.includes('GET /api/health'));
    assert.ok(requestKeys.includes('GET /api/project-state'));
    assert.ok(requestKeys.includes('GET /api/write-gate'));
    assert.ok(requestKeys.includes('GET /api/eda/workspaces/current'));
    assert.ok(requestKeys.includes('GET /api/issue-state'));
    assert.ok(requestKeys.includes('GET /api/evidence/index'));
    for (const record of harness.runtime.requests) {
      assert.equal(record.headers['x-circuitpilot-agent-token'], TEST_TOKEN, `${record.method} ${record.path}: 必须携带 agent token 头`);
    }
  });
});

test('cp_issues / cp_evidence / cp_knowledge：过滤、排序、citation、RAG 降级不冒充结果', async () => {
  await withHarness({}, async (harness) => {
    const issues = await harness.callTool('cp_issues');
    assertEnvelope(issues, 'cp_issues');
    assert.equal(issues.ok, true);
    assert.equal(issues.data.items.length, 2);
    assert.equal(issues.data.items[0].id, 'iss-error', 'error 应排在 warning 前');
    assert.deepEqual(issues.data.items.map((item) => item.status).sort(), ['investigating', 'open']);
    const warnings = await harness.callTool('cp_issues', { severity: 'warning' });
    assert.equal(warnings.data.items.length, 1);
    assert.equal(warnings.data.items[0].id, 'iss-warn');

    const index = await harness.callTool('cp_evidence', { limit: 10 });
    assertEnvelope(index, 'cp_evidence(index)');
    assert.equal(index.ok, true);
    assert.equal(index.data.entries.length, 2);
    assert.equal(index.data.summary.entries, 2);
    assert.equal(index.evidence.length, 2);

    const found = await harness.callTool('cp_evidence', { kind: 'schematic-erc', digest: 'verify-digest-001' });
    assert.equal(found.ok, true);
    assert.equal(found.data.entry.digest, 'verify-digest-001');
    assert.equal(found.evidence[0].digest, 'verify-digest-001');

    const execution = await harness.callTool('cp_evidence', { executionId: 'design-exec-9' });
    assert.equal(execution.ok, true);
    assert.equal(execution.data.executionId, 'design-exec-9');
    assert.equal(execution.evidence[0].kind, 'design-execution-evidence');

    const knowledge = await harness.callTool('cp_knowledge', { query: 'DRC 间距' });
    assertEnvelope(knowledge, 'cp_knowledge');
    assert.equal(knowledge.ok, true);
    assert.equal(knowledge.data.approvedEntries.length, 1, 'candidate 条目不能当依据');
    assert.equal(knowledge.data.approvedEntries[0].id, 'k-1');
    assert.equal(knowledge.data.ragCitations.length, 1);
    assert.equal(knowledge.data.ragCitations[0].score, 0.91);
    assert.equal(knowledge.data.ragError, null);
    assert.equal(knowledge.evidence.length, 1, '知识引用必须带 citation evidence');

    // RAG 不可用时如实降级：主结果仍成功，但标注 ragError，不能假装有 citation。
    harness.runtime.enqueue('POST /api/rag/query', {
      status: 500,
      body: { ok: false, error: { code: 'RAG_UNAVAILABLE', message: 'RAG 未就绪' } },
    });
    const degraded = await harness.callTool('cp_knowledge', { query: '间距' });
    assertEnvelope(degraded, 'cp_knowledge(RAG 500)');
    assert.equal(degraded.ok, true);
    assert.equal(degraded.data.ragCitations, null);
    assert.equal(degraded.data.ragError.code, 'RAG_UNAVAILABLE');
    assert.match(degraded.summary, /RAG 不可用/);
  });
});

test('结果 envelope：12 个工具在成功/拒绝路径都返回统一 6 字段结构', async () => {
  await withHarness({}, async (harness) => {
    const unknownPlanHash = 'd'.repeat(64);
    const invocations = [
      ['cp_status', {}],
      ['cp_project_context', {}],
      ['cp_issues', {}],
      ['cp_evidence', {}],
      ['cp_knowledge', {}],
      ['cp_design_plan', { mode: 'normalize', plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] } }],
      ['cp_pcb_plan', { plan: { board: { layers: 4 }, operations: [{ type: 'line.create' }] } }],
      ['cp_approve', { planHash: unknownPlanHash, confirm: true }],
      ['cp_execute', { planHash: unknownPlanHash, requestId: 'req-envelope-exec' }],
      ['cp_validation', { requestId: 'req-envelope-val', targets: ['erc', 'gates'] }],
      ['cp_export', { requestId: 'req-envelope-export', confirm: true }],
      ['cp_job', { action: 'list' }],
    ];
    for (const [name, args] of invocations) {
      const result = await harness.callTool(name, args);
      assertEnvelope(result, name);
      if (!result.ok) assert.equal(typeof result.code, 'string', `${name}: 失败必须带 code`);
    }
    // 计划类工具必须真的返回 planHash（没有 planHash 就不允许进入批准流程）
    const plan = await harness.callTool('cp_design_plan', {
      plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }, { type: 'component.create' }, { type: 'net.label' }] },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.data.planHash, DESIGN_PLAN_HASH);
    assert.equal(plan.data.ready, true);
    assert.equal(plan.data.counts.operations, 3);
    assert.match(plan.summary, /planHash/);
  });
});

test('设计闭环：plan → chat approve（绑定校验）→ execute → job done；approval 只按真实形态返回', async () => {
  await withHarness({}, async (harness) => {
    const plan = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] } });
    assert.equal(plan.ok, true);
    assert.equal(plan.data.planHash, DESIGN_PLAN_HASH);
    assert.equal(plan.data.ready, true);
    assert.equal(plan.data.counts.operations, 1);
    assert.ok(plan.data.plan, '计划必须保留完整 plan 供批准/执行');
    assert.ok(plan.nextActions.some((action) => /批准/.test(action)));

    const approve = await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
    assertEnvelope(approve, 'cp_approve');
    assert.equal(approve.ok, true);
    assert.equal(approve.data.approvalId, 'approval-design-1');
    assert.equal(approve.data.planHash, DESIGN_PLAN_HASH);
    assert.equal(approve.data.targetFingerprint, 'tf-design-verify');
    assert.equal(approve.data.windowId, 'win-verify-1');
    assert.equal(approve.data.approvalTokenExposed, false);
    assert.equal(harness.runtime.count('GET /api/design/context'), 1, '批准前必须读取目标上下文');
    const approveBody = harness.runtime.calls('POST /api/design/approve')[0].body;
    assert.equal(approveBody.confirm, true);
    assert.equal(approveBody.planHash, DESIGN_PLAN_HASH);
    assert.equal(approveBody.approvalMode, 'chat');
    assert.equal(approveBody.targetFingerprint, 'tf-design-verify');
    assert.equal(approveBody.windowId, 'win-verify-1');
    assert.ok(approveBody.plan, 'Runtime 审批审计需要拿到被批准的计划');

    const approvalRecords = harness.runtime.approvalRecords();
    assert.equal(approvalRecords.length, 1);
    const runtimeApprovalToken = approvalRecords[0].approvalToken;
    assert.ok(runtimeApprovalToken.startsWith('rt-approval-'));
    assert.equal(approvalRecords[0].used, false);

    const execute = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-design-loop' });
    assertEnvelope(execute, 'cp_execute');
    assert.equal(execute.ok, true);
    assert.match(execute.data.jobId, /^job_/);
    assert.equal(execute.data.mayHaveTakenEffect, true, '执行是写操作，超时/失败都可能已生效');

    const waited = await waitJob(harness, execute.data.jobId, 2000);
    assert.equal(waited.ok, true);
    assert.equal(waited.data.job.state, 'done');
    assert.equal(waited.data.job.result.ok, true);
    assert.equal(waited.data.job.result.data.execution.id, 'design-exec-1');
    assert.equal(waited.data.job.result.data.execution.state, 'completed');
    assert.equal(waited.data.job.result.evidence.length, 1);
    assert.equal(waited.data.job.result.evidence[0].kind, 'design-execution');
    // job 内异步执行：等 job 到终态后再核对实际发出的 execute 请求体
    const executeBody = harness.runtime.calls('POST /api/design/execute')[0].body;
    assert.equal(executeBody.approvalToken, runtimeApprovalToken, '执行必须使用插件内存里的 approvalToken');
    assert.equal(executeBody.targetFingerprint, 'tf-design-verify');
    assert.equal(executeBody.windowId, 'win-verify-1');
    assert.ok(executeBody.plan, '执行计划来自插件缓存，不是模型参数');
    assert.equal(harness.runtime.approvalRecords()[0].used, true, 'approvalToken 在 Runtime 侧应为一次性');

    // PCB 闭环：审批响应没有顶层 planHash，插件必须用 bindings.planHash 绑定
    const pcbPlan = await harness.callTool('cp_pcb_plan', { plan: { board: { layers: 4 }, operations: [{ type: 'line.create' }, { type: 'via.create' }] } });
    assert.equal(pcbPlan.ok, true);
    assert.equal(pcbPlan.data.planHash, PCB_PLAN_HASH);
    assert.equal(pcbPlan.data.counts.operations, 2);
    const pcbApprove = await harness.callTool('cp_approve', { planHash: PCB_PLAN_HASH, confirm: true });
    assert.equal(pcbApprove.ok, true, 'pcb 审批应通过 bindings.planHash 绑定');
    const pcbExecute = await harness.callTool('cp_execute', { planHash: PCB_PLAN_HASH, requestId: 'req-pcb-loop' });
    assert.equal(pcbExecute.ok, true);
    const pcbWaited = await waitJob(harness, pcbExecute.data.jobId, 2000);
    assert.equal(pcbWaited.data.job.result.data.execution.id, 'pcb-exec-1');
  });
});

test('结果裁剪：超过 maxResultBytes 时 truncated=true 且 JSON 字节数不超限；自定义上限同样生效', async () => {
  await withHarness({}, async (harness) => {
    harness.runtime.setLargeEvidence(50, 1200);
    const result = await harness.callTool('cp_evidence', { limit: 50 });
    assertEnvelope(result, 'cp_evidence(大结果)');
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true, '超过 16KB 必须标记 truncated');
    assert.ok(jsonBytes(result) <= MAX_RESULT_BYTES, `结果 ${jsonBytes(result)} 字节超过 ${MAX_RESULT_BYTES}`);
    assert.ok(result.evidence.length >= 1, '裁剪后仍必须保留证据下钻入口');

    // 自定义更小上限：normalizeToolConfig 会 clamp 到 >=1024
    const small = await createToolHarness({ runtime: harness.runtime, config: { maxResultBytes: 2048 } });
    try {
      const smallResult = await small.callTool('cp_evidence', { limit: 50 });
      assert.equal(smallResult.truncated, true);
      assert.ok(jsonBytes(smallResult) <= 2048, `结果 ${jsonBytes(smallResult)} 字节超过 2048`);
      assert.equal(small.config.maxResultBytes, 2048);
    } finally {
      small.jobs.cancelAll();
    }
  });
});

test('requestId 幂等：同 id 返回同一 job，写/长任务只执行一次', async () => {
  await withHarness({}, async (harness) => {
    await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } });
    await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });

    const first = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-idem-write' });
    assert.equal(first.ok, true);
    await waitJob(harness, first.data.jobId, 2000);
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1);

    const second = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-idem-write' });
    assert.equal(second.ok, true);
    assert.equal(second.data.deduped, true);
    assert.equal(second.data.jobId, first.data.jobId, '同 requestId 必须返回同一 job');
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1, '同 requestId 不得重复执行');
    assert.equal(harness.runtime.approvalRecords()[0].used, true, '批准只用一次；去重不消耗第二次批准');

    const valFirst = await harness.callTool('cp_validation', { requestId: 'req-idem-val', targets: ['erc'] });
    await waitJob(harness, valFirst.data.jobId, 2000);
    const valSecond = await harness.callTool('cp_validation', { requestId: 'req-idem-val', targets: ['erc'] });
    assert.equal(valSecond.data.deduped, true);
    assert.equal(valSecond.data.jobId, valFirst.data.jobId);
    assert.equal(harness.runtime.counters.ercRuns, 1, '重复 requestId 不得重复运行 ERC');
  });
});

test('超时：job state=timeout、mayHaveTakenEffect=true、禁止自动重试且 HTTP 只调用一次', async () => {
  await withHarness({ config: { jobTimeoutMs: 120, requestTimeoutMs: 5000 } }, async (harness) => {
    harness.runtime.enqueue('POST /api/design/execute', {
      delayMs: 700,
      body: { ok: true, execution: { id: 'design-exec-late', state: 'completed', planHash: DESIGN_PLAN_HASH } },
    });
    await harness.callTool('cp_design_plan', { plan: { kind: 'simple-control-board' } });
    await harness.callTool('cp_approve', { planHash: DESIGN_PLAN_HASH, confirm: true });
    const submitted = await harness.callTool('cp_execute', { planHash: DESIGN_PLAN_HASH, requestId: 'req-timeout-write' });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.data.mayHaveTakenEffect, true);

    const waited = await waitJob(harness, submitted.data.jobId, 2000);
    assert.equal(waited.ok, true);
    assert.equal(waited.data.job.state, 'timeout');
    assert.equal(waited.data.job.mayHaveTakenEffect, true, '写操作超时必须标记 mayHaveTakenEffect');
    assert.equal(waited.data.job.error.code, 'JOB_TIMEOUT');
    assert.ok(waited.nextActions.some((action) => /不要?自动重试|禁止自动重试/.test(action)), '超时 nextActions 必须明确禁止自动重试');

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(harness.runtime.count('POST /api/design/execute'), 1, '超时后不得自动重发写请求');
  });
});

test('错误映射与脱敏：401/409/500 有可执行 nextActions；响应体里的 agent token 被脱敏；超大响应拒绝', async () => {
  await withHarness({ clientOptions: { maxResponseBytes: 1024 } }, async (harness) => {
    const { client, runtime } = harness;

    runtime.enqueue('GET /api/project-state', { status: 401, body: {} });
    const unauthorized = await client.get('/api/project-state');
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.code, 'AGENT_TOKEN_INVALID');
    assert.ok(unauthorized.nextActions.length >= 2, '401 必须给出可执行下一步');

    runtime.enqueue('GET /api/project-state', { status: 409, body: { ok: false, error: { code: 'WRITE_PAUSED', message: '写入已暂停' } } });
    const conflict = await client.get('/api/project-state');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.code, 'WRITE_PAUSED');
    assert.ok(conflict.nextActions.some((action) => /不要自动重试写操作/.test(action)), '409 必须提示不要自动重试');

    runtime.enqueue('GET /api/issue-state', { status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
    const serverError = await client.get('/api/issue-state');
    assert.equal(serverError.ok, false);
    assert.equal(serverError.code, 'INTERNAL_ERROR');
    assert.ok(serverError.nextActions.some((action) => /日志/.test(action)), '5xx 必须提示查看日志');

    runtime.enqueue('GET /api/evidence/index', {
      status: 500,
      body: { ok: false, error: { code: 'LEAK', message: `Runtime 内部错误，收到令牌 ${TEST_TOKEN}` } },
    });
    const leaked = await client.get('/api/evidence/index');
    assert.equal(leaked.ok, false);
    assert.ok(!JSON.stringify(leaked).includes(TEST_TOKEN), '错误结果不得包含 agent token');
    assert.match(leaked.message, /\[REDACTED\]/, '错误 message 中的 agent token 必须被替换');

    runtime.enqueue('GET /api/evidence/index', { jsonBytes: 4096 });
    const tooLarge = await client.get('/api/evidence/index');
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.code, 'RESPONSE_TOO_LARGE');
    assert.ok(!JSON.stringify(tooLarge).includes('xxxxxxxxxx'), '超大响应不得原样带回模型');
  });
});
