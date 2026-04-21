# Marketplace Analytics V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-safe, event-driven analytics for user funnel, helper performance, marketplace health, revenue, retention, trust, geo, and failure metrics across React Native + Fiber + PostgreSQL.

**Architecture:** Keep PostgreSQL as canonical analytics store with immutable raw events + typed fact tables + hourly/daily rollups. Route all app/business events through one `/api/v1/events` contract, enrich with backend middleware telemetry, and serve dashboards via rollup tables in Metabase. Mirror selected product events to Mixpanel/Amplitude optionally.

**Tech Stack:** React Native (Expo, TypeScript), Go (Fiber), PostgreSQL (JSONB + partitioning + indexes), Redis (existing), Metabase, optional Mixpanel/Amplitude.

---

## File Structure and Ownership

- **Backend event contract + ingestion**
  - Modify: `App/househelp-api/internal/analytics/model.go` (canonical envelope + event enums)
  - Create: `App/househelp-api/internal/analytics/validator.go` (schema/privacy validation)
  - Create: `App/househelp-api/internal/analytics/sanitizer.go` (token/PII stripping + geo rounding)
  - Modify: `App/househelp-api/internal/analytics/handler.go` (`POST /events` + validation errors)
  - Modify: `App/househelp-api/internal/analytics/service.go` (sync ingest API + async mirror fanout)
  - Modify: `App/househelp-api/internal/analytics/repository.go` (raw/fact writes + idempotency)
  - Create: `App/househelp-api/internal/analytics/handler_test.go`
  - Create: `App/househelp-api/internal/analytics/service_test.go`

- **Backend telemetry middleware**
  - Create: `App/househelp-api/internal/middleware/analytics_events.go` (request completed/failure emit)
  - Modify: `App/househelp-api/cmd/api/main.go` (wire middleware after request-id/auth)

- **Database schema + rollups**
  - Create: `App/househelp-api/migrations/031_analytics_event_pipeline.sql`
  - Create: `App/househelp-api/migrations/032_analytics_geo_trust.sql`
  - Create: `App/househelp-api/migrations/033_analytics_business_rollups.sql`
  - Modify: `App/househelp-api/internal/analytics/rollup_worker.go`
  - Create: `App/househelp-api/internal/analytics/rollup_queries.go`

- **Admin analytics APIs**
  - Modify: `App/househelp-api/internal/analytics/handler.go` (new endpoints: geo, trust, failures, retention, unit-economics)
  - Modify: `App/househelp-api/internal/analytics/model.go` (response DTOs)
  - Modify: `App/househelp-api/internal/analytics/repository.go` (metric queries)

- **React Native instrumentation**
  - Create: `App/zopmop-app/src/analytics/events.ts`
  - Create: `App/zopmop-app/src/analytics/tracker.ts`
  - Create: `App/zopmop-app/src/api/analytics.ts`
  - Modify: `App/zopmop-app/App.tsx` (`app_opened`)
  - Modify: `App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx` (`signup_started`, `signup_completed`)
  - Modify: `App/zopmop-app/src/screens/main/HomeScreen.tsx` (`search_initiated`, `helper_profile_viewed`)
  - Modify: `App/zopmop-app/src/screens/booking/InstantMatchingScreen.tsx` (`booking_requested`, `match_found`, `match_failed`, `search_timeout`, `booking_cancelled_by_user`)
  - Modify: `App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx` (`helper_online`, `helper_offline`)
  - Modify: `App/zopmop-app/src/screens/pro/ProActiveScreen.tsx` (`job_accepted`, `job_completed`, `job_cancelled_by_helper`)

- **Ops docs + dashboard SQL**
  - Create: `report/analytics/metabase/product_dashboard.sql`
  - Create: `report/analytics/metabase/ops_dashboard.sql`
  - Create: `report/analytics/metabase/founder_dashboard.sql`
  - Modify: `README.md` (analytics architecture + privacy controls + runbook)

---

