# ZopMop Business Rules Audit — 2026-05-21

**Branch audited:** feature/payroll-targets-flags (44a5ff5)
**Repos covered:** App/househelp-api (Go backend), App/zopmop-app (RN customer app), App/zopmop-crm (CRM React app)
**Method:** Static read-only inspection. Citations follow `(path:lineStart-lineEnd)`.
**Caveat:** This is a description of what the code does today, not what we want it to do. Where code disagrees with assumed rules, the code wins and the assumption is flagged for Aditya to decide.

## Top-of-doc Conflicts & Concerns

| # | Conflict / Concern | Where | Decision needed |
|---|---|---|---|
| C1 | **Two pro-pay formulas alive** — `booking/earnings.go` (₹80/hr base + ₹50/hr peak + ₹100 weekend) versus `payroll/calc.go` (₹80/hr online + ₹80/hr work, no peak/weekend). | `internal/booking/earnings.go:23-66` vs `internal/payroll/calc.go:79-94` | Pick one. If booking snapshot feeds payroll, remove duplication. Risk: pros paid both ways or neither. |
| C2 | **Cart pricing skips surge**, legacy `CreateBooking` applies surge. Same customer can game by routing via cart. | `internal/booking/cart_pricing_golden_test.go:134-145` | Either apply surge in cart, or document the intentional exemption. |
| C3 | **Integer truncation on cart line items** — `base × duration / min` truncates remainder; customer underpays/overpays by up to (min-1) paise per item. | `internal/booking/cart_pricing_golden_test.go:60-67` | Add rounding or accept the rounding error. |
| C4 | **Admin-initiated cancellation skips events** — `repo.CancelBooking` direct path, no booking.cancelled outbox event, no webhook, no analytics. Pro/customer not notified. | `internal/admin/service.go:395-420` vs `internal/booking/service.go:602-661` | Route admin cancel through service layer or accept silent admin cancels. |
| C5 | **No pro-initiated cancellation path** at all. | search of `internal/booking/` | Confirm intentional. |
| C6 | **No pro no-show or customer no-show penalty**. The pending-action sweeper only handles "no pro found". | `internal/booking/pending_action_sweeper.go:99-199` | Add no-show codepaths if business expects them. |
| C7 | **Aadhaar + bank account stored plaintext**. Phase 12 TODO. | `internal/crm/workers/repository.go:506-510`, `model.go:59-67` | Encrypt before pilot if any real KYC collected. |
| C8 | **Two admin permission systems coexist** — flat user-app perms (`PermManageUsers`, …) and CRM roles (`viewer/support/admin/superadmin` with 96 perms). No mapping. | `internal/admin/model.go:9-16` vs `internal/crm/auth/permissions.go:20-172` | Document or unify. |
| C9 | **Maps fail-open silently** — distance check skipped when Google Maps is unreachable; far-away pros may get assigned with no operator alert. | `internal/booking/service.go:34-42`, `internal/googlemaps/client.go:58-76` | Add alert or accept silent quality degradation. |
| C10 | **OTP "999999" hardcoded** in multiple code paths, including config layer, not strictly gated to dev only. | `internal/auth/service.go:377`, `handler.go:298`, `pkg/config/config.go:46`, RN `services/auth.ts:101` | Confirm production safety. |
| C11 | **Out-of-zone bookings silently accepted** — locality nil → "invite anyone". No soft warn, no fallback message. | `internal/booking/service.go:876-939`, `internal/matching/dispatch.go:300-340` | Decide hard-reject vs soft-warn vs current any-pro behavior. |
| C12 | **`max_per_user` and `stackable` promo fields unused** — stored but never read. Customer can reuse a single promo unlimited times subject to global cap. | `internal/offers/handler.go:99-111` | Either enforce or remove fields. |
| C13 | **Roomies group force-delete zeros prepaid balances** without crediting to main wallet (main wallet not built). | `internal/roomies/repository.go:119, 140`, `service.go:363` | Block force-delete or finish main wallet before pilot. |
| C14 | **Tips persisted client-side only** — no server sync visible. | `App/zopmop-app/src/screens/main/TipScreen.tsx:2` | Tips may be silently lost on reinstall. |

---

## Section 1: Pricing and Money

**Summary:** ZopMop's pricing operates in **paise** (INR hundredths), combining fixed service base prices with a flat platform fee, optional surge multipliers, and promo code discounts. Prices are stored as integers in DB; no GST/tax calculations are present in the codebase. Pro earnings have two formulas in code (see C1). Refunds route through Cashfree or manual ops; cancellation fees apply outside a 30-minute protection window.

### A. Pricing Model & Service Costs

**Base pricing per service:** Each service has a fixed `base_price_cents` (paise, stored in `service_categories.base_price_cents`) set at DB seed time and immutable by customer/pro. Examples from migration 015:
- Sweeping & Mopping: ₹25 (2500 paise)
- Fridge Cleaning: ₹149 (14,900 paise) — highest priced service
- All other standard services: ₹25 each

(App/househelp-api/migrations/015_seed_service_categories.up.sql:10-19)

**Pricing formula — Legacy instant bookings (CreateBooking):**
```
Total = base_price_cents + BaseFeeCents
If surge enabled and multiplier > 1.0: Total = int(Total × multiplier)
Discount = promo(Total)
Net = Total - Discount
```
(App/househelp-api/internal/booking/service.go:419-451)

**Pricing formula — Cart-based paths (CreateScheduledBooking, CreateInstantBookingFromCart):**
```
Cart item price = base_price_cents × duration_minutes / min_duration_minutes   (integer division — see C3)
Total = sum(item prices) + BaseFeeCents
Discount = promo(Total)
Net = Total - Discount
Surge is NOT applied in cart paths (regression guard in test: cart_pricing_golden_test.go:134-145)
```
(App/househelp-api/internal/cart/repository.go:169-191, internal/booking/service.go:1074-1084, 1216-1225)

CONFLICT C2 flagged at top.

### B. Platform Fees & Surge Pricing

**Platform/base fee:** Stored in `app_config` table, retrieved by `GetPricingConfig()`. Default fallback: ₹20 (2000 paise). (App/househelp-api/internal/booking/service.go:420-424, 1079-1082)

**Surge multiplier:** Also fetched from config; controlled via `pricing.surge_enabled` boolean and `pricing.surge_multiplier` float. When enabled and > 1.0, applied AFTER adding base fee but BEFORE promo discount. (App/househelp-api/internal/booking/service_pricing_golden_test.go:55-64, 131-144)

**Worked example (legacy path, surge 1.5):**
- Service: Sweeping & Mopping (₹25), base fee ₹20
- Before surge: 2500 + 2000 = 4500 paise
- After surge: int(4500 × 1.5) = 6750 paise = ₹67.50

### C. Currency Storage & Display Conversion

All monetary amounts stored as **integer paise** (₹1 = 100 paise):
- `bookings.amount_paise`, `bookings.discount_paise` (migration 065)
- `payments.amount_paise` (migration 056)
- `cart_items.price_cents` (legacy naming; actually paise after migration 089)
- `service_categories.base_price_cents`

No explicit Go-side display conversion layer. Cashfree gateway accepts rupees as float; `paiseToRupees()` converts at the boundary. (App/househelp-api/internal/payments/cashfree.go:127-167)

**No GST / tax math anywhere in code.** Amounts shown to customer are net charged (any GST is implicitly baked into base_price_cents).

### D. Promo Codes & Discounts

**Promo types:** Two mutually exclusive types per code:
- **"percent"**: discount = total × value / 100
- **"fixed"**: discount = value paise

(App/househelp-api/internal/booking/service_pricing_golden_test.go:24-35, 76-87, 90-99)

**Clamping:** discount > total → clamp to total. Net never negative. (service.go:447-449)

**Eligibility gates in GET /api/v1/offers:**
- `is_active = TRUE`
- `starts_at IS NULL OR starts_at ≤ NOW()`
- `expires_at IS NULL OR expires_at > NOW()`
- `max_uses = 0 OR uses_count < max_uses`
- **Audience filtering:**
  - `audience='all'` → everyone
  - `audience='user_segment'` → only specific user IDs in `audience_user_ids[]`
  - `audience='new_users'` → users with no completed (non-cancelled) bookings

