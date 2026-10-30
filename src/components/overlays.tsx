import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Command, Search, X } from 'lucide-react';
import { Button, IconButton } from './ui';
import type { ToastMessage } from '../types';

const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"])';

/**
 * D9 键盘可达性：对话框打开后把焦点移入、Tab/Shift+Tab 在框内循环、Escape 关闭、
 * 关闭后把焦点还给打开它的元素。之前只有 Escape，焦点会留在背后的页面上（Tab 能跑出去）。
 * jsdom 里 offsetParent 恒为 null，因此这里不用可见性过滤，只跳过 disabled/hidden。
 */
function useDialogFocus(open: boolean, ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => {
      const node = ref.current;
      if (!node) return [] as HTMLElement[];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hasAttribute('hidden'));
    };
    const frame = requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      const first = focusables()[0];
      (first ?? node).focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const list = focusables();
      if (!list.length) { event.preventDefault(); node.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !node.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open, onClose, ref]);
}

export function Modal({ open, onClose, title, eyebrow, children, footer, width = '560px' }: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode; width?: string }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(open, dialogRef, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} tabIndex={-1} className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><IconButton label="关闭对话框" onClick={onClose}><X size={18} /></IconButton></header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>, document.body,
  );
}

export function Drawer({ open, onClose, title, eyebrow, children, footer }: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(open, dialogRef, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay overlay--drawer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={dialogRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label={title}>
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
