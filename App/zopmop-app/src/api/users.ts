import type { AuthUser } from '../context/AuthContext';
import { apiFetch, triggerSignOut } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';

export async function getMe(token: string): Promise<AuthUser> {
  const res = await apiFetch(`${BASE_URL}/me`, { headers: authHeaders(token) });
  if (res.status === 401 || res.status === 403) {
    triggerSignOut(); // auth invalid — force re-login
    throw new Error('Not authenticated');
  }
  if (res.status === 404) {
    // Don't sign out on 404: it could be a transient backend issue.
    // Surface a clear error and let the caller decide how to recover.
    throw new Error('User not found');
  }
  if (!res.ok) throw new Error('Failed to fetch profile');
  return validateShape<AuthUser>(await res.json(), ['id', 'phone', 'role']);
}

export async function updateMe(token: string, name: string): Promise<AuthUser> {
  const res = await apiFetch(`${BASE_URL}/me`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error('Failed to update profile');
  return validateShape<AuthUser>(await res.json(), ['id', 'phone', 'role']);
}

export async function updateFCMToken(token: string, fcmToken: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/me/fcm-token`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ fcm_token: fcmToken }),
  });
  if (!res.ok) throw new Error('Failed to update FCM token');
}

// UnpaidBookingsError is thrown when the server rejects a request because
// the customer has completed-but-unpaid Cashfree bookings. Carries the
// count and total amount so the screen can render a settle-pending-payments
// prompt with a "View Bookings" deep-link.
export class UnpaidBookingsError extends Error {
  readonly code = 'UNPAID_BOOKINGS' as const;
  readonly count: number;
  readonly totalPaise: number;
  constructor(count: number, totalPaise: number) {
    super(`You have ${count} unpaid booking(s) totaling ₹${(totalPaise / 100).toFixed(2)}`);
    this.name = 'UnpaidBookingsError';
    this.count = count;
    this.totalPaise = totalPaise;
  }
}

// Permanently deletes the caller's account. Required by App Store
// Guideline 5.1.1(v). The server soft-deletes the row and returns 200; the
// caller MUST clear local auth state after resolution.
//
// Throws UnpaidBookingsError when the server returns 409 UNPAID_BOOKINGS —
// callers should catch that branch and route the user to settle the
// outstanding bookings before retrying.
export async function deleteMe(token: string, reason?: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/me`, {
    method: 'DELETE',
    headers: authHeaders(token),
    body: JSON.stringify({ reason: reason ?? '' }),
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
    throw new Error(err.error ?? 'Failed to delete account');
  }
}
