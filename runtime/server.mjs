import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWED_ORIGINS, BODY_LIMIT, BRIDGE_PORTS, EDA_APP_CANDIDATES, RUNTIME_HOST, RUNTIME_PORT } from './config.mjs';
import { BridgeClient } from './bridge.mjs';
import { EdaGuiClient } from './eda-gui.mjs';
import { createApprovalStore, fingerprintOf } from './automation/approvals.mjs';
import { createApprovalLedger } from './approval-ledger.mjs';
import { createAutomationJournal } from './automation/journal.mjs';
import { createRuntimeExecutors } from './automation/executors.mjs';
import { createDefaultRecipeRegistry } from './automation/recipes.mjs';
import { runRecipe } from './automation/runner.mjs';
import { createRunLock } from './automation/run-lock.mjs';
import { analyzeRunEntries, canReplay, findInterruptedRuns } from './automation/recovery.mjs';
import { exportSchematicNetlistText, runSchematicAcceptance } from './schematic-acceptance.mjs';
import { evaluateFootprintIntegrity } from './footprint-integrity.mjs';
import { applyNetConnect, buildTestConnections, collectDanglingPins, rollbackNetConnect, planNetConnect } from './net-connect.mjs';
import { applySchematicBatch, planSchematicBatch, readPartFacts } from './schematic-batch.mjs';
import { assertAnnotatableDesignator } from './designator.mjs';
import { buildExemptionTemplate, classifyDrcItems, defaultExemptionPath, loadExemptionFile, loadScopedExemptionFile, normalizeDrcReport, saveExemptionFile } from './drc.mjs';
import { checkOperatingPoint, runSimulation as runSimulationDefault, verifySimulationEvidence } from './simulation.mjs';
import { assertPinEvidenceForNetlist, auditPinEvidence, buildPinEvidence } from './pin-evidence.mjs';
import { captureEdaWindow } from './eda-window-capture.mjs';
import { assessEdaAdaptation } from './eda-adaptation.mjs';
import { auditNetlistAssumptions } from './netlist-assumptions.mjs';
import { planPinFirstNetlistFlow } from './automation/pin-first-flow.mjs';
import { providerEgressManifest, previewProviderEgress } from './provider-egress.mjs';
import { fetchPage, searchWeb, RESEARCH_CODES } from './research.mjs';
import { createKnowledgeStore } from './knowledge.mjs';
import { createKnowledgeApi, KNOWLEDGE_API_CODES } from './knowledge-api.mjs';
import { buildReviewQueue, healthMetrics } from './knowledge-pipeline.mjs';
import { createKnowledgeManager } from './agents/knowledge-manager.mjs';
import { createPcbWebCollectors, DEFAULT_PCB_TOPICS } from './collectors/pcb-web.mjs';
import { createKnowledgeScheduler } from './knowledge-scheduler.mjs';
import { createRagStore } from './rag/store.mjs';
import { createGateService, GATE_SERVICE_CODES } from './gates-service.mjs';
import { createReleaseArchiveStore } from './release-archive.mjs';
import { buildTimeline } from './timeline.mjs';
import { appendTimelineLink, loadTimelineLinks, validateTimelineLink } from './timeline-links.mjs';
import { buildRunAuditBundle } from './automation/audit-bundle.mjs';
import { planOrchestration, decideFailureRecovery, listGoalProfiles } from './automation/orchestration.mjs';
import { catalogTexts, evaluateGuiCapabilities } from './gui-capabilities.mjs';
import { validateOrderConfirmation } from './order-confirmation.mjs';
import { summarizeSupplyEvidence } from './supply-summary.mjs';
import { applyErcExemptions, loadScopedErcExemptionFile, normalizeErcReport, saveErcExemptionFile, summarizeErcConvergence } from './erc.mjs';
import { assessEvidenceFreshness } from './evidence-freshness.mjs';
import { EVIDENCE_KINDS } from './evidence-store.mjs';
import { pruneEvidenceStore } from './evidence-retention.mjs';
import { applyRoutingWithDrcGuard } from './engineering/routing-drc.mjs';
import { extractErcDetail, mergeErcDetail } from './eda-erc-detail.mjs';
import { materializeGuiScreenshot } from './gui-artifact-transport.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { buildReleaseDecision } from './release-decision.mjs';
import { verifyExportManifestBinding } from './release-binding.mjs';
import { buildEvidenceIndex, findEvidence, planEvidenceRetention } from './evidence-index.mjs';
import { planRetention } from './artifact-retention.mjs';
import { createJsonStore } from './store.mjs';
import { createProjectStateStore, createProjectScopedStore, sliceProjectState, assertProjectId, PROJECT_STATE_CODES } from './project-state.mjs';
import { createIssueStateStore } from './issue-state.mjs';
import { createTraceStateStore } from './trace-state.mjs';
import { buildDiagnosticBundle } from './diagnostic-bundle.mjs';
import { summarizeJournalRuns } from './automation/journal.mjs';
import { buildOutlineField, buildPadEnvelopes, checkPadOutlineClearance, diffPlacement, netAffinity, parsePolygonSource, placementCenterMm, planOutlinePlacement, readComponentGeometry, verifyOutlinePlacement } from './placement.mjs';
import { applyPlacementPlan } from './placement-write.mjs';
import { auditPlacementPlan } from './placement-rules.mjs';
import { decideProductionOutput } from './production-release.mjs';
import { DEFAULT_KINDS as DEFAULT_EXPORT_KINDS, readExportManifest, runProductionExport, sanitizeArtifactVerification } from './production-export.mjs';
import { buildFabricationOrder, deriveBoardFacts } from './fabrication-order.mjs';
import { DEFAULT_PULLUP_REPAIRS, applySchematicRepair, findExistingBridge, layoutFreeRow, partMatchesRepair, planSchematicRepair } from './schematic-repair.mjs';
import { RELEASE_CODES, collectArtifacts, gateArtifacts, gateFabricationRelease } from './release-gate.mjs';
import { parseEasyEdaNetlist } from './schematic.mjs';
import { EdaJobStore } from './engineering/eda-jobs.mjs';
import { createFileJournal } from './engineering/eda-job-journal.mjs';
import { ChatManager, probeSelectionFallback } from './chat.mjs';
import { DesignManager, normalizePlan } from './design.mjs';
import { buildPartProposal, normalizeRequirement, selectProposalToPlan } from './proposal.mjs';
import { systemDiagnostics } from './diagnostics.mjs';
import { diagnoseFailure } from './failure-diagnosis.mjs';
import { MacKeychain } from './keychain.mjs';
import { listEvents, logger, redact } from './logger.mjs';
import { PROVIDERS, openProviderConsole, providerStatuses, startProviderLogin, testProvider } from './providers.mjs';
import { CustomProviderRegistry, customProviderNotFound } from './customProviders.mjs';
import { compileCh32v003Fixture, normalizePcbPlan, PcbManager, diffPcbAgainstNetlist } from './pcb.mjs';
import { ProductionManager, classifyArtifact, inspectProductionArtifacts } from './production.mjs';
import { findAlternatives } from './engineering/supply-alternatives.mjs';
import { lookupLcscParts, formatSupplyEvidence, searchLcscByKeyword } from './engineering/supply.mjs';
import { engineeringProfiles, runEngineeringAnalysis } from './engineering/engine.mjs';
import { evaluateLayoutRules, layoutRulePackSummary } from './engineering/layout-rules.mjs';
import { normalizeLayoutIntent } from './engineering/layout-intent.mjs';
import { LAYOUT_RULE_FIXTURES } from './engineering/rules/fixtures.mjs';
import { evaluateFabRules, fabProfileSummary, FAB_RULE_FIXTURES } from './engineering/fab-rules.mjs';
import { evaluateNetRules, NET_RULE_FIXTURES, netRuleSummary } from './engineering/net-rules.mjs';
import { evaluateSkillRules, skillRuleSummary, SKILL_RULE_FIXTURES } from './engineering/skill-rules.mjs';
import { buildSkillInput } from './engineering/skill-input.mjs';
import { engineeringFixtures } from './engineering/fixtures.mjs';
import { applyRoutingPlan, buildRepairConnections, finishRouting, planRepairRoutes, rollbackRouting } from './engineering/pcb-routing.mjs';
import { selectRoutableLayers } from './engineering/route-layers.mjs';
// 叠层铜层数的唯一权威换算：叠层序号/层号（内层从 15 起，不是 3/4/5）。
// 产品 HTTP 接口只需读写“层数”，但读回校验必须用这里换算出的层号，不允许裸写层号。
import { PLAN_COPPER_LAYER_COUNTS, copperLayerIds, isEdaCopperLayerCount } from './engineering/layers.mjs';
import { startDetached } from './process.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const runtimeParentPid = process.ppid;
const parentWatchdog = setInterval(() => {
  if (process.ppid === 1 || process.ppid !== runtimeParentPid) process.exit(0);
}, 2_000);
parentWatchdog.unref();

/**
 * 桥连通性故障：这些码表示"本机 EDA 桥暂时不可用"，不是请求体写错了。
 *
 * 历史契约（第 60 轮记录的已知项）：bridge.mjs 抛出的 BRIDGE_UNREACHABLE / BRIDGE_TIMEOUT
 * 不带 error.status，走到顶层 catch 被兜底成 400 —— 把"服务暂时不可用、稍后重试即可"
 * 说成了"客户端请求错误"，会让调用方（UI/脚本）误判成参数问题而放弃重试。
 * 第 61 轮起统一映射为 503 Service Unavailable；BRIDGE_NOT_FOUND 原本就显式返回 503，
 * 这里一并纳入映射，保证"桥没发现/连不上/超时"三种连通性故障语义一致。
 * 错误码与文案保持不变（只改状态码 + 瞬时故障追加 retryable:true），避免破坏既有解析。
 */
const BRIDGE_UNAVAILABLE_CODES = new Set(['BRIDGE_UNREACHABLE', 'BRIDGE_TIMEOUT', 'BRIDGE_NOT_FOUND']);
/** 只有"暂时性"故障才标 retryable；BRIDGE_NOT_FOUND 需先启动/发现桥，不宣称立即可重试。 */
const BRIDGE_RETRYABLE_CODES = new Set(['BRIDGE_UNREACHABLE', 'BRIDGE_TIMEOUT']);

/**
 * 统一的"错误 → HTTP 状态"映射。显式 error.status 永远优先（保持既有路由契约），
 * 只有未标注状态的桥连通性错误才提升为 503，其余仍按历史行为兜底 400。
 */
function httpStatusForError(error) {
  if (error?.status) return error.status;
  if (BRIDGE_UNAVAILABLE_CODES.has(error?.code)) return 503;
  return 400;
}

function runtimeError(error) {
  // details 是为了"说清到底哪个对象出问题"：只报个数（"3 个对象找不到"）会让人无从下手，
  // 真机排查时必须能直接看到对象类型/网络/坐标。
  const details = error?.details && typeof error.details === 'object' ? error.details : null;
  return {
    ok: false,
    error: {
      code: error?.code || 'RUNTIME_ERROR',
      message: redact(error?.message || '本机Runtime发生未知错误'),
      ...(details ? { details } : {}),
      // 503 是"可重试"信号；再显式给一个字段，客户端不必靠猜状态码含义。
      ...(BRIDGE_RETRYABLE_CODES.has(error?.code) ? { retryable: true } : {}),
    },
  };
}

/**
 * 产物下载：只允许"放行目录内的已知文件类型"。
 *
 * 为什么必须白名单：这条路由一旦接受任意绝对路径，本机任何拿到会话令牌的页面都能
 * 读走 ~/.ssh 之类的文件。所以三道闸：根目录白名单（默认 release/deliverables，
 * 可用 CIRCUITPILOT_DOWNLOAD_ROOTS 覆盖）、realpath 后仍须在根目录内（防符号链接逃逸）、
 * 扩展名白名单（产物类型）。只读 GET、不写盘、不返回目录内容。
 */
const DOWNLOAD_EXTENSIONS = new Set(['.zip', '.csv', '.step', '.stp', '.glb', '.gbr', '.drl', '.json', '.txt', '.pdf', '.md', '.xlsx']);
const DOWNLOAD_MIME = { '.zip': 'application/zip', '.csv': 'text/csv; charset=utf-8', '.step': 'application/step', '.stp': 'application/step', '.glb': 'model/gltf-binary', '.gbr': 'application/octet-stream', '.drl': 'application/octet-stream', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function downloadRoots() {
  const configured = String(process.env.CIRCUITPILOT_DOWNLOAD_ROOTS || '').split(sep === ':' ? ':' : ';').map((item) => item.trim()).filter(Boolean);
  const roots = configured.length ? configured : [join(process.cwd(), 'release'), join(process.cwd(), 'deliverables')];
  return roots.map((root) => resolvePath(root)).filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

function resolveDownloadableArtifact(rawPath) {
  const requested = String(rawPath || '').trim();
  if (!requested) throw Object.assign(new Error('缺少 path 参数'), { code: 'DOWNLOAD_PATH_REQUIRED', status: 400 });
  const absolute = resolvePath(requested);
  if (!existsSync(absolute)) throw Object.assign(new Error('文件不存在'), { code: 'DOWNLOAD_NOT_FOUND', status: 404 });
  const real = realpathSync(absolute);
  const inside = downloadRoots().some((root) => real === root || real.startsWith(root + sep));
  if (!inside) throw Object.assign(new Error('只允许下载放行产物目录内的文件'), { code: 'DOWNLOAD_PATH_FORBIDDEN', status: 403 });
  const stat = statSync(real);
  if (!stat.isFile()) throw Object.assign(new Error('只能下载文件，不能下载目录'), { code: 'DOWNLOAD_NOT_A_FILE', status: 400 });
  const ext = extname(real).toLowerCase();
  if (!DOWNLOAD_EXTENSIONS.has(ext)) throw Object.assign(new Error(`不允许下载该类型：${ext || '无扩展名'}`), { code: 'DOWNLOAD_TYPE_FORBIDDEN', status: 400 });
  if (stat.size > 300 * 1024 * 1024) throw Object.assign(new Error('文件超过 300MB，不允许通过 Runtime 下载'), { code: 'DOWNLOAD_TOO_LARGE', status: 413 });
  return { path: real, name: basename(real), size: stat.size, mime: DOWNLOAD_MIME[ext] || 'application/octet-stream' };
}

function sendFile(response, file, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('content-type', file.mime);
  response.setHeader('content-length', String(file.size));
  response.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  response.setHeader('cache-control', 'no-store');
  response.writeHead(200);
  createReadStream(file.path).pipe(response);
}

/** 这些字段是"公开协议元数据"，即使名字里带 token/credential 也不能按密钥擦掉。 */
const PUBLIC_CREDENTIAL_FIELDS = new Set(['configured', 'hint', 'removed', 'note']);

/**
 * 把被"按字段名整值擦除"的公开协议字段恢复回去。
 *
 * 为什么需要：sendJson 对所有响应体套了同一套密钥脱敏，而脱敏规则刻意宽——
 * 字段名命中 `token|credential` 就整值擦成 "[REDACTED]"。对日志这是对的，对协议是错的：
 *   - 自定义模型 Provider 的模型元数据 `maxOutputTokens` 是配置数字，不是密钥，
 *     擦掉会让设置页拿不到上下文/输出上限（值变成字符串 "[REDACTED]"）；
 *   - Provider 凭据状态 `credential` 只有 {configured,hint}（hint 是钥匙串末四位提示），
 *     不含明文，擦掉会让"凭据已保存"的提示变成 undefined。
 * 恢复条件同时限定"形状匹配 + 值类型安全"：数字只恢复数字，credential 只恢复
 * 白名单内的键；任何其它命中敏感名的字段（以及未知形状）仍然保持整值擦除。
 */
function restorePublicResponseFields(original, safe) {
  if (Array.isArray(safe)) {
    if (!Array.isArray(original) || original.length !== safe.length) return safe;
    return safe.map((item, index) => restorePublicResponseFields(original[index], item));
  }
  if (!safe || typeof safe !== 'object' || !original || typeof original !== 'object' || Array.isArray(original)) return safe;
  for (const key of Object.keys(safe)) {
    if (!Object.prototype.hasOwnProperty.call(original, key)) continue;
    const value = original[key];
    if (key === 'maxOutputTokens' && typeof value === 'number' && Number.isFinite(value)) { safe[key] = value; continue; }
    // chat.reply 是模型生成的对话正文（用户要看到完整答复）。此前经 redact() 后会被按 512 字符
    // 截断成 "……[truncated N chars]"，多轮对话里连提问都被砍半；这里恢复原始正文（其余字段仍脱敏）。
    if (key === 'reply' && typeof value === 'string') { safe[key] = value; continue; }
    if (key === 'credential' && value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length > 0 && Object.keys(value).every((field) => PUBLIC_CREDENTIAL_FIELDS.has(field))) {
      safe[key] = { ...value };
      continue;
    }
    safe[key] = restorePublicResponseFields(value, safe[key]);
  }
  return safe;
}

/**
 * 生成"可回给本机客户端"的响应体：先脱敏，再只恢复协议明确允许下发的字段。
 *
 * 真机/压测教训（2026-10-23）：/api/health 的 sessionProof 是发给受信 Origin 的会话令牌；
 * 随机令牌有时以 `sk`/`pk`/`rk` 开头，会被 log-redaction 的自由文本规则当成 API key 擦成
 * `[REDACTED]`，客户端随后拿它发请求就随机 401。这里和 approval.token 一样显式恢复。
 */
export function publicResponseBody(body) {
  const safeBody = redact(body);
  // Approval proofs are intentionally returned to the authenticated local client.
  // They remain redacted from logger events and every other response field.
  if (typeof body?.approval?.token === 'string' && safeBody?.approval) safeBody.approval.token = body.approval.token;
  if (typeof body?.sessionProof === 'string' && safeBody && typeof safeBody === 'object') safeBody.sessionProof = body.sessionProof;
  // 见 restorePublicResponseFields：只恢复公开协议字段，其余仍按密钥擦除。
  restorePublicResponseFields(body, safeBody);
  return safeBody;
}

function sendJson(response, status, body, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.writeHead(status);
  response.end(JSON.stringify(publicResponseBody(body)));
}

function normalizeLibraryPart(value) {
  if (!value || typeof value !== 'object') return undefined;
  const name = String(value.name || '').slice(0, 200);
  const uuid = String(value.uuid || '').slice(0, 160);
  const libraryUuid = String(value.libraryUuid || '').slice(0, 160);
  return name && uuid && libraryUuid ? { name, uuid, libraryUuid } : undefined;
}

/**
 * 器件库搜索结果的归一化。
 *
 * 真机教训（2026-10-16）：旧实现把桥返回的 `{result:[...]}` **当成一个器件**处理，
 * 于是"一次搜索 0 个候选"——而同一时刻直接在 EDA 里调 `lib_Device.getByLcscIds('C45924513')`
 * 明明返回 1 条（封装 SENSORM-SMD_SHT40-AD1B 与板子 BOM 一致）。也就是说
 * "AI 自主从嘉立创匹配器件与封装"这条链断在**归一化**，不在 EDA、也不在网络。
 *
 * 同时按真机字段重映射：EDA 给的是扁平字段 + `otherProperty` 商城属性
 * （`supplierId`=立创编号、`footprintName`、`symbolName`、`model3DName`、
 * `otherProperty['Supplier Part'|'Supplier Footprint'|'Datasheet'|'JLCPCB Part Class']`…）。
 */
const DEVICE_ENVELOPE_KEYS = ['result', 'data', 'candidates', 'items', 'devices', 'list', 'rows'];

function unwrapDevicePayload(raw) {
  let current = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== 'object') return [];
    const key = DEVICE_ENVELOPE_KEYS.find((name) => Array.isArray(current[name]));
    if (!key) break;
    current = current[key];
  }
  if (Array.isArray(current)) return current;
  return current && typeof current === 'object' ? [current] : [];
}

function normalizeDeviceCandidates(raw) {
  const part = (name, uuid, libraryUuid) => (name && uuid ? { name: String(name).slice(0, 200), uuid: String(uuid).slice(0, 160), libraryUuid: String(libraryUuid || '').slice(0, 160) || undefined } : undefined);
  return unwrapDevicePayload(raw).slice(0, 20).map((item) => {
    const property = (key) => {
      const value = item?.otherProperty?.[key];
      return typeof value === 'string' ? value.trim() : '';
    };
    const uuid = String(item?.uuid || '').slice(0, 160);
    const libraryUuid = String(item?.libraryUuid || item?.classification?.libraryUuid || '').slice(0, 160);
    const supplierId = String(item?.supplierId || '').trim();
    return {
      // 名字：EDA 顶层 name 常为空串，真名在商城属性或厂商料号里（真机实测）。
      name: String(item?.name || '').trim().slice(0, 200) || property('LCSC Part Name') || String(item?.manufacturerId || '').trim() || String(item?.footprintName || '').trim() || uuid,
      uuid,
      libraryUuid,
      // 立创料号是"器件身份"的锚点：supplierId 就是 C 编号。
      lcscId: (/^C\d+$/i.test(supplierId) ? supplierId.toUpperCase() : property('Supplier Part')) || null,
      manufacturer: String(item?.manufacturer || '').trim() || property('Manufacturer') || null,
      manufacturerPart: String(item?.manufacturerId || '').trim() || property('Manufacturer Part') || null,
      description: String(item?.description || item?.otherProperty?.Name || '').slice(0, 500),
      supplier: String(item?.supplier || '').trim() || property('Supplier') || null,
      supplierFootprint: property('Supplier Footprint') || null,
      jlcClass: property('JLCPCB Part Class') || null,
      datasheet: property('Datasheet') || null,
      symbol: normalizeLibraryPart(item?.symbol) ?? part(item?.symbolName, item?.symbolUuid, libraryUuid),
      footprint: normalizeLibraryPart(item?.footprint) ?? part(item?.footprintName, item?.footprintUuid, libraryUuid),
      model3D: normalizeLibraryPart(item?.model3D) ?? part(item?.model3DName, item?.model3DUuid, libraryUuid),
      symbolName: String(item?.symbolName || '').slice(0, 200) || null,
      footprintName: String(item?.footprintName || '').slice(0, 200) || null,
      model3DName: String(item?.model3DName || '').slice(0, 200) || null,
      otherProperty: item?.otherProperty && typeof item.otherProperty === 'object' ? Object.fromEntries(Object.entries(item.otherProperty).slice(0, 30).map(([key, value]) => [String(key).slice(0, 80), ['string', 'number', 'boolean'].includes(typeof value) ? value : String(value).slice(0, 200)])) : {},
    };
  }).filter((item) => item.name && item.uuid && item.libraryUuid);
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE', status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求JSON格式无效'), { code: 'INVALID_JSON', status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

/**
 * 任务 journal 的落盘位置。可用 CIRCUITPILOT_JOB_JOURNAL 覆盖（测试/多实例用）。
 */
const JOB_JOURNAL_PATH = process.env.CIRCUITPILOT_JOB_JOURNAL || join(homedir(), 'Library', 'Application Support', 'CircuitPilot', 'eda-jobs.jsonl');

/**
 * 运行时的 EDA 桥接客户端：**任务状态权威落盘**。
 *
 * 这样"谁死了"都不影响记录的真实性：渲染进程换会话 → 在途任务被收口为 interrupted；
 * 运行时自己重启 → 从 journal 恢复，在途收口、已完成连结果一起保留。
 * 任何时候都不会把"结果不可知"说成"完成"，更不会说成"0 项"。
 */
function createDurableBridgeClient(token = process.env.CIRCUITPILOT_BRIDGE_TOKEN || '') {
  try {
    const journal = createFileJournal(JOB_JOURNAL_PATH);
    const { store, interrupted } = EdaJobStore.recover({ journal });
    if (interrupted.length) console.warn(`[circuitpilot] 运行时重启：${interrupted.length} 个在途 EDA 任务已如实标记为 interrupted（不伪装成完成）`);
    return new BridgeClient({ jobStore: store, token });
  } catch (error) {
    console.warn('[circuitpilot] 任务 journal 不可用，退回进程内状态:', error?.message);
    return new BridgeClient({ token });
  }
}

/** 本机是否已经有桥进程（包括用户手动启动的旧实例）。 */
async function anyBridgeRunning() {
  for (const port of BRIDGE_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      if (!response.ok) continue;
      const health = await response.json();
      if (health?.service === 'easyeda-bridge') return true;
    } catch { /* 端口无服务 */ }
  }
  return false;
}

/**
 * 随应用启动桥接守护进程。普通用户不需要再手动执行 `node bridge-server.mjs`。
 * token 只通过环境变量传给子进程，既不出现在 argv，也不写盘；桥只绑定 127.0.0.1。
 */
function spawnBridgeServer(token) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'bridge-server.mjs');
  if (!existsSync(script)) {
    console.warn('[circuitpilot] 桥接守护进程缺失（bridge-server.mjs），EDA 连接将不可用');
    return null;
  }
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      CIRCUITPILOT_BRIDGE_TOKEN: token,
      CIRCUITPILOT_RUNTIME_PID: String(process.pid),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.once('error', (error) => console.warn('[circuitpilot] 桥接守护进程启动失败:', error?.message));
  child.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') console.warn(`[circuitpilot] 桥接守护进程退出 code=${code} signal=${signal}`);
  });
  return child;
}

function isLoopbackHost(hostHeader) {
  return /^(127\.0\.0\.1|localhost|\[::1\]|tauri\.localhost)(:\d+)?$/i.test(String(hostHeader || ''));
}

