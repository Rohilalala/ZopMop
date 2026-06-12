import { apiFetch } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';
import { UnpaidBookingsError } from './users';

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
  price_paise: number;
}

export interface ApiBooking {
  id: string;
  customer_id: string;
  address_id?: string;
  address_tag?: string;   // "Home"/"Work"/"Other" — joined from user_addresses
  address_title?: string; // free-text label
  time_slot_id?: string;
  scheduled_time?: string; // ISO 8601
  total_duration_minutes: number;
  services: BookingServiceItem[];
  status: BookingStatus;
  price_paise: number;
  discount_paise: number;
  promo_code?: string;
  created_at: string;
  helper_id?: string;
  helper_name?: string;
  helper_rating?: number;
  helper_lat?: number;
  helper_lng?: number;
}

export interface CreateBookingPayload {
  address_id: string;
  time_slot_id: string;
  promo_code?: string;
  /**
   * Funding rail for the booking.
   *   - "direct" (default when omitted) → backend creates a pending
   *     payments row; client follows up with POST /payments/cashfree/order
   *     to launch the SDK.
   *   - "wallet" → backend debits the closed-loop wallet inline. Returns
   *     402 INSUFFICIENT_WALLET_BALANCE on short balance.
   */
  payment_source?: 'direct' | 'wallet';
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
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      count?: number;
      total_paise?: number;
    };
    if (res.status === 409 && err.code === 'UNPAID_BOOKINGS') {
      throw new UnpaidBookingsError(err.count ?? 0, err.total_paise ?? 0);
    }
    // A regular slot start that's inside the 45-minute lead window is rejected
    // by the backend with 400 {code:'slot_too_soon'} (spec §3.1). Surface a
    // dedicated error so the caller can show "use ASAP" copy instead of the
    // raw server string.
    if (res.status === 400 && err.code === 'slot_too_soon') {
      throw new SlotTooSoonError(err.error);
    }
    throw new Error(err.error ?? 'Failed to create booking');
  }
  return validateShape<ApiBooking>(await res.json(), ['id', 'customer_id', 'status', 'price_paise', 'created_at']);
}

// ── ASAP / instant cart booking (spec §3.2, §5) ─────────────────────────────
//
// POST /bookings/instant creates an ASAP booking from the server-side cart and
// force-assigns a pro synchronously. On success it returns the assignment
// outcome + the customer-facing arrival promise; when no pro is free right now
// it returns 409 {code:'no_pros_available', earliest_slot} after cancelling the
// just-created row server-side (nothing half-created persists).

/** Earliest bookable regular slot offered alongside a no-pros-available 409. */
export interface EarliestSlot {
  slot_id: string;
  date: string;        // YYYY-MM-DD (IST)
  start_time: string;  // "HH:MM"
  end_time: string;    // "HH:MM"
  scheduled_time: string; // RFC3339 (UTC)
}

/** Success payload of an ASAP booking — mirrors backend booking.ASAPResult. */
export interface ASAPResult {
  booking: ApiBooking;
  assigned: boolean;
  promise_eta_minutes: number;
  helper_name: string;
}

/** Thrown when the ASAP path finds no free pro (409 no_pros_available). */
export class NoProsAvailableError extends Error {
  readonly code = 'no_pros_available' as const;
  readonly earliest: EarliestSlot | null;
  constructor(earliest: EarliestSlot | null) {
    super('No pros are free right now');
    this.name = 'NoProsAvailableError';
    this.earliest = earliest;
  }
}

/** Thrown when a regular slot is booked inside the 45-min lead window (400). */
export class SlotTooSoonError extends Error {
  readonly code = 'slot_too_soon' as const;
  constructor(serverMessage?: string) {
    super(serverMessage ?? 'slots open 45 minutes out — use ASAP for now');
    this.name = 'SlotTooSoonError';
  }
}

export async function createInstantCartBooking(
  token: string,
  payload: { address_id: string; promo_code?: string; payment_source?: 'direct' | 'wallet' },
): Promise<ASAPResult> {
  const res = await apiFetch(`${BASE_URL}/bookings/instant`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      count?: number;
      total_paise?: number;
      earliest_slot?: EarliestSlot | null;
    };
    if (res.status === 409 && err.code === 'no_pros_available') {
      throw new NoProsAvailableError(err.earliest_slot ?? null);
    }
    if (res.status === 409 && err.code === 'UNPAID_BOOKINGS') {
      throw new UnpaidBookingsError(err.count ?? 0, err.total_paise ?? 0);
    }
    throw new Error(err.error ?? 'Failed to create booking');
  }
  const data = (await res.json()) as ASAPResult;
  validateShape<ApiBooking>(data.booking, ['id', 'customer_id', 'status', 'price_paise', 'created_at']);
  return data;
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
    validateShape<ApiBooking>(b, ['id', 'customer_id', 'status', 'price_paise', 'created_at']),
  );
}

export interface CancelBookingResponse {
  message: string;
  cancellation_fee_applied: boolean;
  cancellation_fee_paise: number;
}

export async function cancelBooking(
  token: string,
  bookingId: string,
): Promise<CancelBookingResponse> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to cancel booking');
  }
  return (await res.json()) as CancelBookingResponse;
}

// ── Ratings ────────────────────────────────────────────────────────────────
//
// NOTE: backend endpoint POST /bookings/:id/rate does NOT yet exist
// (verified during 2026-05-03 build). The call is wired here so the
// frontend rating screen ships ready-to-use; the server returns 404 today
// and the screen treats that as a non-fatal "rating saved locally" path.
// Replace the stub with a real implementation when the backend ships.

export type RateBookingPayload = {
  stars: number;             // 1-5
  comment?: string;
};

export async function rateBooking(
  token: string,
  bookingId: string,
  payload: RateBookingPayload,
): Promise<{ ok: boolean; statusCode: number }> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/rate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, statusCode: res.status };
}

// keep-looking: extends the stealth-search window by another 15 minutes
// when a booking is in 'pending_customer_action'. Server: POST
// /bookings/:id/keep-looking (added in service.go KeepLookingBooking).
export async function keepLookingBooking(
  token: string,
  bookingId: string,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/keep-looking`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'failed to extend search');
  }
}
