import { createHash } from 'node:crypto';
import { redactSecrets } from '../log-redaction.mjs';

/**
 * RLA：复盘学习 Agent（Retrospective Learning Agent，W5-01）。
 *
 * 定位：把"项目做完之后才知道的事"变成**可检索、可审核、可失效**的知识候选，
 * 交给已有的 KMA（知识库管理 Agent）/ 知识加工管道 / 人工审核去整理，而不是自己发合格证。
 *
 * ## 为什么单独一个 agent
 *
 * 现有知识入口只覆盖两类"已经结构化"的来源：
 *   - KMA badcase：从门禁证据里捞 blocked/unknown 的失败（缺"为什么、怎么预防"）；
 *   - 网页采集：通用知识（缺"这块板真的踩过"的一手证据）。
 * 项目复盘是第三类：**一手项目事实 + 人的经验判断**。如果直接让 AI 写进知识库，
 * 就会把"以为的原因"当结论；所以这里只做三件事：
 *   1) 只读采集项目事实（交付/门禁/缺陷/变更），归一化成缺陷清单；
 *   2) 把事实映射成候选条目（failure / rule / module，含项目复盘 module）；
 *   3) 落一份 `retrospective` 证据 + 写 candidate 知识；**绝不 approved、绝不改设计**。
 *
 * ## 红线（与 KMA 一致，不可绕过）
 *
 *   - 没有事实也没有人工经验 → 直接失败（`RETRO_NO_EVIDENCE`），不生成"空复盘"；
 *   - 没根因的缺陷标 `needsInvestigation=true`，不编造 rootCause；
 *   - 候选 payload 内**不含时间戳/运行计数**，保证同内容重复运行幂等（store fingerprint 去重）；
 *   - 只读：不写 EDA、不改设计、不调用网络；证据与知识写入失败一律结构化报错。
 */

export const RETRO_AGENT_ID = 'retrospective-learner';
export const RETRO_AGENT_VERSION = '1.0.0';

export const RETRO_CODES = Object.freeze({
  STORE_INVALID: 'RETRO_STORE_INVALID',
  INPUT_INVALID: 'RETRO_INPUT_INVALID',
  NO_EVIDENCE: 'RETRO_NO_EVIDENCE',
  LESSON_INVALID: 'RETRO_LESSON_INVALID',
  EVIDENCE_WRITE_FAILED: 'RETRO_EVIDENCE_WRITE_FAILED',
  KNOWLEDGE_WRITE_FAILED: 'RETRO_KNOWLEDGE_WRITE_FAILED',
});

/** 复盘会读的证据类型白名单（真实项目事实来源；其它类型不参与缺陷归并）。 */
export const RETRO_EVIDENCE_KINDS = Object.freeze([
  'rules', 'drc-report', 'dfm-evidence', 'netlist-diff', 'placement', 'field-issue', 'gate-report', 'fabrication-release',
]);

export const RETRO_LESSON_KINDS = Object.freeze(['failure', 'rule', 'module']);
const ERROR_SEVERITIES = new Set(['error', 'blocking', 'fatal']);

const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const uniqSorted = (values) => [...new Set(values.filter(Boolean))].sort();
const dateIso = (now) => now().toISOString();

/** 项目标识 → 稳定 slug（candidate id 前缀；保证同项目多次复盘落在同一 entityKey 家族）。 */
export function projectKeyOf({ projectId = null, boardId = null, pcbUuid = null } = {}) {
  const candidates = [text(projectId), text(boardId), text(pcbUuid)];
  const raw = candidates.find(Boolean) ?? 'unspecified';
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'unspecified';
}

/** 缺陷码/标题 → 可读 id 片段（保留大小写语义，去掉分隔符）。 */
const idPart = (value, max = 48) => {
  const cleaned = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'X').slice(0, max);
};

/**
 * 从证据记录里归并缺陷事实。
 * 判定：verdict=blocked/unknown 且带 findings（error 级）才算缺陷；warning 只计数不生成 failure。
 */
