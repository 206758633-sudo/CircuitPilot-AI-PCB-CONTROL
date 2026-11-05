import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Inbox, RefreshCw, ShieldCheck } from 'lucide-react';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type {
  SupervisorAttentionSources,
  SupervisorAttentionView,
  SupervisorSeverity,
  SupervisorSource,
  SupervisorTicket,
  SupervisorTicketStatus,
  Tone,
} from '../types';
import { Badge, Button, Panel, Stat } from './ui';

/** 值守队列轮询间隔：只刷新展示，不触发任何写操作。 */
const ATTENTION_POLL_MS = 30_000;

/**
 * 平台 P1-6：来源可用性 → 展示名。
 *
 * 服务端 `sources` 的 key（validations/issues/planRequests）与票据 source（validation/issue/plan）
 * 是两套命名，这里显式映射，避免 UI 自己猜 key 而漏掉某个源。
 */
const SOURCE_AVAILABILITY_META: Array<{ key: keyof SupervisorAttentionSources; label: string }> = [
  { key: 'validations', label: '验证源' },
  { key: 'issues', label: '问题源' },
  { key: 'planRequests', label: '计划源' },
];

const unavailableSources = (sources?: SupervisorAttentionSources) => SOURCE_AVAILABILITY_META
  .map((item) => ({ ...item, state: sources?.[item.key] }))
  .filter((item) => item.state?.available === false)
  .map((item) => ({ key: item.key, label: item.label, reason: item.state?.reason || null }));

const formatTime = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
};

/** 来源 → 展示名 + 「去处理」跳转的现有页签（不新增导航页）。 */
const SOURCE_META: Record<SupervisorSource, { label: string; tone: Tone; hash: string }> = {
  validation: { label: '验证', tone: 'info', hash: '#validation' },
  issue: { label: '问题', tone: 'warning', hash: '#versions' },
  plan: { label: '计划', tone: 'neutral', hash: '#automation' },
};

const SEVERITY_META: Record<SupervisorSeverity, { label: string; tone: Tone }> = {
  critical: { label: '严重', tone: 'danger' },
  error: { label: '错误', tone: 'danger' },
  warning: { label: '警告', tone: 'warning' },
  info: { label: '提示', tone: 'info' },
};

const STATUS_META: Record<SupervisorTicketStatus, { label: string; tone: Tone }> = {
  open: { label: '待处理', tone: 'warning' },
  acknowledged: { label: '已接单', tone: 'info' },
  blocked: { label: '受阻', tone: 'danger' },
  done: { label: '已解决', tone: 'success' },
  dismissed: { label: '已忽略', tone: 'neutral' },
};

const describeError = (error: unknown): { code: string; message: string } => {
  if (error instanceof RuntimeApiError) return { code: error.code, message: error.message };
  return { code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : '未知错误' };
};

type TicketAction = 'ack' | 'dismiss' | 'resolve';

/**
 * C 方案「只读 Agent 值守队列」：展示 Runtime 汇总的 validation / issue / plan 未收口事项。
 *
 * 边界（必须一直成立）：
 * - 只读：本组件不写 EDA、不自动执行、不提供修复/下单入口；「去处理」只跳转到现有页面；
 * - 接单/忽略/已解决只改值守票据状态，不代表问题已被修复（真实修复仍以官方验证/门禁证据为准）；
 * - 独立组件：不使用 useApp/AppProvider，避免把概览页状态耦合进来；
 * - 挂载即加载，之后每 30s 静默轮询；卸载清 timer；失败显示错误码与重试，不白屏。
 */
