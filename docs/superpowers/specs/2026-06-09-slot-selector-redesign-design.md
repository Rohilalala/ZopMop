# Slot Selector Redesign — Design Spec

**Date:** 2026-06-09
**Component:** `App/zopmop-app/src/components/SchedulingModal.tsx`
**Status:** Approved, ready for implementation (handoff to claude design)

## Problem

The current scheduling modal shows a horizontal day strip, then period-grouped
slot cells in a flat 3-column grid (Morning / Afternoon / Evening stacked,
vertically scrolled). Issues raised:

1. **Capacity is invisible** — cells only show available vs `Full`. The new
   scheduling backend (`scheduling-feature-Harshita-slotcap`) computes *live*
   per-slot capacity (`available_capacity`), and none of it surfaces.
2. **Friction / scroll-hunting** — all periods stack in one scroll; finding the
   evening slot means scrolling past morning and afternoon.
3. **Weak hierarchy** — periods blur together in one long grid.
4. **Generic** — looks like any slot picker, not on-brand.

## Design — "Capacity Grid + Period Tabs"

A hybrid: keep the familiar grid of slot cells, but replace stacked period
sections with a segmented period control so only one period is on screen at a
time, and put a live capacity meter on every cell.

### Layout (top to bottom, inside the existing bottom sheet)

1. **Header** — title "Choose Date & Time" + close button. Unchanged.
2. **Day strip** — horizontal chips Today / +1 / +2. IST-cutoff disabling logic
   is **unchanged** (`buildDays`, `IST_CUTOFF_HOUR=20`, `SCHEDULING_LEAD_DAYS=2`).
3. **Period segmented control** — `Morning | Noon | Eve` pill control. Each
   segment carries a live count badge ("3 open" / "Full"). Tapping switches the
   visible period. Replaces the stacked period sections.
4. **Slot grid** — 3-column grid of cells for the *selected period only*. Cells
   are larger now that one period fills the space.
5. **Footer CTA** — "Confirm · Today 10:30 AM" (names day + time). When nothing
   is selected: "Select a time" (disabled). Unchanged behavior, richer label.

### Slot cell

Each cell shows: time range (e.g. `10:30 – 11:30`), a horizontal **capacity
meter**, and a status label. Three states, driven by `available_capacity`:

| `available_capacity` | Meter | Label | Tappable |
|---|---|---|---|
| `0` | full, grey (`#5a5348`) | **Full** | no (disabled, 0.4 opacity) |
| `1`–`3` (scarce) | partial, amber→orange | **"{n} left"** (or "Filling") | yes |
| `> 3` | partial, green (`#4caf6e`) | **Available** | yes |

**Scarce-only copy:** exact numbers appear *only* when `available_capacity <= 3`.
Roomy slots say "Available" with a green meter — no anxiety-inducing "8 free".

**Meter fill ratio** = `committed / effective_roster`, i.e. how full the slot is.
Derive from the response: `effective = available_capacity + committed`. Since the
endpoint returns `available_capacity` but not committed directly, compute fill as
`1 - (available_capacity / max_capacity_for_period)` where `max_capacity_for_period`
is the largest `effective` seen, OR — simpler and sufficient — bucket the fill by
state (green ~30%, amber ~65%, orange ~85%, full 100%). Bucketed fill is
acceptable; the meter is a *signal*, not a precise gauge.

### Period tab badge

Count of bookable slots (`available_capacity > 0`) in that period:
- `> 0` → "{n} open"
- `0` → **"Full"**, and the tab is **disabled** (visible, greyed, not tappable).

If a period has no slots at all (none generated), treat as disabled "—".

### Behavior

- **No pre-select.** Modal opens with no slot selected; CTA reads "Select a time".
  Switching day or period clears the current selection (matches current
  `setSelectedSlot(null)` on day change).
- **Default visible period:** first period that has `> 0` open slots. If all
  full, show the first period (all cells disabled) so the empty state is visible.
- Empty/`No slots available for this date` state is unchanged for a fully empty day.

## Data integration (the only non-cosmetic change)

The redesign needs per-slot capacity, which `GET /slots` does **not** return.
Switch to the new availability endpoint from the slotcap branch:

- **Endpoint:** `GET /bookings/availability?address_id=<id>&date=<YYYY-MM-DD>`
- **Response:** `AvailabilityResponse { date, periods: [{ label, slots: [{ id,
  slot_date, start_time, end_time, period, max_bookings, current_bookings,
  is_available, available_capacity }] }] }`
- **New requirement:** the endpoint needs an `address_id` (capacity is
  locality-scoped). `SchedulingModal` currently takes only `token`. It must also
  receive the **active booking address id** (from cart / booking flow) and pass
  it through.
- Add `getSlotAvailability(token, addressId, date)` to
  `App/zopmop-app/src/api/slots.ts` alongside the existing `getTimeSlots`. Extend
  `ApiTimeSlot` with `available_capacity: number`.
- **Fallback:** if `address_id` is unavailable at the call site, fall back to
  `getTimeSlots` (no capacity meters — degrade to Available/Full only). Keep the
  old path working so the modal is usable before the slotcap branch ships.

### Period label mapping

Backend period labels are `Morning | Afternoon | Evening`. The segmented control
displays `Morning | Noon | Eve`. Map Afternoon→Noon, Evening→Eve for display;
keep the backend label as the key.

## Out of scope

- The day strip / IST cutoff logic (untouched).
- The booking confirmation flow after `onConfirm`.
- Backend capacity computation (owned by the slotcap branch).

## Files touched

- `App/zopmop-app/src/components/SchedulingModal.tsx` — full UI rebuild.
- `App/zopmop-app/src/api/slots.ts` — add `getSlotAvailability`, extend
  `ApiTimeSlot`.
- Call sites of `SchedulingModal` — pass `addressId` prop (CartScreen / booking
  flow).

## Acceptance

- Period tabs switch the visible grid; only one period's slots render at a time.
- Each slot cell shows time + capacity meter + correct state label per the table.
- Numbers appear only at `available_capacity <= 3`.
- Fully-booked period tab is disabled and labeled "Full".
- No slot is pre-selected on open; CTA names the chosen day + time once picked.
- With no `address_id`, modal still works via the `getTimeSlots` fallback.
