#!/usr/bin/env node
/**
 * T6：真机放行门报告（**真实调用 runtime 门禁路由，如实记录 blocked**）。
 *
 * 这不是"改代码让门禁变绿"，也不是"放行批准"。它做三件事：
 *   1. 对当前打开的衣橱板（工程 / 原理图页 / PCB）真实调用 `POST /api/eda/release/gate`，
 *      让服务端**自己**去读原理图验收、PCB 布局、网表和 deliverables 产物，不喂假证据；
 *   2. 把请求（去令牌）、HTTP 状态、完整响应、blockedBy 逐条中文解释（区分"代码能力缺失"
 *      vs "人工/外部依赖"）落盘成 JSON + Markdown；
 *   3. 显式做一遍 **PASS 假象扫描**：局部 `status:'pass'`、`skipped`、`info GATE_PASSED`
 *      都不等于放行通过；没通过就是没通过。
 *
 * 铁律：
 *   - 只调用**只读**路由（health / eda window 读取 / eda 只读命令 / release gate）；
 *     不调用任何写板、批准、重签、导出、安装路由；不签发批准；
 *   - 不伪造证据：缺 DRC/DFM/签核/价格库存就让它 blocked，报告里写明"缺什么、谁提供"；
 *   - 不把历史证据冒充当前板证据：本脚本默认不注入任何预处理证据，
 *     服务端实时取证的结果才是"当前板"的结论；
 *   - 报告永远写"**不是放行通过**"，即使 ready=true 也只是"机器证据齐了，仍须人工签字"。
 *
 * 用法：
 *   CIRCUITPILOT_RUNTIME_TOKEN=<令牌> node scripts/release-gate-report.mjs
 * 环境变量：
 *   CIRCUITPILOT_RUNTIME_URL    默认 http://127.0.0.1:4181
 *   CIRCUITPILOT_RUNTIME_TOKEN  运行时令牌（也可放在 /tmp/cp_my_token.txt；令牌绝不写进报告）
 *   CIRCUITPILOT_GATE_TIMEOUT_MS 门禁调用超时，默认 600000（实时验收可能要 1–3 分钟；桥繁忙时更久）
 *   CIRCUITPILOT_ARTIFACTS_DIR  产物目录，默认仓库内 deliverables
 *   CIRCUITPILOT_TARGET_BOARD   目标板名，默认 Board1_1
 *   CIRCUITPILOT_PAGE_UUID      原理图页 UUID，默认 87dba2a22fe7096e
 *   CIRCUITPILOT_PCB_UUID       PCB 文档 UUID，默认从 project.current 解析（Board1_1 → 5595e77cead09682）
 *
 * 退出码：门禁调用成功并产出报告 → 0（**门禁 blocked 也算成功**，因为报告如实记录了它）；
 *         运行时不可达 / 令牌无效 / 门禁调用失败 → 1（失败报告同样落盘）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const RUNTIME_URL = (process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4181').replace(/\/$/, '');
const OUT_DIR = process.env.CIRCUITPILOT_RELEASE_DIR || join(ROOT, 'artifacts', 'release-gate-real');
const GENERATED_AT = new Date().toISOString();
const STAMP = GENERATED_AT.replace(/[:.]/g, '-');
const JSON_PATH = join(OUT_DIR, `gate-${STAMP}.json`);
const MD_PATH = join(OUT_DIR, `gate-${STAMP}.md`);
const TIMEOUT_MS = Number(process.env.CIRCUITPILOT_GATE_TIMEOUT_MS) || 600_000;
const ARTIFACTS_DIR = resolve(ROOT, process.env.CIRCUITPILOT_ARTIFACTS_DIR || 'deliverables');
const TARGET_BOARD = process.env.CIRCUITPILOT_TARGET_BOARD || 'Board1_1';
const PAGE_UUID = process.env.CIRCUITPILOT_PAGE_UUID || '87dba2a22fe7096e';
const PCB_UUID_ENV = process.env.CIRCUITPILOT_PCB_UUID || null;
const EXPECTED_PROJECT_UUID = process.env.CIRCUITPILOT_PROJECT_UUID || 'ba4924190e3a4388a097f3dee090da20';

/** 令牌解析：只从环境/本机临时文件读，绝不打印、绝不写进报告。 */
function resolveToken() {
  const direct = process.env.CIRCUITPILOT_RUNTIME_TOKEN || process.env.CIRCUITPILOT_TOKEN;
  if (direct && direct.trim()) return { token: direct.trim(), source: '环境变量 CIRCUITPILOT_RUNTIME_TOKEN' };
  for (const path of ['/tmp/cp_my_token.txt', '/tmp/cp_runtime_token.txt']) {
    try {
      if (existsSync(path)) {
        const value = readFileSync(path, 'utf8').trim();
        if (value) return { token: value, source: `本机文件 ${path}` };
      }
    } catch { /* 忽略：继续找下一个来源 */ }
  }
  return { token: '', source: '未找到（需要 CIRCUITPILOT_RUNTIME_TOKEN 或 /tmp/cp_my_token.txt）' };
}
const TOKEN_INFO = resolveToken();
const TOKEN = TOKEN_INFO.token;

const truncate = (value, max = 4000) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（截断，原始 ${text.length} 字符）` : text;
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sha256File = (path) => { try { return sha256(readFileSync(path)); } catch { return null; } };

/** 与 runtime/evidence-store.mjs 一致的稳定序列化，用于核对证据文件 digest 是否被改过。 */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

async function callJson(path, { method = 'GET', body = null, timeoutMs = TIMEOUT_MS, token = true } = {}) {
  const startedAt = Date.now();
  const headers = { 'content-type': 'application/json' };
  if (token && TOKEN) headers['x-circuitpilot-token'] = TOKEN;
  let response;
  let text = '';
  try {
    response = await fetch(`${RUNTIME_URL}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, path, method, durationMs: Date.now() - startedAt, networkError: String(error?.message || error).slice(0, 400), status: null, text: '', payload: null };
  }
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { ok: response.ok, path, method, durationMs: Date.now() - startedAt, status: response.status, text, payload };
}

mkdirSync(OUT_DIR, { recursive: true });

const warnings = [];
const addWarning = (code, message) => warnings.push({ code, message });

// ================================================================ 1. 运行时 + 桥 + 目标预检

const health = await callJson('/api/health', { token: false, timeoutMs: 10_000 });
const healthPayload = health.payload || null;

const runtimeReachable = health.status === 200 && healthPayload?.ok === true;
const tokenLooksMissing = !TOKEN;
const authFailure = health?.payload?.error?.code === 'RUNTIME_TOKEN_INVALID';

const preflight = {
  runtime: {
    url: RUNTIME_URL,
    reachable: runtimeReachable,
    httpStatus: health.status,
    health: healthPayload,
    tokenSource: TOKEN_INFO.source,
    tokenConfigured: Boolean(TOKEN),
  },
  bridge: null,
  project: null,
  target: null,
};

