# Subagent A — Unit Consistency & Type Safety

**Date:** 2026-05-21 · **Branch:** feature/money-flow-audit-2026-05-21 (forked from develop @ f228adb) · **Ground truth:** `audit/money/FLOW_MAP.md`

---

## CRITICAL

### C1. CRM Dashboard "Revenue today" KPI renders `₹NaN` — JSON-tag drift
- Backend: `App/househelp-api/internal/crm/dashboard/dashboard.go:22` — `RevenueTodayCents int `json:"revenue_today_paise"`` (also `App/househelp-api/internal/admin/model.go:44`).
- Frontend: `App/zopmop-crm/src/api/dashboard.ts:6` (`revenue_today_cents`), consumed at `App/zopmop-crm/src/pages/DashboardPage.tsx:44` via `fmtCents(kpis.data.revenue_today_cents)`.
- Effect: wire field is `revenue_today_paise`; TS reads `revenue_today_cents` → undefined → `undefined/100 = NaN` → "₹NaN" on the KPI tile.
- Worked example: ₹40 000 turnover today = 4 000 000 paise. Payload `{"revenue_today_paise":4000000}`. Dashboard KPI displays "₹NaN".
- Fix: rename TS to `revenue_today_paise` (precedent: `api/users.ts:16-18` and comment at `api/all.ts:23-24`).

### C2. CRM Revenue-7d chart renders empty / zero — JSON-tag drift
- Backend: `App/househelp-api/internal/crm/dashboard/dashboard.go:41` — `RevenueCents int `json:"revenue_paise"``.
- Frontend: `App/zopmop-crm/src/api/dashboard.ts:21` (`revenue_cents`), used at `App/zopmop-crm/src/pages/DashboardPage.tsx:104,121`.
- Effect: `q.data.every(p => p.revenue_cents === 0)` is always true; `<Bar dataKey="revenue_cents">` reads undefined → all bars at 0.
- Worked example: 7 days × ₹10 000 (1 000 000 paise) — chart shows seven flat bars at 0.
- Fix: rename `revenue_cents` → `revenue_paise` on TS side.

### C3. CRM Worker Payouts page renders `₹NaN` — JSON-tag drift
- Backend Go struct uses field `AmountCents int64` with json tag `amount_paise`: `App/househelp-api/internal/crm/payouts/payouts.go:28` and `:40` (DB column `crm_payouts.amount_cents` per `payouts.go:99,62`).
- Frontend declares `amount_cents`: `App/zopmop-crm/src/api/all.ts:298,303`. Used at `App/zopmop-crm/src/pages/PayoutsPage.tsx:73,109` (`fmt(p.amount_cents)`) including the Mark-Paid confirm modal.
- Effect: every row shows "₹NaN"; Mark-Paid confirm modal asks the admin to confirm "₹NaN → <worker>".
- Worked example: payout intent ₹3 200 (320 000 paise). Wire `{"amount_paise":320000}`. UI: "₹NaN → Aditya Rohilla — UTR: ___". Founder approves an out-of-band wire from memory.
- Fix: rename TS to `amount_paise`. Optionally rename Go field `AmountCents` → `AmountPaise` for readability.

### C4. `bookings.cancellation_fee_cents` is INT32 + double-misnomer (column says `_cents`, Go json tag says `_paise`)
- Migration: `App/househelp-api/migrations/048_booking_cancellation_fee.up.sql:8` — `cancellation_fee_cents INTEGER NOT NULL DEFAULT 0`. (FLOW_MAP §3.1 lists this as `_paise` — actual column name is `_cents`.)
- Go field: `App/househelp-api/internal/booking/model.go:39,121` — `CancellationFeeCents int `json:"cancellation_fee_paise"``.
- Repository scans into `int`: `App/househelp-api/internal/booking/repository.go:246` updates the column.
- INT32 ceiling = 2 147 483 647 paise = ₹21 474 836.47 (~₹2.14 cr). Adequate at current ₹100 fee.
- Fix: widen to BIGINT, rename column to `cancellation_fee_paise`, change Go field to `int64`.

### C5. `cart_items.price_cents` is INT32, misnamed (paise stored as `_cents`)
- Migration: `App/househelp-api/migrations/012_create_cart.up.sql:17` — `price_cents INTEGER NOT NULL`.
- RN field `App/zopmop-app/src/context/CartContext.tsx:95` sums `item.price_paise` into `subtotalCents` — wire is paise, code labels are mixed.
- Cap ₹21 474 836.47 per line item.
- Fix: rename + widen to `price_paise BIGINT`.

