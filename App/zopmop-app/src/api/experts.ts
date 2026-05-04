// Your Experts — wraps /api/v1/me/experts (defined in
// internal/experts/handler.go).

import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export type Expert = {
  helper_id: string;
  name: string;
  photo_url?: string | null;
  average_rating?: number | null;
  completed_jobs_with_user: number;
  added_at: string;
};

export type ExpertsListResponse = {
  experts: Expert[];
  limit: number;
};

export async function listExperts(token: string): Promise<ExpertsListResponse> {
  const res = await apiFetch(`${BASE_URL}/me/experts`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`list experts: ${res.status}`);
  return res.json();
}

export async function addExpert(token: string, helperId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/me/experts/${encodeURIComponent(helperId)}`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch {}
    throw new Error(body?.error ?? `add expert: ${res.status}`);
  }
}

export async function removeExpert(token: string, helperId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/me/experts/${encodeURIComponent(helperId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`remove expert: ${res.status}`);
}
