import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tsApi } from '@/api/all';
import { Card, EmptyState, ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

const STATUS = ['open', 'in_progress', 'resolved', 'escalated'] as const;

export function DisputesPage() {
  const [tab, setTab] = useState<typeof STATUS[number]>('open');
  const [creating, setCreating] = useState(false);
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Disputes</h1>
          <p className="text-sm text-text-secondary mt-1">User/worker conflict cases. SLA = 48h from open.</p>
        </div>
        <Can perm="disputes.create">
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New case</button>
        </Can>
      </div>
      <div className="flex gap-1 border-b border-border">
        {STATUS.map((s) => (
          <button key={s} onClick={() => setTab(s)} className={`px-4 py-2 text-sm capitalize border-b-2 transition ${tab === s ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>
      <List status={tab} />
      {creating && <NewDispute onClose={() => setCreating(false)} />}
    </div>
  );
}

function List({ status }: { status: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['disputes', status], queryFn: () => tsApi.listDisputes(status) });
  const [resolveID, setResolveID] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const canResolve = usePermission('disputes.resolve');
  const m = useMutation({
    mutationFn: () => tsApi.resolveDispute(resolveID!, resolution),
    onSuccess: () => { showToast({ kind: 'success', message: 'Resolved.' }); qc.invalidateQueries({ queryKey: ['disputes'] }); setResolveID(null); setResolution(''); },
  });
  const transition = useMutation({
    mutationFn: (p: { id: string; status: 'in_progress' | 'escalated' }) => tsApi.setDisputeStatus(p.id, p.status),
    onSuccess: () => { showToast({ kind: 'success', message: 'Status updated.' }); qc.invalidateQueries({ queryKey: ['disputes'] }); },
  });

  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.isError) return <Card><ErrorState title="Could not load disputes" onRetry={() => q.refetch()} /></Card>;
  if ((q.data?.length ?? 0) === 0) return <Card><EmptyState title={`No ${status} disputes`} /></Card>;

  return (
    <div className="space-y-3">
      {q.data?.map((d) => {
        const overdue = d.sla_due_at && new Date(d.sla_due_at) < new Date() && d.status !== 'resolved';
        return (
          <Card key={d.id}>
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <code className="text-[11px] font-mono text-text-muted">{d.id.slice(0, 8)}</code>
                  <StatusPill tone={d.severity === 'critical' || d.severity === 'high' ? 'danger' : d.severity === 'medium' ? 'warning' : 'neutral'}>{d.severity}</StatusPill>
                  {overdue && <StatusPill tone="danger">SLA breach</StatusPill>}
                </div>
                <div className="text-sm mt-1">{d.description}</div>
                <div className="text-[11px] text-text-muted mt-1">
                  source: {d.source} · level: {d.level} · SLA: {d.sla_due_at ? new Date(d.sla_due_at).toLocaleString() : '—'}
                </div>
              </div>
              {status !== 'resolved' && (
                <div className="flex gap-1.5 shrink-0">
                  {d.status !== 'in_progress' && (
                    <button
                      className="btn-ghost !py-1 !px-2 text-xs"
                      disabled={!canResolve || transition.isPending}
                      title={!canResolve ? 'Insufficient permissions' : undefined}
                      onClick={() => {
                        if (!canResolve) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; }
                        transition.mutate({ id: d.id, status: 'in_progress' });
                      }}
                    >In progress</button>
                  )}
                  {d.status !== 'escalated' && (
                    <button
                      className="btn-ghost !py-1 !px-2 text-xs text-warning"
                      disabled={!canResolve || transition.isPending}
                      title={!canResolve ? 'Insufficient permissions' : undefined}
                      onClick={() => {
                        if (!canResolve) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; }
                        transition.mutate({ id: d.id, status: 'escalated' });
                      }}
                    >Escalate</button>
                  )}
                  <button
                    className="btn-ghost !py-1 !px-2 text-xs"
                    disabled={!canResolve}
                    title={!canResolve ? 'Insufficient permissions' : undefined}
                    onClick={() => {
                      if (!canResolve) {
                        showToast({ kind: 'error', message: 'Insufficient permissions' });
                        return;
                      }
                      setResolveID(d.id);
                    }}
                  >Resolve</button>
                </div>
              )}
            </div>
          </Card>
        );
      })}
      <ConfirmModal
        open={!!resolveID}
        onClose={() => { setResolveID(null); setResolution(''); }}
        onConfirm={() => m.mutateAsync()}
        title="Resolve dispute?"
        impact={
          <div className="space-y-2">
            <p>Mark resolved + record outcome. The user-app sees no direct notification — handle via support templates.</p>
            <textarea className="input min-h-[80px]" placeholder="Resolution / outcome" value={resolution} onChange={(e) => setResolution(e.target.value)} />
          </div>
        }
        confirmLabel="Resolve"
      />
    </div>
  );
}

function NewDispute({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [desc, setDesc] = useState('');
  const [sev, setSev]   = useState('medium');
  const [src, setSrc]   = useState('admin');
  const canCreate = usePermission('disputes.create');
  const m = useMutation({
    mutationFn: () => tsApi.createDispute({ description: desc, severity: sev, source: src }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Case opened.' }); qc.invalidateQueries({ queryKey: ['disputes'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="New dispute">
      <div className="space-y-3">
        <textarea className="input min-h-[100px]" placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select className="input" value={sev} onChange={(e) => setSev(e.target.value)}>
            <option>low</option><option>medium</option><option>high</option><option>critical</option>
          </select>
          <select className="input" value={src} onChange={(e) => setSrc(e.target.value)}>
            <option>admin</option><option>customer</option><option>worker</option><option>system</option>
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!desc || !canCreate}
            title={!canCreate ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canCreate) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              m.mutateAsync();
            }}
          >Create</button>
        </div>
      </div>
    </Modal>
  );
}
