import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalStore, DesignManager, attachPlanLineage, documentSourceDigest, normalizePlan, planLineageHashes, wireOperationMatches } from '../design.mjs';
import { createApprovalLedger } from '../approval-ledger.mjs';

const completePlan = {
  blocks: Object.fromEntries(['mcu', 'power', 'led', 'button'].map((id) => [id, { libraryUuid: `lib-${id}`, uuid: `dev-${id}`, value: id }])),
  nets: ['3V3', 'GND'],
  operations: [{ type: 'component.create', args: { component: { libraryUuid: 'lib-mcu', uuid: 'dev-mcu' }, x: 10, y: 20 } }],
};

test('plan normalization is deterministic and blocks unknown parts or arbitrary operations', () => {
  const first = normalizePlan(completePlan);
  const second = normalizePlan({ ...completePlan, title: 'MCU + 电源 + LED + 按键简单控制板' });
  assert.equal(first.ready, true);
  assert.equal(first.planHash, second.planHash);
  const blocked = normalizePlan({ ...completePlan, blocks: { ...completePlan.blocks, mcu: null }, operations: [{ type: 'javascript.eval', args: {} }] });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.missing.includes('mcu:未提供'));
  assert.ok(blocked.missing.includes('unsupported-operation:javascript.eval'));
});

