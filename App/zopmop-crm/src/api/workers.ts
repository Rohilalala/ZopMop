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
};

export type Job = {
  id: string;
  category: string;
  status: string;
  price_cents: number;
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
