import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleF, MarkerF } from '@react-google-maps/api';
import { formatDistanceToNow, format as formatDate } from 'date-fns';
import {
  Check, MapPin, Phone, RefreshCw, ShieldAlert, X,
} from 'lucide-react';

import {
  approveZoneRequest, listPendingZoneApprovals, rejectZoneRequest,
  zoneApprovalKeys, type ZoneApprovalRequest,
} from '@/api/zoneApprovals';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Card, EmptyState, ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { GoogleMapWrapper } from '@/components/maps/GoogleMapWrapper';
import { usePermission } from '@/auth/usePermission';

const REFRESH_MS = 30_000;

// ZoneApprovalsPage — pending review queue. Auto-refreshes every 30s; a row
// click opens the drawer. Permission-gated at the page boundary.
export function ZoneApprovalsPage() {
  const canRead = usePermission('zones.approval.read');
  const [activeId, setActiveId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: zoneApprovalKeys.pending,
    queryFn: listPendingZoneApprovals,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<ShieldAlert className="w-12 h-12" />}
          title="Restricted"
          body="Your role does not have permission to view zone approvals."
        />
      </div>
    );
  }

  const items = q.data ?? [];
  const activeRequest = items.find((r) => r.id === activeId) ?? null;

  return (
    <div className="p-6 space-y-6">
      <Header
        count={items.length}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
      />

      {q.isLoading ? (
        <Card><Skeleton className="h-40" /></Card>
      ) : q.isError ? (
        <Card><ErrorState title="Could not load zone approvals" onRetry={() => q.refetch()} /></Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MapPin className="w-12 h-12" />}
            title="No pending zone approvals"
            body="Approved pros and rejected requests don't show here — check the audit log for history."
          />
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider sticky top-0 z-10">
              <tr>
                <Th>Pro</Th>
                <Th>Phone</Th>
                <Th>Distance from zone</Th>
                <Th>Requested</Th>
                <Th>Photo</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <Row
                  key={r.id}
                  req={r}
                  alt={i % 2 === 1}
                  onReview={() => setActiveId(r.id)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ReviewDrawer
        request={activeRequest}
        onClose={() => setActiveId(null)}
      />
    </div>
  );
}

function Header({
  count, isFetching, onRefresh,
}: { count: number; isFetching: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Zone Approvals</h1>
        <p className="text-sm text-text-secondary mt-1">
          {count} {count === 1 ? 'request' : 'requests'} pending review · auto-refreshes every 30s
        </p>
      </div>
      <button
        className="btn-ghost"
        onClick={onRefresh}
        disabled={isFetching}
        aria-label="refresh"
      >
        <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 font-medium text-${align}`}>{children}</th>;
}

function Row({
  req, alt, onReview,
}: { req: ZoneApprovalRequest; alt: boolean; onReview: () => void }) {
  const distance = formatDistance(req.distance_meters);
  return (
    <tr
      className={`border-t border-border cursor-pointer transition ${alt ? 'bg-surface-elevated/40' : ''} hover:bg-primary/5`}
      onClick={onReview}
    >
      <td className="px-4 py-3">
        <div className="min-w-0">
          <div className="text-text-primary truncate">{req.pro_name ?? '—'}</div>
          <div className="text-[11px] text-text-muted font-mono truncate">{req.pro_id.slice(0, 8)}</div>
        </div>
      </td>
      <td className="px-4 py-3 font-mono">{req.pro_phone ?? '—'}</td>
      <td className="px-4 py-3 tabular-nums">{distance}</td>
      <td className="px-4 py-3 text-text-secondary">
        <span title={formatDate(new Date(req.requested_at), 'MMM d, yyyy HH:mm')}>
          {formatDistanceToNow(new Date(req.requested_at), { addSuffix: true })}
        </span>
      </td>
      <td className="px-4 py-3">
        {req.photo_url ? (
          <img
            src={req.photo_url}
            alt="proof"
            className="w-10 h-10 rounded-lg object-cover border border-border"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-text-muted text-xs">no photo</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          className="btn-primary !py-1.5 !px-3 text-xs"
          onClick={(e) => { e.stopPropagation(); onReview(); }}
        >
          Review
        </button>
      </td>
    </tr>
  );
}

function formatDistance(m: number | null | undefined): string {
  if (m == null) return '—';
  const v = Math.max(0, m);
  if (v < 1000) return `${Math.round(v)}m`;
  return `${(v / 1000).toFixed(1)}km`;
}

// ── Review drawer ───────────────────────────────────────────────────────

function ReviewDrawer({
  request, onClose,
}: { request: ZoneApprovalRequest | null; onClose: () => void }) {
  const qc = useQueryClient();
  const canApprove = usePermission('zones.approval.approve');
  const canReject = usePermission('zones.approval.reject');

  const [notes, setNotes] = useState('');
  const [confirmKind, setConfirmKind] = useState<'approve' | 'reject' | null>(null);

  // Reset local form state when the drawer swaps requests.
  useEffect(() => {
    setNotes('');
    setConfirmKind(null);
  }, [request?.id]);

  const approve = useMutation({
    mutationFn: () => approveZoneRequest(request!.id),
    onSuccess: () => done('Approved.'),
    onError: (e: unknown) => handleConflict(e, 'approve'),
  });
  const reject = useMutation({
    mutationFn: () => rejectZoneRequest(request!.id, notes.trim()),
    onSuccess: () => done('Rejected.'),
    onError: (e: unknown) => handleConflict(e, 'reject'),
  });

  function done(msg: string) {
    showToast({ kind: 'success', message: msg });
    // Optimistic removal so the row disappears immediately even before refetch.
    qc.setQueryData<ZoneApprovalRequest[]>(zoneApprovalKeys.pending, (prev) =>
      (prev ?? []).filter((r) => r.id !== request!.id),
    );
    void qc.invalidateQueries({ queryKey: zoneApprovalKeys.pending });
    setConfirmKind(null);
    onClose();
  }

  function handleConflict(e: unknown, _action: 'approve' | 'reject') {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 409 || status === 400) {
      showToast({ kind: 'warning', message: 'Already reviewed by another admin. Refreshing.' });
      void qc.invalidateQueries({ queryKey: zoneApprovalKeys.pending });
      setConfirmKind(null);
      onClose();
    }
    // Other errors: axios interceptor toast already fired.
  }

  return (
    <Drawer open={request != null} onClose={onClose} width="max-w-3xl">
      {request && (
        <>
          <DrawerHeader request={request} />
          <div className="p-8 space-y-6">
            <PhotoSection url={request.photo_url} />
            <LocationSection request={request} />
            <ContextSection request={request} />
          </div>
          <div className="px-8 py-5 border-t border-border bg-surface-elevated/30 space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
                Notes
                <span className="ml-2 normal-case tracking-normal text-text-muted/70">
                  optional for approve, required for reject (min 5 chars)
                </span>
              </label>
              <textarea
                className="input min-h-[70px] resize-y"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost text-danger"
                disabled={!canReject || notes.trim().length < 5}
                title={
                  !canReject
                    ? 'Insufficient permissions'
                    : notes.trim().length < 5
                      ? 'Notes required (min 5 chars) for rejection'
                      : undefined
                }
                onClick={() => setConfirmKind('reject')}
              >
                <X className="w-4 h-4" />
                Reject
              </button>
              <button
                className="btn-primary"
                disabled={!canApprove}
                title={!canApprove ? 'Insufficient permissions' : undefined}
                onClick={() => setConfirmKind('approve')}
              >
                <Check className="w-4 h-4" />
                Approve
              </button>
            </div>
          </div>

          <ConfirmModal
            open={confirmKind === 'approve'}
            onClose={() => setConfirmKind(null)}
            onConfirm={() => approve.mutateAsync()}
            title={`Approve ${request.pro_name ?? request.pro_phone ?? 'pro'}'s zone exception?`}
            impact={
              <div className="space-y-2">
                <p>They'll receive a push notification and can immediately try Go Online again.</p>
                {notes.trim() && (
                  <p>
                    <span className="text-text-muted">Note:</span>{' '}
                    <span className="text-text-primary">{notes.trim()}</span>
                  </p>
                )}
              </div>
            }
            confirmLabel="Approve"
          />
          <ConfirmModal
            open={confirmKind === 'reject'}
            onClose={() => setConfirmKind(null)}
            onConfirm={() => reject.mutateAsync()}
            title={`Reject ${request.pro_name ?? request.pro_phone ?? 'pro'}'s zone exception?`}
            impact={
              <div className="space-y-2">
                <p>They'll be notified they cannot go online from this location.</p>
                <p>
                  <span className="text-text-muted">Reason:</span>{' '}
                  <span className="text-text-primary">{notes.trim()}</span>
                </p>
              </div>
            }
            confirmLabel="Reject"
            destructive
          />
        </>
      )}
    </Drawer>
  );
}