(App/househelp-api/internal/offers/handler.go:60-92)

**No multi-promo stacking.** Only one promo per booking. (model.go:130-137)

CONFLICT C12 flagged: `max_per_user` and `stackable` columns exist (migration 007) but never read.

### E. Pro Earnings & Revenue Split

CONFLICT C1 flagged at top.

**booking/earnings.go formula (snapshotted at completion):**
```
base_job_pay       = ROUND(actual_duration_minutes / 60 × 8000) paise = ₹80/hr
peak_surcharge     = +₹50/hr (5000 paise) proportional to actual_duration_minutes
                     when completed_at falls in IST peak: 08:00–11:00 or 17:00–20:00
weekend_bonus      = +₹100 flat (10000 paise) on Sat/Sun IST
total_pro_earnings = base + peak + weekend
```
(App/househelp-api/internal/booking/earnings.go:23-66)

**Worked example:** Booking completed 09:30 IST Wednesday, 90-minute actual:
- Base: 90/60 × 8000 = 12000 paise = ₹120
- Peak: 90/60 × 5000 = 7500 paise = ₹75 (in 08:00–11:00)
- Weekend: 0
- **Total: ₹195**

`bookings.pro_earnings_paise` is set at completion. No per-transaction payout-ledger row written here; the payroll engine (Section 6) computes pay from a totally different formula using `shift_sessions.online_minutes` + `job_minutes`.

### F. Refunds & Cancellations (also see Section 3)

**Cancellation fees:**
- **Free window:** ₹0 if cancelled ≥30 min before scheduled start (or before created_at for instant bookings)
- **Charged window:** ₹100 flat (10000 paise = `DefaultCancellationFeeCents`)

(App/househelp-api/internal/booking/cancellation.go:6-36)

**Refund gateways:**
1. **Cashfree:** POST /orders/{order_id}/refunds with idempotency key `refund_id`. Converts paise → rupees at boundary. (App/househelp-api/internal/payments/cashfree.go:127-167)
2. **Manual:** no-op refund, sets `Manual=true`. Ops settles offline. (internal/payments/manual.go:16-18)
3. **Wallet:** refund implemented as wallet credit (topup). (booking/service.go:128-138, 213-273)

**Payment status flow:**
```
bookings.payment_status: NULL → 'pending' → 'paid' / 'failed'
bookings.payment_method: NULL | 'cashfree' | 'wallet'
payments.gateway_status: pending → success | failed | refunded
payments.reconciled: FALSE → TRUE (after reconciliation cron)
```
(internal/booking/service.go:243-251, 294-301)

**Unpaid booking block:** Customer can't create a new booking if they have completed-but-unpaid Cashfree bookings. (service.go:386-397, 1032-1041)

### G. Cart Pricing (Multi-Service Bookings)

```
item_price = base_price_cents × duration_minutes / min_duration_minutes
```
default `min_duration_minutes` = 30 across all seed services. (internal/cart/repository.go:169-191)

**Examples:**
- Sweeping 60 min: 2500 × 60/30 = 5000 paise = ₹50 ✓
- Sweeping 37 min: 2500 × 37/30 = 3083 paise (truncated; C3)
- Fridge 30 min: 14900 × 30/30 = ₹149 ✓

Cart total = sum items + BaseFeeCents. Cart cleared automatically after successful scheduled booking.

### H. Payment Methods & Gateways

`CreateBookingRequest.payment_source`:
- **""/`direct`** (default): Cashfree hosted checkout OR COD fallback. Payment_method stamped `cashfree` immediately; webhook flips status to `paid`. Customer app filters out unpaid Cashfree rows.
- **`wallet`**: closed-loop wallet debit inline. Insufficient → `ErrInsufficientWalletBalance` (402). Success → payment row with `gateway='wallet', gateway_status='success'`, no webhook.

(App/househelp-api/internal/booking/service.go:359-515, 492-514)

**Ledger (payments table):** one row per intent at booking confirm. (internal/payments/ledger.go:37-54)

### BEHAVIORS THAT MAY BE BUGS

- B-1: integer truncation in cart (C3).
- B-2: surge bypass via cart path (C2).
- B-3: `max_per_user` and `stackable` promo fields silent (C12).

### GAPS

1. No GST math anywhere in code.
2. Config keys `pricing.surge_enabled`, `pricing.surge_multiplier`, `pricing.base_fee_cents` referenced but not seeded in migrations — assumed set by CRM offline.
3. No visible check that refund amount ≤ captured amount. Assumed Cashfree enforces.
4. No "pro_payouts" ledger row in booking module — reconciliation logic (customer charge − pro earn − refund − fee) not visible.
5. Two pro-pay formulas alive (C1).

---

## Section 2: Booking Lifecycle

**Summary:** Six core states (pending, searching, accepted, in_progress, completed, cancelled) plus the transient `pending_customer_action` for stealth-instant timeouts. Transitions are enforced by the service layer; DB schema is not as strict.

### State Transitions

| From | To | Trigger | Who | Guards | Side effects |
|------|-----|---------|-----|--------|--------------|
| (initial) | pending | CreateBooking() | Customer | service category active, no unpaid Cashfree bookings, max 1-2 active bookings per customer | payments row created, analytics, instant bookings enqueued to matcher |
| pending | searching | Stealth dispatch cron | System | `is_stealth_instant=true`, fire_at reached | FCM invites in batches |
| pending/searching | accepted | AcceptBooking() | Pro | walking ETA ≤25 min via Google Maps (fail-open), pro max 3 active bookings | `accepted_at`, `helper_id`, pro phone unmasked to customer, webhook `order.assigned` |
| accepted | in_progress | StartBooking() | Pro | status='accepted' | `started_at`, webhook `order.started` |
| in_progress | completed | CompleteBooking() | Pro | status='in_progress' | `completed_at`, `customer_rating_pending=true`, `pro_earnings_paise` snapshot, helpers.total_jobs++, booking_services flush to completed, booking.completed outbox event, webhook, referral completion |
| pending/accepted | cancelled | CancelBooking() | Customer | only pending/accepted; if accepted, only if payment not settled | fee logic per Section 3, may emit pending_refunds |
| any | cancelled | PendingActionSweeper | System cron (5-min tick) | status='pending_customer_action' AND updated_at < NOW()-30min | fee=0, refund routed, booking.cancelled emitted |
| any | cancelled | admin CancelBooking | Admin | none | audit log; **no outbox/webhook/analytics** (C4) |

(App/househelp-api/internal/booking/model.go:8-20, service.go:664-756, 1595-1613, 1794-1891, handler.go:350-380, pending_action_sweeper.go:99-199, admin/service.go:395-420)

### Time Limits

- **Stealth-instant** fires 15 min before scheduled_time (`stealthFireLeadTime=15min`).
- **`pending_customer_action` timeout**: 30 min, then sweeper auto-cancels free, releases slot capacity, routes refund.
  (App/househelp-api/internal/booking/pending_action_sweeper.go:24-88, service.go:57-96)

### Modification After Creation

- **Reschedule** (scheduled bookings): allowed in `pending` or `accepted`. Slot capacity enforced via FOR UPDATE locks. (service.go:1659-1789)
- **"Keep Looking"** (stealth only): customer resets `pending_customer_action` → `pending` with new fire_at=NOW(). (service.go:960-998)
- **Locked post-accept**: address, service category, price immutable once `helper_id` set.

### Phase-10 sub-state timestamps (advisory, not gating)
`accepted_at`, `en_route_at`, `arrived_at`, `started_at`, `completed_at` columns exist. `MarkArrived()` logs but does NOT change status. (model.go:40-48, service.go:1585-1593)

### GAPS

1. No actual en_route/arrived state machine — only advisory timestamps.
2. No pro-initiated cancellation path (C5).
3. No explicit no-show detection (C6).

---

## Section 3: Cancellation

**Summary:** Three entry points (customer, admin, auto-sweeper). Refund depends on **when** vs scheduled start and **how** paid.

### Free Cancellation Window

Free cancel if requested **more than 30 minutes before** scheduled start. Cutoff: `FreeCancelDeadline(start) = start.Add(-30 * time.Minute)`. Now < deadline → free. (App/househelp-api/internal/booking/cancellation.go:5-36)

