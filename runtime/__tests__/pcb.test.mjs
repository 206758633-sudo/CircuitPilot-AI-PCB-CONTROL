import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCh32v003Fixture, diffPcbAgainstNetlist, drcVerdict, normalizePcbPlan, PCB_CAPABILITIES, PcbManager } from '../pcb.mjs';
import { ApprovalStore } from '../design.mjs';

test('CH32V003 fixture compiles deterministically to a 45x30 two-layer board', () => {
  const a = compileCh32v003Fixture({ placements: { U1: { x: 20, y: 15, rotation: 0 } } });
  const b = compileCh32v003Fixture({ placements: { U1: { x: 20, y: 15, rotation: 0 } } });
  assert.equal(a.ready, true);
  assert.equal(a.planHash, b.planHash);
  assert.deepEqual(a.plan.board, { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 });
  // 板框必须走 pcb.outline.create（Polyline + 坐标开头多边形编码）：单条闭合轮廓，
  // 而不是改造前的 4 条 pcb.line.create + layer 11（真机实测 Line 只接受 SIGNAL 铜层，必然失败）。
  const outline = a.plan.operations.filter((item) => item.stage === 'outline');
  assert.equal(outline.length, 1);
  assert.equal(outline[0].type, 'pcb.outline.create');
  assert.equal(outline[0].args.layer, 11);
  assert.equal(a.plan.operations.filter((item) => item.type === 'pcb.line.create' && item.args.layer === 11).length, 0);
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
  let drcPolls = 0;
  let source = '{"board":"before"}';
  return {
    selectedWindowId: 'W1',
    async execute(id, args = {}) {
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { if (failRestore) throw new Error('restore failed'); source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      // DRC 后台任务：start 回 jobId，poll 回结果信封。
      // failDrc 现在模拟的是"**这次改动把板子弄差了**"：改前基线干净，改后出现 1 条违规。
      // （"改前改后都有同样的既有违规"是另一条用例，且**不该**回滚。）
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') {
        drcPolls += 1;
        const findings = failDrc && drcPolls > 1 ? [{ code: 'D1' }] : [];
        return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: findings.length, items: findings, truncated: false } } };
      }
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
    if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
    if (id === 'pcb.rules.read') return { result: {} };
    if (id === 'pcb.source.read') return { result: source };
    if (id === 'document.source.restore') { source = args.source; return { result: true }; }
    if (id === 'pcb.save') return { result: true };
    // 板框现在是单条 pcb.outline.create（不再有 4 条 line.create）。下面在同一个 outline 阶段里
    // 放两条板框操作、让第二条失败——不变量不变：阶段中途失败必须回滚到**该阶段**快照，
    // 而不是只回滚失败的那一条。
    if (id === 'pcb.outline.create') { creates += 1; source = `{"state":"outline-${creates}"}`; if (creates === 2) throw Object.assign(new Error('partial failure'), { code: 'PARTIAL' }); return { result: { primitiveId: `O${creates}` } }; }
    if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
    if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 0, items: [], truncated: false } } };
    return { result: true };
  };
  const plan = fixturePlan();
  // 在 outline 阶段插入第二条板框操作（首条成功后第二条失败 => 该阶段被部分改动）。
  plan.operations.splice(2, 0, { ...plan.operations[1], args: { ...plan.operations[1].args, heightMm: 20 } });
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

/**
 * 真机实测（第 16 轮）：`{operations:[pcb.importChanges, pcb.save]}` 落在真实的 6 层板上，
 * 因为"层数>2 就要叠层证据"而永远 `ready:false`——把"把已修好的原理图同步进现成板子"堵死了。
 * 现在：纯文档生命周期动作不索要板厂叠层单；一旦开始创建多层几何或宣称叠层，就必须给证据。
 */
