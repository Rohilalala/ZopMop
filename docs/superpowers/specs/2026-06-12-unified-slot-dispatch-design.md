# Unified Slot Dispatch — Design Spec

**Date:** 2026-06-12
**Status:** Approved in brainstorming; pending written-spec review
**Scope:** Booking creation, capacity, dispatch/assignment, pro + customer UX for the pilot
**Supersedes:** instant batcher matching, nightly 22:00 scheduled dispatch, stealth-instant dispatch, the 8 PM cutoff rule, the offer/accept invite chain

---

## 1. Summary

Today the system has three booking pipelines (instant batcher, nightly scheduled dispatcher, stealth-instant cron) and an offer/accept negotiation with pros. This design replaces all of them with **one booking concept and one assigner**:

- Every booking is a slot booking. "Instant" is just the earliest slot (ASAP).
- Pros never accept or decline. Work is **force-assigned** into their committed shift window and appears in their roster. (Pilot: pros are closely supervised; an accept/decline layer can return later.)
- Assignment is **just-in-time**: at `scheduled_time − 30 min` for slot bookings, immediately for ASAP. This fixes the fatal flaw of batch assignment: a booking created at noon for 2:30 PM is handled identically to one created two days ago.
- Travel time is a first-class input everywhere: Google Maps walking ETA when live location is known, a flat 15-minute planning buffer when it is not.
- Capacity for future slots uses the **window-recount model** from `origin/scheduling-feature-Harshita-slotcap` (roster − leave − overlapping committed job windows, under a (locality, date) advisory lock), not `time_slots` counters.

## 2. Constants (all config-backed, tunable without deploys)

| Key | Default | Meaning |
|---|---|---|
| `dispatchLeadMin` | 30 | Minutes before `scheduled_time` that assignment fires |
| `travelBufferMin` | 15 | Planning travel buffer used in all window math and shift-runway checks |
| `asapEtaPadMin` | 5 | Pad added to walking ETA for the customer-facing arrival promise |
| `asapMaxPromiseMin` | 15 | Max promise for ASAP; pros whose `ETA + pad` exceeds this are ineligible for that ASAP booking |
| `minSlotLeadMin` | 45 | Customers cannot book a regular slot closer than this (= dispatchLead + travelBuffer) |

## 3. Booking creation

### 3.1 Slot picker (customer)
- Options shown: **"ASAP — pro at your door in ~15 min"** plus regular grid slots starting `≥ minSlotLeadMin` (45 min) from now, up to 2 days out (existing `scheduledBookingMaxLeadDays`).
- The 15–45 minute gap is intentionally not bookable.

### 3.2 ASAP booking
- `scheduled_time = now`. ASAP means now — the pro leaves immediately.
- **Bypasses slot capacity counters and the window-recount gate.** The real capacity check is the synchronous assignment attempt (§5.3): if an eligible pro is free right now, the booking confirms; if not, the customer instantly gets *"No pros free right now — earliest slot is 4:00 PM, book it?"* and nothing half-created persists.
- Arrival promise on the confirmation screen: winner's **Google Maps walking ETA + `asapEtaPadMin`** ("Arriving by 2:07 PM"). Fallback when Maps/live location unavailable: `now + 15 min`.

### 3.3 Regular slot booking
- Validations as today (ownership, serviceability, promo, max-active, unpaid-Cashfree) plus:
- **Capacity gate = slotcap window-recount** (adopted from `scheduling-feature-Harshita-slotcap`):
  - Capacity(locality, window) = active rostered pros in locality − pros on approved leave that date − bookings in `committedStatusList` whose **padded** job windows overlap the requested window.
  - Runs under the (locality, date) advisory lock inside the booking-creation transaction (prevents the cross-slot double-book race — audit fix b939794 lineage).
  - `committedStatusList = (pending, searching, accepted, arrived, in_progress)` — a `pending` booking holds a roster seat from creation; the dispatcher later decides *which* pro. Cancellation frees capacity by leaving the status set.
- **Padded job window everywhere:** a booking occupies `[scheduled_time, scheduled_time + duration + travelBufferMin]` in all capacity and clash math.
- `time_slots.current_bookings/max_bookings` counters: **retired** (columns remain; no longer written or read for gating). Slot-picker availability display comes from the window-recount endpoint.
- `is_stealth_instant` / `fire_at` / the 8 PM `schedulingCutoffHourIST` rule: **no longer set or consulted** (columns remain, dead).

