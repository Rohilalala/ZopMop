# Server OTP Rail + Payment-Gated END OTP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client-derived START OTP with server-stored START + END OTPs, verify them pro-side, and gate END-OTP visibility on payment (with cash-at-completion and an always-present online-pay nudge).

**Architecture:** Two 4-digit OTPs live as plaintext columns on `bookings`, auto-generated for every row via a volatile column DEFAULT (covers all create/accept paths + backfills legacy rows). Pro `start`/`complete` carry the OTP in-body; the server verifies in a transaction (constant-time compare, attempt counter). END OTP is exposed to the customer only when `payment_status='paid'`; a new `collect-cash` endpoint flips a COD booking to paid (writing a cash `payments` row), and the existing Cashfree order flow handles pay-online. OTP values are role-gated inside `GetBookingByID` so the shared `/bookings/:id` never leaks them to the pro.

**Tech Stack:** Go 1.x / Fiber / pgx, golang-migrate (forward-only `.up.sql`), React Native / Expo (TypeScript), Cashfree Drop SDK.

**Spec:** `docs/superpowers/specs/2026-06-17-server-otp-payment-gated-design.md`

**Deviations from spec (approved at plan time):**
- **DEV-1** Generation = volatile column DEFAULT (SQL `random()`) at insert, not `crypto/rand` at accept. Reason: create+accept are multi-path; one DEFAULT covers all paths and backfills legacy rows.
- **DEV-2** Pro live-flip on online payment = 5s client poll while awaiting-payment, not SSE (no `booking_status_change` event exists; `booking.paid` is a no-op handler).
- **DEV-3** OTP role-gating lives inside `GetBookingByID` (customer-only) because the pro shares `GET /bookings/:id`.

**Testing note:** Backend tasks use DB-backed Go tests gated on `TEST_DATABASE_URL` (stdlib `t.Fatalf`, no testify — mirrors `internal/booking/split_payment_test.go`). The RN app has no unit-test harness; RN tasks verify via `npx tsc --noEmit` (the FE gate) + an explicit manual iOS-sim smoke step.

**Nil-safe deps:** `StartBooking`/`CompleteBooking` call `s.analytics`, `s.webhooks` (`fireWebhook`/`buildOrderEvent`), and `s.notifications` — all documented "nil-safe" on the `Service` struct. Tests construct `NewService(NewRepository(pool), pool, nil, nil, nil)` with these nil. If a test nil-panics inside one of them, the fix is to add the nil-receiver guard to that method (a pre-existing gap) — do NOT wire real deps into the unit test.

**Running backend tests locally:**
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
export TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable'
# Ensure migrations applied to that DB first (Task 1).
go test ./internal/booking/... -run TestOTP -v
```

---

## File map

**Backend (`App/househelp-api`)**
- Create: `migrations/144_booking_otp.up.sql` — 6 new columns + backfill via default.
- Modify: `internal/booking/model.go` — add OTP + payment fields to `Booking`.
- Modify: `internal/booking/repository.go` — `GetBookingByID` (select new cols + role-gate OTP), `GetHelperActiveBookings` (select payment cols).
- Modify: `internal/booking/service.go` — error sentinels, `StartBooking`/`CompleteBooking` OTP+payment gating, new `CollectCash`.
- Modify: `internal/booking/jobs.go` — parse `otp` body on start/complete, new `CollectCash` handler + route, error→HTTP mapping.
- Create: `internal/booking/otp_test.go` — DB-backed tests.

**RN customer (`App/zopmop-app`)**
- Modify: `src/api/matching.ts` — `BookingDetail` new fields.
- Modify: `src/screens/main/TrackLiveScreen.tsx` — server OTP, END card, nudge row.

**RN pro (`App/zopmop-app`)**
- Modify: `src/api/jobs.ts` — `jobStart`/`jobComplete` take `otp`, new `jobCollectCash`.
- Modify: `src/api/pro.ts` (or wherever `getJobDetail` lives) — detail type new payment fields.
- Modify: `src/screens/pro/JobDetailScreen.tsx` — OTP bottom sheet, awaiting-payment + collect-cash, poll.
- Create: `src/components/OtpSheet.tsx` — reusable 4-digit entry sheet.

---

## Task 1: Migration 144 — OTP columns + backfill

**Files:**
- Create: `App/househelp-api/migrations/144_booking_otp.up.sql`

- [ ] **Step 1: Confirm 143 is the current head and 144 is free**

Run:
```bash
ls /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api/migrations | sort | tail -5
```
Expected: highest is `143_booking_wallet_applied.up.sql`, no `144_*`.

- [ ] **Step 2: Write the migration**

Create `App/househelp-api/migrations/144_booking_otp.up.sql`:
```sql
-- 144_booking_otp.up.sql
-- Server-side booking OTPs. START + END are 4-digit plaintext codes scoped to
-- one booking. The volatile random() DEFAULT means Postgres evaluates a fresh
-- value PER ROW: this both backfills every existing row with a distinct code
-- and auto-generates for every future INSERT regardless of code path
-- (CreateBooking, CreateScheduledBooking, assigner force-assign). Forward-only.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS start_otp           VARCHAR(4)  NOT NULL DEFAULT (lpad((floor(random()*10000))::text, 4, '0')),
    ADD COLUMN IF NOT EXISTS end_otp             VARCHAR(4)  NOT NULL DEFAULT (lpad((floor(random()*10000))::text, 4, '0')),
    ADD COLUMN IF NOT EXISTS start_otp_attempts  INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS end_otp_attempts    INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS start_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS end_verified_at     TIMESTAMPTZ;
```

- [ ] **Step 3: Apply against the local test DB**

Run (native path avoids the stale-image footgun):
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
MIGRATIONS_PATH=$(pwd)/migrations go run ./cmd/migrate up
```
Expected: prints a version line ending at `144`.

- [ ] **Step 4: Verify columns exist, are non-null, and backfilled distinctly**

Run:
```bash
PGPASSWORD=localdev123 psql -h localhost -p 5433 -U househelp -d househelp_db -c \
"SELECT count(*) AS rows, count(*) FILTER (WHERE start_otp ~ '^[0-9]{4}\$') AS valid_start, count(DISTINCT start_otp) AS distinct_start FROM bookings;"
```
Expected: `valid_start = rows`, and if `rows >= 2` then `distinct_start > 1` (proves per-row volatile evaluation, not a single cached value).

