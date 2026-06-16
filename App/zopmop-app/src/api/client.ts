import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { reportBackendDown } from '../hooks/useBackendHealth';
import { refreshAccessToken } from '../services/auth';

/** Installed app version + platform, sent on every request so the backend can
 *  enforce its min-version policy (force-update). Resolved once at module load. */
export const CLIENT_VERSION = (Constants.expoConfig?.version as string | undefined) ?? '0.0.0';
export const CLIENT_PLATFORM = Platform.OS; // 'ios' | 'android'

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

// Force-update hook. Registered by the app root; apiFetch calls it when any
// request returns 426 Upgrade Required (a forced version policy), so a
// force-update takes effect mid-session, not just at launch.
export type ForceUpdateInfo = { message?: string; store_url?: string; min_version?: string };
let _onForceUpdate: ((info: ForceUpdateInfo) => void) | null = null;
export function registerForceUpdateCallback(fn: (info: ForceUpdateInfo) => void) {
  _onForceUpdate = fn;
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
type RefreshOutcome = {
  token: string | null;
  /** True only when /auth/refresh authoritatively rejected the token
   *  (401/403 — unknown / revoked / expired). 429s, 5xx and network
   *  errors are NOT auth failures: signing out on those logged users
   *  out whenever a refresh raced a backend restart or tripped the
   *  per-IP rate limiter (the "makes me log in again" bug). */
  authFailure: boolean;
};
let _refreshInFlight: Promise<RefreshOutcome> | null = null;

async function attemptRefresh(): Promise<RefreshOutcome> {
  if (_refreshInFlight) return _refreshInFlight;
  const refresh = _getRefreshToken?.() ?? null;
  // No refresh token stored — authoritative: nothing to rotate with.
  if (!refresh) return { token: null, authFailure: true };
  _refreshInFlight = (async () => {
    try {
      const out = await refreshAccessToken(refresh);
      _setTokens?.(out.access_token, out.refresh_token);
      return { token: out.access_token, authFailure: false };
    } catch (e) {
      const status = (e as { status?: number })?.status;
      return { token: null, authFailure: status === 401 || status === 403 };
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
  const hasClientVersion = Object.keys(incoming).some((k) => k.toLowerCase() === 'x-client-version');
  const baseHeaders: Record<string, string> = {
    ...incoming,
    ...(hasRequestId ? {} : { 'X-Request-ID': generateRequestId() }),
    ...(hasIdempotencyKey ? {} : { 'Idempotency-Key': generateIdempotencyKey() }),
    // Version/platform on every request so the backend force-update gate can
    // 426 a stale build. Don't clobber a caller that set its own version header.
    ...(hasClientVersion ? {} : { 'X-Client-Version': CLIENT_VERSION }),
    'X-Client-Platform': CLIENT_PLATFORM,
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

      // 426 Upgrade Required — a forced version policy. Surface the update
      // screen and return; never retry (the build can't satisfy it).
      if (res.status === 426) {
        try {
          const info = await res.clone().json();
          _onForceUpdate?.({ message: info?.message, store_url: info?.store_url, min_version: info?.min_version });
        } catch {
          _onForceUpdate?.({});
        }
        return res;
      }

      if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      if (res.status === 401 && !refreshed) {
        // Try silent refresh once. Mutex inside attemptRefresh
        // collapses concurrent callers onto the same /refresh call.
        const outcome = await attemptRefresh();
        if (outcome.token) {
          accessToken = outcome.token;
          refreshed = true;
          // Strip any caller-supplied Authorization header (the
          // authHeaders(token) pattern ~19 api modules use) so the
          // retry goes out with the freshly rotated token. Leaving it
          // in place made withAuthHeader keep the expired token →
          // guaranteed second 401 → global sign-out roughly daily.
          for (const k of Object.keys(baseHeaders)) {
            if (k.toLowerCase() === 'authorization') delete baseHeaders[k];
          }
          // Retry the original request immediately (does not count
          // against the 5xx-retry budget).
          continue;
        }
        // Sign out ONLY when the server authoritatively rejected the
        // refresh token. A 429 / 5xx / network blip during refresh is
        // transient — keep the session; the next request retries.
        if (outcome.authFailure) _signOut?.();
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
