// Phase 3.7: same Idempotency-Key submitted twice within 500ms.
// Expectation: second response either returns the same booking ID OR an error
// indicating idempotent replay; must NOT create two distinct bookings.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { API, authHeaders, customers, SERVICE_CATEGORY_ID } from './lib.js';

export const options = {
  scenarios: {
    idem: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      maxDuration: '60s',
    },
  },
};

export default function () {
  const c = customers[(__VU - 1) % customers.length];
  const key = `idem-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({
    service_category_id: SERVICE_CATEGORY_ID,
    address: 'Idem test address',
    lat: 28.6139,
    lng: 77.2090,
  });
  const headers = authHeaders(c.token, { 'Idempotency-Key': key });

  const r1 = http.post(`${API}/bookings/`, body, { headers, tags: { name: 'idem_first' } });
  // Hit again immediately (well under 500ms).
  const r2 = http.post(`${API}/bookings/`, body, { headers, tags: { name: 'idem_second' } });

  const id1 = r1.status === 201 ? r1.json('id') : null;
  const id2 = r2.status === 201 ? r2.json('id') : null;

  check(r1, { 'first 201': (x) => x.status === 201 });
  check(r2, {
    'second is replay (same id) OR conflict 4xx': () => {
      if (id1 && id2 && id1 === id2) return true;
      if (r2.status === 409 || r2.status === 425) return true;
      return false;
    },
  });
}
