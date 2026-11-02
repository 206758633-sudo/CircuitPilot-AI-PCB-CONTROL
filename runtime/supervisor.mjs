/**
 * 只读 Supervisor（C 方案 MVP）。
 *
 * 定位：把现有 Runtime 里“已经发生、但需要人处理”的事实聚合成一个持久队列。
 * 它不是新的授权层，也不是自动修复器：
 *   - Source 只读现有 Store（validation-state / issue-state / agent-plan-requests）；
 *   - Router 先做确定性过滤，再把候选变成 Ticket；
 *   - Worker 是确定性规则诊断，不调用模型、不写 EDA、不签发批准；
 *   - 真正的写板仍必须走既有 planHash + 一次性批准 + 写锁 + 回读/DRC 链。
 *
 * 安全口径：
 *   - 不自动执行、不自动批准、不修改源 Store；
 *   - 对源状态“消失”不擅自收口（可能是读取失败），只对明确的 pass/resolved 收口；
 *   - 终态（done/dismissed）只在新一轮源状态变化（signalKey 变化）时重开，不反复打扰；
 *   - 状态文件损坏 fail-closed，由 server 降级为 503，不用空队列伪装“没事”。
 */
import { randomBytes } from 'node:crypto';
import { createJsonStore } from './store.mjs';

export const SUPERVISOR_CODES = Object.freeze({
  INVALID: 'SUPERVISOR_INVALID',
  STORE_UNAVAILABLE: 'SUPERVISOR_STORE_UNAVAILABLE',
  TICKET_NOT_FOUND: 'SUPERVISOR_TICKET_NOT_FOUND',
  TICKET_CLOSED: 'SUPERVISOR_TICKET_CLOSED',
  SOURCE_UNAVAILABLE: 'SUPERVISOR_SOURCE_UNAVAILABLE',
});

export const SUPERVISOR_STATUSES = Object.freeze(['open', 'acknowledged', 'blocked', 'done', 'dismissed']);
export const SUPERVISOR_ATTENTION_STATUSES = Object.freeze(['open', 'acknowledged', 'blocked']);
export const SUPERVISOR_SOURCES = Object.freeze(['validation', 'issue', 'plan']);
export const SUPERVISOR_SEVERITIES = Object.freeze(['critical', 'error', 'warning', 'info']);
export const SUPERVISOR_LIMIT = 200;
export const SUPERVISOR_TICKET_ID = /^sup_[a-f0-9]{12}$/;

const STATUS_SET = new Set(SUPERVISOR_STATUSES);
const ATTENTION_SET = new Set(SUPERVISOR_ATTENTION_STATUSES);
const SOURCE_SET = new Set(SUPERVISOR_SOURCES);
const SEVERITY_SET = new Set(SUPERVISOR_SEVERITIES);
const TERMINAL_SET = new Set(['done', 'dismissed']);
const SEVERITY_RANK = Object.freeze({ critical: 0, error: 1, warning: 2, info: 3 });

const text = (value) => String(value ?? '').trim();
const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};
const nowIso = (now) => {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('Supervisor 的 now() 必须返回合法时间'), { code: SUPERVISOR_CODES.INVALID });
  return date.toISOString();
};
const short = (value, max) => {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
};
const coded = (code, message, status = 400, details = undefined) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

function safeString(value, field, max) {
  const raw = text(value);
  if (raw.length > max) throw coded(SUPERVISOR_CODES.INVALID, `${field} 长度不能超过 ${max}`, 400, { field });
  return raw;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => ({
    kind: safeString(item?.kind, 'evidence.kind', 80) || 'unknown',
    ref: safeString(item?.ref, 'evidence.ref', 300),
    ...(item?.digest ? { digest: safeString(item.digest, 'evidence.digest', 200) } : {}),
  })).filter((item) => item.ref);
}

function normalizeSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subject = {};
  for (const field of ['projectId', 'pcbUuid', 'documentUuid', 'boardId']) {
    const raw = text(value[field]);
    if (raw) subject[field] = short(raw, 200);
  }
  return Object.keys(subject).length ? subject : null;
}

function normalizeWorker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { name: 'rule-worker', verdict: 'needs_review', steps: [] };
  return {
    name: safeString(value.name, 'worker.name', 80) || 'rule-worker',
    verdict: safeString(value.verdict, 'worker.verdict', 120) || 'needs_review',
    steps: Array.isArray(value.steps) ? value.steps.slice(0, 10).map((step) => short(step, 400)).filter(Boolean) : [],
  };
}