function DrawerHeader({ request }: { request: ZoneApprovalRequest }) {
  return (
    <div className="px-8 pt-8 pb-4 border-b border-border">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-full bg-accent/30 flex items-center justify-center font-semibold text-lg">
          {(request.pro_name ?? request.pro_phone ?? '?')[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold truncate">
            {request.pro_name ?? 'Unknown pro'}
          </h2>
          <div className="text-sm text-text-secondary flex items-center gap-1.5">
            {request.pro_phone ? (
              <a href={`tel:${request.pro_phone}`} className="hover:text-text-primary flex items-center gap-1">
                <Phone className="w-3 h-3" />
                {request.pro_phone}
              </a>
            ) : '—'}
          </div>
          <div className="text-[11px] text-text-muted font-mono mt-1">{request.pro_id}</div>
        </div>
        <StatusPill tone="warning">Pending review</StatusPill>
      </div>
    </div>
  );
}

function PhotoSection({ url }: { url?: string | null }) {
  if (!url) {
    return (
      <div className="card-elevated p-6 text-sm text-text-secondary">No photo provided.</div>
    );
  }
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Proof photo</h3>
      <a href={url} target="_blank" rel="noopener noreferrer" className="block">
        <img
          src={url}
          alt="zone approval proof"
          className="w-full max-h-[420px] object-contain rounded-xl border border-border bg-black/30"
        />
      </a>
      <p className="text-[11px] text-text-muted mt-2">Click to open full-size.</p>
    </div>
  );
}

function LocationSection({ request }: { request: ZoneApprovalRequest }) {
  const proPos = { lat: request.current_lat, lng: request.current_lng };
  const zoneLat = request.assigned_zone_lat ?? null;
  const zoneLng = request.assigned_zone_lng ?? null;
  const radiusKm = request.assigned_zone_radius_km ?? null;
  const haveZone = zoneLat != null && zoneLng != null && radiusKm != null;
  const center = haveZone
    ? { lat: (request.current_lat + zoneLat!) / 2, lng: (request.current_lng + zoneLng!) / 2 }
    : proPos;

  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Location</h3>
      <div className="card-elevated p-3 mb-3 text-sm">
        Pro is{' '}
        <span className="text-text-primary font-medium">{formatDistance(request.distance_meters)}</span>
        {haveZone ? (
          <> from assigned zone (<span className="text-text-primary">{request.assigned_zone_name}</span>)</>
        ) : (
          <> from their assigned zone (no current assignment found)</>
        )}
      </div>
      <div className="w-full h-[300px] rounded-xl overflow-hidden border border-border">
        <GoogleMapWrapper
          center={center}
          zoom={12}
          style={{ width: '100%', height: '100%' }}
        >
          <ProMarker pos={proPos} label={request.pro_name ?? request.pro_phone ?? 'Pro'} />
          {haveZone && (
            <>
              <ZoneCenterMarker
                pos={{ lat: zoneLat!, lng: zoneLng! }}
                label={request.assigned_zone_name ?? 'Zone'}
              />
              <CircleF
                center={{ lat: zoneLat!, lng: zoneLng! }}
                radius={radiusKm! * 1000}
                options={{
                  fillColor: '#6C63FF',
                  fillOpacity: 0.12,
                  strokeColor: '#6C63FF',
                  strokeOpacity: 0.7,
                  strokeWeight: 1.5,
                }}
              />
            </>
          )}
        </GoogleMapWrapper>
      </div>
      <code className="block mt-2 text-[11px] font-mono text-text-muted">
        Pro: {request.current_lat.toFixed(5)}, {request.current_lng.toFixed(5)}
        {haveZone && (
          <>
            {' '}· Zone: {zoneLat!.toFixed(5)}, {zoneLng!.toFixed(5)} · r={radiusKm}km
          </>
        )}
      </code>
    </div>
  );
}

