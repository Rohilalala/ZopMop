// Payroll-engine admin API client. Pairs with internal/crm/payroll
// in the backend. The legacy /payouts/* endpoints (manual one-off
// disbursements via crm_payouts) live in a different module.

import { api } from './client';

export type PayoutStatus =
  | 'pending_manual_payout'
  | 'paid'
  | 'cancelled'
  | 'failed'
  | 'skipped';

export interface Payout {
  id: string;
  pro_id: string;
  helper_name?: string | null;
  helper_phone?: string | null;
  cycle_start: string; // YYYY-MM-DD
  cycle_end: string;   // YYYY-MM-DD
  online_minutes: number;
  working_minutes: number;
  base_pay_paise: number;
  work_bonus_paise: number;
  gross_pay_paise: number;
  deductions_paise: number;
  net_pay_paise: number;
  status: PayoutStatus;
  transaction_id?: string | null;
  paid_at?: string | null;
  paid_by_admin_id?: string | null;
  failure_reason?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerPayoutSummary {
  lifetime_paid_paise: number;
  current_cycle_pending?: Payout | null;
  recent_payouts: Payout[];
}

export const payrollKeys = {
  worker: (id: string) => ['payroll', 'worker', id] as const,
};

export async function getWorkerPayouts(workerId: string): Promise<WorkerPayoutSummary> {
  const { data } = await api.get<WorkerPayoutSummary>(`/workers/${workerId}/payroll-payouts`);
  // Defensive: backend returns recent_payouts as an array; never undefined.
  return {
    ...data,
    recent_payouts: data.recent_payouts ?? [],
  };
}

export async function markPayoutPaid(
  id: string,
  body: { paid_at?: string; notes?: string },
): Promise<Payout> {
  const { data } = await api.post<Payout>(`/payroll/payouts/${id}/mark-paid`, body);
  return data;
}

export async function markPayoutFailed(id: string, reason: string): Promise<Payout> {
  const { data } = await api.post<Payout>(`/payroll/payouts/${id}/mark-failed`, { reason });
  return data;
}

export async function recomputePayout(id: string): Promise<Payout> {
  const { data } = await api.post<Payout>(`/payroll/payouts/${id}/recompute`);
  return data;
}
