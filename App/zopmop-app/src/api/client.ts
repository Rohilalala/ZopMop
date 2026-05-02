import { reportBackendDown } from '../hooks/useBackendHealth';

// Global signOut callback registered by AuthProvider on mount.
let _signOut: (() => void) | null = null;

export function registerSignOutCallback(fn: () => void) {
  _signOut = fn;
}

/** Call this to trigger a global sign-out (e.g. user deleted from DB). */
export function triggerSignOut() {
  _signOut?.();
}

/** Default network timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Generate a short, unique-enough request ID for correlating client requests
 * with server logs. Not cryptographic — just collision-resistant per session.
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Drop-in replacement for fetch with three security/observability enhancements:
 *
 * 1. Auto-signs-out on 401 (expired / invalid token).
 * 2. Enforces a 10-second timeout via AbortController to prevent:
 *    - Slow-loris style attacks that hang the UI indefinitely.
 *    - Resource exhaustion from piled-up unresolved promises.
 * 3. Attaches a per-request `X-Request-ID` header so the backend can correlate
 *    logs end-to-end with a specific client call.
 *
 * Use this for ALL API calls instead of raw fetch().
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Merge headers without dropping caller-supplied ones; add X-Request-ID
  // unless the caller already provided one.
  const incoming = (options?.headers ?? {}) as Record<string, string>;
  const hasRequestId = Object.keys(incoming).some(
    (k) => k.toLowerCase() === 'x-request-id',
  );
  const headers: Record<string, string> = {
    ...incoming,
    ...(hasRequestId ? {} : { 'X-Request-ID': generateRequestId() }),
  };

  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (res.status === 401) {
      _signOut?.();
    }
    // 5xx → backend reachable but unhealthy. Surface as "down" so user sees
    // the dead-Zop screen instead of getting stuck on opaque request failures.
    if (res.status >= 500) {
      reportBackendDown();
    }
    return res;
  } catch (err: any) {
    // Anything that prevented us from getting a response — DNS failure,
    // connection refused (server not running), socket reset, request timeout
    // — means we couldn't reach the backend. Flip the global health flag so
    // the BackendDownScreen renders immediately.
    reportBackendDown();
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
