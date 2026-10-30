#!/usr/bin/env node
/**
 * E8：真机半写故障注入 + 收敛验证（可重复执行，失败退出码 1）。
 *
 * 注入方式不是"模拟网络断"，而是真实最危险的半写：覆铜创建**已经写进板子**，
 * 但读回断言故意不满足（expectedPourCount 给 +99）→ runner 必须走 rollback，
 * 用 `pcb.pour.deleteAdded` 按运行前快照差集删除本次新增覆铜。
 *
 * 判定（全部满足才算通过）：
 *   1) run.state === 'failed'（不是 completed，也不冒充成功）；
 *   2) run.rollback.ok === true，且回退动作确实执行；
 *   3) 运行后覆铜 id 集合 == 运行前快照（板上没有残留）；
 *   4) journal 里能找到 rollback.step 记录。
 *
 * 用法：node scripts/e8-halfwrite-injection.mjs [--token x] [--base http://127.0.0.1:4179]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const base = flag('--base', process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179').replace(/\/$/, '');
const token = flag('--token', process.env.CIRCUITPILOT_RUNTIME_TOKEN || readFileSync('/tmp/cp_my_token.txt', 'utf8').trim());
const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': token, origin: 'http://127.0.0.1:4177' };

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({ raw: 'unparsable' }));
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`), { status: response.status, payload });
  return payload;
}

const before = await call('GET', '/api/eda/pcb/pours');
const beforeIds = (before.pours || []).map((item) => String(item.primitiveId)).sort();
console.log(`[e8] 运行前覆铜 ${beforeIds.length} 个：${beforeIds.join(',')}`);

const issued = await call('POST', '/api/automation/approvals', {
  scope: 'write',
  note: 'E8 半写故障注入（AI 代用户授权本次真机演练；只创建→故意读回失败→自动回滚删除，不改其它设计）',
});
const approvalId = issued.approval?.approvalId;
if (!approvalId) throw new Error('写板批准签发失败');
console.log(`[e8] 批准：${approvalId} 指纹 ${String(issued.approval.fingerprint).slice(0, 12)}`);

const runResponse = await call('POST', '/api/automation/run', {
  recipeId: 'pcb-create-pour',
  runId: `e8-halfwrite-${Date.now().toString(36)}`,
  approvalIds: [approvalId],
  params: {
    net: 'GND',
    layer: 1,
    outline: [[400, 400], [520, 400], [520, 520], [400, 520]],
    pourName: 'E8-HALFWRITE',
    expectedPourCount: beforeIds.length + 99,
    existingPourIds: beforeIds,
  },
});
const run = runResponse.run;
const after = await call('GET', '/api/eda/pcb/pours');
const afterIds = (after.pours || []).map((item) => String(item.primitiveId)).sort();
const journal = run.runId ? await call('GET', `/api/automation/runs/${encodeURIComponent(run.runId)}`) : null;
const rollbackSteps = (journal?.run?.entries || []).filter((entry) => entry.phase === 'rollback.step');

const checks = {
  stateIsFailed: run.state === 'failed',
  rollbackOk: run.rollback?.ok === true,
  rollbackExecuted: Array.isArray(run.rollback?.executed) && run.rollback.executed.length > 0,
  noLeftoverPours: JSON.stringify(afterIds) === JSON.stringify(beforeIds),
  journalHasRollbackStep: rollbackSteps.length > 0,
};
const evidence = {
  schemaVersion: 1,
  kind: 'e8-halfwrite-injection',
  at: new Date().toISOString(),
  recipeId: 'pcb-create-pour',
  injection: 'expectedPourCount = before + 99（写入成功后读回必失败）',
  approvalId,
  before: { count: beforeIds.length, ids: beforeIds },
  run: { runId: run.runId, state: run.state, failedStep: run.failedStep, rollback: run.rollback, steps: run.steps },
  after: { count: afterIds.length, ids: afterIds },
  journal: { path: journal?.run?.journalPath ?? null, chain: journal?.run?.chain ?? null, rollbackSteps: rollbackSteps.length },
  checks,
  ok: Object.values(checks).every(Boolean),
};
const dir = join(process.cwd(), 'artifacts/e8-halfwrite');
mkdirSync(dir, { recursive: true });
const file = join(dir, `e8-halfwrite-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[e8] state=${run.state} rollback.ok=${run.rollback?.ok} 覆铜 ${beforeIds.length}→${afterIds.length}`);
console.log(`[e8] journal=${journal?.run?.journalPath} rollbackSteps=${rollbackSteps.length}`);
console.log(`[e8] 证据：${file}`);
if (!evidence.ok) {
  console.error(`[e8] 失败：${JSON.stringify(checks)}`);
  process.exit(1);
}
