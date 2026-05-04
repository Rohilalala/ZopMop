import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { Send, X as XIcon, RotateCw } from 'lucide-react';

import { getPushReach, growthApi, type PushMsg, type PushTarget } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';
import { useAuth } from '@/store/auth';

// Tiny inline debounce — avoid pulling a dep just for this.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// Page-level ticking clock — drives every countdown badge in the list with one
// interval (vs N intervals if each row owned its own). Cleaned up on unmount.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function formatCountdown(target: Date, now: number): string {
  const diff = target.getTime() - now;
  if (diff <= 0) return 'Sending soon…';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `Sends in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Sends in ${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Sends in ${h}h ${m % 60}m`;
  return `Sends ${target.toLocaleString()}`;
}

type PushTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
function toneForStatus(status: string): PushTone {
  switch (status) {
    case 'sent':      return 'success';
    case 'scheduled': return 'info';
    case 'failed':    return 'danger';
    case 'cancelled': return 'warning';
    case 'draft':     return 'neutral';
    default:          return 'neutral';
  }
}

export function PushPage() {
  const qc = useQueryClient();
  const isAuthed = useAuth((s) => !!s.accessToken);
  const list = useQuery({
    queryKey: ['push'],
    queryFn: growthApi.listPush,
    refetchInterval: 15_000,
  });
  const canCreate = usePermission('push.create');
  const canSend   = usePermission('push.send');

  // One ticking clock for all rows (page-level interval — better than per-row).
  const now = useNow(30_000);

  const [title, setTitle] = useState('');
  const [body, setBody]   = useState('');
  const [imageURL, setImageURL] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [target, setTarget] = useState<'users' | 'pros' | 'both'>('users');
  const [scheduled, setScheduled] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [sendId, setSendId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PushMsg | null>(null);
  const [retryTarget, setRetryTarget]   = useState<PushMsg | null>(null);

  // Estimated reach — debounced refetch on target change. Not polled.
  const debouncedTarget = useDebouncedValue(target, 250);
  const reach = useQuery({
    queryKey: ['push-reach', debouncedTarget],
    queryFn: () => getPushReach({ kind: debouncedTarget } as PushTarget),
    enabled: isAuthed,
    retry: (count, err) => {
      if (isAxiosError(err) && err.response?.status === 403) return false;
      return count < 2;
    },
    staleTime: 30_000,
  });
  const reachIs403 = isAxiosError(reach.error) && reach.error.response?.status === 403;

  const create = useMutation({
    mutationFn: () => growthApi.createPush({
      title, body, image_url: imageURL || undefined, deep_link: deepLink || undefined,
      target_kind: target,
      scheduled_at: scheduled ? new Date(scheduled).toISOString() : null,
    }),
    onSuccess: () => {
      showToast({ kind: 'success', message: scheduled ? 'Push scheduled.' : 'Push drafted.' });
      qc.invalidateQueries({ queryKey: ['push'] });
      setTitle(''); setBody(''); setImageURL(''); setDeepLink(''); setScheduled('');
      setConfirm(false);
    },
  });
  const send = useMutation({
    mutationFn: (id: string) => growthApi.sendPush(id),
    onSuccess: () => { showToast({ kind: 'success', message: 'Push sent.' }); qc.invalidateQueries({ queryKey: ['push'] }); setSendId(null); },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => growthApi.cancelPush(id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Scheduled push cancelled.' });
      qc.invalidateQueries({ queryKey: ['push'] });
      setCancelTarget(null);
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) => growthApi.retryPush(id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Push retry queued.' });
      qc.invalidateQueries({ queryKey: ['push'] });
      setRetryTarget(null);
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Push Notifications</h1>
        <p className="text-sm text-text-secondary mt-1">Compose, target, schedule. Actual FCM dispatch is performed by the user-app's notification worker.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <h2 className="text-sm font-semibold mb-3">Compose</h2>
          <div className="space-y-3">
            <input className="input" placeholder="Title (≤60 chars)" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="input min-h-[80px]" placeholder="Body (≤180 chars)" maxLength={180} value={body} onChange={(e) => setBody(e.target.value)} />
            <input className="input" placeholder="Image URL (optional)" value={imageURL} onChange={(e) => setImageURL(e.target.value)} />
            <input className="input" placeholder="Deep link (optional)" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} />
            <div className="flex gap-1 bg-surface-elevated p-1 rounded-xl">
              {(['users', 'pros', 'both'] as const).map((k) => (
                <button key={k} onClick={() => setTarget(k)} className={`flex-1 py-2 text-sm rounded-lg transition capitalize ${target === k ? 'bg-primary text-white' : 'text-text-secondary'}`}>{k}</button>
              ))}
            </div>
            <div className="text-xs text-text-secondary">
              {reachIs403
                ? <>Estimated reach: <span className="text-text-muted">—</span></>
                : reach.isError
                  ? <span className="text-text-muted">Estimated reach: unavailable</span>
                  : reach.isLoading || reach.isFetching || reach.data === undefined
                    ? <>Estimated reach: <span className="text-text-muted">…</span></>
                    : <>Estimated reach: <span className="font-medium text-text-primary">{reach.data.toLocaleString()}</span> devices</>}
            </div>
            <input className="input" type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
            <button
              className="btn-primary w-full"
              disabled={!title || !body || !canCreate}
              title={!canCreate ? 'Insufficient permissions' : undefined}
              onClick={() => {
                if (!canCreate) {
                  showToast({ kind: 'error', message: 'Insufficient permissions' });
                  return;
                }
                setConfirm(true);
              }}
            >
              {scheduled ? 'Schedule' : 'Save draft'}
            </button>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3">Sent / scheduled</h2>
          {list.isLoading ? <Skeleton className="h-32" /> :
            (list.data?.length ?? 0) === 0 ? <EmptyState title="No pushes yet" /> :
              <div className="space-y-2 max-h-[420px] overflow-y-auto">
                {list.data?.map((m) => (
                  <PushRow
                    key={m.id}
                    m={m}
                    now={now}
                    canSend={canSend}
                    onSend={() => {
                      if (!canSend) {
                        showToast({ kind: 'error', message: 'Insufficient permissions' });
                        return;
                      }
                      setSendId(m.id);
                    }}
                    onCancel={() => setCancelTarget(m)}
                    onRetry={() => setRetryTarget(m)}
                  />
                ))}
              </div>
          }
        </Card>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => create.mutateAsync()}
        title={scheduled ? 'Schedule push?' : 'Save draft?'}
        impact={
          <div className="space-y-2">
            <p>Target: {target}</p>
            <p>"{title}"</p>
            <p className="text-xs text-text-muted">{body}</p>
            {scheduled && <p>Scheduled for {new Date(scheduled).toLocaleString()}</p>}
          </div>
        }
        confirmLabel={scheduled ? 'Schedule' : 'Save'}
      />
      <ConfirmModal
        open={!!sendId}
        onClose={() => setSendId(null)}
        onConfirm={() => send.mutateAsync(sendId!)}
        title="Send push now?"
        impact="The push is dispatched immediately. There is no recall."
        confirmLabel="Send"
      />
      <ConfirmModal
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancel.mutateAsync(cancelTarget!.id)}
        title="Cancel scheduled push?"
        impact={cancelTarget ? <p>Cancel scheduled push '<span className="font-medium">{cancelTarget.title}</span>'? It will not be sent.</p> : null}
        confirmLabel="Cancel push"
        destructive
      />
      <ConfirmModal
        open={!!retryTarget}
        onClose={() => setRetryTarget(null)}
        onConfirm={() => retry.mutateAsync(retryTarget!.id)}
        title="Retry sending push?"
        impact={retryTarget ? <p>Retry sending '<span className="font-medium">{retryTarget.title}</span>'? This will fire immediately.</p> : null}
        confirmLabel="Retry now"
      />
    </div>
  );
}

