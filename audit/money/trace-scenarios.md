# Money-Flow Trace Scenarios — Subagent B

**Audit date:** 2026-05-21
**Branch:** feature/money-flow-audit-2026-05-21 (cut from develop; migrations 109/110 listed in FLOW_MAP do NOT exist on this branch — the FLOW_MAP was generated against develop@HEAD which has since advanced).
**Scope:** trace one rupee end-to-end through three real scenarios. Every step cites file:line. Tags on suspicious steps: CRITICAL / HIGH / MEDIUM / LOW.

Assumptions for every scenario:
- Service price: `service_categories.base_price_cents = 50000` (₹500, despite the `_cents` misnomer this is paise — see `App/househelp-api/migrations/003_create_service_categories.up.sql:9`).
- Pricing config: `BaseFeeCents = 2000` (₹20 platform fee), `SurgeEnabled = false`, no promo.
- `totalPriceCents = 50000 + 2000 = 52000` paise (₹520).
- For the worked arithmetic in Scenario 1 we still follow the brief's ₹500 round number and use 50 000 paise as the wire amount, ignoring the fee.

Throughout, "paise" is the canonical wire unit. Every variable in Go named `*Cents` in the booking package is actually paise — see the misnomer note in `FLOW_MAP.md:159`.

---

## SCENARIO 1 — Happy path

Customer Anita pays ₹500 (50 000 paise) for a ₹500 service; pro Ravi accepts, completes; admin marks Ravi paid.

### Step 1 — App frontend builds the payment payload

- `App/zopmop-app/src/screens/main/CartScreen.tsx:136-137` builds `totalCents = subtotalCents + feeCents`. Unit: **integer paise** (despite the variable name). `subtotalCents` comes from `useCart()` which sums `cart_items.price_cents` (also paise; misnomer).
- `App/zopmop-app/src/screens/main/CartScreen.tsx:303` passes `totalCents` to the navigation params for the Payment screen.
- `App/zopmop-app/src/screens/main/PaymentScreen.tsx:99-101` reads `params.amount_paise` (correctly named at this hop) and converts to display rupees with `Math.floor(amountPaise / 100)`. Unit in memory: **int64-shaped JS number, paise**.
- `App/zopmop-app/src/screens/main/PaymentScreen.tsx:114-117` invokes `createCashfreeOrder(token, { booking_id, payment_source: 'direct' })` — the **amount is NOT in the request body**; the server re-reads it from the bookings row. Good defensive design.

> Transactional with next? No — frontend → API hop. Idempotent? Yes (the API short-circuits if a successful payment already exists or reuses a pending Cashfree order).
> Tag: **LOW** — naming inconsistency only (`totalCents` is paise).

### Step 2 — Backend creates payment + cashfree_orders row

- `App/househelp-api/internal/payments/handler.go:391-462` `createCashfreeOrderForBooking`:
  - line 407-410 — `SELECT amount_paise, COALESCE(discount_paise, 0), status FROM bookings WHERE id = $1::uuid`. Unit: **int64 paise**.
  - line 434 — `netPaise := amountPaise - discountPaise`. With ₹500 and no discount, `netPaise = 50000`.
  - line 442-444 — `findReusableCashfreeOrder` idempotency: reuse a pending Cashfree order if one exists (good, **idempotent on retry**).
  - line 449-454 — `SELECT EXISTS … gateway_status='success'` short-circuit (**idempotent**).
  - line 457 — `openCashfreeOrder(ctx, &bookingID, userID, netPaise, …)`.
- `App/househelp-api/internal/payments/handler.go:565-622` `openCashfreeOrder`:
  - line 566 — `h.ledger.CreatePayment(ctx, bookingID, userID, amountPaise, "cashfree", nil)` writes the `payments` row (`amount_paise BIGINT NOT NULL` per migration 056). Unit: **int64 paise**.
  - line 571 — `ourOrderID := "zop-" + paymentID`.
  - line 578-588 — `gateway.CreateOrder` HTTP call to Cashfree with `AmountPaise` field (converted to rupees in `cashfree.go:491-493`: `paiseToRupees(paise) = float64(paise)/100.0` — this is the **only place** integer-paise becomes float-rupees).
  - line 593-614 — `INSERT INTO cashfree_orders` + `UPDATE payments SET gateway_ref` in **one local tx** (DB-side transactional). BUT this tx wraps lines 593-614 only; the gateway call at line 578 is **OUTSIDE the tx** by design (comment at 559-564). If the gateway call succeeds and the tx fails, we have a Cashfree order with no local row — handled by idempotency (next retry re-creates a new Cashfree order; the orphan expires in 30 days).
  > Tag: **MEDIUM** — orphan Cashfree orders linger 30 days; no cleanup job. Not money-loss but ops debt.

