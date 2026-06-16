import axios, { AxiosError } from 'axios';

import { api } from './client';

export type Status = 'active' | 'pending' | 'rejected' | 'suspended' | 'banned';

export type WorkerListItem = {
  id: string;
  phone: string;
  name?: string | null;
  avatar_url?: string | null;
  status: Status;
  is_available: boolean;
  is_online: boolean;
  is_vip: boolean;
  rating: number;
  total_jobs: number;
  categories: string[];
  joined_at: string;
  last_active_at?: string | null;
};

export type WorkerDetail = WorkerListItem & {
  address: string;
  current_lat?: number | null;
  current_lng?: number | null;
  suspend_reason?: string | null;
  ban_reason?: string | null;
  completed_jobs_30d: number;
  earnings_30d_cents: number;
  cancellation_rate: number;
  /** Operational area; managed via PATCH /admin/workers/:id/locality. */
  locality?: string | null;

  // KYC / personal — landed via migration 106 (Phase 11B Step 2). All fields
  // nullable on the backend; absence in the JSON response means the column
  // is NULL (Go `omitempty` strips empty pointers).
  dob?: string | null;                       // YYYY-MM-DD
  gender?: 'male' | 'female' | 'other' | null;
  languages: string[];                        // always present (defaults to [])
  alt_phone?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  photo_url?: string | null;

  // PII fields visible to all admins today. Phase 12 will mask these for
  // non-superadmin roles and encrypt at rest.
  aadhaar_number?: string | null;
  aadhaar_verified: boolean;
  bank_account_number?: string | null;
  bank_account_holder_name?: string | null;
  bank_ifsc?: string | null;
  bank_verified: boolean;
};

export type Job = {
  id: string;
  category: string;
  status: string;
  price_paise: number;
  created_at: string;
  completed_at?: string | null;
};

export type LivePin = {
  id: string;
  name?: string | null;
  phone: string;
  lat: number;
  lng: number;
  rating: number;
  job_status: 'idle' | 'en_route' | 'on_job' | 'offline';
  active_booking_id?: string | null;
  updated_at?: string | null;
};

export type ListParams = {
  search?: string;
  status?: Status | '';
  category?: string;
  only_online?: boolean;
  sort_by?: 'joined_at' | 'total_jobs' | 'rating' | 'name';
  sort_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type ListResponse = {
  items: WorkerListItem[];
  total_count: number;
  limit: number;
  offset: number;
};

export async function listWorkers(p: ListParams): Promise<ListResponse> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === '' || v == null || v === false) continue;
    cleaned[k] = String(v);
  }
  return (await api.get<ListResponse>('/admin/workers', { params: cleaned })).data;
}
export async function getWorker(id: string): Promise<WorkerDetail> {
  return (await api.get<WorkerDetail>(`/admin/workers/${id}`)).data;
}
export async function getWorkerJobs(id: string): Promise<Job[]> {
  return (await api.get<{ jobs: Job[] }>(`/admin/workers/${id}/jobs`)).data.jobs;
}
export async function workerActiveJob(id: string): Promise<{ has_active: boolean; booking_id?: string | null }> {
  return (await api.get<{ has_active: boolean; booking_id?: string | null }>(`/admin/workers/${id}/active-job`)).data;
}

export interface WorkerPII {
  aadhaar_number?: string | null;
  bank_account_number?: string | null;
  bank_account_holder_name?: string | null;
  bank_ifsc?: string | null;
}
// Superadmin-only, server-audited unmasked PII reveal. The worker detail
// payload only carries last-4-masked values; full numbers come from here.
export async function workerPII(id: string): Promise<WorkerPII> {
  return (await api.get<WorkerPII>(`/admin/workers/${id}/pii`)).data;
}
export async function getLivePins(): Promise<LivePin[]> {
  return (await api.get<{ pins: LivePin[] }>('/admin/workers/live')).data.pins;
}
export async function approveWorker(id: string) { await api.post(`/admin/workers/${id}/approve`); }
export async function rejectWorker(id: string, reason: string) { await api.post(`/admin/workers/${id}/reject`, { reason }); }
export async function suspendWorker(id: string, reason: string) { await api.post(`/admin/workers/${id}/suspend`, { reason }); }
export async function unsuspendWorker(id: string) { await api.post(`/admin/workers/${id}/unsuspend`); }
export async function forceOffline(id: string) { await api.post(`/admin/workers/${id}/force-offline`); }
export async function setWorkerCategories(id: string, categories: string[]) {
  await api.put(`/admin/workers/${id}/categories`, { categories });
}

