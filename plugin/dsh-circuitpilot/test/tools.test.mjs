import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCircuitPilotTools,
  DESIGN_LOOP_MAX_ITERATIONS,
  DESIGN_LOOP_MODEL_MAX_BYTES,
  DEFAULT_TOOL_CONFIG,
  TOOL_NAMES,
  normalizeToolConfig,
  summarizeIssues,
} from '../lib/tools.mjs';
import {
  APPROVAL_TOKEN,
  DESIGN_HASH,
  NOW_ISO,
  PCB_HASH,
  TEST_TOKEN,
  createDefaultRouter,
  makeHarness,
  waitJob,
} from './helpers.mjs';

function foreachNoToken(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(TEST_TOKEN), false, '工具输出不得包含 agent token');
  assert.equal(text.includes('cpa_'), false, '工具输出不得包含 agent token 形态');
}

async function withHarness(options, fn) {
  const harness = await makeHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

test('工具目录：13 个 cp_* 工具，schema/description/execute 完整且名字稳定', async () => {
  const harness = await makeHarness({ handler: createDefaultRouter().handler });
  try {
    assert.deepEqual(harness.tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.equal(TOOL_NAMES.length, 13);
    assert.equal(harness.tools.length, 13);
    assert.equal(TOOL_NAMES.at(-1), 'cp_design_loop');
    assert.equal(harness.byName.cp_design_loop.type, 'read');
    for (const tool of harness.tools) {
      assert.match(tool.name, /^cp_[a-z_]+$/);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20, `${tool.name} description 太短`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.execute, 'function');
      assert.ok(['read', 'plan', 'approve', 'execute'].includes(tool.type));
    }
    assert.equal(normalizeToolConfig({ approvalMode: 'bogus' }).approvalMode, 'chat');
    assert.equal(normalizeToolConfig({ approvalMode: 'off' }).approvalMode, 'off');
    assert.equal(normalizeToolConfig({ maxResultBytes: 999999 }).maxResultBytes, 262144);
    assert.equal(normalizeToolConfig({ maxResultBytes: 1 }).maxResultBytes, 1024);
  } finally {
    await harness.close();
  }
});

test('cp_status：汇总项目/EDA/写门禁/问题/证据，返回 JSON 可序列化对象', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.match(result.summary, /测试控制板/);
    assert.equal(result.data.project.id, 'p-test-1');
    assert.equal(result.data.project.name, '测试控制板');
    assert.equal(result.data.eda.online, true);
    assert.equal(result.data.eda.workspace.pcbUuid, 'pcb1');
    assert.equal(result.data.writeGate.paused, false);
    assert.equal(result.data.issues.open, 2);
    assert.equal(result.data.evidence.entries, 2);
    assert.ok(result.evidence.length >= 2);
    assert.equal(result.evidence[0].kind, 'drc-report');
    assert.ok(result.evidence[0].digest);
    assert.doesNotThrow(() => JSON.stringify(result));
  });
});

test('cp_status：Runtime 不可达时返回 ok:false + 可执行 nextActions', async () => {
  const harness = await makeHarness({ handler: createDefaultRouter().handler });
  await harness.runtime.close();
  const result = await harness.callTool('cp_status');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNTIME_UNREACHABLE');
  assert.ok(result.nextActions.length > 0);
  assert.match(result.nextActions.join(' '), /启动 CircuitPilot/);
});

test('cp_status：写暂停/EDA 离线时给出停止写操作提示', async () => {
  const handler = async (call) => {
    if (call.path === '/api/write-gate') return { ok: true, gate: { paused: true, sessionPaused: false, reason: '主线维护', actor: 'user' } };
    if (call.path === '/api/eda/workspaces/current') return [503, { ok: false, error: { code: 'BRIDGE_NOT_FOUND', message: '未发现EasyEDA Bridge' } }];
    const router = createDefaultRouter();
    return router.handler(call);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true);
    assert.equal(result.data.writeGate.paused, true);
    assert.equal(result.data.eda.online, false);
    assert.ok(result.nextActions.some((item) => /写入已暂停/.test(item)));
    assert.ok(result.nextActions.some((item) => /嘉立创EDA/.test(item)));
  });
});

test('cp_project_context：项目统计 + EDA 绑定 + 问题摘要', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context');
    assert.equal(result.ok, true);
    assert.equal(result.data.project.projectCount, 1);
    assert.equal(result.data.counts.requirements, 2);
    assert.equal(result.data.counts.components, 1);
    assert.equal(result.data.edaWorkspace.schematicUuid, 'sch1');
    assert.equal(result.data.issues.open, 2);
  });
});

test('cp_project_context：includeAllProjects=false 不额外请求 /api/projects', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context');
    assert.equal(result.ok, true);
    assert.equal(result.data.projects, undefined);
    assert.equal(result.data.projectOverview, undefined);
    assert.equal(router.state.projectListCalls, 0);
    assert.equal(router.state.projectStateCalls.length, 0);
    assert.equal(harness.runtime.calls.some((call) => call.path === '/api/projects'), false);
  });
});

test('cp_project_context：includeAllProjects=true 聚合多项目/多板（每项目 ≤20 板）且只读', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context', { includeAllProjects: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.project.id, 'p-test-1');
    assert.deepEqual(result.data.projectOverview, { total: 4, returned: 4, partial: false, errors: [] });
    assert.equal(result.data.projects.length, 4);

    const p1 = result.data.projects.find((item) => item.id === 'p-test-1');
    assert.equal(p1.name, '测试控制板');
    assert.equal(p1.stage, 'PCB');
    assert.equal(p1.archived, false);
    assert.equal(p1.edaBound, true);
    assert.equal(p1.savedAt, NOW_ISO);
    assert.deepEqual(p1.counts, { requirements: 2, components: 1, assets: 0 });
    assert.deepEqual(p1.boards, [
      { name: '主控板', pcbUuid: 'pcb-main', schematicUuid: 'sch-main' },
      { name: '电源板', pcbUuid: 'pcb-power', schematicUuid: 'sch-power' },
    ]);
    assert.deepEqual(Object.keys(p1.boards[0]).sort(), ['name', 'pcbUuid', 'schematicUuid']);

    const p2 = result.data.projects.find((item) => item.id === 'p-2');
    assert.equal(p2.boards.length, 1);
    assert.equal(p2.boards[0].name, '双电池主控板');
    assert.deepEqual(p2.counts, { requirements: 3, components: 2, assets: 1 });

    const many = result.data.projects.find((item) => item.id === 'p-many');
    assert.equal(many.boards.length, 20, '每个项目最多 20 个 board');
    assert.equal(many.boards[0].name, 'Board-1');
    assert.equal(many.boards[19].name, 'Board-20');

    assert.equal(router.state.projectListCalls, 1);
    assert.equal(router.state.projectStateCalls.length, 4);
    assert.ok(harness.runtime.calls.every((call) => call.method === 'GET'), '总览只允许 GET');
    foreachNoToken(result);
  });
});

test('cp_project_context：单项目失败时 partial + error，其它项目仍返回', async () => {
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.method === 'GET' && call.path === '/api/projects/p-2/state') {
      return [500, { ok: false, error: { code: 'PROJECT_STATE_READ_FAILED', message: '状态文件损坏' } }];
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context', { includeAllProjects: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.projectOverview.partial, true);
    assert.equal(result.data.projectOverview.returned, 4);
    assert.deepEqual(result.data.projectOverview.errors, [{
      projectId: 'p-2', code: 'PROJECT_STATE_READ_FAILED', message: '状态文件损坏',
    }]);
    const failed = result.data.projects.find((item) => item.id === 'p-2');
    assert.deepEqual(failed.boards, []);
    assert.equal(failed.counts, null);
    assert.equal(failed.error.code, 'PROJECT_STATE_READ_FAILED');
    const p1 = result.data.projects.find((item) => item.id === 'p-test-1');
    assert.equal(p1.boards.length, 2, '其它项目不受影响');
    assert.ok(result.nextActions.some((item) => /部分项目读取失败/.test(item)));
    foreachNoToken(result);
  });
});

test('cp_project_context：/api/projects 本身失败时仍返回当前项目上下文（overview 标 partial）', async () => {
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.method === 'GET' && call.path === '/api/projects') {
      return [503, { ok: false, error: { code: 'BRIDGE_NOT_FOUND', message: '未发现EasyEDA Bridge' } }];
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context', { includeAllProjects: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.project.id, 'p-test-1');
    assert.deepEqual(result.data.projects, []);
    assert.deepEqual(result.data.projectOverview, {
      total: 0,
      returned: 0,
      partial: true,
      errors: [{ projectId: null, code: 'BRIDGE_NOT_FOUND', message: '未发现EasyEDA Bridge' }],
    });
    assert.match(result.summary, /partial/);
  });
});

test('cp_project_context：projectLimit 生效（截断但仍返回 total）；非法值拒绝', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const limited = await harness.callTool('cp_project_context', { includeAllProjects: true, projectLimit: 2 });
    assert.equal(limited.ok, true);
    assert.equal(limited.data.projects.length, 2);
    assert.deepEqual(limited.data.projectOverview, { total: 4, returned: 2, partial: false, errors: [] });
    assert.deepEqual(router.state.projectStateCalls, ['p-test-1', 'p-2']);
    assert.ok(limited.nextActions.some((item) => /projectLimit/.test(item)));

    for (const projectLimit of [0, 21, 2.5]) {
      const invalid = await harness.callTool('cp_project_context', { includeAllProjects: true, projectLimit });
      assert.equal(invalid.ok, false, `projectLimit=${projectLimit} 应拒绝`);
      assert.equal(invalid.code, 'INVALID_ARGUMENTS');
    }
  });
});

test('cp_project_context：projectId 特殊字符按 encodeURIComponent 请求，输出无 token', async () => {
  const weirdId = 'p 空格/#1';
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.method === 'GET' && call.path === '/api/projects') {
      return {
        ok: true,
        projects: [{ id: weirdId, name: '特殊项目', stage: 'PCB', archived: false, edaBound: true, savedAt: NOW_ISO, requirements: 1, components: 0, assets: 0 }],
      };
    }
    if (call.method === 'GET' && /^\/api\/projects\/[^/]+\/state$/.test(call.path)) {
      const projectId = decodeURIComponent(call.path.split('/')[3]);
      return {
        ok: true,
        projectId,
        state: { schemaVersion: 4, data: [{ itemType: 'Board', name: '主控板', pcb: { uuid: 'pcb-x' }, schematic: { uuid: 'sch-x' } }] },
        savedAt: NOW_ISO,
      };
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_project_context', { includeAllProjects: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.projects[0].id, weirdId);
    assert.equal(result.data.projects[0].boards[0].name, '主控板');
    const stateCall = harness.runtime.calls.find((call) => call.path.endsWith('/state'));
    assert.equal(stateCall.path, `/api/projects/${encodeURIComponent(weirdId)}/state`);
    foreachNoToken(result);
  });
});