**Fallback** if `distinct_start = 1` with multiple rows (some PG paths could cache a single value): the column DEFAULT is still re-evaluated per future INSERT (so new bookings are fine), only the legacy backfill collided. Add a corrective `145_booking_otp_backfill.up.sql` that re-randomizes existing rows:
```sql
UPDATE bookings SET start_otp = lpad((floor(random()*10000))::text, 4, '0'),
                    end_otp   = lpad((floor(random()*10000))::text, 4, '0');
```
(Per-row `UPDATE` is unambiguously evaluated per row.) Re-run Step 4 to confirm distinctness.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/migrations/144_booking_otp.up.sql
git commit -m "feat(booking): migration 144 — server OTP columns + backfill"
```

---

## Task 2: Booking model + role-gated read exposure

**Files:**
- Modify: `App/househelp-api/internal/booking/model.go:22-59`
- Modify: `App/househelp-api/internal/booking/repository.go:49-87`
- Test: `App/househelp-api/internal/booking/otp_test.go`

- [ ] **Step 1: Write the failing test**

Create `App/househelp-api/internal/booking/otp_test.go` (shares the package's test helpers `splitTestPool`, `seedPendingBooking`, `makeUUID`, `newSplitTestService` from `split_payment_test.go`):
```go
package booking

import (
	"context"
	"testing"
)

// Customer reading their own booking sees start_otp always and end_otp only
// once paid. The pro (helper) reading the same booking never sees either.
func TestGetBookingByID_OTPExposure(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	repo := NewRepository(pool)

	customer := makeUUID(t, "otp-cust")
	bookingID := seedPendingBooking(t, pool, customer, 10000)

	// Read OTP values directly to compare against the exposed payload.
	var startCode, endCode string
	if err := pool.QueryRow(ctx, `SELECT start_otp, end_otp FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&startCode, &endCode); err != nil {
		t.Fatalf("read raw otps: %v", err)
	}

	// Unpaid customer read: start_otp present, end_otp hidden.
	b, err := repo.GetBookingByID(ctx, bookingID, customer)
	if err != nil {
		t.Fatalf("customer GetBookingByID: %v", err)
	}
	if b.StartOTP == nil || *b.StartOTP != startCode {
		t.Fatalf("customer start_otp = %v, want %q", b.StartOTP, startCode)
	}
	if b.EndOTP != nil {
		t.Fatalf("unpaid customer end_otp = %v, want nil", *b.EndOTP)
	}

	// Mark paid → end_otp now exposed to customer.
	if _, err := pool.Exec(ctx, `UPDATE bookings SET payment_status='paid' WHERE id=$1::uuid`, bookingID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	b2, err := repo.GetBookingByID(ctx, bookingID, customer)
	if err != nil {
		t.Fatalf("customer GetBookingByID (paid): %v", err)
	}
	if b2.EndOTP == nil || *b2.EndOTP != endCode {
		t.Fatalf("paid customer end_otp = %v, want %q", b2.EndOTP, endCode)
	}

	// Pro (helper) read of the same paid booking: BOTH OTPs nil.
	helper := makeUUID(t, "otp-pro")
	if _, err := pool.Exec(ctx, `UPDATE bookings SET helper_id=$2::uuid WHERE id=$1::uuid`, bookingID, helper); err != nil {
		t.Fatalf("assign helper: %v", err)
	}
	bp, err := repo.GetBookingByID(ctx, bookingID, helper)
	if err != nil {
		t.Fatalf("pro GetBookingByID: %v", err)
	}
	if bp.StartOTP != nil || bp.EndOTP != nil {
		t.Fatalf("pro saw otp values: start=%v end=%v, want both nil", bp.StartOTP, bp.EndOTP)
	}
}
```

- [ ] **Step 2: Run it — expect compile failure**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestGetBookingByID_OTPExposure -v
```
Expected: FAIL — `b.StartOTP undefined` (field not on struct yet).

- [ ] **Step 3: Add fields to the Booking struct**

In `internal/booking/model.go`, inside `type Booking struct`, add immediately after the `UpdatedAt` field (line ~58):
```go
	// Server OTP rail (migration 144). StartOTP is exposed to the booking's
	// customer only; EndOTP additionally requires payment_status='paid'. Both
	// are nil on the pro/helper payload — never leak the code to the verifier.
	// Populated in GetBookingByID per caller role; never selected for the pro
	// list query.
	StartOTP           *string `json:"otp,omitempty"`
	EndOTP             *string `json:"end_otp,omitempty"`
	PaymentStatus      *string `json:"payment_status,omitempty"`
	PaymentMethod      *string `json:"payment_method,omitempty"`
	WalletAppliedPaise int     `json:"wallet_applied_paise"`
```

- [ ] **Step 4: Select + role-gate in GetBookingByID**

In `internal/booking/repository.go`, replace the `GetBookingByID` query + Scan + return (lines 49-86) with:
```go
func (r *Repository) GetBookingByID(ctx context.Context, bookingID, requestingUserID string) (*Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	b := &Booking{}
	var startOTP, endOTP string
	var paymentStatus, paymentMethod *string
	err := r.db.QueryRow(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, amount_paise, promo_code, discount_paise,
		        scheduled_time, cancelled_at, cancelled_by, cancellation_fee_applied, cancellation_fee_cents,
		        accepted_at, en_route_at, arrived_at, started_at, completed_at,
		        pro_earnings_paise, actual_duration_minutes, customer_rating_pending,
		        created_at, updated_at,
		        start_otp, end_otp, payment_status, payment_method, wallet_applied_paise
		 FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.AmountPaise, &b.PromoCode,
		&b.DiscountPaise,
		&b.ScheduledTime, &b.CancelledAt, &b.CancelledBy, &b.CancellationFeeApplied, &b.CancellationFeeCents,
		&b.AcceptedAt, &b.EnRouteAt, &b.ArrivedAt, &b.StartedAt, &b.CompletedAt,
		&b.ProEarningsPaise, &b.ActualDurationMinutes, &b.CustomerRatingPending,
		&b.CreatedAt, &b.UpdatedAt,
		&startOTP, &endOTP, &paymentStatus, &paymentMethod, &b.WalletAppliedPaise,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("booking not found")
		}
		return nil, fmt.Errorf("failed to get booking: %w", err)
	}

	// IDOR check: ensure the requesting user owns this booking or is the assigned helper.
	if b.CustomerID != requestingUserID {
		if b.HelperID == nil || *b.HelperID != requestingUserID {
			return nil, fmt.Errorf("booking not found") // Intentionally vague to prevent enumeration.
		}
	}

	// Payment fields are safe for both roles (pro needs them for the
	// outstanding/collect-cash UI; customer for the nudge).
	b.PaymentStatus = paymentStatus
	b.PaymentMethod = paymentMethod

	// OTP exposure is role-gated. Only the booking's CUSTOMER ever receives the
	// code values — the pro/helper types them in and the server compares, so
	// the verifier must never be handed the answer. END OTP additionally
	// requires payment to be settled.
	if b.CustomerID == requestingUserID {
		sc := startOTP
		b.StartOTP = &sc
		if paymentStatus != nil && *paymentStatus == "paid" {
			ec := endOTP
			b.EndOTP = &ec
		}
	}

	return b, nil
}
```

- [ ] **Step 5: Run the test — expect PASS**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestGetBookingByID_OTPExposure -v
```
Expected: PASS.

- [ ] **Step 6: Build + commit**

```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api && go build ./... && go vet ./internal/booking/
git add App/househelp-api/internal/booking/model.go App/househelp-api/internal/booking/repository.go App/househelp-api/internal/booking/otp_test.go
git commit -m "feat(booking): role-gated OTP + payment fields on booking detail"
```

---

## Task 3: Expose payment fields on the pro active-jobs list

**Files:**
- Modify: `App/househelp-api/internal/booking/repository.go:561-597` (`GetHelperActiveBookings`)

- [ ] **Step 1: Add payment columns to the list query + Scan**

In `internal/booking/repository.go`, in `GetHelperActiveBookings`, change the SELECT and Scan. Replace the query string and the `rows.Scan(...)` call with:
```go
	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at,
		        COALESCE(pro_earnings_paise, 0), payment_status, payment_method, wallet_applied_paise
		 FROM bookings
		 WHERE helper_id = $1 AND status IN ('accepted', 'in_progress')
		 ORDER BY updated_at DESC
		 LIMIT 50`,
		helperID,
	)
