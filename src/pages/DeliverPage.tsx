import { ValidationPage } from './ValidationPage';
import { RuleCenterPage } from './RuleCenterPage';
import { PlacementPage } from './PlacementPage';
import { VerificationCenterPage } from './VerificationCenterPage';
import { KnowledgePage } from './KnowledgePage';
import { useApp } from '../state/AppContext';

export type DeliverTab = 'verify' | 'placement' | 'rules' | 'verification' | 'knowledge';

const tabs: Array<{ id: DeliverTab; label: string }> = [
  { id: 'verify', label: '检查与问题' },
  { id: 'placement', label: '布局微调' },
  { id: 'rules', label: '规则中心' },
  { id: 'verification', label: '验证中心（门禁）' },
  { id: 'knowledge', label: '知识库' },
];

export function DeliverPage({ tab }: { tab: DeliverTab }) {
  const { state } = useApp();
  const active: DeliverTab = tab === 'placement' ? 'placement' : tab === 'rules' ? 'rules' : tab === 'verification' ? 'verification' : tab === 'knowledge' ? 'knowledge' : 'verify';
  const openFindings = state.validations.reduce((sum, item) => sum + item.findings.filter((finding) => finding.status === 'open').length, 0);
  const go = (next: DeliverTab) => {
    window.location.hash = next === 'verify' ? 'validation' : `validation/${next}`;
  };

  return (
    <div>
      <div className="page-tabs" role="tablist" aria-label="验证与交付">
        {tabs.map((item) => (
          <button type="button" role="tab" aria-selected={active === item.id} key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => go(item.id)}>
            {item.label}{item.id === 'verify' && <span className="tab-count">{state.validations.length}</span>}
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
