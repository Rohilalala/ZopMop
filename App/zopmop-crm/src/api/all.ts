// Centralised API helpers for the bulk-built modules. Smaller surface than
// per-module files; each builds on the same axios client. The richer
// modules (users, workers) keep their own typed files.
import { api } from './client';

// ── Health ─────────────────────────────────────────────────────────────
export type HealthMetrics = {
  avg_latency_ms: number;
  error_rate: number;
  request_count: number;
  uptime: 'up' | 'down' | 'unknown';
  app_url: string;
  checked_at: string;
};

export async function getHealthMetrics(): Promise<HealthMetrics> {
  const r = await api.get<HealthMetrics>('/admin/health/metrics');
  return r.data;
}

// ── Orders ─────────────────────────────────────────────────────────────
// Wire-field names match internal/crm/orders/orders.go::Detail exactly:
// the Go json tags are `price_paise` / `discount_paise` (not _cents). The
// SPA previously had _cents which silently rendered NaN — fixed here.
export type Order = {
  id: string;
  customer_name?: string | null;
  customer_phone: string;
  worker_name?: string | null;
  worker_phone?: string | null;
  category: string;
  status: string;
  price_paise: number;
  discount_paise: number;
  promo_code?: string | null;
  created_at: string;
  completed_at?: string | null;
};
export type OrderDetail = Order & {
  customer_id: string;
  worker_id?: string | null;
  address: string;
  lat: number; lng: number;
  scheduled_time?: string | null;
  matched_at?: string | null; accepted_at?: string | null;
  started_at?: string | null; arrived_at?: string | null;
  en_route_at?: string | null;
  cancelled_at?: string | null; cancelled_by?: string | null;
  services: OrderServiceLine[];
};

// One row of the booking_services join surfaced via Phase 11B Step 1's
// extension to the detail query.
export type OrderServiceLine = {
  service_id: string;
  service_name: string;
  duration_minutes: number;
  price_paise: number;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  display_order: number;
  started_at?: string | null;
  completed_at?: string | null;
  skip_reason?: string | null;
};

export type AvailableWorker = {
  worker_id: string;
  name: string;
  rating: number;
  distance_km: number;
  categories: string[];
  current_status: string;
};

export type OrderNote = {
  id: string;
  booking_id: string;
  admin_id: string;
  admin_email?: string;
  body: string;
  created_at: string;
};

export const ordersApi = {
  list: (p: Record<string, string | number>) => api.get('/admin/orders', { params: p }).then(r => r.data as { items: Order[]; total_count: number; limit: number; offset: number }),
  get: (id: string) => api.get<OrderDetail>(`/admin/orders/${id}`).then(r => r.data),
  cancel: (id: string, reason: string) => api.post(`/admin/orders/${id}/cancel`, { reason }),
  complete: (id: string) => api.post(`/admin/orders/${id}/complete`),
  availableWorkers: (id: string, radiusKm?: number) =>
    api.get<AvailableWorker[]>(`/admin/orders/${id}/available-workers`, {
      params: radiusKm ? { radius_km: radiusKm } : undefined,
    }).then(r => r.data),
  reassign: (id: string, body: { new_worker_id: string; reason: string }) => api.post(`/admin/orders/${id}/reassign`, body),
  listNotes: (id: string) =>
    api.get<{ items: OrderNote[] }>(`/admin/orders/${id}/notes`).then(r => r.data.items ?? []),
  addNote: (id: string, body: string) =>
    api.post<OrderNote>(`/admin/orders/${id}/notes`, { body }).then(r => r.data),
};

export const orderKeys = {
  all: ['orders'] as const,
  detail: (id: string) => ['orders', 'detail', id] as const,
  notes: (id: string) => ['orders', id, 'notes'] as const,
  availableWorkers: (id: string, radiusKm: number) => ['orders', id, 'available-workers', radiusKm] as const,
};

// ── Refunds ────────────────────────────────────────────────────────────
export type RefundStatus =
  | 'pending'
  | 'approved'
  | 'processed'
  | 'processed_manual'
  | 'gateway_error'
  | 'rejected'
  | 'cancelled';
export type PaymentMethod = 'cod' | 'upi' | 'card' | 'wallet' | 'netbanking';

