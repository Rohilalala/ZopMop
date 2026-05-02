import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, LogOut, Monitor, User } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { logout } from '@/api/auth';

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
  // Wired up by the Dashboard module's alerts feed; this stub is the topbar
  // affordance only — actual list lives on the dashboard.
  return (
    <button className="relative w-9 h-9 rounded-xl border border-border hover:bg-surface-elevated transition flex items-center justify-center">
      <Bell className="w-4 h-4 text-text-secondary" />
    </button>
  );
}

function AdminMenu() {
  const admin = useAuth((s) => s.admin);
  const clear = useAuth((s) => s.clear);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  async function doLogout() {
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
