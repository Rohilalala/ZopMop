// stress_full.js — full lifecycle k6 stress for the househelp-api. Drives
// every state transition through the real HTTP routes, no DB shortcuts.
//
// Scenarios run in this timeline:
//   0:00 baseline           1 VU, smoke + p95 thresholds across public+auth
//   0:15 customer_lifecycle ramp 5→15 VUs, customers create + poll + (rare) cancel
//   0:20 helper_workers     30 VUs constant, pros poll invites, accept,
//                           arrive, start, complete, customer reviews after
//   4:00 thundering_herd    50 VUs × 10 iters, herd booking creates
//   5:45 edge_cases         5 VUs × 50 iters, validation/auth/role failures
//
// The customer + helper scenarios run concurrently so the matching engine has
// real demand AND real supply: customers post bookings, the engine fans out
// invites every 5s (matching.batch_interval_seconds), helper VUs pull those
// invites and march them through accepted → in_progress → completed. After
// completion, the same customer's next iteration may post a review.
//
// Run from this directory:
//   BASE_URL=http://localhost:8080 k6 run stress_full.js

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const CUSTOMERS_CSV = __ENV.CUSTOMERS_CSV || './stress_customers.csv';
const HELPERS_CSV   = __ENV.HELPERS_CSV   || './stress_helpers.csv';
const SERVICE_CATEGORY_ID = __ENV.SERVICE_CATEGORY_ID || 'a1000000-0000-0000-0000-000000000001';

const customers = new SharedArray('customers', () => {
  const f = open(CUSTOMERS_CSV);
  return papaparse.parse(f, { header: true, skipEmptyLines: true }).data;
});
const helpers = new SharedArray('helpers', () => {
  const f = open(HELPERS_CSV);
  return papaparse.parse(f, { header: true, skipEmptyLines: true }).data;
});

// ── metrics ────────────────────────────────────────────────────────────────
const errors5xx          = new Counter('errors_5xx');
const errors4xxUnexpected = new Counter('errors_4xx_unexpected');

const bookingsCreated     = new Counter('bookings_created');
const bookingsMatched     = new Counter('bookings_match_status_matched');
const bookingsCancelled   = new Counter('bookings_cancelled_by_customer');
const bookingsAcceptedCnt = new Counter('bookings_accepted');
const bookingsArrivedCnt  = new Counter('bookings_arrived');
const bookingsStartedCnt  = new Counter('bookings_started');
const bookingsCompletedCnt = new Counter('bookings_completed');
const reviewsPosted       = new Counter('reviews_posted');
const dedupConflicts      = new Counter('dedup_conflicts_409');
const expectedAuthFails   = new Counter('expected_auth_fails');
const acceptRaceLost      = new Counter('accept_race_lost'); // 400/404 — another helper got it
const matchPollSeconds    = new Trend('match_poll_seconds');
const lifecycleSeconds    = new Trend('full_lifecycle_seconds');
const bookingCreate2xx    = new Rate('booking_create_2xx');

