# Re-engagement Reminder Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send personalized push reminders when a user drops off on mopping service discovery or leaves items in cart without creating a booking for 30 minutes.

**Architecture:** Add a small backend re-engagement module that runs as a periodic worker, computes eligible users from analytics/cart/booking data, deduplicates sends in a dedicated table, and dispatches pushes through existing `notification.Service`. Keep event ingestion backward-compatible and only add the minimum new event names/properties needed for precise targeting.

**Tech Stack:** Go (Fiber), PostgreSQL, existing analytics events table, existing FCM notification service.

---

## File Structure

- **Create:** `App/househelp-api/migrations/032_reengagement_notifications.sql`  
  Create dedupe/state table for sent reminder records.
- **Create:** `App/househelp-api/internal/reengagement/model.go`  
  Candidate/reminder types and scenario constants.
- **Create:** `App/househelp-api/internal/reengagement/repository.go`  
  SQL reads for candidates + idempotent send log write.
- **Create:** `App/househelp-api/internal/reengagement/service.go`  
  Business rules: 30-min delay, booking exclusion, personalization.
- **Create:** `App/househelp-api/internal/reengagement/worker.go`  
  Ticker-based worker to process both scenarios.
- **Create:** `App/househelp-api/internal/reengagement/service_test.go`  
  Unit tests for eligibility and dedupe behavior.
- **Create:** `App/househelp-api/internal/reengagement/worker_test.go`  
  Worker run-loop and dispatch tests.
- **Modify:** `App/househelp-api/internal/analytics/model.go`  
  Add `booking_requested` to allowed client events.
- **Modify:** `App/househelp-api/internal/cart/service.go`  
  Emit `cart.item_added` / `cart.item_removed` analytics with service context.
- **Modify:** `App/househelp-api/internal/notification/service.go`  
  Add generic `NotifyCustomerReengagement(...)`.
- **Modify:** `App/househelp-api/cmd/api/main.go`  
  Wire and start/stop re-engagement worker.

---

### Task 1: Add schema for dedupe + reminder history

**Files:**
- Create: `App/househelp-api/migrations/032_reengagement_notifications.sql`
- Test: `App/househelp-api/internal/reengagement/service_test.go` (later tasks will validate behavior against unique key assumptions)

- [ ] **Step 1: Write migration file**

```sql
CREATE TABLE IF NOT EXISTS reengagement_notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario      TEXT NOT NULL, -- 'mopping_dropoff' | 'cart_abandonment'
    window_start  TIMESTAMPTZ NOT NULL,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reengagement_user_scenario_window
    ON reengagement_notifications (user_id, scenario, window_start);

CREATE INDEX IF NOT EXISTS idx_reengagement_sent_at
    ON reengagement_notifications (sent_at DESC);
```

- [ ] **Step 2: Apply migration in local dev DB**

Run: `cd App/househelp-api && make migrate-up` (or your project migration command)  
Expected: migration `032_reengagement_notifications.sql` applied successfully.

- [ ] **Step 3: Commit**

```bash
git add App/househelp-api/migrations/032_reengagement_notifications.sql
git commit -m "feat: add reengagement notification log table"
```

---

### Task 2: Add re-engagement domain + repository

**Files:**
- Create: `App/househelp-api/internal/reengagement/model.go`
- Create: `App/househelp-api/internal/reengagement/repository.go`
- Test: `App/househelp-api/internal/reengagement/service_test.go`

- [ ] **Step 1: Write failing test for idempotent send log behavior**

```go
func TestService_ProcessMoppingDropoff_DedupesByWindow(t *testing.T) {
    repo := &fakeRepo{
        mopping: []Candidate{{UserID: "11111111-1111-1111-1111-111111111111", WindowStart: time.Now().Add(-35 * time.Minute), ServiceName: "Mopping"}},
    }
    notif := &fakeNotifier{}
    svc := NewService(repo, notif, 30*time.Minute)

    require.NoError(t, svc.ProcessMoppingDropoff(context.Background(), time.Now()))
    require.NoError(t, svc.ProcessMoppingDropoff(context.Background(), time.Now()))

    require.Equal(t, 1, notif.sentCount("11111111-1111-1111-1111-111111111111", ScenarioMoppingDropoff))
}
```

- [ ] **Step 2: Run test and verify it fails**

Run: `cd App/househelp-api && go test ./internal/reengagement -run TestService_ProcessMoppingDropoff_DedupesByWindow -v`  
Expected: FAIL (module/types missing).

- [ ] **Step 3: Create `model.go`**