export function SupervisorPanel() {
  const [view, setView] = useState<SupervisorAttentionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ ticketId: string; action: TicketAction } | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const next = await runtimeClient.getSupervisorAttention();
      if (!aliveRef.current) return;
      setView(next);
      setError(null);
    } catch (caught) {
      if (!aliveRef.current) return;
      const detail = describeError(caught);
      // 有旧数据时保留列表，只在顶部提示"本次刷新失败"，避免一次网络抖动把队列清空。
      setError(`[${detail.code}] ${detail.message}`);
    } finally {
      if (aliveRef.current && !options.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const timer = window.setInterval(() => { void load({ silent: true }); }, ATTENTION_POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const act = async (ticket: SupervisorTicket, action: TicketAction) => {
    // 忽略会让人工注意力长期离开该问题（直到源状态变化）；加一次确认，避免误点。
    if (action === 'dismiss' && !window.confirm('忽略后该票据会从值守队列隐藏，直到源状态发生变化。\n\n确认忽略？')) return;
    setBusy({ ticketId: ticket.ticketId, action });
    setActionError(null);
    try {
      if (action === 'ack') await runtimeClient.ackSupervisorTicket(ticket.ticketId);
      else if (action === 'dismiss') await runtimeClient.dismissSupervisorTicket(ticket.ticketId);
      else await runtimeClient.resolveSupervisorTicket(ticket.ticketId);
      // 操作成功后刷新队列（以 Runtime 返回的状态为准，不在前端猜测新状态）。
      await load({ silent: true });
    } catch (caught) {
      const detail = describeError(caught);
      setActionError(`[${detail.code}] ${detail.message}`);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const isBusy = busy !== null || loading;
  const attention = view?.summary.attention ?? 0;
  // 平台 P1-6：任一来源不可用时，summary/tickets 里该源为 0 是"读不到"而不是"没有"。
  const degraded = unavailableSources(view?.sources);

  return (
    <Panel
      eyebrow="SUPERVISOR · READ-ONLY"
      title="值守队列（只读巡检）"
      meta={view ? <Badge tone={degraded.length ? 'warning' : attention > 0 ? 'warning' : 'success'}>{degraded.length ? `${degraded.length} 个来源不可用` : attention > 0 ? `${attention} 项待处理` : '暂无待处理'}</Badge> : null}
      actions={<Button size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>刷新队列</Button>}
    >
      <div className="supervisor">
        <p className="supervisor__note">
          <ShieldCheck size={15} aria-hidden />
          <span>
            只读值守：Runtime 只汇总 validation / issue / plan 证据并给出建议，<strong>不写 EDA、不会自动执行</strong>；
            点「去处理」只跳转到对应页面，任何写入仍需你在那里人工批准。
          </span>
        </p>

        {degraded.length ? (
          <div className="inline-alert inline-alert--danger" role="alert" data-testid="supervisor-degraded">
            <AlertTriangle size={16} />
            <span>
              <strong>{degraded.map((item) => item.label).join(' / ')} 不可用：该来源的待办无法列出（不是没有待办）</strong>
              {degraded.map((item) => (
                <small key={item.key}>{item.label}：{item.reason || '服务端未给出原因'}</small>
              ))}
              <small>队列里该来源的计数为 0 只代表"没读到"；修复后点「刷新队列」重新巡检。</small>
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="inline-alert inline-alert--danger" role="alert">
            <AlertTriangle size={16} />
            <span>
              <strong>{view ? '刷新值守队列失败（下面仍是上次结果）' : '读取值守队列失败'}</strong>
              <small>{error}</small>
              <span className="supervisor__retry"><Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>重试</Button></span>
            </span>
          </div>
        ) : null}

        {actionError ? (
          <div className="inline-alert inline-alert--danger" role="alert">
            <AlertTriangle size={16} />
            <span><strong>票据操作未生效</strong><small>{actionError}</small></span>
          </div>
        ) : null}

        {!view && loading ? <div className="empty-inline"><RefreshCw size={22} className="spin" /><strong>正在读取值守队列…</strong><span>从本机 Runtime 拉取只读巡检结果。</span></div> : null}

        {view ? (
          <>
            <div className="stats-grid stats-grid--4">
              <Stat label="票据总数" value={view.summary.total} hint={`含已收口；巡检于 ${formatTime(view.generatedAt)}`} />
              <Stat
                label="需你处理"
                value={view.summary.attention}
                tone={attention > 0 ? 'warning' : 'success'}
                hint={`待处理 ${view.summary.byStatus.open} · 已接单 ${view.summary.byStatus.acknowledged} · 受阻 ${view.summary.byStatus.blocked}`}
              />
              <Stat
                label="严重度"
                value={`严重 ${view.summary.bySeverity.critical} · 错误 ${view.summary.bySeverity.error}`}
                tone={view.summary.bySeverity.critical > 0 ? 'danger' : 'neutral'}
                hint={`警告 ${view.summary.bySeverity.warning} · 提示 ${view.summary.bySeverity.info}`}
              />
            </div>

            {view.tickets.length === 0 ? (
              <div className="empty-inline supervisor__empty">
                <Inbox size={22} />
                {degraded.length ? (
                  <>
                    <strong>当前没有读到需要你处理的事项，但有来源不可用（见上方横幅）。</strong>
                    <span>不可用来源的待办未列出，不代表没有待办；修复后点「刷新队列」重新巡检。</span>
                  </>
                ) : (
                  <>
                    <strong>当前没有需要你处理的事项；后台只读巡检仍在运行。</strong>
                    <span>队列每 30 秒刷新一次；有问题时会在这里出现，并附证据引用与建议动作。</span>
                  </>
                )}
              </div>
            ) : (
              <ul className="supervisor__list">
                {view.tickets.map((ticket) => {
                  const source = SOURCE_META[ticket.source] ?? { label: ticket.source, tone: 'neutral' as Tone, hash: '#validation' };
                  const severity = SEVERITY_META[ticket.severity] ?? { label: ticket.severity, tone: 'neutral' as Tone };
                  const status = STATUS_META[ticket.status] ?? { label: ticket.status, tone: 'neutral' as Tone };
                  const ticketBusy = busy?.ticketId === ticket.ticketId ? busy.action : null;
                  return (
                    <li className={`supervisor-ticket supervisor-ticket--${ticket.severity}`} key={ticket.ticketId}>
                      <div className="supervisor-ticket__head">
                        <div className="supervisor-ticket__badges">
                          <Badge tone={source.tone}>{source.label}</Badge>
                          <Badge tone={severity.tone}>{severity.label}</Badge>
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {ticket.occurrences > 1 ? <Badge tone="neutral">出现 {ticket.occurrences} 次</Badge> : null}
                        </div>
                        <small className="supervisor-ticket__time">更新 {formatTime(ticket.updatedAt)}</small>
                      </div>

                      <strong className="supervisor-ticket__title">{ticket.title}</strong>
                      <p className="supervisor-ticket__summary">{ticket.summary}</p>
                      <p className="supervisor-ticket__action"><span>建议动作</span>{ticket.suggestedAction}</p>

                      <p className="supervisor-ticket__evidence">
                        <span>证据 {ticket.evidence.length} 条</span>
                        {ticket.evidence.slice(0, 4).map((item) => (
                          <code key={`${item.kind}-${item.ref}`} title={`${item.kind} · ${item.ref}${item.digest ? ` · digest ${item.digest}` : ''}`}>{item.kind}</code>
                        ))}
                        {ticket.evidence.length > 4 ? <small>+{ticket.evidence.length - 4}</small> : null}
                      </p>

                      {ticket.worker?.verdict ? (
                        <p className="supervisor-ticket__worker">
                          <span>值守建议</span>
                          <small>{ticket.worker.name} · {ticket.worker.verdict}{ticket.worker.steps?.length ? `（${ticket.worker.steps.length} 个检查步骤）` : ''}</small>
                        </p>
                      ) : null}

                      <div className="supervisor-ticket__foot">
                        <Button size="sm" variant="ghost" icon={<ArrowRight size={14} />} onClick={() => { window.location.hash = source.hash; }}>去处理</Button>
                        <div className="supervisor-ticket__buttons">
                          {ticket.status === 'open' ? (
                            <Button size="sm" loading={ticketBusy === 'ack'} disabled={isBusy} onClick={() => void act(ticket, 'ack')}>接单</Button>
                          ) : null}
                          {ticket.status === 'open' || ticket.status === 'acknowledged' ? (
                            <>
                              <Button size="sm" loading={ticketBusy === 'dismiss'} disabled={isBusy} onClick={() => void act(ticket, 'dismiss')}>忽略</Button>
                              <Button size="sm" variant="primary" loading={ticketBusy === 'resolve'} disabled={isBusy} onClick={() => void act(ticket, 'resolve')}>已解决</Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="supervisor__foot">
              本面板只读：不提供写 EDA、自动修复、下单等操作；「接单/忽略/已解决」只改变值守队列状态，
              真实修复仍以官方验证与门禁证据为准（标记成功不会让未通过的检查自动通过；源仍显示失败/未解决时，已解决票据会在下一次巡检自动重新打开）。
            </p>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
