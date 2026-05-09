import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type Offer = {
  id: string;
  code: string;
  title: string;
  description: string;
  discount_label: string;
  expires_at: string | null;
  min_order_cents: number;
  max_per_user: number;
  stackable: boolean;
  categories: string[];
};

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
