# Booking Side-Effects Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move booking side-effects (push notifications, match cleanup, helper counters) off the synchronous request path using a transactional outbox + worker, while preserving current API behavior and correctness.

**Architecture:** Keep booking state transitions synchronous in existing handlers/services, but write side-effect events into a new `booking_outbox` table in the same DB transaction as the state change. Add a background worker that polls pending events, executes side-effects through existing services, retries failures with backoff, and marks events completed. This preserves strong consistency for booking state while making side-effects async and scalable.

**Tech Stack:** Go 1.24, Fiber, pgx/pgxpool, PostgreSQL, Redis, zerolog, existing notification/matching services

---

## File Structure (planned changes)

- **Create:** `migrations/033_booking_outbox.sql`  
  New outbox table + indexes for pending/retry scans.
- **Create:** `internal/booking/outbox.go`  
  Event model (`type`, payload shape), JSON helpers.
- **Create:** `internal/booking/outbox_repository.go`  
  DB operations: enqueue in tx, claim batch, mark done/failed/retry.
- **Create:** `internal/booking/outbox_worker.go`  
  Polling worker loop, dispatch by event type, retry policy.
- **Create:** `internal/booking/outbox_worker_test.go`  
  Unit tests for dispatch/retry behavior (fake notifier/match engine).
- **Modify:** `internal/booking/repository.go`  
  Add transaction helpers used by accept/cancel/complete flows.
- **Modify:** `internal/booking/service.go`  
  Replace inline side-effects with outbox enqueue in the same transaction.
- **Modify:** `cmd/api/main.go`  
  Wire and start/stop outbox worker.
- **Modify:** `internal/booking/handler_test.go` (or add new booking service tests)  
  Add regression checks for API-visible behavior.

---

### Task 1: Add outbox schema + repository primitives

**Files:**
- Create: `migrations/033_booking_outbox.sql`
- Create: `internal/booking/outbox.go`
- Create: `internal/booking/outbox_repository.go`
- Test: `internal/booking/outbox_worker_test.go` (new tests start here for repository interfaces)

- [ ] **Step 1: Write the failing test for event encode/decode contract**

```go
func TestOutboxPayloadRoundTrip(t *testing.T) {
	t.Parallel()
	payload := BookingOutboxPayload{
		BookingID:  "11111111-1111-1111-1111-111111111111",
		CustomerID: "22222222-2222-2222-2222-222222222222",
		HelperID:   "33333333-3333-3333-3333-333333333333",
	}
	raw, err := payload.Marshal()
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var got BookingOutboxPayload
	if err := got.Unmarshal(raw); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if got.BookingID != payload.BookingID || got.CustomerID != payload.CustomerID || got.HelperID != payload.HelperID {
		t.Fatalf("payload mismatch: got=%+v want=%+v", got, payload)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/booking -run TestOutboxPayloadRoundTrip -v`  
Expected: FAIL with undefined `BookingOutboxPayload` / methods.

- [ ] **Step 3: Write minimal outbox model + migration**

```sql
CREATE TABLE booking_outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    TEXT NOT NULL,
    payload       JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
    attempt_count INT  NOT NULL DEFAULT 0,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_booking_outbox_pending_available
    ON booking_outbox (status, available_at, created_at)
    WHERE status IN ('pending','processing');
```

```go
type BookingOutboxPayload struct {
	BookingID  string `json:"booking_id"`
	CustomerID string `json:"customer_id,omitempty"`
	HelperID   string `json:"helper_id,omitempty"`
	HelperName string `json:"helper_name,omitempty"`
}
```

- [ ] **Step 4: Run tests to verify payload contract passes**

Run: `go test ./internal/booking -run TestOutboxPayloadRoundTrip -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/033_booking_outbox.sql internal/booking/outbox.go internal/booking/outbox_repository.go internal/booking/outbox_worker_test.go
git commit -m "feat: add booking outbox schema and models"
```

---

### Task 2: Enqueue side-effects transactionally in booking flows

