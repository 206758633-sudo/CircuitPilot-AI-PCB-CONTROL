import { useMemo, useState } from 'react';
import { ArrowRight, Bot, CheckCheck, CircuitBoard, FileStack, GitCompare, History, Lightbulb, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';

function go(hash: string) {
  window.location.hash = hash;
}

import { STAGE_ORDER, stageProgress } from '../services/stageMachine';
import { validationKpis } from '../services/validationEvidence';
import { GUIDED_FLOW } from '../navigation';

const stageOrder = STAGE_ORDER;

export function OverviewPage() {
  const { state, activeProject, requirementCompleteness, openRiskCount, openIssueCount, navigate, notify } = useApp();
  const project = activeProject;
  const stageIndex = Math.max(0, stageOrder.indexOf((project?.stage ?? '概念') as typeof stageOrder[number]));
  // P0-3：进度由阶段派生，避免 project.progress 与阶段长期脱节。
  const progress = stageProgress(project?.stage);
  const confirmedReqs = state.requirements.filter((item) => item.status === 'confirmed').length;
  const conflicts = state.requirements.filter((item) => item.status === 'conflict').length;
  const suggested = state.requirements.filter((item) => item.status === 'suggested').length;
  const validations = state.validations;
  // P0-3：概览只统计"当前项目 + official"验证记录；seed/Demo 不再冒充"已验证"。
  const kpis = useMemo(() => validationKpis(validations, project?.id), [validations, project?.id]);
  const passed = kpis.passed;
  const warn = kpis.failedOrWarn;
  const idle = kpis.missing.length;
  const openFindings = kpis.openFindings;
  const components = state.components;
  const approved = components.filter((item) => item.status === 'approved').length;

  const stages = useMemo(() => [
    { key: '需求', title: '需求确认', meta: `${confirmedReqs}/${state.requirements.length} 条已确认`, state: requirementCompleteness >= 100 ? 'done' : 'now' as const },
    { key: '方案', title: '方案生成', meta: stageIndex >= 1 ? '原理图方案已生成' : 'AI 对话与选型', state: stageIndex >= 2 ? 'done' : stageIndex >= 1 ? 'now' : 'todo' as const },
    { key: '写入', title: '受控写入', meta: state.eda.connected ? 'EDA 已连接' : '等待连接 EDA', state: stageIndex >= 3 ? 'done' : stageIndex >= 2 ? 'now' : 'todo' as const },
    { key: '验证', title: '验证交付', meta: kpis.ran === 0 ? '官方 ERC/DRC 尚未运行' : kpis.missing.length ? `${kpis.missing.join('/')} 未运行` : `${passed}/${kpis.total} 项官方检查通过`, state: stageIndex >= 4 ? 'done' : stageIndex >= 3 ? 'now' : 'todo' as const },
  ], [confirmedReqs, state.requirements.length, requirementCompleteness, stageIndex, state.eda.connected, kpis]);

  const decisions = useMemo(() => {
    const list: Array<{ id: string; tone: 'warn' | 'danger' | 'info'; title: string; detail: string; action: string; cta: string }> = [];
    if (conflicts > 0) {
      list.push({ id: 'conflict', tone: 'danger', title: `${conflicts} 条需求存在冲突`, detail: '冲突需求不解决，后面的选型与布局都会反复。建议先裁决定义。', action: 'design/req', cta: '去裁决' });
    }
    if (suggested > 0) {
      list.push({ id: 'suggested', tone: 'warn', title: `${suggested} 条 AI 建议待确认`, detail: 'AI 依据芯片参考设计与工艺偏好给出建议，接受后才会进入约束。', action: 'design/req', cta: '去确认' });
    }
    if (openIssueCount > 0) {
      list.push({ id: 'issues', tone: 'danger', title: `${openIssueCount} 个运行问题待处理`, detail: 'Runtime / EDA 现场问题会阻塞受控写入，先处理再继续。', action: 'versions', cta: '查看问题' });
    }
    if (idle > 0) {
      list.push({ id: 'idle', tone: 'info', title: `${idle} 项验证还没运行`, detail: '未运行的检查不会出现在交付报告里，运行后才知道是否可交付。', action: 'validation', cta: '运行验证' });
    }
    if (openFindings > 0) {
      list.push({ id: 'findings', tone: 'warn', title: `${openFindings} 个检查问题待收口`, detail: 'ERC / DRC 问题需修复或豁免并留下理由，才能生成交付包。', action: 'validation', cta: '查看问题' });
    }
    return list.slice(0, 3);
  }, [conflicts, suggested, openIssueCount, idle, openFindings]);

  const activity = useMemo(() => state.audit.slice(0, 4), [state.audit]);

  const description = project?.description ?? '从左侧选择一个项目开始。';
  const [descExpanded, setDescExpanded] = useState(false);
  const descClampable = description.length > 160;

  const primary = (() => {
    if (requirementCompleteness < 100 || conflicts > 0) return { hash: 'design/chat', label: '继续补全设计输入', hint: `${requirementCompleteness}% 需求已确认` };
    if (stageIndex < 2) return { hash: 'eda', label: '进入受控 EDA 执行', hint: '快照 → 批准 → 写入 → 回读' };
    if (idle > 0 || openFindings > 0) return { hash: 'validation', label: '运行验证并收口问题', hint: `${idle} 项未运行 · ${openFindings} 个问题` };
    return { hash: 'validation', label: '生成交付包', hint: '检查已通过，可导出' };
  })();

  return (
    <div className="ov">
      <section className="ov-hero">
        <div>
          <div className="ov-eyebrow"><ShieldCheck size={14} /> 当前项目 · {project?.stage ?? '概念'}阶段 · 更新于 {project?.updatedAt?.slice(0, 16) ?? '—'}</div>
          <h2>{project?.name ?? '未选择项目'} <span>· {project?.code ?? '—'}</span></h2>
          <p className={descExpanded ? 'is-expanded' : ''}>{description}</p>
          {descClampable && (
            <button type="button" className="link-button" aria-expanded={descExpanded} onClick={() => setDescExpanded((value) => !value)}>
              {descExpanded ? '收起摘要' : '展开全部摘要'}
            </button>
          )}
          <div className="ov-actions">
            <button type="button" className="button button--primary" onClick={() => go(primary.hash)}>{primary.label}<ArrowRight size={15} /></button>
            <button type="button" className="button" onClick={() => go('design/chat')}><Sparkles size={15} />和 AI 继续聊</button>
            <button type="button" className="button" onClick={() => go('versions')}><History size={15} />版本与审计</button>
          </div>
        </div>
        <div className="ov-side">
          <div className="ov-ring" role="img" aria-label={`设计进度 ${progress}%，${primary.hint}`}>
            <svg width="94" height="94" viewBox="0 0 94 94" aria-hidden>
              <circle cx="47" cy="47" r="40" fill="none" stroke="#e8ece7" strokeWidth="8" />
              <circle cx="47" cy="47" r="40" fill="none" stroke="#147a5a" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(progress / 100) * 251.2} 251.2`} />
            </svg>
            <div className="ov-ring__val"><strong>{progress}%</strong><small>设计进度</small></div>
          </div>
          <small>{primary.hint}</small>
        </div>

        <div className="ov-stages">
          {stages.map((stage, index) => (
            <div key={stage.key} className={`ov-stage is-${stage.state}`}>
              <i>{stage.state === 'done' ? '✓' : index + 1}</i>
              <strong>{stage.title}</strong>
              <small>{stage.meta}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="ov-grid">
        <section className="ov-card">
          <div className="ov-card__head">
            <div><h3>现在需要你决策</h3><p>按影响排序，处理完这些卡点，项目才能继续往前。</p></div>
            <button type="button" className="button button--ghost button--sm" onClick={() => navigate('versions')}>全部问题</button>
          </div>
          <div className="ov-card__body">
            {decisions.length === 0 ? (
              <div className="ov-empty">目前没有阻塞决策：需求已确认、检查已通过。可以直接进入交付。</div>
            ) : (
              <div className="ov-decisions">
                {decisions.map((item) => (
                  <button type="button" className="ov-decision" key={item.id} onClick={() => go(item.action)}>
                    <span className={`ov-decision__ico ${item.tone === 'danger' ? 'is-danger' : item.tone === 'info' ? 'is-info' : ''}`}>
                      {item.tone === 'info' ? <Lightbulb size={15} /> : <TriangleAlert size={15} />}
                    </span>
                    <span className="ov-decision__copy"><strong>{item.title}</strong><span className="ov-decision__detail">{item.detail}</span></span>
                    <span className="ov-decision__cta">{item.cta}<ArrowRight size={13} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="ov-card">
          <div className="ov-card__head"><div><h3>项目健康度</h3><p>四条主线，红/黄就说明还不能交付。</p></div></div>
          <div className="ov-health">
            <div className="ov-health__row">
              <div className="label"><span>需求确认</span><strong>{confirmedReqs}/{state.requirements.length}</strong></div>
              <div className="progress" role="progressbar" aria-label="需求确认进度" aria-valuenow={requirementCompleteness} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${requirementCompleteness}%` }} /></div>
            </div>
            <div className="ov-health__row">
              <div className="label"><span>官方验证通过</span><strong>{passed}/{kpis.total}</strong></div>
              <div className="progress" role="progressbar" aria-label="官方验证通过进度" aria-valuenow={kpis.total ? Math.round((passed / kpis.total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${kpis.total ? Math.round((passed / kpis.total) * 100) : 0}%` }} /></div>
            </div>
            <div className="ov-health__row">
              <div className="label"><span>元件已批准</span><strong>{approved}/{components.length}</strong></div>
              <div className="progress" role="progressbar" aria-label="元件批准进度" aria-valuenow={components.length ? Math.round((approved / components.length) * 100) : 0} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${components.length ? Math.round((approved / components.length) * 100) : 0}%` }} /></div>
            </div>
          </div>
          <div className="ov-mini">
            <div className="ov-tile"><strong>{openRiskCount}</strong><span>风险项</span></div>
            <div className="ov-tile"><strong>{warn}</strong><span>需关注</span></div>
            <div className="ov-tile"><strong>{openIssueCount}</strong><span>待处理问题</span></div>
          </div>
        </section>
      </div>

      <section className="ov-card">
        <div className="ov-card__head"><div><h3>最近发生了什么</h3><p>只保留影响设计判断的事件，可追溯到版本。</p></div><button type="button" className="button button--ghost button--sm" onClick={() => navigate('versions')}>查看全部</button></div>
        <div className="ov-activity">
          {activity.length === 0 && <div className="ov-empty" style={{ padding: '4px 0 10px' }}>还没有事件，和 AI 聊一轮或运行一次验证就会出现在这里。</div>}
          {activity.map((event) => (
            <div className="ov-act" key={event.id}>
              <span className="ov-act__ico">{event.type === 'ai' ? <Bot size={14} /> : event.type === 'eda' ? <CircuitBoard size={14} /> : event.type === 'validation' ? <CheckCheck size={14} /> : <History size={14} />}</span>
              <div><strong>{event.title}</strong><small>{event.detail}</small></div>
              <time>{event.time.slice(5, 16)}</time>
            </div>
          ))}
        </div>
      </section>

      <section className="ov-card">
        <div className="ov-card__head"><div><h3>从零到交付的完整链路</h3><p>按顺序走就是一条完整任务流；每一步都落在明确的页面职责里，写板前必须人工批准。</p></div><button type="button" className="button button--ghost button--sm" onClick={() => navigate('projects')}>先确认项目</button></div>
        <div className="ov-quick">
          {GUIDED_FLOW.map((step) => (
            <button type="button" key={step.id} onClick={() => navigate(step.page, step.tab)}>
              <ArrowRight size={17} />
              <strong>{step.label}</strong>
              <small>{step.stage} · {step.description}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="ov-quick">
        <button type="button" onClick={() => go('design/chat')}><Sparkles size={17} /><strong>让 AI 追问补全</strong><small>把口语需求变成可验证约束</small></button>
        <button type="button" onClick={() => go('design/select')}><Lightbulb size={17} /><strong>元件选型</strong><small>需求换真实候选与库存证据</small></button>
        <button type="button" onClick={() => go('eda')}><CircuitBoard size={17} /><strong>受控执行</strong><small>快照 / 批准 / 回读 / 回滚</small></button>
        <button type="button" onClick={() => go('versions')}><GitCompare size={17} /><strong>版本对比</strong><small>看看这轮改了什么</small></button>
        <button type="button" onClick={() => go('projects')}><FileStack size={17} /><strong>项目与资料</strong><small>工程目录、BOM 与依据文件</small></button>
      </div>
    </div>
  );
}

export function OverviewFallback() {
  return (
    <div className="ov" aria-busy="true" aria-live="polite">
      <section className="ov-hero" aria-label="概览加载占位">
        <div>
          <div className="skeleton skeleton--line" style={{ width: '46%' }} />
          <div className="skeleton skeleton--title" style={{ marginTop: 12 }} />
          <div className="skeleton skeleton--line" style={{ width: '72%', marginTop: 10 }} />
          <div className="skeleton skeleton--line" style={{ width: '58%', marginTop: 6 }} />
        </div>
        <div className="ov-side"><div className="skeleton" style={{ width: 96, height: 96, borderRadius: '50%' }} /></div>
      </section>
      <div className="ov-grid">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
      <span className="visually-hidden">项目数据加载中</span>
    </div>
  );
}
