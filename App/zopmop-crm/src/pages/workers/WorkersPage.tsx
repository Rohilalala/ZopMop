import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus, Search, Star } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { listWorkers, type ListParams, type Status, type WorkerListItem } from '@/api/workers';
import { Can } from '@/auth/Can';
import { Card, EmptyState, ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { WorkerDrawer } from './WorkerDrawer';

// UUID v4-ish guard. Audit/order/email links may pass anything in ?id= —
// drop quietly on bad input rather than firing a bogus GET /workers/<garbage>.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WorkersPage: same shape as UsersPage but driven by the workers endpoint.
// Adds an "online only" filter and a category-string match.

const STATUS_OPTIONS: { value: Status | ''; label: string }[] = [
  { value: '',          label: 'All statuses' },
  { value: 'active',    label: 'Active' },
  { value: 'pending',   label: 'Pending approval' },
  { value: 'rejected',  label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'banned',    label: 'Banned' },
];
const PAGE_SIZE = 25;

export function WorkersPage() {
  const [params, setParams] = useState<ListParams>({
    sort_by: 'joined_at',
    sort_dir: 'desc',
    limit: PAGE_SIZE,
    offset: 0,
  });
  // Drawer state is driven by ?id= in the URL so deep links from AuditPage
  // and OrderDetailPage open the right worker. Browser back / forward also
  // wires through useSearchParams, so popstate closes the drawer for free.
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawerId, setDrawerId] = useState<string | null>(null);

  useEffect(() => {
    const raw = searchParams.get('id');
    setDrawerId(raw && UUID_RE.test(raw) ? raw : null);
  }, [searchParams]);

  const openDrawer = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('id', id);
    setSearchParams(sp);
  };
  const closeDrawer = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('id');
    setSearchParams(sp);
  };

  const q = useQuery({
    queryKey: ['workers', params],
    queryFn: () => listWorkers(params),
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total_count ?? 0;
  const page = Math.floor((params.offset ?? 0) / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function update(patch: Partial<ListParams>) {
    setParams((p) => ({ ...p, ...patch, offset: 'offset' in patch ? patch.offset! : 0 }));
  }
  function toggleSort(col: NonNullable<ListParams['sort_by']>) {
    setParams((p) => ({
      ...p,
      sort_by: col,
      sort_dir: p.sort_by === col && p.sort_dir === 'desc' ? 'asc' : 'desc',
      offset: 0,
    }));
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="text-sm text-text-secondary mt-1">
            Pro accounts. Approve applications, manage suspensions, monitor performance.
          </p>
        </div>
        <Can perm="workers.create">
          <Link to="/workers/new" className="btn-primary shrink-0">
            <Plus className="w-4 h-4" />
            New Pro
          </Link>
        </Can>
      </div>

      <Card className="!p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-9"
              placeholder="Search by name, phone, or email…"
              value={params.search ?? ''}
              onChange={(e) => update({ search: e.target.value })}
            />
          </div>
          <select
            className="input max-w-[200px]"
            value={params.status ?? ''}
            onChange={(e) => update({ status: e.target.value as Status | '' })}
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            className="input max-w-[180px]"
            placeholder="Category…"
            value={params.category ?? ''}
            onChange={(e) => update({ category: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary px-3 h-11 border border-border rounded-xl bg-surface-elevated cursor-pointer">
            <input
              type="checkbox"
              checked={params.only_online ?? false}
              onChange={(e) => update({ only_online: e.target.checked || undefined })}
            />
            Online only
          </label>
        </div>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider sticky top-0 z-10">
            <tr>
              <Th>Worker</Th>
              <Th>Phone</Th>
              <Th>Categories</Th>
              <ThSort label="Rating" col="rating" current={params} onClick={toggleSort} align="right" />
              <ThSort label="Jobs" col="total_jobs" current={params} onClick={toggleSort} align="right" />
              <ThSort label="Joined" col="joined_at" current={params} onClick={toggleSort} />
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <RowSkeletons />
            ) : q.isError ? (
              <tr><td colSpan={7}><ErrorState title="Could not load workers" onRetry={() => q.refetch()} /></td></tr>
            ) : (q.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={7}>
                <EmptyState
                  title={params.search ? `No matches for "${params.search}"` : 'No workers'}
                  body={params.search ? 'Try a different search term.' : 'Pro accounts will appear here once they sign up.'}
                />
              </td></tr>
            ) : (
              q.data?.items.map((w, i) => (
                <Row key={w.id} worker={w} alt={i % 2 === 1} onClick={() => openDrawer(w.id)} />
              ))
            )}
          </tbody>
        </table>

        {(q.data?.items.length ?? 0) > 0 && (
          <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-text-secondary">
            <span>
              {(params.offset ?? 0) + 1}–{Math.min((params.offset ?? 0) + (q.data?.items.length ?? 0), total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                className="btn-ghost !py-1 !px-2 text-xs"
                disabled={page === 1}
                onClick={() => update({ offset: Math.max(0, (params.offset ?? 0) - PAGE_SIZE) })}
              >← Prev</button>
              <span>Page {page} of {pages}</span>
              <button
                className="btn-ghost !py-1 !px-2 text-xs"
                disabled={page >= pages}
                onClick={() => update({ offset: (params.offset ?? 0) + PAGE_SIZE })}
              >Next →</button>
            </div>
          </div>
        )}
      </Card>

      <WorkerDrawer workerId={drawerId} onClose={closeDrawer} />
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 font-medium text-${align}`}>{children}</th>;
}
function ThSort({
  label, col, current, onClick, align = 'left',
}: {
  label: string;
  col: NonNullable<ListParams['sort_by']>;
  current: ListParams;
  onClick: (c: NonNullable<ListParams['sort_by']>) => void;
  align?: 'left' | 'right';
}) {
  const active = current.sort_by === col;
  return (
    <th className={`px-4 py-3 font-medium text-${align}`}>
      <button
        className={`inline-flex items-center gap-1 transition ${active ? 'text-text-primary' : 'hover:text-text-primary'}`}
        onClick={() => onClick(col)}
      >
        {label}
        {active && (current.sort_dir === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
      </button>
    </th>
  );
}

function Row({ worker, alt, onClick }: { worker: WorkerListItem; alt: boolean; onClick: () => void }) {
  return (
    <tr
      className={`border-t border-border cursor-pointer transition ${alt ? 'bg-surface-elevated/40' : ''} hover:bg-primary/5`}
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative shrink-0">
            <div className="w-8 h-8 rounded-full bg-accent/30 flex items-center justify-center text-xs font-semibold">
              {(worker.name ?? worker.phone)[0]?.toUpperCase()}
            </div>
            <span
              title={worker.is_online ? 'Online' : 'Offline'}
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${
                worker.is_online ? 'bg-success' : 'bg-text-muted'
              }`}
            />
          </div>
          <div className="min-w-0">
            <div className="text-text-primary truncate">{worker.name ?? '—'}</div>
            <div className="text-[11px] text-text-muted font-mono truncate">{worker.id.slice(0, 8)}</div>
          </div>
          {worker.is_vip && <Star className="w-3.5 h-3.5 text-warning fill-warning" />}
        </div>
      </td>
      <td className="px-4 py-3">{worker.phone}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {worker.categories.length === 0
            ? <span className="text-text-muted">—</span>
            : worker.categories.slice(0, 3).map((c) => (
              <span key={c} className="pill border-border bg-surface-elevated text-text-secondary !px-2 !py-0.5">{c}</span>
            ))}
          {worker.categories.length > 3 && (
            <span className="text-text-muted text-xs">+{worker.categories.length - 3}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span className="inline-flex items-center gap-1">
          <Star className="w-3 h-3 text-warning fill-warning" />
          {worker.rating.toFixed(2)}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{worker.total_jobs}</td>
      <td className="px-4 py-3">{new Date(worker.joined_at).toLocaleDateString()}</td>
      <td className="px-4 py-3">
        <StatusPill tone={
          worker.status === 'active' ? 'success'
          : worker.status === 'pending' ? 'warning'
          : worker.status === 'rejected' ? 'danger'
          : worker.status === 'suspended' ? 'warning'
          : worker.status === 'banned' ? 'danger'
          : 'neutral'
        }>{worker.status}</StatusPill>
      </td>
    </tr>
  );
}

function RowSkeletons() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} className="border-t border-border">
          {Array.from({ length: 7 }).map((_, j) => (
            <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
          ))}
        </tr>
      ))}
    </>
  );
}
