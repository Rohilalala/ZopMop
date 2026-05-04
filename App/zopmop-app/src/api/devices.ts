import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type RegisterDeviceBody = {
  fcm_token: string;
  platform: 'ios' | 'android' | 'web';
  device_id: string;
};

/**
 * Registers (or upserts) the caller's FCM token with the backend.
 * Backend dedupes on (user_id, device_id) so calling this on every token
 * refresh is safe — see App/api/v1/devices/register.
 */
export async function registerDevice(
  token: string,
  body: RegisterDeviceBody,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/devices/register`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`device register failed: ${res.status}`);
}