### Task 1: Canonical Event Contract + Ingestion Endpoint

**Files:**
- Create: `App/househelp-api/internal/analytics/validator.go`
- Create: `App/househelp-api/internal/analytics/sanitizer.go`
- Modify: `App/househelp-api/internal/analytics/model.go`
- Modify: `App/househelp-api/internal/analytics/handler.go`
- Modify: `App/househelp-api/internal/analytics/service.go`
- Test: `App/househelp-api/internal/analytics/handler_test.go`

- [ ] **Step 1: Write failing handler tests for required schema and privacy rejection**

```go
func TestTrackEvent_RejectsMissingRequiredFields(t *testing.T) {
	// missing event_name and timestamp => 400
}

func TestTrackEvent_RejectsTokenLeakage(t *testing.T) {
	// properties.authorization present => 400
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestTrackEvent_ -v`  
Expected: FAIL with missing route/validation assertions.

- [ ] **Step 3: Implement minimal ingestion contract and validator**

```go
type EventEnvelope struct {
	EventID       string                 `json:"event_id"`
	EventName     string                 `json:"event_name"`
	EventVersion  int                    `json:"event_version"`
	Timestamp     time.Time              `json:"timestamp"`
	UserID        string                 `json:"user_id"`
	HelperID      *string                `json:"helper_id,omitempty"`
	Device        string                 `json:"device"`
	Location      EventLocation          `json:"location"`
	Properties    map[string]any         `json:"properties"`
	Metadata      map[string]any         `json:"metadata"`
	ConsentState  string                 `json:"consent_state"`
}
```

```go
func ValidateEvent(e *EventEnvelope) error {
	if e.EventName == "" || e.UserID == "" || e.Device == "" || e.Timestamp.IsZero() {
		return ErrInvalidEvent
	}
	if hasSecretKeys(e.Properties) || hasSecretKeys(e.Metadata) {
		return ErrSensitivePayload
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestTrackEvent_ -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/analytics/model.go \
        App/househelp-api/internal/analytics/handler.go \
        App/househelp-api/internal/analytics/service.go \
        App/househelp-api/internal/analytics/validator.go \
        App/househelp-api/internal/analytics/sanitizer.go \
        App/househelp-api/internal/analytics/handler_test.go
git commit -m "feat(analytics): add canonical event ingestion contract"
```

### Task 2: Raw Events + Fact Tables + Idempotent Writes

**Files:**
- Create: `App/househelp-api/migrations/031_analytics_event_pipeline.sql`
- Modify: `App/househelp-api/internal/analytics/repository.go`
- Test: `App/househelp-api/internal/analytics/service_test.go`

- [ ] **Step 1: Write failing service test for idempotent insert**

```go
func TestIngestEvent_DeduplicatesByEventID(t *testing.T) {
	// same event_id ingested twice => 1 raw row persisted
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestIngestEvent_DeduplicatesByEventID -v`  
Expected: FAIL because unique constraint/write path not implemented.

- [ ] **Step 3: Add migration + repository upsert**

```sql
CREATE TABLE analytics_raw_events (
  event_date date NOT NULL,
  event_id uuid NOT NULL,
  event_name text NOT NULL,
  user_id uuid NOT NULL,
  helper_id uuid NULL,
  device text NOT NULL,
  area text NOT NULL,
  city text NOT NULL,
  geo_point point,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_date, event_id)
) PARTITION BY RANGE (event_date);
```

```go
_, err := r.db.Exec(ctx, `
	INSERT INTO analytics_raw_events (...)
	VALUES (...)
	ON CONFLICT (event_date, event_id) DO NOTHING
`)
```

- [ ] **Step 4: Run tests**

Run: `cd App/househelp-api && go test ./internal/analytics -v`  
Expected: PASS for idempotency tests.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/migrations/031_analytics_event_pipeline.sql \
        App/househelp-api/internal/analytics/repository.go \
        App/househelp-api/internal/analytics/service_test.go
