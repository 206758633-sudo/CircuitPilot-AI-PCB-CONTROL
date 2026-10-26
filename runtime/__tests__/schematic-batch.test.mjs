import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applySchematicBatch, normalizeBatch, planSchematicBatch, readPartFacts, verifySchematicBatch,
} from '../schematic-batch.mjs';

const device = (uuid) => ({ libraryUuid: 'lib-1', uuid });
const item = (uuid, x, y) => ({ component: device(uuid), x, y, addIntoBom: true, addIntoPcb: true });
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'cp-batch-')), 'state.json');

test('A6：批量项规范化 fail-closed（缺身份/坐标/重复/超限）', () => {
  assert.throws(() => normalizeBatch({ items: [] }), (error) => error.code === 'SCHEMATIC_BATCH_ITEMS_INVALID');
  assert.throws(() => normalizeBatch({ items: [{ x: 1, y: 2 }] }), (error) => error.code === 'SCHEMATIC_BATCH_ITEMS_INVALID');
  assert.throws(() => normalizeBatch({ items: [{ component: device('a'), x: 'x', y: 2 }] }), (error) => error.code === 'SCHEMATIC_BATCH_ITEMS_INVALID');
  assert.throws(() => normalizeBatch({ items: [item('a', 1, 2), item('a', 1, 2)] }), (error) => error.code === 'SCHEMATIC_BATCH_ITEMS_INVALID');
  assert.throws(() => normalizeBatch({ items: [{ component: device('a'), x: 1, y: 2 }], limit: 0 }), (error) => error.code === 'SCHEMATIC_BATCH_ITEMS_INVALID');
  // 同型号不同坐标是正常设计（多颗 100nF），不能被当成重复项。
  const ok = normalizeBatch({ items: [item('cap', 10, 10), item('cap', 20, 10)] });
  assert.equal(ok.items.length, 2);
});

test('A6：计划阶段按"身份+坐标"匹配，同型号多颗不会被误判为已存在', () => {
  const parts = [
    { primitiveId: 'p1', uuid: 'cap', libraryUuid: 'lib-1', x: 10, y: 10, props: { Designator: 'C1' } },
    { primitiveId: 'p2', uuid: 'cap', libraryUuid: 'lib-1', x: 20, y: 10, props: { Designator: 'C2' } },
  ];
  const plan = planSchematicBatch({ items: [item('cap', 10, 10), item('cap', 30, 10), item('res', 40, 10)], parts });
  assert.equal(plan.counts.total, 3);
  assert.equal(plan.counts.skipExisting, 1);
  assert.equal(plan.counts.create, 2);
  assert.equal(plan.items[0].matchedBy, 'identity');
  assert.equal(plan.items[0].existing.designator, 'C1');
  assert.equal(plan.items[1].action, 'create', '同型号但坐标不同，必须新建');
  assert.deepEqual(plan.duplicateGroups, []);
  // 坐标相同但身份不同 → 仍然视为"该位置已有器件"，避免叠放重复件。
  const overlapping = planSchematicBatch({ items: [item('other', 10, 10)], parts });
  assert.equal(overlapping.items[0].action, 'skip-existing');
  assert.equal(overlapping.items[0].matchedBy, 'coordinate');
});

test('A6：批量执行逐件创建 + 每件落进度 + 保存后读回验收；重复执行幂等', async () => {
  const parts = [];
  const calls = [];
  const execute = async (id, args) => {
    calls.push(id);
    if (id === 'schematic.component.create') {
      const created = { primitiveId: `p${parts.length + 1}`, uuid: args.component.uuid, libraryUuid: args.component.libraryUuid, x: args.x, y: args.y, props: { Designator: `U${parts.length + 1}` } };
      parts.push(created);
      return { result: created };
    }
    if (id === 'schematic.save') return { result: true };
    throw new Error(`unexpected ${id}`);
  };
  const file = stateFile();
  const plan1 = planSchematicBatch({ items: [item('a', 1, 1), item('b', 2, 2)], parts });
  const run1 = await applySchematicBatch({ execute, plan: plan1, stateFile: file, save: true, readParts: async () => parts });
  assert.equal(run1.ok, true);
  assert.equal(run1.created.length, 2);
  assert.equal(run1.saved, true);
  assert.equal(run1.verification.ok, true);
  assert.equal(parts.length, 2);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(state.completed).length, 2);

  // 第二次同计划：计划阶段判定已存在 → 全部 skip，不再调用 create。
  const before = calls.length;
  const plan2 = planSchematicBatch({ items: [item('a', 1, 1), item('b', 2, 2)], parts });
  assert.equal(plan2.counts.create, 0);
  const run2 = await applySchematicBatch({ execute, plan: plan2, stateFile: file, save: true, readParts: async () => parts });
  assert.equal(run2.ok, true);
  assert.equal(run2.created.length, 0);
  assert.equal(run2.skipped.length, 2);
  assert.equal(parts.length, 2, '重复执行不能产生重复件');
  assert.equal(calls.slice(before).filter((id) => id === 'schematic.component.create').length, 0);
});

