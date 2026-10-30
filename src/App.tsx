import { useEffect, useState } from 'react';
import { Shell, type ShellPage } from './components/Shell';
import { useApp } from './state/AppContext';
import type { PageId } from './types';
import { OverviewPage } from './pages/OverviewPage';
import { DesignPage, type DesignTab } from './pages/DesignPage';
import { ExecutionPage } from './pages/ExecutionPage';
import { DeliverPage, type DeliverTab } from './pages/DeliverPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { VersionsPage } from './pages/VersionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutomationPage } from './pages/AutomationPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { logger } from './utils/logger';
import { CANONICAL_PAGES, DESIGN_TABS, LEGACY_ALIASES, VALIDATION_TABS } from './navigation';

type Route = { page: PageId; tab?: string };

// D6：路由别名与页签集合来自 `src/navigation.ts` 单一事实源（导航/路由/页面职责不再各写一份）。
const canonicalPages = new Set<PageId>(CANONICAL_PAGES);

function resolvePage(page: PageId): Route {
  const legacy = LEGACY_ALIASES[page];
  if (legacy) return legacy;
  if (canonicalPages.has(page)) return { page };
  return { page: 'overview' };
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [head, tab] = raw.split('/');
  const legacy = LEGACY_ALIASES[head];
  if (legacy) return legacy;
  if (head === 'design') return { page: 'design', tab: DESIGN_TABS.includes(tab as never) ? tab : 'chat' };
  if (head === 'validation') return { page: 'validation', tab: VALIDATION_TABS.includes(tab as never) ? tab : 'verify' };
  if (canonicalPages.has(head as PageId)) return { page: head as PageId };
  return { page: 'overview' };
}

function canonicalHash(route: Route): string {
  // 有页签的页面统一输出 #page/tab；默认页签（design/chat、validation/verify）保持短 hash。
  if (route.page === 'design' && route.tab && route.tab !== 'chat') return `#design/${route.tab}`;
  if (route.page === 'validation' && route.tab && route.tab !== 'verify') return `#validation/${route.tab}`;
  return `#${route.page}`;
}

export default function App() {
  const { state, dispatch } = useApp();
  const [route, setRoute] = useState<Route>(() => (
    window.location.hash ? parseHash(window.location.hash) : resolvePage(state.currentPage)
  ));

  useEffect(() => {
    const sync = () => {
      const next = parseHash(window.location.hash);
      logger.info('Navigation', `Route ${next.page}${next.tab ? '/' + next.tab : ''}`);
      setRoute(next);
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    if (state.currentPage !== route.page) dispatch({ type: 'NAVIGATE', page: route.page });
    const parsed = window.location.hash ? parseHash(window.location.hash) : null;
    const canonical = canonicalHash(route);
    if (!parsed || parsed.page !== route.page || parsed.tab !== route.tab) {
      window.history.replaceState(null, '', canonical);
    }
  // 只在路由变化时归一化 hash：该 effect 不能依赖 state.currentPage，
  // 否则 dispatch(NAVIGATE) 会先于 hashchange 触发，用旧 route 把新 hash 改回去。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const shellPage: ShellPage = route.page === 'projects' ? 'projects' : route.page as ShellPage;

  return (
    <Shell page={shellPage} tab={route.tab}>
      {route.page === 'overview' && <OverviewPage />}
      {route.page === 'projects' && <ProjectsPage />}
      {route.page === 'design' && <DesignPage tab={(route.tab as DesignTab) || 'chat'} />}
      {route.page === 'eda' && <ExecutionPage />}
      {route.page === 'automation' && <AutomationPage />}
      {route.page === 'validation' && <DeliverPage tab={((route.tab as DeliverTab) || 'verify')} />}
      {route.page === 'knowledge' && <KnowledgePage />}
      {route.page === 'versions' && <VersionsPage />}
      {route.page === 'settings' && <SettingsPage />}
    </Shell>
  );
}
