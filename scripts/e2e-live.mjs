#!/usr/bin/env node
/**
 * 真机全链路驱动（板子只读）。
 *
 * 用途：把"小白需求 → PCBA 判断 → 元件匹配 → 原理图(含网表) → 布局 → 布线校验 → DRC → 3D → 生产文件"
 * 这条链在**真实嘉立创EDA**上从头跑一遍，每步留下可复核的读数，最后产出正式生产文件。
 *
 * 硬约束（本脚本的设计前提）：**不改板子**。
 *   - 只调用只读/校验/导出类路由：placement/plan、routing/plan、drc/*、schematic/acceptance、
 *     production/*、pcb/3d/export。
 *   - 绝不调用任何写板路由：placement/apply、routing/apply、routing/finish、routing/rollback、
 *     schematic/repair，以及 approve 类与 execute 类路由。
 *   - 首尾各读一次铜几何计数并比对，用数据证明"板现状不变"（不是靠口头保证）。
 *
 * 用法：
 *   node scripts/e2e-live.mjs                    # 全链路（跳过 GLB）
 *   CIRCUITPILOT_E2E_GLB=1 node scripts/e2e-live.mjs          # 末尾附加 GLB 尝试
 *   CIRCUITPILOT_E2E_USER_CONFIRMED=1 node scripts/e2e-live.mjs  # 带上"人已确认布局"（仅当真有真人确认）
 *
 * 环境变量：
 *   CIRCUITPILOT_RUNTIME_URL    运行时地址，默认 http://127.0.0.1:4179
 *   CIRCUITPILOT_RUNTIME_TOKEN  运行时令牌；缺省读 /tmp/cp_runtime_token.txt
 *   CIRCUITPILOT_E2E_OUT_DIR    生产文件输出目录，默认 release/<今天>
 *   CIRCUITPILOT_E2E_PLAN       语义计划路径，默认 deliverables/cp-multilayer-monitor-20261013/cp_semantic_plan_6l_with_cc_fix.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const BASE = (process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179').replace(/\/$/, '');
const TOKEN = process.env.CIRCUITPILOT_RUNTIME_TOKEN
  || (existsSync('/tmp/cp_runtime_token.txt') ? readFileSync('/tmp/cp_runtime_token.txt', 'utf8').trim() : '');
const PLAN_PATH = process.env.CIRCUITPILOT_E2E_PLAN
  || join(ROOT, 'deliverables/cp-multilayer-monitor-20261013/cp_semantic_plan_6l_with_cc_fix.json');
const OUT_DIR = process.env.CIRCUITPILOT_E2E_OUT_DIR || join(ROOT, 'release', new Date().toISOString().slice(0, 10));
const WITH_GLB = process.env.CIRCUITPILOT_E2E_GLB === '1';
const USER_CONFIRMED = process.env.CIRCUITPILOT_E2E_USER_CONFIRMED === '1';
const DEFAULT_TIMEOUT_MS = Number(process.env.CIRCUITPILOT_E2E_TIMEOUT_MS) || 600_000;

const steps = [];
const unwrap = (value) => value?.result ?? value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-circuitpilot-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  const payload = unwrap(parsed);
  if (!response.ok || parsed?.error) {
    const error = parsed?.error || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` };
    const thrown = new Error(`${error.code}: ${String(error.message || '').slice(0, 300)}`);
    thrown.code = error.code;
    thrown.details = error.details;
    throw thrown;
  }
  return payload;
}

/** 记一步：绝不让异常打断整条链——每一步如实记录 pass/warn/fail/skipped 与读数。 */
async function step(id, title, run, { optional = false } = {}) {
  const startedAt = Date.now();
  try {
    const evidence = await run();
    steps.push({ id, title, status: evidence?.status || 'pass', ms: Date.now() - startedAt, evidence: evidence?.data ?? evidence ?? null, note: evidence?.note ?? null });
  } catch (error) {
    steps.push({ id, title, status: optional ? 'warn' : 'fail', ms: Date.now() - startedAt, error: `${error.code ? `${error.code}: ` : ''}${error.message}`, details: error.details ?? null });
  }
  const last = steps[steps.length - 1];
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', skipped: '⏭️' }[last.status] || '❔';
  console.log(`${icon} ${title}${last.ms ? ` (${(last.ms / 1000).toFixed(1)}s)` : ''}${last.error ? ` — ${last.error}` : ''}`);
  return last;
}

