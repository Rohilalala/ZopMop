# Money Flow Map — ZopMop

**Audit date:** 2026-05-21
**Branch built on:** develop
**Scope:** every place rupees enter, transform, are stored, or leave the system, plus the cron and external APIs that touch them.

This map is the foundation for the four Phase 1 subagents. Every claim is cited file:line so subagents can verify directly.

---

## 0. Money flow at a glance

```
 customer wallet (cash) ──▶ Cashfree PG ──▶ payments.amount_paise
                                              │
                                              ▼
                                      booking.amount_paise
                                              │
                            ┌─────────────────┼─────────────────┐
                            ▼                 ▼                 ▼
                booking_services.price_paise   pending_refunds   wallet_transactions (spend / refund_credit)
                            │                 │                       │
                            ▼                 ▼                       ▼
                shift_sessions.online_minutes  Cashfree refund   wallets.balance_paise
                            │                 │
                            ▼                 │
                       PAYROLL CRON           │
                            │                 │
                            ▼                 │
              payouts.gross_pay_paise         │
                            │                 │
                            ▼                 │
              payouts.net_pay_paise   ◀───── admin_pro_deductions.amount_paise
                            │
                            ▼
                  CRM admin "mark-paid"
                            │
                            ▼
              manual bank wire → pro UPI/account (no Cashfree Payouts integration; manual)
```

**Settlement to ZopMop bank**: Cashfree settles into our merchant bank account on T+1/T+2 — outside this codebase, no reconciliation job today.

---

## 1. Money entry points

### 1.1 Customer pays for a booking
- Instant booking POST `/api/v1/bookings` → `App/househelp-api/internal/booking/service.go:391`
- Scheduled booking → `App/househelp-api/internal/booking/service.go:976` (`CreateScheduledBooking`)
- Cart instant booking → `App/househelp-api/internal/booking/service.go:1165`
- Direct-pay funnel: customer hits POST `/api/v1/payments/cashfree/order` → `App/househelp-api/internal/payments/handler.go:391` (`createCashfreeOrderForBooking`)
- Mobile entry: `App/zopmop-app/src/screens/main/PaymentScreen.tsx:114` calls `createCashfreeOrder()` in `App/zopmop-app/src/api/payments.ts:72-90`
- Cashfree SDK opens checkout: `App/zopmop-app/src/hooks/useCashfreePayment.ts:1-250`

### 1.2 Wallet top-up
- Customer enters rupees: `App/zopmop-app/src/screens/main/WalletTopupSheet.tsx:56-109` (input field at :190, `amountPaise = parsedRupees * 100` at :95)
- Server: `App/househelp-api/internal/payments/handler.go:465-484` (same Cashfree flow with `booking_id=null`)
- Bounds: `App/househelp-api/internal/payments/handler.go:327-329` — 100 ≤ paise ≤ 500 000 (₹1–₹5 000)

### 1.3 Refund credit back to wallet
- `App/househelp-api/internal/crm/refunds/refunds.go:638-688` (refund approval crediting wallet rail)

### 1.4 Manual admin actions touching money
- Mark-paid: `App/househelp-api/internal/crm/payroll/payroll.go:230-269`
- Mark-failed: `App/househelp-api/internal/crm/payroll/payroll.go:273-314`
- Recompute payout: `App/househelp-api/internal/crm/payroll/payroll.go:320-362`
- Add admin deduction: schema `App/househelp-api/migrations/103_admin_pro_deductions.up.sql:11` (`amount_paise BIGINT CHECK > 0`)
- Promo creation: `App/zopmop-crm/src/pages/PromosPage.tsx:160-164` (`Min order (₹ × 100)` field — admin types paise directly)
- Refund approve / reject: `App/househelp-api/internal/crm/refunds/refunds.go:241-253` and `:615-750`

---

## 2. Money calculation points

### 2.1 Booking price
- Instant single-service: `App/househelp-api/internal/booking/service.go:426-429`
  - `total = basePriceCents + BaseFeeCents`
  - Surge: `if SurgeEnabled && multiplier > 1.0: total = int(float64(total) * multiplier)`
- Cart-based scheduled: `App/househelp-api/internal/booking/service.go:1074-1084`
  - `total = sum(cart_items.price_cents) + BaseFeeCents` (no surge)
