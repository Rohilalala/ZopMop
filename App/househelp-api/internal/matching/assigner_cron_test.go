package matching

import (
	"context"
	"testing"
	"time"

	_ "time/tzdata"

	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// DB-backed tests for the assigner cron (spec §5.1, §5.5). Reuses asgFixture
// from assigner_test.go. Skipped when TEST_DATABASE_URL is unset.
//
// Travel note: with nil maps the cron's assigner fails open to TravelBufferMin
// (15). For a future slot the feasibility rule is eta+pad <= minutesUntilSlot,
// so a booking must be both DUE (now >= scheduled_time - leadMin) and far enough
// out that 15+5=20 <= minutesUntilSlot. now()+25min satisfies both (due since
// 25 < lead 30; feasible since 20 <= ~25).

// makePaidBookingAt inserts a pending cashfree-paid booking at `at` for the
// fixture customer/locality. Paid so the ClaimDue payment gate lets it through
// and the no-pro terminal path produces a refund row.
func (f *asgFixture) makePaidBookingAt(at time.Time, durationMin int, amountPaise int64) string {
	f.t.Helper()
	var id string
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO bookings
		  (customer_id, status, address, lat, lng, amount_paise, total_duration_minutes,
		   scheduled_time, locality, payment_method, payment_status)
		VALUES ($1::uuid, 'pending', 'Test Addr', 28.45, 77.05, $2, $3, $4, $5, 'cashfree', 'paid')
		RETURNING id::text
	`, f.customer, amountPaise, durationMin, at, f.locality).Scan(&id); err != nil {
		f.t.Fatalf("insert paid booking: %v", err)
	}
	return id
}

// TestAssignerCron_AssignsDueBooking: a due booking with one eligible pro is
// force-assigned within a single RunOnce tick.
func TestAssignerCron_AssignsDueBooking(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	// Due (within 30-min lead) and 25 min out so fail-open travel (20) fits.
	bk := f.makeBooking(time.Now().Add(25*time.Minute), 60)

	cron := NewAssignerCron(f.asg, nil)
	assigned, cancelled, err := cron.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if assigned < 1 {
		t.Fatalf("expected >=1 assigned, got assigned=%d cancelled=%d", assigned, cancelled)
	}

	var helperID, status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COALESCE(helper_id::text,''), status FROM bookings WHERE id = $1::uuid`, bk,
	).Scan(&helperID, &status); err != nil {
		t.Fatal(err)
	}
	if helperID != pro || status != "accepted" {
		t.Fatalf("booking helper=%s status=%s, want %s/accepted", helperID, status, pro)
	}
}

// TestAssignerCron_NoProPastSlotCancelsAndRefunds: a paid booking past its slot
// with zero eligible pros is terminally cancelled (no_pros_found) and a refund
// row is recorded.
func TestAssignerCron_NoProPastSlotCancelsAndRefunds(t *testing.T) {
	f := newAsgFixture(t)
	// No pros at all → ErrNoEligiblePro. Slot already passed → terminal path.
	const amt = 50000
	bk := f.makePaidBookingAt(time.Now().Add(-1*time.Minute), 60, amt)
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM pending_refunds WHERE booking_id = $1::uuid`, bk)
	})

	walletRepo := wallet.NewRepository(f.pool)
	cron := NewAssignerCron(f.asg, walletRepo)
	_, cancelled, err := cron.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if cancelled < 1 {
		t.Fatalf("expected >=1 cancelled, got %d", cancelled)
	}

	var status, cancelledBy string
	var inviteExhausted *time.Time
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, COALESCE(cancelled_by,''), invite_exhausted_at FROM bookings WHERE id = $1::uuid`, bk,
	).Scan(&status, &cancelledBy, &inviteExhausted); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || cancelledBy != "no_pros_found" {
		t.Fatalf("booking status=%s cancelled_by=%s, want cancelled/no_pros_found", status, cancelledBy)
	}
	if inviteExhausted == nil {
		t.Fatalf("invite_exhausted_at must be stamped on terminal cancel")
	}

	// Cashfree-paid → a pending_refunds row for the net amount.
	var refundN int
	var refundCents int64
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COUNT(*), COALESCE(MAX(amount_cents),0) FROM pending_refunds WHERE booking_id = $1::uuid AND status='pending'`, bk,
	).Scan(&refundN, &refundCents); err != nil {
		t.Fatal(err)
	}
	if refundN != 1 {
		t.Fatalf("pending_refunds rows = %d, want 1", refundN)
	}
	if refundCents != amt {
		t.Fatalf("refund amount_cents = %d, want %d", refundCents, amt)
	}
}

// TestAssignerCron_NoProBeforeSlotStaysPending: a paid booking that is due but
// has no pro AND is still before its slot start is left pending (retried next
// tick), not cancelled.
func TestAssignerCron_NoProBeforeSlotStaysPending(t *testing.T) {
	f := newAsgFixture(t)
	// Due (within lead) but slot is still 25 min out and there are no pros.
	bk := f.makePaidBookingAt(time.Now().Add(25*time.Minute), 60, 50000)
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM pending_refunds WHERE booking_id = $1::uuid`, bk)
	})

	cron := NewAssignerCron(f.asg, wallet.NewRepository(f.pool))
	_, cancelled, err := cron.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if cancelled != 0 {
		t.Fatalf("before-slot no-pro must not cancel, got cancelled=%d", cancelled)
	}

	var status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM bookings WHERE id = $1::uuid`, bk,
	).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("before-slot no-pro booking status=%s, want pending", status)
	}
}