**Files:**
- Modify: `internal/booking/repository.go`
- Modify: `internal/booking/service.go`
- Test: `internal/booking/outbox_worker_test.go` (service-level enqueue assertions via fakes)

- [ ] **Step 1: Write failing test for cancel/accept/complete enqueue behavior**

```go
func TestAcceptBooking_EnqueuesCustomerAcceptedEvent(t *testing.T) {
	t.Parallel()
	// Arrange fake repo with accepted transition and fake outbox recorder.
	// Call service.AcceptBooking(...)
	// Assert outbox has event_type "booking.customer.accepted" with booking/customer/helper IDs.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/booking -run TestAcceptBooking_EnqueuesCustomerAcceptedEvent -v`  
Expected: FAIL because no outbox enqueue occurs.

- [ ] **Step 3: Implement transactional enqueue in service paths**

```go
// In AcceptBooking:
// 1) update booking status in tx
// 2) insert outbox event booking.customer.accepted
// 3) commit tx
//
// In CancelBooking:
// enqueue booking.pro.cancelled and booking.match.cleanup
//
// In CompleteBooking:
// enqueue booking.customer.completed and booking.helper.increment_jobs
```

```go
if err := r.EnqueueOutboxEvent(ctx, tx, OutboxEvent{
	EventType: OutboxEventCustomerAccepted,
	Payload:   payloadJSON,
}); err != nil {
	return fmt.Errorf("enqueue outbox event: %w", err)
}
```

- [ ] **Step 4: Run focused tests and package tests**

Run: `go test ./internal/booking -run "TestAcceptBooking_EnqueuesCustomerAcceptedEvent|TestCancelBooking_EnqueuesCleanupAndProCancel|TestCompleteBooking_EnqueuesCompletionAndHelperCounter" -v`  
Expected: PASS.

Run: `go test ./internal/booking -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/booking/repository.go internal/booking/service.go internal/booking/outbox_worker_test.go
git commit -m "feat: enqueue booking side-effects via outbox"
```

---

### Task 3: Add outbox worker + side-effect dispatch with retries

**Files:**
- Create: `internal/booking/outbox_worker.go`
- Modify: `internal/booking/service.go` (dispatch helpers if needed)
- Test: `internal/booking/outbox_worker_test.go`

- [ ] **Step 1: Write failing worker tests for success + retry**

```go
func TestOutboxWorker_ProcessesPendingEvent(t *testing.T) {
	t.Parallel()
	// Seed fake repository with one pending "booking.customer.completed" event
	// Run processOnce()
	// Assert notifier called once and event marked done
}

func TestOutboxWorker_RetriesOnFailure(t *testing.T) {
	t.Parallel()
	// notifier fails first time
	// Assert attempt_count increments and available_at is pushed forward
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/booking -run "TestOutboxWorker_ProcessesPendingEvent|TestOutboxWorker_RetriesOnFailure" -v`  
Expected: FAIL with missing worker implementation.

- [ ] **Step 3: Implement worker loop and dispatch table**

```go
type OutboxWorker struct {
	repo      *OutboxRepository
	notif     notificationSender
	match     matchCleanup
	db        *pgxpool.Pool
	interval  time.Duration
	maxBatch  int
	stop      chan struct{}
	wg        sync.WaitGroup
}

func (w *OutboxWorker) processOnce(ctx context.Context) error {
	events, err := w.repo.ClaimPending(ctx, w.maxBatch)
	if err != nil { return err }
	for _, evt := range events {
		if err := w.dispatch(ctx, evt); err != nil {
			_ = w.repo.MarkRetry(ctx, evt.ID, err, nextBackoff(evt.AttemptCount))
			continue
		}
		_ = w.repo.MarkDone(ctx, evt.ID)
	}
	return nil
}
```

- [ ] **Step 4: Run worker and booking tests**

Run: `go test ./internal/booking -run OutboxWorker -v`  
Expected: PASS.