- Cart-based instant: `App/househelp-api/internal/booking/service.go:1216-1225` (no surge)

### 2.2 Discount / promo
- `App/househelp-api/internal/booking/service.go:431-450`
  - Percent: `discountCents = totalPriceCents * promoValue / 100`
  - Fixed: `discountCents = promoValue`
  - Clamped to `≤ totalPriceCents`

### 2.3 Net amount customer pays
- `App/househelp-api/internal/booking/service.go:490`
  - `netPaise = totalPriceCents - discountCents`

### 2.4 Stack discount rules (multi-service)
- `App/househelp-api/migrations/086_stack_rules.up.sql` — `discount_percent NUMERIC(5,2)` capped at 50, optional `max_discount_paise`, gated by `min_subtotal_paise`
- Application code: search `applied_stack_rule_id` users in `App/househelp-api/internal/booking/*`

### 2.5 Cancellation fee
- `App/househelp-api/internal/booking/service.go:605-626` — `feeCents = DefaultCancellationFeeCents` (10 000 paise = ₹100) if `now ≥ scheduled_time − 30 min`, else 0
- Refund amount: `App/househelp-api/internal/booking/repository.go:264` — `refundAmount = priceCents - discountCents - feeCents`

### 2.6 Cashfree paise→rupees conversion (outbound)
- `App/househelp-api/internal/payments/cashfree.go:491-493` — `float64(paise) / 100.0`
- Body sent to Cashfree at `App/househelp-api/internal/payments/cashfree.go:252` (POST /orders) and `:147-149` (POST refunds)

### 2.7 Payroll engine
- Constants: `App/househelp-api/internal/payroll/payroll.go:20-26`
  - `BaseRatePaisePerHour = 8000` (₹80/hr)
  - `BonusRatePaisePerHour = 8000`
- Compute per pro per cycle: `App/househelp-api/internal/payroll/calc.go:79-94`
  ```
  basePayPaise   = onlineMinutes  × 8000 / 60
  bonusPayPaise  = workingMinutes × 8000 / 60
  grossPayPaise  = basePayPaise + bonusPayPaise
  netPayPaise    = grossPayPaise        (v1: deductions = 0 in calc; admin deductions applied separately)
  ```
- Aggregation: `AggregateActivity` walks `shift_sessions` (online/working minutes) per cycle (`App/househelp-api/internal/payroll/calc.go:79-94`, repository functions in `App/househelp-api/internal/payroll/repository.go`)
- Cycle boundaries: `App/househelp-api/internal/payroll/calc.go:38-50` — cycle 1: 1st–15th IST, cycle 2: 16th–EOM IST
- Run gate: `App/househelp-api/internal/payroll/service.go:108-115` — only runs on cycle close day
- Orchestrator: `App/househelp-api/internal/payroll/service.go:136-208` (`RunCycle`)

### 2.8 Performance flag math (not money but adjacent)
- Hours target missed: `App/househelp-api/internal/payroll/service.go:20-41`
- Acceptance below 0.85: `App/househelp-api/internal/payroll/service.go:42-63`
- Both write to `helper_flags` (migration 110)

### 2.9 Pro earnings snapshot per booking
- Stored at completion in `bookings.pro_earnings_paise` (migration 101_job_lifecycle.up.sql:27)
- Surfaced to pro app: `App/zopmop-app/src/screens/pro/JobDetailScreen.tsx:250, 483`

### 2.10 Split-cart "my share"
- `App/zopmop-app/src/screens/main/CartScreen.tsx:137` — `myShareCents = Math.ceil(totalCents / splitCount)` (rounding bug suspect — flagged for Subagent D)

### 2.11 Frontend rupee↔paise conversions
- Centralized helpers:
  - CRM: `App/zopmop-crm/src/lib/formatters.ts:8-21` (`formatRupees`, `formatRupeesExact`)
  - RN: `App/zopmop-app/src/screens/pro/ProMoneyScreen.tsx:26-27` (`paiseToRupees`)
  - RN: `App/zopmop-app/src/screens/main/WalletScreen.tsx:347-355` (`formatRupees` local)
- Inline `(value / 100)` and `* 100` scattered across ~96 sites — Subagent A enumerates.

---

## 3. Money storage — DB columns

(See `Subagent A — Units` for full type/unit audit; this is the column inventory.)

