import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, CheckCheck, CircuitBoard, FolderKanban, History, LayoutGrid, ListChecks, PauseCircle, Search, Settings, Sparkles, Workflow } from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { PageId } from '../types';
import { Badge } from './ui';
import { CommandPalette, ToastViewport, type PaletteCommand } from './overlays';
import { NAV_ITEMS, NAV_SHORTCUTS, PAGE_RESPONSIBILITIES } from '../navigation';

export type NavPage = Extract<PageId, 'overview' | 'design' | 'eda' | 'automation' | 'validation' | 'knowledge' | 'versions' | 'settings'>;
export type ShellPage = NavPage | 'projects';

/** D6：导航数据来自 `src/navigation.ts` 单一事实源；这里只补图标。 */
const NAV_ICONS: Record<NavPage, typeof FolderKanban> = {
  overview: FolderKanban,
  design: Sparkles,
  eda: CircuitBoard,
  automation: Workflow,
  validation: CheckCheck,
  knowledge: BookOpen,
  versions: History,
  settings: Settings,
};

const navItems = NAV_ITEMS.map((item) => ({ ...item, icon: NAV_ICONS[item.id] }));

/** D6：一级快捷入口的图标（入口是"页面 + 页签"，不是新页面）。 */
const SHORTCUT_ICONS: Record<string, typeof FolderKanban> = {
  projects: FolderKanban,
  requirements: ListChecks,
  placement: LayoutGrid,
};
const shortcutItems = NAV_SHORTCUTS.map((item) => ({ ...item, icon: SHORTCUT_ICONS[item.id] ?? FolderKanban }));

function modeMeta(mode: string, writePaused: boolean) {
  if (mode === 'real_read_only') return { flag: 'REAL READ ONLY · 真实只读', tone: 'info' as const, badge: '真实只读' };
  if (mode === 'controlled_write' && !writePaused) return { flag: 'CONTROLLED WRITE · 受控写入', tone: 'success' as const, badge: '受控写入' };
  if (writePaused) return { flag: 'WRITE PAUSED · 写入已暂停', tone: 'warning' as const, badge: '写入已暂停' };
  return { flag: 'DEMO MODE · 模拟控制', tone: 'warning' as const, badge: 'DEMO 数据' };
}

