import { apiFetch } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';
import { UnpaidBookingsError } from './users';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchedHelper {
  id: string;
  name: string;
  phone: string;
  rating: number;
  eta_minutes: number;
  lat?: number;
  lng?: number;
  photo_url?: string;
  total_jobs?: number;
}

export interface MatchStatusResponse {
  status: 'searching' | 'matched' | 'failed';
  helper?: MatchedHelper;
  /** Underlying booking lifecycle status when known (pending/accepted/in_progress/completed/cancelled). */
  booking_status?: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  /** True once the assigned pro tapped "I've Arrived" at the customer's door. */
  arrived?: boolean;
}

export interface InstantBookingPayload {
  address_id: string;
}

export interface InstantBooking {
  id: string;
  customer_id: string;
  status: string;
  price_cents: number;
  created_at: string;
}

export interface HelperInvite {
  booking_id: string;
}

export interface HelperInviteDetail {
  booking_id: string;
  customer_name: string;
  address: string;
  lat: number;
  lng: number;
  services: string[];
  total_minutes: number;
  price_cents: number;
  created_at: string;
}

// ── Instant Booking (Customer) ────────────────────────────────────────────────

/**
 * POST /bookings — creates an instant booking using the cart contents.
 * Returns the booking ID; the mobile client then polls /bookings/:id/match-status.
 */
export async function createInstantBooking(
  token: string,
  serviceCategoryId: string,
  address: string,
  lat: number,
  lng: number,
): Promise<InstantBooking> {
  const res = await apiFetch(`${BASE_URL}/bookings`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      service_category_id: serviceCategoryId,
      address,
      lat,
      lng,
    }),
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
    throw new Error(err.error ?? 'Failed to create instant booking');
  }
  return validateShape<InstantBooking>(await res.json(), ['id', 'customer_id', 'status', 'price_cents', 'created_at']);
}

/**
 * GET /bookings/:id/match-status — polls for who has been matched to a booking.
 * Returns { status: "searching" | "matched" | "failed", helper? }
 */
export async function getMatchStatus(
  token: string,
  bookingId: string,
): Promise<MatchStatusResponse> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/match-status`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to get match status');
  }
  return validateShape<MatchStatusResponse>(await res.json(), ['status']);
}

// ── Pro (Helper) APIs ─────────────────────────────────────────────────────────

/**
 * GET /bookings/helper/invites — gets the list of booking IDs this helper has been matched to.
 * Pros poll this endpoint to discover available jobs.
 */
export async function getHelperInvites(token: string): Promise<string[]> {
  const res = await apiFetch(`${BASE_URL}/bookings/helper/invites`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to fetch invites');
  const data = await res.json();
  if (!Array.isArray(data.booking_ids)) throw new Error('Invalid response: booking_ids is not an array');
  return data.booking_ids as string[];
}

/**
 * GET /helpers/me/invites — gets full invite details (address, lat, lng, services, etc.)
 * for all pending bookings this helper has been matched to.
 * Use this instead of getHelperInvites + getBookingDetails to avoid IDOR failures
 * on pending bookings where helper_id is still NULL.
 */
export async function getHelperInvitesWithDetails(token: string): Promise<HelperInviteDetail[]> {
  const res = await apiFetch(`${BASE_URL}/helpers/me/invites`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to fetch invites');
  const data = await res.json();
  if (!Array.isArray(data.invites ?? [])) throw new Error('Invalid response: invites is not an array');
  return (data.invites ?? []).map((inv: unknown) =>
    validateShape<HelperInviteDetail>(inv, ['booking_id', 'address', 'lat', 'lng', 'price_cents']),
  );
}

/**
 * GET /bookings/:id — gets a specific booking's full details (including customer address).
 */
export async function getBookingDetails(token: string, bookingId: string): Promise<HelperInviteDetail> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to get booking details');
  return validateShape<HelperInviteDetail>(await res.json(), ['booking_id', 'address', 'lat', 'lng', 'price_cents']);
}

/**
 * POST /bookings/:id/accept — pro accepts the booking.
 */
export async function acceptBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/accept`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to accept booking');
  }
}

// ── Tracking (both sides) ─────────────────────────────────────────────────────

export interface TrackingResponse {
  helper_lat: number;
  helper_lng: number;
  customer_lat: number;
  customer_lng: number;
  eta_minutes: number;
  polyline: string;
  last_updated_at: string;
}

/**
 * GET /bookings/:id/tracking — returns helper live location, ETA and route polyline.
 * Both customer and helper can call this while status is accepted/in_progress.
 */
export async function getBookingTracking(
  token: string,
  bookingId: string,
): Promise<TrackingResponse> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/tracking`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to get tracking');
  }
  return validateShape<TrackingResponse>(await res.json(), ['helper_lat', 'helper_lng', 'customer_lat', 'customer_lng', 'eta_minutes']);
}

/**
 * POST /bookings/:id/arrived — helper marks they've reached the customer's door.
 * Status stays "accepted"; sets arrived_at and surfaces "Pro's at your door"
 * on the customer's BookingConfirmed screen.
 */
export async function arrivedBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/arrived`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to mark arrived');
  }
}

/**
 * POST /bookings/:id/start — helper starts the actual service (accepted → in_progress).
 */
export async function startBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/start`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to start booking');
  }
}

/**
 * POST /bookings/:id/complete — helper marks service done (in_progress → completed).
 */
export async function completeBooking(token: string, bookingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/complete`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to complete booking');
  }
}

/**
 * Returns the WebSocket URL for Pro location streaming.
 * The token is intentionally NOT included in the URL to avoid it appearing in
 * server access logs, proxy logs, or browser history.
 * The caller must send {"type":"auth","token":"..."} as the first WebSocket message.
 *
 * Security: BASE_URL.replace(/^http/, 'ws') maps:
 *   http://  → ws://   (plaintext — only permitted in local dev)
 *   https:// → wss://  (TLS — required for production)
 * The EXPO_PUBLIC_API_URL HTTPS check in config.ts throws in production builds,
 * so a release binary will never reach this point with an http:// base URL.
 */
export function getLocationWsUrl(): string {
  if (!__DEV__ && BASE_URL.startsWith('http://')) {
    throw new Error('[Security] WebSocket URL would use unencrypted ws:// in production. Set EXPO_PUBLIC_API_URL to an https:// URL.');
  }
  const base = BASE_URL.replace(/^http/, 'ws');
  return `${base}/location/ws`;
}

/**
 * Returns the WebSocket URL for customer-side tracking push.
 * Server pushes a TrackingResponse JSON every ~5s on this socket; replaces
 * the previous setInterval poll on /bookings/:id/tracking. Same auth model
 * as getLocationWsUrl: no token in the URL — the client sends
 * {"type":"auth","token":"<JWT>"} as the first WebSocket message.
 */
export function getBookingTrackingWsUrl(bookingId: string): string {
  if (!__DEV__ && BASE_URL.startsWith('http://')) {
    throw new Error('[Security] WebSocket URL would use unencrypted ws:// in production. Set EXPO_PUBLIC_API_URL to an https:// URL.');
  }
  const base = BASE_URL.replace(/^http/, 'ws');
  return `${base}/bookings/${bookingId}/track/ws`;
}

/**
 * GET /location/helper/:id — gets current GPS coords of a helper.
 */
export async function getHelperLocation(
  token: string,
  helperId: string,
): Promise<{ lat: number; lng: number }> {
  const res = await apiFetch(`${BASE_URL}/location/helper/${helperId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Location not available');
  return validateShape<{ lat: number; lng: number }>(await res.json(), ['lat', 'lng']);
}
