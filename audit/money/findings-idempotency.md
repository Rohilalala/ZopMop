# Subagent C — Idempotency, Concurrency, Reconciliation

**Branch note (important):** FLOW_MAP references `internal/crm/payroll/payroll.go:230-269` (Mark-Paid/Failed/Recompute) and migrations 109/110. **None of those exist on this audit branch.** HEAD is `93e4367` on `feature/money-flow-audit-2026-05-21` (forked from `develop` tip `f228adb`). The shipped CRM admin payouts handler here is `internal/crm/payouts/payouts.go` operating on a separate table `crm_payouts`, not the engine `payouts` from migration 108. That gap drives CRITICAL-C1.

The CRM-embedded payroll handler + migrations 109/110 live on the unmerged branch `feature/payroll-targets-flags`. They are NOT in `develop` and therefore not in any deployable build.

---

## CRITICAL

### CRITICAL-C1 — Engine `payouts` rows are unreachable from the CRM admin panel
- Cron writes `payouts` (`App/househelp-api/internal/payroll/repository.go:86-108`, schema `App/househelp-api/migrations/108_payroll_engine.up.sql:51-84`).
- CRM Mark-Paid writes a different table `crm_payouts` (`App/househelp-api/internal/crm/payouts/payouts.go:106-116`):
  ```sql
  UPDATE crm_payouts SET status='paid', paid_at=now(), external_ref=NULLIF($2,''), updated_at=now()
  WHERE id = $1::uuid AND status IN ('pending','processing')
  ```
- Worked example: cron fires 16-May 01:00 IST → writes 14 rows in `payouts`. Founder opens CRM Payouts page (reads `crm_payouts`), sees zero. Ops either pays twice (manual against engine row + new `crm_payouts` row) or rows sit forever in `pending_manual_payout`. Inconsistent source of truth.

### CRITICAL-C2 — Dead `payments.reconciled` column; no Cashfree reconciliation job exists
- Schema: `App/househelp-api/migrations/056_payments.up.sql` defines `reconciled BOOLEAN DEFAULT FALSE`.
- Helpers `MarkReconciled` / `UnreconciledCount` / `IsReconciled` defined at `App/househelp-api/internal/payments/ledger.go:125-172` — **zero callers** anywhere in `cmd/` or `internal/`.
- The only place `reconciled=TRUE` is ever set is the wallet-paid booking insert (`App/househelp-api/internal/booking/service.go:233-234`) where the row self-flags because there's no external gateway. **No Cashfree row is ever flipped.**
- `App/househelp-api/cmd/crm-integrity/main.go:129-163` reconciles `SUM(payments.amount_paise)` vs `SUM(bookings.amount_paise)` per user — does not read `reconciled`, does not compare to Cashfree, is a one-shot CLI.
- **Blast radius:** any dropped Cashfree webhook (see HIGH-C5) leaves a `pending` payment + unpaid booking forever; no offline pass detects it. Customer charged at Cashfree, service not delivered, no auto-flag.

### CRITICAL-C3 — Payment-intent race: no UNIQUE on `(booking_id, gateway_status='pending')`
- Path: `App/househelp-api/internal/payments/handler.go:391-462`. Steps: SELECT reusable (`:496-505`), EXISTS-success check (`:449-454`), insert payments row in `openCashfreeOrder` (`:565-622`). No row lock between the SELECT and the INSERT.
- `payments.gateway_ref UNIQUE` only protects after `gateway_ref` is populated at `:606-611` — *after* the Cashfree call.
- Worked example: user double-taps Pay on flaky network. Both goroutines pass the reusable-lookup (no pending row yet), both call `openCashfreeOrder`, both create distinct Cashfree orders. Two PaymentSheets succeed → two `payments` rows with `gateway_status='success'` and different `gateway_ref`s. Double-charge; UNIQUE does not save us.

---

## HIGH

### HIGH-C4 — `crm_payouts.MarkPaid` returns malformed error on no-op CAS; false audit entry
- `App/househelp-api/internal/crm/payouts/payouts.go:106-116`:
  ```go
  if err != nil || res.RowsAffected() == 0 {
      return fmt.Errorf("mark paid: %w", err)  // wraps nil → "mark paid: %!w(<nil>)"
  }
  ```
