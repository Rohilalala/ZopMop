// Shift-session admin view. Backend: internal/crm/shiftsessions/handler.go
// (GET /admin/shift-sessions). Read-only; shows the mandatory go-online /
// go-offline selfies (base64 data URLs).

import { api } from './client';

export type ShiftSession = {
  id: string;
  pro_id: string;
  pro_name?: string | null;
  pro_phone?: string | null;
  online_at?: string | null;
  offline_at?: string | null;
  online_minutes?: number | null;
  // The list carries presence flags only — the (large, base64) selfies are
  // lazy-loaded per session via getShiftSessionSelfies to keep the list small.
  has_online_selfie: boolean;
  has_offline_selfie: boolean;
};

export type ShiftSessionList = {
  items: ShiftSession[];
  total_count: number;
  limit: number;
  offset: number;
};

export type ShiftSessionSelfies = {
  online_selfie_url?: string | null;
  offline_selfie_url?: string | null;
};

export async function listShiftSessions(limit = 50, offset = 0): Promise<ShiftSessionList> {
  const res = await api.get<ShiftSessionList>('/admin/shift-sessions', { params: { limit, offset } });
  return res.data;
}

export async function getShiftSessionSelfies(id: string): Promise<ShiftSessionSelfies> {
  const res = await api.get<ShiftSessionSelfies>(`/admin/shift-sessions/${id}/selfies`);
  return res.data;
}

export const shiftSessionKeys = {
  all: ['shiftSessions'] as const,
  list: (limit: number, offset: number) => ['shiftSessions', 'list', limit, offset] as const,
};
