package booking

import (
	"context"
	"testing"
)

// DB-backed test for the CRM read API (Repository.CapacityForDate, served by
// GET /admin/capacity). Seeds a locality with 2 approved pros, puts 1 on
// approved leave for the date, and commits 1 booking in one slot. The booked
// slot's window must reconcile to free = roster − leave − committed = 2−1−1 = 0;
// every other window has the one absent pro on leave but no commitment, so
// free = 2−1−0 = 1.
//
// Skipped when TEST_DATABASE_URL is unset (mirrors capacity_test.go).
func TestCapacityForDate_RosterLeaveCommittedReconcile(t *testing.T) {
	f := newCapFixture(t, 2) // 2 approved roster helpers in f.locality
	ctx := context.Background()

	// One of the two pros is on approved full-day leave for the date → every
	// window loses one seat from the roster.
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO pro_leaves (pro_id, date, status, source) VALUES ($1::uuid, $2::date, 'approved', 'admin')`,
		f.helperIDs[0], f.dateStr); err != nil {
		t.Fatalf("insert approved leave: %v", err)
	}

	// One committed booking at 09:00 (30 min) holds a seat in the 09:00 window.
	const bookedHHMM = "09:00"
	f.slotID(bookedHHMM) // pre-create so the slots layer doesn't auto-generate
	if _, err := f.book(bookedHHMM, 30, true); err != nil {
		t.Fatalf("seed booking at %s: %v", bookedHHMM, err)
	}

	windows, err := f.repo.CapacityForDate(ctx, f.locality, f.dateStr)
	if err != nil {
		t.Fatalf("CapacityForDate: %v", err)
	}
	if len(windows) == 0 {
		t.Fatal("expected at least one window in capacity response")
	}

	sawBooked := false
	for _, w := range windows {
		// Roster and on-leave are locality/date-wide → identical on every row.
		if w.Roster != 2 {
			t.Fatalf("window %s roster = %d, want 2", w.WindowStart, w.Roster)
		}
		if w.OnLeave != 1 {
			t.Fatalf("window %s on_leave = %d, want 1", w.WindowStart, w.OnLeave)
		}
		// free is always the clamped roster − on_leave − committed.
		wantFree := w.Roster - w.OnLeave - w.Committed
		if wantFree < 0 {
			wantFree = 0
		}
		if w.Free != wantFree {
			t.Fatalf("window %s free = %d, want %d (roster %d − leave %d − committed %d)",
				w.WindowStart, w.Free, wantFree, w.Roster, w.OnLeave, w.Committed)
		}

		switch w.WindowStart {
		case bookedHHMM:
			sawBooked = true
			// 30-min job at 09:00 + 15-min travel pad spans [09:00, 09:45);
			// it overlaps only the 09:00 window (the next is 09:30 — also
			// overlapped via the pad, asserted in capacity_test.go). For the
			// 09:00 window: committed = 1 → free = 2−1−1 = 0.
			if w.Committed != 1 {
				t.Fatalf("booked window %s committed = %d, want 1", w.WindowStart, w.Committed)
			}
			if w.Free != 0 {
				t.Fatalf("booked window %s free = %d, want 0 (2−1−1)", w.WindowStart, w.Free)
			}
		case "09:30":
			// Travel pad bleeds the 09:00 job into 09:30 → committed = 1, free = 0.
			if w.Committed != 1 {
				t.Fatalf("09:30 window committed = %d, want 1 (travel pad)", w.Committed)
			}
			if w.Free != 0 {
				t.Fatalf("09:30 window free = %d, want 0 (held by pad)", w.Free)
			}
		default:
			// Untouched windows: only the leave applies → committed 0, free 1.
			if w.Committed != 0 {
				t.Fatalf("window %s committed = %d, want 0", w.WindowStart, w.Committed)
			}
			if w.Free != 1 {
				t.Fatalf("window %s free = %d, want 1 (2−1−0)", w.WindowStart, w.Free)
			}
		}
	}
	if !sawBooked {
		t.Fatalf("booked window %s not present in capacity response", bookedHHMM)
	}
}
