// Shared helpers for k6 stress scripts.
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';
import { SharedArray } from 'k6/data';
import http from 'k6/http';

export const BASE = __ENV.BASE_URL || 'http://localhost:8080';
export const API = `${BASE}/api/v1`;

export const customers = new SharedArray('customers', () => {
  const f = open('./customers.csv');
  return papaparse.parse(f, { header: true, skipEmptyLines: true }).data;
});

export const helpers = new SharedArray('helpers', () => {
  const f = open('./helpers.csv');
  return papaparse.parse(f, { header: true, skipEmptyLines: true }).data;
});

export function authHeaders(token, extra = {}) {
  return Object.assign(
    {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    extra,
  );
}

export function pickCustomer() {
  return customers[Math.floor(Math.random() * customers.length)];
}

export function pickHelper() {
  return helpers[Math.floor(Math.random() * helpers.length)];
}

// Delhi NCR jitter — keeps requests within ~15km of CP.
export function delhiCoord() {
  return {
    lat: 28.6139 + (Math.random() - 0.5) * 0.15,
    lng: 77.2090 + (Math.random() - 0.5) * 0.15,
  };
}

export const SERVICE_CATEGORY_ID = 'a1000000-0000-0000-0000-000000000001';
