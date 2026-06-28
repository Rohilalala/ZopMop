# Pro App + Slot Picker Implementation Plan (Plan 3 of 4 — Unified Slot Dispatch)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Mobile catches up with the backend model: customers get ASAP + ≥45-min slots with live capacity; pros get a force-assigned roster (no offers, no accept/decline).

**Architecture:** Slot picker consumes `GET /bookings/availability` and the ASAP create responses (`assigned/promise_eta_minutes` | 409 `no_pros_available`+`earliest_slot`). Pro app: `booking_assigned` push → roster refresh + alert; the entire offer surface (JobOffer screen, offer rows, decline, countdowns) is removed. TrackLive already streams raw live ETA (verified during the audit fixes) — verify, don't rebuild.

**Tech Stack:** React Native/Expo (App/zopmop-app), TypeScript. Gates: `npx tsc --noEmit`; backend untouched except verified contracts.

**Branch/worktree:** `feature/unified-slot-dispatch` at `/.claude/worktrees/unified-slot-dispatch`. No AI commit trailers. No push.

---

### Task 1: Customer slot picker — ASAP + 45-min lead + live capacity

**Files:** Modify `App/zopmop-app/src/components/SchedulingModal.tsx`, `src/api/bookings.ts` (or create `src/api/slots.ts`), `src/screens/main/CartScreen.tsx`.

- [ ] API: `getSlotAvailability(date: string, addressId: string)` → `GET /bookings/availability?date=&address_id=` typed to the backend `AvailabilityResponse` (periods[].slots[] incl. `available_capacity`, `is_available`). Use `apiFetch`.
- [ ] Picker UI: first option **"ASAP — pro at your door in ~15 min"**; then the day's period-bucketed slots from the endpoint, with a slot DISABLED when `is_available=false` OR its start is `< now + 45min` (IST math — use the existing IST helpers, never `toISOString` date-only).
- [ ] ASAP selection → existing instant-create call path (`POST /bookings/instant` for cart flow); on success read `{assigned, promise_eta_minutes, helper_name}`; on 409 `{code:'no_pros_available', earliest_slot}` show inline sheet: "No pros free right now — earliest slot is <time>. Book it?" → one tap books that slot via the scheduled path.
- [ ] Slot create 400 `slot_too_soon` → friendly copy ("slots open 45 minutes out — use ASAP").
- [ ] `npx tsc --noEmit` green → commit `feat(app): ASAP + capacity-aware slot picker (spec §3.1)`.

### Task 2: Booking-confirmed promise + TrackLive verification

**Files:** Modify `App/zopmop-app/src/screens/main/BookingConfirmedScreen.tsx` (and the cart/instant success navigation that feeds it).

- [ ] ASAP confirmations show **"<Name> is on the way — arriving by <now + promise_eta_minutes>"** (compute display time in IST). Slot confirmations show the slot time as today.
- [ ] VERIFY (no rebuild): TrackLiveScreen shows the raw live Maps ETA from the tracking payload and refreshes via the live-location WS (landed in the audit-fix branch lineage — if absent on THIS branch, that's expected: it's on fix/pro-crm-audit-sweep; note it in the report as a merge-order dependency, do NOT reimplement).
- [ ] tsc green → commit `feat(app): ASAP arrival promise on confirmation (spec §6)`.

### Task 3: Pro roster — booking_assigned in, offers out

**Files:** Modify `App/zopmop-app/src/utils/pushRouter.ts`, `src/screens/pro/JobsListScreen.tsx`, `src/utils/shiftEvents.ts` if needed.

- [ ] `booking_assigned` push (sent by the assigner: `{type:'booking_assigned', booking_id}`) → emit existing `booking_status_change` AND show a high-visibility in-app alert/toast "New job added to your roster" (tray notification already arrives via FCM alert payload). JobsListScreen must refetch on that event (it already listens for `booking_status_change` — verify; wire if not).
- [ ] Remove the offers surface from JobsListScreen: the offers cache/map, pending-offer hydration from `/pro/jobs/pending`, OfferRow rendering, and related state. Roster sections = active + today's jobs only.
- [ ] "Got it" acknowledgment: newly-arrived roster rows (booking ids seen via the event since last app open) render with a NEW badge + a "Got it" button that just clears the badge (local AsyncStorage set; no backend call — spec §5.4).
- [ ] tsc green → commit `feat(app): pro roster live-updates on booking_assigned; offers surface removed (spec §8)`.

### Task 4: Delete the offer machinery

**Files:** Delete `App/zopmop-app/src/screens/pro/JobOfferScreen.tsx`. Modify `src/navigation/MainNavigator.tsx`, `src/types/navigation.ts`, `src/utils/pushRouter.ts`, `src/api/jobs.ts`.

- [ ] Remove the JobOffer route + screen + nav types; remove `booking_offer`/`SCHEDULED_INVITE` cases from pushRouter (backend no longer sends them — falls to default log if a stale push arrives); remove decline/accept-offer API functions from `api/jobs.ts` (`acceptJob` for offers, decline, listPendingOffers) and any imports. Keep per-job lifecycle APIs (en-route/arrive/start/complete) untouched.
- [ ] grep `JobOffer\|booking_offer\|decline\|pending` under `src/` → no live references to the removed surface (pro leave/decline-unrelated hits are fine — judge each).
- [ ] tsc green → commit `refactor(app): delete job-offer screen, offer pushes, decline (spec §8, §9)`.

### Task 5: Gates

- [ ] `cd App/zopmop-app && npx tsc --noEmit` AND `cd App/househelp-api && go build ./... && go test ./internal/matching/ ./internal/booking/` (contract sanity — backend untouched, must still be green).
- [ ] Manual checklist (emulator optional — if no simulator available, static-verify the wiring and say so): picker shows ASAP + disabled near slots; pro JobsList has no offer UI.
- [ ] Commit anything that moved → `test(app): plan-3 verification`.

---

## Self-review
- Spec §3.1→T1, §6 promise/TrackLive→T2, §5.4 ack + §8 roster→T3, §8/§9 deletions→T4. Customer-side unchanged beyond picker/confirm per §14.6. CRM untouched (Plan 4).
- Backend contract names used here were landed by Plan 2 T5 (`promise_eta_minutes`, `no_pros_available`, `earliest_slot`, `slot_too_soon`) — implementers verify exact JSON keys against `internal/booking/service.go`/handler before typing the FE.