### 3.1 Bookings & line items
| Table | Column | Type | Unit | Migration:line |
|---|---|---|---|---|
| `bookings` | `amount_paise` | BIGINT NOT NULL | paise | 065_bookings_amount_paise.up.sql:31 |
| `bookings` | `discount_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 065_bookings_amount_paise.up.sql:37 |
| `bookings` | `cancellation_fee_paise` | **INTEGER** (INT32) | paise | 048_booking_cancellation_fee.up.sql:8 ⚠ |
| `bookings` | `cancellation_fee_applied` | BOOLEAN | — | 048_booking_cancellation_fee.up.sql:7 |
| `bookings` | `payment_method` | VARCHAR(20) | enum | 046_refund_gateway.up.sql:6 |
| `bookings` | `payment_status` | VARCHAR(20) | enum | 046_refund_gateway.up.sql:8 |
| `bookings` | `payment_id` | VARCHAR(80) | gateway ref | 046_refund_gateway.up.sql:7 |
| `bookings` | `pro_earnings_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 101_job_lifecycle.up.sql:27 |
| `booking_services` | `price_paise` | BIGINT NOT NULL | paise | 090_extend_booking_services.up.sql:10 |
| `cart_items` | `price_cents` | **INTEGER** (INT32) | paise (misnomer) | 012_create_cart.up.sql:17 ⚠ |
| `booking_adjustments` | `delta_paise` | BIGINT NOT NULL | paise (±) | 088_booking_adjustments.up.sql:8 |
| `service_categories` | `base_price_cents` | **INTEGER** (INT32) | paise (misnomer) | 003_create_service_categories.up.sql:9 ⚠ |
| `service_categories` | `mrp_cents` | **INTEGER** | paise (misnomer) | 011_extend_service_categories.up.sql:12 ⚠ |
| `service_variants` | `price_paise` | BIGINT NOT NULL CHECK > 0 | paise | 084_service_variants.up.sql:8 |
| `service_variants` | `mrp_paise` | BIGINT NULL | paise | 084_service_variants.up.sql:9 |
| `bundles` | `bundle_price_paise` | BIGINT NOT NULL | paise | 085_bundles.up.sql:6 |
| `bundles` | `mrp_paise` | BIGINT NULL | paise | 085_bundles.up.sql:7 |
| `stack_rules` | `discount_percent` | NUMERIC(5,2) CHECK 0 < x ≤ 50 | percent | 086_stack_rules.up.sql:6 |
| `stack_rules` | `max_discount_paise` | BIGINT NULL | paise | 086_stack_rules.up.sql:7 |
| `stack_rules` | `min_subtotal_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 086_stack_rules.up.sql:8 |
| `promotions` | `discount_value` | INTEGER | paise OR percent (dual) | 007_create_promotions.up.sql:8 ⚠ |
| `promotions` | `min_order_cents` | INTEGER | paise (misnomer) | 007_create_promotions.up.sql:9 ⚠ |

### 3.2 Payments / Cashfree
| Table | Column | Type | Unit | Migration:line |
|---|---|---|---|---|
| `payments` | `amount_paise` | BIGINT NOT NULL CHECK ≥ 0 | paise | 056_payments.up.sql:15 |
| `payments` | `booking_id` | UUID NULLABLE | FK (null for wallet top-up) | 068_payments_nullable_booking.up.sql:16 |
| `payments` | `gateway` | TEXT NOT NULL | enum | 056_payments.up.sql |
| `payments` | `gateway_ref` | TEXT UNIQUE | dedup key | 056_payments.up.sql |
| `payments` | `gateway_status` | TEXT CHECK in (pending,success,failed,refunded) | enum | 056_payments.up.sql |
| `payments` | `reconciled` | BOOLEAN DEFAULT FALSE | — | 056_payments.up.sql |
| `cashfree_orders` | `cf_order_id` | TEXT UNIQUE | external ref | 066_cashfree_orders.up.sql |
| `cashfree_orders` | `order_id` | TEXT UNIQUE | our ref | 066_cashfree_orders.up.sql |
| `cashfree_orders` | `payment_session_id` | TEXT | SDK token | 066_cashfree_orders.up.sql |

### 3.3 Wallet
| Table | Column | Type | Unit | Migration:line |
|---|---|---|---|---|
| `wallets` | `balance_paise` | BIGINT NOT NULL DEFAULT 0 CHECK ≥ 0 | paise | 067_wallets.up.sql:15 |
| `wallet_transactions` | `amount_paise` | BIGINT NOT NULL (signed) | paise | 067_wallets.up.sql:23 |
| `wallet_transactions` | `balance_after` | BIGINT NOT NULL | paise | 067_wallets.up.sql:24 |
| `wallet_transactions` | `kind` | TEXT CHECK in (topup, spend, refund_credit, adjustment, reversal, referral_credit) | enum | 067 + 083 |

### 3.4 Refunds
| Table | Column | Type | Unit | Migration:line |
|---|---|---|---|---|
| `pending_refunds` | `amount_cents` | BIGINT CHECK > 0 | paise (misnomer) | 034_pending_refunds.up.sql:4 |
| `pending_refunds` | `partial_amount_cents` | BIGINT NULL | paise (misnomer) | 046_refund_gateway.up.sql:22 |
| `pending_refunds` | `status` | VARCHAR(20) | enum (pending, approved, processed, processed_manual, gateway_error, rejected, cancelled, failed, settled) | 034 + 046:45 |
| `pending_refunds` | `gateway_refund_id` | VARCHAR(80) | external ref | 046_refund_gateway.up.sql:17 |
| `pending_refunds` | UNIQUE `(booking_id) WHERE booking_id IS NOT NULL AND status IN (pending, approved, processed, processed_manual)` | partial unique | dedup | 046_refund_gateway.up.sql |

### 3.5 Payroll
| Table | Column | Type | Unit | Migration:line |
|---|---|---|---|---|
| `payouts` | `online_minutes` | INT NOT NULL | minutes | 108_payroll_engine.up.sql |
| `payouts` | `working_minutes` | INT NOT NULL | minutes | 108_payroll_engine.up.sql |
| `payouts` | `base_pay_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 108:66 |
| `payouts` | `work_bonus_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 108:67 |
| `payouts` | `gross_pay_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 108:68 |
| `payouts` | `deductions_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 108:69 |
| `payouts` | `net_pay_paise` | BIGINT NOT NULL DEFAULT 0 | paise | 108:70 |
| `payouts` | `status` | VARCHAR(32) CHECK in (pending_manual_payout, paid, cancelled, failed, skipped) | enum | 108:72-73, 109:27 |
| `payouts` | `transaction_id` | TEXT | UTR / bank ref | 108 |
| `payouts` | `paid_by_admin_id` | UUID FK crm_admins | — | 109:17 |
| `payouts` | UNIQUE `(pro_id, cycle_start)` | idempotency | — | 108 |
| `admin_pro_deductions` | `amount_paise` | BIGINT CHECK > 0 | paise | 103_admin_pro_deductions.up.sql:11 |
| `payout_audit_log` | `before_state` / `after_state` | JSONB | snapshot | 109_payroll_admin_audit.up.sql |
| `absence_records` | `cash_deducted_paise` | **INTEGER** (INT32) | paise | 098_shift_system.up.sql:126 ⚠ |
| `booking_cancellations` | `penalty_amount_paise` | **INTEGER** (INT32) | paise | 098_shift_system.up.sql:108 ⚠ |
| `shift_sessions` | `online_minutes`, `job_minutes` | INT | minutes | 098_shift_system.up.sql |

### 3.6 Referral credits
- `referrals` (083) — both `referrer_credited_at` and `referee_credited_at`; wallet credit value lives in code, not in this table.

### 3.7 Indexes that prevent double-spend / double-refund / double-payout
- `payments.gateway_ref` UNIQUE — Cashfree order dedup
- `pending_refunds (booking_id) WHERE booking_id IS NOT NULL AND status IN (...)` PARTIAL UNIQUE — refund dedup per booking
- `payouts (pro_id, cycle_start)` UNIQUE — payroll cycle dedup
- `cashfree_orders.cf_order_id` UNIQUE, `cashfree_orders.order_id` UNIQUE
- `referrals (referee_id)` UNIQUE — one-time signup credit
- `dispatched_jobs (pro_id, booking_id)` UNIQUE — offer dedup
- `cart_items (cart_id, variant_id)` / `(cart_id, bundle_id)` partial UNIQUE

---

## 4. Money exit points

### 4.1 To Cashfree (PG settlement)
- We don't initiate PG settlement; Cashfree wires our merchant bank account on T+1/T+2. No code in this repo.

### 4.2 To pro bank (manual)
- No Cashfree Payouts integration. CRM admin enters UTR/transaction ID via `App/zopmop-crm/src/pages/PayoutsPage.tsx:84-91` and clicks Mark-Paid → `App/househelp-api/internal/crm/payroll/payroll.go:230-269`.
- Side effect: only DB state change. The actual money transfer happens out of band (IMPS/UPI/NEFT done by founder).

### 4.3 Refund to customer
- Cashfree path: `App/househelp-api/internal/payments/cashfree.go:127-167` (`Refund(ctx, paymentID, amountPaise, method, idempotencyKey)` → POST `/orders/{order_id}/refunds`)
- Manual path: `App/househelp-api/internal/payments/manual.go:16-17` — always returns success; row marked `processed_manual`
- Wallet path: `App/househelp-api/internal/crm/refunds/refunds.go:638-688` calls wallet credit

### 4.4 Wallet debit on booking
- `App/househelp-api/internal/booking/service.go:492-505` — `payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise))`

---

## 5. Cron jobs touching money

### 5.1 Payroll cycle close (PR #20)
- Code: `App/househelp-api/internal/payroll/service.go:108-208`
- Schedule: cron driver lives in `App/househelp-api/cmd/` or `internal/cron/` (Subagent C to confirm; agents listed `RunForToday` as entry point)
- Gate: errors on non-cycle-close days
- Idempotency: `INSERT … ON CONFLICT DO NOTHING` on `(pro_id, cycle_start)` (`App/househelp-api/internal/payroll/repository.go:86-126`)

### 5.2 Pending action sweeper (refund-creating)
- `App/househelp-api/internal/booking/pending_action_sweeper.go:162-188` — auto-cancellation creates pending_refunds rows when customer doesn't respond in time

### 5.3 Absence 3 AM cron
- `App/househelp-api/migrations/098_shift_system.up.sql` describes — writes `absence_records.cash_deducted_paise` per skipped day per pro. Locate cron driver in `App/househelp-api/internal/cron/` (Subagent C).

### 5.4 Cycle hours target check at close
- Inside `RunCycle` (`App/househelp-api/internal/payroll/service.go:20-41, 42-63`) — writes `helper_flags` rows.

### 5.5 (Open question) Reconciliation
- No code found that periodically reconciles "Cashfree settled ↔ payments.gateway_status='success' ↔ wallet balances". Flagged for Subagent C.

---

## 6. External money APIs

### 6.1 Cashfree PG
- `POST /pg/orders` — `App/househelp-api/internal/payments/cashfree.go:252`
  - Body field `order_amount` is **float64 rupees** (`paiseToRupees`)
  - Currency hard-coded INR
- `POST /pg/orders/{order_id}/refunds` — `App/househelp-api/internal/payments/cashfree.go:127-167`
  - Body `refund_amount: float64 rupees`, `refund_id: "rfnd-" + idempotencyKey` (:138)
- `GET /pg/orders/{order_id}` — `App/househelp-api/internal/payments/cashfree.go:316`
- `GET /pg/orders/{order_id}/payments` — `App/househelp-api/internal/payments/cashfree.go:361`
- Webhook receiver — `App/househelp-api/internal/payments/handler.go:915-982`
  - Signature: HMAC-SHA256(secret, timestamp + rawBody), b64 (`App/househelp-api/internal/payments/cashfree.go:415-446`)
  - Replay window: 300 s (`:426-434`)
  - Dedup: `ConsumeOnceTx(ctx, db, eventID, …)` keyed on event_id (`App/househelp-api/internal/payments/handler.go:854-871`)
  - Events handled: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`
  - On dispatch error: log + 200 (avoid retry storm) — `:857-870`
