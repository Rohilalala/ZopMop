import { BASE_URL } from './config';

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
    // Security: Fail-closed — network errors or unreachable backend must NOT grant
    // access. Defaulting to serviceable:true would let an attacker block the zone-check
    // request (DNS poisoning, firewall rule) to bypass geo-restrictions entirely.
    return { serviceable: false };
  }
}
