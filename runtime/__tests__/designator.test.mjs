import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertAnnotatableDesignator, assertAnnotatedDesignators, findUnannotatedDesignators, isAnnotatedDesignator } from '../designator.mjs';
import { normalizePcbPlan } from '../pcb.mjs';
import { applyPlacementPlan } from '../placement-write.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-desig-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-desig-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-desig-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

test('A5：未标注位号判定与门禁（拒绝 C?/R?，正常位号放行）', () => {
  assert.equal(isAnnotatedDesignator('C12'), true);
  assert.equal(isAnnotatedDesignator('C?'), false);
  assert.equal(isAnnotatedDesignator('?'), false);
  assert.equal(isAnnotatedDesignator(''), false);
  assert.deepEqual(findUnannotatedDesignators(['R1', 'C?', 'U?', 'C?', '']), ['C?', 'U?']);
  assert.throws(() => assertAnnotatedDesignators(['R1', 'C?'], { label: '布局计划' }), (error) => error.code === 'DESIGNATOR_UNANNOTATED' && /布局计划/.test(error.message));
  assert.doesNotThrow(() => assertAnnotatedDesignators(['R1', 'C12']));
  assert.equal(assertAnnotatableDesignator('C36'), 'C36');
  assert.throws(() => assertAnnotatableDesignator('C?'), (error) => error.code === 'DESIGNATOR_INVALID');
  assert.throws(() => assertAnnotatableDesignator('12'), (error) => error.code === 'DESIGNATOR_INVALID');
});

test('A5：布局写回对含 ? 的计划在快照/写入前就拒绝（execute 0 次）', async () => {
  const calls = [];
  const execute = async (id) => { calls.push(id); return { result: true }; };
  await assert.rejects(
    () => applyPlacementPlan({ execute, plan: { placements: [{ ref: 'C?', primitiveId: 'p1', xMm: 1, yMm: 1 }] }, readback: { components: [] }, dryRun: false }),
    (error) => error.code === 'DESIGNATOR_UNANNOTATED',
  );
  assert.deepEqual(calls, [], '未标注位号计划不能触发任何写入/快照');
});

test('A5：PCB 计划里引用 C? 直接判计划不完整', () => {
  const plan = normalizePcbPlan({
    board: { widthMm: 50, heightMm: 40, layers: 2, thicknessMm: 1.6, copperOz: 1 },
    operations: [{ type: 'pcb.component.modify', args: { designator: 'C?' } }],
  });
  assert.equal(plan.ready, false);
  assert.ok(plan.missing.some((item) => item.startsWith('designator-unannotated')));
});

function fakeBridge() {
  const parts = [{ primitiveId: 'p1', designator: 'C?', x: 1, y: 2, uuid: 'dev-uuid', libraryUuid: 'lib-uuid', props: { Designator: 'C?' } }];
  return {
    parts,
    port: 49632,
    selectedWindowId: 'W-DESIG',
    async discover() { return { port: 49632 }; },
    async windows() { return { windows: [{ id: 'W-DESIG' }], selectedWindowId: 'W-DESIG', selectionRequired: false }; },
    listCommands() { return ['schematic.parts.read', 'schematic.component.designator.set', 'schematic.save', 'project.current', 'document.current']; },
    async execute(id, args = {}) {
      if (id === 'project.current') return { result: { uuid: 'P-DESIG' } };
      if (id === 'document.current') return { result: { uuid: 'D-DESIG', documentType: 1 } };
      if (id === 'schematic.parts.read') return { result: parts.map((item) => ({ ...item, props: { ...item.props } })) };
      if (id === 'schematic.component.designator.set') {
        const target = parts.find((item) => item.primitiveId === args.primitiveId);
        if (!target) return { result: { ok: false, primitiveId: args.primitiveId, designator: null, error: 'not found' } };
        target.designator = args.designator;
        target.props.Designator = args.designator;
        return { result: { ok: true, primitiveId: args.primitiveId, designator: args.designator } };
      }
      if (id === 'schematic.save') return { result: true };
      throw Object.assign(new Error(`不应执行的命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

test('A5 HTTP：位号标注必须带写板批准；标注后保存并逐件读回确认', async (context) => {
  const bridge = fakeBridge();
  const { server } = createRuntimeServer({ bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

  // 1) 缺批准：409，且没有改动位号。
  const denied = await post('/api/eda/schematic/designators/set', { items: [{ primitiveId: 'p1', designator: 'C36' }] });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, 'AUTOMATION_APPROVAL_REQUIRED');
  assert.equal(bridge.parts[0].designator, 'C?');

  // 2) 非法目标位号：400（不能把 C? 当目标值）。
  const approval = await (await post('/api/automation/approvals', { scope: 'write', note: 'A5 测试：位号标注' })).json();
  const approvalIds = [approval.approval.id || approval.approval.approvalId];
  const invalid = await post('/api/eda/schematic/designators/set', { items: [{ primitiveId: 'p1', designator: 'C?' }], approvalIds });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'DESIGNATOR_INVALID');

  // 3) 正常标注：保存 + 读回一致。
  const ok = await post('/api/eda/schematic/designators/set', { items: [{ primitiveId: 'p1', designator: 'C36' }], approvalIds, save: true });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.saved, true);
  assert.equal(body.verification[0].actual, 'C36');
  assert.equal(bridge.parts[0].designator, 'C36');
});
