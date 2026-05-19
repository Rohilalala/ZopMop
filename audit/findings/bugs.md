# Subagent 8 — Bug Hunt

Scope: concrete latent business-logic bugs across backend (Go) and the
React Native customer + pro app. Findings ordered by severity then file.
File paths absolute. Line numbers are from the working tree on
`feature/referral-flow-fixes` at audit start.

Severity counts: Critical 4, High 6, Medium 7, Low 3, Nit 3.

---

## CRITICAL

```
[SEVERITY: Critical]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/cart/repository.go:54-60]
[CATEGORY: Bug / Schema drift]
Finding:
`AddItem` issues `INSERT … ON CONFLICT (cart_id, service_id) DO UPDATE`,
but the underlying unique constraint `cart_items_cart_id_service_id_key`
was dropped by migration `095_drop_legacy_cart_items_unique.up.sql`
(applied on prod 2026-05-15 per user memory entry
"PROD MIGRATION INCIDENT 2026-05-14"). PostgreSQL requires a matching
unique index for the column inference form of ON CONFLICT and will
reject the statement with
"there is no unique or exclusion constraint matching the ON CONFLICT
 specification". Every POST /cart/add returns 500.

Impact:
Customer cart "add service" is broken in production for every user as
soon as migration 095 finished applying. This blocks the entire booking
funnel (cart → instant or scheduled). If telemetry hasn't shown a spike
yet it's because the legacy constraint may still exist on some prod
boxes; the moment 095 is re-applied or a fresh DB is spun, every cart
write breaks.

Fix:
Either restore the legacy unique on (cart_id, service_id) — repository
code is single-service today, no variants flow through it — OR migrate
the repo to insert against (cart_id, variant_id) / (cart_id, bundle_id)
to match the new partial unique indexes that 089/095 added. Given the
cart code has zero references to `variant_id` or `bundle_id`, the
fastest correct fix is to re-add the legacy unique gate guarded by
`IF NOT EXISTS` and treat cart_items.service_id as the dedup key until
the rest of the variant flow lands.

Evidence:
- Drop: App/househelp-api/migrations/095_drop_legacy_cart_items_unique.up.sql
- Live ON CONFLICT: App/househelp-api/internal/cart/repository.go:56
- No variant/bundle refs anywhere in `internal/cart/`:
  `grep -rn "variant_id\|bundle_id" internal/cart/` → empty.
```

```
[SEVERITY: Critical]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/repository.go:678,734]
[CATEGORY: Bug / Schema drift]
Finding:
After migration 094 (`094_rerename_booking_services_price.up.sql`)
the `booking_services` column is named `price_paise`. The booking
repository still INSERTs into `(booking_id, service_id, duration_minutes,
price_cents)` on line 678 and SELECTs `'price_cents', bs.price_cents`
on line 734. Both queries error with
"column \"price_cents\" of relation \"booking_services\" does not exist"
after 094 is applied.

Impact:
- `CreateScheduledBooking` (cart-based scheduled flow) cannot insert
  per-service line items → entire scheduled booking flow broken
- The customer "My Bookings" list query (line 723 onwards) returns
  500 — every authenticated home/orders screen breaks
This is the same class of incident as 2026-05-14 (memory:
project_prod_migration_incident_2026_05_14.md) and recurs because
migration 094 was idempotent but the Go code wasn't updated to match.

Fix:
Rename both string literals to `price_paise`. Audit the JSON field name
too — `'price_cents', bs.price_paise` is the path of least resistance to
keep clients happy, but a coordinated field rename to `price_paise` in
the API contract is the right end state.

Evidence:
- Column rename: App/househelp-api/migrations/094_rerename_booking_services_price.up.sql
- Affected INSERT: internal/booking/repository.go:678
- Affected SELECT/json_build: internal/booking/repository.go:734
```

