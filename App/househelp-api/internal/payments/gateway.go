// Package payments provides a pluggable abstraction over payment gateways
// for refund processing. The CRM refunds module calls Gateway.Refund without
// caring whether the active implementation is the manual fallback or a real
// gateway like Cashfree.
package payments

import (
	"context"
	"errors"
)

// PaymentMethod is the payment instrument used for the original charge.
type PaymentMethod string

const (
	MethodCOD        PaymentMethod = "cod"
	MethodUPI        PaymentMethod = "upi"
	MethodCard       PaymentMethod = "card"
	MethodWallet     PaymentMethod = "wallet"
	MethodNetbanking PaymentMethod = "netbanking"
)

// RefundResult is the outcome of a Refund call.
type RefundResult struct {
	GatewayRefundID string // gateway's own reference (e.g. rfnd_xxx)
	StatusCode      int    // gateway HTTP status, 0 if N/A
	Manual          bool   // true if this was a manual (no gateway) refund
}

// ErrGatewayUnconfigured is returned when no real gateway is wired up and the
// caller asked for an automatic refund.
var ErrGatewayUnconfigured = errors.New("payment gateway is not configured")

// ErrUnsupportedMethod is returned when the payment method (e.g. COD) does not
// admit an automatic gateway refund. Caller should mark the row as
// processed_manual.
var ErrUnsupportedMethod = errors.New("payment method does not support automatic refund")

// Gateway is the abstraction every payment integration implements.
type Gateway interface {
	// Refund issues a refund against a previously captured payment.
	// amountCents == originalAmount means a full refund; smaller is partial.
	// For COD payments, return ErrUnsupportedMethod — caller will mark as
	// processed_manual.
	//
	// idempotencyKey is the merchant-side dedup token: the same key
	// resubmitted to the gateway must return the same refund record. Pass
	// the refund row's UUID. CashfreeGateway uses this as the body's
	// refund_id (which is Cashfree's natural idempotency key per their
	// v2025-01-01 contract); ManualGateway ignores it. Empty key disables
	// gateway-side idempotency — only safe for the manual fallback path.
	Refund(ctx context.Context, paymentID string, amountCents int64, method PaymentMethod, idempotencyKey string) (*RefundResult, error)

	// Name identifies the active gateway in logs/audit.
	Name() string
}
