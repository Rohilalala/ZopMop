import { reportBackendDown } from '../hooks/useBackendHealth';
import { refreshAccessToken } from '../services/auth';

// Global callbacks registered by AuthProvider on mount. apiFetch reads
// the current access/refresh pair through these so it can attach the
// Bearer header AND silently rotate on 401 without coupling the client
// to the React context.

let _signOut: (() => void) | null = null;
let _getAccessToken: (() => string | null) | null = null;
let _getRefreshToken: (() => string | null) | null = null;
let _setTokens: ((access: string, refresh: string) => void) | null = null;

export function registerSignOutCallback(fn: () => void) {
  _signOut = fn;
}

export function registerTokenAccessors(opts: {
  getAccess: () => string | null;
  getRefresh: () => string | null;
  setTokens: (access: string, refresh: string) => void;
}) {
  _getAccessToken = opts.getAccess;
  _getRefreshToken = opts.getRefresh;
  _setTokens = opts.setTokens;
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

function generateRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function generateIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Refresh mutex: under burst load (e.g. dashboard mounts 5 requests
// in parallel) only one /refresh call should fire. The others wait
// on this promise then retry with the freshly-rotated access token.
let _refreshInFlight: Promise<string | null> | null = null;

async function attemptRefresh(): Promise<string | null> {
  if (_refreshInFlight) return _refreshInFlight;
  const refresh = _getRefreshToken?.() ?? null;
  if (!refresh) return null;
  _refreshInFlight = (async () => {
    try {
      const out = await refreshAccessToken(refresh);
      _setTokens?.(out.access_token, out.refresh_token);
      return out.access_token;
    } catch {
      return null;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

function withAuthHeader(
  headers: Record<string, string>,
  token: string | null,
): Record<string, string> {
  if (!token) return headers;
  // Don't clobber a caller-supplied Authorization (e.g. one-shot
  // bootstrap calls that pass a specific token).
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (hasAuth) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

/**
 * Drop-in replacement for fetch:
 *
 * 1. Attaches `Authorization: Bearer <accessToken>` automatically.
 * 2. On 401, tries /auth/refresh once. If refresh succeeds the
 *    original request is retried exactly once with the new access
 *    token. If it fails (or the second 401 still 401s), signs the
 *    user out globally.
 * 3. 10-second timeout per attempt; exponential backoff on 5xx.
 * 4. Attaches X-Request-ID + Idempotency-Key headers (audit D4-N4).
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const incoming = (options?.headers ?? {}) as Record<string, string>;
  const hasRequestId = Object.keys(incoming).some((k) => k.toLowerCase() === 'x-request-id');
  const hasIdempotencyKey = Object.keys(incoming).some((k) => k.toLowerCase() === 'idempotency-key');
  const baseHeaders: Record<string, string> = {
    ...incoming,
    ...(hasRequestId ? {} : { 'X-Request-ID': generateRequestId() }),
    ...(hasIdempotencyKey ? {} : { 'Idempotency-Key': generateIdempotencyKey() }),
  };

  let refreshed = false;
  let accessToken = _getAccessToken?.() ?? null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = withAuthHeader(baseHeaders, accessToken);
      const res = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      if (res.status === 401 && !refreshed) {
        // Try silent refresh once. Mutex inside attemptRefresh
        // collapses concurrent callers onto the same /refresh call.
        const fresh = await attemptRefresh();
        if (fresh) {
          accessToken = fresh;
          refreshed = true;
          // Retry the original request immediately (does not count
          // against the 5xx-retry budget).
          continue;
        }
        // Refresh failed → sign out globally.
        _signOut?.();
        return res;
      }

      if (res.status === 401) {
        // Already retried with a fresh token; second 401 means the
        // server still rejects us. Sign out.
        _signOut?.();
      }
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
      if (isTimeout) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    }
  }

  throw new Error('apiFetch: retry loop exited without a result');
}
