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

/**
 * Generate an idempotency key sent as the Idempotency-Key header on every
 * apiFetch request (audit D4-N4). The server middleware
 * (internal/middleware/idempotency.go) namespaces by user_id and uses SETNX
 * to dedup — collision-resistance only needs to hold per-(user, 10-min
 * window), not cryptographically. Same homegrown shape as
 * generateRequestId, with extra entropy for the longer dedup window.
 */
function generateIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
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
  // and Idempotency-Key unless the caller already provided them. Computed
  // once so all retries share the same values — the server-side dedup at
  // internal/middleware/idempotency.go relies on retried POSTs reusing the
  // same Idempotency-Key (audit D4-N4).
  const incoming = (options?.headers ?? {}) as Record<string, string>;
  const hasRequestId = Object.keys(incoming).some(
    (k) => k.toLowerCase() === 'x-request-id',
  );
  const hasIdempotencyKey = Object.keys(incoming).some(
    (k) => k.toLowerCase() === 'idempotency-key',
  );
  const headers: Record<string, string> = {
    ...incoming,
    ...(hasRequestId ? {} : { 'X-Request-ID': generateRequestId() }),
    ...(hasIdempotencyKey ? {} : { 'Idempotency-Key': generateIdempotencyKey() }),
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

      // Don't flip the global "backend down" flag from here. Pro-side
      // endpoints can be slow (location PUTs, status toggles, instant-match
      // polling) and a single timeout shouldn't blank the entire UI with the
      // dead-Zop screen. The /health poller in useBackendHealth runs every
      // 5s while down and will catch real outages on its own. Network-error
      // surfacing remains the caller's responsibility via thrown errors.
      if (isTimeout) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    }
  }

  // Unreachable: loop either returns a response or throws.
  throw new Error('apiFetch: retry loop exited without a result');
}