export type Refund = {
  id: string;
  user_id: string;
  user_name?: string | null;
  user_phone: string;
  amount_paise: number;
  source: string;
  source_ref?: string | null;
  status: RefundStatus;
  created_at: string;
  settled_at?: string | null;
  // T1.6 gateway integration fields.
  payment_method?: PaymentMethod | null;
  payment_id?: string | null;
  gateway_refund_id?: string | null;
  processed_at?: string | null;
  error_message?: string | null;
  partial_amount_paise?: number | null;
  approved_at?: string | null;
};

export type RefundApproveResponse = {
  ok: boolean;
  status?: RefundStatus;
  gateway_refund_id?: string | null;
};

export type RefundFromOrderResponse = {
  ok: boolean;
  refund_id: string;
  status: RefundStatus;
  gateway_refund_id?: string | null;
};

export const refundsApi = {
  list: (p: Record<string, string | number>) => api.get('/admin/refunds', { params: p }).then(r => r.data as { items: Refund[]; total_count: number }),
  approve: (id: string, body: { amount_paise?: number; reason: string }) =>
    api.post<RefundApproveResponse>(`/admin/refunds/${id}/approve`, body).then(r => r.data),
  reject:  (id: string, reason: string) => api.post(`/admin/refunds/${id}/reject`, { reason }),
  retry:   (id: string) => api.post(`/admin/refunds/${id}/retry`).then(() => undefined),
  fromOrder: (orderId: string, body: { amount_paise: number; reason: string }) =>
    api.post<RefundFromOrderResponse>(`/admin/refunds/from-order/${orderId}`, body).then(r => r.data),
};

// ── Promos ─────────────────────────────────────────────────────────────
export type Promo = {
  id: string; code: string; name?: string | null; description?: string | null;
  discount_type: string; discount_value: number; min_order_paise: number;
  max_uses: number; uses_count: number; max_per_user: number; is_active: boolean;
  starts_at?: string | null; expires_at?: string | null;
  audience: string; audience_user_ids: string[]; categories: string[]; stackable: boolean;
  created_at: string;
};
export const promosApi = {
  list: (p: Record<string, string | number>) => api.get('/admin/promos', { params: p }).then(r => r.data as { items: Promo[]; total_count: number }),
  get: (id: string) => api.get<Promo>(`/admin/promos/${id}`).then(r => r.data),
  generateCode: () => api.get<{ code: string }>('/admin/promos/generate-code').then(r => r.data.code),
  create: (body: Partial<Promo>) => api.post<Promo>('/admin/promos', body).then(r => r.data),
  update: (id: string, body: Partial<Promo>) => api.put(`/admin/promos/${id}`, body),
  activate: (id: string) => api.post(`/admin/promos/${id}/activate`),
  deactivate: (id: string) => api.post(`/admin/promos/${id}/deactivate`),
  stats: (id: string) => api.get<{ redemptions: number; unique_users: number; discount_paise: number; revenue_paise: number }>(`/admin/promos/${id}/stats`).then(r => r.data),
};

// ── Banners ────────────────────────────────────────────────────────────
export type Banner = {
  id: string; title: string; subtitle?: string | null; image_url: string;
  tap_action?: string | null; cta_label?: string | null; cta_kind?: string | null;
  display_order: number; is_active: boolean;
  starts_at?: string | null; ends_at?: string | null;
  audience: string; audience_zone?: string | null;
  created_at: string;
};
export const bannersApi = {
  list: () => api.get<{ items: Banner[] }>('/admin/banners').then(r => r.data.items),
  create: (body: Partial<Banner>) => api.post<Banner>('/admin/banners', body).then(r => r.data),
  update: (id: string, body: Partial<Banner>) => api.put(`/admin/banners/${id}`, body),
  delete: (id: string) => api.delete(`/admin/banners/${id}`),
  reorder: (ids: string[]) => api.post('/admin/banners/reorder', { ids }),
};

