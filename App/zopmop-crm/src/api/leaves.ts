import { api } from './client';

export type ReassignmentOutcome = 'reassigned' | 'partially_reassigned' | 'cancelled' | 'none';
export type LeaveStatus = 'approved' | 'cancelled' | 'pending' | 'rejected';

export interface LeaveRow {
  id: string;
  pro_id: string;
  pro_name: string;
  pro_phone: string;
  date: string;          // ISO date
  declared_at: string;   // ISO timestamp
  status: LeaveStatus;
  source: 'pro' | 'admin';
  bookings_affected: number;
  reassignment_outcome: ReassignmentOutcome;
  cancelled_booking_ids: string[];
}

export interface LeaveBalance {
  pro_id: string;
  pro_name: string;
  pro_phone: string;
  balance: number;
  monthly_quota: number;
  used_this_month: number;
  reset_at: string;
}

export interface ListLeavesParams {
  pro_id?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  limit?: number;
  offset?: number;
}

export interface ListLeavesResponse {
  items: LeaveRow[];
  total_count: number;
  limit: number;
  offset: number;
}

export async function listLeaves(p: ListLeavesParams): Promise<ListLeavesResponse> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === '') continue;
    cleaned[k] = String(v);
  }
  return (await api.get<ListLeavesResponse>('/admin/leaves', { params: cleaned })).data;
}

export async function getBalances(proId?: string): Promise<LeaveBalance[]> {
  const params: Record<string, string> = {};
  if (proId) params.pro_id = proId;
  return (await api.get<{ items: LeaveBalance[] }>('/admin/leaves/balances', { params })).data.items;
}

export async function allocateLeave(
  proId: string,
  days: number,
  reason?: string,
): Promise<{ ok: true; new_balance: number }> {
  return (
    await api.post<{ ok: true; new_balance: number }>(
      `/admin/pro/${proId}/leave/allocate`,
      { days, reason: reason ?? '' },
    )
  ).data;
}
