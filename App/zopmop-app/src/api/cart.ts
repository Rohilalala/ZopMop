import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface ApiCartItem {
  id: string;
  cart_id: string;
  service_id: string;
  service_name: string;
  duration_minutes: number;
  price_paise: number;
}

export interface ApiCart {
  id: string;
  user_id: string;
  items: ApiCartItem[];
  created_at: string;
  updated_at: string;
}

export async function getCart(token: string): Promise<ApiCart> {
  const res = await apiFetch(`${BASE_URL}/cart`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error('Failed to fetch cart');
  return res.json() as Promise<ApiCart>;
}

export async function addToCart(
  token: string,
  serviceId: string,
  durationMinutes: number,
): Promise<ApiCart> {
  const res = await apiFetch(`${BASE_URL}/cart/add`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ service_id: serviceId, duration_minutes: durationMinutes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to add item to cart');
  }
  return res.json() as Promise<ApiCart>;
}

export async function removeFromCart(token: string, itemId: string): Promise<ApiCart> {
  const res = await apiFetch(`${BASE_URL}/cart/items/${itemId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to remove cart item');
  return res.json() as Promise<ApiCart>;
}

export async function clearCart(token: string): Promise<void> {
  await apiFetch(`${BASE_URL}/cart`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}
