import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { normalizeProjectState } from '../project-state.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-pstate-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-pstate-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-pstate-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const fakeBridge = {
  port: 49632,
  selectedWindowId: 'W-PSTATE',
  async discover() { return { port: 49632 }; },
  async windows() { return { windows: [{ id: 'W-PSTATE' }], selectedWindowId: 'W-PSTATE', selectionRequired: false }; },
  async execute(command) {
    if (command === 'project.current') return { result: { uuid: 'P-PSTATE', data: [] } };
    if (command === 'document.current') return { result: null };
    return { result: {} };
  },
};

async function start(context) {
  const { server } = createRuntimeServer({ bridge: fakeBridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    get: () => fetch(`${base}/api/project-state`, { headers }),
    put: (body) => fetch(`${base}/api/project-state`, { method: 'PUT', headers, body: JSON.stringify(body) }),
  };
}

const state = {
  projects: [{ id: 'p1', name: '智能衣橱助手', stage: '设计' }],
  activeProjectId: 'p1',
  requirements: [{ id: 'r1', title: '控制 3 路电机', content: '支持正反转' }],
  components: [{ id: 'c1', designator: 'U1' }],
  assets: [{ id: 'a1', name: 'spec.pdf' }],
};

test('C1：项目状态 GET 默认空状态，PUT 后可跨请求读回', async (context) => {
  const api = await start(context);
  const initial = await (await api.get()).json();
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.state.projects, []);
  assert.equal(initial.state.activeProjectId, null);

  const saved = await (await api.put({ state })).json();
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.state.projects, state.projects);
  assert.deepEqual(saved.state.requirements, state.requirements);
  assert.equal(typeof saved.savedAt, 'string');

  const reloaded = await (await api.get()).json();
  assert.deepEqual(reloaded.state, saved.state);
});

test('C1：非法状态 fail-closed（id 重复 / activeProjectId 悬空 / projects 非数组）', async (context) => {
  const api = await start(context);
  const duplicated = await api.put({ state: { ...state, projects: [state.projects[0], state.projects[0]] } });
  assert.equal(duplicated.status, 400);
  assert.equal((await duplicated.json()).error.code, 'PROJECT_STATE_INVALID');

  const dangling = await api.put({ state: { ...state, activeProjectId: 'missing' } });
  assert.equal(dangling.status, 400);
  assert.equal((await dangling.json()).error.code, 'PROJECT_STATE_INVALID');

  const badShape = await api.put({ state: { ...state, projects: 'not-an-array' } });
  assert.equal(badShape.status, 400);

  const flat = await api.put({ projects: state.projects });
  assert.equal(flat.status, 400);
  assert.equal((await flat.json()).error.code, 'PROJECT_STATE_INVALID');
});

test('C1：normalizeProjectState 保留未知字段（器件/资料原样）并补 updatedAt', () => {
  const normalized = normalizeProjectState({ ...state, components: [{ id: 'c1', extra: 1 }] });
  assert.equal(normalized.components.length, 1);
  assert.equal(normalized.components[0].extra, 1);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(typeof normalized.updatedAt, 'string');
  assert.equal(normalized.activeProjectId, 'p1');
});
