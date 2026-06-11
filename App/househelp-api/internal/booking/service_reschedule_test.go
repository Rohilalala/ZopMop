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

// Rescheduling into a full window is rejected by the live gate.
func TestReschedule_IntoFullWindow_Blocked(t *testing.T) {
	f := newCapFixture(t, 1) // single helper → one seat per non-overlapping window
	svc := NewService(f.repo, f.pool, nil, nil, nil)

	// Customer A's booking at 09:00 (its window [09:00,09:45) doesn't reach 11:00).
	a, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("customer A booking (09:00) failed: %v", err)
	}

	// Customer B fills the single 11:00 seat.
	cB, aB := f.newCustomer()
	if _, err := f.bookAs(cB, aB, "11:00", 30, true); err != nil {
		t.Fatalf("customer B booking (11:00) failed: %v", err)
	}
	if got := f.available("11:00"); got != 0 {
		t.Fatalf("11:00 availability = %d, want 0 (full)", got)
	}

	// A tries to move 09:00 → 11:00 (full) → ErrSlotUnavailable.
	newSlot := f.slotID("11:00")
	newSched := f.instant("11:00").Format(time.RFC3339)
	if _, err := svc.RescheduleBooking(context.Background(), a.ID, f.customer, newSlot, newSched); !errors.Is(err, ErrSlotUnavailable) {
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

	a, err := f.book("09:00", 30, true) // padded window [09:00,09:45)
	if err != nil {
		t.Fatalf("book 09:00: %v", err)
	}

	// Move 09:00 → 09:30 (overlaps A's own old padded window). Must succeed.
	newSlot := f.slotID("09:30")
	newSched := f.instant("09:30").Format(time.RFC3339)
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

	// Simulate the assigner having already placed a pro on this booking.
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE bookings
		    SET helper_id = $2::uuid, status = 'accepted',
		        accepted_at = now(), matched_at = now()
		  WHERE id = $1::uuid`,
		a.ID, f.helperIDs[0],
	); err != nil {
		t.Fatalf("mark booking accepted: %v", err)
	}

	// Move 09:00 → 11:00 (free).
	newSlot := f.slotID("11:00")
	newSched := f.instant("11:00").Format(time.RFC3339)
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
