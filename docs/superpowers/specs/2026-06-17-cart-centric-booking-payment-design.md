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
- **(B) A two-step payment choice at checkout — *when* then *method*.** Upfront (wallet / online now) or pay-after-service. Pay-after creates an outstanding balance the customer can **settle online at any time** (Swiggy-style), or pay by cash at completion.

**Explicitly out of scope → deferred to Spec C** (separate design + plan): server-generated START/END OTPs, pro-side OTP verification, the settle-online-anytime *endpoint*, cash-collection-at-completion, and the END-OTP-gated-on-payment enforcement. A+B defines the payment *model* and *where the settle affordance lives*; the affordance's wiring, the settle endpoint, and the enforcement all **ship in C** (a "Pay online now" button with no settle endpoint would be dead UI, so it is not shipped in A+B).

## 2. Current state (as built, branch `develop`)

- **Two redundant selectors today:** a Schedule/Instant **mode toggle on `AllServicesScreen`** (`ModeToggle`, before service selection) AND an **ASAP-vs-slot choice inside the cart's `SchedulingModal`** (`asapSelected`). The cart's instant path (`POST /bookings/instant`, `createInstantCartBooking`) is **already multi-service**. The standalone `InstantMatchingScreen` is a single-service, parallel/legacy flow.
- **Duration** is chosen on the `ServiceAboutScreen` detail sheet and locked into the cart (`CartContext`).
- **Instant eligibility filter:** `AllServicesScreen` only shows services with `min_duration_minutes ≤ 30` in instant mode (`isInstantSvc`).
- **Payment today:** cart `paymentSource: 'direct' | 'wallet'` only. Backend supports a third rail, `cod`, but **no UI** exposes it; today `cod` just assigns + completes with **zero collection**.
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

## 4. Design

### 4.1 Services screen + navigation cleanup (A — frontend only)

- Remove `ModeToggle` (Schedule/Instant) from `AllServicesScreen` → pure browse grid. Tap a service → `ServiceAbout` sheet (duration picker + Add to cart). Cart dock unchanged.
- Remove the instant-eligibility filter (`isInstantSvc`, `min_duration ≤ 30`) — every service is addable and instant-able (D3).
- Retire the legacy single-service instant flow: delete `InstantMatchingScreen`, its route, the `AllServices { instant }` nav param, and any Home-screen "Instant" CTA that routed into it. (Enumerate all Home/grid entry points during implementation; the cart is the single timing decision point.)
- Resulting single nav path: `Home → AllServices → ServiceAbout (duration + add) → Cart → confirm → TrackLive | BookingConfirmed`.

### 4.2 Cart — WHEN selector (A)

- Add a prominent segmented **Instant | Scheduled** control on the cart.
- **Instant** → no slot; Confirm calls `POST /bookings/instant` (existing multi-service ASAP path, synchronous force-assign).
- **Scheduled** → opens the existing `SchedulingModal` for slot selection; Confirm calls `POST /bookings/scheduled` with the chosen `time_slot_id`.
- Drop the `SchedulingModal`'s own ASAP option — the segment now owns instant-vs-scheduled. Modal becomes slot-pick-only.
- State: collapse `asapSelected` + scattered slot fields into `timing: 'instant' | 'scheduled'` + `slot: { id, label } | null`.
- Validation: `scheduled` requires a selected slot before Confirm is enabled; `instant` requires nothing extra.

### 4.3 Cart — PAYMENT two-step (B)

- Replace `paymentSource: 'direct' | 'wallet'` with:
  - `payWhen: 'now' | 'after'`
  - when `now` → `payMethod: 'wallet' | 'online'`
  - when `after` → single "Pay after service" (no method sub-choice — D9)
- **UI:** Step 1 = Pay now / Pay after toggle. Step 2 (only for "now") = Wallet / Pay online. Wallet shown only under Pay-now and disabled if `walletBalance < total`.
- **Rail mapping (no backend change — all three rails exist):**

  | `payWhen` | `payMethod` | `payment_source` sent | Dispatch | `payment_status` at create |
  |-----------|-------------|----------------------|----------|----------------------------|
  | now | wallet | `wallet` | sync, after inline debit | `paid` |
  | now | online | `direct` | after Cashfree webhook | `pending` → `paid` |
  | after | — | `cod` | immediate | unpaid (NULL) |

- **Pay-later = outstanding balance + persistent "Pay online now" affordance** (D10). A+B *specifies* that a `cod` booking carries an outstanding balance and that a "Pay online now" CTA belongs on the confirmation screen and throughout the active job (tracking screen). That CTA, the *settle endpoint* (Cashfree charge against an existing booking), the cash-at-completion path, and the **END-OTP release on settle** all **ship in Spec C** — A+B does not render a dead button.

### 4.4 Data flow (A+B)

1. Cart Confirm builds the request from `{ timing, payWhen, payMethod }`:
   - `timing=instant` → `POST /bookings/instant { address_id, promo_code?, payment_source }`
   - `timing=scheduled` → `POST /bookings/scheduled { address_id, time_slot_id, promo_code?, payment_source }`
   - `payment_source` per the §4.3 mapping.
2. Post-confirm routing:
   - instant + assigned → "found your pro" (helper name + ETA from `ASAPResult`) → `TrackLive`.
   - instant + no pro → existing `no_pros_found` handling (auto-refund applies **only if prepaid**; a `cod` booking has nothing to refund).
   - scheduled → `BookingConfirmed`.
   - `now+online` (`direct`) → Cashfree sheet at checkout → on success → confirmed/dispatch (unchanged).

### 4.5 Backend footprint

- **A: zero** — pure frontend deletion + rewiring.
- **B: zero required** — `wallet` / `direct` / `cod` rails already exist; the rail mapping is client-side. No migration in A+B. (The "settle anytime" endpoint and any new columns belong to Spec C.)

## 5. Edge cases / risks

- **Roomies bill-split** (`splitEnabled`, `selectedMemberIds`) stays available only under **Pay-now** — a `cod`/pay-later booking can't be split cleanly. Hide/disable split when Pay-after is selected.
- **Scheduled + pay-later** holds a slot/capacity seat while unpaid. Acceptable — it is a confirmed booking; capacity is recounted live at dispatch (per the unified-dispatch model).
- **FCM is mocked locally** → "found your pro" / assignment is verified via DB + `event_outbox`, not a real push.
- **Pay-later fraud exposure** (work rendered before payment) — accepted for the single-society pilot (D11). Follow-up: CRM-controlled gate (per-customer / segment / first-booking-must-prepay).
- **Switching timing with a built cart** is now always valid (any service is instant-able, D3) — no cross-mode validation needed.

## 6. Testing

- **Headless API harness** (extend the existing OTP-login → cart-booking smoke test): drive every `{ timing × payWhen }` combination, assert the correct `payment_source`, dispatch behaviour, and resulting `status` / `payment_status`.
- **UI:** services screen has no mode toggle; any service is addable; cart shows the Instant/Scheduled segment + the two-step payment section; Confirm routes to the correct endpoint and post-confirm screen.

## 7. Boundary with Spec C (next design)

Spec C will cover, in order of dependency:
1. Server-generated START OTP (DB-backed, replacing the current client-side deterministic hash) + pro-side verification at job start.
2. Server-generated END OTP + pro-side verification at completion.
3. Pay-later collection: the **settle-online-anytime** endpoint (Cashfree charge against an existing `cod` booking) **and** cash-collected-at-completion.
4. **END-OTP gating:** for a pay-later booking the END OTP is released **only after** payment completes — online (settled anytime) or cash (at completion). Upfront-paid bookings get the END OTP at work-done with no payment gate.
