import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { refundsApi, type PaymentMethod, type Refund, type RefundStatus } from '@/api/all';
import { Card, EmptyState, ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const STATUSES: RefundStatus[] = [
  'pending',
  'approved',
  'processed',
  'processed_manual',
  'gateway_error',
  'rejected',
];

const STATUS_TONE: Record<RefundStatus, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'info',
  approved: 'info', // teal-ish; reuse info palette since there's no teal tone primitive.
  processed: 'success',
  processed_manual: 'warning',
  gateway_error: 'danger',
  rejected: 'neutral',
  cancelled: 'neutral',
};

const METHOD_BADGE: Record<PaymentMethod, string> = {
  upi: 'border-primary/30 text-primary/90 bg-primary/10',
  card: 'border-purple-400/30 text-purple-300 bg-purple-500/10',
  cod: 'border-warning/30 text-warning/90 bg-warning/10',
  wallet: 'border-border text-text-secondary bg-surface-elevated',
  netbanking: 'border-cyan-400/30 text-cyan-300 bg-cyan-500/10',
};

function MethodBadge({ method }: { method?: PaymentMethod | null }) {
  if (!method) return <span className="text-text-muted text-xs">—</span>;
  const label = method === 'cod' ? 'COD' : method === 'upi' ? 'UPI' : method.charAt(0).toUpperCase() + method.slice(1);
  return <span className={`pill ${METHOD_BADGE[method]}`}>{label}</span>;
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function shortRef(s?: string | null) {
  if (!s) return '—';
  return s.length <= 14 ? s : s.slice(0, 6) + '…' + s.slice(-4);
}

export function RefundsPage() {
  const [tab, setTab] = useState<RefundStatus>('pending');
  const q = useQuery({
    queryKey: ['refunds', tab],
    queryFn: () => refundsApi.list({ status: tab, limit: 100 }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Refunds</h1>
        <p className="text-sm text-text-secondary mt-1">Pending refunds need a decision. Approved rows are pushed to the payment gateway; failures land in Gateway error.</p>
      </div>
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={`px-4 py-2 text-sm capitalize whitespace-nowrap border-b-2 transition ${tab === s ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> :
          q.isError ? <ErrorState title="Could not load refunds" onRetry={() => q.refetch()} /> :
          (q.data?.items.length ?? 0) === 0 ? <EmptyState title={`No ${tab.replace(/_/g, ' ')} refunds`} /> :
            <table className="w-full text-sm">
              <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-left">Method</th>
                  <th className="px-4 py-3 text-left">Source / Status</th>
                  <th className="px-4 py-3 text-right">Created</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.items.map((r) => <Row key={r.id} r={r} tab={tab} />)}
              </tbody>
            </table>
        }
      </Card>
    </div>
  );
}

function Row({ r, tab }: { r: Refund; tab: RefundStatus }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<null | 'approve' | 'reject' | 'retry'>(null);
  const [partial, setPartial] = useState<string>('');
  const [reason, setReason] = useState('');

  const canApproveFull    = usePermission('refunds.approve_full');
  const canApprovePartial = usePermission('refunds.approve_partial');
  const canReject         = usePermission('refunds.reject');

  const partialCents = partial ? Number(partial) * 100 : 0;
  const isPartial = !!partial && partialCents > 0 && partialCents < r.amount_paise;
  const canApproveNow = isPartial ? canApprovePartial : canApproveFull;
  const effectiveAmount = isPartial ? partialCents : r.amount_paise;

  const isCod = r.payment_method === 'cod';
  // Block automatic approval if the refund is non-COD but lacks a payment ref
  // — the gateway needs the original payment id to issue a reversal.
  const missingPaymentRef = !isCod && !!r.payment_method && !r.payment_id;

  const approve = useMutation({
    mutationFn: () => refundsApi.approve(r.id, {
      reason,
      ...(isPartial ? { amount_paise: partialCents } : {}),
    }),
    onSuccess: (data) => {
      const amount = fmt(effectiveAmount);
      if (data.status === 'processed') {
        const ref = data.gateway_refund_id ? ` Gateway ref: ${data.gateway_refund_id}` : '';
        showToast({ kind: 'success', message: `Refund of ${amount} processed successfully.${ref}` });
      } else if (data.status === 'processed_manual') {
        showToast({ kind: 'warning', message: `Refund of ${amount} marked for manual processing. Handle offline.` });
      } else {
        showToast({ kind: 'success', message: `Refund of ${amount} approved.` });
      }
      qc.invalidateQueries({ queryKey: ['refunds'] });
      setOpen(null); setReason(''); setPartial('');
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      if (e?.response?.status && e.response.status >= 500 && e.response.data?.error === 'gateway_error') {
        const msg = e.response.data?.message ?? 'Gateway refund call failed.';
        showToast({ kind: 'error', message: `Gateway refund failed: ${msg}. Click Retry on the row to try again.` });
        qc.invalidateQueries({ queryKey: ['refunds'] });
        setOpen(null);
      }
      // 4xx is already toasted by the axios interceptor (uses data.error / data.message).
    },
  });
  const reject = useMutation({
    mutationFn: () => refundsApi.reject(r.id, reason),
    onSuccess: () => { showToast({ kind: 'success', message: 'Refund rejected.' }); qc.invalidateQueries({ queryKey: ['refunds'] }); setOpen(null); setReason(''); },
  });
  const retry = useMutation({
    mutationFn: () => refundsApi.retry(r.id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Gateway retry queued. Status will update shortly.' });
      qc.invalidateQueries({ queryKey: ['refunds'] });
      setOpen(null);
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      if (e?.response?.status && e.response.status >= 500 && e.response.data?.error === 'gateway_error') {
        const msg = e.response.data?.message ?? 'Gateway refund call failed.';
        showToast({ kind: 'error', message: `Retry failed: ${msg}` });
        qc.invalidateQueries({ queryKey: ['refunds'] });
        setOpen(null);
      }
    },
  });

  const canAct = tab === 'pending';
  const isProcessed = r.status === 'processed';
  const isManual = r.status === 'processed_manual';
  const isGatewayError = r.status === 'gateway_error';
  const displayedAmount = r.partial_amount_paise && r.partial_amount_paise > 0 ? r.partial_amount_paise : r.amount_paise;

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="px-4 py-3">
          <div>{r.user_name ?? r.user_phone}</div>
          <div className="text-[11px] text-text-secondary">{r.user_phone}</div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          <div>{fmt(displayedAmount)}</div>
          {r.partial_amount_paise && r.partial_amount_paise > 0 && r.partial_amount_paise < r.amount_paise && (
            <div className="text-[11px] text-text-muted">of {fmt(r.amount_paise)}</div>
          )}
        </td>
        <td className="px-4 py-3"><MethodBadge method={r.payment_method} /></td>
        <td className="px-4 py-3 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill tone="info">{r.source}</StatusPill>
            <StatusPill tone={STATUS_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</StatusPill>
            {isManual && <StatusPill tone="warning">Manual refund required</StatusPill>}
          </div>
          {isProcessed && r.gateway_refund_id && (
            <div className="text-[11px] text-text-muted">
              Gateway ref: <span className="font-mono">{r.gateway_refund_id}</span>
              {r.processed_at && <> · {new Date(r.processed_at).toLocaleString()}</>}
            </div>
          )}
          {isGatewayError && r.error_message && (
            <div className="text-[11px] text-danger" title={r.error_message}>
              {truncate(r.error_message, 200)}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-right text-text-secondary whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
        <td className="px-4 py-3 text-right whitespace-nowrap">
          {canAct && (
            <>
              <button
                className="btn-ghost text-success !py-1"
                disabled={!canApproveFull && !canApprovePartial}
                title={(!canApproveFull && !canApprovePartial) ? 'Insufficient permissions' : undefined}
                onClick={() => {
                  if (!canApproveFull && !canApprovePartial) {
                    showToast({ kind: 'error', message: 'Insufficient permissions' });
                    return;
                  }
                  setOpen('approve');
                }}
              >Approve</button>
              <button
                className="btn-ghost text-danger !py-1 ml-2"
                disabled={!canReject}
                title={!canReject ? 'Insufficient permissions' : undefined}
                onClick={() => {
                  if (!canReject) {
                    showToast({ kind: 'error', message: 'Insufficient permissions' });
                    return;
                  }
                  setOpen('reject');
                }}
              >Reject</button>
            </>
          )}
          {isGatewayError && (
            <Can perm="refunds.approve_full">
              <button className="btn-ghost text-warning !py-1" onClick={() => setOpen('retry')}>Retry</button>
            </Can>
          )}
        </td>
      </tr>

      {/* Approve modal — uses bare Modal so we can control the footer (spinner during gateway call). */}
      <Modal
        open={open === 'approve'}
        onClose={approve.isPending ? () => {} : () => { setOpen(null); }}
        title="Approve refund?"
        width="max-w-lg"
      >
        <div className="text-sm text-text-secondary space-y-4">
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 gap-x-3 text-sm">
            <dt className="text-text-muted">Original amount</dt>
            <dd className="text-text-primary tabular-nums">{fmt(r.amount_paise)}</dd>
            <dt className="text-text-muted">Refund amount</dt>
            <dd className="text-text-primary tabular-nums">{fmt(effectiveAmount)}{isPartial && <span className="text-text-muted"> (partial)</span>}</dd>
            <dt className="text-text-muted">Payment method</dt>
            <dd><MethodBadge method={r.payment_method} /></dd>
            <dt className="text-text-muted">Original payment ref</dt>
            <dd className="font-mono text-xs text-text-primary" title={r.payment_id ?? undefined}>{shortRef(r.payment_id)}</dd>
          </dl>

          {isCod && (
            <div className="rounded-md border border-warning/30 bg-warning/10 text-warning px-3 py-2 text-xs">
              COD order — refund will be marked as Manual. Reach out to the customer offline.
            </div>
          )}
          {missingPaymentRef && (
            <div className="rounded-md border border-danger/30 bg-danger/10 text-danger px-3 py-2 text-xs">
              Original payment reference missing. Cannot process automatic refund.
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs text-text-muted">Full amount = {fmt(r.amount_paise)}. Leave partial blank to approve full.</p>
            <input className="input" placeholder="Partial amount in ₹ (optional)" value={partial} onChange={(e) => setPartial(e.target.value.replace(/\D/g, ''))} />
            <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button className="btn-ghost" onClick={() => setOpen(null)} disabled={approve.isPending}>Cancel</button>
          <button
            className="btn-primary inline-flex items-center gap-2"
            disabled={approve.isPending || missingPaymentRef || !reason.trim() || !canApproveNow}
            onClick={() => {
              if (!canApproveNow) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              approve.mutate();
            }}
          >
            {approve.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {approve.isPending ? 'Processing refund…' : 'Approve'}
          </button>
        </div>
      </Modal>

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

      <ConfirmModal
        open={open === 'retry'}
        onClose={() => setOpen(null)}
        onConfirm={() => retry.mutateAsync()}
        title="Retry gateway refund?"
        impact={
          <div className="space-y-2">
            <p>This re-runs the gateway refund call for {fmt(displayedAmount)}.</p>
            {r.error_message && (
              <p className="text-xs text-text-muted">Last error: <span className="text-danger">{truncate(r.error_message, 200)}</span></p>
            )}
          </div>
        }
        confirmLabel="Retry"
      />
    </>
  );
}