### C6. `service_categories.base_price_cents` & `mrp_cents` are INT32, misnamed
- Migrations: `App/househelp-api/migrations/003_create_service_categories.up.sql:9` (`base_price_cents INTEGER NOT NULL`), `App/househelp-api/migrations/011_extend_service_categories.up.sql:12` (`mrp_cents INTEGER`).
- Pattern drift: `service_variants.price_paise` (mig 084) and `bundles.bundle_price_paise` (mig 085) are BIGINT+paise — `service_categories` is the off-pattern outlier and is exactly what the booking creation path reads at `App/househelp-api/internal/booking/service.go:406,408` into a local `int basePriceCents`.
- Same misnomer propagates to CRM order filter `min_cents`/`max_cents` (`App/zopmop-crm/src/pages/OrdersPage.tsx:83-84` ↔ `App/househelp-api/internal/crm/orders/orders.go:740-745`).
- Fix: forward-only migration to widen + rename.

### C7. `promotions.discount_value` is dual-mode INT (paise OR percent depending on `discount_type`) — admin-side footgun
- Migration: `App/househelp-api/migrations/007_create_promotions.up.sql:8` — `discount_value INTEGER NOT NULL`.
- Read site discriminator IS checked correctly: `App/househelp-api/internal/booking/service.go:442-446` branches on `promo.DiscountType == "percent"`. No 100× math error in code today.
- BUT: admin form `App/zopmop-crm/src/pages/PromosPage.tsx` accepts a raw integer in the same field for both modes. Admin typing "200" for a "₹200 off, fixed" promo writes `discount_value=200` → at booking time customer gets `discountCents=200` = ₹2 off, not ₹200.
- Worked example: ₹500 booking, admin-intended ₹200 off, actually applied ₹2 off → customer overcharged ₹198, no log signal.
- Fix: split column into `discount_value_percent` (NULLable) and `discount_value_paise` (NULLable) with CHECK enforcing exactly one set; or add CHECK `(type='percent' AND value BETWEEN 1 AND 100) OR (type='fixed' AND value >= 100)`. UI should render the two modes with explicit unit suffix.

### C8. Cashfree webhook decodes `payment_amount` (rupees float64) but never asserts it against `bookings.amount_paise`
- Decoder: `App/househelp-api/internal/payments/handler.go:754,760,768` — `OrderAmount`, `PaymentAmount`, `RefundAmount` all `float64`.
- Usage: grep confirms none of these decoded floats are read further. The webhook stamps `gateway_status='success'` based purely on event type, never comparing the gateway-reported amount with our stored expected `payments.amount_paise`.
- Risk: defense-in-depth gap. A re-signed replay within the 300 s skew window with a tweaked amount, a Cashfree partial-capture flow that lands a different `payment_amount`, or any future capture-style flow could stamp success at the wrong amount silently.
- Worked example: ₹500 booking. If a same-event-ID payload variant with `payment_amount: 50.00` ever signed-and-replayed, we still mark the row paid. Today blocked by upstream order-creation contract, but the assertion is missing.
- Fix: inside `dispatchCashfreeEventTx`, before stamping success, assert `int64(math.Round(env.Data.Payment.PaymentAmount*100)) == netPaise` (where netPaise = `amount_paise - discount_paise`). Mismatch → skip + alert.

---

## HIGH

### H1. `Booking.AmountPaise` & `DiscountPaise` are Go `int`, not `int64`, while DB columns are BIGINT
- `App/househelp-api/internal/booking/model.go:33,35` — `AmountPaise int`, `DiscountPaise int`. Same for `CreateBookingRequest` at `:165-166` and `BookingDetailService` at `:120-121`.
- DB columns BIGINT per `App/househelp-api/migrations/065_bookings_amount_paise.up.sql:31,37`.
- On 64-bit Go `int == int64`, but the code makes no portable guarantee. A `GOARCH=arm` cross-compile narrows scans of large BIGINTs.
- Worked example: ₹25 cr corporate booking = 2 500 000 000 paise > int32 max (2.14e9). INSERT succeeds; subsequent read into `int` on 32-bit truncates / errors.
- Fix: switch every money-bearing field in `booking/model.go` from `int` to `int64`.

### H2. Surge multiplier truncates via `int(float64(x) * mult)` — under-charges by up to 99 paise
- `App/househelp-api/internal/booking/service.go:428`:
  `totalPriceCents = int(float64(totalPriceCents) * pricingConfig.SurgeMultiplier)`
- `int(...)` truncates; `1.33` is not exact in float64.
- Worked example: ₹4 000 × 1.33 surge. 400 000 paise × 1.33 → in double = 531 999.999… → `int(...) = 531 999` paise = ₹5 319.99. Customer billed 1 paisa less than intended. Sign of drift depends on multiplier.
- Fix: `totalPriceCents = int(math.Round(float64(totalPriceCents) * pricingConfig.SurgeMultiplier))`, or store surge as integer basis points (`133` = 1.33×) and compute `total * bps / 100`.

