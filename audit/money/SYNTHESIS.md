# Money Flow Audit — Synthesis

**Audit date:** 2026-05-21
**Branch audited:** `feature/money-flow-audit-2026-05-21`, cut from `develop@f228adb`
**Inputs:** `FLOW_MAP.md`, `findings-units.md` (Subagent A), `trace-scenarios.md` (Subagent B), `findings-idempotency.md` (Subagent C), `findings-math.md` (Subagent D)

> **Branch context (important).** FLOW_MAP §3.5 and §1.4 reference `internal/crm/payroll/payroll.go` (Mark-Paid / Mark-Failed / Recompute) and migrations 109/110. **None of those exist on `develop` or on this audit branch.** They live on the unmerged `feature/payroll-targets-flags`. Several findings below derive directly from this gap: code on the deployable branch writes payroll rows into a table the CRM cannot read or update.

---

## Launch blockers (pre-pilot must-fix)

Anything in this section can lose customer or pro money in the 5-pro pilot or block founders from running the back-office.

### LB-1 — Pro-side mid-service cancel leaves customer paid + no refund row
- `App/househelp-api/internal/shift/service.go:361-398` calls `MarkBookingCancelled` (`shift/repository.go:756-764`), which is a bare `UPDATE bookings SET status='cancelled'`. No status guard, no `pending_refunds` INSERT, no payment-state check.
- Effect: customer's ₹500 stays `payment_status='paid'` forever with no refund row. Customer-facing list still shows it as paid. Only manual support intervention recovers the money.
- Race compounds the loss (`trace-scenarios.md` B-6): webhook arriving after pro-cancel still flips `payment_status='paid'` because the webhook does not check `bookings.status`.
- **Fix:** route every pro-cancel through `CancelBookingWithFee` (which already gates the refund insert), or insert a separate `pending_refunds` row from `shift/service.go` in the same tx.

### LB-2 — Chargeback rail is fully absent (handler + clawback + reconciliation)
Three connected gaps; together they make any successful chargeback an unbounded silent loss.
- **No handler.** `App/househelp-api/internal/payments/handler.go:886-987 dispatchCashfreeEventTx` only switches on `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`. Chargeback/dispute events fall into `default:` and are 200'd (`trace-scenarios.md` B-7).
- **No clawback mechanism.** Cannot debit `wallets.balance_paise` below 0 (`migrations/067_wallets.up.sql:15` CHECK), no negative `admin_pro_deductions`, no clawback `payouts` row (`trace-scenarios.md` B-8). Once funds wired to pro, our books cannot reflect a reversal.
- **No settlement reconciliation.** `payments.reconciled` column is dead (`findings-idempotency.md` C-2). `MarkReconciled`/`UnreconciledCount` in `internal/payments/ledger.go:125-172` are zero-callers. `cmd/crm-integrity/main.go` does internal SUM only, not vs Cashfree.
- **Fix:** at minimum, add a `DISPUTE_CREATED` / `CHARGEBACK_*` switch arm that writes a `pending_refunds`-style row + alerts. Build a nightly settlement-recon job that compares Cashfree settled balance to `sum(payments.gateway_status='success')` minus `sum(refunds processed/settled)`. Pilot can accept lack of clawback as acceptable risk for 5 pros, but must surface the loss within 24 h.

### LB-3 — Payroll cron writes to `payouts`; CRM Mark-Paid writes to `crm_payouts`
- Cron `App/househelp-api/internal/payroll/repository.go:86-108` inserts into `payouts` (schema `migrations/108_payroll_engine.up.sql:51-84`).
- CRM Mark-Paid handler `App/househelp-api/internal/crm/payouts/payouts.go:106-116` UPDATEs `crm_payouts`. Disjoint table. (`findings-idempotency.md` C-1, `trace-scenarios.md` B-3.)
- Effect: on May 16, cron writes 5 `payouts` rows for the pilot pros; founder opens the CRM Payouts page (which reads `crm_payouts`) and sees zero. Either every payout is manual DB work, or rows sit forever in `pending_manual_payout`.
- **Fix:** either merge `feature/payroll-targets-flags` (which is where the missing handler lives) into develop before pilot, or temporarily ship a thin handler on develop that flips `payouts.status` via CAS + audit log.