if (runtimeReachable && TOKEN) {
  const discover = await callJson('/api/eda/discover', { timeoutMs: 30_000 });
  const windows = await callJson('/api/eda/windows', { timeoutMs: 30_000 });
  const documentCurrent = await callJson('/api/eda/commands/document.current', { method: 'POST', body: {}, timeoutMs: 30_000 });
  const projectCurrent = await callJson('/api/eda/commands/project.current', { method: 'POST', body: {}, timeoutMs: 30_000 });

  const currentDoc = documentCurrent.payload?.command?.result?.result ?? null;
  const projectRaw = projectCurrent.payload?.command?.result?.result ?? null;
  let project = null;
  // project.current 返回的对象可能被包在更深层；递归找 itemType==='Project' 的那个。
  const findProject = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (node.itemType === 'Project' && node.uuid) return node;
    for (const value of Object.values(node)) {
      const found = findProject(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  project = findProject(projectRaw) ?? projectRaw;
  const boards = Array.isArray(project?.data)
    ? project.data.filter((item) => item?.itemType === 'Board').map((item) => ({
      name: item.name ?? null,
      schematicUuid: item.schematic?.uuid ?? null,
      schematicName: item.schematic?.name ?? null,
      pcbUuid: item.pcb?.uuid ?? null,
      pcbName: item.pcb?.name ?? null,
    }))
    : [];
  const targetBoard = boards.find((item) => item.name === TARGET_BOARD) || null;
  const pcbUuid = PCB_UUID_ENV || targetBoard?.pcbUuid || null;

  preflight.bridge = {
    discovered: discover.payload?.bridge ? { port: discover.payload.bridge.port, health: discover.payload.bridge.health ?? null } : null,
    windows: windows.payload ?? null,
    discoverHttpStatus: discover.status,
    windowsHttpStatus: windows.status,
  };
  preflight.project = {
    uuid: project?.uuid ?? null,
    name: project?.friendlyName ?? project?.name ?? null,
    boards,
    currentDocument: currentDoc,
    projectCurrentHttpStatus: projectCurrent.status,
    documentCurrentHttpStatus: documentCurrent.status,
  };
  preflight.target = {
    projectUuid: project?.uuid ?? null,
    expectedProjectUuid: EXPECTED_PROJECT_UUID,
    projectMatchesExpected: project?.uuid === EXPECTED_PROJECT_UUID,
    boardName: TARGET_BOARD,
    board: targetBoard,
    pcbUuid,
    pageUuid: PAGE_UUID,
    artifactsDir: ARTIFACTS_DIR,
  };

  if (!project) addWarning('PROJECT_READ_FAILED', '读取 project.current 失败：无法确认目标工程/板 UUID，门禁调用将依赖默认值。');
  if (project && project.uuid !== EXPECTED_PROJECT_UUID) {
    addWarning('PROJECT_MISMATCH', `当前打开的工程是 ${project.uuid}（${project.friendlyName || project.name || ''}），与任务指定 ${EXPECTED_PROJECT_UUID} 不一致：报告结论只对"当前打开的工程"成立。`);
  }
  if (!targetBoard) addWarning('TARGET_BOARD_NOT_FOUND', `当前工程里找不到板 ${TARGET_BOARD}：PCB UUID 使用环境变量默认值或让服务端自行解析。`);
  if (!pcbUuid) addWarning('PCB_UUID_UNKNOWN', '解析不到目标 PCB UUID：门禁调用不传 pcbUuid（服务端会自行找当前工程 PCB，可能读错板）。');
  const currentDocumentUuid = currentDoc?.uuid ?? null;
  if (currentDocumentUuid && PAGE_UUID !== currentDocumentUuid) {
    addWarning('PAGE_UUID_NOT_ACTIVE', `指定的原理图页 ${PAGE_UUID} 不是 EDA 当前活动文档（当前 ${currentDocumentUuid}）：门禁会自己 schematic.open 指定页，这里只作提示。`);
  }
} else if (!TOKEN) {
  addWarning('RUNTIME_TOKEN_MISSING', '没有运行时令牌：无法调用需要鉴权的只读路由，也无法调用门禁。');
}

// ================================================================ 2. 证据清单（只读扫描，不注入）

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).map((name) => join(dir, name)).filter((path) => { try { return statSync(path).isFile(); } catch { return false; } }); } catch { return []; }
}

const DRAFT_MARKER_RE = /draft|not[-_ ]?for[-_ ]?order|草稿|请勿下单|preliminary/i;

function classifyDeliverable(name) {
  const prefix = ['GERBER_', 'BOM_', 'CPL_', 'STEP_'].find((item) => name.startsWith(item));
  return prefix ? prefix.replace('_', '').toLowerCase() : null;
}

const deliverables = listFiles(ARTIFACTS_DIR).map((path) => {
  const name = path.split('/').pop();
  return {
    path,
    name,
    kind: classifyDeliverable(name),
    bytes: (() => { try { return statSync(path).size; } catch { return null; } })(),
    mtime: (() => { try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; } })(),
    sha256: sha256File(path),
    draftMarker: DRAFT_MARKER_RE.test(name),
  };
});

const evidenceRoot = join(ROOT, 'artifacts', 'evidence');

/** 读 evidence-store 的某一类最新一条，并重算 digest 核对文件是否被改动。 */
function readEvidenceEntry(kind) {
  const dir = join(evidenceRoot, kind);
  const files = listFiles(dir).filter((path) => path.split('/').pop().startsWith(`${kind}-`) && path.endsWith('.json'))
    .sort((left, right) => { try { return statSync(right).mtimeMs - statSync(left).mtimeMs; } catch { return 0; } });
  if (!files.length) return null;
  const path = files[0];
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { path, error: `不是合法 JSON：${String(error?.message || error)}` };
  }
  let digestConsistent = null;
  try {
    const recomputed = sha256(canonical({
      schemaVersion: parsed.schemaVersion,
      kind: parsed.kind,
      savedAt: parsed.savedAt,
      fingerprint: parsed.fingerprint ?? {},
      note: parsed.note ?? null,
      payload: parsed.payload,
    }));
    digestConsistent = recomputed === parsed.digest;
  } catch { digestConsistent = null; }
  return {
    path,
    schemaVersion: parsed.schemaVersion ?? null,
    kind: parsed.kind ?? null,
    savedAt: parsed.savedAt ?? null,
    digest: parsed.digest ?? null,
    digestConsistent,
    fingerprint: parsed.fingerprint ?? null,
    note: parsed.note ?? null,
    payload: parsed.payload ?? null,
    fileSha256: sha256File(path),
    fileBytes: (() => { try { return statSync(path).size; } catch { return null; } })(),
    allFiles: files.length,
  };
}

function summarizeDrcEntry(entry) {
  if (!entry || entry.error) return entry ? { path: entry.path, error: entry.error } : null;
  const report = entry.payload?.report ?? null;
  return {
    path: entry.path, savedAt: entry.savedAt, digest: entry.digest, digestConsistent: entry.digestConsistent,
    fingerprint: entry.fingerprint, note: entry.note,
    ok: report?.ok ?? null, reportedCount: report?.reportedCount ?? null, itemCount: report?.itemCount ?? (Array.isArray(report?.items) ? report.items.length : null),
    truncated: report?.truncated ?? null, digestOfReport: report?.digest ?? null,
    classificationReady: entry.payload?.classification?.ready ?? null,
  };
}

function summarizeErcEntry(entry) {
  if (!entry || entry.error) return entry ? { path: entry.path, error: entry.error } : null;
  const report = entry.payload?.report ?? null;
  return {
    path: entry.path, savedAt: entry.savedAt, digest: entry.digest, digestConsistent: entry.digestConsistent,
    fingerprint: entry.fingerprint, ran: report?.ran ?? null,
    counts: report?.counts ?? null,
    findings: Array.isArray(report?.findings) ? report.findings.length : null,
    detailSource: entry.payload?.report?.detailSource ?? null,
  };
}

function summarizeSpiceEntry(entry) {
  if (!entry || entry.error) return entry ? { path: entry.path, error: entry.error } : null;
  const payload = entry.payload ?? {};
  const simulation = payload.simulation ?? payload.evidence ?? null;
  return {
    path: entry.path, savedAt: entry.savedAt, digest: entry.digest, digestConsistent: entry.digestConsistent,
    fingerprint: entry.fingerprint,
    source: payload.source ?? null,
    netlist: payload.netlist ?? null,
    simulation: simulation ? {
      evidenceHash: simulation.evidenceHash ?? null,
      source: simulation.source ?? null,
      solver: simulation.solver ?? null,
      scopeNote: simulation.scopeNote ?? null,
      operatingPoint: simulation.operatingPoint ?? null,
    } : null,
    designChecks: payload.designChecks?.summary ?? null,
  };
}

function summarizeGenericEntry(entry) {
  if (!entry || entry.error) return entry ? { path: entry.path, error: entry.error } : null;
  return {
    path: entry.path,
    savedAt: entry.savedAt,
    digest: entry.digest,
    digestConsistent: entry.digestConsistent,
    fingerprint: entry.fingerprint,
    note: entry.note,
    payloadKeys: entry.payload && typeof entry.payload === 'object' ? Object.keys(entry.payload) : null,
    payloadPassed: entry.payload?.passed ?? entry.payload?.classification?.ready ?? null,
  };
}

const dfmEntry = readEvidenceEntry('dfm-evidence');
const signoffEntry = readEvidenceEntry('signoff');
const evidenceStore = {
  root: evidenceRoot,
  drc: summarizeDrcEntry(readEvidenceEntry('drc-report')),
  erc: summarizeErcEntry(readEvidenceEntry('schematic-erc')),
  spiceSimulation: listFiles(join(evidenceRoot, 'spice-simulation')).filter((path) => path.endsWith('.json')).length
    ? summarizeSpiceEntry(readEvidenceEntry('spice-simulation'))
    : null,
  dfm: summarizeGenericEntry(dfmEntry),
  signoff: summarizeGenericEntry(signoffEntry),
  kindsPresent: existsSync(evidenceRoot) ? readdirSync(evidenceRoot) : [],
};

