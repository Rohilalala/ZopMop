package booking

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type stubDBTX struct {
execFn func(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func (s stubDBTX) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return s.execFn(ctx, sql, args...)
}

var _ DBTX = (*pgxpool.Pool)(nil)
var _ DBTX = (pgx.Tx)(nil)

func TestOutboxRepositoryEnqueue_UsesProvidedExecutor(t *testing.T) {
	t.Parallel()

repo := &OutboxRepository{}
called := false
	err := repo.Enqueue(context.Background(), stubDBTX{execFn: func(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
		called = true
		if !strings.Contains(sql, "INSERT INTO booking_outbox") {
			t.Fatalf("unexpected sql: %s", sql)
		}
		if len(args) != 2 {
			t.Fatalf("expected 2 args, got %d", len(args))
		}
if got := args[0]; got != BookingOutboxEventStatusChanged {
t.Fatalf("unexpected event type: %v", got)
}
return pgconn.NewCommandTag("INSERT 0 1"), nil
}}, OutboxEvent{
Type: BookingOutboxEventStatusChanged,
Payload: BookingOutboxPayload{
BookingID:  "b1",
CustomerID: "c1",
},
})
if err != nil {
t.Fatalf("enqueue: %v", err)
}
if !called {
t.Fatal("expected provided executor to be used")
}
}

func TestOutboxRepositoryEnqueue_PropagatesExecError(t *testing.T) {
t.Parallel()

repo := &OutboxRepository{}
wantErr := errors.New("boom")

err := repo.Enqueue(context.Background(), stubDBTX{execFn: func(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
return pgconn.CommandTag{}, wantErr
}}, OutboxEvent{
Type: BookingOutboxEventStatusChanged,
Payload: BookingOutboxPayload{
BookingID:  "b1",
CustomerID: "c1",
},
})
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected wrapped exec error, got %v", err)
	}
}