const copperCounts = async () => {
  const plan = await call('/api/eda/pcb/routing/plan', { method: 'POST', body: { pcbUuid: PCB_UUID } });
  return { copper: plan.copper, broken: (plan.brokenNets || []).length };
};

let PCB_UUID = process.env.CIRCUITPILOT_E2E_PCB_UUID || null;
let SCHEMATIC_UUID = process.env.CIRCUITPILOT_E2E_SCHEMATIC_UUID || null;

async function main() {
  console.log(`\n真机全链路 ${BASE}  板子只读  输出目录 ${OUT_DIR}\n`);

  // ── 0. 环境与文档绑定 ────────────────────────────────────────────────
  const env = await step('env', '环境：运行时 + 桥 + EDA 连接', async () => {
    const health = await call('/api/health');
    const bridgeHealth = await fetch('http://127.0.0.1:49620/health', { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
    const current = await call('/api/eda/workspaces/current').catch(() => null);
    const project = unwrap(await call('/api/eda/project/open', { method: 'POST', body: { activatePcb: true } }));
    PCB_UUID = PCB_UUID || project?.pcbUuid || null;
    const rawBoards = project?.project?.boards;
    const boards = Array.isArray(rawBoards) ? rawBoards : (rawBoards && typeof rawBoards === 'object' ? Object.values(rawBoards) : []);
    const board = boards.find((item) => item?.pcb?.uuid) || boards[0] || (project?.project && typeof project.project === 'object' ? project.project : {});
    SCHEMATIC_UUID = SCHEMATIC_UUID || board?.schematic?.page?.[0]?.uuid || board?.schematic?.uuid || null;
    const data = { runtime: health?.service || health?.name || 'ok', bridge: { service: bridgeHealth?.service, edaConnected: bridgeHealth?.edaConnected }, workspace: current?.current?.name || current?.name || null, project: project?.project?.title || null, pcbUuid: PCB_UUID, schematicUuid: SCHEMATIC_UUID };
    return { status: PCB_UUID ? 'pass' : 'warn', data };
  });
  if (!PCB_UUID) throw new Error('没能绑定 PCB 文档 UUID：后续步骤无处可跑');

  // ── 1. 板子基线（首读）：证明后面全程没动板 ────────────────────────────
  const baseline = await step('baseline', '板子基线（首读铜几何）', async () => ({ data: await copperCounts() }));
  const initial = baseline.evidence;

  // ── 2. 需求 → 语义计划（含 AI 自然语言输入）───────────────────────────
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
  await step('plan-normalize', '需求：语义计划归一化（小白语言 → 结构化设计意图）', async () => {
    const normalized = await call('/api/production/plans/normalize', { method: 'POST', body: { plan } });
    const planning = normalized.planning || normalized;
    return { data: { components: (planning.plan?.components || []).length, board: planning.plan?.board || null, issues: (planning.issues || []).length } };
  });
  let semanticPlanHash = null;
  let compiledPlanHash = null;
  await step('plan-compile', '需求：语义计划编译成可执行操作', async () => {
    const result = await call('/api/production/plans/compile', { method: 'POST', body: { plan } });
    const planning = result.planning || result;
    semanticPlanHash = planning.compiled?.semanticPlanHash || planning.planHash || null;
    compiledPlanHash = planning.compiledPlanHash || null;
    return { status: planning.ready ? 'pass' : 'fail', data: { ready: planning.ready, operations: (planning.compiled?.operations || []).length, semanticPlanHash: String(semanticPlanHash || '').slice(0, 16), compiledPlanHash: String(compiledPlanHash || '').slice(0, 16), issues: (planning.issues || []).length } };
  });
  await step('plan-ai', '需求：AI 从自然语言直接出计划（需已配置模型凭据）', async () => {
    const result = await call('/api/production/plans/ai', { method: 'POST', body: { requirement: '做一块 60×40mm 六层监测板：STM32G071 + SHT40 温湿度 + USB-C 供电与数据 + I2C 上拉；USB-C 灌端要 5.1kΩ Rd；用立创商城能买到的料' }, timeoutMs: 420_000 });
    const candidate = result.candidate || {};
    // AI 的契约：事实不足时 status 必须 blocked、plan 必须 null。**blocked 不是故障，是正确行为**
    // （"不猜封装/坐标/叠层"）——所以这里只判"这条链路通不通"，并把它的理由原样带出来。
    const usable = ['ready', 'blocked'].includes(candidate.status);
    return {
      status: usable ? 'pass' : 'warn',
      data: {
        status: candidate.status ?? null,
        planGiven: candidate.plan ? { components: (candidate.plan.components || []).length, nets: (candidate.plan.nets || []).length } : null,
        blockingInformation: (candidate.blockingInformation || []).slice(0, 4),
        normalized: result.planning ? { ready: result.planning.ready ?? null } : null,
        note: candidate.status === 'blocked' ? 'AI 判断关键事实不足并拒绝产出计划（按契约要求，不猜参数）' : null,
      },
    };
  }, { optional: true });

  // ── 3. 元件匹配（嘉立创/LCSC）────────────────────────────────────────
  await step('supply-match', '元件匹配：从嘉立创/LCSC 搜到实物料号', async () => {
    const queries = ['SHT40', '4.7k 电阻', 'STM32G071'];
    const perQuery = [];
    for (const query of queries) {
      const result = await call('/api/eda/library/devices/search', { method: 'POST', body: { query } });
      const candidates = result.search?.candidates || result.candidates || [];
      perQuery.push({ query, mode: result.search?.mode ?? null, found: candidates.length, sample: candidates.slice(0, 2).map((item) => `${item.lcscId || '(无C号)'} ${item.footprintName || ''} ${item.name || ''}`.trim()) });
    }
    // 再从板上 BOM 反查：能查到同封装/同料号才算"匹配到实物"（这是身份的交叉验证，不是自说自话）
    const boardParts = ['C45924513', 'C23186', 'C23162', 'C165948', 'C529344'];
    const verified = [];
    for (const lcscId of boardParts) {
      const result = await call('/api/eda/library/devices/search', { method: 'POST', body: { query: lcscId } });
      const hit = (result.search?.candidates || []).find((item) => String(item.lcscId).toUpperCase() === lcscId);
      verified.push({ lcscId, found: Boolean(hit), footprint: hit?.footprintName || null, jlcClass: hit?.jlcClass || null });
    }
    const missing = verified.filter((item) => !item.found).map((item) => item.lcscId);
    return { status: missing.length ? 'fail' : 'pass', data: { perQuery, boardBomVerified: verified, unmatchedLcscIds: missing } };
  });

  // ── 4. 原理图：网表 + ERC + 设计检查（含仿真）────────────────────────
  const acceptance = {};
  await step('schematic', '原理图：自动切页 → 网表 + ERC + 设计检查(含仿真)', async () => {
    const result = await call('/api/eda/schematic/acceptance', { method: 'POST', body: { plan, schematicUuid: SCHEMATIC_UUID } });
    const report = result.acceptance || result;
    acceptance.evidence = { acceptance: report };
    const nl = report.netlist || {};
    return {
      status: report.ready ? 'pass' : 'warn',
      data: {
        switched: result.schematic?.activated ?? null,
        ready: report.ready,
        netlist: { components: nl.components, nets: nl.nets, pins: nl.pins, namedPins: nl.namedPins, sha256: (nl.meta?.sha256 || '').slice(0, 16) },
        designChecks: (report.designChecks?.summary) || null,
        blocking: (report.findings || []).filter((item) => item.severity === 'blocking').map((item) => item.code),
        warnings: (report.findings || []).filter((item) => item.severity === 'warning').map((item) => item.code),
      },
    };
  });

  // ── 5. 布局：按板框校验（只读，不写）─────────────────────────────────
  const placement = await step('placement', '布局：按板框轮廓校验（只读）', async () => {
    const result = await call('/api/eda/pcb/placement/plan', { method: 'POST', body: { pcbUuid: PCB_UUID, overhangAllowances: { J1: { maxOverhangMm: 0.2, reason: '板边贴装 USB-C 插座外壳按结构伸出板边，焊盘全部在板框内' } } } });
    const cv = result.currentVerification || {};
    const blocking = (cv.findings || []).filter((item) => item.severity === 'blocking').map((item) => `${item.code}[${item.field || ''}]`);
    return { status: blocking.length ? 'fail' : 'pass', data: { componentCount: result.componentCount, outlinePoints: (result.outline?.points || []).length, blocking, warnings: [...new Set((cv.findings || []).filter((i) => i.severity !== 'blocking').map((i) => i.code))] } };
  });

  // ── 6. 布线校验：断网 + 几何复核（只读，不写）────────────────────────
  await step('routing', '布线：断网检查 + 间距复核（只读）', async () => {
    const result = await call('/api/eda/pcb/routing/plan', { method: 'POST', body: { pcbUuid: PCB_UUID } });
    const verification = result.verification || {};
    return {
      status: (result.brokenNets || []).length ? 'fail' : 'pass',
      data: { copper: result.copper, brokenNets: result.brokenNets || [], verification: { ok: verification.ok, minGapMil: verification.minGapMil, clearanceMil: verification.clearanceMil, violations: (verification.violations || []).length } },
    };
  });

  // ── 7. DRC（跑在 EDA 里，不改板）───────────────────────────────────
  const drc = await step('drc', '规则校验：官方 DRC + 逐项归因', async () => {
    const started = await call('/api/eda/pcb/drc/start', { method: 'POST', body: { userInterface: false } });
    const jobId = started.jobId;
    let report = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(5_000);
      report = await call('/api/eda/pcb/drc/report', { method: 'POST', body: { jobId } });
      if (report.state !== 'running') break;
    }
    const classification = report.classification || {};
    const summary = classification.summary || {};
    if (report.state === 'running') return { status: 'fail', data: { jobId, note: 'DRC 作业在时限内没有结束，不能当成通过' } };
    const reportPath = join(tmpdir(), `cp-e2e-drc-${Date.now()}.json`);
    if (report.report) writeFileSync(reportPath, JSON.stringify(report.report), 'utf8');
    lastDrcReportPath = report.report ? reportPath : null;
    return { status: classification.ready ? 'pass' : 'fail', data: { jobId, state: report.state, summary, ready: classification.ready, reportPath: lastDrcReportPath } };
  });

  // ── 8. 生产文件：门禁 → 正式导出 → 复核 ─────────────────────────────
  const readiness = await step('readiness', '生产就绪度：八条证据链逐条点名', async () => {
    const result = await call('/api/production/readiness', { method: 'POST', body: { pcbUuid: PCB_UUID, pageUuid: SCHEMATIC_UUID, semanticPlanHash, compiledPlanHash } });
    return { data: result.readiness || result };
  });
  const exported = await step('export', '生产文件：门禁通过后按正式命名导出', async () => {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    const result = await call('/api/production/export', {
      method: 'POST',
      body: {
        requested: 'final',
        outDir: OUT_DIR,
        artifactsDir: OUT_DIR,
        pcbUuid: PCB_UUID,
        pageUuid: SCHEMATIC_UUID,
        plan,
        semanticPlanHash,
        compiledPlanHash,
        acceptance: acceptance.evidence?.acceptance ?? null,
        drcReportPath: lastDrcReportPath,
        userConfirmed: USER_CONFIRMED,
        overhangAllowances: { J1: { maxOverhangMm: 0.2, reason: '板边贴装 USB-C 插座（TYPE-C-31-M-12），外壳两角按连接器结构伸出板边 0.174mm 才能插线；焊盘全部在板框内，不影响装配与电气' } },
      },
    });
    const wrote = (result.wrote || []).map((path) => ({ name: basename(path), bytes: existsSync(path) ? statSync(path).size : null }));
    const decision = result.decision || {};
    return {
      status: result.exported ? 'pass' : 'warn',
      data: { exported: result.exported, outputClass: decision.outputClass ?? null, code: decision.code ?? null, blockers: result.gate?.blockerCodes || [], wrote },
    };
  });
  // ── 9. 3D（STEP 必须成功；GLB 视 EDA 版本能力）───────────────────────
  await step('3d-step', '3D：贴装后模型导出（STEP）', async () => {
    const result = await call('/api/pcb/3d/export', { method: 'POST', body: { format: 'step', fileName: 'STEP_CircuitPilot-assembled', outDir: OUT_DIR } });
    const model = result.model || result;
    return { status: model.bytes > 0 ? 'pass' : 'fail', data: { bytes: model.bytes, name: model.path ? basename(model.path) : null, sha256: String(model.sha256 || '').slice(0, 16) } };
  });
  // GLB 默认**不做**：实测在这个 EDA 版本上它只会返回空，而且反复尝试会把 3D 导出通道卡住
  // （卡住之后连 STEP 都会拿桥 503）。所以改成显式开关 CIRCUITPILOT_E2E_GLB=1 才跑，
  // 保证"跑通全流程"这条链不会因为一个已知不支持的特性把自己弄坏。
  if (!WITH_GLB) {
    steps.push({ id: '3d-glb', title: '3D：GLB（默认跳过，CIRCUITPILOT_E2E_GLB=1 才试）', status: 'skipped', ms: 0, evidence: { note: '该 EDA 版本不产出 GLB；为避免卡住 3D 导出通道，默认不试' } });
  } else await step('3d-glb', '3D：GLB（取决于嘉立创EDA 版本是否支持）', async () => {
    const result = await call('/api/pcb/3d/export', { method: 'POST', body: { format: 'glb', fileName: 'GLB_CircuitPilot-assembled', outDir: OUT_DIR }, timeoutMs: 360_000 });
    const model = result.model || result;
    return { status: model.bytes > 0 ? 'pass' : 'warn', data: { bytes: model.bytes ?? null, note: model.bytes ? null : '该 EDA 版本未产出 GLB（如实记录，不伪造文件）' } };
  }, { optional: true });

  await step('artifacts', '生产文件：逐件内容自检（存在性/命名/位号/STEP 头）', async () => {
    // 说明：`/api/production/artifacts/inspect` 要的是 manifest 绑定（给文件清单它不看），
    // 所以这里做**本地逐件自检**——判据和门禁同源：正式命名、非空、位号集合、STEP 头。
    const names = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [];
    const pick = (prefix, ext) => names.find((name) => name.startsWith(prefix) && name.endsWith(ext) && !/DRAFT|NOT-FOR-ORDER/i.test(name));
    const found = {
      gerber: pick('GERBER_', '.zip'),
      bom: pick('BOM_', '.csv'),
      cpl: pick('CPL_', '.csv'),
      step: names.find((name) => name.startsWith('STEP_') && /\.(step|stp)$/i.test(name)),
    };
    const checks = [];
    const missing = Object.entries(found).filter(([, name]) => !name).map(([kind]) => kind);
    for (const [kind, name] of Object.entries(found)) {
      if (!name) continue;
      const path = join(OUT_DIR, name);
      const bytes = statSync(path).size;
      checks.push({ kind, name, bytes, ok: bytes > 0 });
    }
    // 真机教训：嘉立创导出的 BOM/CPL 是 UTF-16（字节里夹 NUL），按 utf8 直读会读成乱码，
    // 于是"位号数=0"这种假失败。统一按 utf8 读再剥掉 NUL，两种编码都能用。
    const readTable = (name) => (name ? readFileSync(join(OUT_DIR, name), 'utf8').replace(/\u0000/g, '').replace(/\ufeff/g, '') : '');
    const bomText = readTable(found.bom);
    const cplText = readTable(found.cpl);
    const refs = (value) => [...new Set((value.match(/\b(?:U|R|C|D|J)\d+\b/g) || []))];
    const bomRefs = refs(bomText);
    const cplRefs = refs(cplText);
    const stepHead = found.step ? readFileSync(join(OUT_DIR, found.step), 'utf8').slice(0, 40) : '';
    const stepOk = /ISO-10303-21/.test(stepHead);
    const draftFree = !names.some((name) => /DRAFT|NOT-FOR-ORDER/i.test(name));
    checks.push({ kind: 'bom-designators', count: bomRefs.length, ok: bomRefs.length >= 8 });
    checks.push({ kind: 'cpl-designators', count: cplRefs.length, ok: cplRefs.length >= 8 });
    checks.push({ kind: 'step-header', head: stepHead.slice(0, 20), ok: stepOk });
    checks.push({ kind: 'no-draft-name', ok: draftFree });
    // 板上真实位号（从铜几何读到的 12 个元件的 BOM 集合）与产物对齐
    const boardRefs = ['U1','U2','U3','U4','U5','U6','D1','J1','R1','R2','R3','R4'];
    const uncovered = boardRefs.filter((ref) => !bomRefs.includes(ref));
    checks.push({ kind: 'board-refs-covered', uncovered, ok: uncovered.length === 0 });
    const failed = missing.length ? missing : checks.filter((item) => item.ok === false).map((item) => item.kind);
    return { status: failed.length ? 'fail' : 'pass', data: { files: checks.filter((c) => c.bytes), uncoveredBoardRefs: uncovered, failedChecks: failed } };
  });

  // ── 10. 板子基线（末读）：证明全程没动板 ─────────────────────────────
  await step('unchanged', '板现状不变：末读铜几何与首读逐项比对', async () => {
    const final = await copperCounts();
    const same = JSON.stringify(final) === JSON.stringify(initial);
    return { status: same ? 'pass' : 'fail', data: { before: initial, after: final, identical: same } };
  });

  // ── 报告 ────────────────────────────────────────────────────────────
  const glbStep = steps.find((item) => item.id === '3d-glb');
  const summary = {
    generatedAt: new Date().toISOString(),
    runtimeUrl: BASE,
    boardReadOnly: true,
    steps: steps.map(({ id, title, status, ms, evidence, error, note, details }) => ({ id, title, status, ms, evidence, error, note, details })),
    counts: {
      pass: steps.filter((s) => s.status === 'pass').length,
      warn: steps.filter((s) => s.status === 'warn').length,
      fail: steps.filter((s) => s.status === 'fail').length,
    },
  };
  const reportPath = join(ROOT, 'docs/implementation', `e2e-live-${new Date().toISOString().slice(0, 10)}.md`);
  const md = [
    `# 真机全链路运行报告（板子只读）`,
    ``,
    `- 生成时间：${summary.generatedAt}`,
    `- 运行时：${BASE}｜板子：${PCB_UUID}｜原理图页：${SCHEMATIC_UUID || '(未绑定)'}`,
    `- 结论：**通过 ${summary.counts.pass} / 警告 ${summary.counts.warn} / 失败 ${summary.counts.fail}**`,
    `- 约束：全程未调用任何写板路由；首末两次铜几何比对见最后一步。`,
    ``,
    `| 步骤 | 结果 | 耗时 | 关键读数 |`,
    `| --- | --- | --- | --- |`,
    ...steps.map((item) => `| ${item.title} | ${({ pass: '✅', warn: '⚠️', fail: '❌', skipped: '⏭️' })[item.status] || item.status} | ${(item.ms / 1000).toFixed(1)}s | ${item.error ? item.error : JSON.stringify(item.evidence).slice(0, 220).replace(/\|/g, '\\|')} |`),
    ``,
    `## 逐步原始读数`,
    ``,
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    glbStep ? '' : '',
  ].join('\n');
  writeFileSync(reportPath, md, 'utf8');
  writeFileSync(join(tmpdir(), 'cp-e2e-live-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n通过 ${summary.counts.pass} / 警告 ${summary.counts.warn} / 失败 ${summary.counts.fail}`);
  console.log(`报告：${reportPath}`);
  if (summary.counts.fail > 0) process.exitCode = 2;
}

let lastDrcReportPath = null;
await main();
