# Capacity Foundation Implementation Plan (Plan 1 of 4 — Unified Slot Dispatch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the live window-recount capacity model (ported from `origin/scheduling-feature-Harshita-slotcap`) on `feature/unified-slot-dispatch`, with the 15-minute travel pad, as the single capacity gate for scheduled bookings.

**Architecture:** Capacity is derived live at booking time — `available = roster(locality) − onLeave(locality,date) − committedOverlapping(locality, paddedWindow)` — under a per-(locality,date,slot) advisory lock inside the booking-creation transaction. No counter columns. The `GET /bookings/availability` endpoint recomputes the same math for the customer slot picker.

**Tech Stack:** Go 1.26 / Fiber / pgx v5 / Postgres (migrations forward-only, no .down.sql). Spec: `docs/superpowers/specs/2026-06-12-unified-slot-dispatch-design.md` §3.3, §4, §11.1.

**Branch:** `feature/unified-slot-dispatch` (cut from `origin/develop`). Work here only.

**Known interplay (do not "fix" during this plan):** `fix/pro-crm-audit-sweep` (unmerged) also edits `CreateScheduledBooking` (real address/coords) and holds migrations 127–130. When that branch merges, a small conflict in `repository.go` is expected and resolved then — both changes are additive to different parts of the function.

---

### Task 1: Cherry-pick the slotcap commit

