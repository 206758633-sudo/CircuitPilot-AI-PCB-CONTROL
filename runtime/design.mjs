import crypto from 'node:crypto';
import { createApprovalService } from './approval-service.mjs';

export const DESIGN_API_VERSION = 1;
const REQUIRED_BLOCKS = ['mcu', 'power', 'led', 'button'];
// P1-5：原理图写入没有显式批次，按操作数切批（每 10 个操作复读一次工程/文档身份）。
const WRITE_BATCH_SIZE = 10;

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex'); }

export function canonicalDocumentSource(source) {
  if (typeof source !== 'string') return source;
  return source
    .replace(/"client":"[^"]*"/, '"client":"__VOLATILE__"')
    .replace(/"updateTime":\d+/, '"updateTime":0')
    .replace(/"version":"[^"]*"/, '"version":"__VOLATILE__"');
}

export function documentSourceDigest(source) { return digest(canonicalDocumentSource(source)); }

/**
 * P0-1：计划血缘（双哈希）。
 *
 * 为什么必须有：AI 页批准的是"语义计划"，EDA 页真正编译/执行的是"编译计划"。
 * 修复前 normalizePlan/normalizePcbPlan 重建计划时把来源哈希丢掉，批准账本只记单一 planHash，
 * 事后无法证明"写的就是用户批准的那一份"。这里把来源两哈希作为计划字段保留（参与 planHash），
 * 批准令牌与账本再各自绑定，任何一层对不上都能 409。
 */
const PLAN_HASH_RE = /^[a-f0-9]{16,64}$/i;
const LINEAGE_FIELDS = ['semanticPlanHash', 'compiledPlanHash'];

function lineageInvalidError(field, value) {
  const received = typeof value === 'string' ? (value.length > 80 ? `${value.slice(0, 80)}…` : value) : typeof value;
  return Object.assign(new Error(`计划血缘 ${field} 显式提供但格式非法：需要 16-64 位十六进制哈希；拒绝写入批准账本`), {
    code: 'APPROVAL_LINEAGE_INVALID',
    status: 400,
    details: { field, received },
  });
}

/**
 * P1-2：血缘输入严格校验（fail-closed），不再把非法值静默置 null。
 *
 * 兼容：字段缺省 / undefined / null 表示“本计划不绑定血缘”（旧计划、旧调用方、无血缘的网表计划都不受影响）。
 * 拒绝：显式空串、纯空白、非字符串、长度不符、非十六进制 → APPROVAL_LINEAGE_INVALID（status 400）。
 * 为什么：静默丢弃会让“调用方以为写进了血缘、账本里却没有”成为不可见的追溯缺口；
 * 显式非法必须让调用方（HTTP 400）看到，而不是让审批 succeeds with 空血缘。
 */
export function planLineageHashes(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { semanticPlanHash: null, compiledPlanHash: null };
  for (const field of LINEAGE_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw lineageInvalidError(field, value);
    const trimmed = value.trim();
    if (!trimmed || !PLAN_HASH_RE.test(trimmed)) throw lineageInvalidError(field, value);
    result[field] = trimmed.toLowerCase();
  }
  return result;
}
export function attachPlanLineage(plan, input = {}) {
  const lineage = planLineageHashes(input);
  return {
    ...plan,
    ...(lineage.semanticPlanHash ? { semanticPlanHash: lineage.semanticPlanHash } : {}),
    ...(lineage.compiledPlanHash ? { compiledPlanHash: lineage.compiledPlanHash } : {}),
  };
}

/**
 * P1-5：批准目标绑定（projectId/documentUuid，可空）。
 * 空串/空白按“未绑定”处理，兼容旧调用方；显式非字符串值拒绝为 APPROVAL_TARGET_INVALID(400)。
 */
export function normalizeTargetBinding({ projectId = null, documentUuid = null } = {}) {
  const clean = (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw Object.assign(new Error(`批准目标 ${field} 必须是字符串（可空）`), { code: 'APPROVAL_TARGET_INVALID', status: 400, details: { field } });
    const trimmed = value.trim();
    return trimmed || null;
  };
  return { projectId: clean(projectId, 'projectId'), documentUuid: clean(documentUuid, 'documentUuid') };
}