- Handler at `:170-179` records `payout.paid` audit **before** checking nothing was updated. Two admins double-clicking: A wins, B gets 400 with garbled error, audit log shows two `payout.paid` rows. State safe (CAS), audit log lies → wire-transfer disputes hard to resolve.

### HIGH-C5 — Webhook 200-on-internal-error swallows the event; comment about retries is wrong
- `App/househelp-api/internal/payments/handler.go:857-870`: on dispatch error returns 200, so Cashfree marks delivered and does **not** retry. Inline comment at `:867-868` says "Cashfree's own retry of the same event_id will re-enter dispatch" — incorrect, Cashfree only retries on non-2xx.
- Combined with CRITICAL-C2 (no reconciliation), a transient DB error → permanently lost ledger update.
- Recommendation: return 503 on transient DB errors so Cashfree retries; or insert a `webhook_failures` row in a *separate* tx for ops visibility.

### HIGH-C6 — Signature replay window relies entirely on `event_id` dedup
- `App/househelp-api/internal/payments/cashfree.go:415-446`: 300 s skew compared against local clock; if NTP drifts >300 s, valid webhooks rejected (availability only, not money).
- Replay within 300 s is blocked only by `ConsumeOnceTx` keyed on `eventID`. Fallback chain in `handler.go:842-848` is `env.EventID → cfPaymentID → Type + ":" + orderID` — third tier collides legitimate retries with replays. Safe in happy path; fragile if a future event type ever leaves `event_id` empty AND triggers a non-idempotent ledger write.

### HIGH-C7 — `admin_pro_deductions` never aggregated into `payouts.deductions_paise`
- `UpsertPayout` hardcodes `deductions_paise = 0` (`App/househelp-api/internal/payroll/repository.go:95`).
- `admin_pro_deductions` table is written via `App/househelp-api/internal/crm/workers/repository.go:602-628` but **no SELECT against it** exists in the payroll engine.
- Worked example: ops files ₹500 damage deduction on 2026-05-12 (cycle 1). Cron fires 16-May → `deductions_paise=0` → pro paid full gross. ZopMop eats the ₹500.

### HIGH-C8 — No recompute path; deductions added after cron-fire are lost forever
- `UpsertPayout` is `ON CONFLICT DO NOTHING` (`App/househelp-api/internal/payroll/repository.go:97`); no `Recompute` exists on this branch.
- Pre-emptive flag for the future recompute PR: it MUST `SELECT … FOR UPDATE` the `payouts` row before snapshotting deductions, else two admins clicking Recompute race.

---

## MEDIUM

### MEDIUM-C9 — `ConsumeOnce` (non-Tx variant) has documented TOCTOU; should be private or deleted
- `App/househelp-api/internal/payments/idempotency.go:24-57`. Comment at `:17-21` acknowledges it. Not currently called on the money path (Cashfree uses `ConsumeOnceTx`), but any future webhook hooking into the non-Tx variant inherits the race.

### MEDIUM-C10 — `processed_webhook_events` has no GC
- `App/househelp-api/migrations/057_processed_webhook_events.up.sql`: PK on `event_id`, no TTL. Not a money risk; grows ~30 MB/yr at 1 M events. **No** dedup TTL → replays decades later still blocked (good).

### MEDIUM-C11 — `findReusableCashfreeOrder` returns expired SDK sessions if `co.expires_at` drifts from Cashfree
- `App/househelp-api/internal/payments/handler.go:496-505`. Fragility only — annoyance, not double-money.

### MEDIUM-C12 — `booking_adjustments.delta_paise` has zero Go code today
- `App/househelp-api/migrations/088_booking_adjustments.up.sql` schema only. No approval handler exists; no current race. Flag for future PR: approval MUST CAS `status='pending' → 'approved'` before re-applying `delta_paise` to `bookings.amount_paise`.

---

## LOW

