// Phase 3.3 + 3.4 + 3.2: pool saturation + geo p95 + cache fallback proxy.
//   - 1000 simultaneous /zones/check (PostGIS spatial query) → geo p95.
//   - High-VU /api/v1/me hammer → DB pool saturation (auth middleware hits DB).
//   - Mid-run, externally flush Redis (caller does it via redis-cli) — we just
//     measure read latency before/after, the spike on first miss reveals fallback.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { API, authHeaders, customers, delhiCoord } from './lib.js';

const geoLat = new Trend('geo_check_latency');
const meLat = new Trend('me_latency');

export const options = {
  scenarios: {
    geo_burst: {
      executor: 'constant-arrival-rate',
      rate: 200, // 200 rps × 60s = 12k requests; concurrent peak depends on latency
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 100,
      maxVUs: 400,
      exec: 'geoBurst',
    },
    pool_saturate: {
      executor: 'constant-vus',
      vus: 200, // exceeds DB_POOL_MAX_CONNS=80 → forces queueing
      duration: '60s',
      exec: 'poolSaturate',
    },
  },
  thresholds: {
    'geo_check_latency': ['p(50)<200', 'p(95)<800', 'p(99)<2000'],
    'me_latency': ['p(50)<200', 'p(95)<1500', 'p(99)<5000'],
  },
};

export function geoBurst() {
  const coord = delhiCoord();
  const r = http.get(`${API}/zones/check?lat=${coord.lat}&lon=${coord.lng}`, {
    tags: { name: 'geo_check' },
  });
  geoLat.add(r.timings.duration);
  check(r, { 'geo 200': (x) => x.status === 200 });
}

export function poolSaturate() {
  const c = customers[(__VU - 1) % customers.length];
  const r = http.get(`${API}/me`, { headers: authHeaders(c.token), tags: { name: 'me_db' } });
  meLat.add(r.timings.duration);
  check(r, { 'me 200 or 5xx (queue overflow)': (x) => x.status === 200 || x.status >= 500 });
}