### Step 3 — Cashfree SDK opens, customer pays

- Drop SDK opens via `App/zopmop-app/src/hooks/useCashfreePayment.ts` (referenced from `PaymentScreen.tsx:73,138`). Money moves customer → Cashfree.
- Cashfree calls our webhook → `App/househelp-api/internal/payments/handler.go:`779-873 (verifyAndDispatch).
- Webhook signature verified via HMAC-SHA256 — `App/househelp-api/internal/payments/cashfree.go:415-446` with 300 s replay window (FLOW_MAP §6.1).

### Step 4 — Webhook updates payments.gateway_status + bookings.payment_status

- `App/househelp-api/internal/payments/handler.go:854-870` — `ConsumeOnceTx(ctx, db, eventID, …)` dedupes by `eventID`. **Idempotent.**
- `App/househelp-api/internal/payments/handler.go:886-940` `dispatchCashfreeEventTx`:
  - line 894-901 — `SELECT … FROM cashfree_orders co JOIN payments p … FOR UPDATE OF p` — serializes concurrent webhook deliveries on the same `payments.id`.
  - line 920 — `UpdateStatusByGatewayRefTx(ctx, tx, paymentRef, "success", receivedAt)` flips `payments.gateway_status='success'`.
  - line 930-937 — `UPDATE bookings SET payment_status='paid', updated_at=NOW() WHERE id=$1::uuid AND payment_method='cashfree'` inside same tx.
  - line 938-940 — `emitBookingPaidEventTx` writes `event_outbox` row (durable).
- Whole block runs inside `ConsumeOnceTx` — **atomic**. If dispatch fails, the dedupe row is rolled back, so a retry from Cashfree re-enters dispatch (line 866-869 comment).
- **However**, line 869 returns 200 OK even on internal failure to avoid Cashfree retry storms. If our retry semantics break, **the only signal is the log line** at 858-863.

> Tag: **MEDIUM** — silent-200-on-error is intentional but can mask a wedged payment indefinitely. No reconciliation cron exists to catch `payments.gateway_status='pending'` rows whose Cashfree-side state is paid (FLOW_MAP §5.5, §7).

### Step 5 — Pro Ravi accepts → completes; pro_earnings_paise set

- Accept: `App/househelp-api/internal/booking/service.go:664` `AcceptBooking`. Calls `repo.AcceptBooking` at `repository.go:393`. Atomically claims the row via row-level lock. **Idempotent** (second accept returns `ErrBookingNotPending`).
- Complete: `App/househelp-api/internal/booking/service.go:1794` `CompleteBooking`:
  - line 1809-1815 — `UPDATE bookings SET status='completed', completed_at=NOW() … RETURNING started_at, completed_at`.
  - line 1822-1834 — `actualMin := int(completedAt.Sub(*startedAt).Minutes())` (with fallback to `total_duration_minutes`).
  - line 1835 — `earnings := ComputeBookingEarnings(actualMin, completedAt)`.
  - line 1836-1843 — `UPDATE bookings SET actual_duration_minutes = $2, pro_earnings_paise = $3` — same tx.

**Formula** (`App/househelp-api/internal/booking/earnings.go:42-66`):
```
base    = round(actualMinutes/60 * 8000)        paise   (≈ ₹80/hr)
peak    = round(actualMinutes/60 * 5000) if 08-11 or 17-20 IST
weekend = 10000 if Sat/Sun IST
total   = base + peak + weekend
```

For Ravi working 25 minutes off-peak weekday:
```
base    = round(25/60 * 8000) = round(3333.333...) = 3333 paise   (₹33.33)
peak    = 0
weekend = 0
total   = 3333 paise
```

> Tag: **HIGH** — `pro_earnings_paise` is computed per-booking, but the **payroll engine completely ignores `bookings.pro_earnings_paise`**: it pays from `shift_sessions` only (`payroll/repository.go:61-69`). So `pro_earnings_paise` is a vestigial snapshot — peak/weekend bonuses computed at completion **never reach the payout** (see Step 8). Either the booking-side formula or the payroll-side formula is dead code. Per FLOW_MAP §2.7, payroll is "v1" — this is the latent bug.