```
[SEVERITY: Critical]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/repository.go:328-389]
[CATEGORY: Bug / State machine]
Finding:
Stealth-instant bookings cannot be accepted. `StealthDispatcher.claimNext`
flips the booking row from `status='pending'` to `status='searching'`
(stealth_dispatch.go:148-153) before InviteChain emits the per-pro FCM
push. The pro app then calls POST /bookings/:id/accept which hits
`Repository.AcceptBooking` whose UPDATE is gated by
`WHERE id = $1 AND status = $4 ('pending')`. Because the booking is now
`'searching'`, RowsAffected=0 and the repo returns `ErrAlreadyAccepted`
to every pro that taps Accept during the 15-min stealth window.

Impact:
After-8pm-IST bookings (the stealth path) can never assign a pro via
the documented flow. Customers see "we're still looking" until 15 min
expires, then "keep looking or cancel". The acceptance race-detection
in `inviteSinglePro` polls `bookings.helper_id`, which only flips when
AcceptBooking succeeds — but AcceptBooking can't succeed while status
is 'searching'. The path is dead-ended.

Fix:
Either widen the AcceptBooking WHERE clause to
`status IN ('pending','searching')` and update the state-machine map
on line 242 to allow `searching → accepted`, OR flip the row back to
`pending` immediately before each `inviteSinglePro` call. Option 1 is
cleaner and matches the existing comment at stealth_dispatch.go:96
which already attempts a "status catch-up" UPDATE post-assignment.

Evidence:
- Stealth status flip: internal/matching/stealth_dispatch.go:148-153
- AcceptBooking gate: internal/booking/repository.go:359-368
- Allowed transitions map: internal/booking/repository.go:242
```

```
[SEVERITY: Critical]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/referral/service.go:158-200]
[CATEGORY: Bug / Race condition]
Finding:
`MaybeCompleteOnBookingTx` reads the pending referral with a plain
`SELECT … WHERE referee_id = $1 AND status = 'pending'` (no FOR UPDATE,
no row lock). Two concurrent booking-completion transactions for the
same customer can both:
  1. Observe `ref.status='pending'`
  2. Count exactly one completed booking after `ref.CreatedAt` (each
     tx counts the booking it is committing, which is the only one)
  3. Both credit the referee (Rs 100) and referrer (Rs 150)
  4. Both run `UPDATE referrals SET status='completed'` (final value is
     the same, but the wallet was double-credited)

Impact:
Referee + referrer wallets can be credited 2-3x for a single referral
under concurrent booking completions. Customer-facing fraud surface:
have multiple long-running pros, complete two bookings in fast
succession to double-bump the wallet. Not high-probability but
high-impact when triggered. Compounded by the absence of an
idempotency unique on `wallet_transactions(user_id, kind, source_ref)`
for `kind='referral_credit'` rows.

Fix:
1. Lock the referral row with `SELECT … FOR UPDATE` inside the same tx.
2. Add a partial unique index on `wallet_transactions` to enforce
   one referral_credit row per (referrer_id|referee_id, source_referral_id)
   — but to add that you must first thread the referral_id through
   `wallet.WalletTx`. A `note`-based unique would be brittle.
3. Switch `MaybeCompleteOnBookingTx` to `UPDATE referrals SET status =
   'completed' WHERE id = $id AND status = 'pending' RETURNING *` —
   only the winner gets a non-empty result and proceeds with the
   credits.

Evidence:
- Read without lock: internal/referral/repository.go:153-167
- Credit flow without idempotency key: internal/referral/service.go:181-199
- Wallet has no per-source idempotency on referral_credit kind:
  internal/wallet/repository.go:106-166
```

---

## HIGH

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/service.go:450-460]
[CATEGORY: Bug / Race condition]
Finding:
`CreateBooking` (instant single-service path) inserts the booking row
first, then calls `IncrementPromoCodeUsage` in a SEPARATE transaction.
If the second call fails (e.g. limit reached due to concurrent use, or
DB hiccup), the booking persists with `discount_paise` already applied
but `promotions.uses_count` is not advanced. The first user to race
past the per-promo cap effectively gets a free extra discount.

The same anti-pattern is repeated in:
- `CreateScheduledBooking` (service.go:1054-1068)
- The cart-derived instant path (service.go:1196-1220)

Impact:
Promo over-redemption when limits are tight (especially `max_uses=1`
launch codes), and silent failures the user never sees because the
booking creation already succeeded with the discount baked in.

Fix:
Push the promo INCREMENT into the booking-creation transaction. Or
compute eligibility + reserve uses_count optimistically before
inserting the booking, and roll back the booking on increment failure.

