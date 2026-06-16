import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw, Save } from 'lucide-react';

import { listFlags, listSnapshots, rollbackSnapshot, updateFlag, type Flag } from '@/api/flags';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { useProMode } from '@/store/proMode';
import { usePermission } from '@/auth/usePermission';

// FlagsPage: grouped by category. Each card has an inline editor that
// matches the flag's data type. Saving opens a confirmation modal first.

type Pending = {
  key: string;
  next: unknown;
  before: unknown;
  flag: Flag;
} | null;

export function FlagsPage() {
  const proMode = useProMode((s) => s.enabled);
  const qc = useQueryClient();
  const flagsQ = useQuery({ queryKey: ['flags'], queryFn: listFlags });
  const [pending, setPending] = useState<Pending>(null);
  const [snapsOpen, setSnapsOpen] = useState(false);
  const canUpdate = usePermission('flags.update');

  const grouped = useMemo(() => {
    const map: Record<string, Flag[]> = {};
    for (const f of flagsQ.data ?? []) {
      (map[f.def.category] ??= []).push(f);
    }
    return map;
  }, [flagsQ.data]);

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => updateFlag(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flags'] });
      qc.invalidateQueries({ queryKey: ['snapshots'] });
      showToast({ kind: 'success', message: 'Flag value saved (and snapshotted for rollback).' });
      setPending(null);
    },
    onError: () => {
      // Toast already surfaced by axios interceptor.
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feature Flags</h1>
          <p className="text-sm text-text-secondary mt-1">
            Values are stored and snapshotted for rollback. Note: these flags are not yet
            wired into the live app config (config_manager / app_config) — changes here do
            not affect production behaviour until that integration ships.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => setSnapsOpen(true)}>
          <History className="w-4 h-4" />
          History
        </button>
      </div>

      {flagsQ.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-32" /><Skeleton className="h-32" />
        </div>
      ) : (flagsQ.data?.length ?? 0) === 0 ? (
        <EmptyState title="No flags configured" body="Add flag definitions in internal/crm/flags/registry.go." />
      ) : (
        Object.entries(grouped).map(([cat, flags]) => (
          <section key={cat}>
            <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">{cat}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {flags.map((f) => (
                <FlagCard
                  key={f.def.key}
                  flag={f}
                  proMode={proMode}
                  canUpdate={canUpdate}
                  onChange={(next) => {
                    if (!canUpdate) {
                      showToast({ kind: 'error', message: 'Insufficient permissions' });
                      return;
                    }
                    setPending({ key: f.def.key, next, before: f.value, flag: f });
                  }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <ConfirmModal
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => save.mutateAsync({ key: pending!.key, value: pending!.next })}
        title={`Update ${pending?.flag.def.name ?? ''}?`}
        impact={
          <div className="space-y-2">
            <p>
              <span className="text-text-muted">Before:</span>{' '}
              <code className="font-mono text-text-primary">{JSON.stringify(pending?.before)}</code>
            </p>
            <p>
              <span className="text-text-muted">After:</span>{' '}
              <code className="font-mono text-text-primary">{JSON.stringify(pending?.next)}</code>
            </p>
            <p className="text-xs text-text-muted">
              Saved to the flag store and reversible from history. Not yet consumed by the
              live app engine — this does not change production behaviour.
            </p>
          </div>
        }
        confirmLabel="Save"
      />

      <SnapshotsModal open={snapsOpen} onClose={() => setSnapsOpen(false)} />
    </div>
  );
}

function FlagCard({
  flag, onChange, proMode, canUpdate,
}: {
  flag: Flag;
  onChange: (next: unknown) => void;
  proMode: boolean;
  canUpdate: boolean;
}) {
  const { def, value } = flag;
  return (
    <Card>
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{def.name}</div>
          <div className="text-[11px] text-text-secondary">{def.description}</div>
        </div>
        <StatusPill tone={isOn(value, def.type) ? 'success' : 'neutral'}>
          {labelOf(value, def.type)}
        </StatusPill>
      </div>

      <div className="mt-3" title={!canUpdate ? 'Insufficient permissions' : undefined}>
        <FlagEditor flag={flag} onCommit={onChange} disabled={!canUpdate} />
      </div>

      {proMode && (
        <div className="mt-3 pt-3 border-t border-border text-[11px] text-text-muted font-mono space-y-0.5">
          <div>key: {def.key}</div>
          <div>type: {def.type}</div>
          <div>default: {JSON.stringify(def.default)}</div>
        </div>
      )}
    </Card>
  );
}

function FlagEditor({ flag, onCommit, disabled }: { flag: Flag; onCommit: (next: unknown) => void; disabled: boolean }) {
  const { def, value } = flag;
  if (def.type === 'bool') {
    const checked = !!value;
    return (
      <button
        onClick={() => onCommit(!checked)}
        disabled={disabled}
        className={`w-12 h-6 rounded-full relative transition ${checked ? 'bg-primary' : 'bg-border'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        aria-label="toggle flag"
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-[26px]' : 'left-0.5'}`} />
      </button>
    );
  }
  if (def.type === 'number') {
    return <NumericInput flag={flag} onCommit={onCommit} disabled={disabled} />;
  }
  if (def.type === 'enum') {
    return (
      <select
        className="input"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value)}
      >
        {def.enum_options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }
  // string / json
  return <StringInput flag={flag} onCommit={onCommit} disabled={disabled} />;
}

function NumericInput({ flag, onCommit, disabled }: { flag: Flag; onCommit: (next: unknown) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(String(flag.value ?? ''));
  const min = flag.def.min, max = flag.def.max;
  const num = Number(draft);
  const valid = !isNaN(num) && (min == null || num >= min) && (max == null || num <= max);
  return (
    <div className="flex items-center gap-2">
      <input
        className={`input ${!valid ? 'border-danger' : ''}`}
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        min={min}
        max={max}
        disabled={disabled}
      />
      <button
        className="btn-primary"
        disabled={!valid || num === Number(flag.value) || disabled}
        onClick={() => onCommit(num)}
      >
        <Save className="w-4 h-4" />
      </button>
      {(min != null || max != null) && (
        <span className="text-[11px] text-text-muted">
          {min ?? '—'}…{max ?? '—'}
        </span>
      )}
    </div>
  );
}

function StringInput({ flag, onCommit, disabled }: { flag: Flag; onCommit: (next: unknown) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(String(flag.value ?? ''));
  const dirty = draft !== String(flag.value ?? '');
  return (
    <div className="flex items-center gap-2">
      <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} />
      <button className="btn-primary" disabled={!dirty || disabled} onClick={() => onCommit(draft)}>
        <Save className="w-4 h-4" />
      </button>
    </div>
  );
}

function isOn(v: unknown, t: string): boolean {
  if (t === 'bool') return !!v;
  return v != null && v !== '';
}
function labelOf(v: unknown, t: string): string {
  if (t === 'bool') return v ? 'on' : 'off';
  if (v == null || v === '') return 'unset';
  return String(v);
}

function SnapshotsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['snapshots'], queryFn: listSnapshots, enabled: open });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const canRollback = usePermission('flags.rollback');

  const rb = useMutation({
    mutationFn: rollbackSnapshot,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flags'] });
      qc.invalidateQueries({ queryKey: ['snapshots'] });
      showToast({ kind: 'success', message: 'Rolled back. New snapshot created.' });
      setPendingId(null);
      onClose();
    },
  });

  return (
    <>
      <ConfirmModal
        open={!!pendingId}
        onClose={() => setPendingId(null)}
        onConfirm={() => rb.mutateAsync(pendingId!)}
        title="Rollback to this snapshot?"
        impact="All flags will revert to the values stored in this snapshot. A new snapshot recording the rollback will be created."
        confirmLabel="Rollback"
        destructive
      />
      {/* re-using Modal would nest awkwardly; keep this simple inline panel */}
      {open && (
        <div className="fixed inset-0 z-30 flex items-center justify-center" onClick={onClose}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" />
          <div className="relative card-elevated w-full max-w-2xl mx-4 p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Snapshots</h2>
            {q.isLoading ? (
              <Skeleton className="h-32" />
            ) : (q.data?.length ?? 0) === 0 ? (
              <EmptyState title="No snapshots yet" body="Snapshots are created on every flag change." />
            ) : (
              <div className="divide-y divide-border">
                {q.data?.map((s) => (
                  <div key={s.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary">
                        {s.reason ?? <span className="text-text-muted">(no reason)</span>}
                      </div>
                      <div className="text-[11px] text-text-secondary">
                        {s.admin_email ?? '—'} · {new Date(s.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="btn-ghost text-xs"
                      disabled={!canRollback}
                      title={!canRollback ? 'Insufficient permissions' : undefined}
                      onClick={() => {
                        if (!canRollback) {
                          showToast({ kind: 'error', message: 'Insufficient permissions' });
                          return;
                        }
                        setPendingId(s.id);
                      }}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Rollback
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
