# CRM Dispatch Integration Plan (Plan 4 of 4 — Unified Slot Dispatch)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Give ops eyes on the force-assign world (spec §14): bookings-at-risk KPI, no-pros-found feed, read-only capacity grid, assignment metadata; retire dead filter values.

**Tech Stack:** Go (cmd/crm-api + internal/crm), React+Vite (App/zopmop-crm). Gates: `go build/vet/test`, `npx tsc --noEmit` (CRM).

**Branch/worktree:** `feature/unified-slot-dispatch` at `/.claude/worktrees/unified-slot-dispatch`. No AI trailers, no push.

---

### Task 1: Backend — bookings-at-risk KPI + no-pros filter

**Files:** Modify `App/househelp-api/internal/crm/dashboard/dashboard.go` (+test), `internal/crm/orders/orders.go` (+test).

- [ ] KPI: extend the kpis response with `bookings_at_risk` = `COUNT(*) FROM bookings WHERE status='pending' AND helper_id IS NULL AND now() >= scheduled_time - make_interval(mins => $lead)` where `$lead` reads `dispatch.lead_min` from the config table the same way other crm code reads config (fallback 30). Uses the partial claim index.
- [ ] Orders list: accept `cancelled_by=` query param (exact match, validated against known values incl. `no_pros_found`) added to the existing filter SQL.
- [ ] Tests: at-risk counts only in-window unassigned (3 fixtures: future-far pending = no, in-window pending = yes, assigned = no); orders filter returns only matching rows.
- [ ] `go build ./... && go test ./internal/crm/...` → commit `feat(crm-api): bookings-at-risk KPI + cancelled_by orders filter (spec §14.1)`.

### Task 2: Backend — GET /admin/capacity

**Files:** Modify `App/househelp-api/internal/booking/capacity.go` (export a read API), create `internal/crm/capacity/capacity.go` (+test), wire in `cmd/crm-api/main.go`.

- [ ] Export from the booking package: `func (r *Repository) CapacityForDate(ctx, locality, date string) ([]WindowCapacity, error)` returning per-slot rows `{SlotID, Window (start–end IST strings), Roster, OnLeave, Committed, Free int}` — same math as `GetSlotAvailability` (roster/on-leave once, committed per slot, travel-pad included via committedCountForSlot).
- [ ] CRM handler: `GET /admin/capacity?locality=&date=` (validate date YYYY-MM-DD; locality non-empty; RequirePermission read-level like sibling read endpoints), constructs/uses a `booking.Repository` over the crm db pool, returns `{locality, date, windows: [...]}`.
- [ ] Test: seeded locality with 2 pros, 1 on leave, 1 committed booking → rows reconcile (free = roster − leave − committed, clamped ≥0).
- [ ] Commit `feat(crm-api): read-only capacity endpoint (spec §14.2)`.

### Task 3: CRM frontend — KPI card, no-pros feed, capacity grid, filter cleanup

**Files:** Modify `App/zopmop-crm/src/api/dashboard.ts`, `src/pages/DashboardPage.tsx`, `src/pages/OrdersPage.tsx`, `src/pages/LocalitiesPage.tsx`, `src/api/all.ts` (or new `src/api/capacity.ts`).

- [ ] Dashboard: `bookings_at_risk` on the KPIs type + a KPI card "Bookings at risk" (alert tone when > 0).
- [ ] OrdersPage: add quick filter chip/select "Unfilled (no pros)" → `cancelled_by=no_pros_found` param; REMOVE `searching` from the status filter options + STATUS_TONE (never produced anymore).
- [ ] LocalitiesPage: per-locality "Capacity" drill-down (date picker defaulting today IST) → table `{window, roster, on leave, committed, free}` from `GET /admin/capacity`; read-only; error/empty states per the page's existing patterns (ErrorState component exists).
- [ ] Order detail: show `matched_at` ("Assigned at") in the timeline if not already rendered (FE OrderDetail type already carries it — render only).
- [ ] `npx tsc --noEmit` green → commit `feat(crm): dispatch monitoring — at-risk KPI, unfilled feed, capacity grid (spec §14)`.

### Task 4: Gates + race-test verification

- [ ] `cd App/househelp-api && go build ./... && go vet ./... && go test ./...` and `cd App/zopmop-crm && npx tsc --noEmit` — all green.
- [ ] VERIFY (already landed in Plan 2 T9): the admin-manual-assign vs assigner-claim race test exists and passes (`go test ./internal/matching/ -run -v` the race test name). If somehow absent → BLOCKED (do not write a new one silently; report).
- [ ] Commit anything moved → `test(crm): plan-4 verification`.

---

## Self-review
- §14.1→T1+T3, §14.2→T2+T3, §14.3 verified in T4 (test landed in Plan 2), §14.4→T3 (searching removal; PushPage needs nothing), §14.5 config = seeds only (already in config defaults, no UI — per spec deferral), §14.6 untouched surfaces respected.
- CRM is not prod-deployed (repo rule) — no IsProduction concerns for these read-only surfaces.
