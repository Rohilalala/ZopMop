package booking

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PR#7 hostile-review FIX 2 regression coverage: audit-or-bust contact
// reveal. White-box (package booking) so we can build a Service with
// only the db dependency RevealCustomerContact actually uses.
func crDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://househelp:localdev123@localhost:5432/househelp_db"
}

func revealCount(t *testing.T, p *pgxpool.Pool, bookingID string) int {
	t.Helper()
	var n int
	if err := p.QueryRow(context.Background(), `SELECT count(*) FROM pro_contact_reveals WHERE booking_id=$1::uuid`, bookingID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func setupReveal(t *testing.T) (*Service, *pgxpool.Pool, string, string, string) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, crDSN())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("no DB: %v", err)
	}
	var customerID, proUserID, bookingID string
	ph1 := "9" + uuid.NewString()[:9]
	ph2 := "8" + uuid.NewString()[:9]
	if err := pool.QueryRow(ctx, `INSERT INTO users (phone, role, name) VALUES ($1,'customer','Test Cust') RETURNING id::text`, ph1).Scan(&customerID); err != nil {
		t.Fatalf("ins customer: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (phone, role) VALUES ($1,'pro') RETURNING id::text`, ph2).Scan(&proUserID); err != nil {
		t.Fatalf("ins pro user: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO helpers (id) VALUES ($1::uuid)`, proUserID); err != nil {
		t.Fatalf("ins helper: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO bookings (customer_id, helper_id, address, lat, lng, amount_paise, status) VALUES ($1::uuid,$2::uuid,'addr',12.9,77.6,10000,'accepted') RETURNING id::text`, customerID, proUserID).Scan(&bookingID); err != nil {
		t.Fatalf("ins booking: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM pro_contact_reveals WHERE booking_id=$1::uuid`, bookingID)
		pool.Exec(c, `DELETE FROM bookings WHERE id=$1::uuid`, bookingID)
		pool.Exec(c, `DELETE FROM helpers WHERE id=$1::uuid`, proUserID)
		pool.Exec(c, `DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)`, customerID, proUserID)
		pool.Close()
	})
	return &Service{db: pool}, pool, proUserID, bookingID, customerID
}

func TestContactReveal_S6_NormalPath(t *testing.T) {
	svc, pool, proID, bookingID, _ := setupReveal(t)
	resp, err := svc.RevealCustomerContact(context.Background(), bookingID, proID, "smoke-agent")
	if err != nil {
		t.Fatalf("S6 expected nil, got %v", err)
	}
	if resp == nil || resp.CustomerPhone == "" {
		t.Fatalf("S6 expected phone in response, got %+v", resp)
	}
	if n := revealCount(t, pool, bookingID); n != 1 {
		t.Fatalf("S6 expected exactly 1 audit row, got %d", n)
	}
}

func TestContactReveal_S7_AuditFailureRollsBackNoOrphan(t *testing.T) {
	svc, pool, proID, bookingID, _ := setupReveal(t)
	// Force ONLY the audit INSERT to fail (guard read on bookings/users
	// must still succeed) by adding a CHECK(false) to pro_contact_reveals.
	// CHECK constraints are enforced on INSERT even when added NOT VALID.
	if _, err := pool.Exec(context.Background(),
		`ALTER TABLE pro_contact_reveals ADD CONSTRAINT tmp_pr7_s7_fail CHECK (false) NOT VALID`); err != nil {
		t.Fatalf("S7 setup constraint: %v", err)
	}
	defer pool.Exec(context.Background(), `ALTER TABLE pro_contact_reveals DROP CONSTRAINT IF EXISTS tmp_pr7_s7_fail`)

	resp, err := svc.RevealCustomerContact(context.Background(), bookingID, proID, "smoke-agent")
	if !errors.Is(err, ErrContactAuditFailed) {
		t.Fatalf("S7 expected ErrContactAuditFailed, got err=%v resp=%+v", err, resp)
	}
	if resp != nil {
		t.Fatalf("S7 expected NO PII in response, got %+v", resp)
	}
	if n := revealCount(t, pool, bookingID); n != 0 {
		t.Fatalf("S7 expected 0 orphan audit rows after rollback, got %d", n)
	}
}