export const options = {
  scenarios: {
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '60s',
      exec: 'baseline',
    },
    customer_lifecycle: {
      executor: 'ramping-vus',
      startTime: '15s',
      startVUs: 3,
      stages: [
        { duration: '30s',  target: 10 },
        { duration: '120s', target: 10 },
        { duration: '30s',  target: 0 },
      ],
      gracefulRampDown: '15s',
      exec: 'customerLifecycle',
    },
    helper_workers: {
      executor: 'constant-vus',
      startTime: '20s',
      vus: 100, // one VU per seeded helper so the matching engine's pick
                // (which can land on any of the 100 helpers) never strands
                // an invite on an idle account.
      duration: '3m20s',
      exec: 'helperLifecycle',
    },
    thundering_herd: {
      executor: 'per-vu-iterations',
      startTime: '4m',
      vus: 50,
      iterations: 10,
      maxDuration: '90s',
      exec: 'thunderingHerd',
    },
    edge_cases: {
      executor: 'shared-iterations',
      startTime: '5m45s',
      vus: 5,
      iterations: 50,
      maxDuration: '60s',
      exec: 'edgeCases',
    },
  },
  thresholds: {
    'errors_5xx':                                 ['count<5'],
    'http_req_duration{name:health}':             ['p(95)<200'],
    'http_req_duration{name:services}':           ['p(95)<400'],
    'http_req_duration{name:sdui_home}':          ['p(95)<800'],
    'http_req_duration{name:zones_check}':        ['p(95)<300'],
    'http_req_duration{name:me}':                 ['p(95)<500'],
    'http_req_duration{name:bookings_create}':    ['p(95)<1500'],
    'http_req_duration{name:helper_loc_put}':     ['p(95)<400'],
    'http_req_duration{name:helper_invites}':     ['p(95)<500'],
    'http_req_duration{name:bookings_accept}':    ['p(95)<800'],
    'http_req_duration{name:bookings_complete}':  ['p(95)<800'],
    // Matching engine batches every 5s and notifies up to 3 helpers per
    // booking — only one wins the accept race. Realistic floor for a 3-min
    // run is "we got at least some lifecycle completions": tighten in CI
    // when the engine config is tuned for higher throughput.
    'bookings_completed':                         ['count>5'],
    'bookings_accepted':                          ['count>5'],
  },
};

// ── shared helpers ─────────────────────────────────────────────────────────
function authHeaders(token, extra = {}) {
  return Object.assign(
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    extra,
  );
}
function pickCustomer() { return customers[Math.floor(Math.random() * customers.length)]; }
function pickCustomerByVU() { return customers[__VU % customers.length]; }
function pickHelper() { return helpers[Math.floor(Math.random() * helpers.length)]; }
function pickHelperByVU() { return helpers[__VU % helpers.length]; }
// ncrCoord returns a coord ≈ within 1 km of Connaught Place. Tight radius
// keeps the matching engine's walking-ETA guard (25 min cap) happy so
// accepts don't fail with ErrTooFarAway.
function ncrCoord() {
  return {
    lat: 28.6139 + (Math.random() - 0.5) * 0.01,
    lng: 77.2090 + (Math.random() - 0.5) * 0.01,
  };
}
function trackErr(r, name) {
  if (r.status >= 500) errors5xx.add(1, { route: name });
  else if (r.status >= 400 && ![400, 401, 403, 404, 409, 413, 429].includes(r.status)) {
    errors4xxUnexpected.add(1, { route: name, code: String(r.status) });
  }
}

// ── 1. baseline ────────────────────────────────────────────────────────────
export function baseline() {
  const cust = pickCustomer();
  const helper = pickHelper();

  group('public', () => {
    let r = http.get(`${BASE}/health`, { tags: { name: 'health' } });
    check(r, { 'health 200': (x) => x.status === 200 });
    r = http.get(`${API}/services`, { tags: { name: 'services' } });
    check(r, { 'services 200': (x) => x.status === 200 });
    r = http.get(`${API}/sdui/page/home`, { tags: { name: 'sdui_home' } });
    check(r, { 'sdui 200': (x) => x.status === 200 });
    r = http.get(`${API}/zones/check?lat=28.6139&lon=77.2090`, { tags: { name: 'zones_check' } });
    check(r, { 'zones 200': (x) => x.status === 200 });
  });
  group('auth', () => {
    let r = http.get(`${API}/me`, { headers: authHeaders(cust.token), tags: { name: 'me' } });
    check(r, { 'me 200': (x) => x.status === 200 });
    r = http.get(`${API}/helpers/me/profile`, {
      headers: authHeaders(helper.token), tags: { name: 'helper_profile' },
    });
    check(r, { 'helper profile 200': (x) => x.status === 200 });
    r = http.put(`${API}/helpers/me/location`,
      JSON.stringify({ lat: 28.62, lng: 77.21 }),
      { headers: authHeaders(helper.token), tags: { name: 'helper_loc_put' } });
    check(r, { 'helper loc 200': (x) => x.status === 200 });
  });
}

