// Phase 2: realistic concurrent cohorts WITHIN rate-limiter budgets.
//
// Rate-limit constraints discovered in middleware/ratelimit.go:
//   - publicLimiter: 30/min per IP   (we share 127.0.0.1 in loopback test)
//   - authLimiter:   100/min per user
//   - bookingCreate:   3/min per user (intentional spam guard)
//
// To genuinely exercise the backend without slamming into 429s:
//   - Public (sdui/services): 1 customer-cohort VU = 1 hit per 2s → 30/min/VU.
//     We use the 100-customer pool and stagger across them so the IP-shared
//     bucket isn't exceeded too badly. We accept some 429s and tally them.
//   - Auth-bound: each VU pinned to a distinct user via VU index modulo pool;
//     stay below 100/min/user.
//   - Booking creates: limited to 2/min/user (under 3 cap). Burst handled by
//     phase3_thundering_herd.js separately.
//   - Pro GPS pings: 1 per 8s per VU → 7.5/min/VU (well under 100/min auth cap).
//
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { API, authHeaders, customers, helpers, SERVICE_CATEGORY_ID, delhiCoord } from './lib.js';

const status2xx = new Counter('status_2xx');
const status4xx = new Counter('status_4xx');
const status429 = new Counter('status_429');
const status5xx = new Counter('status_5xx');
function tally(r) {
  if (r.status >= 200 && r.status < 300) status2xx.add(1);
  else if (r.status === 429) status429.add(1);
  else if (r.status >= 400 && r.status < 500) status4xx.add(1);
  else if (r.status >= 500) status5xx.add(1);
}

export const options = {
  scenarios: {
    pros_online_status: {
      executor: 'constant-vus',
      vus: 30, duration: '60s', exec: 'proStatusOnline',
      tags: { cohort: 'pros_online' },
    },
    pros_gps_stream: {
      executor: 'constant-vus',
      vus: 15, duration: '60s', exec: 'proGpsStream',
      tags: { cohort: 'pros_gps' },
    },
    pros_finishing: {
      executor: 'constant-vus',
      vus: 10, duration: '60s', exec: 'proFinishing',
      tags: { cohort: 'pros_finishing' },
    },
    customers_browsing: {
      executor: 'constant-vus',
      // Public endpoints are IP-throttled at 30/min total. With 1 hit per 2s
      // per VU and only the first VU getting through, we'll see heavy 429s on
      // /sdui and /services — that's the documented behavior. We measure /me
      // (auth-bound) and tally 429s separately for visibility.
      vus: 30, duration: '60s', exec: 'customerBrowsing',
      tags: { cohort: 'cust_browse' },
    },
    customers_booking: {
      executor: 'constant-vus',
      // Each VU is pinned to a unique user. 2 bookings/VU/min stays under the
      // 3/min/user BookingCreateRateLimit cap.
      vus: 50, duration: '60s', exec: 'customerBooking',
      tags: { cohort: 'cust_book' },
    },
    customers_tracking: {
      executor: 'constant-vus',
      vus: 50, duration: '60s', exec: 'customerTracking',
      tags: { cohort: 'cust_track' },
    },
  },
  thresholds: {
    'http_req_duration{cohort:pros_gps}': ['p(95)<500'],
    'http_req_duration{cohort:cust_book}': ['p(95)<1500'],
    'http_req_duration{cohort:cust_track}': ['p(95)<800'],
    // No global http_req_failed threshold — rate-limit 429s on public are
    // expected loopback behavior and reported separately as status_429.
  },
};

function helperByVU() {
  return helpers[(__VU - 1) % helpers.length];
}
function customerByVU() {
  return customers[(__VU - 1) % customers.length];
}

export function proStatusOnline() {
  const h = helperByVU();
  const r = http.put(`${API}/helpers/me/status`, JSON.stringify({ is_available: true }),
    { headers: authHeaders(h.token), tags: { name: 'pro_status' } });
  tally(r);
  check(r, { 'status 2xx': (x) => x.status >= 200 && x.status < 300 });
  sleep(8);
}

export function proGpsStream() {
  const h = helperByVU();
  const c = delhiCoord();
  const r = http.put(`${API}/helpers/me/location`, JSON.stringify({ lat: c.lat, lng: c.lng }),
    { headers: authHeaders(h.token), tags: { name: 'pro_gps' } });
  tally(r);
  check(r, { 'gps 200': (x) => x.status === 200 });
  sleep(8);
}

export function proFinishing() {
  const h = helperByVU();
  const r1 = http.put(`${API}/helpers/me/status`, JSON.stringify({ is_available: false }),
    { headers: authHeaders(h.token), tags: { name: 'pro_status_off' } });
  tally(r1);
  sleep(0.5);
  const r2 = http.put(`${API}/helpers/me/status`, JSON.stringify({ is_available: true }),
    { headers: authHeaders(h.token), tags: { name: 'pro_status_on' } });
  tally(r2);
  const c = delhiCoord();
  const r3 = http.put(`${API}/helpers/me/location`, JSON.stringify({ lat: c.lat, lng: c.lng }),
    { headers: authHeaders(h.token), tags: { name: 'pro_gps_finishing' } });
  tally(r3);
  sleep(8);
}

export function customerBrowsing() {
  const c = customerByVU();
  const a = http.get(`${API}/sdui/page/home`, { tags: { name: 'browse_sdui' } });
  tally(a); check(a, { 'sdui 2xx or 429': (x) => x.status === 200 || x.status === 429 });
  const b = http.get(`${API}/services`, { tags: { name: 'browse_services' } });
  tally(b); check(b, { 'services 2xx or 429': (x) => x.status === 200 || x.status === 429 });
  const d = http.get(`${API}/me`, { headers: authHeaders(c.token), tags: { name: 'browse_me' } });
  tally(d); check(d, { 'me 200': (x) => x.status === 200 });
  sleep(2);
}

export function customerBooking() {
  const c = customerByVU();
  const coord = delhiCoord();
  const r = http.post(`${API}/bookings/`, JSON.stringify({
    service_category_id: SERVICE_CATEGORY_ID,
    address: 'Phase2 load address',
    lat: coord.lat,
    lng: coord.lng,
  }), {
    headers: authHeaders(c.token, { 'Idempotency-Key': `p2-${__VU}-${__ITER}-${Date.now()}` }),
    tags: { name: 'book_create' },
  });
  tally(r);
  check(r, { 'create 201 or rate-limited': (x) => x.status === 201 || x.status === 429 });
  sleep(30); // 2 bookings/min/VU max → under the 3/min/user cap.
}

export function customerTracking() {
  const c = customerByVU();
  const list = http.get(`${API}/bookings/`, { headers: authHeaders(c.token), tags: { name: 'list_bookings' } });
  tally(list);
  let bookingId;
  if (list.status === 200) {
    const arr = list.json('bookings') || list.json();
    if (Array.isArray(arr) && arr.length > 0) bookingId = arr[0].id;
  }
  if (bookingId) {
    const r = http.get(`${API}/bookings/${bookingId}/tracking`, {
      headers: authHeaders(c.token),
      tags: { name: 'track_poll' },
    });
    tally(r);
    check(r, { 'tracking 2xx or 4xx-by-status': (x) => x.status === 200 || (x.status >= 400 && x.status < 500) });
  }
  sleep(5);
}
