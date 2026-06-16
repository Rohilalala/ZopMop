import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronDown, LogOut, Monitor, User } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { logout } from '@/api/auth';
import { markLoggedOut } from '@/api/client';
import {
  listNotifications,
  markAllRead,
  markRead,
  resolveNotificationLink,
  unreadCount,
  type CrmNotification,
  type NotificationSeverity,
} from '@/api/notifications';

// Topbar: breadcrumb left, alerts bell + admin avatar right.
// Crumb labels are derived from the URL path; for fully-custom labels per
// page we'd add a useBreadcrumb context, but the current map covers the
// known routes.

const CRUMB_LABELS: Record<string, string> = {
  '': 'Dashboard',
  orders: 'Orders',
  refunds: 'Refunds',
  users: 'Users',
  workers: 'Workers',
  leaves: 'Leaves',
  map: 'Live Map',
  promos: 'Promos',
  banners: 'Banners',
  experiments: 'A/B Tests',
  push: 'Push',
  analytics: 'Analytics',
  payouts: 'Payouts',
  flags: 'Feature Flags',
  disputes: 'Disputes',
  settings: 'Settings',
  sessions: 'Active Sessions',
};

export function Topbar() {
  const loc = useLocation();
  const segs = loc.pathname.split('/').filter(Boolean);
  const crumbs = segs.length === 0 ? [{ label: 'Dashboard', to: '/' }] : segs.map((s, i) => ({
    label: CRUMB_LABELS[s] ?? s,
    to: '/' + segs.slice(0, i + 1).join('/'),
  }));

  return (
    <header className="h-16 px-6 border-b border-border flex items-center justify-between bg-surface/60 backdrop-blur">
      <nav className="flex items-center gap-2 text-sm">
        {crumbs.map((c, i) => (
          <span key={c.to} className="flex items-center gap-2">
            {i > 0 && <span className="text-text-muted">/</span>}
            <span className={i === crumbs.length - 1 ? 'text-text-primary' : 'text-text-secondary'}>
              {c.label}
            </span>
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-3">
        <AlertsBell />
        <AdminMenu />
      </div>
    </header>
  );
}

function AlertsBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  // Unread badge polled every 30s. Keeps the bell up-to-date without
  // pulling the whole feed when the dropdown is closed.
  const unreadQ = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: unreadCount,
    refetchInterval: 30_000,
  });

  // Feed only loads on open — avoids hammering the API for a list nobody is reading.
  const listQ = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => listNotifications({ limit: 50 }),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  });

  // Click-outside to dismiss.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function onClickItem(n: CrmNotification) {
    if (!n.read_at) {
      try { await markRead(n.id); } catch { /* swallow — UI optimism */ }
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
    const link = resolveNotificationLink(n);
    if (link) {
      setOpen(false);
      nav(link);
    }
  }

  async function onMarkAll() {
    try { await markAllRead(); } finally {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  }

  const unread = unreadQ.data ?? 0;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-xl border border-border hover:bg-surface-elevated transition flex items-center justify-center"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4 text-text-secondary" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 w-[380px] max-h-[520px] flex flex-col card-elevated p-0 z-30 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div>
              <div className="text-sm font-semibold">Notifications</div>
              <div className="text-[11px] text-text-muted">
                {unread > 0 ? `${unread} unread` : 'All caught up'}
              </div>
            </div>
            <button
              onClick={() => void onMarkAll()}
              disabled={unread === 0}
              className="text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-default"
            >
              Mark all read
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {listQ.isLoading ? (
              <div className="p-6 text-sm text-text-muted text-center">Loading…</div>
            ) : (listQ.data?.length ?? 0) === 0 ? (
              <div className="p-8 text-sm text-text-muted text-center">No notifications</div>
            ) : (
              <ul className="divide-y divide-border">
                {listQ.data!.map((n) => (
                  <NotificationRow key={n.id} n={n} onClick={() => void onClickItem(n)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SEVERITY_STYLES: Record<NotificationSeverity, { label: string; pill: string; rowBg: string }> = {
  info:    { label: 'Info',    pill: 'border-primary/30 text-primary/90 bg-primary/10', rowBg: '' },
  warning: { label: 'Warning', pill: 'border-warning/30 text-warning/90 bg-warning/10', rowBg: '' },
  // urgent rows render with a red wash + red border so they don't blend in;
  // they also stay sticky regardless of read state until clicked.
  urgent:  { label: 'Urgent',  pill: 'border-danger/40 text-danger bg-danger/15',       rowBg: 'bg-danger/10 border-l-2 border-danger' },
};

function NotificationRow({ n, onClick }: { n: CrmNotification; onClick: () => void }) {
  const sev = SEVERITY_STYLES[n.severity] ?? SEVERITY_STYLES.info;
  const unread = !n.read_at;
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-3 transition hover:bg-surface ${sev.rowBg} ${unread ? 'bg-surface-elevated/50' : ''}`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className={`pill text-[10px] ${sev.pill}`}>{sev.label}</span>
          {unread && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
          <span className="ml-auto text-[10px] text-text-muted">{formatRelativeTime(n.created_at)}</span>
        </div>
        <div className="text-sm font-medium text-text-primary">{n.title}</div>
        {n.body && <div className="text-xs text-text-secondary mt-0.5 line-clamp-2">{n.body}</div>}
      </button>
    </li>
  );
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function AdminMenu() {
  const admin = useAuth((s) => s.admin);
  const clear = useAuth((s) => s.clear);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  async function doLogout() {
    // Bump the logout epoch first so any in-flight silent refresh discards its
    // result instead of bouncing the user back into an authenticated session.
    markLoggedOut();
    try { await logout(); }
    finally {
      clear();
      nav('/login', { replace: true });
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 h-9 rounded-xl border border-border hover:bg-surface-elevated transition"
      >
        <div className="w-6 h-6 rounded-full bg-primary/30 flex items-center justify-center text-[11px] font-semibold">
          {admin?.display_name?.[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="text-sm text-text-primary">{admin?.display_name ?? '—'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 w-56 card-elevated p-1.5 z-30">
          <MenuItem icon={User} label="Profile" onClick={() => { setOpen(false); nav('/settings'); }} />
          <MenuItem icon={Monitor} label="Active Sessions" onClick={() => { setOpen(false); nav('/sessions'); }} />
          <div className="h-px bg-border my-1" />
          <MenuItem icon={LogOut} label="Sign Out" onClick={() => { setOpen(false); void doLogout(); }} danger />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon, label, onClick, danger = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition ${
        danger ? 'text-danger hover:bg-danger/10' : 'text-text-primary hover:bg-surface'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}