git commit -m "feat(analytics): add partitioned raw event store and idempotent writes"
```

### Task 3: Fiber Middleware Telemetry Events

**Files:**
- Create: `App/househelp-api/internal/middleware/analytics_events.go`
- Modify: `App/househelp-api/cmd/api/main.go`
- Test: `App/househelp-api/internal/analytics/handler_test.go`

- [ ] **Step 1: Write failing middleware test for request metrics event**

```go
func TestAnalyticsMiddleware_EmitsRequestCompleted(t *testing.T) {
	// verify route, status_code, latency_ms recorded
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestAnalyticsMiddleware_ -v`  
Expected: FAIL because middleware not wired.

- [ ] **Step 3: Implement middleware and wire it**

```go
func AnalyticsEvents(svc *analytics.Service) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		svc.TrackRequest(c, time.Since(start), err)
		return err
	}
}
```

```go
app.Use(mw.AnalyticsEvents(analyticsSvc))
```

- [ ] **Step 4: Run tests**

Run: `cd App/househelp-api && go test ./internal/analytics -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/middleware/analytics_events.go \
        App/househelp-api/cmd/api/main.go \
        App/househelp-api/internal/analytics/handler_test.go
git commit -m "feat(analytics): auto-capture backend request telemetry"
```

### Task 4: React Native Tracking SDK + Funnel Instrumentation

**Files:**
- Create: `App/zopmop-app/src/analytics/events.ts`
- Create: `App/zopmop-app/src/analytics/tracker.ts`
- Create: `App/zopmop-app/src/api/analytics.ts`
- Modify: `App/zopmop-app/App.tsx`
- Modify: `App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx`
- Modify: `App/zopmop-app/src/screens/main/HomeScreen.tsx`
- Modify: `App/zopmop-app/src/screens/booking/InstantMatchingScreen.tsx`
- Modify: `App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx`
- Modify: `App/zopmop-app/src/screens/pro/ProActiveScreen.tsx`

- [ ] **Step 1: Add failing type checks for event names/properties**

```ts
trackEvent('signup_completed', { user_id, device: 'android' }); // should require timestamp/location
```

- [ ] **Step 2: Run typecheck to verify failure**

Run: `cd App/zopmop-app && npx tsc --noEmit`  
Expected: FAIL with missing required analytics fields.

- [ ] **Step 3: Implement tracker + event wrappers**

```ts
export async function trackEvent(eventName: AnalyticsEventName, payload: EventPayload) {
  const enriched = await withDeviceAndLocation(payload);
  await postAnalyticsEvent(enriched);
}
```

```ts
// App.tsx
useEffect(() => { trackEvent('app_opened', basePayload()); }, []);
```

- [ ] **Step 4: Run typecheck**

Run: `cd App/zopmop-app && npx tsc --noEmit`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/zopmop-app/src/analytics/events.ts \
        App/zopmop-app/src/analytics/tracker.ts \
        App/zopmop-app/src/api/analytics.ts \
        App/zopmop-app/App.tsx \
        App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx \
        App/zopmop-app/src/screens/main/HomeScreen.tsx \
        App/zopmop-app/src/screens/booking/InstantMatchingScreen.tsx \
        App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx \
        App/zopmop-app/src/screens/pro/ProActiveScreen.tsx
git commit -m "feat(app-analytics): instrument funnel and helper lifecycle events"
```

### Task 5: Core KPI Rollups and Query Layer

**Files:**
- Create: `App/househelp-api/migrations/033_analytics_business_rollups.sql`
- Create: `App/househelp-api/internal/analytics/rollup_queries.go`
- Modify: `App/househelp-api/internal/analytics/rollup_worker.go`
- Modify: `App/househelp-api/internal/analytics/repository.go`
- Test: `App/househelp-api/internal/analytics/service_test.go`

- [ ] **Step 1: Write failing tests for KPI query methods**

