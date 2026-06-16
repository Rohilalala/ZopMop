# Cart-Centric Booking + Payment Choice — Design (Spec A+B)

**Date:** 2026-06-17
**Status:** Approved design, pre-implementation
**Repo:** ZopMop · `App/zopmop-app` (RN/Expo customer app), `App/househelp-api` (Go/Fiber)
**Branch:** `feature/cart-booking-overhaul`
**Related:** `2026-06-12-unified-slot-dispatch-design.md` (the force-assign model this builds on); `2026-05-08-optimistic-cart-design.md`, `2026-06-09-slot-selector-redesign-design.md` (existing cart/slot work — review before implementing).

---

## 1. Goal

Two coupled user-side changes to the customer app:

- **(A) Move the instant-vs-scheduled selection out of the services screen and into the cart.** The services screen becomes a clean browse-and-add surface; the decision of *when* (Instant ASAP vs Scheduled slot) happens once, at the cart/checkout. Motivated by the shift from specialised-pro-per-task to **generalist pros trained across tasks** — one person can fulfil a mixed cart, so the timing choice no longer needs to live per-service up front.
- **(B) A two-step payment choice at checkout — *when* then *method* — plus a partial-wallet applicator.** Upfront (online now) or pay-after-service; wallet balance can be applied to any booking (partial or full), and when wallet is applied the remainder is online-only. Pay-after creates an outstanding balance the customer can **settle online at any time** (Swiggy-style), or pay by cash at completion.

**Explicitly out of scope → deferred to Spec C** (separate design + plan): server-generated START/END OTPs, pro-side OTP verification, the settle-online-anytime *endpoint*, cash-collection-at-completion, and the END-OTP-gated-on-payment enforcement. A+B defines the payment *model* and *where the settle affordance lives*; the affordance's wiring, the settle endpoint, and the enforcement all **ship in C** (a "Pay online now" button with no settle endpoint would be dead UI, so it is not shipped in A+B).

## 2. Current state (as built, branch `develop`)

- **Two redundant selectors today:** a Schedule/Instant **mode toggle on `AllServicesScreen`** (`ModeToggle`, before service selection) AND an **ASAP-vs-slot choice inside the cart's `SchedulingModal`** (`asapSelected`). The cart's instant path (`POST /bookings/instant`, `createInstantCartBooking`) is **already multi-service**. The standalone `InstantMatchingScreen` is a single-service, parallel/legacy flow.
- **Duration** is chosen on the `ServiceAboutScreen` detail sheet and locked into the cart (`CartContext`).
- **Instant eligibility filter:** `AllServicesScreen` only shows services with `min_duration_minutes ≤ 30` in instant mode (`isInstantSvc`).
- **Payment today:** cart `paymentSource: 'direct' | 'wallet'` only. Backend supports a third rail, `cod`, but **no UI** exposes it; today `cod` just assigns + completes with **zero collection**. **Wallet is all-or-nothing** — selectable only when `walletBalance ≥ total`; no partial apply, no split charge.
- **Payment rails (backend `internal/booking/service.go`):** `wallet` (inline debit, sync assign), `direct`/`""` (Cashfree prepay, dispatch deferred until `PAYMENT_SUCCESS` webhook stamps `payment_status='paid'`), `cod` (no money moves, assigns immediately, `payment_status` stays unpaid).
- Booking creation is multi-service on both `/bookings/instant` and `/bookings/scheduled` (cart is server-side; client sends only `address_id` [+ `time_slot_id` for scheduled] + `payment_source`).

## 3. Decisions (from brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Spec scope | A + B now; OTP lifecycle + pay-later collection = Spec C |
| D2 | Duration placement | Keep on `ServiceAbout` sheet, locked into cart |
| D3 | Instant eligibility | **Any** service can be instant — drop the `min_duration ≤ 30` filter |
| D4 | ASAP post-confirm UX | Brief "found your pro" (name + ETA) → existing live tracking (`TrackLive`) |
| D5 | Checkout structure | Cart + slot modal (minimal-move): selector lives on the cart, scheduled opens existing `SchedulingModal` |
| D6 | Payment UX | Two-step: **when** (Pay now / Pay after) → **method** |
| D7 | Pay-later dispatch | Immediate (the `cod` rail); collection enforced in Spec C |
| D8 | Upfront dispatch | Unchanged — paid at checkout (wallet inline / Cashfree sheet), then dispatch |
| D9 | Pay-after settle method | **Not** chosen at checkout — "Pay after service" is one option. Cash-vs-online decided later at settle time |
| D10 | Settle-online-anytime | Pay-later = persistent outstanding balance + a "Pay online now" affordance available throughout the booking; settling online releases the END OTP. *Affordance* in A+B, *endpoint + OTP release* in Spec C |
| D11 | Pay-later trust gating | Open to **everyone** for the pilot; CRM gate (segment / first-booking-prepay) is a documented follow-up, not built in A+B |
| D12 | Timing toggle | Reuse the **existing `ModeToggle` component** (relocated from `AllServicesScreen`), rendered on the cart once the cart has ≥1 item |
| D13 | Partial wallet | "Use wallet" applies `min(balance, total)`. Full-cover → wallet-only; partial → remainder **online-now only** (split). Wallet **never** combines with cash / pay-later |
| D14 | Wallet split scope | The split charge (partial wallet + Cashfree remainder) is built **in Spec B** → B is no longer zero-backend |
| D15 | "Pay online now" visual | A **subtle inline nudge row** (small leading icon + one short line + trailing chevron), not a loud filled CTA. Renders in Spec C |