export function createRuntimeServer({ keychain = new MacKeychain(), bridge = null, bridgeToken = process.env.CIRCUITPILOT_BRIDGE_TOKEN || '', diagnostics = systemDiagnostics, chat = null, design = null, pcb = null, production = null, evidence = null, gui = null, simulationRun = runSimulationDefault, alternativeSearch = null, runtimeToken = process.env.CIRCUITPILOT_RUNTIME_TOKEN } = {}) {
  if (!bridge) bridge = createDurableBridgeClient(bridgeToken);
  const injectedToken = typeof runtimeToken === 'string' && runtimeToken.length >= 16;
  // Tauri 壳层通过环境变量注入令牌时，令牌完全不经由 HTTP 分发，因此彻底关闭
  // HTTP 令牌发放：此时本机任何进程（哪怕伪造 Origin）都无法再通过 /api/health 领到令牌，
  // 只能由持有令牌的 WebView 发起请求。这是对“本机同用户进程可伪造 Origin”这一残余风险的收口。
  // 独立开发模式（npm run dev:full，没有注入令牌）才回退到随机令牌 + 受信 Origin 引导。
  const httpTokenIssuance = !injectedToken;
  const sessionToken = injectedToken ? runtimeToken : crypto.randomBytes(24).toString('base64url');
  // 业务状态落盘目录：生产放行/执行历史/（后续）项目与聊天共用同一个 state 目录，
  // 便于整体备份与迁移；单文件损坏只影响对应子系统，不互相带崩。
  const stateDir = process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts/state');
  // C1：项目/需求/器件/资料等业务状态的权威副本。前端仍保留 localStorage 作离线缓存，
  // 但跨浏览器/清缓存后的恢复以 Runtime 这份原子写文件为准（读损坏会抛 STORE_*，不假装空状态）。
  const projectStateStore = createProjectStateStore({ file: join(stateDir, 'project-state.json') });
  // C6：项目级状态隔离——每个项目一个文件；读取时若项目文件缺失，从聚合状态迁移出该项目的只读切片。
  const projectScopedStore = createProjectScopedStore({ dir: join(stateDir, 'project-states'), legacyStore: projectStateStore });
  // C1：前端追溯三件套（版本/修改/审计）的权威副本；损坏抛 STORE_*，不假装空历史。
  const traceStateStore = createTraceStateStore({ file: join(stateDir, 'trace-state.json') });
  // C1：问题中心记录也落 Runtime；前端 localStorage 仅离线缓存。
  const issueStateStore = createIssueStateStore({ file: join(stateDir, 'issue-state.json') });
  // 统一批准账本（C2）：设计计划批准 + 自动化写板批准共用一个哈希链；损坏时降级为内存并大声记日志。
  const approvalLedger = (() => {
    try {
      return createApprovalLedger({ store: createJsonStore({ file: join(stateDir, 'approvals-ledger.json'), schemaVersion: 1, initial: () => ({ entries: [] }) }) });
    } catch (error) {
      logger.error('Approvals', '批准账本状态文件不可用，已降级为内存（重启后审计历史会丢）', { code: error?.code, message: error?.message });
      return createApprovalLedger();
    }
  })();

  // W3-03：知识库（本地 JSON 存储 + 检索/审核 API）。API 写入只能是 candidate，审核必须给 reviewedBy。
  const knowledgeStore = createKnowledgeStore({ root: join(stateDir, 'knowledge') });
  const knowledgeApi = createKnowledgeApi({ store: knowledgeStore });
  /**
   * 自定义模型 Provider 注册表：Runtime 是唯一权威持久化（${stateDir}/custom-providers.json），
   * 密钥不在这里——每个 Provider 一个独立钥匙串条目。
   * 读损坏/版本不符时 createJsonStore 抛 STORE_*：与其它子系统一致地**降级为内存 + 大声记日志**，
   * 而不是把"读失败"伪装成"没有自定义 Provider"继续放行（那会悄悄丢用户的全部配置）。
   */
  const customProvidersFile = join(stateDir, 'custom-providers.json');
  // 降级原因（null = 正常）。降级后写路由必须 fail-closed 拒绝：内存注册表的修改重启即丢，
  // 让用户以为"保存成功"比直接报错更糟；读路由仍然可用，只是显式标注不可用。
  let customProvidersDegraded = null;
  const customProviders = (() => {
    try {
      return new CustomProviderRegistry({ file: customProvidersFile, reservedIds: Object.keys(PROVIDERS) });
    } catch (error) {
      customProvidersDegraded = {
        code: error?.code || 'STORE_UNAVAILABLE',
        message: `自定义 Provider 状态文件不可用（${error?.code || 'STORE_UNAVAILABLE'}），已临时降级为内存模式：本次会话的新增/修改不会保存。请修复或移走 ${customProvidersFile} 后重启 Runtime。`,
      };
      logger.error('CustomProviders', '自定义模型 Provider 状态文件不可用，已降级为内存（重启后自定义 Provider 配置会丢）', { code: error?.code, message: error?.message });
      return new CustomProviderRegistry({ reservedIds: Object.keys(PROVIDERS) });
    }
  })();
  /** 自定义 Provider 写操作的前置门禁：状态文件坏掉时不接受"看起来成功"的修改。 */
  const assertCustomProvidersWritable = () => {
    if (!customProvidersDegraded) return;
    throw Object.assign(new Error(customProvidersDegraded.message), {
      code: 'CUSTOM_PROVIDER_STORE_UNAVAILABLE', status: 503, details: { storeCode: customProvidersDegraded.code, file: customProvidersFile },
    });
  };
  const chatManager = chat || (() => {
    try {
      // C1：聊天 transcript 落盘（重启后按历史重建线程）；损坏/不可写时降级为内存并大声记日志。
      return new ChatManager({ keychain, bridge, customProviders, transcriptStore: createJsonStore({ file: join(stateDir, 'chat-transcripts.json'), schemaVersion: 1, initial: () => ({ sessions: {} }) }) });
    } catch (error) {
      logger.error('Chat', '聊天 transcript 状态文件不可用，已降级为内存（重启后聊天记录会丢）', { code: error?.code, message: error?.message });
      return new ChatManager({ keychain, bridge, customProviders });
    }
  })();
  const designManager = design || (() => {
    try {
      return new DesignManager({ bridge, ledger: approvalLedger, store: createJsonStore({ file: join(stateDir, 'design-executions.json'), schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    } catch (error) {
      // 损坏/不可写时降级为内存：历史会丢，但当前这次写入的执行记录仍然完整返回，不伪造历史。
      logger.error('Design', '原理图执行历史状态文件不可用，已降级为内存（重启后历史会丢）', { code: error?.code, message: error?.message });
      return new DesignManager({ bridge, ledger: approvalLedger });
    }
  })();
  const pcbManager = pcb || (() => {
    try {
      return new PcbManager({ bridge, ledger: approvalLedger, store: createJsonStore({ file: join(stateDir, 'pcb-executions.json'), schemaVersion: 1, initial: () => ({ executions: [] }) }) });
    } catch (error) {
      logger.error('Pcb', 'PCB执行历史状态文件不可用，已降级为内存（重启后历史会丢）', { code: error?.code, message: error?.message });
      return new PcbManager({ bridge, ledger: approvalLedger });
    }
  })();
  /**
   * 通道 B：EDA GUI 执行器（CDP 受信任输入）。
   * 与桥接通道（eda.* 扩展 API）互补：铺铜/交互式连线/菜单对话框只能走这条。
   * 挂在运行时上而不是外部脚本，保证每次 GUI 操作都有统一的动作白名单、超时与读回校验。
   */
  const guiClient = gui || new EdaGuiClient();
  /** 自动化内核（Phase 0）：配方注册表 + 哈希链审计 + 双通道执行器。 */
  // B8：不可变发布版本目录（默认跟随状态目录；测试用 CIRCUITPILOT_RELEASES_DIR 隔离）。
  const releaseArchiveDir = process.env.CIRCUITPILOT_RELEASES_DIR
    || join(process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts/state'), 'releases');
  const releaseArchives = createReleaseArchiveStore({ dir: releaseArchiveDir });
  const automationRegistry = createDefaultRecipeRegistry();
  // E7：文件锁 → 跨进程（多开 runtime / 并行脚本）互斥；锁文件放在运行时状态目录。
  const automationRunLock = createRunLock({ file: join(stateDir, 'automation-run.lock') });
  // E7 中止：runId → AbortController。只允许中止“正在执行”的 run；结束后的 run 返回 409。
  const activeRunControllers = new Map();
  const automationRunCache = new Map();
  const automationRunCacheTtlMs = 10 * 60 * 1000;
  const automationJournal = createAutomationJournal();
  const automationApprovals = createApprovalStore({ journal: automationJournal, ledger: approvalLedger });
  const productionArtifactsRoot = new URL('../manufacturing/', import.meta.url).pathname;
  const productionStateFile = process.env.CIRCUITPILOT_STATE_FILE
    || join(process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts/state'), 'production.json');
  const productionManager = production || (() => {
    try {
      return new ProductionManager({
        artifactsRoot: productionArtifactsRoot,
        pcb: pcbManager,
        store: createJsonStore({ file: productionStateFile, schemaVersion: 1, initial: () => ({ plans: [], reviews: [] }) }),
      });
    } catch (error) {
      // 状态文件损坏/不可读时**大声降级为内存**：计划与终审会丢（重启后要重新签），
      // 但不会因为读不到文件就返回"通过"——这是 fail-closed 与可用性的折中。
      logger.error('Production', '生产状态文件不可用，已降级为内存（重启后计划/终审需重做）', { file: productionStateFile, code: error?.code, message: error?.message });
      return new ProductionManager({ artifactsRoot: productionArtifactsRoot, pcb: pcbManager });
    }
  })();
  /**
   * 证据落盘：DRC 报告 / 在线 DFM 回填 / 人工终审必须成为可复核的文件，
   * 而不是只活在某个 HTTP 响应或页面 state 里（刷新/重启/换人就没了）。
   */
  const evidenceRoot = process.env.CIRCUITPILOT_EVIDENCE_DIR || join(process.cwd(), 'artifacts/evidence');
  const evidenceStore = evidence || createEvidenceStore({ root: evidenceRoot });
  // W3-18：KMA 知识管理 Agent + 定时维护。只产 candidate；抓取走白名单；调度状态落 state。
  const knowledgeWebEnabled = process.env.CIRCUITPILOT_KNOWLEDGE_WEB !== 'off';
  const knowledgeManager = createKnowledgeManager({
    store: knowledgeStore,
    evidenceRoot,
    evidenceStore,
    webCollectors: knowledgeWebEnabled ? createPcbWebCollectors({ topics: DEFAULT_PCB_TOPICS }) : [],
  });
  const knowledgeIntervalHours = Number(process.env.CIRCUITPILOT_KNOWLEDGE_INTERVAL_HOURS ?? 24);
  const knowledgeInitialMinutes = Number(process.env.CIRCUITPILOT_KNOWLEDGE_INITIAL_MINUTES ?? 2);
  const knowledgeScheduler = createKnowledgeScheduler({
    manager: knowledgeManager,
    stateFile: join(stateDir, 'knowledge-agent.json'),
    intervalMs: Math.max(60 * 60 * 1000, (Number.isFinite(knowledgeIntervalHours) ? knowledgeIntervalHours : 24) * 60 * 60 * 1000),
    initialDelayMs: Math.max(60 * 1000, (Number.isFinite(knowledgeInitialMinutes) ? knowledgeInitialMinutes : 2) * 60 * 1000),
  });
  if (process.env.CIRCUITPILOT_KNOWLEDGE_AGENT !== 'off') {
    const schedulerStatus = knowledgeScheduler.start();
    logger.info('Knowledge', 'KMA scheduler started', { intervalMs: schedulerStatus.intervalMs, nextRunAt: schedulerStatus.nextRunAt });
  }

  // W3-20：RAG 混合检索（知识库条目 + 工程文档）；索引落 state，首次查询懒构建。
  // docs/knowledge 是 K1 通用工程知识（PCB 设计/原理图/元件）：结构化条目由
  // scripts/seed-knowledge-pcb.mjs 灌入，文档目录必须一并进语料，否则"有文档但检索不到"。
  const ragDirs = ['docs/knowledge'].filter((dir) => existsSync(join(process.cwd(), dir)));
  const ragStore = createRagStore({
    knowledgeStore,
    indexFile: join(stateDir, 'rag', 'index.json'),
    dirs: ragDirs,
    baseDir: process.cwd(),
  });

  // W5-03/W5-04：门禁服务（证据→G1~G6 裁决→归档→人工终审签字写哈希链账本）
  const gateService = createGateService({ evidenceStore, approvalLedger });
  /**
   * 原理图验收的"增强取证"公共选项：
   *  - ercDetail：EDA 扩展 API 只有聚合计数，逐条明细走 GUI 面板抓取（eda-erc-detail.mjs）；
   *  - loadSimulationEvidence：EDA 导不出 SPICE 网表时，回退引用本机已落盘的真实求解器证据。
   * 两件事都只在真机可用时生效；不可用时如实降级，绝不把"没有结论"包装成"通过"。
   */
  const simEvidenceMaxAgeMs = () => {
    const hours = Number(process.env.CIRCUITPILOT_SIM_EVIDENCE_MAX_AGE_HOURS);
    return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 24 * 3_600_000;
  };
  const acceptanceExtraOptions = {
    ercDetail: () => extractErcDetail({ gui: guiClient }),
    /**
     * 仿真证据回退必须校验"归属 + 新鲜度"：只取 latest() 可能引用到别的工程/改版前的旧证据。
     * 返回 {entry} 或 {rejected:[{reason, problems, entry}]}，由验收如实记录拒绝原因。
     */
    loadSimulationEvidence: async () => {
      const entry = evidenceStore.latest('spice-simulation');
      if (!entry) return { entry: null, rejected: [{ reason: '本机没有落盘的 SPICE 仿真证据' }] };
      let current = null;
      try { current = await currentEdaFingerprint(); } catch { current = null; }
      const freshness = assessEvidenceFreshness(entry, { current, maxAgeMs: simEvidenceMaxAgeMs() });
      if (!freshness.ok) {
        return {
          entry: null,
          rejected: [{ reason: '落盘仿真证据不满足归属/新鲜度要求', problems: freshness.problems, entry: { digest: entry.digest, savedAt: entry.savedAt, path: entry.path, fingerprint: entry.fingerprint ?? null } }],
        };
      }
      return { entry, freshness };
    },
  };
  /** 证据路由里统一把可选字符串字段收敛成 trim 后的字符串（避免 undefined/null 混进指纹）。 */
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  /**
   * Provider id 必须"存在"：内置声明表里，或自定义注册表里。
   * 未知 id 一律 404 —— 以前它会被直接透给钥匙串，用户看到的是一句
   * KEYCHAIN_PROVIDER_UNSUPPORTED，完全不知道是自己 id 写错了还是功能没实现。
   */
  const requireKnownProvider = (id) => {
    if (PROVIDERS[id]) return;
    if (customProviders.get(id)) return;
    throw customProviderNotFound(id);
  };

  /**
   * 确保 EDA 桥已发现且窗口已选中。
   * 真机教训：新加的 EDA 路由如果直接 bridge.execute，会因为没有先 discover 而 400 BRIDGE_NOT_FOUND——
   * 而"先 discover"这一步在其它路由里是散落重复写的，很容易漏。这里收成一个口子。
   */
  /**
   * 确保桥已发现、窗口已选中、工程已打开。
   *
   * 自愈（真机第 59 轮）：EDA 退出重开后桥会消失，`bridge.discover()` 只探测不拉起；
   * 即使桥恢复，EDA 也可能停在开始页（没有工程）。这里做两件事：
   *   1. 桥不可达时重新 discover 一次（端口可能变）；
   *   2. 工程没打开时用上次记录的工程 UUID 自动 openProject（只尝试一次，失败不假装成功）。
   */
  const ensureEdaSession = async () => {
    const connect = async () => {
      if (!bridge.port) await bridge.discover();
      if (!bridge.port) throw Object.assign(new Error('未发现EasyEDA Bridge（EDA 可能没启动或桥进程已退出，请重新连接 EDA）'), { code: 'BRIDGE_NOT_FOUND', status: 503 });
      return bridge.windows();
    };
    let windows;
    let reconnected = false;
    try {
      windows = await connect();
    } catch (error) {
      // 只有"桥真的断过"才进入自愈分支：EDA 重启会带走桥进程，此时重连后 EDA 多半停在开始页。
      if (error?.code === 'BRIDGE_UNREACHABLE' || error?.code === 'BRIDGE_TIMEOUT') {
        bridge.port = null;
        windows = await connect();
        reconnected = true;
      } else throw error;
    }
    if (windows.selectionRequired) throw Object.assign(new Error('检测到多个嘉立创EDA窗口，请先在高级控制中选择目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED', status: 409 });
    if (!bridge.selectedWindowId) throw Object.assign(new Error('没有已连接的嘉立创EDA窗口'), { code: 'EDA_WINDOW_NOT_FOUND', status: 409 });
    let reopened = null;
    // 自愈只发生在"桥断线重连"之后（或显式开启），不改变普通调用"当前工程没开就是没开"的语义。
    if (reconnected || process.env.CIRCUITPILOT_AUTO_REOPEN_PROJECT === '1') {
      try {
        const project = (await bridge.execute('project.current', {}))?.result;
        if (!(project?.uuid || project?.id)) throw Object.assign(new Error('EDA 没有打开工程'), { code: 'EDA_PROJECT_NOT_OPEN' });
      } catch {
        const remembered = lastProjectUuid();
        if (remembered) {
          try {
            await bridge.execute('project.open', { projectUuid: remembered });
            const project = (await bridge.execute('project.current', {}))?.result;
            const projectUuid = project?.uuid || project?.id || null;
            if (projectUuid) { rememberProject(projectUuid); reopened = { projectUuid, via: 'last-eda-project' }; }
          } catch (reopenError) {
            logger.warn('EDA', '自动重开上次工程失败（不影响窗口连接，后续路由会给出具体错误）', { projectUuid: remembered, message: String(reopenError?.message || reopenError).slice(0, 200) });
          }
        }
      }
    }
    return { windows, selectedWindowId: bridge.selectedWindowId, reopened };
  };

  /**
   * 当前 EDA 目标指纹（窗口 + 工程 + 文档）。批准绑定它，防止"批准 A 板、执行到 B 板"。
   */
  const currentEdaFingerprint = async () => {
    await ensureEdaSession();
    const project = (await bridge.execute('project.current', {})).result;
    const document = (await bridge.execute('document.current', {})).result;
    const projectUuid = project?.uuid || project?.id || project?.data?.[0]?.uuid || null;
    if (projectUuid) rememberProject(projectUuid);
    const documentUuid = document?.uuid || null;
    return {
      fingerprint: fingerprintOf({ windowId: bridge.selectedWindowId, projectUuid, documentUuid }),
      windowId: bridge.selectedWindowId,
      projectUuid,
      documentUuid,
    };
  };

  /** 读当前工程的 ERC 豁免（与 DRC 同样的工程级隔离规则）。 */
  const loadErcExemptionFileForCurrentProject = async () => {
    let projectUuid = null;
    try { projectUuid = (await currentEdaFingerprint()).projectUuid; } catch { projectUuid = null; }
    return loadScopedErcExemptionFile(projectUuid);
  };

  /** 读当前工程的 DRC 豁免（工程级文件；没有工程时用 global，回退旧版全局文件会带 warning）。 */
  const loadDrcExemptionFileForCurrentProject = async () => {
    let projectUuid = null;
    try { projectUuid = (await currentEdaFingerprint()).projectUuid; } catch { projectUuid = null; }
    return loadScopedExemptionFile(projectUuid);
  };

  /**
   * 工程写路由的统一闸门（写板批准）。
   *
   * 为什么必须放在服务端：以前只有"自动化配方"走批准校验，而 placement/apply、routing/apply、
   * routing/finish、routing/rollback、schematic/repair 这些工程写入路由是"浏览器说写就写"——
   * 页面上的批准按钮只是 UI 自觉，绕开页面直接打 HTTP 就能写板。
   * 现在真实写入（非 dryRun / 会保存）必须先消费一次服务端签发、绑定当前窗口+工程+文档指纹的
   * write 批准；dry-run 不写盘，不需要批准。
   */
  const requireWriteApproval = async (body, { recipeId = null } = {}) => {
    const approvalIds = Array.isArray(body?.approvalIds) ? body.approvalIds.map(String).filter(Boolean) : [];
    if (!approvalIds.length) {
      throw Object.assign(new Error('真实写入必须先由人工签发写板批准（先 POST /api/automation/approvals {scope:"write"}，再带 approvalIds）'), {
        code: 'AUTOMATION_APPROVAL_REQUIRED', status: 409, details: { scope: 'write' },
      });
    }
    const target = await currentEdaFingerprint();
    const resolved = automationApprovals.resolve({ approvalIds, requiredScopes: ['write'], recipeId, fingerprint: target.fingerprint });
    if (!resolved.ok) {
      throw Object.assign(new Error(`写板批准无效或与当前 EDA 目标不匹配：${resolved.missing.map((item) => item.reason).join('；')}`), {
        code: 'AUTOMATION_APPROVAL_INVALID', status: 409, details: { missing: resolved.missing, currentFingerprint: target.fingerprint },
      });
    }
    return target;
  };

  /** 打开原理图页面并等它成为活动文档（写入前必须确认文档身份，不能"大概打开了"）。 */
  const ensureSchematicActive = async ({ pageUuid = null, documentUuid = null, approvedTarget = null } = {}) => {
    await ensureEdaSession();
    const unwrapResult = (value) => (value?.result ?? value);
    if (pageUuid) {
      if (approvedTarget?.documentUuid && pageUuid !== approvedTarget.documentUuid) {
        throw Object.assign(new Error(`批准绑定的文档是 ${approvedTarget.documentUuid}，与请求写入的 ${pageUuid} 不一致，拒绝写入`), { code: 'AUTOMATION_APPROVAL_INVALID', status: 409 });
      }
      const opened = unwrapResult(await bridge.execute('schematic.open', { pageUuid, documentUuid }));
      if (!opened?.opened) throw Object.assign(new Error('原理图打不开，拒绝在不确定的文档上写入'), { code: 'EDA_DOCUMENT_OPEN_FAILED', status: 409 });
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const current = unwrapResult(await bridge.execute('document.current', {}));
      if (current?.documentType === 1) return current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw Object.assign(new Error('当前活动文档不是原理图，拒绝写入（请先打开原理图页面）'), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
  };

  /**
   * 打开 PCB 文档并**等它真的成为活动文档**。
   *
   * 真机教训（2026-10-13）：`pcb.open` 之后盲目 `setTimeout(800)` 就去读 PCB，
   * 会稳定拿到 `Bridge HTTP 500`（浏览器抢焦点时尤其明显；连续 3 次重试全失败），
   * 而同一命令"先打开 PCB 再读"用独立脚本就是 10ms 成功。
   * 所以这里按 `document.current` 轮询，而不是赌一个拍脑袋的时长。
   */
  /**
   * "上次用过的工程"要记住：嘉立创EDA 重启后停在首页、`project.current` 为 null，
   * 这时如果只依赖用户手点，AI 就整条链路瘫痪。记忆文件可用环境变量覆盖（测试必须隔离，
   * 否则会像 DRC 豁免那样出现"开发机绿、别的机器红"）。
   */
  const projectMemoPath = () => String(process.env.CIRCUITPILOT_PROJECT_MEMO || '').trim() || join(homedir(), '.circuitpilot', 'last-project.json');
  const rememberProject = (projectUuid) => {
    if (typeof projectUuid !== 'string' || !projectUuid) return;
    try {
      mkdirSync(join(projectMemoPath(), '..'), { recursive: true });
      writeFileSync(projectMemoPath(), JSON.stringify({ projectUuid, at: new Date().toISOString() }));
    } catch { /* 记忆失败不该影响主流程 */ }
  };
  const lastProjectUuid = () => {
    try { return JSON.parse(readFileSync(projectMemoPath(), 'utf8'))?.projectUuid || null; } catch { return null; }
  };

  const activatePcbDocument = async (pcbUuid) => {
    const opened = (await bridge.execute('pcb.open', { documentUuid: pcbUuid })).result;
    if (!opened?.opened) throw Object.assign(new Error('PCB 文档打不开'), { code: 'EDA_DOCUMENT_OPEN_FAILED', status: 409 });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      let current = null;
      try {
        current = (await bridge.execute('document.current', {})).result;
      } catch {
        // 轮询只是"更快知道可以读了"，读不到活动文档不该把整条路由判死：
        // 退回一次固定等待，让后面真正的读取去给出结论（能用就继续，不能用就报明确错误）。
        await new Promise((resolve) => setTimeout(resolve, 800));
        return opened;
      }
      if (current?.documentType === 3 && (!pcbUuid || current.uuid === pcbUuid)) return opened;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return opened;
  };

  /**
   * 自己找出"本项目的 PCB 文档"，不让用户手动切文档。
   *
   * 真机 A/B 实验（2026-10-13）：活动文档停在原理图、调用方又没给 pcbUuid 时，
   * `pcb.placement.read` 会稳定返回 `Bridge HTTP 500`（重试 3 次全失败）；
   * 同一个请求带上 pcbUuid 立刻 200（226ms）。也就是说"读不到"根本不是抖动，
   * 而是"没人告诉运行时该读哪块板"。`project.current` 的 `data[].pcb.uuid` 就是答案。
   */
  /**
   * 确保"PCB 就是当前活动文档"，否则所有 PCB 读写都会被自己的护栏挡成 409 PCB_DOCUMENT_REQUIRED。
   * 真机教训（2026-10-15）：EDA 重启后会停在上次之外的页签（甚至在首页），
   * 用户没点 PCB 时 AI 就"什么也做不了"——这不是护栏该有的行为，AI 应当自己把 PCB 打开并等到位。
   */
  const openProjectAndWait = async (projectUuid) => {
    const opened = (await bridge.execute('project.open', { projectUuid })).result;
    if (!opened?.opened) throw Object.assign(new Error(`工程打不开：${projectUuid}`), { code: 'EDA_PROJECT_OPEN_FAILED', status: 409 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = (await bridge.execute('project.current', {})).result;
      // 真机实测：`openProject` 立刻返回，但工程内容（data[]）是**异步加载**的——
      // 只看"data 是不是数组"会拿到空数组，紧接着 resolveProjectPcbUuid 就找不到板，
      // 表现为"工程打开了、PCB 却读不到"。必须等到真有条目才算就绪。
      if (Array.isArray(current?.data) && current.data.length > 0) { rememberProject(projectUuid); return current; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Object.assign(new Error(`工程已打开但 15 秒内没就绪：${projectUuid}`), { code: 'EDA_PROJECT_NOT_READY', status: 504 });
  };

  const ensurePcbDocument = async (pcbUuid) => {
    const current = (await bridge.execute('document.current', {})).result;
    if (Number(current?.documentType) === 3 && typeof current?.uuid === 'string' && current.uuid) {
      return { pcbUuid: current.uuid, activated: false };
    }
    let target = (typeof pcbUuid === 'string' && pcbUuid) ? pcbUuid : await resolveProjectPcbUuid();
    if (!target && !pcbUuid) {
      // EDA 重启后停在首页（project.current 为 null）：自己把上次的工程打开，而不是让用户去点。
      const project = (await bridge.execute('project.current', {})).result;
      const noProjectOpen = !project || (!project.uuid && !Array.isArray(project.data));
      const memo = lastProjectUuid();
      if (noProjectOpen && memo) {
        await openProjectAndWait(memo);
        target = await resolveProjectPcbUuid();
      }
    }
    if (!target) {
      throw Object.assign(new Error('当前工程里找不到 PCB 文档：请在嘉立创EDA 打开该工程的 PCB，或在请求里填 PCB 文档 UUID'), { code: 'PCB_DOCUMENT_REQUIRED', status: 409 });
    }
    await activatePcbDocument(target);
    return { pcbUuid: target, activated: true };
  };

  const resolveProjectPcbUuid = async () => {
    const project = (await bridge.execute('project.current', {})).result;
    rememberProject(project?.uuid);
    const boards = Array.isArray(project?.data) ? project.data.filter((item) => item?.itemType === 'Board') : [];
    const pcbs = boards.map((board) => board?.pcb).filter((pcb) => typeof pcb?.uuid === 'string' && pcb.uuid);
    if (pcbs.length === 0) return null;
    if (pcbs.length === 1) return pcbs[0].uuid;
    // 一个工程里有多块 PCB：优先"当前文档所属的那块板"，仍不确定才退回第一块，并且不假装确定。
    const current = (await bridge.execute('document.current', {})).result;
    const hit = boards.find((board) => board?.pcb?.uuid === current?.uuid
      || board?.schematic?.uuid === current?.uuid
      || (Array.isArray(board?.schematic?.page) && board.schematic.page.some((page) => page?.uuid === current?.uuid)));
    return hit?.pcb?.uuid ?? pcbs[0].uuid;
  };

  /**
   * 与 ensurePcbDocument 对称的缺口：`schematic.*` 只对**活动原理图**生效。
   * 真机实测（2026-10-16）：活动文档是 PCB 时跑原理图验收，架构如实报
   * ACCEPTANCE_NETLIST_WRONG_DOCUMENT（没有假装通过，这是对的），但"切到原理图"这件事应当由 AI 自己做。
   */
  const SCHEMATIC_DOCUMENT_TYPE = 1;
  const PCB_DOCUMENT_TYPE = 3;
  /**
   * 取"要检查/导出的原理图页面"。
   *
   * 真机教训（第 60 轮）：一个工程里可能有多块板（Board1 / Board1_1 / Board1_2），
   * 旧实现永远取**第一块板**的第一页。用户在 Board1_1 的 PCB 上点 ERC 时，
   * 结果检查的是 Board1 的原理图——那块板可能是空的，于是出现"ERC 全 0、ran:false"的假结果。
   * 现在若当前活动文档是某块板的 PCB，就优先用**同一块板**的原理图页面。
   */
  const resolveProjectSchematicUuid = async (preferredPcbUuid = null) => {
    const project = (await bridge.execute('project.current', {})).result;
    rememberProject(project?.uuid);
    const boards = Array.isArray(project?.data) ? project.data.filter((item) => item?.itemType === 'Board') : [];
    const schematicPagesOf = (board) => {
      const schematic = board?.schematic;
      const pages = [];
      // 页面 UUID 优先：原理图导出只对活动**页**生效（文档级 UUID 不一定能直接打开）。
      if (Array.isArray(schematic?.page)) for (const page of schematic.page) if (typeof page?.uuid === 'string' && page.uuid) pages.push(page.uuid);
      if (typeof schematic?.uuid === 'string' && schematic.uuid && !pages.includes(schematic.uuid)) pages.push(schematic.uuid);
      return pages;
    };
    if (preferredPcbUuid) {
      const preferred = boards.find((board) => {
        const pcb = board?.pcb || {};
        const uuids = [pcb.uuid, ...(Array.isArray(pcb.page) ? pcb.page.map((page) => page?.uuid) : [])].filter(Boolean);
        return uuids.includes(preferredPcbUuid);
      });
      if (preferred) {
        const pages = schematicPagesOf(preferred);
        if (pages.length) return pages[0];
      }
    }
    for (const board of boards) {
      const pages = schematicPagesOf(board);
      if (pages.length) return pages[0];
    }
    return null;
  };

  const ensureSchematicDocument = async (schematicUuid) => {
    const current = (await bridge.execute('document.current', {})).result;
    if (Number(current?.documentType) === SCHEMATIC_DOCUMENT_TYPE) return { schematicUuid: current.uuid ?? null, activated: false };
    // 当前是 PCB 时，优先切到"同一块板"的原理图，避免多板工程里检查错板（见 resolveProjectSchematicUuid）。
    const preferredPcbUuid = Number(current?.documentType) === PCB_DOCUMENT_TYPE ? (current?.uuid ?? null) : null;
    const target = (typeof schematicUuid === 'string' && schematicUuid) ? schematicUuid : await resolveProjectSchematicUuid(preferredPcbUuid);
    if (!target) throw Object.assign(new Error('当前工程里找不到原理图页面：请在嘉立创EDA 打开原理图，或在请求里填原理图 documentUuid'), { code: 'SCHEMATIC_DOCUMENT_REQUIRED', status: 409 });
    const opened = (await bridge.execute('schematic.open', { documentUuid: target, pageUuid: target })).result;
    if (!opened?.opened) throw Object.assign(new Error(`原理图页面打不开：${target}`), { code: 'SCHEMATIC_DOCUMENT_OPEN_FAILED', status: 409 });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const now = (await bridge.execute('document.current', {})).result;
      if (Number(now?.documentType) === SCHEMATIC_DOCUMENT_TYPE) return { schematicUuid: now.uuid ?? target, activated: true };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Object.assign(new Error('原理图已打开但 10 秒内没有成为活动文档'), { code: 'SCHEMATIC_DOCUMENT_NOT_READY', status: 504 });
  };

  /**
   * 读"原理图里要上板的器件"（真机教训：schematic.* 只对**活动文档**生效）。
   * 读法是轮询而不是死等固定毫秒：切过去先试读，空就每 200ms 再试，最多 10 次。
   */
  const readSchematicParts = async () => {
    const project = (await bridge.execute('project.current', {})).result;
    const boards = Array.isArray(project?.data) ? project.data.filter((item) => item?.itemType === 'Board') : [];
    const current = (await bridge.execute('document.current', {})).result;
    const matches = (board) => board?.pcb?.uuid === current?.uuid || board?.schematic?.uuid === current?.uuid
      || (Array.isArray(board?.schematic?.page) && board.schematic.page.some((page) => page?.uuid === current?.uuid));
    const board = boards.find(matches) ?? boards.find((item) => item?.schematic?.page?.length) ?? boards[0];
    const pageUuid = board?.schematic?.page?.[0]?.uuid ?? board?.schematic?.uuid ?? null;
    if (!pageUuid) return { designators: [], pageUuid: null, componentCount: 0 };
    await bridge.execute('schematic.open', { documentUuid: pageUuid });
    let items = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const list = (await bridge.execute('schematic.components', {})).result;
      items = Array.isArray(list) ? list : (Array.isArray(list?.components) ? list.components : []);
      if (items.length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { designators: [...new Set(items.filter((item) => item?.addIntoPcb === true && item?.designator).map((item) => item.designator))], pageUuid, componentCount: items.length };
  };

  /**
   * 读 PCB 放置数据：先确定要读哪块板（调用方没给就自己去工程里找），
   * 再确保它是活动文档，读失败就**重开一次再读**。
   */
  const readPcbPlacement = async (pcbUuid) => {
    const target = (typeof pcbUuid === 'string' && pcbUuid) ? pcbUuid : await resolveProjectPcbUuid();
    if (!target) {
      throw Object.assign(new Error('读不到 PCB 放置数据：当前工程里找不到 PCB 文档。请在嘉立创EDA 中打开该工程的 PCB，或在请求里填 PCB 文档 UUID。'), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
    }
    await activatePcbDocument(target);
    try {
      return { readback: (await bridge.execute('pcb.placement.read')).result, pcbUuid: target };
    } catch (error) {
      // 读失败就重开一次再读：真机实测桥会间歇性 500，重开+重读比把 500 原样抛给用户有用得多。
      await activatePcbDocument(target);
      try {
        return { readback: (await bridge.execute('pcb.placement.read')).result, pcbUuid: target };
      } catch (retryError) {
        throw Object.assign(new Error(`读不到 PCB 放置数据（${String(retryError?.code || 'ERROR')}）：已尝试打开 PCB 文档 ${target} 仍失败。`), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
      }
    }
  };

  /**
   * 布局审计的扩展证据：丝印文字（含包围盒）、封装名、铜焊盘。
   * 每一项都独立失败：缺一项就让对应规则 REVIEW，不能让整份审计因为一个读命令 500 而消失。
   */
  const readLayoutEvidence = async (pcbUuid, knownCopper = null) => {
    const readOptional = async (command, args) => {
      try { return (await bridge.execute(command, args)).result ?? null; } catch (error) { return null; }
    };
    const copper = knownCopper ?? await readOptional('pcb.copper.read', {});
    const texts = await readOptional('pcb.texts.detail', {});
    const pads = await readOptional('pcb.pads.read', { pcbUuid });
    return { texts, pads, copper };
  };

  /**
   * 收集门禁所需的全部证据：body 里给了的用给的（离线可复现、界面可缓存），缺的才去实机读。
   * 抽成函数是为了让"下单前闸门"和"产出决策"共用同一套取证——两处各写一遍必然漂移，
   * 而漂移的后果是"界面说能下单、导出脚本说不能"这种最难查的分歧。
   */
  /**
   * 「本次正式导出将要覆盖的自产草稿产物」路径（第 50 轮接线）。
   * 只在请求正式产出（requested==='final'）时才把**本目录内**的草稿产物视为"将被替换"，
   * 目录外的草稿一律不算——避免"随便放个草稿进来就能绕过闸门"。
   */
  const selfDraftReplacedPaths = (body = {}) => {
    if (body?.requested !== 'final') return [];
    const dir = typeof body.artifactsDir === 'string' && body.artifactsDir.trim() ? body.artifactsDir : join(process.cwd(), 'deliverables');
    if (!existsSync(dir)) return [];
    const prefixes = ['GERBER_', 'BOM_', 'CPL_', 'STEP_'];
    return readdirSync(dir)
      .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)) && /DRAFT|NOT-FOR-ORDER/i.test(name))
      .map((name) => join(dir, name));
  };

  /**
   * 第 61 轮：放行门可显式消费"本机落盘的 SPICE 仿真证据"。
   *
   * 输入（`body.acceptanceExtraOptions.simulationEvidence`，兼容顶层 `body.simulationEvidence`）：
   *   - 字符串：本机 JSON 文件路径（T3 的 artifacts/spice/simulation-evidence-*.json）；
   *   - 对象：同形状内联证据。
   *
   * 为什么必须 fail-closed：这份证据只覆盖关键子电路，而且可能是**别的工程/上一版网表**跑出来的。
   * "文件存在"不等于"这块板被仿真过"。这里依次校验：可读 → kind/schema → 新鲜度 → 数值 →
   * 与当前工程/原理图页/实时网表 sha256 的绑定。任何一项拿不到或不符都返回 rejected，
   * 由闸门映射成 unknown/blocked，绝不默认当通过。
   */
  const readReleaseSimulationEvidenceSource = (input) => {
    if (input && typeof input === 'object' && !Array.isArray(input)) return { value: input, path: null };
    if (typeof input !== 'string' || !input.trim()) return { error: 'simulationEvidence 必须是本机 JSON 证据文件路径，或同形状对象' };
    const path = resolvePath(input.trim());
    if (!existsSync(path)) return { error: `仿真证据文件不存在：${path}` };
    let content;
    try { content = readFileSync(path, 'utf8'); } catch (error) { return { error: `仿真证据文件不可读：${String(error?.message || error).slice(0, 160)}` }; }
    try { return { value: JSON.parse(content), path }; } catch (error) { return { error: `仿真证据不是合法 JSON：${String(error?.message || error).slice(0, 160)}` }; }
  };

  /** 归一化并校验一份 T3 仿真证据；返回 {simulation} 或 {rejected:[{code,reason,...}]}。 */
  const validateReleaseSimulationEvidence = ({ input, current = null, pageUuid = null, targetPcbUuid = null, liveNetlistSha256 = null, currentError = null }) => {
    const invalid = (reason, extra = {}) => ({ rejected: [{ code: RELEASE_CODES.SIMULATION_EVIDENCE_INVALID, reason, ...extra }] });
    const unbound = (reason, extra = {}) => ({ rejected: [{ code: RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND, reason, ...extra }] });
    const source = readReleaseSimulationEvidenceSource(input);
    if (source.error) return invalid(source.error);
    const evidence = source.value;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return invalid('仿真证据必须是 JSON 对象');
    const evidencePath = source.path ?? (typeof evidence.path === 'string' ? evidence.path : null);
    if (evidence.kind !== 'spice-simulation-evidence') return invalid(`仿真证据 kind 必须是 spice-simulation-evidence，实际为 ${JSON.stringify(evidence.kind ?? null)}`, { evidencePath });
    if (evidence.status !== 'ok') return invalid(`仿真证据 status=${JSON.stringify(evidence.status ?? null)}：只有 status=ok 的完整证据才能被消费`, { evidencePath });
    const generatedAt = Date.parse(evidence.generatedAt || '');
    if (!Number.isFinite(generatedAt)) return invalid('仿真证据缺少可解析的 generatedAt：无法判断是否过期', { evidencePath });
    const ageMs = Date.now() - generatedAt;
    const maxAgeMs = simEvidenceMaxAgeMs();
    if (ageMs < -5 * 60_000) return invalid('仿真证据 generatedAt 在未来：时间戳不可信，不能当证据', { evidencePath });
    if (ageMs > maxAgeMs) return invalid(`仿真证据已 ${Math.round((ageMs / 3_600_000) * 10) / 10} 小时（阈值 ${Math.round(maxAgeMs / 3_600_000)} 小时）：必须重新跑仿真，不能拿旧证据放行`, { evidencePath });

    const netlist = evidence.netlist && typeof evidence.netlist === 'object' ? evidence.netlist : null;
    if (!netlist) return invalid('仿真证据缺少 netlist 段：无法确认它来自哪份网表', { evidencePath });
    const netlistSha256 = typeof netlist.sha256 === 'string' ? netlist.sha256.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(netlistSha256)) return invalid('仿真证据 netlist.sha256 缺失或不是 64 位十六进制', { evidencePath });
    if (netlist.parseable === false) return invalid('仿真证据标注 netlist.parseable=false：网表没有被解析成功', { evidencePath });
    if (!(Number(netlist.componentCount) > 0)) return invalid('仿真证据 netlist.componentCount 无效（≤0）：等于没有真实网表', { evidencePath });
    const runs = Array.isArray(evidence.runs) ? evidence.runs : [];
    if (!runs.length) return invalid('仿真证据没有 runs：没有真实求解器执行记录，不能当仿真结果', { evidencePath });
    const failedRuns = runs.filter((run) => !Number.isInteger(run?.exitCode) || run.exitCode !== 0);
    if (failedRuns.length) return invalid(`仿真证据有 ${failedRuns.length} 个求解器 run 非 0 退出：${failedRuns.map((run) => `${run?.kind ?? '?'}:exit${run?.exitCode ?? '?'}`).join('、')}`, { evidencePath });
    const numericValues = [];
    const results = evidence.results && typeof evidence.results === 'object' ? evidence.results : null;
    if (results) for (const group of Object.values(results)) {
      if (!group || typeof group !== 'object') continue;
      for (const value of Object.values(group)) if (typeof value === 'number' && Number.isFinite(value)) numericValues.push(value);
    }
    if (!results || !numericValues.length) return invalid('仿真证据没有可复核的数值结果（results 为空或没有有限数）：不能声称跑出了结论', { evidencePath });

    // ---- 绑定：证据必须属于"当前工程 + 当前原理图页/当前网表" ----
    const evidenceProjectUuid = text(evidence.environment?.project?.projectUuid) || text(evidence.environment?.expectedProjectUuid) || null;
    if (!evidenceProjectUuid) return unbound('仿真证据没有记录工程 UUID：无法确认它属于当前工程', { evidencePath });
    const currentProjectUuid = text(current?.projectUuid) || null;
    if (!currentProjectUuid) return unbound(`无法读取当前工程指纹${currentError ? `（${currentError}）` : ''}：不确认归属就当没有证据（fail-closed）`, { evidencePath, binding: { projectUuid: evidenceProjectUuid, currentProjectUuid: null } });
    if (evidenceProjectUuid !== currentProjectUuid) return unbound(`仿真证据属于工程 ${evidenceProjectUuid}，当前工程是 ${currentProjectUuid}：这是别的工程的证据`, { evidencePath, binding: { projectUuid: evidenceProjectUuid, currentProjectUuid } });
    const evidencePageUuid = text(evidence.environment?.project?.pageUuid) || text(evidence.environment?.targetPageUuid) || null;
    const requestedPage = text(pageUuid) || null;
    const pageMatched = Boolean(evidencePageUuid && requestedPage && evidencePageUuid === requestedPage);
    if (evidencePageUuid && requestedPage && !pageMatched) return unbound(`仿真证据属于原理图页 ${evidencePageUuid}，本次请求的原理图页是 ${requestedPage}：页不一致`, { evidencePath, binding: { projectUuid: evidenceProjectUuid, pageUuid: evidencePageUuid, requestedPage } });
    const liveSha = text(liveNetlistSha256).toLowerCase() || null;
    const netlistSha256MatchedLive = Boolean(liveSha && liveSha === netlistSha256);
    if (liveSha && !netlistSha256MatchedLive) {
      return unbound(`仿真证据网表 sha256=${netlistSha256.slice(0, 12)}… 与当前实时导出网表 ${liveSha.slice(0, 12)}… 不一致：证据不是这块板当前版本的网表`, { evidencePath, binding: { projectUuid: evidenceProjectUuid, netlistSha256, liveNetlistSha256: liveSha } });
    }
    if (!pageMatched && !netlistSha256MatchedLive) {
      return unbound('仿真证据既没有匹配的原理图页、也没有可与当前实时网表对照的 sha256：无法确认属于当前设计（fail-closed）', { evidencePath, binding: { projectUuid: evidenceProjectUuid, pageUuid: evidencePageUuid, requestedPage } });
    }

    const deck = evidence.deck && typeof evidence.deck === 'object' ? evidence.deck : {};
    const edaNetlistAvailable = evidence.edaSimulationNetlist?.available === true;
    const subcircuit = text(deck.subcircuit) || '关键子电路';
    const simulation = {
      evidencePath,
      evidenceKind: evidence.kind,
      evidenceHash: netlistSha256,
      source: 'T3 外部网表 + ngspice 求解器',
      solver: 'ngspice',
      scopeNote: `${subcircuit}；不是整板/全功能仿真`,
      generatedAt: new Date(generatedAt).toISOString(),
      // 覆盖范围永远不是整板：T3 deck 是从真实网表里挑出的子电路；EDA 侧整板 SPICE 网表导不出时更明确。
      partial: true,
      coverage: {
        subcircuit,
        decks: Array.isArray(deck.decks) ? deck.decks.length : 0,
        usedComponents: Array.isArray(deck.usedComponents) ? deck.usedComponents.length : 0,
        usedNets: Array.isArray(deck.usedNets) ? deck.usedNets.length : 0,
        edaSimulationNetlistAvailable: edaNetlistAvailable,
        edaSimulationNetlistReason: evidence.edaSimulationNetlist?.reason ?? null,
        componentCount: Number(netlist.componentCount),
        netCount: Number.isFinite(Number(netlist.netCount)) ? Number(netlist.netCount) : null,
        runs: runs.map((run) => ({ kind: run.kind ?? null, exitCode: run.exitCode })),
      },
      binding: {
        projectUuid: evidenceProjectUuid,
        pageUuid: evidencePageUuid,
        netlistSha256,
        liveNetlistSha256: liveSha,
        netlistSha256MatchedLive,
        pageMatched,
        targetPcbUuid: text(targetPcbUuid) || null,
        verifiedAt: new Date().toISOString(),
      },
      netlist: { sha256: netlistSha256, componentCount: Number(netlist.componentCount), netCount: Number.isFinite(Number(netlist.netCount)) ? Number(netlist.netCount) : null },
    };
    return { simulation };
  };

  /**
   * 归一化放行门收到的 DRC 输入，并保留**证据绑定信息**（第 61 轮）。
   *
   * 支持两种真实形状：
   *   - 裸 DRC 报告（normalizeDrcReport 的输入）；
   *   - 证据库条目 {kind:'drc-report', fingerprint:{pcbUuid}, payload:{report}}——
   *     这种形状以前会被 normalizeDrcReport 判成"结构不可识别"，绑定信息也随之丢失。
   * 绑定字段放在 normalized.binding，gateDrc 用它判断"是不是当前这块板"。
   */
  const normalizeReleaseDrcReport = (raw) => {
    const record = raw && typeof raw === 'object' && raw.kind === 'drc-report' && raw.payload && typeof raw.payload === 'object' ? raw : null;
    const reportSource = record?.payload?.report ?? (raw?.payload && typeof raw.payload === 'object' && Object.prototype.hasOwnProperty.call(raw.payload, 'report') ? raw.payload.report : raw);
    const normalized = normalizeDrcReport(reportSource);
    normalized.binding = {
      pcbUuid: text(record?.fingerprint?.pcbUuid ?? raw?.fingerprint?.pcbUuid ?? raw?.pcbUuid ?? raw?.payload?.pcbUuid) || null,
      projectUuid: text(record?.fingerprint?.projectUuid ?? raw?.fingerprint?.projectUuid ?? raw?.projectUuid) || null,
      savedAt: text(record?.savedAt ?? raw?.savedAt) || null,
      digest: text(record?.digest ?? raw?.digest) || normalized.digest || null,
    };
    return normalized;
  };

  const gatherReleaseEvidence = async (body) => {

      const dir = typeof body.artifactsDir === 'string' && body.artifactsDir.trim() ? body.artifactsDir : join(process.cwd(), 'deliverables');
      const prefixes = { gerber: 'GERBER_', bom: 'BOM_', cpl: 'CPL_', step: 'STEP_' };
      const files = {};
      const draftChosen = {};
      if (existsSync(dir)) {
        // 确定性规则（第 46 轮修）：同一 kind 有多个同前缀文件时，**正式命名优先、草稿兜底**——
        // 原实现是"后命中者覆盖前者"，裁决会随 readdir 顺序而变（第 45 轮读出的不确定性缺陷）。
        for (const name of readdirSync(dir)) {
          for (const [kind, prefix] of Object.entries(prefixes)) {
            if (!name.startsWith(prefix)) continue;
            const isDraft = /DRAFT|NOT-FOR-ORDER/i.test(name);
            if (files[kind] && !(draftChosen[kind] && !isDraft)) continue;
            files[kind] = join(dir, name);
            draftChosen[kind] = isDraft;
          }
        }
      }
      if (!files.step) {
        // 真机教训（第 39–40 轮）：3D 路由 `POST /api/pcb/3d/export` 落盘在 `deliverables/pcb-3d/*.step`，
        // 文件名不以 `STEP_` 开头、也不在 artifactsDir 根目录（readdirSync 不递归），
        // 于是"真的产出了 10.9MB STEP，闸门却报缺 step 产物"。这里补一条明确的回退：取该目录最新的 .step。
        const stepDir = join(dir, 'pcb-3d');
        if (existsSync(stepDir)) {
          const candidates = readdirSync(stepDir).filter((name) => name.toLowerCase().endsWith('.step')).map((name) => join(stepDir, name));
          if (candidates.length) files.step = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        }
      }
      const artifacts = Array.isArray(body.artifacts) ? body.artifacts : collectArtifacts({ files });
      // 语义分清楚：**没传 = 请去实机读**；**显式传 null = 这条证据就没有**（照实报"不知道"，绝不因为读不到而放行）
      const provided = (key) => Object.prototype.hasOwnProperty.call(body, key);
      let acceptance = provided('acceptance') ? body.acceptance : null;
      let design = provided('design') ? body.design : null;
      let placementVerification = provided('placementVerification') ? body.placementVerification : null;
      // 当前目标 PCB：优先实机解析结果，其次请求里显式给的 uuid（全离线注入证据时只有后者）。
      let targetPcbUuid = text(body.pcbUuid) || null;
      // 界面往往拿不到 DRC 报告对象，只给一个本机报告路径；这里按路径读真报告，
      // 而不是"没给报告就当通过"——缺证据永远是 unknown/阻断。
      if (!body.drcReport && typeof body.drcReportPath === 'string' && body.drcReportPath) {
        const reportPath = resolvePath(body.drcReportPath);
        if (!existsSync(reportPath)) throw Object.assign(new Error(`DRC 报告文件不存在：${reportPath}`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        body.drcReport = JSON.parse(readFileSync(reportPath, 'utf8'));
      }
      if (!body.exemptions && typeof body.exemptionsPath === 'string' && body.exemptionsPath) {
        const exemptionsPath = resolvePath(body.exemptionsPath);
        if (!existsSync(exemptionsPath)) throw Object.assign(new Error(`豁免文件不存在：${exemptionsPath}`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        const parsedExemptions = JSON.parse(readFileSync(exemptionsPath, 'utf8'));
        // 形状归一化（第 56 轮）：接受 数组 / {exemptions:[...]}（模板形状）/ {items:[...]}（草稿形状）。
        // 不做这层归一化时，对象形状的文件在下面 `Array.isArray(body.exemptions)` 处会**静默失败**并回退到默认豁免文件，
        // 用户会以为"我明明填了却不生效"——静默忽略比报错更糟，所以这里宁可明确报错。
        const exemptionList = Array.isArray(parsedExemptions)
          ? parsedExemptions
          : (Array.isArray(parsedExemptions?.exemptions) ? parsedExemptions.exemptions : (Array.isArray(parsedExemptions?.items) ? parsedExemptions.items : null));
        if (!exemptionList) throw Object.assign(new Error('豁免文件必须是数组，或含 exemptions/items 数组的对象'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        body.exemptions = exemptionList;
      }
      if (!provided('acceptance') || !provided('design') || !provided('placementVerification')) {
        await ensureEdaSession();
        const bridgeExecute = (commandId, args) => bridge.execute(commandId, args);
        // 网络连通性核对需要 PCB 文档 UUID：**必须在切到原理图之前解析**（解析 PCB 会把活动文档切走）。
        // 不传的话验收里的 net-connectivity 只能跳过——2026-10-22 真机就是因此让"171 个空网络焊盘"的板子
        // 在门禁里拿到 schematic:pass。缺失时如实降级为"无法核对"，但能解析就一定要解析。
        let gatePcbUuid = text(body.pcbUuid) || ((await readPcbPlacement(null).catch(() => null))?.pcbUuid ?? null);
        /**
         * 产品修复（r54，两处真机复现的缺陷）：
         *  ① 多板工程且未给 pcbUuid 时，门禁会挑"当前/第一块 PCB"（本次挑到 2 层 LED 灯板），
         *     再拿 4 层主板的 Gerber/CPL 去比 → 误报 RELEASE_GERBER_COPPER_MISSING（4 vs 2）
         *     与 RELEASE_CPL_COORD_MISMATCH（偏差 13~45mm）。这不是设计问题，是门禁没绑定目标板。
         *  ② 未给 pageUuid 时 acceptance 不会打开原理图，直接判 RELEASE_SCHEMATIC_NOT_READY
         *     （documentType=3），等于"没读到就说原理图不过"。
         * 修法：多板且未显式指定 → fail-closed 409 列出板子让调用方选；唯一板 → 自动补齐 pcbUuid+pageUuid。
         */
        if (!text(body.pcbUuid) && !provided('design') && !provided('acceptance') && !provided('placementVerification')) {
          let boards = [];
          try {
            const projectInfo = (await bridge.execute('project.current')).result;
            boards = Array.isArray(projectInfo?.data)
              ? projectInfo.data.filter((item) => item?.itemType === 'Board' && text(item?.pcb?.uuid))
              : [];
          } catch { boards = []; }
          if (boards.length > 1) {
            throw Object.assign(new Error(`工程里有 ${boards.length} 块板（${boards.map((board) => `${board.name}:${board.pcb.uuid}`).join('、')}）：多板工程必须显式给 pcbUuid，否则门禁可能拿错板比对（本次就会把 4 层主板产物和 2 层 LED 灯板读回混在一起）。`), {
              code: 'EDA_TARGET_PCB_AMBIGUOUS',
              status: 409,
              details: { boards: boards.map((board) => ({ name: board.name, pcbUuid: board.pcb.uuid, schematicUuid: board?.schematic?.uuid ?? null })) },
            });
          }
          if (boards.length === 1) {
            body.pcbUuid = boards[0].pcb.uuid;
            gatePcbUuid = boards[0].pcb.uuid;
            const page = Array.isArray(boards[0]?.schematic?.page) ? boards[0].schematic.page.find((item) => text(item?.uuid)) : null;
            if (page?.uuid) body.pageUuid = page.uuid;
          }
        }
        // 门禁要读原理图与 PCB：调用方给出 uuid，运行时自己打开（否则很容易"读到空"而给出假结论）
        if (!provided('acceptance') && (body.pageUuid || body.documentUuid)) {
          const opened = (await bridge.execute('schematic.open', { pageUuid: body.pageUuid || null, documentUuid: body.documentUuid || null })).result;
          if (!opened?.opened) throw Object.assign(new Error('原理图打不开，拒绝用空网表给出结论'), { code: 'EDA_DOCUMENT_OPEN_FAILED', status: 409 });
          // 等"活动文档真的变成原理图"再继续。真机上切换标签后立刻导出会拿到空网表，
          // 盲等固定时长同样不可靠——所以轮询 document.current（1~6ms 一次）。
          let activated = false;
          for (let attempt = 0; attempt < 25; attempt += 1) {
            const current = (await bridge.execute('document.current', {})).result;
            if (current?.documentType === 1) { activated = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (!activated) throw Object.assign(new Error('原理图已打开但没能成为活动文档（可能被其它窗口或对话框挡住），拒绝用空网表给出结论'), { code: 'EDA_DOCUMENT_OPEN_FAILED', status: 409 });
        }
        if (!acceptance) acceptance = await runSchematicAcceptance({ execute: bridgeExecute, plan: body.plan || null, skipSimulation: false, pcbUuid: gatePcbUuid });
        // 抓完原理图证据后**立刻**留下网表文本：下一步要切回 PCB 读 placement/铜层，
        // 切回后再 export 只会拿到空网表（历史上 design.designators 变空、BOM 位号校验被静默跳过的根因）。
        let gateNetlistText = '';
        if (!design) {
          try {
            gateNetlistText = (await bridge.execute('schematic.netlist.export', { fileName: 'circuitpilot-netlist', netlistType: 'EasyEDA', inlineLimit: 262144 }))?.result?.text || '';
          } catch { gateNetlistText = ''; }
        }
        const pcbPlacement = await readPcbPlacement(text(body.pcbUuid) || gatePcbUuid || null);
        const { readback } = pcbPlacement;
        // 实机解析出的 PCB 才是"当前目标"的权威来源（body.pcbUuid 可能没给）。
        if (pcbPlacement.pcbUuid) targetPcbUuid = pcbPlacement.pcbUuid;
        const copperCount = await bridge.execute('pcb.layers.copperCount').then((value) => value?.result ?? null).catch(() => null);
        // 板面证据里的坐标统一用**包围盒中心**（读回 xMm/yMm 是器件原点，非对称封装会差几毫米）。
        // 同时保留 originXMm/originYMm：EDA 导出的 CPL 用的正是器件原点，发布门禁做坐标比对时
        // 需要两套基准都试（否则 USB/座子/模组等非对称封装会稳定误报 CPL 坐标不一致）。
        const placement = (readback?.components || []).map((item) => { const center = placementCenterMm(item); return { ref: item.designator, xMm: center.xMm, yMm: center.yMm, originXMm: Number(item.xMm), originYMm: Number(item.yMm), rotationDeg: Number(item.rotationDeg) || 0 }; });
        if (!placementVerification) {
          placementVerification = verifyOutlinePlacement({
            placements: (readback?.components || []).filter((item) => item.bboxMm).map((item) => { const center = placementCenterMm(item); return { ref: item.designator, xMm: center.xMm, yMm: center.yMm, widthMm: Number(item.bboxMm.xMm), heightMm: Number(item.bboxMm.yMm), rotationDeg: Number(item.rotationDeg) || 0, side: item.layerSide || 'top' }; }),
            outline: parsePolygonSource(readback?.outline?.[0]?.source),
            edgeClearanceMm: body.edgeClearanceMm ?? 1, spacingMm: body.spacingMm ?? 0.5,
            overhangAllowances: body.overhangAllowances && typeof body.overhangAllowances === 'object' ? body.overhangAllowances : {},
          });
        }
        if (!design) {
          const netlistText = gateNetlistText;
          const parsed = parseEasyEdaNetlist(netlistText);
          design = {
            designators: (parsed?.components || []).map((item) => item.designator).filter(Boolean),
            placement, boardLayerCount: Number.isFinite(Number(copperCount)) ? Number(copperCount) : null,
            coordinateToleranceMm: body.coordinateToleranceMm,
            netlistSha256: netlistText ? crypto.createHash('sha256').update(netlistText).digest('hex') : null,
            outlineSource: readback?.outline?.[0]?.source ?? null,
          };
        }
      }
      /**
       * 第 61 轮：可选仿真证据接线（body.acceptanceExtraOptions.simulationEvidence 或 body.simulationEvidence）。
       * 只在"验收本身没有仿真结论"时注入；显式提供但校验不过 → 把具体原因塞进 acceptance.simulation.invalid，
       * 让 gate 的 simulation 子门如实报"证据不可用/绑定不符"，而不是笼统的 NOT_RUN 或假通过。
       */
      const simulationEvidenceInput = body?.acceptanceExtraOptions?.simulationEvidence ?? body?.simulationEvidence ?? null;
      let simulationEvidence = null;
      if (simulationEvidenceInput !== null && simulationEvidenceInput !== undefined) {
        let current = null;
        let currentError = null;
        try { current = await currentEdaFingerprint(); } catch (error) { currentError = String(error?.message || error).slice(0, 200); }
        const outcome = validateReleaseSimulationEvidence({
          input: simulationEvidenceInput,
          current,
          currentError,
          pageUuid: text(body.pageUuid) || text(body.documentUuid) || null,
          targetPcbUuid,
          liveNetlistSha256: design?.netlistSha256 ?? null,
        });
        if (outcome.rejected) {
          const reject = outcome.rejected[0];
          acceptance = {
            ...(acceptance || { ready: null, netlist: {}, findings: [] }),
            simulation: { invalid: true, code: reject.code, reason: reject.reason, evidencePath: reject.evidencePath ?? null, binding: reject.binding ?? null },
          };
          simulationEvidence = { consumed: false, rejected: outcome.rejected };
          logger.warn('Release', '提供的仿真证据未通过 fail-closed 校验，闸门将如实报不可用', { code: reject.code, reason: reject.reason });
        } else if (acceptance?.designChecks) {
          simulationEvidence = { consumed: false, rejected: [{ code: RELEASE_CODES.SIMULATION_EVIDENCE_INVALID, reason: '本次验收已有 EDA 侧设计检查点结论：显式仿真证据不覆盖它' }] };
        } else if (acceptance?.simulation) {
          simulationEvidence = { consumed: false, rejected: [{ code: RELEASE_CODES.SIMULATION_EVIDENCE_INVALID, reason: '验收报告已自带仿真结论：不重复覆盖' }] };
        } else {
          acceptance = { ...(acceptance || { ready: null, netlist: {}, findings: [] }), simulation: outcome.simulation };
          simulationEvidence = {
            consumed: true,
            evidencePath: outcome.simulation.evidencePath,
            evidenceHash: outcome.simulation.evidenceHash,
            partial: outcome.simulation.partial,
            binding: outcome.simulation.binding,
          };
          logger.info('Release', '放行门已消费本机仿真证据（仅关键子电路，覆盖范围如实标注）', { evidencePath: outcome.simulation.evidencePath, netlistSha256: outcome.simulation.netlist.sha256 });
        }
      }
    return {
      acceptance, artifacts, design, placementVerification,
      // 第 61 轮：DRC 输入归一化的同时保留绑定（pcbUuid），gateDrc 用它判断"是不是当前这块板"。
      drcReport: body.drcReport ? normalizeReleaseDrcReport(body.drcReport) : null,
      exemptions: Array.isArray(body.exemptions) ? body.exemptions : (await loadDrcExemptionFileForCurrentProject()).exemptions,
      writeback: body.writeback || null, userConfirmed: body.userConfirmed === true, pricing: body.pricing || null,
      targetPcbUuid, simulationEvidence,
    };
  };

  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const origin = request.headers.origin;
    const url = new URL(request.url || '/', `http://${RUNTIME_HOST}`);
    const method = request.method || 'GET';
    const requestId = crypto.randomUUID();

    // DNS rebinding / 伪造 Host：只接受回环主机名。
    if (!isLoopbackHost(request.headers.host)) {
      logger.warn('Http', 'Rejected non-loopback Host header', { host: request.headers.host, path: url.pathname });
      return sendJson(response, 403, runtimeError(Object.assign(new Error('Host未获授权'), { code: 'HOST_FORBIDDEN' })), null);
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      logger.warn('Http', 'Rejected untrusted origin', { origin, path: url.pathname });
      return sendJson(response, 403, runtimeError(Object.assign(new Error('Origin未获授权'), { code: 'ORIGIN_FORBIDDEN' })), null);
    }
    if (method === 'OPTIONS') {
      if (origin) response.setHeader('access-control-allow-origin', origin);
      // 允许的方法必须覆盖真实用到的动词。历史缺陷：这里漏了 PUT，浏览器预检直接失败，
      // 请求根本没离开 WebView，前端只能看到 fetch 抛错（表现为“保存不了 / Runtime 不可达”），
      // 而 Runtime 日志里连一条请求都不会出现。
      response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type,x-circuitpilot-token');
      response.setHeader('access-control-max-age', '600');
      if (origin) response.setHeader('vary', 'origin');
      response.writeHead(204);
      return response.end();
    }
    // 唯一公开路由是 GET /api/health，它本身也不会向未受信任的来源泄漏令牌。
    // 其余路由（含只读 GET）一律要求会话令牌，避免本机任意进程读取设计数据、日志和工具链路径。
    const isPublicRoute = method === 'GET' && url.pathname === '/api/health';
    if (!isPublicRoute && request.headers['x-circuitpilot-token'] !== sessionToken) {
      // 鉴权失败必须留下可审计痕迹（但不记录令牌本身）。此前这里静默返回 401，
      // 排查“前端为什么连不上”时日志里什么都看不到。
      logger.warn('Http', 'Rejected request with invalid session token', {
        method,
        path: url.pathname,
        // 注意：字段名不能包含 token/key/secret/credential，否则会被 logger 的
        // SECRET_KEYS 规则整段涂成 [REDACTED]，日志就失去诊断价值了。
        hadAuthHeader: typeof request.headers['x-circuitpilot-token'] === 'string',
        issuanceEnabled: httpTokenIssuance,
      });
      return sendJson(response, 401, runtimeError(Object.assign(new Error('Runtime会话令牌无效'), { code: 'RUNTIME_TOKEN_INVALID' })), origin);
    }

    try {
      let result;
      // C6：项目级路由用 URL 里的项目 id 做隔离键（声明在 try 内，避免全局变量）。
      let projectMatch = null;
      if (method === 'GET' && url.pathname === '/api/health') {
        // 令牌只发给受信任的浏览器来源（开发端口或 Tauri WebView），而且只有在
        // 令牌没有由壳层注入时才发放；不带 Origin 的本机进程（curl / 脚本 / 其它 App）
        // 永远拿不到写权限凭据。
        const trustedOrigin = typeof origin === 'string' && ALLOWED_ORIGINS.has(origin);
        result = { ok: true, service: 'circuitpilot-runtime', version: RUNTIME_VERSION, host: RUNTIME_HOST, ...(httpTokenIssuance && trustedOrigin ? { sessionProof: sessionToken } : {}) };
      } else if (method === 'GET' && url.pathname === '/api/project-state') {
        const loaded = projectStateStore.read();
        result = { ok: true, state: loaded.state, savedAt: loaded.savedAt };
      } else if (method === 'GET' && url.pathname === '/api/trace-state') {
        const loaded = traceStateStore.load();
        result = { ok: true, state: loaded.state, savedAt: loaded.savedAt, truncated: loaded.truncated, total: loaded.total };
      } else if (method === 'GET' && url.pathname === '/api/issue-state') {
        const loaded = issueStateStore.load();
        result = { ok: true, state: loaded.state, savedAt: loaded.savedAt, truncated: loaded.truncated, total: loaded.total };
      } else if (method === 'PUT' && url.pathname === '/api/issue-state') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
          throw Object.assign(new Error('问题状态请求体必须是 {state:{issues}}'), { code: 'ISSUE_STATE_INVALID', status: 400 });
        }
        const saved = issueStateStore.save(body.state);
        result = { ok: true, state: saved.state, savedAt: saved.savedAt, truncated: saved.truncated, total: saved.total };
      } else if (method === 'PUT' && url.pathname === '/api/trace-state') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
          throw Object.assign(new Error('追溯状态请求体必须是 {state:{versions,changes,audit}}'), { code: 'TRACE_STATE_INVALID', status: 400 });
        }
        const saved = traceStateStore.save(body.state);
        result = { ok: true, state: saved.state, savedAt: saved.savedAt, truncated: saved.truncated, total: saved.total };
      } else if (method === 'PUT' && url.pathname === '/api/project-state') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
          throw Object.assign(new Error('项目状态请求体必须是 {state:{...}}'), { code: 'PROJECT_STATE_INVALID', status: 400 });
        }
        const saved = projectStateStore.replace(body.state);
        result = { ok: true, state: saved.state, savedAt: saved.savedAt };
      } else if (method === 'GET' && url.pathname === '/api/projects') {
        // C6：项目列表 + 每个项目状态文件的独立性（savedAt/计数来自各自文件，不是全局状态）。
        const legacy = projectStateStore.read().state;
        const disk = new Map(projectScopedStore.list().map((item) => [item.projectId, item]));
        result = {
          ok: true,
          projects: (legacy.projects || []).map((project) => ({
            id: project.id, name: project.name, stage: project.stage ?? null, archived: project.archived === true,
            edaBound: Boolean(project.edaWorkspace?.projectUuid), savedAt: disk.get(project.id)?.savedAt ?? null,
            requirements: disk.get(project.id)?.requirements ?? null, components: disk.get(project.id)?.components ?? null, assets: disk.get(project.id)?.assets ?? null,
          })),
          scopedFiles: projectScopedStore.list().length,
        };
      } else if (method === 'GET' && (projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/state$/))) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const loaded = projectScopedStore.read(projectId);
        if (!loaded.state) {
          throw Object.assign(new Error(`项目不存在或没有可读状态：${projectId}`), { code: PROJECT_STATE_CODES.NOT_FOUND, status: 404, details: { projectId } });
        }
        result = { ok: true, projectId: loaded.projectId, state: loaded.state, savedAt: loaded.savedAt, source: loaded.source };
      } else if (method === 'PUT' && (projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/state$/))) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
          throw Object.assign(new Error('项目状态请求体必须是 {state:{...}}'), { code: PROJECT_STATE_CODES.INVALID, status: 400 });
        }
        const saved = projectScopedStore.replace(projectId, body.state);
        result = { ok: true, projectId: saved.projectId, state: saved.state, savedAt: saved.savedAt, tagged: saved.tagged };
      } else if (method === 'GET' && (projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/binding\/verify$/))) {
        /**
         * C6：EDA 窗口与项目绑定校验（只读）。
         * 多项目并行时最容易犯的错：在"项目 A"的页面里对 EDA 当前打开的"项目 B"签发写板批准。
         * 这里把项目登记的 edaWorkspace 与窗口真实值逐项比对，对不上就如实列出 mismatches；
         * 项目未绑定则不碰 EDA 会话（不制造副作用），直接返回 bound:false + 指引。
         */
        const projectId = decodeURIComponent(projectMatch[1]);
        const state = projectStateStore.read().state;
        const project = (state.projects || []).find((item) => item?.id === projectId) || null;
        if (!project) throw Object.assign(new Error(`项目不存在：${projectId}`), { code: PROJECT_STATE_CODES.NOT_FOUND, status: 404, details: { projectId } });
        const expected = project.edaWorkspace || null;
        let current = null;
        let currentError = null;
        const mismatches = [];
        if (!expected) {
          mismatches.push('项目尚未绑定 EDA 工程（edaWorkspace 为空）：请先在 EDA 页完成"绑定当前 EDA 工程"');
        } else {
          try {
            await ensureEdaSession();
            const unwrapValue = (value) => value?.result ?? value?.data ?? value;
            const [projectRaw, documentRaw, catalogRaw] = await Promise.all([
              bridge.execute('project.current'), bridge.execute('document.current'), bridge.execute('schematic.catalog').catch(() => null),
            ]);
            const projectData = unwrapValue(projectRaw);
            const document = unwrapValue(documentRaw);
            const catalog = unwrapValue(catalogRaw);
            const boards = Array.isArray(projectData?.data) ? projectData.data.filter((item) => item?.itemType === 'Board') : [];
            const board = boards.find((item) => String(item?.pcb?.uuid || '') === String(document?.uuid || '')) || boards[0] || null;
            const page = (Array.isArray(catalog?.pages) ? catalog.pages : []).find((item) => String(item?.parentSchematicUuid || '') === String(board?.schematic?.uuid || ''));
            current = {
              projectUuid: projectData?.uuid ? String(projectData.uuid) : null,
              boardName: board ? String(board.name || board.parentBoardName || '') : null,
              schematicUuid: board?.schematic?.uuid ? String(board.schematic.uuid) : null,
              schematicPageUuid: page?.uuid ? String(page.uuid) : null,
              pcbUuid: board?.pcb?.uuid ? String(board.pcb.uuid) : null,
              documentUuid: document?.uuid ? String(document.uuid) : null,
            };
            if (!current.projectUuid) mismatches.push('当前 EDA 窗口没有打开工程');
            else if (String(expected.projectUuid || '') !== current.projectUuid) mismatches.push(`工程不一致：项目绑定 ${expected.projectUuid || '(空)'}，当前窗口 ${current.projectUuid}`);
            if (expected.pcbUuid && current.pcbUuid && String(expected.pcbUuid) !== current.pcbUuid) mismatches.push(`PCB 文档不一致：项目绑定 ${expected.pcbUuid}，当前窗口 ${current.pcbUuid}`);
            if (expected.schematicPageUuid && current.schematicPageUuid && String(expected.schematicPageUuid) !== current.schematicPageUuid) mismatches.push(`原理图页不一致：项目绑定 ${expected.schematicPageUuid}，当前窗口 ${current.schematicPageUuid}`);
          } catch (error) { currentError = String(error?.code || error?.message || error).slice(0, 200); }
        }
        result = { ok: true, projectId, bound: Boolean(expected), expected, current, currentError, ready: Boolean(expected && current?.projectUuid && !mismatches.length && !currentError), mismatches };
      } else if (method === 'GET' && url.pathname === '/api/timeline') {
        // C3：执行 journal + 统一批准账本 + 证据索引合成的统一时间线（只读、有界、坏行暴露）。
        const runId = url.searchParams.get('runId');
        const limit = Number(url.searchParams.get('limit') || 200);
        result = buildTimeline({
          journalDir: automationJournal.dir,
          evidenceDir: evidenceRoot,
          approvalsFile: join(stateDir, 'approvals-ledger.json'),
          linksFile: join(stateDir, 'timeline-links.jsonl'),
          runId: runId ? String(runId) : null,
          limit: Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.trunc(limit))) : 200,
        });
      } else if (method === 'POST' && url.pathname === '/api/timeline/link') {
        // C3（剩余）：显式把证据 digest 关联到一次 run（append-only）；不存在的 run/证据 404，重复 409。
        const body = await readBody(request);
        let normalized;
        try { normalized = validateTimelineLink(body); } catch (error) { throw Object.assign(new Error(error?.message || '关联参数不合法'), { code: 'TIMELINE_LINK_INVALID', status: 400 }); }
        const runFile = join(automationJournal.dir, `${normalized.runId}.jsonl`);
        if (!existsSync(runFile)) throw Object.assign(new Error(`run 不存在或不在这台运行时上：${normalized.runId}`), { code: 'TIMELINE_LINK_RUN_NOT_FOUND', status: 404 });
        const index = buildEvidenceIndex({ dirs: [evidenceRoot] });
        const matched = (index.entries || []).find((item) => String(item?.digest || '').toLowerCase() === normalized.digest);
        if (!matched) throw Object.assign(new Error(`证据索引里找不到 digest：${normalized.digest}`), { code: 'TIMELINE_LINK_EVIDENCE_NOT_FOUND', status: 404 });
        const linksFile = join(stateDir, 'timeline-links.jsonl');
        const existing = loadTimelineLinks({ file: linksFile });
        if ((existing.links || []).some((item) => item.runId === normalized.runId && item.digest === normalized.digest)) {
          throw Object.assign(new Error('该 run 与证据已有关联（不重复登记）'), { code: 'TIMELINE_LINK_DUPLICATE', status: 409 });
        }
        result = { ok: true, link: appendTimelineLink({ file: linksFile, ...normalized }) };
      } else if (method === 'GET' && url.pathname === '/api/diagnostics/bundle') {
        // H5：可定位一次失败的诊断包（只读、脱敏、有界）。任一段取不到就如实写 unavailable，
        // 不因为某个存储坏了就让整份诊断包生成失败——那正是最需要诊断的时候。
        let diagnosticsPayload = null;
        try { diagnosticsPayload = await diagnostics(); } catch (error) { diagnosticsPayload = { available: false, reason: String(error?.message || error).slice(0, 200) }; }
        let evidenceIndex = null;
        try { evidenceIndex = buildEvidenceIndex({ dirs: [evidenceRoot] }); } catch (error) { evidenceIndex = { available: false, reason: String(error?.message || error).slice(0, 200) }; }
        let traceState = null;
        try { traceState = traceStateStore.load(); } catch (error) { traceState = { available: false, reason: String(error?.message || error).slice(0, 200) }; }
        let journalSummary = null;
        try { journalSummary = summarizeJournalRuns({ dir: automationJournal.dir }); } catch (error) { journalSummary = null; }
        const recentErrors = listEvents().filter((event) => event.level === 'error').slice(0, 20).map((event) => ({ at: event.timestamp, code: event.data?.code || 'RUNTIME_LOG', message: event.message, operation: event.module }));
        const bundle = buildDiagnosticBundle({
          version: RUNTIME_VERSION,
          diagnostics: diagnosticsPayload,
          evidence: evidenceIndex,
          trace: traceState,
          journal: journalSummary,
          recentErrors,
          runtime: { stateDirPresent: existsSync(stateDir) },
        });
        result = { ok: true, bundle };
      } else if (method === 'GET' && url.pathname === '/api/diagnostics') {
        result = { ok: true, diagnostics: await diagnostics() };
      } else if (method === 'POST' && url.pathname === '/api/diagnostics/failure') {
        // 统一失败诊断（D4）：把任意失败翻译成带证据/修复入口的 issue；不重试、不修复、不猜。
        const body = await readBody(request);
        if (!body || typeof body !== 'object') throw Object.assign(new Error('失败诊断请求体必须是对象'), { code: 'FAILURE_DIAGNOSIS_INVALID', status: 400 });
        if (body.error != null && (typeof body.error !== 'object' || Array.isArray(body.error))) throw Object.assign(new Error('error 必须是 {code,message,details} 对象'), { code: 'FAILURE_DIAGNOSIS_INVALID', status: 400 });
        const diagnosis = diagnoseFailure({ source: body.source, error: body.error || {}, context: body.context || {} });
        result = { ok: true, diagnosis };
      } else if (method === 'GET' && url.pathname === '/api/provider/egress') {
        // G4：数据外发清单（现有 provider 调用点/触发条件/发送字段/明确不发送的内容）。
        result = { ok: true, egress: providerEgressManifest() };
      } else if (method === 'POST' && url.pathname === '/api/provider/egress/preview') {
        // G4：脱敏预览（与日志/诊断包同一套 redactSecrets；不改发送行为）。
        const body = await readBody(request);
        result = previewProviderEgress(body?.payload);
      } else if (method === 'GET' && url.pathname === '/api/eda/gates/status') {
        result = { ok: true, ...gateService.status({ pcbUuid: url.searchParams.get('pcbUuid') || '' }) };
      } else if (method === 'POST' && url.pathname === '/api/eda/gates/evaluate') {
        const body = await readBody(request);
        result = { ok: true, ...gateService.evaluate({ pcbUuid: body?.pcbUuid }) };
        logger.info('Gates', 'Gate report archived', { pcbUuid: body?.pcbUuid ?? null, verdict: result.report?.verdict ?? null });
      } else if (method === 'POST' && url.pathname === '/api/eda/gates/signoff') {
        const body = await readBody(request);
        result = { ok: true, ...gateService.signoff({ pcbUuid: body?.pcbUuid, signedBy: body?.signedBy, decision: body?.decision, note: body?.note }) };
        logger.info('Gates', 'Human signoff recorded', { pcbUuid: body?.pcbUuid ?? null, decision: body?.decision ?? null, signedBy: body?.signedBy ?? null });
      } else if (method === 'GET' && url.pathname === '/api/eda/gates/approvals') {
        result = { ok: true, ...approvalLedger.snapshot({ limit: Number(url.searchParams.get('limit')) || 100 }) };
      } else if (method === 'GET' && url.pathname === '/api/knowledge/entries') {
        result = { ok: true, knowledge: knowledgeApi.list({
          kind: url.searchParams.get('kind') || null,
          trust: url.searchParams.get('trust') || null,
          reviewState: url.searchParams.get('reviewState') || null,
          entityKey: url.searchParams.get('entityKey') || null,
          text: url.searchParams.get('text') || null,
          includeExpired: url.searchParams.get('includeExpired') === '1' || url.searchParams.get('includeExpired') === 'true',
        }) };
      } else if (method === 'POST' && url.pathname === '/api/knowledge/entries') {
        const body = await readBody(request);
        result = { ok: true, ...knowledgeApi.save({ kind: body?.kind, title: body?.title, payload: body?.payload, provenance: body?.provenance, trust: body?.trust, ttlDays: body?.ttlDays }) };
        logger.info('Knowledge', 'Knowledge entry saved as candidate', { kind: body?.kind, id: result.entry?.id ?? null });
      } else if (method === 'POST' && /^\/api\/knowledge\/entries\/[^/]+\/review$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[4]);
        const body = await readBody(request);
        result = { ok: true, ...knowledgeApi.review({ id, state: body?.state, reviewedBy: body?.reviewedBy }) };
        logger.info('Knowledge', 'Knowledge entry reviewed', { id, state: body?.state, reviewedBy: body?.reviewedBy ?? null });
      } else if (method === 'GET' && url.pathname === '/api/knowledge/review-queue') {
        result = { ok: true, ...buildReviewQueue({ store: knowledgeStore }) };
      } else if (method === 'GET' && url.pathname === '/api/knowledge/health') {
        result = { ok: true, metrics: healthMetrics({ store: knowledgeStore }) };
      } else if (method === 'GET' && url.pathname === '/api/knowledge/conflicts') {
        result = { ok: true, ...knowledgeApi.conflicts({ entityKey: url.searchParams.get('entityKey') || '' }) };
      } else if (method === 'GET' && url.pathname === '/api/knowledge/usage') {
        result = { ok: true, ...knowledgeApi.usage({ id: url.searchParams.get('id') || '' }) };
      } else if (method === 'POST' && url.pathname === '/api/knowledge/usage') {
        const body = await readBody(request);
        result = { ok: true, ...knowledgeApi.recordUsage({ id: body?.id, agent: body?.agent, outcome: body?.outcome, note: body?.note }) };
      } else if (method === 'GET' && url.pathname === '/api/knowledge/agent/status') {
        result = { ok: true, scheduler: knowledgeScheduler.status(), manager: knowledgeManager.status() };
      } else if (method === 'POST' && url.pathname === '/api/knowledge/agent/run') {
        const body = await readBody(request);
        const task = String(body?.task || 'all');
        if (!['all', 'badcases', 'web', 'maintain'].includes(task)) {
          throw Object.assign(new Error('task 只能是 all/badcases/web/maintain'), { code: KNOWLEDGE_API_CODES.INVALID, status: 400 });
        }
        const tasks = task === 'all' ? ['badcases', 'web', 'maintain'] : [task];
        const cycle = await knowledgeScheduler.runNow({ reason: 'manual', tasks });
        result = { ok: cycle.ok !== false, cycle };
        logger.info('Knowledge', 'KMA run completed', { task, ok: cycle.ok !== false });
      } else if (method === 'GET' && url.pathname === '/api/rag/status') {
        result = { ok: true, rag: ragStore.status() };
      } else if (method === 'POST' && url.pathname === '/api/rag/reindex') {
        const stats = ragStore.reindex();
        result = { ok: true, rag: stats };
        logger.info('RAG', 'Index rebuilt', { docs: stats.docs, chunks: stats.chunks, terms: stats.terms });
      } else if (method === 'POST' && url.pathname === '/api/rag/query') {
        const body = await readBody(request);
        const queryText = typeof body?.query === 'string' ? body.query.trim() : '';
        if (!queryText) throw Object.assign(new Error('检索 query 不能为空'), { code: 'RAG_QUERY_EMPTY', status: 400 });
        const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((kind) => typeof kind === 'string') : null;
        result = { ok: true, rag: ragStore.query({ query: queryText, topK: Number(body?.topK) || 8, kinds: kinds && kinds.length ? kinds : null, minScore: Number(body?.minScore) || 0 }) };
        logger.info('RAG', 'Query completed', { query: queryText.slice(0, 80), results: result.rag.results.length, total: result.rag.total });
      } else if (method === 'GET' && url.pathname === '/api/knowledge/badcases') {
        result = { ok: true, badcases: knowledgeManager.listBadcases({ limit: Number(url.searchParams.get('limit')) || 50 }) };
      } else if (method === 'POST' && url.pathname === '/api/research/search') {
        // S1：联网检索默认关闭。服务端不读“会话态开关”，要求每次请求显式 allowResearch:true，
        // 避免用户关掉设置后，旧页面/旧请求仍在偷偷联网。
        const body = await readBody(request);
        if (body?.allowResearch !== true) throw Object.assign(new Error('联网检索未开启：请先在设置中允许 AI 查询公网'), { code: RESEARCH_CODES.DISABLED, status: 403 });
        const research = await searchWeb({ query: body?.query, provider: body?.provider || null, limit: body?.limit });
        if (!research.ok) throw Object.assign(new Error(research.message), { code: research.code, status: research.code === RESEARCH_CODES.NO_RESULTS ? 404 : 502 });
        result = { ok: true, research };
        logger.info('Research', 'Web search completed', { provider: research.provider, results: research.results.length, query: String(body?.query || '').slice(0, 80), digest: research.digest.slice(0, 12) });
      } else if (method === 'POST' && url.pathname === '/api/research/fetch') {
        const body = await readBody(request);
        if (body?.allowResearch !== true) throw Object.assign(new Error('联网检索未开启：请先在设置中允许 AI 查询公网'), { code: RESEARCH_CODES.DISABLED, status: 403 });
        const page = await fetchPage({ url: body?.url });
        if (!page.ok) throw Object.assign(new Error(page.message), { code: page.code, status: page.code === RESEARCH_CODES.URL_BLOCKED ? 400 : 502 });
        result = { ok: true, page };
        logger.info('Research', 'Web page fetched', { host: new URL(page.finalUrl).host, bytes: page.bytes, digest: page.digest.slice(0, 12) });
      } else if (method === 'GET' && url.pathname === '/api/research/status') {
        result = { ok: true, research: { enabled: false, sources: [{ id: 'duckduckgo', label: 'DuckDuckGo（无需 API Key）' }, { id: 'bing', label: 'Bing（无需 API Key）' }], note: '联网默认关闭；设置中开启后，由请求显式 allowResearch 放行；只读取证、不写工程' } };
      } else if (method === 'GET' && url.pathname === '/api/providers') {
        // 同一份列表里给前端"内置平台 + 注册表自定义 Provider"：内置在前，摘要形状见契约 §3。
        // 自定义摘要是从公开配置 + 钥匙串"是否存在凭据"派生的，天然不含密钥字段。
        result = {
          ok: true,
          providers: [...await providerStatuses(keychain), ...await customProviders.statuses(keychain)],
          // 只在降级时出现：让前端能把"自定义 Provider 列表为空"和"状态文件坏了"区分开。
          ...(customProvidersDegraded ? { customProviders: { available: false, ...customProvidersDegraded } } : {}),
        };
      } else if (method === 'PUT' && /^\/api\/custom-providers\/[^/]+$/.test(url.pathname)) {
        // 新建/更新自定义模型 Provider。id 只允许在路径里出现一次（body 里的 id 必须与之一致，
        // 否则会出现"PUT /acme 实际改了 beta"这种无法排查的静默错改）。
        assertCustomProvidersWritable();
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readBody(request);
        const { created, provider } = customProviders.upsert(body, { idFromPath: id });
        let configured = false;
        // 凭据状态只是界面提示：读不到钥匙串时按"未配置"显示，不因此回滚已经保存的配置。
        try { configured = Boolean(await keychain.configured(provider.id)); } catch { configured = false; }
        result = { ok: true, customProvider: { ...provider, configured, ready: configured } };
        logger.info('CustomProviders', created ? 'Created custom model provider' : 'Updated custom model provider', {
          provider: provider.id, protocol: provider.protocol, models: provider.models.length, configured,
        });
      } else if (method === 'DELETE' && /^\/api\/custom-providers\/[^/]+$/.test(url.pathname)) {
        // 删除配置 + 撤销该 Provider 的钥匙串条目：只删配置会留下一个"孤儿密钥"，
        // 用户以为已经删干净了。配置先删（可重建），密钥删除失败只如实回报，不假装成功。
        assertCustomProvidersWritable();
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const removed = customProviders.remove(id);
        let credential = { configured: false };
        try {
          await keychain.remove(id);
        } catch (error) {
          logger.error('CustomProviders', '自定义 Provider 已删除，但钥匙串条目删除失败', { provider: id, code: error?.code });
          credential = { configured: false, removed: false, note: '配置已删除，但钥匙串条目删除失败，请到"钥匙串访问"里手动删除该条目' };
        }
        result = { ok: true, removed: removed.removed, credential };
        logger.warn('CustomProviders', 'Removed custom model provider and its Keychain entry', { provider: id });
      } else if (method === 'POST' && /^\/api\/custom-providers\/[^/]+\/models$/.test(url.pathname)) {
        // "获取可用模型"：先确认存过 Key（否则会得到一句让人摸不着头脑的 401），
        // 再按注册表里的地址/协议打 {base}/models。请求构造与连接测试共用 testProvider，
        // 避免这里再复制一份超时/错误映射。
        assertCustomProvidersWritable();
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const descriptor = customProviders.resolve(id);
        if (!descriptor) throw customProviderNotFound(id);
        let configured = false;
        try { configured = Boolean(await keychain.configured(id)); } catch { configured = false; }
        if (!configured) throw Object.assign(new Error(`${descriptor.label} 尚未保存 API 密钥，请先保存密钥再获取可用模型`), { code: 'CUSTOM_PROVIDER_KEY_REQUIRED', status: 409 });
        const probed = await testProvider(id, keychain, { provider: descriptor });
        result = { ok: true, models: (Array.isArray(probed?.models) ? probed.models : []).map((modelId) => ({ id: modelId })) };
        logger.info('CustomProviders', 'Probed custom provider model list', { provider: id, models: result.models.length });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/login$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        result = { ok: true, login: await startProviderLogin(id) };
        logger.info('Provider', 'Started official provider login', { provider: id });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/key$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        requireKnownProvider(id);
        const body = await readBody(request);
        result = { ok: true, credential: await keychain.store(id, body.key) };
        // 请求体用完立即抹掉明文 Key，避免它继续流经后续任何可能记录 body 的代码路径。
        if (body && typeof body === 'object') body.key = undefined;
        logger.info('Credential', 'Stored provider credential in Keychain', { provider: id });
      } else if (method === 'DELETE' && /^\/api\/providers\/[^/]+\/key$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        requireKnownProvider(id);
        result = { ok: true, credential: await keychain.remove(id) };
        logger.warn('Credential', 'Removed provider credential from Keychain', { provider: id });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/test$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        requireKnownProvider(id);
        const testBody = await readBody(request);
        // 自定义 Provider 的地址以注册表为准：不允许请求体覆盖成任意 URL（那会绕开用户保存的配置）。
        const customDescriptor = PROVIDERS[id] ? null : customProviders.resolve(id);
        result = { ok: true, test: await testProvider(id, keychain, customDescriptor ? { provider: customDescriptor } : { baseUrl: testBody?.baseUrl }) };
        logger.info('Provider', 'Provider connection test completed', { provider: id });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/console$/.test(url.pathname)) {
        // 只传 Provider id，URL 由 Runtime 侧声明表决定；详情见 providers.mjs 的 openProviderConsole。
        const id = url.pathname.split('/')[3];
        result = { ok: true, console: await openProviderConsole(id) };
        logger.info('Provider', 'Opened provider console in the system browser', { provider: id });
      } else if (method === 'GET' && url.pathname === '/api/eda/discover') {
        const match = await bridge.discover();
        result = { ok: true, bridge: match };
        logger.info('EasyEDA', match ? 'Discovered EasyEDA Bridge' : 'EasyEDA Bridge not found', { port: match?.port });
      } else if (method === 'GET' && url.pathname === '/api/eda/windows') {
        result = { ok: true, ...(await bridge.windows()) };
      } else if (method === 'POST' && url.pathname === '/api/eda/windows/select') {
        const body = await readBody(request);
        result = { ok: true, ...(await bridge.selectWindow(body.windowId)) };
        logger.info('EasyEDA', 'Selected active EDA window', { windowId: body.windowId });
      } else if (method === 'GET' && url.pathname === '/api/eda/commands') {
        result = { ok: true, commands: bridge.listCommands() };
      } else if (method === 'POST' && /^\/api\/eda\/commands\/[^/]+$/.test(url.pathname)) {
        const commandId = decodeURIComponent(url.pathname.split('/')[4]);
        const body = await readBody(request);
        // 真机教训（第 16 轮）：这条通用命令路由原先直接 bridge.execute，
        // 运行时刚起来还没 discover 时，连 `pcb.open` 都会 400 BRIDGE_NOT_FOUND（桥明明在）。
        await ensureEdaSession();
        const commandStarted = performance.now();
        const metadata = bridge.listCommands().find((item) => item.id === commandId);
        const commandResult = await bridge.execute(commandId, body);
        result = { ok: true, command: { id: commandId, permission: metadata?.permission || 'read', duration: Math.round(performance.now() - commandStarted), result: commandResult } };
        logger.info('EasyEDA', 'Executed registered non-write command', { commandId, permission: result.command.permission, duration: result.command.duration });
      } else if (method === 'POST' && url.pathname === '/api/eda/release/gate') {
        const body = await readBody(request);
        const gate = gateFabricationRelease({ ...(await gatherReleaseEvidence(body)), constraints: Array.isArray(body.constraints) ? body.constraints : [], designFacts: body.designFacts ?? null, draftPathsReplaced: selfDraftReplacedPaths(body), engineering: body.engineering && typeof body.engineering === 'object' ? body.engineering : null, layoutAudit: body.layoutAudit && typeof body.layoutAudit === 'object' ? body.layoutAudit : null, engineeringExemptions: Array.isArray(body.engineeringExemptions) ? body.engineeringExemptions : [] });
        // 统一裁决：本地门禁 + 落盘的人工证据（在线 DFM / 终审签核）只有一条结论。
        // 给了 PCB/计划标识就强制校验证据绑定：不能拿别的板/别的计划的 DFM 或签核来充数。
        const releaseBinding = { pcbUuid: text(body.pcbUuid) || null, planHash: text(body.planHash) || null };
        const releaseDecision = buildReleaseDecision({ gate, dfm: evidenceStore.latest('dfm-evidence'), signoff: evidenceStore.latest('signoff'), binding: releaseBinding });
        result = { ...gate, releaseDecision };
      } else if (method === 'POST' && url.pathname === '/api/production/release') {
        /**
         * 产出决策：门禁没通过就只能出草稿，正式命名一律拒绝。
         * 与门禁同一个取证函数，因此"看到的阻断"和"能不能出正式文件"永远是同一套证据。
         */
        const body = await readBody(request);
        const evidence = await gatherReleaseEvidence(body);
        const gate = gateFabricationRelease({ ...evidence, constraints: Array.isArray(body.constraints) ? body.constraints : [], designFacts: body.designFacts ?? null, draftPathsReplaced: selfDraftReplacedPaths(body), engineering: body.engineering && typeof body.engineering === 'object' ? body.engineering : null, layoutAudit: body.layoutAudit && typeof body.layoutAudit === 'object' ? body.layoutAudit : null, engineeringExemptions: Array.isArray(body.engineeringExemptions) ? body.engineeringExemptions : [] });
        const requested = body.requested === 'draft' ? 'draft' : 'final';
        const releaseDecision = buildReleaseDecision({
          gate,
          dfm: evidenceStore.latest('dfm-evidence'),
          signoff: evidenceStore.latest('signoff'),
          binding: { pcbUuid: text(body.pcbUuid) || null, planHash: text(body.planHash) || null },
        });
        result = { ...decideProductionOutput({ gate, requested, artifacts: evidence.artifacts }), releaseDecision };
      } else if (method === 'POST' && url.pathname === '/api/production/releases/archive') {
        // B8：把一次真正 ready 的放行固化为不可变发布版本（服务端重算门禁/裁决，不接受客户端自报 ready）。
        const body = await readBody(request);
        const evidence = await gatherReleaseEvidence(body);
        const gate = gateFabricationRelease({ ...evidence, constraints: Array.isArray(body.constraints) ? body.constraints : [], designFacts: body.designFacts ?? null, draftPathsReplaced: selfDraftReplacedPaths(body), engineering: body.engineering && typeof body.engineering === 'object' ? body.engineering : null, layoutAudit: body.layoutAudit && typeof body.layoutAudit === 'object' ? body.layoutAudit : null, engineeringExemptions: Array.isArray(body.engineeringExemptions) ? body.engineeringExemptions : [] });
        const artifactsDirResolved = typeof body.artifactsDir === 'string' && body.artifactsDir.trim() ? resolvePath(body.artifactsDir) : join(process.cwd(), 'deliverables');
        const signoffEvidence = evidenceStore.latest('signoff');
        // planHash 优先取显式传入；没传则取人工签核证据里绑定的 planHash（签核对象本身就是这次放行的计划）。
        const archivePlanHash = text(body.planHash) || (typeof signoffEvidence?.payload?.planHash === 'string' ? signoffEvidence.payload.planHash : null);
        let manifestHash = null;
        try { manifestHash = inspectProductionArtifacts(artifactsDirResolved, { pcbUuid: text(body.pcbUuid) || null, planHash: archivePlanHash }).manifest?.manifestHash ?? null; } catch { manifestHash = null; }
        const releaseDecision = buildReleaseDecision({
          gate,
          dfm: evidenceStore.latest('dfm-evidence'),
          signoff: signoffEvidence,
          binding: { pcbUuid: text(body.pcbUuid) || null, planHash: archivePlanHash, manifestHash },
        });
        const release = releaseArchives.archive({
          gate,
          releaseDecision,
          binding: {
            planHash: archivePlanHash,
            compiledPlanHash: text(body.compiledPlanHash) || null,
            pcbUuid: text(body.pcbUuid) || null,
            pcbExecutionId: text(body.pcbExecutionId) || null,
            reviewHash: text(body.reviewHash) || signoffEvidence?.digest || null,
            manifestHash,
          },
          artifactsDir: artifactsDirResolved,
          files: evidence.artifacts.map((artifact) => ({ path: artifact.path, role: artifact.kind })),
          notes: body.notes,
        });
        result = { ok: true, release };
        logger.info('Production', 'Archived immutable release version', { releaseId: release.releaseId, manifestHash: release.binding.manifestHash, planHash: release.binding.planHash });
      } else if (method === 'GET' && url.pathname === '/api/production/releases') {
        // B8：发布版本列表（只读；每条都带证据文件重校验结果，不把"记录还在"当"证据可信"）。
        result = { ok: true, ...releaseArchives.list() };
      } else if (method === 'GET' && /^\/api\/production\/releases\/[^/]+$/.test(url.pathname)) {
        const releaseId = decodeURIComponent(url.pathname.split('/')[4]);
        result = { ok: true, release: releaseArchives.get(releaseId) };
      } else if (method === 'GET' && url.pathname === '/api/production/download') {
        result = { ok: true, __file: resolveDownloadableArtifact(url.searchParams.get('path')) };
      } else if (method === 'POST' && url.pathname === '/api/production/export') {
        /**
         * 真导出生产文件：**先裁决、获准才写盘**，落盘后立刻用门禁同一套规则复核。
         * 顺序不能反——先写再看会让"文件已经在磁盘上"变成既成事实，人就会当它是交付物。
         * 草稿由裁决强制带上 `-DRAFT-NOT-FOR-ORDER`；正式命名只在门禁通过且复核通过时才存在。
         */
        const body = await readBody(request);
        const evidence = await gatherReleaseEvidence(body);
        const requestedManifestHash = typeof body.manifestHash === 'string' && body.manifestHash.trim() ? body.manifestHash.trim() : null;
        const providedBinding = body.binding && typeof body.binding === 'object' ? body.binding : {};
        // B1/B4：正式导出必须证明"签核的物料 = 本次要导出的物料"。
        // 用与 readiness 相同的 binding 重算当前 artifactsDir 的 manifestHash；拿不到就当作不匹配（fail-closed）。
        let recomputedManifestHash = null;
        try {
          const artifactsDir = typeof body.artifactsDir === 'string' && body.artifactsDir.trim() ? resolvePath(body.artifactsDir) : join(process.cwd(), 'deliverables');
          recomputedManifestHash = inspectProductionArtifacts(artifactsDir, providedBinding).manifest?.manifestHash ?? null;
        } catch { recomputedManifestHash = null; }
        const requestedFinal = body.requested === 'final';
        const signoffEvidence = evidenceStore.latest('signoff');
        const manifestCheck = verifyExportManifestBinding({
          requested: requestedFinal ? 'final' : 'draft',
          providedManifestHash: requestedManifestHash,
          recomputedManifestHash,
          signoffManifestHash: signoffEvidence?.payload?.manifestHash ?? null,
        });
        // 真机踩到的"鸡生蛋"缺陷：`/api/eda/release/gate` 会把"本次将被覆盖的自产草稿"传给门禁，
        // 而这里漏传了 ⇒ 只要目录里还有上一轮的草稿产物，`requested:'final'` **永远**被
        // RELEASE_ARTIFACT_DRAFT_MARKER 挡住，正式件根本写不出来（等于正式导出这条路是死的）。
        // 用自己的草稿覆盖自己的草稿是允许的，但仅限本目录、且只对显式 requested:'final' 生效。
        const draftPathsReplaced = selfDraftReplacedPaths(body);
        // A1：正式导出的门禁必须与放行闸门同一套需求约束证据，否则两条路会给出不同结论。
        const gate = gateFabricationRelease({ ...evidence, constraints: Array.isArray(body.constraints) ? body.constraints : [], designFacts: body.designFacts ?? null, draftPathsReplaced, engineering: body.engineering && typeof body.engineering === 'object' ? body.engineering : null, layoutAudit: body.layoutAudit && typeof body.layoutAudit === 'object' ? body.layoutAudit : null, engineeringExemptions: Array.isArray(body.engineeringExemptions) ? body.engineeringExemptions : [] });
        const requested = body.requested === 'draft' ? 'draft' : 'final';
        const decision = decideProductionOutput({ gate, requested, artifacts: evidence.artifacts, draftPathsReplaced });
        const releaseDecision = buildReleaseDecision({
          gate,
          dfm: evidenceStore.latest('dfm-evidence'),
          signoff: signoffEvidence,
          // B1/B4：把本次重算的 manifestHash 放进裁决 binding，签核/DFM 的指纹校验才会真正生效。
          binding: { pcbUuid: text(body.pcbUuid) || null, planHash: text(body.planHash) || null, manifestHash: manifestCheck.manifestHash },
        });
        const manifestBinding = {
          requested: manifestCheck.checks.requested,
          providedManifestHash: requestedManifestHash,
          recomputedManifestHash,
          signoffManifestHash: signoffEvidence?.payload?.manifestHash ?? null,
          boundManifestHash: manifestCheck.manifestHash,
          ok: manifestCheck.ok,
          ...(manifestCheck.code ? { code: manifestCheck.code, message: manifestCheck.message } : {}),
        };
        // 正式产出必须在**本地门禁全过**之上再要求人工证据（在线 DFM + 终审签核）。
        // 之前正式命名只看闸门：闸门一绿就出正式文件，等于把"人工放行"这道理序绕过去了。
        if (!manifestCheck.ok) {
          // 物料清单绑定不成立：明确挡住正式产出，但保留裁决明细让用户知道还缺什么。
          result = {
            ...decision,
            allowed: false, outputClass: null, exported: false, wrote: [], outDir: null,
            code: manifestCheck.code,
            message: manifestCheck.message,
            blockers: [...(decision.blockers || []), manifestCheck.code],
            releaseDecision,
            manifestBinding,
          };
        } else if (decision.allowed && requested === 'final' && !releaseDecision.ready) {
          result = {
            ...decision,
            allowed: false, outputClass: null, exported: false, wrote: [], outDir: null,
            code: 'RELEASE_DECISION_BLOCKED',
            message: `不能出正式生产文件：${releaseDecision.reason}`,
            blockers: [...(decision.blockers || []), ...releaseDecision.blockedBy],
            releaseDecision,
          };
        } else if (!decision.allowed) {
          result = { ...decision, exported: false, wrote: [], outDir: null, releaseDecision, manifestBinding };
        } else {
          const outDir = typeof body.outDir === 'string' && body.outDir.trim()
            ? resolvePath(body.outDir)
            : join(process.cwd(), 'release', new Date().toISOString().slice(0, 10));
          const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : DEFAULT_EXPORT_KINDS;
          const run = await runProductionExport({
            decision, outDir, kinds,
            execute: (commandId, args, options) => bridge.execute(commandId, args, options),
            design: evidence.design ?? null,
            // 复核用的就是门禁那套规则：Gerber 铜层数 vs 板子层数、BOM 位号集合、CPL 坐标容差、STEP 头
            verify: ({ files }) => sanitizeArtifactVerification({
              report: gateArtifacts({ artifacts: collectArtifacts({ files }), design: evidence.design ?? {} }),
              outputClass: decision.outputClass, kinds,
            }),
          });
          // 形状说清楚：`exported` 是布尔（这次导出成不成），`files` 是确实落盘的文件清单。
          result = { ...run, decision, releaseDecision, manifestBinding, exported: run.ok === true, files: run.exported ?? [], wrote: (run.exported ?? []).map((item) => item.path), outDir };
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/repair') {
        /**
         * 按验收结论自动修复原理图（受控写入）：缺 Rd / 缺 I2C 上拉这类缺陷，直接落到原理图上，
         * 写完立刻用网表复核 + 重跑验收。默认 dryRun，只有显式 `dryRun:false` 才写盘。
         *
         * 三条真机教训焊在这里：
         *  1. 元件必须 `addIntoPcb=true`，否则它**不进 EasyEDA 网表**，复核与验收都看不到（实测）。
         *  2. 复核必须在**保存之后**（保存前网表不反映新图元）。
         *  3. 复核按**计数**比对：未标注元件位号都是 `R?`，用集合去重会把两个引脚算成一个。
         */
        const body = await readBody(request);
        if (body.dryRun === false) await requireWriteApproval(body);
        await ensureEdaSession();
        const bridgeExecute = (commandId, args, options) => bridge.execute(commandId, args, options);
        const unwrapResult = (value) => value?.result ?? value;
        if (typeof body.pageUuid === 'string' && body.pageUuid) {
          const opened = unwrapResult(await bridge.execute('schematic.open', { pageUuid: body.pageUuid }));
          if (!opened?.opened) throw Object.assign(new Error('原理图打不开，拒绝在不确定的文档上写入'), { code: 'EDA_DOCUMENT_OPEN_FAILED', status: 409 });
          let activated = false;
          for (let attempt = 0; attempt < 25; attempt += 1) {
            const current = unwrapResult(await bridge.execute('document.current', {}));
            if (current?.documentType === 1) { activated = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (!activated) throw Object.assign(new Error('原理图已打开但不是活动文档，拒绝写入'), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
        }
        const readNetlist = async () => {
          const exported = unwrapResult(await bridge.execute('schematic.netlist.export', { fileName: 'circuitpilot-repair', netlistType: 'EasyEDA', inlineLimit: 262144 }));
          if (!exported?.text) throw Object.assign(new Error('网表为空，拒绝在看不到网络的情况下改设计'), { code: 'EDA_NETLIST_EMPTY', status: 409 });
          return JSON.parse(exported.text);
        };
        const before = await readNetlist();
        const components = (unwrapResult(await bridge.execute('schematic.components')) || {}).components || [];
        const requested = Array.isArray(body.repairs) && body.repairs.length ? body.repairs : DEFAULT_PULLUP_REPAIRS;
        const row = layoutFreeRow({ components, count: requested.length, spacingMm: Number(body.spacingMm) || 240, startX: Number(body.startX) || 400 });
        const resolved = [];
        // 真机实测：一次 LCSC 在线库检索要 1~30 秒不等（还会整次超时被中断），
        // 所以**同一个关键词只查一次**（4 个电阻只有 2 个不同阻值），查到的结果复用。
        const deviceCache = new Map();
        const searchDevice = async (keyword, label) => {
          if (deviceCache.has(keyword)) return deviceCache.get(keyword);
          // 检索串只放"阻值编码 + 封装"，不要把欧姆数塞进关键词（`5100 5101` 这种串会搜不到东西）
          let found;
          try {
            found = unwrapResult(await bridge.execute('library.device.search', { query: `${keyword} 0603 电阻`, mode: 'keyword', limit: 12, page: 1 })) || [];
          } catch (error) {
            // 超时/中止要如实说清是"在线库没在预算内返回"，而不是让它以一个裸 abort 冒到界面上
            throw Object.assign(new Error(`真机元件库检索失败（${label}）：${String(error?.message || error).slice(0, 120)}。可在 repairs[].device 里直接给出 libraryUuid/uuid 免去检索`), { code: 'EDA_DEVICE_SEARCH_FAILED', status: 504 });
          }
          const hit = (Array.isArray(found) ? found : []).find((item) => String(item.name || '').includes(String(keyword)));
          if (!hit) throw Object.assign(new Error(`真机库里没找到 ${keyword}（${label}）`), { code: 'EDA_DEVICE_NOT_FOUND', status: 404 });
          const device = { libraryUuid: hit.libraryUuid, uuid: hit.uuid, mpn: hit.name };
          deviceCache.set(keyword, device);
          return device;
        };
        for (const [index, repair] of requested.entries()) {
          let device = repair.device ?? null;
          // 幂等命中（这两个网络之间已有合格器件）就不查库——已经修好的东西不该再去联网白等一次检索
          const bridges = findExistingBridge(before, repair.net, repair.otherNet);
          const alreadySatisfied = bridges.some((item) => partMatchesRepair(item.props, repair));
          if (!device?.uuid && !alreadySatisfied) {
            const keyword = repair.mpnKeyword || repair.query;
            if (!keyword) throw Object.assign(new Error(`修复项 ${repair.id ?? index} 缺少器件身份（device 或 mpnKeyword）`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
            device = await searchDevice(keyword, repair.title ?? repair.id ?? `#${index + 1}`);
          }
          resolved.push({ ...repair, device, position: repair.position ?? row[index] ?? row[0] });
        }
        const plan = planSchematicRepair({ netlist: before, repairs: resolved });
        // 幂等命中的项没有（也不需要）器件身份，这里必须容忍 device 为 null
        const summarizeDevices = () => resolved.map((item) => ({ id: item.id, mpn: item.device?.mpn ?? null, net: item.net, otherNet: item.otherNet, valueOhm: item.valueOhm, position: item.position }));
        if (body.dryRun !== false) {
          result = { dryRun: true, plan, devices: summarizeDevices() };
        } else if (plan.operations.length === 0) {
          // 幂等命中：设计已经合格，**一个字节都不许写**。但仍然重跑验收——"不用改"也要有证据。
          const acceptance = await runSchematicAcceptance({ execute: bridgeExecute, plan: body.plan || null, skipSimulation: body.skipSimulation === true, ...acceptanceExtraOptions });
          result = {
            dryRun: false,
            skipped: true,
            skippedReason: plan.findings.some((finding) => finding.code === 'REPAIR_ALREADY_SATISFIED') ? 'ALREADY_SATISFIED' : 'NOTHING_TO_DO',
            plan,
            devices: summarizeDevices(),
            applied: null,
            acceptance: { ready: acceptance.ready, netlist: acceptance.netlist, designChecks: acceptance.designChecks, findings: acceptance.findings },
          };
        } else {
          const applied = await applySchematicRepair({ execute: bridgeExecute, plan, readNetlist, save: true });
          // 改完立刻重跑验收：写入本身不算"修好了"，仿真数值才算
          const acceptance = await runSchematicAcceptance({ execute: bridgeExecute, plan: body.plan || null, skipSimulation: body.skipSimulation === true, ...acceptanceExtraOptions });
          result = {
            dryRun: false,
            devices: resolved.map((item) => ({ id: item.id, mpn: item.device.mpn ?? null, net: item.net, otherNet: item.otherNet, valueOhm: item.valueOhm, position: item.position })),
            applied: { createdPins: applied.createdPins, diff: applied.diff, events: applied.events },
            acceptance: { ready: acceptance.ready, netlist: acceptance.netlist, designChecks: acceptance.designChecks, findings: acceptance.findings },
          };
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/net-connect') {
        /**
         * R3 网表连线：把已存在但悬空的引脚按网络名挂接（网络端口落在引脚坐标上），
         * 保存后导网表逐引脚核对；默认 dryRun，只有显式 `dryRun:false` 才写盘且必须消费
         * 一次服务端签发、绑定当前文档指纹的 write 批准。
         *
         * 与 repair 的边界：repair 只处理"缺上拉/Rd"这类新增元件修复；本路由不新增元件，
         * 只给既有引脚命名网络，因此计划里的每个引脚都必须在写前网表里存在且当前无网。
         */
        const body = await readBody(request);
        let approvedTarget = null;
        if (body.dryRun === false) approvedTarget = await requireWriteApproval(body);
        await ensureEdaSession();
        const unwrapResult = (value) => (value?.result ?? value);
        const bridgeExecute = (commandId, args, options) => bridge.execute(commandId, args, options);
        await ensureSchematicActive({ pageUuid: typeof body.pageUuid === 'string' ? body.pageUuid : null, documentUuid: body.documentUuid ?? null, approvedTarget });
        const readNetlist = async () => {
          const { exported, text: netlistText, reason } = await exportSchematicNetlistText(bridgeExecute);
          if (!netlistText) throw Object.assign(new Error(`网表为空或分片取回失败（${reason || '无内容'}），拒绝在看不到网络的情况下改设计`), { code: 'EDA_NETLIST_EMPTY', status: 409 });
          return JSON.parse(netlistText);
        };
        const before = await readNetlist();
        const readback = unwrapResult(await bridge.execute('schematic.components')) || {};
        const componentList = readback.components || [];
        const pinMap = readback.pins || {};
        let candidates = null;
        let connections = Array.isArray(body.connections) ? body.connections : null;
        if (!connections) {
          if (body.autoCandidates !== true) {
            throw Object.assign(new Error('必须提供 connections（或 autoCandidates:true 让服务端基于网表列出悬空引脚）'), { code: 'NET_CONNECT_CONNECTIONS_INVALID', status: 400 });
          }
          candidates = collectDanglingPins({ components: componentList, pins: pinMap, netlist: before, limit: Number(body.candidateLimit) || 20 });
          connections = buildTestConnections(candidates, { prefix: body.testNetPrefix || 'CP_R3_TEST', perNet: Number(body.perNet) || 2, maxNets: Number(body.maxNets) || 3 });
        }
        const planned = planNetConnect({ connections, components: componentList, pins: pinMap, netlist: before });
        const planView = planned.plan ? {
          apiVersion: 1, kind: 'schematic-net-connect', planHash: planned.planHash,
          nets: planned.plan.nets,
          operations: planned.plan.operations.map((item) => ({ net: item.net, uniqueId: item.uniqueId, designator: item.designator, pinNumber: item.pinNumber, x: item.args.x, y: item.args.y })),
          satisfied: planned.satisfied, findings: planned.findings,
        } : { apiVersion: 1, kind: 'schematic-net-connect', planHash: null, nets: [], operations: [], satisfied: planned.satisfied, findings: planned.findings };
        if (body.dryRun !== false) {
          result = { dryRun: true, ok: planned.ok, plan: planView, suggestedConnections: connections, candidates, netlist: { components: 0, pins: 0 }, willSave: body.save !== false };
        } else {
          if (!planned.ok) {
            throw Object.assign(new Error(`网表连线计划不通过：${planned.findings.filter((item) => item.severity === 'blocking').map((item) => item.message).join('；') || '没有可写入的引脚'}`), { code: planned.findings[0]?.code || 'NET_CONNECT_CONNECTIONS_INVALID', status: 409, details: { findings: planned.findings } });
          }
          const loadComponents = async () => unwrapResult(await bridge.execute('schematic.components')) || {};
          const applied = await applyNetConnect({ execute: bridgeExecute, plan: planned.plan, beforeNetlist: before, readNetlist, loadComponents, save: body.save !== false });
          // 写完重跑验收：连线本身不算"收敛"，ERC/网表指标才算（ERC 失败会如实记为 warning，不伪造通过）
          const acceptance = await runSchematicAcceptance({ execute: bridgeExecute, plan: body.plan || null, skipSimulation: body.skipSimulation === true, ...acceptanceExtraOptions });
          result = {
            dryRun: false,
            plan: planView,
            applied: { createdPrimitiveIds: applied.createdPrimitiveIds, saved: applied.saved, verification: applied.verification, events: applied.events },
            acceptance: { ready: acceptance.ready, netlist: acceptance.netlist, findings: acceptance.findings },
          };
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/net-connect/rollback') {
        /**
         * 删除本次网表连线写入的网络端口并保存，核对图元确实不在了、目标引脚回到无网。
         * 这是 A7 验收的"删除后复原"证据，必须消费 write 批准（删除也是写）。
         */
        const body = await readBody(request);
        const approvedTarget = await requireWriteApproval(body);
        const bridgeExecute = (commandId, args, options) => bridge.execute(commandId, args, options);
        const unwrapResult = (value) => (value?.result ?? value);
        await ensureSchematicActive({ pageUuid: typeof body.pageUuid === 'string' ? body.pageUuid : null, documentUuid: body.documentUuid ?? null, approvedTarget });
        const readNetlist = async () => {
          const { text: netlistText, reason } = await exportSchematicNetlistText(bridgeExecute);
          if (!netlistText) throw Object.assign(new Error(`网表为空或分片取回失败（${reason || '无内容'}），无法核对回滚`), { code: 'EDA_NETLIST_EMPTY', status: 409 });
          return JSON.parse(netlistText);
        };
        const loadComponents = async () => unwrapResult(await bridge.execute('schematic.components')) || {};
        const rollback = await rollbackNetConnect({
          execute: bridgeExecute,
          loadComponents,
          readNetlist,
          primitiveIds: Array.isArray(body.primitiveIds) ? body.primitiveIds.map(String) : [],
          targets: Array.isArray(body.targets) ? body.targets : [],
        });
        result = { ok: rollback.ok, rollback };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/designators/set') {
        /**
         * A5 位号标注：把原理图里的 `C?` 占位位号改成已标注位号（真机验证过的
         * `sch_PrimitiveComponent.modify(id,{designator})`），写完逐件读回并保存。
         * 标注是写操作，必须消费绑定当前文档指纹的 write 批准。
         */
        const body = await readBody(request);
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length || items.length > 300) throw Object.assign(new Error('位号标注需要 1–300 项 items'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        const normalizedItems = items.map((item, index) => {
          if (!item || typeof item.primitiveId !== 'string' || !item.primitiveId) throw Object.assign(new Error(`第 ${index + 1} 项缺少 primitiveId`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
          return { primitiveId: item.primitiveId, designator: assertAnnotatableDesignator(item.designator) };
        });
        const approvedTarget = await requireWriteApproval(body);
        await ensureEdaSession();
        const unwrapResult = (value) => (value?.result ?? value);
        await ensureSchematicActive({ pageUuid: typeof body.pageUuid === 'string' ? body.pageUuid : null, documentUuid: body.documentUuid ?? null, approvedTarget });
        const applied = [];
        for (const item of normalizedItems) {
          const raw = unwrapResult(await bridge.execute('schematic.component.designator.set', item));
          applied.push({ primitiveId: item.primitiveId, designator: item.designator, ok: raw?.ok === true, readDesignator: raw?.designator ?? null, error: raw?.error ?? null });
        }
        let saved = null;
        if (body.save !== false) {
          const savedResult = unwrapResult(await bridge.execute('schematic.save', {}));
          if (savedResult !== true) throw Object.assign(new Error('位号标注后保存未确认（schematic.save 未返回 true），不能声称已落盘'), { code: 'SAVE_FAILED', status: 409 });
          saved = true;
        }
        // 独立读回：不信任 modify 返回值，逐件核对当前设计器里的位号。
        const parts = unwrapResult(await bridge.execute('schematic.parts.read'));
        const byId = new Map((Array.isArray(parts) ? parts : []).map((part) => [String(part?.primitiveId || part?.id || ''), readPartFacts(part)]));
        const verification = normalizedItems.map((item) => {
          const facts = byId.get(String(item.primitiveId)) || null;
          const actual = facts?.designator ?? null;
          return { primitiveId: item.primitiveId, expected: item.designator, actual, ok: actual !== null && String(actual) === item.designator };
        });
        const unverified = verification.filter((item) => !item.ok);
        if (unverified.length) throw Object.assign(new Error(`位号标注读回不一致：${unverified.map((item) => `${item.primitiveId} 期望 ${item.expected} 实际 ${item.actual ?? '(缺失)'}`).join('；')}`), { code: 'DESIGNATOR_READBACK_MISMATCH', status: 409, details: { verification } });
        result = { ok: true, applied, saved, verification };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/component-batch') {
        /**
         * A6 原理图批量落件：默认 dryRun 只做计划（读回现有器件 + 逐项 create/skip-existing），
         * 显式 `dryRun:false` 才写，且必须消费绑定当前文档指纹的 write 批准。
         * 逐件创建、每件原子落进度（同 planHash 可续跑）、保存后读回验收；重复执行不产生重复件。
         */
        const body = await readBody(request);
        let approvedTarget = null;
        if (body.dryRun === false) approvedTarget = await requireWriteApproval(body);
        await ensureEdaSession();
        const unwrapResult = (value) => (value?.result ?? value);
        await ensureSchematicActive({ pageUuid: typeof body.pageUuid === 'string' ? body.pageUuid : null, documentUuid: body.documentUuid ?? null, approvedTarget });
        const readParts = async () => {
          const parts = unwrapResult(await bridge.execute('schematic.parts.read'));
          if (!Array.isArray(parts)) throw Object.assign(new Error('读不到原理图器件列表，拒绝在看不到现状的情况下批量落件'), { code: 'SCHEMATIC_BATCH_READBACK_INVALID', status: 409 });
          return parts;
        };
        const parts = await readParts();
        const planned = planSchematicBatch({ items: Array.isArray(body.items) ? body.items : [], parts, toleranceMm: Number.isFinite(Number(body.toleranceMm)) ? Number(body.toleranceMm) : 0.05 });
        const planView = {
          apiVersion: 1, kind: 'schematic-component-batch', planHash: planned.planHash,
          counts: planned.counts, identityUnproven: planned.identityUnproven, duplicateGroups: planned.duplicateGroups,
          findings: planned.findings,
          items: planned.items.map((item) => ({ key: item.key, coordinate: item.coordinate, action: item.action, matchedBy: item.matchedBy, existing: item.existing, x: item.x, y: item.y })),
        };
        if (body.dryRun !== false) {
          result = { dryRun: true, plan: planView, willSave: body.save !== false, resume: Boolean(body.resume) };
        } else {
          const batchDir = String(process.env.CIRCUITPILOT_BATCH_DIR || '').trim() || join(homedir(), '.circuitpilot', 'schematic-batches');
          const stateFile = join(batchDir, `${planned.planHash}.json`);
          const applied = await applySchematicBatch({
            execute: (commandId, args, options) => bridge.execute(commandId, args, options),
            plan: planned,
            stateFile,
            save: body.save !== false,
            readParts,
          });
          result = { dryRun: false, plan: planView, applied };
        }
      } else if (method === 'POST' && url.pathname === '/api/production/order-card') {
        /**
         * 板厂下单参数卡：把"这块板实测是什么样"和"我打算怎么下单"摆在一起核对。
         * 只读、不写 EDA：它只是把事实和假设摊开，绝不替用户下单，也不猜价格。
         */
        const body = await readBody(request);
        // 产物：优先用导出清单（那里面有 sha256），其次按前缀扫目录
        let files = Array.isArray(body.files) && body.files.length ? body.files : [];
        if (!files.length && typeof body.exportManifestPath === 'string' && body.exportManifestPath) {
          const manifestPath = resolvePath(body.exportManifestPath);
          if (!existsSync(manifestPath)) throw Object.assign(new Error(`导出清单不存在：${manifestPath}`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
          const manifest = readExportManifest(manifestPath);
          files = (manifest.files || []).map((item) => ({ kind: item.kind, name: item.name ?? item.path, path: item.path, bytes: item.bytes }));
        }
        if (!files.length) {
          const dir = typeof body.artifactsDir === 'string' && body.artifactsDir.trim() ? body.artifactsDir : join(process.cwd(), 'deliverables');
          const prefixes = { gerber: 'GERBER_', bom: 'BOM_', cpl: 'CPL_', step: 'STEP_' };
          if (existsSync(dir)) {
            for (const name of readdirSync(dir)) for (const [kind, prefix] of Object.entries(prefixes)) if (name.startsWith(prefix)) files.push({ kind, name, path: join(dir, name), bytes: statSync(join(dir, name)).size });
          }
        }
        // DRC 报告：给了路径就按路径读真报告（缺证据一律照实报 unknown）
        let drcReport = body.drcReport ?? null;
        if (!drcReport && typeof body.drcReportPath === 'string' && body.drcReportPath) {
          const reportPath = resolvePath(body.drcReportPath);
          if (!existsSync(reportPath)) throw Object.assign(new Error(`DRC 报告文件不存在：${reportPath}`), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
          drcReport = JSON.parse(readFileSync(reportPath, 'utf8'));
        }
        let facts = body.facts ?? null;
        if (!facts) {
          await ensureEdaSession();
          const { readback } = await readPcbPlacement(body.pcbUuid);
          const copperCount = await bridge.execute('pcb.layers.copperCount').then((value) => value?.result ?? null).catch(() => null);
          facts = deriveBoardFacts({
            outlinePoints: parsePolygonSource(readback?.outline?.[0]?.source)?.points ?? [],
            copperLayerCount: copperCount,
            designators: (readback?.components || []).map((item) => item.designator),
            netCount: drcReport?.byNet ? Object.keys(drcReport.byNet).length : null,
            drcReport,
            impedanceNets: Array.isArray(body.impedanceNets) ? body.impedanceNets : [],
          });
        }
        result = buildFabricationOrder({
          facts,
          requested: body.requested && typeof body.requested === 'object' ? body.requested : {},
          capability: body.capability && typeof body.capability === 'object' ? body.capability : undefined,
          files,
          price: body.price ?? null,
        });
        // B3：供应链价格/库存证据随下单卡展示（已知单价合计/缺货/过期）。证据缺失不猜价。
        if (body.pricingEvidence && typeof body.pricingEvidence === 'object') {
          result.supplySummary = summarizeSupplyEvidence(body.pricingEvidence, {
            staleAfterHours: Number.isFinite(Number(body.supplyMaxAgeHours)) && Number(body.supplyMaxAgeHours) > 0 ? Number(body.supplyMaxAgeHours) : 24,
          });
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/placement/plan') {
        // 板框 → 自动布局 → 独立复核 → 与现状 diff。只读，不写 EDA。
        const body = await readBody(request);
        const layoutIntent = (body.designIntent ?? body.intent) ? normalizeLayoutIntent(body.designIntent ?? body.intent) : null;
        await ensureEdaSession();
        // 调用方可以只给 pcbUuid，由运行时负责把 PCB 文档打开并**等它成为活动文档**——小白用户不该手动切文档
        let readback;
        let resolvedPcbUuid = body.pcbUuid ?? null;
        try {
          const resolved = await readPcbPlacement(body.pcbUuid);
          readback = resolved.readback;
          resolvedPcbUuid = resolved.pcbUuid;
        } catch (error) {
          // 真机实测：当前活动文档不是 PCB 时该命令直接 500。原样抛出去只会让人一头雾水，
          // 这里翻成可操作的指引（给出 pcbUuid，或先在 EDA 里打开 PCB）。
          throw Object.assign(new Error(`读不到 PCB 放置数据（${String(error?.code || 'ERROR')}）：当前活动文档可能不是 PCB。请填 PCB 文档 UUID 让运行时替你打开，或先在嘉立创EDA 中打开 PCB 文档。`), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
        }
        const outline = parsePolygonSource(readback?.outline?.[0]?.source);
        const { components, unknown } = readComponentGeometry(readback);
        const affinity = netAffinity(components);
        const edgeClearanceMm = Number.isFinite(body.edgeClearanceMm) ? body.edgeClearanceMm : 1;
        const spacingMm = Number.isFinite(body.spacingMm) ? body.spacingMm : 0.5;
        const gridMm = Number.isFinite(body.gridMm) ? body.gridMm : 0.5;
        // 焊盘包络（D-33-1）：库房焊盘常伸出本体，规划/复核都必须按"本体 ∪ 焊盘"占位，
        // 否则会出现"本体离板边 1mm 合规、焊盘却压/越板框"（真机 U1 顶排 12 个焊盘）。
        let copperPads = [];
        let copperRead = null;
        let padOutlineCheck = null;
        try {
          copperRead = (await bridge.execute('pcb.copper.read', {}))?.result;
          copperPads = Array.isArray(copperRead?.pads) ? copperRead.pads : [];
          padOutlineCheck = checkPadOutlineClearance({ pads: copperPads, outline, clearanceMil: Number(body.padOutlineClearanceMil ?? 11.8) });
        } catch (error) {
          padOutlineCheck = { ok: null, checked: 0, violations: [], findings: [], note: `读不到铜皮，无法做焊盘级板框复核：${String(error?.message || error).slice(0, 160)}` };
        }
        const layoutEvidence = await readLayoutEvidence(resolvedPcbUuid, copperRead);
        // 可选：读板/预演时自动跑一次官方 DRC（只读 validate，不写板）。默认关闭，
        // 由调用方显式给 autoDrc=true；失败不阻断布局，只让 GATE-02 保持 REVIEW。
        let autoDrcReport = null;
        let autoDrcError = null;
        if (body.autoDrc === true && !(body.drcReport && typeof body.drcReport === 'object')) {
          try { autoDrcReport = (await bridge.execute('pcb.drc', {}))?.result ?? null; }
          catch (error) { autoDrcError = String(error?.message || error).slice(0, 200); }
        }
        const padEnvelopes = buildPadEnvelopes(copperPads, components);
        const outlineField = buildOutlineField(outline);
        const plan = planOutlinePlacement({ outline, components, affinity, edgeClearanceMm, spacingMm, gridMm, padEnvelopes, outlineField, anchors: body.anchors && typeof body.anchors === 'object' ? body.anchors : {} });
        const verifyOptions = { outline, edgeClearanceMm, spacingMm, outlineField, overhangAllowances: body.overhangAllowances && typeof body.overhangAllowances === 'object' ? body.overhangAllowances : {} };
        const plannedPlacements = plan.placements.map((item) => ({ ...item, padEnvelope: item.padEnvelope || padEnvelopes[item.ref] || null }));
        // 复核现状必须带上 side：双面板上"底面器件"与"顶面器件"的包围盒重叠不代表碰撞（D-62）。
        const currentPlacements = components.filter((component) => component.current && component.widthMm).map((component) => ({ ref: component.ref, xMm: component.current.xMm, yMm: component.current.yMm, widthMm: component.widthMm, heightMm: component.heightMm, rotationDeg: component.current.rotationDeg, side: component.side || 'top', padEnvelope: padEnvelopes[component.ref] || null }));
        result = {
          ok: true, outline: { points: outline.points, bounds: outline.bounds, source: readback?.outline?.[0]?.source ?? null, closed: outline.closed },
          source: 'eda-live', componentCount: components.length, unknownSize: unknown.map((item) => item.ref),
          affinity: { netCount: affinity.netCount, topPairs: [...affinity.pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) },
          plan: { ...plan, placements: plannedPlacements }, verification: verifyOutlinePlacement({ placements: plannedPlacements, ...verifyOptions }),
          currentVerification: verifyOutlinePlacement({ placements: currentPlacements, ...verifyOptions }),
          padOutlineCheck, padEnvelopes,
          diff: diffPlacement(currentPlacements, plannedPlacements), verifyOptions, pcbUuid: resolvedPcbUuid,
          layoutAudit: auditPlacementPlan({ plan: { ...plan, placements: plannedPlacements }, readback, outline, ...layoutEvidence, intent: layoutIntent, drcReport: body.drcReport && typeof body.drcReport === 'object' ? body.drcReport : autoDrcReport, drcScope: typeof body.drcScope === 'string' && body.drcScope ? body.drcScope : `${resolvedPcbUuid}/plan` }),
          drcAuto: { requested: body.autoDrc === true, used: Boolean(autoDrcReport), error: autoDrcError },
        };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/placement/apply') {
        // 写回布局：默认 dryRun，逐项回读比对 + 几何复核，不通过自动回滚；永不自动保存。
        const body = await readBody(request);
        const layoutIntent = (body.designIntent ?? body.intent) ? normalizeLayoutIntent(body.designIntent ?? body.intent) : null;
        if (!body.plan || !Array.isArray(body.plan.placements)) throw Object.assign(new Error('缺少 plan.placements'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        if (body.dryRun === false) await requireWriteApproval(body);
        await ensureEdaSession();
        const { readback, pcbUuid: resolvedPcbUuid } = await readPcbPlacement(body.pcbUuid);
        const outline = body.outline?.points ? { points: body.outline.points } : parsePolygonSource(readback?.outline?.[0]?.source);
        const verifyOptions = { outline, outlineField: buildOutlineField(outline), edgeClearanceMm: Number.isFinite(body.edgeClearanceMm) ? body.edgeClearanceMm : 1, spacingMm: Number.isFinite(body.spacingMm) ? body.spacingMm : 0.5, overhangAllowances: body.overhangAllowances && typeof body.overhangAllowances === 'object' ? body.overhangAllowances : {} };
        // A9：写回前先过 128 条规则审计；硬门禁里"真的量到违规"的项阻断写入。
        const layoutEvidence = await readLayoutEvidence(resolvedPcbUuid);
        let autoDrcReport = null;
        let autoDrcError = null;
        if (body.autoDrc === true && !(body.drcReport && typeof body.drcReport === 'object')) {
          try { autoDrcReport = (await bridge.execute('pcb.drc', {}))?.result ?? null; }
          catch (error) { autoDrcError = String(error?.message || error).slice(0, 200); }
        }
        const layoutAudit = auditPlacementPlan({ plan: body.plan, readback, outline, ...layoutEvidence, intent: layoutIntent, drcReport: body.drcReport && typeof body.drcReport === 'object' ? body.drcReport : autoDrcReport, drcScope: typeof body.drcScope === 'string' && body.drcScope ? body.drcScope : `${resolvedPcbUuid}/apply` });
        if (body.dryRun === false && !layoutAudit.ok) {
          throw Object.assign(new Error(`布局计划未通过规则审计：${layoutAudit.blocking.map((item) => `${item.ruleId} ${item.message}`).join('；') || '命中硬门禁'}`), { code: 'PLACEMENT_RULES_BLOCKED', status: 409, details: { audit: layoutAudit } });
        }
        result = await applyPlacementPlan({ execute: (commandId, args, options) => bridge.execute(commandId, args, options), plan: body.plan, readback, dryRun: body.dryRun !== false, verifyOptions, save: false });
        result.layoutAudit = layoutAudit;
        result.drcAuto = { requested: body.autoDrc === true, used: Boolean(autoDrcReport), error: autoDrcError };
      } else if (method === 'POST' && url.pathname === '/api/eda/pins/evidence') {
        /**
         * A4：引脚证据采集（只读，不改板）。
         * 以 PCB 焊盘为权威来源（位号/脚号/网络/层/通孔），可选切到原理图读器件位号做覆盖比对，
         * 再切回 PCB（不让调用者留在一个"被偷偷切走"的文档上）。
         * 未知网络必须由调用方显式给 assumption（含理由），否则 audit.ok=false —— 缺证据就是阻断。
         */
        const body = await readBody(request);
        const assumptions = Array.isArray(body.assumptions) ? body.assumptions : [];
        await ensureEdaSession();
        await ensurePcbDocument(body.pcbUuid);
        const copper = (await bridge.execute('pcb.copper.read', {}))?.result ?? {};
        const pads = Array.isArray(copper.pads) ? copper.pads : [];
        let schematicParts = null;
        if (body.includeSchematic === true) {
          try {
            await ensureSchematicDocument(typeof body.schematicUuid === 'string' && body.schematicUuid ? body.schematicUuid : null);
            const parts = (await bridge.execute('schematic.parts.read', {}))?.result;
            schematicParts = Array.isArray(parts) ? parts : [];
          } catch (error) {
            schematicParts = null;
            // 原理图读不到不是"通过"：evidence.schematic.parts 置 null，并在 audit 里作为警告如实说出。
          } finally {
            try { await ensurePcbDocument(body.pcbUuid); } catch { /* 切回失败会在后续步骤暴露，不在这里假装成功 */ }
          }
        }
        const evidence = buildPinEvidence({ pads, schematicParts: schematicParts || [], assumptions });
        const audit = auditPinEvidence(evidence);
        result = {
          ok: true,
          evidence,
          audit,
          readback: { pads: pads.length, components: Array.isArray(copper.pads) ? new Set(pads.map((pad) => String(pad?.designator ?? ''))).size : 0, schematicParts: schematicParts === null ? null : schematicParts.length },
        };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/routing/plan') {
        // 只读：读铜几何快照 → 找断网 → 间距感知布线（A*）→ 独立几何复核。不写 EDA。
        const body = await readBody(request);
        await ensureEdaSession();
        await ensurePcbDocument();
        const snapshot = await bridge.execute('pcb.copper.read', {});
        const geometry = snapshot?.result ?? snapshot;
        const requestedNets = Array.isArray(body.nets) && body.nets.length ? new Set(body.nets.map((net) => String(net))) : null;
        const maxConnections = Number.isFinite(body.maxConnections) ? body.maxConnections : 24;
        // 指定网络时必须先在**全部断网**里找目标再截断：旧实现先用默认 24 条截断再过滤，
        // 于是 `nets:['MOTOR']` 永远返回 0 条（目标网络根本不在前 24 条里），把"按网布线"变成了假功能。
        const { connections, analysis } = buildRepairConnections(geometry, requestedNets ? { maxConnections: 5000 } : { maxConnections });
        const targets = (requestedNets ? connections.filter((connection) => requestedNets.has(connection.net)) : connections).slice(0, maxConnections);
        const options = body.options && typeof body.options === 'object' ? { ...body.options } : {};
        // 真机缺陷（第 58 轮）：规划器默认只认 [1,2,17,18] 层，把 4 层板的内层写成 17/18（不存在的层），
        // 于是计划里出现 layer 17 → 应用到 EDA 必然 Bridge 500。这里按**实机铜层列表**覆盖 layers，
        // 内层默认取实机第一张内层（4 层板=15），保证"计划写的就是板子真有的层"。
        try {
          const layerReadback = (await bridge.execute('pcb.layers.read', {}))?.result;
          const selection = selectRoutableLayers(layerReadback);
          if (selection) {
            options.layers = selection.layers;
            if (!Number.isInteger(Number(options.innerLayer)) && selection.innerLayer) options.innerLayer = selection.innerLayer;
          }
        } catch { /* 读层失败就保留默认，由后续复核拦截 */ }
        // 自主规划：三种顺序各算一遍（原序/反序/按起点拥挤度），挑"全通且复核通过"的那份。
        // 每规划成一条就把它的铜当作互斥障碍，后面的路线必须绕开它——否则同批计划会互相交叉。
        const planned = planRepairRoutes({ geometry, connections: targets, options });
        const routes = planned.routes;
        const verification = planned.verification;
        result = {
          ok: true, source: 'eda-live', copper: analysis.counts,
          brokenNets: analysis.nets.filter((entry) => !entry.connected).map((entry) => ({ net: entry.net, islands: entry.islands.length, items: entry.itemCount })),
          requested: targets.length,
          routes: routes.map((route) => (route.ok
            ? { ok: true, net: route.net, fanout: route.fanout, viaInPad: route.viaInPad, from: route.from, segments: route.segments, vias: route.vias, expansions: route.expansions }
            : { ok: false, net: route.net, reason: route.reason, attempts: route.attempts })),
          verification,
          processNote: routes.some((route) => route.ok && route.viaInPad) ? '含盘中孔（via-in-pad）换层：量产需树脂塞孔/电镀填平工艺，计划中已标注' : null,
        };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/routing/apply') {
        // 受控写入：默认 dryRun；独立复核不通过直接拒写；写后回读比对，对不上自动回滚；保存必须显式要求。
        const body = await readBody(request);
        if (!body.plan || !Array.isArray(body.plan.routes)) throw Object.assign(new Error('缺少 plan.routes'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        if (body.dryRun === false) await requireWriteApproval(body);
        await ensureEdaSession();
        await ensurePcbDocument();
        const snapshot = await bridge.execute('pcb.copper.read', {});
        // 真机教训：计划复核通过 ≠ EDA 精确几何 DRC 通过。真实写入后必须跑一次官方 DRC，
        // 只比较"新增"违规；有新增就自动回滚本批铜（见 engineering/routing-drc.mjs）。
        // body.verifyDrc === false 是显式逃生门（会记录在返回里，便于审计"为什么没校验"）。
        result = await applyRoutingWithDrcGuard({
          execute: (commandId, args, options) => bridge.execute(commandId, args, options),
          plan: body.plan,
          geometry: snapshot?.result ?? snapshot,
          dryRun: body.dryRun !== false,
          save: body.save === true,
          options: body.options && typeof body.options === 'object' ? body.options : {},
          verifyDrc: body.verifyDrc !== false,
          logger,
        });
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/routing/rollback') {
        // 受控回滚：把上一批不合规的铜删掉，并回读确认真的删干净了
        const body = await readBody(request);
        await requireWriteApproval(body);
        await ensureEdaSession();
        await ensurePcbDocument();
        result = await rollbackRouting({
          execute: (commandId, args, options) => bridge.execute(commandId, args, options),
          items: body.items,
        });
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/routing/finish') {
        // 布线收尾：新铜会切平面所以要重建铺铜；保存是不可逆动作，必须显式要求（默认两者都做，但要经过受控授权）。
        const body = await readBody(request);
        await requireWriteApproval(body);
        await ensureEdaSession();
        await ensurePcbDocument();
        result = await finishRouting({
          execute: (commandId, args, options) => bridge.execute(commandId, args, options),
          rebuildPours: body.rebuildPours !== false,
          save: body.save !== false,
        });
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/pour/create') {
        /**
         * A11 新建覆铜（真机验证过的通道）：
         *   PCB_MathPolygon.createComplexPolygon(flat) + PCB_PrimitivePour.create(net,layer,cp,...)
         * 一定会写板 → 必须消费 write 批准；写入后**按属性读回**（网络/层），不是只看数量。
         * `cleanup:true` 是能力验证模式：建后立即删除并把数量读回，不保存（用于真机自检，绝不留残渣）。
         * 任何读回不符：先删掉本次新建图元再报错，绝不把失败当成功。
         */
        const body = await readBody(request);
        const net = typeof body.net === 'string' ? body.net.trim() : '';
        if (!net) throw Object.assign(new Error('覆铜必须指定 net'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        const layer = Number(body.layer);
        if (!Number.isInteger(layer) || layer < 1 || layer > 64) throw Object.assign(new Error('覆铜层必须是 1..64 的整数'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        const outline = Array.isArray(body.outline) ? body.outline : null;
        const complexPolygon = body.complexPolygon && typeof body.complexPolygon === 'object' ? body.complexPolygon : null;
        if (!complexPolygon && !(outline && outline.length >= 3 && outline.every((point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === 'number' && Number.isFinite(value))))) {
          throw Object.assign(new Error('覆铜需要 outline（至少 3 个 [x,y] 数字点）或 complexPolygon'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        }
        const pourArgs = {
          net, layer,
          ...(complexPolygon ? { complexPolygon } : { outline }),
          pourName: typeof body.pourName === 'string' && body.pourName.trim() ? body.pourName.trim() : net,
          preserveSilos: body.preserveSilos === true,
          pourPriority: Number.isFinite(Number(body.pourPriority)) ? Number(body.pourPriority) : 0,
          lineWidth: Number.isFinite(Number(body.lineWidth)) ? Number(body.lineWidth) : 0.2,
          primitiveLock: body.primitiveLock === true,
        };
        await requireWriteApproval(body);
        await ensureEdaSession();
        await ensurePcbDocument(body.pcbUuid);
        const readPours = async () => {
          const value = await bridge.execute('pcb.pours.detail', {});
          return Array.isArray(value?.result) ? value.result : (Array.isArray(value) ? value : []);
        };
        const before = await readPours();
        const beforeIds = before.map((item) => String(item.primitiveId));
        const rollbackCreated = async (createdId) => {
          try {
            await bridge.execute('pcb.pour.delete', { primitiveId: createdId }, { allowWrite: true });
            const afterRollback = await readPours();
            return { attempted: true, ok: !afterRollback.some((item) => String(item.primitiveId) === createdId), pours: afterRollback.length };
          } catch (error) {
            return { attempted: true, ok: false, error: String(error?.code || error?.message || error) };
          }
        };
        let createdId = null;
        try {
          const created = await bridge.execute('pcb.pour.create', pourArgs, { allowWrite: true });
          const createdValue = created?.result ?? created;
          createdId = typeof createdValue?.primitiveId === 'string' ? createdValue.primitiveId : null;
          const after = await readPours();
          const newItems = after.filter((item) => !beforeIds.includes(String(item.primitiveId)));
          if (!createdId) createdId = newItems.length === 1 ? String(newItems[0].primitiveId) : null;
          const matched = newItems.filter((item) => String(item.net) === net && Number(item.layer) === layer);
          const verification = {
            poursBefore: before.length,
            poursAfter: after.length,
            newCount: newItems.length,
            newIds: newItems.map((item) => String(item.primitiveId)),
            matched: matched.map((item) => ({ primitiveId: String(item.primitiveId), net: String(item.net), layer: Number(item.layer), pourName: item.pourName })),
            createdId,
          };
          if (newItems.length !== 1 || matched.length !== 1 || !createdId) {
            const rollback = createdId ? await rollbackCreated(createdId) : { attempted: false, ok: true };
            throw Object.assign(new Error(`覆铜创建后读回不符：新增 ${newItems.length} 个、网络/层匹配 ${matched.length} 个（期望各 1 个）`), { code: 'PCB_POUR_VERIFY_FAILED', status: 409, details: { verification, rollback } });
          }
          if (body.cleanup === true) {
            const cleanup = await rollbackCreated(createdId);
            const finalPours = cleanup.pours ?? null;
            if (!cleanup.ok) throw Object.assign(new Error('覆铜验证模式清理失败：新建图元未删干净，不能声称验证通过'), { code: 'PCB_POUR_ROLLBACK_INCOMPLETE', status: 409, details: { verification, cleanup } });
            result = { ok: true, mode: 'verify-cleanup', created: { primitiveId: createdId, net, layer }, verification, cleanup, saved: false };
          } else {
            let saved = null;
            if (body.save !== false) {
              const saveResult = await bridge.execute('pcb.save', {}, { allowWrite: true });
              const saveValue = saveResult?.result ?? saveResult;
              if (saveValue !== true) {
                const rollback = await rollbackCreated(createdId);
                throw Object.assign(new Error('覆铜创建后保存未确认（pcb.save 未返回 true）'), { code: 'SAVE_FAILED', status: 409, details: { verification, rollback } });
              }
              saved = true;
            }
            result = { ok: true, mode: 'create', created: { primitiveId: createdId, net, layer }, verification, saved };
          }
        } catch (error) {
          if (error?.code === 'PCB_POUR_VERIFY_FAILED' || error?.code === 'PCB_POUR_ROLLBACK_INCOMPLETE' || error?.code === 'SAVE_FAILED') throw error;
          // 创建本身失败/超时：按 id 尽力回收并给出可诊断的边界（超时可能已在 EDA 侧创建，读回里能看到的就算数）。
          const after = await readPours().catch(() => []);
          const leaked = after.filter((item) => !beforeIds.includes(String(item.primitiveId)));
          let rollback = { attempted: false, ok: true };
          if (leaked.length) {
            const results = [];
            for (const item of leaked) results.push(await rollbackCreated(String(item.primitiveId)));
            rollback = { attempted: true, ok: results.every((item) => item.ok), results };
          }
          throw Object.assign(new Error(`覆铜创建失败：${error?.message || error}`), { code: error?.code || 'PCB_POUR_CREATE_FAILED', status: error?.status || 409, details: { rollback, leaked: leaked.map((item) => String(item.primitiveId)) } });
        }
      } else if (method === 'GET' && url.pathname === '/api/eda/pcb/pours') {
        // E8：半写回滚需要"运行前覆铜 id 快照"；只读，确保在 PCB 文档上下文。
        await ensureEdaSession();
        await ensurePcbDocument();
        const pours = await bridge.execute('pcb.pours.detail', {});
        result = { ok: true, pours: pours?.result ?? pours };
      } else if (method === 'GET' && url.pathname === '/api/eda/pcb/layers') {
        /**
         * 叠层只读：铜层数 + 层列表。
         * 这是"2 层改 4 层"产品入口的读侧：UI 必须先看到当前层数/层列表，才能提出变更。
         * 读失败（copperCount 不是整数）一律 409——绝不把"读不到"当成 2 层/0 层成功返回，
         * 否则用户会以为板子只有 2 层而做出错误叠层决策。
         */
        await ensureEdaSession();
        await ensurePcbDocument();
        const copperCount = (await bridge.execute('pcb.layers.copperCount'))?.result;
        if (!Number.isInteger(copperCount)) {
          throw Object.assign(new Error(`读取 PCB 铜层数失败：${JSON.stringify(copperCount)}`), { code: 'PCB_LAYER_COUNT_READ_FAILED', status: 409 });
        }
        const layerList = (await bridge.execute('pcb.layers.read'))?.result;
        // 桥层自第 60 轮起返回 {layers,enabledCopperIds,configuredCount}（归一化），旧桥仍可能返回数组。
        const layers = Array.isArray(layerList) ? layerList : Array.isArray(layerList?.layers) ? layerList.layers : [];
        result = { ok: true, layers: { copperCount, count: layers.length, layers, enabledCopperIds: Array.isArray(layerList?.enabledCopperIds) ? layerList.enabledCopperIds : null, configuredCount: layerList?.configuredCount ?? null } };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/layers') {
        /**
         * 设置叠层铜层数（2,4,6,…,32）。
         *
         * 这是**写板**动作（官方 Beta API setTheNumberOfCopperLayers）：
         *   - 先校验层数（非法值在批准之前就 400，不浪费一次性批准）；
         *   - 必须消费一次服务端签发、绑定当前窗口+工程+文档指纹的 write 批准；
         *   - 写后必须回读校验：层数一致 + 每个铜层 id 存在且 type=SIGNAL。
         *     官方 Beta 返回 true 不代表层列表真的变了（真机出现过"返回成功、层数不变"），
         *     所以绝不凭 setCount 的返回值声称成功；读回不符 → 409 并带 before/after/expectedLayerIds。
         *   - 保存默认执行（save !== false）；pcb.save 未确认 true → SAVE_FAILED，不假装已保存。
         */
        const body = await readBody(request);
        const copperLayers = Number(body.copperLayers);
        if (!isEdaCopperLayerCount(copperLayers)) {
          throw Object.assign(new Error(`铜层数必须是 ${PLAN_COPPER_LAYER_COUNTS.join('/')} 之一：${JSON.stringify(body.copperLayers)}`), {
            code: 'EDA_COMMAND_ARGS_INVALID', status: 400,
            details: { copperLayers: body.copperLayers ?? null, allowed: PLAN_COPPER_LAYER_COUNTS },
          });
        }
        const approvedTarget = await requireWriteApproval(body);
        await ensureEdaSession();
        await ensurePcbDocument();
        // 读 before/after 都走同一套读取函数：任何一次铜层数读失败都显式报错，不返回伪快照。
        const readLayerStack = async () => {
          const copperCountNow = (await bridge.execute('pcb.layers.copperCount'))?.result;
          if (!Number.isInteger(copperCountNow)) {
            throw Object.assign(new Error(`读取 PCB 铜层数失败：${JSON.stringify(copperCountNow)}`), { code: 'PCB_LAYER_COUNT_READ_FAILED', status: 409 });
          }
          const listed = (await bridge.execute('pcb.layers.read'))?.result;
          const listedLayers = Array.isArray(listed) ? listed : Array.isArray(listed?.layers) ? listed.layers : [];
          return { copperCount: copperCountNow, layers: listedLayers };
        };
        const before = await readLayerStack();
        const setOutcome = await bridge.execute('pcb.layers.setCount', { layers: copperLayers }, { allowWrite: true });
        if ((setOutcome?.result ?? setOutcome) !== true) {
          throw Object.assign(new Error('设置铜层数未确认（pcb.layers.setCount 未返回 true）'), {
            code: 'PCB_LAYER_COUNT_SET_FAILED', status: 409,
            details: { before, requested: copperLayers },
          });
        }
        const after = await readLayerStack();
        // 叠层第 N 层 ≠ 层号 N：4 层是 [1,15,16,2]。这里只能信 layers.mjs 的换算。
        const expectedLayerIds = copperLayerIds(copperLayers);
        const layerById = new Map(after.layers.map((layer) => [Number(layer?.id), layer]));
        const missingLayerIds = expectedLayerIds.filter((id) => !layerById.has(id));
        const wrongTypeLayerIds = expectedLayerIds.filter((id) => layerById.has(id) && String(layerById.get(id)?.type || '').toUpperCase() !== 'SIGNAL');
        if (after.copperCount !== copperLayers || missingLayerIds.length || wrongTypeLayerIds.length) {
          throw Object.assign(new Error(`设置铜层数后读回不符：期望 ${copperLayers} 层（铜层 ${expectedLayerIds.join('/')} 均为 SIGNAL），实际 ${after.copperCount} 层；缺层 ${missingLayerIds.join('/') || '无'}，类型不符 ${wrongTypeLayerIds.join('/') || '无'}`), {
            code: 'PCB_LAYER_COUNT_VERIFY_FAILED', status: 409,
            details: { before, after, expectedLayerIds, missingLayerIds, wrongTypeLayerIds },
          });
        }
        let saved = false;
        if (body.save !== false) {
          const saveOutcome = await bridge.execute('pcb.save', {}, { allowWrite: true });
          if ((saveOutcome?.result ?? saveOutcome) !== true) {
            throw Object.assign(new Error('铜层数设置成功但保存未确认（pcb.save 未返回 true）'), {
              code: 'SAVE_FAILED', status: 409,
              details: { before, after, expectedLayerIds },
            });
          }
          saved = true;
        }
        const changed = before.copperCount !== after.copperCount;
        // 取证：把 before/after/expected/saved 落成可复核证据，而不是只活在这一次 HTTP 响应里。
        // 证据类型 pcb-layer-stack 已登记在 evidence-store.mjs 的 EVIDENCE_KINDS 白名单。
        // 取证仍按 best-effort：证据写不进去时如实记日志，但绝不把已经生效/已保存的写板判成失败，
        // 也绝不假装证据已落盘（前端/发布门禁读取证据账本，不以 HTTP 200 当证据）。
        try {
          const entry = evidenceStore.save({
            kind: 'pcb-layer-stack',
            payload: {
              command: 'pcb.layers.setCount',
              copperLayers, changed, saved,
              before: { copperCount: before.copperCount, layers: before.layers },
              after: { copperCount: after.copperCount, layers: after.layers },
              expected: { copperLayers, layerIds: expectedLayerIds },
              verification: { matched: true },
            },
            fingerprint: { windowId: approvedTarget.windowId, projectUuid: approvedTarget.projectUuid, documentUuid: approvedTarget.documentUuid },
            note: 'PCB 叠层铜层数变更取证（写后读回校验通过）',
          });
          logger.info('Pcb', 'PCB layer stack evidence recorded', { digest: entry.digest, path: entry.path, copperLayers, saved });
        } catch (error) {
          logger.warn('Pcb', 'PCB layer stack evidence not persisted', { code: error?.code || 'EVIDENCE_WRITE_FAILED', message: String(error?.message || error).slice(0, 200), copperLayers });
        }
        result = {
          ok: true,
          changed,
          copperLayers,
          before: { copperCount: before.copperCount, layers: before.layers },
          after: { copperCount: after.copperCount, layers: after.layers },
          verification: { expectedLayerIds, matched: true },
          saved,
        };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/drc/start') {
        await ensureEdaSession();
        // 修复：错误信息一直提示"可在请求里填 PCB 文档 UUID"，但这里从未读取 body.pcbUuid，
        // 于是 EDA 重启/切文档后必然 409（PCB_DOCUMENT_REQUIRED），DRC 无法启动。
        const drcStartBody = await readBody(request);
        await ensurePcbDocument(typeof drcStartBody.pcbUuid === 'string' && drcStartBody.pcbUuid ? drcStartBody.pcbUuid : undefined);
        // DRC 只能"受理 + 轮询"：它是渲染进程里的长任务，塞进一个同步 HTTP 请求里
        // 就是本项目反复踩的那个坑（超时后没人知道它是否还在跑）。
        const jobId = crypto.randomUUID();
        const started = await bridge.execute('pcb.drc.job.start', { jobId, userInterface: drcStartBody.userInterface === true }, { allowWrite: true });
        result = { ok: true, jobId, state: (started.result ?? started)?.state || 'running', startedAt: (started.result ?? started)?.startedAt ?? null };
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/drc/cancel') {
        await ensureEdaSession();
        // DRC 是渲染进程里的长任务：卡住时必须能收口，否则下一次 DRC 会被 EDA_JOB_BUSY 挡住。
        // 这里只做"标记取消 + 如实回报状态"，不假装能中断 EDA 侧已在跑的调用。
        const body = await readBody(request);
        if (!body.jobId || typeof body.jobId !== 'string') {
          status = 400;
          result = { ok: false, error: { code: 'EDA_COMMAND_ARGS_INVALID', message: '缺少 jobId' } };
        } else {
          const cancelled = await bridge.execute('pcb.job.cancel', { jobId: body.jobId });
          result = { ok: true, jobId: body.jobId, cancelled: cancelled?.result ?? cancelled ?? null };
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/pcb/drc/report') {
        await ensureEdaSession();
        // 拿结果：运行中就如实返回 running（客户端自己决定再轮询），完成了才归一化 + 归类。
        const body = await readBody(request);
        const polled = await bridge.execute('pcb.job.poll', { jobId: body.jobId });
        const job = polled.result ?? polled;
        if (!job || job.state === 'running' || job.state === 'pending' || job.state === 'unknown') {
          result = { ok: true, state: job?.state || 'unknown', jobId: body.jobId, raw: job || null };
        } else if (job.state !== 'done') {
          result = { ok: true, state: job.state, jobId: body.jobId, error: job.error || null };
        } else {
          const normalized = normalizeDrcReport(job);
          const file = typeof body.exemptionPath === 'string' && body.exemptionPath ? body.exemptionPath : defaultExemptionPath();
          const stored = Array.isArray(body.exemptions) ? { path: file, exists: false, exemptions: body.exemptions, invalid: [] } : loadExemptionFile(file);
          const classification = classifyDrcItems({ items: normalized.items, exemptions: stored.exemptions, reportedCount: normalized.reportedCount, truncated: normalized.truncated });
          // 落盘的是**全量归一化报告**（不是给 UI 的 500 条截断版）：放行闸门必须看到全部条目。
          const savedEntry = body.persist === false ? null : evidenceStore.save({
            kind: 'drc-report',
            payload: { report: normalized, classification, jobId: body.jobId, pcbUuid: typeof body.pcbUuid === 'string' && body.pcbUuid ? body.pcbUuid : null },
            fingerprint: { jobId: body.jobId, pcbUuid: typeof body.pcbUuid === 'string' && body.pcbUuid ? body.pcbUuid : null },
            note: 'pcb drc job report',
          });
          result = {
            ok: true, state: 'done', jobId: body.jobId,
            report: { ...normalized, items: normalized.items.slice(0, 500), itemsTruncatedForTransport: normalized.items.length > 500 },
            classification,
            exemptions: { path: stored.path, exists: stored.exists, count: stored.exemptions.length, invalid: stored.invalid },
            template: buildExemptionTemplate(normalized.items),
            ...(savedEntry ? { saved: { path: savedEntry.path, digest: savedEntry.digest, savedAt: savedEntry.savedAt, schemaVersion: savedEntry.schemaVersion } } : {}),
          };
        }
      } else if (method === 'GET' && url.pathname === '/api/eda/pcb/drc/exemptions') {
        result = { ok: true, ...(await loadDrcExemptionFileForCurrentProject()) };
      } else if (method === 'PUT' && url.pathname === '/api/eda/pcb/drc/exemptions') {
        const body = await readBody(request);
        // 写到"当前工程"的豁免文件（不写到全局文件，避免跨项目污染）
        const current = await loadDrcExemptionFileForCurrentProject();
        result = { ok: true, ...saveExemptionFile(current.path, Array.isArray(body.exemptions) ? body.exemptions : []) };
      } else if (method === 'GET' && url.pathname === '/api/eda/pcb/drc/latest') {
        // 最近一次真机 DRC 取证（落盘文件）。UI 用它自动填充闸门证据，不再手抄路径。
        const pcbUuid = url.searchParams.get('pcbUuid');
        result = { ok: true, evidence: evidenceStore.latest('drc-report', pcbUuid ? { fingerprint: { pcbUuid } } : {}) };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/erc/run') {
        // 原理图 ERC 取证（只读）：执行 EDA 的 schematic.drc → 归一化/分类 → 套用豁免 → 落盘证据。
        // 与 PCB DRC 一样，缺明细时如实标注 aggregateOnly，绝不把聚合计数当逐条结论。
        const body = await readBody(request);
        await ensureEdaSession();
        // 真机验收（第 60 轮）：明细只能从"当前活动原理图"的 ERC 面板抓；如果活动文档是 PCB，
        // 面板里是 PCB DRC（或根本没有 ERC 面板），绝不能拿它冒充 ERC 明细。
        const schematicTarget = await ensureSchematicDocument(typeof body.schematicUuid === 'string' && body.schematicUuid ? body.schematicUuid : null);
        const raw = await bridge.execute('schematic.drc', {});
        const normalized = normalizeErcReport(raw?.result ?? raw);
        // EDA 扩展 API 只给聚合计数；明细从 EDA 检查面板抓（产品能力，见 eda-erc-detail.mjs）。
        // 抓到就升级成逐条结论；抓不到就保留聚合结论并如实说明原因，不静默吞掉。
        let ercDetailMeta = null;
        let report = normalized;
        let targetBefore = null;
        if (normalized.aggregateOnly && (normalized.counts.error > 0 || normalized.counts.fatal > 0 || normalized.counts.warning > 0)) {
          // 明细是从"当前 EDA 界面"抓的：抓之前和抓之后必须是同一个窗口/工程/文档，
          // 否则明细可能属于别的文档（EDA 面板可能残留上一块板的结果）——宁可不用，也不能张冠李戴。
          targetBefore = await currentEdaFingerprint().catch(() => null);
          // ERC 明细可能是"点击检查 → EDA 现场跑一遍 → 流式出结果"，预算给足 45s；
          // 内部有截止时间，最坏情况返回部分明细，不会让整条 ERC 取证失败。
          const detail = await extractErcDetail({ gui: guiClient, timeoutMs: 45_000, expectedCounts: normalized.counts });
          const targetAfterDetail = await currentEdaFingerprint().catch(() => null);
          const targetStable = !targetBefore || !targetAfterDetail || targetBefore.fingerprint === targetAfterDetail.fingerprint;
          const merged = targetStable ? mergeErcDetail(normalized, detail) : null;
          if (merged && merged.detailSource) {
            report = merged;
            ercDetailMeta = { ok: true, source: merged.detailSource, counts: merged.detailCounts ?? null };
          } else {
            ercDetailMeta = {
              ok: false,
              reason: targetStable ? String(detail?.reason || 'DETAIL_UNAVAILABLE').slice(0, 200) : 'EDA_TARGET_CHANGED_DURING_DETAIL',
              targetBefore: targetBefore?.fingerprint ?? null,
              targetAfter: targetAfterDetail?.fingerprint ?? null,
            };
          }
        }
        const exemptionFile = await loadErcExemptionFileForCurrentProject();
        const applied = applyErcExemptions(report, exemptionFile.exemptions);
        // 多板工程必须能回答"这次 ERC 到底检查的是哪一页原理图"：否则全 0 结果无法判断是
        // 设计干净还是切到了空板（真机第 60 轮踩过：默认取第一块板，得到假 0）。
        applied.documentUuid = schematicTarget?.schematicUuid ?? null;
        const target = targetBefore && (await currentEdaFingerprint().catch(() => null))?.fingerprint === targetBefore.fingerprint
          ? targetBefore
          : await currentEdaFingerprint();
        const entry = evidenceStore.save({
          kind: 'schematic-erc',
          payload: { report: applied, exemptionFile: { path: exemptionFile.path, exists: exemptionFile.exists, invalid: exemptionFile.invalid }, ercDetail: ercDetailMeta },
          fingerprint: { windowId: target.windowId, projectUuid: target.projectUuid, documentUuid: target.documentUuid },
          note: '原理图 ERC 取证（只读）',
        });
        result = { ok: true, erc: applied, summary: summarizeErcConvergence(applied), ercDetail: ercDetailMeta, saved: { path: entry.path, digest: entry.digest, savedAt: entry.savedAt } };
      } else if (method === 'GET' && url.pathname === '/api/eda/schematic/erc/latest') {
        result = { ok: true, evidence: evidenceStore.latest('schematic-erc') };
      } else if (method === 'GET' && url.pathname === '/api/eda/schematic/erc/exemptions') {
        result = { ok: true, ...(await loadErcExemptionFileForCurrentProject()) };
      } else if (method === 'PUT' && url.pathname === '/api/eda/schematic/erc/exemptions') {
        const body = await readBody(request);
        // 写到"当前工程"的 ERC 豁免文件，不写全局文件
        const currentExemptions = await loadErcExemptionFileForCurrentProject();
        const saved = saveErcExemptionFile(Array.isArray(body.exemptions) ? body.exemptions : [], currentExemptions.path);
        result = { ok: true, saved };
      } else if (method === 'POST' && url.pathname === '/api/production/dfm-evidence') {
        // 在线 DFM 只能人工做：这里只登记“人看过的结果”，不让本地检查冒充。
        const body = await readBody(request);
        if (typeof body.passed !== 'boolean') throw Object.assign(new Error('DFM 证据必须显式给出 passed: true/false'), { code: 'DFM_EVIDENCE_INVALID', status: 400 });
        const entry = evidenceStore.save({
          kind: 'dfm-evidence',
          payload: {
            passed: body.passed,
            operator: text(body.operator) || 'human',
            source: text(body.source) || '嘉立创在线DFM',
            conclusion: text(body.conclusion),
            url: text(body.url) || null,
            artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
            uploadedAt: new Date().toISOString(),
          },
          fingerprint: { planHash: text(body.planHash) || null, pcbUuid: text(body.pcbUuid) || null },
          note: body.note ?? null,
        });
        result = { ok: true, evidence: entry };
      } else if (method === 'POST' && url.pathname === '/api/production/order-confirmation') {
        /**
         * E3 / R10：下单参数卡人工确认 + 支付人工留痕。
         * 只落证据，不执行下单、不执行支付（服务端没有任何下单/支付能力可调用）。
         */
        const body = await readBody(request);
        const normalized = validateOrderConfirmation({ card: body.card, operator: body.operator, note: body.note, paymentManual: body.paymentManual });
        const entry = evidenceStore.save({
          kind: 'order-confirmation',
          payload: { ...normalized, source: 'ui-order-card', confirmedAt: new Date().toISOString() },
          fingerprint: { orderCardGeneratedAt: normalized.card.generatedAt, operator: normalized.operator },
          note: '下单参数卡人工确认（系统不代下单、不代付）',
        });
        logger.info('Production', 'Human order-card confirmation recorded', { digest: entry.digest, operator: normalized.operator });
        result = { ok: true, confirmation: { path: entry.path, digest: entry.digest, savedAt: entry.savedAt, payload: entry.payload } };
      } else if (method === 'GET' && url.pathname === '/api/production/order-confirmation/latest') {
        const entry = evidenceStore.latest('order-confirmation');
        result = { ok: true, evidence: entry ? { path: entry.path, digest: entry.digest, savedAt: entry.savedAt, payload: entry.payload } : null };
      } else if (method === 'GET' && url.pathname === '/api/production/dfm-evidence/latest') {
        const planHash = url.searchParams.get('planHash');
        result = { ok: true, evidence: evidenceStore.latest('dfm-evidence', planHash ? { fingerprint: { planHash } } : {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/signoff') {
        // 人工终审签核：三方角色 + 结论 + 绑定计划/清单哈希，服务端落盘（不可由客户端伪造“已签”）。
        const body = await readBody(request);
        const roles = Array.isArray(body.roles) ? body.roles.filter((item) => item && typeof item === 'object') : [];
        if (!roles.length) throw Object.assign(new Error('签核必须包含至少一个角色'), { code: 'SIGNOFF_INVALID', status: 400 });
        if (body.passed !== true) throw Object.assign(new Error('签核记录只登记“通过”的结论；未通过请记录 DFM/问题，不要伪造签核'), { code: 'SIGNOFF_INVALID', status: 400 });
        const manifestHash = text(body.manifestHash);
        if (!manifestHash) throw Object.assign(new Error('签核必须绑定物料清单哈希'), { code: 'SIGNOFF_INVALID', status: 400 });
        const entry = evidenceStore.save({
          kind: 'signoff',
          payload: {
            passed: true,
            operator: text(body.operator) || 'human',
            planHash: text(body.planHash) || null,
            manifestHash,
            conclusion: text(body.conclusion) || '人工终审通过',
            roles: roles.map((item) => ({ role: text(item.role), name: text(item.name), conclusion: text(item.conclusion) || '通过', signedAt: text(item.signedAt) || new Date().toISOString() })),
          },
          fingerprint: { planHash: text(body.planHash) || null, manifestHash, pcbUuid: text(body.pcbUuid) || null },
          note: body.note ?? null,
        });
        // 放行批准（release）的统一入链点：三方签核 = 人工放行批准。
        // 放行不是一次性令牌而是持久证据（签核文件 + 绑定哈希），最终由 buildReleaseDecision 裁决；
        // 这里把事实写进同一账本，使三类批准可在一处核对。
        approvalLedger.record({
          scope: 'release',
          action: 'issued',
          approvalId: String(entry.digest || '').slice(0, 16),
          bindings: { planHash: text(body.planHash) || null, manifestHash, pcbUuid: text(body.pcbUuid) || null },
          note: '人工终审签核（三方角色）',
        });
        result = { ok: true, evidence: entry };
      } else if (method === 'GET' && url.pathname === '/api/evidence/index') {
        // C5：证据索引（只读汇总）。扫描证据目录，坏文件/重复副本如实列出，不隐藏。
        const index = buildEvidenceIndex({ dirs: [evidenceRoot] });
        result = { ok: true, index };
      } else if (method === 'GET' && url.pathname === '/api/evidence/find') {
        const kind = text(url.searchParams.get('kind')) || undefined;
        const digest = text(url.searchParams.get('digest')) || undefined;
        if (!kind && !digest) throw Object.assign(new Error('按证据索引查找需要 kind 或 digest 至少一个'), { code: 'EVIDENCE_FIND_REQUIRED', status: 400 });
        const index = buildEvidenceIndex({ dirs: [evidenceRoot] });
        const evidence = findEvidence(index, { kind, digest });
        if (!evidence) throw Object.assign(new Error('证据索引里没有匹配项'), { code: 'EVIDENCE_NOT_FOUND', status: 404 });
        result = { ok: true, evidence, index: { generatedAt: index.generatedAt, complete: index.complete, summary: index.summary } };
      } else if (method === 'POST' && url.pathname === '/api/evidence/retention/plan') {
        // C5：保留计划（dry-run）。只生成计划，**没有任何删除能力**；时间未知/损坏条目一律保留。
        const body = await readBody(request);
        const index = buildEvidenceIndex({ dirs: [evidenceRoot] });
        const plan = planEvidenceRetention({
          index,
          keepPerKind: Number(body.keepPerKind) || undefined,
          keepDays: Number(body.keepDays) || undefined,
        });
        result = { ok: true, plan };
      } else if (method === 'POST' && url.pathname === '/api/evidence/retention/prune') {
        // 证据清理：**破坏性操作**，必须显式 confirm + 服务端写批准；默认 dryRun，只清理超出保留额度的旧条目，
        // 并返回可审计的 removed 列表（路径/摘要/落盘时间/原因）。产品默认策略仍是"只计划不删除"（上面的 plan 路由）。
        const body = await readBody(request);
        if (body.confirm !== 'prune-evidence') throw Object.assign(new Error('证据清理是破坏性操作，必须带 confirm:"prune-evidence"'), { code: 'EVIDENCE_PRUNE_CONFIRM_REQUIRED', status: 400 });
        const requestedKinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds.map((item) => text(item)) : [...EVIDENCE_KINDS];
        const unknownKinds = requestedKinds.filter((kind) => !EVIDENCE_KINDS.includes(kind));
        if (unknownKinds.length) throw Object.assign(new Error(`未知证据类型：${unknownKinds.join('、')}`), { code: 'EVIDENCE_KIND_INVALID', status: 400 });
        const dryRun = body.dryRun !== false;
        if (!dryRun) await requireWriteApproval(body);
        const reports = requestedKinds.map((kind) => pruneEvidenceStore({
          store: evidenceStore,
          kind,
          dryRun,
          maxAgeMs: Number(body.maxAgeDays) > 0 ? Number(body.maxAgeDays) * 86_400_000 : undefined,
          maxCount: Number(body.maxCount) > 0 ? Number(body.maxCount) : undefined,
          minKeep: Number(body.minKeep) >= 0 ? Number(body.minKeep) : undefined,
        }));
        result = { ok: true, dryRun, reports };
      } else if (method === 'POST' && url.pathname === '/api/artifacts/retention/plan') {
        // B10：制造物保留计划（dry-run）。只扫描进程工作目录下的白名单子目录，不接受任意路径。
        const body = await readBody(request);
        const allowedDirs = ['deliverables', 'release', 'manufacturing'];
        const roots = (Array.isArray(body.dirs) && body.dirs.length ? body.dirs : allowedDirs)
          .map((item) => text(item))
          .filter((item) => allowedDirs.includes(item));
        const entries = [];
        const walk = (dir, depth) => {
          if (depth > 3 || !existsSync(dir)) return;
          for (const name of readdirSync(dir)) {
            if (name.startsWith('.')) continue;
            const full = join(dir, name);
            let stat;
            try { stat = statSync(full); } catch { continue; }
            if (stat.isDirectory()) { walk(full, depth + 1); continue; }
            entries.push({
              kind: classifyArtifact(name),
              path: relative(process.cwd(), full),
              bytes: stat.size,
              createdAt: new Date(stat.mtimeMs).toISOString(),
            });
          }
        };
        for (const dir of roots) walk(join(process.cwd(), dir), 1);
        const plan = planRetention({ entries, policy: body.policy && typeof body.policy === 'object' ? body.policy : {} });
        result = { ok: true, plan, scanned: { dirs: roots, entries: entries.length } };
      } else if (method === 'GET' && url.pathname === '/api/production/signoff/latest') {
        const manifestHash = url.searchParams.get('manifestHash');
        result = { ok: true, evidence: evidenceStore.latest('signoff', manifestHash ? { fingerprint: { manifestHash } } : {}) };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/simulation/run') {
        /**
         * A14：SPICE 仿真证据取证（真跑求解器）。
         * 网表来源优先级：请求里显式 netlistText → EDA 导出的仿真网表；
         * 两者都没有/导出为空 ⇒ SIMULATION_NETLIST_REQUIRED（不伪造"仿真通过"）。
         * 只有 `runSimulation` 真实 spawn 出证据、且 `verifySimulationEvidence` 校验通过才落盘；
         * 没有求解器时返回结构化失败（含探测过的路径），不是值。
         */
        const body = await readBody(request);
        await ensureEdaSession();
        const schematic = await ensureSchematicDocument(body?.schematicUuid || null);
        let netlistText = typeof body.netlistText === 'string' && body.netlistText.trim() ? body.netlistText : null;
        let exportMeta = null;
        if (!netlistText) {
          try {
            const exported = (await bridge.execute('schematic.simulation.netlist.export', { fileName: 'circuitpilot-sim', netlistType: 'Ngspice' }))?.result ?? null;
            if (typeof exported?.text === 'string' && exported.text.trim()) {
              netlistText = exported.text;
              exportMeta = { name: exported.name ?? null, size: exported.size ?? null, inline: exported.inline !== false, chunks: Number(exported.chunks) || 1 };
            } else {
              exportMeta = exported ? { name: exported.name ?? null, size: exported.size ?? null, inline: exported.inline !== false, chunks: Number(exported.chunks) || 1, empty: true } : null;
            }
          } catch (error) {
            throw Object.assign(new Error(`SPICE 仿真网表导出失败：${String(error?.message || error).slice(0, 200)}`), { code: 'SIMULATION_NETLIST_EXPORT_FAILED', status: 409, details: { schematic } });
          }
        }
        if (!netlistText) {
          throw Object.assign(new Error('没有可用的 SPICE 网表：请求未提供 netlistText，且 EDA 导出为空（原理图可能没有绑定仿真模型）。仿真验收不可执行 ≠ 仿真通过。'), {
            code: 'SIMULATION_NETLIST_REQUIRED', status: 409, details: { schematic, exportMeta },
          });
        }
        const expectations = body.expectations && typeof body.expectations === 'object' && !Array.isArray(body.expectations) ? body.expectations : null;
        const outcome = await simulationRun({
          netlistText,
          solverPath: typeof body.solverPath === 'string' && body.solverPath ? body.solverPath : undefined,
          timeoutMs: Number.isFinite(Number(body.timeoutMs)) ? Number(body.timeoutMs) : undefined,
        });
        const verification = outcome.evidence
          ? verifySimulationEvidence(outcome.evidence, { netlistText })
          : { ok: false, findings: [{ code: outcome.code, message: outcome.message, severity: 'blocking', field: 'simulationEvidence' }] };
        const findings = [...(outcome.findings || []), ...(verification.findings || [])];
        if (!outcome.ran) {
          throw Object.assign(new Error(`仿真未跑成：${outcome.code} ${outcome.message}`), {
            code: outcome.code || 'SIMULATION_FAILED', status: 409,
            details: { schematic, exportMeta, findings, verification, netlist: { bytes: Buffer.byteLength(netlistText, 'utf8') } },
          });
        }
        if (!verification.ok) {
          throw Object.assign(new Error('求解器产出的证据没有通过校验（来源/网表指纹/产物哈希），不能作为验收证据'), {
            code: 'SIMULATION_EVIDENCE_INVALID', status: 409, details: { findings, verification },
          });
        }
        const pointFindings = expectations ? checkOperatingPoint(outcome.evidence.operatingPoint, expectations).findings : [];
        const target = await currentEdaFingerprint();
        const entry = body.persist === false ? null : evidenceStore.save({
          kind: 'spice-simulation',
          payload: { evidence: outcome.evidence, verification, findings: [...findings, ...pointFindings], exportMeta },
          fingerprint: { windowId: target.windowId, projectUuid: target.projectUuid, documentUuid: target.documentUuid },
          note: 'SPICE 仿真证据（真实求解器产出）',
        });
        result = {
          ok: outcome.ok && pointFindings.every((item) => item.severity !== 'blocking'),
          ran: true,
          schematic,
          evidence: outcome.evidence,
          verification,
          findings: [...findings, ...pointFindings],
          saved: entry ? { path: entry.path, digest: entry.digest, savedAt: entry.savedAt } : null,
          netlist: { bytes: Buffer.byteLength(netlistText, 'utf8'), exportMeta },
        };
      } else if (method === 'GET' && url.pathname === '/api/eda/schematic/simulation/latest') {
        result = { ok: true, evidence: evidenceStore.latest('spice-simulation') };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/acceptance') {
        // 原理图验收：导出网表 → 结构/计划比对 → ERC → 仿真（缺求解器就如实报"没有仿真"）
        const body = await readBody(request);
        // 自己把原理图切成活动文档：否则只会拿到"当前活动文档不是原理图"的阻断结论。
        await ensureEdaSession();
        // 网络连通性核对需要 PCB 文档 UUID。**必须在切到原理图之前解析**：
        // 解析 PCB 会把活动文档切到 PCB，若放在 ensureSchematicDocument 之后，
        // 验收一开始就会读到"当前文档不是原理图"（2026-10-22 真机踩到）。
        const pcbUuidForAcceptance = typeof body.pcbUuid === 'string' && body.pcbUuid.trim()
          ? body.pcbUuid.trim()
          : ((await readPcbPlacement(null).catch(() => null))?.pcbUuid ?? null);
        const schematic = await ensureSchematicDocument(body?.schematicUuid || null);
        const acceptance = await runSchematicAcceptance({
          execute: (commandId, args) => bridge.execute(commandId, args),
          plan: body.plan || null,
          skipSimulation: body.skipSimulation === true,
          expectations: body.expectations || null,
          timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined,
          solverPath: typeof body.solverPath === 'string' && body.solverPath ? body.solverPath : undefined,
          pcbUuid: pcbUuidForAcceptance,
          ...acceptanceExtraOptions,
        });
        // A14：验收里的仿真结论（真实求解器或设计检查点）必须落盘，否则"跑过"只是一次性响应。
        // 只在真的 simulated 时落盘；没有仿真就如实返回 simulation:null，不落一份"看起来像证据"的空壳。
        let savedSimulation = null;
        if (acceptance.simulation || acceptance.designChecks?.summary?.simulated) {
          const target = await currentEdaFingerprint();
          const entry = body.persistSimulation === false ? null : evidenceStore.save({
            kind: 'spice-simulation',
            payload: {
              source: 'schematic-acceptance',
              netlist: acceptance.netlist,
              simulation: acceptance.simulation,
              designChecks: acceptance.designChecks,
              scopeNote: acceptance.simulation ? 'EDA 导出的 SPICE 网表 + 真实求解器' : 'EDA 导不出 SPICE 网表时的设计检查点仿真（覆盖范围有限，不等于全电路仿真）',
            },
            fingerprint: { windowId: target.windowId, projectUuid: target.projectUuid, documentUuid: target.documentUuid },
            note: '原理图验收中的 SPICE 仿真证据',
          });
          if (entry) savedSimulation = { path: entry.path, digest: entry.digest, savedAt: entry.savedAt };
        }
        result = { ok: true, schematic, acceptance, savedSimulation };
      } else if (method === 'POST' && url.pathname === '/api/eda/footprint/integrity') {
        /**
         * 封装完整性预检（只读）。
         *
         * 真机教训（2026-10-22）：MK1 的 MEMS 麦克风封装在本地库里不存在，放置/连线都成功，
         * 只有 ERC 冒一句"引脚没有对应焊盘"，人只能从聚合错误里反推根因。
         * 这里提前把"原理图引脚集合 ↔ PCB 焊盘集合"逐位号比对，输出可定位的结论
         * （哪个位号、缺哪几个焊盘），供 PM/自动化在出制造文件前拦截。
         *
         * 只读：仅切换文档（schematic.open / pcb.open）读回，不 save、不写任何图元。
         */
        const body = await readBody(request);
        const pageUuid = typeof body.schematicPageUuid === 'string' && body.schematicPageUuid
          ? body.schematicPageUuid
          : (typeof body.pageUuid === 'string' && body.pageUuid ? body.pageUuid : null);
        const pcbUuid = typeof body.pcbUuid === 'string' && body.pcbUuid ? body.pcbUuid : null;
        if (!pageUuid || !pcbUuid) throw Object.assign(new Error('封装预检需要 schematicPageUuid 与 pcbUuid（只读检查，不做任何猜测）'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        await ensureEdaSession();
        const steps = [];
        // bridge.execute 返回的是 { success, result, windowId } 包装体（与 bridge 的 wire 协议一致），
        // 这里统一拆一次 result；否则所有"看起来读到了"的判断都会变成 undefined（真机本轮踩到）。
        const call = async (commandId, args) => {
          const raw = await bridge.execute(commandId, args);
          return raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
        };
        const schematicDoc = await ensureSchematicDocument(pageUuid);
        steps.push({ step: 'schematic.open', ok: Boolean(schematicDoc) });
        const readback = await call('schematic.components', {});
        const components = Array.isArray(readback?.components) ? readback.components : [];
        const pinsByPrimitive = readback?.pins && typeof readback.pins === 'object' ? readback.pins : {};
        const parts = components
          .filter((item) => String(item?.componentType) === 'part')
          .map((item) => ({
            designator: String(item?.designator || ''),
            primitiveId: item?.primitiveId ?? null,
            footprint: item?.footprint ? { uuid: item.footprint.uuid ?? null, name: item.footprint.name ?? null } : null,
            pinNumbers: (pinsByPrimitive[item?.primitiveId] || []).map((pin) => pin?.pinNumber ?? ''),
          }));
        steps.push({ step: 'schematic.read', ok: parts.length > 0, components: components.length, parts: parts.length });
        const pcbOpened = await call('pcb.open', { documentUuid: pcbUuid });
        steps.push({ step: 'pcb.open', ok: Boolean(pcbOpened?.opened) });
        if (!pcbOpened?.opened) throw Object.assign(new Error(`PCB 打开失败：${pcbUuid}（无法读焊盘，不能把"没读到"当成没问题）`), { code: 'EDA_PCB_OPEN_FAILED', status: 409 });
        // 打开 PCB 后立刻读会读到"0 个器件"——不是"PCB 空"，而是文档还在加载（真机本轮踩到）。
        // 读回必须等到有内容或明确超时；把重试次数如实写进 steps，避免"一次读不到就当空板"。
        let placement = null;
        let placementAttempts = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          placementAttempts = attempt + 1;
          placement = await call('pcb.placement.read', {}).catch((error) => ({ error: String(error?.message || error).slice(0, 160) }));
          const count = Array.isArray(placement?.components) ? placement.components.length : 0;
          if (count > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        const pcbItems = Array.isArray(placement?.components) ? placement.components : [];
        const wanted = new Map(parts.map((part) => [part.designator, part]));
        const padsByDesignator = {};
        const padReadErrors = [];
        for (const item of pcbItems) {
          const designator = String(item?.designator || '');
          if (!designator) continue;
          if (!wanted.has(designator)) { padsByDesignator[designator] = []; continue; }
          try {
            const pads = await call('pcb.pins.read', { primitiveId: item.primitiveId });
            padsByDesignator[designator] = (Array.isArray(pads) ? pads : []).map((pad) => pad?.padNumber ?? '');
          } catch (error) {
            padReadErrors.push({ designator, error: String(error?.message || error).slice(0, 160) });
          }
        }
        steps.push({ step: 'pcb.read', ok: pcbItems.length > 0, components: pcbItems.length, placementAttempts, padReadErrors: padReadErrors.length ? padReadErrors : null });
        // 恢复活动文档到原理图页：预检不能把用户/后续步骤留在 PCB 上。
        await call('schematic.open', { pageUuid }).catch(() => null);
        steps.push({ step: 'schematic.restore', ok: true });
        const evaluated = evaluateFootprintIntegrity({
          schematicParts: parts,
          pcbComponents: pcbItems.map((item) => ({ designator: item?.designator ?? '' })),
          padsByDesignator,
        });
        result = {
          ok: true,
          readOnly: true,
          targets: { schematicPageUuid: pageUuid, pcbUuid },
          ready: evaluated.ready,
          summary: evaluated.summary,
          findings: evaluated.findings,
          steps,
          assumptions: [
            '只判断引脚号/焊盘号集合一致性，不判断焊盘几何是否符合 datasheet（几何需人工 DFM）',
            '任一侧读不到时 fail-closed：padReadErrors 非空表示部分焊盘未读到，结论不可当成"通过"',
          ],
        };
      } else if (method === 'POST' && url.pathname === '/api/eda/library/search/fallback') {
        // A2：只读回退检索诊断。给"某型号 0 命中"排查用：逐级变形重试并保留每次尝试，
        // 命中来源如实标注；不写工程、不改身份、不缓存。
        const body = await readBody(request);
        if (!bridge.port) await bridge.discover();
        const queries = Array.isArray(body.queries) ? body.queries : (body.query ? [body.query] : []);
        if (!queries.length) throw Object.assign(new Error('至少提供一个 query（或 queries 数组）'), { code: 'SELECTION_QUERY_REQUIRED', status: 400 });
        result = await probeSelectionFallback({ bridge, queries });
      } else if (method === 'POST' && url.pathname === '/api/eda/library/devices/search') {
        const body = await readBody(request);
        if (!bridge.port) await bridge.discover();
        const mode = /^C\d+$/i.test(String(body.query || '').trim()) ? 'lcsc' : body.mode || 'keyword';
        const raw = await bridge.execute('library.device.search', { query: String(body.query || '').trim(), mode, limit: 20, page: Number(body.page || 1) });
        result = { ok: true, search: { query: String(body.query || '').trim(), mode, beta: true, readOnly: true, candidates: normalizeDeviceCandidates(raw) } };
        logger.info('EasyEDA', 'Device library search completed', { mode, resultCount: result.search.candidates.length });
      } else if (method === 'GET' && url.pathname === '/api/design/context') {
        result = { ok: true, context: await designManager.context() };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/open-current') {
        const body = await readBody(request);
        const raw = await bridge.execute('schematic.catalog');
        const catalog = raw?.result ?? raw?.data ?? raw;
        const pages = Array.isArray(catalog?.pages) ? catalog.pages : Array.isArray(catalog) ? catalog : [];
        const requestedUuid = String(body.documentUuid || '');
        const page = requestedUuid ? pages.find((item) => String(item?.uuid || item?.documentUuid || '') === requestedUuid) : pages.find((item) => /^[a-f0-9]{16,64}$/i.test(String(item?.uuid || item?.documentUuid || '')));
        const documentUuid = String(page?.uuid || page?.documentUuid || '');
        if (!documentUuid) throw Object.assign(new Error('当前嘉立创EDA工程中没有可打开的原理图页面'), { code: 'SCHEMATIC_PAGE_NOT_FOUND', status: 404 });
        result = { ok: true, schematic: { documentUuid, page, navigation: await bridge.execute('schematic.open', { documentUuid }) } };
      } else if (method === 'POST' && url.pathname === '/api/design/plan') {
        const body = await readBody(request);
        result = { ok: true, planning: normalizePlan(body.plan || {}) };
        logger.info('Design', 'Normalized simple-board plan', { ready: result.planning.ready, planHash: result.planning.planHash, missingCount: result.planning.missing.length });
      } else if (method === 'POST' && url.pathname === '/api/design/plan/ai') {
        const body = await readBody(request);
        const candidate = await chatManager.plan(body);
        result = { ok: true, candidate, planning: normalizePlan(candidate) };
        logger.info('Design', 'Codex generated structured simple-board plan candidate', { ready: result.planning.ready, planHash: result.planning.planHash, missingCount: result.planning.missing.length });
      } else if (method === 'POST' && url.pathname === '/api/design/netlist/ai') {
        const body = await readBody(request);
        // A4：网表生成的前置引脚证据门禁。
        // - 调用方显式传 pinEvidence ⇒ 证据审计必须通过（未知网络无 assumption 直接 409）；
        // - 显式 requirePinEvidence:true 但没传证据 ⇒ 409（不能凭"没证据"生成可执行网表）；
        // - 不传也不要求（旧调用/从零设计）⇒ 保持原行为，但结果里明确 pinEvidence:null，不假装有证据。
        let pinEvidenceAudit = null;
        if (body.pinEvidence) pinEvidenceAudit = assertPinEvidenceForNetlist(body.pinEvidence);
        if (body.requirePinEvidence === true && !pinEvidenceAudit) {
          throw Object.assign(new Error('这次网表生成要求引脚证据，但请求里没有 pinEvidence：先采集证据（含每个未知网络的 assumption）再生成。'), { code: 'PIN_EVIDENCE_REQUIRED', status: 409 });
        }
        const netlistResult = await chatManager.netlist(body);
        // A4：assumption 结构标注（方向+来源）随网表一起返回；strict 模式下未标注方向直接 409。
        const assumptionAudit = auditNetlistAssumptions(netlistResult?.netlist?.assumptions, { defaultSource: 'inferred' });
        netlistResult.assumptionAudit = assumptionAudit;
        if (body.strictAssumptions === true && !assumptionAudit.strictOk) {
          throw Object.assign(new Error(`网表 assumption 未全部标注方向：${assumptionAudit.warnings.slice(0, 4).map((item) => item.message).join('；') || assumptionAudit.blockers.map((item) => item.message).join('；')}`), {
            code: 'NETLIST_ASSUMPTION_UNMARKED', status: 409, details: { assumptionAudit },
          });
        }
        if (pinEvidenceAudit) {
          netlistResult.pinEvidence = {
            digest: crypto.createHash('sha256').update(JSON.stringify(body.pinEvidence)).digest('hex'),
            counts: pinEvidenceAudit.counts,
          };
        }
        result = { ok: true, netlist: netlistResult };
      } else if (method === 'POST' && url.pathname === '/api/automation/flows/pin-first-netlist') {
        // A4：两阶段"先落器件→读引脚→再生成网表"的计划层（只出计划，不执行、不代批准）。
        const body = await readBody(request);
        const pinEvidence = body.pinEvidence && typeof body.pinEvidence === 'object' ? body.pinEvidence : null;
        const pinAudit = pinEvidence ? (body.pinAudit && typeof body.pinAudit === 'object' ? body.pinAudit : auditPinEvidence(pinEvidence)) : (body.pinAudit && typeof body.pinAudit === 'object' ? body.pinAudit : null);
        const assumptionAudit = body.assumptionAudit && typeof body.assumptionAudit === 'object' ? body.assumptionAudit : auditNetlistAssumptions(body.assumptions, { defaultSource: 'inferred' });
        result = { ok: true, plan: planPinFirstNetlistFlow({ pcbExecutionId: body.pcbExecutionId, pinEvidence, pinAudit, assumptionAudit, notes: body.notes }) };
      } else if (method === 'POST' && url.pathname === '/api/design/approve') {
        const body = await readBody(request);
        result = { ok: true, approval: designManager.approve(body) };
        logger.info('Design', 'Issued bound design approval', { planHash: result.approval.planHash, windowId: body.windowId, expiresAt: result.approval.expiresAt });
      } else if (method === 'POST' && url.pathname === '/api/design/cancel') {
        const body = await readBody(request);
        result = { ok: true, cancellation: designManager.cancel(body) };
      } else if (method === 'POST' && url.pathname === '/api/design/capabilities/probe') {
        result = { ok: true, capabilities: await designManager.probe() };
      } else if (method === 'POST' && url.pathname === '/api/design/execute') {
        const body = await readBody(request);
        result = { ok: true, execution: await designManager.execute(body) };
        logger.info('Design', 'Controlled schematic execution finished', { executionId: result.execution.id, state: result.execution.state, planHash: result.execution.planHash });
      } else if (method === 'GET' && url.pathname === '/api/design/executions') {
        result = { ok: true, executions: designManager.list(), persistenceError: designManager.persistenceError || null };
      } else if (method === 'GET' && url.pathname === '/api/pcb/executions') {
        result = { ok: true, executions: pcbManager.list(), persistenceError: pcbManager.persistenceError || null };
      } else if (method === 'GET' && /^\/api\/pcb\/executions\/[^/]+$/.test(url.pathname)) {
        const executionId = decodeURIComponent(url.pathname.split('/')[4]);
        const execution = pcbManager.get(executionId);
        if (!execution) throw Object.assign(new Error('PCB执行记录不存在'), { code: 'EXECUTION_NOT_FOUND', status: 404 });
        result = { ok: true, execution };
      } else if (method === 'GET' && /^\/api\/design\/executions\/[^/]+\/evidence$/.test(url.pathname)) {
        const executionId = decodeURIComponent(url.pathname.split('/')[4]);
        const evidence = designManager.evidence(executionId);
        if (!evidence) throw Object.assign(new Error('执行恢复证据不存在'), { code: 'EXECUTION_NOT_FOUND', status: 404 });
        result = { ok: true, evidence };
      } else if (method === 'GET' && /^\/api\/design\/executions\/[^/]+$/.test(url.pathname)) {
        const executionId = decodeURIComponent(url.pathname.split('/')[4]);
        const execution = designManager.get(executionId);
        if (!execution) throw Object.assign(new Error('执行记录不存在'), { code: 'EXECUTION_NOT_FOUND', status: 404 });
        result = { ok: true, execution };
      } else if (method === 'GET' && url.pathname === '/api/eda/version/adaptation') {
        // G5：版本适配诊断。版本来源如实标注：查询参数（实测/人工提供）> 能力矩阵声明基线 > unknown；
        // 桥在线时顺带跑 eda.api.describe 核对关键图元 API，探针失败也如实报告（不当作通过）。
        const capabilities = pcbManager.capabilities();
        const queriedVersion = typeof url.searchParams.get('version') === 'string' ? url.searchParams.get('version').trim() : '';
        let probe = null;
        let probeError = null;
        if (bridge && bridge.port) {
          try {
            const described = await bridge.execute('eda.api.describe', {});
            probe = described?.result ?? described ?? null;
          } catch (error) {
            probeError = error?.message || String(error);
          }
        }
        const version = queriedVersion || capabilities.edaVersion || null;
        const versionSource = queriedVersion ? 'user' : capabilities.edaVersion ? 'capability-matrix' : 'unknown';
        result = { ok: true, adaptation: assessEdaAdaptation({ version, versionSource, probe, probeError, capabilityItems: capabilities.items }) };
      } else if (method === 'GET' && url.pathname === '/api/pcb/capabilities') {
        result = { ok: true, capabilities: pcbManager.capabilities() };
      } else if (method === 'GET' && url.pathname === '/api/pcb/context') {
        // 真机教训（第 16 轮）：PCB 管理器的路由**没有**先 discover 就调桥，
        // 于是"运行时刚起来、谁都还没发现桥"时，第一条 /api/pcb/context 直接 400 BRIDGE_NOT_FOUND。
        // 桥就在那里，是运行时自己没去找。所有要读实机的 PCB 路由都必须先建立会话。
        await ensureEdaSession();
        result = { ok: true, context: await pcbManager.context() };
      } else if (method === 'GET' && url.pathname === '/api/pcb/sync/verify') {
        // 真机边界（第 20–23 轮，9 次实验）：嘉立创EDA 3.2.186 的公开 API **无法新增 PCB 器件**
        // （importChanges 空转、图元 create 内部依赖不可达、源码通道只能改写不能新增）。
        // 所以这条路由只做两件事：**如实判定差异** + **给出可照做的指引**，绝不假装写成功。
        await ensureEdaSession();
        const schematic = await readSchematicParts();
        const placement = await readPcbPlacement(url.searchParams.get('pcbUuid'));
        const verification = diffPcbAgainstNetlist({
          schematicParts: schematic.designators,
          pcbDesignators: (placement.readback?.components || []).map((item) => item.designator),
        });
        result = { ok: true, pcbUuid: placement.pcbUuid, schematicPageUuid: schematic.pageUuid, schematic, verification };
      } else if (method === 'POST' && url.pathname === '/api/eda/project/open') {
        /**
         * 让运行时自己把工程打开（真机：EDA 重启后停在首页，project.current 为 null，
         * 所有 PCB 路由都会被护栏挡成 409，而这一步本来是可以自动化的）。
         */
        await ensureEdaSession();
        const body = await readBody(request).catch(() => ({}));
        const wanted = (typeof body?.projectUuid === 'string' && body.projectUuid) ? body.projectUuid : lastProjectUuid();
        if (!wanted) throw Object.assign(new Error('没有可打开的工程：请在请求里填 projectUuid（或先成功用过一次工程）'), { code: 'EDA_COMMAND_ARGS_INVALID', status: 400 });
        const project = await openProjectAndWait(wanted);
        let pcbUuid = null;
        let activated = false;
        try {
          pcbUuid = await resolveProjectPcbUuid();
          if (pcbUuid && body?.activatePcb !== false) { await activatePcbDocument(pcbUuid); activated = true; }
        } catch { /* 工程打开了但里面没有 PCB：如实返回 pcbUuid 为 null，不假装成功 */ }
        result = { ok: true, project: { projectUuid: wanted, title: project?.friendlyName ?? project?.name ?? null, boards: Array.isArray(project?.data) ? project.data.length : 0 }, pcbUuid, activated };
      } else if (method === 'POST' && url.pathname === '/api/pcb/3d/export') {
        // 真机实测（第 32 轮）：pcb.3d.export 20.8s 产出 10.9MB STEP，分片取回自洽。
        // 这条路由只做"取回 → 落盘 → 自证"：字节数与 size 不符、STEP 头不合法、落盘字节不符都判失败，
        // 绝不返回"成功"让上游以为拿到产物。
        await ensureEdaSession();
        const body = await readBody(request).catch(() => ({}));
        const pcbUuid = (typeof body?.pcbUuid === 'string' && body.pcbUuid) ? body.pcbUuid : await resolveProjectPcbUuid();
        if (!pcbUuid) throw Object.assign(new Error('读不到 PCB 文档，无法导出 3D'), { code: 'EDA_DOCUMENT_REQUIRED', status: 409 });
        await activatePcbDocument(pcbUuid);
        // 格式必须由调用方选择并一路传到底：桥早就支持 glb，但这条路由以前**没把 format 传下去**，
        // 于是 GLB 永远只能拿到 STEP（产品缺口，不是 EDA 能力缺口）。
        const format = body?.format === 'glb' ? 'glb' : 'step';
        // 真机踩过的坑：EDA 侧 3D 导出 RPC 一旦卡住，桥会把后续调用排在同一队列里，
        // 结果是**这条 HTTP 请求被无限挂住**（实测 >600s 都没返回，调用方根本等不到错误）。
        // 所以整条导出链必须有**总时限**：宁可明确报"超时"，也不能让请求悬着。
        const deadlineMs = Number(process.env.CIRCUITPILOT_3D_EXPORT_DEADLINE_MS) > 0 ? Number(process.env.CIRCUITPILOT_3D_EXPORT_DEADLINE_MS) : 300_000;
        const deadlineAt = Date.now() + deadlineMs;
        const withDeadline = (factory, label) => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) return Promise.reject(Object.assign(new Error(`3D 导出超过总时限 ${deadlineMs}ms（卡在：${label}）`), { code: 'PCB_3D_EXPORT_DEADLINE', status: 504 }));
          let timer = null;
          return Promise.race([
            factory(),
            new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`3D 导出超过总时限 ${deadlineMs}ms（卡在：${label}）`), { code: 'PCB_3D_EXPORT_DEADLINE', status: 504 })), remaining); }),
          ]).finally(() => { if (timer) clearTimeout(timer); });
        };
        const meta = (await withDeadline(() => bridge.execute('pcb.3d.export', { fileName: body?.fileName || 'CircuitPilot-Assembled-3D', format }), '导出命令')).result;
        if (!meta?.exportId || !Number.isFinite(Number(meta.size)) || Number(meta.size) <= 0) throw Object.assign(new Error('3D 导出没有返回有效文件'), { code: 'PCB_3D_EXPORT_EMPTY', status: 502 });
        const parts = [];
        for (let index = 0; index < Number(meta.chunks); index += 1) {
          const chunk = (await withDeadline(() => bridge.execute('pcb.3d.chunk', { exportId: meta.exportId, index }), `分片 ${index}`)).result;
          // 真机教训（第 33 轮）：分片字段叫 `base64`，不是 `data`；而且"取到对象"不等于"取到字节"——
          // 上一轮把包装对象的 JSON 长度误当成了解码字节数。这里逐片核对解码长度。
          if (chunk?.error) throw Object.assign(new Error(`3D 分片 ${index} 取回失败：${chunk.error}`), { code: chunk.error === 'EDA_EXPORT_BUFFER_LOST' ? 'PCB_3D_BUFFER_LOST' : 'PCB_3D_CHUNK_INVALID', status: 502 });
          if (typeof chunk?.base64 !== 'string' || !chunk.base64.length) throw Object.assign(new Error(`3D 分片 ${index} 为空`), { code: 'PCB_3D_CHUNK_EMPTY', status: 502 });
          const decoded = Buffer.from(chunk.base64, 'base64');
          if (Number.isFinite(Number(chunk.bytes)) && decoded.length !== Number(chunk.bytes)) throw Object.assign(new Error(`3D 分片 ${index} 长度不符：解出 ${decoded.length}，应为 ${chunk.bytes}`), { code: 'PCB_3D_CHUNK_MISMATCH', status: 502 });
          parts.push(decoded);
        }
        const bytes = Buffer.concat(parts);
        if (bytes.length !== Number(meta.size)) throw Object.assign(new Error(`3D 文件不完整：收到 ${bytes.length} 字节，应为 ${meta.size}`), { code: 'PCB_3D_INCOMPLETE', status: 502 });
        // 按声明的格式做**结构性**校验，而不是只看开头有没有某个字符串：
        // STEP 看 ISO-10303-21 头；GLB 看二进制头（magic 'glTF' + version=2 + 文件总长度必须自洽）。
        if (format === 'step') {
          if (!bytes.subarray(0, 64).toString('latin1').includes('ISO-10303-21')) throw Object.assign(new Error('3D 产物不是合法 STEP（缺少 ISO-10303-21 头）'), { code: 'PCB_3D_NOT_STEP', status: 502 });
        } else {
          const magic = bytes.subarray(0, 4).toString('latin1');
          const version = bytes.length >= 12 ? bytes.readUInt32LE(4) : -1;
          const declared = bytes.length >= 12 ? bytes.readUInt32LE(8) : -1;
          if (magic !== 'glTF') throw Object.assign(new Error(`3D 产物不是合法 GLB（magic=${JSON.stringify(magic)}）`), { code: 'PCB_3D_NOT_GLB', status: 502 });
          if (version !== 2) throw Object.assign(new Error(`GLB 版本应为 2，实际 ${version}`), { code: 'PCB_3D_NOT_GLB', status: 502 });
          if (declared !== bytes.length) throw Object.assign(new Error(`GLB 头部声明长度 ${declared} 与实际字节 ${bytes.length} 不符`), { code: 'PCB_3D_NOT_GLB', status: 502 });
        }
        const outDir = (typeof body?.outDir === 'string' && body.outDir) ? body.outDir : join(process.cwd(), 'deliverables', 'pcb-3d');
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `${String(meta.name || 'pcb-3d').replace(/[^\w.-]+/g, '_')}.${format}`);
        writeFileSync(outPath, bytes);
        const onDisk = statSync(outPath).size;
        if (onDisk !== bytes.length) throw Object.assign(new Error(`3D 落盘字节数不符：磁盘 ${onDisk}，内存 ${bytes.length}`), { code: 'PCB_3D_WRITE_MISMATCH', status: 500 });
        result = { ok: true, pcbUuid, model: { path: outPath, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), format, chunks: Number(meta.chunks), elements: meta.elements ?? null } };
      } else if (method === 'POST' && url.pathname === '/api/eda/app/focus') {
        const appPath = EDA_APP_CANDIDATES.find((candidate) => existsSync(candidate));
        if (!appPath) throw Object.assign(new Error('未在受支持路径发现嘉立创EDA专业版'), { code: 'EASYEDA_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        result = { ok: true, application: { path: appPath, focused: true } };
        logger.info('EDA', 'EasyEDA application focused', { path: appPath });
      } else if (method === 'POST' && url.pathname === '/api/app/focus') {
        const appPath = '/Applications/CircuitPilot.app';
        if (!existsSync(appPath)) throw Object.assign(new Error('未发现已安装的CircuitPilot应用'), { code: 'CIRCUITPILOT_APP_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        result = { ok: true, application: { path: appPath, focused: true } };
      } else if (method === 'POST' && url.pathname === '/api/eda/workspaces') {
        const body = await readBody(request);
        const friendlyName = String(body.friendlyName || '').trim();
        const projectName = String(body.projectName || friendlyName).trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `CircuitPilot-${Date.now()}`;
        const appPath = EDA_APP_CANDIDATES.find((candidate) => existsSync(candidate));
        if (!appPath) throw Object.assign(new Error('未在受支持路径发现嘉立创EDA专业版'), { code: 'EASYEDA_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        let discovered = await bridge.discover();
        for (let attempt = 0; !discovered && attempt < 30; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 500)); discovered = await bridge.discover(); }
        if (!discovered) throw Object.assign(new Error('已打开嘉立创EDA，但Bridge未在15秒内就绪；请确认Run API Gateway扩展已启用'), { code: 'BRIDGE_START_TIMEOUT', status: 504 });
        const windows = await bridge.windows();
        if (windows.selectionRequired) throw Object.assign(new Error('检测到多个嘉立创EDA窗口，请先在高级控制中选择创建目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED', status: 409 });
        const created = await bridge.execute('workspace.create', { friendlyName, projectName, description: String(body.description || '').slice(0, 500) }, { allowWrite: true });
        result = { ok: true, workspace: created?.result || created?.data || created };
        logger.info('EDA', 'Created EasyEDA project workspace', { friendlyName, projectName, windowId: bridge.selectedWindowId });
      } else if (method === 'GET' && url.pathname === '/api/eda/workspaces/current') {
        const unwrapValue = (value) => value?.result ?? value?.data ?? value;
        if (!bridge.port) await bridge.discover();
        if (!bridge.port) throw Object.assign(new Error('未发现EasyEDA Bridge'), { code: 'BRIDGE_NOT_FOUND', status: 503 });
        const windowState = await bridge.windows();
        if (!windowState.windows.length) throw Object.assign(new Error('Bridge在线，但没有嘉立创EDA窗口连接'), { code: 'EDA_WINDOW_NOT_FOUND', status: 409 });
        if (windowState.selectionRequired) throw Object.assign(new Error('检测到多个嘉立创EDA窗口，请先在高级控制中选择目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED', status: 409 });
        const [projectRaw, documentRaw, catalogRaw] = await Promise.all([bridge.execute('project.current'), bridge.execute('document.current'), bridge.execute('schematic.catalog')]);
        const project = unwrapValue(projectRaw); const document = unwrapValue(documentRaw); const catalog = unwrapValue(catalogRaw);
        if (Number(document?.documentType) !== 3) throw Object.assign(new Error('请先在嘉立创EDA中选中要绑定的PCB文档'), { code: 'PCB_DOCUMENT_REQUIRED', status: 409 });
        const boards = Array.isArray(project?.data) ? project.data.filter((item) => item?.itemType === 'Board') : [];
        const board = boards.find((item) => String(item?.pcb?.uuid || '') === String(document?.uuid || ''));
        if (!board?.schematic?.uuid || !board?.pcb?.uuid) throw Object.assign(new Error('当前PCB没有找到同Board关联的原理图'), { code: 'EDA_BOARD_BINDING_NOT_FOUND', status: 404 });
        const page = (Array.isArray(catalog?.pages) ? catalog.pages : []).find((item) => String(item?.parentSchematicUuid || '') === String(board.schematic.uuid));
        if (!page?.uuid) throw Object.assign(new Error('当前Board没有可写入的原理图页面'), { code: 'SCHEMATIC_PAGE_NOT_FOUND', status: 404 });
        result = { ok: true, workspace: { projectUuid: String(project.uuid), boardName: String(board.name || board.parentBoardName || ''), schematicUuid: String(board.schematic.uuid), schematicPageUuid: String(page.uuid), pcbUuid: String(board.pcb.uuid) } };
      } else if (method === 'POST' && url.pathname === '/api/pcb/plan') {
        const body = await readBody(request);
        result = { ok: true, planning: normalizePcbPlan(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/fixtures/ch32v003/compile') {
        const body = await readBody(request);
        result = { ok: true, planning: compileCh32v003Fixture(body || {}) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/approve') {
        const body = await readBody(request);
        result = { ok: true, approval: pcbManager.approve(body) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/execute') {
        const body = await readBody(request);
        await ensureEdaSession();
        result = { ok: true, execution: await pcbManager.execute(body) };
      } else if (method === 'POST' && url.pathname === '/api/eda/gui/execute') {
        // 通道 B：GUI 动作（受信任输入）。不依赖桥接会话，但动作必须在白名单内。
        // G3：`eval`（任意 JS 注入）默认**禁用**，只有显式设置 CIRCUITPILOT_ALLOW_GUI_EVAL=1 的
        // 本地诊断场景才允许；产品路径不能通过 HTTP 直接执行任意脚本。
        const body = await readBody(request);
        if (body?.action === 'eval' && process.env.CIRCUITPILOT_ALLOW_GUI_EVAL !== '1') {
          throw Object.assign(new Error('GUI eval 默认禁用：任意 JS 注入不是产品能力；需要本地诊断时显式设置 CIRCUITPILOT_ALLOW_GUI_EVAL=1'), { code: 'GUI_EVAL_DISABLED', status: 403 });
        }
        const execution = await guiClient.execute(body.action, body.params || {});
        // 截图是唯一会返回 MB 级 base64 的 GUI 动作：小图内联、大图落盘 + sha256，
        // 否则响应体过大在传输层被截断，调用方只会拿到半截 base64（真机第 59 轮踩过）。
        if (body.action === 'screenshot' && typeof execution?.base64 === 'string') {
          const materialized = materializeGuiScreenshot({
            base64: execution.base64,
            bytes: execution.bytes ?? null,
            outDir: process.env.CIRCUITPILOT_GUI_EVIDENCE_DIR || join(process.cwd(), 'artifacts/gui-capabilities'),
            namePrefix: 'gui-execute-screenshot',
          });
          if (materialized.ok) {
            result = { ok: true, execution: { ...execution, ...materialized } };
          } else {
            result = { ok: false, execution: { error: materialized.reason ?? 'SCREENSHOT_MATERIALIZE_FAILED', bytes: execution?.bytes ?? null } };
          }
        } else {
          result = { ok: true, execution };
        }
      } else if (method === 'POST' && url.pathname === '/api/eda/gui/capabilities/probe') {
        /**
         * E9：GUI 兜底能力只读探测。findTexts 不点击/不输入；可选 viewport 用 CDP Emulation
         * 验证两种布局尺寸下文案仍可定位；可选 captureScreenshot 落一张 PNG 证据。
         */
        const body = await readBody(request);
        const requestedTexts = Array.isArray(body.texts) && body.texts.length ? body.texts.map((item) => String(item)).slice(0, 80) : catalogTexts();
        const viewport = body.viewport && Number.isFinite(Number(body.viewport.width)) && Number.isFinite(Number(body.viewport.height))
          ? { width: Number(body.viewport.width), height: Number(body.viewport.height) } : null;
        let probe;
        try {
          probe = await guiClient.execute('findTexts', { texts: requestedTexts, viewport });
        } catch (error) {
          throw Object.assign(new Error(`GUI 能力探测失败（CDP 未连接/EDA 未启动？）：${String(error?.message || error).slice(0, 200)}`), { code: 'GUI_CAPABILITY_PROBE_FAILED', status: 503, details: { cause: error?.code || null } });
        }
        const evaluated = evaluateGuiCapabilities({ probe });
        let screenshot = null;
        if (body.captureScreenshot === true) {
          try {
            const shot = await guiClient.execute('screenshot', {});
            const sha256 = crypto.createHash('sha256').update(Buffer.from(String(shot?.base64 || ''), 'base64')).digest('hex');
            const dir = process.env.CIRCUITPILOT_GUI_EVIDENCE_DIR || join(process.cwd(), 'artifacts/gui-capabilities');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `gui-capabilities-${new Date().toISOString().replace(/[:.]/g, '-')}-${sha256.slice(0, 8)}.png`);
            writeFileSync(file, Buffer.from(String(shot?.base64 || ''), 'base64'));
            screenshot = { path: file, sha256, bytes: shot?.bytes ?? null };
          } catch (error) {
            // CDP 截图在本机 EDA 3.2.186 会超时：降级为 macOS 窗口区域截图（仅 EDA 窗口），
            // 仍然给出 sha256/路径；两条路都不行才报失败，不伪造截图。
            try {
              screenshot = captureEdaWindow({ outDir: process.env.CIRCUITPILOT_GUI_EVIDENCE_DIR || join(process.cwd(), 'artifacts/gui-capabilities') });
              screenshot.cdpError = String(error?.message || error).slice(0, 200);
            } catch (fallbackError) {
              screenshot = { ok: false, error: String(error?.message || error).slice(0, 200), fallbackError: String(fallbackError?.message || fallbackError).slice(0, 200) };
            }
          }
        }
        result = {
          ok: true,
          viewport: probe?.viewport ?? null,
          requestedViewport: viewport,
          catalogVersion: 1,
          availableCount: evaluated.availableCount,
          blockedCount: evaluated.blockedCount,
          missingTexts: evaluated.missingTexts,
          capabilities: evaluated.entries,
          screenshot,
        };
      } else if (method === 'GET' && url.pathname === '/api/eda/gui/state') {
        result = { ok: true, state: await guiClient.execute('state') };
      } else if (method === 'GET' && url.pathname === '/api/automation/recipes') {
        // Phase 0/1：4 条只读 + R1/R2/R6 三条写入配方（写入配方要求服务端签发的 write 批准）。
        result = { ok: true, schemaVersion: 1, recipes: automationRegistry.summaries() };
      } else if (method === 'POST' && url.pathname === '/api/automation/approvals') {
        // 签发一次人工批准：必须由服务端在真实 EDA 会话上绑定当前目标，客户端不能自报允许。
        const body = await readBody(request);
        const target = await currentEdaFingerprint();
        const approval = automationApprovals.issue({
          scope: body.scope,
          recipeId: body.recipeId ?? null,
          fingerprint: target.fingerprint,
          planHash: body.planHash ?? null,
          note: body.note || '',
        });
        result = { ok: true, approval: { ...approval, target } };
      } else if (method === 'GET' && url.pathname === '/api/automation/orchestration/goals') {
        // E10：可编排目标 profile（确定性映射表；未覆盖目标必须人工编排）。
        result = { ok: true, goals: listGoalProfiles() };
      } else if (method === 'POST' && url.pathname === '/api/automation/orchestration/plan') {
        // E10：目标 → 配方序列（含 gate 节点/依赖/预算/决策日志）。只出计划，不执行、不代批准。
        const body = await readBody(request);
        try {
          result = { ok: true, plan: planOrchestration({ goal: body.goal, budget: body.budget, recipes: automationRegistry.list(), evidence: body.evidence ?? null }) };
        } catch (error) {
          throw Object.assign(new Error(error?.message || '编排计划生成失败'), { code: error?.code || 'E10_PLAN_FAILED', status: error?.code === 'E10_GOAL_UNSUPPORTED' ? 422 : 400, details: error?.details });
        }
      } else if (method === 'POST' && url.pathname === '/api/automation/orchestration/failure') {
        // E10：失败分类 → 恢复决策（人审）。写动作永不自动重放。
        const body = await readBody(request);
        try {
          result = { ok: true, recovery: decideFailureRecovery({ errorCode: body.errorCode, stage: body.stage, attempt: body.attempt, planId: body.planId, nodeId: body.nodeId }) };
        } catch (error) {
          throw Object.assign(new Error(error?.message || '失败恢复决策生成失败'), { code: error?.code || 'E10_DECISION_FAILED', status: 400 });
        }
      } else if (method === 'GET' && url.pathname === '/api/automation/recovery') {
        // E7：重启后未完成 run 的**只读**恢复分析（不自动重放写动作，写过的 run 一律 needs_human）。
        result = { ok: true, recovery: findInterruptedRuns({ dir: automationJournal.dir, registry: automationRegistry, limit: 20 }) };
      } else if (method === 'GET' && url.pathname === '/api/automation/approvals') {
        result = { ok: true, approvals: automationApprovals.list() };
      } else if (method === 'POST' && url.pathname === '/api/automation/run') {
        // 跑一个已登记配方：缺参数/缺批准 → 0 步执行；读回不符 → failed（绝不假通过）。
        const body = await readBody(request);
        const recipe = automationRegistry.get(body.recipeId);
        if (!recipe) throw Object.assign(new Error('自动化配方不存在'), { code: 'AUTOMATION_RECIPE_NOT_FOUND', status: 404 });
        // E7：单写锁 + runId 幂等。同一 runId 重复提交返回同一结果；不同 run 并发直接 409。
        const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const cachedRun = automationRunCache.get(runId);
        if (cachedRun && cachedRun.expiresAt > Date.now()) {
          result = { ok: true, runId, run: await cachedRun.promise, deduplicated: true };
        } else {
          const lock = automationRunLock.tryAcquire({ runId, recipeId: recipe.id });
          if (!lock.ok) {
            throw Object.assign(new Error(`已有自动化运行正在执行（${lock.status?.runId ?? 'unknown'} · ${lock.status?.recipeId ?? 'unknown'}），拒绝并发写同一 EDA 文档`), {
              code: lock.code, status: 409, details: { activeRun: lock.status },
            });
          }
          const abortController = new AbortController();
          activeRunControllers.set(runId, abortController);
          const executeRun = (async () => {
            const recipeReadbacks = recipe.steps.map((step) => step.expect?.readback).filter(Boolean);
            const readbackNeedsBridge = (readback) => readback && (readback.kind === 'api'
              || (readback.kind === 'compose' && Object.values(readback.reads).some((read) => read.kind === 'api')));
            const fallbackNeedsBridge = recipe.steps.some((step) => (step.fallback?.actions || []).some((action) => action.kind === 'api'));
            const needsBridge = recipe.steps.some((step) => step.action.kind === 'api') || fallbackNeedsBridge || recipeReadbacks.some(readbackNeedsBridge);
            if (needsBridge) await ensureEdaSession();
            const requiredScopes = [...new Set([...(recipe.requiredApprovals || []), ...recipe.steps.map((step) => step.approval).filter(Boolean)])];
            const approvalIds = Array.isArray(body.approvalIds) ? body.approvalIds : [];
            let approvals = {};
            let resolvedFingerprint = null;
            if (requiredScopes.length && approvalIds.length) {
              const target = await currentEdaFingerprint();
              resolvedFingerprint = target.fingerprint;
              const resolved = automationApprovals.resolve({ approvalIds, requiredScopes, recipeId: recipe.id, fingerprint: target.fingerprint });
              if (!resolved.ok) {
                throw Object.assign(new Error(`批准无效或与当前目标不匹配：${resolved.missing.map((item) => `${item.scope}（${item.reason}）`).join('；')}`), {
                  code: 'AUTOMATION_APPROVAL_INVALID', status: 409, details: { missing: resolved.missing, currentFingerprint: target.fingerprint },
                });
              }
              approvals = resolved.approvals;
            }
            // 响应里的 runId 必须与 journal/审计里的 runId 一致，否则 "用返回的 runId 去查审计" 会 404。
            return runRecipe({ recipe, executors: createRuntimeExecutors({ bridge, gui: guiClient }), params: body.params || {}, approvals, approvalIds, approvalFingerprint: resolvedFingerprint, journal: automationJournal, runId, signal: abortController.signal });
          })();
          automationRunCache.set(runId, { promise: executeRun, expiresAt: Infinity });
          try {
            const run = await executeRun;
            result = { ok: true, runId, run };
            // 完成后保留短期结果用于幂等重放（同一 runId 不再执行第二次）。
            automationRunCache.set(runId, { promise: Promise.resolve(run), expiresAt: Date.now() + automationRunCacheTtlMs });
          } catch (error) {
            automationRunCache.delete(runId);
            throw error;
          } finally {
            activeRunControllers.delete(runId);
            automationRunLock.release(lock.token);
          }
        }
      } else if (method === 'POST' && /^\/api\/automation\/runs\/[^/]+\/replay$/.test(url.pathname)) {
        // E7：显式安全重放——只允许“全程只读”的中断 run；写过的 run 必须人工确认过现场再处理。
        const replayFrom = decodeURIComponent(url.pathname.split('/')[4]);
        const entries = automationJournal.read(replayFrom);
        if (!entries.length || entries[0].phase !== 'run.start' || !entries[0].recipeId) {
          throw Object.assign(new Error(`审计记录不存在（不是 run 记录）：${replayFrom}`), { code: 'AUTOMATION_RUN_NOT_FOUND', status: 404, details: { runId: replayFrom } });
        }
        const analysis = analyzeRunEntries(entries, { registry: automationRegistry, runId: replayFrom });
        const gate = canReplay(analysis);
        if (!gate.ok) {
          throw Object.assign(new Error(`不允许自动重放：${gate.reason}`), {
            code: 'AUTOMATION_RECOVERY_NOT_SAFE', status: 409, details: { runId: replayFrom, verdict: gate.verdict, reason: gate.reason, analysis },
          });
        }
        const recipe = automationRegistry.get(analysis.recipeId);
        if (!recipe) throw Object.assign(new Error(`配方不在当前注册表：${analysis.recipeId}`), { code: 'AUTOMATION_RECIPE_NOT_FOUND', status: 404 });
        const replayRunId = `${replayFrom}-replay-${Date.now().toString(36)}`.slice(0, 80);
        const lock = automationRunLock.tryAcquire({ runId: replayRunId, recipeId: recipe.id });
        if (!lock.ok) throw Object.assign(new Error('已有自动化运行正在执行，拒绝并发执行恢复重放'), { code: lock.code, status: 409, details: { activeRun: lock.status } });
        const controller = new AbortController();
        activeRunControllers.set(replayRunId, controller);
        try {
          automationJournal.append(replayRunId, { at: new Date().toISOString(), phase: 'recovery.start', recoveredFrom: replayFrom, verdict: analysis.verdict, lastPhase: analysis.lastPhase });
          const run = await runRecipe({ recipe, executors: createRuntimeExecutors({ bridge, gui: guiClient }), params: {}, approvals: {}, journal: automationJournal, runId: replayRunId, signal: controller.signal });
          // 只有重放成功收敛才把原 run 标记为已恢复（失败则保持"未完成"，下次还能看到）。
          if (run.state === 'completed') {
            automationJournal.append(replayFrom, { at: new Date().toISOString(), phase: 'run.recovered', recoveredBy: replayRunId, state: run.state });
          }
          result = { ok: true, replay: { recoveredFrom: replayFrom, snapshot: analysis, runId: replayRunId, run } };
        } finally {
          activeRunControllers.delete(replayRunId);
          automationRunLock.release(lock.token);
        }
      } else if (method === 'POST' && /^\/api\/automation\/runs\/[^/]+\/abort$/.test(url.pathname)) {
        // E7 中止：只允许中止正在执行的 run；在下一个步骤边界生效（进行中的动作会完成并读回）。
        const abortRunId = decodeURIComponent(url.pathname.split('/')[4]);
        const controller = activeRunControllers.get(abortRunId);
        if (!controller) {
          throw Object.assign(new Error(`该运行不在执行中（可能已完成/失败/不存在）：${abortRunId}`), {
            code: 'AUTOMATION_RUN_NOT_RUNNING', status: 409, details: { runId: abortRunId, hint: '已完成或失败的运行不可中止；请查看审计链确认最终状态' },
          });
        }
        controller.abort('operator_requested');
        result = { ok: true, runId: abortRunId, abortRequested: true, note: '中止将在下一个步骤边界生效：进行中的动作会完成并读回；写动作若已发出可能已生效，结果里会标记 mayHaveTakenEffect' };
      } else if (method === 'GET' && /^\/api\/automation\/runs\/[^/]+\/audit-bundle$/.test(url.pathname)) {
        // E11：写步骤安全审计包（before/after 截图摘要 + 读回摘要 + 批准 id/目标指纹 + 哈希链校验）。
        const auditRunId = decodeURIComponent(url.pathname.split('/')[4]);
        const auditEntries = automationJournal.read(auditRunId);
        if (!auditEntries.length || auditEntries[0]?.phase !== 'run.start') {
          throw Object.assign(new Error(`审计记录不存在（不是 run 记录）：${auditRunId}`), { code: 'AUTOMATION_RUN_NOT_FOUND', status: 404, details: { runId: auditRunId } });
        }
        const auditRun = auditEntries[0];
        const auditRecipe = auditRun.recipeId ? automationRegistry.get(auditRun.recipeId) : null;
        const auditWriteSteps = auditRecipe ? auditRecipe.steps.filter((step) => step.approval === 'write' || step.approval === 'destructive').map((step) => step.id) : [];
        result = { ok: true, bundle: buildRunAuditBundle(auditEntries, { runId: auditRunId, writeStepIds: auditWriteSteps, recipeId: auditRun.recipeId }) };
      } else if (method === 'GET' && /^\/api\/automation\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/')[4]);
        const entries = automationJournal.read(runId);
        if (!entries.length) throw Object.assign(new Error('自动化运行记录不存在'), { code: 'AUTOMATION_RUN_NOT_FOUND', status: 404 });
        result = { ok: true, run: { runId, entries, chain: automationJournal.verify(entries), journalPath: automationJournal.pathFor(runId) } };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/normalize') {
        const body = await readBody(request);
        result = { ok: true, planning: productionManager.normalize(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/compile') {
        const body = await readBody(request);
        result = { ok: true, planning: productionManager.compile(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/ai') {
        const body = await readBody(request);
        const candidate = await chatManager.productionPlan(body);
        result = { ok: true, candidate, planning: candidate.plan ? productionManager.normalize(candidate.plan) : null };
      } else if (method === 'POST' && url.pathname === '/api/supply/pricing') {
        // 按需查询嘉立创/LCSC 价格与库存。**必须由调用方显式触发**：导出/发布路径不会自己联网。
        // 真机实测源：jlcpcb.com SMT 选料接口（含价格阶梯与库存，USD 计价），只认精确料号匹配；
        // 查不到就是 unknown + 理由，绝不猜价格、绝不把 unknown 当成已定价。
        const body = await readBody(request);
        const lcscIds = (Array.isArray(body.lcscIds) ? body.lcscIds : [])
          .map((id) => String(id || '').trim().toUpperCase())
          .filter((id) => /^C\d{4,}$/.test(id))
          .slice(0, 200);
        const lookup = await lookupLcscParts({ lcscIds, timeoutMs: Number(body.timeoutMs) || undefined });
        result = { ok: true, pricing: formatSupplyEvidence(lookup) };
      } else if (method === 'POST' && url.pathname === '/api/supply/alternatives') {
        /**
         * B9：缺料/过期料号的替代候选。真实关键词检索（JLC/立创 SMT 选料接口），
         * 每条候选显式标 `equivalence:'unverified'`——关键词命中不等于电气等价，工程确认后才可用。
         * 原料号永远排除；某条查询失败只影响该条（带原因），不整体成功。
         */
        const body = await readBody(request);
        const rawItems = Array.isArray(body.items) ? body.items : [];
        if (!rawItems.length) throw Object.assign(new Error('需要至少一个缺料项（items）'), { code: 'ALTERNATIVES_ITEMS_REQUIRED', status: 400 });
        const items = rawItems.slice(0, 10).map((item) => ({
          lcscId: typeof item?.lcscId === 'string' ? item.lcscId.trim().toUpperCase() : null,
          mpn: typeof item?.mpn === 'string' ? item.mpn : undefined,
          value: typeof item?.value === 'string' ? item.value : undefined,
          package: typeof item?.package === 'string' ? item.package : undefined,
        }));
        const search = alternativeSearch || (async ({ query }) => searchLcscByKeyword({ query, timeoutMs: Number(body.timeoutMs) || undefined }));
        const alternatives = await findAlternatives({ items, search, maxCandidates: Number(body.maxCandidates) || undefined });
        result = { ok: true, source: 'jlcpcb-smt-component-api', checkedAt: new Date().toISOString(), ...alternatives };
      } else if (method === 'POST' && url.pathname === '/api/library/proposals') {
        // 候选提案：需求/关键词 → 真实库检索 → 价格库存证据 → 可勾选候选清单。
        // 只读：不发写命令、不落文件；检索不到就是空候选，价格查不到就是 unknown（绝不猜）。
        const body = await readBody(request);
        const requirement = normalizeRequirement(body);
        if (!requirement.queries.length && !requirement.lcscIds.length) {
          throw Object.assign(new Error('需要至少一个检索关键词或 LCSC 料号'), { code: 'PROPOSAL_QUERY_REQUIRED', status: 400 });
        }
        if (!bridge.port) await bridge.discover();
        const candidates = [];
        const searchOnce = async (query) => {
          const mode = /^C\d+$/i.test(query) ? 'lcsc' : 'keyword';
          const raw = await bridge.execute('library.device.search', { query, mode, limit: 20, page: 1 });
          candidates.push(...normalizeDeviceCandidates(raw));
        };
        for (const query of requirement.queries) await searchOnce(query);
        // 只给料号时按料号精确检索：保证候选是"真实存在的器件"，而不是按名字猜出来的型号。
        if (!requirement.queries.length) for (const lcscId of requirement.lcscIds) await searchOnce(lcscId);
        const lcscIdsForPricing = [...new Set([...requirement.lcscIds, ...candidates.map((item) => item.lcscId).filter(Boolean)])].slice(0, 200);
        let pricing = null;
        if (body.fetchPricing !== false && lcscIdsForPricing.length) {
          try {
            pricing = formatSupplyEvidence(await lookupLcscParts({ lcscIds: lcscIdsForPricing, timeoutMs: Number(body.timeoutMs) || undefined }));
          } catch (error) {
            // 查价失败不能变成"没有价格"，要留原因给用户看。
            pricing = { kind: 'supply-pricing-evidence', schemaVersion: 1, available: false, error: error.message, entries: [] };
          }
        }
        result = { ok: true, proposal: buildPartProposal({ ...requirement, candidates, pricing }) };
        logger.info('Proposal', 'Part proposal built', { queries: requirement.queries.length, candidateCount: result.proposal.summary.candidates, priced: result.proposal.summary.priced });
      } else if (method === 'POST' && url.pathname === '/api/library/proposals/plan') {
        // 用户勾选 → 落 plan：只生成计划（reviewed-netlist），**不写工程**；
        // 真正落板仍必须走 approve（审批令牌绑定 planHash）→ execute。
        const body = await readBody(request);
        result = { ok: true, ...selectProposalToPlan({ proposal: body.proposal, selectedIds: body.selectedIds, title: body.title, nets: body.nets }) };
        logger.info('Proposal', 'Selection turned into plan', { proposalId: result.proposalId, selected: result.selection.selected.length, ready: result.planning.ready, missing: result.planning.missing.length });
      } else if (method === 'POST' && url.pathname === '/api/production/artifacts/inspect') {
        const body = await readBody(request);
        result = { ok: true, inspection: productionManager.artifacts(body.binding || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/readiness') {
        const body = await readBody(request);
        const planHash = typeof body.semanticPlanHash === 'string' && body.semanticPlanHash ? body.semanticPlanHash : null;
        // 只吃"绑定到本计划"的 DFM 证据；签核证据在 manager 内再做绑定校验。
        result = {
          ok: true,
          readiness: productionManager.readiness(body, {
            dfm: evidenceStore.latest('dfm-evidence', planHash ? { fingerprint: { planHash } } : {}),
            signoff: evidenceStore.latest('signoff'),
          }),
        };
      } else if (method === 'POST' && url.pathname === '/api/production/reviews/final') {
        const body = await readBody(request);
        result = { ok: true, review: productionManager.finalReview(body) };
        logger.warn('Production', 'Recorded human final review', { reviewedBy: result.review.reviewer, semanticPlanHash: result.review.semanticPlanHash, manifestHash: result.review.manifestHash });
      } else if (method === 'GET' && url.pathname === '/api/engineering/profiles') {
        result = { ok: true, profiles: engineeringProfiles(), fixtures: Object.keys(engineeringFixtures) };
      } else if (method === 'GET' && url.pathname === '/api/engineering/layout-rules') {
        // 只回元信息（128 条正文在 pack 文件里），并列出可直接审计的样板
        result = { ok: true, pack: layoutRulePackSummary(), fixtures: Object.keys(LAYOUT_RULE_FIXTURES) };
      } else if (method === 'POST' && url.pathname === '/api/engineering/layout-rules/audit') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? LAYOUT_RULE_FIXTURES[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('布局规则样板不存在'), { code: 'LAYOUT_RULE_FIXTURE_NOT_FOUND', status: 404 });
        const audit = evaluateLayoutRules(fixture ? fixture() : body.input || {});
        result = { ok: true, audit };
        logger.info('Engineering', 'PCBA layout rule audit completed', { fixtureId: body.fixtureId || null, passed: audit.passed, releaseReady: audit.releaseReady, blocking: audit.summary.blockingFailures, review: audit.summary.REVIEW, auditHash: audit.auditHash });
      } else if (method === 'GET' && url.pathname === '/api/engineering/fab-rules') {
        // 板厂能力只回元信息，30 条限值留在 rules/fab-capabilities.json
        result = { ok: true, pack: fabProfileSummary(), fixtures: Object.keys(FAB_RULE_FIXTURES) };
      } else if (method === 'POST' && url.pathname === '/api/engineering/fab-rules/audit') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? FAB_RULE_FIXTURES[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('板厂规则样板不存在'), { code: 'FAB_RULE_FIXTURE_NOT_FOUND', status: 404 });
        let audit;
        try {
          audit = evaluateFabRules(fixture ? fixture() : body.input || {});
        } catch (error) {
          if (String(error?.code || '').startsWith('FAB_PROFILE_')) throw Object.assign(error, { status: 400 });
          throw error;
        }
        result = { ok: true, audit };
        logger.info('Engineering', 'Fab capability audit completed', { fixtureId: body.fixtureId || null, fab: audit.fab, variant: audit.variant, passed: audit.passed, releaseReady: audit.releaseReady, blocking: audit.summary.blockingFailures, review: audit.summary.REVIEW, auditHash: audit.auditHash });
      } else if (method === 'GET' && url.pathname === '/api/engineering/net-rules') {
        result = { ok: true, ...netRuleSummary() };
      } else if (method === 'POST' && url.pathname === '/api/engineering/net-rules/audit') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? NET_RULE_FIXTURES[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('网络规则样板不存在'), { code: 'NET_RULE_FIXTURE_NOT_FOUND', status: 404 });
        const audit = evaluateNetRules(fixture ? fixture() : body.input || {});
        result = { ok: true, audit };
        logger.info('Engineering', 'Net rule audit completed', { fixtureId: body.fixtureId || null, passed: audit.passed, releaseReady: audit.releaseReady, blocking: audit.summary.blockingFailures, review: audit.summary.REVIEW, auditHash: audit.auditHash });
      } else if (method === 'GET' && url.pathname === '/api/engineering/constraint-rules') {
        result = { ok: true, ...skillRuleSummary() };
      } else if (method === 'POST' && url.pathname === '/api/engineering/constraint-rules/audit') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? SKILL_RULE_FIXTURES[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('Skill 规则样板不存在'), { code: 'SKILL_RULE_FIXTURE_NOT_FOUND', status: 404 });
        const audit = evaluateSkillRules(fixture ? fixture() : body.input || {});
        result = { ok: true, audit };
        logger.info('Engineering', 'Skill rule audit completed', { fixtureId: body.fixtureId || null, passed: audit.passed, releaseReady: audit.releaseReady, blocking: audit.summary.blockingFailures, review: audit.summary.REVIEW, auditHash: audit.auditHash });
      } else if (method === 'POST' && url.pathname === '/api/engineering/constraint-rules/bridge-audit') {
        const body = await readBody(request);
        await ensureEdaSession();
        const unwrapBridge = (value) => value?.result ?? value;
        const document = unwrapBridge(await bridge.execute('document.current', {}));
        if (Number(document?.documentType) !== 3) {
          throw Object.assign(new Error(`当前文档不是 PCB（documentType=${document?.documentType ?? 'unknown'}），请先打开 PCB 或调用 pcb.open`), { code: 'NOT_A_PCB_DOCUMENT', status: 409, details: { documentType: document?.documentType ?? null, uuid: document?.uuid ?? null } });
        }
        const design = body.design && typeof body.design === 'object' && !Array.isArray(body.design) ? body.design : {};
        const read = async (commandId) => unwrapBridge(await bridge.execute(commandId, {}));
        const placement = await read('pcb.placement.read');
        const regions = await read('pcb.regions.detail');
        const texts = await read('pcb.texts.detail');
        const pours = await read('pcb.pours.detail');
        const outline = await read('pcb.outline.read');
        const includeCopper = body.includeCopper === true || Boolean(design.netClasses && design.netClassMap);
        const copper = includeCopper ? await read('pcb.copper.read') : null;
        const input = buildSkillInput({ placement, regions, texts, pours, outline, copper, design });
        const audit = evaluateSkillRules(input);
        result = {
          ok: true,
          bridge: { document: { uuid: document.uuid ?? null, tabId: document.tabId ?? null, documentType: document.documentType }, reads: ['pcb.placement.read', 'pcb.regions.detail', 'pcb.texts.detail', 'pcb.pours.detail', 'pcb.outline.read', ...(includeCopper ? ['pcb.copper.read'] : [])] },
          collected: { components: input.placements.length, regions: input.regions.length, silkTexts: input.silkTexts.length, pours: input.pours.length, tracks: Array.isArray(input.tracks) ? input.tracks.length : 0, board: input.board },
          audit,
        };
        logger.info('Engineering', 'Bridge skill audit completed', { documentUuid: document.uuid || null, components: input.placements.length, passed: audit.passed, releaseReady: audit.releaseReady, blocking: audit.summary.blockingFailures, review: audit.summary.REVIEW, auditHash: audit.auditHash });
      } else if (method === 'POST' && url.pathname === '/api/engineering/analyze') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? engineeringFixtures[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('工程样板不存在'), { code: 'ENGINEERING_FIXTURE_NOT_FOUND', status: 404 });
        result = { ok: true, analysis: runEngineeringAnalysis(fixture ? fixture() : body.input || {}) };
        logger.info('Engineering', 'Advanced PCB engineering analysis completed', { fixtureId: body.fixtureId || null, passed: result.analysis.passed, reportHash: result.analysis.reportHash, findingCount: result.analysis.findings.length });
      } else if (method === 'GET' && url.pathname === '/api/chat/status') {
        result = { ok: true, chat: await chatManager.status(url.searchParams.get('provider') || 'codex_account') };
      } else if (method === 'POST' && /^\/api\/chat\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
        const body = await readBody(request);
        result = { ok: true, chat: await chatManager.send(sessionId, body) };
        logger.info('Chat', 'Codex PCBA chat turn completed', { sessionId, suggestions: result.chat.requirementSuggestions.length, edaStatus: result.chat.eda.status });
      } else if (method === 'GET' && url.pathname === '/api/chat/sessions') {
        result = { ok: true, sessions: chatManager.listSessions() };
      } else if (method === 'GET' && /^\/api\/chat\/sessions\/[^/]+\/transcript$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
        result = { ok: true, transcript: chatManager.transcript(sessionId) };
      } else if (method === 'DELETE' && /^\/api\/chat\/sessions\/[^/]+$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
        result = { ok: true, chat: chatManager.reset(sessionId) };
        logger.info('Chat', 'Chat session reset', { sessionId });
      } else if (method === 'GET' && url.pathname === '/api/events') {
        result = { ok: true, events: listEvents() };
      } else if (method === 'GET' && url.pathname === '/api/approvals/ledger') {
        // 统一批准账本：只回审计事实（scope/action/绑定哈希/时间）与哈希链校验结果，不回落盘路径与令牌。
        result = { ok: true, ...approvalLedger.snapshot({ limit: 100 }) };
      } else {
        throw Object.assign(new Error('Runtime端点不存在'), { code: 'ROUTE_NOT_FOUND', status: 404 });
      }
      logger.info('Http', 'Request completed', { requestId, method, path: url.pathname, duration: Math.round(performance.now() - startedAt) });
      if (result && typeof result === 'object' && result.__file) {
        logger.info('Http', 'Artifact download served', { requestId, file: result.__file.name, size: result.__file.size });
        sendFile(response, result.__file, origin);
        return;
      }
      return sendJson(response, 200, result, origin);
    } catch (error) {
      logger.error('Http', 'Request failed', { requestId, method, path: url.pathname, code: error.code, message: error.message });
      // 桥连通性错误（BRIDGE_UNREACHABLE/TIMEOUT/NOT_FOUND）→ 503；显式 status 优先；
      // 其余未知错误维持历史兜底 400。见 httpStatusForError 的注释。
      return sendJson(response, httpStatusForError(error), runtimeError(error), origin);
    }
  });
  // 没有 error 监听器时，EADDRINUSE / EACCES 会变成未捕获异常直接击穿进程；
  // 这里统一记录，便于定位“端口被占用”和“权限不足”。
  server.on('error', (error) => logger.error('Http', 'Runtime server error', { code: error.code, message: error.message, host: RUNTIME_HOST }));
  server.on('close', () => chatManager.close?.());
  return { server, sessionToken, httpTokenIssuance };
}

/**
 * 从 stdin 读取壳层通过管道下发的会话令牌（首行，读到换行或 EOF 为止）。
 *
 * 为什么走管道而不是环境变量：macOS 上同一用户的其它进程可以用 `ps -E` 读到
 * 别人进程的环境变量，令牌放在环境里等于对“本机同用户进程”这个威胁模型完全暴露。
 * 管道内容不落在 argv、环境变量或磁盘上，同用户进程无法读取。
 *
 * 超时返回空串；由调用方决定是 fail closed 还是回退。
 */
export function readTokenFromStdin({ timeoutMs = 5000, stdin = process.stdin } = {}) {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      try { stdin.pause(); } catch { /* 流已关闭时忽略 */ }
      resolve(value);
    };
    const onData = (chunk) => { buffer += chunk; const index = buffer.indexOf('\n'); if (index >= 0) finish(buffer.slice(0, index).trim()); };
    const onEnd = () => finish(buffer.trim());
    const onError = () => finish('');
    const timer = setTimeout(() => finish(''), timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

/**
 * 解析启动时的令牌来源。
 *
 * 壳层会设置 CIRCUITPILOT_TOKEN_STDIN=1 并通过管道写入令牌。此时必须 fail closed：
 * 一旦管道没送到就退化成“随机令牌 + HTTP 发放”，会把已经关掉的攻击面重新打开，
 * 所以这种情况直接拒绝启动，而不是悄悄降级。
 */
export async function resolveStartupToken({ env = process.env, readStdin = readTokenFromStdin } = {}) {
  const expectStdin = env.CIRCUITPILOT_TOKEN_STDIN === '1';
  const stdinToken = expectStdin ? await readStdin() : '';
  if (expectStdin && stdinToken.length < 16) {
    return { ok: false, reason: `CIRCUITPILOT_TOKEN_STDIN=1 但 stdin 上没有读到有效令牌（收到 ${stdinToken.length} 字符）` };
  }
  if (stdinToken) return { ok: true, runtimeToken: stdinToken, source: 'stdin' };
  if (typeof env.CIRCUITPILOT_RUNTIME_TOKEN === 'string' && env.CIRCUITPILOT_RUNTIME_TOKEN) return { ok: true, runtimeToken: env.CIRCUITPILOT_RUNTIME_TOKEN, source: 'env' };
  return { ok: true, runtimeToken: undefined, source: 'none' };
}

export async function startRuntime({ port = RUNTIME_PORT, runtimeToken } = {}) {
  // 已有桥进程（例如开发者手动启动）时不要另起一个抢端口；此时沿用现有实例，
  // 并让客户端不带 token（兼容旧实例）。全新安装则自动启动带 token 的桥。
  const existingBridge = await anyBridgeRunning();
  const bridgeToken = existingBridge ? '' : crypto.randomBytes(32).toString('hex');
  const bridgeProcess = existingBridge ? null : spawnBridgeServer(bridgeToken);
  const { server } = createRuntimeServer({ runtimeToken, bridgeToken });
  // 端口被占用时不要假装启动成功：细节已由上面的 error 监听器记录，这里只负责非零退出。
  server.once('error', () => process.exit(1));
  server.listen(port, RUNTIME_HOST, () => logger.info('Runtime', 'CircuitPilot Runtime started', { host: RUNTIME_HOST, port, bridgeAutoStart: Boolean(bridgeProcess) }));
  const shutdown = (signal) => {
    logger.warn('Runtime', 'CircuitPilot Runtime stopping', { signal });
    try { bridgeProcess?.kill('SIGTERM'); } catch { /* 已退出 */ }
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

async function main() {
  const resolved = await resolveStartupToken();
  if (!resolved.ok) {
    // fail closed：见 resolveStartupToken 的说明。
    logger.error('Runtime', 'Refusing to start without the token the shell promised to pipe', { reason: resolved.reason });
    process.exit(1);
  }
  // 只记录令牌“来源”，绝不记录令牌本身：这是可观测证据，用来核实发布版到底走的哪条通道
  // （stdin=壳层管道，env=开发/测试，none=随机令牌+受信 Origin 引导）。
  logger.info('Runtime', 'Session token source resolved', { source: resolved.source });
  return await startRuntime({ runtimeToken: resolved.runtimeToken });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
