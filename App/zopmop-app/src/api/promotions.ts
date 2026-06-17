import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type Offer = {
  id: string;
  code: string;
  title: string;
  description: string;
  discount_label: string;
  expires_at: string | null;
  min_order_paise: number;
  max_per_user: number;
  stackable: boolean;
  categories: string[];
};

export type PromoPreview = {
  valid: boolean;
  discount_paise?: number;
  net_paise?: number;
  message?: string;
};

/** GET /bookings/promo-preview — display-only discount for a code on an order
 *  amount (paise). Lets the cart show a real discount line + net total before
 *  checkout (the booking-create path re-validates and is the source of truth). */
export async function previewPromo(token: string, code: string, amountPaise: number): Promise<PromoPreview> {
  const res = await apiFetch(
    `${BASE_URL}/bookings/promo-preview?code=${encodeURIComponent(code)}&amount_paise=${amountPaise}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  if (!res.ok) return { valid: false };
  return (await res.json()) as PromoPreview;
}

/** GET /offers — active promotions visible to the authenticated user. */
export async function listOffers(token: string): Promise<Offer[]> {
  const res = await apiFetch(`${BASE_URL}/offers`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`offers fetch failed (${res.status})`);
  }
  const body = await res.json() as { offers: Offer[] };
  return body.offers ?? [];
}
