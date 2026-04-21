# Backend Testing Report

**Project:** ZopMop / `househelp-api`  
**Report Date:** 2026-04-16  
**Scope:** Runtime/API validation, load behavior, fuzz-like input checks, and baseline test execution

## 1. Test Environment

- Backend path: `/Users/adityarohilla/Documents/ZopMop/App/househelp-api`
- Docker: `29.2.0`
- Docker Compose: `v5.0.2`
- Supporting services: PostgreSQL and Redis started successfully via `docker compose up -d postgres redis`

## 2. Automated Test Suite Status

### Command
`go test ./...`

### Result
- Command succeeded (`exit code 0`)
- All packages reported **`[no test files]`**
- Current backend has **no `_test.go` coverage**

## 3. Runtime Smoke Tests

### Initial smoke checks (running API on `localhost:8080`)
- `GET /health` → `200`
- `GET /api/v1/bookings` (no auth) → `401`
- `GET /api/v1/zones/check` (missing params) → `400`
- `POST /api/v1/auth/send-otp` (invalid JSON body) → `400`

## 4. Load & Rate-Limit Behavior

### Load Test A (public `/health`, burst)
- Requests: `400` (40 workers)
- Result: `200: 27`, `429: 373`
- Throughput: `~2588.68 RPS`
- Latency: `avg 14.28ms`, `p95 22.02ms`, `p99 30.80ms`
- Observation: Public limiter engaged rapidly (expected).

### Load Test B (after limiter cooldown, unauth protected path `/api/v1/bookings`)
- Requests: `400` (40 workers)
- Result: `401: 400`
- Throughput: `~3288.01 RPS`
- Latency: `avg 10.00ms`, `p95 16.57ms`, `p99 18.41ms`
- Observation: Auth middleware handles unauthorized bursts predictably.

### Load Test C (after auth bootstrap, authenticated `/api/v1/bookings`)
- Auth bootstrap:
  - `POST /api/v1/auth/send-otp` → `200`
  - `POST /api/v1/auth/verify-otp` → `200`
- Requests: `80` (20 workers)
- Result: `200: 80`
- Throughput: `~317.27 RPS`
- Latency: `avg 46.33ms`, `p95 207.89ms`, `p99 220.04ms`

## 5. Fuzz-Like Input Testing

## Public/auth fuzz batches
- `POST /api/v1/auth/send-otp` malformed/invalid payloads:
  - Sample run: `400`, `422`, `429` responses observed
  - `5xx`: `0` (in bounded run)
- `GET /api/v1/zones/check` random invalid lat/lon:
  - Mostly `429` due public rate limit once budget exhausted
  - `5xx`: `0`

## Authenticated path fuzz batch
- Target: `GET /api/v1/bookings/{random-id}/tracking` with valid JWT
- Batch result: `429: 20`, `500: 20`

## 6. Confirmed Defect (Reproduced)

### Issue
`GET /api/v1/bookings/{non-uuid}/tracking` returns **500 Internal Server Error** instead of a client error (4xx).

### Reproduction (post-cooldown single request)
- Authenticated request with random non-UUID booking id
- Response:
  - Status: `500`
  - Body:
    `{"error":"failed to get booking: ERROR: invalid input syntax for type uuid: \"...\" (SQLSTATE 22P02)"}`

### Impact
- Invalid user input is leaking DB error semantics and producing server-error classification.
- Expected behavior should be validation failure (`400`) or not found (`404`) with sanitized message.

## 7. Overall Assessment

- Runtime service is reachable and core middleware behavior is functional.
- Rate-limiting is active and aggressive on public paths.
- Authenticated booking list endpoint handled concurrent requests successfully.
- Major quality gap: **no automated test files** in backend.
- High-priority defect identified in booking tracking path param validation/error mapping.

## 8. Recommendations

1. Add UUID validation for booking ID path parameters in relevant handlers before DB query.
2. Map invalid ID format to `400` and avoid returning raw DB error text.
3. Introduce baseline unit/integration tests (`*_test.go`) for auth, booking, middleware, and tracking flows.
4. Add dedicated load profiles that avoid rate-limit masking when performance benchmarking.