// ── 2. customer full lifecycle ────────────────────────────────────────────
// Creates a booking, polls /match-status until matched (or timeout),
// optionally posts a review if the helper has already driven the booking
// through to completed by the time we poll detail. Cancels ~5% of bookings
// during the searching phase to exercise the cancel path.
//
// Customers are pinned per (__VU, __ITER) so we cycle through the entire
// 1000-customer pool deterministically — this dodges the per-user
// BookingCreateRateLimit (3 / min) by never hitting the same customer twice
// within the window, even at high concurrency. Every code path ends with a
// sleep() so a fast-fail iteration (rate-limited create, etc.) does not hot
// loop and saturate the API.
export function customerLifecycle() {
  const idx = (__VU * 7919 + __ITER) % customers.length; // distinct, spread.
  const cust = customers[idx];
  const c = ncrCoord();

  // List + me — keep the read-side warm.
  if (Math.random() < 0.3) {
    const r = http.get(`${API}/me`, { headers: authHeaders(cust.token), tags: { name: 'me' } });
    trackErr(r, 'me');
  }
  if (Math.random() < 0.2) {
    const r = http.get(`${API}/sdui/page/home`, { tags: { name: 'sdui_home' } });
    trackErr(r, 'sdui_home');
  }

  // Create a booking. Idempotency-Key ensures retries don't double-insert.
  const idemKey = `lc-${cust.id}-${__VU}-${__ITER}-${Date.now()}`;
  const created = http.post(`${API}/bookings/`,
    JSON.stringify({
      service_category_id: SERVICE_CATEGORY_ID,
      address: 'Stress lifecycle, Delhi',
      lat: c.lat, lng: c.lng,
    }),
    {
      headers: authHeaders(cust.token, { 'Idempotency-Key': idemKey }),
      tags: { name: 'bookings_create' },
    },
  );
  bookingCreate2xx.add(created.status === 200 || created.status === 201);
  trackErr(created, 'bookings_create');
  if (created.status === 409) { dedupConflicts.add(1); sleep(1); return; }
  if (created.status === 429) { sleep(2); return; } // rate-limited; back off
  if (created.status !== 201 && created.status !== 200) { sleep(1); return; }
  const bookingID = created.json('id');
  if (!bookingID) { sleep(1); return; }
  bookingsCreated.add(1);

  // Poll match-status up to ~30s. Real customer client polls every 2s.
  const pollStart = Date.now();
  let matched = false;
  for (let i = 0; i < 15; i++) {
    sleep(2);
    const r = http.get(`${API}/bookings/${bookingID}/match-status`,
      { headers: authHeaders(cust.token), tags: { name: 'bookings_match_status' } });
    trackErr(r, 'bookings_match_status');
    if (r.status !== 200) continue;
    const status = r.json('status');
    if (status === 'matched') { matched = true; bookingsMatched.add(1); break; }
    if (status === 'failed')  { break; }
  }
  matchPollSeconds.add((Date.now() - pollStart) / 1000);

  // Cancel ~5% of bookings to exercise the cancel path. Choose only those
  // still in pending/searching — once matched, cancelling fee-stings the
  // customer and isn't representative.
  if (!matched && Math.random() < 0.05) {
    const r = http.post(`${API}/bookings/${bookingID}/cancel`, '{}',
      { headers: authHeaders(cust.token), tags: { name: 'bookings_cancel' } });
    trackErr(r, 'bookings_cancel');
    if (r.status === 200) bookingsCancelled.add(1);
    return;
  }

  // Wait briefly for the helper VU to push toward complete, then GET detail
  // and (if completed) leave a review.
  if (matched) {
    sleep(4);
    const detail = http.get(`${API}/bookings/${bookingID}`,
      { headers: authHeaders(cust.token), tags: { name: 'bookings_detail' } });
    trackErr(detail, 'bookings_detail');
    if (detail.status === 200 && detail.json('status') === 'completed') {
      const r = http.post(`${API}/bookings/${bookingID}/review`,
        JSON.stringify({ rating: 4 + Math.floor(Math.random() * 2), comment: 'stress test review' }),
        { headers: authHeaders(cust.token), tags: { name: 'bookings_review' } });
      trackErr(r, 'bookings_review');
      if (r.status === 200 || r.status === 201) reviewsPosted.add(1);
    }
  }
  sleep(1); // floor between iters so a tight loop never forms
}