## 4. Design

### 4.1 Services screen + navigation cleanup (A — frontend only)

- Remove `ModeToggle` (Schedule/Instant) from `AllServicesScreen` (it is **relocated** to the cart — §4.2, same component) → pure browse grid. Tap a service → `ServiceAbout` sheet (duration picker + Add to cart). Cart dock unchanged.
- Remove the instant-eligibility filter (`isInstantSvc`, `min_duration ≤ 30`) — every service is addable and instant-able (D3).
- Retire the legacy single-service instant flow: delete `InstantMatchingScreen`, its route, the `AllServices { instant }` nav param, and any Home-screen "Instant" CTA that routed into it. (Enumerate all Home/grid entry points during implementation; the cart is the single timing decision point.)
- Resulting single nav path: `Home → AllServices → ServiceAbout (duration + add) → Cart → confirm → TrackLive | BookingConfirmed`.

### 4.2 Cart — WHEN selector (A)

- Reuse the **existing `ModeToggle` component** (the Schedule/Instant control currently on `AllServicesScreen`) on the cart — same component, relocated (D12). Render it once the cart has ≥1 item.
- **Instant** → no slot; Confirm calls `POST /bookings/instant` (existing multi-service ASAP path, synchronous force-assign).
- **Scheduled** → opens the existing `SchedulingModal` for slot selection; Confirm calls `POST /bookings/scheduled` with the chosen `time_slot_id`.
- Drop the `SchedulingModal`'s own ASAP option — the segment now owns instant-vs-scheduled. Modal becomes slot-pick-only.
- State: collapse `asapSelected` + scattered slot fields into `timing: 'instant' | 'scheduled'` + `slot: { id, label } | null`.
- Validation: `scheduled` requires a selected slot before Confirm is enabled; `instant` requires nothing extra.

### 4.3 Cart — PAYMENT: wallet applicator + two-step (B)

**Wallet applicator (optional, top of the payment section):** "Use wallet (₹X available)". When on, applies `applied = min(walletBalance, total)`.
- `applied == total` → **wallet-only**, instant (existing `wallet` rail). No remainder, no when/method choice.
- `0 < applied < total` → **partial**: the remainder `total − applied` must be **paid online now** (Cashfree). This is a **split charge** (wallet debit `applied` + Cashfree `remainder`). Cash and Pay-after are **disabled** while wallet is applied (D13).
- Wallet **never** combines with cash or pay-later (D13).

**Two-step when→method (shown when wallet is OFF or balance = 0):**
- `payWhen: 'now' | 'after'`
- `now` → online (Cashfree, full total).
- `after` → single "Pay after service" → `cod` (no method sub-choice — D9).

**Rail mapping:**

| Selection | `payment_source` | Backend | Dispatch | `payment_status` |
|-----------|------------------|---------|----------|------------------|
| wallet covers full | `wallet` | exists | sync after debit | `paid` |
| wallet partial + online | **split (NEW)** | wallet debit + Cashfree remainder, atomic | after Cashfree confirms | `pending` → `paid` |
| online (no wallet) | `direct` | exists | after Cashfree webhook | `pending` → `paid` |
| pay after | `cod` | exists | immediate | unpaid (NULL) |

**Pay-later = outstanding balance + persistent "Pay online now" affordance** (D10). A+B *specifies* that a `cod` booking carries an outstanding balance and that a "Pay online now" CTA belongs on the confirmation + active-job screens. That CTA, the *settle endpoint* (Cashfree charge against an existing booking), the cash-at-completion path, and the **END-OTP release on settle** all **ship in Spec C** — A+B does not render a dead button.
- **Visual treatment (D15):** the "Pay online now" affordance is a **subtle inline nudge row**, not a loud filled CTA — a lightweight full-width row with a small leading rupee/coin icon, one short line (e.g. "Pay ₹X online to avoid cash handling" + optional cashback/benefit subtext), and a trailing chevron `›`, sitting inline in the content flow (à la the food-delivery "Pay ₹138 online to avoid cash handling ›" banner the user referenced). Realised in Spec C alongside the settle endpoint.

