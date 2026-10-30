import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolygonSource } from '../placement.mjs';
import { PLACEMENT_WRITE_CODES, applyPlacementPlan, buildPlacementUpdates, mmToMil } from '../placement-write.mjs';

const REAL_OUTLINE_SOURCE = [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0];
const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);

/** 可控的假 EDA：state 里的坐标会被 write 真实改写，便于验证"回读比对"这条链。 */
function fakeEda({ components, ignoreWrites = false, failRestore = false, partialApply = false }) {
  const state = new Map(components.map((component) => [component.primitiveId, { ...component, bboxMm: component.bboxMm ?? { xMm: 2, yMm: 2 } }]));
  const calls = [];
  const execute = async (commandId, args = {}) => {
    calls.push({ commandId, args });
    if (commandId === 'pcb.source.read') return { result: 'PCB_SOURCE_SNAPSHOT' };
    if (commandId === 'pcb.placement.write') {
      const list = args.updates || [];
      const isRestore = calls.filter((call) => call.commandId === 'pcb.placement.write').length > 1;
      let applied = 0;
      if ((failRestore && isRestore) || (partialApply && !isRestore)) return { result: { requested: list.length, applied: applied, results: list.map((item) => ({ primitiveId: item.primitiveId, ok: false, error: '假失败' })) } };
      for (const update of list) {
        const current = state.get(update.primitiveId);
        if (!current) continue;
        if (!ignoreWrites) { current.xMil = update.xMil; current.yMil = update.yMil; current.rotationDeg = update.rotationDeg; }
        applied += 1;
      }
      return { result: { requested: list.length, applied, results: list.map((item) => ({ primitiveId: item.primitiveId, ok: true })) } };
    }
    if (commandId === 'pcb.placement.read') {
      return { result: { unit: 'mm', componentCount: state.size, components: [...state.values()].map((component) => ({ primitiveId: component.primitiveId, designator: component.designator, xMm: Number((component.xMil * 0.0254).toFixed(4)), yMm: Number((component.yMil * 0.0254).toFixed(4)), rotationDeg: component.rotationDeg || 0, bboxMm: component.bboxMm, nets: component.nets || [] })), outline: [{ primitiveId: 'outline', lineWidthMil: 10, source: REAL_OUTLINE_SOURCE }], outlineCount: 1 } };
    }
    throw Object.assign(new Error(`未预期的命令 ${commandId}`), { code: 'UNEXPECTED' });
  };
  return { execute, calls, state };
}

const milOf = (mm) => Number((mm / 0.0254).toFixed(6));

test('写回清单只认 EDA 当前读回的位置，已在目标位的跳过，找不到的报错', () => {
  const readback = { components: [{ primitiveId: 'p1', designator: 'U1', xMm: 10, yMm: -20 }, { primitiveId: 'p2', designator: 'U2', xMm: 28, yMm: -11 }] };
  const plan = { placements: [
    { ref: 'U1', primitiveId: 'p1', xMm: 10.005, yMm: -20, rotationDeg: 0 }, // 0.005mm 偏差 → 跳过
    { ref: 'U2', primitiveId: 'p2', xMm: 20, yMm: -30, rotationDeg: 0 },
    { ref: 'U9', primitiveId: 'p9', xMm: 1, yMm: -1, rotationDeg: 0 },
  ] };
  const result = buildPlacementUpdates({ plan, readback, toleranceMm: 0.02 });
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].ref, 'U2');
  assert.equal(result.updates[0].deltaMm, 20.616, '(28,-11)→(20,-30) 位移 √425 ≈ 20.616mm');
  assert.equal(result.skipped[0].ref, 'U1');
  assert.equal(result.missing[0].ref, 'U9');
  assert.match(result.missing[0].reason, /读回里找不到/);
});

test('默认是预演：不写 EDA，只报"会移动什么"', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }] });
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 20, yMm: -30, rotationDeg: 0 }] }, readback: (await eda.execute('pcb.placement.read', {})).result, dryRun: true });
  assert.equal(result.applied, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.DRY_RUN));
  assert.equal(eda.calls.some((call) => call.commandId === 'pcb.placement.write'), false, '预演绝不能写 EDA');
});

