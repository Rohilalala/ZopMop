import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutsApi, type Payout } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export function PayoutsPage() {
  const [tab, setTab] = useState('pending');
  const q = useQuery({
    queryKey: ['payouts', tab],
    queryFn: () => payoutsApi.list({ status: tab, limit: 100 }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Worker Payouts</h1>
        <p className="text-sm text-text-secondary mt-1">Mark-paid records intent + audit. The actual UPI/bank transfer is invoked by the payment worker.</p>
      </div>
      <div className="flex gap-1 border-b border-border">
        {['pending', 'processing', 'paid', 'failed'].map((s) => (
          <button key={s} onClick={() => setTab(s)} className={`px-4 py-2 text-sm capitalize border-b-2 transition ${tab === s ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {s}
          </button>
        ))}
      </div>
      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> :
          (q.data?.items.length ?? 0) === 0 ? <EmptyState title={`No ${tab} payouts`} /> :
            <table className="w-full text-sm">
              <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Worker</th>
                  <th className="px-4 py-3 text-left">Period</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  {tab === 'pending' && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {q.data?.items.map((p) => <PayoutRow key={p.id} p={p} canAct={tab === 'pending' || tab === 'processing'} />)}
              </tbody>
            </table>
        }
      </Card>
    </div>
  );
}

function PayoutRow({ p, canAct }: { p: Payout; canAct: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<null | 'paid' | 'failed'>(null);
  const [ref, setRef] = useState('');
  const [notes, setNotes] = useState('');
  const paid = useMutation({ mutationFn: () => payoutsApi.paid(p.id, ref), onSuccess: () => { showToast({ kind: 'success', message: 'Marked paid.' }); qc.invalidateQueries({ queryKey: ['payouts'] }); setOpen(null); setRef(''); } });
  const failed = useMutation({ mutationFn: () => payoutsApi.failed(p.id, notes), onSuccess: () => { showToast({ kind: 'success', message: 'Marked failed.' }); qc.invalidateQueries({ queryKey: ['payouts'] }); setOpen(null); setNotes(''); } });
  return (
    <>
      <tr className="border-t border-border">
        <td className="px-4 py-3">
          <div>{p.worker_name ?? p.worker_phone}</div>
          <div className="text-[11px] text-text-secondary">{p.worker_phone}</div>
        </td>
        <td className="px-4 py-3 text-text-secondary">
          {new Date(p.period_start).toLocaleDateString()} – {new Date(p.period_end).toLocaleDateString()}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{fmt(p.amount_cents)}</td>
        <td className="px-4 py-3">
          <StatusPill tone={p.status === 'paid' ? 'success' : p.status === 'failed' ? 'danger' : p.status === 'processing' ? 'warning' : 'neutral'}>{p.status}</StatusPill>
          {p.external_ref && <span className="text-[10px] font-mono text-text-muted ml-2">{p.external_ref}</span>}
        </td>
        {canAct && (
          <td className="px-4 py-3 text-right">
            <button className="btn-ghost text-success !py-1" onClick={() => setOpen('paid')}>Mark paid</button>
            <button className="btn-ghost text-danger !py-1 ml-2" onClick={() => setOpen('failed')}>Failed</button>
          </td>
        )}
      </tr>
      <ConfirmModal open={open === 'paid'} onClose={() => setOpen(null)} onConfirm={() => paid.mutateAsync()}
        title="Mark paid?"
        impact={<div className="space-y-3"><p>{fmt(p.amount_cents)} → {p.worker_name ?? p.worker_phone}</p><input className="input" placeholder="External ref (UTR, txn id)" value={ref} onChange={(e) => setRef(e.target.value)} /></div>}
        confirmLabel="Mark paid" />
      <ConfirmModal open={open === 'failed'} onClose={() => setOpen(null)} onConfirm={() => failed.mutateAsync()}
        title="Mark failed?"
        impact={<div className="space-y-3"><p>The worker is not paid. Re-issue manually after fixing the cause.</p><input className="input" placeholder="Notes (cause)" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>}
        destructive confirmLabel="Mark failed" />
    </>
  );
}
