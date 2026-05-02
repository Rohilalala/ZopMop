// Helper-side booking endpoints — used by the pro app to recover state and
// display today's bookings on the dashboard.

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
