import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkerF } from '@react-google-maps/api';
import {
  Check, FileText, ListOrdered, MapPin, Pause, Play, PowerOff, Star, Tag, X,
} from 'lucide-react';

import {
  approveWorker, forceOffline, getWorker, getWorkerJobs, rejectWorker,
  setWorkerCategories, setWorkerLocality, suspendWorker, unsuspendWorker, workerActiveJob,
  type WorkerDetail,
} from '@/api/workers';
import { listLocalities } from '@/api/localities';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { GoogleMapWrapper } from '@/components/maps/GoogleMapWrapper';
import { usePermission } from '@/auth/usePermission';

// WorkerDrawer: tabbed detail panel.

type Tab = 'overview' | 'jobs' | 'categories';

export function WorkerDrawer({ workerId, onClose }: { workerId: string | null; onClose: () => void }) {
  const open = workerId != null;
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const q = useQuery({
    queryKey: ['worker', workerId],
    queryFn: () => getWorker(workerId!),
    enabled: open,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['worker', workerId] });
    qc.invalidateQueries({ queryKey: ['workers'] });
    qc.invalidateQueries({ queryKey: ['live-pins'] });
  };

  return (
    <Drawer open={open} onClose={onClose} width="max-w-2xl">
      {q.isLoading || !q.data ? (
        <div className="p-8 space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <>
          <Header worker={q.data} onActed={invalidate} />
          <Tabs current={tab} onChange={setTab} />
          {tab === 'overview'   && <OverviewTab worker={q.data} />}
          {tab === 'jobs'       && <JobsTab workerId={q.data.id} />}
          {tab === 'categories' && <CategoriesTab worker={q.data} onSaved={invalidate} />}
        </>
      )}
    </Drawer>
  );
}

