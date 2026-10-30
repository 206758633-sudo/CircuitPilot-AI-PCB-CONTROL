import { useCallback, useEffect, useState } from 'react';
import { Bot, KeyRound, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type { AgentAuditEvent, AgentPendingApproval, AgentPlanRequest, AgentTokenStatus, ApprovalLedgerEntry, ApprovalLedgerSnapshot, AuditIntegrity, Tone } from '../types';
import { Badge, Button, Panel, Stat, TableFrame } from './ui';
import { ConfirmDialog } from './overlays';

/** 面板只展示最近 8 条；服务端保留完整审计（limit 由 Runtime 截断并回报 total）。 */
const AUDIT_LIMIT = 8;
/** 批准账本同样只展示最近 8 条（账本按时间追加，展示时倒序）。 */
const LEDGER_LIMIT = 8;

/** approvalId / planHash 等只显示前缀，避免长串撑破单元格；不涉及秘密。 */
const shortId = (value: unknown, length = 12) => {
  if (typeof value !== 'string' || !value) return '—';
  return value.length > length ? `${value.slice(0, length)}…` : value;
};
const ledgerActionTone = (action?: string): Tone => {
  const value = (action || '').toLowerCase();
  if (value === 'signed' || value === 'consumed') return 'success';
  if (value === 'issued') return 'neutral';
  if (value === 'rejected' || value === 'replayed' || value === 'mismatch') return 'danger';
  if (value === 'revoked' || value === 'expired') return 'warning';
  return 'neutral';
};
const ledgerBinding = (entry: ApprovalLedgerEntry, key: string) => {
  const value = entry.bindings?.[key];
  return typeof value === 'string' && value ? value : null;
};

/**
 * 审计链完整性徽标（task-26）：旧 Runtime 没有该字段时返回 null —— 整个徽标/统计都不渲染，
 * 不能把"未校验"显示成"完整"。
 */
const integrityView = (integrity: AuditIntegrity | null): { label: string; tone: Tone } | null => {
  if (!integrity) return null;
  switch (integrity.chain) {
    case 'ok':
    case 'empty': return { label: '审计链完整', tone: 'success' };
    case 'legacy': return { label: '含旧格式', tone: 'warning' };
    case 'broken': return { label: '审计链异常', tone: 'danger' };
    default: return { label: '审计链未校验', tone: 'neutral' };
  }
};
/** legacy 字段服务端可能给布尔或行数：两种都如实显示，不猜。 */
const legacyLabel = (legacy: AuditIntegrity['legacy']) => (typeof legacy === 'number' ? `${legacy} 行旧格式` : legacy ? '含旧格式' : '无旧格式');
/** verified 同理：布尔显示"是/否"，数字显示已验证行数。 */
const verifiedLabel = (verified: AuditIntegrity['verified']) => (typeof verified === 'number' ? `${verified} 行` : verified ? '是' : '否');

const formatTime = (value?: string | number | null) => {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
};

/** outcome → 徽标语气：显式拒绝（denied/401/403）和故障（failed/timeout）必须一眼分开。 */
const outcomeTone = (outcome?: string): Tone => {
  const value = (outcome || '').toLowerCase();
  if (!value) return 'neutral';
  if (['ok', 'success', 'allowed', 'completed', 'pass'].includes(value)) return 'success';
  if (['denied', 'blocked', 'rejected', 'forbidden', '401', '403'].some((token) => value.includes(token))) return 'danger';
  if (['error', 'failed', 'fail', 'timeout', 'skipped'].some((token) => value.includes(token))) return 'warning';
  return 'neutral';
};
const outcomeLabel = (outcome?: string) => (!outcome ? '—' : outcome === 'ok' ? '成功' : outcome);

/**
 * 令牌状态口径：available=false 时区分"缺失"与"损坏"——
 * 缺失可以重启生成，损坏必须先移走旧文件（Runtime 不会静默降级放行）。
 */
const tokenState = (agent: AgentTokenStatus | null): { label: string; tone: Tone; hint: string } => {
  if (!agent) return { label: '未读取', tone: 'neutral', hint: '尚未从 Runtime 读取令牌状态' };
  if (agent.available) return { label: '可用', tone: 'success', hint: `作用域 ${agent.scopes.join(' / ') || '未声明'}` };
  const reason = agent.reason || '';
  const lowered = reason.toLowerCase();
  if (lowered.includes('invalid') || reason.includes('损坏') || reason.includes('权限')) return { label: '损坏', tone: 'danger', hint: reason || '令牌文件非法或权限过宽' };
  if (lowered.includes('missing') || lowered.includes('enoent') || reason.includes('不存在')) return { label: '缺失', tone: 'warning', hint: reason || '令牌文件不存在' };
  return { label: '不可用', tone: 'warning', hint: reason || 'Runtime 未给出可用令牌' };
};

const describeError = (error: unknown): { code: string; status: number; message: string } => {
  if (error instanceof RuntimeApiError) return { code: error.code, status: error.status, message: error.message };
  return { code: 'CLIENT_ERROR', status: 0, message: error instanceof Error ? error.message : '未知错误' };
};
/** 旧 Runtime 没有 /api/agent/* 路由 → 404；401 是会话鉴权失败，不能伪装成"版本不支持"。 */
const isMissingRoute = (error: unknown) => error instanceof RuntimeApiError && error.status === 404;

/**
 * 插件审批 deep link：`?agent=approvals` / `?agent=ledger` / `?agent=access`。
 * 只返回本面板内的锚点 id；不认识的 query 不滚动，也不改变路由。
 */
export const agentDeepLinkSection = (search: string): string | null => {
  const value = new URLSearchParams(search).get('agent');
  if (value === 'plans') return 'agent-plan-requests';
  if (value === 'approvals') return 'agent-approvals';
  if (value === 'ledger') return 'agent-ledger';
  if (value === 'access') return 'agent-access';
  return null;
};

/**
 * 设置页「Agent 接入」控制台（MVP）：只读展示令牌元数据 + 最近调用审计，并提供轮换入口。
 *
 * 安全边界（与 docs/agent/agent-contract.md §1 对齐）：
 * - 永不渲染令牌原文，也不提供"复制令牌"；
 * - 轮换必须二次确认，成功文案明确"旧令牌立即失效、插件下次请求自动读取新令牌"；
 * - 不提供签核/下单等业务操作，本面板只做接入与审计可见性；
 * - Runtime 不可达/旧版本（404/401）降级为说明文案，不白屏、不假装"无令牌"。
 */
export function AgentAccessPanel() {
  const { state, notify, addAudit } = useApp();
  const [agent, setAgent] = useState<AgentTokenStatus | null>(null);
  const [events, setEvents] = useState<AgentAuditEvent[]>([]);
  const [auditMeta, setAuditMeta] = useState<{ total: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateNotice, setRotateNotice] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<AuditIntegrity | null>(null);
  const [ledger, setLedger] = useState<ApprovalLedgerSnapshot | null>(null);
  const [ledgerUnsupported, setLedgerUnsupported] = useState(false);
  const [approvals, setApprovals] = useState<AgentPendingApproval[]>([]);
  const [approvalsUnsupported, setApprovalsUnsupported] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentPendingApproval | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [planRequests, setPlanRequests] = useState<AgentPlanRequest[]>([]);
  const [planRequestsUnsupported, setPlanRequestsUnsupported] = useState(false);
  const [planRequestsError, setPlanRequestsError] = useState<string | null>(null);
  const [planDecisionTarget, setPlanDecisionTarget] = useState<{ request: AgentPlanRequest; decision: 'approve' | 'reject' } | null>(null);
  const [planDeciding, setPlanDeciding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLedger(null);
    setLedgerUnsupported(false);
    setApprovals([]);
    setApprovalsUnsupported(false);
    setApprovalsError(null);
    setPlanRequests([]);
    setPlanRequestsUnsupported(false);
    setPlanRequestsError(null);
    try {
      // Runtime 契约里 auditIntegrity/integrity 是 task-26 新增字段；runtimeClient 的返回类型尚未收窄，
      // 这里按契约断言（旧 Runtime 缺字段 → undefined → 面板降级"不显示"）。
      const payload = await runtimeClient.agentStatus() as { agent: AgentTokenStatus; audit: AgentAuditEvent[]; auditIntegrity?: AuditIntegrity };
      setAgent(payload.agent);
      setUnsupported(false);
      // 审计单独按 limit=8 取（/api/agent/status 里的 audit 可能更长）；审计失败不拖垮整块状态。
      const audit = await runtimeClient.agentAudit(AUDIT_LIMIT).catch(() => null) as { events: AgentAuditEvent[]; total: number; truncated?: boolean; integrity?: AuditIntegrity } | null;
      // 优先用 audit 响应的 integrity（更贴近列表），没有再回退 status.auditIntegrity。
      setIntegrity(audit?.integrity ?? payload.auditIntegrity ?? null);
      if (audit) {
        setEvents((audit.events ?? []).slice(0, AUDIT_LIMIT));
        setAuditMeta({ total: audit.total, truncated: Boolean(audit.truncated) });
      } else {
        setEvents((payload.audit ?? []).slice(0, AUDIT_LIMIT));
        setAuditMeta(null);
      }
      // 批准账本是独立的只读端点：旧 Runtime 404 时只隐藏该区块，不影响令牌/审计主流程。
      await runtimeClient.approvalLedger().then((view) => setLedger(view)).catch((caughtLedger) => {
        if (isMissingRoute(caughtLedger)) setLedgerUnsupported(true);
      });
      // 待执行批准同样是独立只读端点；旧 Runtime 404 时只隐藏该区块。
      await runtimeClient.agentApprovals().then((payload) => setApprovals(payload.approvals ?? [])).catch((caughtApprovals) => {
        if (isMissingRoute(caughtApprovals)) setApprovalsUnsupported(true);
      });
      // 计划级审查队列：只显示 pending/approved；旧 Runtime 404 时隐藏该区块。
      await runtimeClient.agentPlanRequests('all', 100).then((payload) => {
        const visible = (payload.requests ?? []).filter((item) => item.status === 'pending' || item.status === 'approved');
        setPlanRequests(visible);
      }).catch((caughtPlanRequests) => {
        if (isMissingRoute(caughtPlanRequests)) setPlanRequestsUnsupported(true);
        else setPlanRequestsError(describeError(caughtPlanRequests).message);
      });
    } catch (caught) {
      const detail = describeError(caught);
      if (isMissingRoute(caught)) {
        setUnsupported(true);
        setAgent(null);
        setEvents([]);
        setAuditMeta(null);
        setIntegrity(null);
        setLedger(null);
        setApprovals([]);
      } else {
        setError(`[${detail.code}] ${detail.message}`);
        setIntegrity(null);
        setLedger(null);
        setApprovals([]);
        setPlanRequests([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!state.runtime.reachable) return;
    void load();
  }, [load, state.runtime.reachable]);

  // deep link 滚动：等首次加载完成再滚，避免目标区块还没渲染。
  useEffect(() => {
    if (loading) return;
    const target = agentDeepLinkSection(window.location.search);
    if (!target) return;
    const timer = window.setTimeout(() => {
      document.getElementById(target)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, approvals.length, ledger?.entries.length, planRequests.length]);

  const decidePlanRequest = async () => {
    if (!planDecisionTarget || planDeciding) return;
    setPlanDeciding(true);
    try {
      const result = await runtimeClient.decideAgentPlanRequest(
        planDecisionTarget.request.requestId,
        planDecisionTarget.decision,
        planDecisionTarget.decision === 'reject' ? '用户在 UI 拒绝该计划' : '用户在 UI 批准该计划',
      );
      const label = planDecisionTarget.decision === 'approve' ? '已批准' : '已拒绝';
      notify(`计划请求${label}`, `requestId ${planDecisionTarget.request.requestId.slice(0, 12)}…；UI 只记录人工决定，不签发 token。`, planDecisionTarget.decision === 'approve' ? 'success' : 'warning');
      addAudit('settings', `计划请求${label}`, `${planDecisionTarget.request.kind} · ${planDecisionTarget.request.requestId.slice(0, 12)}…`, planDecisionTarget.decision === 'approve' ? 'success' : 'warning');
      setPlanDecisionTarget(null);
      await load();
    } catch (caught) {
      const detail = describeError(caught);
      setPlanRequestsError(`[${detail.code}] ${detail.message}`);
      notify('计划请求决策失败', `${detail.code} · ${detail.message}`, 'danger');
    } finally {
      setPlanDeciding(false);
    }
  };

  const rotate = async () => {
    setConfirmOpen(false);
    setRotating(true);
    setRotateError(null);
    setRotateNotice(null);
    try {
      const result = await runtimeClient.rotateAgentToken();
      // 轮换响应只回元数据；以返回值为准镜像（新令牌必然可用，但仍以服务端 available 为准）。
      setAgent((current) => ({ ...(current ?? result.agent), ...result.agent }));
      setRotateNotice('旧令牌已立即失效；DSH 插件下次请求会自动读取新令牌（无需手工复制/粘贴）。');
      addAudit('settings', '轮换 Agent 令牌', `${result.agent?.name ?? 'dsh-plugin'} · ${formatTime(result.agent?.createdAt)}`, 'warning');
      notify('Agent 令牌已轮换', '旧令牌立即失效；插件下次请求自动读取新令牌。', 'success');
      await load();
    } catch (caught) {
      const detail = describeError(caught);
      setRotateError(`[${detail.code}] ${detail.message}`);
      addAudit('settings', '轮换 Agent 令牌失败', `${detail.code} · ${detail.message}`, 'error');
      notify('轮换 Agent 令牌失败', `${detail.code} · ${detail.message}`, 'danger');
    } finally {
      setRotating(false);
    }
  };

  const revokeApproval = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setApprovalsError(null);
    try {
      await runtimeClient.revokeAgentApproval(revokeTarget.approvalId);
      notify('待执行批准已撤销', '该批准令牌立即失效，Agent 无法再用它执行计划；需要重新在对话中审批。', 'success');
      addAudit('settings', '撤销 Agent 待执行批准', revokeTarget.approvalId, 'warning');
      setRevokeTarget(null);
      await load();
    } catch (caught) {
      const detail = describeError(caught);
      setApprovalsError(`[${detail.code}] ${detail.message}`);
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  };

  const stateView = tokenState(agent);
  const integrityBadge = integrityView(integrity);
  /** 只有 Runtime 明确返回 anchored 字段时才显示锚点徽标；旧 Runtime 不能假装“已锚定”。 */
  const anchoredBadge = integrity && typeof integrity.anchored === 'boolean'
    ? (integrity.anchored ? { label: '已锚定', tone: 'success' as Tone } : { label: '未锚定（旧审计）', tone: 'warning' as Tone })
    : null;
  const ledgerBadge = ledger ? (ledger.chain?.ok ? { label: '账本链完整', tone: 'success' as Tone } : { label: '账本链异常', tone: 'danger' as Tone }) : null;
  const ledgerEntries = ledger ? [...ledger.entries].slice(-LEDGER_LIMIT).reverse() : [];
  const canOperate = state.runtime.reachable && !unsupported;

  return (
    <Panel
      eyebrow="02d · AGENT ACCESS"
      title="Agent 接入（插件令牌与调用审计）"
      meta={<Badge tone={stateView.tone}>{stateView.label}</Badge>}
      actions={<Button size="sm" icon={<RefreshCw size={14} />} loading={loading} disabled={!state.runtime.reachable} title={!state.runtime.reachable ? '请先启动本机 Runtime' : undefined} onClick={() => void load()}>刷新状态</Button>}
    >
      <div className="detail-stack" id="agent-access">
        {!state.runtime.reachable ? (
          <div className="inline-alert inline-alert--warning" role="status">
            <TriangleAlert size={16} />
            <span><strong>Runtime 未连接</strong><small>Agent 令牌由 Runtime 持有并落盘；连上后才能读取状态、审计与轮换。插件请求此时也会失败。</small></span>
          </div>
        ) : null}

        {unsupported ? (
          <div className="inline-alert inline-alert--info" role="status">
            <ShieldCheck size={16} />
            <span><strong>该 Runtime 版本尚未提供 Agent 控制台</strong><small>当前 Runtime 没有 GET /api/agent/status 等路由（404/401）。升级或重启最新 CircuitPilot 后本面板会自动生效；此状态不影响其它设置。</small></span>
          </div>
        ) : null}

        {error ? (
          <div className="inline-alert inline-alert--danger" role="alert">
            <TriangleAlert size={16} />
            <span><strong>读取 Agent 状态失败</strong><small>{error}</small></span>
          </div>
        ) : null}

        {canOperate && !agent && loading ? <div className="empty-inline"><Bot size={22} /><strong>正在读取 Agent 状态…</strong><span>从本机 Runtime 读取令牌元数据与最近调用审计。</span></div> : null}

        {canOperate && agent ? (
          <>
            <div className="stats-grid stats-grid--4">
              <Stat label="Agent 令牌" value={<Badge tone={stateView.tone}>{stateView.label}</Badge>} hint={agent.name || 'dsh-plugin'} />
              <Stat label="授权作用域" value={agent.scopes.length ? agent.scopes.join(' · ') : '未声明'} hint="read / plan / execute（执行前仍需对话批准）" />
              <Stat label="最近调用" value={`${events.length} 条`} hint={auditMeta ? `Runtime 共 ${auditMeta.total} 条${auditMeta.truncated ? '（已截断）' : ''}` : `最多展示 ${AUDIT_LIMIT} 条`} />
            </div>

            <div className="detail-block">
              <span>令牌元数据（只读，不包含令牌原文）</span>
              <p>令牌文件：<code style={{ overflowWrap: 'anywhere' }}>{agent.file || '未提供路径'}</code></p>
              <p>创建时间：{formatTime(agent.createdAt)}</p>
              <p>作用域：{agent.scopes.length ? agent.scopes.join('、') : '未声明'}</p>
            </div>

            {!agent.available ? (
              <div className="inline-alert inline-alert--warning" role="status">
                <TriangleAlert size={16} />
                <span>
                  <strong>Agent 令牌不可用（{stateView.label}）：{stateView.hint}</strong>
                  <small>
                    启动或重启 CircuitPilot 生成令牌：Runtime 首次启动会在上述路径原子写入一份 0600 令牌（目录 0700）。
                    若显示"损坏/权限过宽"，请先移走旧文件再重启，Runtime 会重新生成；它不会静默降级放行，也不会用进程内随机数顶替。
                  </small>
                </span>
              </div>
            ) : null}

            <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
              <Button variant="danger" icon={<KeyRound size={14} />} loading={rotating} disabled={!canOperate || loading} onClick={() => { setRotateError(null); setConfirmOpen(true); }}>轮换 Agent 令牌</Button>
            </div>
            {rotateNotice ? <div className="inline-alert inline-alert--info" role="status"><ShieldCheck size={16} /><span>{rotateNotice}</span></div> : null}
            {rotateError ? <div className="inline-alert inline-alert--danger" role="alert"><TriangleAlert size={16} /><span><strong>轮换失败</strong><small>{rotateError}</small></span></div> : null}

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 11 }}>最近 Agent 调用（最多 {AUDIT_LIMIT} 条）</strong>
                {integrityBadge ? <Badge tone={integrityBadge.tone}>{integrityBadge.label}</Badge> : null}
                {anchoredBadge ? <Badge tone={anchoredBadge.tone}>{anchoredBadge.label}</Badge> : null}
              </div>
              {integrity ? (
                <p><small>
                  链校验：verified {verifiedLabel(integrity.verified)} · {legacyLabel(integrity.legacy)} · badLines {integrity.badLines}
                  {typeof integrity.firstBadSeq === 'number' ? ` · 首个异常行 #${integrity.firstBadSeq}` : ''}
                </small></p>
              ) : null}
              {integrity?.chain === 'broken' ? (
                <div className="inline-alert inline-alert--danger" role="alert">
                  <TriangleAlert size={16} />
                  <span>
                    <strong>审计链异常{typeof integrity.firstBadSeq === 'number' ? `（首个异常行 #${integrity.firstBadSeq}）` : ''}</strong>
                    <small>
                      请保留现场：不要删除、覆盖或清空 agent-audit.jsonl；检查该文件是否被截断/改写，以及令牌文件与审计目录权限（0600/0700）。
                      {integrity.reason ? ` Runtime 报告：${integrity.reason}。` : ''}
                      本面板不提供修复或清空操作，避免把证据一起抹掉。
                    </small>
                  </span>
                </div>
              ) : null}
              {events.length ? (
                <TableFrame label="最近 Agent 调用审计">
                  <table>
                    <thead><tr><th>时间</th><th>类型</th><th>Actor</th><th>方法 / 路径</th><th>结果</th></tr></thead>
                    <tbody>
                      {events.map((event, index) => (
                        <tr key={`${event.at}-${event.kind}-${index}`}>
                          <td>{formatTime(event.at)}</td>
                          <td>{event.kind || '—'}</td>
                          <td>{event.actor || '—'}</td>
                          <td><code style={{ overflowWrap: 'anywhere' }}>{`${event.method ?? ''} ${event.path ?? event.target ?? event.tool ?? ''}`.trim() || '—'}</code></td>
                          <td><Badge tone={outcomeTone(event.outcome)}>{outcomeLabel(event.outcome)}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : (
                <div className="empty-inline"><Bot size={22} /><strong>暂无 Agent 调用</strong><span>DSH 插件通过 /api/agent/* 调用 Runtime 后，这里会出现审计记录（不显示令牌原文）。</span></div>
              )}
            </div>

            {!planRequestsUnsupported ? (
              <div id="agent-plan-requests">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 11 }}>计划级审查请求</strong>
                  <Badge tone={planRequests.some((item) => item.status === 'pending') ? 'warning' : 'neutral'}>
                    {planRequests.length ? `${planRequests.length} 条` : '无'}
                  </Badge>
                  <small>Agent 登记的计划；UI 批准/拒绝只记录人工决定，不签发 token</small>
                </div>
                {planRequestsError ? (
                  <div className="inline-alert inline-alert--danger" role="alert">
                    <TriangleAlert size={16} />
                    <span><strong>计划请求读取/决策失败</strong><small>{planRequestsError}</small></span>
                  </div>
                ) : null}
                {planRequests.length ? (
                  <TableFrame label="计划级审查请求">
                    <table>
                      <thead><tr><th>类型</th><th>计划 / 摘要</th><th>状态</th><th>过期时间</th><th>操作</th></tr></thead>
                      <tbody>
                        {planRequests.map((request) => (
                          <tr key={request.requestId}>
                            <td><Badge tone={request.kind === 'design' ? 'neutral' : 'warning'}>{request.kind === 'design' ? '原理图' : 'PCB'}</Badge></td>
                            <td>
                              <div style={{ display: 'grid', gap: 2 }}>
                                <strong style={{ fontSize: 11 }}>{request.title || `计划 ${shortId(request.requestId, 10)}`}</strong>
                                <code style={{ overflowWrap: 'anywhere' }} title={request.planHash}>
                                  {`plan ${shortId(request.planHash, 12)} · win ${shortId(request.windowId, 10)}`}
                                </code>
                                {request.summary ? <small>{request.summary}</small> : null}
                                {request.risks.length || request.missing.length ? (
                                  <small>{`风险 ${request.risks.length} · 缺失 ${request.missing.length}`}</small>
                                ) : null}
                              </div>
                            </td>
                            <td>
                              <Badge tone={request.status === 'approved' ? 'success' : 'warning'}>
                                {request.status === 'approved' ? '已批准（等待 Agent）' : '待审查'}
                              </Badge>
                            </td>
                            <td>{formatTime(request.expiresAt)}</td>
                            <td>
                              {request.status === 'pending' ? (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  <Button variant="ghost" disabled={planDeciding} onClick={() => setPlanDecisionTarget({ request, decision: 'approve' })}>批准</Button>
                                  <Button variant="ghost" disabled={planDeciding} onClick={() => setPlanDecisionTarget({ request, decision: 'reject' })}>拒绝</Button>
                                </div>
                              ) : <small>等待 Agent cp_approve</small>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <div className="empty-inline"><ShieldCheck size={22} /><strong>暂无计划审查请求</strong><span>Agent 在 cp_design_plan / cp_pcb_plan 传 requestApproval:true 后，计划会出现在这里。</span></div>
                )}
              </div>
            ) : (
              <div className="inline-alert inline-alert--info" role="status">
                <ShieldCheck size={16} />
                <span><strong>该 Runtime 版本尚未提供计划级审查</strong><small>GET /api/agent/plan-requests 不存在（404）；令牌、审计与待执行批准功能不受影响。</small></span>
              </div>
            )}

            {!approvalsUnsupported ? (
              <div id="agent-approvals">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 11 }}>待执行批准</strong>
                  <Badge tone={approvals.length ? 'warning' : 'neutral'}>{approvals.length ? `${approvals.length} 条待执行` : '无'}</Badge>
                  <small>已签发、尚未使用/撤销/过期；不显示令牌原文</small>
                </div>
                {approvalsError ? (
                  <div className="inline-alert inline-alert--danger" role="alert">
                    <TriangleAlert size={16} />
                    <span><strong>待执行批准读取/撤销失败</strong><small>{approvalsError}</small></span>
                  </div>
                ) : null}
                {approvals.length ? (
                  <TableFrame label="待执行批准">
                    <table>
                      <thead><tr><th>类型</th><th>计划 / 窗口</th><th>过期时间</th><th>操作</th></tr></thead>
                      <tbody>
                        {approvals.map((approval) => (
                          <tr key={`${approval.kind}-${approval.approvalId}`}>
                            <td><Badge tone={approval.kind === 'design' ? 'neutral' : 'warning'}>{approval.kind === 'design' ? '原理图' : 'PCB'}</Badge></td>
                            <td>
                              <code style={{ overflowWrap: 'anywhere' }} title={String(approval.bindings?.planHash ?? '')}>
                                {`plan ${shortId(approval.bindings?.planHash, 12)} · win ${shortId(approval.bindings?.windowId, 10)}`}
                              </code>
                            </td>
                            <td>{formatTime(approval.expiresAt)}</td>
                            <td><Button variant="ghost" onClick={() => setRevokeTarget(approval)} disabled={revoking}>撤销</Button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <div className="empty-inline"><ShieldCheck size={22} /><strong>暂无待执行批准</strong><span>Agent 在对话中签发计划批准、但尚未执行/撤销时，这里会出现一条待执行记录。</span></div>
                )}
              </div>
            ) : (
              <div className="inline-alert inline-alert--info" role="status">
                <ShieldCheck size={16} />
                <span><strong>该 Runtime 版本尚未提供待执行批准</strong><small>GET /api/agent/approvals 不存在（404）；令牌、审计与批准账本功能不受影响。</small></span>
              </div>
            )}

            {!ledgerUnsupported ? (
              <div id="agent-ledger">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 11 }}>批准账本（最近 {LEDGER_LIMIT} 条，只读）</strong>
                  {ledgerBadge ? <Badge tone={ledgerBadge.tone}>{ledgerBadge.label}</Badge> : null}
                  {ledger ? <small>共 {ledger.summary.total} 条</small> : null}
                </div>
                {ledger?.loadError ? (
                  <div className="inline-alert inline-alert--warning" role="status">
                    <TriangleAlert size={16} />
                    <span><strong>批准账本读取降级</strong><small>{ledger.loadError}</small></span>
                  </div>
                ) : null}
                {ledger && !ledger.chain?.ok ? (
                  <div className="inline-alert inline-alert--danger" role="alert">
                    <TriangleAlert size={16} />
                    <span>
                      <strong>批准账本哈希链异常{typeof ledger.chain?.brokenAt === 'number' ? `（第 ${ledger.chain.brokenAt} 条）` : ''}</strong>
                      <small>请保留现场：不要删除或覆盖 approvals-ledger.json；本面板不提供修复/清空操作。{ledger.chain?.reason ? ` Runtime 报告：${ledger.chain.reason}。` : ''}</small>
                    </span>
                  </div>
                ) : null}
                {ledgerEntries.length ? (
                  <TableFrame label="最近批准账本">
                    <table>
                      <thead><tr><th>时间</th><th>作用域 / 动作</th><th>批准 ID</th><th>计划 / 目标</th></tr></thead>
                      <tbody>
                        {ledgerEntries.map((entry) => (
                          <tr key={`${entry.index}-${entry.entryHash ?? entry.at}`}>
                            <td>{formatTime(entry.at)}</td>
                            <td><Badge tone={ledgerActionTone(entry.action)}>{`${entry.scope || '—'} / ${entry.action || '—'}`}</Badge></td>
                            <td><code title={entry.approvalId ?? undefined}>{shortId(entry.approvalId, 8)}</code></td>
                            <td>
                              <code style={{ overflowWrap: 'anywhere' }} title={ledgerBinding(entry, 'planHash') ?? undefined}>
                                {`plan ${shortId(ledgerBinding(entry, 'planHash'), 12)} · win ${shortId(ledgerBinding(entry, 'windowId'), 10)}`}
                              </code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <div className="empty-inline"><ShieldCheck size={22} /><strong>暂无批准记录</strong><span>计划/写板批准签发、消费、撤销或驳回后，这里会出现哈希链账本记录（不含令牌原文）。</span></div>
                )}
              </div>
            ) : (
              <div className="inline-alert inline-alert--info" role="status">
                <ShieldCheck size={16} />
                <span><strong>该 Runtime 版本尚未提供批准账本</strong><small>GET /api/approvals/ledger 不存在（404）；令牌与审计功能不受影响。</small></span>
              </div>
            )}

            <p><small>本面板展示令牌元数据、审计、审计链完整性、批准账本、待执行批准与计划级审查请求；不显示/不复制令牌原文。计划审查的批准/拒绝只记录人工决定，不签发 token；Agent 仍需 cp_approve 才能取得一次性批准令牌。撤销待执行批准只让该令牌失效，不会执行任何写操作；轮换后旧令牌立即失效，插件下次请求自动读取新令牌。</small></p>
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={Boolean(planDecisionTarget)}
        onClose={() => setPlanDecisionTarget(null)}
        onConfirm={() => void decidePlanRequest()}
        title={planDecisionTarget?.decision === 'approve' ? '批准这条计划请求？' : '拒绝这条计划请求？'}
        description={`${planDecisionTarget?.request.title || '计划'}（${planDecisionTarget?.request.requestId.slice(0, 12) ?? ''}…）：UI 只记录人工决定，不会签发 token、不会执行写操作；批准后 Agent 仍需 cp_approve。`}
        confirmLabel={planDecisionTarget?.decision === 'approve' ? '确认批准' : '确认拒绝'}
        danger={planDecisionTarget?.decision === 'reject'}
      />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void revokeApproval()}
        title="撤销这条待执行批准？"
        description={`将立即让批准 ${revokeTarget ? shortId(revokeTarget.approvalId, 8) : ''} 失效：Agent 无法再用它执行该计划，需要重新在对话中审批。撤销不会执行任何写操作，也不会显示令牌原文。`}
        confirmLabel="确认撤销"
        danger
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void rotate()}
        title="轮换 Agent 令牌？"
        description="将立即生成新令牌，旧令牌马上失效：正在使用旧令牌的插件请求会收到 401，需要重试。插件下次请求会自动读取新令牌，不需要你复制/粘贴；界面也不会显示令牌原文。"
        confirmLabel="确认轮换"
        danger
      />
    </Panel>
  );
}