- Env: `EXPO_PUBLIC_CASHFREE_ENV` (RN app), backend `CASHFREE_ENV` (sandbox/prod) — flagged for Subagent D mis-env risk.

### 6.2 Cashfree Payouts (pro bank wires)
- **Not integrated.** Pro payouts are out-of-band manual bank transfers. Mark-paid only flips DB state.

### 6.3 Any other money APIs
- None observed (no Razorpay, no Stripe, no Plaid, no PhonePe).

---

## 7. Internal money flow invariants worth verifying

For Phase 1 subagents to challenge. Each should hold; if it doesn't, that's a finding.

1. **booking.amount_paise == sum(booking_services.price_paise) for that booking** (no fees added since fees go separately? Verify in service.go.)
2. **payments.amount_paise == booking.amount_paise − booking.discount_paise** at intent creation time (`App/househelp-api/internal/payments/handler.go:391-462`).
3. **wallet_transactions sum per user == wallets.balance_paise** (append-only ledger invariant — is there a check? Subagent C.)
4. **pending_refunds.amount_cents ≤ payments.amount_paise** for that booking (no over-refund).
5. **payouts.gross_pay_paise == base_pay_paise + work_bonus_paise** every row.
6. **payouts.net_pay_paise == gross_pay_paise − deductions_paise** every row.
7. **No two pending_refunds rows for the same booking with status in (pending, approved, processed, processed_manual)** — enforced by partial UNIQUE; verify code path that flips status doesn't create dup before old row settles.
8. **One payouts row per (pro_id, cycle_start)** — enforced by UNIQUE; verify recompute doesn't create dup.
9. **Cashfree order body `order_amount` (rupees) × 100 == payments.amount_paise** — i.e. no rounding drift across the conversion.
10. **Webhook event_id seen twice → second is a no-op** — `ConsumeOnceTx` guarantee; verify rollback path.

