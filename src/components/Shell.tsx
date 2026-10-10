import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bot,
  Box,
  Braces,
  CheckCheck,
  CircuitBoard,
  ClipboardList,
  FolderKanban,
  History,
  PauseCircle,
  Search,
  Settings,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { PageId } from '../types';
import { Badge, Button } from './ui';
import { CommandPalette, ToastViewport, type PaletteCommand } from './overlays';

const navItems: Array<{ id: PageId; label: string; hint: string; icon: typeof Box }> = [
  { id: 'projects', label: '项目总览', hint: 'PROJECTS', icon: FolderKanban },
  { id: 'requirements', label: '需求约束', hint: 'REQUIREMENTS', icon: ClipboardList },
  { id: 'assets', label: '资料与 BOM', hint: 'ASSETS', icon: Box },
  { id: 'ai', label: 'AI 对话', hint: 'REAL CODEX CHAT', icon: Bot },
  { id: 'eda', label: 'EDA 控制', hint: 'BRIDGE', icon: CircuitBoard },
  { id: 'validation', label: '验证中心', hint: 'ERC / DRC', icon: CheckCheck },
  { id: 'versions', label: '版本、日志与问题', hint: 'TRACEABILITY', icon: History },
  { id: 'settings', label: '系统设置', hint: 'CONFIG', icon: Settings },
];

const pageMeta: Record<PageId, { index: string; title: string; description: string }> = {
  projects: { index: '01', title: '项目总览', description: '建立工程边界，观察当前设计阶段与风险状态。' },
  requirements: { index: '02', title: '需求约束', description: '把自然语言转成可验证、可追溯的硬件约束。' },
  assets: { index: '03', title: '资料与 BOM', description: '维护正式依据、元件清单、替代料与证据链。' },
  ai: { index: '04', title: 'AI 需求对话', description: '使用真实Codex账号，通过连续追问补齐PCBA设计输入。' },
  eda: { index: '05', title: 'EDA 控制', description: '检查本机环境、权限与嘉立创EDA桥接状态。' },
  validation: { index: '06', title: '验证中心', description: '统一运行 ERC、DRC、网表、封装与制造检查。' },
  versions: { index: '07', title: '版本、日志与问题', description: '比较快照、查看字段修改、处理持久化问题与审计事件。' },
  settings: { index: '08', title: '系统设置', description: '配置真实 AI Provider、本机Runtime、安全策略与凭据。' },
};

export function Shell({ children }: { children: ReactNode }) {
  const { state, activeProject, navigate, notify, toasts, openIssueCount } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const meta = pageMeta[state.currentPage];
  const modeMeta = state.runtime.mode === 'real_read_only'
    ? { flag: 'REAL READ ONLY · 真实只读', badge: '真实只读', tone: 'info' as const }
    : state.runtime.mode === 'controlled_write'
      ? { flag: 'CONTROLLED WRITE · 受控写入', badge: '受控写入', tone: 'success' as const }
      : { flag: 'DEMO MODE · 模拟控制', badge: 'DEMO 数据', tone: 'warning' as const };

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
    { id: 'new-ai', label: '开始 AI 需求对话', hint: '让Codex追问并补齐PCBA输入', action: () => navigate('ai') },
    { id: 'check-eda', label: '检查 EDA 环境', hint: '进入桥接诊断页', action: () => { navigate('eda'); notify('已定位', '请点击“运行全量检查”启动诊断。', 'info'); } },
  ], [navigate, notify]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark"><CircuitBoard size={21} /></div>
          <div><strong>CircuitPilot</strong><span>AI PCB CONTROL</span></div>
        </div>
        <div className={`demo-flag demo-flag--${state.runtime.mode}`}><span className="signal-dot" /> {modeMeta.flag}</div>
        <nav className="nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button type="button" key={item.id} data-testid={`nav-${item.id}`} className={state.currentPage === item.id ? 'is-active' : ''} onClick={() => navigate(item.id)}>
                <span className="nav__icon"><Icon size={17} /></span>
                <span><strong>{item.label}{item.id === 'versions' && openIssueCount > 0 ? ` · ${openIssueCount}` : ''}</strong><small>{item.hint}</small></span>
                <span className="nav__rail" />
              </button>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <div className="mini-status"><span className={state.eda.connected ? 'status-light status-light--on' : 'status-light'} /><span><strong>本地桥接</strong><small>{state.eda.connected ? `127.0.0.1:${state.eda.port}` : '未连接'}</small></span></div>
          <Button variant="ghost" size="sm" icon={<PauseCircle size={15} />} onClick={() => navigate('settings')}>{state.settings.writePaused ? '写入已暂停' : '写入策略'}</Button>
        </div>
      </aside>

      <div className="workspace">
        <header className="status-bus">
          <div className="window-dots" aria-hidden><span /><span /><span /></div>
          <div className="status-bus__items">
            <div><small>ACTIVE PROJECT</small><strong>{activeProject?.code || 'NO PROJECT'}</strong></div>
            <div><small>AI PROVIDER</small><strong className={state.settings.providerReady ? 'text-success' : 'text-warning'}>{state.settings.providerReady ? state.settings.provider === 'demo' ? 'READY · DEMO' : 'READY · REAL' : 'OFFLINE'}</strong></div>
            <div><small>EDA BRIDGE</small><strong className={state.eda.connected ? 'text-success' : 'text-warning'}>{state.eda.connected ? 'CONNECTED' : 'DISCONNECTED'}</strong></div>
            <div><small>WRITE GATE</small><strong className={state.settings.writePaused || state.eda.writePaused ? 'text-warning' : ''}>{state.settings.writePaused || state.eda.writePaused ? 'PAUSED' : state.task.mode === 'read_only' ? 'READ ONLY' : 'APPROVAL'}</strong></div>
            <div role="button" tabIndex={0} onClick={() => navigate('versions')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate('versions'); }}><small>OPEN ISSUES</small><strong className={openIssueCount ? 'text-warning' : 'text-success'}>{openIssueCount ? `${openIssueCount} UNRESOLVED` : '0 HEALTHY'}</strong></div>
          </div>
          <button type="button" className="command-trigger" onClick={() => setPaletteOpen(true)} aria-label="打开快速指令"><Search size={14} /><span>快速指令</span><kbd>⌘ K</kbd></button>
        </header>

        <main className="main">
          <header className="page-head">
            <div className="page-number">{meta.index}</div>
            <div className="page-head__copy"><div className="eyebrow">CONTROL WORKSPACE / {meta.index}</div><h1>{meta.title}</h1><p>{meta.description}</p></div>
            <div className="page-head__state"><Badge tone={modeMeta.tone}>{modeMeta.badge}</Badge><span>最后保存 {new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div>
          </header>
          <div className="page-content">{children}</div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ToastViewport toasts={toasts} />
    </div>
  );
}