```go
func TestGetCoreMetrics_ReturnsConversionAndMatchKPIs(t *testing.T) {}
func TestGetBusinessMetrics_ReturnsAOVLTVRepeat(t *testing.T) {}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestGetCoreMetrics_ -v`  
Expected: FAIL (missing query methods/DTOs).

- [ ] **Step 3: Implement rollup SQL + repository methods**

```sql
CREATE MATERIALIZED VIEW analytics_core_daily AS
SELECT event_date, city, area,
       booking_confirmed_users::float / NULLIF(search_users,0) AS booking_conversion_rate,
       match_found_count::float / NULLIF(search_count,0)        AS match_success_rate
FROM ...
```

```go
func (r *Repository) GetCoreMetrics(ctx context.Context, f MetricFilters) (*CoreMetrics, error) { ... }
```

- [ ] **Step 4: Run tests**

Run: `cd App/househelp-api && go test ./internal/analytics -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/migrations/033_analytics_business_rollups.sql \
        App/househelp-api/internal/analytics/rollup_queries.go \
        App/househelp-api/internal/analytics/rollup_worker.go \
        App/househelp-api/internal/analytics/repository.go \
        App/househelp-api/internal/analytics/service_test.go
git commit -m "feat(analytics): add core and business KPI rollups"
```

### Task 6: Geo Analytics + Heatmap Endpoints

**Files:**
- Create: `App/househelp-api/migrations/032_analytics_geo_trust.sql`
- Modify: `App/househelp-api/internal/analytics/model.go`
- Modify: `App/househelp-api/internal/analytics/repository.go`
- Modify: `App/househelp-api/internal/analytics/handler.go`
- Test: `App/househelp-api/internal/analytics/handler_test.go`

- [ ] **Step 1: Write failing handler test for geo heatmap endpoint**

```go
func TestGetGeoHeatmap_ReturnsDemandSupplyFailureCells(t *testing.T) {}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd App/househelp-api && go test ./internal/analytics -run TestGetGeoHeatmap_ -v`  
Expected: FAIL (endpoint/query absent).

- [ ] **Step 3: Implement geo aggregation and endpoint**

```go
g.Get("/geo/heatmap", h.GetGeoHeatmap)
```

```sql
SELECT geohash6, area, city,
       SUM(bookings_confirmed) AS bookings,
       SUM(helper_online_minutes) AS availability,
       SUM(match_failed_count) AS failures
FROM analytics_geo_15m
WHERE bucket_time BETWEEN $1 AND $2
GROUP BY geohash6, area, city;
```

- [ ] **Step 4: Run tests**

Run: `cd App/househelp-api && go test ./internal/analytics -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/migrations/032_analytics_geo_trust.sql \
        App/househelp-api/internal/analytics/model.go \
        App/househelp-api/internal/analytics/repository.go \
        App/househelp-api/internal/analytics/handler.go \
        App/househelp-api/internal/analytics/handler_test.go
git commit -m "feat(analytics): add geo demand-supply heatmap analytics"
```

### Task 7: Trust, Quality, and Failure Analytics

**Files:**
- Modify: `App/househelp-api/internal/analytics/model.go`
- Modify: `App/househelp-api/internal/analytics/repository.go`
- Modify: `App/househelp-api/internal/analytics/handler.go`
- Test: `App/househelp-api/internal/analytics/service_test.go`

- [ ] **Step 1: Write failing tests for trust/failure KPI methods**

```go
func TestGetTrustMetrics_ReturnsRatingsComplaintRateNPS(t *testing.T) {}
func TestGetFailureMetrics_BreaksDownByReason(t *testing.T) {}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd App/househelp-api && go test ./internal/analytics -run 'TestGetTrustMetrics_|TestGetFailureMetrics_' -v`  
Expected: FAIL.

- [ ] **Step 3: Implement trust/failure queries**

```sql
SELECT helper_id,
       bayesian_rating,
       complaints_per_100_jobs,
       nps_score
FROM analytics_helper_quality_daily
WHERE bucket_date >= CURRENT_DATE - $1;
```