test('cp_project_context：schema 暴露多项目只读总览参数（默认关闭、limit 1–20）', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const tool = harness.byName.cp_project_context;
    const props = tool.inputSchema.properties;
    assert.equal(tool.type, 'read');
    assert.equal(props.includeAllProjects.type, 'boolean');
    assert.match(props.includeAllProjects.description, /默认 false/);
    assert.equal(props.projectLimit.type, 'integer');
    assert.equal(props.projectLimit.minimum, 1);
    assert.equal(props.projectLimit.maximum, 20);
    assert.deepEqual(tool.inputSchema.required, []);
    assert.match(tool.description, /includeAllProjects/);
  });
});

test('cp_issues：只返回 open/investigating，按严重度排序并支持筛选', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_issues');
    assert.equal(result.ok, true);
    assert.equal(result.data.totalIssues, 4);
    assert.equal(result.data.open, 2);
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].severity, 'error');
    assert.equal(result.data.bySeverity.error, 1);
    assert.equal(result.data.bySeverity.warning, 1);
    const warningOnly = await harness.callTool('cp_issues', { severity: 'warning' });
    assert.equal(warningOnly.data.items.length, 1);
    assert.equal(warningOnly.data.items[0].id, 'i-open-warning');
  });
});

test('cp_issues：旧 issue-state 只有 title/code-in-id 时也返回可读 summary/code', () => {
  const summary = summarizeIssues({
    issues: [
      { id: 'issue-1792917104847-PCB_DRC_NETLIST_SNAPSHOT_UNRESOLVED', severity: 'medium', status: 'open', title: 'DRC 仍报 1 条项目级 Netlist Error' },
      { id: 'issue-1792917104847-PCB_LED_IFACE_NET_NAMING', severity: 'medium', status: 'open', title: '跨板接口网络命名不一致', summary: '显式 summary 优先' },
    ],
  });
  assert.equal(summary.open, 2);
  assert.equal(summary.items[0].summary, 'DRC 仍报 1 条项目级 Netlist Error');
  assert.equal(summary.items[0].code, 'PCB_DRC_NETLIST_SNAPSHOT_UNRESOLVED');
  assert.equal(summary.items[1].summary, '显式 summary 优先');
  assert.equal(summary.items[1].code, 'PCB_LED_IFACE_NET_NAMING');
});

test('cp_evidence：索引、kind+digest 精确查找、executionId 证据', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const listed = await harness.callTool('cp_evidence', { limit: 5 });
    assert.equal(listed.ok, true);
    assert.equal(listed.data.entries.length, 2);
    assert.equal(listed.data.summary.entries, 2);
    assert.equal(listed.evidence[0].kind, 'drc-report');
    assert.equal(listed.evidence[0].digest, 'drc-old-digest');

    const found = await harness.callTool('cp_evidence', { kind: 'drc-report', digest: 'drc-old-digest' });
    assert.equal(found.ok, true);
    assert.equal(found.data.entry.digest, 'drc-old-digest');
    assert.equal(found.evidence.length, 1);

    const missing = await harness.callTool('cp_evidence', { kind: 'drc-report', digest: 'no-such-digest' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'EVIDENCE_NOT_FOUND');

    const execution = await harness.callTool('cp_evidence', { executionId: 'design-exec-1' });
    assert.equal(execution.ok, true);
    assert.equal(execution.data.executionId, 'design-exec-1');
    assert.equal(execution.evidence[0].kind, 'design-execution-evidence');
  });
});

test('cp_evidence：设计执行不存在时回退 PCB 执行记录（真实写链路证据）', async () => {
  const base = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.path === '/api/design/executions/pcb-exec-1/evidence') {
      return [404, { ok: false, error: { code: 'EXECUTION_NOT_FOUND', message: '执行恢复证据不存在' } }];
    }
    if (call.path === '/api/pcb/executions/pcb-exec-1') {
      return {
        ok: true,
        execution: {
          id: 'pcb-exec-1',
          state: 'completed',
          planHash: 'pcb-plan-hash-1',
          snapshot: { digest: 'snap-1', size: 100 },
          readback: { componentCount: 95, lineCount: 1152 },
          drc: { passed: true, job: { jobId: 'drc-1', count: 0 } },
        },
      };
    }
    return base.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_evidence', { executionId: 'pcb-exec-1' });
    assert.equal(result.ok, true);
    assert.equal(result.data.kind, 'pcb');
    assert.equal(result.data.execution.id, 'pcb-exec-1');
    assert.equal(result.data.execution.drc.passed, true);
    assert.equal(result.evidence[0].kind, 'pcb-execution');
    assert.equal(result.evidence[0].digest, 'pcb-plan-hash-1');
    assert.match(result.summary, /PCB 执行/);
  });
});

test('cp_knowledge：只查 approved 并带 citation；RAG 不可用如实降级', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_knowledge', { query: '间距' });
    assert.equal(result.ok, true);
    assert.equal(result.data.approvedEntries.length, 2);
    assert.equal(result.data.ragCitations.length, 1);
    assert.equal(result.evidence[0].kind, 'knowledge');
    assert.match(result.evidence[0].ref, /^knowledge:k/);
    const router = createDefaultRouter();
    void router;
  });

  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.path === '/api/rag/query') return [500, { ok: false, error: { code: 'RAG_INDEX_MISSING', message: 'rag 索引未建立' } }];
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_knowledge', { query: '间距' });
    assert.equal(result.ok, true);
    assert.equal(result.data.ragCitations, null);
    assert.equal(result.data.ragError.code, 'RAG_INDEX_MISSING');
    assert.match(result.summary, /RAG 不可用/);
  });
});

test('cp_design_plan：normalize/ai 都返回 planHash 并记录计划；缺参数拒绝', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const normalized = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.data.planHash, DESIGN_HASH);
    assert.equal(normalized.data.ready, true);
    assert.equal(normalized.data.counts.operations, 2);
    assert.ok(normalized.data.plan);
    assert.match(normalized.nextActions.join(' '), /cp_approve/);
    assert.equal(router.state.planBodies[0].plan.title, 'x');

    const generated = await harness.callTool('cp_design_plan', { mode: 'ai', requirements: '做一个 4 层控制板' });
    assert.equal(generated.ok, true);
    assert.equal(generated.data.ready, false);
    assert.equal(generated.data.missing.length, 2);
    assert.equal(router.state.planBodies[1].requirement, '做一个 4 层控制板');

    const invalid = await harness.callTool('cp_design_plan', {});
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'INVALID_ARGUMENTS');
  });
});

test('cp_design_plan：Runtime 错误码原样传播', async () => {
  const handler = async () => [409, { ok: false, error: { code: 'PLAN_INCOMPLETE', message: '计划信息不完整' } }];
  await withHarness({ handler }, async (harness) => {
    const result = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PLAN_INCOMPLETE');
    assert.equal(result.status, undefined);
    assert.ok(result.nextActions.length > 0);
  });
});

test('cp_pcb_plan：返回板参数/操作统计；缺 plan 拒绝', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_pcb_plan', { plan: { board: { layers: 4 }, operations: [{ type: 'line.create' }] } });
    assert.equal(result.ok, true);
    assert.equal(result.data.planHash, PCB_HASH);
    assert.equal(result.data.board.layers, 4);
    assert.equal(result.data.counts.operations, 2);
    assert.equal(result.data.expectationDesignators, 2);
    const invalid = await harness.callTool('cp_pcb_plan', {});
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'INVALID_ARGUMENTS');
  });
});

test('approvalMode=off：cp_approve / cp_execute 直接拒绝', async () => {
  await withHarness({ approvalMode: 'off', handler: createDefaultRouter().handler }, async (harness) => {
    const approve = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approve.ok, false);
    assert.equal(approve.code, 'APPROVAL_MODE_DISABLED');
    const execute = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-off-1' });
    assert.equal(execute.ok, false);
    assert.equal(execute.code, 'APPROVAL_MODE_DISABLED');
  });
});

test('cp_approve：confirm 必填 true；未知 planHash 拒绝；不返回 approvalToken', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const missingConfirm = await harness.callTool('cp_approve', { planHash: DESIGN_HASH });
    assert.equal(missingConfirm.ok, false);
    assert.equal(missingConfirm.code, 'INVALID_ARGUMENTS');

    const falseConfirm = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: false });
    assert.equal(falseConfirm.ok, false);
    assert.equal(falseConfirm.code, 'CONFIRM_REQUIRED');

    const unknown = await harness.callTool('cp_approve', { planHash: 'c'.repeat(64), confirm: true });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'PLAN_NOT_KNOWN');

    await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, true);
    assert.equal(approved.data.approvalId, 'approval-design-1');
    assert.equal(approved.data.approvalTokenExposed, false);
    assert.equal(JSON.stringify(approved).includes(APPROVAL_TOKEN), false);
  });
});

test('cp_approve：核对 Runtime approval.bindings，目标/计划哈希不一致或缺 token 一律拒绝', async () => {
  const router = createDefaultRouter();
  const run = async (approvalPayload) => {
    const handler = async (call, ctx) => {
      if (call.path === '/api/design/approve') return { ok: true, approval: approvalPayload };
      return router.handler(call, ctx);
    };
    const harness = await makeHarness({ handler });
    try {
      await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
      return await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    } finally {
      await harness.close();
    }
  };

  const targetDrift = await run({ approvalId: 'apv-1', token: 'secret-token-1', bindings: { planHash: DESIGN_HASH, targetFingerprint: 'tf-other', windowId: 'win-1' }, expiresAt: Date.now() + 60_000 });
  assert.equal(targetDrift.ok, false);
  assert.equal(targetDrift.code, 'APPROVAL_TARGET_MISMATCH');
  assert.equal(JSON.stringify(targetDrift).includes('secret-token-1'), false);

  const windowDrift = await run({ approvalId: 'apv-2', token: 'secret-token-2', bindings: { planHash: DESIGN_HASH, targetFingerprint: 'tf-design-1', windowId: 'win-other' }, expiresAt: Date.now() + 60_000 });
  assert.equal(windowDrift.ok, false);
  assert.equal(windowDrift.code, 'APPROVAL_TARGET_MISMATCH');

  const planDrift = await run({ approvalId: 'apv-3', token: 'secret-token-3', bindings: { planHash: 'c'.repeat(64), targetFingerprint: 'tf-design-1', windowId: 'win-1' }, expiresAt: Date.now() + 60_000 });
  assert.equal(planDrift.ok, false);
  assert.equal(planDrift.code, 'PLAN_HASH_MISMATCH');

  const noToken = await run({ approvalId: 'apv-4', bindings: { planHash: DESIGN_HASH, targetFingerprint: 'tf-design-1', windowId: 'win-1' }, expiresAt: Date.now() + 60_000 });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.code, 'APPROVAL_REQUIRED');
});

