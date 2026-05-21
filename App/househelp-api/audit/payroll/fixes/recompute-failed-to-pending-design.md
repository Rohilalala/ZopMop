# Recompute on failed rows: flip status to pending — design

## Problem

PR #21 shipped `RecomputeApply` allowing recompute on rows where
`status ∈ {pending_manual_payout, failed}`. The UPDATE only touched
the numeric fields (online_minutes, working_minutes, *_pay_paise);
`status` and `failure_reason` were left as-is.

Consequence: a row stuck in `failed` keeps that status even after a
recompute. `mark-paid` accepts only `pending_manual_payout` → the
admin has no way to retry payout after a recompute. Fix-and-retry
loop is dead-ended.

Decision (2026-05-21): recompute on a `failed` row also resets it to
`pending_manual_payout` and clears `failure_reason`, so the admin can
re-attempt `mark-paid` immediately. Recompute on a row that is already
`pending_manual_payout` keeps the status as-is.

## Truth table

| Before status | After recompute status | failure_reason |
|---|---|---|
| `pending_manual_payout` | `pending_manual_payout` (unchanged) | unchanged |
| `failed`                | `pending_manual_payout` (**new**)   | `NULL` (**new**) |
| `paid`                  | rejected with 403 (unchanged)       | n/a |

## Implementation

`internal/crm/payroll/payroll.go::RecomputeApply` UPDATE statement
gains two conditional SET clauses, evaluated against the row's
current `status` in the same atomic UPDATE:

```sql
UPDATE payouts
   SET online_minutes   = $2,
       working_minutes  = $3,
       base_pay_paise   = $4,
       work_bonus_paise = $5,
       gross_pay_paise  = $6,
       net_pay_paise    = $7,
       status = CASE
                  WHEN status = 'failed' THEN 'pending_manual_payout'
                  ELSE status
                END,
       failure_reason = CASE
                          WHEN status = 'failed' THEN NULL
                          ELSE failure_reason
                        END,
       updated_at = now()
 WHERE id = $1::uuid
   AND status IN ('pending_manual_payout', 'failed')
RETURNING id
```

The two `CASE` legs reference the pre-UPDATE column value
(PostgreSQL evaluates UPDATE SET expressions against the OLD row),
so the status check inside the CASE matches the WHERE-clause check.
Atomic; no extra round-trip.

## Audit log

`insertAudit` writes the full before/after JSONB snapshots produced
by `readPayoutSnapshot`. The snapshot already includes `status` and
`failure_reason`, so the status flip and the cleared reason are
captured automatically — no schema change needed. The `action`
remains `recomputed`.

## Frontend

`App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx` recompute
ConfirmModal `impact` copy gains a sentence noting that a `failed`
row will move back to `pending_manual_payout` so the admin can
retry `mark-paid`.

## Out of scope

- No new error code; no new audit `action`; no schema migration.
- The handler-side status check in `transitionInTx` paid-row branch
  is unchanged: paid → 403 stays.
