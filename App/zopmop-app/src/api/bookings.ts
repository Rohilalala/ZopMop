import { apiFetch } from './client';
import { BASE_URL } from './config';

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
}

export interface CreateBookingPayload {
  address_id: string;
  time_slot_id: string;
  promo_code?: string;
}

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
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
  return res.json() as Promise<ApiBooking>;
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
  return data.bookings as ApiBooking[];
}

export async function cancelBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to cancel booking');
}