### H3. Split-cart `myShareCents = Math.ceil(totalCents / splitCount)` — Σ shares can exceed total
- `App/zopmop-app/src/screens/main/CartScreen.tsx:137`.
- Worked example: total = 10 001 paise (₹100.01), split=3 → `Math.ceil(3333.666…) = 3334`, three roomies × 3334 = 10 002 (overpaid 1 paisa). Split=4, total=401 → 101×4 = 404 paise (overpaid 3 paise).
- Currently display-only (button label at `:635`); when backend split lands the overcharge becomes real billing.
- Fix: `baseShare = Math.floor(total / k); remainder = total - baseShare*k`. Distribute `remainder` extra paise across first `remainder` participants, or charge the booker `total - (k-1)*baseShare`.

### H4. Mobile constant drift: `BASE_RATE_PER_HOUR = 80`
- `App/zopmop-app/src/utils/proBookingCancel.ts:17` (the file the FLOW_MAP cited as `ProBookingCancel.tsx:17`; actual filename is `proBookingCancel.ts`).
- Backend source of truth `BaseRatePaisePerHour = 8000` in `App/househelp-api/internal/payroll/payroll.go:20-26`.
- Risk: a rate bump on the backend silently desyncs the pre-cancel penalty estimate.
- Fix: surface `base_rate_paise_per_hour` from a backend config or extend the existing `getFortnightProgress()` payload.

### H5. Mobile constant drift: `PLATFORM_FEE_CENTS = 2000`
- `App/zopmop-app/src/screens/main/CartScreen.tsx:53`.
- Backend source of truth `config_manager.PricingConfig.BaseFeeCents` (fallback constant at `App/househelp-api/internal/booking/service.go:423`).
- Worked example: config bumped to ₹30. Cart bill row still says "Platform fee ₹20", subtotal ₹200, total ₹220; backend stamps ₹230 onto `bookings.amount_paise`. Customer's slip says ₹230, complaint thread starts.
- Fix: backend `/config/pricing` endpoint, RN reads `feeCents` from there.

### H6. `pending_refunds.amount_cents` & `partial_amount_cents` — BIGINT but misnamed
- Migration: `App/househelp-api/migrations/034_pending_refunds.up.sql:4`, `App/househelp-api/migrations/046_refund_gateway.up.sql:22`.
- Go struct at `App/househelp-api/internal/crm/refunds/refunds.go:44` — `AmountCents int64 `json:"amount_paise"`` (wire name is correct paise, internal name says cents). Type safety is fine; linguistic mismatch only.
- Fix: forward-only `RENAME COLUMN amount_cents TO amount_paise` migration; touches `App/househelp-api/internal/compliance/export.go:390-391` and all refund SQL.

---

## MEDIUM

### M1. `paiseToRupees` (float64) round-trip — lossless under current usage
- `App/househelp-api/internal/payments/cashfree.go:491-493`. Worked example: ₹500.50 → 50050 paise → `float64(50050)/100.0 = 500.5` (exact). Float64 53-bit mantissa exact for integers up to 9e15 paise → ₹90 trillion. No drift today. Related concern is C8 (inbound side, not this conversion).

### M2. Promo percent order-of-ops correct
- `App/househelp-api/internal/booking/service.go:443` — `totalPriceCents * promo.DiscountValue / 100`. Multiplication before division. Truncation always rounds discount **down** (under-credits customer ≤ ₹0.99). Acceptable; document the policy.

### M3. Payroll `minutes × rate / 60` — correct order, ≤ 0.33 paisa truncation per fortnight
- `App/househelp-api/internal/payroll/calc.go:83-84`. Multiplies first, then divides. Cap: 21 600 minutes × 8000 fits int32 with overhead. Recommendation: document the intentional truncation in the comment block.

### M4 / M5. `math.Round` floats in per-booking earnings vs integer truncation in payroll
- `App/househelp-api/internal/booking/earnings.go:48,52` use `math.Round`; `App/househelp-api/internal/payroll/calc.go:83-84` uses integer truncation; `App/househelp-api/internal/matching/dispatch.go:678` uses `math.Round` again.
- Pro earnings snapshot per booking rounds half-up; cycle aggregator rounds-down. Difference per pro per cycle: a few paise. Reconciliation between `bookings.pro_earnings_paise` sum and `payouts.gross_pay_paise` will systematically differ.
- Fix: pick one rounding policy across the three files. Recommend integer math (`minutes * rate / 60`) everywhere.

