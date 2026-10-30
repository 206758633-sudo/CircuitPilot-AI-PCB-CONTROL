import test from 'node:test';
import assert from 'node:assert/strict';
import { diffDrcReports, applyRoutingWithDrcGuard } from '../engineering/routing-drc.mjs';

const item = (key, errorType = 'Clearance Error') => ({ instanceKey: key, signature: key, errorType, net: 'GND', layer: '15', group: 'g', objects: [] });
const report = (items) => ({ ok: true, items, itemCount: items.length });
const plan = { routes: [{ ok: true }] };
const geom = { lines: [], vias: [], pads: [] };

test('DRC 差分：只把"新增"算回归，消失的算已解决', () => {
  const before = report([item('a'), item('b')]);
  const after = report([item('a'), item('c')]);
  const diff = diffDrcReports(before, after);
  assert.equal(diff.newCount, 1);
  assert.equal(diff.newItems[0].instanceKey, 'c');
  assert.equal(diff.resolvedCount, 1);
  assert.equal(diff.resolvedItems[0].instanceKey, 'b');
});

test('写入后 DRC 无新增：放行并记录写前/写后计数', async () => {
  const calls = [];
  const result = await applyRoutingWithDrcGuard({
    execute: async () => ({}),
    plan, geometry: geom, dryRun: false,
    runDrc: async () => report([item('a')]),
    apply: async () => { calls.push('apply'); return { ok: true, written: [{ kind: 'line', id: 'L1' }] }; },
    rollback: async () => { calls.push('rollback'); return { removed: 1 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.drcCheck.newCount, 0);
  assert.deepEqual(calls, ['apply']);
});

test('写入后 DRC 新增违规：自动回滚并抛 ROUTING_DRC_REGRESSION', async () => {
  const calls = [];
  let round = 0;
  await assert.rejects(
    () => applyRoutingWithDrcGuard({
      execute: async () => ({}),
      plan, geometry: geom, dryRun: false,
      runDrc: async () => (round++ === 0 ? report([item('a')]) : report([item('a'), item('new-1')])),
      apply: async () => { calls.push('apply'); return { ok: true, written: [{ kind: 'via', id: 'V1' }, { kind: 'line', id: 'L1' }] }; },
      rollback: async ({ items }) => { calls.push(`rollback:${items.length}`); return { removed: items.length, residual: [] }; },
    }),
    (error) => {
      assert.equal(error.code, 'ROUTING_DRC_REGRESSION');
      assert.equal(error.details.newCount, 1);
      assert.equal(error.details.newItems[0].instanceKey, 'new-1');
      return true;
    },
  );
  assert.deepEqual(calls, ['apply', 'rollback:2']);
});

test('写前/写后 DRC 报告不可用：拒绝冒充"通过"（写后不可用会先回滚）', async () => {
  await assert.rejects(
    () => applyRoutingWithDrcGuard({ execute: async () => ({}), plan, geometry: geom, dryRun: false, runDrc: async () => ({}), apply: async () => { throw new Error('should not apply'); } }),
    (error) => error.code === 'ROUTING_DRC_REPORT_INVALID' && error.details.phase === 'before',
  );
  const calls = [];
  await assert.rejects(
    () => applyRoutingWithDrcGuard({
      execute: async () => ({}), plan, geometry: geom, dryRun: false,
      runDrc: (() => { let round = 0; return async () => (round++ === 0 ? report([item('a')]) : {}); })(),
      apply: async () => { calls.push('apply'); return { ok: true, written: [{ kind: 'line', id: 'L1' }] }; },
      rollback: async () => { calls.push('rollback'); return { removed: 1 }; },
    }),
    (error) => error.code === 'ROUTING_DRC_REPORT_INVALID' && error.details.phase === 'after',
  );
  assert.deepEqual(calls, ['apply', 'rollback']);
});

test('dry-run 不写板：跳过 DRC，不调用 runDrc', async () => {
  let drcCalls = 0;
  const result = await applyRoutingWithDrcGuard({ execute: async () => ({}), plan, geometry: geom, dryRun: true, runDrc: async () => { drcCalls += 1; return report([]); }, apply: async () => ({ ok: true, dryRun: true }) });
  assert.equal(result.dryRun, true);
  assert.equal(drcCalls, 0);
});

test('真机 DRC 原始形状（分组数组）也能作为基线：不再误报"缺少 items 数组"', async () => {
  const { defaultRunDrc } = await import('../engineering/routing-drc.mjs');
  const { normalizeDrcReport } = await import('../drc.mjs');
  // PCB_Drc.check 真机返回：[{ name, list:[{ name, list:[叶子] }] }]
  const rawArray = [{
    name: 'Clearance Error',
    list: [{
      name: 'Board Outline to SMD Pad',
      list: [{ errorType: 'Clearance Error', ruleName: 'copperThickness1oz', layer: 'Top Layer', obj1: { typeName: 'Board Outline', suffix: ': e1' }, obj2: { typeName: 'SMD Pad', suffix: '(CAM_22): U1_26' }, explanation: { errData: { obj1Type: 'Board Outline', obj2Type: 'SMD Pad', globalIndex: 'err786', position: { x: 137.9, y: 9.4 } } } }],
    }],
  }];
  const wrapped = await defaultRunDrc(async () => ({ success: true, result: rawArray }));
  assert.equal(wrapped.items.length, 1);
  const normalized = normalizeDrcReport(wrapped);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.itemCount, 1);
  assert.equal(normalized.items[0].errorType, 'Clearance Error');
});

test('真机差分稳定性：同一违规换了 globalIndex/坐标不算新增，换了对象 ID 才算新增', async () => {
  const { normalizeDrcReport } = await import('../drc.mjs');
  const raw = (globalIndex, x, obj1, obj2) => [{
    name: 'Clearance Error',
    list: [{ name: 'SMD Pad to Track', list: [{ errorType: 'Clearance Error', ruleName: 'copperThickness1oz', layer: 'Top Layer', obj1: { typeName: 'Track', suffix: ': t1' }, obj2: { typeName: 'SMD Pad', suffix: '(TOUCH): U1_3' }, explanation: { errData: { obj1, obj2, obj1Type: 'Track', obj2Type: 'SMD Pad', globalIndex, position: { x, y: 140 } } } }] }],
  }];
  const before = normalizeDrcReport({ items: raw('err100', 170.8, 'tA', 'padX') });
  const afterSame = normalizeDrcReport({ items: raw('err3573', 171.2, 'tA', 'padX') });
  const afterDifferent = normalizeDrcReport({ items: raw('err4000', 170.8, 'tB', 'padX') });
  const { diffDrcReports } = await import('../engineering/routing-drc.mjs');
  const diffSame = diffDrcReports(before, afterSame);
  assert.equal(diffSame.newCount, 0);
  assert.equal(diffSame.resolvedCount, 0);
  const diffDifferent = diffDrcReports(before, afterDifferent);
  assert.equal(diffDifferent.newCount, 1);
});

test('DRC 回归回滚按写前快照差集删：创建响应没有图元 ID 也能删干净（真机 D-31-4）', async () => {
  const { rollbackRouting } = await import('../engineering/pcb-routing.mjs');
  const before = { lines: [{ id: 'L0', net: 'GND', layer: 1, x1: 0, y1: 0, x2: 10, y2: 0, width: 8 }], vias: [] };
  let board = { lines: [{ ...before.lines[0] }], vias: [] };
  const deleted = [];
  const execute = async (commandId, args) => {
    if (commandId === 'pcb.copper.read') return { success: true, result: { counts: { lines: board.lines.length }, lines: board.lines.map((l) => ({ ...l })), vias: [], pads: [], components: [] } };
    if (commandId === 'pcb.lines.delete') { deleted.push(...args.primitiveIds); board = { ...board, lines: board.lines.filter((l) => !args.primitiveIds.includes(l.id)) }; return { success: true, result: true }; }
    return { success: true, result: true };
  };
  // 模拟"创建响应缺 ID"：新铜 L9 出现在板上，但 written 里没有 id
  board = { ...board, lines: [...board.lines, { id: 'L9', net: 'TOUCH', layer: 1, x1: 5, y1: 5, x2: 20, y2: 5, width: 8 }] };
  const result = await rollbackRouting({ execute, items: [{ kind: 'line', id: '' }], before });
  assert.deepEqual(deleted, ['L9']);
  assert.deepEqual(result.residual, []);
  assert.equal(board.lines.length, 1);
  // 无快照时退回按 ID 回滚（老行为仍可用）
  const result2 = await rollbackRouting({ execute: async (c) => (c === 'pcb.copper.read' ? { result: { lines: [], vias: [] } } : { result: true }), items: [{ kind: 'line', id: 'LX' }] });
  assert.equal(result2.residual.length, 0);
});
