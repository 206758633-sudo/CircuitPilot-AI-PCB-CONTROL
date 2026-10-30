import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCircuitPilotTools,
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

test('工具目录：12 个 cp_* 工具，schema/description/execute 完整且名字稳定', async () => {
  const harness = await makeHarness({ handler: createDefaultRouter().handler });
  try {
    assert.deepEqual(harness.tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.equal(harness.tools.length, 12);
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
    assert.equal(tools.length, 12);
  } finally {
    await harness.close();
  }
});
