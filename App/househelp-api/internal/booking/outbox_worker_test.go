package booking

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestOutboxWorkerProcessBatch_SuccessMarksDone(t *testing.T) {
	t.Parallel()

	store := &fakeOutboxStore{
		events: []OutboxPendingEvent{
			{
				ID:   "evt-1",
				Type: BookingOutboxEventNotifyCustomerCompleted,
				Payload: BookingOutboxPayload{
					BookingID:  "booking-1",
					CustomerID: "customer-1",
				},
				AttemptCount: 1,
			},
		},
	}
	notifier := &fakeOutboxNotifier{}
	worker := &OutboxWorker{
		store:         store,
		notifications: notifier,
		matcher:       &fakeOutboxMatcher{},
		db:            fakeOutboxDB{},
		batchSize:     10,
		baseBackoff:   time.Second,
		maxBackoff:    10 * time.Second,
		maxAttempts:   8,
		now:           time.Now,
		sleep:         sleepWithContext,
	}

	processed, err := worker.processBatch(context.Background())
	if err != nil {
		t.Fatalf("process batch: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}
	if len(store.doneIDs) != 1 || store.doneIDs[0] != "evt-1" {
		t.Fatalf("expected evt-1 marked done, got %#v", store.doneIDs)
	}
	if len(store.retries) != 0 {
		t.Fatalf("expected no retries, got %#v", store.retries)
	}
	if len(notifier.completedCalls) != 1 {
		t.Fatalf("expected 1 completion notification, got %d", len(notifier.completedCalls))
	}
}

func TestOutboxWorkerProcessBatch_DispatchFailureMarksRetry(t *testing.T) {
	t.Parallel()

	now := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	store := &fakeOutboxStore{
		events: []OutboxPendingEvent{
			{
				ID:   "evt-2",
				Type: BookingOutboxEventNotifyCustomerAccepted,
				Payload: BookingOutboxPayload{
					BookingID:  "booking-2",
					CustomerID: "customer-2",
					HelperName: "Alex",
				},
				AttemptCount: 2,
			},
		},
	}
	notifier := &fakeOutboxNotifier{
		acceptedErr: errors.New("notification provider down"),
	}
	worker := &OutboxWorker{
		store:         store,
		notifications: notifier,
		matcher:       &fakeOutboxMatcher{},
		db:            fakeOutboxDB{},
		batchSize:     10,
		baseBackoff:   2 * time.Second,
		maxBackoff:    time.Minute,
		maxAttempts:   8,
		now:           func() time.Time { return now },
		sleep:         sleepWithContext,
	}

	processed, err := worker.processBatch(context.Background())
	if err != nil {
		t.Fatalf("process batch: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}
	if len(store.doneIDs) != 0 {
		t.Fatalf("expected no done events, got %#v", store.doneIDs)
	}
	if len(store.retries) != 1 {
		t.Fatalf("expected 1 retry call, got %d", len(store.retries))
	}
	gotRetry := store.retries[0]
	if gotRetry.eventID != "evt-2" {
		t.Fatalf("unexpected retry event id: %s", gotRetry.eventID)
	}
	wantAt := now.Add(4 * time.Second)
	if !gotRetry.nextAvailableAt.Equal(wantAt) {
		t.Fatalf("unexpected retry at: want %s got %s", wantAt, gotRetry.nextAvailableAt)
	}
}

func TestOutboxWorkerProcessBatch_LegacyUnderscoreEventTypeProcessed(t *testing.T) {
	t.Parallel()

	store := &fakeOutboxStore{
		events: []OutboxPendingEvent{
			{
				ID:   "evt-legacy-1",
				Type: BookingOutboxEventType("booking_customer_accepted"),
				Payload: BookingOutboxPayload{
					BookingID:  "booking-legacy-1",
					CustomerID: "customer-legacy-1",
					HelperName: "Legacy Helper",
				},
				AttemptCount: 1,
			},
		},
	}
	notifier := &fakeOutboxNotifier{}
	worker := &OutboxWorker{
		store:         store,
		notifications: notifier,
		matcher:       &fakeOutboxMatcher{},
		db:            fakeOutboxDB{},
		batchSize:     10,
		baseBackoff:   time.Second,
		maxBackoff:    10 * time.Second,
		maxAttempts:   8,
		now:           time.Now,
		sleep:         sleepWithContext,
	}

	processed, err := worker.processBatch(context.Background())
	if err != nil {
		t.Fatalf("process batch: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}
	if len(store.retries) != 0 {
		t.Fatalf("expected no retries for legacy event type, got %#v", store.retries)
	}
	if len(store.doneIDs) != 1 || store.doneIDs[0] != "evt-legacy-1" {
		t.Fatalf("expected evt-legacy-1 marked done, got %#v", store.doneIDs)
	}
	if len(notifier.acceptedCalls) != 1 {
		t.Fatalf("expected 1 accepted notification call, got %d", len(notifier.acceptedCalls))
	}
}

func TestOutboxWorkerProcessBatch_MaxAttemptsMarksFailed(t *testing.T) {
	t.Parallel()

	now := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	store := &fakeOutboxStore{
		events: []OutboxPendingEvent{
			{
				ID:   "evt-max-1",
				Type: BookingOutboxEventNotifyCustomerAccepted,
				Payload: BookingOutboxPayload{
					BookingID:  "booking-max-1",
					CustomerID: "customer-max-1",
					HelperName: "Alex",
				},
				AttemptCount: 8,
			},
		},
	}
	notifier := &fakeOutboxNotifier{
		acceptedErr: errors.New("notification provider down"),
	}
	worker := &OutboxWorker{
		store:         store,
		notifications: notifier,
		matcher:       &fakeOutboxMatcher{},
		db:            fakeOutboxDB{},
		batchSize:     10,
		baseBackoff:   2 * time.Second,
		maxBackoff:    time.Minute,
		maxAttempts:   8,
		now:           func() time.Time { return now },
		sleep:         sleepWithContext,
	}

	processed, err := worker.processBatch(context.Background())
	if err != nil {
		t.Fatalf("process batch: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}
	if len(store.retries) != 0 {
		t.Fatalf("expected no retries after max attempts, got %#v", store.retries)
	}
	if len(store.failed) != 1 {
		t.Fatalf("expected 1 failed mark call, got %d", len(store.failed))
	}
	if store.failed[0].eventID != "evt-max-1" {
		t.Fatalf("unexpected failed event id: %s", store.failed[0].eventID)
	}
}

type fakeOutboxStore struct {
	events   []OutboxPendingEvent
	doneIDs  []string
	retries  []fakeRetryCall
	failed   []fakeFailedCall
	claimed  bool
	claimErr error
}

type fakeRetryCall struct {
	eventID         string
	lastError       string
	nextAvailableAt time.Time
}

type fakeFailedCall struct {
	eventID   string
	lastError string
}

func (f *fakeOutboxStore) ClaimPending(_ context.Context, _ int) ([]OutboxPendingEvent, error) {
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if f.claimed {
		return nil, nil
	}
	f.claimed = true
	return append([]OutboxPendingEvent(nil), f.events...), nil
}

func (f *fakeOutboxStore) MarkDone(_ context.Context, eventID string) error {
	f.doneIDs = append(f.doneIDs, eventID)
	return nil
}

func (f *fakeOutboxStore) MarkRetry(_ context.Context, eventID, lastError string, nextAvailableAt time.Time) error {
	f.retries = append(f.retries, fakeRetryCall{
		eventID:         eventID,
		lastError:       lastError,
		nextAvailableAt: nextAvailableAt,
	})
	return nil
}

func (f *fakeOutboxStore) MarkFailed(_ context.Context, eventID, lastError string) error {
	f.failed = append(f.failed, fakeFailedCall{
		eventID:   eventID,
		lastError: lastError,
	})
	return nil
}

type fakeOutboxNotifier struct {
	acceptedErr    error
	completedCalls []string
	cancelledCalls []string
	acceptedCalls  []string
}

func (f *fakeOutboxNotifier) NotifyCustomerBookingAccepted(_ context.Context, customerID, helperName, bookingID string) error {
	f.acceptedCalls = append(f.acceptedCalls, customerID+":"+helperName+":"+bookingID)
	return f.acceptedErr
}

func (f *fakeOutboxNotifier) NotifyProBookingCancelled(_ context.Context, helperID, bookingID string) error {
	f.cancelledCalls = append(f.cancelledCalls, helperID+":"+bookingID)
	return nil
}

func (f *fakeOutboxNotifier) NotifyCustomerBookingCompleted(_ context.Context, customerID, bookingID string) error {
	f.completedCalls = append(f.completedCalls, customerID+":"+bookingID)
	return nil
}

type fakeOutboxMatcher struct{}

func (fakeOutboxMatcher) ClearMatchOnAccept(context.Context, string, string) {}

type fakeOutboxDB struct{}

func (fakeOutboxDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