### LB-4 — `shift_sessions.job_minutes` is never written; bonus rail is dead at runtime
- Payroll reads `job_minutes` (`payroll/repository.go:63`) but no Go code ever increments it. Migration default is 0 (`trace-scenarios.md` B-1).
- Effect: `BonusPayPaise = 0` for every pro every cycle. Pros only earn the online-rate base. The brief's expected ₹113.33 (60 online + 25 working min at ₹80/hr each) becomes ₹80 in reality.
- **Fix:** identify when a session should accrue job time (booking start → complete) and `UPDATE shift_sessions SET job_minutes = job_minutes + $minutes` in the same tx as `CompleteBooking` / `MarkBookingCancelled` (whichever ends the work).

### LB-5 — Promotions admin can mint free-booking coupons
- `App/househelp-api/internal/crm/promos/promos.go:164-189` only checks `DiscountValue <= 0`. No upper bound for percent (must be ≤ 100) and no INT32-paise cap for fixed (`findings-math.md` C-1).
- Apply path `App/househelp-api/internal/booking/service.go:443` clamps net at 0 (`:447-449`), so over-discount cannot go negative — but it can zero every booking until `max_uses` runs out.
- Worked example: admin types `discount_type='percent', discount_value=10000` (meant 10). Every redemption is free. Or `discount_value=200` meaning ₹200 off → backend applies ₹2 off → customer overcharged ₹198 silently (Subagent A C7).
- **Fix:** server-side bounds + DB CHECK constraint by `discount_type`. Optionally split column into `discount_value_percent` and `discount_value_paise`.

### LB-6 — Payment-intent race: no UNIQUE on `(booking_id, gateway_status='pending')`
- `App/househelp-api/internal/payments/handler.go:391-462`. SELECT reusable (`:496-505`) and INSERT in `openCashfreeOrder` (`:565-622`) have no row lock between them. `payments.gateway_ref` UNIQUE only kicks in after the Cashfree round trip (`findings-idempotency.md` C-3).
- Double-tap Pay on flaky network: two Cashfree orders, two `payments` rows with distinct `gateway_ref`, two PaymentSheets succeed → double-charge.
- **Fix:** `CREATE UNIQUE INDEX … ON payments(booking_id) WHERE booking_id IS NOT NULL AND gateway_status = 'pending'` (forward-only migration) and let the INSERT path return ErrDuplicate which the handler maps to the reuse path.

### LB-7 — Cycle-close cron at 01:00 IST drops late-night sessions from both cycles
- `App/househelp-api/internal/payroll/calc.go:111-127` fires `NextCloseAfter` at 01:00 IST on day 15 / EOM. Aggregation filters `offline_at IS NOT NULL` AND `sc.shift_date BETWEEN cycle_start AND cycle_end` (`findings-math.md` H-5).
- Worked case (amended per REVIEW.md): pro online 22:00 on 2026-05-14 to 02:00 on 2026-05-15. `shift_date = 2026-05-14` (belongs to cycle 1..15). Cron fires 01:00 on 2026-05-15 while the session is still open → excluded by `offline_at IS NOT NULL`. Session closes at 02:00 → no re-run; `UpsertPayout` is `ON CONFLICT DO NOTHING` so the cycle row isn't amended. Minutes lost forever.
- **Fix:** fire cron at 01:00 IST on day **after** close (day 16 and day-1-of-next-month), OR run after the 03:00 IST shift-cutoff sweeper that auto-closes dangling sessions.

### LB-8 — CRM Payouts page renders ₹NaN; admin approves bank wires from memory
- Backend Go struct `App/househelp-api/internal/crm/payouts/payouts.go:28,40` json-tags `amount_paise`; frontend `App/zopmop-crm/src/api/all.ts:298,303` reads `amount_cents` (`findings-units.md` C-3).
- Effect: every row shows "₹NaN"; Mark-Paid confirm modal says "₹NaN → Aditya Rohilla". Founder approves wire without UI-side amount.
- Same drift breaks the Dashboard Revenue Today KPI and the Revenue 7d chart (`findings-units.md` C-1, C-2).
- **Fix:** rename TS fields to `_paise` (`api/all.ts:298,303`, `api/dashboard.ts:6,21`). One-line per field.