```go
package reengagement

import "time"

const (
    ScenarioMoppingDropoff = "mopping_dropoff"
    ScenarioCartAbandonment = "cart_abandonment"
)

type Candidate struct {
    UserID      string
    WindowStart time.Time
    ServiceName string
    CartCount   int
}
```

- [ ] **Step 4: Create `repository.go` with required interfaces + SQL methods**

```go
type Repository struct { db *pgxpool.Pool }

func (r *Repository) ListMoppingDropoffCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error) { /* query analytics_events */ }
func (r *Repository) ListCartAbandonmentCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error) { /* query cart/bookings */ }
func (r *Repository) RecordSent(ctx context.Context, userID, scenario string, windowStart time.Time, payload map[string]string) (bool, error) { /* INSERT ... ON CONFLICT DO NOTHING */ }
```

- [ ] **Step 5: Run targeted test again**

Run: `cd App/househelp-api && go test ./internal/reengagement -run TestService_ProcessMoppingDropoff_DedupesByWindow -v`  
Expected: still FAIL until service is implemented (next task).

- [ ] **Step 6: Commit**

```bash
git add App/househelp-api/internal/reengagement/model.go App/househelp-api/internal/reengagement/repository.go
git commit -m "feat: add reengagement domain and repository skeleton"
```

---

### Task 3: Implement service rules + personalization

**Files:**
- Create: `App/househelp-api/internal/reengagement/service.go`
- Modify: `App/househelp-api/internal/notification/service.go`
- Test: `App/househelp-api/internal/reengagement/service_test.go`

- [ ] **Step 1: Add failing tests for both scenarios**

```go
func TestService_ProcessCartAbandonment_SendsPersonalizedReminder(t *testing.T) {
    repo := &fakeRepo{
        cart: []Candidate{{UserID: "11111111-1111-1111-1111-111111111111", WindowStart: time.Now().Add(-40 * time.Minute), CartCount: 2, ServiceName: "Kitchen Cleaning"}},
    }
    notif := &fakeNotifier{}
    svc := NewService(repo, notif, 30*time.Minute)

    require.NoError(t, svc.ProcessCartAbandonment(context.Background(), time.Now()))
    require.Equal(t, "Still need Kitchen Cleaning?", notif.lastTitle())
}
```

- [ ] **Step 2: Run tests to confirm RED**

Run: `cd App/househelp-api && go test ./internal/reengagement -v`  
Expected: FAIL with missing service logic.

- [ ] **Step 3: Implement `service.go` minimally**

```go
type Notifier interface {
    NotifyCustomerReengagement(ctx context.Context, userID, title, body string, data map[string]string) error
}

func (s *Service) ProcessMoppingDropoff(ctx context.Context, now time.Time) error { /* list candidates -> RecordSent -> notify */ }
func (s *Service) ProcessCartAbandonment(ctx context.Context, now time.Time) error { /* list candidates -> RecordSent -> notify */ }
```

- [ ] **Step 4: Add generic notification method in notification service**

```go
func (s *Service) NotifyCustomerReengagement(ctx context.Context, customerID, title, body string, data map[string]string) error {
    token := s.fcmToken(ctx, customerID)
    if token == "" { return nil }
    return s.sendToToken(ctx, token, title, body, data)
}
```

- [ ] **Step 5: Re-run tests**

Run: `cd App/househelp-api && go test ./internal/reengagement -v`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add App/househelp-api/internal/reengagement/service.go App/househelp-api/internal/reengagement/service_test.go App/househelp-api/internal/notification/service.go
git commit -m "feat: implement reengagement service and notification dispatch"
```

---

### Task 4: Wire cart and analytics signals

**Files:**
- Modify: `App/househelp-api/internal/analytics/model.go`
- Modify: `App/househelp-api/internal/cart/service.go`
- Test: `App/househelp-api/internal/cart/service_test.go` (create if absent)

- [ ] **Step 1: Write failing test for cart analytics emit**

```go
func TestService_AddItem_TracksCartItemAdded(t *testing.T) {
    // fake repo + fake analytics writer
    // call AddItem
    // assert Track called with event cart.item_added and service context
}
```

- [ ] **Step 2: Run cart test and verify failure**

Run: `cd App/househelp-api && go test ./internal/cart -run TestService_AddItem_TracksCartItemAdded -v`  
Expected: FAIL (analytics wiring missing).

- [ ] **Step 3: Add `booking_requested` to allowed client events**

```go
const EventBookingRequested = "booking_requested"
// include in AllowedClientEvents map
```

- [ ] **Step 4: Inject analytics into cart service and emit events**

```go
type analyticsTracker interface {
    Track(ctx context.Context, eventName, userID, bookingID string, props map[string]string)
}

