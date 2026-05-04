// Phase 3.1: 300 customers POST /bookings/ at the same instant.
// Uses per-VU-iteration executor with a 0s startTime — k6 ramps all 300 VUs
// up before iterations begin (gracefulStop=0 to keep them stacked tight).
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { API, authHeaders, customers, SERVICE_CATEGORY_ID, delhiCoord } from './lib.js';

const burstLatency = new Trend('burst_latency');
const burstErrors = new Counter('burst_errors');

export const options = {
  scenarios: {
    herd: {
      executor: 'per-vu-iterations',
      vus: 300,
      iterations: 1,
      maxDuration: '60s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.10'],
    'burst_latency': ['p(50)<800', 'p(95)<3000', 'p(99)<5000'],
  },
};

export default function () {
  const c = customers[(__VU - 1) % customers.length];
  const coord = delhiCoord();
  const r = http.post(
    `${API}/bookings/`,
    JSON.stringify({
      service_category_id: SERVICE_CATEGORY_ID,
      address: 'Herd test address',
      lat: coord.lat,
      lng: coord.lng,
    }),
    {
      headers: authHeaders(c.token, { 'Idempotency-Key': `herd-${__VU}-${Date.now()}` }),
      tags: { name: 'herd_book' },
    },
  );
  burstLatency.add(r.timings.duration);
  if (r.status !== 201) burstErrors.add(1);
  check(r, { 'created 201': (x) => x.status === 201 });
}