### LB-9 — Webhook handler 200-on-internal-error silently drops events
- `App/househelp-api/internal/payments/handler.go:857-870` returns 200 on internal failure with a misleading inline comment that says "Cashfree will retry the same event_id" — Cashfree only retries non-2xx (`findings-idempotency.md` HIGH-C5).
- Combined with LB-2 (no reconciliation), one transient DB error = permanent ledger gap. Customer paid Cashfree but our DB says `payments.gateway_status='pending'` forever.
- **Fix:** return 503 on transient DB errors so Cashfree retries; or write a `webhook_failures` row in a separate tx for ops visibility.

---

## High — fix before scale (post-pilot)

### H-A. `admin_pro_deductions` never aggregated into `payouts.deductions_paise`
- `UpsertPayout` hardcodes `0` (`App/househelp-api/internal/payroll/repository.go:95`). `admin_pro_deductions` is write-only via `App/househelp-api/internal/crm/workers/repository.go:602-628`; no SELECT against it from the payroll engine (`findings-idempotency.md` HIGH-C7, `findings-math.md` M-7, `trace-scenarios.md` B-2).
- Admin files ₹500 damage deduction; cron pays full gross; founder must remember to net it down by hand. With 5 pros that is survivable; at 50 it is not.

### H-B. Pro paid online-rate for time spent on a booking they cancelled mid-service
- `trace-scenarios.md` B-5. Customer-side loss (LB-1) compounded with pro-side gain. Two-sided drift on the same event.
- **Fix:** include cancelled-bookings minutes as a deduction during payroll aggregation, OR set `shift_sessions.job_minutes -= cancelled_minutes` during pro-cancel.

### H-C. Surge multiplier truncates fractional paise
- `App/househelp-api/internal/booking/service.go:428` — `int(float64(totalPriceCents) * surgeMultiplier)`. Always rounds toward zero. ~0.25p avg loss × 10k surge bookings/day = ~₹9 k/yr (`findings-math.md` H-2, `findings-units.md` H2). Negligible at pilot scale, worth fixing before scale.

### H-D. Percent promo truncates after multiply (system favored)
- `App/househelp-api/internal/booking/service.go:443` — customer overpays by up to 99 paise per redemption (`findings-math.md` H-3). Opposite direction from H-C.

### H-E. Stack rules schema shipped but no code applies them
- `App/househelp-api/migrations/086_stack_rules.up.sql` + `migrations/090_extend_booking_services.up.sql` (`applied_stack_rule_id`). Grep across `internal/` returns zero references outside migrations and tests (`findings-math.md` H-4).
- If any admin has created stack rules expecting them to apply, customers were overcharged. **Verify production `stack_rules` table is empty before pilot.**

### H-F. Cancellation fee stamped on COD/unpaid bookings — display fiction
- Unconditional stamp site is `App/househelp-api/internal/booking/repository.go:246` (`cancellation_fee_cents = $5`); refund-insert gate at `:262-285` is correctly `payment_status`-aware. The stamp itself runs regardless of payment state, so COD bookings carry a fee row but never trigger a refund (`findings-math.md` C-3, amended by REVIEW.md).
- Pro side: `App/zopmop-app/src/utils/proBookingCancel.ts:17,21` (hardcoded `BASE_RATE_PER_HOUR=80`, drift risk). The penalty estimator shows what is **deducted from** pro pay (not paid to them) — the M-δ drift risk remains, but the "pro paid the fee" framing was incorrect and is removed here.
- **Fix:** gate the UPDATE on `payment_status='paid'`.

### H-G. Cart-screen total is client-computed; server can re-price (surge) before booking creation
- `App/zopmop-app/src/screens/main/CartScreen.tsx:136` adds `PLATFORM_FEE_CENTS = 2000` locally (`:53`). Server reads `pricing_config.BaseFeeCents` from config + may apply surge. Payment screen later shows server number, but user already tapped "Pay" against the client number (`trace-scenarios.md` B-10, `findings-units.md` H5).

