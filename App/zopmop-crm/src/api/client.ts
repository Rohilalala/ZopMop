import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, useAuth } from '@/store/auth';
import { showToast } from '@/components/ui/Toast';

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
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
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
    try {
      const res = await axios.post(
        `${baseURL}/admin/auth/refresh`,
        {},
        { withCredentials: true },
      );
      const { access_token, expires_at, admin } = res.data;
      useAuth.getState().setSession(access_token, expires_at, admin);
      return access_token as string;
    } catch {
      useAuth.getState().clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
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

    // Surface non-401 errors as toasts. 401s are silent (handled above).
    if (status && status !== 401) {
      const msg = (error.response?.data as { error?: string } | undefined)?.error;
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