func (s *Service) SetAnalytics(a analyticsTracker) { s.analytics = a }
// in AddItem: Track(cart.item_added, props{"service_id":..., "service_name":...})
// in RemoveItem: Track(cart.item_removed, props{"item_id":...})
```

- [ ] **Step 5: Wire cart analytics in `cmd/api/main.go`**

```go
cartService := cartmod.NewService(cartRepo)
cartService.SetAnalytics(analyticsSvc)
```

- [ ] **Step 6: Re-run cart and analytics tests**

Run: `cd App/househelp-api && go test ./internal/cart ./internal/analytics -v`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add App/househelp-api/internal/analytics/model.go App/househelp-api/internal/cart/service.go App/househelp-api/internal/cart/service_test.go App/househelp-api/cmd/api/main.go
git commit -m "feat: emit cart analytics and allow booking_requested event"
```

---

### Task 5: Add worker runtime integration

**Files:**
- Create: `App/househelp-api/internal/reengagement/worker.go`
- Create: `App/househelp-api/internal/reengagement/worker_test.go`
- Modify: `App/househelp-api/cmd/api/main.go`

- [ ] **Step 1: Write failing worker test**

```go
func TestWorker_RunOnce_ProcessesBothScenarios(t *testing.T) {
    svc := &fakeService{}
    w := NewWorker(svc, time.Minute)
    w.runOnce()
    require.Equal(t, 1, svc.moppingCalls)
    require.Equal(t, 1, svc.cartCalls)
}
```

- [ ] **Step 2: Run worker tests for RED**

Run: `cd App/househelp-api && go test ./internal/reengagement -run TestWorker_RunOnce_ProcessesBothScenarios -v`  
Expected: FAIL (worker missing).

- [ ] **Step 3: Implement worker**

```go
type Worker struct { svc *Service; interval time.Duration; stop chan struct{}; wg sync.WaitGroup }
func (w *Worker) Start() { /* ticker loop */ }
func (w *Worker) Stop() { /* graceful stop */ }
func (w *Worker) runOnce() { _ = w.svc.ProcessMoppingDropoff(...); _ = w.svc.ProcessCartAbandonment(...) }
```

- [ ] **Step 4: Wire worker in `main.go`**

```go
reRepo := reengagement.NewRepository(dbPool)
reSvc := reengagement.NewService(reRepo, notificationService, 30*time.Minute)
reWorker := reengagement.NewWorker(reSvc, 5*time.Minute)
reWorker.Start()
defer reWorker.Stop()
```

- [ ] **Step 5: Run tests**

Run: `cd App/househelp-api && go test ./internal/reengagement ./internal/notification ./cmd/api -v`  
Expected: PASS.

- [ ] **Step 6: Run package safety suite**

Run: `cd App/househelp-api && go test ./internal/analytics ./internal/cart ./internal/reengagement -race`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add App/househelp-api/internal/reengagement/worker.go App/househelp-api/internal/reengagement/worker_test.go App/househelp-api/cmd/api/main.go
git commit -m "feat: run reengagement reminder worker in api process"
```

---

### Task 6: Add operational query pack for Metabase

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-marketplace-analytics-design.md` (append reminder KPI queries)

- [ ] **Step 1: Add SQL cards for re-engagement KPI**

```sql
-- reminders sent by scenario (24h)
SELECT scenario, COUNT(*) AS sent
FROM reengagement_notifications
WHERE sent_at >= NOW() - INTERVAL '24 hours'
GROUP BY scenario
ORDER BY sent DESC;
```

```sql
-- mopping drop-off recovered (booking created within 24h of reminder)
SELECT
  COUNT(*) FILTER (WHERE b.id IS NOT NULL) AS recovered,
  COUNT(*) AS reminded
FROM reengagement_notifications r
LEFT JOIN bookings b
  ON b.customer_id = r.user_id
 AND b.created_at >= r.sent_at
 AND b.created_at < r.sent_at + INTERVAL '24 hours'
WHERE r.scenario = 'mopping_dropoff';
```

- [ ] **Step 2: Commit docs update**

```bash
git add docs/superpowers/specs/2026-04-21-marketplace-analytics-design.md
git commit -m "docs: add reengagement KPI queries for dashboards"
```

---

## Final Verification Checklist

- [ ] `go test ./internal/reengagement -v`
- [ ] `go test ./internal/cart ./internal/analytics ./internal/notification -v`
- [ ] `go test ./internal/reengagement ./internal/cart ./internal/analytics -race`
- [ ] Manually verify one mopping drop-off reminder and one cart reminder in dev logs.
- [ ] Confirm no duplicate send for same `(user_id, scenario, window_start)`.

