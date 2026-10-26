import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Filter, Plus, Search, Sparkles } from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { Requirement, RequirementStatus } from '../types';
import { Badge, Button, Field, Panel, Progress, SegmentedTabs, Stat, TableFrame } from '../components/ui';
import { Modal } from '../components/overlays';

const statusLabel: Record<RequirementStatus, string> = { confirmed: '已确认', suggested: 'AI建议', missing: '缺失', conflict: '冲突' };
const statusTone: Record<RequirementStatus, 'success' | 'info' | 'warning' | 'danger'> = { confirmed: 'success', suggested: 'info', missing: 'warning', conflict: 'danger' };

export function RequirementsPage() {
  const { state, dispatch, requirementCompleteness, notify, addAudit } = useApp();
  const categories = ['全部', ...Array.from(new Set(state.requirements.map((item) => item.category)))];
  const [category, setCategory] = useState('全部');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ category: '功能', name: '', value: '', unit: '', source: '', note: '', kind: 'hard' as 'hard' | 'soft', blocking: true });

  const visible = useMemo(() => state.requirements.filter((item) => (category === '全部' || item.category === category) && (status === 'all' || item.status === status) && `${item.name} ${item.value} ${item.source}`.toLowerCase().includes(query.toLowerCase())), [state.requirements, category, status, query]);
  const update = (requirement: Requirement, message: string) => {
    dispatch({ type: 'UPDATE_REQUIREMENT', requirement: { ...requirement, updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) } });
    addAudit('requirement', message, `${requirement.name}: ${requirement.value}${requirement.unit}`, 'success');
    notify('约束已更新', message, 'success');
  };
  const create = () => {
    if (!draft.name.trim() || !draft.value.trim()) return;
    const requirement: Requirement = { id: `req-${Date.now()}`, ...draft, status: 'confirmed', updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) };
    dispatch({ type: 'ADD_REQUIREMENT', requirement }); addAudit('requirement', '新增需求约束', requirement.name, 'success'); notify('约束已新增', requirement.name, 'success'); setCreating(false); setDraft({ category: '功能', name: '', value: '', unit: '', source: '', note: '', kind: 'hard', blocking: true });
  };

  return (
    <>
      <div className="stats-grid stats-grid--4"><Stat label="完整度" value={`${requirementCompleteness}%`} hint="仅计入已确认约束" tone={requirementCompleteness >= 75 ? 'success' : 'warning'} /><Stat label="硬约束" value={state.requirements.filter((item) => item.kind === 'hard').length} hint="违反时阻断执行" /><Stat label="待确认建议" value={state.requirements.filter((item) => item.status === 'suggested').length} hint="来自 AI 推断" tone="info" /><Stat label="冲突 / 缺失" value={state.requirements.filter((item) => item.status === 'conflict' || item.status === 'missing').length} hint="需人工决策" tone="danger" /></div>
      <Panel className="requirement-progress" eyebrow="CONSTRAINT COVERAGE" title="设计输入完整度" actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>新增约束</Button>}><Progress value={requirementCompleteness} label="已确认约束占比" /><div className="coverage-note"><AlertTriangle size={16} /><span>AI 只能在已确认的约束边界内规划写入；冲突项不会被静默选择。</span></div></Panel>
      <Panel eyebrow="REQUIREMENT REGISTRY" title="受控需求表" meta={`显示 ${visible.length} / ${state.requirements.length} 条`}>
        <div className="toolbar toolbar--wrap"><SegmentedTabs label="需求分类" value={category} onChange={setCategory} items={categories.map((item) => ({ value: item, label: item }))} /><div className="toolbar__spacer" /><label className="search-box"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称、值或来源" aria-label="搜索需求" /></label><label className="compact-select"><Filter size={14} /><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="筛选需求状态"><option value="all">全部状态</option><option value="confirmed">已确认</option><option value="suggested">AI建议</option><option value="conflict">冲突</option><option value="missing">缺失</option></select></label></div>
        <TableFrame label="受控需求表"><table><thead><tr><th>约束项</th><th>值</th><th>类型</th><th>来源 / 证据</th><th>状态</th><th className="table-actions">操作</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.category} · {item.note}</small></td><td><code>{item.value} {item.unit}</code></td><td><Badge tone={item.kind === 'hard' ? 'warning' : 'neutral'}>{item.kind === 'hard' ? '硬约束' : '软约束'}</Badge>{item.blocking && <small className="blocking-note">阻断项</small>}</td><td>{item.source || '未记录'}</td><td><Badge tone={statusTone[item.status]}>{statusLabel[item.status]}</Badge></td><td className="row-actions"><Button size="sm" onClick={() => setEditing(item)}>编辑</Button>{item.status === 'suggested' && <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => update({ ...item, status: 'confirmed' }, `确认AI建议：${item.name}`)}>确认</Button>}{item.status === 'conflict' && <Button size="sm" variant="danger" onClick={() => setEditing(item)}>解决冲突</Button>}</td></tr>)}</tbody></table></TableFrame>
      </Panel>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.status === 'conflict' ? '解决约束冲突' : '编辑需求约束'} eyebrow="HUMAN DECISION" footer={<><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" onClick={() => { if (editing) { update({ ...editing, status: 'confirmed' }, editing.status === 'conflict' ? `已解决冲突：${editing.name}` : `编辑约束：${editing.name}`); setEditing(null); } }} disabled={!editing?.name.trim() || !editing?.value.trim()}>保存并确认</Button></>}>
        {editing && <div className="form-grid"><div className="inline-alert"><Sparkles size={16} /><span>保存后该值将成为 AI 规划与验证的正式依据。</span></div><Field label="约束名称" required><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="form-row"><Field label="值" required><input className="input" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} /></Field><Field label="单位"><input className="input" value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} /></Field></div><Field label="依据来源"><input className="input" value={editing.source} onChange={(e) => setEditing({ ...editing, source: e.target.value })} /></Field><Field label="决策说明"><textarea className="input textarea" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field></div>}
      </Modal>

      <Modal open={creating} onClose={() => setCreating(false)} title="新增需求约束" eyebrow="NEW CONSTRAINT" footer={<><Button onClick={() => setCreating(false)}>取消</Button><Button variant="primary" onClick={create} disabled={!draft.name.trim() || !draft.value.trim()}>加入约束基线</Button></>}>
        <div className="form-grid"><div className="form-row"><Field label="分类"><select className="input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{categories.filter((item) => item !== '全部').map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="约束类型"><select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'hard' | 'soft' })}><option value="hard">硬约束</option><option value="soft">软约束</option></select></Field></div><Field label="约束名称" required><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><div className="form-row"><Field label="值" required><input className="input" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /></Field><Field label="单位"><input className="input" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></Field></div><Field label="依据来源"><input className="input" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></Field><Field label="备注"><textarea className="input textarea" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></Field></div>
      </Modal>
    </>
  );
}
