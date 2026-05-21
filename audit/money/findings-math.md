# Subagent D — Money Math Bugs & Edge Cases

Severity legend: **CRITICAL** = silent money loss / wrong charge today. **HIGH** = fires on plausible production input. **MEDIUM** = edge / future config. **LOW** = cosmetic or guarded.

---

## CRITICAL

### C-1. Promotions admin can mint free-booking coupons — no bound on `discount_value`
- `App/househelp-api/internal/crm/promos/promos.go:164-189` (Create), `:197-209` (Update). Only check is `DiscountValue <= 0` (line 165). No `≤ 100` cap for percent type, no INT32-paise ceiling for fixed type.
- Apply sites: `App/househelp-api/internal/booking/service.go:443, 1097, 1237`. Clamp `if discountCents > totalPriceCents` at `:447-449` saves us from negative net, but the booking goes to **net=0** silently.
- Worked example: admin types `discount_type='percent', discount_value=10000` (meant 10). Cart total ₹500.50 → `50050 * 10000 / 100 = 5_005_000 paise → clamped to 50050 → ₹0 net`. Every redemption is a free booking until `max_uses` runs out.
- Worked example (fixed): `discount_value=2_000_000_000` fits in INT32 → every booking clamps to free.
- Fix: server-side bounds + DB CHECK constraints by `discount_type`.

### C-2. ProMoneyScreen drops up to 99 paise per display
- `App/zopmop-app/src/screens/pro/ProMoneyScreen.tsx:26-27`: `return '₹' + Math.round(p / 100).toLocaleString('en-IN')`.
- 12550 paise (₹125.50) shows "₹126" — 50p HIGHER than DB. 12549 paise (₹125.49) shows "₹125" — 49p LOWER.
- CRM uses `(paise/100).toLocaleString('en-IN', { maximumFractionDigits: 0 })` (`App/zopmop-crm/src/lib/formatters.ts:8-11`) — different rounding semantics than RN's `Math.round`. Pro sees "₹126", founder pays "₹125" → dispute. Bulk admin uses `formatRupeesExact` (`:15-21`) showing 2 decimals — same payout, two formats.

### C-3. Cancellation fee stamped on COD/unpaid bookings but no money flows
- `App/househelp-api/internal/booking/repository.go:262-285`. UPDATE always stamps `cancellation_fee_paise` and `cancellation_fee_applied=true` (`:248-252`); the refund-row insert is gated by `paid && nonCod && refundAmount > 0`.
- Worked example: COD booking ₹500, customer cancels 20 min before slot → fee=₹100 stamped, no refund row, customer paid ₹0 ever, pro gets ₹0. The "fee" annotation is a display fiction. Pro screen (`ProBookingCancel.tsx:17` — hardcoded `BASE_RATE_PER_HOUR=80`) suggests they'll be paid the penalty — they won't.
- Fix: don't stamp fee when `payment_status != 'paid'`.

---

## HIGH

### H-1. INT32 paise columns will overflow if config grows (pre-flagged in FLOW_MAP §8)
- `cart_items.price_cents` (mig 012:17), `service_categories.base_price_cents`/`mrp_cents` (003/011), `promotions.discount_value`/`min_order_cents` (007), `bookings.cancellation_fee_paise` (048:8), `booking_cancellations.penalty_amount_paise` (098:108), `absence_records.cash_deducted_paise` (098:126). Ceiling ≈ ₹2 14 748.36.
- `cart_items.price_cents` is the highest risk: a wedding deep-clean variant at ₹30L (`service_variants.price_paise = 300_000_00`, BIGINT) flows into the INT32 cart_items column → SQLSTATE 22003 (numeric_value_out_of_range) blocks add-to-cart.
- Fix: forward-only migration to BIGINT for all five; rename `_cents → _paise`.

