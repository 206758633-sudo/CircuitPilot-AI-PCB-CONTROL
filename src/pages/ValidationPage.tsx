import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Crosshair, Play, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { demoAdapter } from '../services/demoAdapter';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { EngineeringAnalysis, Finding, ValidationCheck } from '../types';
import { Badge, Button, Field, Panel, Progress, Stat } from '../components/ui';
import { Drawer, Modal } from '../components/overlays';

const checkTone = (status: ValidationCheck['status']) => status === 'pass' ? 'success' : status === 'warn' ? 'warning' : status === 'fail' ? 'danger' : status === 'running' ? 'info' : 'neutral';
const checkLabel = (status: ValidationCheck['status']) => ({ pass: '通过', warn: '警告', fail: '失败', running: '运行中', idle: '未运行' })[status];

export function ValidationPage() {
  const { state, dispatch, notify, addAudit, reportIssue, navigate } = useApp();
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<ValidationCheck | null>(null);
  const [waive, setWaive] = useState<{ check: ValidationCheck; finding: Finding } | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [engineeringRunning, setEngineeringRunning] = useState<string | null>(null);
  const [engineeringResult, setEngineeringResult] = useState<EngineeringAnalysis | null>(null);
  const totalOpen = useMemo(() => state.validations.reduce((sum, item) => sum + item.findings.filter((finding) => finding.status === 'open').length, 0), [state.validations]);
  const passCount = state.validations.filter((item) => item.status === 'pass').length;
  const coverage = Math.round((state.validations.filter((item) => item.status !== 'idle').length / state.validations.length) * 100);

  const runAll = async () => {
    setRunning(true);
    try {
      const result = await demoAdapter.runValidations(state.validations, (validations) => dispatch({ type: 'SET_VALIDATIONS', validations }));
      dispatch({ type: 'SET_VALIDATIONS', validations: result });
      addAudit('validation', '完成全量验证', `${result.length}项检查 · Demo`, result.some((item) => item.status === 'fail') ? 'error' : result.some((item) => item.status === 'warn') ? 'warning' : 'success');
      notify('验证已完成', '结果来自模拟适配器，不代表真实嘉立创EDA检查结果。', 'success');
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      reportIssue({ fingerprint: 'validation:DEMO_RUN_ALL', source: 'validation', severity: 'error', status: 'open', code: 'VALIDATION_RUN_FAILED', summary: '全量工程验证运行失败', detail, suggestedAction: '确认本机Runtime可用后重试“运行全部检查”；页面不会因此锁死。' });
      addAudit('validation', '全量验证失败', detail, 'error');
      notify('验证失败', `${detail}；页面已恢复可用，可重新运行全部检查。`, 'danger');
    } finally { setRunning(false); }
  };
  const runOne = async (check: ValidationCheck) => {
    const start = { ...check, status: 'running' as const };
    dispatch({ type: 'UPDATE_VALIDATION', validation: start }); setSelected(start);
    try {
      const result = await demoAdapter.runValidations([check], () => undefined);
      dispatch({ type: 'UPDATE_VALIDATION', validation: result[0] }); setSelected(result[0]); addAudit('validation', `运行${check.name}`, check.description, 'info'); notify(`${check.name} 已完成`, `状态：${checkLabel(result[0].status)}（Demo）`, result[0].status === 'pass' ? 'success' : 'warning');
    } catch (error) {
      const restored: ValidationCheck = { ...check, status: check.status === 'running' ? 'idle' : check.status };
      dispatch({ type: 'UPDATE_VALIDATION', validation: restored }); setSelected(restored);
      const detail = error instanceof Error ? error.message : '未知错误';
      reportIssue({ fingerprint: `validation:DEMO_RUN_ONE:${check.id}`, source: 'validation', severity: 'error', status: 'open', code: 'VALIDATION_RUN_FAILED', summary: `${check.name}验证检查运行失败`, detail, context: { checkId: check.id }, suggestedAction: '确认本机Runtime可用后重新运行该检查；检查状态已恢复为可重试。' });
      addAudit('validation', `运行${check.name}失败`, detail, 'error');
      notify(`${check.name} 运行失败`, `${detail}；状态已恢复为${checkLabel(restored.status)}，可重新运行。`, 'danger');
    }
  };
  const locate = (finding: Finding) => { navigate('eda'); notify('已发送定位请求', `Demo 将定位到 ${finding.object}；真实定位需要Bridge连接。`, 'info'); addAudit('validation', '定位验证问题', `${finding.object} · ${finding.rule}`, 'info'); };
  const createFix = (finding: Finding) => {
    dispatch({ type: 'PATCH_TASK', patch: { goal: `修复验证问题：${finding.title}（对象 ${finding.object}，规则 ${finding.rule}）。建议：${finding.suggestion}`, status: 'draft', steps: [], progress: 0, planHash: `fix-${Date.now().toString(36)}` } }); navigate('ai'); notify('已创建修复任务草稿', '请审阅任务目标并生成计划。', 'success'); addAudit('ai', '从验证问题创建任务', finding.title, 'info');
  };
  const confirmWaiver = () => {
    if (!waive || !waiverReason.trim()) return;
    const updated: ValidationCheck = { ...waive.check, findings: waive.check.findings.map((item) => item.id === waive.finding.id ? { ...item, status: 'waived', waiverReason: waiverReason.trim() } : item), count: Math.max(0, waive.check.count - 1) };
    updated.status = updated.findings.some((item) => item.status === 'open') ? 'warn' : 'pass';
    dispatch({ type: 'UPDATE_VALIDATION', validation: updated }); setSelected(updated); addAudit('validation', '人工豁免验证问题', `${waive.finding.rule} · ${waiverReason}`, 'warning'); notify('豁免已记录', '原因已写入审计，问题没有被删除。', 'warning'); setWaive(null); setWaiverReason('');
  };
  const runEngineering = async (fixtureId: string) => {
    setEngineeringRunning(fixtureId);
    try {
      const result = await runtimeClient.analyzeEngineering({ fixtureId });
      setEngineeringResult(result);
      addAudit('validation', `运行${fixtureId}三阶段工程分析`, `${result.findings.length}项门禁 · ${result.reportHash.slice(0,12)}`, result.passed ? 'success' : 'warning');
      notify('真实工程分析已完成', result.passed ? '解析门禁通过，仍须官方DRC、在线DFM和人工审批。' : `发现 ${result.findings.length} 项阻断或警告。`, result.passed ? 'success' : 'warning');
    } catch (error) {
      const detail=error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : '未知Runtime错误';
      notify('工程分析失败', detail, 'danger'); addAudit('validation', `运行${fixtureId}失败`, detail, 'error');
    } finally { setEngineeringRunning(null); }
  };

  return (
    <>
      <div className="stats-grid stats-grid--4"><Stat label="验证覆盖率" value={`${coverage}%`} hint={`${state.validations.length} 个检查域`} tone={coverage === 100 ? 'success' : 'warning'} /><Stat label="通过" value={passCount} hint="当前无开放问题" tone="success" /><Stat label="警告 / 失败" value={state.validations.filter((item) => item.status === 'warn' || item.status === 'fail').length} hint="需要工程审阅" tone="warning" /><Stat label="开放问题" value={totalOpen} hint="豁免项不计入" tone={totalOpen ? 'danger' : 'success'} /></div>
      <Panel eyebrow="ADVANCED PCB ENGINEERING" title="三阶段工程引擎" meta="真实本机Runtime计算 · 高速数字 / HDI / 2.4GHz RF">
        <div className="validation-grid">{[
          ['HS-USB2-4L','阶段1 · 高速数字','USB2差分、阻抗、时延、串扰和回流路径'],
          ['HDI-BGA-6L','阶段2 · 多层HDI','6层叠层、微孔能力、层切换与BGA逃逸'],
          ['RF-24G-4L','阶段3 · 2.4GHz RF','CPWG、天线禁布、过孔围栏与openEMS交接'],
        ].map(([id,title,description],index)=><button type="button" className="validation-card validation-card--idle" key={id} disabled={Boolean(engineeringRunning)} onClick={()=>runEngineering(id)}><div className="validation-card__index">{String(index+1).padStart(2,'0')}</div><div className="validation-card__icon">{engineeringRunning===id?<Circle/>:<Play/>}</div><div><strong>{title}</strong><small>{description}</small></div><div className="validation-card__state"><Badge tone="info">{engineeringRunning===id?'计算中':'运行样板'}</Badge><span>{id}</span></div></button>)}</div>
        {engineeringResult && <div className="detail-stack"><div className="validation-summary"><Badge tone={engineeringResult.passed?'success':'warning'}>{engineeringResult.passed?'解析门禁通过':'存在阻断项'}</Badge><div><strong>不可变工程报告</strong><p><code>{engineeringResult.reportHash}</code></p></div><span>{engineeringResult.findings.length} 项</span></div><div className="stats-grid stats-grid--4"><Stat label="高速网络" value={engineeringResult.highSpeed.length} hint="解析阻抗与回流检查" tone="info"/><Stat label="HDI转换" value={engineeringResult.hdi.transitions.length} hint="微孔堆叠与层图" tone="info"/><Stat label="RF网络" value={engineeringResult.rf.length} hint="外部仿真证据门禁" tone="info"/><Stat label="受控EDA操作" value={engineeringResult.operations.length} hint="尚未执行，需独立审批" tone="warning"/></div><div className="inline-alert inline-alert--warning"><AlertTriangle size={16}/><span>结果不会自动写入嘉立创EDA。正式生产仍强制要求官方DRC、嘉立创在线DFM和人工审批。</span></div>{engineeringResult.findings.slice(0,8).map((finding)=><div className="finding-detail" key={`${finding.code}-${finding.path}`}><div className="finding-detail__head"><Badge tone="danger">{finding.severity}</Badge><code>{finding.code}</code></div><h3>{finding.message}</h3><div className="detail-block"><span>数据路径</span><strong>{finding.path}</strong></div></div>)}</div>}
      </Panel>
      <Panel eyebrow="VALIDATION PIPELINE" title="工程验证矩阵" meta="Demo 模拟检查，不替代EDA原生报告" actions={<Button variant="primary" icon={<Play size={15} />} loading={running} onClick={runAll}>运行全部检查</Button>}>
        <Progress value={running ? Math.max(8, state.validations.filter((item) => item.status !== 'idle' && item.status !== 'running').length / state.validations.length * 100) : coverage} label={running ? '验证任务进行中' : '本轮检查覆盖'} />
        <div className="validation-grid">{state.validations.map((check, index) => <button type="button" className={`validation-card validation-card--${check.status}`} key={check.id} onClick={() => setSelected(check)}><div className="validation-card__index">{String(index + 1).padStart(2, '0')}</div><div className="validation-card__icon">{check.status === 'pass' ? <CheckCircle2 /> : check.status === 'fail' ? <XCircle /> : check.status === 'warn' ? <AlertTriangle /> : <Circle />}</div><div><strong>{check.name}</strong><small>{check.description}</small></div><div className="validation-card__state"><Badge tone={checkTone(check.status)}>{checkLabel(check.status)}</Badge><span>{check.count} 项</span></div></button>)}</div>
      </Panel>

      <Panel eyebrow="OPEN FINDINGS" title="问题清单" meta="点击问题查看定位、建议与豁免路径">
        <div className="finding-list">{state.validations.flatMap((check) => check.findings.map((finding) => ({ check, finding }))).map(({ check, finding }) => <article className={`finding-row finding-row--${finding.status}`} key={finding.id}><div className="finding-severity"><ShieldAlert size={18} /></div><button type="button" className="finding-row__main" onClick={() => setSelected(check)}><strong>{finding.title}</strong><small><code>{finding.rule}</code> · 对象 {finding.object} · {check.name}</small></button><Badge tone={finding.status === 'waived' ? 'neutral' : finding.severity === 'error' ? 'danger' : 'warning'}>{finding.status === 'waived' ? '已豁免' : finding.severity === 'error' ? '错误' : '警告'}</Badge><Button size="sm" onClick={() => setSelected(check)}>处理</Button></article>)}</div>
      </Panel>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.name || '检查详情'} eyebrow="VALIDATION INSPECTOR" footer={selected && <Button variant="primary" icon={<Play size={15} />} onClick={() => runOne(selected)} disabled={selected.status === 'running'}>{selected.status === 'running' ? '运行中' : `重新运行 ${selected.name}`}</Button>}>
        {selected && <div className="detail-stack"><div className="validation-summary"><Badge tone={checkTone(selected.status)}>{checkLabel(selected.status)}</Badge><div><strong>{selected.name}</strong><p>{selected.description}</p></div><span>{selected.count} 项</span></div>{selected.findings.length ? selected.findings.map((finding) => <div className={`finding-detail finding-detail--${finding.status}`} key={finding.id}><div className="finding-detail__head"><Badge tone={finding.status === 'waived' ? 'neutral' : finding.severity === 'error' ? 'danger' : 'warning'}>{finding.status === 'waived' ? '已豁免' : finding.severity}</Badge><code>{finding.rule}</code></div><h3>{finding.title}</h3><div className="detail-block"><span>设计对象</span><strong>{finding.object}</strong></div><div className="detail-block"><span>修复建议</span><p>{finding.suggestion}</p></div>{finding.waiverReason && <div className="waiver-note"><strong>豁免原因</strong><p>{finding.waiverReason}</p></div>}<div className="row-actions"><Button size="sm" icon={<Crosshair size={14} />} onClick={() => locate(finding)}>在EDA中定位</Button><Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={() => createFix(finding)}>创建AI修复任务</Button>{finding.status === 'open' && <Button size="sm" variant="ghost" onClick={() => { setWaive({ check: selected, finding }); setWaiverReason(''); }}>申请豁免</Button>}</div></div>) : <div className="empty-inline"><CheckCircle2 size={25} /><strong>当前没有问题</strong><span>本检查域处于通过状态。</span></div>}</div>}
      </Drawer>
      <Modal open={Boolean(waive)} onClose={() => setWaive(null)} title="记录验证豁免" eyebrow="ENGINEERING EXCEPTION" footer={<><Button onClick={() => setWaive(null)}>取消</Button><Button variant="primary" onClick={confirmWaiver} disabled={!waiverReason.trim()}>确认豁免并留痕</Button></>}><div className="form-grid"><div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>豁免不会删除问题，只会记录人工接受风险的原因。</span></div><Field label="豁免原因" required hint="至少说明风险接受依据与后续措施"><textarea className="input textarea textarea--large" value={waiverReason} onChange={(e) => setWaiverReason(e.target.value)} placeholder="例如：当前样机仅用于功能验证，Rev.B 将补充保护器件…" /></Field></div></Modal>
    </>
  );
}