test('A6：中途失败即停、状态文件保留进度，修复后续跑只补剩余项', async () => {
  const parts = [];
  let failOnce = true;
  const execute = async (id, args) => {
    if (id === 'schematic.component.create') {
      if (args.component.uuid === 'b' && failOnce) { failOnce = false; throw Object.assign(new Error('渲染进程中止'), { code: 'EDA_REQUEST_ABANDONED' }); }
      const created = { primitiveId: `p${parts.length + 1}`, uuid: args.component.uuid, libraryUuid: args.component.libraryUuid, x: args.x, y: args.y };
      parts.push(created);
      return { result: created };
    }
    if (id === 'schematic.save') return { result: true };
    throw new Error(`unexpected ${id}`);
  };
  const file = stateFile();
  const items = [item('a', 1, 1), item('b', 2, 2), item('c', 3, 3)];
  const plan = planSchematicBatch({ items, parts });
  const failedRun = await applySchematicBatch({ execute, plan, stateFile: file, save: true, readParts: async () => parts });
  assert.equal(failedRun.ok, false);
  assert.equal(failedRun.failed.code, 'EDA_REQUEST_ABANDONED');
  assert.equal(failedRun.created.length, 1);
  assert.equal(parts.length, 1, '失败后不得继续创建后续器件');
  assert.ok(existsSync(file));

  const resumedRun = await applySchematicBatch({ execute, plan, stateFile: file, save: true, readParts: async () => parts });
  assert.equal(resumedRun.ok, true);
  assert.equal(resumedRun.resumed, true);
  assert.equal(resumedRun.created.length, 2, '续跑只补 b、c');
  assert.equal(resumedRun.skipped[0].reason, 'already-completed');
  assert.equal(parts.length, 3);
});

test('A6：状态文件 planHash 不匹配拒绝混跑；读回缺件时报失败而不是假成功', async () => {
  const file = stateFile();
  const planA = planSchematicBatch({ items: [item('a', 1, 1)] });
  const execute = async (id) => (id === 'schematic.component.create' ? { result: { primitiveId: 'p1' } } : { result: true });
  await applySchematicBatch({ execute, plan: planA, stateFile: file });
  const planB = planSchematicBatch({ items: [item('b', 2, 2)] });
  await assert.rejects(() => applySchematicBatch({ execute, plan: planB, stateFile: file }), (error) => error.code === 'SCHEMATIC_BATCH_STATE_MISMATCH');

  // 读回为空：创建调用都"成功"也不能判通过。
  const verify = verifySchematicBatch({ plan: planA, parts: [], createdPrimitiveIds: ['p1'] });
  assert.equal(verify.ok, false);
  assert.match(verify.findings[0].message, /读回缺少/);
  await assert.rejects(() => applySchematicBatch({ execute, plan: planA, stateFile: stateFile(), save: true, readParts: async () => [] }), (error) => error.code === 'SCHEMATIC_BATCH_VERIFY_FAILED');
});

test('A6：器件读回事实提取不猜身份（身份/坐标缺失就是 null）', () => {
  const facts = readPartFacts({ primitiveId: 'p1', props: { Designator: 'C?', LCSC: 'C123' } });
  assert.equal(facts.identity, null);
  assert.equal(facts.designator, 'C?');
  assert.equal(facts.lcscId, 'C123');
  assert.equal(facts.x, null);
  assert.equal(facts.y, null);
  const full = readPartFacts({ primitiveId: 'p2', uuid: 'u', libraryUuid: 'l', x: 1.5, y: 2, position: { x: 9, y: 9 } });
  assert.equal(full.identity, 'l::u');
  assert.equal(full.x, 1.5);
});