### H-H. ProMoneyScreen `Math.round(p/100)` loses up to 99 paise per display
- `App/zopmop-app/src/screens/pro/ProMoneyScreen.tsx:26-27`. CRM `formatRupeesExact` shows 2 decimals on bulk admin. Pro reads "₹126", founder pays "₹125.50" → cycle-end dispute (`findings-math.md` C-2, `findings-units.md` M6).

### H-I. Cashfree webhook never asserts `payment_amount` matches local `amount_paise - discount_paise`
- `App/househelp-api/internal/payments/handler.go:754,760,768` decodes the float but never compares. Defense-in-depth gap; today blocked by upstream order-creation contract, but adding the assertion costs ~5 lines and would catch any future capture-flow drift (`findings-units.md` C8).

### H-J. INT32 paise column cluster: `cart_items.price_cents`, `service_categories.base_price_cents`/`mrp_cents`, `bookings.cancellation_fee_paise`, `booking_cancellations.penalty_amount_paise`, `absence_records.cash_deducted_paise`, `promotions.discount_value`/`min_order_cents`
- Ceiling ≈ ₹21 474 836.47. Pattern-drift relative to BIGINT `_paise` siblings (`service_variants`, `bundles`). Off-by-100 misnomer (`_cents` actually paise) compounds risk during future renames (`findings-units.md` H1, C4-C7, `findings-math.md` H-1). Forward-only widening migration required.

---

## Medium — defer with rationale

### M-α. Wallet-paid bookings are the only `payments` rows that self-flag `reconciled=TRUE`
- `App/househelp-api/internal/booking/service.go:233-234`. Cashfree rows never flip. The reconciliation cron (LB-2) must learn to flip them.

### M-β. `crm_payouts.MarkPaid` audit log records "payout.paid" even on no-op CAS
- `App/househelp-api/internal/crm/payouts/payouts.go:106-116,170-179` (`findings-idempotency.md` HIGH-C4). State stays safe; audit log lies. Once LB-3 fixed against the engine `payouts` table this code stops mattering, but the new handler must avoid the same trap.

### M-γ. RN money-display layer is 30+ inline `(p/100).toFixed(0|2)` sites; no central helper
- Same paise value renders as different rupees depending on screen (`findings-units.md` M6, `findings-math.md` C-2). Defer until centralised `App/zopmop-app/src/utils/money.ts` is built; mirror CRM `lib/formatters.ts`.

### M-δ. Frontend constants drift: `PLATFORM_FEE_CENTS = 2000`, `BASE_RATE_PER_HOUR = 80` hardcoded in RN; backend has its own
- `App/zopmop-app/src/screens/main/CartScreen.tsx:53` and `App/zopmop-app/src/utils/proBookingCancel.ts:17` (`findings-units.md` H4, H5; `findings-math.md` M-5, M-6). One config endpoint surfaces both.

### M-ε. `CASHFREE_PG_ENV` default → sandbox
- `App/househelp-api/internal/payments/cashfree.go:88-91`. A misconfigured Railway deploy silently runs all checkouts against sandbox; sandbox webhooks flip `payment_status='paid'` — system thinks money was collected (`findings-math.md` M-3). Pre-launch checklist must verify the env var on every deploy.

### M-ζ. Float64 paise→rupees round-trip negligible but non-zero
- Math is exact for paise ≤ 2^53. Single `paiseToRupees` site is benign. Documented for completeness (`findings-units.md` M1, `findings-math.md` M-2).

### M-η. Per-booking earnings (`booking/earnings.go:42-66`) vs payroll engine rounding diverge
- `math.Round` half-up at booking-complete vs integer truncation in payroll. Sum of `bookings.pro_earnings_paise` will systematically differ from `payouts.gross_pay_paise` (`findings-units.md` M4). Document the policy; pick one rule pre-scale.

### M-θ. `processed_webhook_events` has no TTL
- `App/househelp-api/migrations/057_processed_webhook_events.up.sql`. ~30 MB/yr. Not a money risk; ops housekeeping.

### M-N1. `openCashfreeOrder` leaves orphan `payments` rows on gateway failure (REVIEW.md N-1)
- `App/househelp-api/internal/payments/handler.go:566` writes `payments` BEFORE the gateway call at `:578`. If `CreateOrder` returns network/5xx, the payments row stays `gateway_status='pending'`, `gateway_ref=NULL`. The reuse path (`:496-505`) requires `cashfree_orders.expires_at > NOW()` from a row that was never written → orphan never re-used. Each retry creates yet another orphan.
- Not money-loss, but inflates `unreconciled_count` noise and complicates LB-2 reconciliation.

