package booking

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// RecordNoProRefund routes a refund for a booking that was cancelled because no
// pro could be found, inside the caller's transaction. It is a thin wrapper over
// wallet.RecordBookingRefundTx — the shared rail lives in the wallet package (a
// leaf with no internal imports) so the matching assigner can call it too
// without an import cycle (booking already imports matching). This wrapper keeps
// the booking-package call site (pending-action sweeper) on a booking-named
// helper.
//
// Money only moves when the booking was actually paid and the net amount is
// positive; see wallet.RecordBookingRefundTx for the per-method rails.
func RecordNoProRefund(
	ctx context.Context,
	tx pgx.Tx,
	walletRepo *wallet.Repository,
	customerID, bookingID string,
	paymentMethod, paymentID, paymentStatus *string,
	refundAmountPaise int64,
	note string,
) error {
	return wallet.RecordBookingRefundTx(ctx, tx, walletRepo, customerID, bookingID,
		paymentMethod, paymentID, paymentStatus, refundAmountPaise, note)
}
