import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, ClipboardList, User, UserCog, Tag,
  Banknote, Receipt, Settings as SettingsIcon, Flag,
  Map as MapIcon, FlaskConical, BarChart3, Image as ImageIcon,
  Bell, ShieldAlert, ChevronsLeft, ChevronsRight, CalendarDays, MapPinned,
  ShieldCheck, FileText, Clock, Sliders, ListChecks, Package,
  type LucideIcon,
} from 'lucide-react';
import { useProMode } from '@/store/proMode';
import { listPendingZoneApprovals, zoneApprovalKeys } from '@/api/zoneApprovals';
import { usePermission } from '@/auth/usePermission';

// Sidebar navigation. Sections come from the spec — Overview, Operations,
// Workers, Growth, Finance, Platform, Settings. Pro Mode toggle lives in the
// footer and unmasks the more advanced tools globally.

type Item = { to: string; label: string; icon: LucideIcon };

// Sidebar layout — locked in Phase H. Groupings reflect daily operator
// workflow: anything action-driven goes under Operations, anything growth-
// experiment-driven under Growth, etc. New top-level pages should be slotted
// into an existing group rather than spawning a new one.
const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: 'Operations',
    items: [
      { to: '/',                label: 'Dashboard',       icon: LayoutDashboard },
      { to: '/map',             label: 'Live Map',        icon: MapIcon },
      { to: '/zone-approvals',  label: 'Zone Approvals',  icon: ShieldCheck },
      { to: '/workers',         label: 'Workers',         icon: UserCog },
      { to: '/users',           label: 'Users',           icon: User },
      { to: '/orders',          label: 'Orders',          icon: ClipboardList },
      { to: '/refunds',         label: 'Refunds',         icon: Receipt },
      { to: '/leaves',          label: 'Leaves',          icon: CalendarDays },
      { to: '/payouts',         label: 'Payouts',         icon: Banknote },
    ],
  },
  {
    title: 'Growth',
    items: [
      { to: '/catalog',     label: 'Catalog',     icon: Package },
      { to: '/promos',      label: 'Promos',      icon: Tag },
      { to: '/banners',     label: 'Banners',     icon: ImageIcon },
      { to: '/push',        label: 'Push',        icon: Bell },
      { to: '/experiments', label: 'Experiments', icon: FlaskConical },
    ],
  },
  {
    title: 'Insights',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    title: 'Trust & Safety',
    items: [
      { to: '/disputes', label: 'Disputes', icon: ShieldAlert },
    ],
  },
  {
    title: 'Platform',
    items: [
      { to: '/flags',      label: 'Flags',      icon: Flag },
      { to: '/localities', label: 'Localities', icon: MapPinned },
      { to: '/sessions',   label: 'Sessions',   icon: Clock },
      { to: '/audit',      label: 'Audit',      icon: FileText },
      { to: '/settings',   label: 'Settings',   icon: SettingsIcon },
    ],
  },
];

// SDUI control panel — admin-gated, so it's appended to SECTIONS only when the
// current operator can read SDUI configs (see Sidebar render).
const SDUI_SECTION: { title: string; items: Item[] } = {
  title: 'SDUI',
  items: [
    { to: '/sdui',                 label: 'Pages',           icon: LayoutDashboard },
    { to: '/sdui/allowed-actions', label: 'Action allowlist', icon: ListChecks },
  ],
};

export function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const proMode = useProMode((s) => s.enabled);
  const setProMode = useProMode((s) => s.set);

  // SDUI control panel is admin-only — append its nav section just for those
  // operators so non-admins never see the entry points.
  const canSeeSdui = usePermission('sdui.read');
  const sections = canSeeSdui ? [...SECTIONS, SDUI_SECTION] : SECTIONS;

  // Live count of pending zone approvals — drives the badge next to the
  // sidebar link. Same query key the page uses, so the data is shared.
  const canSeeZoneApprovals = usePermission('zones.approval.read');
  const zaQ = useQuery({
    queryKey: zoneApprovalKeys.pending,
    queryFn: listPendingZoneApprovals,
    refetchInterval: 30_000,
    enabled: canSeeZoneApprovals,
    staleTime: 15_000,
  });
  const badgeFor = (to: string): number | null => {
    if (to !== '/zone-approvals') return null;
    const n = zaQ.data?.length ?? 0;
    return n > 0 ? n : null;
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 260 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="shrink-0 bg-surface border-r border-border flex flex-col"
    >
      <div className="h-16 px-4 flex items-center border-b border-border">
        <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mr-3">
          <span className="text-primary font-bold text-sm">Z</span>
        </div>
        {!collapsed && (
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">Zopmop</div>
            <div className="text-[11px] text-text-secondary leading-tight">CRM</div>
          </div>
        )}
        <button
          onClick={onToggleCollapsed}
          className="text-text-muted hover:text-text-primary transition"
          aria-label={collapsed ? 'expand sidebar' : 'collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {sections.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed && (
              <div className="px-4 mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                {section.title}
              </div>
            )}
            <div className="px-2 flex flex-col gap-0.5">
              {section.items.map((it) => {
                const badge = badgeFor(it.to);
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === '/'}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition ${
                        isActive
                          ? 'bg-primary/10 border border-primary/30 text-text-primary shadow-glow-primary/30'
                          : 'border border-transparent text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                      }`
                    }
                    title={collapsed ? it.label : undefined}
                  >
                    <it.icon className="w-4 h-4 shrink-0" />
                    {!collapsed && <span className="truncate flex-1">{it.label}</span>}
                    {badge != null && (
                      collapsed ? (
                        <span
                          className="absolute -translate-y-3 translate-x-3 w-2 h-2 rounded-full bg-danger"
                          aria-label={`${badge} pending`}
                        />
                      ) : (
                        <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-danger/90 text-white text-[10px] font-semibold tabular-nums">
                          {badge}
                        </span>
                      )
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-border">
        {!collapsed ? (
          <label className="flex items-center justify-between px-2 py-2 cursor-pointer">
            <div>
              <div className="text-sm font-medium">Pro Mode</div>
              <div className="text-[11px] text-text-secondary">Show advanced controls</div>
            </div>
            <input
              type="checkbox"
              className="sr-only peer"
              checked={proMode}
              onChange={(e) => setProMode(e.target.checked)}
            />
            <span
              onClick={() => setProMode(!proMode)}
              className={`w-9 h-5 rounded-full transition relative ${
                proMode ? 'bg-primary' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                  proMode ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </span>
          </label>
        ) : (
          <button
            onClick={() => setProMode(!proMode)}
            className={`w-full flex justify-center p-2 rounded-xl transition ${
              proMode ? 'bg-primary/15 border border-primary/30' : 'border border-transparent text-text-muted hover:text-text-primary'
            }`}
            title={proMode ? 'Pro Mode: ON' : 'Pro Mode: OFF'}
          >
            <Sliders className="w-4 h-4" />
          </button>
        )}
      </div>
    </motion.aside>
  );
}