### H-N2. `findReusableCashfreeOrder` ignores `payments.amount_paise` drift (REVIEW.md N-2 — HIGH)
- `App/househelp-api/internal/payments/handler.go:496-505` reuses a pending Cashfree order based on `cashfree_orders.expires_at`. It returns the stale `p.amount_paise` from when the pending order was first created. If `bookings.amount_paise` changes between attempts (promo applied/removed, admin edit), the reuse path silently charges the old amount.
- Compounds with LB-5 (unbounded promo discount can change net mid-flight) and LB-6 (race).
- **Fix:** during reuse, compare `cashfree_orders.amount_paise` against current `bookings.amount_paise - discount_paise`. If different, void the pending Cashfree order and open a fresh one.

### M-N3. Wallet topup PAYMENT_SUCCESS with nil wallet service silently no-credits (REVIEW.md N-3)
- `App/househelp-api/internal/payments/handler.go:947-951` calls `h.wallet.CreditTx(...)` for topups; `:952` fallback when `h.wallet == nil` logs a warning and continues. Customer paid Cashfree, ledger says success, balance unchanged.
- Risk surface depends on whether `h.wallet` is ever nil in production wiring. Pre-pilot: confirm wallet service is non-nil in the prod boot sequence; if so, demote to documentation-only.

### L-N4. `payroll/repository.go:65` join silently drops legacy NULL-commitment sessions (REVIEW.md N-4)
- `JOIN shift_commitments sc ON sc.id = ss.commitment_id` excludes any `shift_sessions` with `commitment_id IS NULL`. Migration 098 makes it `NOT NULL` going forward, but pre-098 rows (if any) silently vanish from payroll. Verify with `SELECT COUNT(*) FROM shift_sessions WHERE commitment_id IS NULL` against prod.

### M-ι. First four pro-side mid-service cancels per 30 days incur no penalty
- `App/househelp-api/internal/shift/service.go:378-381` `StrikeThreshold = 5`. Pro can cancel four customers mid-service for free; customer loss from LB-1 stays uncompensated.

### M-κ. CartScreen `Math.ceil` split display ≠ backend `floor + remainder`
- Frontend `App/zopmop-app/src/screens/main/CartScreen.tsx:137`; backend `App/househelp-api/internal/roomies/service.go:526-528`. Display-only mismatch today (1 paise per non-initiator). If client ever sends `myShareCents` instead of `totalCents`, becomes a real overcharge (`findings-units.md` H3, `findings-math.md` M-4).

---

## Reconciliation gaps (pre-scale, not pre-pilot)

These are missing automated checks. With 5 pilot pros, manual eyeballing is acceptable. Before opening to ≥ 50 pros they must be automated.

1. **Cashfree settlement ↔ payments**: nightly job that compares Cashfree merchant-balance settled amounts to `SUM(payments.amount_paise) WHERE gateway_status='success'` minus `SUM(refunds processed/settled)`. Sets `payments.reconciled=TRUE` per settled row. (LB-2.)
2. **Booking row sanity**: every `bookings.payment_status='paid'` should have exactly one `payments.gateway_status='success'`. Sweeper detects orphans.
3. **Cancelled-paid orphans**: every `bookings.status='cancelled' AND payment_status='paid'` should have a `pending_refunds` row in some status. Sweeper detects orphans (LB-1, B-6).
4. **Wallet ledger integrity**: `SUM(wallet_transactions.amount_paise) per user == wallets.balance_paise`. Daily cron + alert on drift.
5. **Pro pay vs deductions**: `payouts.net_pay_paise == gross_pay_paise - sum(admin_pro_deductions.amount_paise per pro per cycle)`. Cannot hold today (LB-3, H-A) because deductions aren't aggregated; reconciliation cron should refuse to mark "fully paid" until both sides reconcile.
6. **Cashfree event coverage**: alert when a webhook lands with an unknown `eventType` (LB-2). Today silently logged at info.
7. **Cycle-close session sweep**: at cron fire, count open `shift_sessions` (`offline_at IS NULL`). Force-close at 03:00 IST cutoff and re-bucket into the correct cycle (LB-7).
8. **Promotion redemptions**: log every promo apply with `(promo_id, discount_paise_applied, total_paise, user_id)`. Alert if any single discount > ₹1 000 or > 50 % of total (LB-5).