### 4.4 Data flow (A+B)

1. Cart Confirm builds the request from `{ timing, useWallet, payWhen, payMethod }`:
   - `timing=instant` → `POST /bookings/instant { address_id, promo_code?, payment_source }`
   - `timing=scheduled` → `POST /bookings/scheduled { address_id, time_slot_id, promo_code?, payment_source }`
   - `payment_source` per the §4.3 mapping; the **split** path additionally signals the wallet-applied amount so the backend debits the wallet + raises a Cashfree order for the remainder.
2. Post-confirm routing:
   - instant + assigned → "found your pro" (helper name + ETA from `ASAPResult`) → `TrackLive`.
   - instant + no pro → existing `no_pros_found` handling (auto-refund applies **only if prepaid** — wallet-only, split, or `direct`; a `cod` booking has nothing to refund; a **split** refunds **both** the wallet debit and the gateway charge).
   - scheduled → `BookingConfirmed`.
   - online or split (`direct` / split) → Cashfree sheet at checkout → on success → confirmed/dispatch; on failure → wallet debit (if any) rolled back, booking not dispatched.

### 4.5 Backend footprint

- **A: zero** — pure frontend deletion + rewiring.
- **B: one new backend capability — the split charge (D14).** `wallet` / `direct` / `cod` rails already exist and need no change. The **partial-wallet + Cashfree-remainder** path is net-new: in one flow, debit `min(balance, total)` from the wallet, create a Cashfree order for the remainder, and mark the booking `paid` only when the gateway confirms. Must be **atomic with rollback** — if the Cashfree order fails/expires after the wallet debit, the wallet debit is reversed (credited back) and the booking is not dispatched. Dispatch is **deferred until the gateway confirms** the remainder (same as `direct`), even though the wallet portion is already held. (The "settle anytime" endpoint + OTP columns remain Spec C.)

## 5. Edge cases / risks

- **Roomies bill-split** (`splitEnabled`, `selectedMemberIds`) stays available only under **Pay-now** — a `cod`/pay-later booking can't be split cleanly. Hide/disable split when Pay-after is selected.
- **Scheduled + pay-later** holds a slot/capacity seat while unpaid. Acceptable — it is a confirmed booking; capacity is recounted live at dispatch (per the unified-dispatch model).
- **FCM is mocked locally** → "found your pro" / assignment is verified via DB + `event_outbox`, not a real push.
- **Split-charge atomicity** (partial wallet + Cashfree): the wallet debit and the gateway charge must commit together. If Cashfree fails/expires after the wallet debit, reverse the wallet debit and do not dispatch. Guard against a stuck "wallet held, gateway pending" state (timeout/reconcile path). Verify no money is lost or double-counted (int64 paise).
- **Pay-later fraud exposure** (work rendered before payment) — accepted for the single-society pilot (D11). Follow-up: CRM-controlled gate (per-customer / segment / first-booking-must-prepay).
- **Switching timing with a built cart** is now always valid (any service is instant-able, D3) — no cross-mode validation needed.

## 6. Testing

- **Headless API harness** (extend the existing OTP-login → cart-booking smoke test): drive every `{ timing × (wallet-full | wallet-partial+online | online | pay-after) }` combination, assert the correct `payment_source`, dispatch behaviour, and resulting `status` / `payment_status`. For the **split**, assert the wallet debit + gateway order both apply on success and that a gateway failure rolls back the wallet debit (balances correct to the paise).
- **UI:** services screen has no mode toggle; any service is addable; cart shows the Instant/Scheduled segment + the two-step payment section; Confirm routes to the correct endpoint and post-confirm screen.

## 7. Boundary with Spec C (next design)

Spec C will cover, in order of dependency:
1. Server-generated START OTP (DB-backed, replacing the current client-side deterministic hash) + pro-side verification at job start.
2. Server-generated END OTP + pro-side verification at completion.
3. Pay-later collection: the **settle-online-anytime** endpoint (Cashfree charge against an existing `cod` booking) **and** cash-collected-at-completion. The customer-facing trigger is the subtle inline "Pay online now" nudge row (D15), shown on the confirmation + active-job screens.
4. **END-OTP gating:** for a pay-later booking the END OTP is released **only after** payment completes — online (settled anytime) or cash (at completion). Upfront-paid bookings get the END OTP at work-done with no payment gate.
