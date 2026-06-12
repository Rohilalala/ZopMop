import { api } from './client';

export type KPIs = {
  active_orders: number;
  workers_online: number;
  revenue_today_cents: number;
  pending_refunds: number;
  pending_applications: number;
  open_disputes: number;
  bookings_at_risk: number;
};

export type LiveOrder = {
  id: string;
  user_name: string;
  category: string;
  helper_name?: string | null;
  status: string;
  created_at: string;
};

export type RevenuePoint = { date: string; revenue_cents: number };
export type CategoryShare = { category: string; count: number };

export async function fetchKpis(): Promise<KPIs> {
  return (await api.get<KPIs>('/admin/dashboard/kpis')).data;
}
export async function fetchLiveOrders(): Promise<LiveOrder[]> {
  return (await api.get<{ orders: LiveOrder[] }>('/admin/dashboard/live-orders')).data.orders;
}
export async function fetchRevenue7d(): Promise<RevenuePoint[]> {
  return (await api.get<{ points: RevenuePoint[] }>('/admin/dashboard/revenue-7d')).data.points;
}
export async function fetchCategoryShare(): Promise<CategoryShare[]> {
  return (await api.get<{ categories: CategoryShare[] }>('/admin/dashboard/category-share')).data.categories;
}

export type Alert = {
  id: number;
  severity: 'error' | 'warning' | 'info';
  source: string;
  message: string;
  link?: string | null;
  metadata?: unknown;
  read_by: string[];
  created_at: string;
};
export async function fetchAlerts(): Promise<Alert[]> {
  return (await api.get<{ alerts: Alert[] }>('/admin/alerts')).data.alerts;
}
export async function markAllAlertsRead(): Promise<void> {
  await api.post('/admin/alerts/read-all');
}
