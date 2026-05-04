import { apiFetch } from './client';
import { BASE_URL, authHeaders } from './config';

export interface ValidateVpaResult {
  vpa: string;
  valid: boolean;
  customer_name?: string;
  error?: string;
}

export async function validateVpa(token: string, vpa: string): Promise<ValidateVpaResult> {
  const res = await apiFetch(`${BASE_URL}/payments/validate-vpa`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ vpa }),
  });
  if (res.status === 503) {
    throw new Error('VPA validation is not configured on the server.');
  }
  if (!res.ok) {
    throw new Error('VPA validation failed.');
  }
  return res.json() as Promise<ValidateVpaResult>;
}
