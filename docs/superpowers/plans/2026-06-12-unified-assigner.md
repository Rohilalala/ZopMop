# Unified Assigner Implementation Plan (Plan 2 of 4 — Unified Slot Dispatch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three dispatch pipelines (5s batcher, nightly 22:00 cron, stealth cron) and the offer/accept invite chain with ONE just-in-time force-assigner: every booking assigned at `max(now, scheduled_time − 30min)`; ASAP bookings assigned synchronously at creation.

**Architecture:** A 60-second cron claims due bookings via a partial index, computes pool eligibility in one set-based SQL query, orders candidates (preferred → shift-ending-soonest → nearest), verifies travel feasibility with cached Google Maps walking ETAs, and force-assigns atomically (no pro accept step). `classifyScheduling` shrinks to past/45-min/2-day checks. Spec: `docs/superpowers/specs/2026-06-12-unified-slot-dispatch-design.md` §2, §3, §5, §6, §7, §9, §10, §12.

**Tech Stack:** Go 1.26 / Fiber / pgx v5 / Redis GEO / googlemaps client (`internal/googlemaps`) / forward-only migrations (next free: 132).

**Branch:** `feature/unified-slot-dispatch`, worktree `/.claude/worktrees/unified-slot-dispatch`. Commits per task, NO AI co-author trailers (repo rule), no push.

**Carryovers folded in:** RescheduleBooking still uses the retired counter gate (Task 7); GiST index hardcodes the pad — link to `capacityTravelPadMin` (Task 2).

---

### Task 1: Dispatch config constants

**Files:** Create `App/househelp-api/internal/matching/config.go` + `config_test.go`

- [ ] Define the five spec-§2 knobs read through `config_manager` with hardcoded fallbacks, mirroring the existing `ConfigBookingMaxActivePerHelper` pattern (see `internal/booking/service.go:671` for the read style; add the key constants next to the existing ones in `internal/config_manager`):
  `dispatch.lead_min`=30, `dispatch.travel_buffer_min`=15, `dispatch.asap_eta_pad_min`=5, `dispatch.asap_max_promise_min`=15, `dispatch.min_slot_lead_min`=45.
  Expose as `type DispatchConfig struct { LeadMin, TravelBufferMin, AsapEtaPadMin, AsapMaxPromiseMin, MinSlotLeadMin int }` + `LoadDispatchConfig(ctx, cfg *config_manager.Service) DispatchConfig` (never errors — falls back per key, logs once).
- [ ] Pure unit test: missing keys → defaults; present keys → parsed ints; garbage → default for that key only.
- [ ] `go test ./internal/matching/ -run DispatchConfig` green → commit `feat(matching): dispatch config knobs (spec §2)`.

### Task 2: Migration 132 — claim + clash indexes

**Files:** Create `App/househelp-api/migrations/132_assigner_indexes.up.sql`

- [ ] Per spec §11.1 (comment in the migration must reference `capacityTravelPadMin` in capacity.go as the single source of the 15):

```sql
-- 132_assigner_indexes.up.sql
-- Unified assigner hot paths (spec §11.1). Forward-only.
-- Claim scan: only unassigned, pending rows live in the index.
CREATE INDEX IF NOT EXISTS idx_bookings_assigner_claim
    ON bookings (scheduled_time)
    WHERE status = 'pending' AND helper_id IS NULL;
-- Clash probe: interval tree over each pro's padded job windows.
-- The +15 mirrors capacityTravelPadMin (internal/booking/capacity.go).
CREATE INDEX IF NOT EXISTS idx_bookings_helper_window_gist
    ON bookings USING gist (
        helper_id,
        tstzrange(scheduled_time,
                  scheduled_time + make_interval(mins => COALESCE(total_duration_minutes, 60) + 15))
    )
    WHERE helper_id IS NOT NULL
      AND status IN ('accepted', 'in_progress')
      AND scheduled_time IS NOT NULL;
```
  (btree_gist extension needed for uuid+range composite: `CREATE EXTENSION IF NOT EXISTS btree_gist;` first line.)
- [ ] `make migrate` applies clean → commit `feat(migrations): assigner claim + GiST clash indexes (132, spec §11.1)`.

### Task 3: The assigner core

