import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';

import { growthApi, type PushMsg } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

export function PushPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['push'], queryFn: growthApi.listPush });

  const [title, setTitle] = useState('');
  const [body, setBody]   = useState('');
  const [imageURL, setImageURL] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [target, setTarget] = useState<'users' | 'pros' | 'both'>('users');
  const [scheduled, setScheduled] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [sendId, setSendId] = useState<string | null>(null);

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
            <input className="input" type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
            <button className="btn-primary w-full" disabled={!title || !body} onClick={() => setConfirm(true)}>
              {scheduled ? 'Schedule' : 'Save draft'}
            </button>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3">Sent / scheduled</h2>
          {list.isLoading ? <Skeleton className="h-32" /> :
            (list.data?.length ?? 0) === 0 ? <EmptyState title="No pushes yet" /> :
              <div className="space-y-2 max-h-[420px] overflow-y-auto">
                {list.data?.map((m) => <PushRow key={m.id} m={m} onSend={() => setSendId(m.id)} />)}
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
    </div>
  );
}

function PushRow({ m, onSend }: { m: PushMsg; onSend: () => void }) {
  return (
    <div className="card-elevated p-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{m.title}</div>
        <div className="text-xs text-text-secondary line-clamp-1">{m.body}</div>
        <div className="text-[11px] text-text-muted mt-1">~{m.estimated_reach} · {m.target_kind} · {new Date(m.created_at).toLocaleString()}</div>
      </div>
      <StatusPill tone={
        m.status === 'sent' ? 'success' :
        m.status === 'scheduled' ? 'info' :
        m.status === 'failed' ? 'danger' : 'neutral'
      }>{m.status}</StatusPill>
      {m.status !== 'sent' && (
        <button className="btn-ghost !py-1 !px-2 text-xs" onClick={onSend}><Send className="w-3.5 h-3.5" />Send now</button>
      )}
    </div>
  );
}