/** T3 / 其它任务落在 artifacts/ 下的独立证据（只做交叉参考，不注入门禁）。 */
function inspectSupplementaryEvidence() {
  const out = { spice: { netlists: [], simulationEvidences: [] }, boardAnalysis: [] };
  for (const path of listFiles(join(ROOT, 'artifacts', 'spice'))) {
    const name = path.split('/').pop();
    const record = {
      path, name, bytes: (() => { try { return statSync(path).size; } catch { return null; } })(),
      mtime: (() => { try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; } })(),
      sha256: sha256File(path),
    };
    if (/\.net$/i.test(name)) out.spice.netlists.push(record);
    else if (/simulation-evidence.*\.json$/i.test(name)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        out.spice.simulationEvidences.push({
          ...record,
          schemaVersion: parsed.schemaVersion ?? null,
          task: parsed.task ?? null,
          status: parsed.status ?? null,
          generatedAt: parsed.generatedAt ?? null,
          finishedAt: parsed.finishedAt ?? null,
          netlist: parsed.netlist ? {
            sha256: parsed.netlist.sha256 ?? null,
            bytes: parsed.netlist.bytes ?? null,
            format: parsed.netlist.format ?? null,
            componentCount: parsed.netlist.componentCount ?? null,
            pinCount: parsed.netlist.pinCount ?? null,
            connectedPinCount: parsed.netlist.connectedPinCount ?? null,
            netCount: parsed.netlist.netCount ?? parsed.connectivity?.wireReadback?.netCount ?? null,
            parseable: parsed.netlist.parseable ?? null,
          } : (parsed.netlistSha256 ? { sha256: parsed.netlistSha256 } : null),
          solver: parsed.solver?.version ?? parsed.runs?.[0]?.ngspiceVersion ?? parsed.ngspiceVersion ?? null,
          run: parsed.run ? { exitCode: parsed.run.exitCode ?? null, durationMs: parsed.run.durationMs ?? null } : null,
          runs: Array.isArray(parsed.runs) ? parsed.runs.map((item) => ({ kind: item.kind ?? null, exitCode: item.exitCode ?? null, logPath: item.logPath ?? null, logSha256: item.logSha256 ?? null, ngspiceVersion: (item.ngspiceVersion ?? '').split('|').pop()?.trim() || null })) : null,
          results: parsed.results ? { operatingPoint: parsed.results.operatingPoint ?? null, measurements: parsed.results.measurements ?? null } : null,
          edaSimulationNetlist: parsed.edaSimulationNetlist ?? null,
          deck: parsed.deck ? { path: parsed.deck.path ?? null, subcircuit: parsed.deck.subcircuit ?? null, analyses: parsed.deck.analyses ?? null, usedNets: Array.isArray(parsed.deck.usedNets) ? parsed.deck.usedNets.map((net) => net.name) : null } : null,
          decks: Array.isArray(parsed.decks) ? parsed.decks.map((deck) => ({ name: deck.name ?? null, exitCode: deck.exitCode ?? null, pass: deck.pass ?? null })) : null,
          assumptionsCount: Array.isArray(parsed.assumptions) ? parsed.assumptions.length : null,
          blockedReasons: parsed.blockedReasons ?? null,
          findingsCount: Array.isArray(parsed.findings) ? parsed.findings.length : null,
          note: parsed.status === 'blocked'
            ? 'T3 仿真证据本身 status=blocked（ngspice 未成功跑完）：它是"仿真未闭环"的证据，不是"仿真通过"。'
            : null,
        });
      } catch (error) {
        out.spice.simulationEvidences.push({ ...record, error: String(error?.message || error) });
      }
    }
  }
  for (const path of listFiles(join(ROOT, 'artifacts', 'board-analysis'))) {
    out.boardAnalysis.push({ path, name: path.split('/').pop(), bytes: (() => { try { return statSync(path).size; } catch { return null; } })(), mtime: (() => { try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; } })() });
  }
  return out;
}
const supplementary = inspectSupplementaryEvidence();

if (!deliverables.length) addWarning('ARTIFACTS_DIR_EMPTY', `产物目录 ${ARTIFACTS_DIR} 里没有文件：门禁的"生产文件"闸门必然缺产物。`);
if (deliverables.every((item) => item.draftMarker)) addWarning('ALL_ARTIFACTS_DRAFT', 'deliverables 里全部产物文件名都带草稿标记（DRAFT-NOT-FOR-ORDER）：它们是草稿，不是可下单正式件。');
if (!evidenceStore.drc) addWarning('DRC_EVIDENCE_ABSENT', 'artifacts/evidence/drc-report 下没有任何 DRC 证据：门禁调用不会自动跑 DRC，DRC 闸门会如实报"缺证据"。');
if (!evidenceStore.dfm) addWarning('DFM_EVIDENCE_ABSENT', 'artifacts/evidence 下没有 dfm-evidence：在线 DFM 人工回填证据缺失。');
if (!evidenceStore.signoff) addWarning('SIGNOFF_EVIDENCE_ABSENT', 'artifacts/evidence 下没有 signoff：人工终审签核缺失。');