---

## Acceptable risk for 5-pro pilot (defer list)

For each, the rationale matters more than the deferral.

- **A.1 — `admin_pro_deductions` not aggregated (H-A)**. Founder personally wires the 5 pros every fortnight; manual subtraction is feasible. Re-evaluate before pilot #2.
- **A.2 — Surge / promo truncation (H-C, H-D)**. Surge off in pilot; promo amounts capped manually. Defer.
- **A.3 — Stack rules (H-E)**. Verify `SELECT count(*) FROM stack_rules` = 0 before pilot. If admin never creates a row, no overcharge possible.
- **A.4 — Cashfree env (M-ε)**. Add pre-flight Railway env-var check to release runbook; defer the panic-on-mismatch code change.
- **A.5 — Constants drift (M-δ)**. Don't change `pricing_config.BaseFeeCents` or `BaseRatePaisePerHour` during pilot. Lock both via release runbook.
- ~~**A.6 — Payments-intent race (LB-6)**. Pilot users are 5 friends; instruct them not to double-tap Pay.~~ **PROMOTED to launch-blocker per REVIEW.md §4 quibble.** RN's Cashfree Drop SDK can produce double order-creates without user error (network retry on the order-create POST, app foreground/background race). The partial unique index is a one-line forward-only migration — there is no rationale to defer it.
- **A.7 — Clawback (sub-point of LB-2)**. Pilot card-payment value ≤ ₹5 000/booking × 50 bookings = ₹2.5L total exposure. Worst-case chargeback in pilot: founder eats it.
- **A.8 — RN money-display centralization (M-γ)**. Will fix in v2; not money-loss, only customer perception.

---

## Top 10 — ranked by financial impact × probability

| # | ID | Severity | Scenario in plain English | Recommended fix |
|---|---|---|---|---|
| 1 | LB-1 | CRITICAL | Pro cancels mid-service. Customer's ₹500 never refunded; no row exists for support to action. Every pro-cancel in pilot = customer loss. | Route pro-cancel through `CancelBookingWithFee` or insert `pending_refunds` row in `shift/service.go`. |
| 2 | LB-4 | CRITICAL | `shift_sessions.job_minutes` never written. Every pro paid only the online base rate; bonus rail is dead. Pros underpaid every cycle. | Write `job_minutes` during booking start/complete; backfill on cancel. |
| 3 | LB-3 | CRITICAL | Cron writes `payouts` rows; CRM cannot mark them paid. Either rows sit forever in `pending_manual_payout`, or founder does raw SQL. | Merge `feature/payroll-targets-flags` to develop OR ship a thin Mark-Paid handler against the engine `payouts` table on develop. |
| 4 | LB-5 | CRITICAL | One admin typo on promo `discount_value` (e.g. `200` instead of `2`, or `10000` instead of `10`) → every redemption is free. | Server-side bounds + DB CHECK by `discount_type`; ideally split into two columns. |
| 5 | LB-2 | CRITICAL | Chargeback at Cashfree → silent. Webhook 200's it, no clawback exists, no reconciliation cron compares settlement to DB. Loss invisible until manual dashboard check. | Add chargeback switch arm; nightly settlement reconciliation; alert on Cashfree settled vs DB drift. |
| 6 | LB-9 | HIGH | Webhook 200-on-error swallows transient DB failures. Customer paid at Cashfree, our DB stuck at `pending` forever, no auto-detect. | Return 503 on transient DB error; write `webhook_failures` row in a separate tx. |
| 7 | LB-7 | HIGH | Cron at 01:00 IST drops sessions still open at 01:00 on the close day; their `shift_date` belongs to the closing cycle so they never re-appear. Pro silently loses up to one shift's pay. | Fire cron at 01:00 on day-after-close, OR run after 03:00 IST shift-cutoff sweep. |
| 8 | LB-6 | HIGH | Double-tap Pay on flaky network creates two Cashfree orders → two `payments` rows → double-charge. UNIQUE on `gateway_ref` is too late. | Partial UNIQUE INDEX on `payments(booking_id) WHERE gateway_status='pending'`. |
| 9 | LB-8 | HIGH | CRM Payouts page renders ₹NaN. Admin approves manual bank wires without seeing the amount in the UI. | Rename TS fields `amount_cents` → `amount_paise` (`api/all.ts:298,303`; `api/dashboard.ts:6,21`). |
| 10 | H-G | HIGH | Cart shows local-computed total. Server applies surge / different fee; user already tapped "Pay" on the lower number. | Always round-trip a `quote` call before opening Cashfree sheet; render server number on cart "Total" too. |
| 11 | H-N2 | HIGH (new, REVIEW) | Reused pending Cashfree order locks in the **old** `amount_paise`. If booking amount changes (promo applied/removed, admin edit) between attempts, customer is charged the stale number. | On reuse, compare cashfree_orders.amount_paise to current `bookings.amount_paise - discount_paise`; void + re-open if different. |

