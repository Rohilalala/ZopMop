import { apiFetch } from './client';
import { BASE_URL } from './config';

export interface ApiService {
  id: string;
  name: string;
  description?: string;
  short_description?: string;
  emoji?: string;
  bg_color: string;
  base_price_cents: number;
  mrp_cents?: number;
  rating: number;
  review_count: number;
  min_duration_minutes: number;
  max_duration_minutes: number;
  duration_step_minutes: number;
  is_active: boolean;
  display_order: number;
}

export interface ServiceInclude {
  id: string;
  item: string;
  display_order: number;
}

export interface ServiceExclude {
  id: string;
  item: string;
  display_order: number;
}

export interface ServiceStep {
  id: string;
  step_number: number;
  title: string;
  description?: string;
  icon?: string;
}

export interface ServiceAddon {
  id: string;
  name: string;
  emoji?: string;
  bg_color: string;
  base_price_cents: number;
  display_order: number;
}

export interface ServiceDetails {
  service: ApiService;
  includes: ServiceInclude[];
  excludes: ServiceExclude[];
  steps: ServiceStep[];
}

export async function listServices(): Promise<ApiService[]> {
  const res = await apiFetch(`${BASE_URL}/services`);
  if (!res.ok) throw new Error('Failed to fetch services');
  const data = await res.json();
  return data.services as ApiService[];
}

export async function getServiceDetails(serviceId: string): Promise<ServiceDetails> {
  const res = await apiFetch(`${BASE_URL}/services/${serviceId}/details`);
  if (!res.ok) throw new Error('Failed to fetch service details');
  return res.json() as Promise<ServiceDetails>;
}

export async function getServiceAddons(serviceId: string): Promise<ServiceAddon[]> {
  const res = await apiFetch(`${BASE_URL}/services/${serviceId}/addons`);
  if (!res.ok) throw new Error('Failed to fetch service addons');
  const data = await res.json();
  return data.addons as ServiceAddon[];
}
