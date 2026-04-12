import { Platform } from 'react-native';

let _rawUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

// Android emulator cannot reach LAN IPs directly — remap to the emulator's
// alias for the host machine (10.0.2.2) so both iOS and Android work from
// the same .env without manual changes.
if (__DEV__ && Platform.OS === 'android') {
  _rawUrl = _rawUrl.replace(/http:\/\/(?!10\.0\.2\.2|localhost)[\d.]+/, 'http://10.0.2.2');
}

// Security: Reject plaintext HTTP in production builds to prevent MITM attacks.
// All API traffic must be encrypted with TLS in production.
if (!__DEV__ && _rawUrl.startsWith('http://')) {
  throw new Error(
    '[Security] EXPO_PUBLIC_API_URL must use HTTPS in production. ' +
    'Set EXPO_PUBLIC_API_URL to an https:// URL before building a release.',
  );
}

// Development warning: alert developers when running over plaintext HTTP.
if (__DEV__ && _rawUrl.startsWith('http://')) {
  console.warn(
    '[Security Warning] API traffic is using plaintext HTTP. ' +
    'Switch EXPO_PUBLIC_API_URL to an https:// URL before releasing to production.',
  );
}

export const BASE_URL = _rawUrl;

/**
 * Validates that a parsed API response object contains all required keys.
 * Throws if any required key is missing or null/undefined, preventing the app
 * from silently consuming attacker-crafted or malformed backend responses.
 *
 * Usage: const data = validateShape(await res.json(), ['id', 'token', 'role']);
 */
export function validateShape<T extends object>(
  data: unknown,
  requiredKeys: (keyof T)[],
): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid response: expected an object');
  }
  for (const key of requiredKeys) {
    if ((data as Record<string, unknown>)[key as string] == null) {
      throw new Error(`Invalid response: missing required field "${String(key)}"`);
    }
  }
  return data as T;
}

/** authHeaders helper — centralised here to avoid duplication across API modules. */
export function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
