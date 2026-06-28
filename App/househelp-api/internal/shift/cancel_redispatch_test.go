package shift_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/shift"
)

// Task 6 (spec §7): a pro cancelling an assigned, still-future booking must NOT
// dead-end the booking — it returns to the assigner as 'pending' with the
// cancelling pro recorded in excluded_pro_id so the next dispatch tick skips
// them. Once the slot has passed there is nothing to re-dispatch, so the old
// terminal cancel path stays.

type cancelFixture struct {
	pool      *pgxpool.Pool
	svc       *shift.Service
	customer  string
	proUserID string
}

func newCancelFixture(t *testing.T) *cancelFixture {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("no DB: %v", err)
	}
	f := &cancelFixture{pool: pool, svc: shift.NewService(shift.NewRepository(pool))}
	ph1 := "9" + uuid.NewString()[:9]
	ph2 := "8" + uuid.NewString()[:9]
	mustScan(t, pool, &f.customer, `INSERT INTO users (phone, role) VALUES ($1,'customer') RETURNING id::text`, ph1)
	mustScan(t, pool, &f.proUserID, `INSERT INTO users (phone, role) VALUES ($1,'pro') RETURNING id::text`, ph2)
	mustExec(t, pool, `INSERT INTO helpers (id, approval_status) VALUES ($1::uuid, 'approved')`, f.proUserID)
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM booking_cancellations WHERE pro_id=$1::uuid`, f.proUserID)
		pool.Exec(c, `DELETE FROM bookings WHERE customer_id=$1::uuid`, f.customer)
		pool.Exec(c, `DELETE FROM helpers WHERE id=$1::uuid`, f.proUserID)
		pool.Exec(c, `DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)`, f.customer, f.proUserID)
		pool.Close()
	})
	return f
}

// makeAcceptedBooking inserts an 'accepted' booking owned by the fixture pro,
// scheduled at `at`. Returns the booking id.
func (f *cancelFixture) makeAcceptedBooking(t *testing.T, at time.Time) string {
	t.Helper()
	var id string
	mustScan(t, f.pool, &id, `
		INSERT INTO bookings
		  (customer_id, helper_id, status, address, lat, lng, amount_paise,
		   total_duration_minutes, scheduled_time)
		VALUES ($1::uuid, $2::uuid, 'accepted', 'Addr', 28.45, 77.05, 10000, 60, $3)
		RETURNING id::text`, f.customer, f.proUserID, at)
	return id
}

func TestCancelBooking_FutureSlot_ReturnsToAssignerExcluded(t *testing.T) {
	f := newCancelFixture(t)
	bk := f.makeAcceptedBooking(t, time.Now().Add(2*time.Hour))

	if _, err := f.svc.CancelBooking(context.Background(), f.proUserID, bk); err != nil {
		t.Fatalf("CancelBooking: %v", err)
	}

	var status string
	var helperID, excluded *string
	var matchedAt *time.Time
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, helper_id::text, excluded_pro_id::text, matched_at FROM bookings WHERE id=$1::uuid`, bk,
	).Scan(&status, &helperID, &excluded, &matchedAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("status = %s, want pending", status)
	}
	if helperID != nil {
		t.Fatalf("helper_id = %v, want NULL", *helperID)
	}
	if matchedAt != nil {
		t.Fatalf("matched_at = %v, want NULL (so ClaimDue re-picks it)", *matchedAt)
	}
	if excluded == nil || *excluded != f.proUserID {
		t.Fatalf("excluded_pro_id = %v, want %s", excluded, f.proUserID)
	}
}

func TestCancelBooking_PastSlot_StaysCancelled(t *testing.T) {
	f := newCancelFixture(t)
	bk := f.makeAcceptedBooking(t, time.Now().Add(-2*time.Hour)) // slot already passed

	if _, err := f.svc.CancelBooking(context.Background(), f.proUserID, bk); err != nil {
		t.Fatalf("CancelBooking: %v", err)
	}

	var status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM bookings WHERE id=$1::uuid`, bk).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("past-slot cancel status = %s, want cancelled (no re-dispatch)", status)
	}
}