export function normalizePlan(input = {}) {
  if (input.kind === 'reviewed-netlist') {
    const plan = attachPlanLineage({ apiVersion: DESIGN_API_VERSION, kind: 'reviewed-netlist', title: String(input.title || '已审核项目网络表'), nets: Array.isArray(input.nets) ? input.nets.map(String) : [], operations: Array.isArray(input.operations) ? input.operations : [], assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [] }, input);
    const missing = [];
    if (!plan.nets.length) missing.push('nets');
    if (!plan.operations.length) missing.push('operations');
    for (const [index, operation] of plan.operations.entries()) {
      if (!['component.create','net.connect'].includes(operation?.type)) missing.push(`unsupported-operation:${operation?.type}`);
      if (operation?.type === 'net.connect' && (!operation.args?.net || !Array.isArray(operation.args?.endpoints) || operation.args.endpoints.length < 2)) missing.push(`net.connect.${index}`);
    }
    return { plan, missing, ready: missing.length === 0, planHash: digest(plan) };
  }
  const blocks = Object.fromEntries(REQUIRED_BLOCKS.map((id) => [id, input.blocks?.[id] || null]));
  const plan = attachPlanLineage({
    apiVersion: DESIGN_API_VERSION,
    kind: 'simple-control-board',
    title: String(input.title || 'MCU + 电源 + LED + 按键简单控制板'),
    blocks,
    nets: Array.isArray(input.nets) ? [...input.nets].map(String).sort() : [],
    placements: Array.isArray(input.placements) ? input.placements : [],
    operations: Array.isArray(input.operations) ? input.operations : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
  }, input);
  const missing = [];
  for (const id of REQUIRED_BLOCKS) {
    const block = blocks[id];
    if (!block) missing.push(`${id}:未提供`);
    else {
      if (!block.libraryUuid) missing.push(`${id}:libraryUuid`);
      if (!block.uuid) missing.push(`${id}:uuid`);
      if (!block.value) missing.push(`${id}:value`);
    }
  }
  if (!plan.nets.length) missing.push('nets');
  if (!plan.operations.length) missing.push('operations');
  const forbidden = plan.operations.find((item) => !['component.create', 'pin.noConnect', 'netFlag.create', 'wire.create'].includes(item?.type));
  if (forbidden) missing.push(`unsupported-operation:${forbidden.type}`);
  return { plan, missing, ready: missing.length === 0, planHash: digest(plan) };
}

const PROJECT_IDENTITY_KEYS = ['uuid', 'projectUuid', 'id'];
const DOCUMENT_IDENTITY_KEYS = ['uuid', 'documentUuid', 'id'];

