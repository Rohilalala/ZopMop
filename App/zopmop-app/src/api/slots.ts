import { apiFetch } from './client';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

export interface ApiTimeSlot {
  id: string;
  slot_date: string;
  start_time: string;
  end_time: string;
  period: string;
  max_bookings: number;
  current_bookings: number;
  is_available: boolean;
}

export interface ApiSlotPeriod {
  label: string; // "Morning" | "Afternoon" | "Evening"
  slots: ApiTimeSlot[];
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
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