## 4. Capacity model (slotcap adoption notes)

- Source branch: `origin/scheduling-feature-Harshita-slotcap` (`capacity.go`, 245 lines + tests). **Backend adopted; FE from that branch superseded** by this design's picker.
- Changes required during adoption:
  1. Migration renumbered (branch ships `112`; develop is at 126 and the audit-fix branch holds 127–130 → land as **131+**).
  2. Window padded with `travelBufferMin` (branch counts raw windows).
  3. `PilotLocality` fallback ("Orchid Island Gurugram") retained for the pilot; multi-society rollout must replace it with real address→locality resolution (already flagged in branch comments).

## 5. The assigner (one dispatcher, replaces all three)

### 5.1 Trigger
- Cron tick every 60 s: claim bookings with `status='pending'`, `helper_id IS NULL`, payment gate (`payment_method <> 'cashfree' OR payment_status='paid'`), and `now ≥ scheduled_time − dispatchLeadMin`. `SELECT FOR UPDATE SKIP LOCKED` + `matched_at` stamp (existing claim pattern).
- ASAP bookings additionally trigger a **synchronous assignment attempt inside the booking-creation request** so the customer gets an immediate confirm/deny. The cron remains the safety net (e.g. process crash mid-create).

### 5.2 Candidate ordering
1. Customer's preferred pros (existing `experts.PreferredHelperIDs`, oldest relationship first).
2. General pool, locality-filtered. Among eligible pros, order by:
   1. **Shift ending soonest** (spend expiring capacity first — preserves flexible pros for later bookings; closes most of greedy assignment's "capacity stealing" failure mode for free),
   2. then **nearest-first by live location** (Redis geo) when available, else random.

### 5.3 Per-candidate eligibility (all must pass)

Eligibility for the WHOLE candidate pool is computed in **one set-based SQL query** (joins evaluate every row of the matrix below for all candidates at once, returning ranked survivors) — not one round-trip per candidate. Only the travel-feasibility check runs per-candidate afterwards, in §5.2 order, stopping at the first pass.
| Check | Rule |
|---|---|
| Account | not banned/deleted, `approval_status='approved'` |
| Leave | no approved leave on the booking's IST date |
| Clash | no existing accepted/arrived/in-progress booking whose window overlaps the new booking's **padded** window `[start, start + duration + travelBufferMin]` |
| Online | live shift session (`online_at` set, `offline_at` null). JIT assignment always happens mid-shift, so the online requirement stays; committed-but-offline pros are skipped and the existing no-show penalty system polices them |
| Shift runway | remaining committed shift ≥ `duration + travelBufferMin` |
| Zone/locality | zone assignment or `helpers.locality` matches booking locality (case-insensitive) |
| **Travel feasibility** | Google Maps walking ETA from pro's live location to the booking address must satisfy: ASAP → `ETA + asapEtaPadMin ≤ asapMaxPromiseMin`; slot → `ETA + asapEtaPadMin ≤ minutes until scheduled_time`. Maps error or stale location → **fail-open** to `travelBufferMin` as the assumed ETA (dispatch must never stall on Google) |

### 5.4 Assignment (atomic, no negotiation)
```sql
UPDATE bookings SET helper_id=$pro, status='accepted', accepted_at=now(),
       matched_at=COALESCE(matched_at, now()), updated_at=now()
WHERE id=$id AND helper_id IS NULL AND status='pending'
RETURNING customer_id
```
- Pro push: `booking_assigned` (already routed in the app) — "New job: 2:30 PM, Sector 12". Roster updates; pro taps **"Got it"** (UI acknowledgment only, no backend gate).
- Customer push: "‹Name› is assigned to your booking" (+ outbox-backed durable copy).
- Max-active cap is **not** applied to roster assignment (it would block legitimate day-packing); the padded-window clash check is the real constraint. ASAP synchronous path keeps the per-pro advisory lock to serialize concurrent assigns.

### 5.5 No pro found
- **ASAP:** synchronous failure → instant customer answer offering the earliest available regular slot. The booking row IS created and immediately marked `cancelled` / `cancelled_by='no_pros_found'` — keeps an audit trail, reuses the existing refund-if-paid path, and feeds the rebook scanner.
- **Slot:** retry every tick from `T − 30` to `T + 0`. Still unassigned at slot start → `cancelled`, `cancelled_by='no_pros_found'`, customer push, auto-refund record. Rebook scanner ("pros available again within 2 h") stays.
- `pending_customer_action` limbo + its sweeper: **deleted** (only the stealth path produced it).

## 6. Travel-time model (single source of truth)

| Surface | Value |
|---|---|
| Booking-confirmed screen (promise) | `Maps walking ETA + asapEtaPadMin` (padded promise; under-promise over-deliver) |
| TrackLive screen | **raw live Maps ETA**, unpadded, refreshing as the pro's location streams (live-location WS pipeline) |
| Capacity + clash windows | `duration + travelBufferMin` pad |
| Shift runway | `duration + travelBufferMin` |
| Dispatch lead | `dispatchLeadMin = 30` = travel + breathing room, verified per-pro with real ETA at assignment |
| Maps quota | ASAP ≈ 1 call per candidate until one qualifies (nearest-first → usually 1–3); slot = 1 per assignment; fail-open on error |
| ETA cache | in-process **LRU with TTL (~2 min)** keyed `(pro geohash bucket, booking address)` — pros barely move between ticks, so repeat candidate checks are cache hits instead of Maps calls |

## 7. Post-assignment changes

- **Pro cancels / declares leave / loses the shift:** booking returns to `pending` (helper cleared), dispatcher re-claims next tick with that pro excluded; customer notified of the swap (`worker_changed` push, already routed). Pro-side penalties unchanged.
- **Customer cancel:** windows unchanged (free ≥ 30 min before start; fee inside). ASAP bookings are inside the fee window by construction.
- **Reschedule:** re-runs the capacity gate for the new window; releases the old window implicitly via status/time change.

## 8. Pro app changes

- **Deny/Decline: removed** from all surfaces (pilot). Backend `/decline` route may remain but nothing calls it.
- JobOffer screen (offer + countdown + accept/decline) is obsolete for dispatch; assigned jobs land directly in the roster (JobsList/Today). The `booking_offer` push type stops being sent.
- Roster: today's assigned jobs, live-updating on `booking_assigned`. Optional "later today: N unassigned bookings in your area" teaser — **out of scope v1** (YAGNI).

## 9. Deletions (the payoff)

| Component | Fate |
|---|---|
| 5 s batcher + PostGIS scoring engine + walking-time batch filter | deleted (Maps ETA helper retained for §5.3/§6) |
| Nightly 22:00 ScheduledDispatcher | deleted |
| StealthDispatcher + 15-min search window | deleted |
| `pending_customer_action` + sweeper | deleted |
| InviteChain / inviteSinglePro / 25 s offer waits / Redis invite sets | deleted |
| 8 PM cutoff (`schedulingCutoffHourIST`), `classifyScheduling` stealth branch | deleted (keep past-check, ≥45-min check, ≤2-day check) |
| Deny button + offer UI | deleted |
| `time_slots` counter gating | retired (display/columns remain) |

## 10. State machine (after)

```
pending ──(assigner)──→ accepted ──→ in_progress ──→ completed
   │                        │              │
   └──────→ cancelled ←─────┴──────────────┘
```
- `searching` no longer produced (remains in CHECK constraint for old rows; accept-path tolerance for it stays harmless).
- En-route/arrived stay timestamps. Per-service line statuses unchanged.

## 11. Data & migrations

- New migrations start at **131** (audit branch holds 127–130): slotcap gating objects (renumbered from branch's 112), plus any config seeds for §2 keys.
- No destructive schema changes: `is_stealth_instant`, `fire_at`, `time_slots` counters, `pending_customer_action` enum value all remain for historical rows.

### 11.1 Indexes (the compute model)
All hot dispatch paths are index probes, not scans:
- **Claim scan** (every 60 s): partial B-tree `ON bookings (scheduled_time) WHERE status='pending' AND helper_id IS NULL` — the index contains only unassigned rows; the DB index IS the dispatcher's priority queue, persistent and crash-safe.
- **Clash check** (per pro × window): GiST **`tstzrange` index** `ON bookings USING gist (helper_id, tstzrange(scheduled_time, scheduled_time + (total_duration_minutes + 15) * interval '1 minute'))` — a real interval tree; overlap (`&&`) becomes one O(log n) probe instead of per-row date math.
- **Capacity recount** (per locality × window): same range-index approach keyed by locality (extends slotcap's partial index).
- **Nearest pro:** Redis GEO (geohash sorted set) — already in place.
These four + the single set-based eligibility query (§5.3) and the ETA cache (§6) make a dispatch tick a handful of index probes and at most a few Maps calls.

## 12. Edge cases

| Case | Behaviour |
|---|---|
| Booking created at `T−29` (admin path or race past picker) | claimed on next tick; assignment with whatever lead remains |
| Pro's job overruns into next assignment | next assignment's clash check at `T−30` sees live windows; an overrunning job at that moment makes the pro ineligible |
| Process down at 2:00 PM, back 2:10 | cron catch-up claims everything past its lead time immediately (no fixed-hour run to miss — the old 22:00/3:30 fragility is gone by design) |
| Maps outage | fail-open: assume `travelBufferMin` ETA, promises fall back to flat +15 |
| No live location for an online pro | nearest-first degrades to shuffle; travel check fail-open |
| Two ASAP bookings race for the last free pro | per-pro advisory lock + `helper_id IS NULL` guard — one wins, the loser's synchronous attempt moves to the next candidate or reports no-pros |

## 13. Out of scope / pilot caveats

- Accept/decline layer for pros (may return post-pilot).
- Multi-society locality resolution (PilotLocality fallback stays).
- Day-level route optimization across a pro's roster.
- "Later today" unassigned-jobs teaser in the pro app.
- Driving-mode ETAs (walking only, matching pilot reality).

## 14. CRM integration (ships together with dispatch, same release)

The CRM currently has zero dispatch visibility (its only "dispatcher" is the webhook dispatcher; no manual trigger, no slot/capacity admin). Force-assign removes all human negotiation from dispatch, so ops tooling is part of this design — not a follow-up.

### 14.1 Dispatch monitoring (new)
- **Dashboard KPI "Bookings at risk":** count of bookings `pending`, unassigned, with `now ≥ scheduled_time − dispatchLeadMin` (the assigner is actively failing to place them). Extend `GET /admin/dashboard/kpis`.
- **No-pros-found feed:** OrdersPage filter for `cancelled_by='no_pros_found'` (last 48 h) so ops sees every unfilled booking same-day.
- **Order detail:** show assignment metadata — assigned pro, `matched_at`. Per-candidate skip reasons are server logs only in v1 (no attempt-audit table).

### 14.2 Capacity visibility (new)
- Expose the window-recount to CRM: `GET /admin/capacity?locality=&date=` → rows `{window, roster, on_leave, committed, free}`.
- UI: read-only capacity grid, drill-down from LocalitiesPage by date.

### 14.3 Manual override (existing, verified compatible)
- OrderDetail assign/reassign modal remains the ops escalation path. Admin assign vs JIT-cron races are safe via the `helper_id IS NULL` claim guard — covered by an explicit test (§15).
- Admin reassign of an assigned booking keeps notifying old pro / new pro / customer (already wired).

### 14.4 Cleanups
- OrdersPage status filter: drop `searching` (never produced again).
- PushPage: `booking_offer` type stops flowing — display-only, no change needed.

### 14.5 Config
- §2 constants live in `config_manager`, seeded via migration/env. A CRM editing UI for them is deferred together with the Feature-Flags-bridge item; pilot tuning happens via config seeds.

### 14.6 Explicitly unchanged
- Customer-app UI beyond the slot picker (§3.1); LiveMapPage; workers/leaves/payouts CRM surfaces.

## 15. Testing

- Unit: capacity window math (adopt slotcap's 389-line test file, extend for the travel pad); eligibility matrix per §5.3 row; promise computation incl. fallbacks.
- Integration: ASAP happy path (create→assign→push), ASAP no-pro path, slot T−30 assignment, no-pro-at-slot-start refund path, re-dispatch after pro cancel, race: two ASAP vs one pro, race: admin manual assign vs JIT cron claim.
- CRM: bookings-at-risk KPI counts only in-window unassigned; capacity endpoint rows reconcile with the booking-creation gate; no-pros-found filter returns the §5.5 cancellations.
- Manual pilot checklist: noon booking for 2:30 PM lands in a pro's roster at 2:00 PM with correct ETA promise; TrackLive shows raw live ETA; CRM shows the assignment and the capacity grid reflects the held window.
