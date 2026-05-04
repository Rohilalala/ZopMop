// Phase 1: baseline — single iteration per endpoint, assert 200 + latency.
import http from 'k6/http';
import { check, group } from 'k6';
import { Trend } from 'k6/metrics';
import { API, BASE, authHeaders, pickCustomer, pickHelper, SERVICE_CATEGORY_ID } from './lib.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    'http_req_duration{name:health}': ['p(95)<200'],
    'http_req_duration{name:services}': ['p(95)<200'],
    'http_req_duration{name:sdui_home}': ['p(95)<400'],
    'http_req_duration{name:zones_check}': ['p(95)<200'],
    'http_req_duration{name:me}': ['p(95)<200'],
    'http_req_duration{name:helper_profile}': ['p(95)<200'],
    'http_req_duration{name:bookings_create}': ['p(95)<400'],
    'http_req_duration{name:bookings_tracking}': ['p(95)<200'],
    'http_req_duration{name:helpers_location_put}': ['p(95)<200'],
    'http_req_duration{name:send_otp}': ['p(95)<400'],
  },
};

export default function () {
  const cust = pickCustomer();
  const helper = pickHelper();

  group('GET /health', () => {
    const r = http.get(`${BASE}/health`, { tags: { name: 'health' } });
    check(r, { 'health 200': (x) => x.status === 200 });
  });

  group('GET /api/v1/services (categories proxy)', () => {
    const r = http.get(`${API}/services`, { tags: { name: 'services' } });
    check(r, {
      'services 200': (x) => x.status === 200,
      'services has list': (x) => x.json('services') !== undefined,
    });
  });

  group('GET /api/v1/sdui/page/home', () => {
    const r = http.get(`${API}/sdui/page/home`, { tags: { name: 'sdui_home' } });
    check(r, { 'sdui 200': (x) => x.status === 200 });
  });

  group('GET /api/v1/zones/check', () => {
    const r = http.get(`${API}/zones/check?lat=28.6139&lon=77.2090`, { tags: { name: 'zones_check' } });
    check(r, { 'zones 200': (x) => x.status === 200 });
  });

  group('GET /api/v1/me (auth)', () => {
    const r = http.get(`${API}/me`, { headers: authHeaders(cust.token), tags: { name: 'me' } });
    check(r, { 'me 200': (x) => x.status === 200 });
  });

  group('GET /api/v1/helpers/me/profile (auth pro)', () => {
    const r = http.get(`${API}/helpers/me/profile`, {
      headers: authHeaders(helper.token),
      tags: { name: 'helper_profile' },
    });
    check(r, { 'helper profile 200': (x) => x.status === 200 });
  });

  group('PUT /api/v1/helpers/me/location', () => {
    const r = http.put(
      `${API}/helpers/me/location`,
      JSON.stringify({ lat: 28.62, lng: 77.21 }),
      { headers: authHeaders(helper.token), tags: { name: 'helpers_location_put' } },
    );
    check(r, { 'location 200': (x) => x.status === 200 });
  });

  let bookingId;
  group('POST /api/v1/bookings (create)', () => {
    const r = http.post(
      `${API}/bookings/`,
      JSON.stringify({
        service_category_id: SERVICE_CATEGORY_ID,
        address: 'Connaught Place, New Delhi',
        lat: 28.6139,
        lng: 77.2090,
      }),
      {
        headers: authHeaders(cust.token, { 'Idempotency-Key': `baseline-${Date.now()}` }),
        tags: { name: 'bookings_create' },
      },
    );
    check(r, {
      'create 201': (x) => x.status === 201,
      'create has id': (x) => x.json('id') !== undefined,
    });
    bookingId = r.json('id');
  });

  if (bookingId) {
    group('GET /api/v1/bookings/:id/tracking', () => {
      const r = http.get(`${API}/bookings/${bookingId}/tracking`, {
        headers: authHeaders(cust.token),
        tags: { name: 'bookings_tracking' },
      });
      check(r, { 'tracking 200 or 404': (x) => x.status === 200 || x.status === 404 });
    });
  }

  group('POST /api/v1/auth/send-otp', () => {
    // Use a phone outside the loadtest range to avoid stomping seeded users.
    const phone = `+91777${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
    const r = http.post(
      `${API}/auth/send-otp`,
      JSON.stringify({ phone }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'send_otp' } },
    );
    check(r, { 'send-otp 200 or 429': (x) => x.status === 200 || x.status === 429 });
  });
}