function Header({ worker, onActed }: { worker: WorkerDetail; onActed: () => void }) {
  return (
    <div className="px-8 pt-8 pb-4 border-b border-border">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <div className="w-14 h-14 rounded-full bg-accent/30 flex items-center justify-center font-semibold text-lg">
            {(worker.name ?? worker.phone)[0]?.toUpperCase()}
          </div>
          <span
            title={worker.is_online ? 'Online' : 'Offline'}
            className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-surface ${
              worker.is_online ? 'bg-success' : 'bg-text-muted'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold truncate">{worker.name ?? worker.phone}</h2>
            {worker.is_vip && <Star className="w-4 h-4 text-warning fill-warning" />}
          </div>
          <div className="text-sm text-text-secondary">{worker.phone}</div>
          <div className="text-[11px] text-text-muted font-mono mt-1">{worker.id}</div>
        </div>
        <StatusPill tone={
          worker.status === 'active' ? 'success'
          : worker.status === 'pending' ? 'warning'
          : worker.status === 'rejected' ? 'danger'
          : worker.status === 'suspended' ? 'warning'
          : 'danger'
        }>{worker.status}</StatusPill>
      </div>

      {worker.suspend_reason && (
        <div className="mt-3 px-3 py-2 rounded-xl bg-warning/10 border border-warning/30 text-sm text-warning/90">
          <span className="font-semibold">Suspended:</span> {worker.suspend_reason}
        </div>
      )}
      {worker.ban_reason && (
        <div className="mt-3 px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-sm text-danger/90">
          <span className="font-semibold">Banned:</span> {worker.ban_reason}
        </div>
      )}

      <Actions worker={worker} onActed={onActed} />
    </div>
  );
}

function Actions({ worker, onActed }: { worker: WorkerDetail; onActed: () => void }) {
  const [pending, setPending] = useState<null
    | { kind: 'approve' }
    | { kind: 'reject' }
    | { kind: 'suspend' }
    | { kind: 'unsuspend' }
    | { kind: 'force-offline' }
  >(null);
  const [reason, setReason] = useState('');

  const activeJobQ = useQuery({
    queryKey: ['worker-active-job', worker.id],
    queryFn: () => workerActiveJob(worker.id),
    enabled: pending?.kind === 'force-offline' || pending?.kind === 'suspend',
  });

  const approve = useMutation({ mutationFn: () => approveWorker(worker.id), onSuccess: () => done('Worker approved.') });
  const reject  = useMutation({ mutationFn: () => rejectWorker(worker.id, reason),  onSuccess: () => done('Application rejected.') });
  const suspend = useMutation({ mutationFn: () => suspendWorker(worker.id, reason), onSuccess: () => done('Worker suspended.') });
  const unsus   = useMutation({ mutationFn: () => unsuspendWorker(worker.id),       onSuccess: () => done('Worker reinstated.') });
  const offline = useMutation({ mutationFn: () => forceOffline(worker.id),          onSuccess: () => done('Worker forced offline.') });

  function done(msg: string) {
    showToast({ kind: 'success', message: msg });
    onActed();
    setPending(null);
    setReason('');
  }

  const canApprove   = usePermission('workers.approve');
  const canReject    = usePermission('workers.reject');
  const canSuspend   = usePermission('workers.suspend');
  const canUnsuspend = usePermission('workers.unsuspend');
  const canOffline   = usePermission('workers.force_offline');

  const denyClick = (can: boolean, action: () => void) => () => {
    if (!can) {
      showToast({ kind: 'error', message: 'Insufficient permissions' });
      return;
    }
    action();
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        {worker.status === 'pending' && (
          <>
            <button
              className="btn-ghost text-success"
              disabled={!canApprove}
              title={!canApprove ? 'Insufficient permissions' : undefined}
              onClick={denyClick(canApprove, () => setPending({ kind: 'approve' }))}
            >
              <Check className="w-4 h-4" />Approve
            </button>
            <button
              className="btn-ghost text-danger"
              disabled={!canReject}
              title={!canReject ? 'Insufficient permissions' : undefined}
              onClick={denyClick(canReject, () => setPending({ kind: 'reject' }))}
            >
              <X className="w-4 h-4" />Reject
            </button>
          </>
        )}
        {worker.status === 'active' && (
          <>
            <button
              className="btn-ghost text-warning"
              disabled={!canSuspend}
              title={!canSuspend ? 'Insufficient permissions' : undefined}
              onClick={denyClick(canSuspend, () => setPending({ kind: 'suspend' }))}
            >
              <Pause className="w-4 h-4" />Suspend
            </button>
            {worker.is_available && (
              <button
                className="btn-ghost"
                disabled={!canOffline}
                title={!canOffline ? 'Insufficient permissions' : undefined}
                onClick={denyClick(canOffline, () => setPending({ kind: 'force-offline' }))}
              >
                <PowerOff className="w-4 h-4" />Force offline
              </button>
            )}
          </>
        )}
        {worker.status === 'suspended' && (
          <button
            className="btn-ghost text-success"
            disabled={!canUnsuspend}
            title={!canUnsuspend ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canUnsuspend, () => setPending({ kind: 'unsuspend' }))}
          >
            <Play className="w-4 h-4" />Unsuspend
          </button>
        )}
        {worker.status === 'rejected' && (
          <button
            className="btn-ghost text-success"
            disabled={!canApprove}
            title={!canApprove ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canApprove, () => setPending({ kind: 'approve' }))}
          >
            <Check className="w-4 h-4" />Approve anyway
          </button>
        )}
      </div>

      <ConfirmModal
        open={pending?.kind === 'approve'}
        onClose={() => setPending(null)}
        onConfirm={() => approve.mutateAsync()}
        title="Approve this worker?"
        impact="They will be able to accept bookings immediately."
        confirmLabel="Approve"
      />

      <ConfirmModal
        open={pending?.kind === 'reject'}
        onClose={() => { setPending(null); setReason(''); }}
        onConfirm={() => reject.mutateAsync()}
        title="Reject this application?"
        impact={
          <div className="space-y-3">
            <p>The worker will be marked rejected. Approving later is still possible.</p>
            <input
              className="input"
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        }
        confirmLabel="Reject"
        destructive
      />

      <ConfirmModal
        open={pending?.kind === 'suspend'}
        onClose={() => { setPending(null); setReason(''); }}
        onConfirm={() => suspend.mutateAsync()}
        title="Suspend worker?"
        impact={
          <div className="space-y-3">
            <p>They cannot log in or accept bookings until reinstated.</p>
            {activeJobQ.data?.has_active && (
              <p className="text-warning">
                ⚠ Worker has an active booking ({activeJobQ.data.booking_id}). Suspension will not cancel it.
              </p>
            )}
            <input
              className="input"
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        }
        confirmLabel="Suspend"
      />

      <ConfirmModal
        open={pending?.kind === 'unsuspend'}
        onClose={() => setPending(null)}
        onConfirm={() => unsus.mutateAsync()}
        title="Reinstate worker?"
        impact="They will be able to log in again immediately."
        confirmLabel="Unsuspend"
      />

      <ConfirmModal
        open={pending?.kind === 'force-offline'}
        onClose={() => setPending(null)}
        onConfirm={() => offline.mutateAsync()}
        title="Force worker offline?"
        impact={
          activeJobQ.data?.has_active
            ? `⚠ Worker has an active booking (${activeJobQ.data.booking_id}). Going offline does NOT cancel it — they'll need to complete or hand it off manually.`
            : "Worker will stop receiving new booking offers until they go online again."
        }
        confirmLabel="Force offline"
      />
    </>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'overview',   label: 'Overview',   icon: FileText },
    { id: 'jobs',       label: 'Jobs',       icon: ListOrdered },
    { id: 'categories', label: 'Categories', icon: Tag },
  ];
  return (
    <div className="px-8 border-b border-border flex gap-1">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          className={`px-3 py-3 text-sm flex items-center gap-2 border-b-2 transition ${
            current === it.id
              ? 'border-primary text-text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          <it.icon className="w-4 h-4" />
          {it.label}
        </button>
      ))}
    </div>
  );
}

function LocalityRow({ worker }: { worker: WorkerDetail }) {
  const qc = useQueryClient();
  const localitiesQ = useQuery({
    queryKey: ['localities-active'],
    queryFn: () => listLocalities({ activeOnly: true }),
  });
  const setMut = useMutation({
    mutationFn: (next: string) => setWorkerLocality(worker.id, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['worker', worker.id] });
      showToast({ kind: 'success', message: 'Locality updated' });
    },
    onError: (e: any) =>
      showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not update' }),
  });

  const current = worker.locality ?? '';
  return (
    <div className="col-span-2">
      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Locality</h3>
      <select
        className="input w-full max-w-xs"
        value={current}
        disabled={setMut.isPending || localitiesQ.isLoading}
        onChange={(e) => setMut.mutate(e.target.value)}
      >
        <option value="">— No locality —</option>
        {(localitiesQ.data ?? []).map((l) => (
          <option key={l.id} value={l.name}>
            {l.name} · {l.city}
          </option>
        ))}
      </select>
      <p className="text-xs text-text-muted mt-2">
        Drives scheduled-invite matching. Pro can also set this themselves
        from the app.
      </p>
    </div>
  );
}

function OverviewTab({ worker }: { worker: WorkerDetail }) {
  const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return (
    <div className="p-8 grid grid-cols-2 gap-4">
      <Stat label="Rating"             value={`${worker.rating.toFixed(2)} ★`} />
      <Stat label="Total jobs"         value={String(worker.total_jobs)} />
      <Stat label="Completed (30d)"    value={String(worker.completed_jobs_30d)} />
      <Stat label="Earnings (30d)"     value={fmt(worker.earnings_30d_cents)} />
      <Stat label="Cancellation rate"  value={(worker.cancellation_rate * 100).toFixed(1) + '%'} />
      <Stat label="Joined"             value={new Date(worker.joined_at).toLocaleDateString()} />

      <div className="col-span-2">
        <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Address</h3>
        <div className="text-sm text-text-primary">{worker.address || '—'}</div>
      </div>

      <LocalityRow worker={worker} />

      <div className="col-span-2">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wider text-text-muted">Live location</h3>
          <StatusPill tone={worker.is_online ? 'success' : 'neutral'}>
            {worker.is_online ? 'Online' : 'Offline'}
          </StatusPill>
        </div>
        {worker.current_lat != null && worker.current_lng != null ? (
          <>
            <WorkerLocationMap
              workerId={worker.id}
              lat={worker.current_lat}
              lng={worker.current_lng}
              name={worker.name ?? worker.phone}
              online={worker.is_online}
            />
            <code className="block mt-2 text-[11px] font-mono text-text-muted">
              {worker.current_lat.toFixed(5)}, {worker.current_lng.toFixed(5)}
              {!worker.is_online && (
                <span className="ml-2 text-text-secondary">· last known position</span>
              )}
            </code>
          </>
        ) : (
          <div className="card-elevated p-6 flex items-center gap-3 text-text-secondary text-sm">
            <MapPin className="w-5 h-5 text-text-muted" />
            No location reported yet.
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerLocationMap({
  lat,
  lng,
  name,
  online,
}: {
  workerId: string;
  lat: number;
  lng: number;
  name: string;
  online: boolean;
}) {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const center = { lat, lng };
  const color = online ? '#00D4AA' : '#4A4A6A';

  // Re-pan + trigger resize when the drawer animates in: GoogleMap measures its
  // container on mount, but the Drawer's translate animation means dimensions
  // can settle after mount, leaving the marker correctly positioned but the
  // viewport off. Firing a resize on the next frame nudges Maps to recalc.
  useEffect(() => {
    if (!map) return;
    const t = window.setTimeout(() => {
      google.maps.event.trigger(map, 'resize');
      map.panTo(center);
      map.setZoom(14);
    }, 250);
    return () => window.clearTimeout(t);
  }, [map, lat, lng]);

  const r = 7;
  const halo = r + 4;
  const size = halo * 2 + 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${halo}" fill="${color}" fill-opacity="0.2"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="#0A0A0F" stroke-width="2"/>
  </svg>`;
  const iconUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

  return (
    <div className="w-full h-[240px] rounded-xl overflow-hidden border border-border">
      <GoogleMapWrapper
        center={center}
        zoom={14}
        disableDefaultUI
        style={{ width: '100%', height: '100%' }}
        onLoad={setMap}
      >
        {map && (
          <MarkerF
            position={center}
            title={name}
            icon={{
              url: iconUrl,
              scaledSize: new google.maps.Size(size, size),
              anchor: new google.maps.Point(size / 2, size / 2),
            }}
          />
        )}
      </GoogleMapWrapper>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-elevated p-4">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function JobsTab({ workerId }: { workerId: string }) {
  const q = useQuery({ queryKey: ['worker-jobs', workerId], queryFn: () => getWorkerJobs(workerId) });
  const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-32" /></div>;
  if ((q.data?.length ?? 0) === 0) return <div className="p-8"><EmptyState title="No jobs yet" /></div>;
  return (
    <div className="px-8 py-4">
      <table className="w-full text-sm">
        <thead className="text-xs text-text-muted">
          <tr>
            <th className="text-left py-2">Job</th>
            <th className="text-left py-2">Category</th>
            <th className="text-left py-2">Status</th>
            <th className="text-right py-2">Amount</th>
            <th className="text-right py-2">Date</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((j) => (
            <tr key={j.id} className="border-t border-border">
              <td className="py-2 font-mono text-[11px]">{j.id.slice(0, 8)}</td>
              <td className="py-2">{j.category}</td>
              <td className="py-2"><StatusPill tone={
                j.status === 'completed' ? 'success'
                : j.status === 'cancelled' ? 'danger'
                : 'info'
              }>{j.status}</StatusPill></td>
              <td className="py-2 text-right tabular-nums">{fmt(j.price_cents)}</td>
              <td className="py-2 text-right text-text-secondary">{new Date(j.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoriesTab({ worker, onSaved }: { worker: WorkerDetail; onSaved: () => void }) {
  const [draft, setDraft] = useState(worker.categories.join(', '));
  const [confirm, setConfirm] = useState(false);
  const m = useMutation({
    mutationFn: () => setWorkerCategories(
      worker.id,
      draft.split(',').map((s) => s.trim()).filter(Boolean),
    ),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Categories updated.' });
      onSaved();
      setConfirm(false);
    },
  });
  const dirty = draft.trim() !== worker.categories.join(', ');
  const canSave = usePermission('workers.set_categories');
  return (
    <div className="p-8 space-y-4">
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Categories (comma-separated)</label>
        <textarea
          className="input min-h-[80px] resize-y font-mono text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={!dirty || !canSave}
          title={!canSave ? 'Insufficient permissions' : undefined}
          onClick={() => {
            if (!canSave) {
              showToast({ kind: 'error', message: 'Insufficient permissions' });
              return;
            }
            setConfirm(true);
          }}
        >Save</button>
      </div>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => m.mutateAsync()}
        title="Update worker's categories?"
        impact={
          <div className="space-y-2">
            <p><span className="text-text-muted">Before:</span> {worker.categories.join(', ') || '—'}</p>
            <p><span className="text-text-muted">After:</span> {draft || '—'}</p>
          </div>
        }
        confirmLabel="Save"
      />
    </div>
  );
}