### Step 6 — shift_sessions records online + working minutes

- Online tap: `App/househelp-api/internal/shift/repository.go:211-219` `OpenSession` inserts `shift_sessions (commitment_id, pro_id, online_at)` with `offline_at = NULL, online_minutes = NULL, job_minutes = 0` (DEFAULT).
- Offline tap: `App/househelp-api/internal/shift/repository.go:260-272` `CloseSession`: `UPDATE shift_sessions SET offline_at = now(), online_minutes = GREATEST(0, EXTRACT(EPOCH …)/60)`.
- **`job_minutes` is never written anywhere in the Go code** (`grep -rn "job_minutes" --include='*.go'` returns only model serialization, the migration default, and the payroll SELECT). The migration default is 0; nothing ever increments it.

> Tag: **CRITICAL — Finding B-1**. `shift_sessions.job_minutes` is read by `payroll/repository.go:63` but never written. Therefore `workingMin = 0` for every pro in every cycle; `BonusPayPaise = 0`. Pros only get `BasePayPaise` (online time). The bonus rail in FLOW_MAP §2.7 is **dead at runtime**.

For Ravi spending 60 online min and 25 working min:
- Real DB state after offline tap: `online_minutes = 60, job_minutes = 0`.
- Payroll aggregation reads: `onlineMin=60, workingMin=0` (not 25).

### Step 7 — Cycle-close cron runs on day 15 or EOM

- `App/househelp-api/internal/payroll/cron.go:42-66` `run()` waits until `NextCloseAfter(IST())` then calls `runOnce`.
- Boot replay at `cron.go:47-51`: if today is a close date and start > 01:00 IST, runs immediately. Safe because `UpsertPayout` uses `ON CONFLICT DO NOTHING` (`payroll/repository.go:97`).
- `App/househelp-api/internal/payroll/cron.go:68-80` `runOnce` → `svc.RunForToday(ctx)` → `service.go:40-46` `RunForToday` → `service.go:51-116` `RunCycle`.
- `RunCycle`:
  - line 56 — `EligibleHelpers(ctx, cycle.End)` — every pro with `effective_start_date <= cycle.End`.
  - line 67 — `AggregateActivity(ctx, proID, cycle.Start, cycle.End)` reads `shift_sessions` (`repository.go:58-74`).
  - line 86 — `ComputePay(onlineMin, workingMin)` (next step).
  - line 93 — `UpsertPayout`. **Idempotent on (pro_id, cycle_start)** — unique constraint at migration `108_payroll_engine.up.sql:82`.

> Tag: **MEDIUM** — `AggregateActivity` joins `shift_commitments.shift_date` (line 65-67) but a pro can be online via `OpenSession` even without a commitment? Migration 098 shows commitment_id is `NOT NULL`. Fine.
> Tag: **LOW** — open sessions (`offline_at IS NULL`) at cron fire are silently excluded (`repository.go:68`). The pro is paid next cycle for that session — but **if the session straddles cycle close**, all of the session's minutes count in the **later** cycle (it's date-bucketed by `sc.shift_date` not by `online_at`). For a session that straddles the boundary, this is correct because `sc.shift_date` belongs to one date. OK.

### Step 8 — Payouts row created with gross_pay_paise

- `App/househelp-api/internal/payroll/calc.go:79-94` `ComputePay`:
```go
base   = int64(onlineMin)  * 8000 / 60   // BaseRatePaisePerHour=8000
bonus  = int64(workingMin) * 8000 / 60   // BonusRatePaisePerHour=8000
gross  = base + bonus
net    = gross                            // deductions = 0 in v1
```

Brief's worked numbers: `online=60, working=25`:
- Expected: base = 60*8000/60 = **8000** paise (₹80), bonus = 25*8000/60 = 3333 paise (truncated from 3333.33), gross = **11333** paise.
- **Actual** (per Finding B-1): base = 8000, bonus = 0 (because workingMin=0), gross = **8000 paise**.

- `App/househelp-api/internal/payroll/repository.go:82-108` `UpsertPayout`: `INSERT … ON CONFLICT (pro_id, cycle_start) DO NOTHING` with status `'pending_manual_payout'`. **Idempotent.** Note: per FLOW_MAP §2.7 deductions are 0 in v1 of calc; admin deductions are applied separately. **But** I see no code that applies `admin_pro_deductions.amount_paise` to `payouts.deductions_paise` ever. So even if an admin records a deduction, `net_pay = gross` always.

