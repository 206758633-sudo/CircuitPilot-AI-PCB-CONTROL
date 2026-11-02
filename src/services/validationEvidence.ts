import type { Finding, IssueRecord, ValidationCheck } from '../types';

/**
 * P0-3：验证结果的"官方投影"——真实 ERC/DRC 结论的唯一落点。
 *
 * 修复前：真实 ERC/DRC 只写组件内 state；写全局 state.validations 的只有 demoAdapter（source:'demo'），
 * 而 seed 预置了 3 pass/3 warn/2 idle，首次打开就显示 75% 覆盖率；阶段证据 `drcPassed` 也永远
 * 读不到 official。结果：概览"已验证"是假的、问题中心收不到 DRC 条目、"验证→生产"必被阻断。
 *
 * 现在：官方记录必须带 `source:'official'` + `projectId` + 证据 digest；KPI / 阶段门禁只认这一份。
 * 种子与 Demo 记录保留在列表里用于走查，但**不计入真实覆盖**。
 */

export const OFFICIAL_VALIDATION_ENGINES = ['ERC', 'DRC'] as const;
export type OfficialValidationEngine = typeof OFFICIAL_VALIDATION_ENGINES[number];

/**
 * P1-1（复审 2026-10-29）：官方 ERC/DRC 取证前的工程身份判定（纯函数，便于测试）。
 *
 * 修复前验证页信任自己的窗口状态：在项目 A 页面可以对项目 B 的 EDA 窗口取证，
 * 结论却写进当前项目（证据串项目，阶段门禁跟着错）。
 * fail-closed：`no-binding`（项目没绑工程）与 `unknown`（读不到当前工程）都算"不能取证"，
 * 只有两边都读到且相等才是 `ok`。
 */
export type EdaWorkspaceIdentity =
  | { ok: true; projectUuid: string }
  | { ok: false; reason: 'no-binding' | 'unknown' | 'mismatch'; boundProjectUuid: string | null; currentProjectUuid: string | null };

/**
 * 从 EDA `project.current` 的命令结果里读工程 UUID。
 *
 * 真机 2026-11-02 实测：Runtime 的 `/api/eda/commands/project.current` 返回的是
 * `{ command: { result: { success: true, result: { data: [Board...] } } } }`，
 * 工程 UUID 在 Board 的 `parentProjectUuid`；旧代码只认顶层 `uuid/id/data[0].uuid`，
 * 于是把"已绑定且当前就是同一工程"误判成 unknown，官方 DRC 被 fail-closed 阻断。
 * 这里按"显式 projectUuid → parentProjectUuid → 旧版 uuid/id"降级读取，不猜板 UUID。
 */
