// Shared low-level primitives. One file because they're each tiny and
// always imported together — splitting just adds noise.

import type { ReactNode } from 'react';

// Card — the surface every chunk of content sits on.
export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

// StatusPill — coloured dot + label. Use the `tone` prop, not raw colours.
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE_CLS: Record<Tone, { dot: string; pill: string }> = {
  success: { dot: 'bg-success', pill: 'border-success/30 text-success/90 bg-success/10' },
  warning: { dot: 'bg-warning', pill: 'border-warning/30 text-warning/90 bg-warning/10' },
  danger:  { dot: 'bg-danger',  pill: 'border-danger/30 text-danger/90 bg-danger/10' },
  info:    { dot: 'bg-primary', pill: 'border-primary/30 text-primary/90 bg-primary/10' },
  neutral: { dot: 'bg-text-muted', pill: 'border-border text-text-secondary bg-surface-elevated' },
};
export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE_CLS[tone];
  return (
    <span className={`pill ${t.pill}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

// Skeleton — loading placeholder. Always prefer over a spinner for content.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

// EmptyState — illustrated empty content. Pass illustration + title + body.
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      {icon && <div className="mb-4 text-text-muted">{icon}</div>}
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {body && <p className="mt-1 text-sm text-text-secondary max-w-md">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
