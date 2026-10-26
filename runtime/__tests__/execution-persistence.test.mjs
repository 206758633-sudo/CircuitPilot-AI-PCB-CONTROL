import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesignManager } from '../design.mjs';
import { PcbManager } from '../pcb.mjs';
import { createJsonStore } from '../store.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'cp-exec-persist-'));
const seed = (id, extra = {}) => ({
  id, state: 'completed', planHash: `plan-${id}`, events: [{ at: '2026-10-19T00:00:00.000Z', stage: 'readback', status: 'passed', detail: {} }],
  createdPrimitiveIds: ['p1'], drc: { passed: true, findings: [] }, ...extra,
});

test('原理图执行历史：写入后可重启加载，列表/详情都还在（含计划哈希与 DRC 结论）', () => {
  const dir = root();
  try {
    const file = join(dir, 'design-executions.json');
    const first = new DesignManager({ bridge: {}, store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    first.executions.set('exec-1', seed('exec-1'));
    first.persist();
    assert.equal(first.persistenceError, null);

    const restarted = new DesignManager({ bridge: {}, store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    assert.equal(restarted.get('exec-1')?.planHash, 'plan-exec-1');
    const list = restarted.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'schematic');
    assert.equal(list[0].state, 'completed');
    assert.equal(list[0].drc.passed, true);
    assert.equal(list[0].createdAt, '2026-10-19T00:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PCB 执行历史：同样重启可读，摘要带 progress 与 DRC 计数', () => {
  const dir = root();
  try {
    const file = join(dir, 'pcb-executions.json');
    const first = new PcbManager({ bridge: {}, store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    first.executions.set('pcb-1', seed('pcb-1', { progress: { completed: 3, total: 3 }, drc: { passed: false, findings: [{}, {}] } }));
    first.persist();

    const restarted = new PcbManager({ bridge: {}, store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    const list = restarted.list();
    assert.equal(restarted.get('pcb-1')?.id, 'pcb-1');
    assert.equal(list[0].kind, 'pcb');
    assert.deepEqual(list[0].progress, { completed: 3, total: 3 });
    assert.equal(list[0].drc.findings, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('状态文件损坏：构造时 fail-closed 抛 STORE_CORRUPT（由 server 降级为内存，不伪造历史）', () => {
  const dir = root();
  try {
    const file = join(dir, 'design-executions.json');
    writeFileSync(file, '{broken', 'utf8');
    assert.throws(
      () => new DesignManager({ bridge: {}, store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ executions: [] }) }) }),
      (error) => error.code === 'STORE_CORRUPT',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