function PushRow({
  m, now, canSend, onSend, onCancel, onRetry,
}: {
  m: PushMsg;
  now: number;
  canSend: boolean;
  onSend: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const showCounts =
    m.status === 'sent' &&
    (m.sent_count !== undefined || m.delivered_count !== undefined || m.failed_count !== undefined);

  const scheduledDate = m.scheduled_at ? new Date(m.scheduled_at) : null;
  const showCountdown = m.status === 'scheduled' && scheduledDate !== null;
  const errorText = m.status === 'failed' && m.error_message ? m.error_message : null;
  const truncatedError = errorText && errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;

  return (
    <div className="card-elevated p-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{m.title}</div>
        {errorText && (
          <div className="text-[11px] text-danger mt-0.5 line-clamp-2" title={errorText}>
            {truncatedError}
          </div>
        )}
        <div className="text-xs text-text-secondary line-clamp-1">{m.body}</div>
        <div className="text-[11px] text-text-muted mt-1">~{m.estimated_reach} · {m.target_kind} · {new Date(m.created_at).toLocaleString()}</div>
        {showCounts && (
          <div className="text-[11px] text-text-muted mt-0.5">
            Sent: {m.sent_count ?? 0} · Delivered: {m.delivered_count ?? 0} · Failed: {m.failed_count ?? 0}
          </div>
        )}
        {showCountdown && scheduledDate && (
          <div className="mt-1.5">
            <span className="pill border-primary/30 text-primary/90 bg-primary/10">
              {formatCountdown(scheduledDate, now)}
            </span>
          </div>
        )}
      </div>
      <StatusPill tone={toneForStatus(m.status)}>{m.status}</StatusPill>
      {m.status !== 'sent' && m.status !== 'cancelled' && m.status !== 'failed' && (
        <button
          className="btn-ghost !py-1 !px-2 text-xs"
          onClick={onSend}
          disabled={!canSend}
          title={!canSend ? 'Insufficient permissions' : undefined}
        ><Send className="w-3.5 h-3.5" />Send now</button>
      )}
      {m.status === 'scheduled' && (
        <Can perm="push.create">
          <button
            className="btn-ghost !py-1 !px-2 text-xs"
            onClick={onCancel}
            title="Cancel scheduled push"
          ><XIcon className="w-3.5 h-3.5" />Cancel</button>
        </Can>
      )}
      {m.status === 'failed' && (
        <Can perm="push.send">
          <button
            className="btn-ghost !py-1 !px-2 text-xs"
            onClick={onRetry}
            title="Retry sending now"
          ><RotateCw className="w-3.5 h-3.5" />Retry Now</button>
        </Can>
      )}
    </div>
  );
}
