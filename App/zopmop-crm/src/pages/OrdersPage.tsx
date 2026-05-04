import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';

import { ordersApi, refundsApi, type Order } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { showToast } from '@/components/ui/Toast';
import { useProMode } from '@/store/proMode';
import { usePermission } from '@/auth/usePermission';
import { Can } from '@/auth/Can';

const PAGE = 25;
const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  completed: 'success', cancelled: 'danger', pending: 'warning',
  in_progress: 'info', en_route: 'info', arrived: 'info', assigned: 'info',
};

export function OrdersPage() {
  const [params, setParams] = useState({ search: '', status: '', limit: PAGE, offset: 0 });
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['orders', params],
    queryFn: () => ordersApi.list(params),
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total_count ?? 0;
  const page = Math.floor(params.offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Orders</h1>
        <p className="text-sm text-text-secondary mt-1">Booking lifecycle, manual interventions.</p>
      </div>

      <Card className="!p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-9"
              placeholder="Search by order id, user, worker…"
              value={params.search}
              onChange={(e) => setParams((p) => ({ ...p, search: e.target.value, offset: 0 }))}
            />
          </div>
          <select
            className="input max-w-[180px]"
            value={params.status}
            onChange={(e) => setParams((p) => ({ ...p, status: e.target.value, offset: 0 }))}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="assigned">Assigned</option>
            <option value="en_route">En route</option>
            <option value="arrived">Arrived</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left">Order</th>
              <th className="px-4 py-3 text-left">Customer / Worker</th>
              <th className="px-4 py-3 text-left">Category</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              [...Array(6)].map((_, i) => (
                <tr key={i} className="border-t border-border">
                  {[...Array(6)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>)}
                </tr>
              ))
            ) : (q.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={6}><EmptyState title="No orders match" /></td></tr>
            ) : q.data?.items.map((o, i) => (
              <Row key={o.id} order={o} alt={i % 2 === 1} onClick={() => setDrawerId(o.id)} />
            ))}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-text-secondary">
          <span>{params.offset + 1}–{Math.min(params.offset + (q.data?.items.length ?? 0), total)} of {total}</span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !py-1 !px-2 text-xs" disabled={page === 1} onClick={() => setParams((p) => ({ ...p, offset: Math.max(0, p.offset - PAGE) }))}>← Prev</button>
            <span>Page {page} of {pages}</span>
            <button className="btn-ghost !py-1 !px-2 text-xs" disabled={page >= pages} onClick={() => setParams((p) => ({ ...p, offset: p.offset + PAGE }))}>Next →</button>
          </div>
        </div>
      </Card>

      <OrderDrawer id={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}

function Row({ order, alt, onClick }: { order: Order; alt: boolean; onClick: () => void }) {
  return (
    <tr className={`border-t border-border cursor-pointer transition ${alt ? 'bg-surface-elevated/40' : ''} hover:bg-primary/5`} onClick={onClick}>
      <td className="px-4 py-3 font-mono text-[11px]">{order.id.slice(0, 8)}</td>
      <td className="px-4 py-3">
        <div className="text-text-primary">{order.customer_name ?? order.customer_phone}</div>
        <div className="text-[11px] text-text-secondary">{order.worker_name ?? <span className="text-text-muted">unassigned</span>}</div>
      </td>
      <td className="px-4 py-3">{order.category}</td>
      <td className="px-4 py-3 text-right tabular-nums">{fmt(order.price_cents)}{order.discount_cents > 0 && <div className="text-[11px] text-text-muted">−{fmt(order.discount_cents)} {order.promo_code ?? ''}</div>}</td>
      <td className="px-4 py-3"><StatusPill tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</StatusPill></td>
      <td className="px-4 py-3 text-right text-text-secondary">{new Date(order.created_at).toLocaleString()}</td>
    </tr>
  );
}

function OrderDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const open = id != null;
  const qc = useQueryClient();
  const proMode = useProMode((s) => s.enabled);
  const q = useQuery({ queryKey: ['order', id], queryFn: () => ordersApi.get(id!), enabled: open });
  const [pending, setPending] = useState<null | 'cancel' | 'complete'>(null);
  const [reason, setReason] = useState('');
  const [reassignOpen, setReassignOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const cancel = useMutation({
    mutationFn: () => ordersApi.cancel(id!, reason),
    onSuccess: () => { showToast({ kind: 'success', message: 'Order cancelled.' }); qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['order', id] }); setPending(null); setReason(''); },
  });
  const complete = useMutation({
    mutationFn: () => ordersApi.complete(id!),
    onSuccess: () => { showToast({ kind: 'success', message: 'Order force-completed.' }); qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['order', id] }); setPending(null); },
  });

  return (
    <Drawer open={open} onClose={onClose} width="max-w-2xl">
      {q.isLoading || !q.data ? (
        <div className="p-8"><Skeleton className="h-32" /></div>
      ) : (
        <div className="p-8 space-y-6">
          <div>
            <div className="text-xs text-text-muted font-mono">{q.data.id}</div>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-xl font-semibold">{q.data.category}</h2>
              <StatusPill tone={STATUS_TONE[q.data.status] ?? 'neutral'}>{q.data.status}</StatusPill>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-[11px] uppercase tracking-wider text-text-muted">Customer</div><div className="mt-1">{q.data.customer_name ?? q.data.customer_phone}</div><div className="text-[11px] text-text-secondary">{q.data.customer_phone}</div></div>
            <div><div className="text-[11px] uppercase tracking-wider text-text-muted">Worker</div><div className="mt-1">{q.data.worker_name ?? <span className="text-text-muted">unassigned</span>}</div></div>
            <div><div className="text-[11px] uppercase tracking-wider text-text-muted">Amount</div><div className="mt-1 font-semibold">{fmt(q.data.price_cents)}</div>{q.data.discount_cents > 0 && <div className="text-[11px] text-warning">−{fmt(q.data.discount_cents)} via {q.data.promo_code}</div>}</div>
            <div><div className="text-[11px] uppercase tracking-wider text-text-muted">Address</div><div className="mt-1 text-xs">{q.data.address}</div></div>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Timeline</h3>
            <div className="space-y-2 text-sm">
              <Step label="Created"   at={q.data.created_at} />
              <Step label="Matched"   at={q.data.matched_at} />
              <Step label="Accepted"  at={q.data.accepted_at} />
              <Step label="En route"  at={q.data.started_at} />
              <Step label="Arrived"   at={q.data.arrived_at} />
              <Step label="Completed" at={q.data.completed_at} />
              <Step label="Cancelled" at={q.data.cancelled_at} note={q.data.cancelled_by ?? undefined} />
            </div>
          </div>

          <OrderActions
            proMode={proMode}
            status={q.data.status}
            onCancel={() => setPending('cancel')}
            onComplete={() => setPending('complete')}
            onReassign={() => setReassignOpen(true)}
            onRefund={() => setRefundOpen(true)}
          />
        </div>
      )}

      <ConfirmModal
        open={pending === 'cancel'}
        onClose={() => { setPending(null); setReason(''); }}
        onConfirm={() => cancel.mutateAsync()}
        title="Cancel this order?"
        impact={
          <div className="space-y-3">
            <p>The order will be marked cancelled. The user app sees this immediately.</p>
            <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        }
        confirmLabel="Cancel order"
        destructive
      />

      <ConfirmModal
        open={pending === 'complete'}
        onClose={() => setPending(null)}
        onConfirm={() => complete.mutateAsync()}
        title="Force complete this order?"
        impact="This bypasses the worker's normal completion flow. Use only when the worker confirmed offline and can't tap Complete in their app."
        confirmLabel="Force complete"
        destructive
      />

      {id && reassignOpen && q.data && (
        <ReassignModal
          orderId={id}
          currentHelperName={q.data.worker_name ?? null}
          onClose={() => setReassignOpen(false)}
          onSuccess={() => {
            setReassignOpen(false);
            qc.invalidateQueries({ queryKey: ['orders'] });
            qc.invalidateQueries({ queryKey: ['order', id] });
          }}
        />
      )}

      {id && refundOpen && q.data && (
        <RefundModal
          orderId={id}
          orderTotalCents={q.data.price_cents}
          onClose={() => setRefundOpen(false)}
          onSuccess={() => {
            setRefundOpen(false);
            qc.invalidateQueries({ queryKey: ['orders'] });
            qc.invalidateQueries({ queryKey: ['order', id] });
            qc.invalidateQueries({ queryKey: ['refunds'] });
          }}
        />
      )}
    </Drawer>
  );
}

