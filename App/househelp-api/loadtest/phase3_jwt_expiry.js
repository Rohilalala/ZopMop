// Phase 3.6: JWT expiry. Mints an already-expired token and an unsigned token,
// expects 401 from auth-protected endpoints.
import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';
import crypto from 'k6/crypto';
import { API, customers } from './lib.js';

// HS256 sign a JWT with given payload and secret.
function signJWT(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64 = (obj) => encoding.b64encode(JSON.stringify(obj), 'rawurl');
  const signing = `${b64(header)}.${b64(payload)}`;
  const sig = encoding.b64encode(
    crypto.hmac('sha256', secret, signing, 'binary'),
    'rawurl',
  );
  return `${signing}.${sig}`;
}

const SECRET = __ENV.JWT_SECRET || 'change-this-to-a-random-64-char-string-in-production-123456789012';

export const options = {
  scenarios: {
    expired: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 1,
      maxDuration: '60s',
    },
  },
};

export default function () {
  const c = customers[(__VU - 1) % customers.length];
  const expiredAt = Math.floor(Date.now() / 1000) - 3600; // 1h ago

  // 1. Build expired token with same user_id as a real seeded customer.
  const expiredToken = signJWT(SECRET, {
    user_id: c.id,
    role: 'customer',
    is_suspended: false,
    iss: 'househelp-api',
    iat: expiredAt - 60,
    exp: expiredAt,
  });

  const r1 = http.get(`${API}/me`, {
    headers: { 'Authorization': `Bearer ${expiredToken}` },
    tags: { name: 'jwt_expired' },
  });
  check(r1, { 'expired → 401': (x) => x.status === 401 });

  // 2. Garbage signature.
  const garbage = expiredToken.split('.').slice(0, 2).join('.') + '.deadbeef';
  const r2 = http.get(`${API}/me`, {
    headers: { 'Authorization': `Bearer ${garbage}` },
    tags: { name: 'jwt_bad_sig' },
  });
  check(r2, { 'bad sig → 401': (x) => x.status === 401 });

  // 3. Valid token (control).
  const r3 = http.get(`${API}/me`, {
    headers: { 'Authorization': `Bearer ${c.token}` },
    tags: { name: 'jwt_valid' },
  });
  check(r3, { 'valid → 200': (x) => x.status === 200 });
}
