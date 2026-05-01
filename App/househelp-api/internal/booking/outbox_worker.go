package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type outboxStore interface {
	ClaimPending(ctx context.Context, limit int) ([]OutboxPendingEvent, error)
	MarkDone(ctx context.Context, eventID string) error
	MarkRetry(ctx context.Context, eventID, lastError string, nextAvailableAt time.Time) error
	MarkFailed(ctx context.Context, eventID, lastError string) error
}

type outboxNotificationService interface {
	NotifyCustomerBookingAccepted(ctx context.Context, customerID, helperName, bookingID string) error
	NotifyProBookingCancelled(ctx context.Context, helperID, bookingID string) error
	NotifyCustomerBookingCompleted(ctx context.Context, customerID, bookingID string) error
}

type outboxMatchService interface {
	ClearMatchOnAccept(ctx context.Context, bookingID string, acceptedHelperID string)
}

type outboxDB interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

type OutboxWorker struct {
	store         outboxStore
	notifications outboxNotificationService
	matcher       outboxMatchService
	db            outboxDB

	batchSize    int
	pollInterval time.Duration
	baseBackoff  time.Duration
	maxBackoff   time.Duration
	maxAttempts  int
	now          func() time.Time
	sleep        func(context.Context, time.Duration) error
}

func NewOutboxWorker(repo *OutboxRepository, notifSvc outboxNotificationService, matchSvc outboxMatchService, db outboxDB) *OutboxWorker {
	return &OutboxWorker{
		store:         repo,
		notifications: notifSvc,
		matcher:       matchSvc,
		db:            db,
		batchSize:     20,
		pollInterval:  time.Second,
		baseBackoff:   2 * time.Second,
		maxBackoff:    2 * time.Minute,
		maxAttempts:   8,
		now:           time.Now,
		sleep:         sleepWithContext,
	}
}

func (w *OutboxWorker) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		processed, err := w.processBatch(ctx)
		if err != nil {
			if sleepErr := w.sleep(ctx, w.pollInterval); sleepErr != nil {
				return sleepErr
			}
			continue
		}
		if processed == 0 {
			if err := w.sleep(ctx, w.pollInterval); err != nil {
				return err
			}
		}
	}
}

func (w *OutboxWorker) processBatch(ctx context.Context) (int, error) {
	events, err := w.store.ClaimPending(ctx, w.batchSize)
	if err != nil {
		return 0, err
	}

	for _, evt := range events {
		if err := w.dispatch(ctx, evt); err != nil {
			if evt.AttemptCount >= w.maxAttempts {
				if markErr := w.store.MarkFailed(ctx, evt.ID, err.Error()); markErr != nil {
					return 0, fmt.Errorf("dispatch outbox event: %w (mark failed failed: %v)", err, markErr)
				}
				continue
			}
			backoff := w.retryBackoff(evt.AttemptCount)
			nextAvailableAt := w.now().Add(backoff)
			if markErr := w.store.MarkRetry(ctx, evt.ID, err.Error(), nextAvailableAt); markErr != nil {
				return 0, fmt.Errorf("dispatch outbox event: %w (mark retry failed: %v)", err, markErr)
			}
			continue
		}
		if err := w.store.MarkDone(ctx, evt.ID); err != nil {
			return 0, fmt.Errorf("mark outbox done: %w", err)
		}
	}

	return len(events), nil
}

func (w *OutboxWorker) dispatch(ctx context.Context, evt OutboxPendingEvent) error {
	switch canonicalizeOutboxEventType(evt.Type) {
	case BookingOutboxEventNotifyCustomerAccepted:
		return w.notifications.NotifyCustomerBookingAccepted(
			ctx, evt.Payload.CustomerID, evt.Payload.HelperName, evt.Payload.BookingID,
		)
	case BookingOutboxEventNotifyProCancelled:
		if evt.Payload.HelperID == nil || *evt.Payload.HelperID == "" {
			return fmt.Errorf("missing helper id for %s", evt.Type)
		}
		return w.notifications.NotifyProBookingCancelled(ctx, *evt.Payload.HelperID, evt.Payload.BookingID)
	case BookingOutboxEventMatchCleanup:
		w.matcher.ClearMatchOnAccept(ctx, evt.Payload.BookingID, "")
		return nil
	case BookingOutboxEventNotifyCustomerCompleted:
		return w.notifications.NotifyCustomerBookingCompleted(ctx, evt.Payload.CustomerID, evt.Payload.BookingID)
	case BookingOutboxEventIncrementHelperJobs:
		if evt.Payload.HelperID == nil || *evt.Payload.HelperID == "" {
			return fmt.Errorf("missing helper id for %s", evt.Type)
		}
		_, err := w.db.Exec(ctx, `UPDATE helpers SET total_jobs = total_jobs + 1 WHERE id = $1`, *evt.Payload.HelperID)
		if err != nil {
			return fmt.Errorf("increment helper jobs: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported outbox event type: %s", evt.Type)
	}
}

func canonicalizeOutboxEventType(eventType BookingOutboxEventType) BookingOutboxEventType {
	switch eventType {
	case "booking_customer_accepted":
		return BookingOutboxEventNotifyCustomerAccepted
	case "booking_pro_cancelled":
		return BookingOutboxEventNotifyProCancelled
	case "booking_match_cleanup":
		return BookingOutboxEventMatchCleanup
	case "booking_customer_completed":
		return BookingOutboxEventNotifyCustomerCompleted
	case "booking_helper_increment_jobs":
		return BookingOutboxEventIncrementHelperJobs
	default:
		return eventType
	}
}

func (w *OutboxWorker) retryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	backoff := w.baseBackoff
	for i := 1; i < attempt; i++ {
		backoff *= 2
		if backoff >= w.maxBackoff {
			return w.maxBackoff
		}
	}
	return backoff
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
