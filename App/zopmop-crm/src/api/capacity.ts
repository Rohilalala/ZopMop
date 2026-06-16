// Capacity — read-only window-recount breakdown per locality + date (spec §14.2).
// Backend: internal/crm/capacity/capacity.go → GET /admin/capacity.

import { api } from './client';

export type CapacityWindow = {
  slot_id: string;
  window_start: string; // "HH:MM" IST
  window_end: string;   // "HH:MM" IST
  roster: number;
  on_leave: number;
  committed: number;
  free: number;
};

export type CapacityResponse = {
  locality: string;
  date: string;
  windows: CapacityWindow[];
};

export async function fetchCapacity(locality: string, date: string): Promise<CapacityResponse> {
  const res = await api.get<CapacityResponse>('/admin/capacity', { params: { locality, date } });
  return { ...res.data, windows: res.data.windows ?? [] };
}
