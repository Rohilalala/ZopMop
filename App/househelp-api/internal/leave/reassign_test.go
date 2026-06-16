package leave

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Task 6 (spec §7): declaring leave must return the on-leave pro's bookings to
// the assigner — 'pending', helper cleared, matched_at wiped, excluded_pro_id =
// the on-leave pro — rather than synchronously force-picking a replacement.
// The next dispatch tick places a free pro (who then gets booking_assigned).

func leaveDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://househelp:localdev123@localhost:5432/househelp_db"
}

func TestReassignAffected_LeaveReturnsBookingToAssignerExcluded(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, leaveDSN())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("no DB: %v", err)
	}
	t.Cleanup(pool.Close)

	// Pro + customer.
	var proID, customerID string
	ph1 := "8" + uuid.NewString()[:9]
	ph2 := "9" + uuid.NewString()[:9]
	if err := pool.QueryRow(ctx, `INSERT INTO users (phone, role) VALUES ($1,'pro') RETURNING id::text`, ph1).Scan(&proID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (phone, role) VALUES ($1,'customer') RETURNING id::text`, ph2).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO helpers (id, approval_status) VALUES ($1::uuid, 'approved')`, proID); err != nil {
		t.Fatal(err)
	}

	// Accepted booking for the pro tomorrow (noon IST so the ::date cast lands on
	// the leave date regardless of the DB session zone). A time_slot is referenced
	// because the existing ListProBookingsOnDate projection scans time_slot_id into
	// a non-nullable string.
	tomorrow := startOfDayIST(time.Now().AddDate(0, 0, 1))
	// Second-precision offset within the day, reused via ON CONFLICT, dodges the
	// time_slots (slot_date, start_time) unique constraint across suite re-runs.
	slotStart := tomorrow.Add(6*time.Hour + time.Duration(time.Now().UnixNano()%(8*3600))*time.Second)
	at := slotStart
	var slotID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO time_slots (slot_date, start_time, end_time, max_bookings, current_bookings, is_active)
		VALUES ($1::date, $2::time, $3::time, 5, 0, true)
		ON CONFLICT (slot_date, start_time) DO UPDATE SET is_active = true
		RETURNING id::text`,
		slotStart.Format("2006-01-02"), slotStart.Format("15:04:05"), slotStart.Add(time.Hour).Format("15:04:05")).Scan(&slotID); err != nil {
		t.Fatal(err)
	}
	// A service_category is referenced for the same reason as time_slot_id —
	// ListProBookingsOnDate scans service_category_id into a non-nullable string.
	var svcCatID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM service_categories LIMIT 1`).Scan(&svcCatID); err != nil {
		t.Skipf("no service_categories seeded: %v", err)
	}
	var bk string
	if err := pool.QueryRow(ctx, `
		INSERT INTO bookings
		  (customer_id, helper_id, status, address, lat, lng, amount_paise,
		   total_duration_minutes, scheduled_time, time_slot_id, service_category_id)
		VALUES ($1::uuid, $2::uuid, 'accepted', 'Addr', 28.45, 77.05, 10000, 60, $3, $4::uuid, $5::uuid)
		RETURNING id::text`, customerID, proID, at, slotID, svcCatID).Scan(&bk); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM bookings WHERE id=$1::uuid`, bk)
		pool.Exec(c, `DELETE FROM time_slots WHERE id=$1::uuid`, slotID)
		pool.Exec(c, `DELETE FROM pro_leaves WHERE pro_id=$1::uuid`, proID)
		pool.Exec(c, `DELETE FROM helpers WHERE id=$1::uuid`, proID)
		pool.Exec(c, `DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)`, proID, customerID)
	})

	// nil notifiers — both surfaces are nil-safe in the service.
	svc := NewService(NewRepository(pool), nil, nil)
	if _, err := svc.AdminGrantLeave(ctx, proID, tomorrow, "test"); err != nil {
		t.Fatalf("AdminGrantLeave: %v", err)
	}

	var status string
	var helperID, excluded *string
	var matchedAt *time.Time
	if err := pool.QueryRow(ctx,
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
		t.Fatalf("matched_at = %v, want NULL", *matchedAt)
	}
	if excluded == nil || *excluded != proID {
		t.Fatalf("excluded_pro_id = %v, want on-leave pro %s", excluded, proID)
	}
}
