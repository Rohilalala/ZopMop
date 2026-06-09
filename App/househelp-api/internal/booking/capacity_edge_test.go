package booking

import (
	"context"
	"errors"
	"sync"
	"testing"

	_ "time/tzdata"
)

// Edge-case probes for the slot-capacity gate. These push on the boundaries the
// happy-path suite doesn't: half-open adjacency, roster eligibility filters,
// leave status/date, committed-status set, multi-seat concurrency, and
// non-gated bookings still consuming capacity. DB-backed; skip without
// TEST_DATABASE_URL.

func (f *capFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("exec %q: %v", sql, err)
	}
}

// A 60-min job at 09:00 ends exactly at 10:00. Half-open overlap (start < end,
// end > start) means it must NOT block the 10:00 slot, which starts at 10:00.
func TestSlotCapacityEdge_AdjacentJobBoundary(t *testing.T) {
	f := newCapFixture(t, 1)
	if _, err := f.book("09:00", 60, true); err != nil {
		t.Fatalf("60-min booking at 09:00 failed: %v", err)
	}
	if got := f.committed("10:00"); got != 0 {
		t.Fatalf("committed overlapping 10:00 = %d, want 0 (adjacency is not overlap)", got)
	}
	if got := f.available("10:00"); got != 1 {
		t.Fatalf("10:00 availability after adjacent job = %d, want 1", got)
	}
	cB, aB := f.newCustomer()
	if _, err := f.bookAs(cB, aB, "10:00", 30, true); err != nil {
		t.Fatalf("booking the adjacent 10:00 slot should succeed: %v", err)
	}
}

// Suspended / banned / soft-deleted helpers drop out of the roster count even
// though their helpers row is approved.
func TestSlotCapacityEdge_IneligibleHelpersExcluded(t *testing.T) {
	f := newCapFixture(t, 3) // 3 approved
	if got := f.available("09:00"); got != 3 {
		t.Fatalf("initial = %d, want 3", got)
	}
	f.exec(`UPDATE users SET is_suspended = TRUE WHERE id = $1::uuid`, f.helperIDs[0])
	f.exec(`UPDATE users SET banned_at = now() WHERE id = $1::uuid`, f.helperIDs[1])
	if got := f.available("09:00"); got != 1 {
		t.Fatalf("after suspend+ban = %d, want 1", got)
	}
	f.exec(`UPDATE users SET deleted_at = now() WHERE id = $1::uuid`, f.helperIDs[2])
	if got := f.available("09:00"); got != 0 {
		t.Fatalf("after suspend+ban+delete = %d, want 0", got)
	}
}

// Helpers outside the locality, or not approved, never add capacity.
func TestSlotCapacityEdge_WrongLocalityAndUnapprovedExcluded(t *testing.T) {
	f := newCapFixture(t, 1) // 1 approved in-locality
	// Approved helper in a DIFFERENT locality.
	other := f.addUser(t, "pro")
	f.helperIDs = append(f.helperIDs, other)
	f.exec(`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'approved', $2)`, other, "OtherLoc-"+f.locality)
	// Pending-approval helper in THIS locality.
	pend := f.addUser(t, "pro")
	f.helperIDs = append(f.helperIDs, pend)
	f.exec(`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'pending', $2)`, pend, f.locality)

	if got := f.available("09:00"); got != 1 {
		t.Fatalf("capacity = %d, want 1 (other-locality + unapproved must not count)", got)
	}
}

// Only APPROVED leave on the SAME date for a ROSTER helper reduces capacity.
// (pro_leaves.status is constrained to approved|cancelled — there is no pending
// state.)
func TestSlotCapacityEdge_LeaveStatusAndDate(t *testing.T) {
	f := newCapFixture(t, 2)
	// Cancelled leave — must NOT reduce.
	f.exec(`INSERT INTO pro_leaves (pro_id, date, status, source) VALUES ($1::uuid, $2::date, 'cancelled', 'admin')`,
		f.helperIDs[0], f.dateStr)
	if got := f.available("09:00"); got != 2 {
		t.Fatalf("cancelled leave reduced capacity to %d, want 2", got)
	}
	// Approved leave on a DIFFERENT date — must NOT reduce today.
	f.exec(`INSERT INTO pro_leaves (pro_id, date, status, source)
	        VALUES ($1::uuid, ($2::date + 5), 'approved', 'admin')`, f.helperIDs[0], f.dateStr)
	if got := f.available("09:00"); got != 2 {
		t.Fatalf("approved leave on other date reduced capacity to %d, want 2", got)
	}
	// Approved leave, this date — reduces by one.
	f.exec(`INSERT INTO pro_leaves (pro_id, date, status, source) VALUES ($1::uuid, $2::date, 'approved', 'admin')`,
		f.helperIDs[1], f.dateStr)
	if got := f.available("09:00"); got != 1 {
		t.Fatalf("approved leave today = %d, want 1", got)
	}
}

// in_progress holds capacity; completed/cancelled free it.
func TestSlotCapacityEdge_CommittedStatusSet(t *testing.T) {
	f := newCapFixture(t, 1)
	b, err := f.book("09:00", 30, true)
	if err != nil {
		t.Fatalf("booking failed: %v", err)
	}
	f.exec(`UPDATE bookings SET status = 'in_progress' WHERE id = $1::uuid`, b.ID)
	if got := f.available("09:00"); got != 0 {
		t.Fatalf("in_progress should hold capacity, got avail = %d, want 0", got)
	}
	f.exec(`UPDATE bookings SET status = 'completed' WHERE id = $1::uuid`, b.ID)
	if got := f.available("09:00"); got != 1 {
		t.Fatalf("completed should free capacity, got avail = %d, want 1", got)
	}
}

