package wallet

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// RecordBookingRefundTx routes a booking refund onto the correct rail inside the
// caller's transaction. It is the single shared home of the wallet vs
// pending_refunds logic that used to live inline in the booking
// pending-action sweeper — lifted to the wallet package (a leaf with no other
// internal imports) so both the booking package and the matching assigner can
// reuse it without an import cycle (booking already imports matching).
//
// Money only moves when the booking was actually paid (paymentStatus='paid')
// and the net refund amount is positive:
//   - wallet payments   → KindRefundCredit back to the customer's wallet.
//   - cashfree payments → a 'pending' pending_refunds row (the refund worker
//     completes it out of band; ON CONFLICT keeps it idempotent per booking).
//   - cash / null / unknown method → no movement (nothing was collected).
//
// All writes go through tx so they commit atomically with the booking-status
// change the caller is making. refundAmountPaise is the net (amount − discount)
// the caller has already computed.
func RecordBookingRefundTx(
	ctx context.Context,
	tx pgx.Tx,
	repo *Repository,
	customerID, bookingID string,
	paymentMethod, paymentID, paymentStatus *string,
	refundAmountPaise int64,
	note string,
) error {
	paid := paymentStatus != nil && *paymentStatus == "paid"
	if !paid || refundAmountPaise <= 0 || paymentMethod == nil {
		return nil
	}

	switch *paymentMethod {
	case "wallet":
		if _, err := repo.ApplyTransactionTx(ctx, tx, WalletTx{
			UserID:      customerID,
			AmountPaise: refundAmountPaise,
			Kind:        KindRefundCredit,
			BookingID:   &bookingID,
			Note:        note,
		}); err != nil {
			return err
		}
	case "cashfree":
		if _, err := tx.Exec(ctx, `
			INSERT INTO pending_refunds
			  (user_id, amount_cents, source, source_ref,
			   booking_id, payment_method, payment_id, status)
			VALUES ($1::uuid, $2, 'booking_cancellation', $3::text,
			        $3::uuid, $4, $5, 'pending')
			ON CONFLICT (booking_id)
			  WHERE booking_id IS NOT NULL
			    AND status IN ('pending','approved','processed','processed_manual')
			DO NOTHING
		`, customerID, refundAmountPaise, bookingID, paymentMethod, paymentID); err != nil {
			return err
		}
	}
	// cash / null / unknown method: nothing collected, nothing to refund.
	return nil
}
