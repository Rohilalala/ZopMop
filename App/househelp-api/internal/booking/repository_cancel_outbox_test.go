package booking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestCancelBookingWithOutbox_EnqueueFailureRollsBackStatus(t *testing.T) {
	t.Parallel()

	helperID := "helper-1"
	state := newFakeCancelTxState(Booking{
		ID:         "booking-1",
		CustomerID: "customer-1",
		HelperID:   &helperID,
		Status:     StatusAccepted,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})
	state.failOutboxInsert = true

	repo := &Repository{
		outbox: NewOutboxRepository(nil),
		beginTx: func(context.Context) (pgx.Tx, error) {
			return newFakeCancelTx(state), nil
		},
	}

	err := repo.CancelBookingWithOutbox(context.Background(), "booking-1", "customer")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "enqueue booking outbox event") {
		t.Fatalf("expected enqueue error, got %v", err)
	}

	if got := state.persisted.Status; got != StatusAccepted {
		t.Fatalf("expected status rollback to accepted, got %s", got)
	}
	if state.committed {
		t.Fatal("did not expect commit on enqueue failure")
	}
	if !state.rolledBack {
		t.Fatal("expected rollback on enqueue failure")
	}
	if got := len(state.persistedOutbox); got != 0 {
		t.Fatalf("expected no persisted outbox events, got %d", got)
	}
}

func TestCancelBookingWithOutbox_SuccessCommitsStatusAndOutbox(t *testing.T) {
	t.Parallel()

	helperID := "helper-1"
	state := newFakeCancelTxState(Booking{
		ID:         "booking-1",
		CustomerID: "customer-1",
		HelperID:   &helperID,
		Status:     StatusAccepted,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	repo := &Repository{
		outbox: NewOutboxRepository(nil),
		beginTx: func(context.Context) (pgx.Tx, error) {
			return newFakeCancelTx(state), nil
		},
	}

	if err := repo.CancelBookingWithOutbox(context.Background(), "booking-1", "customer"); err != nil {
		t.Fatalf("cancel booking: %v", err)
	}

	if got := state.persisted.Status; got != StatusCancelled {
		t.Fatalf("expected status cancelled, got %s", got)
	}
	if !state.committed {
		t.Fatal("expected commit on success")
	}
	if state.rolledBack {
		t.Fatal("did not expect rollback on success")
	}
	if got := len(state.persistedOutbox); got != 2 {
		t.Fatalf("expected 2 persisted outbox events, got %d", got)
	}

	if state.persistedOutbox[0].Type != BookingOutboxEventNotifyProCancelled {
		t.Fatalf("unexpected first event type: %s", state.persistedOutbox[0].Type)
	}
	if state.persistedOutbox[1].Type != BookingOutboxEventMatchCleanup {
		t.Fatalf("unexpected second event type: %s", state.persistedOutbox[1].Type)
	}
}

type fakeCancelTxState struct {
	persisted        Booking
	working          Booking
	persistedOutbox  []OutboxEvent
	workingOutbox    []OutboxEvent
	failOutboxInsert bool
	committed        bool
	rolledBack       bool
}

func newFakeCancelTxState(initial Booking) *fakeCancelTxState {
	return &fakeCancelTxState{
		persisted: initial,
		working:   initial,
	}
}

type fakeCancelTx struct {
	state  *fakeCancelTxState
	closed bool
}

func newFakeCancelTx(state *fakeCancelTxState) *fakeCancelTx {
	state.working = state.persisted
	state.workingOutbox = nil
	state.committed = false
	state.rolledBack = false
	return &fakeCancelTx{state: state}
}

func (f *fakeCancelTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("not implemented")
}

func (f *fakeCancelTx) Commit(context.Context) error {
	if f.closed {
		return errors.New("tx closed")
	}
	f.closed = true
	f.state.committed = true
	f.state.persisted = f.state.working
	f.state.persistedOutbox = append([]OutboxEvent(nil), f.state.workingOutbox...)
	return nil
}

func (f *fakeCancelTx) Rollback(context.Context) error {
	if f.closed {
		return nil
	}
	f.closed = true
	f.state.rolledBack = true
	f.state.working = f.state.persisted
	f.state.workingOutbox = nil
	return nil
}

func (f *fakeCancelTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("not implemented")
}

func (f *fakeCancelTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (f *fakeCancelTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (f *fakeCancelTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("not implemented")
}

func (f *fakeCancelTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "UPDATE bookings SET status") {
		f.state.working.Status = StatusCancelled
		return pgconn.NewCommandTag("UPDATE 1"), nil
	}
	if strings.Contains(sql, "INSERT INTO booking_outbox") {
		if f.state.failOutboxInsert {
			return pgconn.CommandTag{}, errors.New("forced outbox insert failure")
		}

		eventType, _ := args[0].(BookingOutboxEventType)
		payloadBytes, _ := args[1].([]byte)
		var payload BookingOutboxPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return pgconn.CommandTag{}, fmt.Errorf("decode payload: %w", err)
		}

		f.state.workingOutbox = append(f.state.workingOutbox, OutboxEvent{
			Type:    eventType,
			Payload: payload,
		})
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}
	return pgconn.CommandTag{}, fmt.Errorf("unexpected exec SQL: %s", sql)
}

func (f *fakeCancelTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("not implemented")
}

func (f *fakeCancelTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "FROM bookings WHERE id = $1") {
		if len(args) == 0 || args[0] != f.state.persisted.ID {
			return fakeRow{err: pgx.ErrNoRows}
		}
		b := f.state.working
		return fakeRow{values: []any{
			b.ID, b.CustomerID, b.HelperID, b.ServiceCategoryID, b.Status, b.Address,
			b.Lat, b.Lng, b.PriceCents, b.PromoCode, b.DiscountCents, b.CreatedAt, b.UpdatedAt,
		}}
	}
	return fakeRow{err: fmt.Errorf("unexpected query SQL: %s", sql)}
}

func (f *fakeCancelTx) Conn() *pgx.Conn {
	return nil
}

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return fmt.Errorf("scan mismatch: got %d dests, %d values", len(dest), len(r.values))
	}
	for i := range dest {
		if err := assignScanValue(dest[i], r.values[i]); err != nil {
			return err
		}
	}
	return nil
}

func assignScanValue(dest any, src any) error {
	dv := reflect.ValueOf(dest)
	if dv.Kind() != reflect.Pointer || dv.IsNil() {
		return errors.New("destination must be non-nil pointer")
	}

	target := dv.Elem()
	if src == nil {
		target.Set(reflect.Zero(target.Type()))
		return nil
	}

	srcVal := reflect.ValueOf(src)
	if srcVal.Type().AssignableTo(target.Type()) {
		target.Set(srcVal)
		return nil
	}
	if srcVal.Type().ConvertibleTo(target.Type()) {
		target.Set(srcVal.Convert(target.Type()))
		return nil
	}
	return fmt.Errorf("cannot assign %T to %T", src, dest)
}
