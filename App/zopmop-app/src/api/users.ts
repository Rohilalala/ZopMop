import type { AuthUser } from '../context/AuthContext';
import { apiFetch, triggerSignOut } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';

export async function getMe(token: string): Promise<AuthUser> {
  const res = await apiFetch(`${BASE_URL}/me`, { headers: authHeaders(token) });
  if (res.status === 404) {
    triggerSignOut(); // user was deleted from the DB
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

// Permanently deletes the caller's account. Required by App Store
// Guideline 5.1.1(v). The server soft-deletes the row and returns 200; the
// caller MUST clear local auth state after resolution.
export async function deleteMe(token: string, reason?: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/me`, {
    method: 'DELETE',
    headers: authHeaders(token),
    body: JSON.stringify({ reason: reason ?? '' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to delete account');
  }
}