> Tag: **HIGH — Finding B-2**. `admin_pro_deductions` (migration 103) is write-only from the admin side; nothing reads it into `payouts.deductions_paise`. Either dead-code or unbuilt feature. If a pro damages something and admin records a ₹500 deduction, payout still goes out full.

### Step 9 — Admin opens CRM, mark-paid clicked

- The FLOW_MAP cites a new `internal/crm/payroll/payroll.go:230-269` for mark-paid, but **that file does not exist on this branch**. The only mark-paid path is the legacy `App/househelp-api/internal/crm/payouts/payouts.go:106-116`:
```go
UPDATE crm_payouts SET status='paid', paid_at=now(), external_ref=NULLIF($2, ''), updated_at=now()
WHERE id = $1::uuid AND status IN ('pending','processing')
```
- This targets the **old `crm_payouts` table**, NOT the new `payouts` table from migration 108. The two tables are disjoint — the payroll cron writes into `payouts`, but the only CRM mark-paid endpoint writes into `crm_payouts`.

> Tag: **CRITICAL — Finding B-3**. There is NO endpoint on this branch that flips `payouts.status` from `pending_manual_payout` to `paid`. The cron writes payout rows that no admin UI can mark paid. Either the admin works directly in the DB (frightening) or the develop-branch CRM endpoint hasn't merged yet. Audit must confirm whether the develop branch closes this gap; on this branch it is a money-stuck-in-limbo bug.

- Audit log: `App/househelp-api/internal/crm/payouts/payouts.go:177` calls `h.audit(c, "payout.paid", id, nil, body.ExternalRef)`. Audit goes through `internal/crm/audit/audit.go`. So even when the legacy mark-paid is used, the trail exists.

### Step 10 — Founder makes actual bank IMPS transfer (outside code)

- No code touches money here. Founder manually wires INR to pro's bank/UPI; transaction ID typed back into CRM. Per FLOW_MAP §4.2, **no Cashfree Payouts integration exists**.

> Tag: **MEDIUM** — entire pro-payout rail is manual. No reconciliation between "I clicked paid in CRM" and "money actually left ZopMop's bank". A typo, a missed transfer, or a duplicate transfer is undetectable in software.

---

## SCENARIO 2 — Pro-side cancellation mid-service

Customer Anita pays ₹500 (status `paid`). Ravi accepts → arrives → starts service. 5 min in, Ravi cancels.

### Steps 1-4 — same as Scenario 1
Money lives in `payments` (status `success`) and `bookings.payment_status='paid'`.

### Step 5 — Pro cancels mid-service

Two distinct cancel paths exist:

- **Customer path:** `POST /bookings/:id/cancel` → `App/househelp-api/internal/booking/handler.go:445` → `service.go:605-660` `CancelBooking` → `repo.CancelBookingWithFee(ctx, bookingID, "customer", feeCents)` at `repository.go:222`. Only accepts `status IN ('pending','accepted')` (line 248). **In-progress bookings cannot use this path.**

- **Pro path:** `POST /pro/bookings/:id/cancel` → `App/househelp-api/internal/shift/service.go:361-398` `CancelBooking`:
  - line 383 — `repo.MarkBookingCancelled(ctx, bookingID)` — at `shift/repository.go:756-764`:
    ```sql
    UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1
    ```
    No status guard, no refund insert, no payment-state check.
  - line 386 — `repo.InsertCancellation` writes a `booking_cancellations` row with `penalty_amount_paise = 0` (Ravi's first strike doesn't trigger the 5-strike penalty: `customerNotified && index >= StrikeThreshold` at line 379).

After this, `bookings.status='cancelled'` and `bookings.payment_status='paid'` simultaneously. There is **no `pending_refunds` row**.

> Tag: **CRITICAL — Finding B-4**. Pro-side mid-service cancel SKIPS `CancelBookingWithFee` entirely. The customer's ₹500 is `payment_status='paid'`; nothing creates a refund row; the customer-facing bookings list filter is `payment_method != 'cashfree' OR payment_status = 'paid'` — so the cancelled booking still shows as paid forever. **The customer eats the full ₹500.** Only manual intervention via the CRM refund dashboard can rescue this.

