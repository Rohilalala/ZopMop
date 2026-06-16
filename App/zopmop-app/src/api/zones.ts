import { BASE_URL } from './config';

export interface ZoneCheckResult {
  serviceable: boolean;
  zone_name?: string;
  city?: string;
  /** True only when the server actually answered (HTTP 200). On network
   *  errors / 5xx this is false and `serviceable` is just the fail-closed
   *  default — callers must NOT treat it as a real "out of zone" answer
   *  (a backend restart or flaky network would otherwise flash the
   *  "We're not in your area" screen at users who are in zone). */
  authoritative: boolean;
}

export async function checkServiceability(lat: number, lon: number): Promise<ZoneCheckResult> {
  try {
    const res = await fetch(`${BASE_URL}/zones/check?lat=${lat}&lon=${lon}`);
    if (!res.ok) return { serviceable: false, authoritative: false };
    const body = await (res.json() as Promise<Omit<ZoneCheckResult, 'authoritative'>>);
    return { ...body, authoritative: true };
  } catch {
    // Security: Fail-closed — network errors or unreachable backend must NOT grant
    // access. Defaulting to serviceable:true would let an attacker block the zone-check
    // request (DNS poisoning, firewall rule) to bypass geo-restrictions entirely.
    // `authoritative:false` lets the UI keep its last known state instead of
    // hard-blocking on a transient error (backend deploy, flaky network).
    // NOTE: instant bookings are zone-gated server-side via dispatch matching;
    // scheduled-booking creation does NOT currently re-check the zone on the
    // backend, so this client gate is the only pre-booking zone filter there.
    return { serviceable: false, authoritative: false };
  }
}
