#!/usr/bin/env node
/**
 * A7 / R3 真机验收：原理图网表连线通道（写 → 保存 → 网表逐引脚读回 → 删除 → 复原）。
 *
 * 三个相位（默认 artifacts/a7-r3/<时间戳>/ 作为同一个证据目录）：
 *   probe     只读：打开原理图页面，让服务端基于网表列出悬空引脚并给出"验证用网络"计划；
 *   write     写：用 --approve 让服务端签发一次绑定当前窗口+工程+文档的 write 批准（用户已显式
 *             授权由本代理代其签发），写入网络端口 → 保存 → 读回网表确认目标引脚网络正确；
 *   rollback  写：删除本次写入的端口 → 保存 → 读回确认目标引脚回到无网（删除后复原）。
 *
 * 安全边界：
 *   - 只写"验证用网络"（默认 CP_R3_TEST_*），写完必须 rollback；它不是替用户决定真实网络归属；
 *   - 写前/写后都由服务端在真实 EDA 上读网表核对，任何既有网络丢引脚/计划外引脚被赋网 → 服务端回滚并报错；
 *   - 不伪造：任意相位失败即非 0 退出，证据 JSON 原样落盘。
 *
 * 用法：
 *   node scripts/a7-r3-acceptance.mjs probe
 *   node scripts/a7-r3-acceptance.mjs write --approve
 *   node scripts/a7-r3-acceptance.mjs rollback --approve
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179').replace(/\/$/, '');
const TOKEN = process.env.CIRCUITPILOT_RUNTIME_TOKEN
  || (existsSync('/tmp/cp_my_token.txt') ? readFileSync('/tmp/cp_my_token.txt', 'utf8').trim() : '')
  || (existsSync('/tmp/cp_runtime_token.txt') ? readFileSync('/tmp/cp_runtime_token.txt', 'utf8').trim() : '');
const args = process.argv.slice(2);
const phase = args.find((item) => !item.startsWith('--')) || 'probe';
const flag = (name, fallback = null) => { const index = args.indexOf(`--${name}`); return index >= 0 ? (args[index + 1] ?? true) : fallback; };
const approve = args.includes('--approve');
const COUNT = Number(flag('count', 5));
const PREFIX = String(flag('prefix', 'CP_R3_TEST'));
const OUT = String(flag('out', join(process.cwd(), 'artifacts', 'a7-r3', new Date().toISOString().replace(/[:.]/g, '-'))));
// 目标工程/原理图页面必须显式固定：工程里有 3 块板，open-current 默认取"第一个页面"可能落到别的板。
// 默认值是本次验收板（智能衣橱助手 Board1_1 · Schematic1_1 · P1），可用 --project/--page 覆盖。
const PROJECT = String(flag('project', process.env.CIRCUITPILOT_A7_PROJECT || '5e1059beff734847ba4b38b557e8ed59'));
const PAGE = String(flag('page', process.env.CIRCUITPILOT_A7_PAGE || '8db59ac7bbc9510b'));

if (!TOKEN) { console.error('缺少运行时令牌（CIRCUITPILOT_RUNTIME_TOKEN 或 /tmp/cp_my_token.txt）'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

async function api(path, { method = 'GET', body = null, timeoutMs = 300_000 } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-circuitpilot-token': TOKEN, origin: 'http://127.0.0.1:4177' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed?.ok === false) {
    const error = parsed?.error || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` };
    const thrown = new Error(`${error.code}: ${String(error.message || '').slice(0, 300)}`);
    thrown.code = error.code; thrown.details = error.details;
    throw thrown;
  }
  return parsed;
}
const writeJson = (name, value) => writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
const statePath = join(OUT, 'state.json');
const loadState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
const line = (text) => console.log(text);

async function openSchematic() {
  // EDA 可能停在首页/别的板：先显式打开目标工程，再打开指定页面，最后读回活动文档 UUID 核对。
  const project = await api('/api/eda/project/open', { method: 'POST', body: { projectUuid: PROJECT, activatePcb: false } });
  const opened = await api('/api/eda/schematic/open-current', { method: 'POST', body: { documentUuid: PAGE } });
  const documentUuid = opened?.schematic?.documentUuid ?? null;
  const context = await api('/api/design/context');
  const active = context?.context?.document ?? null;
  const activeProject = context?.context?.project ?? null;
  const projectUuid = project?.project?.projectUuid ?? activeProject?.uuid ?? null;
  if (documentUuid !== PAGE) throw Object.assign(new Error(`打开的原理图页面是 ${documentUuid ?? '?'}，不是目标 ${PAGE}`), { code: 'A7_WRONG_DOCUMENT' });
  if (active?.uuid && active.uuid !== PAGE) throw Object.assign(new Error(`活动文档是 ${active.uuid}，不是目标原理图页面 ${PAGE}`), { code: 'A7_WRONG_DOCUMENT' });
  line(`  项目: ${projectUuid ?? '?'} / 板: ${project?.project?.title ?? '?'} / 原理图页面: ${documentUuid}`);
  return { documentUuid, workspace: { projectUuid, boards: project?.project?.boards ?? null } };
}

async function issueWriteApproval(note) {
  // 用户在本会话显式授权："需要我签发就控制电脑去自己实现"——批准仍由服务端在真实 EDA 会话上
  // 绑定当前窗口/工程/文档签发，可审计；这里如实把"代签"写进 note，不冒充人工点击。
  const issued = await api('/api/automation/approvals', { method: 'POST', body: { scope: 'write', recipeId: null, note } });
  const approval = issued?.approval ?? null;
  if (!approval?.approvalId) throw Object.assign(new Error('服务端未返回批准 ID'), { code: 'APPROVAL_ISSUE_FAILED' });
  writeJson(`approval-${phase}.json`, approval);
  line(`  已签发 write 批准 ${approval.approvalId}（绑定指纹 ${approval.fingerprint}，${approval.expiresAt} 过期）`);
  return approval;
}

async function probe() {
  line(`[probe] ${BASE} → ${OUT}`);
  const { documentUuid, workspace } = await openSchematic();
  const report = await api('/api/eda/schematic/net-connect', { method: 'POST', body: { dryRun: true, autoCandidates: true, candidateLimit: COUNT, maxNets: 3, testNetPrefix: PREFIX } });
  writeJson('probe.json', report);
  const plan = report?.plan ?? {};
  const candidates = report?.candidates ?? [];
  line(`  悬空引脚候选 ${candidates.length} 个；验证计划 ${plan.operations?.length ?? 0} 个端口 / 网络 ${(plan.nets || []).join(',')}`);
  for (const operation of plan.operations || []) line(`    · ${operation.net} ← ${operation.designator || operation.uniqueId}.${operation.pinNumber} @ (${operation.x}, ${operation.y})`);
  if (!report.ok) { line(`  ❌ 计划不通过：${(plan.findings || []).map((item) => item.message).join('；')}`); return 1; }
  writeFileSync(statePath, `${JSON.stringify({ phase: 'probe', documentUuid, workspace, connections: report.suggestedConnections, candidates, createdAt: new Date().toISOString() }, null, 2)}\n`);
  line('  ✅ probe 通过（只读，未写任何图元）');
  return 0;
}

async function write() {
  line(`[write] ${BASE} → ${OUT}`);
  if (!approve) { line('  ❌ write 需要 --approve（由服务端签发 write 批准后才能写）'); return 2; }
  const state = loadState();
  if (!state?.connections?.length) { line('  ❌ 先跑 probe 生成 state.json'); return 2; }
  const { documentUuid } = await openSchematic();
  if (state.documentUuid && documentUuid && state.documentUuid !== documentUuid) {
    line(`  ⚠️ 原理图页面与 probe 时不同（${state.documentUuid} → ${documentUuid}）：重新 probe 后再写`);
    return 2;
  }
  const approval = await issueWriteApproval(`A7/R3 真机验收：用户已显式授权代理代签 write 批准（session 指令）; prefix=${PREFIX}; count=${state.connections.flatMap((item) => item.pins).length}`);
  const report = await api('/api/eda/schematic/net-connect', { method: 'POST', body: { dryRun: false, connections: state.connections, approvalIds: [approval.approvalId], save: true, skipSimulation: true } });
  writeJson('write.json', report);
  const applied = report?.applied ?? {};
  const verification = applied.verification ?? {};
  line(`  写入端口 ${applied.createdPrimitiveIds?.length ?? 0} 个；保存 ${applied.saved ? '是' : '否'}；核对 ${verification.ok ? '通过' : '失败'}（目标 ${verification.summary?.targets ?? 0}）`);
  if (!verification.ok) {
    for (const item of [...(verification.missing || []), ...(verification.unexpected || [])]) line(`    ❌ ${JSON.stringify(item)}`);
    return 1;
  }
  const targets = (report?.plan?.operations || []).map((item) => ({ uniqueId: item.uniqueId, designator: item.designator, pinNumber: item.pinNumber, net: item.net }));
  writeFileSync(statePath, `${JSON.stringify({ ...state, phase: 'write', documentUuid, approval, primitiveIds: applied.createdPrimitiveIds, createdPrimitiveIds: applied.createdPrimitiveIds, targets, verification, acceptance: report?.acceptance ?? null, wroteAt: new Date().toISOString() }, null, 2)}\n`);
  line(`  ✅ 写后网表核对通过：${targets.map((item) => `${item.designator || item.uniqueId}.${item.pinNumber}→${item.net}`).join('，')}`);
  return 0;
}

async function rollback() {
  line(`[rollback] ${BASE} → ${OUT}`);
  if (!approve) { line('  ❌ rollback 会删图元/保存，需要 --approve'); return 2; }
  const state = loadState();
  if (!state?.primitiveIds?.length) { line('  ❌ 先跑 write 生成 state.json（含 createdPrimitiveIds）'); return 2; }
  const { documentUuid } = await openSchematic();
  const approval = await issueWriteApproval(`A7/R3 删除后复原：用户已显式授权代理代签 write 批准（session 指令）; primitiveIds=${state.primitiveIds.length}`);
  const report = await api('/api/eda/schematic/net-connect/rollback', { method: 'POST', body: { approvalIds: [approval.approvalId], primitiveIds: state.primitiveIds, targets: state.targets, documentUuid } });
  writeJson('rollback.json', report);
  const rollbackResult = report?.rollback ?? {};
  line(`  删除 ${rollbackResult.deleted ? '成功' : '失败'}；保存 ${rollbackResult.saved ? '成功' : (rollbackResult.deleted && rollbackResult.remaining?.length === 0 ? '跳过（图元已不在）' : '失败')}；残留图元 ${rollbackResult.remaining?.length ?? '?'}；目标引脚复原 ${rollbackResult.targetsRestored ? '是' : '否'}`);
  if (!report.ok) return 1;
  writeFileSync(statePath, `${JSON.stringify({ ...state, phase: 'rollback', rollback: rollbackResult, rolledBackAt: new Date().toISOString() }, null, 2)}\n`);
  line('  ✅ 删除后复原核对通过（原理图回到写入前网络状态）');
  return 0;
}

try {
  const code = phase === 'probe' ? await probe() : phase === 'write' ? await write() : phase === 'rollback' ? await rollback() : 2;
  console.log(`\n证据目录：${OUT}`);
  process.exit(code);
} catch (error) {
  console.error(`❌ ${phase} 失败：${error.code ? `${error.code}: ` : ''}${error.message}`);
  if (error.details) writeJson(`error-${phase}.json`, error.details);
  process.exit(1);
}