// ── Experiments ────────────────────────────────────────────────────────
export type Variant = { id: string; name: string; value: unknown; traffic_pct: number };
export type Experiment = {
  id: string; name: string; hypothesis?: string | null; kind: string;
  target_key?: string | null; variants: Variant[]; metric: string;
  audience: string; status: string;
  started_at?: string | null; ended_at?: string | null; winner_variant?: string | null;
  created_at: string; updated_at: string;
};
export const experimentsApi = {
  list: () => api.get<{ items: Experiment[] }>('/admin/experiments').then(r => r.data.items),
  create: (body: Partial<Experiment>) => api.post<Experiment>('/admin/experiments', body).then(r => r.data),
  start: (id: string) => api.post(`/admin/experiments/${id}/start`),
  pause: (id: string) => api.post(`/admin/experiments/${id}/pause`),
  stop: (id: string) => api.post(`/admin/experiments/${id}/stop`),
  rollout: (id: string, winner: string) => api.post(`/admin/experiments/${id}/rollout`, { winner }),
};

// ── Analytics ──────────────────────────────────────────────────────────
export const analyticsApi = {
  summary: (params: Record<string, string>) => api.get('/admin/analytics/summary', { params }).then(r => r.data as { orders: number; completed_orders: number; cancelled_orders: number; revenue_paise: number; new_users: number; new_workers: number; avg_order_paise: number }),
  revenueDaily: (params: Record<string, string>) => api.get<{ points: { date: string; value: number }[] }>('/admin/analytics/revenue-daily', { params }).then(r => r.data.points),
  ordersDaily: (params: Record<string, string>) => api.get<{ points: { date: string; value: number }[] }>('/admin/analytics/orders-daily', { params }).then(r => r.data.points),
  signupsDaily: (params: Record<string, string>) => api.get<{ points: { date: string; value: number }[] }>('/admin/analytics/signups-daily', { params }).then(r => r.data.points),
  byCategory: (params: Record<string, string>) => api.get<{ items: { category: string; orders: number; revenue_paise: number }[] }>('/admin/analytics/by-category', { params }).then(r => r.data.items),
};

// ── Growth ─────────────────────────────────────────────────────────────
export type PushMsg = {
  id: string; title: string; body: string; image_url?: string | null; deep_link?: string | null;
  target_kind: string; estimated_reach: number;
  scheduled_at?: string | null; sent_at?: string | null; status: string; created_at: string;
  sent_count?: number;
  delivered_count?: number;
  failed_count?: number;
  error_message?: string;
};

export type PushTarget =
  | { kind: 'users' }
  | { kind: 'pros' }
  | { kind: 'both' }
  | { kind: 'user'; id: string }
  | { kind: 'worker'; id: string };

function targetParam(t: PushTarget): string {
  switch (t.kind) {
    case 'users':
    case 'pros':
    case 'both':
      return t.kind;
    case 'user':
      return `user:${t.id}`;
    case 'worker':
      return `worker:${t.id}`;
  }
}

export async function getPushReach(target: PushTarget): Promise<number> {
  const r = await api.get<{ count: number }>(`/admin/growth/push/reach`, {
    params: { target: targetParam(target) },
  });
  return r.data.count;
}

export const growthApi = {
  listPush: () => api.get<{ items: PushMsg[] }>('/admin/growth/push').then(r => r.data.items),
  createPush: (body: { title: string; body: string; image_url?: string; deep_link?: string; target_kind: string; user_ids?: string[]; scheduled_at?: string | null }) =>
    api.post<PushMsg>('/admin/growth/push', body).then(r => r.data),
  sendPush: (id: string) => api.post(`/admin/growth/push/${id}/send`),
  cancelPush: (id: string) => api.post(`/admin/growth/push/${id}/cancel`).then(() => undefined),
  retryPush: (id: string) => api.post(`/admin/growth/push/${id}/retry`).then(() => undefined),
  listLostUser: () => api.get<{ items: { id: string; name: string; inactive_days: number; trigger_kind: string; promo_code?: string | null; push_title?: string | null; push_body?: string | null; is_active: boolean; triggered_count: number; conversion_count: number; created_at: string }[] }>('/admin/growth/lost-user').then(r => r.data.items),
  createLostUser: (body: { name: string; inactive_days: number; trigger_kind: string; promo_code?: string; push_title?: string; push_body?: string; is_active: boolean }) =>
    api.post('/admin/growth/lost-user', body),
  toggleLostUser: (id: string, active: boolean) => api.post(`/admin/growth/lost-user/${id}/toggle`, { active }),
  getLoyalty: () => api.get<{ is_enabled: boolean; points_per_100_inr: number; points_per_redeem_inr: number; bonus_rules: unknown; updated_at: string }>('/admin/growth/loyalty').then(r => r.data),
  setLoyalty: (body: { is_enabled: boolean; points_per_100_inr: number; points_per_redeem_inr: number; bonus_rules?: unknown }) =>
    api.put('/admin/growth/loyalty', body),
  listWaitlists: () => api.get<{ items: { id: string; city: string; category?: string | null; description?: string | null; is_active: boolean; entry_count: number; created_at: string }[] }>('/admin/growth/waitlist').then(r => r.data.items),
  createWaitlist: (body: { city: string; category?: string; description?: string }) => api.post('/admin/growth/waitlist', body),
};

