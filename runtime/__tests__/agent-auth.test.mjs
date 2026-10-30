import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_AUTH_CODES, AGENT_CHAT_APPROVAL_ROUTES, AGENT_PLAN_REQUEST_CREATE_ROUTE, AGENT_PUBLIC_ROUTES, assertAgentRouteAllowed, isAgentRouteAllowed, normalizeAgentPath } from '../agent-auth.mjs';

/**
 * 契约 docs/agent/agent-contract.md §1「Agent 禁止访问的路由（denylist）」：
 * - 放行：GET /api/agent/status、GET /api/agent/health
 * - 拒绝：/api/production/signoff、/api/production/reviews/final、
 *   /api/production/order-confirmation、/api/write-gate（POST）、/api/agent/*（除 status/health）、
 *   /api/settings*、/api/providers*、/api/research/config、文件下载/诊断包
 * - 对话审批例外（approvalMode='chat'）：仅放行 POST 精确路径 /api/design/approve、/api/pcb/approve；
 *   GET/HEAD、子路径与任意 /api/design/* 都不因此放开
 * - 计划级待审批队列（task-40）：仅放行 Agent POST 精确路径 /api/agent/plan-requests（创建）；
 *   GET 列表、POST decision、子路径、编码路径与其他方法仍 403
 * - 其余复用现有 Runtime 路由（默认放行）
 */

test('/api/agent/*：只有 GET status/health 放行（GET/HEAD、大小写、尾斜杠）', () => {
  assert.deepEqual([...AGENT_PUBLIC_ROUTES], ['/api/agent/status', '/api/agent/health']);
  for (const method of ['GET', 'HEAD', 'get', 'head', ' Get ']) {
    for (const path of ['/api/agent/status', '/api/agent/health', '/api/agent/status/', '/api/agent/health/']) {
      assert.equal(isAgentRouteAllowed(method, path), true, `${method} ${path} 应放行`);
    }
  }
});

test('/api/agent/*：除 status/health 外一律拒绝（含非 GET 的 status/health）', () => {
  const denied = [
    ['GET', '/api/agent'],
    ['GET', '/api/agent/'],
    ['GET', '/api/agent/jobs'],
    ['POST', '/api/agent/jobs/start'],
    ['POST', '/api/agent/status'],
    ['DELETE', '/api/agent/health'],
    ['PUT', '/api/agent/health'],
    ['GET', '/api/agent/pair'],
    ['POST', '/api/agent/pair'],
    ['GET', '/api/agent/statuses'],
    ['GET', '/api/agent/status/extra'],
    ['GET', '/api/agent/health/../jobs'],
  ];
  for (const [method, path] of denied) {
    assert.equal(isAgentRouteAllowed(method, path), false, `${method} ${path} 应拒绝`);
  }
});

test('计划级待审批：仅 POST 精确 /api/agent/plan-requests 放行（创建）；GET/decision/子路径/编码仍拒绝', () => {
  assert.equal(AGENT_PLAN_REQUEST_CREATE_ROUTE, '/api/agent/plan-requests');
  assert.equal(isAgentRouteAllowed('POST', '/api/agent/plan-requests'), true);
  assert.equal(isAgentRouteAllowed('post', '/api/agent/plan-requests/'), true, '尾斜杠归一化后应放行');
  assert.equal(isAgentRouteAllowed('POST', '/api/agent/plan-requests?x=1'), true, 'query 不属于 path');
  // 只允许创建：读列表、decision、子路径/编码路径、其他方法全部拒绝。
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isAgentRouteAllowed(method, '/api/agent/plan-requests'), false, `${method} 创建路由应拒绝`);
  }
  for (const path of [
    '/api/agent/plan-requests/apr_0000000000000000',
    '/api/agent/plan-requests/apr_0000000000000000/decision',
    '/api/agent/plan-requests/child',
    '/api/agent/plan-requests%2Fchild',
    '/api/agent/plan-requests-status',
  ]) {
    assert.equal(isAgentRouteAllowed('POST', path), false, `POST ${path} 应拒绝`);
  }
  assert.throws(
    () => assertAgentRouteAllowed('GET', '/api/agent/plan-requests'),
    (error) => error.code === AGENT_AUTH_CODES.ROUTE_FORBIDDEN && error.status === 403,
  );
  assert.throws(
    () => assertAgentRouteAllowed('POST', '/api/agent/plan-requests/apr_0000000000000000/decision'),
    (error) => error.code === AGENT_AUTH_CODES.ROUTE_FORBIDDEN && error.status === 403,
  );
});

test('签核/终审/下单确认：任意方法与子路径都拒绝（子树 fail-closed 保留）', () => {
  const trees = [
    '/api/production/signoff',
    '/api/production/reviews/final',
    '/api/production/order-confirmation',
  ];
  for (const tree of trees) {
    for (const suffix of ['', '/', '/latest', '/child']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(isAgentRouteAllowed(method, `${tree}${suffix}`), false, `${method} ${tree}${suffix} 应拒绝`);
      }
    }
  }
});

