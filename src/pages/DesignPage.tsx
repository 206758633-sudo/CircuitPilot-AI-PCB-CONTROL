import { AiTasksPage } from './AiTasksPage';
import { RequirementsPage } from './RequirementsPage';
import { PartProposalPage } from './PartProposalPage';
import { AssetsPage } from './AssetsPage';
import { useApp } from '../state/AppContext';

export type DesignTab = 'chat' | 'req' | 'select' | 'assets';

const tabs: Array<{ id: DesignTab; label: string }> = [
  { id: 'chat', label: 'AI 对话' },
  { id: 'req', label: '需求约束' },
  { id: 'select', label: '元件选型' },
  { id: 'assets', label: '资料与 BOM' },
];

export function DesignPage({ tab }: { tab: DesignTab }) {
  const { state, openRiskCount } = useApp();
  const confirmed = state.requirements.filter((item) => item.status === 'confirmed').length;
  const suggestions = state.requirements.filter((item) => item.status === 'suggested').length;
  const counts: Record<DesignTab, number | undefined> = {
    chat: undefined,
    req: state.requirements.length,
    select: state.components.length,
    assets: state.assets.length,
  };
  const go = (next: DesignTab) => { window.location.hash = `design/${next}`; };
  const active: DesignTab = tabs.some((item) => item.id === tab) ? tab : 'chat';

  return (
    <div className={`design-pane design-pane--${active}`}>
      <div className="page-tabs" role="tablist" aria-label="AI 设计工作区">
        {tabs.map((item) => (
          <button type="button" role="tab" aria-selected={active === item.id} key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => go(item.id)}>
            {item.label}{counts[item.id] !== undefined && <span className="tab-count">{counts[item.id]}</span>}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5, paddingBottom: 8 }}>
          需求 {confirmed}/{state.requirements.length} 已确认{suggestions ? ` · ${suggestions} 条建议待确认` : ''}{openRiskCount ? ` · ${openRiskCount} 项风险` : ''}
        </span>
      </div>
      {active === 'chat' && <AiTasksPage />}
      {active === 'req' && <RequirementsPage />}
      {active === 'select' && <PartProposalPage />}
      {active === 'assets' && <AssetsPage />}
    </div>
  );
}