// ── Zones / Surge ──────────────────────────────────────────────────────
export type Zone = { id: string; name: string; city: string; lat: number; lon: number; radius_km: number; is_active: boolean; created_at: string };
export type SurgeRule = { id: string; zone_id: string; multiplier: number; starts_at?: string | null; ends_at?: string | null; reason?: string | null; is_active: boolean; created_at: string };
export const zonesApi = {
  list: () => api.get<{ items: Zone[] }>('/admin/zones').then(r => r.data.items),
  create: (body: { name: string; city: string; lat: number; lon: number; radius_km: number }) => api.post('/admin/zones', body),
  update: (id: string, body: { name: string; city: string; lat: number; lon: number; radius_km: number }) => api.put(`/admin/zones/${id}`, body),
  toggle: (id: string, active: boolean) => api.post(`/admin/zones/${id}/toggle`, { active }),
  surgeList: () => api.get<{ items: SurgeRule[] }>('/admin/zones/surge').then(r => r.data.items),
  surgeCreate: (body: { zone_id: string; multiplier: number; reason?: string; starts_at?: string | null; ends_at?: string | null }) => api.post('/admin/zones/surge', body),
  surgeDelete: (id: string) => api.delete(`/admin/zones/surge/${id}`),
};

// ── Payouts ────────────────────────────────────────────────────────────
export type Payout = {
  id: string; worker_id: string; worker_name?: string | null; worker_phone: string;
  period_start: string; period_end: string; amount_cents: number; status: string;
  paid_at?: string | null; external_ref?: string | null; notes?: string | null; created_at: string;
};
export const payoutsApi = {
  list: (p: Record<string, string | number>) => api.get<{ items: Payout[]; total_count: number }>('/admin/payouts', { params: p }).then(r => r.data),
  create: (body: { worker_id: string; period_start: string; period_end: string; amount_cents: number; notes?: string }) => api.post('/admin/payouts', body),
  paid: (id: string, externalRef: string) => api.post(`/admin/payouts/${id}/paid`, { external_ref: externalRef }),
  failed: (id: string, notes: string) => api.post(`/admin/payouts/${id}/failed`, { notes }),
};

// ── Trust & Safety ─────────────────────────────────────────────────────
export type Dispute = {
  id: string; booking_id?: string | null; customer_id?: string | null; worker_id?: string | null;
  source: string; description: string; severity: string; level: string; status: string;
  resolution?: string | null; assigned_to?: string | null;
  sla_due_at?: string | null; resolved_at?: string | null; created_at: string;
};
export type Fraud = { id: string; user_id?: string | null; pattern: string; details?: unknown; status: string; created_at: string };
export type BlacklistEntry = { id: string; kind: string; value: string; reason: string; created_at: string };
export type Incident = {
  id: string; severity: string; source: string; description: string;
  involved_user_id?: string | null; involved_worker_id?: string | null;
  actions_taken?: string | null; status: string; resolved_at?: string | null; created_at: string;
};
export const tsApi = {
  listDisputes: (status?: string) => api.get<{ items: Dispute[] }>('/admin/disputes', { params: status ? { status } : {} }).then(r => r.data.items),
  createDispute: (body: Partial<Dispute> & { description: string }) => api.post('/admin/disputes', body),
  resolveDispute: (id: string, resolution: string) => api.post(`/admin/disputes/${id}/resolve`, { resolution }),

  listFraud: (status?: string) => api.get<{ items: Fraud[] }>('/admin/fraud', { params: status ? { status } : {} }).then(r => r.data.items),
  reviewFraud: (id: string, status: string) => api.post(`/admin/fraud/${id}/review`, { status }),

  listBlacklist: () => api.get<{ items: BlacklistEntry[] }>('/admin/blacklist').then(r => r.data.items),
  addBlacklist: (body: { kind: string; value: string; reason: string }) => api.post('/admin/blacklist', body),
  removeBlacklist: (id: string) => api.delete(`/admin/blacklist/${id}`),

  listIncidents: () => api.get<{ items: Incident[] }>('/admin/incidents').then(r => r.data.items),
  createIncident: (body: Partial<Incident> & { description: string; severity: string; source: string }) => api.post('/admin/incidents', body),
  resolveIncident: (id: string) => api.post(`/admin/incidents/${id}/resolve`),
};