Run: `go test ./internal/booking -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/booking/outbox_worker.go internal/booking/outbox_worker_test.go internal/booking/service.go
git commit -m "feat: process booking outbox events asynchronously"
```

---

### Task 4: Wire worker in server boot + periodic API verification

**Files:**
- Modify: `cmd/api/main.go`
- Test: `internal/booking/handler_test.go` (or new API-level tests in booking package)

- [ ] **Step 1: Write failing integration-style test for boot wiring**

```go
func TestServerBoot_StartsBookingOutboxWorker(t *testing.T) {
	t.Parallel()
	// Assert main wiring constructs worker with dependencies and start/stop lifecycle hooks.
	// If direct boot test is too heavy, test constructor path in booking package.
}
```

- [ ] **Step 2: Run test to confirm missing wiring**

Run: `go test ./cmd/api -run TestServerBoot_StartsBookingOutboxWorker -v`  
Expected: FAIL (or skip if no test harness yet, then add package-level constructor test).

- [ ] **Step 3: Wire worker and add periodic API checks during refactor**

```go
outboxRepo := booking.NewOutboxRepository(dbPool)
outboxWorker := booking.NewOutboxWorker(outboxRepo, notificationService, matchEngine, dbPool, 2*time.Second, 100)
outboxWorker.Start()
defer outboxWorker.Stop()
```

Periodic API checks to run after each major edit:

```bash
curl -sS http://127.0.0.1:8080/health
curl -sS -H "Authorization: Bearer <token>" http://127.0.0.1:8080/api/v1/bookings?page=1&limit=1
```

- [ ] **Step 4: Run full verification suite**

Run: `go test ./internal/booking ./internal/analytics ./internal/middleware -v`  
Expected: PASS.

Run: `go test ./...`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/api/main.go internal/booking/handler_test.go internal/booking/outbox_worker.go internal/booking/outbox_repository.go internal/booking/service.go migrations/033_booking_outbox.sql
git commit -m "feat: wire booking outbox worker and preserve API behavior"
```

---

### Task 5: Operational safeguards for scalability and rollback

**Files:**
- Modify: `cmd/api/main.go`
- Modify: `internal/booking/outbox_worker.go`
- Test: `internal/booking/outbox_worker_test.go`

- [ ] **Step 1: Write failing test for retry cap + dead-letter state**

```go
func TestOutboxWorker_MarksFailedAfterMaxAttempts(t *testing.T) {
	t.Parallel()
	// Seed event with high attempt_count and force dispatch failure.
	// Assert status transitions to failed and is no longer claimed.
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `go test ./internal/booking -run TestOutboxWorker_MarksFailedAfterMaxAttempts -v`  
Expected: FAIL until retry-cap logic exists.

- [ ] **Step 3: Implement max-attempt guard + metrics hooks**

```go
const maxAttempts = 8

if evt.AttemptCount >= maxAttempts {
	_ = w.repo.MarkFailed(ctx, evt.ID, err)
	continue
}
```

Expose counters through existing admin runtime metrics map to monitor:
- pending count
- processing count
- failed count
- avg attempt count

- [ ] **Step 4: Run tests and smoke endpoints**

Run: `go test ./internal/booking -v`  
Expected: PASS.

Run: `curl -sS -H "Authorization: Bearer <admin_token>" http://127.0.0.1:8080/api/v1/admin/runtime/metrics`  
Expected: JSON includes outbox metrics fields.

- [ ] **Step 5: Commit**

```bash
git add internal/booking/outbox_worker.go internal/booking/outbox_worker_test.go cmd/api/main.go
git commit -m "feat: add outbox retry caps and runtime metrics"
```

---

## Spec Coverage Check

- **Async side-effects with safe correctness:** Covered by Tasks 1-3.
- **No API behavior breakage:** Covered by Tasks 2 and 4 tests + periodic API checks.
- **Scalability and observability:** Covered by Task 5 metrics + retry policy.
- **Periodic testing while editing:** Explicit command checkpoints included in Task 4 and full test gates in each task.

