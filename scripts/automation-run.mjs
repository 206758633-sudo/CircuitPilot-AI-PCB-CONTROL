#!/usr/bin/env node
/**
 * 真机自动化配方执行器（Phase 1）。
 *
 * 用途：在本机嘉立创EDA 已打开的前提下，从命令行跑一条自动化配方，打印每一步的
 * 读回结果与哈希链审计；退出码只在 `run.ok === true` 时为 0。
 *
 * 用法：
 *   node scripts/automation-run.mjs eda-read-state
 *   node scripts/automation-run.mjs eda-open-project --param projectText=DemoBoard --param documentText=PCB1 --approve
 *   node scripts/automation-run.mjs pcb-sync-from-schematic --approve
 *   node scripts/automation-run.mjs pcb-rebuild-pours --approve
 *
 * 说明：
 *   - 默认连 http://127.0.0.1:4179（可用 --base 或 CIRCUITPILOT_RUNTIME_URL 覆盖）；
 *   - 写入配方必须显式 --approve：脚本会先请求服务端签发写板批准（绑定当前窗口/工程/文档指纹）；
 *   - 脚本不伪造成功：状态不是 completed 就以非 0 退出，并打印失败步骤与读回原因。
 */
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179' },
    param: { type: 'string', multiple: true, default: [] },
    approve: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`用法：node scripts/automation-run.mjs <recipeId> [--param key=value ...] [--approve] [--base URL] [--json]`);
  process.exit(values.help ? 0 : 1);
}

const recipeId = positionals[0];
const base = String(values.base).replace(/\/$/, '');
const params = {};
for (const item of values.param) {
  const index = item.indexOf('=');
  if (index < 1) { console.error(`参数格式错误（应为 key=value）：${item}`); process.exit(2); }
  params[item.slice(0, index)] = item.slice(index + 1);
}

const origin = 'http://127.0.0.1:4177';
let token = process.env.CIRCUITPILOT_RUNTIME_TOKEN || null;

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-circuitpilot-token': token } : {}), origin, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  // 1) 握手拿会话令牌（开发模式）；壳层注入令牌时直接用环境变量
  const health = await api('/api/health');
  if (health.status !== 200) { console.error(`Runtime 不可用：${base}（${health.status}）`); process.exit(3); }
  if (typeof health.body.sessionProof === 'string' && health.body.sessionProof.length >= 16) token = health.body.sessionProof;

  // 2) 读配方元信息
  const recipes = await api('/api/automation/recipes');
  const recipe = (recipes.body.recipes || []).find((item) => item.id === recipeId);
  if (!recipe) { console.error(`配方不存在：${recipeId}`); process.exit(4); }
  console.log(`配方：${recipe.title}（${recipe.id}）· 步骤 ${recipe.stepCount} · 需要批准：${recipe.requiredApprovals.join(',') || '无'}`);
  const missing = Object.entries(recipe.params || {}).filter(([name, spec]) => spec.required && !params[name]).map(([name]) => name);
  if (missing.length) { console.error(`缺少必填参数：${missing.join(',')}`); process.exit(5); }

  // 3) 按配方要求签发批准（一次性、绑定当前 EDA 目标）
  const approvalIds = [];
  if (recipe.requiredApprovals.length) {
    if (!values.approve) { console.error(`这是写入配方，必须显式 --approve 才能执行。`); process.exit(6); }
    for (const scope of recipe.requiredApprovals) {
      const issued = await api('/api/automation/approvals', { method: 'POST', body: JSON.stringify({ scope, recipeId, note: `CLI ${recipeId}` }) });
      if (issued.status !== 200) { console.error(`签发批准失败：${issued.body?.error?.message || issued.status}`); process.exit(7); }
      approvalIds.push(issued.body.approval.approvalId);
      console.log(`已签发批准：${issued.body.approval.scope} · 指纹 ${issued.body.approval.fingerprint} · 到期 ${issued.body.approval.expiresAt}`);
    }
  }

  // 4) 执行
  const run = await api('/api/automation/run', { method: 'POST', body: JSON.stringify({ recipeId, params, approvalIds }) });
  if (run.status !== 200) { console.error(`执行请求失败：${run.body?.error?.code} ${run.body?.error?.message}`); process.exit(8); }
  const result = run.body.run;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`\n结果：${result.state}`);
    for (const step of result.steps) console.log(`  ✔ ${step.stepId} · ${step.strategy || 'primary'} · 读回 ${step.evidence?.checks ?? 0} 条断言`);
    if (result.failedStep) console.log(`  ✖ ${result.failedStep.stepId}：${result.failedStep.failures.join('；')}`);
    if (result.missingParams) console.log(`  待填参数：${result.missingParams.join(',')}`);
    if (result.missingApprovals) console.log(`  待批准：${result.missingApprovals.join(',')}`);
  }

  // 5) 审计链
  if (result.runId) {
    const journal = await api(`/api/automation/runs/${encodeURIComponent(result.runId)}`);
    if (journal.status === 200) {
      const { chain, entries } = journal.body.run;
      console.log(`\n审计：${entries.length} 条 · 哈希链 ${chain.ok ? '完整' : `断裂@${chain.brokenAt}`} · ${journal.body.run.journalPath}`);
      if (!values.json) for (const entry of entries) console.log(`  ${String(entry.seq).padStart(2)} ${entry.phase}${entry.stepId ? ` (${entry.stepId})` : ''}${entry.ok === undefined ? '' : entry.ok ? ' ✔' : ' ✖'}`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => { console.error(`执行异常：${error?.message || error}`); process.exit(9); });
