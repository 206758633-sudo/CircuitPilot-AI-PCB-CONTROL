/**
 * 复合设计框架的 Runtime 服务层（给 HTTP 路由 / Agent / 未来 UI 用的纯函数包装）。
 *
 * 边界：
 *   - 只读离线：不写 EDA、不签核、不触发任何写操作；输出只是"执行候选计划 + 证据"；
 *   - fail-closed：模型非法 / 过大 / 闭环内部错误一律抛结构化错误，绝不返回"看起来通过"；
 *   - 稳定裁剪：HTTP 层返回摘要（不是整个 IR/全部 findings），避免把响应撑爆。
 */
import { fileURLToPath } from 'node:url';
import { adaptPlacements } from './engineering/skill-input.mjs';
import { parseEasyEdaNetlist } from './net-connectivity.mjs';
import {
  createBoardModel,
  frameworkStatus,
  runDesignLoop,
  runGoldenEvaluation,
} from './design-framework/index.mjs';

export const DESIGN_FRAMEWORK_SERVICE_CODES = Object.freeze({
  INVALID_MODEL: 'DESIGN_FRAMEWORK_INVALID_MODEL',
  MODEL_TOO_LARGE: 'DESIGN_FRAMEWORK_MODEL_TOO_LARGE',
  RUN_FAILED: 'DESIGN_FRAMEWORK_RUN_FAILED',
  GOLDEN_FAILED: 'DESIGN_FRAMEWORK_GOLDEN_FAILED',
  NO_ACTIVE_PROJECT: 'DESIGN_FRAMEWORK_NO_ACTIVE_PROJECT',
  EDA_OFFLINE: 'DESIGN_FRAMEWORK_EDA_OFFLINE',
  EDA_READ_FAILED: 'DESIGN_FRAMEWORK_EDA_READ_FAILED',
});

/** 与插件侧 `cp_design_loop` 约定一致：模型 JSON 上限 200KB、迭代上限 8。 */
export const DESIGN_FRAMEWORK_MODEL_MAX_BYTES = 200_000;
export const DESIGN_FRAMEWORK_MAX_ITERATIONS = 8;
export const DEFAULT_GOLDEN_DIR = fileURLToPath(new URL('../eval/golden/', import.meta.url));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const coded = (code, message, status, details = null) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

function clampIterations(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, 'options.maxIterations 必须是数字', 400, { value });
  return Math.min(DESIGN_FRAMEWORK_MAX_ITERATIONS, Math.max(1, Math.floor(parsed)));
}

function summarizeIterations(iterations) {
  return (Array.isArray(iterations) ? iterations : []).map((entry) => ({
    iteration: entry.iteration,
    modelDigest: entry.modelDigest,
    blocking: Array.isArray(entry.blocking) ? entry.blocking.map((item) => ({ source: item.source, code: item.code, ref: item.ref ?? null, group: item.group ?? null })) : [],
    reviewCount: entry.reviewCount,
  }));
}

/** 把闭环结果裁剪成 HTTP/Agent 用的稳定摘要。 */
export function summarizeLoopResult(result) {
  const summary = result?.summary ?? {};
  return {
    ok: result?.ok === true,
    status: result?.status ?? 'blocked',
    iterations: summarizeIterations(result?.iterations),
    repairCount: Array.isArray(result?.repairs) ? result.repairs.length : 0,
    repairs: (Array.isArray(result?.repairs) ? result.repairs : []).map((repair) => ({ iteration: repair.iteration, strategy: repair.strategy, riskLevel: repair.riskLevel, fromDigest: repair.fromDigest, toDigest: repair.toDigest, detail: repair.detail ?? null })),
    summary: {
      initialDigest: summary.initialDigest ?? null,
      finalDigest: summary.finalDigest ?? null,
      iterations: summary.iterations ?? 0,
      repairs: summary.repairs ?? 0,
      blocking: summary.blocking ?? null,
      review: summary.review ?? null,
      ruleCoverage: summary.ruleCoverage ?? null,
      releaseReady: summary.releaseReady === true,
      model: summary.model ?? null,
    },
    rules: result?.rules ?? null,
    netlist: result?.netlist ?? null,
    plan: {
      operations: Array.isArray(result?.plan?.operations) ? result.plan.operations.length : 0,
      skipped: Array.isArray(result?.plan?.skipped) ? result.plan.skipped.slice(0, 50) : [],
    },
    evidence: result?.evidence ?? null,
    digest: result?.digest ?? null,
  };
}

