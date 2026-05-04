import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  LayoutDashboard, Briefcase, Users, UserCog, Megaphone,
  CircleDollarSign, Settings as SettingsIcon, Sliders,
  Map as MapIcon, FlaskConical, BarChart3, Image as ImageIcon,
  Bell, ShieldAlert, ChevronsLeft, ChevronsRight, CalendarDays, MapPin,
  type LucideIcon,
} from 'lucide-react';
import { useProMode } from '@/store/proMode';

// Sidebar navigation. Sections come from the spec — Overview, Operations,
// Workers, Growth, Finance, Platform, Settings. Pro Mode toggle lives in the
// footer and unmasks the more advanced tools globally.

type Item = { to: string; label: string; icon: LucideIcon };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Operations',
    items: [
      { to: '/orders',  label: 'Orders',   icon: Briefcase },
      { to: '/refunds', label: 'Refunds',  icon: CircleDollarSign },
      { to: '/users',   label: 'Users',    icon: Users },
    ],
  },
  {
    title: 'Workers',
    items: [
      { to: '/workers', label: 'Workers',  icon: UserCog },
      { to: '/leaves',  label: 'Leaves',   icon: CalendarDays },
      { to: '/map',     label: 'Live Map', icon: MapIcon },
    ],
  },
  {
    title: 'Growth',
    items: [
      { to: '/promos',     label: 'Promos',     icon: Megaphone },
      { to: '/banners',    label: 'Banners',    icon: ImageIcon },
      { to: '/experiments', label: 'A/B Tests', icon: FlaskConical },
      { to: '/push',        label: 'Push',      icon: Bell },
    ],
  },
  {
    title: 'Finance',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/payouts',   label: 'Payouts',   icon: CircleDollarSign },
    ],
  },
  {
    title: 'Platform',
    items: [
      { to: '/flags',      label: 'Feature Flags', icon: Sliders },
      { to: '/localities', label: 'Localities',    icon: MapPin },
      { to: '/disputes',   label: 'Disputes',      icon: ShieldAlert },
      { to: '/settings',   label: 'Settings',      icon: SettingsIcon },
    ],
  },
];

export function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const proMode = useProMode((s) => s.enabled);
  const setProMode = useProMode((s) => s.set);

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
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed && (
              <div className="px-4 mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                {section.title}
              </div>
            )}
            <div className="px-2 flex flex-col gap-0.5">
              {section.items.map((it) => (
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
                  {!collapsed && <span className="truncate">{it.label}</span>}
                </NavLink>
              ))}
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