function OrderActions({ proMode, status, onCancel, onComplete, onReassign, onRefund }: { proMode: boolean; status: string; onCancel: () => void; onComplete: () => void; onReassign: () => void; onRefund: () => void }) {
  const canCancel = usePermission('orders.cancel');
  const canComplete = usePermission('orders.complete');
  const canRefund = usePermission('refunds.approve_full');
  const reassignable = status === 'assigned' || status === 'in_progress';
  const cancellable = status !== 'completed' && status !== 'cancelled';
  return (
    <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
      {cancellable && (
        <button
          className="btn-ghost text-danger"
          disabled={!canCancel}
          title={!canCancel ? 'Insufficient permissions' : undefined}
          onClick={() => {
            if (!canCancel) {
              showToast({ kind: 'error', message: 'Insufficient permissions' });
              return;
            }
            onCancel();
          }}
        >Cancel order</button>
      )}
      {reassignable && (
        <Can perm="orders.reassign">
          <button className="btn-ghost text-info" onClick={onReassign}>Reassign worker</button>
        </Can>
      )}
      <button
        className="btn-primary"
        disabled={!canRefund}
        title={!canRefund ? 'Insufficient permissions' : undefined}
        onClick={() => {
          if (!canRefund) {
            showToast({ kind: 'error', message: 'Insufficient permissions' });
            return;
          }
          onRefund();
        }}
      >Process refund</button>
      {proMode && cancellable && (
        <button
          className="btn-ghost text-warning"
          disabled={!canComplete}
          title={!canComplete ? 'Insufficient permissions' : undefined}
          onClick={() => {
            if (!canComplete) {
              showToast({ kind: 'error', message: 'Insufficient permissions' });
              return;
            }
            onComplete();
          }}
        >Force complete (Pro)</button>
      )}
    </div>
  );
}

function RefundModal({
  orderId,
  orderTotalCents,
  onClose,
  onSuccess,
}: {
  orderId: string;
  orderTotalCents: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [percent, setPercent] = useState(100);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canPartial = usePermission('refunds.approve_partial');

  const amountCents = Math.round((orderTotalCents * percent) / 100);
  const isPartial = percent < 100;
  const blockedByPartial = isPartial && !canPartial;

  const refund = useMutation({
    mutationFn: () => refundsApi.fromOrder(orderId, { amount_cents: amountCents, reason }),
    onSuccess: (res) => {
      const human =
        res.status === 'processed' ? 'Refund processed via gateway.' :
        res.status === 'processed_manual' ? 'Refund recorded for manual settlement.' :
        res.status === 'gateway_error' ? 'Gateway returned an error — refund saved for retry.' :
        `Refund created (${res.status}).`;
      showToast({ kind: res.status === 'gateway_error' ? 'error' : 'success', message: human });
      setConfirmOpen(false);
      onSuccess();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string; error?: string } }; message?: string })?.response?.data?.message
        ?? (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? (err as { message?: string })?.message
        ?? 'Failed to process refund';
      showToast({ kind: 'error', message: msg });
      setConfirmOpen(false);
    },
  });

  const canSubmit = amountCents > 0 && reason.trim().length > 0 && !blockedByPartial && !refund.isPending;

  return (
    <>
      <Modal open={!confirmOpen} onClose={onClose} title="Process refund" width="max-w-lg">
        <div className="space-y-5">
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted">Order total</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{fmt(orderTotalCents)}</div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs uppercase tracking-wider text-text-muted">Refund percentage</label>
              <span className="text-sm font-mono">{percent}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="mt-1 flex justify-between text-[10px] text-text-muted">
              <span>1%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-border p-3">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">Refund amount</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-success">{fmt(amountCents)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">Customer pays</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{fmt(orderTotalCents - amountCents)}</div>
            </div>
          </div>

          {blockedByPartial && (
            <div className="text-xs text-danger">
              Partial refunds require the <span className="font-mono">refunds.approve_partial</span> role. Slide to 100% or escalate.
            </div>
          )}

          <div>
            <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Reason (required)</label>
            <textarea
              className="input min-h-[80px]"
              placeholder="Why is this refund being issued?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!canSubmit}
              onClick={() => setConfirmOpen(true)}
            >Refund {fmt(amountCents)}</button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => refund.mutateAsync()}
        title="Confirm refund"
        impact={
          <span>
            Refund <span className="font-semibold text-text-primary">{fmt(amountCents)}</span>{' '}
            ({percent}% of {fmt(orderTotalCents)}) for order{' '}
            <span className="font-mono text-text-primary">#{orderId.slice(0, 8)}</span>?
            The gateway will be charged immediately and the customer notified.
          </span>
        }
        confirmLabel="Refund"
        destructive
      />
    </>
  );
}

