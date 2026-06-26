// Pro-side shift system client — wraps /api/v1/pro/* endpoints from
// backend Phase 7 Part A. Auth is attached by apiFetch automatically.

import { apiFetch } from './client';
import { BASE_URL } from './config';

export interface Commitment {
  id: string;
  pro_id: string;
  shift_date: string;  // YYYY-MM-DD
  start_time: string;  // HH:MM
  end_time: string;    // HH:MM
  status: string;
  locked_at?: string | null;
  online_started_at?: string | null;
  online_ended_at?: string | null;
  late_show: boolean;
}

export interface Session {
  id: string;
  commitment_id: string;
  online_at: string;
  offline_at?: string | null;
  online_minutes?: number | null;
  job_minutes: number;
  location_verified_at_start: boolean;
  manual_approval_used: boolean;
}

export interface ActiveShiftResponse {
  session: Session | null;
  commitment: Commitment | null;
}

export interface GoOnlineResult {
  session_id?: string;
  location_ok: boolean;
  requires_manual_approval: boolean;
  distance_meters?: number;
  // A zone-approval request is already queued — route to the waiting
  // state instead of asking for another selfie (resubmit 409s).
  approval_pending?: boolean;
}

export interface FortnightProgress {
  fortnight_start: string;
  fortnight_end: string;
  online_minutes: number;
  target_minutes: number;
  overtime_minutes: number;
  job_minutes: number;
  online_pay_paise: number;
  overtime_pay_paise: number;
  job_pay_paise: number;
  /** Split deductions — render as separate lines in the Money tab. */
  absence_deductions_paise: number;
  cancellation_deductions_paise: number;
  /** Sum of the two split fields. Kept for backwards-compat — prefer
   *  `total_deductions_paise` in new code. */
  deductions_paise: number;
  total_deductions_paise: number;
  projected_pay_paise: number;
  cancellation_count_30d: number;
  leave_balance: number;
}

export interface CancelBookingResult {
  cancellation_index_30d: number;
  penalty_applied: boolean;
  penalty_amount_paise: number;
}

async function expectOk<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let msg = `${what} failed`;
    try {
      const body = await res.json();
      if (body?.error) msg = String(body.error);
    } catch { /* keep default */ }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function listCommitments(): Promise<Commitment[]> {
  const res = await apiFetch(`${BASE_URL}/pro/commitments`);
  const data = await expectOk<{ commitments: Commitment[] }>(res, 'list commitments');
  return data.commitments ?? [];
}

export async function createCommitment(req: {
  shift_date: string;
  start_time: string;
  end_time: string;
}): Promise<Commitment> {
  const res = await apiFetch(`${BASE_URL}/pro/commitments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return expectOk<Commitment>(res, 'create commitment');
}

export async function deleteCommitment(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/commitments/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = new Error('delete commitment failed') as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

export async function goOnline(commitmentID: string, lat: number, lng: number, selfie: string): Promise<GoOnlineResult> {
  const res = await apiFetch(`${BASE_URL}/pro/shifts/${commitmentID}/go-online`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, selfie }),
  });
  return expectOk<GoOnlineResult>(res, 'go online');
}

export async function goOffline(commitmentID: string, selfie: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/shifts/${commitmentID}/go-offline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selfie }),
  });
  if (!res.ok) {
    const err = new Error('go offline failed') as Error & { status?: number };
    err.status = res.status;
    try {
      const body = await res.json();
      if (body?.error) err.message = String(body.error);
    } catch { /* keep default */ }
    throw err;
  }
}

export async function requestZoneApproval(commitmentID: string, body: {
  lat: number;
  lng: number;
  photo_url: string;
}): Promise<{ request_id: string; status: string }> {
  const res = await apiFetch(`${BASE_URL}/pro/shifts/${commitmentID}/zone-approval-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return expectOk<{ request_id: string; status: string }>(res, 'request zone approval');
}

export async function getActiveShift(): Promise<ActiveShiftResponse> {
  const res = await apiFetch(`${BASE_URL}/pro/shifts/active`);
  return expectOk<ActiveShiftResponse>(res, 'get active shift');
}

export async function getFortnightProgress(): Promise<FortnightProgress> {
  const res = await apiFetch(`${BASE_URL}/pro/fortnight/progress`);
  return expectOk<FortnightProgress>(res, 'fortnight progress');
}

export interface ZoneInfo {
  id: string;
  name: string;
  lat: number;
  lng: number;
  shift_radius_km: number;
}

export async function getCurrentZone(): Promise<ZoneInfo | null> {
  const res = await apiFetch(`${BASE_URL}/pro/zone`);
  const data = await expectOk<{ zone: ZoneInfo | null }>(res, 'get zone');
  return data.zone ?? null;
}

export async function cancelProBooking(bookingID: string, reason?: string): Promise<CancelBookingResult> {
  const res = await apiFetch(`${BASE_URL}/pro/bookings/${bookingID}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason ?? '' }),
  });
  return expectOk<CancelBookingResult>(res, 'cancel booking');
}
