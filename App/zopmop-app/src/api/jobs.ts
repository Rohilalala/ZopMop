// Pro-side job lifecycle client — wraps /api/v1/pro/jobs/* from
// backend Phase 10 Part A. Bearer auth attached by apiFetch.

import { apiFetch } from './client';
import { BASE_URL } from './config';
import type { HelperBooking } from './pro';

export interface JobServiceLine {
  id: string;
  booking_id: string;
  service_id: string;
  duration_minutes: number;
  price_paise: number;
  quantity: number;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  started_at?: string | null;
  completed_at?: string | null;
  display_order: number;
  skip_reason?: string | null;
}

export interface CompleteJobResponse {
  message: string;
  pro_earnings_paise: number;
  actual_duration_minutes: number;
}

async function expectOk<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let msg = `${what} failed`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) msg = String(body.error);
      if (body?.code) code = String(body.code);
    } catch { /* keep default */ }
    const err = new Error(msg) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function listActiveJobs(): Promise<HelperBooking[]> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/active`);
  const data = await expectOk<{ bookings: HelperBooking[] }>(res, 'list active jobs');
  return data.bookings ?? [];
}

export async function listPendingOffers(): Promise<string[]> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/pending`);
  const data = await expectOk<{ booking_ids: string[] }>(res, 'list pending offers');
  return data.booking_ids ?? [];
}

export async function acceptJob(bookingID: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/accept`, { method: 'POST' });
  await expectOk<{ message: string }>(res, 'accept job');
}

export async function declineJob(bookingID: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/decline`, { method: 'POST' });
  await expectOk<{ message: string }>(res, 'decline job');
}

export async function jobEnRoute(bookingID: string, lat?: number, lng?: number): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/en-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: lat ?? 0, lng: lng ?? 0 }),
  });
  await expectOk<{ message: string }>(res, 'mark en-route');
}

export async function jobArrived(bookingID: string, lat: number, lng: number): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/arrived`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng }),
  });
  await expectOk<{ message: string }>(res, 'mark arrived');
}

export async function jobStart(bookingID: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/start`, { method: 'POST' });
  await expectOk<{ message: string }>(res, 'start job');
}

export async function jobComplete(bookingID: string): Promise<CompleteJobResponse> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/complete`, { method: 'POST' });
  return expectOk<CompleteJobResponse>(res, 'complete job');
}

export async function startService(bookingID: string, serviceID: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/services/${serviceID}/start`, { method: 'POST' });
  await expectOk<{ message: string }>(res, 'start service');
}

export async function completeService(bookingID: string, serviceID: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/services/${serviceID}/complete`, { method: 'POST' });
  await expectOk<{ message: string }>(res, 'complete service');
}

export async function skipService(bookingID: string, serviceID: string, reason: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/services/${serviceID}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  await expectOk<{ message: string }>(res, 'skip service');
}

// Fetch a single booking detail. Reuses existing /bookings/:id which
// the customer endpoint also serves — backend gates by booking owner-
// ship OR assigned helper, so the pro can see their own booking.
export async function getJobDetail(bookingID: string): Promise<HelperBooking & {
  customer_id: string;
  en_route_at?: string | null;
  arrived_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  pro_earnings_paise?: number;
  actual_duration_minutes?: number;
  customer_rating_pending?: boolean;
}> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingID}`);
  return expectOk(res, 'get job detail');
}

export interface CustomerContact {
  customer_phone: string;
  customer_name: string;
}

/** POST /pro/jobs/:id/contact — reveal customer phone+name for dialing.
 *  Server enforces:
 *   - JWT must be the assigned helper (403 FORBIDDEN otherwise)
 *   - Booking status must be accepted | arrived | in_progress (409 INVALID_STATE)
 *  Each call inserts a pro_contact_reveals audit row server-side. */
export async function fetchCustomerContact(bookingID: string): Promise<CustomerContact> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/contact`, { method: 'POST' });
  return expectOk<CustomerContact>(res, 'reveal contact');
}

export async function listBookingServices(bookingID: string): Promise<JobServiceLine[]> {
  // Backend exposes services via /bookings/:id (richer schedule shape).
  // Re-using the existing endpoint avoids a new route. Parses out the
  // services array; falls back to empty if endpoint shape differs.
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingID}`);
  if (!res.ok) return [];
  try {
    const data = await res.json();
    const lines = (data?.services ?? data?.booking_services ?? []) as JobServiceLine[];
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}