---

## 8. Known off-pattern columns flagged before fan-out

These are pre-tagged for Subagent A and Subagent D so they don't re-discover:

- `bookings.cancellation_fee_paise` — INT32 (max ₹2.14L) — should be BIGINT
- `cart_items.price_cents` — INT32, misnomer
- `absence_records.cash_deducted_paise` — INT32
- `booking_cancellations.penalty_amount_paise` — INT32
- `service_categories.base_price_cents` — INT32, misnomer (service_variants uses BIGINT)
- `service_categories.mrp_cents` — INT32, misnomer
- `promotions.discount_value` — INT, doubles as paise OR percent depending on `discount_type`
- `promotions.min_order_cents` — INT32, misnomer
- `pending_refunds.amount_cents` / `partial_amount_cents` — BIGINT but misnamed "cents" (actually paise)
- `App/zopmop-crm/src/pages/PayoutsPage.tsx:73` references `p.amount_cents` while `Payout` interface in `App/zopmop-crm/src/api/payroll.ts:14-36` uses `_paise` fields — type/field mismatch suspect
- `App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx:794` reads `worker.earnings_30d_cents` (suspicious naming; api/users.ts:17 has explicit comment about prior `_cents` transcription bug)
- `App/zopmop-app/src/screens/main/CartScreen.tsx:137` — `myShareCents = Math.ceil(totalCents / splitCount)` — sum-of-shares > total risk
- `App/zopmop-app/src/screens/main/CartScreen.tsx:53` — `PLATFORM_FEE_CENTS = 2000` hardcoded client-side; backend has its own `BaseFeeCents` in config — drift risk
- `App/zopmop-app/src/screens/pro/ProBookingCancel.tsx:17` — `BASE_RATE_PER_HOUR = 80` hardcoded client-side; backend has `BaseRatePaisePerHour = 8000` — drift risk

---

## 9. Open structural questions

To be resolved by Phase 1/2:

1. Cron driver location and schedule expression — confirm payroll cron runs at 00:05 IST on day 16 and on day-after-EOM.
2. Whether `RunCycle` re-aggregates `admin_pro_deductions` into `payouts.deductions_paise`, or only the initial cron sets it.
3. Whether the cancellation-fee path can leave a booking with `payment_status='paid'` but no `pending_refunds` row when `refundAmount > 0` and the system is COD (gating logic in `App/househelp-api/internal/booking/repository.go:272-284`).
4. Whether `payments.reconciled = FALSE` is ever flipped to `TRUE` (i.e. is there a reconciliation job at all, or is it dead column?).
5. Behavior when Cashfree returns a payment **partial success** (rarely possible per CF docs) — does our webhook ignore? Treat as failure?
6. Behavior when a chargeback is filed at Cashfree (CF webhook `CHARGEBACK_CREATED` etc.) — any handler?
7. Are sandbox vs prod credentials separated cleanly per environment, or could a prod build hit sandbox / vice versa?

---

End of FLOW_MAP.
