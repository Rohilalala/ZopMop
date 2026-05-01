package admin

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// PendingRefund represents a row from the pending_refunds table joined with the
// owning user's phone for display in the admin CRM.
type PendingRefund struct {
	ID          string     `json:"id"`
	UserID      string     `json:"user_id"`
	UserPhone   string     `json:"user_phone,omitempty"`
	AmountCents int64      `json:"amount_cents"`
	Source      string     `json:"source"`
	SourceRef   string     `json:"source_ref,omitempty"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	SettledAt   *time.Time `json:"settled_at,omitempty"`
}

// ListPendingRefunds returns a paginated list of refunds, filterable by status
// ("pending" or "settled"). Empty status returns all rows.
func (r *Repository) ListPendingRefunds(ctx context.Context, status string, page, limit int) ([]PendingRefund, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	baseQuery := `FROM pending_refunds pr LEFT JOIN users u ON u.id = pr.user_id WHERE 1=1`
	args := []interface{}{}
	argIdx := 1

	if status != "" {
		baseQuery += fmt.Sprintf(` AND pr.status = $%d`, argIdx)
		args = append(args, status)
		argIdx++
	}

	var totalCount int
	if err := r.db.QueryRow(queryCtx, `SELECT COUNT(*) `+baseQuery, args...).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count pending refunds: %w", err)
	}

	selectQuery := fmt.Sprintf(
		`SELECT pr.id, pr.user_id, COALESCE(u.phone, ''), pr.amount_cents,
		        pr.source, COALESCE(pr.source_ref, ''), pr.status,
		        pr.created_at, pr.settled_at
		 %s ORDER BY pr.created_at DESC LIMIT $%d OFFSET $%d`,
		baseQuery, argIdx, argIdx+1,
	)
	args = append(args, limit, offset)

	rows, err := r.db.Query(queryCtx, selectQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query pending refunds: %w", err)
	}
	defer rows.Close()

	var refunds []PendingRefund
	for rows.Next() {
		var pr PendingRefund
		if err := rows.Scan(&pr.ID, &pr.UserID, &pr.UserPhone, &pr.AmountCents,
			&pr.Source, &pr.SourceRef, &pr.Status, &pr.CreatedAt, &pr.SettledAt); err != nil {
			return nil, 0, fmt.Errorf("failed to scan pending refund: %w", err)
		}
		refunds = append(refunds, pr)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating pending refunds: %w", err)
	}

	return refunds, totalCount, nil
}

// SettlePendingRefund marks a pending refund as settled and stamps settled_at.
// Returns the updated row so callers can echo it back / log it.
func (r *Repository) SettlePendingRefund(ctx context.Context, id string) (*PendingRefund, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	pr := &PendingRefund{}
	err := r.db.QueryRow(queryCtx,
		`UPDATE pending_refunds
		 SET status = 'settled', settled_at = now()
		 WHERE id = $1 AND status = 'pending'
		 RETURNING id, user_id, amount_cents, source, COALESCE(source_ref, ''),
		           status, created_at, settled_at`,
		id,
	).Scan(&pr.ID, &pr.UserID, &pr.AmountCents, &pr.Source, &pr.SourceRef,
		&pr.Status, &pr.CreatedAt, &pr.SettledAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("refund not found or already settled")
		}
		return nil, fmt.Errorf("failed to settle pending refund: %w", err)
	}

	return pr, nil
}