test('cp_execute：没有批准直接拒绝', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-no-approval' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.ok(result.nextActions.some((item) => /cp_approve/.test(item)));
  });
});

test('设计闭环：plan → chat approve → execute → job wait；token 不暴露、body 带 confirm/lineage', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const plan = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    assert.equal(plan.ok, true);

    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true, note: '用户说批准' });
    assert.equal(approved.ok, true);
    const approveBody = router.state.approveBodies[0];
    assert.equal(approveBody.confirm, true);
    assert.equal(approveBody.planHash, DESIGN_HASH);
    assert.equal(approveBody.approvalMode, 'chat');
    assert.equal(approveBody.targetFingerprint, 'tf-design-1');
    assert.equal(approveBody.windowId, 'win-1');
    assert.equal(approveBody.projectId, 'proj1');
    assert.equal(approveBody.documentUuid, 'doc-sch-1');

    const executed = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-design-flow-1' });
    assert.equal(executed.ok, true);
    assert.equal(executed.data.state === 'queued' || executed.data.state === 'running', true);
    assert.equal(JSON.stringify(executed).includes(APPROVAL_TOKEN), false);

    const waited = await waitJob(harness, executed.data.jobId);
    assert.equal(waited.ok, true);
    assert.equal(waited.data.timedOut, false);
    assert.equal(waited.data.job.state, 'done');
    const executionResult = waited.data.job.result;
    assert.equal(executionResult.ok, true);
    assert.equal(executionResult.data.execution.id, 'design-exec-1');
    assert.equal(executionResult.data.execution.state, 'completed');
    assert.equal(executionResult.evidence[0].kind, 'design-execution');
    assert.match(executionResult.evidence[0].ref, /^\/api\/design\/executions\/design-exec-1$/);
    assert.equal(JSON.stringify(waited).includes(APPROVAL_TOKEN), false);

    const executeBody = router.state.executeBodies[0];
    assert.equal(executeBody.approvalToken, APPROVAL_TOKEN);
    assert.equal(executeBody.targetFingerprint, 'tf-design-1');
    assert.equal(executeBody.windowId, 'win-1');
    assert.equal(executeBody.plan.kind, 'simple-control-board');
  });
});

test('PCB 闭环：pcb plan → approve(kind=pcb) → execute 使用 PCB 上下文', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const plan = await harness.callTool('cp_pcb_plan', { plan: { board: { layers: 4 }, operations: [] } });
    assert.equal(plan.ok, true);
    const approved = await harness.callTool('cp_approve', { planHash: PCB_HASH, confirm: true, kind: 'pcb' });
    assert.equal(approved.ok, true);
    assert.equal(approved.data.kind, 'pcb');
    const approveBody = router.state.approveBodies[0];
    assert.equal(approveBody.targetFingerprint, 'tf-pcb-1');
    assert.equal(approveBody.planHash, PCB_HASH);
    assert.equal(approveBody.approvalMode, 'chat');
    const executed = await harness.callTool('cp_execute', { planHash: PCB_HASH, requestId: 'req-pcb-flow-1' });
    assert.equal(executed.ok, true);
    const waited = await waitJob(harness, executed.data.jobId);
    assert.equal(waited.data.job.result.ok, true);
    assert.equal(waited.data.job.result.data.execution.id, 'pcb-exec-1');
    const executeBody = router.state.executeBodies[0];
    assert.equal(executeBody.approvalToken, APPROVAL_TOKEN);
    assert.equal(executeBody.targetFingerprint, 'tf-pcb-1');
    assert.equal(executeBody.plan.kind, 'pcb-production-plan');
  });
});

test('requestId 幂等：同 id 返回同一 job，不重复执行', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    const first = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-idem-1' });
    const second = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-idem-1' });
    assert.equal(second.ok, true);
    assert.equal(second.data.jobId, first.data.jobId);
    assert.equal(second.data.deduped, true);
    await waitJob(harness, first.data.jobId);
    assert.equal(router.state.executeBodies.length, 1);

    // 批准是一次性的；换新 requestId 但复用旧批准必须被拒绝
    const reused = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-idem-2' });
    assert.equal(reused.ok, false);
    assert.equal(reused.code, 'APPROVAL_REQUIRED');
    assert.match(reused.message, /已被使用/);
  });
});

test('批准过期后拒绝执行', async () => {
  const router = createDefaultRouter();
  let now = 1_000_000;
  await withHarness({ handler: router.handler, config: { clock: () => now } }, async (harness) => {
    await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, true);
    now = Date.now() + 60 * 60 * 1000;
    const executed = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-expired-1' });
    assert.equal(executed.ok, false);
    assert.equal(executed.code, 'APPROVAL_EXPIRED');
    assert.equal(router.state.executeBodies.length, 0);
  });
});

test('cp_validation：ERC + DRC 轮询 + gates 汇总，返回证据引用', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', { requestId: 'req-validation-1' });
    assert.equal(submitted.ok, true);
    const waited = await waitJob(harness, submitted.data.jobId, 5000);
    assert.equal(waited.data.job.state, 'done');
    const result = waited.data.job.result;
    assert.equal(result.ok, true);
    assert.equal(result.data.results.erc.counts.warning, 1);
    assert.equal(result.data.results.drc.counts.warning, 2);
    assert.equal(result.data.results.gates.verdict, 'pass');
    assert.equal(result.data.failures, 0);
    assert.ok(router.state.drcPolls >= 2);
    assert.equal(router.state.ercCalls, 1);
    assert.equal(router.state.gatesCalls, 1);
    assert.equal(result.evidence.length, 3);
    assert.deepEqual(result.evidence.map((item) => item.kind).sort(), ['drc-report', 'gate-report', 'schematic-erc']);
  });
});

test('cp_validation：部分目标失败 → VALIDATION_PARTIAL_FAILED 且不冒充通过', async () => {
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.path === '/api/eda/schematic/erc/run') {
      return [503, { ok: false, error: { code: 'BRIDGE_NOT_FOUND', message: '未发现 EasyEDA Bridge' } }];
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', { requestId: 'req-validation-partial', targets: ['erc', 'gates'] });
    const waited = await waitJob(harness, submitted.data.jobId, 5000);
    const result = waited.data.job.result;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_PARTIAL_FAILED');
    assert.equal(result.data.results.erc.ok, false);
    assert.equal(result.data.results.gates.ok, true);
    assert.match(result.message, /不可当作通过/);
  });
});

test('cp_validation：重复 requestId 返回同一 job', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const first = await harness.callTool('cp_validation', { requestId: 'req-validation-dupe', targets: ['gates'] });
    const second = await harness.callTool('cp_validation', { requestId: 'req-validation-dupe', targets: ['gates'] });
    assert.equal(second.data.jobId, first.data.jobId);
    assert.equal(second.data.deduped, true);
    await waitJob(harness, first.data.jobId);
    assert.equal(router.state.gatesCalls, 1);
  });
});

test('cp_validation 批量：3 板顺序执行，单板失败 partial 且其它板不受影响', async () => {
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.method === 'POST' && call.path === '/api/eda/gates/evaluate' && call.body?.pcbUuid === 'pcb-b') {
      return [500, { ok: false, error: { code: 'BRIDGE_NOT_FOUND', message: 'B 板门禁评估失败' } }];
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', {
      requestId: 'req-batch-1',
      boards: [
        { pcbUuid: 'pcb-a', schematicUuid: 'sch-a' },
        { pcbUuid: 'pcb-b', schematicUuid: 'sch-b' },
        { pcbUuid: 'pcb-c', schematicUuid: 'sch-c' },
      ],
    });
    assert.equal(submitted.ok, true);
    assert.match(submitted.summary, /批量校验任务/);
    const waited = await waitJob(harness, submitted.data.jobId, 8000);
    assert.equal(waited.data.job.state, 'done');
    assert.equal(waited.data.job.label, 'batch validation');
    const result = waited.data.job.result;

    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_PARTIAL_FAILED');
    assert.equal(result.summary, '批量校验：3 板，2 通过，1 失败');
    assert.deepEqual(result.data.targets, ['erc', 'drc', 'gates']);
    assert.equal(result.data.batch.total, 3);
    assert.equal(result.data.batch.succeeded, 2);
    assert.equal(result.data.batch.failed, 1);
    assert.deepEqual(result.data.batch.boards.map((item) => item.pcbUuid), ['pcb-a', 'pcb-b', 'pcb-c']);

    const [a, b, c] = result.data.batch.boards;
    assert.equal(a.ok, true);
    assert.equal(a.results.erc.documentUuid, 'sch-a');
    assert.equal(a.results.drc.ok, true);
    assert.equal(a.results.gates.verdict, 'pass');
    assert.equal(a.error, undefined);
    assert.equal(b.ok, false);
    assert.equal(b.results.gates.ok, false);
    assert.equal(b.results.erc.ok, true);
    assert.equal(b.error.code, 'BOARD_VALIDATION_FAILED');
    assert.deepEqual(b.error.failedTargets, ['gates']);
    assert.equal(c.ok, true);

    assert.deepEqual(router.state.ercBodies.map((body) => body.schematicUuid), ['sch-a', 'sch-b', 'sch-c']);
    assert.deepEqual(router.state.drcStarts.map((body) => body.pcbUuid), ['pcb-a', 'pcb-b', 'pcb-c']);
    // pcb-b 的 gates 请求被测试 handler 直接拦截为 500，因此 fake router 只记录 a/c 两次成功请求
    assert.deepEqual(router.state.gatesBodies.map((body) => body.pcbUuid), ['pcb-a', 'pcb-c']);

    assert.equal(result.evidence.length, 8);
    assert.deepEqual([...new Set(result.evidence.map((item) => item.boardPcbUuid))], ['pcb-a', 'pcb-b', 'pcb-c']);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16384, '批量结果不超过 16KB cap');
    foreachNoToken(result);
  });
});

