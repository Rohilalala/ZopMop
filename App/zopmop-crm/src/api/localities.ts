// Localities — operational areas managed by CRM admins.
// Backend: internal/crm/localities/localities.go.

import { api } from './client';

export interface Locality {
  id: string;
  name: string;
  city: string;
  active: boolean;
  created_at: string;
}

interface ListResponse {
  localities: Locality[];
}

export async function listLocalities(opts?: { city?: string; activeOnly?: boolean }): Promise<Locality[]> {
  const params: Record<string, string> = {};
  if (opts?.city) params.city = opts.city;
  if (opts?.activeOnly) params.active = 'true';
  const res = await api.get<ListResponse>('/admin/localities', { params });
  return res.data.localities ?? [];
}

export async function createLocality(name: string, city: string): Promise<Locality> {
  const res = await api.post<Locality>('/admin/localities', { name, city });
  return res.data;
}

export async function updateLocality(
  id: string,
  patch: { name: string; city: string; active: boolean },
): Promise<Locality> {
  const res = await api.patch<Locality>(`/admin/localities/${encodeURIComponent(id)}`, patch);
  return res.data;
}

export async function deleteLocality(id: string): Promise<void> {
  await api.delete(`/admin/localities/${encodeURIComponent(id)}`);
}