**Files:** Create `App/househelp-api/internal/matching/assigner.go`, `assigner_test.go`. Modify `internal/matching/dispatch.go` only to export reused pieces if needed.

- [ ] `type Assigner struct { db *pgxpool.Pool; rdb *redis.Client; notifications notifier; experts expertsLookup; maps *googlemaps.Client; cfg func(context.Context) DispatchConfig }` + constructor.
- [ ] **ClaimDue(ctx)**: CTE claim, one row at a time, mirroring `scheduled_dispatch.go:claimNext` exactly but with the window `now() >= scheduled_time - make_interval(mins => $leadMin)` AND retry-friendly: claims also rows with `matched_at IS NOT NULL` if `matched_at < now() - interval '55 seconds'` (re-tries each tick until `scheduled_time`; the old `matched_at IS NULL` one-shot is wrong for the retry loop). Keep payment gate `(payment_method IS DISTINCT FROM 'cashfree' OR payment_status='paid')` and `FOR UPDATE SKIP LOCKED`.
- [ ] **EligibleCandidates(ctx, b, excludeProID)** — ONE set-based query returning ordered survivors (spec §5.3): all checks from `dispatch.go:checkEligibility` (active, approved, not on leave that IST date, no padded-window overlap via the GiST probe `NOT EXISTS (... tstzrange && tstzrange(b.start, b.end+pad))`, online shift session, remaining shift ≥ duration+pad, zone/locality match incl. `pro_zone_assignments` fallback to `helpers.locality`) — for the WHOLE locality pool in one statement, ORDER BY shift `end_time` ascending (soonest first), with preferred pros (from `experts.PreferredHelperIDs`) pulled to the front in Go. Exclude `excludeProID` (re-dispatch after pro cancel). Return `[]Candidate{ID, ShiftEndsAt, Lat/Lng-known}`.
- [ ] **TravelFeasible(ctx, cand, b, cfg) (etaMin int, ok bool)** — Redis GEO live position → `maps` walking ETA (reuse the Distance Matrix call pattern from `engine.go` filterByWalkingTime); in-process LRU cache TTL 2 min keyed `(geohash5(pro), bookingID)`; fail-open to `cfg.TravelBufferMin` on Maps error/no live position. ASAP rule: `eta+AsapEtaPadMin ≤ AsapMaxPromiseMin`; slot rule: `eta+AsapEtaPadMin ≤ minutesUntil(scheduled_time)` (when already past scheduled_time — retry tail — treat as ASAP rule).
- [ ] **Assign(ctx, b, proID)** — atomic claim:
```sql
UPDATE bookings SET helper_id=$2, status='accepted', accepted_at=now(),
       matched_at=COALESCE(matched_at, now()), updated_at=now()
WHERE id=$1 AND helper_id IS NULL AND status='pending' RETURNING customer_id::text
```
  plus per-pro `pg_advisory_xact_lock(hashtextextended(proID,0))` around count+assign for the ASAP sync path. On success: pro push `SendDataAlert(proID, "New job scheduled", body, {type:'booking_assigned', booking_id})`; customer push via existing `pushCustomerAccepted`; outbox `booking.accepted` row (same as `booking/repository.go:449`).
- [ ] **AssignOne(ctx, bookingID, excludeProID) (*AssignResult, error)** — load booking (reuse `loadBooking` shape), candidates, walk in order, first travel-feasible wins; none → `(nil, ErrNoEligiblePro)`.
- [ ] Tests (DB-backed, reuse capacity fixtures style): eligibility query each gate row (7 cases); ordering (soonest shift end first); assign atomicity (two concurrent AssignOne for one booking, one pro → exactly one winner); exclusion honored. Maps client nil in tests → fail-open path asserted.
- [ ] Commit `feat(matching): unified JIT assigner core (spec §5)`.

### Task 4: Assigner cron + no-pro terminal path

**Files:** Create `App/househelp-api/internal/matching/assigner_cron.go` (+ test). Modify `cmd/api/main.go:649-658`.

