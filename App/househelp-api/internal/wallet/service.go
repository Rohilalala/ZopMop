package wallet

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Service is the public surface of the wallet module. It enforces the
// closed-loop invariants (kind enum, required reference ids, amount sign)
// before delegating persistence to Repository, and emits wallet.credited /
// wallet.debited events via the existing event_outbox.
//
// The Tx variants are the canonical entry points — they let callers
// compose wallet writes with other writes (booking row update, payment
// ledger update, outbox events) inside one all-or-nothing transaction.
// The non-Tx variants exist for handler routes that don't need composition.
type Service struct {
	repo *Repository
}

// NewService constructs a Service.
func NewService(repo *Repository) *Service { return &Service{repo: repo} }

// Repo exposes the underlying repository for read-only paths that don't
// need transactional composition (e.g. GetBalance / History on the
// /wallet handler).
func (s *Service) Repo() *Repository { return s.repo }

// ValidateCreditInputs is exposed for tests; production callers go through
// CreditTx which calls this internally before touching the database. Returns
// nil when the inputs satisfy the closed-loop invariants.
func ValidateCreditInputs(amountPaise int64, kind Kind, paymentID *string) error {
	if !kind.IsCredit() {
		return fmt.Errorf("%w: %s is not a credit kind", ErrInvalidKind, kind)
	}
	if amountPaise <= 0 {
		return ErrInvalidAmount
	}
	if kind == KindTopup && (paymentID == nil || *paymentID == "") {
		return fmt.Errorf("%w: kind=topup requires payment_id", ErrMissingRef)
	}
	return nil
}

// ValidateDebitInputs is the debit counterpart.
func ValidateDebitInputs(amountPaise int64, kind Kind, bookingID *string) error {
	if kind.IsCredit() {
		return fmt.Errorf("%w: %s is not a debit kind", ErrInvalidKind, kind)
	}
	if kind != KindSpend && kind != KindReversal {
		return fmt.Errorf("%w: %s", ErrInvalidKind, kind)
	}
	if amountPaise <= 0 {
		return ErrInvalidAmount
	}
	if kind == KindSpend && (bookingID == nil || *bookingID == "") {
		return fmt.Errorf("%w: kind=spend requires booking_id", ErrMissingRef)
	}
	return nil
}

// CreditTx applies a positive balance delta inside the supplied tx.
//
// kind must be in {topup, refund_credit, adjustment}. Other invariants:
//   - kind=topup MUST have non-nil paymentID
//   - kind=adjustment is admin-only — handlers don't expose it; callers
//     using it must come from an admin-side pathway
//   - amountPaise MUST be > 0 (sign is flipped internally based on kind)
func (s *Service) CreditTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise int64,
	kind Kind,
	paymentID, bookingID *string,
	note string,
) (*ApplyResult, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	if err := ValidateCreditInputs(amountPaise, kind, paymentID); err != nil {
		return nil, err
	}

	res, err := s.repo.ApplyTransactionTx(ctx, tx, WalletTx{
		UserID:      userID,
		AmountPaise: amountPaise,
		Kind:        kind,
		PaymentID:   paymentID,
		BookingID:   bookingID,
		Note:        note,
	})
	if err != nil {
		return nil, err
	}
	if err := emitWalletCreditedTx(ctx, tx, userID, amountPaise, res.BalanceAfter, kind, paymentID, bookingID, time.Now().UTC()); err != nil {
		return nil, fmt.Errorf("emit wallet.credited: %w", err)
	}
	return res, nil
}

// DebitTx applies a negative balance delta inside the supplied tx.
//
// kind must be in {spend, reversal}. Other invariants:
//   - kind=spend MUST have non-nil bookingID (closed-loop guarantee)
//   - amountPaise MUST be > 0 (service negates internally)
//
// Returns ErrInsufficientBalance when the wallet doesn't have enough —
// caller should map to 402 + code "insufficient_wallet_balance".
func (s *Service) DebitTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise int64,
	kind Kind,
	bookingID *string,
	note string,
) (*ApplyResult, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	if err := ValidateDebitInputs(amountPaise, kind, bookingID); err != nil {
		return nil, err
	}

	res, err := s.repo.ApplyTransactionTx(ctx, tx, WalletTx{
		UserID:      userID,
		AmountPaise: -amountPaise,
		Kind:        kind,
		BookingID:   bookingID,
		Note:        note,
	})
	if err != nil {
		return nil, err
	}
	if err := emitWalletDebitedTx(ctx, tx, userID, amountPaise, res.BalanceAfter, kind, bookingID, time.Now().UTC()); err != nil {
		return nil, fmt.Errorf("emit wallet.debited: %w", err)
	}
	return res, nil
}