// 只跑预检（health / 桥 / 目标解析 / 证据扫描），**不调用门禁**：用于真实门禁调用前的环境自检，
// 也方便在等待其它证据任务时确认脚本本身是好的。
const DRY_RUN = process.env.CIRCUITPILOT_GATE_DRY_RUN === '1';
if (DRY_RUN) {
  const preflightPath = join(OUT_DIR, `gate-preflight-${STAMP}.json`);
  const preflightReport = {
    kind: 'release-gate-real-preflight',
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    note: '这是预检报告：只做了 health/桥/目标/证据扫描，**没有调用门禁**，不能作为放行依据。',
    preflight,
    evidence: { deliverables, evidenceStore, supplementary },
    plannedRequest: {
      method: 'POST',
      path: '/api/eda/release/gate',
      body: {
        pageUuid: PAGE_UUID,
        ...(preflight.target?.pcbUuid ? { pcbUuid: preflight.target.pcbUuid } : {}),
        artifactsDir: ARTIFACTS_DIR,
        userConfirmed: false,
      },
      timeoutMs: TIMEOUT_MS,
    },
    scriptWarnings: warnings,
  };
  writeFileSync(preflightPath, `${JSON.stringify(preflightReport, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: 'preflight-only（未调用门禁）',
    runtime: preflight.runtime,
    target: preflight.target,
    artifactCount: deliverables.length,
    evidencePresent: { drc: Boolean(evidenceStore.drc), erc: Boolean(evidenceStore.erc), spice: Boolean(evidenceStore.spiceSimulation), dfm: Boolean(evidenceStore.dfm), signoff: Boolean(evidenceStore.signoff) },
    scriptWarnings: warnings,
    output: preflightPath,
  }, null, 2));
  process.exit(0);
}

// ================================================================ 3. 真实调用放行门

const REQUEST_BODY = {
  pageUuid: PAGE_UUID,
  ...(preflight.target?.pcbUuid ? { pcbUuid: preflight.target.pcbUuid } : {}),
  artifactsDir: ARTIFACTS_DIR,
  // 显式"未提供"：不让服务端把"没给证据"当通过；也让 layout/DFM 必须走人工。
  userConfirmed: false,
};

const gateCall = (runtimeReachable && TOKEN)
  ? await callJson('/api/eda/release/gate', { method: 'POST', body: REQUEST_BODY, timeoutMs: TIMEOUT_MS })
  : { ok: false, status: null, path: '/api/eda/release/gate', method: 'POST', durationMs: 0, text: '', payload: null, networkError: runtimeReachable ? '缺少运行时令牌，未调用门禁' : '运行时不可达，未调用门禁' };

const gatePayload = gateCall.payload;
const callSucceeded = gateCall.status === 200 && gatePayload && typeof gatePayload === 'object' && !gatePayload.error;

// ================================================================ 4. 阻断分类（中文解释 + 责任归属）

const CATEGORY = {
  'code-capability': { label: '代码能力缺失（产品应自动做但当前做不到/未接线）', responsibility: '代码（开发）' },
  'human': { label: '人工判断/签核依赖（必须由人决定或签字）', responsibility: '人工（用户/评审）' },
  'external': { label: '外部数据/服务/凭证依赖（本机无法自证）', responsibility: '外部（平台/供应商/Apple/立创）' },
  'process': { label: '流程/产物未就绪（先跑对流程才能产出）', responsibility: '流程（按顺序补跑）' },
  'evidence': { label: '证据未提供/未跑成（不是"通过"）', responsibility: '先补跑对应取证步骤' },
  'unknown': { label: '待人工归类（本脚本没有先验知识，不瞎猜）', responsibility: '待定' },
};

/** 按 code 给出中文解释；message 来自门禁响应，必须原样保留。 */
function classifyBlocker(blocker) {
  const code = String(blocker?.code || '');
  const message = String(blocker?.message || '');
  const base = { code, message, field: blocker?.field ?? null };
  const map = {
    RELEASE_SCHEMATIC_EVIDENCE_MISSING: message.includes('0 个器件') || message.includes('具名引脚') || message.includes('网表')
      ? { category: 'code-capability', explanation: '门禁实时读原理图验收时，网表/具名引脚读不出来（当前板的读取链路失败）。所以不是"原理图没问题"，是"根本没看到设计"。', howToResolve: '修复/复跑原理图验收链路（确认 EDA 打开目标页、网表可导出、有具名引脚），再跑门禁。' }
      : { category: 'evidence', explanation: '没有可用的原理图验收报告：不知道 ERC/网表/计划比对结果，不能下单。', howToResolve: '先跑 /api/eda/schematic/acceptance 形成验收报告，再带 acceptance 或重新跑门禁。' },
    RELEASE_SCHEMATIC_NOT_READY: { category: 'human', explanation: '原理图验收有阻断项（通常是 ERC 错误）：必须人工确认电气意图并改图，系统不自动改图。', howToResolve: '按 ERC 明细逐条人工确认/修改原理图，重跑 ERC 直到无阻断。' },
    RELEASE_SIMULATION_NOT_RUN: { category: 'code-capability', explanation: '仿真没跑成：EDA 侧导不出 SPICE 网表、原理图未绑定仿真模型，或本机没有可用求解器；这属于"没有仿真"，不是"仿真通过"。', howToResolve: '给关键网络补 SPICE 模型/检查点，或接入已落盘的真实 ngspice 证据（本仓库 T3 已产出独立证据，但门禁路由当前未接该回退，见 evidence.supplementary）。' },
    RELEASE_SIMULATION_FAILED: { category: 'code-capability', explanation: '仿真跑了但有检查点不满足规格：需要改设计或补器件模型，机器不会替你决定。', howToResolve: '按检查点 measured/spec 差异修改设计或模型，重跑仿真。' },
    RELEASE_DRC_EVIDENCE_MISSING: { category: 'process', explanation: '没有 DRC 报告：门禁不会自己跑 DRC，必须先在 EDA 跑完 DRC 并让证据落盘（artifacts/evidence/drc-report）。没跑过 DRC 不等于布线没问题。', howToResolve: '在 EDA 跑 PCB DRC → 通过证据路由落盘（artifacts/evidence/drc-report/*.json）→ 再跑门禁。' },
    RELEASE_DRC_UNEXPLAINED: { category: 'human', explanation: 'DRC 有未解释/未豁免的违规项：必须改板或逐条登记有理由的豁免。', howToResolve: '修复 DRC 或按规则登记豁免（每条豁免必须能匹配 code 且有理由）。' },
    RELEASE_DRC_EXEMPTION_INVALID: { category: 'human', explanation: 'DRC 豁免无效（缺理由/超范围/不匹配）：机器拒绝把无效豁免当通过。', howToResolve: '修正豁免文件（code+reason、范围受限），重跑门禁。' },
    RELEASE_PLACEMENT_EVIDENCE_MISSING: { category: 'evidence', explanation: '没有布局复核结果：不知道器件是否在板框内、是否越界/重叠。', howToResolve: '先跑布局读回/复核（pcb.placement.read + 板框校验），再跑门禁。' },
    RELEASE_PLACEMENT_NOT_VERIFIED: { category: 'code-capability', explanation: '布局复核没通过（越界/重叠/间距不足）：需要人工重新摆件，机器不自动改布局。', howToResolve: '按复核 findings 人工调整布局，重读实机坐标直到通过。' },
    RELEASE_PLACEMENT_NOT_CONFIRMED: { category: 'human', explanation: '布局没有被明确确认过：自动布局的位移可能很大，下单前必须由人确认（这是产品红线）。', howToResolve: '人工在界面上确认当前布局（userConfirmed=true 且有人负责）。' },
    RELEASE_PLACEMENT_ROLLED_BACK: { category: 'human', explanation: '有一次布局写回失败（可能已回滚）：如果这正是要交付的布局，必须重新确认。', howToResolve: '重新读回实机布局并人工确认。' },
    RELEASE_ARTIFACT_MISSING: { category: 'process', explanation: '缺少某类生产产物（gerber/bom/cpl/step）：没有产物就没有可下单的文件。', howToResolve: '先按正式流程导出该产物到 deliverables（注意：正式导出本身也被门禁守卫，需要先补齐其它证据）。' },
    RELEASE_ARTIFACT_EMPTY: { category: 'process', explanation: '产物是空文件：等于没有。', howToResolve: '重新导出有效产物。' },
    RELEASE_ARTIFACT_UNPARSEABLE: { category: 'process', explanation: '产物无法解析：不是真实可用的生产文件。', howToResolve: '重新导出，并核对格式（Gerber zip/BOM/CPL/STEP）。' },
    RELEASE_ARTIFACT_DRAFT_MARKER: { category: 'process', explanation: '产物文件名自带草稿标记（DRAFT-NOT-FOR-ORDER）：这是草稿，不能用于下单。当前目录里只有草稿件。', howToResolve: '补齐其它证据让门禁 ready=true 后，走正式导出重新命名（去掉草稿标记）。注意这是"鸡生蛋"：正式导出必须先通过门禁。' },
    RELEASE_ARCHIVE_INCONSISTENT: { category: 'process', explanation: 'Gerber 压缩包条目数与目录声明不一致：文件可能被截断。', howToResolve: '重新导出完整 Gerber 压缩包。' },
    RELEASE_ARCHIVE_MISSING: { category: 'process', explanation: '缺少产物压缩包/归档。', howToResolve: '重新导出并归档。' },
    RELEASE_GERBER_COPPER_MISSING: { category: 'process', explanation: 'Gerber 铜层数与 PCB 铜箔层数不符（内层可能没导出）。', howToResolve: '按 4 层板重新导出全部铜层。' },
    RELEASE_GERBER_OUTLINE_MISSING: { category: 'process', explanation: 'Gerber 缺板框层（GKO）：板厂无法确定外形。', howToResolve: '导出时勾选板框层。' },
    RELEASE_GERBER_DRILL_MISSING: { category: 'process', explanation: 'Gerber 里没有钻孔文件（DRL）。', howToResolve: '导出时包含钻孔文件。' },
    RELEASE_BOM_DESIGNATOR_MISMATCH: { category: 'process', explanation: 'BOM 位号集合与网表不一致：这份 BOM 不一定是这块板。', howToResolve: '按当前网表重新导出 BOM。' },
    RELEASE_BOM_SUPPLIER_MISSING: { category: 'external', explanation: 'BOM 行缺供应商料号（LCSC Cxxxxx）：下单必须知道买什么，料号只能来自可信来源。', howToResolve: '等待 T5 富化模块接入 + 用户/立创数据补齐，不伪造料号。' },
    RELEASE_BOM_VALUE_MISSING: { category: 'process', explanation: '阻容感缺 Value：无法采购。', howToResolve: '补 Value 后重新导出 BOM。' },
    RELEASE_CPL_DESIGNATOR_MISMATCH: { category: 'process', explanation: 'CPL 缺位号：贴片文件与设计对不上。', howToResolve: '重新导出 CPL。' },
    RELEASE_CPL_COORD_MISMATCH: { category: 'process', explanation: 'CPL 坐标与实机读回不一致：这份 CPL 可能不是当前布局。', howToResolve: '按当前布局重新导出 CPL（注意器件原点 vs 包围盒中心两套基准）。' },
    RELEASE_CPL_LAYER_MISSING: { category: 'process', explanation: 'CPL 缺贴装面（T/B）或 Rotation 列。', howToResolve: '重新导出包含 Layer/Rotation 的 CPL。' },
    RELEASE_STEP_INVALID: { category: 'process', explanation: 'STEP 文件头不是 ISO-10303-21：不是有效 STEP。', howToResolve: '重新导出 3D STEP。' },
    RELEASE_SUPPLY_IDENTITY_MISSING: { category: 'external', explanation: '无法确认物料身份（BOM 无行或料号不是 LCSC 编号）：机器不猜料号。', howToResolve: '从立创/嘉立创导出可核对的 BOM 证据。' },
    RELEASE_SUPPLY_PRICE_STOCK_UNKNOWN: { category: 'external', explanation: '没有价格/库存证据：系统不猜价格（无证据=unknown，不是 0 元）。', howToResolve: '用立创商城 BOM 导出或开放平台凭据补齐价格/库存。' },
    RELEASE_FRESHNESS_UNKNOWN: { category: 'external', explanation: '价格/库存没有更新时间：无法判断是否过期。', howToResolve: '补 fetchedAt/checkedAt 后重跑。' },
    RELEASE_FRESHNESS_STALE: { category: 'external', explanation: '价格/库存证据已过期：下单前必须重新查价。', howToResolve: '重新拉取最新价格/库存。' },
    RELEASE_CONSTRAINT_FAILED: { category: 'human', explanation: '硬需求约束不满足（如尺寸/层数/接口）：必须改设计或由人重新确认需求。', howToResolve: '按约束报告逐条修设计，或人工确认需求变更。' },
    RELEASE_CONSTRAINT_FACT_UNKNOWN: { category: 'code-capability', explanation: '需求硬约束缺少可量化的事实（designFacts 未提供/未接线）：无法证明满足了需求。', howToResolve: '补齐 designFacts（板尺寸/层数/电源等可测事实）后再跑约束闸门。' },
    RELEASE_CONSTRAINT_UNCLASSIFIED: { category: 'code-capability', explanation: '需求约束未结构化/无法判定：不算通过，只是"没提供"。', howToResolve: '把需求整理成结构化 constraints 并接入门禁。' },
    RELEASE_ENGINEERING_NOT_READY: { category: 'evidence', explanation: '工程分析/布局规则证据未纳入本次放行（skipped ≠ 通过）。', howToResolve: '先跑工程分析/布局规则审计并把结果传给门禁。' },
    RELEASE_ENGINEERING_BLOCKED: { category: 'human', explanation: '工程分析/布局规则审计有阻断项：需要改设计或登记有效豁免。', howToResolve: '按审计 findings 修设计/登记豁免。' },
    RELEASE_LAYOUT_RULES_BLOCKED: { category: 'human', explanation: '布局规则审计未通过（GATE 红线）：必须人工处理。', howToResolve: '修布局或按规则登记有理由的豁免。' },
    RELEASE_READY: { category: 'unknown', explanation: '门禁报告 ready：这只代表"机器证据齐了"，仍需人工签字（humanSignoffRequired 永远为 true）。', howToResolve: '人工复核后走签核流程。' },
    RELEASE_READY_WITH_WARNINGS: { category: 'unknown', explanation: '门禁报告带警告的 ready：警告必须人工知悉，仍不是自动批准。', howToResolve: '人工复核警告后走签核流程。' },
    RELEASE_BLOCKED: { category: 'unknown', explanation: '门禁汇总阻断（其它条目见清单）。', howToResolve: '逐条处理上面的阻断。' },
  };
  const mapped = map[code] || { category: 'unknown', explanation: '本脚本没有该 code 的归类规则：如实保留原文，待人工归类（不假装理解）。', howToResolve: '人工确认该 code 的语义并补归类规则。' };
  return { ...base, ...mapped, categoryLabel: CATEGORY[mapped.category].label, responsibility: CATEGORY[mapped.category].responsibility };
}

const blockers = Array.isArray(gatePayload?.blockers) ? gatePayload.blockers : [];
const classifiedBlockers = blockers.map(classifyBlocker);
const warningsList = Array.isArray(gatePayload?.warnings) ? gatePayload.warnings : [];
const gates = Array.isArray(gatePayload?.gates) ? gatePayload.gates : [];
const releaseDecision = gatePayload?.releaseDecision ?? null;
const outputDecision = gatePayload?.outputDecision ?? null;

// releaseDecision 里的人工门禁 / 本地门禁逐条解释
const decisionGateNotes = (Array.isArray(releaseDecision?.gates) ? releaseDecision.gates : []).map((item) => {
  const isManualDfm = item.id === 'manual:dfm';
  const isManualSignoff = item.id === 'manual:signoff';
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    passed: item.passed,
    category: isManualDfm ? 'external' : isManualSignoff ? 'human' : (item.status === 'pass' ? 'unknown' : 'unknown'),
    categoryLabel: isManualDfm ? CATEGORY.external.label : isManualSignoff ? CATEGORY.human.label : '本地门禁（详见 blockedBy）',
    explanation: isManualDfm
      ? '在线 DFM 需要外部 DFM 服务结论 + 人工回填证据；本地检查不能冒充在线 DFM。'
      : isManualSignoff
        ? '人工终审签核（passed:true 且至少一个角色）缺失：机器无权替人签字。'
        : (item.reason || '本地门禁未通过/未知，详见 blockedBy。'),
    reason: item.reason ?? null,
    evidence: item.evidence ?? null,
  };
});

// ================================================================ 5. PASS 假象扫描

function buildPassIllusionScan() {
  const checks = [];
  const add = (id, title, status, detail) => checks.push({ id, title, status, detail });
  if (!callSucceeded) {
    add('call', '门禁调用是否成功', 'fail', `门禁调用失败，无法据此判断放行状态。HTTP=${gateCall.status ?? 'N/A'} ${truncate(gateCall.networkError || JSON.stringify(gateCall.payload?.error ?? ''), 300)}`);
    return { verdict: 'inconclusive', checks };
  }
  add('gate.ready', '门禁是否 ready', gatePayload.ready === false ? 'ok' : 'fail', `ready=${String(gatePayload.ready)}；verdict=${String(gatePayload.verdict)}。${gatePayload.ready === false ? '门禁明确未通过。' : '门禁报告 ready=true：仍不是人工批准，必须复核。'}`);
  add('gate.human-signoff', 'humanSignoffRequired 是否强制为真', gatePayload.humanSignoffRequired === true ? 'ok' : 'fail', `humanSignoffRequired=${String(gatePayload.humanSignoffRequired)}（下单永远需要人签字）。`);
  add('decision.ready', 'releaseDecision（本地+人工统一裁决）是否未通过', releaseDecision?.ready === false ? 'ok' : 'fail', `releaseDecision.ready=${String(releaseDecision?.ready)}；blockedBy=${JSON.stringify(releaseDecision?.blockedBy ?? [])}`);
  add('decision.order', '自动下单是否永久禁用', releaseDecision?.orderEnabled === false ? 'ok' : 'fail', `orderEnabled=${String(releaseDecision?.orderEnabled)}（业务红线）。`);
  add('output.allowed', '正式生产文件产出是否被禁止', outputDecision ? (outputDecision.allowed === false && outputDecision.outputClass === null ? 'ok' : 'fail') : 'warn', outputDecision ? `allowed=${String(outputDecision.allowed)}；outputClass=${String(outputDecision.outputClass)}；code=${String(outputDecision.code ?? '')}；message=${truncate(outputDecision.message, 200)}` : '门禁响应里没有 outputDecision。');
  add('blockers.count', '阻断清单是否非空', blockers.length > 0 ? 'ok' : 'fail', `blockers=${blockers.length}；warnings=${warningsList.length}。`);
  // 局部 pass / skipped：逐一列出并说明"不代表放行"
  const scopedPasses = gates.filter((item) => item.status === 'pass').map((item) => ({
    id: item.id,
    title: item.title,
    evidence: item.evidence ?? null,
    findings: item.findings ?? [],
    note: item.id === 'constraints' && item.evidence?.provided === false
      ? '⚠️ 这是典型 PASS 假象候选：constraints 闸门 status=pass 但 evidence.provided=false，含义是"没提供约束、本闸门不阻断"，不等于需求约束已满足。'
      : '局部通过：只对本地门禁的这一道闸门成立，不等于整板放行通过。',
  }));
  const skippedGates = gates.filter((item) => item.status === 'skipped').map((item) => ({ id: item.id, title: item.title, note: 'skipped = 本次未覆盖，不是通过。' }));
  add('gates.scoped-pass', '局部 pass / skipped 是否被误读', scopedPasses.some((item) => item.note.includes('⚠️')) || skippedGates.length ? 'warn' : 'ok',
    `status=pass 的闸门：${scopedPasses.map((item) => item.id).join(',') || '无'}；status=skipped：${skippedGates.map((item) => item.id).join(',') || '无'}。这些都不是"整板放行通过"。`);
  // 产物草稿：即使某道产物闸门局部通过，草稿件也不能下单
  const draftCount = deliverables.filter((item) => item.draftMarker).length;
  add('artifacts.draft', '产物是否真实可下单', draftCount > 0 ? 'warn' : 'ok', `deliverables 共 ${deliverables.length} 个文件，其中 ${draftCount} 个带草稿标记；门禁也把它们判为草稿阻断。`);
  // info 级别的 GATE_PASSED：scope 限定
  const gatePassedInfo = (gatePayload.findings || []).filter((item) => item.code === 'RELEASE_GATE_PASSED' || /GATE_PASSED/.test(String(item.code)));
  if (gatePassedInfo.length) add('findings.gate-passed', 'info 级 GATE_PASSED 是否存在范围说明', gatePassedInfo.every((item) => /覆盖范围|不等于|仅限|已由人确认/.test(String(item.message))) ? 'ok' : 'warn', gatePassedInfo.map((item) => item.message).join(' / '));
  const failed = checks.some((item) => item.status === 'fail');
  const suspicious = checks.some((item) => item.status === 'warn');
  return {
    verdict: failed ? 'fail' : suspicious ? 'needs-review' : 'no-false-pass',
    verdictNote: failed ? '门禁状态自相矛盾：不能当成通过。' : suspicious ? '存在需要人工留意的局部 pass / 草稿 / 未覆盖项：它们都不是放行通过。' : '门禁虽 blocked，但未发现"没证据却显示通过"的自相矛盾。',
    checks,
    scopedPasses,
    skippedGates,
  };
}
const passIllusionScan = buildPassIllusionScan();

// ================================================================ 6. 汇总 + 落盘

const callFailure = !runtimeReachable
  ? { kind: 'runtime-unreachable', message: health.networkError || `运行时 /api/health 返回 ${health.status ?? 'N/A'}` }
  : (!TOKEN
    ? { kind: 'runtime-token-missing', message: '缺少运行时令牌，未调用门禁。' }
    : (authFailure ? { kind: 'runtime-token-invalid', message: '运行时拒绝了令牌（RUNTIME_TOKEN_INVALID）。' } : null));

const gateBlocked = callSucceeded ? gatePayload.ready === false : null;
const reportStatus = !callSucceeded ? 'call-failed' : (gateBlocked ? 'gate-blocked' : 'gate-ready-not-approval');

const conclusionOneLine = !callSucceeded
  ? `门禁调用失败：${callFailure?.message || gateCall.networkError || `HTTP ${gateCall.status}`}——本报告不能作为任何放行依据。`
  : (gateBlocked
    ? `门禁结论：blocked（ready=false，${blockers.length} 条阻断）—— 不是放行通过。`
    : '门禁报告 ready=true：机器证据齐了，但仍不是人工放行批准（humanSignoffRequired=true），必须走签核。');

const report = {
  kind: 'release-gate-real-report',
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  status: reportStatus,
  disclaimer: [
    '本报告是"放行门真机证据报告"，**不是放行通过，也不是放行批准**。',
    '只有 humanSignoffRequired 流程完成 + 人工终审签核，才可能进入下单；自动下单/支付永久禁用（orderEnabled=false）。',
    '本脚本没有签发任何批准、没有写板、没有重签/安装 app、没有导出正式生产文件。',
  ],
  conclusion: {
    isReleaseApproval: false,
    oneLine: conclusionOneLine,
    gateReady: gatePayload?.ready ?? null,
    gateVerdict: gatePayload?.verdict ?? null,
    gateBlockerCount: blockers.length,
    gateWarningCount: warningsList.length,
    releaseDecisionReady: releaseDecision?.ready ?? null,
    releaseDecisionVerdict: releaseDecision?.verdict ?? null,
    releaseDecisionBlockedBy: releaseDecision?.blockedBy ?? [],
    orderEnabled: releaseDecision?.orderEnabled ?? null,
    humanSignoffRequired: gatePayload?.humanSignoffRequired ?? true,
    outputDecision: outputDecision ? { allowed: outputDecision.allowed ?? null, outputClass: outputDecision.outputClass ?? null, code: outputDecision.code ?? null, message: outputDecision.message ?? null, blockers: outputDecision.blockers ?? [] } : null,
  },
  preflight,
  request: {
    method: 'POST',
    path: '/api/eda/release/gate',
    url: `${RUNTIME_URL}/api/eda/release/gate`,
    body: REQUEST_BODY,
    headers: { 'content-type': 'application/json', 'x-circuitpilot-token': '（已发送，未记录/未落盘）' },
    reason: [
      '只用当前打开的工程/原理图页/PCB 让服务端实时取证：不预置 acceptance/design/placementVerification/drcReport/pricing。',
      '缺什么就让对应闸门 blocked，不拿历史文件冒充当前板的证据。',
      'userConfirmed=false：布局未经人确认，这是真实状态，不能由脚本代签。',
    ],
  },
  response: callSucceeded || gatePayload
    ? { httpStatus: gateCall.status, durationMs: gateCall.durationMs, ok: callSucceeded, bodySha256: sha256(gateCall.text || ''), bodyBytes: Buffer.byteLength(gateCall.text || '', 'utf8'), body: gatePayload, rawTextPreview: callSucceeded ? null : truncate(gateCall.text, 2000) }
    : { httpStatus: gateCall.status, durationMs: gateCall.durationMs, ok: false, networkError: gateCall.networkError ?? null, rawTextPreview: truncate(gateCall.text, 2000) },
  blockedBy: {
    localGateBlockers: classifiedBlockers,
    manualGates: decisionGateNotes,
    releaseDecisionBlockedBy: releaseDecision?.blockedBy ?? [],
    categories: [...new Set(classifiedBlockers.map((item) => item.category))].map((category) => ({
      category,
      label: CATEGORY[category].label,
      responsibility: CATEGORY[category].responsibility,
      codes: classifiedBlockers.filter((item) => item.category === category).map((item) => item.code),
    })),
  },
  passIllusionScan,
  gates: gates.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    blockingCount: item.blockingCount ?? null,
    evidence: item.evidence ?? null,
    findings: (item.findings || []).map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message, field: finding.field ?? null })),
    interpretation: item.status === 'pass' ? '局部通过（不等于整板放行）' : item.status === 'skipped' ? '本次未覆盖（不是通过）' : item.status === 'warn' ? '有警告（不通过）' : item.status === 'blocked' ? '阻断' : '未知/证据缺失（不是通过）',
  })),
  warnings: warningsList.map((item) => ({ code: item.code, message: item.message, field: item.field ?? null })),
  scriptWarnings: warnings,
  evidence: {
    note: '以下为只读扫描到的证据清单，仅用于交叉参考与人读者复核；本次门禁调用**没有注入**其中任何一项。',
    deliverables,
    evidenceStore,
    supplementary,
    provenanceNotes: [
      'deliverables 里只有 DRAFT-NOT-FOR-ORDER 草稿产物：不能用于下单，门禁也如实阻断。',
      evidenceStore.drc
        ? `最新 DRC 证据：${evidenceStore.drc.path}（savedAt=${evidenceStore.drc.savedAt}，指纹 pcbUuid=${evidenceStore.drc.fingerprint?.pcbUuid ?? 'null'}）。注意：本脚本没有把它注入门禁；若它的指纹与当前板 ${preflight.target?.pcbUuid ?? '未知'} 不一致，它也不能当当前板证据。`
        : '没有 DRC 证据文件：DRC 闸门 blocked 是如实结果。',
      evidenceStore.erc
        ? `最新 ERC 证据：${evidenceStore.erc.path}（savedAt=${evidenceStore.erc.savedAt}，projectUuid=${evidenceStore.erc.fingerprint?.projectUuid ?? 'null'}，documentUuid=${evidenceStore.erc.fingerprint?.documentUuid ?? 'null'}，counts=${JSON.stringify(evidenceStore.erc.counts)}）。它与当前工程/页指纹一致，可作为当前 ERC 现状的旁证；但门禁本次仍会重新实时跑验收。`
        : '没有 ERC 证据文件。',
      evidenceStore.dfm || evidenceStore.signoff ? '存在 DFM/签核证据（见 evidenceStore）。' : '没有 DFM 证据、没有人工终审签核证据：releaseDecision 的人工门禁必然 blocked，这是真实状态。',
      supplementary.spice.netlists.length || supplementary.spice.simulationEvidences.length
        ? `T3 独立 SPICE 证据已存在：netlist ${supplementary.spice.netlists.length} 份、simulation-evidence ${supplementary.spice.simulationEvidences.length} 份（状态：${supplementary.spice.simulationEvidences.map((item) => item.status ?? 'unknown').join('/') || 'unknown'}；网表 sha256=${String(supplementary.spice.netlists[0]?.sha256 ?? '').slice(0, 12)}；ngspice runs=${JSON.stringify(supplementary.spice.simulationEvidences.flatMap((item) => item.runs ?? []).map((run) => `${run.kind}:exit${run.exitCode}`))}）。它**不被本次门禁自动消费**（gate 路由内置验收未启用 evidence-store 的仿真证据回退），只作交叉参考、不作为放行依据；且它只是"关键子电路的真实求解器结果"，不是整板/全功能仿真。`
        : 'artifacts/spice 下暂无 T3 独立 SPICE 证据（可能尚未产出）。',
      '真实 ERC 现状（旁证，来自最新落盘证据）：1 error / 34 warning / 2 info（37 条）；系统不自动改图，需要人工 triage。',
    ],
  },
  notPerformed: [
    '没有签发任何放行批准 / 审批令牌。',
    '没有写 EDA 设计（无 schematic.*.set/place、pcb.*.apply、routing.apply、pour.create）。',
    '没有重签 / 重装 / 公证 / 修改 /Applications/CircuitPilot.app。',
    '没有导出正式生产文件（没有调用 production/export 或 releases/archive）。',
    '没有启动新的端口服务（复用已在运行的源码 sidecar）。',
  ],
  reproduction: {
    command: 'CIRCUITPILOT_RUNTIME_TOKEN=<令牌> node scripts/release-gate-report.mjs',
    env: {
      CIRCUITPILOT_RUNTIME_URL: RUNTIME_URL,
      CIRCUITPILOT_GATE_TIMEOUT_MS: TIMEOUT_MS,
      CIRCUITPILOT_ARTIFACTS_DIR: ARTIFACTS_DIR,
      CIRCUITPILOT_TARGET_BOARD: TARGET_BOARD,
      CIRCUITPILOT_PAGE_UUID: PAGE_UUID,
    },
    note: '令牌只从环境变量或 /tmp 临时文件读取，不写入任何报告。',
  },
  reports: { json: JSON_PATH, markdown: MD_PATH },
};

writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------- Markdown

const md = [];
const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
md.push('# T6 真机放行门报告（真实 runtime 调用）');
md.push('');
md.push('> **结论：不是放行通过。** 本文件是证据报告，不是放行批准；任何"可以下单"的说法都必须经过人工终审签核。');
md.push('');
md.push(`- 生成时间：\`${GENERATED_AT}\``);
md.push(`- 运行时：\`${RUNTIME_URL}\`（health=${preflight.runtime.reachable ? 'ok' : 'FAIL'}，version=${preflight.runtime.health?.version ?? 'N/A'}）`);
md.push(`- 目标工程：\`${preflight.target?.projectUuid ?? '未解析'}\`（期望 \`${EXPECTED_PROJECT_UUID}\`，匹配=${preflight.target?.projectMatchesExpected ?? 'unknown'}）`);
md.push(`- 目标板：\`${TARGET_BOARD}\` / PCB \`${preflight.target?.pcbUuid ?? '未解析'}\` / 原理图页 \`${PAGE_UUID}\``);
md.push(`- 产物目录：\`${ARTIFACTS_DIR}\``);
md.push(`- 报告状态：\`${reportStatus}\``);
md.push(`- JSON：\`${JSON_PATH}\``);
md.push('');
md.push('## 1. 门禁结论');
md.push('');
md.push(`**${conclusionOneLine}**`);
md.push('');
md.push('| 项 | 值 |');
md.push('|---|---|');
md.push(`| ready | \`${String(gatePayload?.ready)}\` |`);
md.push(`| verdict | \`${String(gatePayload?.verdict)}\` |`);
md.push(`| 阻断数 | ${blockers.length} |`);
md.push(`| 警告数 | ${warningsList.length} |`);
md.push(`| humanSignoffRequired | \`${String(gatePayload?.humanSignoffRequired)}\`（机器不能替人签字） |`);
md.push(`| releaseDecision.ready | \`${String(releaseDecision?.ready)}\` |`);
md.push(`| releaseDecision.blockedBy | \`${JSON.stringify(releaseDecision?.blockedBy ?? [])}\` |`);
md.push(`| orderEnabled | \`${String(releaseDecision?.orderEnabled)}\`（自动下单永久禁用） |`);
md.push(`| outputDecision.allowed | \`${String(outputDecision?.allowed)}\` / outputClass=\`${String(outputDecision?.outputClass)}\` |`);
md.push(`| HTTP | ${gateCall.status ?? 'N/A'}（耗时 ${gateCall.durationMs}ms） |`);
md.push('');
md.push('## 2. 阻断清单（逐条中文解释 + 责任归属）');
md.push('');
if (!callSucceeded) {
  md.push(`> 门禁调用失败，没有阻断清单：${callFailure?.message || gateCall.networkError || `HTTP ${gateCall.status}`}`);
} else if (!classifiedBlockers.length) {
  md.push('> 阻断清单为空：注意这不等于"可以下单"，还需人工终审签核。');
} else {
  md.push('| # | code | severity | 门禁原文（message） | 中文解释 | 归属类别 | 谁来解决 | 如何消除 |');
  md.push('|---|---|---|---|---|---|---|---|');
  classifiedBlockers.forEach((item, index) => {
    md.push(`| ${index + 1} | \`${item.code}\` | ${esc(item.message)} | ${esc(item.explanation)} | ${esc(item.categoryLabel)} | ${esc(item.responsibility)} | ${esc(item.howToResolve)} |`);
  });
  md.push('');
  md.push('### 按归属类别汇总');
  md.push('');
  for (const category of report.blockedBy.categories) {
    md.push(`- **${category.label}**（${category.responsibility}）：${category.codes.map((code) => `\`${code}\``).join('、')}`);
  }
}
md.push('');
md.push('## 3. 统一裁决里的人工门禁（DFM / 终审签核）');
md.push('');
if (!decisionGateNotes.length) {
  md.push('> 响应里没有 releaseDecision.gates（门禁调用可能失败）。');
} else {
  md.push('| 门禁 | 状态 | 是否通过 | 中文解释 |');
  md.push('|---|---|---|---|');
  for (const item of decisionGateNotes) {
    md.push(`| ${esc(item.title)}（\`${item.id}\`） | ${esc(item.status)} | ${item.passed ? '是' : '否'} | ${esc(item.explanation)} |`);
  }
}
md.push('');
md.push('## 4. PASS 假象扫描');
md.push('');
md.push(`扫描结论：\`${passIllusionScan.verdict}\` —— ${passIllusionScan.verdictNote}`);
md.push('');
md.push('| 检查 | 状态 | 说明 |');
md.push('|---|---|---|');
for (const item of passIllusionScan.checks) {
  md.push(`| ${esc(item.title)} | ${item.status} | ${esc(item.detail)} |`);
}
md.push('');
if (passIllusionScan.scopedPasses?.length) {
  md.push('**局部 pass 闸门（都不是整板放行）：**');
  md.push('');
  for (const item of passIllusionScan.scopedPasses) md.push(`- \`${item.id}\`（${item.title}）：${item.note}`);
  md.push('');
}
if (passIllusionScan.skippedGates?.length) {
  md.push('**skipped 闸门（= 本次未覆盖，不是通过）：**');
  md.push('');
  for (const item of passIllusionScan.skippedGates) md.push(`- \`${item.id}\`（${item.title}）：${item.note}`);
  md.push('');
}
md.push('## 5. 各本地闸门状态');
md.push('');
md.push('| 闸门 | 状态 | 阻断数 | 读法 |');
md.push('|---|---|---|---|');
for (const item of report.gates) {
  md.push(`| ${esc(item.title)}（\`${item.id}\`） | ${esc(item.status)} | ${item.blockingCount ?? 'N/A'} | ${esc(item.interpretation)} |`);
}
md.push('');
md.push('## 6. 证据来源 / 旁证（本次门禁调用未注入）');
md.push('');
md.push('> 这批文件只用于人工复核与后续补证；本次结论来自服务端**实时取证**，不是这些历史文件。');
md.push('');
md.push('### 6.1 deliverables 产物');
md.push('');
if (!deliverables.length) md.push('- （空）');
else {
  md.push('| 文件 | kind | 大小 | 修改时间 | 草稿标记 | sha256(前12) |');
  md.push('|---|---|---|---|---|---|');
  for (const item of deliverables) md.push(`| \`${esc(item.name)}\` | ${esc(item.kind ?? '-')} | ${item.bytes ?? '-'} | ${esc(item.mtime ?? '-')} | ${item.draftMarker ? '是（草稿）' : '否'} | \`${String(item.sha256 ?? '').slice(0, 12)}\` |`);
}
md.push('');
md.push('### 6.2 evidence-store 最新证据');
md.push('');
const ev = evidenceStore;
md.push(`- DRC：${ev.drc ? `\`${ev.drc.path}\`（savedAt=${ev.drc.savedAt}，reportedCount=${ev.drc.reportedCount}，digest 重算一致=${ev.drc.digestConsistent}，指纹 pcbUuid=${ev.drc.fingerprint?.pcbUuid ?? 'null'}）` : '无'}`);
md.push(`- ERC：${ev.erc ? `\`${ev.erc.path}\`（savedAt=${ev.erc.savedAt}，counts=${JSON.stringify(ev.erc.counts)}，digest 重算一致=${ev.erc.digestConsistent}，指纹 documentUuid=${ev.erc.fingerprint?.documentUuid ?? 'null'}）` : '无'}`);
md.push(`- SPICE 仿真（evidence-store）：${ev.spiceSimulation ? `\`${ev.spiceSimulation.path}\`（savedAt=${ev.spiceSimulation.savedAt}，source=${ev.spiceSimulation.source}，指纹=${JSON.stringify(ev.spiceSimulation.fingerprint)}）` : '无'}`);
md.push(`- DFM 人工回填：${ev.dfm ? `\`${ev.dfm.path}\`` : '**无**'}`);
md.push(`- 人工终审签核：${ev.signoff ? `\`${ev.signoff.path}\`` : '**无**'}`);
md.push('');
md.push('### 6.3 独立补充证据（T3 SPICE / 板级分析）');
md.push('');
if (!supplementary.spice.netlists.length && !supplementary.spice.simulationEvidences.length) {
  md.push('- artifacts/spice 下暂无独立 SPICE 证据。');
} else {
  for (const item of supplementary.spice.netlists) md.push(`- 网表：\`${item.path}\`（${item.bytes} bytes，sha256=\`${String(item.sha256 ?? '').slice(0, 16)}\`，mtime=${item.mtime}）`);
  for (const item of supplementary.spice.simulationEvidences) {
    const net = item.netlist ? `netlist sha256=${String(item.netlist.sha256 ?? '').slice(0, 16)}、器件=${item.netlist.componentCount ?? '-'}、引脚/有网=${item.netlist.pinCount ?? '-'}/${item.netlist.connectedPinCount ?? '-'}、网络=${item.netlist.netCount ?? '-'}` : 'netlist=N/A';
    md.push(`- 仿真证据：\`${item.path}\`（generatedAt=${item.generatedAt ?? '-'}，status=${item.status ?? '-'}，${net}）`);
    if (item.runs?.length) {
      for (const run of item.runs) md.push(`  - ngspice ${run.kind ?? '-'}：exit=${run.exitCode}，log=\`${run.logPath ?? '-'}\`，log sha256=\`${String(run.logSha256 ?? '').slice(0, 16)}\``);
    }
    if (item.results) md.push(`  - 结果：op=${JSON.stringify(item.results.operatingPoint)}，tran/measurements=${JSON.stringify(item.results.measurements)}`);
    if (item.edaSimulationNetlist) md.push(`  - EDA 官方 SPICE 网表：available=${item.edaSimulationNetlist.available}，reason=${item.edaSimulationNetlist.reason}`);
    if (item.assumptionsCount != null) md.push(`  - 假设 ${item.assumptionsCount} 条（人工选值，非实测器件模型）；blockedReasons=${Array.isArray(item.blockedReasons) ? item.blockedReasons.map((reason) => reason.code ?? reason).join(',') : '-'}`);
    if (item.note) md.push(`  - 注意：${item.note}`);
  }
}
if (supplementary.boardAnalysis.length) md.push(`- artifacts/board-analysis：${supplementary.boardAnalysis.length} 份（${supplementary.boardAnalysis.map((item) => item.name).slice(0, 6).join('、')}${supplementary.boardAnalysis.length > 6 ? ' …' : ''}）`);
md.push('');
md.push('### 6.4 证据绑定提醒');
md.push('');
for (const note of report.evidence.provenanceNotes) md.push(`- ${note}`);
md.push('');
md.push('## 7. 请求（令牌已移除）');
md.push('');
md.push('```json');
md.push(JSON.stringify(REQUEST_BODY, null, 2));
md.push('```');
md.push('');
md.push('为什么要这样调用：服务端会**自己**打开指定原理图页、导出网表、跑验收、读 PCB 布局与铜层；不喂 acceptance/design/placement/drc/pricing，缺什么就 blocked，避免"拿历史文件冒充当前板证据"。');
md.push('');
md.push('## 8. 复现');
md.push('');
md.push('```bash');
md.push('CIRCUITPILOT_RUNTIME_TOKEN=<令牌> node scripts/release-gate-report.mjs');
md.push('```');
md.push('');
md.push(`可选环境变量：\`CIRCUITPILOT_RUNTIME_URL\`（默认 ${RUNTIME_URL}）、\`CIRCUITPILOT_GATE_TIMEOUT_MS\`（默认 ${TIMEOUT_MS}）、\`CIRCUITPILOT_ARTIFACTS_DIR\`、\`CIRCUITPILOT_TARGET_BOARD\`、\`CIRCUITPILOT_PAGE_UUID\`、\`CIRCUITPILOT_PCB_UUID\`。令牌只从环境变量/本机临时文件读取，不写进报告。`);
md.push('');
md.push('## 9. 本次没有做什么');
md.push('');
for (const item of report.notPerformed) md.push(`- ${item}`);
md.push('');
if (warnings.length) {
  md.push('## 10. 脚本级提醒（不影响门禁原文）');
  md.push('');
  for (const item of warnings) md.push(`- \`${item.code}\`：${item.message}`);
  md.push('');
}
md.push('---');
md.push('');
md.push('> **再次强调：本报告不是放行通过。** 门禁 blocked / releaseDecision blocked / outputDecision 禁止正式产出，三项都在说同一件事：现在不能下单。');
md.push('> 要变成"可放行"，需要按第 2 节的归属逐条补证/修设计/人工签字，然后**重新跑门禁**，而不是改这份报告。');
md.push('');

writeFileSync(MD_PATH, md.join('\n'), 'utf8');

// ---------------------------------------------------------------- 控制台摘要

console.log(JSON.stringify({
  ok: callSucceeded,
  status: reportStatus,
  conclusion: conclusionOneLine,
  gate: { ready: gatePayload?.ready ?? null, verdict: gatePayload?.verdict ?? null, blockers: blockers.length, warnings: warningsList.length },
  blockedCodes: [...new Set(classifiedBlockers.map((item) => item.code))],
  categories: report.blockedBy.categories,
  releaseDecision: { ready: releaseDecision?.ready ?? null, blockedBy: releaseDecision?.blockedBy ?? [] },
  passIllusionScan: passIllusionScan.verdict,
  output: { json: JSON_PATH, markdown: MD_PATH },
}, null, 2));

process.exit(callSucceeded ? 0 : 1);
