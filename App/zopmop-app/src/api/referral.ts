import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type IncomingReferral = {
  status: 'pending' | 'completed';
  referrer_code: string;
  referrer_name?: string;
};

export type ReferralStats = {
  code: string;
  link: string;
  referrals_used: number;
  referrals_remaining: number;
  total_earned_paise: number;
  incoming?: IncomingReferral | null;
};

export async function getReferralStats(token: string): Promise<ReferralStats> {
  const res = await apiFetch(`${BASE_URL}/me/referral`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`/me/referral ${res.status}: ${body.slice(0, 200) || 'no body'}`);
  }
  return res.json();
}

export async function applyReferralCode(token: string, code: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/referrals/apply`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: Error & { code?: string } = new Error(body.error ?? 'Failed to apply referral code');
    err.code = body.code;
    throw err;
  }
}