/**
 * 运行一次离线设计闭环（只读）。
 * @param {{model:object, options?:{maxIterations?:number, fabProfile?:string}}} input
 * @returns {object} 裁剪后的闭环摘要
 */
export function runFrameworkLoop({ model, options } = {}) {
  if (!isPlainObject(model)) throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, 'model 必须是板级 IR 对象（board/components/nets）', 400);
  const normalizedOptions = isPlainObject(options) ? options : {};
  let serialized;
  try {
    serialized = JSON.stringify(model);
  } catch (error) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, `model 不是合法 JSON：${String(error?.message ?? error).slice(0, 160)}`, 400);
  }
  const bytes = Buffer.byteLength(serialized ?? '', 'utf8');
  if (bytes > DESIGN_FRAMEWORK_MODEL_MAX_BYTES) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.MODEL_TOO_LARGE, `model JSON 超过上限 ${DESIGN_FRAMEWORK_MODEL_MAX_BYTES} 字节（实际 ${bytes}）`, 413, { bytes, maxBytes: DESIGN_FRAMEWORK_MODEL_MAX_BYTES });
  }
  const maxIterations = clampIterations(normalizedOptions.maxIterations);
  const fabProfile = typeof normalizedOptions.fabProfile === 'string' && normalizedOptions.fabProfile.trim() ? normalizedOptions.fabProfile.trim() : undefined;
  let result;
  try {
    result = runDesignLoop(model, {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(fabProfile === undefined ? {} : { fabProfile }),
    });
  } catch (error) {
    // 模型结构错误（板框/位号/网络等）挂 400；其它内部错误挂 500，但都不伪装成功。
    const status = Number.isInteger(error?.status) ? error.status : /BOARD_MODEL_/.test(String(error?.code ?? '')) ? 400 : 500;
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.RUN_FAILED, String(error?.message ?? error), status, { causeCode: error?.code ?? null });
  }
  return summarizeLoopResult(result);
}

/**
 * 从 EasyEDA 网表文本解析 IR nets（可失败；失败不编造网络）。
 * 只保留 IR 里已存在的器件；同一 net 的 pin 去重、按 net 名排序（确定性）。
 */
export function netsFromEasyEdaNetlist(netlistText, components = []) {
  const refs = new Set((Array.isArray(components) ? components : []).map((component) => String(component?.ref ?? '').toUpperCase()));
  const parsed = parseEasyEdaNetlist(netlistText);
  if (parsed.ok !== true) return { nets: [], netlist: { ok: false, reason: parsed.reason ?? 'NETLIST_INVALID' } };
  const byNet = new Map();
  for (const component of parsed.components ?? []) {
    const ref = String(component?.designator ?? '').trim().toUpperCase();
    if (!ref || !refs.has(ref)) continue;
    for (const pin of component.pins ?? []) {
      const netName = String(pin?.net ?? '').trim();
      if (!netName) continue;
      const pinNumber = String(pin?.number ?? '').trim();
      if (!pinNumber) continue;
      if (!byNet.has(netName)) byNet.set(netName, new Map());
      byNet.get(netName).set(`${ref}.${pinNumber}`, { ref, pin: pinNumber });
    }
  }
  const nets = [...byNet.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, pins]) => ({ name, pins: [...pins.values()] }));
  return { nets, netlist: { ok: true, netCount: nets.length, parsedComponents: parsed.components?.length ?? 0 } };
}

/**
 * 从「当前项目 + EDA 读回快照」构建板级 IR（只读，不写 EDA）。
 *
 * `projectState` 是 `/api/project-state` 的状态；`edaSnapshot` 由 server 侧只读读取：
 *   { widthMm, heightMm, layers, placementRead? }
 * - 板框/层数缺失（EDA 离线）→ DESIGN_FRAMEWORK_EDA_OFFLINE（409），绝不编造尺寸；
 * - 器件几何来自 `pcb.placement.read`（经 adaptPlacements 归一）；尺寸未知的器件显式 sizeUnknown，
 *   由闭环判 blocked，不猜尺寸；
 * - 网表暂不从 EDA 自动读取（未实现前 nets=[]，规则层会 REVIEW，不冒充通过）。
 */
