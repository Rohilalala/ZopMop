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
  // Live helper headroom for the slot. Present only on the capacity-aware
  // /bookings/availability endpoint; absent on the plain /slots fallback, where
  // the modal derives it from max_bookings − current_bookings.
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

// Capacity-aware slots for a given address's locality. Hits the
// /bookings/availability endpoint (slot-capacity pilot) which layers
// available_capacity + a live is_available onto each slot. Falls back to the
// plain /slots feed when no address is known or the endpoint isn't deployed yet
// (the capacity backend ships on a separate branch) — in that case slots carry
// no available_capacity and the UI degrades to Available/Full only.
export async function getSlotAvailability(
  token: string,
  addressId: string | undefined,
  date: string,
  durationMin?: number,
): Promise<ApiSlotPeriod[]> {
  if (!addressId) return getTimeSlots(token, date);
  try {
    // Pass the cart's total duration so the endpoint computes availability over
    // each slot's job window — a slot a long job can't book won't show open.
    const durationQS = durationMin && durationMin > 0 ? `&duration_minutes=${durationMin}` : '';
    const res = await apiFetch(
      `${BASE_URL}/bookings/availability?address_id=${addressId}&date=${date}${durationQS}`,
      { headers: authHeaders(token) },
    );
    if (!res.ok) return getTimeSlots(token, date);
    const data = await res.json();
    return (data.periods ?? []) as ApiSlotPeriod[];
  } catch {
    return getTimeSlots(token, date);
  }
}
