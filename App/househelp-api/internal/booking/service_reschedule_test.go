package booking

import (
	"context"
	"errors"
	"testing"
	"time"
)

// DB-backed tests for RescheduleBooking on the live window-recount capacity
// gate (spec §7). Reschedule must run the same gate as creation against the NEW
// slot — full window → ErrSlotUnavailable; free window → the move lands and, if
// the booking was already assigned, it drops back to pending/unassigned so the
// assigner re-places it for the new time.
//
// Skipped when TEST_DATABASE_URL is unset (mirrors capacity_test.go).

// Rescheduling into a full window is rejected by the live gate. The reschedule
// target is a near-future slot (within the bookable window) so the new
// validateSlotTime check passes and the capacity gate is what blocks the move.
func TestReschedule_IntoFullWindow_Blocked(t *testing.T) {
	f := newCapFixture(t, 1) // single helper → one seat per non-overlapping window
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	// Customer A's booking at 09:00 (far-future fixture date; reschedule validates
	// only the NEW time, so the original may sit on the fixture date).
	a, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("customer A booking (09:00) failed: %v", err)
	}

	// Near-future target slot; customer B fills its single seat.
	target, targetSched := f.nearSlot()
	cB, aB := f.newCustomer()
	if _, err := f.bookSlot(cB, aB, target, targetSched, 30, true); err != nil {
		t.Fatalf("customer B booking (target slot) failed: %v", err)
	}

	// A tries to move 09:00 → the full target slot → ErrSlotUnavailable.
	if _, err := svc.RescheduleBooking(context.Background(), a.ID, f.customer, target, targetSched); !errors.Is(err, ErrSlotUnavailable) {
		t.Fatalf("reschedule into full window: got err=%v, want ErrSlotUnavailable", err)
	}

	// The booking must be untouched — still on the original 09:00 slot.
	var slotID string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text FROM bookings WHERE id = $1::uuid`, a.ID,
	).Scan(&slotID); err != nil {
		t.Fatalf("reload booking slot: %v", err)
	}
	if slotID != f.slotID("09:00") {
		t.Fatalf("booking slot after rejected reschedule = %s, want original 09:00 slot", slotID)
	}
}

// A booking must not block its own move into an overlapping (adjacent) slot:
// even in a single-seat locality, the recount excludes the row being moved, so
// its not-yet-shifted old window doesn't count against the new slot.
func TestReschedule_AdjacentOverlap_NotSelfBlocked(t *testing.T) {
	f := newCapFixture(t, 1) // single seat — the strict case
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	// Original and target are two near-future slots one minute apart, so their
	// padded 30-min windows overlap. Both are inside the bookable window so the
	// new validateSlotTime check passes; the test exercises the self-exclusion in
	// the capacity recount.
	origSlot, origSched := f.nearSlot()
	newSlot, newSched := f.nearSlot()
	a, err := f.bookSlot(f.customer, f.addressID, origSlot, origSched, 30, true)
	if err != nil {
		t.Fatalf("book original near slot: %v", err)
	}

	// Move into the overlapping adjacent slot. Must succeed (the row being moved
	// is excluded from its own recount).
	if _, err := svc.RescheduleBooking(context.Background(), a.ID, f.customer, newSlot, newSched); err != nil {
		t.Fatalf("adjacent-overlap reschedule should succeed (self-exclusion), got: %v", err)
	}

	var slotID string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text FROM bookings WHERE id = $1::uuid`, a.ID,
	).Scan(&slotID); err != nil {
		t.Fatalf("reload booking slot: %v", err)
	}
	if slotID != newSlot {
		t.Fatalf("booking slot after reschedule = %s, want %s", slotID, newSlot)
	}
}

