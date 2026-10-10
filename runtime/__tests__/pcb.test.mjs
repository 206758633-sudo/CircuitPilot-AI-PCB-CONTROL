import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCh32v003Fixture, normalizePcbPlan, PCB_CAPABILITIES, PcbManager } from '../pcb.mjs';
import { ApprovalStore } from '../design.mjs';

test('CH32V003 fixture compiles deterministically to a 45x30 two-layer board', () => {
  const a = compileCh32v003Fixture({ placements: { U1: { x: 20, y: 15, rotation: 0 } } });
  const b = compileCh32v003Fixture({ placements: { U1: { x: 20, y: 15, rotation: 0 } } });
  assert.equal(a.ready, true);
  assert.equal(a.planHash, b.planHash);
  assert.deepEqual(a.plan.board, { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 });
  assert.equal(a.plan.operations.filter((item) => item.type === 'pcb.line.create').length, 4);
});

test('unknown PCB operations are rejected', () => {
  const result = normalizePcbPlan({ board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 }, operations: [{ type: 'script.execute', args: {} }] });
  assert.equal(result.ready, false);
  assert.match(result.missing.join(','), /script\.execute/);
});

test('official DRC must be present and be the last operation so a stale pass cannot green-light later writes', () => {
  const board = { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
  const noDrc = normalizePcbPlan({ board, operations: [{ type: 'pcb.save', args: {} }] });
  assert.equal(noDrc.ready, false);
  assert.match(noDrc.missing.join(','), /official-drc-required/);
  // DRC先跑、之后还有写入：这正是“用一次干净的DRC放行改板”的攻击形状。
  const earlyDrc = normalizePcbPlan({ board, operations: [{ type: 'pcb.drc', args: {} }, { type: 'pcb.line.create', args: { layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, lineWidth: 0.2, primitiveLock: false } }, { type: 'pcb.save', args: {} }] });
  assert.equal(earlyDrc.ready, false);
  assert.match(earlyDrc.missing.join(','), /official-drc-must-be-last-operation/);
  const ordered = normalizePcbPlan({ board, operations: [{ type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }] });
  assert.equal(ordered.ready, true);
  // 相同的“早DRC”计划也无法获得批准令牌，因此走不到执行阶段。
  const manager = new PcbManager({ bridge: fakeBridge(), approvals: new ApprovalStore() });
  assert.throws(() => manager.approve({ plan: { board, operations: [{ type: 'pcb.drc', args: {} }, { type: 'pcb.save', args: {} }] }, targetFingerprint: 't', windowId: 'W1' }), { code: 'PCB_PLAN_INCOMPLETE' });
});

test('production capability matrix never presents beta Gerber or autorouting as production ready', () => {
  for (const id of ['gerber-export', 'autorouting']) {
    const item = PCB_CAPABILITIES.find((entry) => entry.id === id);
    assert.equal(item.production, false);
  }
  assert.equal(PCB_CAPABILITIES.find((entry) => entry.id === 'order-payment').status, 'unavailable');
});

function fixturePlan() {
  return compileCh32v003Fixture({ placements: {} }).plan;
}

function fakeBridge({ failDrc = false, failRestore = false } = {}) {
  let source = '{"board":"before"}';
  return {
    selectedWindowId: 'W1',
    async execute(id, args = {}) {
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { if (failRestore) throw new Error('restore failed'); source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      if (id === 'pcb.drc') return { result: failDrc ? [{ code: 'D1' }] : [] };
      source = '{"board":"mutated"}';
      return { result: { primitiveId: `${id}-1` } };
    },
  };
}

async function approvedExecution(manager, plan) {
  const context = await manager.context();
  const approval = manager.approve({ plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  return manager.execute({ plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
}

test('PCB execution snapshots, reads back and requires official DRC result', async () => {
  const manager = new PcbManager({ bridge: fakeBridge(), approvals: new ApprovalStore() });
  const result = await approvedExecution(manager, fixturePlan());
  assert.equal(result.state, 'completed');
  assert.equal(result.drc.passed, true);
  assert.ok(result.events.some((event) => event.stage === 'snapshot'));
  assert.ok(result.events.some((event) => event.stage === 'readback'));
  assert.equal(typeof result.readback.sourceDigest, 'string');
});

test('PCB DRC failure restores, saves and verifies the snapshot', async () => {
  const manager = new PcbManager({ bridge: fakeBridge({ failDrc: true }), approvals: new ApprovalStore() });
  const result = await approvedExecution(manager, fixturePlan());
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.error.code, 'PCB_DRC_FAILED');
  assert.ok(result.events.some((event) => event.stage === 'rollback' && event.status === 'passed'));
});

test('PCB rollback failure locks subsequent writes', async () => {
  const manager = new PcbManager({ bridge: fakeBridge({ failDrc: true, failRestore: true }), approvals: new ApprovalStore() });
  const first = await approvedExecution(manager, fixturePlan());
  assert.equal(first.state, 'rollback_failed');
  const context = await manager.context();
  const approval = manager.approve({ plan: fixturePlan(), targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  await assert.rejects(() => manager.execute({ plan: fixturePlan(), approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId }), { code: 'PCB_WRITE_LOCKED' });
});

test('partial stage mutation rolls back to the stage snapshot and emits bounded progress heartbeats', async () => {
  let source = '{"state":"before"}'; let creates = 0;
  const bridge = fakeBridge();
  bridge.execute = async (id, args = {}) => {
    if (id === 'project.current') return { result: { uuid: 'P1' } };
    if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
    if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts)\.read$/.test(id)) return { result: [] };
    if (id === 'pcb.rules.read') return { result: {} };
    if (id === 'pcb.source.read') return { result: source };
    if (id === 'document.source.restore') { source = args.source; return { result: true }; }
    if (id === 'pcb.save') return { result: true };
    if (id === 'pcb.line.create') { creates += 1; source = `{"state":"line-${creates}"}`; if (creates === 2) throw Object.assign(new Error('partial failure'), { code: 'PARTIAL' }); return { result: { primitiveId: `L${creates}` } }; }
    if (id === 'pcb.drc') return { result: [] };
    return { result: true };
  };
  const plan = fixturePlan();
  const manager = new PcbManager({ bridge, approvals: new ApprovalStore(), batchSize: 1 });
  const result = await approvedExecution(manager, plan);
  assert.equal(result.state, 'rolled_back');
  assert.equal(source, '{"state":"before"}');
  assert.ok(result.events.some((event) => event.status === 'heartbeat'));
});

test('operation timeout rolls back and records a precise failure code', async () => {
  const bridge = fakeBridge();
  const original = bridge.execute.bind(bridge);
  bridge.execute = async (id, args = {}, options = {}) => id === 'pcb.importChanges' ? new Promise(() => {}) : original(id, args, options);
  const manager = new PcbManager({ bridge, approvals: new ApprovalStore(), operationTimeoutMs: 5 });
  const result = await approvedExecution(manager, fixturePlan());
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.error.code, 'PCB_OPERATION_TIMEOUT');
});
