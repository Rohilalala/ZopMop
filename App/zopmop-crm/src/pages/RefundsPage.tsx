import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { refundsApi, type Refund } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const STATUSES = ['pending', 'approved', 'rejected', 'processed'] as const;

export function RefundsPage() {
  const [tab, setTab] = useState<typeof STATUSES[number]>('pending');
  const q = useQuery({
    queryKey: ['refunds', tab],
    queryFn: () => refundsApi.list({ status: tab, limit: 100 }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Refunds</h1>
        <p className="text-sm text-text-secondary mt-1">Pending refunds need a decision. Approved rows are picked up by the payment worker.</p>
      </div>
      <div className="flex gap-1 border-b border-border">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={`px-4 py-2 text-sm capitalize border-b-2 transition ${tab === s ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {s}
          </button>
        ))}
      </div>
      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> :
          (q.data?.items.length ?? 0) === 0 ? <EmptyState title={`No ${tab} refunds`} /> :
            <table className="w-full text-sm">
              <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-left">Source</th>
                  <th className="px-4 py-3 text-right">Created</th>
                  {tab === 'pending' && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {q.data?.items.map((r) => <Row key={r.id} r={r} canAct={tab === 'pending'} />)}
              </tbody>
            </table>
        }
      </Card>
    </div>
  );
}

function Row({ r, canAct }: { r: Refund; canAct: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<null | 'approve' | 'reject'>(null);
  const [partial, setPartial] = useState<string>('');
  const [reason, setReason] = useState('');

  const approve = useMutation({
    mutationFn: () => refundsApi.approve(r.id, {
      reason,
      ...(partial ? { amount_cents: Number(partial) * 100 } : {}),
    }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Refund approved.' }); qc.invalidateQueries({ queryKey: ['refunds'] }); setOpen(null); setReason(''); setPartial(''); },
  });
  const reject = useMutation({
    mutationFn: () => refundsApi.reject(r.id, reason),
    onSuccess: () => { showToast({ kind: 'success', message: 'Refund rejected.' }); qc.invalidateQueries({ queryKey: ['refunds'] }); setOpen(null); setReason(''); },
  });

  return (
    <>
      <tr className="border-t border-border">
        <td className="px-4 py-3">
          <div>{r.user_name ?? r.user_phone}</div>
          <div className="text-[11px] text-text-secondary">{r.user_phone}</div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{fmt(r.amount_cents)}</td>
        <td className="px-4 py-3"><StatusPill tone="info">{r.source}</StatusPill></td>
        <td className="px-4 py-3 text-right text-text-secondary">{new Date(r.created_at).toLocaleString()}</td>
        {canAct && (
          <td className="px-4 py-3 text-right">
            <button className="btn-ghost text-success !py-1" onClick={() => setOpen('approve')}>Approve</button>
            <button className="btn-ghost text-danger !py-1 ml-2" onClick={() => setOpen('reject')}>Reject</button>
          </td>
        )}
      </tr>
      <ConfirmModal
        open={open === 'approve'}
        onClose={() => setOpen(null)}
        onConfirm={() => approve.mutateAsync()}
        title="Approve refund?"
        impact={
          <div className="space-y-3">
            <p>Approving sets status to <code>approved</code>. The payment worker performs the actual reversal.</p>
            <p className="text-xs text-text-muted">Full amount = {fmt(r.amount_cents)}. Leave partial blank to approve full.</p>
            <input className="input" placeholder="Partial amount in ₹ (optional)" value={partial} onChange={(e) => setPartial(e.target.value.replace(/\D/g, ''))} />
            <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        }
        confirmLabel="Approve"
      />
      <ConfirmModal
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        onConfirm={() => reject.mutateAsync()}
        title="Reject refund?"
        impact={
          <div className="space-y-3">
            <p>The user will not receive a refund. They may dispute via support.</p>
            <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        }
        destructive
        confirmLabel="Reject"
      />
    </>
  );
}
