import { useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import type { Tone } from '../types';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className = '', children, type = 'button', disabled, ...props }: ButtonProps) {
  const disabledState = disabled || loading;
  return (
    <button type={type} className={`button button--${variant} button--${size} ${className}`} {...props} disabled={disabledState} title={props.title || (disabledState ? '当前条件下不可用或正在处理中' : undefined)}>
      {loading ? <LoaderCircle className="spin" size={15} aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className = '', type = 'button', ...props }: IconButtonProps) {
  return <button type={type} className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, eyebrow, meta, actions, children, className = '', ...props }: PanelProps) {
  return (
    <section className={`panel ${className}`} {...props}>
      {(title || eyebrow || meta || actions) && (
        <header className="panel__header">
          <div className="panel__heading">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h2>{title}</h2>}
            {meta && <div className="panel__meta">{meta}</div>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return <div className={`stat stat--${tone}`}><div className="stat__label">{label}</div><div className="stat__value">{value}</div>{hint && <div className="stat__hint">{hint}</div>}</div>;
}

export function Field({ label, hint, error, children, required }: { label: string; hint?: string; error?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className={`field ${error ? 'field--error' : ''}`}>
      <span className="field__label">{label}{required && <span aria-hidden> *</span>}</span>
      {children}
      {(error || hint) && <span className="field__hint">{error || hint}</span>}
    </label>
  );
}

export function SelectField({ label, hint, children, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; children: ReactNode }) {
  return <Field label={label} hint={hint}><select className={`input ${className}`} {...props}>{children}</select></Field>;
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <button type="button" className="toggle-row" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} disabled={disabled}>
      <span className="toggle-row__copy"><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <span className={`switch ${checked ? 'is-on' : ''}`} aria-hidden><span /></span>
    </button>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div className="progress-wrap">
      {label && <div className="progress-label"><span>{label}</span><span>{normalized}%</span></div>}
      <div className="progress" role="progressbar" aria-label={label || '进度'} aria-valuenow={normalized} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${normalized}%` }} /></div>
    </div>
  );
}

export function SegmentedTabs({ items, value, onChange, label }: { items: Array<{ value: string; label: string; count?: number }>; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {items.map((item) => <button type="button" role="tab" aria-selected={item.value === value} className={item.value === value ? 'is-active' : ''} key={item.value} onClick={() => onChange(item.value)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}
    </div>
  );
}

export function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

interface CopyValueProps {
  value: string;
  label: string;
  /** 界面展示内容，默认展示完整 value；长路径建议传完整值让 CSS 折行。 */
  display?: ReactNode;
  className?: string;
}

/**
 * 长路径 / 哈希 / Job ID 的只读值：等宽展示 + 一键复制。
 * 复制失败不静默：立即回退到 textarea + execCommand，再失败才提示不可复制（aria-live 告知）。
 */
export function CopyValue({ value, label, display, className = '' }: CopyValueProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      } catch {
        ok = false;
      }
    }
    setState(ok ? 'copied' : 'failed');
    window.setTimeout(() => setState('idle'), ok ? 1600 : 2600);
  };

  return (
    <span className={`copy-value ${className}`.trim()}>
      <code title={value} className="copy-value__text">{display ?? value}</code>
      <button
        type="button"
        className={`copy-value__button ${state === 'copied' ? 'is-copied' : ''} ${state === 'failed' ? 'is-failed' : ''}`}
        onClick={() => void copy()}
        aria-label={`复制${label}`}
        title={state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请手动选择文本' : `复制${label}`}
      >
        {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">{state === 'copied' ? `${label}已复制` : state === 'failed' ? `${label}复制失败` : ''}</span>
    </span>
  );
}
