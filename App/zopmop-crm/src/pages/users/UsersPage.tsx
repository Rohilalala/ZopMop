import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Search, Star } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { listUsers, type ListParams, type Status, type UserListItem } from '@/api/users';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { formatRupees } from '@/lib/formatters';
import { UserDrawer } from './UserDrawer';

// UUID guard for the ?id= deep-link param. Same shape used by WorkersPage.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UsersPage: full database view. Server-side everything (search/filter/sort/
// page) — no client-side filtering, so 100k users render fine.

const STATUS_OPTIONS: { value: Status | ''; label: string }[] = [
  { value: '',          label: 'All statuses' },
  { value: 'active',    label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'banned',    label: 'Banned' },
];
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: '',         label: 'All roles' },
  { value: 'customer', label: 'Customer' },
  { value: 'pro',      label: 'Pro' },
];

const PAGE_SIZE = 25;

export function UsersPage() {
  const [params, setParams] = useState<ListParams>({
    sort_by: 'joined_at',
    sort_dir: 'desc',
    limit: PAGE_SIZE,
    offset: 0,
  });
  // Drawer state lives in ?id= so AuditPage / OrderDetailPage links land on
  // the right user. Browser back / forward close the drawer for free.
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
    queryKey: ['users', params],
    queryFn: () => listUsers(params),
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-text-secondary mt-1">
          Customer + pro database. Search, filter, drill in.
        </p>
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
            className="input max-w-[160px]"
            value={params.status ?? ''}
            onChange={(e) => update({ status: e.target.value as Status | '' })}
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select
            className="input max-w-[140px]"
            value={params.role ?? ''}
            onChange={(e) => update({ role: e.target.value })}
          >
            {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-text-secondary px-3 h-11 border border-border rounded-xl bg-surface-elevated cursor-pointer">
            <input
              type="checkbox"
              checked={params.is_vip ?? false}
              onChange={(e) => update({ is_vip: e.target.checked || undefined })}
            />
            VIP only
          </label>
        </div>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider sticky top-0 z-10">
            <tr>
              <Th>User</Th>
              <Th>Phone / email</Th>
              <Th>Role</Th>
              <ThSort label="Joined" col="joined_at" current={params} onClick={toggleSort} />
              <ThSort label="Orders" col="total_orders" current={params} onClick={toggleSort} align="right" />
              <ThSort label="LTV" col="ltv_cents" current={params} onClick={toggleSort} align="right" />
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <RowSkeletons />
            ) : (q.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={7}>
                <EmptyState
                  title={params.search ? `No matches for "${params.search}"` : 'No users yet'}
                  body={params.search ? 'Try a different search term or clear filters.' : undefined}
                />
              </td></tr>
            ) : (
              q.data?.items.map((u, i) => (
                <Row
                  key={u.id}
                  user={u}
                  alt={i % 2 === 1}
                  onClick={() => openDrawer(u.id)}
                />
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
              >
                ← Prev
              </button>
              <span>Page {page} of {pages}</span>
              <button
                className="btn-ghost !py-1 !px-2 text-xs"
                disabled={page >= pages}
                onClick={() => update({ offset: (params.offset ?? 0) + PAGE_SIZE })}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </Card>

      <UserDrawer userId={drawerId} onClose={closeDrawer} />
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

function Row({ user, alt, onClick }: { user: UserListItem; alt: boolean; onClick: () => void }) {
  return (
    <tr
      className={`border-t border-border cursor-pointer transition ${alt ? 'bg-surface-elevated/40' : ''} hover:bg-primary/5`}
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-primary/30 flex items-center justify-center text-xs font-semibold shrink-0">
            {(user.name ?? user.phone)[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-text-primary truncate">{user.name ?? '—'}</div>
            <div className="text-[11px] text-text-muted font-mono truncate">{user.id.slice(0, 8)}</div>
          </div>
          {user.is_vip && <Star className="w-3.5 h-3.5 text-warning fill-warning" />}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="text-text-primary">{user.phone}</div>
        {user.email && <div className="text-[11px] text-text-secondary">{user.email}</div>}
      </td>
      <td className="px-4 py-3 capitalize">{user.role}</td>
      <td className="px-4 py-3">{new Date(user.joined_at).toLocaleDateString()}</td>
      <td className="px-4 py-3 text-right tabular-nums">{user.total_orders}</td>
      <td className="px-4 py-3 text-right tabular-nums">{formatRupees(user.ltv_paise)}</td>
      <td className="px-4 py-3">
        <StatusPill tone={
          user.status === 'active' ? 'success'
          : user.status === 'suspended' ? 'warning'
          : user.status === 'banned' ? 'danger'
          : 'neutral'
        }>{user.status}</StatusPill>
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