/** 生成 Ticket 的稳定指纹；同一源对象反复扫描不会重复建单。 */
export function supervisorFingerprint(source, key) {
  return `${source}:${short(key, 400)}`;
}

/** 从一条官方验证记录派生信号；demo/manual/running 不进入队列。 */
export function validationSignal(check) {
  if (!check || typeof check !== 'object') return null;
  // 只认官方检查：demo/种子/人工登记不能进入“需要人处理”的官方队列。
  if (check.source !== 'official') return null;
  const projectId = text(check.projectId);
  const name = text(check.name);
  if (!projectId || !name) return null;
  if (check.status !== 'fail' && check.status !== 'warn') return null;
  const findings = Array.isArray(check.findings) ? check.findings : [];
  const open = findings.filter((finding) => finding && finding.status !== 'waived');
  const digest = check.evidence?.digest ? String(check.evidence.digest) : null;
  const severity = check.status === 'fail' ? 'error' : 'warning';
  const count = Number.isFinite(Number(check.count)) ? Number(check.count) : open.length;
  const firstFindings = open.slice(0, 3).map((finding) => `${finding.rule || '规则'} ${finding.title || finding.object || ''}`.trim()).filter(Boolean);
  const sourceUpdatedAt = iso(check.updatedAt);
  const fingerprint = supervisorFingerprint('validation', `${projectId}:${name.toLowerCase()}`);
  const signalKey = `${fingerprint}:${check.status}:${sourceUpdatedAt || ''}:${count}:${open.length}`;
  return {
    fingerprint,
    signalKey,
    source: 'validation',
    severity,
    title: `官方 ${name} ${check.status === 'fail' ? '未通过' : '有告警'}`,
    summary: [
      `${check.description || name}：count=${count}，open findings=${open.length}`,
      firstFindings.length ? `代表问题：${firstFindings.join('；')}` : '',
    ].filter(Boolean).join('。'),
    projectId,
    subject: { projectId, ...(check.evidence?.pcbUuid ? { pcbUuid: String(check.evidence.pcbUuid) } : {}) },
    evidence: [{ kind: 'validation', ref: text(check.id) || `${projectId}:${name}`, ...(digest ? { digest } : {}) }],
    suggestedAction: check.status === 'fail'
      ? '打开「验证与交付」查看官方 DRC/ERC 的 open findings，修复后重跑官方检查；不要用无理由豁免收口。'
      : '打开「验证与交付」确认告警是否可解释；需要修复时先改设计再重跑，不要只改状态。',
    worker: {
      name: 'rule-worker',
      verdict: check.status === 'fail' ? 'needs_repair' : 'needs_review',
      steps: [
        '确认该记录是 official 且属于当前项目，不接受 demo/种子数据冒充。',
        '按 finding 定位到器件/网络/规则，形成最小修复方案。',
        '修复后重跑官方 ERC/DRC，并把新证据摘要与旧记录对比。',
      ],
    },
    sourceUpdatedAt,
    dueAt: null,
  };
}

/** 从问题中心记录派生信号；只处理 open/investigating，resolved/ignored 作为收口信号。 */
export function issueSignal(issue) {
  if (!issue || typeof issue !== 'object') return null;
  const id = text(issue.id);
  if (!id) return null;
  const status = text(issue.status);
  if (status !== 'open' && status !== 'investigating') return null;
  const severity = SEVERITY_SET.has(issue.severity) ? issue.severity : 'warning';
  const fingerprint = supervisorFingerprint('issue', id);
  const sourceUpdatedAt = iso(issue.lastOccurredAt);
  const signalKey = `${fingerprint}:${status}:${sourceUpdatedAt || ''}:${Number(issue.occurrences) || 0}`;
  return {
    fingerprint,
    signalKey,
    source: 'issue',
    severity,
    title: short(issue.summary, 300) || `运行问题 ${id}`,
    summary: short(issue.detail, 2000) || `问题 ${id} 仍处于 ${status}，需要人工判断。`,
    projectId: text(issue.context?.projectId) || null,
    subject: issue.context?.projectId ? { projectId: text(issue.context.projectId) } : null,
    evidence: [{ kind: 'issue', ref: id }],
    suggestedAction: text(issue.suggestedAction) || '打开「版本与问题」查看处理历史；先确认影响范围，再决定修复、降级或记录风险。',
    worker: {
      name: 'rule-worker',
      verdict: status === 'open' ? 'needs_triage' : 'in_progress',
      steps: [
        '确认问题是否仍可复现，以及是否影响当前板/当前写入门禁。',
        '保留原始错误码与证据摘要，不在没有证据时标 resolved。',
        '修复后回到同一条验证/执行记录复核，再关闭问题。',
      ],
    },
    sourceUpdatedAt,
    dueAt: null,
  };
}

