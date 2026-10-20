import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

// 状态目录必须隔离：项目级状态文件写在 CIRCUITPILOT_STATE_DIR 下，多个测试文件并行时不能互相覆盖。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-project-isolation-'));
process.env.CIRCUITPILOT_STATE_DIR = STATE_DIR;
process.on('exit', () => { try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };

// 假桥：模拟"当前 EDA 窗口打开的是 proj-a 的板子"，用于绑定校验。
const eda = {
  projectUuid: 'eda-project-a',
  documentUuid: 'pcb-a',
  calls: 0,
};
const fakeBridge = {
  port: 49620,
  selectedWindowId: 'window-a',
  async discover() {},
  async windows() { return { selectionRequired: false, windows: [{ id: 'window-a' }] }; },
  async execute(command) {
    eda.calls += 1;
    if (command === 'project.current') {
      return { ok: true, result: { uuid: eda.projectUuid, data: [{ itemType: 'Board', name: '智能衣橱助手主板', schematic: { uuid: 'sch-a' }, pcb: { uuid: 'pcb-a' } }] } };
    }
    if (command === 'document.current') return { ok: true, result: { uuid: eda.documentUuid, documentType: 3 } };
    if (command === 'schematic.catalog') return { ok: true, result: { pages: [{ uuid: 'page-a', parentSchematicUuid: 'sch-a' }] } };
    return { ok: true, result: {} };
  },
};

async function startServer(context) {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  return { call };
}

const projectA = { id: 'proj-a', name: '项目 A', stage: '原理图', archived: false, edaWorkspace: { projectUuid: 'eda-project-a', pcbUuid: 'pcb-a', schematicPageUuid: 'page-a' } };
const projectB = { id: 'proj-b', name: '项目 B', stage: '需求', archived: false, edaWorkspace: { projectUuid: 'eda-project-b', pcbUuid: 'pcb-b', schematicPageUuid: 'page-b' } };

test('C6 项目级状态隔离：切片读不串项目、切片写强制打标、跨项目写入被拒', async (context) => {
  const { call } = await startServer(context);

  // 1) 先写一份"旧版聚合状态"（模拟 C1 的单文件数据），项目 A 是 active。
  const seeded = await call('PUT', '/api/project-state', {
    state: {
      projects: [projectA, projectB],
      activeProjectId: 'proj-a',
      requirements: [{ id: 'r-a', name: 'A 的需求' }, { id: 'r-b', name: 'B 的需求', projectId: 'proj-b' }, { id: 'r-legacy', name: '历史未打标需求' }],
      components: [{ id: 'c-a', refdes: 'U1', projectId: 'proj-a' }, { id: 'c-b', refdes: 'U2', projectId: 'proj-b' }],
      assets: [{ id: 'a-a', name: 'A 的资料', projectId: 'proj-a' }, { id: 'a-b', name: 'B 的资料', projectId: 'proj-b' }],
    },
  });
  assert.equal(seeded.status, 200);

  // 2) 列表：两个项目都在，且各自状态文件尚未建立（savedAt=null）。
  const list = await call('GET', '/api/projects');
  assert.equal(list.status, 200);
  assert.deepEqual(list.payload.projects.map((item) => item.id).sort(), ['proj-a', 'proj-b']);

  // 3) 读项目 A 切片：只含 A 的数据 + 未打标历史数据（因为 A 是旧的 active 项目）。
  const sliceA = await call('GET', '/api/projects/proj-a/state');
  assert.equal(sliceA.status, 200);
  assert.equal(sliceA.payload.source, 'legacy-migration');
  assert.deepEqual(sliceA.payload.state.requirements.map((item) => item.id).sort(), ['r-a', 'r-legacy']);
  assert.deepEqual(sliceA.payload.state.components.map((item) => item.id), ['c-a']);
  assert.deepEqual(sliceA.payload.state.assets.map((item) => item.id), ['a-a']);

  // 4) 读项目 B 切片：绝不含 A 的数据，也不含"未打标但属于 A 的历史数据"。
  const sliceB = await call('GET', '/api/projects/proj-b/state');
  assert.equal(sliceB.status, 200);
  assert.deepEqual(sliceB.payload.state.requirements.map((item) => item.id), ['r-b']);
  assert.deepEqual(sliceB.payload.state.components.map((item) => item.id), ['c-b']);
  assert.deepEqual(sliceB.payload.state.assets.map((item) => item.id), ['a-b']);

  // 5) 写项目 A 切片：未打标的新需求/器件被服务端强制打标；写入只落 proj-a 文件。
  const saved = await call('PUT', '/api/projects/proj-a/state', {
    state: {
      projects: [projectA],
      activeProjectId: 'proj-a',
      requirements: [{ id: 'r-new', name: 'A 新增需求' }],
      components: [{ id: 'c-new', refdes: 'U3' }],
      assets: [],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.tagged, 2, '未打标的 2 条实体必须被强制打标');
  assert.ok(saved.payload.state.requirements.every((item) => item.projectId === 'proj-a'));
  const rereadA = await call('GET', '/api/projects/proj-a/state');
  assert.equal(rereadA.payload.source, 'project');
  assert.deepEqual(rereadA.payload.state.requirements.map((item) => item.id), ['r-new']);
  // 项目 B 不受影响
  const rereadB = await call('GET', '/api/projects/proj-b/state');
  assert.deepEqual(rereadB.payload.state.requirements.map((item) => item.id), ['r-b']);
});

test('C6 隔离 fail-closed：跨项目实体/错误 activeProjectId/非法 id/未知项目都被拒绝', async (context) => {
  const { call } = await startServer(context);
  await call('PUT', '/api/project-state', { state: { projects: [projectA, projectB], activeProjectId: 'proj-a', requirements: [], components: [], assets: [] } });

  const crossEntity = await call('PUT', '/api/projects/proj-a/state', {
    state: { projects: [projectA], activeProjectId: 'proj-a', requirements: [{ id: 'r-x', projectId: 'proj-b' }], components: [], assets: [] },
  });
  assert.equal(crossEntity.status, 400);
  assert.equal(crossEntity.payload.error.code, 'PROJECT_STATE_INVALID');
  assert.match(crossEntity.payload.error.message, /不能通过项目 proj-a 的切片写入/);

  const wrongActive = await call('PUT', '/api/projects/proj-a/state', {
    state: { projects: [projectA], activeProjectId: 'proj-b', requirements: [], components: [], assets: [] },
  });
  assert.equal(wrongActive.status, 400);
  assert.equal(wrongActive.payload.error.code, 'PROJECT_STATE_INVALID');

  const badId = await call('GET', '/api/projects/..%2F..%2Fetc/state');
  assert.equal(badId.status, 400);
  assert.equal(badId.payload.error.code, 'PROJECT_STATE_INVALID');

  const unknown = await call('GET', '/api/projects/proj-missing/state');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.payload.error.code, 'PROJECT_STATE_NOT_FOUND');
});

test('C6 EDA 窗口绑定校验：一致=ready，不一致列出工程/PCB 差异，未绑定不碰 EDA 会话', async (context) => {
  const { call } = await startServer(context);
  await call('PUT', '/api/project-state', {
    state: {
      projects: [projectA, projectB, { id: 'proj-c', name: '未绑定项目', stage: '概念', archived: false }],
      activeProjectId: 'proj-a', requirements: [], components: [], assets: [],
    },
  });

  const matching = await call('GET', '/api/projects/proj-a/binding/verify');
  assert.equal(matching.status, 200);
  assert.equal(matching.payload.ready, true);
  assert.deepEqual(matching.payload.mismatches, []);
  assert.equal(matching.payload.current.projectUuid, 'eda-project-a');
  assert.equal(matching.payload.current.pcbUuid, 'pcb-a');

  const mismatch = await call('GET', '/api/projects/proj-b/binding/verify');
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.payload.ready, false);
  assert.ok(mismatch.payload.mismatches.some((item) => item.includes('工程不一致')), JSON.stringify(mismatch.payload.mismatches));
  assert.ok(mismatch.payload.mismatches.some((item) => item.includes('PCB 文档不一致')));

  const callsBefore = eda.calls;
  const unbound = await call('GET', '/api/projects/proj-c/binding/verify');
  assert.equal(unbound.status, 200);
  assert.equal(unbound.payload.bound, false);
  assert.equal(unbound.payload.ready, false);
  assert.ok(unbound.payload.mismatches.some((item) => item.includes('尚未绑定')));
  assert.equal(eda.calls, callsBefore, '未绑定项目不应为了校验去碰 EDA 会话');
});