// ── 3. helper lifecycle ───────────────────────────────────────────────────
// Each VU pins to one helper from the CSV and loops:
//   1. PUT /helpers/me/location (refreshes Redis GEO + helper:active marker
//      so the matching engine continues to consider them).
//   2. GET /helpers/me/invites (or /bookings/helper/invites — both work).
//   3. If invites > 0, accept the first one. On accept-race (someone else
//      grabbed it) just continue. On success: arrived → start → complete.
//   4. Sleep briefly (~0.5s) so Fiber's per-user limiter doesn't bite.
export function helperLifecycle() {
  const h = pickHelperByVU();

  // Refresh location every iteration. Each VU is pinned, so this keeps that
  // specific helper "alive" in Redis the entire run.
  const c = ncrCoord();
  const locResp = http.put(`${API}/helpers/me/location`,
    JSON.stringify({ lat: c.lat, lng: c.lng }),
    { headers: authHeaders(h.token), tags: { name: 'helper_loc_put' } });
  trackErr(locResp, 'helper_loc_put');

  const invR = http.get(`${API}/helpers/me/invites`,
    { headers: authHeaders(h.token), tags: { name: 'helper_invites' } });
  trackErr(invR, 'helper_invites');
  if (invR.status !== 200) { sleep(0.5); return; }
  const invites = invR.json('invites') || [];
  if (invites.length === 0) { sleep(0.5); return; }

  // Each invite shape varies — we only need an id. Accept up to 1 per
  // iteration; the helper's max_active limit (config) will reject more.
  const inv = invites[0];
  const bid = inv.id || inv.booking_id || inv.bookingID;
  if (!bid) { sleep(0.3); return; }

  const t0 = Date.now();

  const acc = http.post(`${API}/bookings/${bid}/accept`, '{}',
    { headers: authHeaders(h.token), tags: { name: 'bookings_accept' } });
  trackErr(acc, 'bookings_accept');
  if (acc.status !== 200) {
    // 400 'booking is not in pending status' / 404 'booking not found' = race lost.
    if (acc.status === 400 || acc.status === 404) acceptRaceLost.add(1);
    sleep(0.3);
    return;
  }
  bookingsAcceptedCnt.add(1);
  sleep(0.5);

  const arr = http.post(`${API}/bookings/${bid}/arrived`, '{}',
    { headers: authHeaders(h.token), tags: { name: 'bookings_arrived' } });
  trackErr(arr, 'bookings_arrived');
  if (arr.status === 200) bookingsArrivedCnt.add(1);
  sleep(0.3);

  const start = http.post(`${API}/bookings/${bid}/start`, '{}',
    { headers: authHeaders(h.token), tags: { name: 'bookings_start' } });
  trackErr(start, 'bookings_start');
  if (start.status !== 200) { sleep(0.3); return; }
  bookingsStartedCnt.add(1);
  sleep(0.7);

  const done = http.post(`${API}/bookings/${bid}/complete`, '{}',
    { headers: authHeaders(h.token), tags: { name: 'bookings_complete' } });
  trackErr(done, 'bookings_complete');
  if (done.status === 200) {
    bookingsCompletedCnt.add(1);
    lifecycleSeconds.add((Date.now() - t0) / 1000);
  }
}

