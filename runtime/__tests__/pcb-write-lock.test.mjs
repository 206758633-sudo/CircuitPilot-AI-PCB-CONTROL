import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizePcbPlan, PcbManager } from '../pcb.mjs';
import { ApprovalStore } from '../design.mjs';

/**
 * WP2 P1-16：PCB 跨进程持久写锁。
 *
 * 为什么必须落盘：`this.running` 只能防同一进程内的并发；两个 Runtime 实例、或崩溃后重启的实例
 * 都能写同一块板。锁文件是互斥租约：崩溃遗留锁超过 15 分钟或 pid 已不存在时可接管（留痕）；
 * 而"回滚失败"的安全锁（writeLocked）跨重启生效，只能人工显式解除。
 */

const makeStateDir = () => mkdtempSync(join(tmpdir(), 'cp-pcb-lock-'));
const lockFile = (stateDir) => join(stateDir, 'pcb-write-lock.json');

function syncPlan() {
  return normalizePcbPlan({
    board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
    operations: [
      { type: 'pcb.importChanges', args: {} },
      { type: 'pcb.save', args: {} },
      { type: 'pcb.drc', args: {} },
    ],
  }).plan;
}

function makeBridge({ gated = false, failDrc = false, failRestore = false } = {}) {
  let source = '{"board":"before"}';
  let enteredResolve = null;
  let releaseResolve = null;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let drcPolls = 0;
  return {
    selectedWindowId: 'W1',
    entered,
    releaseGate: () => releaseResolve(),
    async execute(id, args = {}) {
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (id === 'pcb.outline.read') return { result: { count: 0, items: [], boundsMm: null, zoomToBoardOutline: true } };
      if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') {
        if (failRestore) throw new Error('restore failed');
        source = args.source;
        return { result: true };
      }
      if (id === 'pcb.save') return { result: true };
      if (id === 'pcb.importChanges') {
        source = '{"board":"mutated"}';
        if (gated) { enteredResolve(); await release; }
        return { result: true };
      }
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') {
        drcPolls += 1;
        const findings = failDrc && drcPolls > 1 ? [{ code: 'D1' }] : [];
        return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: findings.length, items: findings, truncated: false } } };
      }
      return { result: true };
    },
  };
}

async function approvedExecution(manager, plan) {
  const context = await manager.context();
  const approval = manager.approve({ plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  return manager.execute({ plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
}

async function prepareApproval(manager, plan) {
  const context = await manager.context();
  const approval = manager.approve({ plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  return { plan, approval, targetFingerprint: context.targetFingerprint, windowId: context.windowId };
}

test('正常执行：锁文件含 owner/pid/startedAt/operation，完成后释放', async () => {
  const stateDir = makeStateDir();
  const bridge = makeBridge({ gated: true });
  const manager = new PcbManager({ stateDir, bridge, approvals: new ApprovalStore() });
  const running = approvedExecution(manager, syncPlan());
  await bridge.entered; // 已进入 importChanges：此刻执行必然持有写锁
  assert.ok(existsSync(lockFile(stateDir)), '执行期间必须存在锁文件');
  const lease = JSON.parse(readFileSync(lockFile(stateDir), 'utf8'));
  assert.equal(typeof lease.owner, 'string');
  assert.ok(lease.owner.startsWith('pcb-manager-'));
  assert.equal(lease.pid, process.pid);
  assert.equal(typeof lease.startedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(lease.startedAt)));
  assert.equal(lease.operation, 'pcb.execute');
  assert.equal(typeof lease.planHash, 'string');
  bridge.releaseGate();
  const result = await running;
  assert.equal(result.state, 'completed', JSON.stringify(result.error || {}));
  assert.equal(result.writeLock?.pid, process.pid);
  assert.equal(result.writeLock?.takeover, null);
  assert.equal(existsSync(lockFile(stateDir)), false, '正常结束后锁文件必须删除');
});

test('并发：第二个 manager 实例拿不到锁 → PCB_WRITE_LOCKED(409)，且批准令牌不被烧掉', async () => {
  const stateDir = makeStateDir();
  const planA = syncPlan();
  const planB = syncPlan();
  const managerA = new PcbManager({ stateDir, bridge: makeBridge({ gated: true }), approvals: new ApprovalStore() });
  const managerB = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore() });
  const preparedB = await prepareApproval(managerB, planB); // 先批准好 B，验证锁冲突不会消耗令牌
  const runningA = approvedExecution(managerA, planA);
  await managerA.bridge.entered;
  await assert.rejects(
    () => managerB.execute({ plan: preparedB.plan, approvalToken: preparedB.approval.token, targetFingerprint: preparedB.targetFingerprint, windowId: preparedB.windowId }),
    (error) => {
      assert.equal(error.code, 'PCB_WRITE_LOCKED');
      assert.equal(error.status, 409);
      assert.equal(error.details?.reason, 'held');
      return true;
    },
  );
  managerA.bridge.releaseGate();
  const doneA = await runningA;
  assert.equal(doneA.state, 'completed', JSON.stringify(doneA.error || {}));
  assert.equal(existsSync(lockFile(stateDir)), false);
  // 锁冲突发生在 consume 之前：同一枚批准令牌在锁释放后仍然可用。
  const doneB = await managerB.execute({ plan: preparedB.plan, approvalToken: preparedB.approval.token, targetFingerprint: preparedB.targetFingerprint, windowId: preparedB.windowId });
  assert.equal(doneB.state, 'completed', JSON.stringify(doneB.error || {}));
});

test('重启后锁仍生效：新实例读到遗留锁文件即拒绝执行', async () => {
  const stateDir = makeStateDir();
  writeFileSync(lockFile(stateDir), JSON.stringify({
    schemaVersion: 1, owner: 'crashed-runtime', pid: process.pid,
    startedAt: new Date().toISOString(), operation: 'pcb.execute', planHash: 'x',
  }), 'utf8');
  const manager = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore() });
  await assert.rejects(() => approvedExecution(manager, syncPlan()), (error) => {
    assert.equal(error.code, 'PCB_WRITE_LOCKED');
    assert.equal(error.status, 409);
    assert.equal(error.details?.reason, 'held');
    assert.equal(error.details?.owner, 'crashed-runtime');
    return true;
  });
  unlinkSync(lockFile(stateDir));
});

test('遗留锁超过 15 分钟：可接管，并记录 stale takeover', async () => {
  const stateDir = makeStateDir();
  writeFileSync(lockFile(stateDir), JSON.stringify({
    schemaVersion: 1, owner: 'crashed-runtime', pid: process.pid,
    startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), operation: 'pcb.execute', planHash: 'x',
  }), 'utf8');
  const manager = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore() });
  const result = await approvedExecution(manager, syncPlan());
  assert.equal(result.state, 'completed', JSON.stringify(result.error || {}));
  assert.equal(result.writeLock?.takeover?.reason, 'stale-age');
  const takeoverEvent = result.events.find((event) => event.stage === 'write-lock' && event.status === 'takeover');
  assert.ok(takeoverEvent, '接管必须留痕');
  assert.equal(takeoverEvent.detail.takeover.previousOwner, 'crashed-runtime');
  assert.equal(existsSync(lockFile(stateDir)), false);
});

