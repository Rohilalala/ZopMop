const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

export interface ZoneCheckResult {
  serviceable: boolean;
  zone_name?: string;
  city?: string;
}

export async function checkServiceability(lat: number, lon: number): Promise<ZoneCheckResult> {
  try {
    const res = await fetch(`${BASE_URL}/zones/check?lat=${lat}&lon=${lon}`);
    if (!res.ok) return { serviceable: false };
    return res.json() as Promise<ZoneCheckResult>;
  } catch {
    // Network error — default to serviceable so we don't block the app offline
    return { serviceable: true };
  }
}