// ── 4. thundering herd ────────────────────────────────────────────────────
const HERD_POOL_SIZE = 20;
export function thunderingHerd() {
  const cust = customers[__VU % HERD_POOL_SIZE];
  const c = ncrCoord();
  const r = http.post(`${API}/bookings/`,
    JSON.stringify({
      service_category_id: SERVICE_CATEGORY_ID,
      address: 'Herd address, Delhi',
      lat: c.lat, lng: c.lng,
    }),
    {
      headers: authHeaders(cust.token, { 'Idempotency-Key': `herd-${cust.id}-${__VU}-${__ITER}` }),
      tags: { name: 'bookings_create' },
    },
  );
  bookingCreate2xx.add(r.status === 201 || r.status === 200);
  if (r.status === 409) dedupConflicts.add(1);
  check(r, {
    'herd 2xx | 409 | 429': (x) =>
      x.status === 200 || x.status === 201 || x.status === 409 || x.status === 429,
  });
  trackErr(r, 'bookings_create');
}

// ── 5. edge cases ─────────────────────────────────────────────────────────
export function edgeCases() {
  const cust = pickCustomer();
  const helper = pickHelper();

  group('invalid JWT', () => {
    const r = http.get(`${API}/me`, {
      headers: authHeaders('not-a-real-jwt'),
      tags: { name: 'edge_invalid_jwt', expected_failure: 'yes' },
    });
    check(r, { '401 garbage': (x) => x.status === 401 });
    if (r.status === 401) expectedAuthFails.add(1);
  });
  group('tampered JWT', () => {
    const tampered = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiZWVlIiwicm9sZSI6ImFkbWluIn0.deadbeef';
    const r = http.get(`${API}/me`, {
      headers: authHeaders(tampered),
      tags: { name: 'edge_tampered_jwt', expected_failure: 'yes' },
    });
    check(r, { '401 tampered': (x) => x.status === 401 });
    if (r.status === 401) expectedAuthFails.add(1);
  });
  group('wrong role', () => {
    const r = http.get(`${API}/helpers/me/profile`, {
      headers: authHeaders(cust.token),
      tags: { name: 'edge_wrong_role', expected_failure: 'yes' },
    });
    check(r, { '403 wrong role': (x) => x.status === 403 });
    if (r.status === 403) expectedAuthFails.add(1);
  });
  group('missing field', () => {
    const r = http.post(`${API}/bookings/`,
      JSON.stringify({ address: 'no category', lat: 28.6, lng: 77.2 }),
      { headers: authHeaders(cust.token, { 'Idempotency-Key': `edge-${__ITER}` }),
        tags: { name: 'edge_missing', expected_failure: 'yes' } });
    check(r, { '400 missing': (x) => x.status === 400 });
  });
  group('bad coords', () => {
    const r = http.put(`${API}/helpers/me/location`,
      JSON.stringify({ lat: 999, lng: -999 }),
      { headers: authHeaders(helper.token),
        tags: { name: 'edge_bad_coords', expected_failure: 'yes' } });
    check(r, { '400 bad coords': (x) => x.status === 400 });
  });
  group('bad uuid', () => {
    const r = http.get(`${API}/bookings/not-a-uuid`, {
      headers: authHeaders(cust.token),
      tags: { name: 'edge_bad_uuid', expected_failure: 'yes' },
    });
    check(r, { '400 bad uuid': (x) => x.status === 400 });
  });
  group('unknown booking cancel', () => {
    const fakeID = '00000000-0000-0000-0000-000000000000';
    const r = http.post(`${API}/bookings/${fakeID}/cancel`, '{}',
      { headers: authHeaders(cust.token),
        tags: { name: 'edge_cancel_unknown', expected_failure: 'yes' } });
    check(r, { '404 unknown': (x) => x.status === 404 });
  });
  group('oversize body', () => {
    const big = 'A'.repeat(5 * 1024 * 1024);
    const r = http.post(`${API}/bookings/`,
      JSON.stringify({
        service_category_id: SERVICE_CATEGORY_ID,
        address: big, lat: 28.6, lng: 77.2,
      }),
      { headers: authHeaders(cust.token, { 'Idempotency-Key': `edge-big-${__ITER}` }),
        tags: { name: 'edge_oversize', expected_failure: 'yes' }, timeout: '30s' });
    check(r, { '413 or 400 oversize': (x) => x.status === 413 || x.status === 400 });
  });
}