function ProMarker({ pos, label }: { pos: google.maps.LatLngLiteral; label: string }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="11" fill="#FF4D6A" fill-opacity="0.2"/>
    <circle cx="14" cy="14" r="7" fill="#FF4D6A" stroke="#0A0A0F" stroke-width="2"/>
  </svg>`;
  return (
    <MarkerF
      position={pos}
      title={label}
      icon={{
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
        scaledSize: new google.maps.Size(28, 28),
        anchor: new google.maps.Point(14, 14),
      }}
    />
  );
}

function ZoneCenterMarker({ pos, label }: { pos: google.maps.LatLngLiteral; label: string }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="6" fill="#6C63FF" stroke="#0A0A0F" stroke-width="2"/>
  </svg>`;
  return (
    <MarkerF
      position={pos}
      title={label}
      icon={{
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
        scaledSize: new google.maps.Size(22, 22),
        anchor: new google.maps.Point(11, 11),
      }}
    />
  );
}

function ContextSection({ request }: { request: ZoneApprovalRequest }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Context</h3>
      <div className="card-elevated p-4 space-y-2.5 text-sm">
        <KV
          k="Requested at"
          v={`${formatDate(new Date(request.requested_at), 'MMM d, yyyy HH:mm')} · ${formatDistanceToNow(new Date(request.requested_at), { addSuffix: true })}`}
        />
        <KV k="Shift commitment" v={request.shift_commitment_id.slice(0, 8)} mono />
        <KV k="Assigned zone" v={request.assigned_zone_name ?? '—'} />
      </div>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-text-muted min-w-[160px]">{k}</span>
      <span className={`text-text-primary break-words ${mono ? 'font-mono text-[12px]' : ''}`}>{v}</span>
    </div>
  );
}