// roster=2, three customers race the SAME slot: exactly two win.
func TestSlotCapacityEdge_ConcurrentTwoSeatsThreeBookers(t *testing.T) {
	f := newCapFixture(t, 2)
	f.slotID("09:00")
	type cust struct {
		c, a string
	}
	cs := []cust{}
	for i := 0; i < 3; i++ {
		c, a := f.newCustomer()
		cs = append(cs, cust{c, a})
	}
	var wg sync.WaitGroup
	errs := make([]error, 3)
	wg.Add(3)
	for i := range cs {
		go func(idx int) {
			defer wg.Done()
			_, errs[idx] = f.bookAs(cs[idx].c, cs[idx].a, "09:00", 30, true)
		}(i)
	}
	wg.Wait()
	var ok, full int
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrSlotUnavailable):
			full++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 2 || full != 1 {
		t.Fatalf("got %d ok / %d full, want 2/1", ok, full)
	}
}

// roster=2: two 60-min jobs at 09:00 fill the helpers through 10:00, so a
// 30-min job at 09:30 (inside that window) is blocked.
func TestSlotCapacityEdge_MultiHelperWindowSaturation(t *testing.T) {
	f := newCapFixture(t, 2)
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()
	cC, aC := f.newCustomer()
	if _, err := f.bookAs(cA, aA, "09:00", 60, true); err != nil {
		t.Fatalf("A failed: %v", err)
	}
	if _, err := f.bookAs(cB, aB, "09:00", 60, true); err != nil {
		t.Fatalf("B failed: %v", err)
	}
	if got := f.available("09:30"); got != 0 {
		t.Fatalf("09:30 availability with both helpers busy = %d, want 0", got)
	}
	if _, err := f.bookAs(cC, aC, "09:30", 30, true); !errors.Is(err, ErrSlotUnavailable) {
		t.Fatalf("09:30 booking: got err=%v, want ErrSlotUnavailable", err)
	}
}

// DURATION-BLIND DISPLAY GAP (documents current behaviour, not a pass/fail of
// the fix). availableForSlot — the value the /bookings/availability endpoint
// shows per slot — counts overlaps against the 30-min SLOT window only. A job
// longer than the slot is gated on its full job window (availableForWindow), so
// a slot can DISPLAY as available yet REJECT a long booking placed on it.
//
// roster=1. A 30-min job at 10:00 occupies 10:00–10:30. The 09:30 slot
// (09:30–10:00) does not overlap it, so the slot shows available. But booking a
// 60-min job at 09:30 (09:30–10:30) collides with the 10:00 job and is
// correctly rejected. The display and the gate disagree because the display
// can't know the cart's duration.
func TestSlotCapacityEdge_DurationBlindDisplayGap(t *testing.T) {
	f := newCapFixture(t, 1)
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()
	if _, err := f.bookAs(cA, aA, "10:00", 30, true); err != nil {
		t.Fatalf("seed 10:00 booking failed: %v", err)
	}
	// Display: 09:30 slot looks open (slot-window count misses the 10:00 job).
	if got := f.available("09:30"); got != 1 {
		t.Fatalf("display avail(09:30) = %d, want 1 (slot-window blind to 10:00 job)", got)
	}
	// Gate: a 60-min job at 09:30 reaches into 10:00–10:30 and is rejected.
	if _, err := f.bookAs(cB, aB, "09:30", 60, true); !errors.Is(err, ErrSlotUnavailable) {
		t.Fatalf("60-min 09:30 booking: got err=%v, want ErrSlotUnavailable "+
			"(display/gate disagree — duration-blind availability)", err)
	}
}

// A multi-item cart sums item durations into one job window. roster=1: a cart of
// two 30-min services at 09:00 is a 60-min job (09:00–10:00) and blocks 09:30.
func TestSlotCapacityEdge_MultiItemCartDuration(t *testing.T) {
	f := newCapFixture(t, 1)
	slotID := f.slotID("09:00")
	sched := f.instant("09:00").Format("2006-01-02T15:04:05Z07:00")
	items := []BookingServiceItem{
		{ServiceID: f.serviceID, DurationMinutes: 30, PriceCents: 100},
		{ServiceID: f.serviceID, DurationMinutes: 30, PriceCents: 100},
	}
	loc := f.locality
	if _, err := f.repo.CreateScheduledBooking(
		context.Background(), f.customer, f.addressID, slotID,
		sched, items, 200, 0, nil, false, nil, &loc, true,
	); err != nil {
		t.Fatalf("multi-item booking failed: %v", err)
	}
	if got := f.available("09:30"); got != 0 {
		t.Fatalf("09:30 availability after 60-min (2x30) cart = %d, want 0", got)
	}
}

// A non-gated booking (enforceCapacity=false, the instant/cart path) that still
// carries scheduled_time + duration consumes capacity for later scheduled
// bookings — the helper is genuinely busy.
func TestSlotCapacityEdge_NonGatedBookingConsumesCapacity(t *testing.T) {
	f := newCapFixture(t, 1)
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()
	// Non-gated booking takes the only helper at 09:00.
	if _, err := f.bookAs(cA, aA, "09:00", 30, false); err != nil {
		t.Fatalf("non-gated booking failed: %v", err)
	}
	if got := f.available("09:00"); got != 0 {
		t.Fatalf("availability after non-gated booking = %d, want 0", got)
	}
	if _, err := f.bookAs(cB, aB, "09:00", 30, true); !errors.Is(err, ErrSlotUnavailable) {
		t.Fatalf("gated booking after non-gated took the seat: got err=%v, want ErrSlotUnavailable", err)
	}
}