For instant bookings (no future scheduled_time), the cutoff is computed from `created_at` and is always already past, so they're outside the free window from inception.

### Customer-Initiated

Endpoints: POST /bookings/:id/cancel, DELETE /bookings/:id. Status must be `pending` or `accepted`.

**Fee:** ₹0 inside window, ₹100 outside (`DefaultCancellationFeeCents = 10000`).

**Refund routing:**
1. `payment_method=NULL/cod` → no refund
2. `payment_status≠paid` → no refund
3. `payment_method=wallet` → wallet credit (minus fee if applicable)
4. `payment_method=cashfree` → pending_refunds row, status='pending', awaiting settlement

**Side effects:** booking.cancelled outbox event, webhook `order.cancelled`, analytics, Redis match keys cleared.

(App/househelp-api/internal/booking/service.go:602-661, cancellation.go:7-36, repository.go:213-270)

### Automatic (Pending Action Sweeper)

5-min tick. Always fee=0. Refund routed identically. Releases `time_slots.current_bookings`. Sends FCM "Booking cancelled. Tap to rebook." (App/househelp-api/internal/booking/pending_action_sweeper.go:99-199)

### Admin-Initiated

PATCH /admin/bookings/:id/cancel (requires PermManageUsers). No state restrictions. No fee. **Calls `repo.CancelBooking` directly, bypassing outbox + webhooks + analytics** (C4). (App/househelp-api/internal/admin/service.go:395-420, handler.go:47)

### Pro Pay on Cancellation

Pro earnings snapshot only at completion. **Pre-completion cancellation → pro earns ₹0** regardless of cause. No pro penalty for declining or abandoning. (C5, C6)

### Worked Example

Booking scheduled 18:00 IST, customer cancels 17:30, payment cashfree wallet, amount ₹5000, no discount:
1. Free deadline = 17:30. Now (17:30) not strictly < deadline → fee applies.
2. Fee: ₹100.
3. Refund = 500000 − 0 − 10000 = **₹4900**.
4. pending_refunds row created (status=pending, payment_method=cashfree).
5. Pro earns ₹0 (booking never completed).

### GAPS

1. No pro-initiated cancellation (C5).
2. Admin cancel doesn't emit events (C4).
3. No pro/customer no-show penalty (C6).

---

## Section 4: Dispatch and Matching

**Summary:** Sequential invite chain. Phase 1 invites customer's "Your Experts" preferred helpers in oldest-first order; Phase 2 broadcasts to a shuffled general pool (cap 60). Per-pro window = 25 seconds, polled every 5 seconds. Hard chain cap = 30 minutes total.

### Preferred Pros ("Your Experts")

Up to 5 preferred helpers per customer, stored in `user_preferred_helpers`, ordered oldest-first. Each preferred pro is only invited if they pass all eligibility gates. If all preferred pros decline/timeout, system marks phase exhausted and switches to general pool. Stealth "Keep Looking" resume skips the preferred phase. (App/househelp-api/internal/experts/repository.go:142-166, model.go:4-22; internal/matching/dispatch.go:499-518)

### Eligibility Gates (each pro, single SQL query)

- account not banned/deleted, role `helper` or `pro`
- `approval_status='approved'`
- no approved `pro_leaves` row for that date
- no overlapping accepted/in_progress booking inside scheduled window + duration
- open `shift_sessions` row (online_at NOT NULL, offline_at NULL)
- current shift_commitment has ≥ (duration + 15 min travel buffer) remaining; skipped if no commitment
- locality match: pro's `pro_zone_assignments.zone_id → service_zones.name` (case-insensitive) matches booking.locality. Legacy fallback to `helpers.locality`.

(App/househelp-api/internal/matching/dispatch.go:159-273)

### Locality Resolution

Tokenize both address text and active locality names; longest-match wins. No match → `locality = nil` → invite any pro (C11). (App/househelp-api/internal/booking/service.go:862-939)

### General Pool (Phase 2)

All non-deleted, non-banned, approved helpers; locality filter applied if locality known; exclude phase-1 attempts; shuffle; cap 60. Each pro then revalidated against eligibility gates. (App/househelp-api/internal/matching/dispatch.go:300-340)

### Invite Chain Mechanics

For each pro:
1. Add booking to pro's Redis invite set (`matchHelperKeyFmt`).
2. Fire SCHEDULED_INVITE FCM data-only push with booking metadata.
3. Poll `bookings.helper_id` every 5s for up to 25s. Pro's id in column → assigned. Different id → race lost, abort. No id after 25s → next pro.

Hard cap **30 min** for full chain; exceed → booking marked cancelled, "no pros found" notification. (dispatch.go:353-438, 441-534)

### Scheduled vs Stealth Timing

- **Scheduled (booked before 8 PM IST):** `is_stealth_instant=false`. ScheduledDispatcher cron runs nightly at 22:00 IST, picks unassigned scheduled bookings firing within 6–30 hours, claims via `SELECT FOR UPDATE SKIP LOCKED`, runs InviteChain. (App/househelp-api/internal/matching/scheduled_dispatch.go:92-202)
- **Stealth instant (booked at/after 8 PM IST):** `is_stealth_instant=true`, `fire_at = scheduled_time − 15 min`. StealthDispatcher (1-min tick) finds eligible bookings, flips status to `searching` in the same tx, runs InviteChain with deadline = `fire_at + 15 min`. (App/househelp-api/internal/booking/service.go:57-92, 822-860; internal/matching/stealth_dispatch.go:1-198)

### Worked Example — 9 AM scheduled cleaning in Indiranagar

Customer books at 7:15 PM today for 9 AM tomorrow, 60-min cleaning, Indiranagar. `is_stealth_instant=false`. Locality resolved.
- 22:00 IST tonight: ScheduledDispatcher claims booking.
- Phase 1: preferred pros invited oldest-first, 25s each, 5s poll.
- Phase 2: ~60 Indiranagar-matched pros (online, ≥75 min shift remaining, no overlap), shuffled, 25s each.
- Acceptance → customer gets FCM "Your pro [name] accepted".
- 30 min total chain exhaustion → booking cancelled, FCM "couldn't find a pro".

### GAPS

1. No "broadcast all" mode; only sequential.
2. No persistent decline marker; if chain re-runs (stealth Keep Looking), a previously-declining pro can be re-invited.
3. No distinct "all declined" outcome vs "timeout".
4. Out-of-zone booking silently invites any pro (C11).

---

## Section 5: Scheduling and Shifts

**Summary:** Pro shifts are daily declarations (`shift_date`, `start_time`, `end_time`) locked at 3 AM IST of the shift date. No-commit by 3 AM → absence row, ₹300 cash or 1 leave deducted. Leave is per-day, monthly quota, lazy-reset. Pay rolls up fortnightly.

### Lock Cutoff

3 AM IST cron `LockShiftsAt3AM`:
- stamps `locked_at` on all shifts for that date
- creates absence rows for pros without a commitment (one absence per fortnight, first-in-fortnight no cash, beyond → ₹300 or 1 leave)

After 3 AM, `UncommitShift` rejects locked/non-committed status. Today's shift becomes immutable at 3 AM even if pro is already online. (App/househelp-api/internal/shift/service.go:44-162)

### Leave Management

Endpoint `DeclareTomorrow` (must be before 9 PM IST). Decrements monthly balance by 1, inserts `pro_leaves` row (status='approved'). Balance 0 → `ErrBalanceExhausted`. Triggers reassignment/cancellation of all bookings for that pro on that date. (App/househelp-api/internal/leave/service.go:71-186)

Leave reset is **lazy**: checked in `Balance()`, triggered on first use of the month. Edge case: pro who never calls `Balance()` until 2nd of month gets reset only then, not at midnight on 1st.

### Online Sessions

GoOnline:
- verifies shift active (locked or today AND between shift_start − 30 min and shift_end)
- creates `shift_sessions` row with `online_at`, `location_verified_at_start`, `manual_approval_used`
- `late_show=true` if Go Online > shift_start + 30 min (`OnTimeGraceMinutes`)

`shift_sessions.job_minutes` accumulates active service time per session. (App/househelp-api/internal/shift/model.go:43-67; service.go:175-280)