// ── Platform ───────────────────────────────────────────────────────────
export type Webhook = { id: string; url: string; events: string[]; is_active: boolean; created_at: string };
export type WebhookDelivery = {
  id: number;
  event: string;
  status_code?: number | null;
  response_body?: string | null;
  duration_ms?: number | null;
  attempt: number;
  succeeded: boolean;
  retried_at?: string | null;
  created_at: string;
};
export type Template = { id: string; category: string; name: string; body: string; created_at: string };
export type Ticket = { id: string; user_id?: string | null; subject: string; body: string; status: string; priority: string; assigned_to?: string | null; resolved_at?: string | null; created_at: string };
export type AppVersion = { id: string; platform: string; min_version: string; force_update: boolean; force_message?: string | null; created_at: string };
export type ChangelogEntry = { id: string; version: string; body: string; is_published: boolean; published_at?: string | null; created_at: string };
export type AuditRow = { id: number; admin_email?: string | null; action: string; module: string; target_type?: string | null; target_id?: string | null; before?: unknown; after?: unknown; ip_address?: string | null; created_at: string };
export const platformApi = {
  listWebhooks: () => api.get<{ items: Webhook[] }>('/admin/webhooks').then(r => r.data.items),
  createWebhook: (body: { url: string; events: string[]; secret?: string }) => api.post('/admin/webhooks', body),
  deleteWebhook: (id: string) => api.delete(`/admin/webhooks/${id}`),
  listDeliveries: (id: string) => api.get<{ items: WebhookDelivery[] }>(`/admin/webhooks/${id}/deliveries`).then(r => r.data.items),
  testWebhook: (id: string, body?: { event?: string; sample?: unknown }) => api.post<WebhookDelivery>(`/admin/webhooks/${id}/test`, body ?? {}).then(r => r.data),
  retryDelivery: (deliveryId: number) => api.post<{ new_delivery_id: number }>(`/admin/webhooks/deliveries/${deliveryId}/retry`).then(r => r.data),

  listTemplates: () => api.get<{ items: Template[] }>('/admin/templates').then(r => r.data.items),
  createTemplate: (body: { category: string; name: string; body: string }) => api.post('/admin/templates', body),
  updateTemplate: (id: string, body: { category: string; name: string; body: string }) => api.put(`/admin/templates/${id}`, body),
  deleteTemplate: (id: string) => api.delete(`/admin/templates/${id}`),

  listTickets: (status?: string) => api.get<{ items: Ticket[] }>('/admin/support', { params: status ? { status } : {} }).then(r => r.data.items),
  resolveTicket: (id: string) => api.post(`/admin/support/${id}/resolve`),

  listAppVersions: () => api.get<{ items: AppVersion[] }>('/admin/app-versions').then(r => r.data.items),
  setAppVersion: (body: { platform: string; min_version: string; force_update: boolean; force_message?: string }) => api.post('/admin/app-versions', body),

  listChangelog: () => api.get<{ items: ChangelogEntry[] }>('/admin/changelog').then(r => r.data.items),
  createChangelog: (body: { version: string; body: string; is_published: boolean }) => api.post('/admin/changelog', body),

  listAudit: (params: Record<string, string | number>) => api.get<{ items: AuditRow[] }>('/admin/audit', { params }).then(r => r.data.items),
};
