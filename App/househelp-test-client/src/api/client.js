import axios from 'axios';

const rawBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8080/api/v1';

// Security: refuse plaintext HTTP in production builds to prevent MITM.
if (import.meta.env.PROD && rawBase.startsWith('http://')) {
  throw new Error(
    '[Security] VITE_API_URL must use HTTPS in production. ' +
    'Set VITE_API_URL to an https:// URL before building.'
  );
}

export const API_BASE_URL = rawBase;
// Derive origin (scheme+host+port) for non-versioned endpoints like /health.
export const API_ORIGIN = rawBase.replace(/\/api\/v1\/?$/, '');

// Cookie auth: the JWT lives in an HttpOnly cookie set by /auth/verify-otp and
// /auth/firebase. withCredentials ensures the browser attaches it on every
// same-site request. The JWT is never readable by JS → XSS cannot steal it.
const client = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Read a cookie value by name. The csrf_ cookie is intentionally NOT HttpOnly
// so this double-submit token can be echoed in the X-Csrf-Token header.
function readCookie(name) {
  const prefix = name + '=';
  const parts = document.cookie.split('; ');
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return '';
}

// Attach the CSRF token on every state-changing request. Safe methods
// (GET/HEAD/OPTIONS) are exempt on the server side.
client.interceptors.request.use(
  (config) => {
    const method = (config.method ?? 'get').toLowerCase();
    if (['post', 'put', 'patch', 'delete'].includes(method)) {
      const csrf = readCookie('csrf_');
      if (csrf) {
        config.headers['X-Csrf-Token'] = csrf;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// On 401 evict cached profile and bounce to login.
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      sessionStorage.removeItem('househelp_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