// Credit is the non-Tx variant for handler routes that don't compose with
// other writes. Wraps CreditTx in its own transaction.
func (s *Service) Credit(
	ctx context.Context,
	userID string,
	amountPaise int64,
	kind Kind,
	paymentID, bookingID *string,
	note string,
) (*ApplyResult, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	var res *ApplyResult
	err := pgx.BeginFunc(ctx, s.repo.db, func(tx pgx.Tx) error {
		r, err := s.CreditTx(ctx, tx, userID, amountPaise, kind, paymentID, bookingID, note)
		if err != nil {
			return err
		}
		res = r
		return nil
	})
	return res, err
}

// CreditWithRef is Credit plus an idempotency Reference. A second call
// with the same reference returns ErrDuplicateTransaction (no second
// money movement) — used by the wallet-path refund so a /retry after a
// lost response can't credit the customer twice.
func (s *Service) CreditWithRef(
	ctx context.Context,
	userID string,
	amountPaise int64,
	kind Kind,
	paymentID, bookingID *string,
	note, reference string,
) (*ApplyResult, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	if err := ValidateCreditInputs(amountPaise, kind, paymentID); err != nil {
		return nil, err
	}
	var res *ApplyResult
	err := pgx.BeginFunc(ctx, s.repo.db, func(tx pgx.Tx) error {
		r, aerr := s.repo.ApplyTransactionTx(ctx, tx, WalletTx{
			UserID:      userID,
			AmountPaise: amountPaise,
			Kind:        kind,
			PaymentID:   paymentID,
			BookingID:   bookingID,
			Note:        note,
			Reference:   reference,
		})
		if aerr != nil {
			return aerr
		}
		if eerr := emitWalletCreditedTx(ctx, tx, userID, amountPaise, r.BalanceAfter, kind, paymentID, bookingID, time.Now().UTC()); eerr != nil {
			return fmt.Errorf("emit wallet.credited: %w", eerr)
		}
		res = r
		return nil
	})
	return res, err
}

// Debit is the non-Tx variant.
func (s *Service) Debit(
	ctx context.Context,
	userID string,
	amountPaise int64,
	kind Kind,
	bookingID *string,
	note string,
) (*ApplyResult, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	var res *ApplyResult
	err := pgx.BeginFunc(ctx, s.repo.db, func(tx pgx.Tx) error {
		r, err := s.DebitTx(ctx, tx, userID, amountPaise, kind, bookingID, note)
		if err != nil {
			return err
		}
		res = r
		return nil
	})
	return res, err
}

// GetBalance returns the user's current balance (0 if no wallet row yet).
func (s *Service) GetBalance(ctx context.Context, userID string) (int64, error) {
	if s == nil || s.repo == nil {
		return 0, ErrNotConfigured
	}
	return s.repo.GetBalance(ctx, userID)
}

// History returns paginated wallet_transactions in reverse-chronological
// order. Pass before=nil for the first page; for subsequent pages pass
// the created_at + id of the last row from the previous page.
func (s *Service) History(ctx context.Context, userID string, limit int, before *time.Time, beforeID string) ([]WalletTransaction, error) {
	if s == nil || s.repo == nil {
		return nil, ErrNotConfigured
	}
	return s.repo.History(ctx, userID, limit, before, beforeID)
}

// emitWalletCreditedTx writes a wallet.credited row to event_outbox.
func emitWalletCreditedTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise, balanceAfter int64,
	kind Kind,
	paymentID, bookingID *string,
	occurredAt time.Time,
) error {
	body := map[string]any{
		"user_id":       userID,
		"amount_paise":  amountPaise,
		"balance_after": balanceAfter,
		"kind":          string(kind),
		"occurred_at":   occurredAt.Format(time.RFC3339),
	}
	if paymentID != nil && *paymentID != "" {
		body["payment_id"] = *paymentID
	}
	if bookingID != nil && *bookingID != "" {
		body["booking_id"] = *bookingID
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (event_type, aggregate_id, payload)
		VALUES ($1, $2::uuid, $3::jsonb)
	`, "wallet.credited", userID, payload)
	return err
}

// emitWalletDebitedTx writes a wallet.debited row to event_outbox.
func emitWalletDebitedTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise, balanceAfter int64,
	kind Kind,
	bookingID *string,
	occurredAt time.Time,
) error {
	body := map[string]any{
		"user_id":       userID,
		"amount_paise":  amountPaise,
		"balance_after": balanceAfter,
		"kind":          string(kind),
		"occurred_at":   occurredAt.Format(time.RFC3339),
	}
	if bookingID != nil && *bookingID != "" {
		body["booking_id"] = *bookingID
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (event_type, aggregate_id, payload)
		VALUES ($1, $2::uuid, $3::jsonb)
	`, "wallet.debited", userID, payload)
	return err
}
