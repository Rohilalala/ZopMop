# Changelog

All notable changes to this project are documented here.

## [Unreleased] — Security & Reliability Fixes

### Issue 9 — Rate Limiting Uses Fixed Window Instead of Sliding Window
- **File:** `internal/middleware/ratelimit.go`
- **Lines:** 29–86
- **Change:** Replaced the `INCR + EXPIRE` fixed-window counter with a proper sliding window algorithm using Redis sorted sets (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`) in an atomic Lua script. This prevents the bypass where `MaxRequests` at the end of one window + `MaxRequests` at the start of the next was possible.

### Issue 10 — Admin SuspendUser Returns Wrong HTTP Status
- **File:** `internal/admin/handler.go`
- **Lines:** 77–105
- **Change:** Both `SuspendUser` and `UnsuspendUser` now return **404** when the repository reports `user not found` (`RowAffected == 0`), instead of always returning 500.

### Issue 11 — No Active Booking Limit for Helpers
- **Files:** `internal/config_manager/model.go`, `internal/booking/repository.go`, `internal/booking/service.go`, `internal/booking/handler.go`
- **Lines:**
  - `internal/config_manager/model.go:27` — Added `ConfigBookingMaxActivePerHelper = "booking.max_active_per_helper"` constant
  - `internal/config_manager/model.go:53` — Added default config value for `ConfigBookingMaxActivePerHelper` (default: 3)
  - `internal/booking/repository.go:114–130` — Added `GetActiveBookingsCountForHelper` method
  - `internal/booking/service.go:182–226` — Added `AcceptBooking` method that checks helper's active booking count before assignment
  - `internal/booking/handler.go:23` — Added `POST /:id/accept` route
  - `internal/booking/handler.go:137–164` — Added `AcceptBooking` handler
- **Change:** Helpers can now only accept new bookings up to a configurable maximum (default: 3 concurrent active bookings).

### Issue 12 — Invalid Booking State Transitions Allowed
- **File:** `internal/booking/repository.go`
- **Lines:** 78–95 (refactored `UpdateBookingStatus`), 97–113 (new `isValidTransition`), 115–130 (new `AcceptBooking`), 132–157 (new `getBookingByID`)
- **Change:** Added `isValidTransition()` map enforcing allowed transitions:
  - `pending → {accepted, cancelled}`
  - `accepted → {in_progress, cancelled}`
  - `in_progress → {completed, cancelled}`
  - `completed` and `cancelled` are terminal states
  - Invalid jumps like `pending → completed` or `cancelled → accepted` are now rejected.

### Issue 13 — Content Cache Stampede Vulnerability
- **File:** `internal/content/service.go`
- **Lines:** 29–88 (refactored `GetAppHomeContent`), 90–127 (new `fetchAndCacheHomeContent`)
- **Change:** Added distributed locking via `SETNX` on `cacheKeyHome:lock` with 5s TTL. Only the lock holder fetches from DB; other goroutines wait 100ms and retry the cache, preventing simultaneous cache misses from all hitting the database.

### Issue 14 — Content JSON Schema Not Validated
- **File:** `internal/content/handler.go`
- **Lines:** 227–280 (refactored `AdminUpdateScreen`), 269–292 (new `validateScreenContentSchema`)
- **Change:** Added `validateScreenContentSchema()` that enforces the expected shape: optional string fields (`hero_title`, `hero_subtitle`, `cta_text`, `empty_state_text`) and optional `sections` array. Any arbitrary JSON that doesn't match this schema is rejected with 400.

### Issue 15 — Config Value Parsing Errors Silently Ignored
- **File:** `internal/config_manager/service.go`
- **Lines:** 110–160
- **Change:** `GetMatchingConfig` now uses defaults (from `DefaultConfigs`) for any value that fails to parse or fetch, with a warning log. Previously returned errors that callers ignored; now gracefully falls back.
- **File:** `internal/config_manager/model.go`
- **Lines:** 17–27 — Added `toFloat()` and `toInt()` helper methods on `AppConfig` to support defaults.

### Issue 16 — Booking Cancellation Window Check is Non-Blocking
- **File:** `internal/booking/service.go`
- **Lines:** 141–180
- **Change:** Added a `TODO` comment noting that a cancellation fee should be charged via the payment service when a booking is cancelled outside the free window. Previously it just logged and proceeded with no fee.

### Issue 17 — Notification Service Is Unused
- **Files:** `cmd/api/main.go`, `internal/booking/service.go`
- **Lines:**
  - `cmd/api/main.go:18` — Added import for `notification` package
  - `cmd/api/main.go:118–119` — Added `notificationService := notification.NewService()` instantiation
  - `cmd/api/main.go:121` — Passed `notificationService` to `booking.NewService`
  - `internal/booking/service.go:8` — Added import for `notification` package
  - `internal/booking/service.go:17` — Added `notifSvc *notification.Service` field to `Service` struct
  - `internal/booking/service.go:26` — Updated `NewService` signature to accept `notifSvc`
  - `internal/booking/service.go:207–214` — `AcceptBooking` now sends `NotifyBookingAccepted` to the customer
- **Change:** The notification service is now instantiated and wired into the booking service. `AcceptBooking` sends push notifications (currently a stub) to customers when their booking is accepted.
