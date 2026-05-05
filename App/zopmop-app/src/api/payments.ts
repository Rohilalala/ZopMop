import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface ValidateVpaResult {
  vpa: string;
  valid: boolean;
  customer_name?: string;
  error?: string;
}

export async function validateVpa(token: string, vpa: string): Promise<ValidateVpaResult> {
  const res = await apiFetch(`${BASE_URL}/payments/validate-vpa`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ vpa }),
  });
  if (res.status === 503) {
    throw new Error('VPA validation is not configured on the server.');
  }
  if (!res.ok) {
    throw new Error('VPA validation failed.');
  }
  return res.json() as Promise<ValidateVpaResult>;
}

// ────────────────────────────────────────────────────────────────────────
// Cashfree PG (collection) — distinct product from Cashfree Payouts above.
// ────────────────────────────────────────────────────────────────────────

/** Response from POST /payments/cashfree/order. payment_session_id feeds
 *  the Cashfree Drop Checkout SDK; order_id is our merchant id (zop-<paymentID>). */
export type CashfreeOrderResponse = {
  payment_session_id: string;
  order_id: string;
  amount_paise: number;
  expires_at: string;
};

/** Status snapshot of an existing Cashfree order. Mirrors backend
 *  payments.gateway_status enum (pending|success|failed|refunded). */
export type CashfreeOrderStatus = {
  status: 'pending' | 'success' | 'failed' | 'refunded';
  amount_paise: number;
  paid_at?: string;
};

/** Structured error surface for the order endpoint — backend returns
 *  {error, code} on every 4xx/5xx (Phase 4 contract from househelp-api). */
export class CashfreeOrderError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CashfreeOrderError';
    this.status = status;
    this.code = code;
  }
}

/**
 * POST /payments/cashfree/order
 *
 * Two payment_source modes:
 *   - "direct"       — funds an existing booking. booking_id required.
 *   - "wallet_topup" — funds the user's closed-loop wallet. amount_paise required.
 *
 * The backend handles ownership checks (403 not_owner), idempotency (409
 * already_paid / reuse-existing-pending), and gateway error pass-through
 * (502 gateway_error). All errors arrive as a CashfreeOrderError so the UI
 * can branch on `.code`.
 */
export async function createCashfreeOrder(
  token: string,
  opts:
    | { booking_id: string; payment_source: 'direct' }
    | { payment_source: 'wallet_topup'; amount_paise: number },
): Promise<CashfreeOrderResponse> {
  const res = await apiFetch(`${BASE_URL}/payments/cashfree/order`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = (body as { code?: string }).code ?? 'unknown';
    const message = (body as { error?: string }).error ?? `cashfree order failed (${res.status})`;
    throw new CashfreeOrderError(res.status, code, message);
  }
  return res.json() as Promise<CashfreeOrderResponse>;
}

/**
 * GET /payments/cashfree/orders/:orderID/status
 *
 * Used by the post-checkout poll loop. Backend live-fetches from Cashfree
 * only when local status is non-terminal; result is cached for 2s.
 */
export async function getCashfreeOrderStatus(
  token: string,
  orderID: string,
): Promise<CashfreeOrderStatus> {
  const res = await apiFetch(
    `${BASE_URL}/payments/cashfree/orders/${encodeURIComponent(orderID)}/status`,
    { method: 'GET', headers: authHeaders(token) },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = (body as { code?: string }).code ?? 'unknown';
    const message = (body as { error?: string }).error ?? `cashfree status failed (${res.status})`;
    throw new CashfreeOrderError(res.status, code, message);
  }
  return res.json() as Promise<CashfreeOrderStatus>;
}
