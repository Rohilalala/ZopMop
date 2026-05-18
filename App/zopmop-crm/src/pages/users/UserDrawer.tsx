import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Pause, Play, Star, StickyNote, ListOrdered, FileText } from 'lucide-react';

import {
  addUserNote,
  banUser,
  getUser,
  getUserNotes,
  getUserOrders,
  setUserVIP,
  suspendUser,
  unbanUser,
  unsuspendUser,
  userActiveOrders,
  type UserDetail,
} from '@/api/users';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { usePermission } from '@/auth/usePermission';

// UserDrawer: tabbed detail view. Overview | Orders | Notes.

type Tab = 'overview' | 'orders' | 'notes';

export function UserDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const open = userId != null;
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');

  const userQ = useQuery({
    queryKey: ['user', userId],
    queryFn: () => getUser(userId!),
    enabled: open,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['user', userId] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };

  const notFound = userQ.isError && (userQ.error as { response?: { status?: number } })?.response?.status === 404;

  return (
    <Drawer open={open} onClose={onClose} width="max-w-2xl">
      {userQ.isLoading ? (
        <div className="p-8 space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
        </div>
      ) : notFound || (userQ.isError && !userQ.data) ? (
        <div className="p-8">
          <EmptyState
            title="User not found"
            body="This user may have been deleted, or the link is stale."
          />
        </div>
      ) : userQ.data ? (
        <>
          <Header user={userQ.data} onActed={invalidate} />
          <Tabs current={tab} onChange={setTab} />
          {tab === 'overview' && <OverviewTab user={userQ.data} />}
          {tab === 'orders'   && <OrdersTab userId={userQ.data.id} />}
          {tab === 'notes'    && <NotesTab userId={userQ.data.id} />}
        </>
      ) : null}
    </Drawer>
  );
}

