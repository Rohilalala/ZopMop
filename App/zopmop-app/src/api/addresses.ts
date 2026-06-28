import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface ApiAddress {
  id: string;
  user_id: string;
  tag: 'Home' | 'Work' | 'Other';
  title: string;
  flat_no: string;
  floor: string;
  building_name: string;
  landmark: string;
  full_address: string;
  receiver_name: string;
  receiver_phone: string;
  lat: number;
  lon: number;
  created_at: string;
}

export interface CreateAddressPayload {
  tag: 'Home' | 'Work' | 'Other';
  title: string;
  flat_no: string;
  floor: string;
  building_name: string;
  landmark: string;
  full_address: string;
  receiver_name: string;
  receiver_phone: string;
  lat: number;
  lon: number;
}

export async function listAddresses(token: string): Promise<ApiAddress[]> {
  const res = await apiFetch(`${BASE_URL}/addresses`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error('Failed to fetch addresses');
  const data = await res.json();
  return data.addresses as ApiAddress[];
}

export async function createAddress(token: string, payload: CreateAddressPayload): Promise<ApiAddress> {
  const res = await apiFetch(`${BASE_URL}/addresses`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body as any).error ?? 'Failed to save address') as Error & { fields?: unknown };
    if ((body as any).fields) err.fields = (body as any).fields;
    throw err;
  }
  return res.json() as Promise<ApiAddress>;
}

export async function updateAddress(token: string, id: string, payload: Partial<CreateAddressPayload>): Promise<ApiAddress> {
  const res = await apiFetch(`${BASE_URL}/addresses/${id}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body as any).error ?? 'Failed to update address') as Error & { fields?: unknown };
    if ((body as any).fields) err.fields = (body as any).fields;
    throw err;
  }
  return res.json() as Promise<ApiAddress>;
}

export async function deleteAddress(token: string, id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/addresses/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? 'Failed to delete address');
  }
}
