package payments

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Ledger writes and updates rows in the payments charge table. Distinct from
// the Gateway abstraction in this package: Gateway issues outbound calls,
// Ledger is the local source of truth for what we *think* the gateway holds.
type Ledger struct{ db *pgxpool.Pool }

// NewLedger constructs a Ledger backed by the supplied write pool.
func NewLedger(db *pgxpool.Pool) *Ledger { return &Ledger{db: db} }

// Payment is the persisted shape of a payments row.
type Payment struct {
	ID            string
	BookingID     string
	UserID        string
	AmountPaise   int64
	Currency      string
	Gateway       string
	GatewayRef    *string
	GatewayStatus string
	Reconciled    bool
}

// CreatePayment inserts a pending payment row. bookingID is now optional
// (nil = wallet topup, see migration 068); userID is always required.
// gatewayRef is also optional at this point — the gateway issues it later
// for non-COD methods. Returns the new payment id.
func (l *Ledger) CreatePayment(ctx context.Context, bookingID *string, userID string, amountPaise int64, gateway string, gatewayRef *string) (string, error) {
	if l == nil || l.db == nil {
		return "", fmt.Errorf("ledger not configured")
	}
	var id string
	err := l.db.QueryRow(ctx, `
		INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_ref)
		VALUES (
			CASE WHEN $1::text IS NULL OR $1::text = '' THEN NULL ELSE $1::uuid END,
			$2::uuid, $3, $4, $5
		)
		RETURNING id::text
	`, ptrOrEmpty(bookingID), userID, amountPaise, gateway, gatewayRef).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create payment: %w", err)
	}
	return id, nil
}

// UpdateStatusByGatewayRef flips the gateway_status of the row whose
// gateway_ref matches. Idempotent — only writes when current status differs
// from target. Sets webhook_received_at to receivedAt on the same write.
//
// Status MUST be one of pending|success|failed|refunded (the CHECK
// constraint in 056_payments.sql is the source of truth). Anything else is
// rejected client-side to surface logic bugs early.
func (l *Ledger) UpdateStatusByGatewayRef(ctx context.Context, ref, status string, receivedAt time.Time) error {
	if l == nil || l.db == nil {
		return fmt.Errorf("ledger not configured")
	}
	if err := validateGatewayStatus(ref, status); err != nil {
		return err
	}
	_, err := l.db.Exec(ctx, updateStatusByGatewayRefSQL, ref, status, receivedAt)
	if err != nil {
		return fmt.Errorf("update status by ref: %w", err)
	}
	return nil
}

// UpdateStatusByGatewayRefTx is the tx-bound variant. Same semantics as
// UpdateStatusByGatewayRef but every write goes through the supplied tx so
// the caller can compose it with other writes (e.g. event_outbox INSERT)
// inside a single all-or-nothing transaction.
func (l *Ledger) UpdateStatusByGatewayRefTx(ctx context.Context, tx pgx.Tx, ref, status string, receivedAt time.Time) error {
	if tx == nil {
		return fmt.Errorf("nil tx")
	}
	if err := validateGatewayStatus(ref, status); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, updateStatusByGatewayRefSQL, ref, status, receivedAt); err != nil {
		return fmt.Errorf("update status by ref (tx): %w", err)
	}
	return nil
}

const updateStatusByGatewayRefSQL = `
	UPDATE payments
	SET gateway_status = $2,
	    webhook_received_at = COALESCE(webhook_received_at, $3)
	WHERE gateway_ref = $1
	  AND gateway_status <> $2
`

func validateGatewayStatus(ref, status string) error {
	switch status {
	case "pending", "success", "failed", "refunded":
	default:
		return fmt.Errorf("invalid gateway_status %q", status)
	}
	if ref == "" {
		return fmt.Errorf("empty gateway_ref")
	}
	return nil
}

// ptrOrEmpty returns the pointed-to string or "" so the SQL `CASE WHEN
// $1::text IS NULL OR $1::text = ''` branch can route to NULL via either
// path — saves callers having to construct a sql.NullString.
func ptrOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// IsReconciled reports whether the row with the given gateway_ref has
// reconciled=true. Used by the simulation harness to verify
// 100%-reconciliation after a webhook stream completes.
func (l *Ledger) IsReconciled(ctx context.Context, gatewayRef string) (bool, error) {
	if l == nil || l.db == nil {
		return false, fmt.Errorf("ledger not configured")
	}
	var ok bool
	err := l.db.QueryRow(ctx,
		`SELECT reconciled FROM payments WHERE gateway_ref = $1`,
		gatewayRef,
	).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("is reconciled: %w", err)
	}
	return ok, nil
}

// UnreconciledCount returns the number of payments rows that are still
// flagged unreconciled. Sim harness uses this to assert 100% recon.
func (l *Ledger) UnreconciledCount(ctx context.Context) (int, error) {
	if l == nil || l.db == nil {
		return 0, fmt.Errorf("ledger not configured")
	}
	var n int
	err := l.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM payments WHERE reconciled = FALSE`,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("unreconciled count: %w", err)
	}
	return n, nil
}

// MarkReconciled flips reconciled=true for the row whose gateway_ref matches.
// Idempotent: a second call on the same ref is a no-op (returns nil).
func (l *Ledger) MarkReconciled(ctx context.Context, gatewayRef string) error {
	if l == nil || l.db == nil {
		return fmt.Errorf("ledger not configured")
	}
	_, err := l.db.Exec(ctx, `
		UPDATE payments
		SET reconciled = TRUE,
		    gateway_status = CASE WHEN gateway_status = 'pending' THEN 'success' ELSE gateway_status END,
		    webhook_received_at = COALESCE(webhook_received_at, now())
		WHERE gateway_ref = $1
	`, gatewayRef)
	if err != nil {
		return fmt.Errorf("mark reconciled: %w", err)
	}
	return nil
}