export function edaProjectUuidFromCommandResult(input: unknown): string | null {
  const seen = new Set<object>();
  const read = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const walk = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const explicit = read(record.projectUuid) || read(record.parentProjectUuid);
    if (explicit) return explicit;
    if (Array.isArray(record.data)) {
      for (const item of record.data) {
        if (!item || typeof item !== 'object') continue;
        const board = item as Record<string, unknown>;
        const parent = read(board.parentProjectUuid);
        if (parent) return parent;
      }
      // 旧版命令结果可能把工程 UUID 放在 data[0].uuid（不是 Board 的 uuid）。
      for (const item of record.data) {
        if (!item || typeof item !== 'object') continue;
        const legacy = read((item as Record<string, unknown>).uuid);
        if (legacy) return legacy;
      }
    }
    // 旧版桥把 `{uuid:'P1'}` 或 `{id:'P1'}` 直接作为 result；仅在没有 data/result/command 时采用，
    // 且排除命令名本身（`project.current`）以免把字符串 id 当工程 UUID。
    if (!('data' in record) && !('result' in record) && !('command' in record)) {
      const legacy = read(record.uuid) || read(record.id);
      if (legacy && !legacy.includes('.')) return legacy;
    }
    for (const key of ['result', 'command']) {
      if (key in record) {
        const found = walk(record[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(input, 0);
}

export function edaWorkspaceIdentity(boundProjectUuid: string | null | undefined, currentProjectUuid: string | null | undefined): EdaWorkspaceIdentity {
  const bound = typeof boundProjectUuid === 'string' && boundProjectUuid.trim() ? boundProjectUuid.trim() : null;
  const current = typeof currentProjectUuid === 'string' && currentProjectUuid.trim() ? currentProjectUuid.trim() : null;
  if (!bound) return { ok: false, reason: 'no-binding', boundProjectUuid: null, currentProjectUuid: current };
  if (!current) return { ok: false, reason: 'unknown', boundProjectUuid: bound, currentProjectUuid: null };
  if (bound !== current) return { ok: false, reason: 'mismatch', boundProjectUuid: bound, currentProjectUuid: current };
  return { ok: true, projectUuid: bound };
}

/** 只取"当前项目 + 官方来源"的验证记录；没有 projectId 的一律不认。 */
export function officialValidationsForProject(validations: ValidationCheck[], projectId: string | null | undefined): ValidationCheck[] {
  if (!projectId) return [];
  return validations.filter((item) => item.source === 'official' && item.projectId === projectId);
}

/** 官方记录按 `projectId + name` upsert；同名的旧种子/演示行会被官方结论替换（保留其 id 以稳定选中态）。 */
export function mergeValidationRecord(validations: ValidationCheck[], record: ValidationCheck): ValidationCheck[] {
  const index = validations.findIndex((item) => item.name === record.name
    && (item.projectId === record.projectId || (!item.projectId && item.source !== 'official')));
  if (index < 0) return [...validations, record];
  const next = [...validations];
  next[index] = { ...next[index], ...record, id: next[index].id };
  return next;
}

export interface ValidationKpis {
  /** 当前项目的官方记录。 */
  official: ValidationCheck[];
  /** 已真实运行过的官方检查数 / 应有检查数（ERC、DRC）。 */
  ran: number;
  total: number;
  coverage: number;
  passed: number;
  failedOrWarn: number;
  openFindings: number;
  /** 还没跑过的官方检查（给 UI 提示"未运行"而不是"通过"）。 */
  missing: OfficialValidationEngine[];
  /** 仅用于展示"还有多少演示/种子记录未计入"；绝不进入覆盖率。 */
  demoOrSeed: number;
}

export function validationKpis(validations: ValidationCheck[], projectId: string | null | undefined): ValidationKpis {
  const official = officialValidationsForProject(validations, projectId);
  const findByEngine = (engine: OfficialValidationEngine) => official.find((item) => item.name === engine) ?? null;
  const required = OFFICIAL_VALIDATION_ENGINES.map((engine) => ({ engine, record: findByEngine(engine) }));
  const ranRecords = required.filter((entry) => entry.record && entry.record.status !== 'idle');
  const demoOrSeed = validations.filter((item) => item.source !== 'official').length;
  return {
    official,
    ran: ranRecords.length,
    total: required.length,
    coverage: Math.round((ranRecords.length / required.length) * 100),
    passed: official.filter((item) => item.status === 'pass').length,
    failedOrWarn: official.filter((item) => item.status === 'warn' || item.status === 'fail').length,
    openFindings: official.reduce((sum, item) => sum + item.findings.filter((finding) => finding.status === 'open').length, 0),
    missing: required.filter((entry) => !entry.record).map((entry) => entry.engine),
    demoOrSeed,
  };
}

/** 构造一条官方验证记录（调用方负责给出 EDA 原生报告里的真实状态/条目）。 */
export function buildOfficialValidationRecord(input: {
  engine: OfficialValidationEngine;
  projectId: string;
  description: string;
  status: ValidationCheck['status'];
  count: number;
  findings: Finding[];
  evidence: NonNullable<ValidationCheck['evidence']>;
  updatedAt?: string;
}): ValidationCheck {
  return {
    id: `official-${input.engine.toLowerCase()}-${input.projectId}`,
    name: input.engine,
    description: input.description,
    status: input.status,
    count: input.count,
    findings: input.findings,
    source: 'official',
    projectId: input.projectId,
    updatedAt: input.updatedAt || new Date().toISOString(),
    evidence: input.evidence,
  };
}

/** 把 ERC 报告（`ErcReport.findings`）转成问题中心统一的 Finding。 */
export function ercFindingsToValidationFindings(findings: Array<{ id?: string; severity?: string; code?: string; title?: string; object?: string; detail?: string; suggestion?: string }>): Finding[] {
  return findings.slice(0, 50).map((finding, index) => ({
    id: `erc-${finding.id || finding.code || index}`,
    title: finding.title || finding.detail || finding.code || 'ERC 问题',
    object: finding.object || '—',
    rule: finding.code || 'ERC',
    severity: finding.severity === 'fatal' || finding.severity === 'error' ? 'error' : 'warning',
    suggestion: finding.suggestion || '按 ERC 规则修正或登记豁免理由后重新运行。',
    status: 'open',
  }));
}

/** 把 DRC 原生报告条目转成 Finding（EDA 的 DRC 条目字段不完全固定，做容错取字段）。 */
export function drcItemsToValidationFindings(items: Array<Record<string, unknown>>): Finding[] {
  return items.slice(0, 50).map((item, index) => {
    const errorType = typeof item.errorType === 'string' && item.errorType ? item.errorType : null;
    const message = typeof item.message === 'string' && item.message ? item.message : null;
    const signature = typeof item.signature === 'string' && item.signature ? item.signature : null;
    const instanceKey = typeof item.instanceKey === 'string' && item.instanceKey ? item.instanceKey : null;
    const objects = Array.isArray(item.objects) ? item.objects.map((entry) => (entry && typeof entry === 'object' && 'type' in entry ? String((entry as { type?: unknown }).type ?? '') : '')).filter(Boolean) : [];
    return {
      id: `drc-${errorType || 'item'}-${index}`,
      title: message || errorType || 'DRC 违规',
      object: instanceKey || signature || objects.join(', ') || '—',
      rule: errorType || 'DRC',
      severity: 'error' as const,
      suggestion: '在嘉立创EDA 修正该违规，或按规则登记豁免理由后重新运行 DRC。',
      status: 'open' as const,
    };
  });
}

/**
 * UI 复审 2026-10-29 新发现：验证页“运行全部检查（Demo）”修复前把 `state.validations`
 * 整体交给 Demo 适配器，再用 `source:'demo'` 覆盖回全局 state —— 已有官方 ERC/DRC 记录
 * 会被一并改成 demo，等于用模拟动作反向抹掉真实证据（P0-3 刚建立的口径被破坏）。
 * 这里只允许模拟结果覆盖非官方行，官方行原样保留。
 */
export function mergeDemoValidationRun(validations: ValidationCheck[], simulated: ValidationCheck[]): ValidationCheck[] {
  const official = validations.filter((item) => item.source === 'official');
  const officialIds = new Set(official.map((item) => item.id));
  const demo = simulated
    .filter((item) => !officialIds.has(item.id))
    .map((item) => ({ ...item, source: 'demo' as const }));
  return [...official, ...demo];
}


/**
 * 源修复自动收口（2026-11-02 真机闭环发现）：
 * 官方检查通过后，同一 checkId 下仍 open 的旧问题必须自动 resolved，
 * 否则问题中心/值守队列会永远停在旧 DRC 工单（验证记录已经 pass，问题却还 open）。
 *
 * 安全边界：只在 official + pass + count===0 + 有 projectId 时收口；
 * 只收 context.checkId 与当前记录完全一致的同项目问题，绝不按标题/严重度模糊匹配。
 */
export function autoResolvableOfficialIssueIds(issues: readonly IssueRecord[], record: ValidationCheck): string[] {
  if (record.source !== 'official' || record.status !== 'pass' || record.count !== 0 || !record.projectId) return [];
  return issues
    .filter((issue) => issue.status === 'open'
      && issue.source === 'validation'
      && issue.context?.checkId === record.id
      && issue.context?.projectId === record.projectId)
    .map((issue) => issue.id);
}
