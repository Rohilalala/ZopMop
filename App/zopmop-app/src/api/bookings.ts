import { apiFetch } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';

export type BookingStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface BookingServiceItem {
  service_id: string;
  service_name: string;
  duration_minutes: number;
  price_cents: number;
}

export interface ApiBooking {
  id: string;
  customer_id: string;
  address_id?: string;
  time_slot_id?: string;
  scheduled_time?: string; // ISO 8601
  total_duration_minutes: number;
  services: BookingServiceItem[];
  status: BookingStatus;
  price_cents: number;
  discount_cents: number;
  promo_code?: string;
  created_at: string;
  helper_name?: string;
  helper_rating?: number;
  helper_lat?: number;
  helper_lng?: number;
}

export interface CreateBookingPayload {
  address_id: string;
  time_slot_id: string;
  promo_code?: string;
}

export async function createScheduledBooking(
  token: string,
  payload: CreateBookingPayload,
): Promise<ApiBooking> {
  const res = await apiFetch(`${BASE_URL}/bookings/scheduled`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to create booking');
  }
  return validateShape<ApiBooking>(await res.json(), ['id', 'customer_id', 'status', 'price_cents', 'created_at']);
}

export async function getBookings(
  token: string,
  status: 'upcoming' | 'past',
  page = 1,
): Promise<ApiBooking[]> {
  const res = await apiFetch(
    `${BASE_URL}/bookings?status=${status}&page=${page}&limit=20`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error('Failed to fetch bookings');
  const data = await res.json();
  if (!Array.isArray(data.bookings)) throw new Error('Invalid response: bookings is not an array');
  return (data.bookings as unknown[]).map(b =>
    validateShape<ApiBooking>(b, ['id', 'customer_id', 'status', 'price_cents', 'created_at']),
  );
}

export async function cancelBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to cancel booking');
}