```
and the scan loop body:
```go
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID,
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.AmountPaise,
			&b.PromoCode, &b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt,
			&b.ProEarningsPaise, &b.PaymentStatus, &b.PaymentMethod, &b.WalletAppliedPaise); err != nil {
			return nil, fmt.Errorf("scan helper active booking: %w", err)
		}
		bookings = append(bookings, b)
	}
```
(Note: this query never selects `start_otp`/`end_otp`, so the list cannot leak codes. `StartOTP`/`EndOTP` stay nil → omitted by `omitempty`.)

- [ ] **Step 2: Build**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api && go build ./...
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add App/househelp-api/internal/booking/repository.go
git commit -m "feat(booking): expose payment_status + wallet_applied on pro active list"
```

---

## Task 4: START OTP verification

**Files:**
- Modify: `App/househelp-api/internal/booking/service.go` (error sentinels near `ErrJobNotInState`; rewrite `StartBooking` at 2040-2073)
- Test: `App/househelp-api/internal/booking/otp_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/booking/otp_test.go`:
```go
// StartBooking requires the correct START OTP. Wrong code → no transition,
// attempt counter increments. Right code → in_progress + start_verified_at set.
func TestStartBooking_OTPGate(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "start-cust")
	helper := makeUUID(t, "start-pro")
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	// Move to 'accepted' with this helper assigned (start precondition).
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='accepted', accepted_at=now() WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set accepted: %v", err)
	}
	var code string
	if err := pool.QueryRow(ctx, `SELECT start_otp FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&code); err != nil {
		t.Fatalf("read start_otp: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	// Wrong OTP → ErrInvalidOTP, status unchanged, attempts incremented.
	wrong := "0000"
	if code == "0000" {
		wrong = "1111"
	}
	if err := svc.StartBooking(ctx, bookingID, helper, wrong); err != ErrInvalidOTP {
		t.Fatalf("wrong otp err = %v, want ErrInvalidOTP", err)
	}
	var status string
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT status, start_otp_attempts FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &attempts); err != nil {
		t.Fatalf("read after wrong: %v", err)
	}
	if status != "accepted" || attempts != 1 {
		t.Fatalf("after wrong otp: status=%s attempts=%d, want accepted/1", status, attempts)
	}

	// Correct OTP → in_progress, start_verified_at set.
	if err := svc.StartBooking(ctx, bookingID, helper, code); err != nil {
		t.Fatalf("correct otp StartBooking: %v", err)
	}
	var verified *string
	if err := pool.QueryRow(ctx, `SELECT status, start_verified_at::text FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &verified); err != nil {
		t.Fatalf("read after correct: %v", err)
	}
	if status != "in_progress" || verified == nil {
		t.Fatalf("after correct otp: status=%s verified=%v, want in_progress/non-nil", status, verified)
	}
}
```

- [ ] **Step 2: Run it — expect failure**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestStartBooking_OTPGate -v
```
Expected: FAIL — `ErrInvalidOTP undefined` and/or `StartBooking` arg count mismatch.

- [ ] **Step 3: Add error sentinels**

In `internal/booking/service.go`, find the line declaring `ErrJobNotInState` (search `ErrJobNotInState =`) and add beside it:
```go
	// ErrInvalidOTP — the supplied booking OTP did not match. Handler maps to 400.
	ErrInvalidOTP = errors.New("invalid otp")
	// ErrPaymentRequired — completion attempted on an unpaid booking. Handler maps to 409.
	ErrPaymentRequired = errors.New("payment required")
)
```
(If `ErrJobNotInState` is a standalone `var ... = errors.New(...)`, convert the group to a `var ( ... )` block containing all three. Ensure `"crypto/subtle"` is in the import block — add it if missing.)

- [ ] **Step 4: Rewrite StartBooking**

In `internal/booking/service.go`, replace the entire `StartBooking` function (2040-2073) with:
```go
func (s *Service) StartBooking(ctx context.Context, bookingID, helperID, otp string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("start booking begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	var (
		customerID string
		startOTP   string
		status     string
	)
	if err := tx.QueryRow(ctx,
		`SELECT customer_id::text, start_otp, status
		   FROM bookings WHERE id = $1 AND helper_id = $2 FOR UPDATE`,
		bookingID, helperID,
	).Scan(&customerID, &startOTP, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotInState // not this pro's job, or gone
		}
		return fmt.Errorf("load booking for start: %w", err)
	}
	if status != string(StatusAccepted) {
		return ErrJobNotInState
	}

	// Count every attempt for audit (committed even on mismatch). No hard
	// lockout — a typo must not strand a pro mid-job (spec §10).
	if _, err := tx.Exec(ctx,
		`UPDATE bookings SET start_otp_attempts = start_otp_attempts + 1, updated_at = NOW() WHERE id = $1`,
		bookingID,
	); err != nil {
		return fmt.Errorf("bump start otp attempts: %w", err)
	}
	if subtle.ConstantTimeCompare([]byte(startOTP), []byte(otp)) != 1 {
		if cErr := tx.Commit(ctx); cErr != nil {
			return fmt.Errorf("commit start otp attempt: %w", cErr)
		}
		return ErrInvalidOTP
	}

	if _, err := tx.Exec(ctx,
		`UPDATE bookings
		    SET status = 'in_progress', started_at = NOW(), start_verified_at = NOW(), updated_at = NOW()
		  WHERE id = $1`,
		bookingID,
	); err != nil {
		return fmt.Errorf("transition to in_progress: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit start: %w", err)
	}

	s.analytics.Track(ctx, analytics.EventBookingStarted, helperID, bookingID, nil)
	s.fireWebhook(ctx, webhooks.EventOrderStarted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusInProgress)))
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "job_started",
			"booking_id": bookingID,
		})
	}
	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking started (in_progress)")
	return nil
}
```

- [ ] **Step 5: Run the test — expect PASS**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestStartBooking_OTPGate -v
```
Expected: PASS. (Build will fail elsewhere because the handler still calls `StartBooking` with 3 args — fixed in Task 7. Run only this test now; do not `go build ./...` yet.)