test('cp_validation 批量：ERC 缺 schematicUuid → SCHEMATIC_UUID_REQUIRED，不回退当前原理图', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', {
      requestId: 'req-batch-nosch',
      boards: [{ pcbUuid: 'pcb-nosch' }],
    });
    assert.equal(submitted.ok, true);
    const result = (await waitJob(harness, submitted.data.jobId, 5000)).data.job.result;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ALL_FAILED');
    assert.equal(result.summary, '批量校验：1 板，0 通过，1 失败');
    const board = result.data.batch.boards[0];
    assert.equal(board.pcbUuid, 'pcb-nosch');
    assert.equal(board.ok, false);
    assert.deepEqual(board.results, {});
    assert.equal(board.error.code, 'SCHEMATIC_UUID_REQUIRED');
    assert.equal(router.state.ercCalls, 0, '缺 schematicUuid 时不得调用 ERC（防止串板）');
    assert.equal(router.state.drcStarts.length, 0, '整板失败后不再跑其它 target');
    assert.equal(router.state.gatesCalls, 0);
  });
});

test('cp_validation 批量：DRC 轮询按板隔离（每板独立 job/report）', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', {
      requestId: 'req-batch-drc',
      targets: ['drc'],
      boards: [{ pcbUuid: 'pcb-1' }, { pcbUuid: 'pcb-2' }],
    });
    const result = (await waitJob(harness, submitted.data.jobId, 8000)).data.job.result;
    assert.equal(result.ok, true);
    assert.equal(result.summary, '批量校验：2 板，2 通过，0 失败');
    assert.equal(result.data.batch.succeeded, 2);
    assert.deepEqual(router.state.drcStarts.map((body) => body.pcbUuid), ['pcb-1', 'pcb-2']);
    assert.deepEqual(Object.keys(router.state.drcPollsByJob).sort(), ['drc-job-1', 'drc-job-2']);
    assert.equal(router.state.drcPollsByJob['drc-job-1'], 2);
    assert.equal(router.state.drcPollsByJob['drc-job-2'], 2);
    assert.equal(router.state.drcPolls, 4);
    assert.equal(result.data.batch.boards[0].results.drc.jobId, 'drc-job-1');
    assert.equal(result.data.batch.boards[1].results.drc.jobId, 'drc-job-2');
    assert.equal(result.data.batch.boards[0].results.drc.counts.warning, 2);
    assert.equal(result.data.batch.boards[1].results.drc.counts.warning, 2);
    assert.equal(router.state.ercCalls, 0);
  });
});

test('cp_validation 批量：DRC 有 unexplained violation 时不得算“通过”', async () => {
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.path === '/api/eda/pcb/drc/report' && call.body?.pcbUuid === 'pcb-b') {
      return [200, {
        ok: true,
        state: 'done',
        jobId: call.body?.jobId,
        report: { counts: { error: 1, warning: 0 }, itemCount: 1, items: [{ rule: 'clearance' }], truncated: false },
        classification: {
          ready: false,
          summary: { total: 1, exempted: 0, unexplained: 1 },
          findings: [{ code: 'DRC_UNEXPLAINED_ITEMS', severity: 'blocking' }],
        },
        saved: { path: 'artifacts/evidence/drc-report/blocking.json', digest: 'drc-blocking-digest', savedAt: NOW_ISO },
      }];
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', {
      requestId: 'req-batch-drc-blocking',
      targets: ['drc'],
      boards: [{ pcbUuid: 'pcb-a' }, { pcbUuid: 'pcb-b' }],
    });
    const result = (await waitJob(harness, submitted.data.jobId, 8000)).data.job.result;
    assert.equal(result.ok, false, '有 blocking DRC 时批量不能整体通过');
    assert.equal(result.code, 'VALIDATION_PARTIAL_FAILED');
    assert.equal(result.summary, '批量校验：2 板，1 通过，1 失败');
    assert.equal(result.data.batch.succeeded, 1);
    assert.equal(result.data.batch.failed, 1);
    assert.equal(result.data.batch.boards[0].ok, true);
    assert.equal(result.data.batch.boards[1].ok, false);
    assert.deepEqual(result.data.batch.boards[1].error.failedTargets, ['drc']);
    assert.equal(result.data.batch.boards[1].results.drc.classification.ready, false);
  });
});

test('cp_validation 批量：boards 与单板参数互斥；非法/超限/重复 pcbUuid', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const mutualPcb = await harness.callTool('cp_validation', {
      requestId: 'req-batch-mutual-1', targets: ['gates'], boards: [{ pcbUuid: 'p1' }], pcbUuid: 'p1',
    });
    assert.equal(mutualPcb.ok, false);
    assert.equal(mutualPcb.code, 'INVALID_ARGUMENTS');
    assert.match(mutualPcb.message, /互斥/);
    const mutualSch = await harness.callTool('cp_validation', {
      requestId: 'req-batch-mutual-2', targets: ['gates'], boards: [{ pcbUuid: 'p1' }], schematicUuid: 's1',
    });
    assert.equal(mutualSch.ok, false);
    assert.equal(mutualSch.code, 'INVALID_ARGUMENTS');
    assert.equal(router.state.gatesCalls, 0, '互斥参数不应提交任何 job');

    const cases = [
      [],
      [{ pcbUuid: 'a' }, { pcbUuid: 'b' }, { pcbUuid: 'c' }, { pcbUuid: 'd' }],
      [{ schematicUuid: 's' }],
      [{ pcbUuid: 123 }],
      [{ pcbUuid: 'a' }, 'not-object'],
    ];
    for (const [index, boards] of cases.entries()) {
      const rejected = await harness.callTool('cp_validation', { requestId: `req-batch-invalid-${index}`, targets: ['gates'], boards });
      assert.equal(rejected.ok, false, `非法 boards 用例 ${index} 应拒绝`);
      assert.equal(rejected.code, 'INVALID_ARGUMENTS');
    }

    const deduped = await harness.callTool('cp_validation', {
      requestId: 'req-batch-dedupe',
      targets: ['gates'],
      boards: [{ pcbUuid: 'dup-a' }, { pcbUuid: 'dup-a' }, { pcbUuid: 'dup-b' }],
    });
    assert.equal(deduped.ok, true);
    assert.match(deduped.summary, /去重 1 块/);
    const result = (await waitJob(harness, deduped.data.jobId, 5000)).data.job.result;
    assert.equal(result.data.batch.total, 2);
    assert.deepEqual(result.data.batch.boards.map((item) => item.pcbUuid), ['dup-a', 'dup-b']);
    assert.deepEqual(router.state.gatesBodies.map((body) => body.pcbUuid), ['dup-a', 'dup-b']);
  });
});

test('cp_validation 批量：同 requestId 幂等，不重复跑整批', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const first = await harness.callTool('cp_validation', {
      requestId: 'req-batch-idem', targets: ['gates'], boards: [{ pcbUuid: 'idem-a' }, { pcbUuid: 'idem-b' }],
    });
    const second = await harness.callTool('cp_validation', {
      requestId: 'req-batch-idem', targets: ['gates'], boards: [{ pcbUuid: 'other-a' }, { pcbUuid: 'other-b' }],
    });
    assert.equal(second.data.jobId, first.data.jobId);
    assert.equal(second.data.deduped, true);
    const result = (await waitJob(harness, first.data.jobId, 5000)).data.job.result;
    assert.equal(result.data.batch.total, 2);
    assert.deepEqual(result.data.batch.boards.map((item) => item.pcbUuid), ['idem-a', 'idem-b']);
    assert.equal(router.state.gatesCalls, 2, '只跑第一次提交的 2 块板');
  });
});

test('cp_validation 单板路径回归：无 batch 字段、job label 保持 validation run', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const submitted = await harness.callTool('cp_validation', { requestId: 'req-single-regression', targets: ['gates'], pcbUuid: 'pcb-single' });
    assert.equal(submitted.ok, true);
    const waited = await waitJob(harness, submitted.data.jobId, 5000);
    assert.equal(waited.data.job.label, 'validation run');
    const result = waited.data.job.result;
    assert.equal(result.ok, true);
    assert.equal(result.data.batch, undefined);
    assert.equal(result.data.results.gates.verdict, 'pass');
    assert.equal(router.state.gatesBodies[0].pcbUuid, 'pcb-single');
  });
});

test('cp_export：confirm 必须 true；成功后 final/manifest/证据；被门禁拒绝如实返回', async () => {
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const missing = await harness.callTool('cp_export', { requestId: 'req-export-1' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'INVALID_ARGUMENTS');

    const unconfirmed = await harness.callTool('cp_export', { requestId: 'req-export-1', confirm: false });
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.code, 'CONFIRM_REQUIRED');

    const submitted = await harness.callTool('cp_export', { requestId: 'req-export-1', confirm: true, planHash: DESIGN_HASH });
    assert.equal(submitted.ok, true);
    const waited = await waitJob(harness, submitted.data.jobId);
    const result = waited.data.job.result;
    assert.equal(result.ok, true);
    assert.equal(result.data.exported, true);
    assert.equal(result.data.final, true);
    assert.equal(result.data.fileCount, 2);
    assert.equal(result.data.manifestHash, 'manifest-1');
    assert.equal(result.evidence[0].kind, 'production-export');
    assert.equal(router.state.exportBodies[0].confirm, true);
  });

  const blockedHandler = async () => ({
    ok: true,
    exported: false,
    final: false,
    code: 'RELEASE_DECISION_BLOCKED',
    message: '不能出正式生产文件：签核缺失',
    blockers: ['SIGNOFF_REQUIRED'],
    decision: { allowed: false, outputClass: null, blockers: ['SIGNOFF_REQUIRED'] },
  });
  await withHarness({ handler: blockedHandler }, async (harness) => {
    const submitted = await harness.callTool('cp_export', { requestId: 'req-export-blocked', confirm: true });
    const waited = await waitJob(harness, submitted.data.jobId);
    const result = waited.data.job.result;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_BLOCKED');
    assert.match(result.message, /签核缺失/);
    assert.deepEqual(result.data.blockers, ['SIGNOFF_REQUIRED']);
  });
});