### Manual Zone Approval

If pro goes online outside their zone's `shift_radius_km` (default 1.0 km, raised to 3.0 km for large zones per migration 099) and no admin pre-approval, GoOnline returns `RequiresManualApproval=true`. Pro uploads selfie via `RequestManualApproval` → zone_approval_requests row. Admin approves/rejects. Once approved, future GoOnline calls for that commitment skip radius check. (App/househelp-api/internal/shift/service.go:207-241, 283-355)

### Shift Enforcement / Penalties

- **No-commit absence**: ₹300 cash deduction OR 1 leave deducted (whichever applies). First-in-fortnight gives one free pass.
- **Late show**: flagged, not penalized in visible code.
- **Pro-initiated booking cancellation 5-strike rule**: 1–4 free (if customer was notified), 5+ deducts `(BaseRatePaisePerHour × estimated_minutes) / 60`, default ₹80/hr.
- **No penalty for committed-but-never-online**: if pro commits but never taps Go Online, no visible code creates a penalty.

(App/househelp-api/internal/shift/service.go:175-280, 357-398; model.go:8-20)

### Fortnight Anchor

`helpers.fortnight_start_date` (default first Monday on/before today). No code rolls it forward; appears to stay static until manual CRM update or external script. Pay calculation operates within the 14-day window from this date.

Pay components:
- Online pay: `BaseRatePaisePerHour=₹80` for minutes ≤ target_minutes (weekly_hours_target × 2)
- Overtime: `OvertimeRatePaisePerHour=₹90` above target
- Job pay: separate per-job rate, not in shift module

NOTE: this contradicts payroll/calc.go (₹80/hr online + ₹80/hr work). See C1.

### GAPS

1. No code rolls fortnight_start_date forward.
2. No enforcement of weekly hours target (used for pay calc but no warning/penalty for shortfall).
3. No penalty for commit-without-go-online.
4. Leave reset is lazy, not cron-driven.
5. No API for mid-day shift extend, reschedule, swap.

---

## Section 6: Payroll

**Summary:** Half-month cycles (1st–15th and 16th–last). Cron runs at 01:00 IST on each cycle close (with boot-replay safety). Pay = (online_minutes/60)×₹80 + (working_minutes/60)×₹80. Two flags (`hours_target_missed`, `acceptance_below_threshold`) trigger admin review only — never auto-action. Payouts manual: `pending_manual_payout → paid` (or `failed → recompute`). Full audit trail.

### Formula

```
pay_paise = (online_minutes × 8000 / 60) + (working_minutes × 8000 / 60)
```
Both rates = ₹80/hr. Integer division at end. (App/househelp-api/internal/payroll/payroll.go:1-44, calc.go:79-94)

**Invariant:** `working_minutes ⊆ online_minutes`. Violation → cron logs error, skips pro, no payout row. (calc.go:8-12, service.go:159-168)

### Worked Example

Pro "Aditya" works 15-day cycle (May 1–15, 2026). Sessions sum to:
- 5220 online min (87 hours)
- 3900 job min (65 hours)

```
base_pay_paise   = 5220 × 8000 / 60 = 696,000 paise = ₹6,960
working_bonus    = 3900 × 8000 / 60 = 520,000 paise = ₹5,200
gross_pay_paise  = ₹12,160
deductions_paise = 0
net_pay_paise    = ₹12,160
```

### Cycle Definitions

| Cycle | Start | End | Close |
|-------|-------|-----|-------|
| 1 | 1st | 15th | 15th 01:00 IST |
| 2 | 16th | last day of month | last day 01:00 IST |

Cron fires daily 01:00 IST. Cycle-close → run close. Otherwise sleep. (App/househelp-api/internal/payroll/cron.go:30-80)

**Boot replay:** API starting after 01:00 IST on close date replays the close immediately. Idempotent via `ON CONFLICT DO NOTHING`. (cron.go:42-50)

### Online Hours

Elapsed wall-clock from online-tap to offline-tap. `shift_sessions.online_minutes` stored at offline. Multiple toggles → multiple session rows. **Only closed sessions counted** (offline_at NOT NULL). Open sessions excluded, count logged. (App/househelp-api/internal/payroll/repository.go:49-73; migrations/098_shift_system.up.sql:74-90)

### Working Hours

`shift_sessions.job_minutes` = cumulative active-service minutes during the session. Doesn't separately track travel/prep/post-service. Model pays for all online time as base + working bonus.

### Fortnight Targets & Proration

- **Hours target**: ≥80 online hours/cycle
- **Acceptance rate**: ≥85% of eligible offers. Zero-dispatch → N/A.

Proration for mid-cycle join/deactivation:
```
days_available = max(0, days from max(effective_start_date, cycle_start)
                          to min(deactivated_at, cycle_end), inclusive)
target_hours   = ceil(80 / 14 × days_available)
```

Examples:
- Pro joins May 8, cycle May 1-15: 8 days → target = ceil(80/14×8) = **46 h**
- Pro deactivated May 20, cycle May 16-31: 5 days → target = **29 h**
- Zero overlap → target = 0 (free pass)

(App/househelp-api/internal/payroll/calc.go:129-160, service.go:20-62, repository.go:110-128; crm/payroll/payroll.go:480-611)

### Flags

| Flag | Trigger | Action |
|------|---------|--------|
| `hours_target_missed` | online_h < prorated target AND target > 0 | Admin review only |
| `acceptance_below_threshold` | accept_rate < 0.85 AND dispatched > 0 | Admin review only |

**Action mechanics:**
- Row in `helper_flags`, UNIQUE(helper, cycle_start, flag_type)
- Status: `open → reviewed | dismissed | escalated`
- **Never auto-action:** no payout deduction, no auto-deactivation, no shift suspension
- Payout row always written regardless of flags; flag insert is non-blocking

(App/househelp-api/internal/payroll/service.go:13-63; migrations/110_helper_flags_and_dispatched_accept_cancel.up.sql:21-74; internal/crm/payroll/payroll.go:613-660, 480-611)

### Effective Start Date (03:00 IST Cutoff)

```
now < 03:00 IST → effective_start_date = today (IST date)
now ≥ 03:00 IST → effective_start_date = tomorrow
```

Rationale: shift commitment bus leaves 03:00 IST. Sign up before → can work today. After → tomorrow only.

`ComputeEffectiveStartDate(now)` called during user create in `internal/auth` and `internal/crm/workers`. Migration 108 backfilled with `(created_at AT TIME ZONE 'Asia/Kolkata')::date`. (App/househelp-api/internal/payroll/calc.go:108-127)

**Examples:** Hired 02:30 IST May 10 → eff May 10. Hired 03:15 IST May 10 → eff May 11.

### Payout State Machine

```
pending_manual_payout
   │
   ├─→ mark-paid → paid (paid is irreversible directly)
   │                ↑
   │                │ (mark-failed from paid OK)
   │                ↓
   ├─→ mark-failed → failed (reversible)
   │                │
   │                └→ recompute → pending_manual_payout (updated amounts)
   │
   └─→ recompute → pending_manual_payout (fresh calc)
```

| Status | Reversible? | Notes |
|--------|------------|-------|
| pending_manual_payout | yes | Initial |
| paid | no (must mark-failed first) | Records paid_at, paid_by_admin_id, transaction_id |
| failed | yes | Records failure_reason; paid_at preserved across reversal |
| skipped / cancelled | — | Reserved, not currently written |

**Paid immutability:** `paid → recompute` blocked, returns `ErrPaidRowImmutable` (HTTP 403). Forces `paid → mark-failed → recompute` path. (App/househelp-api/internal/crm/payroll/payroll.go:394-399, 918-920)

**Audit trail** (`payout_audit_log`): every status change writes audit row in same tx with full before/after JSON, admin_id, optional notes. (migrations/109_payroll_admin_audit.up.sql:35-57; crm/payroll/payroll.go:464-477)

### Eligible Helpers

```sql
SELECT h.id::text
  FROM helpers h
  JOIN users u ON u.id=h.id AND u.role='pro' AND u.deleted_at IS NULL
 WHERE h.effective_start_date <= cycle_end::date
```