### H-2. Surge `int(float * mult)` truncates fractional paise — cumulative loss
- `App/househelp-api/internal/booking/service.go:428`: `totalPriceCents = int(float64(totalPriceCents) * pricingConfig.SurgeMultiplier)`. Go `int()` truncates toward zero.
- 49999 × 1.5 = 74998.5 → 74998 (loses 0.5p). 33333 × 1.1 = 36666.300000000003 → 36666.
- Always rounds **down** (toward zero), never balanced. At 10k surge bookings/day × ~0.25p avg = ~₹9k/yr silent revenue loss.
- Fix: basis-point multiplier with half-even rounding — `int64((int64(total) * surgeBP + 5000) / 10000)`.

### H-3. Percent promo truncates after multiply — system favored
- `App/househelp-api/internal/booking/service.go:443`: `discountCents = totalPriceCents * promo.DiscountValue / 100`. Multiply-first is right, but the divide drops fractional paise.
- 50055 × 10 / 100 = 5005 (drops 0.5p). 50059 × 33 / 100 = 16519 (drops 0.47p). Always rounds discount **down** → customer overpays vs nominal coupon. Opposite direction from H-2.
- Fix: `(total * value + 50) / 100`.

### H-4. Stack rules (migration 086) ship a full schema but no application code
- `grep -rn "max_discount\|stack_rule\|applied_stack" App/househelp-api/internal/` → **zero matches outside migrations/tests**. `booking_services.applied_stack_rule_id` column (mig 090) is never populated.
- Impact: any admin creating stack rules sees them persisted, but they never affect pricing. If admins have created rules expecting them to apply, customers have been overcharged.
- Fix: implement or delete.

### H-5. Payroll cron fires at 01:00 IST on cycle-close day — sessions closing later that day are silently dropped
- `App/househelp-api/internal/payroll/calc.go:111-127`: `NextCloseAfter` returns `time.Date(y, m, d, 1, 0, 0, 0, istLocation)` on the close date.
- Aggregation `App/househelp-api/internal/payroll/repository.go:61-69` filters `sc.shift_date BETWEEN cycle_start AND cycle_end AND ss.offline_at IS NOT NULL`.
- Worked case: pro online 22:00 on 2026-05-15 to 02:00 on 2026-05-16. `shift_date = 2026-05-15`. Cron fired at 01:00 on 2026-05-15 — session not yet closed (still open) → excluded by `offline_at IS NOT NULL`. Next cycle (16th-EOM) won't see it because `shift_date = 2026-05-15` is **outside** that window. **The session falls through both cycles.**
- Fix: either fire cron at 01:00 IST on day *16* (after the close day has fully passed), or change cycle membership to `shift_date < cycle_close_date + 1` and run after that boundary.

---

## MEDIUM

### M-2. Cashfree FP round-trip negligible but non-zero
- `App/househelp-api/internal/payments/cashfree.go:491-493`: `float64(paise)/100.0` is exact when paise is integer (≤ 2^53). 50051/100.0 = 500.5099999999909 — Go json marshals as "500.51" (shortest round-trip), Cashfree parses 2dp. Webhook handler `handler.go:920-940` reads `amountPaise` from local DB row, never reconverts from Cashfree float — drift impossible.

### M-3. Cashfree env defaults to sandbox when `CASHFREE_PG_ENV` unset
- `App/househelp-api/internal/payments/cashfree.go:88-91`. A misconfigured Railway deploy silently runs all checkouts against sandbox; bookings flip `payment_status='paid'` from sandbox webhooks → system thinks money was collected. Inverse (prod keys / sandbox URL) would 401 loudly.
- Fix: refuse to start if `RAILWAY_ENVIRONMENT=production && CASHFREE_PG_ENV != production`.

### M-4. CartScreen `Math.ceil` split display ≠ backend `floor + remainder`
- Frontend `App/zopmop-app/src/screens/main/CartScreen.tsx:137`: `myShareCents = Math.ceil(totalCents / splitCount)`.
- Backend `App/househelp-api/internal/roomies/service.go:526-528`: `splitAmount = total / n; remainder = total % n; initiatorBasePay = splitAmount + remainder`. Initiator absorbs remainder.
- Worked case: total=1000, n=3. Frontend shows everyone "334". Backend: initiator pays 334, others pay 333. Non-initiators owe 1 paise less than displayed.
- Note: customer-payment `total_amount` sent to backend is the full `totalCents`, not myShare — no money-flow bug, just a display inconsistency.

