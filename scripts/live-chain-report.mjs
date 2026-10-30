#!/usr/bin/env node
/**
 * F3：真机只读链路验收矩阵（R1–R8）。
 *
 * 目的：把"R1–R8 哪些能自动验、哪些必须人工/批准"变成一条可执行命令 + 机器可读报告，
 * 而不是验收报告里一句笼统的 SKIPPED。
 *
 * 纪律：
 *   - 只调用**只读**路由（discover/windows、routing/plan、pours、drc/latest、生产签核/DFM 最新证据）；
 *   - 绝不调用写板/落盘/批准/导出路由；
 *   - 每一步都记录 pass/skip/fail 与真实读数；没有证据就 SKIPPED 并写原因，不伪造 PASS；
 *   - 只读步骤失败 → 整体 FAIL 且 exit 1；跳过项不算失败（报告里明确列出）。
 *
 * 用法：node scripts/live-chain-report.mjs
 * 环境：CIRCUITPILOT_RUNTIME_URL（默认 4179）、CIRCUITPILOT_RUNTIME_TOKEN 或 /tmp/cp_my_token.txt
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179').replace(/\/$/, '');
const TOKEN = process.env.CIRCUITPILOT_RUNTIME_TOKEN
  || (existsSync('/tmp/cp_my_token.txt') ? readFileSync('/tmp/cp_my_token.txt', 'utf8').trim() : (existsSync('/tmp/cp_runtime_token.txt') ? readFileSync('/tmp/cp_runtime_token.txt', 'utf8').trim() : ''));
const OUT_DIR = join(process.cwd(), 'artifacts', 'f3-live-chain');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TIMEOUT_MS = Number(process.env.CIRCUITPILOT_LIVE_TIMEOUT_MS) || 120_000;

const items = [];
const record = (item) => { items.push(item); return item; };
const truncate = (value, max = 300) => String(value ?? '').slice(0, max);

async function call(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-circuitpilot-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function pass(id, title, evidence) { return record({ id, title, status: 'pass', evidence }); }
function skip(id, title, reason) { return record({ id, title, status: 'skipped', reason }); }
function fail(id, title, error, details = null) { return record({ id, title, status: 'fail', error: truncate(error), details }); }

const reachable = await fetch(`${BASE}/api/health`).then((response) => response.ok).catch(() => false);
if (!reachable) {
  record({ id: 'environment', title: '运行时可达性', status: 'skipped', reason: `运行时不可达：${BASE}（先启动 npm run dev:runtime）` });
} else if (!TOKEN) {
  record({ id: 'environment', title: '运行时令牌', status: 'fail', error: '缺少运行时令牌（CIRCUITPILOT_RUNTIME_TOKEN 或 /tmp/cp_my_token.txt）' });
} else {
  // R1：目标解析（窗口/工程/文档）
  try {
    const discover = await call('/api/eda/discover');
    const windows = await call('/api/eda/windows');
    if (discover.status !== 200 || windows.status !== 200) throw new Error(`discover=${discover.status} windows=${windows.status}`);
    const win = windows.payload?.windows || windows.payload?.data?.windows || [];
    if (!win.length) throw new Error('没有可用 EDA 窗口（请先打开嘉立创EDA并打开目标板）');
    const selected = windows.payload?.selectedWindowId || windows.payload?.selected?.id || windows.payload?.data?.selectedWindowId || win[0]?.id || null;
    pass('R1', '目标解析：EDA 窗口/工程上下文', { windows: win.length, selectedWindowId: truncate(selected, 80), selectionRequired: windows.payload?.selectionRequired ?? null, discover: truncate(discover.payload?.service ?? discover.payload?.ok, 40) });
  } catch (error) { fail('R1', '目标解析：EDA 窗口/工程上下文', error.message); }

  // R4：PCB 现状 + 铜几何（只读：routing/plan 会读快照并做规划，不写板）
  try {
    const plan = await call('/api/eda/pcb/routing/plan', { method: 'POST', body: { maxConnections: 1 } });
    if (plan.status !== 200 || plan.payload?.ok !== true) throw new Error(`HTTP ${plan.status} ${truncate(plan.payload?.error?.code ?? '', 60)}`);
    const copper = plan.payload?.copper ?? null;
    if (!copper) throw new Error('响应缺少铜几何计数');
    pass('R4', 'PCB 现状：铜几何快照（只读规划）', { copper });
  } catch (error) { fail('R4', 'PCB 现状：铜几何快照（只读规划）', error.message); }

  // R6（只读部分）：覆铜图元快照
  try {
    const pours = await call('/api/eda/pcb/pours');
    if (pours.status !== 200) throw new Error(`HTTP ${pours.status}`);
    const list = Array.isArray(pours.payload?.pours) ? pours.payload.pours : (pours.payload?.pours?.pours ?? null);
    if (!list) throw new Error('响应缺少 pours 列表');
    pass('R6-readonly', '覆铜现状只读快照', { pours: list.length });
  } catch (error) { fail('R6-readonly', '覆铜现状只读快照', error.message); }

  // R5：DRC 最新证据（不自动开跑 DRC，避免改动 EDA 会话状态）
  try {
    const latest = await call('/api/eda/pcb/drc/latest');
    if (latest.status !== 200) throw new Error(`HTTP ${latest.status}`);
    const evidence = latest.payload?.evidence ?? null;
    if (!evidence) skip('R5', 'DRC 最新证据', '尚未生成 DRC 证据：请在 EDA 里人工运行 DRC，或在 UI 显式触发 DRC 任务后重跑本报告');
    else pass('R5', 'DRC 最新证据', { digest: truncate(evidence.digest ?? evidence.reportDigest ?? '', 64), reportedCount: evidence.reportedCount ?? evidence.counts?.reported ?? null, at: truncate(evidence.at ?? evidence.generatedAt ?? '', 40) });
  } catch (error) { fail('R5', 'DRC 最新证据', error.message); }

  // R7：生产签核 / DFM 证据（只读“最新”查询，不导出、不签核）
  try {
    const signoff = await call('/api/production/signoff/latest');
    const dfm = await call('/api/production/dfm-evidence/latest');
    const signoffEvidence = signoff.payload?.evidence ?? null;
    const dfmEvidence = dfm.payload?.evidence ?? null;
    if (!signoffEvidence && !dfmEvidence) skip('R7', '生产签核 / DFM 证据', '尚无可读的签核或 DFM 证据（需人工完成 DFM 上传/签核后才有）');
    else pass('R7', '生产签核 / DFM 证据', { signoff: signoffEvidence ? { at: truncate(signoffEvidence.at ?? signoffEvidence.signedAt ?? '', 40) } : null, dfm: dfmEvidence ? { at: truncate(dfmEvidence.at ?? '', 40) } : null });
  } catch (error) { fail('R7', '生产签核 / DFM 证据', error.message); }

  // 明确不执行的项（写/批准/人工）
  skip('R2', '落板（placement/apply）', '写板动作：必须由用户在 UI 显式签发写板批准，只读报告不执行');
  skip('R3', '布线写铜（routing/apply）', '写板动作：必须由用户签发写板批准；且当前整板布线受 via-in-pad 工艺限制（A10 已记录边界）');
  skip('R6-write', '铺铜重建/新建', '写板动作：需要用户签发写板批准');
  skip('R8', '生产文件导出/放行', '导出会落盘生产文件并绑定最终 DRC/签核，必须人工批准后执行；本报告只读');
}

const failed = items.filter((item) => item.status === 'fail');
const passes = items.filter((item) => item.status === 'pass');
const skips = items.filter((item) => item.status === 'skipped');
const verdict = failed.length ? 'fail' : (passes.length ? 'pass' : 'skipped');
mkdirSync(OUT_DIR, { recursive: true });
const report = { kind: 'live-chain-report', generatedAt: new Date().toISOString(), baseUrl: BASE, verdict, items };
writeFileSync(join(OUT_DIR, `live-chain-${STAMP}.json`), JSON.stringify(report, null, 2));
const md = ['# F3 真机只读链路矩阵（R1–R8）', '', `- 时间：${report.generatedAt}`, `- 目标：${BASE}`, `- 结论：**${verdict.toUpperCase()}**（pass ${passes.length} / skip ${skips.length} / fail ${failed.length}）`, '', '| 项 | 内容 | 结果 | 读数/原因 |', '|---|---|---|---|', ...items.map((item) => `| ${item.id} | ${item.title} | ${item.status.toUpperCase()} | ${item.reason ?? (item.error ? `ERROR: ${item.error}` : JSON.stringify(item.evidence))} |`), '', '说明：只读报告不执行任何写板/导出/签核动作；写/批准项必须由人工在 UI 完成。'];
writeFileSync(join(OUT_DIR, `live-chain-${STAMP}.md`), md.join('\n'));
console.log(md.slice(0, 4).join('\n'));
console.log(md.slice(6, 6 + 1 + items.length).join('\n'));
process.exit(failed.length ? 1 : 0);
