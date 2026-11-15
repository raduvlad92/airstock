import type { ReactNode } from 'react';
import { errorMessage } from '../api.ts';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      {title || actions ? (
        <div className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="notice error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' }) {
  return <p className={`notice ${tone}`}>{children}</p>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted loading">{label}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children, inside the label.
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={t.id === value ? 'tab active' : 'tab'}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function titleCase(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A decimal string from the API (up to 6 places) for display, without float rounding: trailing
 * zeros are dropped, keeping at least `minScale` places.
 */
export function formatDecimal(value: string | null | undefined, minScale = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const [whole, fraction = ''] = value.split('.');
  let digits = fraction.replace(/0+$/, '');
  if (digits.length < minScale) digits = digits.padEnd(minScale, '0');
  return digits ? `${whole}.${digits}` : (whole ?? value);
}