Excludes pros hired strictly after cycle_end, deleted users, non-pros. **Zero-activity pros still get a row** (all zeros) for audit trail. (App/househelp-api/internal/payroll/repository.go:18-47)

### Manual Trigger

`POST /payroll/run` with `{cycle_start, cycle_end}` runs arbitrary window. Empty body → `RunForToday()` (must be close date, else 400). (App/househelp-api/internal/payroll/handler.go:18-70)

### Schema

| Table | Purpose |
|-------|---------|
| `helpers` | identity, `effective_start_date`, `deactivated_at` |
| `payouts` | one row per (pro, cycle_start); paise breakdown; status; transaction_id; paid_at; paid_by_admin_id; failure_reason; notes |
| `payout_audit_log` | full status-change history with JSONB before/after, admin_id |
| `helper_flags` | performance warnings, status open/reviewed/dismissed/escalated |
| `shift_sessions` | online_at, offline_at, online_minutes, job_minutes |
| `dispatched_jobs` | offer tracking (pending/accepted/declined/timed_out), `accept_then_cancel` |

### GAPS

1. v1 deductions = 0 (schema-ready, never populated).
2. No auto-disbursement — `paid` is human-marked. Expected: admin batch-wires (e.g. Razorpay payouts), enters txn_id, marks paid.
3. `accept_then_cancel` column plumbed but not used in flags or deductions.
4. `helpers.deactivated_at` never auto-populated; reserved for manual admin action.
5. Flags dismiss does NOT change payout state — purely observational.
6. No partial-cycle flags — only at close.
7. Zero-dispatch acceptance N/A means a pro with one declined offer can get a free pass.
8. CONFLICT C1: booking/earnings.go vs payroll/calc.go formulas.

---

## Section 7: Authentication and Accounts

**Summary:** Customer self-signup via OTP (Message Central). Pro = customer who applied + admin-approved (role flip is separate from onboarding). CRM admins provisioned offline via SQL. OTP 6 digits / 10-min expiry / 60s resend cooldown / 5-fail lockout 15 min.

### Account Creation Paths

1. **Customer self-signup**: POST /auth/send-otp → POST /auth/verify-otp. New phone → users row with `role='customer'`, `has_accepted_privacy_policy` stamped. Only path for customer creation. (App/househelp-api/internal/auth/handler.go:296-363, service.go:476)
2. **Customer → Pro upgrade**: POST /me/onboard-pro. Inserts `helpers` row with `approval_status='pending'`. **Explicitly does NOT change `users.role`.** Existing session continues. (auth/handler.go:449-476, service.go:313-329)
3. **CRM admin**: provisioned offline by ops via SQL using env-bootstrapped credentials. No API endpoint for admin self-signup. (migrations/039_crm_core.up.sql:135-137)

### OTP Rules

| Rule | Value | Citation |
|------|-------|---------|
| Code length | 6 digits | auth/service.go:18-23 |
| Expiry | 10 min | auth/service.go:18-23 |
| Resend cooldown | 60 s per phone | auth/service.go:158-169 |
| Send/phone | 3 per 15 min | auth/ratelimit.go:32-41 |
| Send/IP | 5 per 15 min | auth/ratelimit.go:32-41 |
| Verify/phone | 5 per 10 min | auth/ratelimit.go:32-41 |
| Failed attempts before lockout | 5 | auth/service.go:230-245 |
| Lockout duration | 15 min | auth/service.go:230-245 |

Lock and failure counters reset on successful verification.

**Dev mode**: `OTP_DEV_MODE=true` → `SendOTP` returns hardcoded `"999999"`. See C10. (handler.go:326-329)

### Account Lifecycle: Suspension & Deletion

**Suspension** (admin only, PermManageUsers): PATCH /admin/users/:id/suspend sets `users.is_suspended=true`. Effects:
- Login blocked: `SendLoginOTP` for suspended pro returns `ErrAccountSuspended` (403). (auth/service.go:402-404)
- Middleware does **live DB read of `is_suspended` on every authed request** — rejects even with valid JWT. (middleware/auth.go:132-150)
- Refresh invalidates all refresh tokens. (auth/service.go:531-536)

**Soft delete** (customer self-serve): DELETE /me sets `deleted_at`. Blocked if unpaid Cashfree bookings (409). Filtered out of all queries via `deleted_at IS NULL`. **Not reversible via UI.**

**CRM admin lockout**: failed CRM logins above threshold trigger `crm_admins.locked_until`. Cleared on successful login. No deactivation endpoint. (crm/auth/service.go:99, repository.go:104-115)

### Pro Role Assignment

Two-step:
1. Customer calls `POST /me/onboard-pro` → helpers row pending. role unchanged.
2. Admin approval (endpoint outside auth module, in CRM workers/admin) → `helpers.approval_status='approved'` AND `users.role='pro'`.

Next login issues JWT with `typ='pro'`, routes client to pro nav stack.

### One Phone, Multiple Roles?

`users.role` is a single VARCHAR(10) constrained `IN ('customer','pro','admin')`. (migrations/001:10, 019:6) **A single user cannot hold both customer and pro roles simultaneously.** Role is bumped in place. JWT refresh picks up new role on rotation, but client's cached role can be stale mid-session.

### Account Properties

- `has_accepted_privacy_policy` boolean, stamped on create, updatable via `MarkPrivacyAccepted`
- `phone_verified_at` stamped on first verify success (auth/service.go:491-492)

### GAPS

1. Pro approval endpoint not in auth module — assumed in `internal/crm/workers/...` or unmapped admin handler.
2. User-app `PermManageUsers` and CRM roles are two distinct systems (C8).
3. CRM admin self-signup missing — purely manual provisioning.
4. No `is_active` deactivation for CRM admins, only `locked_until`.
5. Multi-client session role-staleness untested.

---

## Section 8: Ratings and Reviews

**Summary:** Customers can rate after completion. App treats rating as required (home banner), API does not. Pros do not rate customers. Pro rating is derived aggregate. No edit, no delete, no moderation.

### Customer Rating Flow

- Trigger: booking reaches `completed`. `customer_rating_pending=true` set.
- Endpoint: POST /bookings/:id/review. Body `{rating:1-5, comment≤1000 chars}`.
- Validation: rating ∈ [1,5]; comment trimmed; NULL if empty. UNIQUE(booking_id) → one review per booking, 409 on second attempt.
- Authorization: only booking's customer.
- Side effects: `customer_rating_pending=false` (best-effort), analytics `EventRated` emitted.

(App/househelp-api/internal/reviews/reviews.go:31-35, 58-119)

### Pro Ratings (Derived)

Aggregate stored on `helpers.rating`, recomputed via after-insert trigger (migration 057). **No reciprocal pro→customer rating** exists.

### Visibility

- Customer sees pro name, masked phone pre-accept (unmasked post-accept), aggregate rating, total_jobs. Individual reviews not exposed.
- Pro perspective on reviews not visible in the reviews module — likely surfaced via matching/dispatch info, not investigated.

(internal/booking/model.go:71-78)

### Usage in Dispatch / Deactivation

- ProApproved middleware gates accept/start/complete on `approved` status, **not on rating**. (booking/handler.go:38-50)
- Admin queries can filter by min_rating. (admin/handler.go:140-150)
- **No automatic deactivation based on rating** visible.

### Edit / Remove

- No edit endpoint.
- No delete endpoint.
- UNIQUE constraint blocks second submit. Correction → manual DB only.

### GAPS

1. Rating filter in dispatch not visible — may live in matching engine, not in reviews module.
2. No pro→customer rating.
3. No review moderation (length-validated only).
4. No review visibility to pros before completion.

---

## Section 9: Notifications (FCM + SMS)

**Summary:** FCM for push (graceful degrade), Message Central for OTP (hard dependency), transactional outbox for durable booking events. Token cleanup automatic on Firebase "unregistered". 90-day token freshness gate.

### Architecture

- `internal/notification/Service` wraps Firebase Admin SDK + Postgres pool.
- `TokenResolver` deletes "unregistered" tokens on report. (service.go:154-180, 221-233)
- Only tokens updated within last 90 days included in broadcasts. (resolver.go:26)
- Missing FIREBASE_CREDENTIALS_JSON → mock that logs intent, no push. Bookings continue. (service.go:40-59)

