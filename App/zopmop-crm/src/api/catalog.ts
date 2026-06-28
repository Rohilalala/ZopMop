// Service catalog — base price, MRP, and active flag, editable by CRM admins.
// Backend: internal/crm/catalog/catalog.go (reuses internal/services).
// Edits go live: the customer app refetches GET /services on its next load —
// there is no cache between a CRM edit and the app seeing the new price.

import { api } from './client';

export interface CatalogService {
  id: string;
  name: string;
  category: string;
  bg_color: string;
  base_price_paise: number;
  mrp_paise?: number;
  rating: number;
  review_count: number;
  min_duration_minutes: number;
  max_duration_minutes: number;
  duration_step_minutes: number;
  is_active: boolean;
  display_order: number;
  created_at: string;
}

interface ListResponse {
  services: CatalogService[];
}

export async function listCatalog(): Promise<CatalogService[]> {
  const res = await api.get<ListResponse>('/admin/catalog');
  return res.data.services ?? [];
}

export interface CatalogUpdate {
  base_price_paise?: number;
  mrp_paise?: number;
  is_active?: boolean;
}

export async function updateCatalogService(id: string, patch: CatalogUpdate): Promise<CatalogService> {
  const res = await api.patch<CatalogService>(`/admin/catalog/${encodeURIComponent(id)}`, patch);
  return res.data;
}