test('approval tokens are bound, expire, and cannot be replayed', () => {
  let now = 1_000;
  const approvals = new ApprovalStore({ ttlMs: 100, now: () => now });
  const issued = approvals.issue({ planHash: 'plan', targetFingerprint: 'target', windowId: 'window', steps: ['write'] });
  assert.throws(() => approvals.consume(issued.token, { planHash: 'tampered', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_MISMATCH' });
  approvals.consume(issued.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' });
  assert.throws(() => approvals.consume(issued.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_REPLAYED' });
  const expiring = approvals.issue({ planHash: 'plan', targetFingerprint: 'target', windowId: 'window', steps: [] });
  now = 1_101;
  assert.throws(() => approvals.consume(expiring.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_EXPIRED' });
});

test('document digest ignores EasyEDA save metadata but detects design changes', () => {
  const a = 'HEAD||{"docType":"SCH_PAGE","client":"aaa","updateTime":1,"version":"1"}||BODY-A';
  const b = 'HEAD||{"docType":"SCH_PAGE","client":"bbb","updateTime":2,"version":"2"}||BODY-A';
  assert.equal(documentSourceDigest(a), documentSourceDigest(b));
  assert.notEqual(documentSourceDigest(a), documentSourceDigest(b.replace('BODY-A', 'BODY-B')));
});

test('wire readback accepts merged paths by net and exact segment geometry', () => {
  const operation = { type: 'wire.create', args: { net: '+5V', line: [45, 155, 130, 155, 130, 200] } };
  assert.equal(wireOperationMatches(operation, [{ net: '+5V', line: [160, 200, 130, 200, 130, 155, 45, 155] }]), true);
  assert.equal(wireOperationMatches({ type: 'wire.create', args: { net: '+5V', line: [160, 180, 160, 200] } }, [{ net: '+5V', line: [160, 160, 160, 220] }]), true);
  assert.equal(wireOperationMatches(operation, [{ net: '+5V', line: [45, 155, 130, 155] }]), false);
  assert.equal(wireOperationMatches(operation, [{ net: 'GND', line: [45, 155, 130, 155, 130, 200] }]), false);
});

test('mutated execution restores and verifies source when official DRC fails', async () => {
  let source = 'before-source';
  // P1-3：写入前基线已有一条既有违规；写入后新增一条 → 只有新增被阻断并回滚。
  let drcRuns = 0;
  const bridge = {
    selectedWindowId: 'window-1',
    listCommands() { return ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'].map((id) => ({ id })); },
    async execute(id, args) {
      if (id === 'project.current') return { id: 'project-1' };
      if (id === 'document.current') return { id: 'document-1', type: 'schematic' };
      if (id === 'schematic.catalog') return { pages: [{ id: 'page-1' }] };
      if (id === 'schematic.components') return { components: source === 'after-source' ? [{ primitiveId: 'P1' }] : [], pins: {} };
      if (id === 'schematic.wires') return [];
      if (id === 'document.source.read') return source;
      if (id === 'schematic.component.create') { source = 'after-source'; return { primitiveId: 'P1' }; }
      if (id === 'schematic.wire.read') return [];
      if (id === 'schematic.save') return true;
      if (id === 'schematic.drc') {
        drcRuns += 1;
        return drcRuns === 1
          ? [{ rule: 'unconnected', severity: 'error' }]
          : [{ rule: 'unconnected', severity: 'error' }, { rule: 'pin-collision', severity: 'error' }];
      }
      if (id === 'document.source.restore') { source = args.source; return true; }
      throw new Error(`unexpected ${id}`);
    },
  };
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({ plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  const result = await manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.error.code, 'DRC_FAILED');
  assert.equal(result.error.details.mode, 'baseline');
  assert.equal(result.drcBaseline.count, 1);
  assert.equal(result.drcExempted.length, 1);
  assert.equal(result.drcRegressions.length, 1);
  assert.match(result.drcRegressions[0].key, /pin-collision/);
  assert.equal(source, 'before-source');
  assert.equal(result.snapshot.source, undefined);
});

test('pin.noConnect resolves only a component created by the approved plan and verifies pin state', async () => {
  let source = 'before-source';
  const plan = { ...completePlan, operations: [
    completePlan.operations[0],
    { type: 'pin.noConnect', args: { componentOperationIndex: 0, pinNumbers: ['2', '3'] } },
  ] };
  const bridge = {
    selectedWindowId: 'window-1',
    listCommands() { return ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'].map((id) => ({ id })); },
    async execute(id, args) {
      if (id === 'project.current') return { id: 'project-1' };
      if (id === 'document.current') return { id: 'document-1', type: 'schematic' };
      if (id === 'schematic.catalog') return { pages: [{ id: 'page-1' }] };
      if (id === 'schematic.components') return source === 'after-source' ? { components: [{ primitiveId: 'P1' }], pins: { P1: [{ pinNumber: '2', noConnected: true }, { pinNumber: '3', noConnected: true }] } } : { components: [], pins: {} };
      if (id === 'schematic.wires' || id === 'schematic.wire.read') return [];
      if (id === 'document.source.read') return source;
      if (id === 'schematic.component.create') { source = 'after-source'; return { primitiveId: 'P1' }; }
      if (id === 'schematic.pin.noConnect') { assert.equal(args.componentPrimitiveId, 'P1'); return { componentPrimitiveId: 'P1', pinNumbers: ['2', '3'] }; }
      if (id === 'schematic.save') return true;
      if (id === 'schematic.drc') return [];
      throw new Error(`unexpected ${id}`);
    },
  };
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({ plan, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  const result = await manager.execute({ plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  assert.equal(result.state, 'completed');
  assert.equal(result.events.find((event) => event.stage === 'readback').detail.verifiedNoConnectPins, 2);
});


test('P0-1：计划血缘双哈希被保留并参与 planHash/批准绑定（不再被重建丢弃）', () => {
  const semanticPlanHash = 'a'.repeat(64);
  const compiledPlanHash = 'b'.repeat(64);
  const withLineage = normalizePlan({ ...completePlan, semanticPlanHash, compiledPlanHash });
  assert.equal(withLineage.ready, true);
  assert.equal(withLineage.plan.semanticPlanHash, semanticPlanHash);
  assert.equal(withLineage.plan.compiledPlanHash, compiledPlanHash);
  // 没带血缘的同一计划得到不同哈希：事后能证明“写的是哪一份来源计划”。
  const withoutLineage = normalizePlan(completePlan);
  assert.notEqual(withLineage.planHash, withoutLineage.planHash);
  // P1-2：显式非法哈希必须 fail-closed（不再静默丢弃），由专项测试覆盖；缺省仍兼容。
  assert.deepEqual(planLineageHashes({ semanticPlanHash: 'A'.repeat(32), compiledPlanHash: 'B'.repeat(32) }), { semanticPlanHash: 'a'.repeat(32), compiledPlanHash: 'b'.repeat(32) });
  assert.equal(attachPlanLineage({ x: 1 }, {}).semanticPlanHash, undefined);
});

test('P0-1：批准令牌/账本同时绑定双哈希；任一不一致 APPROVAL_MISMATCH', () => {
  const ledger = createApprovalLedger();
  const approvals = new ApprovalStore({ ledger, ttlMs: 60_000 });
  const semanticPlanHash = 'c'.repeat(64);
  const compiledPlanHash = 'd'.repeat(64);
  const normalized = normalizePlan({ ...completePlan, semanticPlanHash, compiledPlanHash });
  const issued = approvals.issue({
    planHash: normalized.planHash, targetFingerprint: 'target', windowId: 'window', steps: ['write'],
    semanticPlanHash, compiledPlanHash,
  });
  assert.equal(issued.semanticPlanHash, semanticPlanHash);
  assert.equal(issued.compiledPlanHash, compiledPlanHash);
  const ledgerEntry = ledger.snapshot().entries.find((entry) => entry.action === 'issued' && entry.bindings?.planHash === normalized.planHash);
  assert.ok(ledgerEntry, '账本必须记录批准事件');
  assert.equal(ledgerEntry.bindings.semanticPlanHash, semanticPlanHash);
  assert.equal(ledgerEntry.bindings.compiledPlanHash, compiledPlanHash);
  assert.throws(() => approvals.consume(issued.token, {
    planHash: normalized.planHash, targetFingerprint: 'target', windowId: 'window',
    semanticPlanHash: 'e'.repeat(64), compiledPlanHash,
  }), { code: 'APPROVAL_MISMATCH' });
  const consumed = approvals.consume(issued.token, {
    planHash: normalized.planHash, targetFingerprint: 'target', windowId: 'window',
    semanticPlanHash, compiledPlanHash,
  });
  assert.equal(consumed.semanticPlanHash, semanticPlanHash);
  assert.equal(consumed.compiledPlanHash, compiledPlanHash);
});

function createSchematicBridge({ drcRuns = [() => []], onAfterWrite = null } = {}) {
  const state = { source: 'before-source', project: { uuid: 'project-1' }, document: { uuid: 'document-1', documentType: 1 }, drcRuns: 0 };
  const bridge = {
    selectedWindowId: 'window-1',
    listCommands() { return ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'].map((id) => ({ id })); },
    async execute(id, args) {
      if (id === 'project.current') return state.project;
      if (id === 'document.current') return state.document;
      if (id === 'schematic.catalog') return { pages: [{ id: 'page-1' }] };
      if (id === 'schematic.components') return { components: state.source === 'after-source' ? [{ primitiveId: 'P1' }] : [], pins: {} };
      if (id === 'schematic.wires' || id === 'schematic.wire.read') return [];
      if (id === 'document.source.read') return state.source;
      if (id === 'schematic.component.create') { state.source = 'after-source'; if (onAfterWrite) onAfterWrite(state); return { primitiveId: 'P1' }; }
      if (id === 'schematic.save') return true;
      if (id === 'schematic.drc') { const step = drcRuns[Math.min(state.drcRuns, drcRuns.length - 1)]; state.drcRuns += 1; return typeof step === 'function' ? step(state) : step; }
      if (id === 'document.source.restore') { state.source = args.source; return true; }
      if (id === 'schematic.drc.ui') return true;
      throw new Error(`unexpected ${id}`);
    },
  };
  return { bridge, state };
}

async function approveAndExecute(manager, options = {}) {
  const context = await manager.context();
  const approval = manager.approve({ plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1', ...(options.approve || {}) });
  const execution = await manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1', ...(options.execute || {}) });
  return { approval, execution };
}

test('P1-2：显式非法/空白/非字符串血缘抛 APPROVAL_LINEAGE_INVALID(400)，缺省/null 兼容', () => {
  const invalidValues = ['not-a-hash', '', '   ', 'abc', 'a'.repeat(15), 'a'.repeat(65), 'g'.repeat(32), 123, {}, [], true];
  for (const value of invalidValues) {
    assert.throws(() => planLineageHashes({ semanticPlanHash: value }), (error) => error.code === 'APPROVAL_LINEAGE_INVALID' && error.status === 400 && error.details.field === 'semanticPlanHash');
    assert.throws(() => attachPlanLineage({ x: 1 }, { compiledPlanHash: value }), (error) => error.code === 'APPROVAL_LINEAGE_INVALID' && error.status === 400 && error.details.field === 'compiledPlanHash');
    assert.throws(() => normalizePlan({ ...completePlan, semanticPlanHash: value }), { code: 'APPROVAL_LINEAGE_INVALID', status: 400 });
  }
  // 显式空串传给 ApprovalStore.issue 也不能进账本。
  assert.throws(() => new ApprovalStore().issue({ planHash: 'plan', targetFingerprint: 'target', windowId: 'window', steps: [], semanticPlanHash: '' }), { code: 'APPROVAL_LINEAGE_INVALID', status: 400 });
  // 缺省 / undefined / null 仍兼容：不绑定血缘。
  assert.deepEqual(planLineageHashes({}), { semanticPlanHash: null, compiledPlanHash: null });
  assert.deepEqual(planLineageHashes({ semanticPlanHash: null, compiledPlanHash: undefined }), { semanticPlanHash: null, compiledPlanHash: null });
  assert.equal(normalizePlan(completePlan).plan.semanticPlanHash, undefined);
  assert.equal(attachPlanLineage({ x: 1 }, { semanticPlanHash: undefined }).compiledPlanHash, undefined);
});

test('P1-3：基线 2 条既有违规、写入后无新增 → 通过并返回 drcBaseline/drcExempted', async () => {
  const { bridge, state } = createSchematicBridge({ drcRuns: [
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }],
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }],
  ] });
  const manager = new DesignManager({ bridge });
  const { execution } = await approveAndExecute(manager);
  assert.equal(execution.state, 'completed');
  assert.equal(execution.drc.passed, true);
  assert.equal(execution.drcBaseline.count, 2);
  assert.equal(execution.drcExempted.length, 2);
  assert.deepEqual(execution.drcRegressions, []);
  assert.equal(state.source, 'after-source');
});

test('P1-3：基线 2 条既有 + 新增 1 条 → 只阻断新增并回滚，历史项进 drcExempted', async () => {
  const { bridge, state } = createSchematicBridge({ drcRuns: [
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }],
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }, { rule: 'new-short', severity: 'error' }],
  ] });
  const manager = new DesignManager({ bridge });
  const { execution } = await approveAndExecute(manager);
  assert.equal(execution.state, 'rolled_back');
  assert.equal(execution.error.code, 'DRC_FAILED');
  assert.equal(execution.error.details.mode, 'baseline');
  assert.equal(execution.drcBaseline.count, 2);
  assert.equal(execution.drcExempted.length, 2);
  assert.equal(execution.drcRegressions.length, 1);
  assert.match(execution.drcRegressions[0].key, /new-short/);
  assert.equal(state.source, 'before-source');
});

test('P1-3：strictDrc=true 维持零容忍——基线内既有违规也阻断', async () => {
  const { bridge } = createSchematicBridge({ drcRuns: [
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }],
    () => [{ rule: 'old-a', severity: 'error' }, { rule: 'old-b', severity: 'error' }],
  ] });
  const manager = new DesignManager({ bridge });
  const { execution } = await approveAndExecute(manager, { execute: { strictDrc: true } });
  assert.equal(execution.state, 'rolled_back');
  assert.equal(execution.error.code, 'DRC_FAILED');
  assert.equal(execution.error.details.mode, 'strict');
  assert.equal(execution.drc.strict, true);
});

test('P1-3：聚合 warn（[{type:"warn",count}]）历史项豁免，新增 warning 只记录不阻断', async () => {
  const { bridge } = createSchematicBridge({ drcRuns: [
    () => [{ type: 'warn', count: 2 }],
    () => [{ type: 'warn', count: 3 }],
  ] });
  const manager = new DesignManager({ bridge });
  const { execution } = await approveAndExecute(manager);
  assert.equal(execution.state, 'completed');
  assert.equal(execution.drc.passed, true);
  assert.equal(execution.drcRegressions.length, 1);
  assert.equal(execution.drcRegressions[0].severity, 'warning');
  assert.equal(execution.drcWarnings.length, 1);
  assert.equal(execution.drcExempted.length, 1);
  assert.equal(execution.drcBaseline.warnings, 2);
});

test('P1-5：批准保存 projectId/documentUuid 并落账本；目标一致时执行通过并逐批复核', async () => {
  const ledger = createApprovalLedger();
  const { bridge } = createSchematicBridge();
  const manager = new DesignManager({ bridge, ledger });
  const context = await manager.context();
  const approval = manager.approve({
    plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  assert.equal(approval.projectId, 'project-1');
  assert.equal(approval.documentUuid, 'document-1');
  const ledgerEntry = ledger.snapshot().entries.find((entry) => entry.action === 'issued');
  assert.equal(ledgerEntry.bindings.projectId, 'project-1');
  assert.equal(ledgerEntry.bindings.documentUuid, 'document-1');
  const execution = await manager.execute({
    plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  assert.equal(execution.state, 'completed');
  assert.equal(execution.projectId, 'project-1');
  assert.equal(execution.documentUuid, 'document-1');
  // start + write-batch:1 + save 至少三次目标复核。
  assert.ok(execution.targetChecks.length >= 3, `targetChecks=${execution.targetChecks.length}`);
});

test('P1-5：执行开始时 bridge 的 document.current 漂移 → APPROVAL_TARGET_MISMATCH(409, expected/actual/phase)，不写入', async () => {
  const { bridge, state } = createSchematicBridge();
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({
    plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  // 批准之后、执行之前用户切到了另一份原理图。
  state.document = { uuid: 'document-2', documentType: 1 };
  await assert.rejects(
    manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' }),
    (error) => error.code === 'APPROVAL_TARGET_MISMATCH' && error.status === 409
      && error.details.phase === 'start'
      && error.details.expected.documentUuid === 'document-1'
      && error.details.actual.documentUuid === 'document-2',
  );
  assert.equal(state.source, 'before-source');
  assert.equal(manager.executions.size, 0);
});

test('P1-5：执行中目标文档漂移 → 保存前复核抛 409，回滚也被目标校验拦住并置写锁', async () => {
  const { bridge, state } = createSchematicBridge({ onAfterWrite: (current) => { current.document = { uuid: 'document-2', documentType: 1 }; } });
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({
    plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  const execution = await manager.execute({
    plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  assert.equal(execution.state, 'rollback_failed');
  assert.equal(execution.error.code, 'APPROVAL_TARGET_MISMATCH');
  assert.equal(execution.error.details.phase, 'save');
  assert.equal(execution.writeLocked, true);
  assert.equal(execution.rollbackError.code, 'APPROVAL_TARGET_MISMATCH');
  assert.equal(execution.rollbackError.details.phase, 'rollback');
  // 回滚被拒绝：绝不能把旧文档源码 restore 进漂移后的文档。
  assert.equal(state.source, 'after-source');
  await assert.rejects(
    manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' }),
    { code: 'DESIGN_WRITE_LOCKED', status: 409 },
  );
});

test('P1-5：执行 body 携带的目标与批准记录不一致 → APPROVAL_MISMATCH（不信任 body）', async () => {
  const { bridge } = createSchematicBridge();
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({
    plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1',
    projectId: 'project-1', documentUuid: 'document-1',
  });
  await assert.rejects(
    manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1', projectId: 'project-9' }),
    { code: 'APPROVAL_MISMATCH' },
  );
});