### OTP (Message Central)

Stateful: `SendOTP` returns `verificationId`, persisted in Redis. `VerifyOTP` requires id + code. Long-lived bearer; no auto-renew. 401 from MC → misconfig with no retry. (auth/messagecentral.go:18-44, 114-149)

Dev mode short-circuits: id `dev-<national>`, code `999999`. (messagecentral.go:32-44)

### Event Catalogue

| Event | Channel | Recipient | Fallback |
|-------|---------|-----------|----------|
| booking.accepted | FCM notification | customer | none — token missing = silent |
| booking.completed | FCM notification | customer | silent |
| booking.cancelled (pro side) | FCM notification | pro | silent |
| no helper found | FCM | customer | silent |
| refund processed | FCM | customer | silent; gated by admin approval |
| booking cancelled (customer view) | FCM | customer | silent |
| pro: new booking invite | FCM data-only multicast | matched pro(s) | server-side timeout advances chain |
| pro: scheduled booking assigned | FCM | pro | silent |
| pro: booking reassigned by admin | FCM | pro | silent |
| pro: booking unassigned by admin | FCM | pro | silent |
| customer: helper changed (admin) | FCM | customer | silent |
| customer: helper reassigned (pro on leave) | FCM | customer | silent |
| customer: booking cancelled (no coverage) | FCM | customer | silent |
| pro en-route / arrived | FCM data-only | customer | silent; tracking |
| zone approval pending | FCM | admin group | silent; best-effort |
| zone approval granted/rejected | FCM | pro | silent |
| customer reengagement | FCM | customer | silent; multicast report cleans invalid tokens |
| OTP delivery | SMS via MC | phone | **no fallback; failure blocks login** |

(notification/service.go:18-666; outbox/handlers.go:30-78; shift/notifier.go:49-99; booking/jobs.go, dispatch.go; auth/messagecentral.go:151+)

### Mechanisms

- **FCM notification (system tray):** booking-state pushes. Mock-on-fail.
- **FCM data-only:** scheduled invites + en-route/arrived. App handles via `data["type"]`.
- **Transactional outbox:** booking events to `event_outbox` table; async worker replays failed events. (outbox/handlers.go:30-78)
- **Admin push:** `SendToAdmins()` via `admin_users.user_id` join; comment notes TODO for topic-based at scale. (service.go:605-610, 643-655)

### Token Lifecycle

- `device_tokens` updated via POST /auth/fcm
- 90-day freshness gate; older excluded
- Auto-prune on Firebase "unregistered" response

### GAPS

1. **No SMS fallback for FCM** — silent loss window, no ops alert.
2. **MC outage blocks login** — hard dependency, no alert.
3. Admin notification reach unclear — depends on admins having FCM token.
4. Refund FCM fires only after admin approval — no notification at initial pending_refund insert.

---

## Section 10: Admin Permissions and Roles

**Summary:** **Two parallel admin systems coexist** (C8):
- User-app: flat permissions on legacy `admin_users` table.
- CRM: role-ranked permissions on `crm_admins` (viewer < support < admin < superadmin).

### User-App Admin Permissions (`internal/admin/model.go:9-16`)

| Perm | Use |
|------|-----|
| PermManageServices | service categories CRUD |
| PermManageContent | banners, hero text |
| PermManageConfig | app-wide config (surge, radius, fees) |
| PermManagePromotions | promo CRUD |
| PermManageUsers | view/suspend users + helpers (broadly used) |
| PermViewAnalytics | read-only dashboard metrics |

Checked via `middleware.RequirePermission(PermXxx)` on each route. No role inheritance.

### CRM Role Hierarchy (`internal/crm/auth/permissions.go:3-15`)

Roles ranked 0–3: viewer < support < admin < superadmin. `HasPermission(role, perm)` checks `role.rank ≥ perm.minRank`. **Superadmin inherits all lower** by rank, not by explicit grant.

### CRM Permission Matrix (excerpt — full list 96 perms; see `internal/crm/auth/permissions.go:20-172`)

| Perm | Min role | Notes |
|------|----------|-------|
| users.suspend / unsuspend / ban / unban / set_vip | admin | |
| users.add_note | support | |
| workers.create / approve / reject / suspend / unsuspend / force_offline / set_categories / deduct / update | admin | |
| workers.add_note | support | |
| orders.cancel / complete / reassign | admin | |
| orders.add_note | support | |
| refunds.approve_full | support | |
| refunds.approve_partial | admin | |
| refunds.reject | support | |
| promos.create/update/toggle | admin | |
| banners.create/update/delete/reorder | admin | |
| experiments.create/start/pause/stop/rollout | admin | |
| push.create / send | support | |
| zones.create/update/toggle | admin | |
| zones.approval.read | support | |
| zones.approval.approve / reject | admin | |
| surge.create / delete | admin | |
| disputes.create / resolve | support | |
| incidents.create / resolve | support | |
| fraud.review | admin | |
| blacklist.add / remove | admin | |
| payouts.create / mark_paid / mark_failed / recompute | admin | |
| flags.review | admin | |
| flags.update / rollback | **superadmin only** | |
| templates.create/update/delete | admin | |
| tickets.resolve | support | |
| waitlist.create | admin | |
| leaves.deduct | admin | |
| webhooks.create / delete | **superadmin only** | |
| app_version.update | **superadmin only** | |
| changelog.publish | **superadmin only** | |
| loyalty.update | **superadmin only** | |
| lost_user.create / toggle | **superadmin only** | |
| ***.read (most) | viewer | Most read perms accessible to viewer+; some (refunds.read, users.read, workers.read) require support+. audit.read, flags.read, webhooks.read require admin+ |

### Endpoint Enforcement

CRM bootstrap wires `auth.HasPermission(role, key)` per route. Returns 403 on failure.

### GAPS / CONFLICTS

1. **Two admin systems coexist** (C8). User-app admin role unrelated to CRM role. A CRM viewer can simultaneously hold PermManageUsers if the legacy `admin_users` table grants it.
2. Pro approval endpoint not in audited modules — assumed under `internal/crm/workers/`.
3. Permission middleware logic not deeply audited for user-app side.
4. No mechanism to permanently deactivate or delete a CRM admin — only `locked_until`.

---

## Section 11: Service Zones and Geographic Scope

**Summary:** Zone = circle (lat, lon, radius_km, shift_radius_km) and/or polygon (PostGIS boundary). Currently only circle path is implemented in matching/Go-Online. Out-of-zone bookings silently accepted with no fallback warning.

### Zone Definition

`service_zones` columns:
- id, name, city, is_active
- circle: lat, lon, radius_km (customer-facing), shift_radius_km (Go-Online verify, default 1.0 km)
- polygon: `boundary GEOGRAPHY(POLYGON, 4326)`, matched via `ST_Contains`

(App/househelp-api/internal/zones/model.go:1-22; migrations/099_zone_shift_radius.up.sql, 100_zone_polygon.up.sql)

### Where Zones Are Checked

**In dispatch matching:**
- locality resolved (Section 4); filter general pool to matching localities.
- Instant bookings via matching engine: no explicit zone check; uses `max_walk_minutes` default 20.

(matching/dispatch.go:257-273; booking/service.go:862-939)

**In Go-Online:**
- Pro's current zone (pro_zone_assignments with effective_to NULL) → lat/lon and shift_radius_km.
- Haversine distance from pro GPS → centre; check `distance ≤ shift_radius_km × 1000m`.
- Outside → offer manual approval pathway. Admin-approved skip the radius check.

(shift/service.go:215-242; model.go:15-17)

**Customer-facing GET /zones/check:**
- Haversine query: first active zone within radius_km. Else `serviceable=false`.
- Used by web app before showing instant-booking UI.

(zones/repository.go:22-50)

### Booking Outside All Active Zones

- classifyScheduling → `locality=nil` → dispatcher invites any pro. No soft warn, no hard reject (C11).
- Instant bookings: no zone gate at all.

### Currently Active Zones

`ListZones` returns all rows (not filtered by `is_active=true`). No seed data for zones in migrations — they live in DB only, presumably populated via CRM. (zones/repository.go:52-79)

### Zone Assignment Lifecycle