test('写回成功：mm→mil 换算正确、逐项回读比对通过、未保存', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }] });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 6.5, yMm: -28, rotationDeg: 0 }] }, readback, dryRun: false, verifyOptions: { outline, edgeClearanceMm: 1 } });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.applied, true);
  assert.equal(result.saved, false, '绝不能悄悄保存');
  const write = eda.calls.find((call) => call.commandId === 'pcb.placement.write');
  assert.equal(write.args.updates[0].xMil, mmToMil(6.5));
  assert.ok(Math.abs(write.args.updates[0].xMil - 255.905512) < 1e-6, `6.5mm = 255.905512 mil，实际 ${write.args.updates[0].xMil}`);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.APPLIED));
  assert.equal(result.rollback, null);
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.steps.map((step) => step.step), ['snapshot', 'apply', 'readback', 'verify', 'pad-outline']);
  assert.ok(result.padOutline, '写回后必须做焊盘级板框复核（D-33-1）');
});

test('回读与目标不符 → 自动回滚到原坐标并回读证明还原', async () => {
  // ignoreWrites: 写入"成功"但坐标没变 → 正是本项目最需要防的"调用没报错≠改成功"
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }], ignoreWrites: true });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 20, yMm: -30, rotationDeg: 0 }] }, readback, dryRun: false, verifyOptions: { outline, edgeClearanceMm: 1 } });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.READBACK_MISMATCH));
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.ROLLED_BACK), JSON.stringify(result.findings.map((f) => f.code)));
  assert.equal(result.rollback.ok, true);
  const writes = eda.calls.filter((call) => call.commandId === 'pcb.placement.write');
  assert.equal(writes.length, 2, '一次写回 + 一次回滚');
  assert.equal(writes[1].args.updates[0].xMil, mmToMil(10), '回滚必须写回原始坐标');
});

test('写回后布局复核不通过 → 同样回滚（几何越界不能只靠坐标比对发现）', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }] });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  // 目标点在板框外：坐标能写对，但几何复核必须拦住
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 70, yMm: -50, rotationDeg: 0 }] }, readback, dryRun: false, verifyOptions: { outline, edgeClearanceMm: 1 } });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.VERIFY_BLOCKED), JSON.stringify(result.findings.map((f) => f.code)));
  assert.equal(result.rollback.ok, true);
});

test('部分写回失败（write 返回 applied 不足）→ 判失败并回滚', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }], partialApply: true });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 20, yMm: -30, rotationDeg: 0 }] }, readback, dryRun: false, verifyOptions: { outline, edgeClearanceMm: 1 } });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.APPLY_FAILED));
});

test('回滚也失败 → 必须给出手工坐标，不许"静默留在半改状态"', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }], ignoreWrites: true, failRestore: true });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 20, yMm: -30, rotationDeg: 0 }] }, readback, dryRun: false, verifyOptions: { outline, edgeClearanceMm: 1 } });
  assert.equal(result.rollback.ok, false);
  const failed = result.findings.find((finding) => finding.code === PLACEMENT_WRITE_CODES.ROLLBACK_FAILED);
  assert.ok(failed, '必须报 ROLLBACK_FAILED');
  assert.equal(failed.severity, 'blocking');
  assert.equal(result.rollback.manualCoordinates[0].xMil, mmToMil(10));
  assert.equal(result.rollback.manualCoordinates[0].ref, 'U1');
});

test('都在目标位置时不做任何写入', async () => {
  const eda = fakeEda({ components: [{ primitiveId: 'p1', designator: 'U1', xMil: milOf(10), yMil: milOf(-20) }] });
  const readback = (await eda.execute('pcb.placement.read', {})).result;
  const result = await applyPlacementPlan({ execute: eda.execute, plan: { placements: [{ ref: 'U1', primitiveId: 'p1', xMm: 10, yMm: -20, rotationDeg: 0 }] }, readback, dryRun: false });
  assert.equal(result.applied, false);
  assert.ok(result.findings.some((finding) => finding.code === PLACEMENT_WRITE_CODES.NOTHING_TO_DO));
  assert.equal(eda.calls.some((call) => call.commandId === 'pcb.placement.write'), false);
});
