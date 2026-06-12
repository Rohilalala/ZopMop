import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MarkerF } from '@react-google-maps/api';
import { format as formatDate, formatDistanceToNow } from 'date-fns';
import {
  AlertCircle, ArrowLeft, Ban, Check, CheckCircle2, Loader2,
  MessageSquare, RotateCcw, Search, Send, Star, UserPlus,
} from 'lucide-react';

import {
  ordersApi, orderKeys, refundsApi,
  type AvailableWorker, type OrderDetail, type OrderServiceLine, type OrderNote,
} from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { GoogleMapWrapper } from '@/components/maps/GoogleMapWrapper';
import { usePermission } from '@/auth/usePermission';

// ── Page entry ──────────────────────────────────────────────────────────

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  // Page entry follows the authed-shell gate (see App.tsx). Read perms are
  // enforced by the backend (orders.read); a 403 there will surface via the
  // standard axios interceptor toast.
  const q = useQuery({
    queryKey: id ? orderKeys.detail(id) : ['orders', 'no-id'],
    queryFn: () => ordersApi.get(id!),
    enabled: !!id,
  });

  if (!id) {
    return (
      <div className="p-6">
        <EmptyState title="No booking id" />
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertCircle className="w-12 h-12" />}
          title="Booking not found"
          body="It may have been removed or you do not have permission to view it."
          action={
            <Link to="/orders" className="btn-ghost">
              <ArrowLeft className="w-4 h-4" /> Back to orders
            </Link>
          }
        />
      </div>
    );
  }

  return <DetailLayout order={q.data} onBack={() => nav('/orders')} />;
}

// ── Layout ──────────────────────────────────────────────────────────────

function DetailLayout({ order, onBack }: { order: OrderDetail; onBack: () => void }) {
  const fmt = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const terminal = order.status === 'completed' || order.status === 'cancelled';
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start gap-4">
        <button onClick={onBack} className="btn-ghost !p-2" aria-label="back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              Booking <span className="font-mono text-base text-text-secondary">{order.id.slice(0, 8)}</span>
            </h1>
            <StatusPill tone={statusTone(order.status)}>{order.status}</StatusPill>
          </div>
          <p className="text-sm text-text-secondary mt-1">
            {order.category} · Created{' '}
            <span title={formatDate(new Date(order.created_at), 'MMM d, yyyy HH:mm')}>
              {formatDistanceToNow(new Date(order.created_at), { addSuffix: true })}
            </span>
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{fmt(order.price_paise)}</div>
          {order.discount_paise > 0 && (
            <div className="text-xs text-warning">
              −{fmt(order.discount_paise)} {order.promo_code ? `via ${order.promo_code}` : ''}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <TimelineCard order={order} />
          <ServicesCard services={order.services ?? []} />
          <NotesCard orderId={order.id} />
        </div>
        <div className="space-y-6">
          <CustomerCard order={order} />
          <ProCard order={order} />
          {!terminal && <ActionsCard order={order} />}
          {terminal && <RefundOnlyCard order={order} />}
        </div>
      </div>
    </div>
  );
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'completed': return 'success';
    case 'cancelled': return 'danger';
    case 'pending': case 'matching': return 'neutral';
    case 'accepted': case 'en_route': case 'arrived': case 'in_progress':
      return 'info';
    default: return 'neutral';
  }
}

// ── Timeline ────────────────────────────────────────────────────────────

const TIMELINE_STEPS: { key: keyof OrderDetail; label: string }[] = [
  { key: 'created_at',    label: 'Created' },
  { key: 'matched_at',    label: 'Assigned' },
  { key: 'accepted_at',   label: 'Accepted' },
  { key: 'en_route_at',   label: 'En route' },
  { key: 'arrived_at',    label: 'Arrived' },
  { key: 'started_at',    label: 'Started' },
  { key: 'completed_at',  label: 'Completed' },
];

