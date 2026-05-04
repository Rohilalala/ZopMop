package payments

import (
	"context"
	"fmt"

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

// CreatePayment inserts a pending payment row for a booking. gatewayRef is
// optional at this point — the gateway issues it later for non-COD methods.
// Returns the new payment id.
func (l *Ledger) CreatePayment(ctx context.Context, bookingID, userID string, amountPaise int64, gateway string, gatewayRef *string) (string, error) {
	if l == nil || l.db == nil {
		return "", fmt.Errorf("ledger not configured")
	}
	var id string
	err := l.db.QueryRow(ctx, `
		INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_ref)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text
	`, bookingID, userID, amountPaise, gateway, gatewayRef).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create payment: %w", err)
	}
	return id, nil
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
