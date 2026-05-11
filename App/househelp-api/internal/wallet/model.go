// Package wallet implements Zopmop's closed-loop wallet. Funds are spendable
// only on Zopmop bookings (kind='spend' enforced at the service layer to
// require booking_id); no P2P transfers, no withdrawal to bank, no
// third-party payments. The schema lives in migrations/067_wallets.sql.
//
// Concurrency: every mutation goes through Repository.ApplyTransactionTx,
// which acquires a row-level FOR UPDATE lock on the wallets row before
// computing the new balance. This serialises concurrent debit/credit
// operations against the same wallet so two simultaneous spends cannot
// both pass the balance check.
package wallet

import (
	"errors"
	"time"
)

// Kind enumerates the audit reason on a wallet_transactions row. The same
// set is enforced at the database via a CHECK constraint and at the service
// layer for additional invariants (booking_id required for spends, etc).
type Kind string

const (
	KindTopup          Kind = "topup"            // credit, requires payment_id
	KindSpend          Kind = "spend"            // debit, requires booking_id
	KindRefundCredit   Kind = "refund_credit"    // credit, may carry booking_id or payment_id
	KindAdjustment     Kind = "adjustment"       // credit, admin-only — no /wallet/* route exposes it
	KindReversal       Kind = "reversal"         // debit, may carry booking_id
	KindReferralCredit Kind = "referral_credit"  // both referee Rs 100 + referrer Rs 200
)

// IsCredit reports whether a kind represents a credit (positive balance
// delta) vs a debit. Used by the service layer to flip the sign of an
// (always positive) caller-supplied amount.
func (k Kind) IsCredit() bool {
	switch k {
	case KindTopup, KindRefundCredit, KindAdjustment, KindReferralCredit:
		return true
	default:
		return false
	}
}

// WalletTx is the input for Repository.ApplyTransactionTx. AmountPaise is
// signed (positive = credit, negative = debit) — the service layer flips
// the sign based on Kind so callers always pass a positive number.
type WalletTx struct {
	UserID       string
	AmountPaise  int64 // signed
	Kind         Kind
	BookingID    *string
	PaymentID    *string
	Note         string
}

// WalletTransaction is the persisted shape of a wallet_transactions row.
type WalletTransaction struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	AmountPaise  int64     `json:"amount_paise"` // signed: + credit, - debit
	BalanceAfter int64     `json:"balance_after"`
	Kind         Kind      `json:"kind"`
	BookingID    *string   `json:"booking_id,omitempty"`
	PaymentID    *string   `json:"payment_id,omitempty"`
	Note         string    `json:"note,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// ApplyResult is the post-write snapshot returned by ApplyTransactionTx.
// Lets the service layer emit outbox events with the canonical
// balance_after value without re-reading.
type ApplyResult struct {
	TransactionID string
	BalanceAfter  int64
}

// Errors returned by the wallet repository / service. Handler maps these
// to HTTP codes:
//
//   ErrInsufficientBalance → 402 Payment Required, code "insufficient_wallet_balance"
//   ErrInvalidKind / ErrInvalidAmount / ErrMissingRef → 400 Bad Request
var (
	ErrInsufficientBalance = errors.New("wallet: insufficient balance")
	ErrInvalidKind         = errors.New("wallet: invalid kind")
	ErrInvalidAmount       = errors.New("wallet: amount must be positive")
	ErrMissingRef          = errors.New("wallet: required reference id missing")
	ErrNotConfigured       = errors.New("wallet: service not configured")
)