test('6 层板：纯文档生命周期计划不再被叠层证据堵死，但宣称/创建多层几何时仍然被堵', () => {
  const board = { widthMm: 60, heightMm: 40, layers: 6, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
  const syncOnly = normalizePcbPlan({ board, constraints: {}, operations: [{ type: 'pcb.importChanges', args: {} }, { type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }] });
  assert.equal(syncOnly.ready, true, `同步计划不该被叠层堵死: ${syncOnly.missing}`);

  // 创建板框 = 宣称多层几何 → 仍然必须有叠层证据
  const withOutline = normalizePcbPlan({ board, constraints: {}, operations: [{ type: 'pcb.outline.create', args: { widthMm: 60, heightMm: 40, layer: 11 } }, { type: 'pcb.save', args: {} }] });
  assert.equal(withOutline.ready, false);
  assert.ok(withOutline.missing.some((item) => item.startsWith('stackup:')), `创建板框必须要求叠层: ${withOutline.missing}`);

  // 内层走线 → 层角色/参考平面必须可判定 → 仍然必须有叠层证据
  const innerRoute = normalizePcbPlan({ board, constraints: {}, operations: [{ type: 'pcb.line.create', args: { layer: 15, points: [1, 1, 2, 2] } }, { type: 'pcb.save', args: {} }] });
  assert.equal(innerRoute.ready, false);
  assert.ok(innerRoute.missing.some((item) => item.startsWith('stackup:')), `内层走线必须要求叠层: ${innerRoute.missing}`);

  // 显式宣称叠层/工艺档 → 仍然必须有叠层证据（哪怕只做同步）
  const declared = normalizePcbPlan({ board, constraints: { profileId: 'jlc-6l' }, operations: [{ type: 'pcb.importChanges', args: {} }] });
  assert.equal(declared.ready, false);
  assert.ok(declared.missing.some((item) => item.startsWith('stackup:')), `显式宣称叠层必须要求证据: ${declared.missing}`);
});

/**
 * 真机实测（第 16 轮）：这块 6 层板**什么都不改**跑官方 DRC 也报 4 项 Clearance Error（既有违规）。
 * "有违规就回滚"会让任何写入被既有违规永远回滚——工程被锁死。所以要按**相对基线**裁决。
 */
test('DRC 裁决：有基线只对新增/加重负责；没基线才是一条都不许有', () => {
  const before = [{ name: 'Clearance Error', list: ['a', 'b', 'c', 'd'] }];
  // 1) 改动前后完全一样 → 通过（既有违规不该背在本次改动头上）
  const same = drcVerdict({ baseline: before, findings: [{ name: 'Clearance Error', list: ['a', 'b', 'c', 'd'] }] });
  assert.equal(same.passed, true, `既有违规不该导致回滚: ${JSON.stringify(same)}`);
  assert.deepEqual(same.regressions, []);
  // 2) 同一类别变多了 → 失败，并且要点名"多了几条"
  const worse = drcVerdict({ baseline: before, findings: [{ name: 'Clearance Error', list: ['a', 'b', 'c', 'd', 'e', 'f'] }] });
  assert.equal(worse.passed, false);
  assert.deepEqual(worse.regressions, [{ group: 'Clearance Error', before: 4, after: 6 }]);
  // 3) 出了新类别 → 失败
  const novel = drcVerdict({ baseline: before, findings: [{ name: 'Clearance Error', list: ['a', 'b', 'c', 'd'] }, { name: 'Unconnected Pin', list: ['p1'] }] });
  assert.equal(novel.passed, false);
  assert.deepEqual(novel.regressions, [{ group: 'Unconnected Pin', before: 0, after: 1 }]);
  // 4) 改好了 → 通过
  const better = drcVerdict({ baseline: before, findings: [{ name: 'Clearance Error', list: ['a'] }] });
  assert.equal(better.passed, true);
  assert.equal(better.strict, false);
  // 5) 没有基线 → 严格模式：一条违规都不许有，并且如实标注 strict
  const strict = drcVerdict({ baseline: null, findings: [{ name: 'Clearance Error', list: ['a'] }] });
  assert.equal(strict.passed, false);
  assert.equal(strict.strict, true, '没有基线时必须如实标注严格模式');
  assert.deepEqual(drcVerdict({ baseline: null, findings: [] }).passed, true);
});

/**
 * 相对基线的另一面：既有违规在改动前后**一模一样**时，不该回滚——
 * 否则真机上（这块板本来就有 4 项 Clearance Error）任何写入都会被永久回滚。
 */
test('既有违规在改动前后一致时不回滚：执行完成但如实记录"非严格模式"与基线分组', async () => {
  const bridge = fakeBridge();
  const inner = bridge.execute;
  bridge.execute = async (id, args, options) => {
    if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 2, items: [{ name: 'Clearance Error', list: ['a', 'b'] }], truncated: false } } };
    return inner(id, args, options);
  };
  const manager = new PcbManager({ bridge, approvals: new ApprovalStore() });
  const result = await approvedExecution(manager, fixturePlan());
  assert.equal(result.state, 'completed', JSON.stringify(result.error || {}));
  assert.equal(result.drc.passed, true);
  assert.equal(result.drc.strict, false, '有基线时必须标注非严格模式');
  assert.deepEqual(result.drc.regressions, []);
  assert.deepEqual(result.drc.groups, { 'Clearance Error': 2 });
  assert.deepEqual(result.drc.baselineGroups, { 'Clearance Error': 2 });
});

/**
 * 真机边界（第 20–23 轮）：PCB 器件新增必须由 EDA 原生能力完成，CircuitPilot 只负责判定与验收。
 * 因此"差异没清零就绝不放行"必须是硬判定，且未标注位号（R?）绝不能静默当作已匹配。
 */
test('同步差异检测：缺件/多件/未标注位号都不放行，清一色一致才放行', () => {
  const pcb = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'D1', 'J1'];
  // 1) 真机现况：原理图 12 个器件，PCB 只有 8 个 → 必须点名缺 R1..R4
  const live = diffPcbAgainstNetlist({ schematicParts: [...pcb, 'R1', 'R2', 'R3', 'R4'], pcbDesignators: pcb });
  assert.equal(live.ready, false);
  assert.deepEqual(live.missing, ['R1', 'R2', 'R3', 'R4']);
  assert.deepEqual(live.extra, []);
  assert.equal(live.matched.length, 8);
  assert.match(live.guide, /更新\/转换原理图到 PCB/);
  // 2) 多出来的器件也要点名（不允许"多就假装没事"）
  const extra = diffPcbAgainstNetlist({ schematicParts: pcb, pcbDesignators: [...pcb, 'R9'] });
  assert.equal(extra.ready, false);
  assert.deepEqual(extra.extra, ['R9']);
  // 3) 未标注位号：R? 必须单独计入 unannotated，绝不当作已匹配
  const unannotated = diffPcbAgainstNetlist({ schematicParts: [...pcb, 'R?'], pcbDesignators: [...pcb, 'R?'] });
  assert.equal(unannotated.ready, false);
  assert.deepEqual(unannotated.unannotated, ['R?']);
  // 4) 大小写/空白容忍；完全一致才放行
  const clean = diffPcbAgainstNetlist({ schematicParts: [' u1 ', 'u2'], pcbDesignators: ['U1', 'U2'] });
  assert.equal(clean.ready, true, JSON.stringify(clean));
  assert.match(clean.guide, /已一致/);
});