Evidence:
- Booking insert: internal/booking/service.go:450
- Promo increment in own tx: internal/booking/repository.go:781-827
- "Don't fail booking if increment fails": service.go:457-459 comment
```

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/matching/scheduled_dispatch.go:170-181]
[CATEGORY: Bug / Timezone + window edge]
Finding:
The 22:00 IST nightly cron claims scheduled bookings via
`scheduled_time BETWEEN now() + 6h AND now() + 30h`. Bookings made
BEFORE 20:00 IST (regular scheduled, `is_stealth_instant=false`) but
for a slot LESS than 6 hours away never enter either dispatcher's
window. Concrete repro: place a booking at 19:30 IST today for
tomorrow 03:30 IST. Stealth path is skipped because the 20:00 cutoff
is `>=`, not `>`. ScheduledDispatcher at 22:00 sees 03:30 tomorrow as
`now+5h30m` — outside the 6-30h band. The booking is never dispatched.

Impact:
Bookings made in a ~30-min window for very-early-morning slots fall
through the cracks. Customer pays, no pro is invited, no
`no_pros_found` cancellation runs. Booking sits as `pending` forever.

Fix:
- Extend ScheduledDispatcher claim window down to `now()+1h` (or
  `now()+0`); the helper-side eligibility check already gates on
  scheduled_time + duration overlap.
- Or run an additional reconciliation sweep on startup that picks
  up `pending` bookings with `scheduled_time < now()+6h` and either
  hands them to StealthDispatcher or runs InviteChain inline.
- Or change the booking creation classifier so any booking < 24h
  away is treated as stealth.

Evidence:
- 6-30h window: internal/matching/scheduled_dispatch.go:179-180
- Cutoff comparator: internal/booking/service.go:799 (`now.Hour() >=
  schedulingCutoffHourIST`)
```

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/slots/service.go:26-29]
[CATEGORY: Bug / Dead code; capacity drift]
Finding:
`slots.Service.IncrementBooking` is never called by any caller in the
backend. `grep -rn "IncrementBooking\|slots\.Service.*Increment"`
returns only the definition and the (separate) inline implementation
inside the booking repository's `CreateScheduledBooking`. The booking
flow does increment the counter inside its own scheduled-booking tx
(repository.go:635-639), but other paths (instant booking, future
admin overrides, the Zop AI assistant) do not — and a stale
`current_bookings` value is what gates the public
`/slots?date=YYYY-MM-DD` list.

Impact:
Instant bookings don't decrement against slot capacity at all (they
don't have a `time_slot_id`, which is consistent). But the dead
`slots.Service.IncrementBooking` is a footgun: anyone wiring a new
booking entry point and reading the slots module's public API will
believe they can `slotsSvc.IncrementBooking(slotID)` to track capacity
— but that method skips the same FOR-UPDATE tx the canonical path
uses, so two callers could race past `current_bookings < max_bookings`.

Fix:
Delete `slots.Service.IncrementBooking` and the underlying repository
method, OR thread it through the booking transactions (replacing the
inline UPDATE on repository.go:635-639) so there is one truth.

Evidence:
- Unused service method: internal/slots/service.go:26-29
- Inline increment: internal/booking/repository.go:635-639
- No grep hits to the service variant outside test/zop wire
```

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/service.go:1734-1768]
[CATEGORY: Bug / Tx timeout]
Finding:
`CompleteBooking` opens a tx with `WithTimeout(ctx, 5*time.Second)` and
inside that tx calls `referrals.MaybeCompleteOnBookingTx`, which in
turn calls `wallet.CreditTx` TWICE (referee + referrer). Each wallet
credit is: lazy-insert wallets row + SELECT FOR UPDATE + UPDATE +
INSERT wallet_transactions + INSERT event_outbox. Under load, the
referrer's wallet may be contended (popular referrer with multiple
referees completing first bookings simultaneously), and a 5-second
budget for: booking UPDATE + outbox + 2× wallet credits + 2× outbox +
referral UPDATE is tight.

Impact:
On contention, `CompleteBooking` returns 500 to the pro, the booking
stays in_progress, the helper sees "complete failed", retries — second
attempt may double-credit because the outer tx rolled back on
StatementTimeout, but inside the rolled-back tx the FOR UPDATE row lock
was held briefly. Not a corruption bug by itself, but a UX cliff.

Fix:
Bump the timeout to 15s, or extract the wallet credits into a
post-commit step driven by the event_outbox row that's already being
emitted. Referrals already write a `referral.completed`-equivalent
state — let an outbox consumer fan out wallet credits asynchronously.

Evidence:
- Timeout: internal/booking/service.go:1731-1732
- In-tx wallet credits: internal/referral/service.go:181-197
- Wallet repo write count: internal/wallet/repository.go:118-163
```

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/users/repository.go:222,437 +
       /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/workers/repository.go:277,330 +
       /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/dashboard/dashboard.go:72 +
       /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/location/handler.go:284 +
       /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/matching/dispatch.go:171]