- [ ] **Step 6: Commit**

```bash
git add App/househelp-api/internal/booking/service.go App/househelp-api/internal/booking/otp_test.go
git commit -m "feat(booking): verify START OTP on job start"
```

---

## Task 5: END OTP + payment gate on completion

**Files:**
- Modify: `App/househelp-api/internal/booking/service.go` (`CompleteBooking` at 2288; new `gateCompletion` helper)
- Test: `App/househelp-api/internal/booking/otp_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/booking/otp_test.go`:
```go
// CompleteBooking gates on payment THEN END OTP. Unpaid → ErrPaymentRequired
// (even with a correct-looking code). Paid + wrong → ErrInvalidOTP. Paid +
// right → completed.
func TestCompleteBooking_PaymentAndOTPGate(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "cmp-cust")
	helper := makeUUID(t, "cmp-pro")
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='in_progress', started_at=now(),
		        payment_method='cod' WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set in_progress cod unpaid: %v", err)
	}
	var code string
	if err := pool.QueryRow(ctx, `SELECT end_otp FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&code); err != nil {
		t.Fatalf("read end_otp: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	// Unpaid → ErrPaymentRequired regardless of code.
	if err := svc.CompleteBooking(ctx, bookingID, helper, code); err != ErrPaymentRequired {
		t.Fatalf("unpaid complete err = %v, want ErrPaymentRequired", err)
	}

	// Mark paid.
	if _, err := pool.Exec(ctx, `UPDATE bookings SET payment_status='paid' WHERE id=$1::uuid`, bookingID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	// Paid + wrong → ErrInvalidOTP.
	wrong := "0000"
	if code == "0000" {
		wrong = "1111"
	}
	if err := svc.CompleteBooking(ctx, bookingID, helper, wrong); err != ErrInvalidOTP {
		t.Fatalf("paid+wrong err = %v, want ErrInvalidOTP", err)
	}
	// Paid + right → completed.
	if err := svc.CompleteBooking(ctx, bookingID, helper, code); err != nil {
		t.Fatalf("paid+right complete: %v", err)
	}
	var status string
	var endVerified *string
	if err := pool.QueryRow(ctx, `SELECT status, end_verified_at::text FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &endVerified); err != nil {
		t.Fatalf("read after complete: %v", err)
	}
	if status != "completed" || endVerified == nil {
		t.Fatalf("after complete: status=%s endVerified=%v, want completed/non-nil", status, endVerified)
	}
}
```

- [ ] **Step 2: Run it — expect failure**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestCompleteBooking_PaymentAndOTPGate -v
```
Expected: FAIL — `CompleteBooking` arg count mismatch.

- [ ] **Step 3: Add the gateCompletion helper**

In `internal/booking/service.go`, add a new method directly above `CompleteBooking`:
```go
// gateCompletion enforces, in its own short tx, the completion preconditions:
// the caller owns the in_progress job, payment is settled, and the END OTP
// matches. The attempt counter is bumped for audit (committed even on a
// mismatch). Returns nil only when the caller may proceed to complete. The
// main completion tx re-guards status='in_progress', so the tiny gap between
// this tx and that one is safe (payment can't un-settle; a status change just
// yields ErrJobNotInState there).
func (s *Service) gateCompletion(ctx context.Context, bookingID, helperID, otp string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("gate completion begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	var (
		status        string
		paymentStatus *string
		endOTP        string
	)
	if err := tx.QueryRow(ctx,
		`SELECT status, payment_status, end_otp
		   FROM bookings WHERE id = $1 AND helper_id = $2 FOR UPDATE`,
		bookingID, helperID,
	).Scan(&status, &paymentStatus, &endOTP); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotInState
		}
		return fmt.Errorf("load booking for completion gate: %w", err)
	}
	if status != string(StatusInProgress) {
		return ErrJobNotInState
	}
	if paymentStatus == nil || *paymentStatus != "paid" {
		return ErrPaymentRequired
	}
	if _, err := tx.Exec(ctx,
		`UPDATE bookings SET end_otp_attempts = end_otp_attempts + 1, updated_at = NOW() WHERE id = $1`,
		bookingID,
	); err != nil {
		return fmt.Errorf("bump end otp attempts: %w", err)
	}
	if subtle.ConstantTimeCompare([]byte(endOTP), []byte(otp)) != 1 {
		if cErr := tx.Commit(ctx); cErr != nil {
			return fmt.Errorf("commit end otp attempt: %w", cErr)
		}
		return ErrInvalidOTP
	}
	if _, err := tx.Exec(ctx,
		`UPDATE bookings SET end_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
		bookingID,
	); err != nil {
		return fmt.Errorf("stamp end_verified_at: %w", err)
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 4: Wire the gate + new signature into CompleteBooking**

In `internal/booking/service.go`, change the `CompleteBooking` signature and add the gate call as the first statements. Replace:
```go
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID string) error {
	txCtx, txCancel := context.WithTimeout(ctx, 5*time.Second)
```
with:
```go
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID, otp string) error {
	// Payment + END OTP gate (own tx). Must pass before any completion work.
	if err := s.gateCompletion(ctx, bookingID, helperID, otp); err != nil {
		return err
	}

	txCtx, txCancel := context.WithTimeout(ctx, 5*time.Second)
```
(The rest of `CompleteBooking` is unchanged — it already re-guards `status='in_progress'` in its UPDATE.)

- [ ] **Step 5: Run the test — expect PASS**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestCompleteBooking_PaymentAndOTPGate -v
```
Expected: PASS. (Do not `go build ./...` yet — handler still calls old signature; fixed in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add App/househelp-api/internal/booking/service.go App/househelp-api/internal/booking/otp_test.go
git commit -m "feat(booking): payment + END OTP gate on completion"
```

---

## Task 6: CollectCash service method

**Files:**
- Modify: `App/househelp-api/internal/booking/service.go` (new `CollectCash`)
- Test: `App/househelp-api/internal/booking/otp_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/booking/otp_test.go`:
```go
// CollectCash flips a COD in_progress booking to paid, writes a cash payment
// row for the outstanding net, and emits booking.paid. END OTP then becomes
// visible to the customer.
func TestCollectCash(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "cash-cust")
	helper := makeUUID(t, "cash-pro")
	// net = amount(10000) - discount(0) - wallet_applied(2000) = 8000
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='in_progress', started_at=now(),
		        payment_method='cod', wallet_applied_paise=2000 WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set in_progress cod: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	outstanding, err := svc.CollectCash(ctx, bookingID, helper)
	if err != nil {
		t.Fatalf("CollectCash: %v", err)
	}
	if outstanding != 0 {
		t.Fatalf("returned outstanding = %d, want 0", outstanding)
	}

	var payStatus string
	if err := pool.QueryRow(ctx, `SELECT payment_status FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&payStatus); err != nil {
		t.Fatalf("read payment_status: %v", err)
	}
	if payStatus != "paid" {
		t.Fatalf("payment_status = %s, want paid", payStatus)
	}

	var cashAmt int64
	if err := pool.QueryRow(ctx,
		`SELECT amount_paise FROM payments WHERE booking_id=$1::uuid AND gateway='cash' AND gateway_status='success'`,
		bookingID).Scan(&cashAmt); err != nil {
		t.Fatalf("read cash payment row: %v", err)
	}
	if cashAmt != 8000 {
		t.Fatalf("cash amount = %d, want 8000 (net of wallet)", cashAmt)
	}

	var evtCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM event_outbox WHERE event_type='booking.paid' AND aggregate_id=$1::uuid`,
		bookingID).Scan(&evtCount); err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	if evtCount != 1 {
		t.Fatalf("booking.paid events = %d, want 1", evtCount)
	}

	// Second call is a no-op error (already paid).
	if _, err := svc.CollectCash(ctx, bookingID, helper); err == nil {
		t.Fatalf("second CollectCash should error (already paid)")
	}
}
```
Add the cash-payments cleanup to `seedPendingBooking`'s `t.Cleanup` if not already covered — it already runs `DELETE FROM payments WHERE booking_id=...` and `DELETE FROM event_outbox` is NOT in it, so also clean the outbox: in `seedPendingBooking`'s cleanup block, add `ex(\`DELETE FROM event_outbox WHERE aggregate_id = $1::uuid\`, bookingID)`.

- [ ] **Step 2: Run it — expect failure**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestCollectCash -v
```
Expected: FAIL — `svc.CollectCash undefined`.

- [ ] **Step 3: Implement CollectCash**

In `internal/booking/service.go`, add (near the other payment helpers like `stampBookingCOD`):
```go
// CollectCash records that the pro collected the outstanding net in cash for a
// COD booking: it flips payment_status to 'paid' (method stays 'cod'), writes a
// cash payments row for audit/reconciliation (C2 ledger), and emits
// booking.paid — all in one tx. This unlocks the END OTP for the customer.
// Returns the remaining outstanding (always 0 on success).
func (s *Service) CollectCash(ctx context.Context, bookingID, helperID string) (int64, error) {
	var net int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var (
			customerID    string
			status        string
			method        *string
			paymentStatus *string
			amount        int64
			discount      int64
			walletApplied int64
		)
		if err := tx.QueryRow(ctx,
			`SELECT customer_id::text, status, payment_method, payment_status,
			        amount_paise, discount_paise, wallet_applied_paise
			   FROM bookings WHERE id = $1 AND helper_id = $2 FOR UPDATE`,
			bookingID, helperID,
		).Scan(&customerID, &status, &method, &paymentStatus, &amount, &discount, &walletApplied); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrJobNotInState
			}
			return fmt.Errorf("load booking for collect-cash: %w", err)
		}
		if status != string(StatusInProgress) {
			return ErrJobNotInState
		}
		if method == nil || *method != "cod" {
			return fmt.Errorf("collect-cash: booking is not COD")
		}
		if paymentStatus != nil && *paymentStatus == "paid" {
			return fmt.Errorf("collect-cash: booking already paid")
		}

		net = amount - discount - walletApplied
		if net < 0 {
			net = 0
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_status, webhook_received_at, reconciled)
			VALUES ($1::uuid, $2::uuid, $3, 'cash', 'success', NOW(), TRUE)
		`, bookingID, customerID, net); err != nil {
			return fmt.Errorf("insert cash payment row: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bookings SET payment_status = 'paid', updated_at = NOW() WHERE id = $1::uuid
		`, bookingID); err != nil {
			return fmt.Errorf("stamp booking paid (cash): %w", err)
		}

		payload, mErr := json.Marshal(map[string]any{
			"booking_id":   bookingID,
			"user_id":      customerID,
			"amount_paise": net,
			"gateway":      "cash",
			"paid_at":      time.Now().UTC().Format(time.RFC3339),
		})
		if mErr != nil {
			return fmt.Errorf("marshal booking.paid (cash): %w", mErr)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO event_outbox (event_type, aggregate_id, payload)
			VALUES ('booking.paid', $1::uuid, $2::jsonb)
		`, bookingID, payload); err != nil {
			return fmt.Errorf("emit booking.paid (cash): %w", err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Int64("cash_paise", net).Msg("cash collected (cod marked paid)")
	return 0, nil
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run TestCollectCash -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/booking/service.go App/househelp-api/internal/booking/otp_test.go
git commit -m "feat(booking): CollectCash marks COD paid + writes cash payment row"
```

---

## Task 7: Wire handlers + routes

**Files:**
- Modify: `App/househelp-api/internal/booking/jobs.go` (Start/Complete bodies parse `otp`; new `CollectCash` handler + route; error mapping)

- [ ] **Step 1: Add the collect-cash route**

In `internal/booking/jobs.go`, in `RegisterRoutes` (74-86), add after the `complete` line:
```go
	r.Post("/:id/collect-cash", h.CollectCash)
```

- [ ] **Step 2: Rewrite the Start handler to parse + map OTP errors**

Replace the `Start` handler (176-189) with:
```go
func (h *JobsHandler) Start(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req struct {
		OTP string `json:"otp"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if err := h.service.StartBooking(c.UserContext(), bookingID, helperID, req.OTP); err != nil {
		switch {
		case errors.Is(err, ErrInvalidOTP):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "incorrect OTP", "code": "invalid_otp"})
		case errors.Is(err, ErrJobNotInState):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		default:
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
	}
	return c.JSON(fiber.Map{"message": "in_progress"})
}
```

- [ ] **Step 3: Rewrite the Complete handler**

Replace the `Complete` handler (191-216) with:
```go
func (h *JobsHandler) Complete(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req struct {
		OTP string `json:"otp"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if err := h.service.CompleteBooking(c.UserContext(), bookingID, helperID, req.OTP); err != nil {
		switch {
		case errors.Is(err, ErrInvalidOTP):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "incorrect OTP", "code": "invalid_otp"})
		case errors.Is(err, ErrPaymentRequired):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "payment required", "code": "payment_required"})
		case errors.Is(err, ErrJobNotInState):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		default:
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
	}
	var earnings int64
	var actualMin int
	_ = h.service.db.QueryRow(c.UserContext(),
		`SELECT COALESCE(pro_earnings_paise, 0), COALESCE(actual_duration_minutes, 0)
		   FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&earnings, &actualMin)
	return c.JSON(fiber.Map{
		"message":                 "completed",
		"pro_earnings_paise":      earnings,
		"actual_duration_minutes": actualMin,
	})
}
```

- [ ] **Step 4: Add the CollectCash handler**

In `internal/booking/jobs.go`, add after `Complete`:
```go
func (h *JobsHandler) CollectCash(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	outstanding, err := h.service.CollectCash(c.UserContext(), bookingID, helperID)
	if err != nil {
		if errors.Is(err, ErrJobNotInState) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"message": "cash_collected", "outstanding_paise": outstanding})
}
```

- [ ] **Step 5: Full build + full booking test run + vet**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
go build ./... && go vet ./internal/booking/ && \
TEST_DATABASE_URL='postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable' \
go test ./internal/booking/ -run 'TestGetBookingByID_OTPExposure|TestStartBooking_OTPGate|TestCompleteBooking_PaymentAndOTPGate|TestCollectCash' -v
```
Expected: build succeeds, all four tests PASS.

- [ ] **Step 6: Commit**

```bash
git add App/househelp-api/internal/booking/jobs.go
git commit -m "feat(booking): OTP body + payment-gate error mapping + collect-cash route"
```

---

## Task 8: Customer app — server OTP, END card, nudge

**Files:**
- Modify: `App/zopmop-app/src/api/matching.ts:69-103` (`BookingDetail`)
- Modify: `App/zopmop-app/src/screens/main/TrackLiveScreen.tsx`

- [ ] **Step 1: Extend the BookingDetail type**

In `src/api/matching.ts`, inside `export interface BookingDetail`, add after `free_cancel_until?: string;`:
```ts
  /** Server-issued START OTP (always present for the customer). */
  otp?: string;
  /** Server-issued END OTP — present only once payment_status==='paid'. */
  end_otp?: string;
  payment_status?: string;
  payment_method?: string;
  wallet_applied_paise?: number;
```

- [ ] **Step 2: Replace deriveOtp with the server value**

In `src/screens/main/TrackLiveScreen.tsx`:

(a) Delete the `deriveOtp` function (1121-1128).

(b) Replace the `displayOtp` line (402) with a server-backed START OTP:
```tsx
  const startOtp = detail?.otp ?? '';
```

(c) In the START OTP card JSX (713-731), replace `displayOtp.split('')` with `startOtp.split('')`, and change the visibility guard so START shows from en-route onward through the job (spec §4b):
```tsx
{!!startOtp && (subState === 'en_route' || subState === 'arrived' || subState === 'in_progress') && (
  <View style={styles.otp}>
    <View style={{ flex: 1 }}>
      <Text style={[fontBold, styles.otpLabel]}>START OTP</Text>
      <Text style={[fontMed, styles.otpHelp]}>
        {helperName
          ? `Share with ${helperName.split(' ')[0]} when they arrive`
          : 'Share this code with your pro when they arrive'}
      </Text>
    </View>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {startOtp.split('').map((d, i) => (
        <View key={i} style={styles.otpDigit}>
          <Text style={[fontMono, styles.otpDigitText]}>{d}</Text>
        </View>
      ))}
    </View>
  </View>
)}
```

- [ ] **Step 3: Add the END OTP card + the pay-online nudge**

Still in `TrackLiveScreen.tsx`, compute the paid flag + outstanding near `startOtp`:
```tsx
  const isPaid = detail?.payment_status === 'paid';
  const endOtp = detail?.end_otp ?? '';
  const outstandingPaise = detail
    ? Math.max(0, (detail.price_paise ?? 0) - (detail.discount_paise ?? 0) - (detail.wallet_applied_paise ?? 0))
    : 0;
  const isActive = subState !== 'completed' && subState !== 'cancelled' && subState !== 'no_pro_available';
```

Add the `useCashfreePayment` hook + the order helper at the top of the component (mirroring existing usage — import `useCashfreePayment` from `'../../hooks/useCashfreePayment'`, `createCashfreeOrder` from `'../../api/payments'`, and the auth token the screen already uses):
```tsx
  const { startPayment } = useCashfreePayment();
  const [paying, setPaying] = useState(false);

  const payOnline = useCallback(async () => {
    if (!bookingId || paying) return;
    setPaying(true);
    try {
      const order = await createCashfreeOrder(token, { booking_id: bookingId, payment_source: 'direct' });
      await startPayment({
        payment_session_id: order.payment_session_id,
        order_id: order.order_id,
        on_success: () => { refetch(); },        // re-pull detail; END OTP appears
        on_failure: () => { /* sheet closed / failed — no-op */ },
      });
    } catch {
      // order creation failed — leave nudge in place
    } finally {
      setPaying(false);
    }
  }, [bookingId, paying, token, startPayment, refetch]);
```
(Use the screen's existing detail-refetch function in place of `refetch` — confirm its name by grepping the file for the function passed to the polling/`useEffect`; it is the function that calls `getBookingDetail`.)

Render the END card + nudge in the same region as the START card:
```tsx
{isActive && !isPaid && (
  <Pressable style={styles.payNudge} onPress={payOnline} disabled={paying}>
    <View style={styles.payNudgeIcon}>
      <Text style={[fontBold, styles.payNudgeRupee]}>₹</Text>
    </View>
    <Text style={[fontMed, styles.payNudgeText]}>
      {`Pay ₹${(outstandingPaise / 100).toFixed(0)} online to avoid cash handling`}
    </Text>
    <Text style={[fontMed, styles.payNudgeChevron]}>›</Text>
  </Pressable>
)}

{isPaid && !!endOtp && subState === 'in_progress' && (
  <View style={styles.otp}>
    <View style={{ flex: 1 }}>
      <Text style={[fontBold, styles.otpLabel]}>END OTP</Text>
      <Text style={[fontMed, styles.otpHelp]}>Share when the job is done to finish</Text>
    </View>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {endOtp.split('').map((d, i) => (
        <View key={i} style={styles.otpDigit}>
          <Text style={[fontMono, styles.otpDigitText]}>{d}</Text>
        </View>
      ))}
    </View>
  </View>
)}
```

Add the nudge styles to the screen's `StyleSheet.create({...})` (match existing card tokens — reuse the same color/spacing constants the file already imports; ZopMop accent, not Toing green):
```tsx
  payNudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFF7E6',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  payNudgeIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#F5A300',
    alignItems: 'center', justifyContent: 'center',
  },
  payNudgeRupee: { color: '#FFFFFF', fontSize: 15 },
  payNudgeText: { flex: 1, color: '#7A5A00', fontSize: 13 },
  payNudgeChevron: { color: '#B07A00', fontSize: 20 },
```

- [ ] **Step 4: Typecheck**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app && npx tsc --noEmit
```
Expected: no errors. (If `createCashfreeOrder`/`useCashfreePayment` import paths differ, fix per the actual file locations: `src/api/payments.ts`, `src/hooks/useCashfreePayment.ts`.)

- [ ] **Step 5: Commit**

```bash
git add App/zopmop-app/src/api/matching.ts App/zopmop-app/src/screens/main/TrackLiveScreen.tsx
git commit -m "feat(app): server START/END OTP + pay-online nudge on TrackLive"
```

---

## Task 9: Pro API client — OTP args + collect-cash

**Files:**
- Modify: `App/zopmop-app/src/api/jobs.ts:52-78`
- Modify: the pro job-detail type (grep first — Step 1)

- [ ] **Step 1: Locate the pro detail fetch + type**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app
grep -rn "export async function getJobDetail" src/api
grep -rn "interface JobDetail" src/screens/pro/JobDetailScreen.tsx
```
Note the endpoint `getJobDetail` calls (expected `GET /bookings/:id`). The backend now returns `payment_status`, `payment_method`, `wallet_applied_paise`, `price_paise`, `discount_paise` on that payload (Task 2).

- [ ] **Step 2: jobStart / jobComplete take an OTP; add jobCollectCash**

In `src/api/jobs.ts`, replace `jobStart` and `jobComplete` (70-78) with:
```ts
export async function jobStart(bookingID: string, otp: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp }),
  });
  await expectOk<{ message: string }>(res, 'start job');
}

export async function jobComplete(bookingID: string, otp: string): Promise<CompleteJobResponse> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp }),
  });
  return expectOk<CompleteJobResponse>(res, 'complete job');
}

export async function jobCollectCash(bookingID: string): Promise<{ outstanding_paise: number }> {
  const res = await apiFetch(`${BASE_URL}/pro/jobs/${bookingID}/collect-cash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return expectOk<{ outstanding_paise: number }>(res, 'collect cash');
}
```

- [ ] **Step 3: Add payment fields to the pro JobDetail type**

In `src/screens/pro/JobDetailScreen.tsx`, inside `interface JobDetail` (46-60), add:
```ts
  payment_status?: string;
  payment_method?: string;
  price_paise?: number;
  discount_paise?: number;
  wallet_applied_paise?: number;
```
And if `getJobDetail`'s return type (in `src/api/pro.ts` or wherever Step 1 found it) is an explicit intersection, add the same five optional fields there.

- [ ] **Step 4: Typecheck (will flag the screen's now-wrong call sites — fixed in Task 10)**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app && npx tsc --noEmit 2>&1 | head -20
```
Expected: errors ONLY at `jobStart(bookingID)` / `jobComplete(bookingID)` call sites in `JobDetailScreen.tsx` (missing `otp` arg). These are resolved in Task 10.

- [ ] **Step 5: Commit**

```bash
git add App/zopmop-app/src/api/jobs.ts App/zopmop-app/src/screens/pro/JobDetailScreen.tsx
git commit -m "feat(app): pro job API takes OTP + collect-cash client"
```

---

## Task 10: Pro JobDetail — OTP sheet, awaiting-payment, collect-cash, poll

**Files:**
- Create: `App/zopmop-app/src/components/OtpSheet.tsx`
- Modify: `App/zopmop-app/src/screens/pro/JobDetailScreen.tsx`
- Modify: `App/zopmop-app/src/i18n/en.ts` (+ hi.ts, bn.ts) — new jobDetail strings

- [ ] **Step 1: Build the reusable OTP entry sheet**

Create `src/components/OtpSheet.tsx` (RN `Modal` slide pattern from `SettlementModal.tsx`; 4-box input pattern from `OTPVerificationScreen.tsx`, fixed to 4 digits):
```tsx
import React, { useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native';

const OTP_LEN = 4;

interface Props {
  visible: boolean;
  title: string;
  cta: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (otp: string) => void;
  onClose: () => void;
}

export function OtpSheet({ visible, title, cta, busy, error, onSubmit, onClose }: Props) {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const refs = useRef<(TextInput | null)[]>([]);

  function reset() {
    setDigits(Array(OTP_LEN).fill(''));
    onClose();
  }
  function change(i: number, text: string) {
    const cleaned = text.replace(/\D/g, '');
    if (cleaned.length === OTP_LEN) {
      setDigits(cleaned.split(''));
      refs.current[OTP_LEN - 1]?.focus();
      return;
    }
    const d = cleaned.slice(-1);
    if (!d) return;
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (i < OTP_LEN - 1) refs.current[i + 1]?.focus();
  }
  function keyPress(i: number, key: string) {
    if (key === 'Backspace' && !digits[i] && i > 0) {
      const next = [...digits];
      next[i - 1] = '';
      setDigits(next);
      refs.current[i - 1]?.focus();
    }
  }

  const code = digits.join('');
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={reset}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={{ flex: 1 }} onPress={reset} />
        <View style={s.sheet} onStartShouldSetResponder={() => true}>
          <View style={s.handle} />
          <Text style={s.title}>{title}</Text>
          <View style={s.row}>
            {digits.map((d, i) => (
              <TextInput
                key={i}
                ref={(r) => { refs.current[i] = r; }}
                style={[s.box, d ? s.boxFilled : null, error ? s.boxError : null]}
                value={d}
                onChangeText={(t) => change(i, t)}
                onKeyPress={({ nativeEvent }) => keyPress(i, nativeEvent.key)}
                keyboardType="number-pad"
                maxLength={OTP_LEN}
                selectTextOnFocus
                autoFocus={i === 0}
              />
            ))}
          </View>
          {!!error && <Text style={s.error}>{error}</Text>}
          <Pressable
            style={[s.cta, (code.length < OTP_LEN || busy) ? s.ctaDisabled : null]}
            disabled={code.length < OTP_LEN || busy}
            onPress={() => onSubmit(code)}
          >
            <Text style={s.ctaText}>{cta}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const BOX = 52;
const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32 },
  handle: { width: 40, height: 4, backgroundColor: '#E2E2E2', borderRadius: 999, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  box: { width: BOX, height: BOX + 8, borderRadius: 12, borderWidth: 1.5, borderColor: '#E2E2E2', textAlign: 'center', fontSize: 24, fontWeight: '700', color: '#1A1A1A' },
  boxFilled: { borderColor: '#F5A300', backgroundColor: 'rgba(245,163,0,0.12)' },
  boxError: { borderColor: '#E5484D', backgroundColor: '#FFF0F0' },
  error: { color: '#E5484D', fontSize: 13, marginTop: 10, textAlign: 'center' },
  cta: { backgroundColor: '#F5A300', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
```

- [ ] **Step 2: Add i18n strings**

In `src/i18n/en.ts`, inside the `jobDetail:` object, add:
```ts
    startOtpTitle: 'Enter the customer’s START OTP',
    startOtpCta: 'Verify & start',
    endOtpTitle: 'Enter the customer’s END OTP',
    endOtpCta: 'Verify & finish',
    otpWrong: 'Incorrect OTP. Ask the customer to read it again.',
    awaitingPaymentTitle: 'Awaiting payment',
    awaitingPaymentBody: 'Customer hasn’t paid yet. Collect cash, or wait for them to pay online.',
    collectCash: 'Collect ₹{amount} cash',
    collectCashConfirmTitle: 'Cash collected?',
    collectCashConfirmBody: 'Confirm you received ₹{amount} in cash. This unlocks the finish OTP.',
```
Add matching keys to `src/i18n/hi.ts` and `src/i18n/bn.ts` (translate; keep `{amount}` placeholder).

- [ ] **Step 3: Rewire the start/finish handlers + add states**

In `src/screens/pro/JobDetailScreen.tsx`:

(a) Add imports + state near the top of the component:
```tsx
import { OtpSheet } from '../../components/OtpSheet';
import { jobCollectCash } from '../../api/jobs';
```
```tsx
  const [otpMode, setOtpMode] = useState<null | 'start' | 'finish'>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const isPaid = detail?.payment_status === 'paid';
  const outstandingPaise = detail
    ? Math.max(0, (detail.price_paise ?? 0) - (detail.discount_paise ?? 0) - (detail.wallet_applied_paise ?? 0))
    : 0;
  const outstandingRupees = (outstandingPaise / 100).toFixed(0);
```

(b) Replace `tapStart` (235-258) so the button opens the OTP sheet instead of calling jobStart directly:
```tsx
  function tapStart() {
    setOtpError(null);
    setOtpMode('start');
  }

  async function submitStartOtp(otp: string) {
    if (!detail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      await jobStart(bookingID, otp);
      haptics.success();
      setOtpMode(null);
      await refresh();
    } catch (e: any) {
      if (e?.code === 'invalid_otp') setOtpError(t('jobDetail.otpWrong'));
      else { setOtpMode(null); showError(e?.message ?? t('common.error')); }
    } finally {
      setOtpBusy(false);
    }
  }
```

(c) Replace `tapFinish` (260-281): if unpaid, the finish button is replaced by the collect-cash flow (see (d)); the paid path opens the END OTP sheet:
```tsx
  function tapFinish() {
    setOtpError(null);
    setOtpMode('finish');
  }

  async function submitFinishOtp(otp: string) {
    if (!detail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      await jobComplete(bookingID, otp);
      haptics.success();
      setOtpMode(null);
      showSuccess(t('jobDetail.headerStepCompleted'));
      await refresh();
    } catch (e: any) {
      if (e?.code === 'invalid_otp') setOtpError(t('jobDetail.otpWrong'));
      else if (e?.code === 'payment_required') { setOtpMode(null); showError(t('jobDetail.awaitingPaymentBody')); }
      else { setOtpMode(null); showError(e?.message ?? t('common.error')); }
    } finally {
      setOtpBusy(false);
    }
  }

  function tapCollectCash() {
    Alert.alert(
      t('jobDetail.collectCashConfirmTitle'),
      t('jobDetail.collectCashConfirmBody', { amount: outstandingRupees }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('jobDetail.collectCash', { amount: outstandingRupees }),
          onPress: async () => {
            if (busy) return;
            setBusy(true);
            try {
              await jobCollectCash(bookingID);
              haptics.success();
              await refresh(); // payment_status flips → finish OTP sheet becomes available
            } catch (e: any) {
              showError(e?.message ?? t('common.error'));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }
```

(d) In the in-progress render branch, choose the finish CTA by payment state. Where the "Finish job" button is rendered (the `in_progress` state), replace it with:
```tsx
{isPaid ? (
  <Pressable style={styles.primaryBtn} onPress={tapFinish} disabled={busy}>
    <Text style={styles.primaryBtnText}>{t('jobDetail.finishJob')}</Text>
  </Pressable>
) : (
  <View>
    <Text style={styles.awaitingTitle}>{t('jobDetail.awaitingPaymentTitle')}</Text>
    <Text style={styles.awaitingBody}>{t('jobDetail.awaitingPaymentBody')}</Text>
    <Pressable style={styles.primaryBtn} onPress={tapCollectCash} disabled={busy}>
      <Text style={styles.primaryBtnText}>{t('jobDetail.collectCash', { amount: outstandingRupees })}</Text>
    </Pressable>
  </View>
)}
```
(Reuse the screen's existing primary-button style names; if they differ from `primaryBtn`/`primaryBtnText`, match the file's actual finish-button styles. Add `awaitingTitle`/`awaitingBody` to the screen's StyleSheet — a bold 15px and a muted 13px text.)

(e) Render the sheet once near the end of the component's return:
```tsx
<OtpSheet
  visible={otpMode !== null}
  title={otpMode === 'start' ? t('jobDetail.startOtpTitle') : t('jobDetail.endOtpTitle')}
  cta={otpMode === 'start' ? t('jobDetail.startOtpCta') : t('jobDetail.endOtpCta')}
  busy={otpBusy}
  error={otpError}
  onSubmit={otpMode === 'start' ? submitStartOtp : submitFinishOtp}
  onClose={() => { setOtpMode(null); setOtpError(null); }}
/>
```

- [ ] **Step 4: Poll while awaiting payment (DEV-2)**

In `JobDetailScreen.tsx`, add an effect so the screen flips live when the customer pays online (no SSE exists):
```tsx
  // While the job is in progress but unpaid, poll so the screen flips to the
  // finish-OTP path the moment the customer pays online (no payment SSE exists).
  useEffect(() => {
    if (detail?.status !== 'in_progress' || isPaid) return;
    const id = setInterval(() => { refresh(); }, 5000);
    return () => clearInterval(id);
  }, [detail?.status, isPaid, refresh]);
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Manual iOS-sim smoke (per spec §12)**

With the local stack on this branch (backend rebuilt incl. migration 144, Metro from this worktree) drive the sim:
1. Customer: confirm a COD ("Pay after") booking shows START OTP (en-route) + the "Pay ₹X online…" nudge; END OTP hidden.
2. Pro: "Start Job" → OTP sheet → enter START OTP → job goes in-progress.
3. Pro: in-progress unpaid shows "Awaiting payment" + "Collect ₹X cash".
4. Pro: "Collect cash" → confirm → customer END OTP appears, nudge gone.
5. Pro: "Finish Job" → END OTP sheet → enter END OTP → completed.
6. Repeat with pay-online: customer taps nudge → Cashfree sheet → success → END OTP appears + pro screen flips to finish within ~5s.

- [ ] **Step 7: Commit**

```bash
git add App/zopmop-app/src/components/OtpSheet.tsx App/zopmop-app/src/screens/pro/JobDetailScreen.tsx App/zopmop-app/src/i18n/en.ts App/zopmop-app/src/i18n/hi.ts App/zopmop-app/src/i18n/bn.ts
git commit -m "feat(app): pro OTP sheet, collect-cash, awaiting-payment poll"
```

---

## Final verification (before PR)

- [ ] Backend: `cd App/househelp-api && go build ./... && go vet ./internal/booking/ && TEST_DATABASE_URL=... go test ./internal/booking/... -v`
- [ ] Frontend: `cd App/zopmop-app && npx tsc --noEmit`
- [ ] Live rail matrix (HTTP layer, per the split `already_paid` lesson): paid-upfront complete; unpaid complete → 409 `payment_required`; pay-online-then-complete; collect-cash-then-complete.
- [ ] Grep assert no OTP leak to pro: `grep -n "start_otp\|end_otp" App/househelp-api/internal/booking/repository.go` shows them only in `GetBookingByID` (role-gated), never in `GetHelperActiveBookings`.