function TimelineCard({ order }: { order: OrderDetail }) {
  const cancelled = order.cancelled_at != null;
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-4">Timeline</h3>
      <ol className="space-y-3">
        {TIMELINE_STEPS.map((step) => {
          const ts = order[step.key] as string | null | undefined;
          return <TimelineRow key={step.key as string} label={step.label} ts={ts} />;
        })}
        {cancelled && (
          <TimelineRow label="Cancelled" ts={order.cancelled_at} danger />
        )}
      </ol>
      {(order.matched_at == null && order.accepted_at == null && order.status === 'pending') && (
        <p className="mt-4 text-xs text-text-muted">
          Awaiting dispatcher to find a pro for this booking.
        </p>
      )}
    </Card>
  );
}

function TimelineRow({
  label, ts, danger,
}: { label: string; ts?: string | null; danger?: boolean }) {
  const done = !!ts;
  const tone =
    danger ? 'bg-danger' : done ? 'bg-primary' : 'bg-text-muted/30';
  return (
    <li className="flex items-start gap-3 text-sm">
      <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${tone}`} />
      <div className="flex-1 min-w-0">
        <div className={`${done ? 'text-text-primary' : 'text-text-muted'} ${danger ? 'text-danger' : ''}`}>
          {label}
        </div>
        {ts ? (
          <div className="text-xs text-text-secondary" title={formatDate(new Date(ts), 'MMM d, yyyy HH:mm:ss')}>
            {formatDistanceToNow(new Date(ts), { addSuffix: true })}
          </div>
        ) : (
          <div className="text-xs text-text-muted">—</div>
        )}
      </div>
    </li>
  );
}

// ── Services breakdown ──────────────────────────────────────────────────

function ServicesCard({ services }: { services: OrderServiceLine[] }) {
  const sorted = useMemo(
    () => [...services].sort((a, b) => a.display_order - b.display_order),
    [services],
  );
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Services breakdown</h3>
      {sorted.length === 0 ? (
        <p className="text-sm text-text-secondary">
          No service breakdown available (pre-Phase-10 booking).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="text-left py-2">Service</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2">Started</th>
                <th className="text-left py-2">Completed</th>
                <th className="text-left py-2">Skip reason</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.service_id} className="border-t border-border">
                  <td className="py-2.5">
                    <div className="text-text-primary">{s.service_name}</div>
                    <div className="text-[11px] text-text-muted">
                      {s.duration_minutes}m · ₹{(s.price_paise / 100).toFixed(0)}
                    </div>
                  </td>
                  <td className="py-2.5"><StatusPill tone={serviceTone(s.status)}>{s.status}</StatusPill></td>
                  <td className="py-2.5 text-text-secondary">
                    {s.started_at ? formatDate(new Date(s.started_at), 'HH:mm') : '—'}
                  </td>
                  <td className="py-2.5 text-text-secondary">
                    {s.completed_at ? formatDate(new Date(s.completed_at), 'HH:mm') : '—'}
                  </td>
                  <td className="py-2.5 text-text-secondary text-xs">{s.skip_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function serviceTone(s: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (s) {
    case 'completed': return 'success';
    case 'in_progress': return 'info';
    case 'skipped': return 'warning';
    default: return 'neutral';
  }
}

// ── Admin notes ─────────────────────────────────────────────────────────

const noteSchema = z.object({
  body: z.string().trim().min(3, 'min 3 characters').max(2000, 'max 2000 characters'),
});

function NotesCard({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const canAdd = usePermission('orders.add_note');
  const q = useQuery({
    queryKey: orderKeys.notes(orderId),
    queryFn: () => ordersApi.listNotes(orderId),
  });
  const f = useForm<{ body: string }>({
    resolver: zodResolver(noteSchema),
    mode: 'onChange',
    defaultValues: { body: '' },
  });
  const m = useMutation({
    mutationFn: (body: string) => ordersApi.addNote(orderId, body),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Note added.' });
      f.reset({ body: '' });
      void qc.invalidateQueries({ queryKey: orderKeys.notes(orderId) });
    },
  });
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-primary" />
        Admin notes
      </h3>
      <div className="space-y-3">
        {q.isLoading ? (
          <Skeleton className="h-12" />
        ) : (q.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-text-secondary">No notes yet.</p>
        ) : (
          q.data!.map((n) => <NoteItem key={n.id} n={n} />)
        )}
      </div>
      {canAdd && (
        <form
          onSubmit={f.handleSubmit((v) => m.mutate(v.body))}
          className="mt-4 pt-4 border-t border-border space-y-2"
        >
          <textarea
            className="input min-h-[70px] resize-y"
            placeholder="Add a note about this booking…"
            {...f.register('body')}
          />
          {f.formState.errors.body && (
            <p className="text-xs text-danger">{f.formState.errors.body.message as string}</p>
          )}
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={m.isPending}>
              {m.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Add note
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

function NoteItem({ n }: { n: OrderNote }) {
  return (
    <div className="card-elevated p-3">
      <div className="flex items-center justify-between text-xs text-text-muted mb-1">
        <span className={n.admin_email ? '' : 'font-mono'}>
          {n.admin_email ?? n.admin_id.slice(0, 8)}
        </span>
        <span title={formatDate(new Date(n.created_at), 'MMM d, yyyy HH:mm')}>
          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{n.body}</p>
    </div>
  );
}

// ── Customer card ───────────────────────────────────────────────────────

function CustomerCard({ order }: { order: OrderDetail }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Customer</h3>
      <div className="space-y-2 text-sm">
        <KV k="Name" v={order.customer_name ?? '—'} />
        <KV k="Phone" v={order.customer_phone} mono />
        <KV
          k="Address"
          v={order.address || '—'}
          multiline
        />
        <KV
          k="Customer ID"
          v={
            <Link to={`/users?id=${order.customer_id}`} className="font-mono text-[12px] hover:text-primary">
              {order.customer_id.slice(0, 8)}
            </Link>
          }
        />
      </div>
      {order.lat !== 0 && order.lng !== 0 && (
        <div className="mt-4 w-full h-[180px] rounded-xl overflow-hidden border border-border">
          <GoogleMapWrapper
            center={{ lat: order.lat, lng: order.lng }}
            zoom={14}
            style={{ width: '100%', height: '100%' }}
            disableDefaultUI
          >
            <MarkerF position={{ lat: order.lat, lng: order.lng }} />
          </GoogleMapWrapper>
        </div>
      )}
    </Card>
  );
}

function KV({
  k, v, multiline, mono,
}: { k: string; v: React.ReactNode; multiline?: boolean; mono?: boolean }) {
  return (
    <div className={`flex ${multiline ? 'flex-col gap-1' : 'items-baseline gap-3'}`}>
      <span className="text-text-muted min-w-[120px] text-xs uppercase tracking-wider">{k}</span>
      <span className={`text-text-primary break-words ${mono ? 'font-mono text-[12px]' : ''}`}>{v}</span>
    </div>
  );
}

// ── Pro/Worker card ─────────────────────────────────────────────────────

function ProCard({ order }: { order: OrderDetail }) {
  if (!order.worker_id) {
    return (
      <Card>
        <h3 className="text-sm font-semibold mb-3">Pro</h3>
        <div className="card-elevated p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-text-muted/30 flex items-center justify-center">
            <UserPlus className="w-4 h-4 text-text-muted" />
          </div>
          <div className="flex-1">
            <div className="text-sm text-text-primary">Unassigned</div>
            <div className="text-xs text-text-muted">Use Force Assign below to manually pick a pro.</div>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Pro</h3>
      <div className="space-y-2 text-sm">
        <KV k="Name" v={order.worker_name ?? '—'} />
        <KV k="Phone" v={order.worker_phone ?? '—'} mono />
        <KV k="Worker ID" v={
          <Link to={`/workers?id=${order.worker_id}`} className="font-mono text-[12px] hover:text-primary">
            {order.worker_id.slice(0, 8)}
          </Link>
        } />
      </div>
      <div className="mt-4 flex justify-end">
        <Link to={`/workers?id=${order.worker_id}`} className="btn-ghost text-xs">
          <Star className="w-3 h-3" />
          View pro
        </Link>
      </div>
    </Card>
  );
}

// ── Admin actions card ──────────────────────────────────────────────────

function ActionsCard({ order }: { order: OrderDetail }) {
  const qc = useQueryClient();
  const canReassign = usePermission('orders.reassign');
  const canComplete = usePermission('orders.complete');
  const canCancel = usePermission('orders.cancel');
  const canRefund = usePermission('refunds.approve_full');
  const [assignOpen, setAssignOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orderKeys.detail(order.id) });
    void qc.invalidateQueries({ queryKey: orderKeys.all });
  };

  const complete = useMutation({
    mutationFn: () => ordersApi.complete(order.id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Booking marked completed.' });
      invalidate();
      setCompleteOpen(false);
    },
  });
  const cancel = useMutation({
    mutationFn: () => ordersApi.cancel(order.id, cancelReason.trim()),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Booking cancelled.' });
      invalidate();
      setCancelOpen(false);
      setCancelReason('');
    },
  });

  const completable = ['accepted', 'in_progress', 'arrived', 'en_route'].includes(order.status);

  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Admin actions</h3>
      <div className="grid grid-cols-1 gap-2">
        {canReassign && (
          <button className="btn-ghost text-left" onClick={() => setAssignOpen(true)}>
            <UserPlus className="w-4 h-4" />
            {order.worker_id ? 'Reassign pro' : 'Assign pro'}
          </button>
        )}
        {canComplete && (
          <button
            className="btn-ghost text-left text-success"
            disabled={!completable}
            title={!completable ? 'Only available when accepted / in_progress / arrived / en_route' : undefined}
            onClick={() => setCompleteOpen(true)}
          >
            <CheckCircle2 className="w-4 h-4" />
            Mark completed
          </button>
        )}
        {canRefund && (
          <button className="btn-ghost text-left text-warning" onClick={() => setRefundOpen(true)}>
            <RotateCcw className="w-4 h-4" />
            Issue refund
          </button>
        )}
        {canCancel && (
          <button className="btn-ghost text-left text-danger" onClick={() => setCancelOpen(true)}>
            <Ban className="w-4 h-4" />
            Cancel booking
          </button>
        )}
      </div>

      <AssignProModal
        orderId={order.id}
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onAssigned={invalidate}
        reassigning={!!order.worker_id}
      />
      <RefundModal
        order={order}
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        onIssued={invalidate}
      />
      <ConfirmModal
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        onConfirm={() => complete.mutateAsync()}
        title="Mark this booking as completed?"
        impact="This triggers pro earnings calculation and the customer rating prompt."
        confirmLabel="Mark completed"
      />
      <ConfirmModal
        open={cancelOpen}
        onClose={() => { setCancelOpen(false); setCancelReason(''); }}
        onConfirm={() => cancel.mutateAsync()}
        title="Cancel this booking?"
        impact={
          <div className="space-y-3">
            <p className="text-danger">
              This will cancel the booking and refund the customer. The pro will be notified.
            </p>
            <textarea
              className="input min-h-[70px] resize-y"
              placeholder="Reason (required, min 5 chars)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
        }
        confirmLabel="Cancel booking"
        destructive
      />
    </Card>
  );
}

function RefundOnlyCard({ order }: { order: OrderDetail }) {
  const qc = useQueryClient();
  const canRefund = usePermission('refunds.approve_full');
  const [refundOpen, setRefundOpen] = useState(false);
  if (!canRefund) return null;
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Post-booking actions</h3>
      <button
        className="btn-primary w-full"
        onClick={() => setRefundOpen(true)}
      >
        <RotateCcw className="w-4 h-4" />
        Issue refund
      </button>
      <RefundModal
        order={order}
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        onIssued={() => void qc.invalidateQueries({ queryKey: orderKeys.detail(order.id) })}
      />
    </Card>
  );
}

// ── Assign / Reassign modal ─────────────────────────────────────────────

const RADIUS_OPTIONS = [5, 10, 20, 50];

function AssignProModal({
  orderId, open, onClose, onAssigned, reassigning,
}: {
  orderId: string;
  open: boolean;
  onClose: () => void;
  onAssigned: () => void;
  reassigning: boolean;
}) {
  const [radius, setRadius] = useState(5);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<AvailableWorker | null>(null);
  const [reason, setReason] = useState('');

  const q = useQuery({
    queryKey: orderKeys.availableWorkers(orderId, radius),
    queryFn: () => ordersApi.availableWorkers(orderId, radius),
    enabled: open,
  });

  const m = useMutation({
    mutationFn: () =>
      ordersApi.reassign(orderId, { new_worker_id: picked!.worker_id, reason: reason.trim() }),
    onSuccess: () => {
      showToast({
        kind: 'success',
        message: `${reassigning ? 'Reassigned' : 'Assigned'} to ${picked?.name}.`,
      });
      onAssigned();
      reset();
      onClose();
    },
  });

  const reset = () => { setPicked(null); setReason(''); setSearch(''); };
  const close = () => { reset(); onClose(); };

  const items = (q.data ?? []).filter((w) =>
    !search || w.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={reassigning ? 'Reassign pro' : 'Assign pro'}
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-text-muted">Search radius</span>
          {RADIUS_OPTIONS.map((r) => (
            <button
              key={r}
              className={`pill !px-3 !py-1.5 ${
                r === radius
                  ? 'border-primary/40 bg-primary/10 text-text-primary'
                  : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => setRadius(r)}
            >
              {r}km
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            className="input pl-9"
            placeholder="Filter by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="card-elevated max-h-[280px] overflow-y-auto">
          {q.isLoading ? (
            <div className="p-4"><Skeleton className="h-16" /></div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-text-secondary">
              No available pros within {radius}km. Increase the radius.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((w) => (
                <li
                  key={w.worker_id}
                  className={`p-3 cursor-pointer flex items-center gap-3 transition ${
                    picked?.worker_id === w.worker_id ? 'bg-primary/10' : 'hover:bg-primary/5'
                  }`}
                  onClick={() => setPicked(w)}
                >
                  <div className="w-9 h-9 rounded-full bg-accent/30 flex items-center justify-center text-sm font-semibold">
                    {w.name[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">{w.name}</div>
                    <div className="text-[11px] text-text-muted">
                      {w.rating.toFixed(2)} ★ · {w.distance_km.toFixed(1)}km · {w.categories.join(', ')}
                    </div>
                  </div>
                  {picked?.worker_id === w.worker_id && <Check className="w-4 h-4 text-primary" />}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
            Reason <span className="text-danger">*</span>
          </label>
          <textarea
            className="input min-h-[70px] resize-y"
            placeholder="Why are you assigning this pro? (min 5 chars)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={close}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!picked || reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {reassigning ? 'Reassign' : 'Assign'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Refund modal ────────────────────────────────────────────────────────

function RefundModal({
  order, open, onClose, onIssued,
}: { order: OrderDetail; open: boolean; onClose: () => void; onIssued: () => void }) {
  const fullRupees = (order.price_paise - order.discount_paise) / 100;
  const [amount, setAmount] = useState<number>(fullRupees);
  const [reason, setReason] = useState('');

  const m = useMutation({
    mutationFn: () =>
      refundsApi.fromOrder(order.id, {
        amount_paise: Math.round(amount * 100),
        reason: reason.trim(),
      }),
    onSuccess: (res) => {
      showToast({
        kind: 'success',
        message: `Refund created (${res.refund_id.slice(0, 8)}).`,
      });
      onIssued();
      reset();
      onClose();
    },
  });

  const reset = () => { setAmount(fullRupees); setReason(''); };

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Issue refund" width="max-w-md">
      <div className="space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
            Amount (₹) <span className="text-danger">*</span>
          </label>
          <input
            className="input font-mono"
            type="number"
            step="0.01"
            min={0.01}
            max={fullRupees}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <p className="text-xs text-text-muted mt-1">
            Full amount = ₹{fullRupees.toFixed(2)}.
          </p>
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
            Reason <span className="text-danger">*</span>
          </label>
          <textarea
            className="input min-h-[70px] resize-y"
            placeholder="Why is this refund being issued?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => { reset(); onClose(); }}>Cancel</button>
          <button
            className="btn-primary"
            disabled={amount <= 0 || amount > fullRupees || reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Issue refund
          </button>
        </div>
      </div>
    </Modal>
  );
}

