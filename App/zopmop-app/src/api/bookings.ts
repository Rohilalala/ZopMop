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
  // Phase 1 Step 5b — lifecycle timestamps now serialised on the
  // GetCustomerBookings list payload. Used to derive the home
  // ActiveBookingPill (live-booking state machine: en_route ->
  // arrived -> in_progress) without a per-row detail round-trip.
  en_route_at?: string | null;
  arrived_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  // Phase 1 Step 5d — payment state. Backend already serialises these
  // on the Booking row; declared here for the end-of-service payment
  // screen + lock-rule UI gates.
  payment_status?: 'pending' | 'paid' | 'failed' | 'refunded' | null;
  payment_method?: 'cashfree' | 'wallet' | 'cash' | 'cod' | null;
  cash_collected_at?: string | null;
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
    throw new Error(err.error ?? 'Failed to create booking');
  }
  return validateShape<ApiBooking>(await res.json(), ['id', 'customer_id', 'status', 'price_paise', 'created_at']);
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

// ─────────────────────────────────────────────────────────────────────
// Phase 1 Step 5d.2 — end-of-service payment client + error taxonomy.
//
// The error codes here are the wire-level strings the backend's typed
// errors get mapped to (see internal/booking/handler.go mapOTPGateError
// + internal/payments/handler.go createCashfreeOrderForBooking). The UI
// in EndOfServicePaymentScreen branches on these to drive the lock-rule
// + State-5 retry behaviour. Stable strings — do not rename without a
// backend change.
// ─────────────────────────────────────────────────────────────────────

/**
 * Error codes the backend's ResolveCash handler can return.
 *
 * - BOOKING_NOT_FOUND          404 — booking missing or wrong customer
 * - NO_HELPER_ASSIGNED         409 — no pro on the booking yet
 * - JOB_NOT_IN_STATE           409 — booking not status='in_progress'
 * - ALREADY_PAID_ONLINE        409 — payment_status already 'paid'
 *                                   (Cashfree webhook or wallet path
 *                                   has already settled)
 * - ONLINE_PAYMENT_PENDING     409 — recent Cashfree order still
 *                                   'pending' within 2-min freshness
 *                                   guard. State-5 fallback path will
 *                                   retry on this code (5d.2.d).
 * - OTP_SERVICE_UNAVAILABLE    503 — backend misconfig
 */
export type ResolveCashErrorCode =
  | 'BOOKING_NOT_FOUND'
  | 'NO_HELPER_ASSIGNED'
  | 'JOB_NOT_IN_STATE'
  | 'ALREADY_PAID_ONLINE'
  | 'ONLINE_PAYMENT_PENDING'
  | 'OTP_SERVICE_UNAVAILABLE';

/**
 * Error codes the backend's CreateCashfreeOrder handler can return that
 * matter to the end-of-service payment UI. The Phase 1 guard
 * (chargeability.go) adds the first three; the rest pre-date Phase 1.
 *
 * - already_paid_online        409 — chargeability guard
 * - already_paid_cash          409 — chargeability guard
 * - booking_refunded           409 — chargeability guard; admin re-collect
 * - already_paid               409 — legacy ledger-side success guard
 * - already_completed          409
 * - booking_cancelled          410
 * - bad_status                 409
 * - booking_not_found          404
 * - not_owner                  403
 * - zero_amount                409
 * - missing_booking_id         400
 * - bad_payment_source         400
 * - gateway_unconfigured       503
 * - unauthenticated            401
 * - internal                   500
 */
export type CreateCashfreeOrderErrorCode =
  | 'already_paid_online'
  | 'already_paid_cash'
  | 'booking_refunded'
  | 'already_paid'
  | 'already_completed'
  | 'booking_cancelled'
  | 'bad_status'
  | 'booking_not_found'
  | 'not_owner'
  | 'zero_amount'
  | 'missing_booking_id'
  | 'bad_payment_source'
  | 'gateway_unconfigured'
  | 'unauthenticated'
  | 'internal';

/**
 * Error thrown by resolveCash() — carries the backend's error code so
 * EndOfServicePaymentScreen can branch on ResolveCashErrorCode without
 * parsing prose. Mirrors the cancelBooking / jobStart error pattern.
 */
export class ResolveCashError extends Error {
  readonly code: ResolveCashErrorCode | undefined;
  readonly status: number;
  constructor(message: string, status: number, code?: ResolveCashErrorCode) {
    super(message);
    this.name = 'ResolveCashError';
    this.code = code;
    this.status = status;
  }
}

export interface ResolveCashResponse {
  message: string;
}

/**
 * POST /bookings/:id/resolve-cash
 *
 * Phase 1 Step 3 cash entry point. Backend stamps
 * cash_collected_by_pro = helper_id at the moment of resolve,
 * cash_collected_at = NOW(), then issues the End OTP via the same path
 * the Cashfree webhook uses.
 *
 * Idempotent on repeat tap: a second call against a booking that
 * already carries cash_collected_at returns 200 success and re-issues
 * the End OTP only if the customer's outstanding code expired (the
 * Peek-then-Issue contract from docs/phase-1-payment-gated-flow.md).
 *
 * Throws ResolveCashError with .code set to one of ResolveCashErrorCode
 * on any 4xx/5xx; throws plain Error on network failure.
 */
export async function resolveCash(
  token: string,
  bookingId: string,
): Promise<ResolveCashResponse> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/resolve-cash`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new ResolveCashError(
      body.error ?? 'cash resolve failed',
      res.status,
      body.code as ResolveCashErrorCode | undefined,
    );
  }
  return (await res.json()) as ResolveCashResponse;
}