[CATEGORY: Bug / Enum drift]
Finding:
Several queries filter on `status IN (… 'assigned','en_route','arrived'
…)`, but the booking module's `BookingStatus` enum is `{pending,
accepted, in_progress, completed, cancelled}` (internal/booking/model.go:
9-13). The `'arrived'` value is a TIMESTAMP column (arrived_at) — not a
status — so no row will ever have `status='arrived'`. Similarly
`'assigned'` and `'en_route'` are never assigned anywhere in the
codebase (`grep -rn "status.*assigned\|StatusAssigned\|en_route"` only
returns these queries).

Impact:
- CRM dashboard "active orders" counter undercount on bookings that
  are accepted-but-not-yet-in-progress is fine, but its filter for
  `'assigned'/'en_route'` matches zero rows in perpetuity.
- `internal/location/handler.go:284` location broadcast endpoint
  gates on `status IN ('accepted','in_progress','arrived')` —
  'arrived' matches nothing, so a pro broadcasting location while
  arrived_at is set will succeed via the 'accepted' or 'in_progress'
  legs (depending on which timestamp is later).
- `internal/matching/dispatch.go:171` eligibility check excludes
  helpers in `('accepted','in_progress','arrived')` — 'arrived' is
  noise but not load-bearing since arrived_at-set rows are usually
  still status='in_progress'.

Fix:
Two paths: (a) align the queries to the real enum, removing
'assigned'/'en_route'/'arrived'; or (b) introduce these as real
status transitions in the state machine. (a) is the strictly correct
short-term fix; (b) is a product question.

Evidence:
- Enum: internal/booking/model.go:9-13
- Mismatched filters: see file list above
```

```
[SEVERITY: High]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/zopmop-app/src/screens/main/ReferralEarnScreen.tsx:142, 207]
[CATEGORY: Bug / Currency display drift]
Finding:
The Refer & Earn UI hardcodes "Rs 150 you earn" / "Rs 100 friend earns"
but does not pull from any server contract. The backend's
`ReferrerCreditPaise = 15_000` (Rs 150) and `RefereeCreditPaise =
10_000` (Rs 100) (internal/referral/model.go:17-18) match today. But a
stale comment in wallet/model.go:29 says
"both referee Rs 100 + referrer Rs 200", and the GetStatsForUser query
hardcodes 15000 (`COALESCE(SUM(CASE WHEN status='completed' THEN 15000
ELSE 0 END), 0)`, internal/referral/repository.go:201). If ReferrerCreditPaise
is ever changed, three independent literals (UI string + repo hardcode +
constant) must change in sync. Today only the constant is canonical and
the others drift silently.

Additionally line 207 renders `Rs {stats.total_earned_paise / 100}` —
plain `/100` produces results like `Rs 150` for 15000 but `Rs 150.5`
for 15050 with no fixed decimal formatting. Not strictly wrong because
all credits are round paise multiples today, but it's a fragile assertion.

Impact:
Future price change to referral credits ships in production with stale
display strings or wrong stats — observed-on-prod money mismatch.

Fix:
Backend: change the GetStatsForUser query to multiply
`COUNT(*) FILTER (WHERE status='completed') * $referrerCreditPaise`,
passing the constant from the service layer. Update wallet/model.go:29
comment to "Rs 150". Mobile: surface the credit amounts from the
`/me/referral` endpoint payload (extend ReferralStats with
`referee_credit_paise` and `referrer_credit_paise`) and render those.

Evidence:
- Backend constants: internal/referral/model.go:17-18
- Stale comment: internal/wallet/model.go:29
- Repo hardcode: internal/referral/repository.go:201
- Mobile hardcode: ReferralEarnScreen.tsx:142,147
- Mobile divide-by-100 with no toFixed: ReferralEarnScreen.tsx:207
```

---