test('cp_job：未知 job、wait 超时、cancel、status/list', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const missing = await harness.callTool('cp_job', { action: 'status', jobId: 'job-nope' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'JOB_NOT_FOUND');

    const job = harness.jobs.start('test.slow', 'req-slow-1', async ({ signal }) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { ok: true };
    }, { mayHaveTakenEffect: true });

    const waited = await harness.callTool('cp_job', { action: 'wait', jobId: job.jobId, timeoutMs: 10 });
    assert.equal(waited.ok, true);
    assert.equal(waited.data.timedOut, true);
    assert.ok(waited.nextActions.some((item) => /不要重复写/.test(item)));

    const cancelled = await harness.callTool('cp_job', { action: 'cancel', jobId: job.jobId });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(cancelled.data.job.mayHaveTakenEffect, true);

    const status = await harness.callTool('cp_job', { action: 'status', jobId: job.jobId });
    assert.equal(status.data.job.state, 'cancelled');

    const list = await harness.callTool('cp_job', { action: 'list' });
    assert.equal(list.ok, true);
    assert.ok(list.data.jobs.some((item) => item.jobId === job.jobId));
  });
});

/* ------------------------------------------------------------------ */
/* cp_design_loop（离线设计闭环 / 复合框架）                            */
/* ------------------------------------------------------------------ */

const LOOP_MODEL = {
  schemaVersion: 1,
  board: { widthMm: 40, heightMm: 30, layers: 4 },
  components: [
    { ref: 'U1', xMm: 10, yMm: 10, widthMm: 5, heightMm: 5 },
    { ref: 'R1', xMm: 20, yMm: 10, widthMm: 2, heightMm: 1 },
  ],
  nets: [
    { name: 'VCC', nodes: ['U1.1', 'R1.1'] },
    { name: 'GND', nodes: ['U1.2', 'R1.2'] },
  ],
  rules: { fabProfile: 'JLC04161H-3313' },
};

/** Runtime POST /api/design/framework/run 摘要夹具（与服务层 summarizeLoopResult 同形）。 */
function loopFramework(overrides = {}) {
  return {
    ok: true,
    status: 'passed',
    iterations: [
      { iteration: 1, modelDigest: 'digest-1', blocking: [{ source: 'stackup', code: 'STACKUP_MISSING', ref: null, group: null }], reviewCount: 0 },
      { iteration: 2, modelDigest: 'digest-2', blocking: [], reviewCount: 0 },
    ],
    repairCount: 1,
    repairs: [{ iteration: 1, strategy: 'solve_stackup', riskLevel: 'low', fromDigest: 'digest-1', toDigest: 'digest-2', detail: 'layers=4' }],
    summary: { initialDigest: 'digest-1', finalDigest: 'digest-2', iterations: 2, repairs: 1, blocking: 0, review: 0, ruleCoverage: 0.913, releaseReady: true, model: { board: { layers: 4 }, components: 2, nets: 2 } },
    rules: { total: 151, pass: 138, review: 13, coverageRatio: 0.913 },
    netlist: { nets: 2, findings: 0 },
    plan: { operations: 2, skipped: [] },
    evidence: { kind: 'design-loop-evidence', status: 'passed', finalBlocking: [], planOperationCount: 2 },
    digest: 'loop-digest-1',
    ...overrides,
  };
}

/**
 * fake Runtime：在默认路由上补复合框架路由（task-6；helpers.mjs 不在本任务写作用域）。
 * `routeMissing` 时模拟旧 Runtime 的 404，用于验证 ROUTE 升级。
 */
async function makeLoopHarness({ framework, frameworkResponse, routeMissing = false, options = {} } = {}) {
  const base = createDefaultRouter(routeMissing ? { missingRoutes: ['POST /api/design/framework/run'] } : {});
  const handler = async (call, context) => {
    if (!routeMissing && call.method === 'POST' && call.path === '/api/design/framework/run') {
      if (typeof frameworkResponse === 'function') return frameworkResponse(call);
      return [200, { ok: true, framework: loopFramework(framework) }];
    }
    if (!routeMissing && call.method === 'GET' && call.path === '/api/design/framework/status') {
      return [200, { ok: true, framework: { schemaVersion: 1, kicad: { available: false }, externalSolvers: { available: false }, layers: ['design-as-code'] } }];
    }
    return base.handler(call, context);
  };
  return makeHarness({ ...options, handler });
}

