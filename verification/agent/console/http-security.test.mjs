/**
 * task-28 独立复验（二）：真实 Runtime（createRuntimeServer）HTTP 攻击面。
 *
 * 覆盖：status/audit/rotate 路由、Agent 路由边界（denylist + 编码/穿越变体）、
 * 审计链篡改后的 HTTP 200 + integrity.broken（不 500）、链断时 append 不写、
 * 密钥缺失/权限过宽不重建、rotate 后旧令牌立即 401、token/密钥不泄漏、
 * 下载路由敏感文件拒绝，以及审计日志/错误 message 的脱敏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { readAgentToken } from '../../../runtime/agent-token.mjs';
import { readAgentAudit } from '../../../runtime/agent-console.mjs';
import {
  startConsoleServer,
  call,
  ui,
  agent,
  waitFor,
  seedChain,
  fileSize,
  readKeyHex,
  rawLines,
  writeRawLines,
  parseRawLines,
  writeRawText,
  readRawText,
  chmod,
  fileMode,
  fileExists,
  fakeDesign,
  TOKEN_LIKE,
  headFileFor,
  readHeadFile,
  writeHeadFile,
} from './helpers.mjs';

const auditOf = (session) => readAgentAudit({ auditFile: session.auditPath, keyFile: session.keyFile });

async function waitAudit(session, predicate, options = {}) {
  return waitFor(async () => {
    const audit = await auditOf(session);
    return predicate(audit) ? audit : null;
  }, { label: '等待审计事件', ...options });
}

function assertNoSecrets(text, session, extra = []) {
  assert.ok(!text.includes(session.token || '\u0000'), '响应/日志泄漏当前 token');
  assert.doesNotMatch(text, TOKEN_LIKE);
  if (fileExists(session.keyFile)) {
    const keyHex = readKeyHex(session.keyFile);
    assert.ok(!text.includes(keyHex), '响应/日志泄漏审计密钥');
  }
  for (const secret of extra) assert.ok(!text.includes(secret), '响应/日志泄漏指定秘密');
}

test('UI status/audit：200、返回令牌元信息与审计链，且不含 token/key；Agent 请求/拒绝均入链', async (t) => {
  const session = await startConsoleServer(t);

  const status = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.agent.available, true);
  assert.equal(status.json.agent.name, 'dsh-plugin');
  assert.deepEqual(status.json.agent.scopes, ['read', 'plan', 'execute']);
  assert.equal(status.json.auditIntegrity.chain, 'empty');
  assert.match(status.json.agent.file, /agent-token\.json$/);
  assertNoSecrets(status.text, session);

  const emptyAudit = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(emptyAudit.status, 200);
  assert.deepEqual(emptyAudit.json.events, []);
  assert.equal(emptyAudit.json.integrity.chain, 'empty');

  // Agent 只读 status 放行。
  const agentStatus = await call(session, '/api/agent/status', { headers: agent(session) });
  assert.equal(agentStatus.status, 200);
  assert.equal(agentStatus.json.agent.available, true);

  // Agent 允许的写路由（issue-state 不在 denylist）→ 记 request 事件。
  const accepted = await call(session, '/api/issue-state', {
    method: 'PUT',
    headers: agent(session),
    body: { state: { issues: [] } },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.ok, true);

  // Agent 越权 rotate → 403，并记 denied 事件。
  const denied = await call(session, '/api/agent/token/rotate', { method: 'POST', headers: agent(session), body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'AGENT_ROUTE_FORBIDDEN');

  const audit = await waitAudit(
    session,
    (value) => value.integrity.ok && value.events.some((event) => event.kind === 'denied'),
  );
  const httpAudit = await call(session, '/api/agent/audit?limit=20', { headers: ui(session) });
  assert.equal(httpAudit.status, 200);
  assert.equal(httpAudit.json.ok, true);
  assert.equal(httpAudit.json.integrity.ok, true);
  assert.equal(httpAudit.json.integrity.chain, 'ok');
  assert.ok(httpAudit.json.events.some((event) => event.kind === 'request' && event.path === '/api/issue-state'));
  assert.ok(httpAudit.json.events.some((event) => event.kind === 'denied' && event.path === '/api/agent/token/rotate'));
  for (const event of httpAudit.json.events) {
    assert.ok(!('hash' in event));
    assert.ok(!('prevHash' in event));
  }
  assertNoSecrets(httpAudit.text, session);

  const statusAfter = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.json.auditIntegrity.ok, true);
  assert.equal(statusAfter.json.auditTotal, audit.total);
  assertNoSecrets(statusAfter.text, session);
});

test('HTTP 审计篡改矩阵：改字段/删行/换序/legacy 注入/截断/hash/prevHash/seq → 200 + integrity.broken（不 500）', async (t) => {
  const session = await startConsoleServer(t);

  const cases = [
    {
      name: '篡改中间事件字段',
      mutate(records) { records[1].path = '/api/evil'; },
      reason: 'hash-mismatch',
      firstBadSeq: 2,
      anchored: true,
    },
    {
      name: '删除中间整行',
      mutate(records) { records.splice(1, 1); },
      reason: 'seq-mismatch',
      firstBadSeq: 2,
      anchored: true,
    },
    {
      name: '交换两行',
      mutate(records) { [records[0], records[1]] = [records[1], records[0]]; },
      reason: 'seq-mismatch',
      firstBadSeq: 1,
      anchored: true,
    },
    {
      name: 'legacy 注入链后',
      mutate(records) {
        records.push({ at: new Date().toISOString(), kind: 'request', actor: 'agent', path: '/api/legacy-injected' });
      },
      reason: 'legacy-after-chain',
      anchored: true,
    },
    {
      name: '截断最后一行',
      mutate(_records, auditPath) {
        const raw = readRawText(auditPath);
        const cut = raw.lastIndexOf('\n', raw.length - 2);
        writeRawText(auditPath, raw.slice(0, cut + 1) + raw.slice(cut + 1, cut + 25));
      },
      reason: 'bad-line',
      anchored: false,
      skipWrite: true,
    },
    {
      name: '篡改 hash',
      mutate(records) { records[1].hash = 'f'.repeat(64); },
      reason: 'hash-mismatch',
      firstBadSeq: 2,
      anchored: true,
    },
    {
      name: '篡改 prevHash',
      mutate(records) { records[1].prevHash = 'a'.repeat(64); },
      reason: 'prev-hash-mismatch',
      firstBadSeq: 2,
      anchored: true,
    },
    {
      name: 'seq 跳号（中间）',
      mutate(records) { records[1].seq = 9; },
      reason: 'seq-mismatch',
      firstBadSeq: 2,
      anchored: true,
    },
    {
      name: '删除最后一行（head-ahead）',
      mutate(records) { records.splice(2, 1); },
      reason: 'head-ahead',
      firstBadSeq: 3,
      anchored: false,
      events: 2,
    },
    {
      name: '删除整个审计文件（head-ahead）',
      mutate(_records, auditPath) { rmSync(auditPath, { force: true }); },
      reason: 'head-ahead',
      anchored: false,
      events: 0,
      skipWrite: true,
    },
    {
      name: '改最后一条的 hash（head-hash-mismatch）',
      mutate(records) { records[2].hash = 'e'.repeat(64); },
      reason: 'head-hash-mismatch',
      firstBadSeq: 3,
      anchored: false,
    },
    {
      name: 'head 回退到 seq=2（head-behind）',
      mutate(records, _auditPath, headFile) {
        const head = readHeadFile(headFile);
        writeHeadFile(headFile, { ...head, seq: 2, hash: records[1].hash });
      },
      reason: 'head-behind',
      firstBadSeq: 3,
      anchored: false,
      skipWrite: true,
    },
    {
      name: 'head 损坏（head-invalid）',
      mutate(_records, _auditPath, headFile) { writeRawText(headFile, 'not-json\n'); },
      reason: 'head-invalid',
      anchored: false,
      headSeq: null,
      skipWrite: true,
    },
  ];

  for (const scenario of cases) {
    rmSync(session.auditPath, { force: true });
    rmSync(session.headFile, { force: true });
    await seedChain(session.auditPath, session.keyFile, 3);
    const records = parseRawLines(session.auditPath);
    scenario.mutate(records, session.auditPath, session.headFile);
    if (!scenario.skipWrite) {
      writeRawLines(session.auditPath, records.map((record) => JSON.stringify(record)));
    }

    const auditResponse = await call(session, '/api/agent/audit?limit=20', { headers: ui(session) });
    assert.equal(auditResponse.status, 200, `${scenario.name}: GET audit 必须 200`);
    assert.equal(auditResponse.json.ok, true, scenario.name);
    assert.equal(auditResponse.json.integrity.ok, false, scenario.name);
    assert.equal(auditResponse.json.integrity.chain, 'broken', scenario.name);
    assert.equal(auditResponse.json.integrity.reason, scenario.reason, scenario.name);
    assert.equal(auditResponse.json.integrity.anchored, scenario.anchored, `${scenario.name}: anchored`);
    if (scenario.firstBadSeq !== undefined) {
      assert.equal(auditResponse.json.integrity.firstBadSeq, scenario.firstBadSeq, scenario.name);
    }
    if (scenario.events !== undefined) {
      assert.equal(auditResponse.json.events.length, scenario.events, scenario.name);
    }
    if (scenario.headSeq === null) {
      assert.equal(auditResponse.json.integrity.headSeq, null, scenario.name);
    }
    assert.ok(Array.isArray(auditResponse.json.events), `${scenario.name}: 链断仍应返回事件数组`);
    assertNoSecrets(auditResponse.text, session);

    // status 也不能 500，且把 broken 透传给设置页。
    const statusResponse = await call(session, '/api/agent/status', { headers: ui(session) });
    assert.equal(statusResponse.status, 200, `${scenario.name}: GET status 必须 200`);
    assert.equal(statusResponse.json.ok, true, scenario.name);
    assert.equal(statusResponse.json.agent.available, true, scenario.name);
    assert.equal(statusResponse.json.auditIntegrity.ok, false, scenario.name);
    assert.equal(statusResponse.json.auditIntegrity.reason, scenario.reason, scenario.name);
    assertNoSecrets(statusResponse.text, session);
  }
});

test('HTTP 密钥攻击：缺失→key-missing、权限过宽→key-invalid（均 200），不重建/不修复，恢复后链可继续', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 3);
  const keyBytes = readRawText(session.keyFile);
  const auditSize = fileSize(session.auditPath);

  // 1) 删除密钥文件。
  rmSync(session.keyFile);
  const missingAudit = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(missingAudit.status, 200);
  assert.equal(missingAudit.json.integrity.ok, false);
  assert.equal(missingAudit.json.integrity.reason, 'key-missing');
  assert.equal(fileExists(session.keyFile), false, 'GET audit 不得重建密钥');
  assert.equal(fileSize(session.auditPath), auditSize);

  const missingStatus = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(missingStatus.status, 200);
  assert.equal(missingStatus.json.auditIntegrity.reason, 'key-missing');
  assert.equal(missingStatus.json.agent.available, true);
  assertNoSecrets(missingAudit.text, session);

  // 恢复密钥：链重新可验证（证明没有把旧链换成新密钥）。
  writeFileSync(session.keyFile, keyBytes, { mode: 0o600 });
  chmod(session.keyFile, 0o600);
  const restored = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.integrity.ok, true);
  assert.equal(restored.json.integrity.chain, 'ok');

  // 2) 权限过宽（0644）：key-invalid；不得自动 chmod 或重写。
  chmod(session.keyFile, 0o644);
  const wideAudit = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(wideAudit.status, 200);
  assert.equal(wideAudit.json.integrity.ok, false);
  assert.equal(wideAudit.json.integrity.reason, 'key-invalid');
  const wideStatus = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(wideStatus.status, 200);
  assert.equal(wideStatus.json.auditIntegrity.reason, 'key-invalid');
  assert.equal(fileMode(session.keyFile), 0o644, '不得静默收紧权限');
  assert.equal(readRawText(session.keyFile), keyBytes, '不得重写密钥');
  assert.equal(fileSize(session.auditPath), auditSize);

  chmod(session.keyFile, 0o600);
  const fixed = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.integrity.ok, true);
});

test('链断时 Agent 请求仍成功但 append 不写字节；密钥缺失也不重建（HTTP 级）', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 3);

  // 截断最后一行 → 链断。
  const raw = readRawText(session.auditPath);
  const cut = raw.lastIndexOf('\n', raw.length - 2);
  writeRawText(session.auditPath, raw.slice(0, cut + 1) + raw.slice(cut + 1, cut + 30));
  const brokenSize = fileSize(session.auditPath);
  const keyBytes = readRawText(session.keyFile);

  const accepted = await call(session, '/api/issue-state', {
    method: 'PUT',
    headers: agent(session),
    body: { state: { issues: [] } },
  });
  assert.equal(accepted.status, 200, '审计失败不得拖垮业务请求');
  assert.equal(accepted.json.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fileSize(session.auditPath), brokenSize, '链断时 append 不得写新字节');
  assert.equal(readRawText(session.keyFile), keyBytes, '链断时不得重写密钥');
  assert.ok(session.logs.some((line) => /Agent audit append failed/.test(line)), '应记录审计追加失败 warn');
  assertNoSecrets(session.logs.join('\n'), session);

  const auditResponse = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(auditResponse.status, 200);
  assert.equal(auditResponse.json.integrity.reason, 'bad-line');

  // 删除密钥后再发 Agent 请求：也不得重建密钥。
  rmSync(session.keyFile);
  const accepted2 = await call(session, '/api/issue-state', {
    method: 'PUT',
    headers: agent(session),
    body: { state: { issues: [] } },
  });
  assert.equal(accepted2.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fileExists(session.keyFile), false, '链断时不得重建密钥');
  assert.equal(fileSize(session.auditPath), brokenSize);

  // 链断时 rotate 仍应可用（审计旁路失败不能阻断轮换），且审计链仍 broken、密钥不被重建。
  const rotated = await call(session, '/api/agent/token/rotate', { method: 'POST', headers: ui(session), body: '{}' });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.json.agent.rotated, true);
  assert.equal(fileExists(session.keyFile), false);
  assert.equal(fileSize(session.auditPath), brokenSize);
  const afterRotate = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(afterRotate.status, 200);
  assert.equal(afterRotate.json.integrity.ok, false);
});

test('HTTP head 锚点缺失：audit/status 200 且不误报 broken（anchored=false）；Agent 追加后自动重建 head', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 3);
  rmSync(session.headFile, { force: true });

  const audit = await call(session, '/api/agent/audit?limit=20', { headers: ui(session) });
  assert.equal(audit.status, 200);
  assert.equal(audit.json.integrity.ok, true, 'head 缺失（旧审计）不得判 broken');
  assert.equal(audit.json.integrity.chain, 'ok');
  assert.equal(audit.json.integrity.anchored, false);
  assert.equal(audit.json.integrity.headSeq, null);
  assert.equal(audit.json.integrity.headHash, null);

  const status = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(status.status, 200);
  assert.equal(status.json.auditIntegrity.ok, true);
  assert.equal(status.json.auditIntegrity.anchored, false);

  // Agent 允许的写请求触发 append：head 缺失时不阻断，重建锚点。
  const accepted = await call(session, '/api/issue-state', { method: 'PUT', headers: agent(session), body: { state: { issues: [] } } });
  assert.equal(accepted.status, 200);
  const rebuilt = await waitAudit(session, (value) => value.integrity.ok && value.integrity.anchored && value.total >= 4);
  assert.equal(rebuilt.integrity.headSeq, 4);
  const head = readHeadFile(session.headFile);
  assert.equal(head.seq, 4);
  assert.equal(head.hash, parseRawLines(session.auditPath)[3].hash);
});

test('HTTP head 落后：Agent 请求仍 200，但 append 零字节且 head 不变；GET audit broken/head-behind', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 3);
  const oldHead = readHeadFile(session.headFile);

  // 正常写第 4 条（head 到 seq=4），再把 head 回退成 seq=3。
  const fourth = await (await import('../../../runtime/agent-console.mjs')).appendAgentAudit({
    auditFile: session.auditPath,
    keyFile: session.keyFile,
    headFile: session.headFile,
    event: { kind: 'request', actor: 'agent', path: '/api/manual-fourth' },
  });
  assert.equal(fourth.ok, true);
  writeHeadFile(session.headFile, oldHead);
  const beforeSize = fileSize(session.auditPath);

  const accepted = await call(session, '/api/issue-state', { method: 'PUT', headers: agent(session), body: { state: { issues: [] } } });
  assert.equal(accepted.status, 200, '审计失败不得拖垮业务请求');
  assert.equal(accepted.json.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fileSize(session.auditPath), beforeSize, 'head 落后时 append 必须零字节');
  assert.deepEqual(readHeadFile(session.headFile), oldHead, 'append 拒绝时不得改写 head');

  const audit = await call(session, '/api/agent/audit?limit=20', { headers: ui(session) });
  assert.equal(audit.status, 200);
  assert.equal(audit.json.integrity.ok, false);
  assert.equal(audit.json.integrity.chain, 'broken');
  assert.equal(audit.json.integrity.reason, 'head-behind');
  assert.equal(audit.json.integrity.anchored, false);
  assert.equal(audit.json.integrity.headSeq, 3);

  const status = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(status.status, 200);
  assert.equal(status.json.auditIntegrity.reason, 'head-behind');
});

test('rotate：旧 token 立即 401、新 token 立即 200，审计 rotate 事件落盘且链完整，响应不含 token/key', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 2);
  const oldToken = session.token;

  const rotate = await call(session, '/api/agent/token/rotate', { method: 'POST', headers: ui(session), body: '{}' });
  assert.equal(rotate.status, 200);
  assert.equal(rotate.json.ok, true);
  assert.equal(rotate.json.agent.rotated, true);
  assertNoSecrets(rotate.text, session, [oldToken]);

  const newRecord = await session.readToken();
  assert.notEqual(newRecord.token, oldToken);
  assert.equal(fileMode(session.tokenPath), 0o600);
  assert.ok(!rotate.text.includes(newRecord.token), 'rotate 响应不得含新 token 原文');

  // rotate 响应之后立刻用旧 token：必须 401（无宽限期）。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const oldUse = await call(session, '/api/agent/status', { headers: agent(session, { 'x-circuitpilot-agent-token': oldToken }) });
    assert.equal(oldUse.status, 401, `第 ${attempt + 1} 次旧 token 必须 401`);
  }

  session.token = newRecord.token;
  const newUse = await call(session, '/api/agent/status', { headers: agent(session) });
  assert.equal(newUse.status, 200);
  assert.equal(newUse.json.agent.available, true);
  const newProject = await call(session, '/api/project-state', { headers: agent(session) });
  assert.equal(newProject.status, 200);

  const audit = await waitAudit(
    session,
    (value) => value.integrity.ok && value.events.some((event) => event.kind === 'rotate' && event.actor === 'ui'),
  );
  assert.equal(audit.integrity.anchored, true);
  assert.ok(audit.events.some((event) => event.kind === 'rotate' && event.actor === 'ui'));
  assertNoSecrets(JSON.stringify(audit), session, [oldToken, newRecord.token]);

  const uiAudit = await call(session, '/api/agent/audit?limit=20', { headers: ui(session) });
  assert.equal(uiAudit.status, 200);
  assert.equal(uiAudit.json.integrity.ok, true);
  assert.ok(uiAudit.json.events.some((event) => event.kind === 'rotate'));
  assertNoSecrets(uiAudit.text, session, [oldToken, newRecord.token]);
});

test('并发 rotate + 旧 token 请求：rotate 返回后旧 token 不再成功，新 token 可用，审计链完整', async (t) => {
  const session = await startConsoleServer(t);
  const oldToken = session.token;
  const oldHeaders = agent(session, { 'x-circuitpilot-agent-token': oldToken });

  const inFlight = Array.from({ length: 10 }, () => call(session, '/api/project-state', { headers: oldHeaders }));
  const rotatePromise = call(session, '/api/agent/token/rotate', { method: 'POST', headers: ui(session), body: '{}' });
  const [, rotate] = await Promise.all([Promise.all(inFlight), rotatePromise]);
  assert.equal(rotate.status, 200);

  const afterRotate = await Promise.all(
    Array.from({ length: 10 }, () => call(session, '/api/project-state', { headers: oldHeaders })),
  );
  for (const response of afterRotate) {
    assert.equal(response.status, 401, 'rotate 完成后旧 token 不得继续成功');
  }
  const newRecord = await session.readToken();
  session.token = newRecord.token;
  const newUse = await call(session, '/api/project-state', { headers: agent(session) });
  assert.equal(newUse.status, 200);

  const audit = await waitAudit(
    session,
    (value) => value.integrity.ok && value.events.some((event) => event.kind === 'rotate'),
  );
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assertNoSecrets(JSON.stringify(audit), session, [oldToken]);
});

test('Agent 路由边界矩阵：status 200；audit/rotate/settings/signoff/download/diagnostics 403；编码/穿越/尾斜杠变体不绕过', async (t) => {
  const session = await startConsoleServer(t, { fakeDesign });
  const agentHeaders = agent(session);

  const expectStatus = async (pathname, expected, { method = 'GET', headers = agentHeaders, body } = {}) => {
    const response = await call(session, pathname, { method, headers, body });
    assert.equal(response.status, expected, `${method} ${pathname} 应为 ${expected}，实际 ${response.status}（${response.text.slice(0, 160)}）`);
    return response;
  };

  await expectStatus('/api/agent/status', 200);
  await expectStatus('/api/agent/audit', 403);
  await expectStatus('/api/agent/audit?limit=2', 403);
  await expectStatus('/api/agent/token/rotate', 403, { method: 'POST', body: '{}' });
  await expectStatus('/api/settings', 403);
  await expectStatus('/api/settings', 403, { method: 'POST', body: '{}' });
  await expectStatus('/api/production/signoff', 403, { method: 'POST', body: '{}' });
  await expectStatus('/api/production/signoff/latest', 403);
  await expectStatus('/api/production/download?path=/etc/hosts', 403);
  await expectStatus('/api/diagnostics/bundle', 403);
  await expectStatus('/api/write-gate', 200);
  await expectStatus('/api/write-gate', 403, { method: 'POST', body: '{}' });
  await expectStatus('/api/project-state', 200);

  // 编码 / 双重编码 / 点段 / 尾斜杠变体。
  await expectStatus('/api/%61gent/audit', 403);
  await expectStatus('/api/agent/%61udit', 403);
  await expectStatus('/api/agent/%2561udit', 403);
  await expectStatus('/api/settings/../agent/audit', 403);
  await expectStatus('/api/./agent/audit', 403);
  await expectStatus('/api/agent/audit/', 403);
  await expectStatus('/api/write-gate/', 403, { method: 'POST', body: '{}' });

  // 对话审批豁免：仅 POST 精确路径 + confirm=true + approvalMode=chat。
  const approve = await expectStatus('/api/design/approve', 200, {
    method: 'POST',
    body: { planHash: 'plan-verify-1', confirm: true, approvalMode: 'chat', windowId: 'win-verify' },
  });
  assert.equal(approve.json.ok, true);
  assert.equal(approve.json.approval.planHash, 'plan-verify-1');

  const approveNoConfirm = await expectStatus('/api/design/approve', 403, {
    method: 'POST',
    body: { planHash: 'plan-verify-1', approvalMode: 'chat' },
  });
  assert.equal(approveNoConfirm.json.error.code, 'AGENT_APPROVAL_CONFIRMATION_REQUIRED');
  await expectStatus('/api/design/approve', 403, { method: 'GET' });

  // UI 会话不受 Agent denylist 限制。
  await expectStatus('/api/agent/audit', 200, { headers: ui(session) });

  // 认证边界：无 token / 错误 agent token → 401（不是 403）。
  const noAuth = await call(session, '/api/project-state');
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'RUNTIME_TOKEN_INVALID');
  const wrongAgent = await call(session, '/api/project-state', { headers: agent(session, { 'x-circuitpilot-agent-token': `cpa_${'f'.repeat(48)}` }) });
  assert.equal(wrongAgent.status, 401);

  // 大量 denied/approve 事件入链后，链仍完整（等 approve 也落盘，避免只看到部分异步 append）。
  const audit = await waitAudit(
    session,
    (value) => value.integrity.ok
      && value.events.some((event) => event.kind === 'approve')
      && value.events.some((event) => event.kind === 'denied'),
  );
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.chain, 'ok');
  assert.ok(audit.events.some((event) => event.kind === 'denied'));
  assert.ok(audit.events.some((event) => event.kind === 'approve'));
  assertNoSecrets(JSON.stringify(audit), session);
});

test('无 token 文件：status 200 available:false（AGENT_TOKEN_MISSING）不 500；rotate 可签发首个 token', async (t) => {
  const session = await startConsoleServer(t, { withToken: false });
  const status = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.agent.available, false);
  assert.equal(status.json.agent.reason, 'AGENT_TOKEN_MISSING');
  const audit = await call(session, '/api/agent/audit', { headers: ui(session) });
  assert.equal(audit.status, 200);
  assert.equal(audit.json.integrity.chain, 'empty');

  const noTokenUse = await call(session, '/api/project-state', { headers: agent(session, { 'x-circuitpilot-agent-token': `cpa_${'0'.repeat(48)}` }) });
  assert.equal(noTokenUse.status, 401);

  const rotate = await call(session, '/api/agent/token/rotate', { method: 'POST', headers: ui(session), body: '{}' });
  assert.equal(rotate.status, 200);
  assert.equal(rotate.json.agent.rotated, true);
  const issued = await session.readToken();
  assert.match(issued.token, TOKEN_LIKE);
  session.token = issued.token;
  const use = await call(session, '/api/project-state', { headers: agent(session) });
  assert.equal(use.status, 200);
  const statusAfter = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.json.agent.available, true);
  assertNoSecrets(JSON.stringify(statusAfter.json), session);
});

test('token 文件权限过宽：status 200 available:false（AGENT_TOKEN_INVALID），不自动修复权限/不改内容', async (t) => {
  const session = await startConsoleServer(t);
  const tokenBytes = readRawText(session.tokenPath);
  chmod(session.tokenPath, 0o644);
  try {
    const status = await call(session, '/api/agent/status', { headers: ui(session) });
    assert.equal(status.status, 200);
    assert.equal(status.json.agent.available, false);
    assert.equal(status.json.agent.reason, 'AGENT_TOKEN_INVALID');
    assert.equal(fileMode(session.tokenPath), 0o644, 'status 不得静默收紧 token 文件权限');
    assert.equal(readRawText(session.tokenPath), tokenBytes);
    assertNoSecrets(status.text, session);
    // 观察项：令牌在启动时已读入内存，运行中改宽文件权限不会立刻吊销认证（重启后才 fail-closed）。
    const cachedUse = await call(session, '/api/agent/status', { headers: agent(session) });
    assert.equal(cachedUse.status, 200);
  } finally {
    chmod(session.tokenPath, 0o600);
  }
  const restored = await call(session, '/api/agent/status', { headers: ui(session) });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.agent.available, true);
});

test('泄漏扫描：status/audit/rotate/diagnostics/download 响应、错误 message、stdout/stderr 均不含 token 或审计密钥', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 2);
  const keyHex = readKeyHex(session.keyFile);
  const oldToken = session.token;

  // 配置下载根（包含 token/audit/key/head 所在目录），并放一个合法产物（P3 已修复：用 delimiter 拼接）。
  writeFileSync(join(session.stateDir, 'artifact.json'), '{"hello":"world"}\n');
  process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = `${session.root}${delimiter}${session.stateDir}`;

  const responses = [];
  responses.push(await call(session, '/api/agent/status', { headers: ui(session) }));
  responses.push(await call(session, '/api/agent/audit?limit=20', { headers: ui(session) }));
  responses.push(await call(session, '/api/diagnostics/bundle', { headers: ui(session) }));
  responses.push(await call(session, '/api/production/download?path=' + encodeURIComponent(join(session.stateDir, 'artifact.json')), { headers: ui(session) }));
  responses.push(await call(session, '/api/production/download?path=' + encodeURIComponent(session.tokenPath), { headers: ui(session) }));
  responses.push(await call(session, '/api/production/download?path=' + encodeURIComponent(session.headFile), { headers: ui(session) }));
  responses.push(await call(session, '/api/issue-state', { method: 'POST', headers: ui(session), body: { bad: true } }));
  responses.push(await call(session, '/api/agent/token/rotate', { method: 'POST', headers: ui(session), body: '{}' }));
  const newRecord = await session.readToken();
  responses.push(await call(session, '/api/agent/status', { headers: ui(session) }));
  responses.push(await call(session, '/api/agent/audit?limit=50', { headers: ui(session) }));

  const haystack = [
    ...responses.map((response) => response.text),
    ...responses.map((response) => JSON.stringify(response.json ?? {})),
    session.logs.join('\n'),
    readRawText(session.auditPath),
  ].join('\n');

  assert.ok(!haystack.includes(oldToken), '发现旧 token 原文');
  assert.ok(!haystack.includes(newRecord.token), '发现新 token 原文');
  assert.ok(!haystack.includes(keyHex), '发现审计密钥原文');
  assert.doesNotMatch(haystack, TOKEN_LIKE);
  // key 文件内容（64hex）不得出现在错误 message/日志里。
  assert.ok(!haystack.includes(JSON.parse(readRawText(session.keyFile)).key));

  // diagnostics 200 且是脱敏包；download 敏感文件 403。
  const diagnostics = responses[2];
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.json.ok, true);
  assert.equal(diagnostics.json.bundle.redaction.applied, true);
  assert.equal(responses[4].status, 403);
  assert.equal(responses[4].json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  assert.equal(responses[5].status, 403, 'head 锚点文件也不得下载');
  assert.equal(responses[5].json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  assert.equal(responses[3].status, 200);

  // 审计落盘同样不含 token/key。
  const auditOnDisk = readRawText(session.auditPath);
  assert.ok(!auditOnDisk.includes(oldToken));
  assert.ok(!auditOnDisk.includes(newRecord.token));
  assert.ok(!auditOnDisk.includes(keyHex));
});

test('下载路由：敏感文件名/穿越/符号链接逃逸均 403；合法产物 200；Agent 一律 403', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 1);
  writeFileSync(join(session.stateDir, 'artifact.json'), '{"ok":true}\n');
  process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = `${session.root}${delimiter}${session.stateDir}`;

  const download = (pathname, headers = ui(session)) => call(
    session,
    `/api/production/download?path=${encodeURIComponent(pathname)}`,
    { headers },
  );

  const legit = await download(join(session.stateDir, 'artifact.json'));
  assert.equal(legit.status, 200);
  assert.equal(legit.text, '{"ok":true}\n');

  // token 文件与 audit key 文件（即使目录被配置成下载根）必须拒绝。
  const tokenDownload = await download(session.tokenPath);
  assert.equal(tokenDownload.status, 403);
  assert.equal(tokenDownload.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  const keyDownload = await download(session.keyFile);
  assert.equal(keyDownload.status, 403);
  assert.equal(keyDownload.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  const headDownload = await download(session.headFile);
  assert.equal(headDownload.status, 403, '审计链 head 锚点文件也属于敏感文件');
  assert.equal(headDownload.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  assertNoSecrets(tokenDownload.text, session);
  assertNoSecrets(keyDownload.text, session);
  assertNoSecrets(headDownload.text, session);

  // 路径穿越到 token 文件（归一化后 realpath 命中敏感名）。
  const traversal = await download(join(session.stateDir, '..', 'agent-token.json'));
  assert.equal(traversal.status, 403);

  // 符号链接：指向 token 文件 → realpath 命中敏感名；指向根目录外 → 路径白名单拒绝。
  symlinkSync(session.tokenPath, join(session.stateDir, 'disguised.json'));
  const symlinkToken = await download(join(session.stateDir, 'disguised.json'));
  assert.equal(symlinkToken.status, 403);
  assert.equal(symlinkToken.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');

  const outsideRoot = mkdtempSync(join(tmpdir(), 'cp-download-outside-'));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));
  writeFileSync(join(outsideRoot, 'secret.txt'), 'outside-of-roots\n');
  symlinkSync(join(outsideRoot, 'secret.txt'), join(session.stateDir, 'escape.txt'));
  const escape = await download(join(session.stateDir, 'escape.txt'));
  assert.equal(escape.status, 403);
  assert.equal(escape.json.error.code, 'DOWNLOAD_PATH_FORBIDDEN');

  // Agent 连下载路由都到不了（denylist 先于文件检查）。
  const agentDownload = await download(session.stateDir + '/artifact.json', agent(session));
  assert.equal(agentDownload.status, 403);
  assert.equal(agentDownload.json.error.code, 'AGENT_ROUTE_FORBIDDEN');
});


test('P3 修复复验：POSIX ":"（path delimiter）分隔可用，两 root 各自合法产物 200、敏感文件仍 403；";" 不再作为分隔符（fail-closed 403）', async (t) => {
  const session = await startConsoleServer(t);
  await seedChain(session.auditPath, session.keyFile, 1);
  writeFileSync(join(session.root, 'root-artifact.json'), '{"root":true}\n');
  writeFileSync(join(session.stateDir, 'state-artifact.json'), '{"state":true}\n');
  const download = (pathname) => call(
    session,
    `/api/production/download?path=${encodeURIComponent(pathname)}`,
    { headers: ui(session) },
  );

  // 修复后：CIRCUITPILOT_DOWNLOAD_ROOTS 用 node:path.delimiter（POSIX ':'）拆分两个 root。
  process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = `${session.root}${delimiter}${session.stateDir}`;
  const rootArtifact = await download(join(session.root, 'root-artifact.json'));
  assert.equal(rootArtifact.status, 200, '第一个 root 内产物应可下载');
  assert.equal(rootArtifact.text, '{"root":true}\n');
  const secondArtifact = await download(join(session.stateDir, 'state-artifact.json'));
  assert.equal(secondArtifact.status, 200, '第二个 root 内产物应可下载（修复前这里 403）');
  assert.equal(secondArtifact.text, '{"state":true}\n');

  // 多 root 配置不得削弱敏感名保护。
  const tokenDownload = await download(session.tokenPath);
  assert.equal(tokenDownload.status, 403);
  assert.equal(tokenDownload.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');
  const keyDownload = await download(session.keyFile);
  assert.equal(keyDownload.status, 403);
  assert.equal(keyDownload.json.error.code, 'DOWNLOAD_SENSITIVE_FORBIDDEN');

  // POSIX 上 ';' 不再是分隔符：整串被当单一路径 → 根列表为空 → fail-closed 403。
  process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = `${session.root};${session.stateDir}`;
  const semicolonRoot = await download(join(session.root, 'root-artifact.json'));
  assert.equal(semicolonRoot.status, 403);
  assert.equal(semicolonRoot.json.error.code, 'DOWNLOAD_PATH_FORBIDDEN');
  const semicolonState = await download(join(session.stateDir, 'state-artifact.json'));
  assert.equal(semicolonState.status, 403);
  assert.equal(semicolonState.json.error.code, 'DOWNLOAD_PATH_FORBIDDEN');
  assertNoSecrets(semicolonRoot.text, session);
});
