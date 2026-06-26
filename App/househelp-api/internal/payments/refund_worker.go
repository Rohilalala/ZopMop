package payments

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

const (
	refundWorkerInterval = 60 * time.Second
	refundClaimBatch     = 20
)

// RefundWorker drives queued booking-cancellation refunds against the payment
// gateway. pending_refunds rows are produced on cancel
// (wallet.RecordBookingRefundTx) but only the gateway can move Cashfree money,
// and in production (cmd/api) nothing else processes them — previously only the
// non-deployed CRM console did. This worker closes that gap.
//
// Safe to run alongside the CRM console: it claims rows atomically
// (status pending -> approved, FOR UPDATE SKIP LOCKED) so the two never process
// the same row, and the gateway dedups by refund_id (= the row UUID), so even a
// double-claim cannot move money twice. Rows stuck in 'approved' for >10 min
// (a crashed claim) are re-picked so nothing strands.
type RefundWorker struct {
	db   *pgxpool.Pool
	gw   Gateway
	stop chan struct{}
}

// NewRefundWorker constructs a worker. gw must be a real gateway (Cashfree);
// callers should skip starting it when no gateway is configured.
func NewRefundWorker(db *pgxpool.Pool, gw Gateway) *RefundWorker {
	return &RefundWorker{db: db, gw: gw, stop: make(chan struct{})}
}

// Start runs the 60s processing loop until ctx is cancelled or Stop is called.
func (w *RefundWorker) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(refundWorkerInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				jobCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				if proc, failed, err := w.ProcessOnce(jobCtx, refundClaimBatch); err != nil {
					log.Warn().Err(err).Msg("[refunds] worker tick failed")
				} else if proc > 0 || failed > 0 {
					log.Info().Int("processed", proc).Int("failed", failed).Msg("[refunds] gateway refunds")
				}
				cancel()
			case <-w.stop:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop ends the loop.
func (w *RefundWorker) Stop() { close(w.stop) }

type claimedRefund struct {
	id        string
	paymentID string
	amount    int64
	method    string
}

// ProcessOnce claims up to `limit` queued Cashfree refunds and drives each
// against the gateway. Returns (processed, failed). Exported for tests + a
// manual one-shot trigger.
func (w *RefundWorker) ProcessOnce(ctx context.Context, limit int) (processed, failed int, err error) {
	claimed, err := w.claim(ctx, limit)
	if err != nil {
		return 0, 0, err
	}
	for _, r := range claimed {
		res, rerr := w.gw.Refund(ctx, r.paymentID, r.amount, PaymentMethod(r.method), r.id)
		if rerr != nil {
			failed++
			_, _ = w.db.Exec(ctx,
				`UPDATE pending_refunds SET status='gateway_error', error_message=$2 WHERE id=$1::uuid`,
				r.id, truncateErr(rerr.Error(), 480))
			log.Warn().Err(rerr).Str("refund_id", r.id).Msg("[refunds] gateway refund failed")
			continue
		}
		processed++
		var gwRef *string
		if res != nil && res.GatewayRefundID != "" {
			gwRef = &res.GatewayRefundID
		}
		if _, uerr := w.db.Exec(ctx,
			`UPDATE pending_refunds SET status='processed', gateway_refund_id=$2, processed_at=now() WHERE id=$1::uuid`,
			r.id, gwRef); uerr != nil {
			log.Error().Err(uerr).Str("refund_id", r.id).Msg("[refunds] refund moved at gateway but DB update failed — gateway dedup protects re-run")
		}
	}
	return processed, failed, nil
}

// claim atomically moves up to `limit` due rows to 'approved' and returns them.
func (w *RefundWorker) claim(ctx context.Context, limit int) ([]claimedRefund, error) {
	rows, err := w.db.Query(ctx, `
		UPDATE pending_refunds
		   SET status='approved', approved_at=now()
		 WHERE id IN (
		   SELECT id FROM pending_refunds
		    WHERE payment_method='cashfree' AND payment_id IS NOT NULL
		      AND (status='pending'
		           OR (status='approved' AND approved_at < now() - interval '10 minutes'))
		    ORDER BY created_at
		    LIMIT $1
		    FOR UPDATE SKIP LOCKED
		 )
		 RETURNING id::text, payment_id, amount_cents, payment_method`,
		limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []claimedRefund
	for rows.Next() {
		var c claimedRefund
		var paymentID, method *string
		if err := rows.Scan(&c.id, &paymentID, &c.amount, &method); err != nil {
			return nil, err
		}
		if paymentID != nil {
			c.paymentID = *paymentID
		}
		if method != nil {
			c.method = *method
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func truncateErr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
