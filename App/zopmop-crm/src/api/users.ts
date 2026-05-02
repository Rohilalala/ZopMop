import { api } from './client';

export type Status = 'active' | 'suspended' | 'banned' | 'deleted';

export type UserListItem = {
  id: string;
  phone: string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  role: string;
  status: Status;
  is_vip: boolean;
  joined_at: string;
  total_orders: number;
  ltv_cents: number;
  last_active_at?: string | null;
};

export type UserDetail = UserListItem & {
  suspend_reason?: string | null;
  ban_reason?: string | null;
  banned_at?: string | null;
  avg_order_cents: number;
  active_orders: number;
  preferred_categories: { category: string; count: number }[];
};

export type ListResponse = {
  items: UserListItem[];
  total_count: number;
  limit: number;
  offset: number;
};

export type Order = {
  id: string;
  category: string;
  status: string;
  price_cents: number;
  created_at: string;
  completed_at?: string | null;
};

export type Note = {
  id: string;
  admin_email?: string | null;
  body: string;
  created_at: string;
};

export type ListParams = {
  search?: string;
  status?: Status | '';
  role?: string;
  is_vip?: boolean;
  min_orders?: number;
  min_ltv_cents?: number;
  sort_by?: 'joined_at' | 'total_orders' | 'ltv_cents' | 'name';
  sort_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export async function listUsers(params: ListParams): Promise<ListResponse> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v == null) continue;
    cleaned[k] = String(v);
  }
  return (await api.get<ListResponse>('/admin/users', { params: cleaned })).data;
}

export async function getUser(id: string): Promise<UserDetail> {
  return (await api.get<UserDetail>(`/admin/users/${id}`)).data;
}

export async function getUserOrders(id: string): Promise<Order[]> {
  return (await api.get<{ orders: Order[] }>(`/admin/users/${id}/orders`)).data.orders;
}

export async function getUserNotes(id: string): Promise<Note[]> {
  return (await api.get<{ notes: Note[] }>(`/admin/users/${id}/notes`)).data.notes;
}

export async function addUserNote(id: string, body: string): Promise<Note> {
  return (await api.post<Note>(`/admin/users/${id}/notes`, { body })).data;
}

export async function userActiveOrders(id: string): Promise<{ has_active: boolean; count: number }> {
  return (await api.get<{ has_active: boolean; count: number }>(`/admin/users/${id}/active-orders`)).data;
}

export async function suspendUser(id: string, reason: string): Promise<void> {
  await api.post(`/admin/users/${id}/suspend`, { reason });
}
export async function unsuspendUser(id: string): Promise<void> {
  await api.post(`/admin/users/${id}/unsuspend`);
}
export async function banUser(id: string, reason: string): Promise<void> {
  await api.post(`/admin/users/${id}/ban`, { reason });
}
export async function unbanUser(id: string): Promise<void> {
  await api.post(`/admin/users/${id}/unban`);
}
export async function setUserVIP(id: string, isVIP: boolean): Promise<void> {
  await api.post(`/admin/users/${id}/vip`, { is_vip: isVIP });
}