test('对话审批（approvalMode=chat）：仅 POST 精确 /api/design/approve、/api/pcb/approve 放行', () => {
  assert.deepEqual([...AGENT_CHAT_APPROVAL_ROUTES], ['/api/design/approve', '/api/pcb/approve']);
  for (const route of AGENT_CHAT_APPROVAL_ROUTES) {
    // 精确路径 + POST（含尾斜杠、方法大小写、被误传的 query 入参）放行。
    assert.equal(isAgentRouteAllowed('POST', route), true, `POST ${route} 应放行`);
    assert.equal(isAgentRouteAllowed('post', `${route}/`), true, `POST ${route}/ 应放行`);
    assert.equal(isAgentRouteAllowed('POST', `${route}?confirm=true&planHash=x`), true, `POST ${route}?query 应放行`);
    // 只读方法不放行：对话审批只允许显式 POST 写审批记录，GET 更严格（避免读路径变成旁路）。
    for (const method of ['GET', 'HEAD']) {
      assert.equal(isAgentRouteAllowed(method, route), false, `${method} ${route} 应拒绝`);
    }
    // 其他写方法没有审批语义，拒绝。
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal(isAgentRouteAllowed(method, route), false, `${method} ${route} 应拒绝`);
    }
    // 子路径不能被豁免放大（含 URL 编码的 /）。
    for (const suffix of ['/child', '/preview', '%2Fchild']) {
      assert.equal(isAgentRouteAllowed('POST', `${route}${suffix}`), false, `POST ${route}${suffix} 应拒绝`);
    }
  }
  // 不误伤 /api/design 下已放行的执行路由；豁免也不等于把整个 /api/design/* 放开。
  assert.equal(isAgentRouteAllowed('POST', '/api/design/execute'), true);
  assert.equal(isAgentRouteAllowed('GET', '/api/design/plan'), true);
});

test('/api/write-gate：GET/HEAD 只读快照放行，POST 等写方法拒绝', () => {
  assert.equal(isAgentRouteAllowed('GET', '/api/write-gate'), true);
  assert.equal(isAgentRouteAllowed('HEAD', '/api/write-gate/'), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isAgentRouteAllowed(method, '/api/write-gate'), false, `${method} /api/write-gate 应拒绝`);
    assert.equal(isAgentRouteAllowed(method, '/api/write-gate/state'), false, `${method} /api/write-gate/state 应拒绝`);
  }
});

test('/api/settings*、/api/providers*、/api/research/config：读写都拒绝；研究检索不受影响', () => {
  const denied = ['/api/settings', '/api/settings/', '/api/settings/write-gate', '/api/providers', '/api/providers/custom', '/api/research/config'];
  for (const path of denied) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      assert.equal(isAgentRouteAllowed(method, path), false, `${method} ${path} 应拒绝`);
    }
  }
  // 契约只禁 research/config，研究状态/检索/抓取仍走原有路由。
  assert.equal(isAgentRouteAllowed('GET', '/api/research/status'), true);
  assert.equal(isAgentRouteAllowed('POST', '/api/research/search'), true);
  assert.equal(isAgentRouteAllowed('POST', '/api/research/fetch'), true);
});

test('文件下载与诊断包导出拒绝', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(isAgentRouteAllowed(method, '/api/production/download'), false);
    assert.equal(isAgentRouteAllowed(method, '/api/production/download?path=%2Fetc%2Fpasswd'), false);
    assert.equal(isAgentRouteAllowed(method, '/api/diagnostics/bundle'), false);
  }
  // 普通诊断信息（非诊断包导出）不在 denylist。
  assert.equal(isAgentRouteAllowed('GET', '/api/diagnostics'), true);
});

test('契约放行路由不被误伤（§2 Runtime 复用表）', () => {
  const allowed = [
    ['GET', '/api/health'],
    ['GET', '/api/project-state'],
    ['GET', '/api/projects'],
    ['GET', '/api/eda/workspaces/current'],
    ['GET', '/api/eda/app/focus'],
    ['GET', '/api/issue-state'],
    ['GET', '/api/validation-state'],
    ['GET', '/api/evidence/find'],
    ['GET', '/api/evidence/index'],
    ['POST', '/api/design/plan'],
    ['POST', '/api/design/plan/ai'],
    ['POST', '/api/design/execute'],
    ['POST', '/api/pcb/plan'],
    ['POST', '/api/pcb/execute'],
    ['POST', '/api/eda/schematic/erc/run'],
    ['POST', '/api/eda/pcb/drc/start'],
    ['GET', '/api/eda/gates/status'],
    ['POST', '/api/eda/gates/evaluate'],
    ['GET', '/api/production/readiness'],
    ['POST', '/api/production/export'],
    ['GET', '/api/knowledge/entries'],
    ['GET', '/api/rag/query'],
    ['GET', '/api/approvals/ledger'],
  ];
  for (const [method, path] of allowed) {
    assert.equal(isAgentRouteAllowed(method, path), true, `${method} ${path} 应放行`);
  }
});