### Step 6 — Refund row created?

No. Per Finding B-4, no INSERT into `pending_refunds` occurs from the pro-cancel path.

### Step 7 — pro_earnings_paise behavior

- `CompleteBooking` is the only writer of `pro_earnings_paise` (`booking/service.go:1839`). Since the booking is now `cancelled`, `CompleteBooking` will fail (its UPDATE filters on `status='in_progress'` at line 1812). So `pro_earnings_paise` stays at its `DEFAULT 0` (migration `101_job_lifecycle.up.sql:27`).

> Tag: **LOW** — correct outcome (no per-booking earnings recorded).

### Step 8 — penalty_amount_paise in booking_cancellations

- `shift/service.go:378-381`:
```go
penaltyPaise := 0
if customerNotified && index >= StrikeThreshold {
    penaltyPaise = (BaseRatePaisePerHour * estMinutes) / 60
}
```
- For Ravi's first strike (`index = 1`, `StrikeThreshold = 5` per the file), `penaltyPaise = 0`. He pays no penalty until the 5th cancellation in 30 days.
- Column is `INT NOT NULL DEFAULT 0` (migration `098_shift_system.up.sql:108`) — INT32, max ₹2.14L. Adequate.

> Tag: **MEDIUM** — first four pro-side mid-service cancels per 30 days are entirely free for the pro. The customer is unreimbursed and the pro is unpunished. The 5-strike rule is generous given the customer impact.

### Step 9 — Ravi's 5 min of working time on this booking

- Because `job_minutes` is never written anywhere (Finding B-1), Ravi's 5 minutes never enter `shift_sessions.job_minutes` regardless of cancel.
- His `online_minutes` continues to accrue (he's still online; the cancel doesn't close his shift session). So Ravi gets paid for the 5 minutes via the **online** rail (₹80/hr × 5/60 = 666 paise = ₹6.67) at cycle close.

> Tag: **HIGH — Finding B-5**. Ravi gets paid online-rate for time spent on a booking he cancelled mid-service. Customer is unrefunded (Finding B-4). Two-sided loss: customer pays full ₹500, pro paid ₹6.67 from company, company eats the gap.

### Step 10 — Customer refund: via Cashfree API or wallet credit?

Neither happens automatically. The only refund creators on this branch:
- `App/househelp-api/internal/booking/repository.go:272-284` — `CancelBookingWithFee` (NOT reached for in-progress).
- `App/househelp-api/internal/booking/pending_action_sweeper.go:179` — auto-cancel sweeper for booking-not-accepted-in-time (NOT this scenario).
- `App/househelp-api/internal/crm/refunds/refunds.go` — manual admin refund creation only.

A customer with a paid-then-pro-cancelled booking must email support, support files a CRM refund row, admin approves, gateway fires. There is no in-app refund button.

### Edge case — webhook race vs cancel

- If customer pays at T+0, webhook lands at T+1s, pro cancels at T-1s (race):
  - `bookings.payment_status` is updated by the webhook (`payments/handler.go:930-937`) gated on `payment_method='cashfree'`.
  - Pro cancel via shift path (`shift/repository.go:761`) unconditionally sets `status='cancelled'`.
  - The two writes do not conflict on the same column.
  - Result: row with `status='cancelled'` AND `payment_status='paid'`. Webhook does not check booking status before flipping payment_status.
  - The webhook also does not refund automatically when finding a cancelled booking.

> Tag: **HIGH — Finding B-6**. Webhook + pro-cancel race leaves a permanently-orphaned paid+cancelled row. No code path turns this into a `pending_refunds` row. Customer never refunded.

---

## SCENARIO 3 — Chargeback after pay-out

Customer Anita pays ₹500, service completes, cycle closes, Ravi marked paid (₹400 say). 7 days later Anita disputes via her card issuer; Cashfree raises a chargeback.

### Steps 1-9 — same as Scenario 1 (plus Ravi already paid manually).

### Step 10 — Cashfree CHARGEBACK webhook handling

- `App/househelp-api/internal/payments/handler.go:886-987` `dispatchCashfreeEventTx` `switch eventType` only handles:
  - `"PAYMENT_SUCCESS_WEBHOOK"` (line 915)
  - `"PAYMENT_FAILED_WEBHOOK"` / `"PAYMENT_USER_DROPPED_WEBHOOK"` (line 960)
  - `"REFUND_STATUS_WEBHOOK"` (line 969)
  - `default:` → log "unhandled event type" at line 984-985.

