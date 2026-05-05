// Closed-loop wallet API client. Mirrors the surface area defined in the
// backend (App/househelp-api/internal/wallet/handler.go).
//
// Closed-loop semantics: balance is spendable only on Zopmop bookings via
// the wallet payment_source. Topups go through Cashfree PG → backend webhook
// credits the wallet inside the same transaction as the ledger update.
// There is no withdraw-to-bank, no P2P transfer.

import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

/** Current wallet balance for the authenticated user. */
export type WalletBalance = {
  balance_paise: number;
};

/** One row in the wallet history. amount_paise is signed: +ve = credit, -ve = debit. */
export type WalletTransaction = {
  id: string;
  amount_paise: number;
  balance_after: number;
  kind: 'topup' | 'spend' | 'refund_credit' | 'adjustment' | 'reversal';
  booking_id: string | null;
  payment_id: string | null;
  note: string | null;
  /** RFC3339 timestamp. */
  created_at: string;
};

/** Response shape from the topup endpoint — hands off to the Cashfree SDK. */
export type WalletTopupResponse = {
  payment_session_id: string;
  order_id: string;
  amount_paise: number;
  expires_at: string;
};

/** GET /wallet — current balance. Returns 0 paise if no wallet row exists. */
export async function getWalletBalance(token: string): Promise<WalletBalance> {
  const res = await apiFetch(`${BASE_URL}/wallet`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`wallet balance fetch failed (${res.status})`);
  }
  return res.json() as Promise<WalletBalance>;
}

/**
 * GET /wallet/transactions — paginated history, newest first.
 *
 * Pagination: pass `before` = the `created_at` of the last transaction from
 * the previous page (the backend uses (created_at, id) tuple-cursor; the id
 * arg is currently inferred server-side from the timestamp, so passing
 * `before` alone is sufficient for this client).
 */
export async function getWalletTransactions(
  token: string,
  opts?: { limit?: number; before?: string },
): Promise<{ transactions: WalletTransaction[] }> {
  const limit = opts?.limit ?? 20;
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts?.before) params.set('before', opts.before);
  const res = await apiFetch(`${BASE_URL}/wallet/transactions?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`wallet transactions fetch failed (${res.status})`);
  }
  return res.json() as Promise<{ transactions: WalletTransaction[] }>;
}

/**
 * POST /wallet/topup — opens a Cashfree order for a wallet topup. The
 * returned payment_session_id feeds straight into the Cashfree Drop Checkout
 * SDK. On payment success, the backend webhook credits the wallet inside the
 * same DB transaction as the ledger update — no client-side wallet write.
 *
 * Validation: backend enforces 100 ≤ amount_paise ≤ 500_000 (₹1–₹5,000).
 * Out-of-range returns 402 with code amount_too_low / amount_too_high.
 */
export async function topupWallet(
  token: string,
  amountPaise: number,
): Promise<WalletTopupResponse> {
  const res = await apiFetch(`${BASE_URL}/wallet/topup`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ amount_paise: amountPaise }),
  });
  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    const code = (body as { code?: string }).code ?? 'amount_invalid';
    const message = (body as { error?: string }).error ?? 'topup amount out of range';
    const err = new Error(message) as Error & { code?: string };
    err.code = code;
    throw err;
  }
  if (res.status === 503) {
    throw new Error('Wallet topup is not configured on the server.');
  }
  if (!res.ok) {
    throw new Error(`wallet topup failed (${res.status})`);
  }
  return res.json() as Promise<WalletTopupResponse>;
}