### M6. RN display layer — mixed `Math.round` / `Math.floor` / `.toFixed(0)` / `.toFixed(2)` (≈30+ sites)
- Round-down-via-`Math.round`: `App/zopmop-app/src/screens/pro/JobOfferScreen.tsx:172`, `App/zopmop-app/src/screens/pro/JobsListScreen.tsx:225,261`, `App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx:360`, `App/zopmop-app/src/screens/pro/JobDetailScreen.tsx:250,483`.
- `Math.floor` (loses up to 99 paise off display): `App/zopmop-app/src/screens/main/WalletScreen.tsx:348` (`Math.floor(paise/100)`), `App/zopmop-app/src/screens/main/OffersScreen.tsx:51` (`Math.floor(offer.min_order_paise/100)` — customer with ₹500 thinks ₹500.50 minimum is satisfied).
- `.toFixed(0)`: ~12 sites in CartScreen, HomeCartBar, TrackLive, BookingConfirmed, AllServicesScreen, ManageHouseholdScreen.
- `.toFixed(2)`: error toasts in CartScreen:311, ProfileScreen:189, InstantMatchingScreen:219, ActiveBookingScreen:209.
- Worked inconsistency: cancellation fee ₹100.50 — main UI shows "₹100" (toFixed(0)), cancellation toast shows "₹100.50" (toFixed(2)).
- Fix: centralized `App/zopmop-app/src/utils/money.ts` (mirror `App/zopmop-crm/src/lib/formatters.ts:8-21`). One `formatRupees` (no decimals) + one `formatRupeesExact` (2 decimals). Replace all 30+ inline divisions.

### M7. Roomie vault balance toFixed(0) — UX says "₹500 available" when actual is ₹499.51
- `App/zopmop-app/src/screens/main/ManageHouseholdScreen.tsx:89,107,173`.
- Fix: use the centralized helper from M6.

---

## LOW

### L1–L3. Test fixtures / log lines / `parseFloat`
- `App/househelp-api/internal/compliance/jsonb_scrub_test.go:97` — test only.
- `App/househelp-api/internal/compliance/export.go:390-391` — selects existing misnamed columns; flows through H6 rename.
- `App/househelp-api/internal/booking/service.go:479` log emits `totalPriceCents` as `Int(...)` — fixed once H1 lands.
- `App/zopmop-app/src/components/SettlementModal.tsx:160` — `Math.round(parseFloat(...) * 100)` is the **correct** rupees→paise idiom.
- `App/zopmop-app/src/screens/main/WalletTopupSheet.tsx:95` — `parsedRupees * 100` is exact (parsedRupees is integer 100–500 000).

### L4. GST / tax — OPEN (compliance gap)
- Grep for `gst`, `igst`, `sgst`, `cgst`, `tax_paise`, `tax_cents` → no business-logic hits. Two mentions in `App/househelp-api/internal/compliance/policies.go:72,118` are only legal-basis strings for data retention.
- Implication: bookings invoiced gross of GST, no tax line, no GSTIN of customer, no place-of-supply logic. For a marketplace > ₹20L/yr this is non-compliant. Out of scope for Subagent A; raise as compliance OPEN.

---

## OPEN

- **O1.** Cashfree CHARGEBACK_CREATED / partial-capture events — handler.go dispatches only PAYMENT_SUCCESS / PAYMENT_FAILED / REFUND_STATUS. Unhandled events silently ack. Flag to Subagent C.
- **O2.** `CASHFREE_PG_ENV` default → sandbox base URL (`App/househelp-api/internal/payments/cashfree.go:89-91`). If unset in prod, real cards routed to sandbox. Flag to ops.

---

## Top 5 by severity / blast radius

1. **C3 — Payouts page renders ₹NaN.** Backend emits `amount_paise`, CRM reads `amount_cents`. Mark-Paid confirm modal currently asks an admin to approve "₹NaN → worker". One-line fix in `App/zopmop-crm/src/api/all.ts:298,303`.
2. **C1 + C2 — Dashboard Revenue today KPI and Revenue 7d chart both broken** by the same `_paise` vs `_cents` drift (`api/dashboard.ts:6,21` vs `crm/dashboard/dashboard.go:22,41`). Founders cannot read live revenue from the CRM.
3. **C8 — Cashfree webhook never asserts `payment_amount` matches our `amount_paise - discount_paise`** before stamping success (`payments/handler.go:760-768`). Defense-in-depth gap; assertion absent.
4. **H3 — Split-cart `Math.ceil(totalCents/splitCount)`** makes Σ shares > total (overcharges by up to k-1 paise per group). Display-only today; will become real billing the moment backend split lands (`CartScreen.tsx:137`).
5. **C4 / C5 / C6 — INT32 + misnomer cluster** on `bookings.cancellation_fee_cents`, `cart_items.price_cents`, `service_categories.base_price_cents` / `mrp_cents`. INT32 ceiling = ₹21 474 836.47. Off-pattern relative to BIGINT `_paise` siblings (service_variants, bundles). Requires forward-only migrations.
