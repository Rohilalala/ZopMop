// Audit log read API. Backend: internal/crm/platform/platform.go ListAudit.
//
// Wire shape matches internal/crm/platform/platform.go::AuditRow exactly:
//   * id is an int64 sequence (NOT a UUID)
//   * admin_email may be null (no separate admin_id field on the response)
//   * before / after are separate JSON columns (NOT a single `details` field)
//   * ip_address is rendered via host() — IPv4 dotted-quad or v6 string
//
// Server-side filtering supports module / action / admin_email + limit only.
// Date range, entity_type, entity_id, offset pagination are client-side for
// now (or deferred to a backend follow-up). limit is hard-capped at 500.

import { api } from './client';

export type AuditRow = {
  id: number;
  admin_email?: string | null;
  action: string;
  module: string;
  target_type?: string | null;
  target_id?: string | null;
  before?: unknown;     // raw JSON from json.RawMessage
  after?: unknown;
  ip_address?: string | null;
  created_at: string;   // ISO timestamp
};

export type ListAuditParams = {
  module?: string;
  action?: string;
  admin_email?: string;
  limit?: number;       // 1-500, default 100 server-side
};

export async function listAudit(params: ListAuditParams = {}): Promise<AuditRow[]> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v == null) continue;
    cleaned[k] = String(v);
  }
  const res = await api.get<{ items: AuditRow[] | null }>('/admin/audit', { params: cleaned });
  return res.data.items ?? [];
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (params: ListAuditParams) => ['audit', 'list', params] as const,
};
