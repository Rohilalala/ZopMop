import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ExternalLink, Loader2 } from 'lucide-react';
import {
  allocateLeave,
  getBalances,
  listLeaves,
  type LeaveBalance,
  type LeaveRow,
  type ReassignmentOutcome,
} from '@/api/leaves';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { showToast } from '@/components/ui/Toast';

const OUTCOME_TONE: Record<ReassignmentOutcome, 'success' | 'warning' | 'danger' | 'neutral'> = {
  reassigned: 'success',
  partially_reassigned: 'warning',
  cancelled: 'danger',
  none: 'neutral',
};

const OUTCOME_LABEL: Record<ReassignmentOutcome, string> = {
  reassigned: 'Reassigned',
  partially_reassigned: 'Partially reassigned',
  cancelled: 'Cancelled',
  none: 'None',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function LeavesPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [proIdFilter, setProIdFilter] = useState('');

  const leavesQ = useQuery({
    queryKey: ['leaves', { from, to, proIdFilter }],
    queryFn: () => listLeaves({
      from: from || undefined,
      to: to || undefined,
      pro_id: proIdFilter || undefined,
      limit: 100,
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const balancesQ = useQuery({
    queryKey: ['leaves', 'balances', proIdFilter],
    queryFn: () => getBalances(proIdFilter || undefined),
  });

  // Map pro_id → balance, for inline lookup in the action column.
  const balanceByProID = useMemo(() => {
    const m = new Map<string, LeaveBalance>();
    for (const b of balancesQ.data ?? []) m.set(b.pro_id, b);
    return m;
  }, [balancesQ.data]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarDays className="w-5 h-5" /> Leaves
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Pro leave declarations + reassignment outcomes. Allocate extra days from the action column.
        </p>
      </div>

      <Card className="!p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
          </Field>
          <Field label="Filter by pro id">
            <input
              type="text"
              placeholder="pro UUID"
              value={proIdFilter}
              onChange={(e) => setProIdFilter(e.target.value)}
              className="input w-[280px]"
            />
          </Field>
          {(from || to || proIdFilter) && (
            <button
              type="button"
              onClick={() => { setFrom(''); setTo(''); setProIdFilter(''); }}
              className="text-sm text-text-secondary hover:text-text-primary px-3 py-2"
            >
              Clear
            </button>
          )}
        </div>
      </Card>

      <BalancesStrip data={balancesQ.data ?? []} loading={balancesQ.isLoading} />

      <Card className="!p-0 overflow-hidden">
        {leavesQ.isLoading ? (
          <div className="p-5"><Skeleton className="h-32" /></div>
        ) : (leavesQ.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No leaves found" body="Try widening the date range." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Pro</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Declared at</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Bookings affected</th>
                <th className="px-4 py-3 text-left">Reassignment</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {leavesQ.data!.items.map((row) => (
                <Row key={row.id} row={row} balance={balanceByProID.get(row.pro_id)} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Row({ row, balance }: { row: LeaveRow; balance?: LeaveBalance }) {
  const cancelled = row.reassignment_outcome === 'cancelled';
  return (
    <tr className={`border-t border-border ${cancelled ? 'bg-danger/10' : 'hover:bg-surface-elevated/40'}`}>
      <td className="px-4 py-3">
        <div className="font-medium text-text-primary">{row.pro_name || '—'}</div>
        <div className="text-xs text-text-muted">{row.pro_phone}</div>
      </td>
      <td className="px-4 py-3">{fmtDate(row.date)}</td>
      <td className="px-4 py-3 text-text-secondary">{fmtDateTime(row.declared_at)}</td>
      <td className="px-4 py-3">
        <StatusPill tone={row.status === 'approved' ? 'success' : 'neutral'}>{row.status}</StatusPill>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{row.bookings_affected}</td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <StatusPill tone={OUTCOME_TONE[row.reassignment_outcome]}>
            {OUTCOME_LABEL[row.reassignment_outcome]}
          </StatusPill>
          {cancelled && row.cancelled_booking_ids.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {row.cancelled_booking_ids.map((bid) => (
                <Link
                  key={bid}
                  to={`/orders?id=${bid}`}
                  className="inline-flex items-center gap-1 text-[11px] text-danger hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  View Booking {bid.slice(0, 8)}
                </Link>
              ))}
            </div>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <AllocateAction proId={row.pro_id} balance={balance} />
      </td>
    </tr>
  );
}

function AllocateAction({ proId, balance }: { proId: string; balance?: LeaveBalance }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(1);

  const mut = useMutation({
    mutationFn: () => allocateLeave(proId, days),
    onSuccess: (data) => {
      showToast({ kind: 'success', message: `Allocated. New balance: ${data.new_balance}` });
      void qc.invalidateQueries({ queryKey: ['leaves'] });
      setDays(1);
    },
    onError: () => showToast({ kind: 'error', message: 'Failed to allocate' }),
  });

  return (
    <div className="flex items-center gap-2 justify-end">
      {balance && (
        <span className="text-[11px] text-text-muted whitespace-nowrap">
          bal {balance.balance} / used {balance.used_this_month}
        </span>
      )}
      <input
        type="number"
        min={1}
        max={31}
        value={days}
        onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
        className="input w-16 text-right tabular-nums"
      />
      <button
        type="button"
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
        className="btn-primary text-xs px-3 py-1.5 disabled:opacity-60"
      >
        {mut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Allocate'}
      </button>
    </div>
  );
}

function BalancesStrip({ data, loading }: { data: LeaveBalance[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-20" />;
  if (data.length === 0) return null;
  // Show top 6 — full table would dwarf the page; fuller view comes from filter.
  const shown = data.slice(0, 6);
  return (
    <Card className="!p-4">
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">
        Pro balances (current month)
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {shown.map((b) => (
          <div key={b.pro_id} className="rounded-xl border border-border p-3">
            <div className="text-sm font-medium truncate">{b.pro_name || '—'}</div>
            <div className="text-[11px] text-text-muted truncate">{b.pro_phone}</div>
            <div className="mt-2 flex justify-between items-baseline">
              <span className="text-lg font-semibold tabular-nums">{b.balance}</span>
              <span className="text-[11px] text-text-muted">
                {b.used_this_month} used / {b.monthly_quota} quota
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}
