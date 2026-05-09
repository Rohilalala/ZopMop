package booking

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// pendingActionNotifier is the subset of *notification.Service used here.
type pendingActionNotifier interface {
	SendData(ctx context.Context, userID string, data map[string]string) error
}

// PendingActionSweeper cancels bookings stuck in 'pending_customer_action'
// for more than 30 minutes and routes any refund to the correct rail.
//
// Multi-instance safety: SELECT FOR UPDATE SKIP LOCKED ensures only one
// sweeper instance processes each booking.
type PendingActionSweeper struct {
	db         *pgxpool.Pool
	walletRepo *wallet.Repository
	notif      pendingActionNotifier
}

// NewPendingActionSweeper constructs a sweeper. Pass nil notif to skip FCM.
func NewPendingActionSweeper(db *pgxpool.Pool, walletRepo *wallet.Repository, notif pendingActionNotifier) *PendingActionSweeper {
	return &PendingActionSweeper{db: db, walletRepo: walletRepo, notif: notif}
}

// Start runs the sweep loop until ctx is cancelled.
func (s *PendingActionSweeper) Start(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	tick := func() {
		n, err := s.RunOnce(ctx)
		if err != nil {
			log.Warn().Err(err).Msg("[pending-action-sweep] error")
			return
		}
		if n > 0 {
			log.Info().Int("cancelled", n).Msg("[pending-action-sweep] sweep")
		}
	}

	tick() // immediate first run on startup
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("[pending-action-sweep] ctx cancelled — exiting")
			return
		case <-ticker.C:
			tick()
		}
	}
}

// RunOnce drains all eligible stuck bookings in a tight loop. Returns the
// count of bookings cancelled this pass.
func (s *PendingActionSweeper) RunOnce(ctx context.Context) (int, error) {
	n := 0
	for {
		if ctx.Err() != nil {
			return n, ctx.Err()
		}
		res, ok, err := s.claimAndCancel(ctx)
		if err != nil {
			return n, err
		}
		if !ok {
			return n, nil
		}
		if s.notif != nil {
			_ = s.notif.SendData(ctx, res.customerID, map[string]string{
				"type":       "BOOKING_AUTO_CANCELLED",
				"booking_id": res.bookingID,
				"title":      "Booking cancelled",
				"body":       "Your booking was automatically cancelled. Tap to rebook.",
			})
		}
		n++
	}
}

type sweepResult struct {
	bookingID  string
	customerID string
}

// claimAndCancel atomically claims and cancels one stuck booking. All writes
// (booking status, slot release, refund record / wallet credit) commit in a
// single transaction so failures are fully retryable.
func (s *PendingActionSweeper) claimAndCancel(ctx context.Context) (sweepResult, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return sweepResult{}, false, err
	}
	defer tx.Rollback(ctx)

	var (
		bookingID     string
		customerID    string
		timeSlotID    *string
		paymentMethod *string
		paymentID     *string
		paymentStatus *string
		amountPaise   int64
		discountPaise int64
	)

	err = tx.QueryRow(ctx, `
		SELECT id::text, customer_id::text,
		       time_slot_id::text,
		       payment_method, payment_id, payment_status,
		       amount_paise, COALESCE(discount_paise, 0)
		FROM bookings
		WHERE status      = 'pending_customer_action'
		  AND updated_at  < NOW() - INTERVAL '30 minutes'
		ORDER BY updated_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`).Scan(&bookingID, &customerID, &timeSlotID,
		&paymentMethod, &paymentID, &paymentStatus,
		&amountPaise, &discountPaise)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sweepResult{}, false, nil
		}
		return sweepResult{}, false, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE bookings
		SET status       = 'cancelled',
		    cancelled_at = NOW(),
		    updated_at   = NOW(),
		    cancelled_by = 'sweep_timeout'
		WHERE id = $1::uuid
	`, bookingID); err != nil {
		return sweepResult{}, false, err
	}

	// Release slot capacity so the slot can accept new bookings.
	if timeSlotID != nil && *timeSlotID != "" {
		if _, err := tx.Exec(ctx, `
			UPDATE time_slots
			SET current_bookings = GREATEST(current_bookings - 1, 0)
			WHERE id = $1::uuid
		`, *timeSlotID); err != nil {
			// Non-fatal: log and continue — the cancel is the critical write.
			log.Warn().Err(err).Str("booking_id", bookingID).Str("slot_id", *timeSlotID).
				Msg("[pending-action-sweep] slot release failed")
		}
	}

	// Route refund if money was actually collected.
	paid := paymentStatus != nil && *paymentStatus == "paid"
	refundAmount := amountPaise - discountPaise
	if paid && refundAmount > 0 && paymentMethod != nil {
		switch *paymentMethod {
		case "wallet":
			if _, wErr := s.walletRepo.ApplyTransactionTx(ctx, tx, wallet.WalletTx{
				UserID:      customerID,
				AmountPaise: refundAmount,
				Kind:        wallet.KindRefundCredit,
				BookingID:   &bookingID,
				Note:        "Auto-cancelled: no response to keep-looking prompt",
			}); wErr != nil {
				return sweepResult{}, false, wErr
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
			`, customerID, refundAmount, bookingID, paymentMethod, paymentID); err != nil {
				return sweepResult{}, false, err
			}
		}
		// cash / null / unknown: no money movement needed.
	}

	if err := tx.Commit(ctx); err != nil {
		return sweepResult{}, false, err
	}
	return sweepResult{bookingID: bookingID, customerID: customerID}, true, nil
}