**Files:**
- Create: `App/househelp-api/internal/booking/capacity.go`, `capacity_test.go`, `App/househelp-api/migrations/112_slot_capacity_gating.up.sql` (renamed in Task 2)
- Modify: `App/househelp-api/internal/booking/handler.go`, `service.go`, `repository.go`
- (Mobile files from the commit are reverted in Step 3 — superseded by this redesign's picker, Plan 3.)

- [ ] **Step 1: Cherry-pick**

```bash
cd /Users/adityarohilla/Documents/ZopMop
git switch feature/unified-slot-dispatch
git cherry-pick 411d93a   # "feat: add slot capacity gating pilot" (tip of origin/scheduling-feature-Harshita-slotcap)
```

Expected: conflicts possible in `internal/booking/handler.go` / `service.go` / `repository.go` (develop moved since the branch was cut).

- [ ] **Step 2: Resolve conflicts by intent**

Keep BOTH sides everywhere; the slotcap side replaces only the old counter-gate block. Specifically in `repository.go::CreateScheduledBooking`: delete the `FOR UPDATE`/`current_bookings`/`max_bookings` counter block entirely, keep the slotcap advisory-lock + `availableForSlot` block (its diff is shown verbatim in the spec-discussion; the gate reads `to_char(slot_date,'YYYY-MM-DD'), is_active FROM time_slots WHERE id=$1`, takes `pg_advisory_xact_lock(hashtextextended(locality|date|slotID, 0))`, then `availableForSlot(...) <= 0 → ErrSlotUnavailable`). In `service.go::CreateScheduledBooking`: locality resolution becomes `resolveGateLocality` with `PilotLocality` fallback and `enforceCapacity=true`; `CreateInstantBookingFromCart` passes `false`.

- [ ] **Step 3: Drop the commit's mobile files (superseded by Plan 3)**

```bash
git checkout HEAD -- App/zopmop-app/src/api/bookings.ts App/zopmop-app/src/api/slots.ts App/zopmop-app/src/components/SchedulingModal.tsx App/zopmop-app/src/screens/main/CartScreen.tsx 2>/dev/null || true
git status --short   # only backend files + migration should remain changed
```

- [ ] **Step 4: Compile**

```bash
cd App/househelp-api && go build ./...
```
Expected: clean. (`users.is_suspended` exists — migration 001; `internal/slots` exists on develop — both verified.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(booking): port live slot-capacity gating from scheduling-feature-Harshita-slotcap"
```

### Task 2: Renumber the migration to 131 and fix its header

**Files:**
- Rename: `App/househelp-api/migrations/112_slot_capacity_gating.up.sql` → `131_slot_capacity_gating.up.sql`

- [ ] **Step 1: Rename + fix the stale header comment** (file says `-- 111_slot_capacity_gating.sql`)

```bash
cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api/migrations
git mv 112_slot_capacity_gating.up.sql 131_slot_capacity_gating.up.sql
sed -i '' '1s/111_slot_capacity_gating.sql/131_slot_capacity_gating.up.sql/' 131_slot_capacity_gating.up.sql
```

- [ ] **Step 2: Verify no code references the old number**

```bash
grep -rn "migration 111\|migration 112\|migrations/112" ../internal/ ../cmd/ | grep -v _test
```
Expected: only `capacity.go`'s comment "partial index in migration 111_slot_capacity_gating" → edit that line in `App/househelp-api/internal/booking/capacity.go` to say `131_slot_capacity_gating`.

- [ ] **Step 3: Migrate locally + commit**

```bash
cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api
make up && make migrate          # compose stack + forward-only migrations
git add -A && git commit -m "chore(migrations): renumber slot-capacity gating to 131 (develop holds 124-126, audit branch 127-130)"
```

### Task 3: Run the ported capacity tests

- [ ] **Step 1: Run**

```bash
cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api
go test ./internal/booking/ -run 'Capacity|Availability|Slot' -v 2>&1 | tail -20
```
Expected: PASS (these are the branch's 389 lines of capacity tests; they are DB-backed — the compose stack from Task 2 must be up). If a test references seed data missing on develop (e.g. locality rows), fix the TEST setup to insert its own fixtures — do not change seeds.

- [ ] **Step 2: Commit any test-fixture fixes**

```bash
git add -A && git commit -m "test(booking): self-contained fixtures for ported capacity tests" || echo "nothing to fix"
```

### Task 4: Add the 15-minute travel pad to the committed-overlap window (TDD)

**Files:**
- Modify: `App/househelp-api/internal/booking/capacity.go` (committedCountForSlot), `capacity_test.go`

- [ ] **Step 1: Write the failing test** (append to `capacity_test.go`, reusing its existing fixture helpers — match the file's naming for creating a locality/helper/booking; the assertion shape is what matters):

```go
// A booking ending exactly at a slot's start must still count against that
// slot: the 15-minute travel pad makes back-to-back windows overlap.
func TestCommittedCount_TravelPadOverlapsAdjacentSlot(t *testing.T) {
	repo, cleanup := newCapacityTestRepo(t) // use the file's existing setup helper name
	defer cleanup()

	// Fixture: locality with 1 approved helper; slot 10:00–10:30 IST;
	// a committed booking 09:00–10:00 IST (60 min) in the same locality.
	loc := seedLocalityWithRoster(t, repo, 1)
	slotID := seedSlot(t, repo, "10:00", "10:30")
	seedCommittedBooking(t, repo, loc, "09:00", 60)

	n, err := repo.committedCountForSlot(context.Background(), repo.db, loc, slotID)
	if err != nil {
		t.Fatalf("committedCountForSlot: %v", err)
	}
	// Raw windows: 09:00–10:00 vs 10:00–10:30 → no overlap (half-open).
	// Padded:      09:00–10:15 vs 10:00–10:30 → overlap. Expect 1.
	if n != 1 {
		t.Fatalf("travel pad: want committed=1 against adjacent slot, got %d", n)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
go test ./internal/booking/ -run TravelPadOverlapsAdjacentSlot -v
```
Expected: FAIL with `got 0` (raw half-open windows don't overlap).

- [ ] **Step 3: Implement** — in `committedCountForSlot`, pad the booking window end:

```sql
AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes + 15))
      > ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata')
```
And update the function comment: window is `[scheduled_time, scheduled_time + duration + 15min travel pad)` per spec §3.3/§6. The 15 stays a named const:

```go
// capacityTravelPadMin mirrors travelBufferMin (spec §2) for window math.
const capacityTravelPadMin = 15
```
(use `b.total_duration_minutes + ` + the const via fmt.Sprintf or make_interval param — match the file's existing query style.)

- [ ] **Step 4: Run the whole capacity suite**

```bash
go test ./internal/booking/ -run 'Capacity|Availability|Slot|TravelPad' -v 2>&1 | tail -15
```
Expected: ALL PASS — if an existing ported test asserted non-padded adjacency, update that test's expectation and note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(booking): 15-min travel pad in capacity overlap window (spec §3.3)"
```

### Task 5: Full verification gates

- [ ] **Step 1: Backend gates**

```bash
cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api
go build ./... && go vet ./... && go test ./internal/booking/ ./internal/slots/ && make preflight
```
Expected: all green (preflight = vet + tests + compose + smoke).

- [ ] **Step 2: Confirm the availability endpoint manually**

```bash
# with the compose stack up + a seeded user/address (OTP_DEV_MODE=999999):
curl -s "http://localhost:8080/api/v1/bookings/availability?date=$(date -v+2d +%F)&address_id=<uuid>" -H "Authorization: Bearer <token>" | jq '.periods[0].slots[0]'
```
Expected: slot JSON with `available_capacity` ≥ 0 and `is_available` consistent with it.

- [ ] **Step 3: Final commit if anything moved**

```bash
git add -A && git commit -m "test(booking): capacity foundation verification" || true
```

---

## Self-review notes (spec coverage)

- §3.3 capacity gate + padded window → Tasks 1, 4. §4 adoption notes (renumber, pad, PilotLocality retained) → Tasks 1, 2, 4. §11 migration 131 → Task 2. §11.1 capacity index → ships inside migration 131 (ported `idx_bookings_locality_sched`; the GiST tstzrange upgrade is Plan 2's migration with the claim index, where the assigner needs it).
- NOT in this plan (later plans): ASAP bypass semantics (Plan 2), `GET /admin/capacity` CRM endpoint (Plan 4), slot-picker UI (Plan 3), counter-column retirement beyond the gate (the counters simply stop being written by this code path; `time_slots` admin display untouched).
