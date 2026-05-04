// Pro-side leave declaration API client. Mirrors the routes mounted by
// internal/leave/handler.go on /pro/leave. All endpoints require a JWT.

import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface LeaveBalance {
  balance: number;
  used: number;
  quota: number;
  reset_date: string; // ISO timestamp — first of next IST month
}

export interface LeaveRow {
  id: string;
  pro_id: string;
  date: string;        // ISO date
  declared_at: string; // ISO timestamp
  status: 'approved' | 'cancelled';
  source: 'pro' | 'admin';
  note?: string;
}

export interface AffectedBooking {
  ID: string;
  CustomerID: string;
  HelperID: string;
  TimeSlotID: string;
  ScheduledTime: string;
  ServiceCategoryID: string;
  ServiceName: string;
  CustomerName: string;
  Lat: number;
  Lng: number;
}

export interface ReassignOutcome {
  booking_id: string;
  new_pro_id?: string;
  cancelled: boolean;
  customer_name?: string;
  service_name?: string;
  scheduled_at?: string;
}

export interface DeclareResult {
  date: string;
  balance: LeaveBalance;
  reassigned_count: number;
  cancelled_count: number;
  outcomes: ReassignOutcome[];
}

export interface DeclareError {
  code: 'AFTER_CUTOFF' | 'BALANCE_EXHAUSTED' | 'NOT_TOMORROW' | 'ALREADY_DECLARED' | 'UNKNOWN';
  message: string;
}

/** GET /pro/leave/balance */
export async function getBalance(token: string): Promise<LeaveBalance> {
  const res = await apiFetch(`${BASE_URL}/pro/leave/balance`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load leave balance');
  return res.json();
}

/** GET /pro/leave/affected-tomorrow */
export async function getAffectedTomorrow(token: string): Promise<AffectedBooking[]> {
  const res = await apiFetch(`${BASE_URL}/pro/leave/affected-tomorrow`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load affected bookings');
  const body = await res.json();
  return body.bookings ?? [];
}

/** GET /pro/leave/history?limit= */
export async function getHistory(token: string, limit = 50): Promise<LeaveRow[]> {
  const res = await apiFetch(`${BASE_URL}/pro/leave/history?limit=${limit}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load leave history');
  const body = await res.json();
  return body.leaves ?? [];
}

/**
 * POST /pro/leave/declare — declares leave for a YYYY-MM-DD (must be tomorrow IST).
 * Throws a DeclareError-shaped object on a 4xx so the UI can branch on `code`.
 */
export async function declare(token: string, date: string): Promise<DeclareResult> {
  const res = await apiFetch(`${BASE_URL}/pro/leave/declare`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: DeclareError = {
      code: (body?.code as DeclareError['code']) ?? 'UNKNOWN',
      message: body?.error ?? 'Failed to declare leave',
    };
    throw err;
  }
  return body as DeclareResult;
}
