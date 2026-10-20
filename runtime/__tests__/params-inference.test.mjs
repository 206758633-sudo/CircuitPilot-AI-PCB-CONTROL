import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { inferRecipeParams } from '../automation/params-inference.mjs';
import { planOrchestration } from '../automation/orchestration.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-params-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-params-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-params-auto-'));
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const RECIPES = ['eda-read-project', 'eda-read-document', 'pcb-sync-from-schematic', 'pcb-rebuild-pours', 'pcb-create-pour', 'eda-screenshot-evidence'].map((id) => ({ id }));

const EVIDENCE = {
  pours: { pours: [{ id: 'pour-1', net: 'GND', layer: 1 }, { id: 'pour-2', net: '3V3', layer: 1 }] },
  board: { outline: [[0, 0], [60000, 0], [60000, 40000], [0, 40000]] },
  nets: [{ name: 'GND' }, { name: '3V3' }],
  schematic: { uuid: 'sch-1', parts: [{ designator: 'U1' }, { designator: 'R1' }] },
};

async function start(context) {
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return (body) => fetch(`${base}/api/automation/orchestration/plan`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('E10.2 新建覆铜参数：数量/现有 id/板框/网络/层全部来自证据，不猜', () => {
  const complete = inferRecipeParams({ recipeId: 'pcb-create-pour', evidence: EVIDENCE });
  assert.equal(complete.ok, true);
  assert.equal(complete.params.expectedPourCount, 3);
  assert.deepEqual(complete.params.existingPourIds, ['pour-1', 'pour-2']);
  assert.deepEqual(complete.params.outline, [[0, 0], [60000, 0], [60000, 40000], [0, 40000]]);
  assert.equal(complete.params.net, 'GND');
  assert.equal(complete.params.layer, 1);
  assert.ok(complete.notes.some((note) => note.includes('默认顶层')));
  assert.equal(complete.sources.outline, 'board outline vertices (mil)');

  const partial = inferRecipeParams({ recipeId: 'pcb-create-pour', evidence: { pours: { pours: [] } } });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'E10_PARAMS_EVIDENCE_MISSING');
  assert.ok(partial.missing.includes('board.outline'));
  assert.ok(partial.missing.includes('net'));
  // 缺证据时绝不能给出"大概"参数
  assert.equal(partial.params.expectedPourCount, 1);

  const noEvidence = inferRecipeParams({ recipeId: 'pcb-create-pour', evidence: null });
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.missing.includes('pours'));
});

test('E10.2 同步参数：expectedComponentCount 来自原理图读回；重建无必填参数', () => {
  const sync = inferRecipeParams({ recipeId: 'pcb-sync-from-schematic', evidence: EVIDENCE });
  assert.equal(sync.ok, true);
  assert.equal(sync.params.expectedComponentCount, 2);
  assert.equal(sync.params.schematicUuid, 'sch-1');

  const missing = inferRecipeParams({ recipeId: 'pcb-sync-from-schematic', evidence: { schematic: { parts: [] } } });
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.includes('schematic.parts'));

  const rebuild = inferRecipeParams({ recipeId: 'pcb-rebuild-pours', evidence: null });
  assert.equal(rebuild.ok, true);
  assert.deepEqual(rebuild.params, {});
  assert.equal(rebuild.recipeId, 'pcb-rebuild-pours');
});

test('E10.2 编排集成：有证据填参数；无证据显式 not-provided；证据不全阻断计划', () => {
  const withEvidence = planOrchestration({ goal: '新建覆铜', recipes: RECIPES, evidence: EVIDENCE });
  assert.equal(withEvidence.ok, true);
  const pourNode = withEvidence.nodes.find((node) => node.recipeId === 'pcb-create-pour');
  assert.equal(pourNode.params.net, 'GND');
  assert.equal(pourNode.paramsInference.ok, true);
  assert.equal(pourNode.paramsInference.sources.net, 'detected GND net');

  const noEvidence = planOrchestration({ goal: '新建覆铜', recipes: RECIPES });
  const noEvidenceNode = noEvidence.nodes.find((node) => node.recipeId === 'pcb-create-pour');
  assert.deepEqual(noEvidenceNode.params, {});
  assert.equal(noEvidenceNode.paramsInference.status, 'not-provided');

  const partial = planOrchestration({ goal: '新建覆铜', recipes: RECIPES, evidence: { pours: { pours: [] } } });
  assert.equal(partial.ok, false);
  const blocker = partial.budget.blockers.find((item) => item.code === 'E10_PARAMS_EVIDENCE_MISSING');
  assert.ok(blocker);
  assert.ok(blocker.message.includes('board.outline'));
});

test('E10.2 HTTP：/plan 透传 evidence，参数与阻断如实返回', async (context) => {
  const post = await start(context);
  const withEvidence = await (await post({ goal: '新建覆铜', evidence: EVIDENCE })).json();
  assert.equal(withEvidence.ok, true);
  assert.equal(withEvidence.plan.ok, true);
  const node = withEvidence.plan.nodes.find((item) => item.recipeId === 'pcb-create-pour');
  assert.equal(node.params.net, 'GND');
  assert.equal(node.params.expectedPourCount, 3);

  const withoutEvidence = await (await post({ goal: '新建覆铜' })).json();
  const bare = withoutEvidence.plan.nodes.find((item) => item.recipeId === 'pcb-create-pour');
  assert.deepEqual(bare.params, {});
  assert.equal(bare.paramsInference.status, 'not-provided');
});
