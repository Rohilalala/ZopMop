// Zone approval queue (Phase 11B Step 1 / Phase E).
// Backend: internal/crm/zoneapprovals/handler.go (mounted on cmd/crm-api).
// Enriched list response — see internal/shift/model.go::ZoneApprovalRequest.

import { api } from './client';

export type ZoneApprovalRequest = {
  id: string;
  pro_id: string;
  shift_commitment_id: string;
  requested_at: string;       // ISO timestamp
  current_lat: number;
  current_lng: number;
  photo_url?: string;
  status: 'pending' | 'approved' | 'rejected';
  notes?: string;

  // Enrichment (List endpoint only; pro-app insert response omits these).
  pro_name?: string | null;
  pro_phone?: string | null;
  assigned_zone_id?: string | null;
  assigned_zone_name?: string | null;
  assigned_zone_lat?: number | null;
  assigned_zone_lng?: number | null;
  assigned_zone_radius_km?: number | null;
  distance_meters?: number | null;
};

export async function listPendingZoneApprovals(): Promise<ZoneApprovalRequest[]> {
  const res = await api.get<{ requests: ZoneApprovalRequest[] | null }>('/admin/zone-approvals');
  return res.data.requests ?? [];
}

export async function approveZoneRequest(id: string): Promise<void> {
  await api.post(`/admin/zone-approvals/${id}/approve`);
}

export async function rejectZoneRequest(id: string, notes: string): Promise<void> {
  await api.post(`/admin/zone-approvals/${id}/reject`, { notes });
}

export const zoneApprovalKeys = {
  all: ['zoneApprovals'] as const,
  pending: ['zoneApprovals', 'pending'] as const,
};