- [ ] 60s ticker: loop `ClaimDue` → `AssignOne`; on `ErrNoEligiblePro` and `now < scheduled_time` → leave pending (retried next tick because ClaimDue re-claims stale `matched_at`); on `ErrNoEligiblePro` and `now ≥ scheduled_time` → reuse `markBookingNoProsFound` + `pushCustomerNoProsFound` + create refund record if paid (mirror `pending_action_sweeper.go:162-192` wallet/pending_refunds logic — lift it into a shared helper `booking.RecordNoProRefund` rather than copy).
- [ ] Wire in `main.go`: start `Assigner` cron; REMOVE `matchBatcher` (lines 367-369; `bookingService` takes a nil/queue-less enqueue — see Task 6), `ScheduledDispatcher`, `StealthDispatcher` (655-656), `PendingActionSweeper` (658). KEEP `RebookScanner` (657).
- [ ] Test: booking due now + one eligible pro → assigned within one tick; zero pros + past slot → cancelled `no_pros_found` + refund row.
- [ ] Commit `feat(matching): assigner cron replaces batcher/scheduled/stealth dispatchers (spec §5.1, §5.5)`.

### Task 5: classifyScheduling rewrite + ASAP creation path

**Files:** Modify `App/househelp-api/internal/booking/service.go` (classifyScheduling ~:830, CreateBooking :359, CreateInstantBookingFromCart :1165, CreateScheduledBooking :1006), `handler.go`. Tests in `service_test.go`/new.

- [ ] `classifyScheduling` → `validateSlotTime(scheduledRFC3339) error`: past → `ErrSlotInPast`; `< now+MinSlotLeadMin` → new `ErrSlotTooSoon` (handler: 400 `slot_too_soon`, message "slots open 45 minutes out — use ASAP for now"); `> +2 days` → `ErrSlotTooFar`. Returns NO stealth flag. Delete `schedulingCutoffHourIST`, `stealthFireLeadTime` consts; `CreateScheduledBooking` passes `isStealthInstant=false, fireAt=nil` always (repo params stay for signature stability).
- [ ] ASAP path: repurpose `CreateInstantBookingFromCart` (POST /bookings/instant): `scheduled_time = now` (UTC), capacity gate **bypassed** (`enforceCapacity=false` already), after coords backfill call `assigner.AssignOne` synchronously; success → response includes `{assigned: true, promise_eta_minutes: eta+pad, helper_name}`; `ErrNoEligiblePro` → mark booking `cancelled/no_pros_found` (audit trail per spec §5.5), compute earliest available slot (first `GetSlotAvailability` window with capacity > 0 today/tomorrow) and return 409 `{code:'no_pros_available', earliest_slot: {...}}`. Inject the assigner into booking.Service via a narrow interface `type SyncAssigner interface { AssignOne(ctx, bookingID, exclude string) (*matching.AssignResult, error) }` to avoid an import cycle (matching already imports nothing from booking — define `AssignResult{HelperID, HelperName string, EtaMin int}` in matching).
- [ ] Legacy `CreateBooking` (POST /bookings, old instant): keep validations, set `scheduled_time=now`, drop `matchBatcher.Enqueue` (532-540), run the same synchronous assign path. Remove the 8PM-6AM instant blackout check (:363) — ASAP is now valid whenever an online pro exists; the assignment attempt IS the gate.
- [ ] Tests: lead-time validation triple; ASAP success returns promise; ASAP no-pro returns 409 + earliest_slot + booking row cancelled.
- [ ] Commit `feat(booking): ASAP = now + sync assign; 45-min slot lead; stealth/8pm rules removed (spec §3, §5.5)`.

### Task 6: Pro-cancel / leave → re-dispatch instead of dead-end

**Files:** Modify `App/househelp-api/internal/shift/service.go:362-405` (CancelBooking), `internal/shift/repository.go:760` (MarkBookingCancelled → new Unassign), `internal/leave/service.go` (reassignAffected), migration `133_booking_excluded_pro.up.sql`.

