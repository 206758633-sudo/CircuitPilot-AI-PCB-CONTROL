import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Command, Search, X } from 'lucide-react';
import { Button, IconButton } from './ui';
import type { ToastMessage } from '../types';

export function Modal({ open, onClose, title, eyebrow, children, footer, width = '560px' }: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><IconButton label="关闭对话框" onClick={onClose}><X size={18} /></IconButton></header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>, document.body,
  );
}

export function Drawer({ open, onClose, title, eyebrow, children, footer }: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay overlay--drawer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><IconButton label="关闭抽屉" onClick={onClose}><X size={18} /></IconButton></header>
        <div className="drawer__body">{children}</div>{footer && <footer className="modal__footer">{footer}</footer>}
      </aside>
    </div>, document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = '确认', danger }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; description: ReactNode; confirmLabel?: string; danger?: boolean }) {
  return <Modal open={open} onClose={onClose} title={title} eyebrow="需要人工确认" footer={<><Button onClick={onClose}>取消</Button><Button variant={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button></>}><div className="dialog-copy">{description}</div></Modal>;
}

export function ToastViewport({ toasts }: { toasts: ToastMessage[] }) {
  return createPortal(<div className="toast-viewport" aria-live="polite">{toasts.map((toast) => <div className={`toast toast--${toast.tone}`} key={toast.id}><CheckCircle2 size={17} aria-hidden /><span>{toast.message}</span></div>)}</div>, document.body);
}

export interface PaletteCommand { id: string; label: string; hint: string; action: () => void }

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: PaletteCommand[] }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const results = commands.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="快速指令" eyebrow="COMMAND PALETTE" width="640px">
      <div className="command-search"><Search size={18} aria-hidden /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面或动作…" aria-label="搜索快速指令" /><kbd>ESC</kbd></div>
      <div className="command-list">
        {results.map((item) => <button type="button" key={item.id} onClick={() => { item.action(); onClose(); }}><Command size={16} aria-hidden /><span><strong>{item.label}</strong><small>{item.hint}</small></span><span className="command-arrow">↵</span></button>)}
        {!results.length && <div className="command-empty">没有匹配的指令</div>}
      </div>
    </Modal>
  );
}