`pro_zone_assignments(pro_id, zone_id, effective_from, effective_to)`. Non-overlapping date ranges; current = `effective_to IS NULL`. Reassign → set effective_to on old + insert new with today's effective_from. (migrations/098_shift_system.up.sql:33-46)

### GAPS

1. Polygon matching (ST_Contains) added in migration 100 but **not used** in matching/Go-Online code. Still circle-only.
2. No code enforces a pro must have an active assignment — error path only on the implicit "zoneErr != nil" branch.
3. Out-of-zone booking silent acceptance (C11).
4. No zone-level config for max travel time, time-of-day operating hours, daily capacity.
5. No zone temporary closures / holiday schedules.

---

## Section 12: Edge Cases and Business-Decision Comments

Grep across `App/` (excluding node_modules / vendor) for: TODO, FIXME, HACK, XXX, "business decision", "ASK ADITYA", "pilot only", "temporary", "for now", "hardcoded" (case-insensitive).

### Safe TODOs (cleanup, future tests, extensibility)

| File:Line | Comment |
|---|---|
| App/zopmop-app/src/sdui/allowlist.ts:11 | TODO: jest test asserting Set matches navigator's |
| App/househelp-api/internal/crm/banners/banners.go:4 | S3 presign here is a future TODO |
| App/househelp-api/internal/bff/migrations/migrate.go:26 | Empty chain for now |
| App/househelp-api/internal/shift/cron.go:118 | TODO: read internal/location heartbeats + compare to commitments |

### Suspicious TODOs (business assumption or unresolved question)

| File:Line | Comment | Severity |
|---|---|---|
| App/zopmop-app/src/screens/booking/InstantMatchingScreen.tsx:370 | TODO Phase X: wire reschedule for instant | Medium |
| App/zopmop-app/src/screens/main/BookingConfirmedScreen.tsx:952 | TODO(backend): derive copy from booking.scheduled_at; for now static "tomorrow" | Medium — copy may mislead |
| App/househelp-api/internal/auth/repository.go:222 | TODO: gate helper-only routes on approval_status='approved' once admin panel built | **High** — unapproved helpers may access routes |
| App/househelp-api/internal/notification/service.go:610 | TODO(phase: CRM-admin-login): switch to topic-based push | Medium |
| App/househelp-api/internal/roomies/repository.go:119 | TODO: credit zeroed prepaid_balance to main wallet (not yet built) | **High — C13** |
| App/househelp-api/internal/roomies/repository.go:140 | TODO: before zeroing, enqueue credits to main wallet per user. For now, zero out | **High — C13** |
| App/househelp-api/internal/roomies/service.go:363 | force=true: prepaid balances zeroed (TODO: credit to main wallet) | **High — C13** |
| App/househelp-api/internal/roomies/service.go:401 | TODO: build settlement worker | **High** |
| App/househelp-api/internal/crm/workers/model.go:59-67 | TODO Phase 12: mask/encrypt aadhaar_number and bank_account_number at rest | **High — C7** |
| App/househelp-api/internal/crm/workers/repository.go:229 | TODO Phase 12: null out peer data for non-superadmin | High |
| App/househelp-api/internal/crm/workers/repository.go:506 | TODO Phase 12: encrypt aadhaar_number with KMS | **High — C7** |
| App/househelp-api/internal/crm/workers/repository.go:510 | TODO Phase 12: encrypt bank_account_number with KMS | **High — C7** |

### HACKs / Hardcoded Behavior

| File:Line | Comment | Severity |
|---|---|---|
| App/zopmop-app/src/screens/main/HomeScreen.tsx:3 | Used to be hardcoded monolith; refactored to SDUI | Low (historical) |
| App/zopmop-app/src/utils/photoCapture.ts:7 | Temporary hand-off so smoke test works end-to-end | Low |
| App/zopmop-app/src/screens/main/TipScreen.tsx:2 | End of service; for now we just persist chosen amount in-app | Medium — C14 |
| App/househelp-api/internal/auth/service.go:377 | Returns hardcoded devOTP | Medium — C10 |
| App/househelp-api/internal/auth/handler.go:298 | hardcoded OTP "999999" so testers can complete flow | Medium — C10 |
| App/househelp-api/pkg/config/config.go:46 | treats hardcoded OTP "999999" as valid for every call | Medium — C10 |
| App/househelp-api/internal/leave/model.go:10 | Fallback: hardcoded +05:30 — should never happen | Low |
| App/zopmop-app/src/sdui/allowlist.ts:33 | mailto: hardcoded values, not SDUI | Low |
| App/zopmop-app/src/services/auth.ts:101 | hardcoded OTP "9999" — screen may autofill | Medium — C10 |
| App/househelp-api/internal/matching/demand.go:86 | Supply count uses approximation, not full iteration | Low |
| App/househelp-api/internal/matching/engine.go:64 | Falls back to hardcoded matching defaults | Medium |
| App/househelp-api/internal/bff/sources.go:256 | Uses brand defaults as placeholder pending schema | Low |
| App/zopmop-crm/src/pages/workers/WorkerNewPage.tsx:34 | Service category slugs hardcoded; backend uses freeform strings | Medium |
| App/zopmop-crm/src/pages/workers/WorkerNewPage.tsx:731 | 12 digits, manual verify for now | Medium — no Karza/Digio integration |

---

## Section 12.5: Client-Only Business Rules

Rules implemented only in the React Native customer app (App/zopmop-app/src) or CRM app (App/zopmop-crm/src) with no backend enforcement.

| Rule | File:Line | Severity | Backend-enforced? |
|------|-----------|----------|-------------------|
| Scheduling lead days capped at 2 | App/zopmop-app/src/components/SchedulingModal.tsx:28, 32 | Informational | Partial (backend has `scheduledBookingMaxLeadDays`) |
| 8 PM IST cutoff for today/tomorrow selection | App/zopmop-app/src/components/SchedulingModal.tsx:32, 42, 49 | **Concerning** | No — client-only; backend slot API returns slots regardless |
| Platform fee hardcoded ₹200 (2000 paise) in Cart display | App/zopmop-app/src/screens/main/CartScreen.tsx:53 | **Risky if tampered** | No — backend calculates separately; client display advisory |
| Split-cost calc client-side: ceil(total / splitCount) | App/zopmop-app/src/screens/main/CartScreen.tsx:137 | Informational | Partial — backend processes via `bookGroupChore` |
| Wallet balance soft-fail to 0 on fetch error | App/zopmop-app/src/screens/main/CartScreen.tsx:105-107 | Informational | Yes — backend returns 402 if actual short |
| Wallet pre-flight check (≥ totalCents) | App/zopmop-app/src/screens/main/CartScreen.tsx:227-231 | Informational | Yes — backend re-checks |
| Unpaid-booking gate | App/zopmop-app/src/screens/main/CartScreen.tsx:308-320 | Informational | Yes |
| Promo code in ephemeral `promoStore` | App/zopmop-app/src/screens/main/CartScreen.tsx:41, 249, 279 | Informational | Yes — backend validates at create |
| No client-side promo validation; trusts backend | App/zopmop-app/src/api/promotions.ts | Informational | Yes |
| Serviceability fail-closed | App/zopmop-app/src/api/zones.ts:15-19 | Informational | Yes |
| Address picker mandatory | App/zopmop-app/src/screens/main/CartScreen.tsx:219 | Informational | Yes |
| Slot selection mandatory | App/zopmop-app/src/screens/main/CartScreen.tsx:220 | Informational | Yes |
| No service availability window check on client | App/zopmop-app/src/screens/main/AllServicesScreen.tsx | Informational | Partial — SDUI controls visibility |
| Tip persisted client-side only | App/zopmop-app/src/screens/main/TipScreen.tsx:2 | **Concerning — C14** | No |
| CRM hardcoded service category slugs (8 options) | App/zopmop-crm/src/pages/workers/WorkerNewPage.tsx:34-46 | **Concerning** | Partial — backend accepts freeform |
| UUID gen client-side for split idempotency | App/zopmop-app/src/screens/main/CartScreen.tsx:56-59, 272 | Informational | Yes |
| Manual Aadhaar verify in CRM (no automated flow) | App/zopmop-crm/src/pages/workers/WorkerNewPage.tsx:731 | **Risky** | No — plaintext, no API verify |

