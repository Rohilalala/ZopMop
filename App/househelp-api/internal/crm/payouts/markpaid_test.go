package payouts

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

func openTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed payouts tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// TestMarkPaid_ActorAndAtomicAudit proves the legacy-payout fix: marking a
// payout paid (1) records the acting admin on the row (paid_by_admin_id), and
// (2) writes the audit row in the SAME transaction as the status change, so a
// money state change cannot land without its audit trail.
func TestMarkPaid_ActorAndAtomicAudit(t *testing.T) {
	pool := openTestDB(t)
	ctx := context.Background()
	repo := NewRepository(pool, pool)
	recorder := audit.NewRecorder(pool)

	// Fixtures: a worker (FK) and an admin (paid_by FK).
	workerID := uuid.NewString()
	adminID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'pro')`,
		workerID, "9"+uuid.NewString()[:9])
	if err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO crm_admins (id, email, password_hash, display_name, role, is_active)
		VALUES ($1::uuid, $2, '$2a$10$dummy', 'Payout Tester', 'admin', TRUE)`,
		adminID, "payout-"+adminID[:8]+"@zopmop.local")
	if err != nil {
		t.Fatalf("insert admin: %v", err)
	}

	payoutID, err := repo.Create(ctx, CreateRequest{
		WorkerID: workerID, PeriodStart: "2026-01-01", PeriodEnd: "2026-01-15", AmountCents: 50000,
	})
	if err != nil {
		t.Fatalf("create payout: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM crm_audit_log WHERE admin_id=$1::uuid`, adminID)
		_, _ = pool.Exec(ctx, `DELETE FROM crm_payouts WHERE id=$1::uuid`, payoutID)
		_, _ = pool.Exec(ctx, `DELETE FROM crm_admins WHERE id=$1::uuid`, adminID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1::uuid`, workerID)
	})

	entry := audit.Entry{AdminID: adminID, Action: "payout.paid", Module: "payouts", TargetType: "payout", TargetID: payoutID}
	if err := repo.MarkPaid(ctx, payoutID, "UTR-TEST-123", adminID, recorder, entry); err != nil {
		t.Fatalf("MarkPaid: %v", err)
	}

	// Row records status + actor.
	var status string
	var paidBy *string
	if err := pool.QueryRow(ctx, `SELECT status, paid_by_admin_id::text FROM crm_payouts WHERE id=$1::uuid`, payoutID).Scan(&status, &paidBy); err != nil {
		t.Fatalf("read payout: %v", err)
	}
	if status != "paid" {
		t.Fatalf("status = %q, want paid", status)
	}
	if paidBy == nil || *paidBy != adminID {
		t.Fatalf("paid_by_admin_id = %v, want %s", paidBy, adminID)
	}

	// Audit row written atomically with the status change.
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM crm_audit_log WHERE action='payout.paid' AND target_id=$1 AND admin_id=$2::uuid`, payoutID, adminID).Scan(&auditCount); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("audit rows = %d, want exactly 1 (atomic with the paid status)", auditCount)
	}

	// Marking again must be rejected (already paid) — guards double-pay.
	if err := repo.MarkPaid(ctx, payoutID, "UTR-TEST-456", adminID, recorder, entry); err == nil {
		t.Fatal("second MarkPaid on a paid payout should error (ErrNotActionable)")
	}
}