test('cp_design_loop：passed 闭环返回状态/计数/规则覆盖/证据，只读调用 POST /api/design/framework/run', async () => {
  const harness = await makeLoopHarness();
  try {
    const result = await harness.callTool('cp_design_loop', {
      model: LOOP_MODEL,
      options: { maxIterations: 2, fabProfile: 'JLC04161H-3313' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.equal(result.data.status, 'passed');
    assert.equal(result.data.iterations, 2);
    assert.equal(result.data.repairs, 1);
    assert.equal(result.data.plan.operations, 2);
    assert.equal(result.data.plan.skipped, 0);
    assert.equal(result.data.ruleSummary.coverageRatio, 0.913);
    assert.equal(result.data.options.maxIterations, 2);
    assert.match(result.summary, /status=passed/);
    assert.match(result.summary, /迭代 2/);
    assert.match(result.summary, /修复 1/);
    assert.match(result.summary, /规则覆盖 91\.3%/);
    assert.equal(result.evidence[0].kind, 'design-loop-evidence');
    assert.equal(result.evidence[0].digest, 'loop-digest-1');
    const actions = result.nextActions.join('\n');
    assert.match(actions, /官方 DRC/);
    assert.match(actions, /cp_approve/);
    assert.match(actions, /不写 EDA/);

    const runCalls = harness.runtime.calls.filter((call) => call.path === '/api/design/framework/run');
    assert.equal(runCalls.length, 1);
    assert.deepEqual(runCalls[0].body.model, LOOP_MODEL);
    assert.equal(runCalls[0].body.options.maxIterations, 2);
    assert.equal(runCalls[0].body.options.fabProfile, 'JLC04161H-3313');
    // 只读：除兼容门禁的 GET 外，只允许 POST /api/design/framework/run，不碰写/批准/执行路由。
    assert.equal(harness.runtime.calls.some((call) => call.method !== 'GET' && call.path !== '/api/design/framework/run'), false);
    foreachNoToken(result);
    assert.doesNotThrow(() => JSON.stringify(result));
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：blocked → DESIGN_LOOP_BLOCKED + blocking code/ref + 可执行 nextActions', async () => {
  const blocked = loopFramework({
    status: 'blocked',
    iterations: [{ iteration: 1, modelDigest: 'digest-1', blocking: [{ source: 'netlist', code: 'NETLIST_SHORT', ref: 'VCC/GND', group: null }], reviewCount: 0 }],
    repairs: [],
    repairCount: 0,
    summary: { initialDigest: 'digest-1', finalDigest: 'digest-1', iterations: 1, repairs: 0, blocking: 2, review: 0, ruleCoverage: 0.6, releaseReady: false },
    plan: { operations: 0, skipped: [{ code: 'PLAN_SKIP' }] },
    evidence: {
      kind: 'design-loop-evidence',
      status: 'blocked',
      finalBlocking: [
        { source: 'netlist', code: 'NETLIST_SHORT', ref: 'VCC/GND', group: null },
        { source: 'placement', code: 'PLACEMENT_SIZE_UNKNOWN', ref: 'U1', group: null },
      ],
      finalReviewCount: 0,
    },
  });
  const harness = await makeLoopHarness({ framework: blocked });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESIGN_LOOP_BLOCKED');
    assert.equal(result.data.status, 'blocked');
    assert.equal(result.data.iterations, 1);
    assert.equal(result.data.repairs, 0);
    assert.equal(result.data.plan.skipped, 1);
    assert.deepEqual(result.data.blocking, ['NETLIST_SHORT (VCC/GND)', 'PLACEMENT_SIZE_UNKNOWN (U1)']);
    assert.match(result.message, /NETLIST_SHORT/);
    assert.ok(result.nextActions.some((item) => /NETLIST_SHORT/.test(item)), 'nextActions 必须列出 blocking 项');
    assert.ok(result.nextActions.some((item) => /不要自行重试写操作/.test(item)));
    assert.ok(result.nextActions.some((item) => /不写 EDA|不签核/.test(item)));
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：needs-review → ok:true 但明确不是 passed，要求人工审阅', async () => {
  const review = loopFramework({
    status: 'needs-review',
    repairs: [],
    repairCount: 0,
    summary: { initialDigest: 'digest-1', finalDigest: 'digest-1', iterations: 1, repairs: 0, blocking: 0, review: 13, ruleCoverage: 0.87, releaseReady: false },
    evidence: { kind: 'design-loop-evidence', status: 'needs-review', finalBlocking: [], finalReviewCount: 13 },
  });
  const harness = await makeLoopHarness({ framework: review });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, true);
    assert.equal(result.data.status, 'needs-review');
    assert.match(result.summary, /需人工审阅/);
    assert.match(result.summary, /不是 passed/);
    assert.ok(result.nextActions.some((item) => /不是放行依据/.test(item)));
    assert.ok(result.nextActions.some((item) => /人工/.test(item)));
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：model 超过 200KB → DESIGN_MODEL_TOO_LARGE，且不发 Runtime 请求', async () => {
  const harness = await makeLoopHarness();
  try {
    const bigModel = {
      board: { widthMm: 40, heightMm: 30 },
      components: Array.from({ length: 4000 }, (_unused, index) => ({ ref: `C${index}`, xMm: index, yMm: index, note: 'x'.repeat(40) })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(bigModel), 'utf8') > DESIGN_LOOP_MODEL_MAX_BYTES);
    const result = await harness.callTool('cp_design_loop', { model: bigModel });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESIGN_MODEL_TOO_LARGE');
    assert.equal(result.data.maxBytes, DESIGN_LOOP_MODEL_MAX_BYTES);
    assert.equal(harness.runtime.calls.filter((call) => call.path === '/api/design/framework/run').length, 0);
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：maxIterations 夹在 1–8（99→8、0→1、缺省不传）', async () => {
  const harness = await makeLoopHarness();
  try {
    const runBodies = () => harness.runtime.calls
      .filter((call) => call.path === '/api/design/framework/run')
      .map((call) => call.body.options);
    await harness.callTool('cp_design_loop', { model: LOOP_MODEL, options: { maxIterations: 99 } });
    await harness.callTool('cp_design_loop', { model: LOOP_MODEL, options: { maxIterations: 0 } });
    await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    const [high, low, absent] = runBodies();
    assert.equal(high.maxIterations, DESIGN_LOOP_MAX_ITERATIONS);
    assert.equal(low.maxIterations, 1);
    assert.equal('maxIterations' in absent, false, '缺省时不应伪造 maxIterations，交给 Runtime 默认值');
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：source=project 时不需要 model，请求体带 source 且不带 model（EDA 只读读回由 Runtime 完成）', async () => {
  const harness = await makeLoopHarness({ framework: { ...loopFramework(), status: 'needs-review', summary: { ...loopFramework().summary, blocking: 0, review: 3, releaseReady: false } } });
  try {
    const result = await harness.callTool('cp_design_loop', { source: 'project', options: { maxIterations: 2 } });
    assert.equal(result.ok, true);
    assert.equal(result.data.status, 'needs-review');
    const runCalls = harness.runtime.calls.filter((call) => call.path === '/api/design/framework/run');
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].body.source, 'project');
    assert.equal(runCalls[0].body.model, undefined);
    assert.equal(runCalls[0].body.options.maxIterations, 2);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：source=project 但 Runtime 报 EDA 离线 → 原码透传 + 可执行 nextActions（不伪造 IR）', async () => {
  const harness = await makeLoopHarness({
    frameworkResponse: () => [409, { ok: false, error: { code: 'DESIGN_FRAMEWORK_EDA_OFFLINE', message: 'EDA 不在线或未返回可用板框/铜层数' } }],
  });
  try {
    const result = await harness.callTool('cp_design_loop', { source: 'project' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESIGN_FRAMEWORK_EDA_OFFLINE');
    assert.ok(result.nextActions.some((action) => /打开嘉立创EDA/.test(action)));
    assert.ok(result.nextActions.some((action) => /传 model/.test(action)));
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：Runtime 错误码/nextActions 原样透传，不伪造通过、不漏 token', async () => {
  const harness = await makeLoopHarness({
    frameworkResponse: () => [500, { ok: false, error: { code: 'DESIGN_FRAMEWORK_RUN_FAILED', message: '板级 IR 非法：board.widthMm 缺失' } }],
  });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESIGN_FRAMEWORK_RUN_FAILED');
    assert.match(result.message, /board\.widthMm/);
    assert.ok(result.nextActions.length > 0);
    assert.equal(result.data.runtimeStatus, 500);
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：Runtime 缺路由时升级 RUNTIME_ROUTE_MISSING（列出 run/status）', async () => {
  const harness = await makeLoopHarness({ routeMissing: true });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUNTIME_ROUTE_MISSING');
    assert.equal(result.data.originalCode, 'ROUTE_NOT_FOUND');
    assert.equal(result.data.tool, 'cp_design_loop');
    assert.deepEqual(result.data.routes, ['POST /api/design/framework/run', 'GET /api/design/framework/status']);
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：超大闭环结果仍走结果裁剪（truncated 且保持上限、无 token）', async () => {
  const huge = loopFramework({
    summary: {
      initialDigest: 'digest-1',
      finalDigest: 'digest-2',
      iterations: 8,
      repairs: 8,
      blocking: 0,
      review: 0,
      ruleCoverage: 0.5,
      releaseReady: false,
      model: { components: Array.from({ length: 80 }, (_unused, index) => ({ ref: `C${index}`, note: 'n'.repeat(200) })) },
    },
    iterations: Array.from({ length: 8 }, (_unused, index) => ({
      iteration: index + 1,
      modelDigest: 'd'.repeat(64),
      blocking: Array.from({ length: 30 }, (_item, inner) => ({ source: 'rule', code: `RULE_${inner}`, ref: `R${inner}`, group: null })),
      reviewCount: index,
    })),
  });
  const harness = await makeLoopHarness({ framework: huge, options: { config: { maxResultBytes: 2048 } } });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 2048);
    assert.ok(result.summary.length > 0);
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：schema 明确只读/model|source 二选一/options 结构；非法参数统一 INVALID_ARGUMENTS', async () => {
  const harness = await makeLoopHarness();
  try {
    const tool = harness.byName.cp_design_loop;
    assert.equal(tool.type, 'read');
    assert.equal(tool.inputSchema.type, 'object');
    // 2026-11-06 起支持 source=project：model 改为可选（handler 校验 model 或 source 至少一个）。
    assert.deepEqual(tool.inputSchema.required, []);
    assert.equal(tool.inputSchema.properties.model.type, 'object');
    assert.deepEqual(tool.inputSchema.properties.source.enum, ['model', 'project']);
    assert.equal(tool.inputSchema.properties.options.type, 'object');
    assert.equal(tool.inputSchema.properties.options.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.options.properties.maxIterations.type, 'integer');
    assert.equal(tool.inputSchema.properties.options.properties.fabProfile.type, 'string');
    assert.match(tool.description, /不写 EDA/);
    assert.match(tool.description, /不签核/);

    for (const args of [{}, { model: 'not-an-object' }, { model: {}, options: { maxIterations: 'many' } }]) {
      const result = await harness.callTool('cp_design_loop', args);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_ARGUMENTS');
    }
    assert.equal(harness.runtime.calls.filter((call) => call.path === '/api/design/framework/run').length, 0);
  } finally {
    await harness.close();
  }
});

test('cp_design_loop：status=passed 但仍有 blocking/review → fail-closed DESIGN_LOOP_INCONSISTENT', async () => {
  const inconsistent = loopFramework({
    status: 'passed',
    summary: { initialDigest: 'digest-1', finalDigest: 'digest-2', iterations: 2, repairs: 1, blocking: 1, review: 0, ruleCoverage: 0.9, releaseReady: false },
    evidence: { kind: 'design-loop-evidence', status: 'passed', finalBlocking: [{ source: 'rule', code: 'RULE_FAIL', ref: 'R1', group: null }], finalReviewCount: 0 },
  });
  const harness = await makeLoopHarness({ framework: inconsistent });
  try {
    const result = await harness.callTool('cp_design_loop', { model: LOOP_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESIGN_LOOP_INCONSISTENT');
    assert.match(result.message, /拒绝当作通过/);
    foreachNoToken(result);
  } finally {
    await harness.close();
  }
});

test('normalizeToolConfig：uiUrl 默认、去尾斜杠、仅 http/https', () => {
  assert.equal(DEFAULT_TOOL_CONFIG.uiUrl, 'http://127.0.0.1:4177');
  assert.equal(normalizeToolConfig({}).uiUrl, 'http://127.0.0.1:4177');
  assert.equal(normalizeToolConfig({ uiUrl: 'http://127.0.0.1:9999/' }).uiUrl, 'http://127.0.0.1:9999');
  assert.equal(normalizeToolConfig({ uiUrl: 'https://cp.example.com/ui///' }).uiUrl, 'https://cp.example.com/ui');
  for (const bad of ['javascript:alert(1)', 'file:///tmp/ui', 'not a url', 42, null]) {
    assert.equal(normalizeToolConfig({ uiUrl: bad }).uiUrl, 'http://127.0.0.1:4177', `非法 uiUrl 应回退默认：${String(bad)}`);
  }
});

test('审批 deep link：plan ready 与 approve 成功输出 approvalUrl，nextActions 含 UI 链接且无 token', async () => {
  const expected = 'http://127.0.0.1:4177/?agent=approvals#settings';
  const action = `在 UI 查看/撤销待执行批准：${expected}`;
  const router = createDefaultRouter();
  await withHarness({ handler: router.handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'deep link design' } });
    assert.equal(design.ok, true);
    assert.equal(design.data.approvalUrl, expected);
    assert.ok(design.nextActions.includes(action));
    assert.equal(design.data.approvalToken, undefined);
    foreachNoToken(design);

    const pcb = await harness.callTool('cp_pcb_plan', { plan: { title: 'deep link pcb' } });
    assert.equal(pcb.ok, true);
    assert.equal(pcb.data.approvalUrl, expected);
    assert.ok(pcb.nextActions.includes(action));
    assert.equal(pcb.data.approvalToken, undefined);
    foreachNoToken(pcb);

    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, true);
    assert.equal(approved.data.approvalUrl, expected);
    assert.equal(approved.data.approvalToken, undefined);
    assert.equal(approved.data.approvalTokenExposed, false);
    assert.ok(approved.nextActions.includes(action));
    foreachNoToken(approved);
  });
});

test('审批 deep link：uiUrl 配置生效、非 ready 计划不输出 approvalUrl', async () => {
  const expected = 'https://cp.example.com/ui/?agent=approvals#settings';
  const router = createDefaultRouter();
  const handler = async (call, ctx) => {
    if (call.path === '/api/design/plan') {
      return { ok: true, planning: { ready: false, missing: ['blocks'], planHash: DESIGN_HASH, plan: { title: '不完整' } } };
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler, config: { uiUrl: 'https://cp.example.com/ui/' } }, async (harness) => {
    const incomplete = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    assert.equal(incomplete.ok, true);
    assert.equal(incomplete.data.ready, false);
    assert.equal(incomplete.data.approvalUrl, undefined);
    assert.equal(incomplete.nextActions.some((item) => item.includes('agent=approvals')), false);

    const pcb = await harness.callTool('cp_pcb_plan', { plan: { title: 'y' } });
    assert.equal(pcb.ok, true);
    assert.equal(pcb.data.approvalUrl, expected);
    assert.ok(pcb.nextActions.some((item) => item.includes(expected)));
  });
});

const PLAN_REQUEST_ID = 'apr_0123456789abcdef';
const PLAN_APPROVAL_URL = 'http://127.0.0.1:4177/?agent=plans#settings';

function planRequestHandler(router, { onPlanRequest, onApprove } = {}) {
  const requests = [];
  const handler = async (call, ctx) => {
    if (call.method === 'POST' && call.path === '/api/agent/plan-requests') {
      requests.push(call.body ?? {});
      if (onPlanRequest) return onPlanRequest(call);
      return {
        ok: true,
        request: {
          requestId: PLAN_REQUEST_ID,
          status: 'pending',
          kind: call.body?.kind,
          planHash: call.body?.planHash,
          targetFingerprint: call.body?.targetFingerprint,
          windowId: call.body?.windowId,
          title: call.body?.title,
          summary: call.body?.summary,
          risks: call.body?.risks ?? [],
          missing: call.body?.missing ?? [],
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
      };
    }
    if (onApprove && call.method === 'POST' && (call.path === '/api/design/approve' || call.path === '/api/pcb/approve')) {
      return onApprove(call);
    }
    return router.handler(call, ctx);
  };
  return { handler, requests };
}

test('计划级审批：cp_design_plan requestApproval 创建请求、存 requestId，cp_approve 自动带上', async () => {
  const router = createDefaultRouter();
  const { handler, requests } = planRequestHandler(router);
  await withHarness({ handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', {
      mode: 'normalize',
      title: 'UI 审批设计计划',
      plan: { title: 'UI 审批设计计划', operations: [{ type: 'wire.create' }], assumptions: ['保持当前原理图页'] },
      requestApproval: true,
    });
    assert.equal(design.ok, true);
    assert.equal(design.data.approvalRequestId, PLAN_REQUEST_ID);
    assert.equal(design.data.planApprovalUrl, PLAN_APPROVAL_URL);
    assert.equal(design.data.approvalRequestError, undefined);
    assert.ok(design.nextActions.some((item) => /等待用户在 UI 批准\/拒绝/.test(item)));
    assert.ok(design.nextActions.some((item) => item.includes(PLAN_APPROVAL_URL)));
    foreachNoToken(design);

    assert.equal(requests.length, 1);
    const body = requests[0];
    assert.equal(body.kind, 'design');
    assert.equal(body.planHash, DESIGN_HASH);
    assert.equal(body.windowId, 'win-1');
    assert.equal(body.targetFingerprint, 'tf-design-1');
    assert.equal(body.projectId, 'proj1');
    assert.equal(body.documentUuid, 'doc-sch-1');
    assert.equal(body.title, 'UI 审批设计计划');
    assert.match(body.summary, /ready=true/);
    assert.match(body.summary, /missing 0 项/);
    assert.match(body.summary, /operations 2 个/);
    assert.deepEqual(body.risks, ['测试假设：使用当前原理图页']);
    assert.deepEqual(body.missing, []);
    assert.equal(JSON.stringify(body).includes('cpa_'), false);

    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, true);
    assert.equal(router.state.approveBodies[0].approvalRequestId, PLAN_REQUEST_ID);
    assert.equal(approved.data.approvalRequestId, PLAN_REQUEST_ID);
    foreachNoToken(approved);
  });
});

test('计划级审批：cp_pcb_plan requestApproval 用 PCB 上下文与 plan.title，请求体不泄露 token', async () => {
  const router = createDefaultRouter();
  const { handler, requests } = planRequestHandler(router);
  await withHarness({ handler }, async (harness) => {
    const pcb = await harness.callTool('cp_pcb_plan', {
      plan: { title: 'UI 审批 PCB 计划', operations: [{ type: 'line.create' }], risks: ['布线风险'], assumptions: ['4 层板'] },
      requestApproval: true,
    });
    assert.equal(pcb.ok, true);
    assert.equal(pcb.data.approvalRequestId, PLAN_REQUEST_ID);
    assert.equal(pcb.data.planApprovalUrl, PLAN_APPROVAL_URL);
    assert.equal(requests.length, 1);
    const body = requests[0];
    assert.equal(body.kind, 'pcb');
    assert.equal(body.planHash, PCB_HASH);
    assert.equal(body.targetFingerprint, 'tf-pcb-1');
    assert.equal(body.documentUuid, 'doc-pcb-1');
    assert.equal(body.title, '测试 PCB 计划');
    assert.deepEqual(body.risks, []);
    assert.equal(JSON.stringify(body).includes('cpa_'), false);
    foreachNoToken(pcb);
  });
});

test('计划级审批：context 缺 windowId → APPROVAL_CONTEXT_INCOMPLETE，且不请求 plan-requests', async () => {
  const router = createDefaultRouter();
  const requests = [];
  const handler = async (call, ctx) => {
    if (call.method === 'GET' && call.path === '/api/design/context') {
      return { ok: true, context: { targetFingerprint: 'tf-only' } };
    }
    if (call.method === 'POST' && call.path === '/api/agent/plan-requests') {
      requests.push(call.body);
      return { ok: true, request: { requestId: PLAN_REQUEST_ID } };
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', {
      mode: 'normalize',
      plan: { title: '缺上下文' },
      requestApproval: true,
    });
    assert.equal(design.ok, false);
    assert.equal(design.code, 'APPROVAL_CONTEXT_INCOMPLETE');
    assert.match(design.message, /windowId\/targetFingerprint/);
    assert.equal(requests.length, 0, '不得发送空绑定请求');
  });
});

