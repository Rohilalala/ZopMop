import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { listSessions, revokeSession, type Session } from '@/api/auth';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

// SessionsPage: shows all active refresh-token sessions for the current
// admin, lets them revoke any non-current one. Revoking the current one
// would log the admin out; we disable that to avoid the foot-gun (use
// "Sign out" instead).

export function SessionsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: listSessions });
  const [pending, setPending] = useState<Session | null>(null);

  const m = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showToast({ kind: 'success', message: 'Session revoked.' });
      setPending(null);
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Active Sessions</h1>
        <p className="text-sm text-text-secondary mt-1">
          Every device with an active refresh token. Revoke any session you don't recognise.
        </p>
      </div>
      <Card className="!p-0">
        {q.isLoading ? (
          <div className="p-5"><Skeleton className="h-24" /></div>
        ) : (q.data?.length ?? 0) === 0 ? (
          <EmptyState title="No sessions" />
        ) : (
          <div className="divide-y divide-border">
            {q.data?.map((s) => (
              <div key={s.id} className="px-5 py-4 flex items-center gap-3">
                <Monitor className="w-5 h-5 text-text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary truncate">
                    {s.user_agent ?? 'Unknown device'}
                  </div>
                  <div className="text-[11px] text-text-secondary">
                    {s.ip_address ?? '—'} · last used {new Date(s.last_used_at).toLocaleString()}
                  </div>
                </div>
                {s.is_current && <StatusPill tone="success">current</StatusPill>}
                <button
                  className="btn-ghost text-danger disabled:opacity-30"
                  disabled={s.is_current}
                  onClick={() => setPending(s)}
                  aria-label="revoke session"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <ConfirmModal
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => m.mutateAsync(pending!.id)}
        title="Revoke this session?"
        impact={`The session will be signed out immediately on the device "${pending?.user_agent ?? 'Unknown'}". They'll need to log in again.`}
        confirmLabel="Revoke"
        destructive
      />
    </div>
  );
}