/** 从 bridge 返回里取工程/文档身份（真机 project.current -> {uuid}，document.current -> {uuid,...}）。 */
function targetIdentity(value, keys) {
  const raw = unwrap(value);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    for (const key of keys) {
      const candidate = raw[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

const DRC_SEVERITY = Object.freeze({ error: 'error', fatal: 'error', critical: 'error', warn: 'warning', warning: 'warning', info: 'warning', hint: 'warning' });

/**
 * 把官方 DRC 条目归一化成"可跨基线与本次写入比较"的视图。
 *
 * 真机 `sch_Drc.check(true,false,true)` 既可能返回逐条明细，也可能只返回聚合项
 * （`[{type:'warn',count:6}]`，见 docs/implementation/whole-board-progress.md:841）。
 * 两类都必须能比较：聚合项 key 用 type，明细项 key 用 rule/code + 对象。
 * 未知 severity fail-closed 按 error 处理（新增未知级别违规仍要阻断）。
 */
function drcFindingView(item) {
  if (!item || typeof item !== 'object') return { key: `error|${String(item)}|`, severity: 'error', count: 1 };
  const rawSeverity = String(item.severity ?? item.level ?? item.type ?? '').trim().toLowerCase();
  const severity = DRC_SEVERITY[rawSeverity] ?? 'error';
  const code = String(item.rule ?? item.code ?? item.errorType ?? item.title ?? item.message ?? item.name ?? (rawSeverity ? `aggregate:${rawSeverity}` : 'unknown'));
  const objects = Array.isArray(item.objects) ? item.objects.map((object) => String(object?.type ?? object?.name ?? object ?? '')).join(',') : '';
  const object = String(item.object ?? item.objectName ?? item.instanceKey ?? item.signature ?? objects ?? '');
  const count = Number.isFinite(Number(item.count)) && Number(item.count) > 0 ? Number(item.count) : 1;
  return { key: `${severity}|${code}|${object}`, severity, count };
}

/**
 * P1-3：原理图 DRC 基线裁决——只对"这次写入新增/加重的违规"负责。
 *
 * 真机教训：带既有违规/大量 warning 的板子若不设基线，任何写入都会被旧问题永久回滚（锁死工程）。
 * 规则：
 *  · 普通模式：基线里已有的同 key 违规按历史豁免；只有"新增 error"阻断；新增 warning 记录但不阻断（drcWarnings）。
 *  · strict=true：维持零容忍（任何 DRC 条目都阻断，用于新板/严格交付）。
 *  · 未知 severity 按 error（fail-closed）。
 * 返回 drcBaseline 摘要由调用方从 baseline 数组构造；这里给出 regressions/exempted/warnings 明细。
 */
export function schematicDrcVerdict({ baseline = null, findings = [], strict = false } = {}) {
  const aggregate = (items) => {
    const map = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const view = drcFindingView(item);
      const entry = map.get(view.key) || { key: view.key, severity: view.severity, count: 0 };
      entry.count += view.count;
      if (view.severity === 'error') entry.severity = 'error';
      map.set(view.key, entry);
    }
    return map;
  };
  const after = aggregate(findings);
  const before = aggregate(baseline);
  const regressions = [];
  for (const [key, entry] of after) {
    const prior = before.get(key)?.count || 0;
    if (entry.count > prior) regressions.push({ key, severity: entry.severity, before: prior, after: entry.count });
  }
  const exempted = [...before.entries()]
    .filter(([key]) => after.has(key))
    .map(([key, entry]) => ({ key, severity: entry.severity, count: Math.min(entry.count, after.get(key)?.count || 0) }));
  const blocking = strict
    ? [...after.values()].map((entry) => ({ key: entry.key, severity: 'error', before: before.get(entry.key)?.count || 0, after: entry.count }))
    : regressions.filter((item) => item.severity === 'error');
  return {
    passed: strict ? after.size === 0 : blocking.length === 0,
    strict: Boolean(strict),
    regressions,
    blocking,
    exempted,
    warnings: regressions.filter((item) => item.severity !== 'error'),
    baselineCount: Array.isArray(baseline) ? baseline.length : null,
    findingCount: Array.isArray(findings) ? findings.length : 0,
  };
}

/** DRC 基线摘要（写入前捕获，供审计/UI 展示"历史豁免了几条"）。 */
function drcBaselineSummary(baseline) {
  const views = (Array.isArray(baseline) ? baseline : []).map(drcFindingView);
  return {
    capturedAt: new Date().toISOString(),
    count: views.length,
    errors: views.filter((view) => view.severity === 'error').reduce((sum, view) => sum + view.count, 0),
    warnings: views.filter((view) => view.severity !== 'error').reduce((sum, view) => sum + view.count, 0),
  };
}

export class ApprovalStore {
  /**
   * 计划批准：统一批准服务（C2）的适配器——内存一次性令牌 + TTL（默认 5 分钟），
   * 生命周期事件写进统一账本（approvalId = 令牌哈希前 16 位，绝不存令牌原文）。
   * 令牌/绑定字段与旧实现保持一致，DesignManager/PcbManager 无需改动。
   */
  constructor({ ttlMs = 5 * 60_000, now = () => Date.now(), ledger = null, scope = 'plan' } = {}) {
    this.ttlMs = ttlMs; this.now = now; this.ledger = ledger; this.scope = scope;
    this.service = createApprovalService({
      now,
      defaultTtlMs: ttlMs,
      maxEntries: 200,
      onEvent: (event) => this.auditEvent(event),
    });
  }
  auditEvent(event) {
    if (!this.ledger) return;
    const record = event.record;
    this.ledger.record({
      scope: this.scope,
      action: event.action,
      approvalId: record?.tokenDigest ? record.tokenDigest.slice(0, 16) : 'unknown-token',
      bindings: record ? {
        planHash: record.bindings.planHash ?? null,
        targetFingerprint: record.bindings.targetFingerprint ?? null,
        windowId: record.bindings.windowId ?? null,
        steps: Array.isArray(record.bindings.steps) ? record.bindings.steps.length : null,
        semanticPlanHash: record.bindings.semanticPlanHash ?? null,
        compiledPlanHash: record.bindings.compiledPlanHash ?? null,
        // P1-5：目标绑定也落账本，事后能回答"批准的是哪个工程/哪个文档"。
        projectId: record.bindings.projectId ?? null,
        documentUuid: record.bindings.documentUuid ?? null,
      } : {},
      note: event.action === 'replayed' && !record ? '批准令牌不存在' : '',
    });
  }
  issue({ planHash, targetFingerprint, windowId, steps, semanticPlanHash = null, compiledPlanHash = null, projectId = null, documentUuid = null }) {
    if (![planHash, targetFingerprint, windowId].every((item) => typeof item === 'string' && item.length)) throw Object.assign(new Error('审批绑定信息不完整'), { code: 'APPROVAL_INVALID' });
    const sortedSteps = [...steps].sort();
    // P0-1：批准令牌同时绑定来源双哈希；账本条目（auditEvent）会一起落盘，事后可核对"写的就是批准的"。
    // P1-2：这里再校验一次，防止绕过 normalizePlan 的直接调用把非法血缘写进账本。
    const lineage = planLineageHashes({ semanticPlanHash: semanticPlanHash ?? undefined, compiledPlanHash: compiledPlanHash ?? undefined });
    const target = normalizeTargetBinding({ projectId, documentUuid });
    const issued = this.service.issue({ scope: this.scope, bindings: { planHash, targetFingerprint, windowId, steps: sortedSteps, ...lineage, ...target }, ttlMs: this.ttlMs });
    return { token: issued.token, planHash, targetFingerprint, windowId, steps: sortedSteps, ...lineage, ...target, expiresAt: issued.expiresAt, used: false };
  }
  consume(token, expected = {}) {
    const lineageExpected = planLineageHashes({ semanticPlanHash: expected.semanticPlanHash ?? undefined, compiledPlanHash: expected.compiledPlanHash ?? undefined });
    const targetExpected = normalizeTargetBinding(expected);
    const expectedBindings = { planHash: expected.planHash, targetFingerprint: expected.targetFingerprint, windowId: expected.windowId, ...lineageExpected };
    // 目标绑定只在调用方显式提供时比对：老调用方不传 projectId/documentUuid 时，不能因为
    // 批准记录里存了目标就被判"不一致"（向后兼容），真正的目标漂移由 DesignManager 读 bridge 校验。
    if (targetExpected.projectId) expectedBindings.projectId = targetExpected.projectId;
    if (targetExpected.documentUuid) expectedBindings.documentUuid = targetExpected.documentUuid;
    const consumed = this.service.consumeToken({ token, requiredScope: this.scope, expectedBindings });
    return {
      planHash: consumed.bindings.planHash,
      semanticPlanHash: consumed.bindings.semanticPlanHash ?? null,
      compiledPlanHash: consumed.bindings.compiledPlanHash ?? null,
      projectId: consumed.bindings.projectId ?? null,
      documentUuid: consumed.bindings.documentUuid ?? null,
      targetFingerprint: consumed.bindings.targetFingerprint,
      windowId: consumed.bindings.windowId,
      steps: consumed.bindings.steps,
      expiresAt: consumed.expiresAt,
      used: true,
    };
  }
  /** UI 待执行队列：只列仍可用的批准（公开字段，不含 token/tokenDigest）。 */
  list() {
    return this.service.list();
  }
  /** UI 按 approvalId 撤销仍可用的批准（不接收/不返回令牌原文）。 */
  revokeById(approvalId) {
    const revoked = this.service.revokeById({ approvalId });
    return { cancelled: true, approvalId: revoked.approvalId, planHash: revoked.bindings.planHash, windowId: revoked.bindings.windowId };
  }
  revoke(token) {
    const revoked = this.service.revokeToken({ token });
    return { cancelled: true, planHash: revoked.bindings.planHash, windowId: revoked.bindings.windowId };
  }
}

function unwrap(result) { return result?.result ?? result?.data ?? result; }
function containsPrimitiveId(value, id) {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsPrimitiveId(item, id));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsPrimitiveId(item, id));
  return false;
}

