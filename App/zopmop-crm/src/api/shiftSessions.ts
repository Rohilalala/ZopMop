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
  online_selfie_url?: string | null;
  offline_selfie_url?: string | null;
};

export type ShiftSessionList = {
  items: ShiftSession[];
  total_count: number;
  limit: number;
  offset: number;
};

export async function listShiftSessions(limit = 50, offset = 0): Promise<ShiftSessionList> {
  const res = await api.get<ShiftSessionList>('/admin/shift-sessions', { params: { limit, offset } });
  return res.data;
}

export const shiftSessionKeys = {
  all: ['shiftSessions'] as const,
  list: (limit: number, offset: number) => ['shiftSessions', 'list', limit, offset] as const,
};