---

## Open questions for the founder

1. Is `feature/payroll-targets-flags` (migrations 109/110, `internal/crm/payroll/payroll.go`) intended to merge before pilot? If yes, LB-3 dissolves; the rest of the audit findings still hold for develop tip.
2. Is Cashfree Payouts integration on the roadmap, or will pro payouts stay manual indefinitely? If manual, the "manual wire actually executed" reconciliation must be added (M-α + LB-2 footnote).
3. What is the pilot's planned promotion behaviour? If no promo codes shipped to pilot users, LB-5 can move to M-tier.
4. Does the pilot run with `pricing_config.SurgeEnabled=false`? If so H-C, H-G can be deferred. If on, LB-tier.
5. Cashfree dispute webhook payload structure — do we already know the exact `eventType` strings (`DISPUTE_CREATED`, `CHARGEBACK_*`) to wire into the handler, or do we need a sandbox dispute to discover them?
6. GST/tax compliance (Subagent A L4): is the ZopMop entity already > ₹20 L/yr turnover, requiring GST capture? If yes, this is a separate compliance project, out of scope here.

---

## Acceptance criteria for "money flow audit passed"

Pilot can launch when:
- LB-1, LB-3, LB-4, LB-5, **LB-6** fixed in code on `develop` (LB-6 promoted from defer per REVIEW.md).
- LB-2 partial: chargeback webhook handler + manual-only reconciliation runbook (full automation deferred to scale).
- LB-7 worked around: cron schedule moved or session-sweep guaranteed before cron fire.
- LB-8 fixed: CRM payouts UI renders rupees correctly.
- LB-9 fixed OR runbook + alerting that catches stuck `pending` payment rows within 1 h.
- H-N2 (new): pending-order reuse must re-check `amount_paise` against current booking.

Everything in **High** can stay in v1.5 backlog. Everything in **Medium** documented for v2.

---

## Review pass — what the independent money-reviewer found

A second-stage reviewer (fresh context) re-ran each of the three traces from scratch and re-verified every Top-10 file:line citation. Outcome (full text in `REVIEW.md`):

- **Confirmed:** all 10 launch blockers + every HIGH spot-checked, plus M-α and M-ε.
- **Refuted:** none.
- **Amended (incorporated above):**
  - LB-7 worked example date arithmetic corrected (pro online 22:00 day 14 → offline 02:00 day 15, cron fires 01:00 day 15).
  - H-F citation block moved from `:262-285` (refund gate) to `:246` (unconditional stamp). Pro-side framing inverted; corrected.
  - LB-9 — the misleading comment lives in code at `handler.go:866-868`, not in the audit framing.
- **New findings (added above):** M-N1 (orphan payments rows), H-N2 (stale amount on Cashfree-order reuse — added to Top 10 as row 11), M-N3 (nil-wallet topup no-credit), L-N4 (legacy NULL-commitment shift sessions dropped from payroll).
- **Quibble that became material:** A.6 (deferring LB-6) is unsafe; LB-6 promoted to launch-blocker. A.3 (stack rules check) needs explicit `WHERE is_active = TRUE` clause in the runbook.

End of SYNTHESIS.
