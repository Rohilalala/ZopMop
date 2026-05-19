# ZopMop Full Audit Report

This is the index. Findings live in per-domain files. Each file follows the
strict `[SEVERITY] [FILE] [CATEGORY] Finding/Impact/Fix/Evidence` format and
is sorted by severity within its file.

For executive context, severity counts, and time estimates: see
`EXECUTIVE_SUMMARY.md`.

For launch-blocking work only: see `STORE_READINESS.md`.

For ≤30 min wins: see `QUICK_WINS.md`.

For Aditya-decision-required items: see `OPEN_QUESTIONS.md`.

---

## Index of findings files

### Backend (Go/Fiber)

- `findings/backend-security.md` (26 findings: 1 C / 4 H / 10 M / 9 L / 2 N)
  - **Top**: Google Maps key in repo (Critical), `Zop` chat unbounded user input feeding OpenRouter (High), dev-mode OTP leak via misconfigured `APP_ENV` (High), `internal/bff/admin_handler.go` returning raw `err.Error()` to clients (High), `c.Locals("userID")` drift away from the introduced constant (Medium), CORS allowlist hardening + missing `Idempotency-Key` preflight (Medium).
  - **Cleared**: SQL injection, booking/address/helper IDOR, Cashfree webhook auth, mass assignment, JWT secret-strength validators, PII masking in logs.

- `findings/auth-session.md` (21 findings: 0 C / 5 H / 7 M / 7 L / 2 N)
  - **Top**: `middleware/auth.go:139-145` JWT-claim `is_suspended` fallback regresses the A5-06 fix (High); no server-side logout / token invalidation (High); JWTs lack `jti`/`nbf`, parser lacks `WithLeeway` (High); `SecureStore` Android default options (High); Firebase silent-refresh race producing two valid JWTs (High).
  - **Route map verified**: every `/api/v1/*` route runs through `authMiddleware`. One documented public exception: `payments/cashfree/webhook` (HMAC-authed).

- `findings/rate-limiting.md` (15 findings: 0 C / 1 H / 9 M / 5 L)
  - **Top**: `/auth/firebase` has only IP-level limit (20/min); per-phone throttle missing — SMS-bombing surface unless Firebase App Check is enabled (High). Idempotency middleware only on `POST /bookings` and `/bookings/scheduled`; cancel/accept/reschedule/topup/referral-apply unguarded (Medium). 25s invite chain lacks per-pro cooldown after decline/timeout (Medium). Places autocomplete, helper-location, booking chat all uncapped per-route (Medium).

- `findings/database.md` + `findings/database-2.md` (26 findings: 2 C / 6 H / 9 M / 6 L / 3 N)
  - **Top**: `booking_services` SQL still uses `price_cents` (Critical), addresses soft-delete half-implemented (Critical), cart writer not ported to variants (High), `UpdateBookingStatus` non-transactional read-then-write race (High), FK shape regressions: `bookings.helper_id`/`pro_leaves.pro_id`/`device_tokens.worker_id` reference `users(id)` instead of `helpers(id)` (High), `wallet_transactions` lacks sign/kind CHECK constraints (High).
  - **Recurring theme**: migrations 089/090/094/095 + cart/booking writers are out of phase; the May 14 incident is one re-deploy away from repeating.

- `findings/performance.md` (26 findings: 2 C / 8 H / 9 M / 5 L / 2 N)
  - **Top**: Matching InviteChain single-instance (Critical); DB pool sized for 1 replica (Critical); `helpers:locations` Redis GEO set has no TTL (High); walking-time goroutine fan-out unbounded (High); `/services` and `/zones/check` lack caching (High); Redis pool hard-coded to 10 (High); config service no cache stampede protection (High).
  - **Load-test data cited**: phase3_geo 94.5% failure at 6157 rps; phase2 p95 1369 ms cust_book.

- `findings/code-quality.md` (28 findings: 1 C / 6 H / 11 M / 6 L / 4 N + 5 Open Q)
  - **Top**: 14 Go structs serialize `AmountPaise int` as `json:"price_cents"` (Critical); no API versioning beyond `/api/v1` (High); naming inconsistency `lat/lon` vs `lat/lng` + list envelope keys diverge (High); `internal/matching`, `internal/zop`, plus ~17 other packages have zero `*_test.go` (High); webhook payloads mislabel paise (High); `HelperBooking` TS type drifts from server payload (High).
  - **Cleared / good**: zerolog level discipline 82% correct, `fmt.Errorf("%w")` wrapping 82% adoption.

- `findings/devops.md` (24 findings: 2 C / 6 H / 9 M / 4 L / 3 N)
  - **Top**: no backup/restore runbook (Critical); no error tracking / APM anywhere (Critical); `.env.example` missing 13 vars (High); 9 in-process workers with no leader election (High); CI/CD not enforced as required-status before Railway deploy (High); Crashlytics gap (High); EAS Secrets unverified for production profile (High); `App/zopmop-app/.env` committed with PostHog token; `deploy/retention-cronjob.yaml` references binary the Dockerfile doesn't build — DPDP retention not running in prod.

