// Frontend permission map — mirrors backend RBAC. The value is the minimum
// role required. Keep in sync with the server-side permission registry.
export const PERMISSIONS = {
  // users
  'users.suspend': 'admin',
  'users.unsuspend': 'admin',
  'users.ban': 'admin',
  'users.unban': 'admin',
  'users.set_vip': 'admin',
  'users.add_note': 'support',

  // workers
  'workers.create': 'admin',
  'workers.approve': 'admin',
  'workers.reject': 'admin',
  'workers.suspend': 'admin',
  'workers.unsuspend': 'admin',
  'workers.force_offline': 'admin',
  'workers.set_categories': 'admin',
  'workers.add_note': 'support',
  'workers.read_pii': 'superadmin',
  'workers.deduct': 'admin',
  'workers.update': 'admin',

  // orders
  'orders.cancel': 'admin',
  'orders.complete': 'admin',
  'orders.reassign': 'admin',
  'orders.add_note': 'support',

  // refunds
  'refunds.approve_full': 'support',
  'refunds.approve_partial': 'admin',
  'refunds.reject': 'support',

  // promos
  'promos.create': 'admin',
  'promos.update': 'admin',
  'promos.toggle': 'admin',

  // catalog (service prices / MRP / active toggle)
  'catalog.read': 'viewer',
  'catalog.update': 'admin',

  // banners
  'banners.create': 'admin',
  'banners.update': 'admin',
  'banners.delete': 'admin',
  'banners.reorder': 'admin',

  // experiments
  'experiments.create': 'admin',
  'experiments.start': 'admin',
  'experiments.pause': 'admin',
  'experiments.stop': 'admin',
  'experiments.rollout': 'admin',

  // push
  'push.create': 'support',
  'push.send': 'support',

  // zones
  'zones.create': 'admin',
  'zones.update': 'admin',
  'zones.toggle': 'admin',

  // surge
  'surge.create': 'admin',
  'surge.delete': 'admin',

  // disputes
  'disputes.create': 'support',
  'disputes.resolve': 'support',

  // incidents
  'incidents.create': 'support',
  'incidents.resolve': 'support',

  // fraud
  'fraud.review': 'admin',

  // blacklist
  'blacklist.add': 'admin',
  'blacklist.remove': 'admin',

  // payouts
  'payouts.read': 'viewer',
  'payouts.create': 'admin',
  'payouts.mark_paid': 'admin',
  'payouts.mark_failed': 'admin',
  'payouts.recompute': 'admin',

  // performance flags
  'flags.review': 'admin',

  // templates
  'templates.create': 'admin',
  'templates.update': 'admin',
  'templates.delete': 'admin',

  // tickets
  'tickets.resolve': 'support',

  // leaves
  'leaves.deduct': 'admin',

  // zone approvals (Phase 11B)
  'zones.approval.read': 'support',
  'shift_sessions.read': 'support',
  'zones.approval.approve': 'admin',
  'zones.approval.reject': 'admin',

  // audit
  'audit.read': 'admin',

  // sdui (server-driven UI control panel)
  'sdui.read': 'admin',
  'sdui.write': 'admin',
  'sdui.activate': 'admin',

  // growth — waitlist
  'waitlist.create': 'admin',

  // superadmin-only
  'flags.update': 'superadmin',
  'flags.rollback': 'superadmin',
  'webhooks.create': 'superadmin',
  'webhooks.delete': 'superadmin',
  'app_version.update': 'superadmin',
  'changelog.publish': 'superadmin',
  'loyalty.update': 'superadmin',
  'lost_user.create': 'superadmin',
  'lost_user.toggle': 'superadmin',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Role = 'viewer' | 'support' | 'admin' | 'superadmin';

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  support: 1,
  admin: 2,
  superadmin: 3,
};

export function hasPermission(role: string | undefined | null, perm: PermissionKey): boolean {
  if (!role) return false;
  const min = PERMISSIONS[perm] as Role;
  const r = ROLE_RANK[role as Role];
  if (r === undefined) return false;
  return r >= ROLE_RANK[min];
}