test('计划级审批：创建请求失败 → 计划仍 ok + approvalRequestError，无伪造 requestId', async () => {
  const router = createDefaultRouter();
  const { handler } = planRequestHandler(router, {
    onPlanRequest: () => [409, { ok: false, error: { code: 'PLAN_REQUEST_CAPACITY', message: '待审批队列已满' } }],
  });
  await withHarness({ handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', {
      mode: 'normalize',
      plan: { title: '队列满' },
      requestApproval: true,
    });
    assert.equal(design.ok, true);
    assert.equal(design.data.approvalRequestId, undefined);
    assert.equal(design.data.planApprovalUrl, undefined);
    assert.deepEqual(design.data.approvalRequestError, { code: 'PLAN_REQUEST_CAPACITY', message: '待审批队列已满' });
    assert.ok(design.nextActions.some((item) => /可重试 requestApproval/.test(item)));
    foreachNoToken(design);
  });
});

test('计划级审批：非 ready 计划即使 requestApproval=true 也不请求、不输出 requestId', async () => {
  const router = createDefaultRouter();
  const requests = [];
  const handler = async (call, ctx) => {
    if (call.method === 'POST' && call.path === '/api/design/plan') {
      return { ok: true, planning: { ready: false, missing: ['blocks'], planHash: DESIGN_HASH, plan: { title: '不完整' } } };
    }
    if (call.method === 'POST' && call.path === '/api/agent/plan-requests') {
      requests.push(call.body);
      return { ok: true, request: { requestId: PLAN_REQUEST_ID } };
    }
    return router.handler(call, ctx);
  };
  await withHarness({ handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' }, requestApproval: true });
    assert.equal(design.ok, true);
    assert.equal(design.data.ready, false);
    assert.equal(design.data.approvalRequestId, undefined);
    assert.equal(design.data.approvalRequestError, undefined);
    assert.equal(requests.length, 0);
  });
});

test('计划级审批：cp_approve 带 requestId 且后端 409 时透传 code + UI 深链', async () => {
  const router = createDefaultRouter();
  const { handler } = planRequestHandler(router, {
    onApprove: () => [409, { ok: false, error: { code: 'PLAN_REQUEST_NOT_APPROVED', message: 'UI 尚未批准该计划请求' } }],
  });
  await withHarness({ handler }, async (harness) => {
    const design = await harness.callTool('cp_design_plan', {
      mode: 'normalize',
      plan: { title: '待 UI 批准' },
      requestApproval: true,
    });
    assert.equal(design.ok, true);
    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, false);
    assert.equal(approved.code, 'PLAN_REQUEST_NOT_APPROVED');
    assert.equal(approved.message, 'UI 尚未批准该计划请求');
    assert.ok(approved.nextActions.some((item) => item.includes(PLAN_APPROVAL_URL)));
    assert.ok(approved.nextActions.some((item) => /UI 批准不签发 token/.test(item)));
    foreachNoToken(approved);
  });
});

test('结果裁剪：超过 maxResultBytes 时置 truncated 并保持 JSON 大小上限', async () => {
  const hugeIndex = {
    ok: true,
    index: {
      generatedAt: '2026-10-29T00:00:00.000Z',
      complete: true,
      truncated: false,
      entries: Array.from({ length: 40 }, (_unused, index) => ({
        kind: 'drc-report',
        digest: `digest-${index}-${'d'.repeat(40)}`,
        savedAt: '2026-10-29T00:00:00.000Z',
        note: 'n'.repeat(200),
        path: `artifacts/evidence/drc-report/${'p'.repeat(300)}-${index}.json`,
        fingerprint: { pcbUuid: 'pcb1' },
      })),
      invalid: [],
      duplicates: [],
      errors: [],
      summary: { entries: 40, kinds: { 'drc-report': 40 }, invalid: 0, duplicates: 0, errors: 0, truncated: false, newestSavedAt: '2026-10-29T00:00:00.000Z' },
    },
  };
  const handler = async (call) => {
    if (call.path === '/api/evidence/index') return hugeIndex;
    return createDefaultRouter().handler(call);
  };
  await withHarness({ handler, config: { maxResultBytes: 2048 } }, async (harness) => {
    const result = await harness.callTool('cp_evidence', { limit: 50 });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 2048);
    assert.ok(result.summary.length > 0);
  });
});

test('写工具缺 requestId/planHash 时统一返回 INVALID_ARGUMENTS', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    for (const name of ['cp_execute', 'cp_approve', 'cp_export', 'cp_validation', 'cp_pcb_plan']) {
      const result = await harness.callTool(name, {});
      assert.equal(result.ok, false, `${name} 应该拒绝空参数`);
      assert.equal(result.code, 'INVALID_ARGUMENTS', `${name} code 应为 INVALID_ARGUMENTS`);
    }
  });
});

test('工具定义可独立构造（不依赖 DSH）：显式 client/config 注入', async () => {
  const router = createDefaultRouter();
  const harness = await makeHarness({ handler: router.handler });
  try {
    const tools = createCircuitPilotTools({
      config: normalizeToolConfig({ runtimeUrl: harness.runtime.url, approvalMode: 'chat' }),
      client: harness.client,
      jobs: harness.jobs,
    });
    assert.equal(tools.length, 13);
    assert.equal(tools.at(-1).name, 'cp_design_loop');
  } finally {
    await harness.close();
  }
});

/* ------------------------------------------------------------------ */
/* Runtime 兼容门禁（task-2）                                          */
/* ------------------------------------------------------------------ */