export function extractDefects({ evidence = [] } = {}) {
  if (!Array.isArray(evidence)) throw coded(RETRO_CODES.INPUT_INVALID, 'evidence 必须是数组');
  const groups = new Map();
  const warnings = { count: 0 };
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = text(entry.kind);
    if (!kind || !RETRO_EVIDENCE_KINDS.includes(kind)) continue;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const verdict = String(payload.verdict ?? '').toLowerCase();
    const findings = Array.isArray(payload.findings) ? payload.findings.filter((item) => item && typeof item === 'object') : [];
    const digest = text(entry.digest);
    const blocked = verdict === 'blocked' || verdict === 'unknown';
    if (!blocked) {
      for (const finding of findings) if (String(finding.severity ?? '').toLowerCase() === 'warning') warnings.count += 1;
      continue;
    }
    if (!findings.length) {
      const reason = text(payload.reason) ?? text(payload.message) ?? `${kind} 证据 ${verdict}`;
      const code = `${idPart(kind, 24).replace(/-/g, '_')}_${verdict.toUpperCase()}`;
      const group = groups.get(code) ?? { code, severity: 'error', messages: [], kinds: [], digests: [], digestList: [] };
      group.messages.push(reason);
      group.kinds.push(kind);
      if (digest) group.digests.push(digest);
      groups.set(code, group);
      continue;
    }
    for (const finding of findings) {
      const severity = String(finding.severity ?? '').toLowerCase();
      if (severity === 'warning' || severity === 'info') { warnings.count += 1; continue; }
      const rawCode = text(finding.code) ?? `${idPart(kind, 24).replace(/-/g, '_')}_UNKNOWN`;
      const message = text(finding.message) ?? text(finding.summary) ?? `命中 ${rawCode}`;
      const group = groups.get(rawCode) ?? { code: rawCode, severity: 'error', messages: [], kinds: [], digests: [], digestList: [] };
      group.messages.push(message);
      group.kinds.push(kind);
      if (digest) group.digests.push(digest);
      groups.set(rawCode, group);
    }
  }
  const defects = [...groups.values()]
    .map((group) => ({
      code: group.code,
      severity: 'error',
      message: group.messages[0],
      evidenceKinds: uniqSorted(group.kinds),
      evidenceDigests: uniqSorted(group.digests),
      occurrences: group.messages.length,
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
  return { defects, warningCount: warnings.count };
}

/** 归一化人工/AI 注入的经验（只做字段校验与裁剪，不替用户补原因）。 */
export function normalizeLessons({ lessons = [] } = {}) {
  if (!Array.isArray(lessons)) throw coded(RETRO_CODES.INPUT_INVALID, 'lessons 必须是数组');
  const problems = [];
  const normalized = [];
  const list = (value) => (Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []);
  for (const [index, lesson] of lessons.entries()) {
    const label = `lessons[${index}]`;
    if (!lesson || typeof lesson !== 'object') { problems.push({ index, code: 'LESSON_INVALID', message: `${label} 必须是对象` }); continue; }
    const kind = text(lesson.kind);
    const title = text(lesson.title);
    if (!kind || !RETRO_LESSON_KINDS.includes(kind)) { problems.push({ index, code: 'LESSON_KIND_INVALID', message: `${label}.kind 只能是 failure/rule/module` }); continue; }
    if (!title) { problems.push({ index, code: 'LESSON_TITLE_MISSING', message: `${label}.title 不能为空` }); continue; }
    const item = {
      kind, title,
      // origin=ai 的条目一律按 unverified 入库：模型写的"经验"在人工审核前不可当参考依据。
      origin: ['ai', 'human'].includes(String(lesson.origin ?? '').toLowerCase()) ? String(lesson.origin).toLowerCase() : 'human',
      category: text(lesson.category) ?? (kind === 'failure' ? '复盘缺陷' : kind === 'rule' ? '复盘规则' : '复盘模块'),
      severity: ['error', 'warning', 'info'].includes(String(lesson.severity ?? '').toLowerCase()) ? String(lesson.severity).toLowerCase() : null,
      refs: list(lesson.refs),
      evidenceRefs: list(lesson.evidenceRefs),
    };
    if (kind === 'failure') {
      if (!text(lesson.symptom)) { problems.push({ index, code: 'LESSON_SYMPTOM_MISSING', message: `${label}.symptom 不能为空（失败模式必须有可观察症状）` }); continue; }
      item.symptom = text(lesson.symptom);
      item.rootCause = text(lesson.rootCause);
      item.detection = text(lesson.detection);
      item.prevention = list(lesson.prevention);
    } else if (kind === 'rule') {
      const limits = list(lesson.limits);
      if (!text(lesson.statement)) { problems.push({ index, code: 'LESSON_STATEMENT_MISSING', message: `${label}.statement 不能为空（规则必须可判定）` }); continue; }
      if (!limits.length) { problems.push({ index, code: 'LESSON_LIMITS_MISSING', message: `${label}.limits 至少 1 条数值边界（否则只能当 failure 或 module 沉淀）` }); continue; }
      item.statement = text(lesson.statement);
      item.limits = limits;
      item.rationale = text(lesson.rationale);
      item.check = text(lesson.check);
      item.appliesTo = list(lesson.appliesTo);
    } else {
      const designPoints = list(lesson.designPoints);
      if (!text(lesson.purpose)) { problems.push({ index, code: 'LESSON_PURPOSE_MISSING', message: `${label}.purpose 不能为空（模块必须说清目的）` }); continue; }
      if (!designPoints.length) { problems.push({ index, code: 'LESSON_DESIGNPOINTS_MISSING', message: `${label}.designPoints 至少 1 条可落地做法` }); continue; }
      item.purpose = text(lesson.purpose);
      item.whenToUse = text(lesson.whenToUse);
      item.designPoints = designPoints;
      item.keyParameters = list(lesson.keyParameters);
      item.pitfalls = list(lesson.pitfalls);
    }
    normalized.push(item);
  }
  return { lessons: normalized, problems };
}

/** 汇总一次复盘的事实（release/gates/changes/notes 都可缺省；缺省就不虚构）。 */
export function collectRetroFacts({ projectId = null, boardId = null, pcbUuid = null, projectName = null, evidence = [], release = null, gates = null, changes = [], notes = null, docRefs = [] } = {}) {
  if (!Array.isArray(evidence)) throw coded(RETRO_CODES.INPUT_INVALID, 'evidence 必须是数组');
  const { defects, warningCount } = extractDefects({ evidence });
  const evidenceDigests = uniqSorted(evidence.map((entry) => text(entry?.digest)));
  const changeList = Array.isArray(changes)
    ? changes.map((change) => text(change?.summary) ?? text(change?.ref) ?? text(change)).filter(Boolean).slice(0, 40)
    : [];
  const hasRelease = Boolean(release && typeof release === 'object');
  const hasGates = Boolean(gates && typeof gates === 'object');
  return {
    projectId: text(projectId),
    boardId: text(boardId),
    pcbUuid: text(pcbUuid),
    projectName: text(projectName),
    evidenceKinds: uniqSorted(evidence.map((entry) => text(entry?.kind))),
    evidenceDigests,
    defects,
    warningCount,
    release: hasRelease ? {
      releaseId: text(release.releaseId),
      gateVerdict: text(release.gateVerdict ?? release.gate?.verdict),
      decision: text(release.decision ?? release.releaseDecision?.decision),
      manifestHash: text(release.manifestHash ?? release.binding?.manifestHash),
    } : null,
    gates: hasGates ? {
      verdict: text(gates.verdict),
      gates: Array.isArray(gates.gates) ? gates.gates.map((gate) => ({ id: text(gate?.id), verdict: text(gate?.verdict) })).filter((gate) => gate.id) : [],
      blockingFailures: Number.isFinite(Number(gates.blockingFailures)) ? Number(gates.blockingFailures) : null,
    } : null,
    changes: changeList,
    notes: text(notes),
    docRefs: uniqSorted((Array.isArray(docRefs) ? docRefs : []).map((item) => text(item))),
  };
}

/** 事实 + 经验 → 知识候选（纯函数；payload 内不含时间，保证幂等）。 */
export function deriveRetroCandidates({ facts, lessons = [] } = {}) {
  if (!facts || typeof facts !== 'object') throw coded(RETRO_CODES.INPUT_INVALID, 'deriveRetroCandidates 需要 facts');
  const key = projectKeyOf(facts);
  const candidates = [];
  const evidenceRefs = facts.evidenceDigests ?? [];
  const projectLabel = facts.projectName ?? facts.projectId ?? facts.boardId ?? facts.pcbUuid ?? '未命名项目';

  if (facts.defects?.length || facts.release || facts.gates || facts.changes?.length) {
    const pitfalls = (facts.defects ?? []).map((defect) => `${defect.code}：${defect.message}`).slice(0, 20);
    const designPoints = [
      facts.release ? `放行：${facts.release.releaseId ?? 'release'} · gate=${facts.release.gateVerdict ?? 'unknown'}${facts.release.manifestHash ? ` · manifest=${facts.release.manifestHash.slice(0, 12)}…` : ''}` : null,
      facts.gates ? `门禁：verdict=${facts.gates.verdict ?? 'unknown'} · 阻断项=${facts.gates.blockingFailures ?? '—'}` : null,
      facts.changes.length ? `收尾变更：${facts.changes.join('；')}` : null,
      facts.defects.length ? `缺陷：${facts.defects.map((defect) => defect.code).slice(0, 12).join('、')}` : null,
      facts.notes,
    ].filter(Boolean);
    candidates.push({
      kind: 'module',
      title: `项目复盘：${projectLabel}（缺陷 ${facts.defects.length} · 变更 ${facts.changes.length}）`,
      trust: 'reference',
      payload: {
        moduleId: `RETRO-${key}-PROJECT`,
        projectKey: key,
        category: '项目复盘',
        purpose: `沉淀 ${projectLabel} 的交付结论、缺陷与收尾变更，供同类项目复用前先读；只作候选，需人工审核。`,
        whenToUse: '同类板/同类电源与接口架构复用前；新项目做风险清单时作为一手案例。',
        designPoints: designPoints.length ? designPoints : ['本轮复盘未采集到结构化事实，仅登记复盘动作'],
        keyParameters: [`证据类型=${(facts.evidenceKinds ?? []).join(',') || '无'}`, `缺陷=${facts.defects.length}`, `警告=${facts.warningCount}`, `变更=${facts.changes.length}`],
        pitfalls,
        refs: facts.docRefs ?? [],
        evidenceRefs,
        source: 'retrospective',
      },
    });
  }

  for (const defect of facts.defects ?? []) {
    const failureId = `RETRO-${key}-${idPart(defect.code)}`;
    candidates.push({
      kind: 'failure',
      title: `复盘缺陷：${defect.code}（${projectLabel}）`,
      trust: 'reference',
      payload: {
        failureId,
        projectKey: key,
        code: defect.code,
        category: '复盘缺陷',
        severity: 'error',
        symptom: defect.message,
        rootCause: null,
        detection: `复盘扫描证据（${defect.evidenceKinds.join('、')}）命中 ${defect.code}`,
        prevention: [],
        occurrences: defect.occurrences,
        refs: facts.docRefs ?? [],
        evidenceRefs: defect.evidenceDigests.length ? defect.evidenceDigests : evidenceRefs,
        needsInvestigation: true,
        source: 'retrospective',
      },
    });
  }

  const ruleLessons = lessons.filter((lesson) => lesson.kind === 'rule');
  const moduleLessons = lessons.filter((lesson) => lesson.kind === 'module');
  for (const lesson of lessons.filter((item) => item.kind === 'failure')) {
    candidates.push({
      kind: 'failure',
      title: lesson.title,
      trust: lesson.origin === 'ai' ? 'unverified' : 'reference',
      payload: {
        failureId: `RETRO-${key}-${idPart(lesson.title)}`,
        projectKey: key,
        lessonOrigin: lesson.origin,
        category: lesson.category,
        severity: lesson.severity ?? 'error',
        symptom: lesson.symptom,
        rootCause: lesson.rootCause,
        detection: lesson.detection,
        prevention: lesson.prevention,
        refs: lesson.refs,
        evidenceRefs: lesson.evidenceRefs.length ? lesson.evidenceRefs : evidenceRefs,
        needsInvestigation: !lesson.rootCause,
        source: 'retrospective',
      },
    });
  }
  for (const [index, lesson] of ruleLessons.entries()) {
    candidates.push({
      kind: 'rule',
      title: lesson.title,
      trust: lesson.origin === 'ai' ? 'unverified' : 'reference',
      payload: {
        ruleId: `RETRO-${key}-R${String(index + 1).padStart(2, '0')}`,
        projectKey: key,
        lessonOrigin: lesson.origin,
        category: lesson.category,
        severity: lesson.severity ?? 'warning',
        statement: lesson.statement,
        limits: lesson.limits,
        rationale: lesson.rationale,
        check: lesson.check,
        appliesTo: lesson.appliesTo,
        refs: lesson.refs,
        evidenceRefs: lesson.evidenceRefs.length ? lesson.evidenceRefs : evidenceRefs,
        source: 'retrospective',
      },
    });
  }
  for (const [index, lesson] of moduleLessons.entries()) {
    candidates.push({
      kind: 'module',
      title: lesson.title,
      trust: lesson.origin === 'ai' ? 'unverified' : 'reference',
      payload: {
        moduleId: `RETRO-${key}-M${String(index + 1).padStart(2, '0')}`,
        projectKey: key,
        lessonOrigin: lesson.origin,
        category: lesson.category,
        purpose: lesson.purpose,
        whenToUse: lesson.whenToUse,
        designPoints: lesson.designPoints,
        keyParameters: lesson.keyParameters,
        pitfalls: lesson.pitfalls,
        refs: lesson.refs,
        evidenceRefs: lesson.evidenceRefs.length ? lesson.evidenceRefs : evidenceRefs,
        source: 'retrospective',
      },
    });
  }
  return candidates;
}

/** 大模型起草经验的输出 schema（只作为提示词约束；模型输出仍要过 normalizeLessons 校验）。 */
export const RETRO_LESSON_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        required: ['kind', 'title'],
        properties: {
          kind: { type: 'string', enum: ['failure', 'rule', 'module'] },
          title: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          symptom: { type: 'string' }, rootCause: { type: 'string' }, detection: { type: 'string' },
          prevention: { type: 'array', items: { type: 'string' } },
          statement: { type: 'string' }, limits: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' }, check: { type: 'string' }, appliesTo: { type: 'array', items: { type: 'string' } },
          purpose: { type: 'string' }, whenToUse: { type: 'string' },
          designPoints: { type: 'array', items: { type: 'string' } },
          keyParameters: { type: 'array', items: { type: 'string' } },
          pitfalls: { type: 'array', items: { type: 'string' } },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** 起草经验时给模型的系统角色（与 buildLessonDraftPrompt 配套）。 */
export const RETRO_LESSON_DRAFT_INSTRUCTIONS = '你是资深 PCB/电源设计评审工程师，负责把已发生的项目事实整理成可复核的复盘经验；你不掌握 EDA，也不得虚构事实；输出必须严格符合给定 JSON schema。';

/** 起草经验的提示词：模型只能"整理已发生的事实"，不得新增数值/器件/结论。 */
export function buildLessonDraftPrompt({ facts, maxLessons = 6 } = {}) {
  if (!facts || typeof facts !== 'object') throw coded(RETRO_CODES.INPUT_INVALID, '起草经验需要复盘事实');
  const view = {
    project: { projectId: facts.projectId, boardId: facts.boardId, pcbUuid: facts.pcbUuid, projectName: facts.projectName },
    evidenceKinds: facts.evidenceKinds,
    evidenceDigests: facts.evidenceDigests,
    defects: facts.defects,
    warningCount: facts.warningCount,
    release: facts.release,
    gates: facts.gates,
    changes: facts.changes,
    notes: facts.notes,
    docRefs: facts.docRefs,
  };
  return [
    `请基于下面这份"已发生的项目事实"起草 1~${maxLessons} 条**可复核**的复盘经验，供人工审核后沉淀到知识库。`,
    '硬要求：',
    '1) 只能引用事实里出现过的缺陷码/数值/器件/网络名，不得补写未出现的数字或 datasheet 结论；',
    '2) failure 必须有可观察 symptom；rootCause 不确定时留空并在 title 标注"待调研"，不得编造；',
    '3) rule 必须给 limits（至少 1 条带单位的数值边界）与 check（怎么复核）；',
    '4) module 必须给 purpose 与 designPoints（至少 1 条可落地做法）；',
    '5) evidenceRefs 只能从 facts.evidenceDigests 里挑选，没有证据支撑的经验不要写；',
    '6) 这批事实来自内部项目证据（D 级），不得声称是标准/原厂结论；',
    '7) 只输出 JSON（符合给定 schema），不要 Markdown。',
    '',
    'facts：',
    JSON.stringify(view, null, 2),
  ].join('\n');
}

/**
 * 跨项目合并：把各项目复盘产生的同缺陷码 failure 聚合成一条"跨项目缺陷"候选。
 *
 * 为什么需要：单项目 failureId 带项目前缀，同类问题在第二个项目出现时不会自动关联，
 * 人要在审核队列里翻很多条才能发现"这是复发性问题"。合并只做聚合与提示，
 * 仍写 candidate、仍不编造根因（rootCause 恒为 null，needsInvestigation=true）。
 */
export function mergeRetroDefects({ store, now = () => new Date(), minProjects = 2 } = {}) {
  if (!store || typeof store.list !== 'function') throw coded(RETRO_CODES.STORE_INVALID, '跨项目合并需要知识库 store');
  const entries = store.list({ includeExpired: true });
  const groups = new Map();
  for (const entry of entries) {
    if (entry?.kind !== 'failure') continue;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    if (payload.source !== 'retrospective') continue;
    const code = text(payload.code);
    const projectKey = text(payload.projectKey);
    if (!code || !projectKey) continue;
    const group = groups.get(code) ?? { code, projects: new Set(), symptoms: [], digests: [], occurrences: 0 };
    group.projects.add(projectKey);
    const symptom = text(payload.symptom);
    if (symptom) group.symptoms.push(symptom);
    for (const digest of Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []) if (text(digest)) group.digests.push(digest);
    group.occurrences += Number.isFinite(Number(payload.occurrences)) ? Number(payload.occurrences) : 1;
    groups.set(code, group);
  }
  const merged = [];
  for (const code of [...groups.keys()].sort()) {
    const group = groups.get(code);
    const projects = [...group.projects].sort();
    if (projects.length < Math.max(2, Number(minProjects) || 2)) continue;
    const failureId = `RETRO-CODE-${idPart(code)}`;
    const payload = {
      failureId,
      code,
      category: '跨项目缺陷',
      severity: 'error',
      symptom: group.symptoms[0] ?? `多个项目命中 ${code}`,
      rootCause: null,
      detection: '跨项目复盘合并（按缺陷码聚合）',
      prevention: [],
      occurrences: group.occurrences,
      projectKeys: projects,
      evidenceRefs: uniqSorted(group.digests),
      needsInvestigation: true,
      source: 'retrospective-merge',
    };
    const saved = store.save({
      kind: 'failure',
      title: `跨项目缺陷：${code}（${projects.length} 个项目）`,
      payload,
      provenance: { source: 'retrospective-merge', version: RETRO_AGENT_VERSION, fetchedAt: dateIso(now), collector: RETRO_AGENT_ID },
      trust: 'reference',
      ttlDays: 365,
      reviewState: 'candidate',
    });
    merged.push({ entityKey: failureId, code, projects, occurrences: group.occurrences, id: saved.entry.id, created: saved.created !== false });
  }
  return {
    ok: true,
    scanned: entries.length,
    minProjects: Math.max(2, Number(minProjects) || 2),
    groups: merged.length,
    created: merged.filter((item) => item.created).length,
    duplicates: merged.filter((item) => !item.created).length,
    candidates: merged,
    generatedAt: dateIso(now),
  };
}

/** 证据摘要（不含运行计数，便于对照；候选写入结果单列在 run 结果里）。 */
function buildEvidencePayload({ facts, lessons, candidates, savedAt }) {
  return {
    schemaVersion: 1,
    verdict: 'advisory',
    agent: RETRO_AGENT_ID,
    agentVersion: RETRO_AGENT_VERSION,
    project: {
      projectId: facts.projectId, boardId: facts.boardId, pcbUuid: facts.pcbUuid, projectName: facts.projectName,
      key: projectKeyOf(facts),
    },
    facts: {
      evidenceKinds: facts.evidenceKinds,
      evidenceDigests: facts.evidenceDigests,
      defects: facts.defects,
      warningCount: facts.warningCount,
      release: facts.release,
      gates: facts.gates,
      changes: facts.changes,
      notes: facts.notes,
      docRefs: facts.docRefs,
    },
    lessons: lessons.map((lesson) => ({ kind: lesson.kind, title: lesson.title, hasRootCause: lesson.kind === 'failure' ? Boolean(lesson.rootCause) : null })),
    candidates: candidates.map((candidate) => ({ kind: candidate.kind, title: candidate.title, entityKey: candidate.payload.moduleId ?? candidate.payload.ruleId ?? candidate.payload.failureId ?? null })),
    ranAt: savedAt,
  };
}

/**
 * 创建 RLA。
 * @param {{ store: object, evidenceStore?: object|null, now?: () => Date }} options
 */
export const EXPERIENCE_BUNDLE_SCHEMA_VERSION = 1;

const sha256Text = (value) => createHash('sha256').update(String(value)).digest('hex');
/** 键排序后再序列化：同一内容永远得到同一个 bundleSha256。 */
const canonicalJson = (value) => JSON.stringify(value, (_, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item
));

/**
 * 生成"经验包"：给用户导出、人工提交（GitHub Issue/邮件）用，**不自动上传**。
 *
 * 默认脱敏策略（宁可少收，不可多收）：
 *   - 项目名/板号/PCB UUID 不原样出现：默认只给 sha256 前 12 位（同一用户多次提交仍可关联，外部无法反推）；
 *   - 缺陷 message 默认丢弃（可能含网络名/位号），只保留缺陷码与出现次数；
 *   - 路径、邮箱、密钥形态统一走 `redactSecrets`；
 *   - 经验正文（lessons）是用户自己写的内容，默认保留，但同样过脱敏；
 *   - 证据只带 digest 与类型，不带 payload（不泄漏工程内容）。
 * 包里带 bundleSha256，提交后维护者可校验内容未被改动。
 */
export function buildExperienceBundle({
  facts, lessons = [], appVersion = null, runtimeVersion = null,
  includeProjectName = false, includeMessages = false, includeLessons = true,
  note = null, now = () => new Date(),
} = {}) {
  if (!facts || typeof facts !== 'object') throw coded(RETRO_CODES.INPUT_INVALID, '经验包需要复盘事实');
  const key = projectKeyOf(facts);
  const project = {
    projectKeyHash: sha256Text(`project\u0000${key}`).slice(0, 12),
    projectName: includeProjectName && facts.projectName ? redactSecrets(facts.projectName) : null,
    boardIdHash: facts.boardId ? sha256Text(`board\u0000${facts.boardId}`).slice(0, 12) : null,
    pcbUuidHash: facts.pcbUuid ? sha256Text(`pcb\u0000${facts.pcbUuid}`).slice(0, 12) : null,
  };
  const bundle = {
    schemaVersion: EXPERIENCE_BUNDLE_SCHEMA_VERSION,
    kind: 'circuitpilot-experience-bundle',
    createdAt: dateIso(now),
    app: { appVersion: appVersion ?? null, runtimeVersion: runtimeVersion ?? null, agent: RETRO_AGENT_ID, agentVersion: RETRO_AGENT_VERSION },
    project,
    facts: {
      evidenceKinds: facts.evidenceKinds,
      evidenceDigests: facts.evidenceDigests,
      defects: facts.defects.map((defect) => ({
        code: defect.code,
        severity: defect.severity,
        occurrences: defect.occurrences,
        evidenceKinds: defect.evidenceKinds,
        message: includeMessages ? redactSecrets(defect.message) : null,
      })),
      warningCount: facts.warningCount,
      changes: includeMessages ? (facts.changes ?? []).map((item) => redactSecrets(item)) : [],
      release: facts.release ? { gateVerdict: facts.release.gateVerdict, decision: facts.release.decision } : null,
      gates: facts.gates ? { verdict: facts.gates.verdict, blockingFailures: facts.gates.blockingFailures } : null,
      notes: includeMessages ? redactSecrets(facts.notes) : null,
    },
    lessons: includeLessons ? lessons.map((lesson) => redactSecrets(lesson, { maxStringLength: 4_000 })) : [],
    userNote: redactSecrets(note),
    redaction: {
      ids: 'sha256-12',
      messages: includeMessages ? 'redacted' : 'omitted',
      projectName: includeProjectName ? 'included' : 'omitted',
      pathsAndSecrets: 'redactSecrets',
    },
  };
  return { ...bundle, bundleSha256: sha256Text(canonicalJson(bundle)), bytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8') };
}

/** 给 UI 的经验包预览（不含正文字段，避免把长文本塞进前端状态）。 */
export function experienceBundlePreview(bundle) {
  return {
    kind: bundle.kind, schemaVersion: bundle.schemaVersion, createdAt: bundle.createdAt,
    bundleSha256: bundle.bundleSha256, bytes: bundle.bytes,
    projectKeyHash: bundle.project?.projectKeyHash ?? null,
    defects: bundle.facts?.defects?.length ?? 0,
    lessons: bundle.lessons?.length ?? 0,
    redaction: bundle.redaction,
  };
}

export function createRetrospectiveLearner({ store, evidenceStore = null, now = () => new Date() } = {}) {
  if (!store || typeof store.save !== 'function') throw coded(RETRO_CODES.STORE_INVALID, '复盘学习 Agent 需要知识库 store');
  let lastRun = null;
  let totalRuns = 0;
  let totalCreated = 0;

  const run = ({
    projectId = null, boardId = null, pcbUuid = null, projectName = null,
    evidence = [], release = null, gates = null, changes = [], lessons = [], notes = null, docRefs = [], saveEvidence = true,
  } = {}) => {
    const startedAt = dateIso(now);
    const facts = collectRetroFacts({ projectId, boardId, pcbUuid, projectName, evidence, release, gates, changes, notes, docRefs });
    const normalized = normalizeLessons({ lessons });
    if (normalized.problems.length) {
      throw coded(RETRO_CODES.LESSON_INVALID, `复盘经验有 ${normalized.problems.length} 处不合法，未写入任何条目`, normalized.problems);
    }
    const hasFacts = facts.defects.length > 0 || Boolean(facts.release) || Boolean(facts.gates) || facts.changes.length > 0 || Boolean(facts.notes);
    if (!hasFacts && !normalized.lessons.length) {
      throw coded(RETRO_CODES.NO_EVIDENCE, '没有可复盘的事实或人工经验：请先提供证据/交付结论/经验，不生成空复盘');
    }
    const candidates = deriveRetroCandidates({ facts, lessons: normalized.lessons });
    if (!candidates.length) throw coded(RETRO_CODES.NO_EVIDENCE, '事实不足以生成任何知识候选（如只有 warning），不写空证据');

    const fetchedAt = dateIso(now);
    const savedAt = fetchedAt;
    const results = [];
    const errors = [];
    for (const candidate of candidates) {
      try {
        const saved = store.save({
          kind: candidate.kind,
          title: candidate.title,
          payload: candidate.payload,
          provenance: {
            source: 'retrospective',
            version: RETRO_AGENT_VERSION,
            fetchedAt,
            collector: RETRO_AGENT_ID,
            ...(facts.docRefs[0] ? { url: facts.docRefs[0] } : {}),
          },
          trust: candidate.trust === 'unverified' ? 'unverified' : 'reference',
          ttlDays: 365,
          reviewState: 'candidate',
        });
        // store.save 返回的 entry 不带派生的 entityKey（只有 list/annotate 才带），这里按 kind 从 payload 取。
        const entityKey = candidate.payload.moduleId ?? candidate.payload.ruleId ?? candidate.payload.failureId ?? null;
        results.push({ kind: candidate.kind, title: candidate.title, id: saved.entry.id, entityKey, created: saved.created !== false });
      } catch (error) {
        errors.push({ kind: candidate.kind, title: candidate.title, code: error?.code ?? RETRO_CODES.KNOWLEDGE_WRITE_FAILED, message: String(error?.message || error).slice(0, 200) });
      }
    }
    if (!results.length) throw coded(RETRO_CODES.KNOWLEDGE_WRITE_FAILED, '所有知识候选都写入失败', errors);

    let evidencePath = null;
    if (saveEvidence && evidenceStore && typeof evidenceStore.save === 'function') {
      try {
        const entry = evidenceStore.save({
          kind: 'retrospective',
          payload: buildEvidencePayload({ facts, lessons: normalized.lessons, candidates, savedAt }),
          fingerprint: {
            projectId: facts.projectId, boardId: facts.boardId, pcbUuid: facts.pcbUuid,
            ...(facts.evidenceDigests[0] ? { digest: facts.evidenceDigests[0] } : {}),
          },
          note: 'RLA 项目复盘：事实 → 知识候选（只写 candidate）',
        });
        evidencePath = entry.path;
      } catch (error) {
        throw coded(RETRO_CODES.EVIDENCE_WRITE_FAILED, `复盘证据写入失败：${String(error?.message || error).slice(0, 200)}`);
      }
    }

    const created = results.filter((result) => result.created).length;
    const duplicates = results.length - created;
    totalRuns += 1;
    totalCreated += created;
    const summary = {
      agent: RETRO_AGENT_ID,
      version: RETRO_AGENT_VERSION,
      ok: errors.length === 0,
      projectId: facts.projectId, boardId: facts.boardId, pcbUuid: facts.pcbUuid,
      startedAt, finishedAt: dateIso(now),
      facts: {
        evidenceKinds: facts.evidenceKinds,
        defects: facts.defects.length,
        warnings: facts.warningCount,
        changes: facts.changes.length,
        hasRelease: Boolean(facts.release),
        hasGates: Boolean(facts.gates),
      },
      lessons: { accepted: normalized.lessons.length, byKind: { failure: normalized.lessons.filter((item) => item.kind === 'failure').length, rule: normalized.lessons.filter((item) => item.kind === 'rule').length, module: normalized.lessons.filter((item) => item.kind === 'module').length } },
      candidates: results,
      errors,
      summary: { total: results.length, created, duplicates },
      evidencePath,
    };
    lastRun = { at: summary.finishedAt, projectId: summary.projectId, ok: summary.ok, created, duplicates, defects: summary.facts.defects, lessons: normalized.lessons.length, code: null };
    return summary;
  };

  const recordFailure = (error) => {
    lastRun = { at: dateIso(now), projectId: error?.details?.projectId ?? null, ok: false, created: 0, duplicates: 0, defects: 0, lessons: 0, code: error?.code ?? 'RETRO_FAILED' };
    return error;
  };

  /** 跨项目合并（供路由/人工整理调用；只写 candidate）。 */
  const merge = (options = {}) => mergeRetroDefects({ store, now, ...options });

  const status = () => ({
    agent: RETRO_AGENT_ID,
    version: RETRO_AGENT_VERSION,
    readOnly: false,
    writes: ['knowledge:candidate', 'evidence:retrospective'],
    never: ['knowledge:approved', 'eda:write', 'design:write'],
    lastRun,
    totals: { runs: totalRuns, created: totalCreated },
    evidenceKinds: RETRO_EVIDENCE_KINDS,
    lessonKinds: RETRO_LESSON_KINDS,
    merge: { minProjects: 2, rule: '按 payload.code 聚合，仅 ≥2 个项目才生成跨项目缺陷候选' },
  });

  /** 包装：失败也记录状态（HTTP 路由据此给 status 面板，不抛到进程）。 */
  const runSafely = (input = {}) => {
    try { return { ok: true, run: run(input) }; }
    catch (error) { recordFailure(error); return { ok: false, code: error?.code ?? 'RETRO_FAILED', message: String(error?.message || error), details: error?.details ?? null, run: null }; }
  };

  /** 指纹去重用的 canonical 摘要（测试/UI 只读；不参与存储）。 */
  const fingerprintOfInput = (input = {}) => createHash('sha256').update(JSON.stringify({ facts: collectRetroFacts(input), lessons: normalizeLessons({ lessons: input.lessons ?? [] }).lessons })).digest('hex');

  return { run, runSafely, status, merge, fingerprintOfInput };
}
