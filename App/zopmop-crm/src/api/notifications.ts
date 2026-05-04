import { api } from './client';

export type NotificationSeverity = 'info' | 'warning' | 'urgent';

export interface CrmNotification {
  id: number;
  title: string;
  body: string;
  severity: NotificationSeverity;
  entity_type?: string | null;
  entity_id?: string | null;
  read_at?: string | null;
  created_at: string;
}

export async function listNotifications(params?: { unread?: boolean; limit?: number }): Promise<CrmNotification[]> {
  const q: Record<string, string> = {};
  if (params?.unread) q.unread = 'true';
  if (params?.limit) q.limit = String(params.limit);
  const res = await api.get<{ items: CrmNotification[] }>('/admin/notifications', { params: q });
  return res.data.items;
}

export async function unreadCount(): Promise<number> {
  const res = await api.get<{ unread: number }>('/admin/notifications/unread-count');
  return res.data.unread;
}

export async function markRead(id: number): Promise<void> {
  await api.post(`/admin/notifications/${id}/read`);
}

export async function markAllRead(): Promise<void> {
  await api.post('/admin/notifications/read-all');
}

// Best-effort link resolver — entity_type → CRM route. Returns null when the
// entity isn't routable from the CRM (yet).
export function resolveNotificationLink(n: CrmNotification): string | null {
  if (!n.entity_type || !n.entity_id) return null;
  switch (n.entity_type) {
    case 'booking':
    case 'order':
      return `/orders?id=${encodeURIComponent(n.entity_id)}`;
    case 'refund':
      return `/refunds?id=${encodeURIComponent(n.entity_id)}`;
    case 'user':
    case 'customer':
      return `/users?id=${encodeURIComponent(n.entity_id)}`;
    case 'worker':
    case 'helper':
    case 'pro':
      return `/workers?id=${encodeURIComponent(n.entity_id)}`;
    case 'leave':
      return `/leaves?id=${encodeURIComponent(n.entity_id)}`;
    default:
      return null;
  }
}
