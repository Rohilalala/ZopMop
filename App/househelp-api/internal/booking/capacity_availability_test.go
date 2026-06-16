package booking

import (
	"context"
	"testing"
)

// Direct service-level invocation of GET /bookings/availability's code path
// (Service.GetSlotAvailability) — the handler is a thin auth/ownership wrapper,
// so exercising the service against the live test DB verifies the same math the
// endpoint serves. Asserts the two response invariants the picker relies on:
// available_capacity >= 0, and is_available consistent with it (true only when
// the slot is active AND there is remaining headroom).
//
// Skipped when TEST_DATABASE_URL is unset (mirrors capacity_test.go).
func TestGetSlotAvailability_ResponseInvariants(t *testing.T) {
	f := newCapFixture(t, 2) // 2 approved roster helpers in f.locality

	// Register f.locality as an active locality so the fixture address
	// (full_address contains f.locality) resolves to it rather than falling
	// back to PilotLocality — keeps this test isolated to its own roster.
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO localities (name, city, active) VALUES ($1, 'Gurugram', true)`,
		f.locality,
	); err != nil {
		t.Fatalf("register locality: %v", err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM localities WHERE name = $1`, f.locality)
	})

	svc := NewService(f.repo, f.pool, nil, nil, nil)

	// Pre-create the slot we'll later book, so the slots layer's grid
	// auto-generation (ensureSlotsExist runs only when the date has zero slots)
	// stays off — otherwise the fixture's plain INSERT in slotID() would collide
	// with a generated 09:00 row on UNIQUE(slot_date, start_time).
	const hhmm = "09:00"
	f.slotID(hhmm)

	resp, err := svc.GetSlotAvailability(context.Background(), f.addressID, f.dateStr)
	if err != nil {
		t.Fatalf("GetSlotAvailability: %v", err)
	}
	if resp.Date != f.dateStr {
		t.Fatalf("response date = %q, want %q", resp.Date, f.dateStr)
	}

	totalSlots := 0
	sawRosterHeadroom := false
	for _, p := range resp.Periods {
		for _, sl := range p.Slots {
			totalSlots++
			// Invariant 1: capacity never goes negative (clamped in the service).
			if sl.AvailableCapacity < 0 {
				t.Fatalf("slot %s (%s): available_capacity = %d, want >= 0",
					sl.ID, sl.StartTime, sl.AvailableCapacity)
			}
			// Invariant 2: is_available is consistent — true requires headroom.
			if sl.IsAvailable && sl.AvailableCapacity <= 0 {
				t.Fatalf("slot %s (%s): is_available=true but available_capacity=%d",
					sl.ID, sl.StartTime, sl.AvailableCapacity)
			}
			// With no bookings yet, an active slot reflects the full roster (2).
			if sl.IsAvailable && sl.AvailableCapacity == 2 {
				sawRosterHeadroom = true
			}
		}
	}
	if totalSlots == 0 {
		t.Fatal("expected at least one future slot in availability response")
	}
	if !sawRosterHeadroom {
		t.Fatal("expected at least one available slot with capacity = roster (2)")
	}

	// Now consume capacity on a concrete slot and confirm the endpoint math
	// reflects it: a booking that fills one seat drops available_capacity by 1.
	before := f.available(hhmm)
	if _, err := f.book(hhmm, 30, true); err != nil {
		t.Fatalf("seed booking at %s: %v", hhmm, err)
	}
	resp2, err := svc.GetSlotAvailability(context.Background(), f.addressID, f.dateStr)
	if err != nil {
		t.Fatalf("GetSlotAvailability (post-booking): %v", err)
	}
	found := false
	for _, p := range resp2.Periods {
		for _, sl := range p.Slots {
			if sl.StartTime == hhmm { // to_char(start_time,'HH24:MI') → "09:00"
				found = true
				if sl.AvailableCapacity != before-1 {
					t.Fatalf("%s available_capacity after one booking = %d, want %d",
						hhmm, sl.AvailableCapacity, before-1)
				}
				if sl.IsAvailable != (sl.AvailableCapacity > 0) {
					t.Fatalf("%s is_available=%v inconsistent with capacity=%d",
						hhmm, sl.IsAvailable, sl.AvailableCapacity)
				}
			}
		}
	}
	if !found {
		t.Fatalf("slot %s not present in availability response", hhmm)
	}
}
