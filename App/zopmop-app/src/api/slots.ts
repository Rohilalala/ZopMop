import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface ApiTimeSlot {
  id: string;
  slot_date: string;
  start_time: string;
  end_time: string;
  period: string;
  max_bookings: number;
  current_bookings: number;
  is_available: boolean;
  // Remaining live helper capacity for the slot. Present only on the
  // capacity-aware availability endpoint (getSlotAvailability), not on the
  // plain /slots list.
  available_capacity?: number;
}

export interface ApiSlotPeriod {
  label: string; // "Morning" | "Afternoon" | "Evening"
  slots: ApiTimeSlot[];
}

// Returns slots grouped by period as the backend sends them.
// Response shape: { date, periods: [{ label, slots: [...] }] }
export async function getTimeSlots(token: string, date: string): Promise<ApiSlotPeriod[]> {
  const res = await apiFetch(`${BASE_URL}/slots?date=${date}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to fetch time slots');
  const data = await res.json();
  return (data.periods ?? []) as ApiSlotPeriod[];
}

// Capacity-aware variant of getTimeSlots. is_available folds in the live
// helper capacity for the address's locality (a slot can be unavailable here
// even when the plain /slots list shows it open), and each slot carries an
// available_capacity count. address_id scopes the locality and must be one of
// the caller's saved addresses. Same response shape as getTimeSlots.
export async function getSlotAvailability(
  token: string,
  date: string,
  addressId: string,
): Promise<ApiSlotPeriod[]> {
  const res = await apiFetch(
    `${BASE_URL}/bookings/availability?date=${encodeURIComponent(date)}&address_id=${encodeURIComponent(addressId)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error('Failed to fetch slot availability');
  const data = await res.json();
  return (data.periods ?? []) as ApiSlotPeriod[];
}