- `grep -rni "chargeback|CHARGEBACK|dispute|DISPUTE"` across the entire backend returns ZERO matches in the payments package and ZERO matches in any webhook handler. The only matches are `crm_disputes` (customer-filed support tickets, unrelated to PG chargebacks).

> Tag: **CRITICAL — Finding B-7**. The Cashfree webhook handler has no chargeback path. Cashfree's `DISPUTE_CREATED` / `DISPUTE_OUTCOME` events will be silently logged at info and acknowledged with 200. The book stays as `payments.gateway_status='success'`, `bookings.payment_status='paid'`, no refund, no flag.

### Step 11 — Even if handler existed, does it claw back pro's pay?

- No code references `admin_pro_deductions` in any chargeback-adjacent context.
- No mechanism inserts a negative row to claw back a `paid` payout. The `payouts` table has CHECK constraints only on cycle bounds; there is no `INSERT … VALUES (…, -<amount>, 'clawback')` anywhere.
- A `cancelled` status exists on `payouts` (migration 108:73) but it represents "we never paid this row" not "we paid and want to undo".
- There is no negative-balance handling on `wallets.balance_paise` either — migration 067:15 enforces `CHECK ≥ 0`, so you cannot debit a wallet below zero to recover funds.

> Tag: **CRITICAL — Finding B-8**. Even with a hypothetical chargeback handler, the system has **no mechanism to recover money already paid to a pro**. Founder must do it manually outside the codebase, and the books in our DB will be permanently overstated relative to the bank.

### Edge case — chargeback succeeds, settlement balance debited

- Cashfree deducts ₹500 from ZopMop's merchant balance on a successful chargeback. No code in this repo tracks settlement; per FLOW_MAP §4.1, "We don't initiate PG settlement; Cashfree wires our merchant bank account on T+1/T+2".
- The loss appears in the merchant dashboard only. `payments.amount_paise = 50000, gateway_status = 'success'` in our DB stays true forever. The wallet balances, the payout, the booking row — all show the booking as fully paid and serviced.
- **Books and bank diverge silently.** ZopMop pays Ravi from its own pocket and never knows it lost the consumer side.

> Tag: **CRITICAL — Finding B-9**. No reconciliation cron compares Cashfree settlement balance to our `payments` table (FLOW_MAP §5.5). A chargeback is invisible to ops until manual dashboard inspection.

---

## CROSS-VERIFY — one rupee, four places

