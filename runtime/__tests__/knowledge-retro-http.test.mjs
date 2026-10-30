import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { ensureAgentTokenFile } from '../agent-token.mjs';

// W5-01：复盘学习 Agent 的 HTTP 层契约（UI 会话触发；没有事实 → 409，不写空复盘）。
const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
const UI_TOKEN = 'ui-session-token-for-retro-test';
const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

async function start(context) {
  const root = mkdtempSync(join(tmpdir(), 'cp-retro-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  context.after(() => {
    for (const key of ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const tokenPath = join(root, 'agent-token.json');
  await ensureAgentTokenFile({ file: tokenPath });
  // 注入假 chat：AI 起草经验的路由必须走 ChatManager.generate；单测里不联网、不碰钥匙串。
  const fakeChat = {
    async generate() {
      return {
        json: {
          lessons: [
            { kind: 'failure', title: 'AI 草案：上电浪涌', symptom: '输入电流尖峰超过保险丝额定', rootCause: '输入电容无缓启动', prevention: ['加 NTC 或缓启动 MOSFET'] },
            { kind: 'rule', title: 'AI 草案：缺少数值边界', statement: '输入 ≥24V 时必须做浪涌评估' },
          ],
        },
        text: '', model: 'fake-model', providerId: 'fake-provider',
      };
    },
    async status() { return { ready: false, provider: null, activeSessions: 0 }; },
    listSessions() { return []; },
    transcript() { return { messages: [] }; },
    close() {},
  };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, runtimeToken: UI_TOKEN, agentTokenPath: tokenPath, chat: fakeChat });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, headers: { 'content-type': 'application/json', 'x-circuitpilot-token': UI_TOKEN }, dirs: { state: join(root, 'state'), evidence: join(root, 'evidence') } };
}

test('GET /api/knowledge/retro/status：声明能力边界，初始无运行记录', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/knowledge/retro/status`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agent.agent, 'retrospective-learner');
  assert.equal(body.agent.lastRun, null);
  assert.ok(body.agent.writes.includes('knowledge:candidate'));
  assert.ok(body.agent.never.includes('knowledge:approved'));
});

test('POST /api/knowledge/retro/run：无事实 → 409 RETRO_NO_EVIDENCE（不写空复盘）', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/knowledge/retro/run`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p-empty' }) });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'RETRO_NO_EVIDENCE');
});

test('POST /api/knowledge/retro/run：只有经验也接受（candidate + KMA 整理报告）', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/knowledge/retro/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectId: 'p-retro-http', includeEvidence: false,
      lessons: [{
        kind: 'failure', title: 'HTTP 冒烟：48V 输入无缓启动',
        symptom: '上电冲击电流超过保险丝额定', rootCause: '输入电容无 NTC/缓启动',
        prevention: ['加 NTC 或缓启动 MOSFET'],
      }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.run.summary.created, 1);
  assert.equal(body.run.candidates[0].kind, 'failure');
  assert.equal(body.run.candidates[0].created, true);
  assert.equal(body.maintenance.ok, true);
  assert.equal(body.maintenance.pendingReview, 1, 'KMA 整理后待审 1 条');
  const status = await (await fetch(`${base}/api/knowledge/retro/status`, { headers })).json();
  assert.equal(status.agent.lastRun.ok, true);
  assert.equal(status.agent.totals.runs, 1);
});

test('POST /api/knowledge/retro/run：非法经验 → 400 RETRO_LESSON_INVALID（不写半套）', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/knowledge/retro/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectId: 'p-bad', lessons: [{ kind: 'rule', title: '没有数值边界' }] }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'RETRO_LESSON_INVALID');
  const status = await (await fetch(`${base}/api/knowledge/retro/status`, { headers })).json();
  assert.equal(status.agent.lastRun.ok, false);
});

test('POST /api/knowledge/retro/draft：模型草案经字段校验后返回（不写库），无事实 → 409', async (context) => {
  const { base, headers } = await start(context);
  const empty = await fetch(`${base}/api/knowledge/retro/draft`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p-draft' }) });
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).error.code, 'RETRO_NO_EVIDENCE');

  const response = await fetch(`${base}/api/knowledge/retro/draft`, {
    method: 'POST', headers,
    body: JSON.stringify({ projectId: 'p-draft', includeEvidence: false, notes: '交付归档后发现输入浪涌' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.draft.lessons.length, 1, '缺 limits 的 rule 草案被字段校验丢弃');
  assert.equal(body.draft.problems.length, 1);
  assert.equal(body.draft.problems[0].code, 'LESSON_LIMITS_MISSING');
  assert.equal(body.draft.model, 'fake-model');
  const status = await (await fetch(`${base}/api/knowledge/retro/status`, { headers })).json();
  assert.equal(status.agent.lastRun, null, '草案不写库、不算一次复盘运行');
});

test('POST /api/knowledge/retro/merge：没有跨项目数据时返回 0 组，不写候选', async (context) => {
  const { base, headers } = await start(context);
  const response = await fetch(`${base}/api/knowledge/retro/merge`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.merge.groups, 0);
  assert.equal(body.merge.created, 0);
  assert.equal(body.merge.minProjects, 2);
});

test('POST /api/knowledge/retro/export：返回脱敏经验包且不写库、不落盘', async (context) => {
  const { base, headers, dirs } = await start(context);
  const knowledgeDir = join(dirs.state, 'knowledge');
  const before = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).length : 0;
  const beforeStatus = await (await fetch(`${base}/api/knowledge/retro/status`, { headers })).json();
  const response = await fetch(`${base}/api/knowledge/retro/export`, {
    method: 'POST', headers,
    body: JSON.stringify({ projectId: 'p-export', includeEvidence: false, notes: '导出测试：/Users/alice/board.kicad_pcb', lessons: [] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bundle.kind, 'circuitpilot-experience-bundle');
  assert.match(body.preview.bundleSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(body.bundle).includes('/Users/alice'));
  const after = await (await fetch(`${base}/api/knowledge/retro/status`, { headers })).json();
  assert.equal(after.agent.lastRun, null, '导出不是一次复盘运行');
  assert.equal(beforeStatus.agent.lastRun, null);
  const afterCount = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).length : 0;
  assert.equal(afterCount, before, '导出不应写知识库');
  assert.equal(existsSync(join(dirs.evidence, 'retrospective')), false, '导出不应落证据文件');
});
