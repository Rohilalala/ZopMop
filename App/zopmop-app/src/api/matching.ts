import { apiFetch } from './client';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchedHelper {
  id: string;
  name: string;
  phone: string;
  rating: number;
  eta_minutes: number;
  lat?: number;
  lng?: number;
}

export interface MatchStatusResponse {
  status: 'searching' | 'matched' | 'failed';
  helper?: MatchedHelper;
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
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to create instant booking');
  }
  return res.json() as Promise<InstantBooking>;
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
  return res.json() as Promise<MatchStatusResponse>;
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
  return (data.invites ?? []) as HelperInviteDetail[];
}

/**
 * GET /bookings/:id — gets a specific booking's full details (including customer address).
 */
export async function getBookingDetails(token: string, bookingId: string) {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to get booking details');
  return res.json();
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
  return res.json() as Promise<TrackingResponse>;
}

/**
 * POST /bookings/:id/start — helper marks arrival (accepted → in_progress).
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
 * POST /location/ws — WebSocket URL for Pro to stream GPS location.
 * Returns the full ws:// URL.
 */
export function getLocationWsUrl(token: string): string {
  const base = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1')
    .replace(/^http/, 'ws');
  return `${base}/location/ws?token=${encodeURIComponent(token)}`;
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
  return res.json();
}