/** 从计划级待审批请求派生信号；pending 才需要人，approved/rejected/consumed 作为收口信号。 */
export function planSignal(request) {
  if (!request || typeof request !== 'object') return null;
  const requestId = text(request.requestId);
  if (!requestId) return null;
  if (request.status !== 'pending') return null;
  const risks = Array.isArray(request.risks) ? request.risks.filter(Boolean) : [];
  const missing = Array.isArray(request.missing) ? request.missing.filter(Boolean) : [];
  const severity = risks.length || missing.length ? 'warning' : 'info';
  const fingerprint = supervisorFingerprint('plan', requestId);
  const epochOrDate = (value) => (typeof value === 'number' ? iso(new Date(value)) : iso(value));
  const createdAt = epochOrDate(request.createdAt);
  const expiresAt = epochOrDate(request.expiresAt);
  const signalKey = `${fingerprint}:${createdAt || ''}:${text(request.planHash)}`;
  return {
    fingerprint,
    signalKey,
    source: 'plan',
    severity,
    title: `待审批：${short(request.title, 220) || (request.kind === 'pcb' ? 'PCB 计划' : '设计计划')}`,
    summary: [
      `${request.kind === 'pcb' ? 'PCB' : '设计'}计划等待人工确认。`,
      request.planHash ? `planHash ${short(request.planHash, 20)}` : '',
      risks.length ? `风险 ${risks.length} 项` : '',
      missing.length ? `缺失 ${missing.length} 项` : '',
    ].filter(Boolean).join(' '),
    projectId: text(request.projectId) || null,
    subject: {
      ...(request.projectId ? { projectId: text(request.projectId) } : {}),
      ...(request.documentUuid ? { documentUuid: text(request.documentUuid) } : {}),
    },
    evidence: [{ kind: 'plan-request', ref: requestId, ...(request.planHash ? { digest: text(request.planHash) } : {}) }],
    suggestedAction: '打开「自动化」的计划审批队列，核对 planHash、目标指纹、风险与缺失项；UI 决策只改变请求状态，真正执行仍由既有审批链完成。',
    worker: {
      name: 'rule-worker',
      verdict: 'needs_human_approval',
      steps: [
        '确认计划绑定的项目/文档与当前 EDA 目标一致。',
        '逐条阅读 risks 与 missing；有未解释项时先补计划，不要直接批准。',
        '批准后由原 Agent 消费一次性批准并执行；Supervisor 不会代替写板。',
      ],
    },
    sourceUpdatedAt: createdAt,
    dueAt: expiresAt,
  };
}

/** 从源数组构建正/负信号；负信号用于“源已明确通过/解决”时自动收口。 */
export function buildSupervisorSignals({ validations = [], issues = [], planRequests = [] } = {}) {
  const signals = [];
  const resolved = [];
  for (const check of Array.isArray(validations) ? validations : []) {
    if (!check || typeof check !== 'object') continue;
    if (check.source !== 'official') continue;
    const projectId = text(check.projectId);
    const name = text(check.name);
    if (!projectId || !name) continue;
    const fingerprint = supervisorFingerprint('validation', `${projectId}:${name.toLowerCase()}`);
    const signal = validationSignal(check);
    if (signal) signals.push(signal);
    else if (check.status === 'pass') resolved.push({ fingerprint, note: `官方 ${name} 已通过`, sourceUpdatedAt: iso(check.updatedAt) });
  }
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || typeof issue !== 'object') continue;
    const id = text(issue.id);
    if (!id) continue;
    const fingerprint = supervisorFingerprint('issue', id);
    const signal = issueSignal(issue);
    if (signal) signals.push(signal);
    else if (issue.status === 'resolved' || issue.status === 'ignored') {
      resolved.push({ fingerprint, note: `问题已${issue.status === 'resolved' ? '解决' : '忽略'}`, sourceUpdatedAt: iso(issue.lastOccurredAt) });
    }
  }
  for (const request of Array.isArray(planRequests) ? planRequests : []) {
    if (!request || typeof request !== 'object') continue;
    const requestId = text(request.requestId);
    if (!requestId) continue;
    const fingerprint = supervisorFingerprint('plan', requestId);
    const signal = planSignal(request);
    if (signal) signals.push(signal);
    else if (request.status === 'approved' || request.status === 'rejected' || request.status === 'consumed') {
      resolved.push({ fingerprint, note: `计划请求已${request.status}`, sourceUpdatedAt: iso(request.decidedAt || request.consumedAt || request.createdAt) });
    }
  }
  return { signals, resolved };
}