## MEDIUM

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/matching/dispatch.go:327-360]
[CATEGORY: Bug / Off-by-one]
Finding:
`inviteSinglePro` sets `deadline := time.Now().Add(perProInviteWait)`
then enters a loop that begins with `time.After(pollInterval)` (5s).
A pro that taps Accept within the first 5 seconds is not detected
until the first poll completes — so the effective per-pro window is
discretised to {5,10,15,20,25}s. More importantly the deadline check
is `time.Now().Before(deadline)` which after waiting pollInterval the
loop checks again, so the last poll fires at roughly 25s and a 26th
second accept is missed. Spec says 25s wait — at exactly 25s a real
accept would be missed.

Impact:
~5s of acceptance latency at the start; up to 5s of acceptance loss at
the end of the per-pro window. Real-world impact: marginal pros (those
who take 24-26 seconds to tap) silently drop and the chain moves on.

Fix:
Use a Postgres NOTIFY/LISTEN trigger on bookings.helper_id updates so
the chain wakes immediately on accept. Or shorten pollInterval to 1s
inside the last 3s of the window. Or, cheapest, do an immediate poll
at the start of the loop before the first sleep.

Evidence:
- Deadline computation: internal/matching/dispatch.go:327
- Sleep-then-check pattern: lines 328-333
- Spec value: const perProInviteWait = 25 * time.Second
```

```
[SEVERITY: Nit]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/service.go:85-88]
[CATEGORY: Bug / Investigated, not a bug]
Finding:
Initial worry was that `isInstantBookingClosed(time.Now())` would
compare UTC host time against IST constants. Confirmed clean: the
function body does `hr := t.In(indiaLocation()).Hour()` so the IST
shift is internal. No bug.

Impact: None.
Fix: None.
Evidence: internal/booking/service.go:85-88.
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/booking/service.go:414, 429]
[CATEGORY: Bug / Money rounding]
Finding:
Two integer-pricing places truncate toward zero instead of explicit
floor/round:
- Line 414: `int(float64(totalPriceCents) * pricingConfig.SurgeMultiplier)`
  — converting float to int in Go truncates. Surge 1.5x on 1499 →
  2248.5 → 2248 paise. The platform loses 1 paise per booking, every
  booking, every time surge applies.
- Line 429: `totalPriceCents * promo.DiscountValue / 100` — integer
  division floors for non-negative integers. 10% off Rs 14.99 →
  149 paise discount, customer pays Rs 13.50 — paise lost to floor.

Impact:
Tiny per-booking, but bookings × time = real money. More importantly
the asymmetry (always floor) means the platform always loses on surge
multiplier rounding. Auditability suffers because the rounding rule is
not documented anywhere.

Fix:
Pick a documented rounding policy (banker's, half-up, floor) and apply
uniformly via a `paiseRound(paise int64, multiplier float64) int64`
helper. Most ecommerce systems use round-half-up.

Evidence:
- Surge: internal/booking/service.go:414
- Promo: line 429 + duplicated at line 1044 + line 1180
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/leave/service.go:131-186]
[CATEGORY: Bug / Tx ordering]
Finding:
`DeclareTomorrow` opens a tx, calls `DecrementBalance` first, then
`CreateLeave` second. `CreateLeave` uses
`INSERT … ON CONFLICT (pro_id, date) DO NOTHING RETURNING …` — when
a row already exists for that date (e.g. admin-granted leave) the
RETURNING yields pgx.ErrNoRows and the function returns
`ErrAlreadyDeclared`. The deferred rollback fires correctly and the
balance decrement is undone — so the row-state outcome is fine.

BUT: any failure between `DecrementBalance` succeeding and tx commit
(network blip, ctx cancellation, postgres restart) leaves the balance
decremented while no leave was actually granted. The committed=false
defer rollback handles ctx errors gracefully, but the balance decrement
inside the rolled-back tx is fine too — the issue is operational:
because the decrement runs first the SQL plan locks the
helper_leave_balances row early, increasing contention.

Impact:
Minor. Mostly a correctness-of-ordering smell — the leave row check
should come first because it's the more likely source of failure
(double-declare attempts > insufficient balance attempts).

Fix:
Swap the order: insert leave first (so ErrAlreadyDeclared fires before
we touch the balance), then decrement.

Evidence:
- Order: internal/leave/service.go:158-167
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/zopmop-app/src/screens/main/BookingsScreen.tsx:70-93,377,524]
[CATEGORY: Bug / Timezone display]
Finding:
All booking time displays use `new Date(iso).toLocaleTimeString()` and
`.toLocaleDateString()` with no explicit `timeZone` option. On a
device set to America/New_York (Indian diaspora customer / dev with a
US time zone), a booking scheduled for 14:00 IST renders as 03:30 EST
the previous day. The Pro app (same binary) inherits the same bug.