/** 旧构建（0.8.15）只会 /api/health，其它路由全 404 —— 与用户本机 4178 的真实形态一致。 */
function legacyRouterOptions() {
  return {
    healthVersion: '0.8.15',
    missingRoutes: [
      'GET /api/agent/status',
      'GET /api/project-state',
      'GET /api/issue-state',
      'GET /api/evidence/index',
      'GET /api/write-gate',
      'GET /api/eda/workspaces/current',
    ],
  };
}

test('版本门禁：旧 Runtime 0.8.15 上 cp_status 明确失败 RUNTIME_VERSION_UNSUPPORTED，不再是一串 404', async () => {
  const router = createDefaultRouter(legacyRouterOptions());
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUNTIME_VERSION_UNSUPPORTED');
    assert.match(result.message, /0\.8\.15/);
    assert.match(result.message, /0\.2\.0/);
    assert.ok(result.nextActions.length >= 2, '必须给可操作 nextActions');
    assert.match(result.nextActions.join(' '), /升级|切换/);
    assert.equal(result.data.runtimeVersion, '0.8.15');
    assert.equal(result.data.compat.runtimeVersion, '0.8.15');
    // 门禁失败结果也带插件/宿主诊断（host 未传时优雅降级为 null）。
    assert.equal(typeof result.data.plugin.version, 'string');
    assert.equal(result.data.plugin.host.dshVersion, null);
    assert.equal(result.data.compat.supported, false);
    assert.equal(result.truncated, false);
    foreachNoToken(result);
    // fail-closed：门禁失败后不得再打 project-state 等路由（旧行为会返回一串 404）。
    assert.deepEqual(harness.runtime.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/health']);
  });
});

test('版本门禁：除 cp_job 外的工具都被拦在同一处（0.8.15），cp_job 纯本地不受影响', async () => {
  const router = createDefaultRouter(legacyRouterOptions());
  await withHarness({ handler: router.handler }, async (harness) => {
    for (const [name, args] of [['cp_status', {}], ['cp_project_context', {}], ['cp_issues', {}], ['cp_evidence', {}], ['cp_knowledge', {}]]) {
      const result = await harness.callTool(name, args);
      assert.equal(result.ok, false, `${name} 应被门禁拦住`);
      assert.equal(result.code, 'RUNTIME_VERSION_UNSUPPORTED', `${name} code`);
    }
    // cp_job 是纯本地任务表操作：即使 Runtime 不兼容也必须可用。
    const list = await harness.callTool('cp_job', { action: 'list' });
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.data.jobs));
    assert.equal(harness.runtime.calls.every((call) => call.path === '/api/health'), true, 'cp_job 不应访问 Runtime');
  });
});

test('版本门禁：Runtime 完全不可达时 cp_job 仍可用，其它工具返回 RUNTIME_UNREACHABLE', async () => {
  const harness = await makeHarness({ handler: createDefaultRouter().handler });
  await harness.runtime.close();
  try {
    const status = await harness.callTool('cp_status');
    assert.equal(status.ok, false);
    assert.equal(status.code, 'RUNTIME_UNREACHABLE');
    const job = await harness.callTool('cp_job', { action: 'list' });
    assert.equal(job.ok, true);
  } finally {
    await harness.close();
  }
});

test('版本门禁：版本缺失/非法只警告不硬失败（保持开发版 Runtime 可用）', async () => {
  for (const healthVersion of [null, 'dev-build']) {
    const router = createDefaultRouter({ healthVersion });
    await withHarness({ handler: router.handler }, async (harness) => {
      const result = await harness.callTool('cp_status');
      assert.equal(result.ok, true, `healthVersion=${String(healthVersion)} 不能硬失败`);
      assert.equal(result.data.runtime.versionCompat.unknown, true);
      assert.equal(result.data.runtime.versionCompat.supported, false);
      assert.ok(result.data.warnings.some((item) => /版本兼容性未确认/.test(item)));
      assert.equal(typeof result.data.compat.warning, 'string');
      assert.match(result.summary, /兼容性未确认/);
    });
  }
});

test('cp_status 诊断：0.2.0 Runtime 上给出 versionCompat + 完整能力矩阵 + data.plugin（不传 host 不崩）', async () => {
  await withHarness({ handler: createDefaultRouter().handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true);

    const { runtime, plugin, compat } = result.data;
    assert.equal(runtime.version, '0.2.0');
    assert.equal(runtime.versionCompat.supported, true);
    assert.equal(runtime.versionCompat.unknown, false);
    assert.equal(runtime.versionCompat.range, '>=0.2.0 <0.3.0');
    assert.deepEqual(runtime.versionCompat.verified, ['0.2.0']);
    assert.equal(runtime.capabilities.complete, true);
    assert.deepEqual(runtime.capabilities.missing, []);
    assert.deepEqual(runtime.capabilities.unknown, []);
    assert.equal(runtime.capabilities.checked.length, 6);
    assert.match(runtime.capabilities.checkedAt, /^\d{4}-\d{2}-\d{2}T/);

    // 不传 host：plugin.host 全为 null/默认值，但不能崩。
    assert.equal(typeof plugin.version, 'string');
    assert.equal(plugin.host.dshVersion, null);
    assert.equal(plugin.host.supported, null);
    assert.equal(plugin.host.registration, null);
    assert.equal(plugin.host.supportedRange, '>=0.2.1-rc.2 <0.3.0');
    assert.ok(Array.isArray(plugin.host.verified));

    assert.equal(compat.runtimeVersion, '0.2.0');
    assert.equal(compat.supported, true);
    assert.deepEqual(compat.capabilities, { missing: [], unknown: [], complete: true });
    assert.equal(compat.plugin.version, plugin.version);
    foreachNoToken(result);
  });
});

test('cp_status 诊断：传入 host 时输出 DSH 版本/兼容判定/注册模式', async () => {
  const host = {
    version: '0.2.1-rc.5',
    source: 'runtime.json',
    registration: 'mcp',
    compatible: true,
    supportedRange: '>=0.2.1-rc.2 <0.3.0',
    verified: ['0.2.1-rc.5'],
  };
  await withHarness({ handler: createDefaultRouter().handler, host }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true);
    assert.equal(result.data.plugin.host.dshVersion, '0.2.1-rc.5');
    assert.equal(result.data.plugin.host.supported, true);
    assert.equal(result.data.plugin.host.registration, 'mcp');
    assert.equal(result.data.plugin.host.supportedRange, '>=0.2.1-rc.2 <0.3.0');
    assert.deepEqual(result.data.plugin.host.verified, ['0.2.1-rc.5']);
    assert.equal(result.data.compat.plugin.host.dshVersion, '0.2.1-rc.5');
  });
});

test('404 增强：Runtime 缺路由时升级为 RUNTIME_ROUTE_MISSING（保留 originalCode + 缺失路由 + 三条修复路径）', async () => {
  const router = createDefaultRouter({ missingRoutes: ['GET /api/issue-state'] });
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_issues');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUNTIME_ROUTE_MISSING');
    assert.equal(result.data.originalCode, 'ROUTE_NOT_FOUND');
    assert.equal(result.data.tool, 'cp_issues');
    assert.deepEqual(result.data.routes, ['GET /api/issue-state']);
    assert.match(result.message, /GET \/api\/issue-state/);
    assert.match(result.message, /路由改名|版本不对/);
    const actions = result.nextActions.join('\n');
    assert.ok(result.nextActions.length >= 3);
    assert.match(actions, /升级|切换/);
    assert.match(actions, /回退/);
    assert.match(actions, /升级插件|核对路由名/);
    foreachNoToken(result);
  });
});

test('404 增强：长任务（cp_execute）内部 404 也升级为 RUNTIME_ROUTE_MISSING', async () => {
  const router = createDefaultRouter({ missingRoutes: ['POST /api/design/execute'] });
  await withHarness({ handler: router.handler }, async (harness) => {
    await harness.callTool('cp_design_plan', { mode: 'normalize', plan: { title: 'x' } });
    const approved = await harness.callTool('cp_approve', { planHash: DESIGN_HASH, confirm: true });
    assert.equal(approved.ok, true, '批准路由本身存在，不应受影响');
    const executed = await harness.callTool('cp_execute', { planHash: DESIGN_HASH, requestId: 'req-route-missing-exec' });
    assert.equal(executed.ok, true, '写任务已提交（异步），失败在 job 结果里');
    const waited = await waitJob(harness, executed.data.jobId);
    const jobResult = waited.data.job.result;
    assert.equal(jobResult.ok, false);
    assert.equal(jobResult.code, 'RUNTIME_ROUTE_MISSING');
    assert.equal(jobResult.data.originalCode, 'ROUTE_NOT_FOUND');
    assert.equal(jobResult.data.tool, 'cp_execute');
  });
});

test('能力缺失可见：cp_status 明确列出缺失能力并给出可操作提示（不假装在线正常）', async () => {
  const router = createDefaultRouter({ missingRoutes: ['GET /api/issue-state'] });
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true, 'cp_status 必须能给出诊断而不是直接失败');
    assert.deepEqual(result.data.runtime.capabilities.missing.map((item) => item.id), ['issue-state']);
    assert.equal(result.data.runtime.capabilities.complete, false);
    assert.equal(result.data.runtime.capabilities.missing[0].path, '/api/issue-state');
    assert.deepEqual(result.data.compat.capabilities.missing, ['issue-state']);
    assert.equal(result.data.compat.capabilities.complete, false);
    assert.ok(result.data.warnings.some((item) => /缺少能力.*issue-state/.test(item)));
    assert.ok(result.nextActions.some((item) => /issue-state/.test(item)));
    assert.match(result.summary, /能力缺失 issue-state/);
    assert.equal(result.data.issues, null);
  });
});

test('能力缺失可见：项目状态路由缺失时 cp_status 降级诊断（project=null + routeMissing + 警告）', async () => {
  const router = createDefaultRouter({ missingRoutes: ['GET /api/project-state'] });
  await withHarness({ handler: router.handler }, async (harness) => {
    const result = await harness.callTool('cp_status');
    assert.equal(result.ok, true);
    assert.equal(result.data.project, null);
    assert.equal(result.data.routeMissing.projectState, true);
    assert.equal(result.data.runtime.capabilities.missing.some((item) => item.id === 'project-state'), true);
    assert.ok(result.data.warnings.some((item) => /项目状态路由缺失/.test(item)));
    assert.ok(result.nextActions.some((item) => /project-state/.test(item)));
    assert.match(result.summary, /⚠/);
    assert.match(result.summary, /项目状态路由缺失/);
  });
});