For a ₹500 service with no surge/discount/fee (using the brief's exact number):

1. **Pricing engine output (Go):**
   - `App/househelp-api/internal/booking/service.go:403-408` — `SELECT base_price_cents … FROM service_categories`. For ₹500, DB row has `base_price_cents = 50000`. Unit: paise (despite name).
   - `App/househelp-api/internal/booking/service.go:426` — `totalPriceCents := basePriceCents + pricingConfig.BaseFeeCents`. With no fee, this would be 50000.
   - `App/househelp-api/internal/booking/service.go:459` — `booking.AmountPaise = totalPriceCents`. Assigned to a Go `int` (`booking/model.go` shows `AmountPaise int`). On 64-bit platforms that's int64 backing; on 32-bit (or in JSON marshalling) it could clamp at 2.14B paise. For ₹500 fine.
     > Tag: **MEDIUM** — `booking.AmountPaise` declared as Go `int` not `int64`, while the DB column is BIGINT. A high-value enterprise booking (>₹21.4M) on a 32-bit JS conversion could lose precision. Subagent A territory.

2. **`bookings.amount_paise`:**
   - Migration `065_bookings_amount_paise.up.sql:31` — `BIGINT NOT NULL`. Unit: paise.
   - Written by `repo.CreateBooking` via `service.go:464` (the booking row is INSERTed with `AmountPaise: totalPriceCents`).
   - For ₹500: stored as `50000`.

3. **Body sent to Cashfree create-order:**
   - `App/househelp-api/internal/payments/handler.go:434` — `netPaise := amountPaise - discountPaise` reads `bookings.amount_paise` directly. With no discount: `netPaise = 50000`.
   - `App/househelp-api/internal/payments/handler.go:457,580` — passes `netPaise` as `AmountPaise int64` to `gateway.CreateOrder`.
   - `App/househelp-api/internal/payments/cashfree.go:491-493` — `paiseToRupees(50000) = 50000 / 100.0 = 500.0` (float64 rupees) — the body field `order_amount` per FLOW_MAP §6.1.
   - **Conversion equality check**: `int(500.0 * 100) == 50000` → true. For any paise value where `paise % 100 == 0` the conversion is exact in IEEE-754 (powers of two factors of the integer dividend). For values like `paise = 50001`, `paiseToRupees(50001) = 500.01` is exact in float64 because 50001/100 is exactly representable. For pathological values (e.g. very large with non-terminating binary expansion) there could be drift, but ₹500 round case is exact.

4. **Number rendered on payment screen:**
   - `App/zopmop-app/src/screens/main/PaymentScreen.tsx:99-101` — `amountPaise = params.amount_paise ?? 0; rupees = Math.floor(amountPaise / 100); decimals = (amountPaise % 100).padStart(2, '0')`.
   - For `amount_paise = 50000`: `rupees = 500`, `decimals = '00'` → renders "₹500.00".
   - `amount_paise` comes from `CartScreen.tsx:303` which uses `totalCents = subtotalCents + feeCents` from the local cart computation, NOT from a backend round-trip. If the backend disagrees with the client (e.g. surge multiplier just kicked in server-side), the screen displays the client number while the server charges the server number. **Drift risk.**

**Four-way equality (₹500, no surge, no discount, no platform fee):**
- pricing engine `totalPriceCents` = 50000 paise (server)
- `bookings.amount_paise` = 50000 paise (DB)
- Cashfree body `order_amount` = 500.0 (float rupees, equivalent to 50000 paise)
- Payment screen render = "₹500.00" (display only)

These are **equal in the happy path**. But the screen render is **client-computed** (CartScreen at :136), not derived from the server's booking row. With surge on, `surgeMultiplier` is in `pricingConfig` server-side; the client has no awareness. So if surge enables between cart-view and booking-create, the user sees ₹500 then the server charges ₹600 — **silent.** No re-confirmation step.

> Tag: **HIGH — Finding B-10**. Cart-screen total is client-computed from local prices. Server adds surge / re-prices independently at booking-create. The user can be charged more than the screen showed, without ever seeing the new number, unless the booking-create response is re-rendered (which `CartScreen.tsx:287,293` does pass `amount_paise: created.price_paise` forward — so the **payment screen does show the server number**, but the cart-screen "Total" line they tapped Pay on did not).

---

## Summary of damaging findings

| ID  | Tag      | Finding |
| --- | -------- | ------- |
| B-1 | CRITICAL | `shift_sessions.job_minutes` is never written. Payroll reads it as 0; pros get only online-rate pay, never the working bonus. |
| B-2 | HIGH     | `admin_pro_deductions` is write-only; never read into `payouts.deductions_paise`. |
| B-3 | CRITICAL | No endpoint on this branch flips `payouts.status` from `pending_manual_payout` to `paid`. New payroll cron writes rows that no CRM page can mark paid. (Legacy `/payouts/:id/paid` targets a different `crm_payouts` table.) |
| B-4 | CRITICAL | Pro-side cancel via `shift.Service.CancelBooking` SKIPS `CancelBookingWithFee` — no `pending_refunds` row is ever inserted. Customer's ₹500 is paid but un-refunded. |
| B-5 | HIGH     | Ravi paid online-rate for minutes spent on the booking he cancelled mid-service. |
| B-6 | HIGH     | Webhook-vs-cancel race leaves rows with `status='cancelled' + payment_status='paid'`. No code converts this to a refund. |
| B-7 | CRITICAL | No chargeback handler. `DISPUTE_CREATED`/`CHARGEBACK_*` events are silently logged and 200'd. |
| B-8 | CRITICAL | No mechanism (negative `admin_pro_deductions`, clawback `payouts` row, wallet negative balance) to recover money already paid to a pro on chargeback. |
| B-9 | CRITICAL | No Cashfree settlement reconciliation cron — chargebacks invisible until manual dashboard inspection. |
| B-10| HIGH     | Cart screen shows client-computed total; server can re-price (surge) before booking creation. Payment screen does show the server amount, but the user already tapped "Pay" on the cart number. |

Adjacent findings already documented in FLOW_MAP §8 (INT32 columns, misnomers, `myShareCents` ceil) are not duplicated here.

End of trace-scenarios.md.