function Header({ user, onActed }: { user: UserDetail; onActed: () => void }) {
  return (
    <div className="px-8 pt-8 pb-4 border-b border-border">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 rounded-full bg-primary/30 flex items-center justify-center font-semibold text-lg shrink-0">
          {(user.name ?? user.phone)[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold truncate">{user.name ?? user.phone}</h2>
            {user.is_vip && <Star className="w-4 h-4 text-warning fill-warning" />}
          </div>
          <div className="text-sm text-text-secondary">{user.phone}</div>
          {user.email && <div className="text-sm text-text-secondary">{user.email}</div>}
          <div className="text-[11px] text-text-muted font-mono mt-1">{user.id}</div>
        </div>
        <StatusPill tone={
          user.status === 'active' ? 'success'
          : user.status === 'suspended' ? 'warning'
          : user.status === 'banned' ? 'danger'
          : 'neutral'
        }>{user.status}</StatusPill>
      </div>

      {(user.status === 'suspended' && user.suspend_reason) && (
        <div className="mt-3 px-3 py-2 rounded-xl bg-warning/10 border border-warning/30 text-sm text-warning/90">
          <span className="font-semibold">Suspended:</span> {user.suspend_reason}
        </div>
      )}
      {(user.status === 'banned' && user.ban_reason) && (
        <div className="mt-3 px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-sm text-danger/90">
          <span className="font-semibold">Banned:</span> {user.ban_reason}
        </div>
      )}

      <Actions user={user} onActed={onActed} />
    </div>
  );
}

function Actions({ user, onActed }: { user: UserDetail; onActed: () => void }) {
  const [pending, setPending] = useState<null
    | { kind: 'suspend' }
    | { kind: 'unsuspend' }
    | { kind: 'ban' }
    | { kind: 'unban' }
    | { kind: 'vip'; next: boolean }
  >(null);
  const [reason, setReason] = useState('');

  // Active orders count is fetched lazily so the warning shows only after the
  // admin actually opens the suspend/ban dialog.
  const activeQ = useQuery({
    queryKey: ['user-active-orders', user.id],
    queryFn: () => userActiveOrders(user.id),
    enabled: pending?.kind === 'suspend' || pending?.kind === 'ban',
  });

  const suspend = useMutation({
    mutationFn: () => suspendUser(user.id, reason),
    onSuccess: () => done('User suspended.'),
  });
  const unsuspend = useMutation({
    mutationFn: () => unsuspendUser(user.id),
    onSuccess: () => done('User reinstated.'),
  });
  const ban = useMutation({
    mutationFn: () => banUser(user.id, reason),
    onSuccess: () => done('User banned.'),
  });
  const unban = useMutation({
    mutationFn: () => unbanUser(user.id),
    onSuccess: () => done('Ban lifted.'),
  });
  const vip = useMutation({
    mutationFn: (next: boolean) => setUserVIP(user.id, next),
    onSuccess: () => done('VIP status updated.'),
  });

  function done(msg: string) {
    showToast({ kind: 'success', message: msg });
    onActed();
    setPending(null);
    setReason('');
  }

  const isBanned = user.status === 'banned';
  const isSuspended = user.status === 'suspended';

  const canSuspend   = usePermission('users.suspend');
  const canUnsuspend = usePermission('users.unsuspend');
  const canBan       = usePermission('users.ban');
  const canUnban     = usePermission('users.unban');
  const canVIP       = usePermission('users.set_vip');

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
        {!isBanned && !isSuspended && (
          <button
            className="btn-ghost text-warning"
            disabled={!canSuspend}
            title={!canSuspend ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canSuspend, () => setPending({ kind: 'suspend' }))}
          >
            <Pause className="w-4 h-4" />Suspend
          </button>
        )}
        {isSuspended && (
          <button
            className="btn-ghost text-success"
            disabled={!canUnsuspend}
            title={!canUnsuspend ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canUnsuspend, () => setPending({ kind: 'unsuspend' }))}
          >
            <Play className="w-4 h-4" />Unsuspend
          </button>
        )}
        {!isBanned && (
          <button
            className="btn-ghost text-danger"
            disabled={!canBan}
            title={!canBan ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canBan, () => setPending({ kind: 'ban' }))}
          >
            <Ban className="w-4 h-4" />Ban
          </button>
        )}
        {isBanned && (
          <button
            className="btn-ghost text-success"
            disabled={!canUnban}
            title={!canUnban ? 'Insufficient permissions' : undefined}
            onClick={denyClick(canUnban, () => setPending({ kind: 'unban' }))}
          >
            <Play className="w-4 h-4" />Lift ban
          </button>
        )}
        <button
          className={`btn-ghost ${user.is_vip ? 'text-warning' : ''}`}
          disabled={!canVIP}
          title={!canVIP ? 'Insufficient permissions' : undefined}
          onClick={denyClick(canVIP, () => setPending({ kind: 'vip', next: !user.is_vip }))}
        >
          <Star className="w-4 h-4" />
          {user.is_vip ? 'Remove VIP' : 'Add to VIP'}
        </button>
      </div>

      {/* Suspend */}
      <ConfirmModal
        open={pending?.kind === 'suspend'}
        onClose={() => { setPending(null); setReason(''); }}
        onConfirm={() => suspend.mutateAsync()}
        title="Suspend user?"
        impact={
          <div className="space-y-3">
            <p>The user will be unable to log in until they're reinstated.</p>
            {activeQ.data?.has_active && (
              <p className="text-warning">
                ⚠ User has {activeQ.data.count} active order(s). Suspension will not cancel them.
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

      {/* Unsuspend */}
      <ConfirmModal
        open={pending?.kind === 'unsuspend'}
        onClose={() => setPending(null)}
        onConfirm={() => unsuspend.mutateAsync()}
        title="Reinstate user?"
        impact="The user will be able to log in again immediately."
        confirmLabel="Unsuspend"
      />

      {/* Ban */}
      <ConfirmModal
        open={pending?.kind === 'ban'}
        onClose={() => { setPending(null); setReason(''); }}
        onConfirm={() => ban.mutateAsync()}
        title="Ban user?"
        impact={
          <div className="space-y-3">
            <p>This is the strongest sanction. The user is blocked indefinitely until manually unbanned.</p>
            {activeQ.data?.has_active && (
              <p className="text-warning">
                ⚠ User has {activeQ.data.count} active order(s). Banning will not cancel them.
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
        confirmLabel="Ban User"
        destructive
        requirePhrase="BAN USER"
      />

      {/* Unban */}
      <ConfirmModal
        open={pending?.kind === 'unban'}
        onClose={() => setPending(null)}
        onConfirm={() => unban.mutateAsync()}
        title="Lift ban?"
        impact="The user will be able to log in again. Their old data is unchanged."
        confirmLabel="Unban"
      />

      {/* VIP */}
      <ConfirmModal
        open={pending?.kind === 'vip'}
        onClose={() => setPending(null)}
        onConfirm={() => vip.mutateAsync((pending as { kind: 'vip'; next: boolean }).next)}
        title={(pending?.kind === 'vip' && pending.next) ? 'Add to VIP?' : 'Remove from VIP?'}
        impact={(pending?.kind === 'vip' && pending.next)
          ? 'User will receive priority handling on bookings and may see exclusive promos.'
          : 'User will lose VIP-only perks immediately.'}
        confirmLabel={(pending?.kind === 'vip' && pending.next) ? 'Make VIP' : 'Remove'}
      />
    </>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'overview', label: 'Overview', icon: FileText },
    { id: 'orders',   label: 'Orders',   icon: ListOrdered },
    { id: 'notes',    label: 'Notes',    icon: StickyNote },
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

function OverviewTab({ user }: { user: UserDetail }) {
  // Backend computes avg_order_paise server-side, but for a user with 0
  // orders the column comes back as 0 / null — show "—" so the card doesn't
  // read "₹0" or (worst) "₹NaN" when the field is undefined.
  const avg = user.total_orders > 0 ? formatRupees(user.avg_order_paise) : '—';
  return (
    <div className="p-8 grid grid-cols-2 gap-4">
      <Stat label="Lifetime value" value={formatRupees(user.ltv_paise)} />
      <Stat label="Total orders"   value={String(user.total_orders)} />
      <Stat label="Avg order"      value={avg} />
      <Stat label="Active orders"  value={String(user.active_orders)} />
      <Stat label="Joined"         value={new Date(user.joined_at).toLocaleDateString()} />
      <Stat label="Last active"    value={user.last_active_at ? new Date(user.last_active_at).toLocaleString() : '—'} />

      <div className="col-span-2">
        <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Preferred categories</h3>
        {user.preferred_categories.length === 0 ? (
          <div className="text-sm text-text-muted">No orders yet.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {user.preferred_categories.map((c) => (
              <span key={c.category} className="pill border-border bg-surface-elevated text-text-secondary">
                {c.category} <span className="text-text-muted">· {c.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>
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

function OrdersTab({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ['user-orders', userId], queryFn: () => getUserOrders(userId) });
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-32" /></div>;
  if ((q.data?.length ?? 0) === 0) {
    return <div className="p-8"><EmptyState title="No orders" body="This user hasn't placed any orders yet." /></div>;
  }
  return (
    <div className="px-8 py-4">
      <table className="w-full text-sm">
        <thead className="text-xs text-text-muted">
          <tr><th className="text-left py-2">Order</th><th className="text-left py-2">Category</th><th className="text-left py-2">Status</th><th className="text-right py-2">Amount</th><th className="text-right py-2">Date</th></tr>
        </thead>
        <tbody>
          {q.data?.map((o) => (
            <tr key={o.id} className="border-t border-border">
              <td className="py-2 font-mono text-[11px]">{o.id.slice(0, 8)}</td>
              <td className="py-2">{o.category}</td>
              <td className="py-2"><StatusPill tone={
                o.status === 'completed' ? 'success'
                : o.status === 'cancelled' ? 'danger'
                : 'info'
              }>{o.status}</StatusPill></td>
              <td className="py-2 text-right tabular-nums">{formatRupees(o.price_paise)}</td>
              <td className="py-2 text-right text-text-secondary">{new Date(o.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotesTab({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['user-notes', userId], queryFn: () => getUserNotes(userId) });
  const [draft, setDraft] = useState('');
  const canAddNote = usePermission('users.add_note');
  const m = useMutation({
    mutationFn: () => addUserNote(userId, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-notes', userId] });
      setDraft('');
      showToast({ kind: 'success', message: 'Note added.' });
    },
  });
  return (
    <div className="p-8 space-y-4">
      <div className="card-elevated p-3 space-y-2">
        <textarea
          className="input min-h-[80px] resize-y"
          placeholder="Add a note about this user…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            className="btn-primary !py-2"
            disabled={!draft.trim() || m.isPending || !canAddNote}
            title={!canAddNote ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canAddNote) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              m.mutateAsync();
            }}
          >
            {m.isPending ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </div>

      {q.isLoading ? <Skeleton className="h-24" /> :
        (q.data?.length ?? 0) === 0 ? <EmptyState title="No notes" body="Add the first note above." /> :
        <div className="space-y-3">
          {q.data?.map((n) => (
            <div key={n.id} className="card-elevated p-3">
              <div className="text-xs text-text-muted mb-1">
                {n.admin_email ?? 'unknown'} · {new Date(n.created_at).toLocaleString()}
              </div>
              <div className="text-sm whitespace-pre-wrap text-text-primary">{n.body}</div>
            </div>
          ))}
        </div>
      }
    </div>
  );
}
