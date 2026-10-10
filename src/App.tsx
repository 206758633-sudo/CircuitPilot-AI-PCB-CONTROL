import { useEffect } from 'react';
import { Shell } from './components/Shell';
import { useApp } from './state/AppContext';
import type { PageId } from './types';
import { ProjectsPage } from './pages/ProjectsPage';
import { RequirementsPage } from './pages/RequirementsPage';
import { AssetsPage } from './pages/AssetsPage';
import { AiTasksPage } from './pages/AiTasksPage';
import { EdaPage } from './pages/EdaPage';
import { ValidationPage } from './pages/ValidationPage';
import { VersionsPage } from './pages/VersionsPage';
import { SettingsPage } from './pages/SettingsPage';

const pageIds: PageId[] = ['projects', 'requirements', 'assets', 'ai', 'eda', 'validation', 'versions', 'settings'];

function PageRouter() {
  const { state, dispatch } = useApp();
  useEffect(() => {
    const syncHash = () => {
      const page = window.location.hash.replace('#', '') as PageId;
      if (pageIds.includes(page) && page !== state.currentPage) dispatch({ type: 'NAVIGATE', page });
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [dispatch, state.currentPage]);

  const pages: Record<PageId, JSX.Element> = {
    projects: <ProjectsPage />,
    requirements: <RequirementsPage />,
    assets: <AssetsPage />,
    ai: <AiTasksPage />,
    eda: <EdaPage />,
    validation: <ValidationPage />,
    versions: <VersionsPage />,
    settings: <SettingsPage />,
  };
  return pages[state.currentPage];
}

export default function App() {
  return <Shell><PageRouter /></Shell>;
}