// Rescheduling an already-assigned booking into a free window moves it AND
// resets it to pending/unassigned so the assigner re-dispatches it at the new
// time.
func TestReschedule_IntoFreeWindow_ResetsForReDispatch(t *testing.T) {
	f := newCapFixture(t, 2) // headroom in every window
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	a, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("booking (09:00) failed: %v", err)
	}

	// Simulate the assigner having already placed a pro on this booking
	// (accepted, NOT yet arrived — reschedule of a not-yet-started job is valid).
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE bookings
		    SET helper_id = $2::uuid, status = 'accepted',
		        accepted_at = now(), matched_at = now()
		  WHERE id = $1::uuid`,
		a.ID, f.helperIDs[0],
	); err != nil {
		t.Fatalf("mark booking accepted: %v", err)
	}

	// Move to a free near-future slot (inside the bookable window).
	newSlot, newSched := f.nearSlot()
	if _, err := svc.RescheduleBooking(context.Background(), a.ID, f.customer, newSlot, newSched); err != nil {
		t.Fatalf("reschedule into free window failed: %v", err)
	}

	// The move landed and the booking is reset for re-dispatch.
	var (
		slotID    string
		status    string
		helperID  *string
		matchedAt *time.Time
	)
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text, status, helper_id::text, matched_at
		   FROM bookings WHERE id = $1::uuid`, a.ID,
	).Scan(&slotID, &status, &helperID, &matchedAt); err != nil {
		t.Fatalf("reload booking: %v", err)
	}
	if slotID != newSlot {
		t.Fatalf("booking slot after reschedule = %s, want %s", slotID, newSlot)
	}
	if status != "pending" {
		t.Fatalf("status after reschedule = %s, want pending", status)
	}
	if helperID != nil {
		t.Fatalf("helper_id after reschedule = %v, want NULL (re-dispatch)", *helperID)
	}
	if matchedAt != nil {
		t.Fatalf("matched_at after reschedule = %v, want NULL (re-dispatch)", *matchedAt)
	}
}

// Reschedule must enforce the same time-window rules as creation: a target in
// the past, sooner than the 45-min lead, or beyond the 2-day horizon is rejected
// (the booking is left untouched).
func TestReschedule_TimeWindowValidations(t *testing.T) {
	f := newCapFixture(t, 1)
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	a, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("book 09:00: %v", err)
	}
	target, _ := f.nearSlot() // a valid slot id; only the time is varied below

	cases := []struct {
		name  string
		sched string
		want  error
	}{
		{"past", time.Now().In(istLoc).Add(-1 * time.Hour).Format(time.RFC3339), ErrSlotInPast},
		{"too_soon", time.Now().In(istLoc).Add(20 * time.Minute).Format(time.RFC3339), ErrSlotTooSoon},
		{"too_far", time.Now().In(istLoc).AddDate(0, 0, 5).Format(time.RFC3339), ErrSlotTooFar},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.RescheduleBooking(context.Background(), a.ID, f.customer, target, tc.sched); !errors.Is(err, tc.want) {
				t.Fatalf("reschedule %s: got err=%v, want %v", tc.name, err, tc.want)
			}
		})
	}

	// The booking must be untouched — still on the original 09:00 slot.
	var slotID string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text FROM bookings WHERE id = $1::uuid`, a.ID,
	).Scan(&slotID); err != nil {
		t.Fatalf("reload booking slot: %v", err)
	}
	if slotID != f.slotID("09:00") {
		t.Fatalf("booking slot after rejected reschedules = %s, want original 09:00 slot", slotID)
	}
}

// Reschedule of an already-started job (arrived or in_progress) is rejected so a
// pro is never yanked off an in-flight job.
func TestReschedule_StartedJob_Blocked(t *testing.T) {
	f := newCapFixture(t, 1)
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	a, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("book 09:00: %v", err)
	}
	// Pro assigned and ARRIVED (status stays accepted, arrived_at stamped).
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE bookings SET helper_id = $2::uuid, status = 'accepted',
		     accepted_at = now(), matched_at = now(), arrived_at = now()
		 WHERE id = $1::uuid`,
		a.ID, f.helperIDs[0],
	); err != nil {
		t.Fatalf("mark booking arrived: %v", err)
	}

	target, targetSched := f.nearSlot()
	_, err = svc.RescheduleBooking(context.Background(), a.ID, f.customer, target, targetSched)
	if err == nil || err.Error() != "booking cannot be rescheduled in current status" {
		t.Fatalf("reschedule of arrived job: got err=%v, want 'booking cannot be rescheduled in current status'", err)
	}

	// Untouched.
	var slotID string
	var helperID *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text, helper_id::text FROM bookings WHERE id = $1::uuid`, a.ID,
	).Scan(&slotID, &helperID); err != nil {
		t.Fatalf("reload booking: %v", err)
	}
	if slotID != f.slotID("09:00") || helperID == nil {
		t.Fatalf("arrived booking was modified: slot=%s helper=%v", slotID, helperID)
	}
}