test('路径归一化：URL 编码/双重编码/尾斜杠/重复斜杠/dot-segment/query 都不能绕过 denylist', () => {
  const denied = [
    ['GET', '/api/%73ettings'], // settings
    ['GET', '/api/settings/'],
    ['GET', '/api//settings'],
    ['GET', '//api//settings'],
    ['GET', '/api/x/../settings'],
    ['GET', '/api/%2e%2e/api/settings'],
    ['GET', '/api/settings%2Fwrite-gate'],
    ['GET', '/api/settings%252Fwrite-gate'], // 双重编码
    ['GET', '/api/design/%61pprove'], // 对话审批豁免只给 POST；GET 仍拒绝
    ['PUT', '/api/design/%61pprove'],
    ['GET', '/api/pcb/%61pprove'],
    ['GET', '/api/production/%64ownload'],
    ['GET', '/api/diagnostics/%62undle'],
    ['POST', '/api/%77rite-gate'], // write-gate
    ['POST', '/api/write-gate%2Fstate'],
    ['GET', '/api/agent/%73tatus/../jobs'], // 归一化后是 /api/agent/jobs
    ['GET', '/api/production/download?path=%2Fetc%2Fpasswd'],
    ['GET', '/api/settings?next=/api/health'],
    ['GET', '/api/%70roviders'],
    ['POST', '/api/design/approve%2Fchild'], // 归一化后是子路径，不能借编码放大豁免
  ];
  for (const [method, path] of denied) {
    assert.equal(isAgentRouteAllowed(method, path), false, `${method} ${path} 应拒绝`);
  }

  // 编码后的放行路由不被误伤；query 出现在入参里也要按 pathname 判定。
  assert.equal(isAgentRouteAllowed('GET', '/api/%61gent/status'), true);
  assert.equal(isAgentRouteAllowed('GET', '/api/agent/status?verbose=1'), true);
  assert.equal(isAgentRouteAllowed('GET', '/api/evidence/find/'), true);
  assert.equal(isAgentRouteAllowed('GET', '/api/health?probe=1'), true);
  // 对话审批：编码/尾斜杠/dot-segment 归一化后命中精确 POST 仍放行。
  assert.equal(isAgentRouteAllowed('POST', '/api/design/%61pprove/'), true);
  assert.equal(isAgentRouteAllowed('POST', '/api/pcb/%61pprove/../approve'), true);
});

test('normalizeAgentPath：无法安全归一化时返回 null', () => {
  assert.equal(normalizeAgentPath('/api/settings'), '/api/settings');
  assert.equal(normalizeAgentPath('/api//settings/'), '/api/settings');
  assert.equal(normalizeAgentPath('/api/x/../settings'), '/api/settings');
  for (const bad of [null, undefined, 42, {}, '', 'api/settings', '/api/settings%', '/api/%E0%A4%A/settings', '/api/\u0000settings']) {
    assert.equal(normalizeAgentPath(bad), null, `${String(bad)} 应无法归一化`);
  }
});

test('入参非法时 fail-closed（路径/方法类型不对都拒绝）', () => {
  for (const path of [null, undefined, 42, {}, '', 'api/settings', '/api/settings%', '/api/%E0%A4%A/settings']) {
    assert.equal(isAgentRouteAllowed('GET', path), false, `${String(path)} 应拒绝`);
  }
  for (const method of [null, undefined, 42, '', '   ']) {
    assert.equal(isAgentRouteAllowed(method, '/api/health'), false, `方法 ${String(method)} 应拒绝`);
  }
});

test('denylist 语义：未命中的路由默认放行（存在性由 server 分发决定）', () => {
  assert.equal(isAgentRouteAllowed('GET', '/api/not-a-real-route'), true);
  assert.equal(isAgentRouteAllowed('POST', '/api/eda/gui/execute'), true);
  assert.equal(isAgentRouteAllowed('GET', '/'), true);
});

test('assertAgentRouteAllowed：放行返回 true；拒绝抛 AGENT_ROUTE_FORBIDDEN/403（语义不变）', () => {
  assert.equal(assertAgentRouteAllowed('GET', '/api/health'), true);
  // 对话审批豁免生效：POST approve 返回 true，不再抛错。
  assert.equal(assertAgentRouteAllowed('POST', '/api/design/approve'), true);
  assert.equal(assertAgentRouteAllowed('POST', '/api/pcb/approve'), true);
  // 拒绝语义不变：签核仍抛结构化 403。
  assert.throws(
    () => assertAgentRouteAllowed('POST', '/api/production/signoff'),
    (error) => error.code === AGENT_AUTH_CODES.ROUTE_FORBIDDEN && error.status === 403,
  );
  assert.throws(
    () => assertAgentRouteAllowed('GET', '/api/design/approve'),
    (error) => error.code === AGENT_AUTH_CODES.ROUTE_FORBIDDEN && error.status === 403,
  );
  assert.throws(
    () => assertAgentRouteAllowed('GET', '/api/agent/jobs'),
    (error) => error.code === AGENT_AUTH_CODES.ROUTE_FORBIDDEN && error.status === 403,
  );
});
