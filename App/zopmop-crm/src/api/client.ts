import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, useAuth } from '@/store/auth';
import { showToast } from '@/components/ui/Toast';

// Refresh the access token only when it is within this many ms of expiry.
// Proactive (request-time) refresh keeps us off the 401 path during normal
// navigation, so we never burst the backend refresh limiter.
const REFRESH_SKEW_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Base URL for the CRM API. In dev, vite proxies /admin → localhost:8090, so
// we hit `/admin/...` on the same origin. In prod, set VITE_CRM_API_URL.
const baseURL = import.meta.env.VITE_CRM_API_URL ?? '';

export const api = axios.create({
  baseURL,
  withCredentials: true, // refresh-token cookie is HttpOnly + Secure + SameSite=Strict
  timeout: 20_000,
});

// Attach the access token if we have one. Skip the auth endpoints — they
// either don't need a token (login/totp/refresh/logout) or are explicitly
// authed by the request flow itself.
api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  // Refresh proactively if near expiry — but never for the auth endpoints
  // themselves (login/refresh/logout would recurse / don't carry a token).
  if (!(config.url ?? '').includes('/admin/auth/')) {
    await ensureFreshToken();
  }
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// Silent refresh on 401. Single-flight: concurrent 401s share one /refresh
// call so we don't race the cookie rotation.
let refreshInFlight: Promise<string | null> | null = null;

async function silentRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    // Up to 4 attempts. 429 (rate-limited) and transient network/5xx errors
    // are retried with exponential backoff and NEVER clear the session — a
    // throttled refresh must not evict an authenticated user. Only a
    // definitive auth failure (401/403 = refresh cookie invalid/expired)
    // clears the session and sends the SPA to /login.
    const backoffMs = [2_000, 4_000, 8_000];
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await axios.post(
            `${baseURL}/admin/auth/refresh`,
            {},
            { withCredentials: true },
          );
          const { access_token, expires_at, admin } = res.data;
          useAuth.getState().setSession(access_token, expires_at, admin);
          return access_token as string;
        } catch (err) {
          const status = (err as AxiosError).response?.status;
          if (status === 401 || status === 403) {
            useAuth.getState().clear();
            return null;
          }
          // 429 / 5xx / network: retry with backoff, keep session intact.
          if (attempt < backoffMs.length) {
            await sleep(backoffMs[attempt]);
            continue;
          }
          return null; // exhausted retries — stay logged in, caller fails soft
        }
      }
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// Proactively mint a fresh token when the current one is missing or within
// REFRESH_SKEW_MS of expiry. Single-flight (silentRefresh dedupes), gated on
// expiry so it does NOT fire on every request or every route change.
async function ensureFreshToken(): Promise<void> {
  const { accessToken, expiresAt } = useAuth.getState();
  if (!accessToken || expiresAt == null) return; // bootstrap/login handle this
  if (Date.now() < expiresAt - REFRESH_SKEW_MS) return; // still fresh
  await silentRefresh();
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const url = original?.url ?? '';
    const isAuthEndpoint = url.includes('/admin/auth/');
    const status = error.response?.status;

    if (status === 401 && !original?._retry && !isAuthEndpoint) {
      original._retry = true;
      const newToken = await silentRefresh();
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers['Authorization'] = `Bearer ${newToken}`;
        return api(original);
      }
    }

    // RBAC denial — surface a precise message and skip the generic toast.
    const data = error.response?.data as
      | { error?: string; required_role?: string; your_role?: string; message?: string }
      | undefined;
    if (status === 403 && data?.error === 'insufficient_permissions') {
      const required = data.required_role ?? 'higher role';
      const yours = data.your_role ?? 'unknown';
      showToast({
        kind: 'error',
        message: `Insufficient permissions. Requires ${required}; you are ${yours}.`,
      });
      return Promise.reject(error);
    }

    // Gateway/upstream errors (5xx with a `message` payload) — let callers
    // render a domain-specific toast (e.g. "Gateway refund failed: …"), so
    // skip the generic one. Detected by the `gateway_error` discriminator.
    if (status && status >= 500 && data?.error === 'gateway_error') {
      return Promise.reject(error);
    }

    // Surface non-401 errors as toasts. 401s are silent (handled above).
    if (status && status !== 401) {
      const msg = data?.message ?? data?.error;
      showToast({ kind: 'error', message: msg ?? `Request failed (${status})` });
    }

    return Promise.reject(error);
  },
);

// Convenience: bootstrap the auth state on app load. Tries to refresh once.
// If the refresh succeeds, we know who the user is. Otherwise the app will
// route them to /login.
export async function bootstrapAuth(): Promise<void> {
  await silentRefresh();
  useAuth.getState().setReady();
}