### M-5. `PLATFORM_FEE_CENTS = 2000` hardcoded client-side (`CartScreen.tsx:53`)
- Drifts from backend `pricing_config` if changed. Customer sees wrong total before Cashfree sheet shows the real one. Trust hit, not money loss.

### M-6. `BASE_RATE_PER_HOUR = 80` hardcoded (`ProBookingCancel.tsx:17`)
- Same pattern as M-5 on pro side.

### M-7. Payroll `deductions_paise` is always 0 in v1
- `App/househelp-api/internal/payroll/calc.go:92` (`NetPayPaise: gross`) and `App/househelp-api/internal/payroll/repository.go:95` (literal `0` in INSERT). `admin_pro_deductions` table written but never read by cron.
- Pro earned ₹4000, admin entered ₹500 deduction → CRM shows `net_pay=4000, deductions=500` separately. Founder must remember to wire ₹3500. Manual, unenforced.
- Fix: aggregate `admin_pro_deductions` for the pro/cycle and stamp into the payout row.

---

## LOW

- **L-1.** RN `Math.round` vs CRM `toLocaleString({maximumFractionDigits:0})` — diverge on .50 boundaries.
- **L-2.** CartScreen pervasive `(price_paise/100).toFixed(0)` (lines 606, 616-620, 506, 635) — sub-rupee precision vanishes everywhere.
- **L-3.** Payroll `int64(minutes) * 8000 / 60` order is correct, bounded for max realistic minutes; sub-paise truncation OK.
- **L-4.** Leap year — `App/househelp-api/internal/payroll/calc.go:104-106` uses `time.Date(y, m+1, 0, ...)` "day 0 of next month" trick. Verified by tests `App/househelp-api/internal/payroll/calc_test.go:105-133` (2025-02-28 = close, 2025-02-29 = no-cycle, 2028-02-29 = close, 2028-02-28 = no-cycle).
- **L-5.** All payroll math runs through `istLocation` (`App/househelp-api/internal/payroll/payroll.go:29-44`, fallback `time.FixedZone("IST", 5*3600+1800)` for Alpine images missing tzdata).
- **L-6.** Zero-amount Cashfree orders short-circuited at `App/househelp-api/internal/payments/handler.go:434-437` ("zero_amount") and `App/househelp-api/internal/payments/cashfree.go:206-207`.
- **L-7.** Wallet topup 100 ≤ paise ≤ 500_000 enforced at `App/househelp-api/internal/payments/handler.go:466-473`.
- **L-8.** Negative refund guard: `App/househelp-api/internal/booking/repository.go:264-265` `refundAmount > 0`. Booking ₹50 / fee ₹100 → -5000 → no refund row.
- **L-9.** `payments.amount_paise BIGINT CHECK ≥ 0` (mig 056:15).
- **L-10.** `wallets.balance_paise CHECK ≥ 0` (mig 067:15) plus repo-level re-check `App/househelp-api/internal/payments/wallet/repository.go:136`.
- **L-11.** `booking.AmountPaise int` (`App/househelp-api/internal/booking/model.go:33`) — Go `int` = int64 on amd64/arm64 prod; safe.
- **L-12.** Cycle boundaries are DATE-based on `shift_commitments.shift_date` (`App/househelp-api/internal/payroll/repository.go:64-69`) — sessions don't split across midnight.

---

## Top 5 findings to action

1. **C-1** — Promotions need server-side bounds NOW. Single admin typo = mass free-bookings.
2. **C-2** — Pro earnings display loses 99p; pro vs founder will dispute payouts.
3. **H-5** — Late shift sessions silently dropped from payroll due to cron fire-time vs cycle membership.
4. **H-4** — Stack rules in DB but no code applies them; if admins created any, customers were overcharged.
5. **C-3 + M-7** — COD-cancellation fee is a display fiction; payroll deductions never roll into net pay → human reconciliation required.