function newTicketId() {
  return `sup_${randomBytes(6).toString('hex')}`;
}

function normalizeStoredTicket(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('ticket 不是对象');
  const ticketId = text(row.ticketId);
  if (!SUPERVISOR_TICKET_ID.test(ticketId)) throw new Error(`ticketId 非法：${ticketId}`);
  const source = text(row.source);
  if (!SOURCE_SET.has(source)) throw new Error(`source 非法：${source}`);
  const status = text(row.status);
  if (!STATUS_SET.has(status)) throw new Error(`status 非法：${status}`);
  const severity = text(row.severity);
  if (!SEVERITY_SET.has(severity)) throw new Error(`severity 非法：${severity}`);
  const fingerprint = safeString(row.fingerprint, 'fingerprint', 500);
  if (!fingerprint) throw new Error('fingerprint 为空');
  const createdAt = iso(row.createdAt);
  const updatedAt = iso(row.updatedAt);
  const lastSeenAt = iso(row.lastSeenAt);
  if (!createdAt || !updatedAt || !lastSeenAt) throw new Error('ticket 时间字段非法');
  return {
    ticketId,
    fingerprint,
    signalKey: safeString(row.signalKey, 'signalKey', 800),
    source,
    severity,
    status,
    title: safeString(row.title, 'title', 300),
    summary: safeString(row.summary, 'summary', 2000),
    projectId: text(row.projectId) || null,
    subject: normalizeSubject(row.subject),
    evidence: normalizeEvidence(row.evidence),
    suggestedAction: safeString(row.suggestedAction, 'suggestedAction', 1000),
    worker: normalizeWorker(row.worker),
    createdAt,
    updatedAt,
    lastSeenAt,
    sourceUpdatedAt: iso(row.sourceUpdatedAt),
    dueAt: iso(row.dueAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    closedAt: iso(row.closedAt),
    note: safeString(row.note, 'note', 1000),
    occurrences: Number.isSafeInteger(row.occurrences) && row.occurrences > 0 ? row.occurrences : 1,
  };
}

/** 公开视图：字段白名单，不把内部 signalKey 暴露给 UI。 */
export function supervisorTicketView(ticket) {
  if (!ticket) return null;
  return {
    ticketId: ticket.ticketId,
    fingerprint: ticket.fingerprint,
    source: ticket.source,
    severity: ticket.severity,
    status: ticket.status,
    title: ticket.title,
    summary: ticket.summary,
    projectId: ticket.projectId,
    subject: ticket.subject,
    evidence: ticket.evidence.map((item) => ({ ...item })),
    suggestedAction: ticket.suggestedAction,
    worker: { ...ticket.worker, steps: [...ticket.worker.steps] },
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    lastSeenAt: ticket.lastSeenAt,
    sourceUpdatedAt: ticket.sourceUpdatedAt,
    dueAt: ticket.dueAt,
    acknowledgedAt: ticket.acknowledgedAt,
    closedAt: ticket.closedAt,
    note: ticket.note,
    occurrences: ticket.occurrences,
  };
}

function summaryOf(tickets) {
  const byStatus = Object.fromEntries(SUPERVISOR_STATUSES.map((status) => [status, 0]));
  const bySeverity = Object.fromEntries(SUPERVISOR_SEVERITIES.map((severity) => [severity, 0]));
  const bySource = Object.fromEntries(SUPERVISOR_SOURCES.map((source) => [source, 0]));
  for (const ticket of tickets) {
    byStatus[ticket.status] += 1;
    bySeverity[ticket.severity] += 1;
    bySource[ticket.source] += 1;
  }
  return {
    total: tickets.length,
    attention: tickets.filter((ticket) => ATTENTION_SET.has(ticket.status)).length,
    byStatus,
    bySeverity,
    bySource,
  };
}

function sortTickets(tickets) {
  return [...tickets].sort((left, right) => (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.ticketId.localeCompare(left.ticketId)
  ));
}

/**
 * 创建只读 Supervisor。
 * @param {object} options
 * @param {string|null} options.file 状态文件；null = 仅内存（测试）
 * @param {() => Date|string|number} [options.now]
 * @param {number} [options.maxTickets]
 */
export function createSupervisor({ file = null, now = () => new Date(), maxTickets = SUPERVISOR_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxTickets) || maxTickets < 1) throw coded(SUPERVISOR_CODES.INVALID, 'maxTickets 必须是正整数');
  const store = file ? createJsonStore({ file, schemaVersion: 1, initial: () => ({ tickets: [] }), now }) : null;
  const records = new Map();

  const load = () => {
    if (!store) return;
    const loaded = store.load();
    const rows = Array.isArray(loaded.data?.tickets) ? loaded.data.tickets : [];
    if (rows.length > maxTickets * 10) throw coded(SUPERVISOR_CODES.STORE_UNAVAILABLE, 'Supervisor 状态文件记录数异常', 503);
    for (const row of rows) {
      const ticket = normalizeStoredTicket(row);
      if (records.has(ticket.ticketId)) throw coded(SUPERVISOR_CODES.STORE_UNAVAILABLE, `Supervisor 状态文件重复 ticketId：${ticket.ticketId}`, 503);
      records.set(ticket.ticketId, ticket);
    }
  };

  const persist = () => {
    if (!store) return;
    // 不按 Map 顺序截断：截断可能把仍在等待人的 open ticket 挤掉。容量控制只删终态记录。
    store.save({ tickets: [...records.values()] });
  };

  try {
    load();
  } catch (error) {
    if (error?.code === SUPERVISOR_CODES.STORE_UNAVAILABLE) throw error;
    throw coded(SUPERVISOR_CODES.STORE_UNAVAILABLE, `Supervisor 状态文件损坏（fail-closed）：${error?.message || error}`, 503);
  }

  const snapshot = () => {
    const tickets = sortTickets([...records.values()]);
    return {
      generatedAt: nowIso(now),
      summary: summaryOf(tickets),
      tickets: tickets.map(supervisorTicketView),
    };
  };

  const applySignal = (signal, timestamp) => {
    let ticket = [...records.values()].find((item) => item.fingerprint === signal.fingerprint);
    if (!ticket) {
      ticket = {
        ticketId: newTicketId(),
        fingerprint: signal.fingerprint,
        signalKey: signal.signalKey,
        source: signal.source,
        severity: signal.severity,
        status: 'open',
        title: signal.title,
        summary: signal.summary,
        projectId: signal.projectId || null,
        subject: normalizeSubject(signal.subject),
        evidence: normalizeEvidence(signal.evidence),
        suggestedAction: signal.suggestedAction || '',
        worker: normalizeWorker(signal.worker),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
        sourceUpdatedAt: signal.sourceUpdatedAt || null,
        dueAt: signal.dueAt || null,
        acknowledgedAt: null,
        closedAt: null,
        note: '',
        occurrences: 1,
      };
      records.set(ticket.ticketId, ticket);
      return true;
    }
    if (TERMINAL_SET.has(ticket.status) && ticket.signalKey === signal.signalKey) {
      // done 只表示“人认为已处理”，不能让仍然存在的失败源从注意力里消失。
      // 下一次扫描若源信号还在，就自动重开并留下说明；dismissed 是显式忽略，保持终态直到源变化。
      if (ticket.status === 'done') {
        ticket.status = 'open';
        ticket.closedAt = null;
        ticket.acknowledgedAt = null;
        ticket.updatedAt = timestamp;
        ticket.lastSeenAt = timestamp;
        ticket.note = '源仍显示未通过/未解决，已自动重新打开；标记解决不会隐藏证据。';
        return true;
      }
      ticket.lastSeenAt = timestamp;
      return false;
    }
    const reopened = TERMINAL_SET.has(ticket.status) && ticket.signalKey !== signal.signalKey;
    const signalChanged = ticket.signalKey !== signal.signalKey
      || ticket.severity !== signal.severity
      || ticket.title !== signal.title
      || ticket.summary !== signal.summary
      || JSON.stringify(ticket.evidence) !== JSON.stringify(normalizeEvidence(signal.evidence));
    const next = {
      ...ticket,
      signalKey: signal.signalKey,
      severity: signal.severity,
      title: signal.title,
      summary: signal.summary,
      projectId: signal.projectId || null,
      subject: normalizeSubject(signal.subject),
      evidence: normalizeEvidence(signal.evidence),
      suggestedAction: signal.suggestedAction || '',
      worker: normalizeWorker(signal.worker) || ticket.worker,
      // lastSeenAt 每次巡检都刷新；updatedAt 只在源信号实质变化时更新，避免 UI 每 30s 显示“刚更新”。
      updatedAt: signalChanged || reopened ? timestamp : ticket.updatedAt,
      lastSeenAt: timestamp,
      sourceUpdatedAt: signal.sourceUpdatedAt || null,
      dueAt: signal.dueAt || null,
      status: reopened ? 'open' : ticket.status,
      acknowledgedAt: reopened ? null : ticket.acknowledgedAt,
      closedAt: reopened ? null : ticket.closedAt,
      note: reopened ? '' : ticket.note,
      occurrences: ticket.occurrences + (ticket.signalKey === signal.signalKey ? 0 : 1),
    };
    Object.assign(ticket, next);
    return reopened || signalChanged;
  };

  const closeFromSource = (resolved, timestamp) => {
    let changed = false;
    for (const item of resolved) {
      const ticket = [...records.values()].find((candidate) => candidate.fingerprint === item.fingerprint);
      if (!ticket || TERMINAL_SET.has(ticket.status)) continue;
      ticket.status = 'done';
      ticket.closedAt = timestamp;
      ticket.updatedAt = timestamp;
      ticket.lastSeenAt = timestamp;
      ticket.note = item.note || '源状态已通过，自动收口';
      ticket.sourceUpdatedAt = item.sourceUpdatedAt || ticket.sourceUpdatedAt;
      changed = true;
    }
    return changed;
  };

  return {
    /**
     * 只读扫描源状态，生成/更新/收口 Ticket。
     * 源读取失败必须由调用方抛错；这里不把“读不到”当成“没有信号”。
     */
    scan({ validations = [], issues = [], planRequests = [] } = {}) {
      const { signals, resolved } = buildSupervisorSignals({ validations, issues, planRequests });
      const timestamp = nowIso(now);
      let changed = false;
      for (const signal of signals) changed = applySignal(signal, timestamp) || changed;
      changed = closeFromSource(resolved, timestamp) || changed;
      if (records.size > maxTickets) {
        const removable = [...records.values()]
          .filter((ticket) => TERMINAL_SET.has(ticket.status))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
        for (const ticket of removable) {
          if (records.size <= maxTickets) break;
          records.delete(ticket.ticketId);
          changed = true;
        }
      }
      if (changed) persist();
      return snapshot();
    },

    attention() {
      return snapshot();
    },

    get(ticketId) {
      const ticket = records.get(text(ticketId));
      if (!ticket) throw coded(SUPERVISOR_CODES.TICKET_NOT_FOUND, 'Supervisor Ticket 不存在', 404);
      return supervisorTicketView(ticket);
    },

    ack(ticketId, { note = '' } = {}) {
      const ticket = records.get(text(ticketId));
      if (!ticket) throw coded(SUPERVISOR_CODES.TICKET_NOT_FOUND, 'Supervisor Ticket 不存在', 404);
      if (TERMINAL_SET.has(ticket.status)) throw coded(SUPERVISOR_CODES.TICKET_CLOSED, 'Supervisor Ticket 已关闭，不能重复处理', 409);
      const timestamp = nowIso(now);
      ticket.status = 'acknowledged';
      ticket.acknowledgedAt = timestamp;
      ticket.updatedAt = timestamp;
      ticket.note = safeString(note, 'note', 1000);
      persist();
      return supervisorTicketView(ticket);
    },

    close(ticketId, { status, note = '' } = {}) {
      const ticket = records.get(text(ticketId));
      if (!ticket) throw coded(SUPERVISOR_CODES.TICKET_NOT_FOUND, 'Supervisor Ticket 不存在', 404);
      if (TERMINAL_SET.has(ticket.status)) throw coded(SUPERVISOR_CODES.TICKET_CLOSED, 'Supervisor Ticket 已关闭，不能重复处理', 409);
      if (status !== 'done' && status !== 'dismissed') throw coded(SUPERVISOR_CODES.INVALID, 'close 只接受 done 或 dismissed', 400);
      const timestamp = nowIso(now);
      ticket.status = status;
      ticket.closedAt = timestamp;
      ticket.updatedAt = timestamp;
      ticket.note = safeString(note, 'note', 1000);
      persist();
      return supervisorTicketView(ticket);
    },

    dismiss(ticketId, options = {}) {
      return this.close(ticketId, { ...options, status: 'dismissed' });
    },

    resolve(ticketId, options = {}) {
      return this.close(ticketId, { ...options, status: 'done' });
    },

    snapshot,
  };
}