Impact:
Customers travelling abroad see wildly wrong booking times.
Diaspora users — a measurable cohort — see a confusing UI all the time.

Fix:
Always pass `{ timeZone: 'Asia/Kolkata' }` to toLocaleTimeString /
toLocaleDateString. Wrap in a `formatIst()` helper to enforce.

Evidence:
- BookingsScreen.tsx:70,82-93,377,524
- BookingConfirmedScreen.tsx:872-873
- ActiveBookingScreen.tsx:183
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/helper/repository.go:40,46]
[CATEGORY: Bug / Null display]
Finding:
`GetProfile` does `COALESCE(h.rating, 5.00)` so new pros with zero
reviews show a 5.00 rating to themselves AND, more importantly, to
customers via the booking-match-status response. The matching engine
score function pulls from `helpers.rating` — same default applies.

Impact:
A brand-new pro with zero history appears as 5.00★ to customers and
ranks identically to genuine 5-star pros in the matching score. Trust
erodes when customers later complain about service from a "5-star" pro
who is actually unreviewed.

Fix:
Surface review_count alongside rating so the UI can render "New" /
"No reviews yet" when count=0. For matching score, treat NULL rating
as a neutral 4.0 (median) rather than 5.0, or use Bayesian shrinkage
toward the global mean.

Evidence:
- COALESCE default: internal/helper/repository.go:40,46
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/referral/service.go (entire file)]
[CATEGORY: Bug / Edge case — refund + delete]
Finding:
Referral completion credits both wallets when the referee's first
booking completes (CompleteBookingTx). Subsequent flows that don't
have integration with referral state:
1. If the booking is later refunded (full or partial), referee + referrer
   wallets keep the referral credit. There's no claw-back path.
2. If the referee account is deleted (`users.deleted_at IS NOT NULL`),
   the referrer's wallet still holds the credit, but the referee's
   balance becomes inaccessible (wallets row still exists; user can't
   sign in to spend it). It does NOT reverse.
3. Self-referral by phone-different-account: `referrer.UserID ==
   refereeID` blocks only same-user-id. A user creating a second
   account with a different phone, applying their own code, completes
   a booking → Rs 250 minted from nothing. No phone/IP/device-graph
   check.

Impact:
Promo-fraud surface. Bigger surface than per-booking discount because
referral credits are wallet-credit (spendable on future bookings) and
the cap of 3 referrals per referrer means up to Rs 450 farmable per
phone, multiplied by however many phones a fraudster has.

Fix:
- Add `KindReferralReversal` and reverse credits on full refund.
- Add a phone-suffix / device-id check at referral application time —
  reject if the referrer and referee share normalised phone prefix,
  same device install ID, or same IP at signup.
- Decide product policy on referee deletion (most likely: leave
  referrer credit, lock referee account).

Evidence:
- No reversal anywhere: `grep -rn "ReversalReferral\|reverse.*referral"`
  returns no hits.
- Self-referral by user-id only: internal/referral/service.go:130-132
```

```
[SEVERITY: Medium]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/zopmop-app/App.tsx:60-69]
[CATEGORY: Bug / Race on cold launch]
Finding:
The "flush pending referral code after auth" effect uses
`setTimeout(() => navNavigate('ReferralInvite', { code }), 300)`. The
300ms delay is a band-aid for navigation-not-yet-ready. If the user's
device is slow (older phone, cold launch + JS bundle parse), the nav
ref may still not be mounted at 300ms; the navigate call no-ops and
the code is already removed from AsyncStorage.

Impact:
Cold-launch deep-link `/r/CODE` on slow devices: the code is consumed
silently, the user lands on Home instead of ReferralInvite, and the
referral is never applied.

Fix:
Move the flush into `onReady` of the NavigationContainer (which is the
correct readiness signal), and don't remove from AsyncStorage until
the navigate call returns true.

Evidence:
- Effect: App.tsx:60-69
- onReady handler: App.tsx:77-80 — flush should live here.
```

---

## LOW

```
[SEVERITY: Low]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/leave/model.go:18 +
       internal/leave/service.go:133-135]
