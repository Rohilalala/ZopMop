import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface NearbyStats {
  nearby_count: number;
  avg_rating: number;
  avg_eta_min: number;
}

/**
 * GET /insights/nearby?lat=&lon= → live stats for the home pill.
 * Falls back to a sensible default if the endpoint is unavailable so
 * the UI never blocks on this call.
 */
export async function getNearbyStats(lat: number, lon: number): Promise<NearbyStats> {
  try {
    const res = await apiFetch(`${BASE_URL}/insights/nearby?lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error('not ok');
    const data = await res.json();
    return {
      nearby_count: Number(data.nearby_count ?? 0),
      avg_rating: Number(data.avg_rating ?? 5.0),
      avg_eta_min: Number(data.avg_eta_min ?? 12),
    };
  } catch {
    // Fallback so the pill always renders something useful.
    return { nearby_count: 1, avg_rating: 5.0, avg_eta_min: 2 };
  }
}

/**
 * GET /me/usuals → service IDs the user has booked recently or most often.
 * Returns service IDs ordered: recent first, then most-used.
 */
export async function getMyUsuals(token: string): Promise<string[]> {
  try {
    const res = await apiFetch(`${BASE_URL}/me/usuals`, {
      headers: authHeaders(token),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.service_ids) ? (data.service_ids as string[]) : [];
  } catch {
    return [];
  }
}
