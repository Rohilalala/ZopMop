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

/** Exponential backoff delays in ms — index = retry attempt (0,1,2). */
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

/**
 * Generate a short, unique-enough request ID for correlating client requests
 * with server logs. Not cryptographic — just collision-resistant per session.
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // Merge headers without dropping caller-supplied ones; add X-Request-ID
  // unless the caller already provided one. Computed once so all retries
  // share the same request ID for log correlation.
  const incoming = (options?.headers ?? {}) as Record<string, string>;
  const hasRequestId = Object.keys(incoming).some(
    (k) => k.toLowerCase() === 'x-request-id',
  );
  const headers: Record<string, string> = {
    ...incoming,
    ...(hasRequestId ? {} : { 'X-Request-ID': generateRequestId() }),
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      // Retry 5xx with exponential backoff; 4xx returns immediately.
      if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

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
      clearTimeout(timeoutId);
      const isTimeout = err?.name === 'AbortError';

      if (isTimeout && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      // Anything that prevented us from getting a response — DNS failure,
      // connection refused (server not running), socket reset, request timeout
      // — means we couldn't reach the backend. Flip the global health flag so
      // the BackendDownScreen renders immediately.
      reportBackendDown();
      if (isTimeout) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    }
  }

  // Unreachable: loop either returns a response or throws.
  throw new Error('apiFetch: retry loop exited without a result');
}