export function buildModelFromProject({ projectState, edaSnapshot, netlistText = null, title } = {}) {
  if (!isPlainObject(projectState)) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.NO_ACTIVE_PROJECT, '当前没有可读取的项目状态（projectState 非法）', 409);
  }
  const projects = Array.isArray(projectState.projects) ? projectState.projects : [];
  const activeId = typeof projectState.activeProjectId === 'string' ? projectState.activeProjectId : '';
  const project = projects.find((item) => item?.id === activeId) ?? projects[0] ?? null;
  if (!project) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.NO_ACTIVE_PROJECT, '当前没有活动项目：请先在 CircuitPilot 创建/选择项目再运行离线闭环', 409);
  }
  const snapshot = isPlainObject(edaSnapshot) ? edaSnapshot : null;
  const widthMm = Number(snapshot?.widthMm);
  const heightMm = Number(snapshot?.heightMm);
  const layers = Number(snapshot?.layers);
  if (!snapshot || !(widthMm > 0) || !(heightMm > 0) || !Number.isInteger(layers) || layers < 2) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.EDA_OFFLINE, 'EDA 不在线或未返回可用板框/铜层数：无法从项目构建板级 IR（拒绝编造尺寸）', 409);
  }
  const placements = adaptPlacements(snapshot.placementRead ?? null);
  const components = placements.map((placement) => ({
    ref: placement.ref,
    ...(placement.layerSide === 'bottom' ? { side: 'bottom' } : {}),
    xMm: Number.isFinite(placement.centerXMm) ? placement.centerXMm : 0,
    yMm: Number.isFinite(placement.centerYMm) ? placement.centerYMm : 0,
    rotationDeg: Number.isFinite(placement.rotationDeg) ? placement.rotationDeg : 0,
    ...(placement.widthMm > 0 && placement.heightMm > 0
      ? { widthMm: placement.widthMm, heightMm: placement.heightMm }
      : { sizeUnknown: true }),
  }));
  const netlistSource = netlistText ?? snapshot.netlistText ?? null;
  const parsedNets = netlistSource ? netsFromEasyEdaNetlist(netlistSource, components) : { nets: [], netlist: { ok: false, reason: 'NETLIST_NOT_READ' } };
  const model = createBoardModel({
    meta: { title: typeof title === 'string' && title.trim() ? title.trim() : (project.name ?? project.id ?? 'project'), source: 'project+eda-readback' },
    board: { widthMm, heightMm, layers, thicknessMm: snapshot.thicknessMm ?? null, copperOz: snapshot.copperOz ?? null },
    components,
    nets: parsedNets.nets,
    rules: {},
  });
  model.meta.netlist = parsedNets.netlist;
  return model;
}

/**
 * 运行「项目来源」的离线设计闭环（只读）。EDA 离线/项目缺失时抛结构化错误（409），
 * 绝不返回"看起来通过"的模型。
 */
export function runFrameworkForProject({ projectState, edaSnapshot, netlistText = null, options, title } = {}) {
  const model = buildModelFromProject({ projectState, edaSnapshot, netlistText, title });
  const normalizedOptions = isPlainObject(options) ? options : {};
  const maxIterations = clampIterations(normalizedOptions.maxIterations);
  const fabProfile = typeof normalizedOptions.fabProfile === 'string' && normalizedOptions.fabProfile.trim() ? normalizedOptions.fabProfile.trim() : undefined;
  try {
    const result = runDesignLoop(model, {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(fabProfile === undefined ? {} : { fabProfile }),
    });
    return {
      ...summarizeLoopResult(result),
      source: 'project',
      modelSummary: { board: { widthMm: model.board.widthMm, heightMm: model.board.heightMm, layers: model.board.layers }, componentCount: model.components.length, netCount: model.nets.length, netlist: model.meta.netlist ?? null },
    };
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : /BOARD_MODEL_/.test(String(error?.code ?? '')) ? 400 : 500;
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.RUN_FAILED, String(error?.message ?? error), status, { causeCode: error?.code ?? null });
  }
}

/** 框架状态（KiCad CLI / 外部求解器探测 + 分层元数据），只读。 */
export function frameworkStatusView() {
  return frameworkStatus();
}

/** 金板评估（5 个离线用例），只读；失败不抛异常，返回 ok:false + metrics。 */
export function goldenReport({ dir = DEFAULT_GOLDEN_DIR } = {}) {
  try {
    const report = runGoldenEvaluation({ dir, runLoop: runDesignLoop });
    return {
      ok: report.ok === true,
      metrics: report.metrics,
      results: report.results.map((result) => ({
        id: result.id,
        ok: result.ok,
        status: result.status,
        iterations: result.iterations,
        repairCount: result.repairCount,
        blockingAfter: result.blockingAfter,
        reviewAfter: result.reviewAfter,
        ruleCoverage: result.ruleCoverage,
        violations: result.violations,
      })),
    };
  } catch (error) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.GOLDEN_FAILED, String(error?.message ?? error), 500, { causeCode: error?.code ?? null });
  }
}
