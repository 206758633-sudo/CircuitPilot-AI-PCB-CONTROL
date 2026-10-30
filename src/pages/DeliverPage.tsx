import { ValidationPage } from './ValidationPage';
import { RuleCenterPage } from './RuleCenterPage';
import { PlacementPage } from './PlacementPage';
import { VerificationCenterPage } from './VerificationCenterPage';
import { KnowledgePage } from './KnowledgePage';
import { useApp } from '../state/AppContext';
import { officialValidationsForProject } from '../services/validationEvidence';

export type DeliverTab = 'verify' | 'placement' | 'rules' | 'verification' | 'knowledge';

const tabs: Array<{ id: DeliverTab; label: string }> = [
  { id: 'verify', label: '检查与问题' },
  { id: 'placement', label: '布局微调' },
  { id: 'rules', label: '规则中心' },
  { id: 'verification', label: '验证中心（门禁）' },
  { id: 'knowledge', label: '知识库' },
];

export function DeliverPage({ tab }: { tab: DeliverTab }) {
  const { state, activeProject } = useApp();
  const active: DeliverTab = tab === 'placement' ? 'placement' : tab === 'rules' ? 'rules' : tab === 'verification' ? 'verification' : tab === 'knowledge' ? 'knowledge' : 'verify';
  // P0-3/P1-13：页签角标只统计「当前项目 + 官方 ERC/DRC」的未收口发现；种子/Demo/他项目一律不冒充"待收口"。
  const officialOpenFindings = officialValidationsForProject(state.validations, activeProject?.id);
  const openFindings = officialOpenFindings.reduce((sum, item) => sum + item.findings.filter((finding) => finding.status === 'open').length, 0);
  const officialRanCount = officialOpenFindings.filter((item) => item.status !== 'idle').length;
  const go = (next: DeliverTab) => {
    window.location.hash = next === 'verify' ? 'validation' : `validation/${next}`;
  };

  return (
    <div>
      <div className="page-tabs" role="tablist" aria-label="验证与交付">
        {tabs.map((item) => (
          <button type="button" role="tab" aria-selected={active === item.id} key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => go(item.id)}>
            {item.label}{item.id === 'verify' && <span className="tab-count" title={`本项目官方检查已运行 ${officialRanCount} 项 · 未收口发现 ${openFindings} 条`}>{openFindings}</span>}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: openFindings ? 'var(--yellow)' : 'var(--muted)', fontSize: 11.5, paddingBottom: 8 }}>
          {openFindings ? `${openFindings} 个检查发现待收口` : '当前没有未收口发现'}
        </span>
      </div>
      {active === 'verify' ? <ValidationPage /> : active === 'placement' ? <PlacementPage /> : active === 'verification' ? <VerificationCenterPage /> : active === 'knowledge' ? <KnowledgePage /> : <RuleCenterPage />}
    </div>
  );
}
