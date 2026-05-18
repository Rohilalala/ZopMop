import { BASE_URL } from '../api/config';

// HTTP client for the MSG91-backed /auth/* endpoints. Pure fetch, no
// auth headers — these endpoints are public. apiFetch is intentionally
// NOT used here to avoid the 401-interceptor recursing into /refresh.

export type UserType = 'customer' | 'pro';

export interface AuthUser {
  id: string;
  phone: string;
  name?: string;
  type: UserType;
  role: string; // back-compat with legacy nav gating
  has_accepted_privacy_policy: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface SendOTPResponse {
  message: string;
  is_new_user: boolean;
  // Dev-mode only. Echoed back when MSG91_DEV_MODE=true.
  otp?: string;
  note?: string;
}

export interface VerifyOTPResponse {
  access_token: string;
  refresh_token: string;
  /** Legacy mirror of access_token. Keep until all callers migrate. */
  token: string;
  user: AuthUser;
  is_new_user: boolean;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  token: string;
  user: AuthUser;
}

// Typed error subclass so screens can branch on .code instead of
// brittle message parsing. .retryAfter is the seconds value parsed
// from the Retry-After header (or the JSON body) for 429 responses.
export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const AUTH_TIMEOUT_MS = 12_000;

async function authFetch(path: string, body: Record<string, unknown>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJSON<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuthError('PARSE_ERROR', 'Unexpected response from server', res.status);
  }
}

function mapError(status: number, body: any): AuthError {
  const code: string = body?.code ?? 'UNKNOWN';
  const message: string =
    body?.error ??
    (status === 429 ? 'Too many attempts — please try again later'
      : status >= 500 ? 'Server unavailable — please try again'
        : 'Request failed');
  const retryAfter = typeof body?.retry_after === 'number' ? body.retry_after : undefined;
  return new AuthError(code, message, status, retryAfter);
}

/**
 * POST /auth/send-otp. Triggers an OTP for the given phone. Returns
 * is_new_user so the UI can render the privacy-policy checkbox on
 * the OTP screen. In dev mode the response also contains the
 * hardcoded OTP "9999" — the screen MAY autofill it.
 *
 * @throws AuthError on 4xx/5xx with .code:
 *   - OTP_RATE_LIMITED (429) — too many sends for this phone or IP
 *   - validation failure (422)
 *   - account suspended (403) — phone is a suspended pro
 */
export async function sendOTP(phone: string): Promise<SendOTPResponse> {
  const res = await authFetch('/auth/send-otp', { phone });
  const body = await parseJSON<any>(res);
  if (!res.ok) throw mapError(res.status, body);
  return body as SendOTPResponse;
}

/**
 * POST /auth/verify-otp. Verifies the user-supplied OTP, upserts the
 * user, and returns both tokens + the user view.
 *
 * @throws AuthError on:
 *   - INVALID_OTP (401) — code mismatched
 *   - OTP_RATE_LIMITED (429) — verify counter tripped
 *   - account suspended (403)
 */
export async function verifyOTP(
  phone: string,
  otp: string,
  hasAcceptedPrivacyPolicy = false,
): Promise<VerifyOTPResponse> {
  const res = await authFetch('/auth/verify-otp', {
    phone,
    otp,
    has_accepted_privacy_policy: hasAcceptedPrivacyPolicy,
  });
  const body = await parseJSON<any>(res);
  if (!res.ok) throw mapError(res.status, body);
  return body as VerifyOTPResponse;
}

/**
 * POST /auth/refresh. Rotates the refresh token: the prior plaintext
 * becomes single-use, a new pair is issued.
 *
 * @throws AuthError(REFRESH_INVALID, 401) when the supplied refresh
 *   token is unknown / revoked / expired. Caller should sign the
 *   user out and route to PhoneEntry.
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  const res = await authFetch('/auth/refresh', { refresh_token: refreshToken });
  const body = await parseJSON<any>(res);
  if (!res.ok) throw mapError(res.status, body);
  return body as RefreshResponse;
}

/**
 * POST /auth/logout. Revokes the refresh token server-side and
 * clears the HttpOnly auth cookie. Safe to call without a refresh
 * token (no-op revoke). Never throws — best-effort cleanup.
 */
export async function logout(accessToken: string | null, refreshToken: string | null): Promise<void> {
  try {
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refresh_token: refreshToken ?? '' }),
    });
  } catch {
    // ignore — best-effort
  }
}