```go
g.Get("/trust", h.GetTrustMetrics)
g.Get("/failures", h.GetFailureMetrics)
```

- [ ] **Step 4: Run tests**

Run: `cd App/househelp-api && go test ./internal/analytics -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/analytics/model.go \
        App/househelp-api/internal/analytics/repository.go \
        App/househelp-api/internal/analytics/handler.go \
        App/househelp-api/internal/analytics/service_test.go
git commit -m "feat(analytics): add trust quality and failure KPI APIs"
```

### Task 8: Dashboard SQL Packs + Documentation + Privacy Runbook

**Files:**
- Create: `report/analytics/metabase/product_dashboard.sql`
- Create: `report/analytics/metabase/ops_dashboard.sql`
- Create: `report/analytics/metabase/founder_dashboard.sql`
- Modify: `README.md`

- [ ] **Step 1: Create failing dashboard smoke checklist (manual)**

```text
1) Product funnel cards load under 2s
2) Ops heatmap filters city/area correctly
3) Founder LTV/CAC panel reconciles with source tables
```

- [ ] **Step 2: Export and run SQL locally**

Run: `cd App/househelp-api && psql "$DATABASE_URL" -f ../report/analytics/metabase/product_dashboard.sql`  
Expected: SQL executes without relation/column errors.

- [ ] **Step 3: Add dashboard queries and docs**

```sql
-- product_dashboard.sql
SELECT event_date, app_opened, signup_completed, booking_confirmed, payment_success
FROM analytics_funnel_daily
WHERE event_date BETWEEN {{start_date}} AND {{end_date}};
```

```md
## Analytics Privacy Guardrails
- Never send tokens/JWT/phone/email.
- Geo rounding at ingest (3 decimals).
- Raw precise geo TTL: 7 days.
```

- [ ] **Step 4: Re-run SQL checks**

Run: `cd App/househelp-api && psql "$DATABASE_URL" -f ../report/analytics/metabase/founder_dashboard.sql`  
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add report/analytics/metabase/product_dashboard.sql \
        report/analytics/metabase/ops_dashboard.sql \
        report/analytics/metabase/founder_dashboard.sql \
        README.md
git commit -m "docs(analytics): add dashboard SQL packs and privacy runbook"
```

---

## Metric Query Cheatsheet (for implementation and QA)

- **Booking Conversion Rate**
```sql
SELECT event_date,
       booking_confirmed_users::float / NULLIF(search_users, 0) AS booking_conversion_rate
FROM analytics_funnel_daily;
```

- **Time to Match (p50/p90)**
```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_match_sec) AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY time_to_match_sec) AS p90
FROM analytics_match_events
WHERE event_date BETWEEN $1 AND $2;
```

- **Helper Utilization**
```sql
SELECT helper_id,
       SUM(on_job_minutes)::float / NULLIF(SUM(online_minutes), 0) AS utilization
FROM analytics_helper_daily
GROUP BY helper_id;
```

- **DAU/MAU**
```sql
SELECT
  d.day,
  d.dau,
  m.mau,
  d.dau::float / NULLIF(m.mau, 0) AS dau_mau_ratio
FROM analytics_dau d
JOIN analytics_mau m ON m.month = date_trunc('month', d.day);
```

---

## Spec Coverage Check

- Event tracking design and required events: **covered by Tasks 1 + 4**
- Event-driven architecture + ingestion/storage/query: **covered by Tasks 1, 2, 3, 5**
- Core/business/engagement metrics and formulas: **covered by Tasks 5 + cheatsheet**
- Geo analytics and heatmaps: **covered by Task 6**
- Trust/quality and fraud hints: **covered by Task 7**
- Dashboards for product/ops/founders: **covered by Task 8**
- Security/privacy constraints: **covered by Tasks 1 + 8**
- Implementation outputs (RN code, Fiber middleware, `/events`, sample queries, tools): **covered by Tasks 1, 3, 4, 8**