[CATEGORY: Bug / Off-by-one — cutoff boundary]
Finding:
`CutoffHour = 21` and the gate is `if now.Hour() >= CutoffHour`. A pro
opening the declare flow at exactly 21:00:00 IST is rejected; at
20:59:59 is accepted. Spec language is "before 9 PM" which matches.
Worth a Low because the off-by-one is a common spec-misread surface.

Impact:
Cosmetic / Low — boundary is documented and matches spec.

Fix:
No change. Optionally rename CutoffHour and add a doc comment showing
"strictly less than 21:00 IST".

Evidence:
- internal/leave/model.go:17-18
- internal/leave/service.go:133-135
```

```
[SEVERITY: Low]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/zopmop-app/src/screens/main/ReferralEarnScreen.tsx:117]
[CATEGORY: Bug / Marketing copy drift]
Finding:
Share message: `Use my code ${stats.code} to get Rs 100 off your first
ZopMop booking!`. The referee actually receives Rs 100 as wallet
credit after first booking, not "Rs 100 off". The phrasing implies a
discount-at-checkout that doesn't exist.

Impact:
Customer expects price to drop at checkout; sees full price; pays;
gets surprised by post-completion wallet credit. Avoidable friction.

Fix:
"Use my code ${stats.code} to get Rs 100 ZopMop credit after your
first booking."

Evidence:
- App/zopmop-app/src/screens/main/ReferralEarnScreen.tsx:117
- Actual mechanic: internal/referral/service.go:181 (credit on
  first-booking completion)
```

```
[SEVERITY: Low]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/wallet/model.go:29]
[CATEGORY: Bug / Stale comment]
Finding:
Comment: `KindReferralCredit Kind = "referral_credit"  // both referee
Rs 100 + referrer Rs 200`. Actual values are referrer Rs 150 / referee
Rs 100 (model.go:17-18 of referral package).

Impact:
Reader confusion + risk that someone hardcodes Rs 200 in CRM/admin UI
based on the comment.

Fix:
Update to "referee Rs 100 + referrer Rs 150".

Evidence:
- internal/wallet/model.go:29 vs internal/referral/model.go:17-18
```

---

## NIT

```
[SEVERITY: Nit]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/matching/dispatch.go:268-272]
[CATEGORY: Bug / Determinism]
Finding:
`generalPool` uses `rand.Shuffle` with the package-level rand source
which is initialized with a fixed seed unless `rand.Seed` is called.
Go 1.20+ auto-seeds the default source, so this is fine on the current
toolchain (1.26.3 per go.mod). But the comment doesn't note the
auto-seed reliance — fragile.

Impact:
None on Go 1.20+. Documentation-only.

Fix:
Either use `math/rand/v2` (auto-seeded by design) or add a comment
reminding readers Go 1.20+ is required.

Evidence:
- internal/matching/dispatch.go:268
```

```
[SEVERITY: Nit]
[FILE: /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/payments/cashfree.go:138-141]
[CATEGORY: Bug / Idempotency-key fallback]
Finding:
`refundID := "rfnd-" + idempotencyKey`; fallback when key is empty is
`fmt.Sprintf("rfnd-%d", time.Now().UnixNano())`. The fallback path
generates a non-idempotent id — any retry of an empty-key call hits
the gateway with a new refund_id and risks double-refund.

Impact:
Today no caller passes an empty key (per comment "for the
unauthenticated / pre-row-id flows that don't exist today"). If that
ever changes, double-refund risk re-emerges.

Fix:
Drop the fallback and require non-empty idempotencyKey at the API
boundary (return ErrMissingIdempotencyKey).

Evidence:
- internal/payments/cashfree.go:138-141
```

---

## QUESTIONS FOR ADITYA

1. **Migration 094 + cart unique drop (Critical-1, Critical-2)** — confirm
   the exact production state of `booking_services` columns and
   `cart_items` constraints today. The hybrid-schema memory entry says
   prod was patched manually; if the patch reverted 094 and re-added
   the legacy cart unique then the Critical-1 / Critical-2 findings are
   not actively firing but the Go code is still vulnerable to the next
   clean apply.
2. **Stealth dispatcher status='searching' (Critical-3)** — has any
   real after-8pm-IST stealth booking ever successfully assigned a pro
   in production? If yes, there is a transition path I missed; please
   point me to it.
3. **Referral phone-graph anti-fraud (Medium-7)** — is the product
   willing to accept this fraud surface for now or is a phone-graph
   check desired?
