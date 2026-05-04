import { Link } from 'react-router-dom';
import {
  Tag, Send, Image as ImageIcon, RotateCcw, Users, Activity,
  type LucideIcon,
} from 'lucide-react';

import { usePermission } from '@/auth/usePermission';
import type { PermissionKey } from '@/auth/permissions';

// QuickActions: pill row of common admin shortcuts. Permission-gated entries
// hide entirely when the operator lacks the perm (less clutter than greying
// out). Buttons for routes that don't exist yet render as disabled with a
// "Coming soon" tooltip — visible to everyone so people know the surface is
// planned, just not built.

type ActionPill =
  | {
      kind: 'link';
      label: string;
      to: string;
      icon: LucideIcon;
      perm?: PermissionKey;
    }
  | {
      kind: 'disabled';
      label: string;
      icon: LucideIcon;
      tooltip: string;
    };

const ACTIONS: ActionPill[] = [
  { kind: 'link',     label: 'New Promo',     to: '/promos',   icon: Tag,       perm: 'promos.create' },
  { kind: 'link',     label: 'Send Push',     to: '/push',     icon: Send,      perm: 'push.create' },
  { kind: 'link',     label: 'Add Banner',    to: '/banners',  icon: ImageIcon, perm: 'banners.create' },
  { kind: 'link',     label: 'View Refunds',  to: '/refunds',  icon: RotateCcw },
  { kind: 'disabled', label: 'View Pipeline', icon: Users,    tooltip: 'Coming soon — pipeline not yet built' },
  { kind: 'disabled', label: 'SLA Dashboard', icon: Activity, tooltip: 'Coming soon — SLA dashboard not yet built' },
];

export function QuickActions() {
  // Compute every gate up-front so hook order stays stable across renders.
  const grants: Partial<Record<PermissionKey, boolean>> = {
    'promos.create':  usePermission('promos.create'),
    'push.create':    usePermission('push.create'),
    'banners.create': usePermission('banners.create'),
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS.map((a) => {
        if (a.kind === 'disabled') {
          const Icon = a.icon;
          return (
            <button
              key={a.label}
              type="button"
              disabled
              title={a.tooltip}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-border bg-card text-sm text-text-muted opacity-60 cursor-not-allowed"
            >
              <Icon className="w-4 h-4" />
              {a.label}
            </button>
          );
        }
        if (a.perm && !grants[a.perm]) return null;
        const Icon = a.icon;
        return (
          <Link
            key={a.label}
            to={a.to}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-border bg-card text-sm text-text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
          >
            <Icon className="w-4 h-4 text-primary" />
            {a.label}
          </Link>
        );
      })}
    </div>
  );
}