### Mobile (RN / Expo)

- `findings/frontend.md` + `findings/frontend-2.md` (53 findings: 2 C / 13 H / 19 M / 12 L / 7 N)
  - **Top**: PostHog identify leaks phone PII (Critical); cross-user referral attribution via AsyncStorage (Critical); CartProvider mounted inside MainNavigator (High); request cancellation absent on all but PaymentScreen (High); Idempotency-Key attached to GETs (High); a11y gap on 20/28 screens (High); asset bloat 31 MB (High); referral screens bypass global toast system (High); PostHog autocapture surfaces address text (Medium); ProOnboarding emoji icons against convention (Low).

- `findings/ui-ux.md` (31 findings: 0 C / 9 H / 12 M / 7 L / 3 N + 5 Open Q)
  - **Top**: "ZOPMOP" all-caps wordmark in HomeFooter/ProfileScreen/WalletScreen contradicts the "ZopMop" brand spec (High); Qurova Medium font loaded but never used (High); tagline "Home, handled." only renders 12-5pm via `headlineFor()` (High); 400+ raw hex literals across 42 files instead of theme tokens (High); mascot Lottie views use `resizeMode="cover"` cropping/distorting on non-design aspect ratios (High); HomeScreen + ReferralInviteScreen missing ListEmptyComponent (High); 10 customer screens lack retry affordance (High); trust signals missing on pro cards (High).

### Cross-cutting

- `findings/bugs.md` (23 findings: 4 C / 6 H / 7 M / 3 L / 3 N)
  - **Top 4 Critical mirror the Backend/Database file**: cart broken post-095, booking_services drift, stealth bookings unacceptable, referral race.
  - **Other High**: scheduled bookings <6 h ahead orphaned between dispatchers; promo-code increment in separate tx; `slots.Service.IncrementBooking` is dead code; CRM queries filter on booking statuses that never get assigned; hardcoded referral amounts in 3 places + stale `Rs 200` comment.

- `findings/dead-code.md` (13 findings: 0 C / 0 H / 3 M / 7 L / 3 N)
  - **Top**: 6 likely-unused npm deps (Medium); "Earned ₹X" StatCard on ProDashboard contradicts the gig-worker UI purge memory (Medium); 5 roomies TODOs reference a non-existent "main wallet" (Low/process); 35 TS6133 unused locals; 11 TODO/FIXME markers; `staticcheck` not wired.

- `findings/store-readiness.md` (28 findings: 7 C / 7 H / 8 M / 6 L) + `STORE_READINESS.md` (curated checklist)
  - **Top 8 BLOCKERs**: see `STORE_READINESS.md` and `EXECUTIVE_SUMMARY.md`.

---

## Recurring themes worth resolving as a group

1. **Schema-vs-code drift on paise/cents** appears in Backend (`booking/repository.go`),
   Database (#1, #2), Code Quality (#1 — money JSON tag), Bug Hunt (#1, #2),
   and Webhooks. Fix once at the writer + DTO layer; the rest cascade.
2. **PostHog wiring** comes up in Frontend (PII leak, autocapture, error
   redaction) and DevOps (committed token in `.env`). Treat as a single
   PostHog-hardening epic.
3. **Multi-instance assumptions** come up in Performance (matching cron),
   DevOps (in-process workers, scaling plan), and Rate Limiting (Redis SETNX
   races). All point to "extract workers to a single-replica binary before
   any Railway autoscale event."
4. **No API versioning beyond the path prefix** affects Code Quality, Frontend,
   and DevOps. The right fix is a `min-required-mobile-version` server-side
   header + Force Update screen in the app.
5. **JWT hardening** spans Auth & Session (no `jti`, no revocation) +
   Backend Security (token source precedence, CSRF skip on Authorization).
   Address as a single token-lifecycle sprint.
6. **Brand consistency** + **theme adherence** comes up in UI/UX (wordmark
   casing, font load, tagline rotation, raw hex literals) and Frontend
   (component reuse, design-token discipline). One design-system enforcement
   PR can clean up dozens of findings.
7. **Account-deletion + DPDP** spans Backend (compliance handler exists, good)
   + DevOps (retention worker not actually running) + Store (privacy manifest
   incomplete) + Frontend (analytics opt-out absent). Audit as a DPDP-readiness
   project.

---

## What this audit explicitly did NOT cover

- Penetration test (no active exploitation).
- Manual UI test of every screen on real devices.
- Cross-browser CRM web-app audit (limited inspection only).
- Marketing-website (`website/`) HTML/CSS/JS — out of scope.
- Next.js rebuild (`web/`) — scaffold only.
- Real-time replication / failover of PostGIS — assumed Railway default.
- Cost-modelling under expected load — directionally addressed in performance.md.

These are reasonable next sprints once the launch-blockers and active-prod
bugs are cleared.