### LOW-C13 — Refund idempotency key is row UUID; gateway 409 not explicitly handled but Retry path recovers
- `App/househelp-api/internal/payments/cashfree.go:138`: `refundID = "rfnd-" + idempotencyKey` where idempotencyKey is the `pending_refunds.id` UUID (`App/househelp-api/internal/crm/refunds/refunds.go:812`). Unique across rows and retries.
- 409 from Cashfree returned as error via `c.do()`; caller marks `gateway_error`; admin `Retry` (`App/househelp-api/internal/crm/refunds/refunds.go:648-727`) re-calls with same `rfnd-{id}` → Cashfree returns existing refund → success on next attempt.
- `lockForApproval` is a real CAS (`App/househelp-api/internal/crm/refunds/refunds.go:280-310`): `UPDATE pending_refunds SET status='approved' WHERE id=$1 AND status IN (...)` — two parallel Approves cannot both fire the gateway.

### LOW-C14 — Payroll cycle boundary is anchored to `shift_commitments.shift_date`, not session timestamps
- `App/househelp-api/internal/payroll/repository.go:58-74`. Session crossing midnight stays on its commitment's `shift_date` — clean attribution; no double-count, no loss.
- Open sessions (`offline_at IS NULL`) at cycle close are **skipped** and never picked up in cycle N+1 (shift_date still in N). If cycle-close cron (01:00 IST) fires before the 03:00 IST shift cutoff auto-closes dangling sessions, those minutes are lost. 2-hour exposure window.

### LOW-C15 — `cashfreeWebhookMaxSkew = 300 * time.Second` hard-coded
- `App/househelp-api/internal/payments/cashfree.go:62`. No env override; NTP-drift tuner only.

---

## Concurrency posture

| Path | Lock | Verdict |
|------|------|---------|
| `wallet.ApplyTransactionTx` | `SELECT … FOR UPDATE` on `wallets` (`wallet/repository.go:128`) | safe |
| `payBookingFromWallet` | `pgx.BeginFunc` wrapping debit + payments insert + booking update (`booking/service.go:217-252`) | safe |
| Cashfree webhook dispatch | `SELECT … FOR UPDATE OF p` (`handler.go:894-901`) + outer `ConsumeOnceTx` | safe |
| `findReusableCashfreeOrder` → `openCashfreeOrder` | none | **race (CRITICAL-C3)** |
| Refund `lockForApproval` | CAS `WHERE status='pending'` | safe |
| Payout `UpsertPayout` | `ON CONFLICT DO NOTHING` | safe for double-cron; no recompute |
| `crm_payouts.MarkPaid` | CAS `WHERE status IN ('pending','processing')` | safe state, broken audit (HIGH-C4) |

## Wallet topup vs booking-pay race (Check 12)
Both paths take `SELECT … FOR UPDATE` on the same `wallets` row inside their respective transactions (`wallet/repository.go:128`). Postgres serialises them — the second tx waits for the first to commit, then sees the new `balance_paise`. CHECK ≥ 0 on `wallets.balance_paise` is enforced atomically inside that lock. **No negative-balance race.**

## Reconciliation answer (Check 8)
- Cashfree-settlement vs payments reconciliation cron: **none.**
- `payments.reconciled` flipped to TRUE for Cashfree rows: **never** (only wallet rows self-flag at insert).
- `MarkReconciled` / `UnreconciledCount` callers: **zero**.
- `cmd/crm-integrity` is internal SUM check only, not vs Cashfree, not on a schedule.
- **Blast radius of one dropped Cashfree webhook: unbounded** — no auto-detection.

---

## Top 5 (ranked)
1. **CRITICAL-C2** — no Cashfree reconciliation exists; `payments.reconciled` is a dead column. Ship a daily settlement-recon cron before launch.
2. **CRITICAL-C1** — engine `payouts` rows are unreachable from CRM (`crm_payouts` vs `payouts` table split); ship the missing Mark-Paid handler against the engine table.
3. **CRITICAL-C3** — no UNIQUE / row-lock between `findReusableCashfreeOrder` and `openCashfreeOrder`; double-tap can double-charge. Add partial UNIQUE on `payments(booking_id) WHERE gateway_status='pending'`.
4. **HIGH-C5** — webhook handler 200-on-error silently drops events; combined with C2 = permanent ledger gaps. Return 503 or write a `webhook_failures` row in a separate tx.
5. **HIGH-C7** — `admin_pro_deductions` never aggregated; `UpsertPayout` hardcodes `deductions_paise=0`. Every deduction filed today goes uncollected.
