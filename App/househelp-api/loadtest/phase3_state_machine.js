// Phase 3.5: invalid state transitions on bookings.
// Setup: customer creates booking (pending), then attempts:
//   - cancel after cancel (CANCELLED → IN_PROGRESS implied)
//   - complete a pending booking via /complete (PENDING → COMPLETED, skips ACCEPTED+IN_PROGRESS)
// Expects 4xx for invalid transitions.
import http from 'k6/http';
import { check } from 'k6';
import { API, authHeaders, customers, helpers, SERVICE_CATEGORY_ID } from './lib.js';

export const options = {
  scenarios: {
    fsm: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 1,
      maxDuration: '60s',
    },
  },
};

export default function () {
  const c = customers[(__VU - 1) % customers.length];
  const h = helpers[(__VU - 1) % helpers.length];

  // 1. Create booking (status=pending).
  const created = http.post(
    `${API}/bookings/`,
    JSON.stringify({
      service_category_id: SERVICE_CATEGORY_ID,
      address: 'FSM test address',
      lat: 28.6139,
      lng: 77.2090,
    }),
    {
      headers: authHeaders(c.token, { 'Idempotency-Key': `fsm-${__VU}-${Date.now()}` }),
      tags: { name: 'fsm_create' },
    },
  );
  if (created.status !== 201) return;
  const bookingId = created.json('id');

  // 2. Pro tries to /complete a pending booking (PENDING → COMPLETED, illegal).
  const complete = http.post(
    `${API}/bookings/${bookingId}/complete`,
    null,
    { headers: authHeaders(h.token), tags: { name: 'fsm_pending_to_completed' } },
  );
  check(complete, {
    'pending→completed rejected (4xx)': (x) => x.status >= 400 && x.status < 500,
  });

  // 3. Customer cancels.
  const cancel1 = http.post(
    `${API}/bookings/${bookingId}/cancel`,
    JSON.stringify({ reason: 'fsm test' }),
    { headers: authHeaders(c.token), tags: { name: 'fsm_cancel' } },
  );
  check(cancel1, { 'first cancel ok': (x) => x.status >= 200 && x.status < 300 });

  // 4. Pro tries to /complete on cancelled booking (CANCELLED → COMPLETED, illegal).
  const complete2 = http.post(
    `${API}/bookings/${bookingId}/complete`,
    null,
    { headers: authHeaders(h.token), tags: { name: 'fsm_cancelled_to_completed' } },
  );
  check(complete2, {
    'cancelled→completed rejected (4xx)': (x) => x.status >= 400 && x.status < 500,
  });

  // 5. Pro tries to /start on cancelled booking (CANCELLED → IN_PROGRESS, illegal).
  const start = http.post(
    `${API}/bookings/${bookingId}/start`,
    null,
    { headers: authHeaders(h.token), tags: { name: 'fsm_cancelled_to_started' } },
  );
  check(start, {
    'cancelled→in_progress rejected (4xx)': (x) => x.status >= 400 && x.status < 500,
  });
}