- [ ] Migration 133: `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS excluded_pro_id UUID;` (single-pro exclusion is enough for the pilot; comment says so).
- [ ] Pro cancel (shift): keep penalty/strike + customer push (audit fixes), but instead of `MarkBookingCancelled`: `UPDATE bookings SET helper_id=NULL, status='pending', matched_at=NULL, excluded_pro_id=$pro, updated_at=now() WHERE id=$1 AND status='accepted'` → assigner re-claims next tick and skips `excluded_pro_id`. If the booking's `scheduled_time` already passed → keep old cancel path (no point re-dispatching).
- [ ] Leave `reassignAffected`: replace `FindReplacementPro`+`ReassignBooking` force pick with the same unassign-to-pending (+excluded_pro_id = on-leave pro); keep customer notify; pro notify now happens on assignment (`booking_assigned`).
- [ ] `EligibleCandidates` already takes excludeProID — wire it from `bookings.excluded_pro_id` in AssignOne.
- [ ] Tests: pro cancel → row pending + excluded; assigner skips excluded pro; falls to second pro.
- [ ] Commit `feat(dispatch): pro cancel + leave return bookings to the assigner with exclusion (spec §7, migration 133)`.

### Task 7: Reschedule path onto the window-recount gate (Plan-1 carryover)

**Files:** Modify `App/househelp-api/internal/booking/service.go:~1726-1758` (RescheduleBooking) + tests.

- [ ] Replace the `current_bookings/max_bookings` counter read/write pair with: advisory lock (same `locality|date|slotID` key as CreateScheduledBooking), `availableForSlot(...)` for the NEW slot; remove the old-slot counter decrement (live recount needs no release). If the booking was already assigned, also reset `helper_id=NULL, status='pending', matched_at=NULL` so the assigner re-places it for the new time.
- [ ] Test: reschedule into a full window → `ErrSlotUnavailable`; into a free window → pending + reassigned by assigner.
- [ ] Commit `fix(booking): reschedule uses live capacity gate + re-dispatch (spec §7)`.

### Task 8: Delete the dead pipelines

**Files:** Delete `internal/matching/batch.go`, `scheduled_dispatch.go`, `stealth_dispatch.go`, `internal/booking/pending_action_sweeper.go`. Trim `internal/matching/engine.go` (scoring/batch parts; KEEP the googlemaps walking-ETA helper used by Task 3 — move it to `assigner.go` or a small `travel.go` if cleaner) and `dispatch.go` (delete InviteChain/inviteSinglePro/generalPool/checkEligibility once nothing references them; KEEP loadBooking/markBookingNoProsFound/pushCustomerNoProsFound/pushCustomerAccepted/helperName — assigner uses them). Remove `keep-looking` endpoint + `pending_customer_action` handling in `booking/service.go:960-998` + its routes; remove `/bookings/:id/decline`'s invite-set logic if it referenced Redis match keys (route may stay as no-op per spec §8 — simplest: delete route; mobile stops calling it in Plan 3).
- [ ] `grep -rn "Batcher\|StealthDispatcher\|ScheduledDispatcher\|PendingActionSweeper\|InviteChain\|pending_customer_action\|keep-looking"` over `internal/ cmd/` → only historical comments/migrations may remain.
- [ ] `go build ./... && go vet ./...` clean.
- [ ] Commit `refactor(matching): delete batcher, stealth + nightly dispatchers, invite chain, pending-action limbo (spec §9)`.

### Task 9: Full gates + integration races

- [ ] `cd App/househelp-api && go build ./... && go vet ./... && go test ./... && make preflight` — all green.
- [ ] Add integration tests (DB-backed): (a) two concurrent ASAP creations, one eligible pro → one assigned, one 409 no_pros_available; (b) admin manual assign (direct UPDATE mimicking CRM reassign) racing assigner claim → exactly one helper_id, no overwrite; (c) end-to-end slot flow: create booking T+50min → not claimed; advance by faking `scheduled_time = now()+29min` row → claimed + assigned on next tick.
- [ ] Commit `test(dispatch): assigner race + lifecycle integration suite`.

---

## Self-review notes
- Spec §2→T1, §3.1-3.3→T5, §5.1→T4, §5.2/5.3→T3, §5.4→T3, §5.5→T4+T5, §6→T3 (cache+fail-open), §7→T6+T7, §9→T8, §10 (searching never produced — AcceptBooking's tolerance remains harmless), §11.1→T2, §12 edge cases → T3/T4 tests.
- NOT here: §8 pro-app (Plan 3), §14 CRM (Plan 4). `is_stealth_instant`/`fire_at` columns stay (historical rows).
- The legacy `/pro/jobs/:id/accept` route keeps working during transition (status 'pending'|'searching' accept) — harmless; Plan 3 removes its UI.