test('遗留锁的 pid 已不存在：可接管（stale-pid）', async () => {
  const stateDir = makeStateDir();
  writeFileSync(lockFile(stateDir), JSON.stringify({
    schemaVersion: 1, owner: 'dead-runtime', pid: 999999,
    startedAt: new Date().toISOString(), operation: 'pcb.execute', planHash: 'x',
  }), 'utf8');
  const manager = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore(), pidAlive: () => false });
  const result = await approvedExecution(manager, syncPlan());
  assert.equal(result.state, 'completed', JSON.stringify(result.error || {}));
  assert.equal(result.writeLock?.takeover?.reason, 'stale-pid');
});

test('锁文件损坏：fail-closed 拒绝执行，不自动删除', async () => {
  const stateDir = makeStateDir();
  writeFileSync(lockFile(stateDir), 'not-a-json', 'utf8');
  const manager = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore() });
  await assert.rejects(() => approvedExecution(manager, syncPlan()), (error) => {
    assert.equal(error.code, 'PCB_WRITE_LOCKED');
    assert.equal(error.status, 409);
    assert.equal(error.details?.reason, 'lock-file-corrupt');
    return true;
  });
  assert.equal(existsSync(lockFile(stateDir)), true, '损坏锁文件必须保留给人工确认');
  unlinkSync(lockFile(stateDir));
});

test('回滚失败的安全锁跨重启生效，只能显式解除（P1-E）', async () => {
  const stateDir = makeStateDir();
  let saved = null;
  const memoryStore = () => ({
    load: () => ({ data: saved ?? { executions: [] } }),
    save: (data) => { saved = data; },
  });
  const store = memoryStore();
  const firstManager = new PcbManager({ stateDir, bridge: makeBridge({ failDrc: true, failRestore: true }), approvals: new ApprovalStore(), store });
  const first = await approvedExecution(firstManager, syncPlan());
  assert.equal(first.state, 'rollback_failed');
  assert.equal(firstManager.writeLocked, true);
  assert.equal(saved?.writeLock?.locked, true, '回滚失败必须持久化安全锁');

  // “重启”：新实例读同一 store → 写锁仍然生效。
  const restarted = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore(), store });
  assert.equal(restarted.writeLocked, true);
  await assert.rejects(() => approvedExecution(restarted, syncPlan()), { code: 'PCB_WRITE_LOCKED' });

  const cleared = restarted.releaseSafetyLock({ operator: 'test', note: '人工核实完成' });
  assert.equal(cleared.released, true);
  assert.equal(restarted.writeLocked, false);
  assert.equal(saved?.writeLock?.locked, false);
  const afterClear = new PcbManager({ stateDir, bridge: makeBridge(), approvals: new ApprovalStore(), store });
  assert.equal(afterClear.writeLocked, false);
  // stateDir 是新的临时目录，安全锁解除后不应有残留锁文件影响后续执行。
  assert.equal(existsSync(lockFile(stateDir)), false);
});
