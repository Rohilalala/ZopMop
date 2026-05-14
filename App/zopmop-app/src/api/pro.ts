// Helper-side API — bookings, profile stats, used by the pro app.

import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type HelperBookingStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface HelperBooking {
  id: string;
  customer_id: string;
  helper_id?: string | null;
  service_category_id: string;
  status: HelperBookingStatus;
  address: string;
  lat: number;
  lng: number;
  price_cents: number;
  promo_code?: string | null;
  discount_cents: number;
  created_at: string;
  updated_at: string;
}

/**
 * GET /bookings/helper/active — bookings currently accepted or in_progress
 * for the authenticated helper.
 */
export async function getHelperActive(token: string): Promise<HelperBooking[]> {
  const res = await apiFetch(`${BASE_URL}/bookings/helper/active`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error('Failed to load active bookings');
  }
  const data = await res.json();
  const bookings = (data?.bookings ?? []) as HelperBooking[];
  return Array.isArray(bookings) ? bookings : [];
}

/**
 * GET /bookings/helper/today — every booking the helper touched today
 * (active + completed/cancelled today).
 */
export async function getHelperToday(token: string): Promise<HelperBooking[]> {
  const res = await apiFetch(`${BASE_URL}/bookings/helper/today`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error("Failed to load today's bookings");
  }
  const data = await res.json();
  const bookings = (data?.bookings ?? []) as HelperBooking[];
  return Array.isArray(bookings) ? bookings : [];
}

export interface HelperStats {
  average_rating: number;
  total_jobs: number;
  total_earned_paise: number;
}

/**
 * GET /helpers/me/stats — lifetime rating, job count, and earnings.
 */
export async function getHelperStats(token: string): Promise<HelperStats> {
  const res = await apiFetch(`${BASE_URL}/helpers/me/stats`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load stats');
  return res.json() as Promise<HelperStats>;
}