export function Shell({ page, tab, children }: { page: ShellPage; tab?: string; children: ReactNode }) {
  const { state, activeProject, openIssueCount, navigate, toasts } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const writePaused = state.settings.writePaused || state.eda.writePaused;
  const mode = modeMeta(state.runtime.mode, writePaused);
  const meta = PAGE_RESPONSIBILITIES[page] ?? PAGE_RESPONSIBILITIES.overview;

  const aiLabel = state.settings.providerReady ? (state.settings.provider === 'demo' ? 'AI · 演示模式' : 'AI · 已连接') : 'AI · 未配置';
  const aiProviderLabel = state.settings.provider === 'demo' ? '演示模式' : (state.runtime.providers.find((item) => item.id === state.settings.provider)?.label || state.settings.provider);
  const aiProviderHint = `${aiProviderLabel}${state.settings.model && state.settings.model !== 'auto' ? ` · ${state.settings.model}` : ''}${state.settings.provider !== 'demo' && state.settings.baseUrl ? ' · 自定义Base URL' : ''}`;
  const edaLabel = state.runtime.mode === 'demo' ? 'EDA · 演示数据' : state.eda.connected ? `EDA 已连接 :${state.eda.port}` : 'EDA 未连接';
  const gateLabel = writePaused ? '写入门禁 · 已暂停' : state.task.mode === 'read_only' ? '写入门禁 · 只读' : '写入门禁 · 需批准';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => [
    ...navItems.map((item) => ({ id: item.id, label: `打开${item.label}`, hint: item.hint, action: () => navigate(item.id) })),
    ...shortcutItems.map((item) => ({ id: `shortcut-${item.id}`, label: `打开${item.label}`, hint: item.hint, action: () => navigate(item.page, item.tab) })),
    { id: 'new-ai', label: '开始 AI 需求对话', hint: '让 AI 追问并补齐 PCBA 输入', action: () => { window.location.hash = 'design/chat'; } },
    { id: 'check-eda', label: '检查 EDA 环境', hint: '进入受控执行页', action: () => navigate('eda') },
    { id: 'run-validation', label: '去验证与交付', hint: '运行 ERC / DRC / DFM', action: () => navigate('validation') },
    { id: 'open-settings', label: '打开系统设置', hint: 'AI Provider / Runtime / 安全策略', action: () => navigate('settings') },
  ], [navigate]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主内容</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark"><CircuitBoard size={19} /></div>
          <div><strong>CircuitPilot</strong><span>AI PCB CONTROL</span></div>
        </div>

        <button
          type="button"
          className="project-switch"
          data-testid="project-switch"
          onClick={() => navigate('projects')}
          title="打开项目与工程资料（新建 / 切换 / 归档）"
          aria-label={`切换项目：${activeProject?.name ?? '未选择项目'}，阶段 ${activeProject?.stage ?? '—'}，进度 ${activeProject?.progress ?? 0}%`}
        >
          <strong>{activeProject?.name ?? '未选择项目'}</strong>
          <span className="ps-arrow">→</span>
          <small>{activeProject?.code ?? 'NO PROJECT'} · {activeProject?.stage ?? '—'}</small>
          <span className="ps-progress"><i style={{ width: `${activeProject?.progress ?? 0}%` }} /></span>
        </button>

        <div className={`demo-flag demo-flag--${state.runtime.mode}`}><span className="signal-dot" /> {mode.flag}</div>

        <nav className="nav" aria-label="主导航">
          <div className="nav__label">WORKSPACE</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const critical = (item.id === 'versions' && openIssueCount > 0) || (item.id === 'validation' && state.validations.some((entry) => entry.findings.some((finding) => finding.status === 'open')));
            return (
              <button
                type="button"
                key={item.id}
                data-testid={`nav-${item.id}`}
                className={[active ? 'is-active' : '', critical ? 'is-critical' : ''].filter(Boolean).join(' ')}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <span className="nav__icon"><Icon size={17} /></span>
                <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                {item.id === 'versions' && openIssueCount > 0 ? <span className="nav__count">{openIssueCount}</span> : <span className="nav__rail" />}
              </button>
            );
          })}
        </nav>

        <nav className="nav nav--shortcuts" aria-label="快捷入口">
          <div className="nav__label">SHORTCUTS</div>
          {shortcutItems.map((item) => {
            const Icon = item.icon;
            const active = item.page === page && (item.tab ? item.tab === tab : true);
            return (
              <button type="button" key={item.id} data-testid={`nav-${item.id}`} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined} onClick={() => navigate(item.page, item.tab)}>
                <span className="nav__icon"><Icon size={17} /></span>
                <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                <span className="nav__rail" />
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <div className="mini-status">
            <span className={state.eda.connected ? 'status-light status-light--on' : 'status-light'} />
            <span><strong>本地 Runtime</strong><small>{state.runtime.reachable ? `已连接 · v${state.runtime.serviceVersion ?? '—'}` : '演示模式 · 未连接'}</small></span>
          </div>
          <button type="button" className="button button--ghost button--sm" onClick={() => navigate('settings')}><PauseCircle size={14} /><span>{writePaused ? '写入已暂停' : '写入策略'}</span></button>
          <button type="button" data-testid="nav-settings" className="button button--ghost button--sm" onClick={() => navigate('settings')}><Settings size={14} /><span>系统设置</span></button>
        </div>
      </aside>

      <div className="workspace">
        <header className="status-bus">
          <div className="status-bus__items" role="status" aria-label="运行状态与会话状态">
            <div className="status-bus__project"><span className="project-code">{activeProject?.code ?? 'NO PROJECT'}</span><strong>{activeProject?.name ?? '未选择项目'}</strong></div>
            <span className={`chip ${state.settings.providerReady ? 'chip--ok' : 'chip--warn'}`} title={`AI后端：${aiProviderHint}`}><span className="dot" />{aiLabel}</span>
            <span className={`chip ${state.eda.connected ? 'chip--ok' : 'chip--warn'}`} title="EDA 连接状态：断开时所有写入都会被门禁拒绝"><span className="dot" />{edaLabel}</span>
            <span className={`chip ${writePaused ? 'chip--warn' : 'chip--ok'}`} title="所有写入都需要计划哈希 + 一次性批准令牌 + 快照"><span className="dot" />{gateLabel}</span>
            <button type="button" className="chip" onClick={() => navigate('versions')}>
              <span className={`dot ${openIssueCount ? 'chip--warn-dot' : 'chip--ok'}`} />
              {openIssueCount ? `${openIssueCount} 个运行问题待处理` : '无待处理运行问题'}
            </button>
          </div>
          <button type="button" className="command-trigger" onClick={() => setPaletteOpen(true)} aria-label="打开快速指令">
            <Search size={14} /><span>快速指令</span><kbd>⌘K</kbd>
          </button>
        </header>

        <main className="main" id="main-content" tabIndex={-1}>
          <header className="page-head">
            <div className="page-head__copy">
              <h1>{meta.title}</h1>
              <p>{meta.description}</p>
            </div>
            <div className="page-head__state">
              <Badge tone={mode.tone}>{mode.badge}</Badge>
              <span>最后保存 {new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </header>

          <div className="page-content">{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ToastViewport toasts={toasts} />
    </div>
  );
}