---

## Section 13: Secrets and External Dependencies

**Summary:** Five external services: Message Central (SMS/OTP — hard dep), Cashfree (payments — graceful degrade via COD/manual), Google Maps (matching — fail-open with Haversine), Firebase (FCM — silent loss), Sentry (errors — async drop).

### Message Central (SMS Gateway)

- **Used by:** auth flow (SendOTP, VerifyOTP).
- **Config:** MESSAGECENTRAL_CUSTOMER_ID, MESSAGECENTRAL_AUTH_TOKEN (long-lived bearer, manual rotate), MESSAGECENTRAL_BASE_URL, OTP_DEV_MODE.
- **Down 1 hour:** customers cannot log in. Existing JWTs valid (24h JWT_EXPIRY_HOURS). New bookings blocked at login.
- **Down 1 day:** all expired JWTs locked out. Near-total revenue impact.
- **Fallback:** none (dev mode is testing-only).
- **Alert strategy:** must monitor MC endpoint, alert on 5xx / timeout.

(App/househelp-api/internal/auth/messagecentral.go:1-150)

### Cashfree Payment Gateway

- **Used by:** POST /api/v1/payments/orders (CreateOrder), webhook handler, refunds.
- **Config:** CASHFREE_PG_APP_ID, CASHFREE_PG_SECRET_KEY, CASHFREE_PG_ENV (sandbox/production), CASHFREE_PG_WEBHOOK_SECRET, PUBLIC_BASE_URL.
- **Idempotency:** refund_id is caller-supplied UUID, dedup key for refunds. (cashfree.go:138-144)
- **Down 1 hour:** instant bookings fall back to COD if enabled; otherwise checkout fails. Refunds stall.
- **Down 1 day:** same, longer; refunds queue, customer escalations likely.
- **Fallback:** Manual gateway (`internal/payments/manual.go`) — admins mark refunds processed_manual.
- **Webhook secret drift risk:** silently rejects webhooks; only counter `webhookHMACFailures` (cashfree.go:29-30) — no alerting threshold.

(App/househelp-api/internal/payments/cashfree.go:1-200, manual.go)

### Google Maps (Distance Matrix + Directions)

- **Used by:** matching engine, accept gate (acceptMaxWalkingMinutes=25min).
- **Caching:** Redis 5-min TTL, rounded coords ~11m precision.
- **Down 1 hour:** **fail-open — distance check skipped.** Bookings proceed with worse matching quality.
- **Down 1 day:** same, longer; quality degraded.
- **Fallback:** Haversine (~1km urban error). (booking/service.go:97-107)
- **No retry/backoff** — intentional fail-fast.
- **Hidden risk:** ops won't know Maps is down unless they check logs (C9).

(App/househelp-api/internal/googlemaps/client.go:1-150; booking/service.go:34-42)

### Firebase Cloud Messaging

- **Used by:** all customer/pro pushes, admin alerts.
- **Config:** FIREBASE_CREDENTIALS_JSON, mounted at /app/secrets/firebase-adminsdk.json.
- **Down 1 hour:** notifications don't arrive. Bookings proceed; UX degraded.
- **Down 1 day:** same; pros miss offers; customers may rebook or cancel.
- **Fallback:** none (no SMS fallback, no in-app inbox).
- **Graceful init:** missing credentials → mock that logs intent. (notification/service.go:46-59)

### Sentry (Error Tracking)

- **Used by:** observability layer; fire-and-forget capture of DB errors, webhook decode errors.
- **Config:** SENTRY_DSN (empty = no-op), SENTRY_ENVIRONMENT, SENTRY_TRACES_SAMPLE_RATE (default 0), SENTRY_RELEASE.
- **Down 1 hour/day:** observability blind; events buffer and may drop silently.
- **Fallback:** logs to stdout/journald (no structured replay).

### Operational Matrix

| Service | Critical Path | Graceful Degrade | Hard Dep | Fallback |
|---------|---------------|------------------|----------|----------|
| Message Central | Login | No (blocks) | Yes | None |
| Cashfree | Checkout | Yes (COD) | For card/UPI only | Manual refund |
| Google Maps | Matching | Yes (Haversine) | No | Haversine + quality drop |
| Firebase | Notifications | Yes (silent loss) | No | In-app refresh |
| Sentry | Observability | Yes (events dropped) | No | Logs |

### GAPS

1. MC is single point of failure for auth — no provider redundancy.
2. Cashfree webhook signature drift not alerted (just counted).
3. FCM token rotation rate not observable.
4. Maps fail-open silent — ops invisibility (C9).
5. No circuit breaker / backoff anywhere; only per-call timeouts (5s/15s/6s).
6. Sentry event loss is silent.

---

## Section 99: Suspected Rules With No Code Enforcement Found

Things mentioned in docs / comments / RN client / spec but NOT enforced in backend code.

| Suspected rule | Evidence | Where the gap is |
|---|---|---|
| **Pros may rate customers** | none in code | reviews.go is customer-write-only |
| **Customer no-show triggers a fee** | none | No code path; pro must use customer-cancel side or eat the time |
| **Pro no-show triggers a deduction** | none | No code path; only commit-by-3AM absence and 5-strike cancel are penalized |
| **Cancellation fee scales with proximity to start time** | only single ₹100 flat fee | (cancellation.go:6-36) hard-codes one fee tier |
| **Surge applies in cart paths** | golden test asserts opposite | (cart_pricing_golden_test.go:134-145) |
| **GST line item shown to customer** | nothing in code | no GST calc visible anywhere |
| **Promo `max_per_user` enforced** | column exists | (offers/handler.go:99-111) — never read |
| **Promo `stackable` flag enforced** | column exists | never read; one promo per booking |
| **Service availability window enforced server-side** | nothing | client gates on slot list only |
| **Tip is recorded server-side** | nothing | (TipScreen.tsx:2) — client-only persist |
| **Aadhaar / bank-account encrypted at rest** | TODO Phase 12 | (crm/workers/repository.go:506-510) plaintext today |
| **Helper-only routes gate on approval_status** | TODO comment | (auth/repository.go:222) — currently not gated |
| **Rating-based dispatch / deactivation** | not visible | only `approved` checked in middleware |
| **Polygon zone matching (PostGIS)** | migration 100 adds column | no Go code uses `ST_Contains` — circle only |
| **Out-of-zone booking soft-warn or fallback** | nothing | (booking/service.go:876-939) — silent accept |
| **Pro can cancel an accepted booking via API** | none | no endpoint, no handler |
| **Fortnight start rolls forward automatically** | nothing | (shift/...) — no cron rolls fortnight_start_date |
| **Weekly hours target enforcement** | only used in pay math | no warning/penalty for shortfall in shift module |
| **Penalty for committed-but-not-online shift** | nothing | absence row only for no-commit-by-3AM |
| **Roomies prepaid balances credited back on group delete** | TODO | (roomies/repository.go:140; service.go:363) — zeroed out today |
| **Main wallet exists** | repeated TODO | (roomies/service.go) — referenced but not built |
| **Settlement worker for roomies refunds** | TODO | (roomies/service.go:401) — not built |
| **Admin cancellation notifies customer / pro** | nothing | (admin/service.go:395-420) bypasses outbox + webhooks |
| **CRM admin self-signup / deactivation** | nothing | only `locked_until` exists; ops provisions manually |
| **One phone with both customer and pro roles** | nothing | role is single-value VARCHAR; transition in-place |
| **JWT carries role for client-side gating, kept fresh mid-session** | partial | role-update propagates only via refresh, not mid-session |
| **Push topic-based broadcast for admins** | TODO | (notification/service.go:605-610) — per-user lookup today |
| **SMS fallback when FCM down** | nothing | silent notification loss |
| **MC outage alerting** | nothing | no monitoring code visible |
| **Cashfree webhook HMAC failure alerting** | counter exists | (cashfree.go:29-30) — no alert threshold wired |
| **Refund amount ≤ captured assertion server-side** | nothing | assumed Cashfree-enforced |
| **GST / tax on platform fee or service base** | nothing | not visible anywhere |

---

*End of audit.*