// PATCH /admin/workers/:id/locality — admin-only (workers.suspend perm).
// Empty string clears the locality. Returns the canonical (case-corrected)
// name from the localities table.
export async function setWorkerLocality(id: string, locality: string): Promise<string> {
  const res = await api.patch<{ ok: boolean; locality: string }>(
    `/admin/workers/${id}/locality`,
    { locality },
  );
  return res.data.locality ?? '';
}

// ── Phase 11B Step 1: admin-driven pro registration + manual deductions ──

// CreateWorkerRequest matches internal/crm/workers/repository.go::CreateRequest
// exactly. Do NOT add fields the backend does not accept — body-parsing
// happens via Fiber's struct unmarshal which silently drops unknown keys, so
// inventing fields would mean the UI lies about what got persisted.
//
// KYC + personal fields landed via migration 106 (Phase 11B Step 2).
// All optional — Create() accepts {name, phone} alone and persists NULLs for
// the rest. The Phase C form will collect them across 5 steps but every
// non-name/non-phone field can be skipped or filled in later.
export type CreateWorkerRequest = {
  phone: string;                    // 10-digit or +91-prefixed
  name: string;                     // required
  email?: string;
  address?: string;
  locality?: string;                // free-text, validated against localities table server-side
  weekly_hours_target?: number;     // 0 / omitted → backend defaults to 80
  categories?: string[];            // service category slugs
  zone_id?: string;                 // optional UUID; inserts pro_zone_assignments row
  start_active?: boolean;           // false (default) → approval_status='pending'

  // Personal.
  dob?: string;                     // YYYY-MM-DD (backend validates the shape)
  gender?: 'male' | 'female' | 'other';
  languages?: string[];
  alt_phone?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  photo_url?: string;

  // PII — stored plaintext today, encrypted in Phase 12.
  aadhaar_number?: string;
  bank_account_number?: string;
  bank_account_holder_name?: string;
  bank_ifsc?: string;
};

export type CreateWorkerResult = {
  id: string;
  phone: string;                    // +91-normalised by backend
};

// PhoneInUseError — typed 409 from POST /admin/workers when the phone
// already exists. Lets the form layer (Phase C) highlight the phone field
// without swallowing the generic-error toast from the axios interceptor.
export class PhoneInUseError extends Error {
  constructor(public readonly phone: string) {
    super('phone already in use');
    this.name = 'PhoneInUseError';
  }
}

export async function createWorker(payload: CreateWorkerRequest): Promise<CreateWorkerResult> {
  try {
    const res = await api.post<CreateWorkerResult>('/admin/workers', payload);
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError<{ error?: string }>;
      if (ax.response?.status === 409) {
        throw new PhoneInUseError(payload.phone);
      }
    }
    throw err;
  }
}

// Deduction is the persisted shape returned by POST/GET deductions.
// Mirrors internal/crm/workers/model.go::DeductionRow. admin_id is a UUID;
// the backend does NOT join admin_email today — display layer can fetch the
// admin separately if needed.
export type Deduction = {
  id: string;
  pro_id: string;
  admin_id: string;
  amount_paise: number;
  reason: string;
  fortnight_start?: string | null;  // YYYY-MM-DD or null = current fortnight
  created_at: string;
  reversed_at?: string | null;
};

export type AddDeductionRequest = {
  amount_paise: number;             // must be > 0 (validated server-side)
  reason: string;                   // required, non-empty
  fortnight_start?: string;         // YYYY-MM-DD; omitted → current fortnight server-side
};

export async function addDeduction(
  workerId: string,
  payload: AddDeductionRequest,
): Promise<Deduction> {
  const res = await api.post<Deduction>(`/admin/workers/${workerId}/deductions`, payload);
  return res.data;
}

// Backend returns {items: Deduction[]} with no pagination metadata; hard-capped
// at LIMIT 200 server-side, newest-first, reversed rows included (filter UI-side
// if needed).
export async function listDeductions(workerId: string): Promise<Deduction[]> {
  const res = await api.get<{ items: Deduction[] }>(`/admin/workers/${workerId}/deductions`);
  return res.data.items;
}

// Query-key conventions for TanStack Query. Phase C/D consumers should use
// these so invalidations from createWorker/addDeduction stay coherent.
export const workerKeys = {
  all: ['workers'] as const,
  list: (params: ListParams) => ['workers', params] as const,
  detail: (id: string) => ['workers', 'detail', id] as const,
  deductions: (id: string) => ['workers', id, 'deductions'] as const,
};
