package wallet

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository is the persistence surface for wallets. It owns no business
// rules — closed-loop validation lives in Service. The repository's only
// invariant is balance >= 0 (also enforced by a CHECK constraint on the
// table for defence in depth).
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// DB returns the underlying pool. Used by the service to wrap repository
// calls in its own transaction (e.g. when composing a wallet write with
// outbox event emission).
func (r *Repository) DB() *pgxpool.Pool { return r.db }

// GetBalance returns the current balance for a user. Returns 0 when no
// wallet row exists yet (lazy-creation happens on first mutation, not on
// first read).
func (r *Repository) GetBalance(ctx context.Context, userID string) (int64, error) {
	var balance int64
	err := r.db.QueryRow(ctx,
		`SELECT balance_paise FROM wallets WHERE user_id = $1::uuid`,
		userID,
	).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get balance: %w", err)
	}
	return balance, nil
}

// History returns wallet_transactions for a user in reverse-chronological
// order. Cursor is (created_at, id) — caller passes the values from the
// last row of the previous page. limit is clamped to [1, 100].
func (r *Repository) History(ctx context.Context, userID string, limit int, before *time.Time, beforeID string) ([]WalletTransaction, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	args := []any{userID, limit}
	cursorClause := ""
	if before != nil && beforeID != "" {
		args = append(args, *before, beforeID)
		cursorClause = " AND (created_at, id) < ($3, $4::uuid) "
	}

	rows, err := r.db.Query(ctx, `
		SELECT id::text, user_id::text, amount_paise, balance_after, kind,
		       booking_id::text, payment_id::text, COALESCE(note, ''), created_at
		FROM wallet_transactions
		WHERE user_id = $1::uuid `+cursorClause+`
		ORDER BY created_at DESC, id DESC
		LIMIT $2
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("history query: %w", err)
	}
	defer rows.Close()

	out := make([]WalletTransaction, 0)
	for rows.Next() {
		var t WalletTransaction
		var bookingID, paymentID *string
		if err := rows.Scan(
			&t.ID, &t.UserID, &t.AmountPaise, &t.BalanceAfter, &t.Kind,
			&bookingID, &paymentID, &t.Note, &t.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("history scan: %w", err)
		}
		t.BookingID = bookingID
		t.PaymentID = paymentID
		out = append(out, t)
	}
	return out, rows.Err()
}

// ApplyTransactionTx applies a signed delta to the user's wallet inside
// the supplied tx and inserts a wallet_transactions row. The contract:
//
//   1. Lazy-create the wallets row if missing (first-ever interaction).
//   2. SELECT balance_paise … FOR UPDATE — row-level lock prevents two
//      concurrent ApplyTransactionTx calls from racing on the same wallet.
//   3. Compute new_balance = current + tx.AmountPaise (signed).
//   4. If new_balance < 0 → ErrInsufficientBalance (no writes, tx rolls
//      back with the caller's other writes).
//   5. UPDATE wallets SET balance_paise = new_balance, updated_at = NOW().
//   6. INSERT wallet_transactions with balance_after = new_balance.
//
// Returns the new transaction id and balance_after for the caller to
// embed in event_outbox payloads.
func (r *Repository) ApplyTransactionTx(ctx context.Context, tx pgx.Tx, in WalletTx) (*ApplyResult, error) {
	if tx == nil {
		return nil, fmt.Errorf("nil tx")
	}
	if in.UserID == "" {
		return nil, fmt.Errorf("empty user_id")
	}

	// Lazy create. ON CONFLICT DO NOTHING is a no-op when the row exists;
	// the subsequent SELECT FOR UPDATE then locks whichever row is now
	// authoritative. The INSERT itself takes a row-exclusive lock so two
	// concurrent first-ever interactions don't both try to insert.
	if _, err := tx.Exec(ctx, `
		INSERT INTO wallets (user_id, balance_paise)
		VALUES ($1::uuid, 0)
		ON CONFLICT (user_id) DO NOTHING
	`, in.UserID); err != nil {
		return nil, fmt.Errorf("upsert wallet row: %w", err)
	}

	var current int64
	if err := tx.QueryRow(ctx,
		`SELECT balance_paise FROM wallets WHERE user_id = $1::uuid FOR UPDATE`,
		in.UserID,
	).Scan(&current); err != nil {
		return nil, fmt.Errorf("lock wallet row: %w", err)
	}

	newBalance := current + in.AmountPaise
	if newBalance < 0 {
		return nil, ErrInsufficientBalance
	}

	if _, err := tx.Exec(ctx, `
		UPDATE wallets
		SET balance_paise = $2, updated_at = NOW()
		WHERE user_id = $1::uuid
	`, in.UserID, newBalance); err != nil {
		return nil, fmt.Errorf("update wallet balance: %w", err)
	}

	var txID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO wallet_transactions
		  (user_id, amount_paise, balance_after, kind, booking_id, payment_id, note)
		VALUES (
		  $1::uuid, $2, $3, $4,
		  CASE WHEN $5::text = '' THEN NULL ELSE $5::uuid END,
		  CASE WHEN $6::text = '' THEN NULL ELSE $6::uuid END,
		  NULLIF($7, '')
		)
		RETURNING id::text
	`,
		in.UserID, in.AmountPaise, newBalance, string(in.Kind),
		ptrOrEmpty(in.BookingID), ptrOrEmpty(in.PaymentID), in.Note,
	).Scan(&txID); err != nil {
		return nil, fmt.Errorf("insert wallet_transactions: %w", err)
	}

	return &ApplyResult{TransactionID: txID, BalanceAfter: newBalance}, nil
}

func ptrOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
