import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Camera, RefreshCw, ShieldAlert } from 'lucide-react';

import { listShiftSessions, shiftSessionKeys, type ShiftSession } from '@/api/shiftSessions';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { usePermission } from '@/auth/usePermission';

const PAGE = 50;
const REFRESH_MS = 30_000;

// ShiftSessionsPage — read-only view of pro shift sessions and their
// go-online / go-offline selfies. Permission-gated at the page boundary.
export function ShiftSessionsPage() {
  const canRead = usePermission('shift_sessions.read');
  const [offset, setOffset] = useState(0);

  const q = useQuery({
    queryKey: shiftSessionKeys.list(PAGE, offset),
    queryFn: () => listShiftSessions(PAGE, offset),
    refetchInterval: REFRESH_MS,
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<ShieldAlert className="w-12 h-12" />}
          title="Restricted"
          body="Your role does not have permission to view shift-session selfies."
        />
      </div>
    );
  }

  const items = q.data?.items ?? [];
  const total = q.data?.total_count ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Shift Sessions</h1>
          <p className="text-sm text-text-muted">Go-online / go-offline selfies (proof-of-presence).</p>
        </div>
        <button
          onClick={() => q.refetch()}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-elevated"
        >
          <RefreshCw className={`w-4 h-4 ${q.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {q.isLoading ? (
        <Card><Skeleton className="h-40" /></Card>
      ) : q.isError ? (
        <Card><ErrorState title="Could not load shift sessions" onRetry={() => q.refetch()} /></Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Camera className="w-12 h-12" />}
            title="No shift sessions yet"
            body="Sessions appear here once a pro goes online."
          />
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider sticky top-0 z-10">
              <tr>
                <Th>Pro</Th>
                <Th>Phone</Th>
                <Th>Online</Th>
                <Th>Offline</Th>
                <Th>Minutes</Th>
                <Th>Online selfie</Th>
                <Th>Offline selfie</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => <Row key={s.id} s={s} alt={i % 2 === 1} />)}
            </tbody>
          </table>
        </Card>
      )}

      {total > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="text-left font-medium px-4 py-3">{children}</th>;
}

function fmt(ts?: string | null): string {
  if (!ts) return '—';
  try {
    return format(new Date(ts), 'dd MMM, HH:mm');
  } catch {
    return ts;
  }
}

function Selfie({ url }: { url?: string | null }) {
  if (!url) return <span className="text-text-muted">—</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="selfie" className="w-12 h-12 rounded-lg object-cover border border-border" />
    </a>
  );
}

function Row({ s, alt }: { s: ShiftSession; alt: boolean }) {
  return (
    <tr className={alt ? 'bg-surface-elevated/30' : ''}>
      <td className="px-4 py-3">{s.pro_name ?? '—'}</td>
      <td className="px-4 py-3">{s.pro_phone ?? '—'}</td>
      <td className="px-4 py-3">{fmt(s.online_at)}</td>
      <td className="px-4 py-3">{s.offline_at ? fmt(s.offline_at) : <span className="text-green-500">online</span>}</td>
      <td className="px-4 py-3">{s.online_minutes ?? '—'}</td>
      <td className="px-4 py-3"><Selfie url={s.online_selfie_url} /></td>
      <td className="px-4 py-3"><Selfie url={s.offline_selfie_url} /></td>
    </tr>
  );
}
