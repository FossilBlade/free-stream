import type { ReactNode, SyntheticEvent } from 'react';
import { Focusable, type ScrollMode } from './Focusable';

export function Button({
  children,
  icon,
  variant = 'secondary',
  onSelect,
  focusKey,
  disabled,
  scroll,
  className,
}: {
  children?: ReactNode;
  icon?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  onSelect?: () => void;
  focusKey?: string;
  disabled?: boolean;
  scroll?: ScrollMode;
  className?: string;
}) {
  return (
    <Focusable focusKey={focusKey} onSelect={onSelect} disabled={disabled} scroll={scroll} className={`btn btn-${variant}${children ? '' : ' btn-icon'}${className ? ' ' + className : ''}`}>
      {icon}
      {children && <span>{children}</span>}
    </Focusable>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
      {label && <p className="muted">{label}</p>}
    </div>
  );
}

export function Message({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="message">
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
      {action && <div className="message-action">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'good' | 'ok' | 'risky' | 'accent' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress">
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** Hide an <img> that failed to load so the gradient placeholder behind it shows instead. */
export const hideBroken = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = 'hidden';
};