function ReassignModal({
  orderId,
  currentHelperName,
  onClose,
  onSuccess,
}: {
  orderId: string;
  currentHelperName: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const wq = useQuery({
    queryKey: ['order-available-workers', orderId],
    queryFn: () => ordersApi.availableWorkers(orderId),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reassign = useMutation({
    mutationFn: () => ordersApi.reassign(orderId, { new_worker_id: selected!, reason }),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Worker reassigned' });
      setConfirmOpen(false);
      onSuccess();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as { message?: string })?.message
        ?? 'Failed to reassign worker';
      showToast({ kind: 'error', message: msg });
      setConfirmOpen(false);
    },
  });

  const items = wq.data ?? [];
  const selectedWorker = items.find((w) => w.worker_id === selected) ?? null;
  const canSubmit = !!selected && reason.trim().length > 0 && !reassign.isPending;

  return (
    <>
      <Modal open={!confirmOpen} onClose={onClose} title="Reassign worker" width="max-w-2xl">
        <div className="space-y-4">
          {wq.isLoading ? (
            <div className="text-sm text-text-secondary py-6 text-center">Loading available workers…</div>
          ) : wq.isError ? (
            <div className="py-6 text-center space-y-3">
              <div className="text-sm text-danger">Failed to load workers</div>
              <button className="btn-ghost text-xs" onClick={() => wq.refetch()}>Retry</button>
            </div>
          ) : items.length === 0 ? (
            <div className="text-sm text-text-secondary py-6 text-center">
              No available workers in this zone. Consider expanding the search radius or waiting.
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto border border-border rounded-md divide-y divide-border">
              {items.map((w) => {
                const isSel = w.worker_id === selected;
                return (
                  <button
                    key={w.worker_id}
                    type="button"
                    onClick={() => setSelected(w.worker_id)}
                    className={`w-full text-left px-4 py-3 flex items-start gap-3 transition ${isSel ? 'bg-primary/10' : 'hover:bg-surface-elevated/40'}`}
                  >
                    <span className={`mt-1 w-3 h-3 rounded-full border ${isSel ? 'bg-primary border-primary' : 'border-border'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-text-primary truncate">{w.name}</span>
                        <span className="text-xs text-warning">★ {w.rating.toFixed(1)}</span>
                        <span className="text-xs text-text-secondary">· {w.distance_km.toFixed(1)} km</span>
                        <span className="text-[10px] uppercase tracking-wider text-text-muted ml-auto">{w.current_status}</span>
                      </div>
                      {w.categories.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {w.categories.map((c) => (
                            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary">{c}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div>
            <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Reason (required)</label>
            <textarea
              className="input min-h-[80px]"
              placeholder="Why is this order being reassigned?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!canSubmit}
              onClick={() => setConfirmOpen(true)}
            >Reassign</button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => reassign.mutateAsync()}
        title="Confirm reassignment"
        impact={
          <span>
            You are reassigning order <span className="font-mono text-text-primary">#{orderId.slice(0, 8)}</span> from{' '}
            <span className="text-text-primary">{currentHelperName ?? 'unassigned'}</span> to{' '}
            <span className="text-text-primary">{selectedWorker?.name ?? '—'}</span>.
            The customer and both workers will be notified. Proceed?
          </span>
        }
        confirmLabel="Reassign"
      />
    </>
  );
}

function Step({ label, at, note }: { label: string; at?: string | null; note?: string }) {
  const ok = !!at;
  return (
    <div className="flex items-center gap-3">
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-success' : 'bg-border'}`} />
      <span className={ok ? 'text-text-primary' : 'text-text-muted'}>{label}</span>
      <span className="ml-auto text-xs text-text-secondary">{at ? new Date(at).toLocaleString() : '—'}</span>
      {note && <span className="text-[10px] text-text-muted ml-2">({note})</span>}
    </div>
  );
}