function lineSegments(line) {
  const paths = Array.isArray(line?.[0]) ? line : [line];
  const segments = [];
  for (const path of paths) {
    if (!Array.isArray(path)) continue;
    for (let index = 0; index + 3 < path.length; index += 2) {
      const a = `${path[index]},${path[index + 1]}`;
      const b = `${path[index + 2]},${path[index + 3]}`;
      segments.push(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  return segments;
}

function decodeSegment(segment) {
  const [a, b] = segment.split('|').map((point) => point.split(',').map(Number));
  return { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
}

function segmentCovered(expectedSegment, actualSegments) {
  const expected = decodeSegment(expectedSegment);
  const horizontal = expected.y1 === expected.y2;
  const vertical = expected.x1 === expected.x2;
  if (!horizontal && !vertical) return actualSegments.has(expectedSegment);
  const start = horizontal ? Math.min(expected.x1, expected.x2) : Math.min(expected.y1, expected.y2);
  const end = horizontal ? Math.max(expected.x1, expected.x2) : Math.max(expected.y1, expected.y2);
  const intervals = [...actualSegments].map(decodeSegment).filter((segment) => horizontal
    ? segment.y1 === expected.y1 && segment.y2 === expected.y1
    : segment.x1 === expected.x1 && segment.x2 === expected.x1)
    .map((segment) => horizontal ? [Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2)] : [Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)])
    .sort((a, b) => a[0] - b[0]);
  let coveredTo = start;
  for (const [from, to] of intervals) {
    if (to < coveredTo || from > coveredTo) continue;
    coveredTo = Math.max(coveredTo, to);
    if (coveredTo >= end) return true;
  }
  return start === end;
}

export function wireOperationMatches(operation, wires) {
  const expected = lineSegments(operation?.args?.line);
  const actual = new Set((Array.isArray(wires) ? wires : [])
    .filter((wire) => String(wire?.net || '') === String(operation?.args?.net || ''))
    .flatMap((wire) => lineSegments(wire.line)));
  return expected.length > 0 && expected.every((segment) => segmentCovered(segment, actual));
}

export class DesignManager {
  constructor({ bridge, approvals = null, store = null, ledger = null }) {
    this.bridge = bridge; this.approvals = approvals || new ApprovalStore({ ledger }); this.store = store; this.executions = new Map(); this.running = false; this.persistenceError = null;
    // P1-5：回滚时目标身份漂移会置写锁（不再对错误文档做 restore）；与 PCB 写锁同一语义。
    this.writeLocked = false;
    // 执行历史落盘：重启 Runtime 后仍能查到某次写入做了什么、结果如何。
    // 状态文件损坏时直接抛错，由 server 降级为内存并大声记日志（不返回假记录、不假装历史还在）。
    if (store) {
      const state = store.load();
      for (const item of Array.isArray(state?.data?.executions) ? state.data.executions : []) {
        if (item && typeof item.id === 'string') this.executions.set(item.id, item);
      }
    }
  }
  /** 把当前执行记录写入状态文件；失败只记录标志，不掩盖"板上已经发生写入"这一事实。 */
  persist() {
    if (!this.store) return;
    try {
      this.store.save({ executions: [...this.executions.values()] });
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = { code: 'EXECUTION_PERSIST_FAILED', message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
    }
  }
  /** 列表只返回摘要：完整执行对象可能很大（事件/快照摘要），按 id 再取详情。 */
  list() {
    return [...this.executions.values()]
      .map((item) => ({
        kind: 'schematic', id: item.id, state: item.state, planHash: item.planHash,
        createdAt: item.events?.[0]?.at || null,
        eventCount: item.events?.length ?? 0,
        createdPrimitiveIds: item.createdPrimitiveIds?.length ?? 0,
        error: item.error || null,
        drc: item.drc ? { passed: Boolean(item.drc.passed), findings: Array.isArray(item.drc.findings) ? item.drc.findings.length : null, strict: Boolean(item.drc.strict), regressions: Array.isArray(item.drcRegressions) ? item.drcRegressions.length : 0, exempted: Array.isArray(item.drcExempted) ? item.drcExempted.length : 0 } : null,
        projectId: item.projectId ?? null,
        documentUuid: item.documentUuid ?? null,
        writeLocked: Boolean(item.writeLocked),
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  async context() {
    const [project, document, catalog, componentData, wires, source] = await Promise.all([
      this.bridge.execute('project.current'), this.bridge.execute('document.current'), this.bridge.execute('schematic.catalog'), this.bridge.execute('schematic.components'), this.bridge.execute('schematic.wires'),
      this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }),
    ]);
    const sourceValue = unwrap(source);
    const model = { apiVersion: DESIGN_API_VERSION, windowId: this.bridge.selectedWindowId, capturedAt: new Date().toISOString(), project: unwrap(project), document: unwrap(document), catalog: unwrap(catalog), components: unwrap(componentData), wires: unwrap(wires), sourceDigest: typeof sourceValue === 'string' ? documentSourceDigest(sourceValue) : null };
    model.targetFingerprint = digest({ windowId: model.windowId, project: model.project, document: model.document, catalog: model.catalog, sourceDigest: model.sourceDigest });
    return model;
  }
  approve({ plan, targetFingerprint, windowId, steps = ['snapshot', 'write', 'save', 'readback', 'drc', 'rollback'], projectId = null, documentUuid = null }) {
    const normalized = normalizePlan(plan);
    if (!normalized.ready) throw Object.assign(new Error(`计划信息不完整: ${normalized.missing.join(', ')}`), { code: 'PLAN_INCOMPLETE', missing: normalized.missing });
    // P1-5：批准时记录工程/文档身份（可空）；执行时会用 bridge 实时读取核对，防止"批准 A 写 B"。
    const target = normalizeTargetBinding({ projectId, documentUuid });
    return {
      ...this.approvals.issue({
        planHash: normalized.planHash, targetFingerprint, windowId, steps,
        semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
        ...target,
      }),
      planHash: normalized.planHash,
      semanticPlanHash: normalized.plan.semanticPlanHash ?? null,
      compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
      ...target,
    };
  }
  cancel({ approvalToken }) { return this.approvals.revoke(approvalToken); }
  async probe(prefetched = {}) {
    const required = ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'];
    const registered = new Set(this.bridge.listCommands().map((item) => item.id));
    const missing = required.filter((id) => !registered.has(id));
    if (missing.length) return { supported: false, missing, sourceSnapshot: false, officialDrc: false, checkedAt: new Date().toISOString() };
    const source = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
    // P1-3：execute 会把"写入前基线 DRC"传进来复用，避免同一次写前重复跑两遍官方 DRC。
    const drc = prefetched && prefetched.drc !== undefined ? prefetched.drc : unwrap(await this.bridge.execute('schematic.drc'));
    return { supported: typeof source === 'string' && source.length > 0 && Array.isArray(drc), missing: [], sourceSnapshot: typeof source === 'string' && source.length > 0, officialDrc: Array.isArray(drc), drcFindingCount: Array.isArray(drc) ? drc.length : null, checkedAt: new Date().toISOString() };
  }
  /**
   * 核对批准时绑定的工程/文档身份。只在批准记录里该字段非空时执行（旧批准/未绑定则跳过）。
   * 真机身份：project.current.uuid / document.current.uuid（见 artifacts/.../design-context.json）。
   */
  async verifyApprovalTarget(binding, phase) {
    const expectedProjectId = binding?.projectId || null;
    const expectedDocumentUuid = binding?.documentUuid || null;
    if (!expectedProjectId && !expectedDocumentUuid) return null;
    const [projectRaw, documentRaw] = await Promise.all([
      expectedProjectId ? this.bridge.execute('project.current') : Promise.resolve(null),
      expectedDocumentUuid ? this.bridge.execute('document.current') : Promise.resolve(null),
    ]);
    const actualProjectId = expectedProjectId ? targetIdentity(projectRaw, PROJECT_IDENTITY_KEYS) : null;
    const actualDocumentUuid = expectedDocumentUuid ? targetIdentity(documentRaw, DOCUMENT_IDENTITY_KEYS) : null;
    const detail = {
      expected: { projectId: expectedProjectId, documentUuid: expectedDocumentUuid },
      actual: { projectId: actualProjectId, documentUuid: actualDocumentUuid },
      phase,
    };
    if ((expectedProjectId && actualProjectId !== expectedProjectId) || (expectedDocumentUuid && actualDocumentUuid !== expectedDocumentUuid)) {
      throw Object.assign(new Error(`批准绑定的目标已漂移（${phase}）：期望工程/文档 ${expectedProjectId || '—'}/${expectedDocumentUuid || '—'}，实际 ${actualProjectId || '—'}/${actualDocumentUuid || '—'}`), {
        code: 'APPROVAL_TARGET_MISMATCH', status: 409,
        // runtimeError() 会把 details 原样返回给 HTTP 调用方；phase/expected/actual 同时平铺一份，方便直接断言。
        phase, expected: detail.expected, actual: detail.actual, details: detail,
      });
    }
    return detail;
  }
  async execute({ plan, approvalToken, targetFingerprint, windowId, projectId = null, documentUuid = null, strictDrc = false }) {
    // 严格模式只认布尔 true：避免 body 里 'false' 之类字符串被当成开启严格模式。
    const strictDrcMode = strictDrc === true;
    if (this.writeLocked) throw Object.assign(new Error('上次回滚未通过目标校验，写入已锁定；请人工检查工程并重启Runtime'), { code: 'DESIGN_WRITE_LOCKED', status: 409 });
    if (this.running) throw Object.assign(new Error('已有写任务正在执行'), { code: 'EXECUTION_BUSY' });
    const normalized = normalizePlan(plan);
    if (!normalized.ready) throw Object.assign(new Error('计划信息不完整'), { code: 'PLAN_INCOMPLETE' });
    // 执行请求可显式带上目标（服务端 body 原样透传）；带上就必须与批准记录一致。
    const requestTarget = normalizeTargetBinding({ projectId, documentUuid });
    const consumed = this.approvals.consume(approvalToken, { planHash: normalized.planHash, targetFingerprint, windowId, semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null, ...requestTarget });
    const boundTarget = { projectId: consumed.projectId ?? null, documentUuid: consumed.documentUuid ?? null };
    const live = await this.context();
    // P1-5：身份漂移优先于指纹漂移报错（指纹必然随文档变化，先给更可定位的 409）。
    const startTargetCheck = await this.verifyApprovalTarget(boundTarget, 'start');
    if (live.targetFingerprint !== targetFingerprint || live.windowId !== windowId) throw Object.assign(new Error('目标窗口或文档在批准后发生变化'), { code: 'TARGET_DRIFT' });
    // P1-3：写入前先跑一次官方 DRC 作为基线；读不到数组就 fail-closed（不知道基线就不写板）。
    const baselineDrc = unwrap(await this.bridge.execute('schematic.drc'));
    if (!Array.isArray(baselineDrc)) throw Object.assign(new Error('官方原理图DRC返回结构未知，无法建立写入前基线'), { code: 'DRC_BASELINE_UNKNOWN', status: 502 });
    const capabilities = await this.probe({ drc: baselineDrc });
    if (!capabilities.supported) throw Object.assign(new Error('嘉立创EDA写入前能力探测未通过'), { code: 'EDA_CAPABILITY_PROBE_FAILED', capabilities });
    const id = crypto.randomUUID();
    const execution = {
      id, state: 'snapshotting', planHash: normalized.planHash, semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
      projectId: boundTarget.projectId, documentUuid: boundTarget.documentUuid, targetFingerprint, strictDrc: strictDrcMode, capabilities,
      drcBaseline: drcBaselineSummary(baselineDrc), drcRegressions: [], drcExempted: [], drcWarnings: [], targetChecks: startTargetCheck ? [startTargetCheck] : [], writeLocked: false,
      events: [], createdPrimitiveIds: [], createdWireIds: [], noConnectChecks: [], snapshot: null, drc: null,
    };
    this.executions.set(id, execution); this.running = true;
    const event = (stage, status, detail = {}) => execution.events.push({ at: new Date().toISOString(), stage, status, detail });
    if (startTargetCheck) event('target-check', 'passed', startTargetCheck);
    event('drc-baseline', 'passed', execution.drcBaseline);
    let mutated = false;
    try {
      const source = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
      if (typeof source !== 'string' || !source.length) throw Object.assign(new Error('无法建立非空文档源码快照'), { code: 'SNAPSHOT_EMPTY' });
      execution.snapshot = { id: crypto.randomUUID(), digest: documentSourceDigest(source), size: source.length, source };
      event('snapshot', 'passed', { id: execution.snapshot.id, digest: execution.snapshot.digest, size: execution.snapshot.size });
      execution.state = 'executing';
      const componentPrimitiveIdsByOperationIndex = new Map();
      const realizedWireOperations = [];
      for (const [operationIndex, operation] of normalized.plan.operations.entries()) {
        // P1-5：每个 write 批次（每 10 个操作）前复读工程/文档身份；目标漂移就立即停在写入边界。
        if ((boundTarget.projectId || boundTarget.documentUuid) && operationIndex % WRITE_BATCH_SIZE === 0) {
          const batchTargetCheck = await this.verifyApprovalTarget(boundTarget, `write-batch:${Math.floor(operationIndex / WRITE_BATCH_SIZE) + 1}`);
          if (batchTargetCheck) { execution.targetChecks.push(batchTargetCheck); event('target-check', 'passed', batchTargetCheck); }
        }
        const mapping = { 'component.create': 'schematic.component.create', 'pin.noConnect': 'schematic.pin.noConnect', 'netFlag.create': 'schematic.netFlag.create', 'wire.create': 'schematic.wire.create' };
        let commandArgs = operation.args;
        if (operation.type === 'net.connect') {
          const componentData = unwrap(await this.bridge.execute('schematic.components')) || {};
          const pinsByComponent = componentData.pins || {};
          const points = operation.args.endpoints.map((endpoint) => {
            const primitiveId = componentPrimitiveIdsByOperationIndex.get(endpoint.componentOperationIndex);
            const pin = (pinsByComponent[primitiveId] || []).find((item) => String(item.pinNumber ?? item.number ?? '') === String(endpoint.pinNumber));
            const x = Number(pin?.x ?? pin?.position?.x ?? pin?.getState_X?.()); const y = Number(pin?.y ?? pin?.position?.y ?? pin?.getState_Y?.());
            if (!primitiveId || !Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error(`无法解析网络${operation.args.net}的引脚${endpoint.pinNumber}`), { code: 'NET_PIN_RESOLUTION_FAILED' });
            return { x, y };
          });
          for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
            const start = points[0]; const end = points[pointIndex];
            const wireOperation = { type: 'wire.create', args: { net: operation.args.net, line: [start.x, start.y, end.x, start.y, end.x, end.y] } };
            const wireResult = unwrap(await this.bridge.execute('schematic.wire.create', wireOperation.args, { allowWrite: true }));
            mutated = true; realizedWireOperations.push(wireOperation);
            const wireId = wireResult?.primitiveId || wireResult?.id; if (wireId) { execution.createdPrimitiveIds.push(wireId); execution.createdWireIds.push(wireId); }
          }
          event(operation.type, 'passed', { net: operation.args.net, segments: points.length - 1 });
          continue;
        }
        if (operation.type === 'pin.noConnect') {
          const componentPrimitiveId = componentPrimitiveIdsByOperationIndex.get(operation.args?.componentOperationIndex);
          if (!componentPrimitiveId) throw Object.assign(new Error('未连接标识引用了无效的元件操作'), { code: 'PIN_COMPONENT_REFERENCE_INVALID' });
          commandArgs = { componentPrimitiveId, pinNumbers: operation.args.pinNumbers };
        }
        const result = unwrap(await this.bridge.execute(mapping[operation.type], commandArgs, { allowWrite: true }));
        mutated = true;
        const primitiveId = result?.primitiveId || result?.id;
        if (primitiveId) execution.createdPrimitiveIds.push(primitiveId);
        if (primitiveId && operation.type === 'component.create') componentPrimitiveIdsByOperationIndex.set(operationIndex, primitiveId);
        if (primitiveId && operation.type === 'wire.create') execution.createdWireIds.push(primitiveId);
        if (operation.type === 'pin.noConnect') {
          const expectedPins = [...operation.args.pinNumbers].map(String).sort();
          const actualPins = [...(result?.pinNumbers || [])].map(String).sort();
          if (stableStringify(expectedPins) !== stableStringify(actualPins)) throw Object.assign(new Error('未连接标识未覆盖全部批准引脚'), { code: 'PIN_NO_CONNECT_INCOMPLETE' });
          execution.noConnectChecks.push({ componentPrimitiveId: commandArgs.componentPrimitiveId, pinNumbers: expectedPins });
        }
        event(operation.type, 'passed', { primitiveId: primitiveId || null });
      }
      // save 是独立写批次：落盘前再核对一次目标身份，避免"批次之间被切走文档"。
      if (boundTarget.projectId || boundTarget.documentUuid) {
        const saveTargetCheck = await this.verifyApprovalTarget(boundTarget, 'save');
        if (saveTargetCheck) { execution.targetChecks.push(saveTargetCheck); event('target-check', 'passed', saveTargetCheck); }
      }
      const saved = unwrap(await this.bridge.execute('schematic.save', {}, { allowWrite: true }));
      if (saved !== true) throw Object.assign(new Error('嘉立创EDA未确认保存成功'), { code: 'SAVE_FAILED' });
      event('save', 'passed');
      execution.state = 'reading';
      const after = await this.context();
      const afterSource = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
      if (documentSourceDigest(afterSource) === execution.snapshot.digest) throw Object.assign(new Error('保存后设计内容未发生预期变化'), { code: 'READBACK_UNCHANGED' });
      const uniqueWireIds = [...new Set(execution.createdWireIds)];
      const wireReadback = uniqueWireIds.length ? unwrap(await this.bridge.execute('schematic.wire.read', { primitiveIds: uniqueWireIds })) : [];
      if (uniqueWireIds.length) await new Promise((resolve) => setTimeout(resolve, 800));
      const refreshedWires = uniqueWireIds.length ? unwrap(await this.bridge.execute('schematic.wires')) : [];
      const wireIdSet = new Set(uniqueWireIds);
      const absentIds = execution.createdPrimitiveIds.filter((primitiveId) => !wireIdSet.has(primitiveId) && !containsPrimitiveId(after.components, primitiveId));
      if (absentIds.length) throw Object.assign(new Error(`回读缺少新建对象: ${absentIds.join(',')}`), { code: 'READBACK_PRIMITIVE_MISSING' });
      const pinsByComponent = after.components?.pins || {};
      const missingNoConnect = execution.noConnectChecks.flatMap((check) => check.pinNumbers.filter((number) => !(pinsByComponent[check.componentPrimitiveId] || []).some((pin) => String(pin.pinNumber) === number && (pin.noConnected === true || pin.getState_NoConnected?.() === true))).map((number) => `${check.componentPrimitiveId}:${number}`));
      if (missingNoConnect.length) throw Object.assign(new Error(`回读缺少未连接标识: ${missingNoConnect.join(',')}`), { code: 'READBACK_NO_CONNECT_MISSING' });
      const wireOperations = [...normalized.plan.operations.filter((operation) => operation.type === 'wire.create'), ...realizedWireOperations];
      const missingWireOperations = wireOperations.map((operation, index) => ({ operation, index })).filter(({ operation }) => !wireOperationMatches(operation, refreshedWires)).map(({ index }) => index);
      if (missingWireOperations.length) throw Object.assign(new Error(`回读缺少导线操作: ${missingWireOperations.join(',')}`), { code: 'READBACK_WIRE_GEOMETRY_MISSING' });
      event('readback', 'passed', { targetFingerprint: after.targetFingerprint, sourceDigest: documentSourceDigest(afterSource), verifiedPrimitiveIds: execution.createdPrimitiveIds, verifiedWireIds: uniqueWireIds.filter((primitiveId) => containsPrimitiveId(wireReadback, primitiveId)), verifiedWireOperations: wireOperations.length, verifiedNoConnectPins: execution.noConnectChecks.reduce((sum, item) => sum + item.pinNumbers.length, 0) });
      execution.state = 'verifying';
      const drc = unwrap(await this.bridge.execute('schematic.drc'));
      if (!Array.isArray(drc)) throw Object.assign(new Error('官方原理图DRC返回结构未知'), { code: 'DRC_UNKNOWN_RESULT' });
      // P1-3：与写入前基线比较，只对本次新增/加重的违规负责（strictDrc 时维持零容忍）。
      const drcVerdict = schematicDrcVerdict({ baseline: baselineDrc, findings: drc, strict: strictDrcMode });
      execution.drc = { passed: drcVerdict.passed, findings: drc, strict: drcVerdict.strict, blocking: drcVerdict.blocking.length, exempted: drcVerdict.exempted.length };
      execution.drcRegressions = drcVerdict.regressions;
      execution.drcExempted = drcVerdict.exempted;
      execution.drcWarnings = drcVerdict.warnings;
      event('drc', drcVerdict.passed ? 'passed' : 'failed', {
        count: drc.length, baseline: baselineDrc.length, strict: drcVerdict.strict,
        regressions: drcVerdict.blocking.slice(0, 10), warnings: drcVerdict.warnings.slice(0, 10), exempted: drcVerdict.exempted.length,
      });
      if (!drcVerdict.passed) {
        try { await this.bridge.execute('schematic.drc.ui'); event('drc.ui', 'passed', { opened: true }); }
        catch (uiError) { event('drc.ui', 'failed', { code: uiError.code || 'DRC_UI_FAILED', message: uiError.message }); }
        throw Object.assign(new Error(drcVerdict.strict
          ? `原理图DRC严格模式发现${drc.length}项问题（基线 ${baselineDrc.length} 项，零容忍）`
          : `原理图DRC发现${drcVerdict.blocking.length}项新增/加重违规（基线 ${baselineDrc.length} 项已豁免 ${drcVerdict.exempted.length} 类）`), {
          code: 'DRC_FAILED',
          details: { mode: drcVerdict.strict ? 'strict' : 'baseline', findings: drc.length, baseline: baselineDrc.length, blocking: drcVerdict.blocking, exempted: drcVerdict.exempted.length, regressions: drcVerdict.regressions },
        });
      }
      execution.state = 'completed';
    } catch (error) {
      event('execution', 'failed', { code: error.code || 'EXECUTION_FAILED', message: error.message });
      if (mutated && execution.snapshot) {
        try {
          execution.state = 'rollback_required';
          // P1-5：restore 也是写；目标身份漂移时绝不能把旧内容写进另一份文档 → 直接锁定。
          const rollbackTargetCheck = await this.verifyApprovalTarget(boundTarget, 'rollback');
          if (rollbackTargetCheck) { execution.targetChecks.push(rollbackTargetCheck); event('target-check', 'passed', rollbackTargetCheck); }
          const restored = unwrap(await this.bridge.execute('document.source.restore', { source: execution.snapshot.source }, { allowWrite: true }));
          const saved = restored === true && unwrap(await this.bridge.execute('schematic.save', {}, { allowWrite: true })) === true;
          const restoredSource = saved ? unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true })) : '';
          if (!saved || documentSourceDigest(restoredSource) !== execution.snapshot.digest) throw Object.assign(new Error('恢复后的规范化设计摘要不匹配'), { code: 'ROLLBACK_VERIFY_FAILED' });
          execution.state = 'rolled_back'; event('rollback', 'passed', { digest: execution.snapshot.digest });
        } catch (rollbackError) {
          execution.state = 'rollback_failed'; this.writeLocked = true;
          execution.rollbackError = { code: rollbackError.code || 'ROLLBACK_FAILED', message: rollbackError.message, ...(rollbackError.details ? { details: rollbackError.details } : {}) };
          event('rollback', 'failed', { code: rollbackError.code || 'ROLLBACK_FAILED', message: rollbackError.message, ...(rollbackError.details ? { details: rollbackError.details } : {}) });
        }
      } else execution.state = 'failed';
      execution.error = { code: error.code || 'EXECUTION_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) };
    } finally { if (execution.snapshot) delete execution.snapshot.source; this.running = false; execution.writeLocked = Boolean(this.writeLocked); this.persist(); }
    return execution;
  }
  get(id) { return this.executions.get(id) || null; }
  evidence(id) { const item = this.get(id); return item ? { ...item, snapshot: item.snapshot ? { id: item.snapshot.id, digest: item.snapshot.digest, size: item.snapshot.size } : null } : null; }
}
