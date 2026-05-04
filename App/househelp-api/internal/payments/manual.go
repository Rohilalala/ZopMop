package payments

import "context"

// ManualGateway is the no-op fallback. Every approve produces a manual-refund
// marker that ops handles offline (NEFT, support reach-out, etc).
type ManualGateway struct{}

// Name returns the string "manual" for log/audit identification.
func (m *ManualGateway) Name() string { return "manual" }

// Refund always succeeds with Manual=true; the caller is expected to mark the
// pending_refunds row as processed_manual and surface an amber badge in the UI.
func (m *ManualGateway) Refund(ctx context.Context, paymentID string, amountCents int64, method PaymentMethod) (*RefundResult, error) {
	return &RefundResult{Manual: true}, nil
}
