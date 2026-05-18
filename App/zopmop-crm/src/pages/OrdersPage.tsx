import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ordersApi, type Order } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';

const PAGE = 25;
const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  completed: 'success', cancelled: 'danger', pending: 'warning',
  in_progress: 'info', en_route: 'info', arrived: 'info', assigned: 'info',
};

// All filter / pagination / sort state lives in the URL so back-navigation
// from /orders/:id preserves the admin's working set, and filtered views
// are shareable / bookmarkable. Pattern mirrors AuditPage.tsx.
type Filters = {
  search: string;
  status: string;
  category: string;
  customer_id: string;
  worker_id: string;
  from: string;
  to: string;
  min_cents: string;
  max_cents: string;
  sort_by: string;
  sort_dir: string;
  limit: number;
  offset: number;
};

function readFilters(sp: URLSearchParams): Filters {
  return {
    search:      sp.get('search') ?? '',
    status:      sp.get('status') ?? '',
    category:    sp.get('category') ?? '',
    customer_id: sp.get('customer_id') ?? '',
    worker_id:   sp.get('worker_id') ?? '',
    from:        sp.get('from') ?? '',
    to:          sp.get('to') ?? '',
    min_cents:   sp.get('min_cents') ?? '',
    max_cents:   sp.get('max_cents') ?? '',
    sort_by:     sp.get('sort_by') ?? '',
    sort_dir:    sp.get('sort_dir') ?? '',
    limit:       Number(sp.get('limit') ?? PAGE),
    offset:      Number(sp.get('offset') ?? 0),
  };
}

function writeFilters(f: Filters): URLSearchParams {
  // Only non-default values land in the URL — keeps it clean.
  const out = new URLSearchParams();
  if (f.search)      out.set('search', f.search);
  if (f.status)      out.set('status', f.status);
  if (f.category)    out.set('category', f.category);
  if (f.customer_id) out.set('customer_id', f.customer_id);
  if (f.worker_id)   out.set('worker_id', f.worker_id);
  if (f.from)        out.set('from', f.from);
  if (f.to)          out.set('to', f.to);
  if (f.min_cents)   out.set('min_cents', f.min_cents);
  if (f.max_cents)   out.set('max_cents', f.max_cents);
  if (f.sort_by)     out.set('sort_by', f.sort_by);
  if (f.sort_dir)    out.set('sort_dir', f.sort_dir);
  if (f.limit !== PAGE) out.set('limit', String(f.limit));
  if (f.offset !== 0)   out.set('offset', String(f.offset));
  return out;
}

// Build the query-key for TanStack. Inert (Record only carries serialisable
// values) so the cache key matches across reloads.
function listParams(f: Filters): Record<string, string | number> {
  const p: Record<string, string | number> = { limit: f.limit, offset: f.offset };
  if (f.search)      p.search = f.search;
  if (f.status)      p.status = f.status;
  if (f.category)    p.category = f.category;
  if (f.customer_id) p.customer_id = f.customer_id;
  if (f.worker_id)   p.worker_id = f.worker_id;
  if (f.from)        p.from = f.from;
  if (f.to)          p.to = f.to;
  if (f.min_cents)   p.min_cents = f.min_cents;
  if (f.max_cents)   p.max_cents = f.max_cents;
  if (f.sort_by)     p.sort_by = f.sort_by;
  if (f.sort_dir)    p.sort_dir = f.sort_dir;
  return p;
}

// OrdersPage — list view only. Row click navigates to /orders/:id detail
// (Phase F). All filter/sort/pagination state is URL-encoded.
export function OrdersPage() {
  const [sp, setSp] = useSearchParams();
  const filters = readFilters(sp);
  const nav = useNavigate();

  const q = useQuery({
    queryKey: ['orders', listParams(filters)],
    queryFn: () => ordersApi.list(listParams(filters)),
    placeholderData: keepPreviousData,
  });

  // Filter changes reset offset to 0 so admins don't get paginated mid-list
  // after narrowing results. Pagination changes (offset/limit) skip that
  // reset by passing keepOffset.
  const update = (patch: Partial<Filters>, keepOffset = false) => {
    const next: Filters = { ...filters, ...patch };
    if (!keepOffset && !('offset' in patch)) next.offset = 0;
    setSp(writeFilters(next));
  };
  const clear = () => setSp(new URLSearchParams());

  const total = q.data?.total_count ?? 0;
  const page = Math.floor(filters.offset / filters.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / filters.limit));

  const hasFilters = Boolean(
    filters.search || filters.status || filters.category ||
    filters.customer_id || filters.worker_id || filters.from || filters.to ||
    filters.min_cents || filters.max_cents,
  );

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
              value={filters.search}
              onChange={(e) => update({ search: e.target.value })}
            />
          </div>
          <select
            className="input max-w-[180px]"
            value={filters.status}
            onChange={(e) => update({ status: e.target.value })}
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
          <input
            className="input max-w-[160px]"
            type="date"
            value={filters.from}
            onChange={(e) => update({ from: e.target.value })}
            aria-label="From"
          />
          <input
            className="input max-w-[160px]"
            type="date"
            value={filters.to}
            onChange={(e) => update({ to: e.target.value })}
            aria-label="To"
          />
          {hasFilters && (
            <button className="btn-ghost !py-1.5 !px-3 text-xs" onClick={clear}>
              <X className="w-3 h-3" /> Clear
            </button>
          )}
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
              <Row key={o.id} order={o} alt={i % 2 === 1} onClick={() => nav(`/orders/${o.id}`)} />
            ))}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-text-secondary">
          <span>{filters.offset + 1}–{Math.min(filters.offset + (q.data?.items.length ?? 0), total)} of {total}</span>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost !py-1 !px-2 text-xs"
              disabled={page === 1}
              onClick={() => update({ offset: Math.max(0, filters.offset - filters.limit) }, true)}
            >← Prev</button>
            <span>Page {page} of {pages}</span>
            <button
              className="btn-ghost !py-1 !px-2 text-xs"
              disabled={page >= pages}
              onClick={() => update({ offset: filters.offset + filters.limit }, true)}
            >Next →</button>
          </div>
        </div>
      </Card>
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
      <td className="px-4 py-3 text-right tabular-nums">{fmt(order.price_paise)}{order.discount_paise > 0 && <div className="text-[11px] text-text-muted">−{fmt(order.discount_paise)} {order.promo_code ?? ''}</div>}</td>
      <td className="px-4 py-3"><StatusPill tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</StatusPill></td>
      <td className="px-4 py-3 text-right text-text-secondary">{new Date(order.created_at).toLocaleString()}</td>
    </tr>
  );
}
