# ZopMop Security Audit — REPO_MAP

Built: 2026-05-21 on branch `feature/security-audit-2026-05-21` (forked from `develop`).
Shared context for Phase 1 subagents (Secrets, AuthN/Z, Input, DoS, Disclosure).
All paths relative to repo root `/Users/adityarohilla/Documents/ZopMop`.

---

## 1. Top-level layout

| Path | Purpose |
|------|---------|
| `App/househelp-api/` | Go backend (Fiber). Customer + Pro + CRM/admin APIs, workers, crons, migrations. |
| `App/zopmop-app/` | React Native customer+pro app (Expo). |
| `App/zopmop-crm/` | Vite + React admin SPA (separate hostname, talks to `cmd/crm-api`). |
| `website/` | Marketing site. |
| `web/` | Secondary web property / landing experiments. |
| `docs/` | Internal design + handoff docs. |
| `migrations/` (under househelp-api) | SQL migrations 001 → 108 (124 files). |
| `audit/` | Output of past + this audit. |
| `report/`, `.audit/`, NEEDS_REVIEW*.md, SUMMARY*.md | Historical audit artifacts. |

---

## 2. Backend entry points — `App/househelp-api/cmd/*`

| Binary | main file | Role | Public listen? | Deployed? |
|--------|-----------|------|----------------|-----------|
| `cmd/api/main.go:78` | Customer + Pro public API (Fiber on `:8080`-ish via `cfg.AppAddr`). | Yes — internet-facing. | Railway (per past memory). |
| `cmd/crm-api/main.go:107` | CRM/admin API (separate Fiber app). | Yes — admin SPA backend. | Railway. |
| `cmd/migrate/main.go` | Migration runner (`make migrate`). | No — CLI. | n/a |
| `cmd/crm-integrity/main.go` | One-shot integrity check. | No. | n/a |
| `cmd/loadseed/main.go` | Seed data. | No. | n/a |
| `cmd/promptdump/main.go` | LLM prompt dump utility. | No. | n/a |
| `cmd/retention-worker/main.go` | Background retention/purge worker. | No. | Railway worker. |
| `cmd/jsonb-scrub-backfill/main.go` | One-shot data scrub. | No. | n/a |
| `cmd/sim/main.go` | Simulator. | No. | n/a |
| `cmd/stresstest/` | Stress test harness. | No. | n/a |
| `cmd/crm-api/bootstrap/main.go` | First-admin bootstrap. | No (CLI). | n/a |

`cmd/api/pprof_dev.go` registers pprof handlers on default mux when `ENABLE_PPROF=1` (`cmd/api/main.go:136`).

---

## 3. Middleware inventory

### Customer/Pro side — `internal/middleware/`

| File | Export | Purpose |
|------|--------|---------|
| `admin_auth.go:21` | `SduiAdminAuth(rdb)` | Extra gate for SDUI admin routes. |
| `admin.go:25` | `AdminMiddleware(db, rdb)` | Loads admin perms from DB; required after auth. |
| `admin.go:108` | `RequirePermission(perm)` | Per-permission gate (mounted on admin sub-routes). |
| `auth.go:47` | `IsUnauthenticatedPath(path)` | Allow-list helper. |
| `auth.go:66` | `AuthMiddleware(jwtKeys, suspChecker)` | Verifies JWT, looks up suspension. Primary auth. |
| `auth.go:179` | `RequireUserType(expected)` | Gate on `user_type` claim (customer/pro). |
| `auth.go:195` | `AuthCustomer()` | Sugar for RequireUserType("customer"). |
| `auth.go:199` | `AuthPro()` | Sugar for RequireUserType("pro"). |
| `auth.go:209` | `RequireRole(allowed...)` | Multi-role gate. |
| `compress.go:38` | `CompressIfLarge()` | gzip response compression. |
| `concurrency.go:26` | `DBConcurrencyLimiter(max, waitTimeout)` | Caps concurrent DB-bound requests. |
| `csrf.go:30` | `CSRF(isProduction)` | CSRF token check (cookie-based). |
| `idempotency.go:47` | `Idempotency(rdb, lockTTL, respTTL)` | Idempotency keys via Redis. |
| `jwt.go:17` | `ParseJWTClaims(tokenString, keys)` | JWT validation primitive (multi-key for rotation). |
| `locals.go` | helpers — fiber locals keys. | n/a |
| `ratelimit.go:236` | `RateLimiter(rdb, cfg, keyType)` | Per-IP / per-user sliding window in Redis. |
| `ratelimit.go:243` | `NamedRateLimiter(rdb, cfg, keyType, bucket)` | Named bucket variant (used by CRM login/refresh). |
| `safego.go:10` | `SafeGo(name, fn)` | Goroutine with panic recovery. |
| `security.go:24` | `SecurityHeaders(isProduction)` | HSTS, X-Frame, CSP, etc. |
| `security.go:47` | `CORS(allowedOrigins)` | CORS origin allowlist. |
| `security.go:77` | `RequestID()` | X-Request-Id propagation. |
| `security.go:85` | `RequestLogger()` | Structured access log. |
| `timeout.go:39` | `Timeout(d)` | Per-request context timeout. |
| `timeout.go:47` | `TimeoutWithSkip(d, skip)` | Conditional timeout (skip WS upgrades). |

### CRM side — `internal/crm/middleware/`

| File | Export | Purpose |
|------|--------|---------|
| `jwt.go:36` | `JWT(cfg)` | CRM admin JWT verify (separate signing secret from customer JWT). |
| `jwt.go:107` | `RequireRole(allowed...)` | Per-role gate. |
| `jwt.go:124` | `RequirePermission(perm)` | Per-perm gate (e.g. `PermManagePayouts`). |

Other CRM `app.Use` calls live inline in `cmd/crm-api/middleware.go` (helpers: `requestID`, `securityHeaders`, `corsMiddleware`, `requestLogger`, `metricsCollector`).

---

## 4. Customer/Pro route map — `cmd/api/main.go`

Global middleware chain (applied to every request, lines 216–245):

| Order | call | line |
|-------|------|------|
| 1 | `fiberrecover.New(...)` | 216 |
| 2 | `mw.RequestID()` | 232 |
| 3 | `mw.SecurityHeaders(cfg.IsProduction())` | 233 |
| 4 | `mw.CORS(cfg.AllowedOrigins)` | 234 |
| 5 | `mw.CSRF(cfg.IsProduction())` | 235 |
| 6 | `mw.TimeoutWithSkip(DefaultRequestTimeout, skipWS)` | 239 |
| 7 | `mw.RequestLogger()` | 242 |
| 8 | `mw.CompressIfLarge()` | 245 |

Health endpoints: `app.Get("/health", publicLimiter, ...)` 256, `app.Get("/ready", publicLimiter, ...)` 264.

API base: `api := app.Group("/api/v1")` at 485.

### Public (no auth)

| Path | Middleware | Registrar | Line |
|------|-----------|-----------|------|
| `/api/v1/auth/*` | `authPublicLimiter` | `authHandler.RegisterRoutes` | 488–489 |
| `/api/v1/app/*` (content + config) | `publicLimiter` | `contentHandler.RegisterPublicRoutes`, `configHandler.RegisterPublicRoutes` | 492–494 |
| `/api/v1/bookings/track/*` (WS) | `publicLimiter` | `bookingTrackWS.RegisterTrackingWS` | 533 |
| `/api/v1/services/*` (public) | `publicLimiter`, `dbBoundLimiter` | `servicesHandler.RegisterPublicRoutes` | 544–545 |
| `/api/v1/payments/cashfree/webhook` | **none** (signature-only) | `paymentsHandler.RegisterWebhookRoutes` | 600–601 |
| `/api/v1/zones/*` (public) | `publicLimiter` | `zonesHandler.RegisterPublicRoutes` | 610–611 |
| `/api/v1/localities/*` (public) | `publicLimiter` | `localitiesHandlerPub.RegisterPublicRoutes` | 617 |
| `/api/v1/insights/*` (public) | `publicLimiter`, `dbBoundLimiter` | `insightsHandler.RegisterPublicRoutes` | 623–624 |

### Authenticated (JWT required) — `authMiddleware := mw.AuthMiddleware(jwtVerificationKeys, authRepo)` at 518

All groups below use `authMiddleware, authLimiter, dbBoundLimiter` unless noted.

| Group | Path | Extras | Registrar | Line |
|-------|------|--------|-----------|------|
| Booking | `/api/v1/bookings` | `bookingIdem`, `bookingCreateLimiter`, `proApprovedMW` | `bookingHandler.RegisterRoutes` + `reviews.NewHandler(...).RegisterRoutes` | 522–526 |
| Location | `/api/v1/location` | — | `locationHandler.RegisterRoutes` | 536–537 |
| Addresses | `/api/v1/addresses` | — | `addressHandler.RegisterRoutes` | 540–541 |
| Cart | `/api/v1/cart` | — | `cartHandler.RegisterRoutes` | 548–549 |
| Offers | `/api/v1/...` | — | `offers.NewHandler(dbPool).RegisterRoutes` | 552–553 |
| Disputes | `/api/v1/...` | — | `disputes.NewHandler(dbPool).RegisterRoutes` | 556–557 |
| Slots | `/api/v1/slots` | — | `slotsHandler.RegisterRoutes` | 560–561 |
| Zop (LLM) | `/api/v1/zop` | `Timeout(90s)`, `RequireRole("customer")` | `zopHandler.RegisterRoutes` | 580–581 |
| Places | `/api/v1/places` | (no dbBoundLimiter) | `placesHandler.RegisterRoutes` | 585–586 |
| Payments | `/api/v1/payments` | (no dbBoundLimiter) | `paymentsHandler.RegisterRoutes` | 595–596 |
| Wallet | `/api/v1/wallet` | — | `walletHandler.RegisterRoutes` | 606–607 |
| Me | `/api/v1/me` | — | `authHandler.RegisterMeRoutes` + insights + experts + referral | 627–644 |
| Referrals | `/api/v1/referrals` | — | `referralHandler.RegisterRoutes` | 645–646 |
| Devices | `/api/v1/devices` | — | `authHandler.RegisterDeviceRoutes` | 664–665 |
| Helpers | `/api/v1/helpers` | — | `helperHandler.RegisterRoutes` | 668–669 |
| Pro leave | `/api/v1/pro/leave` | — | `leaveHandler.RegisterRoutes` | 687–689 |
| Pro | `/api/v1/pro` | `RequireRole("pro"), proApprovedMW` — shifts, jobs | `shiftHandler.RegisterProRoutes` + `jobsHandler.RegisterRoutes` | 706–714 |
| Admin | `/api/v1/admin` | `adminMiddleware, adminLimiter, dbBoundLimiter` | `adminHandler` + shift + payroll + content + config + zones + analytics + services | 698–719 |
| Admin runtime | `/api/v1/admin/runtime/metrics` | `RequirePermission(PermViewAnalytics)` | inline | 720 |
| SDUI | `/api/v1/sdui` | `authMiddleware, authLimiter, dbBoundLimiter` | `bffHandler.RegisterRoutes` | 801 |
| SDUI admin | `/api/v1/admin/...` | `SduiAdminAuth(rdb)` | `bffAdminHandler.RegisterRoutes` | 806 |
| Analytics events | `/api/v1/events` | — | analytics handler | 811 |
| Analytics legacy | `/api/v1/analytics/events` | — | analytics handler | 813 |
| Roomies | `/api/v1/roomies` | — | `roomiesHandler.RegisterRoutes` | 820–821 |

Listener: `app.Listen(addr)` at 830.

---

## 5. CRM route map — `cmd/crm-api/main.go`

Global middleware (140–147):

| Order | call | line |
|-------|------|------|
| 1 | `fiberrecover.New(...)` | 140 |
| 2 | `requestID()` | 143 |
| 3 | `securityHeaders(cfg.IsProduction())` | 144 |
| 4 | `corsMiddleware(cfg.AllowedOrigins)` | 145 |
| 5 | `requestLogger()` | 146 |
| 6 | `metricsCollector.Middleware()` | 147 |

**No CSRF middleware on CRM**; the SPA is at a separate origin and uses bearer tokens. Verify in AuthN/Z subagent.

Base: `api := app.Group("/admin")` at 307.

Limiters constructed:
| Name | line | Window/limit |
|------|------|--------------|
| `crmLoginLimiter` | 320 | per-IP for `/admin/auth/login` |
| `crmRefreshLimiter` | 341 | for refresh |
| `crmAdminLimiter` | 358 | per-user across authed routes |

Route registration:

| Group | Path | Middleware | Line |
|-------|------|-----------|------|
| Public auth | `/admin/auth/*` | (limiters bound inside) | 386–387 |
| Authed root | `/admin/*` | `jwtMW, crmAdminLimiter` | 396 |
| Authed auth (sessions, totp) | `/admin/auth/*` | as above | 399–400 |
| Flags | | as above | 402 |
| Alerts | | | 403 |
| Notifications | | | 404 |
| Leaves | | | 405 |
| Dashboard | | | 406 |
| Users | | | 407 |
| Workers | | | 408 |
| Orders | | | 409 |
| Refunds | | | 410 |
| Promos | | | 411 |
| Banners | | | 412 |
| Experiments | | | 413 |
| Analytics | | | 414 |
| Growth | | | 415 |
| Zones | | | 416 |
| Localities | | | 417 |
| Payouts | | | 418 |
| Trust & safety | | | 419 |
| Platform | | | 420 |
| Health | | | 421 |
| Zone approvals | | | 422 |
| Stub enumerator | `/admin/_stub/:module` | gated by `ENABLE_STUB_ENUMERATOR=1` | 428–429 |

Listener: `app.Listen(addr)` at 442. Graceful: push scheduler stop at 459–463.

JWT middleware: `internal/crm/middleware/jwt.go:36`. Permissions enforced via `RequirePermission` inside each handler module's `RegisterRoutes`.

---

## 6. Handler domain index

### `internal/` (customer/pro side)

| Dir | Purpose | Has HTTP handlers? |
|-----|---------|--------------------|
| `addresses` | User addresses CRUD | yes |
| `admin` | Admin handlers (mounted under /api/v1/admin) | yes |
| `analytics` | Event ingestion | yes |
| `auth` | Login/OTP/JWT/session/devices | yes |
| `bff` | SDUI render | yes |
| `booking` | Booking lifecycle, tracking WS, sweepers | yes |
| `cart` | Cart CRUD | yes |
| `compliance` | DSAR / purge / retention policies | service only |
| `config_manager` | App config flags | yes |
| `content` | App content (banners etc) | yes |
| `credentials` | Loads Firebase creds from env JSON | helper |
| `crm/*` | CRM-side handlers (used by cmd/crm-api) | yes (separate binary) |
| `disputes` | Dispute CRUD | yes |
| `experts` | Expert profile | yes |
| `googlemaps` | Google Maps client wrapper | client |
| `helper` | Helper/pro profile, middleware (approved) | yes |
| `insights` | Public + me insights | yes |
| `leave` | Pro leave | yes |
| `location` | Location updates | yes |
| `matching` | Dispatch crons (Scheduled/Stealth/Rebook) | workers |
| `middleware` | All HTTP middleware (see §3) | n/a |
| `notification` | FCM push | service |
| `observability` | Sentry init | service |
| `offers` | Offers CRUD | yes |
| `outbox` | Outbox worker dispatch | worker |
| `payments` | Cashfree client + webhook + customer endpoints | yes |
| `payroll` | Payroll cycle calc, repo, service | service + admin-mounted handler |
| `places` | Google Places autocomplete proxy | yes |
| `reengagement` | Re-engagement reminders | service/worker |
| `referral` | Referral codes + redeem | yes |
| `reviews` | Booking reviews | yes |
| `roomies` | Roomies feature | yes |
| `segments` | User segments | service |
| `services` | Service catalog | yes (public + admin) |
| `shift` | Pro shift system | yes (admin + pro) |
| `slots` | Booking slots | yes |
| `users` | User CRUD | yes |
| `wallet` | Wallet balance | yes |
| `webhooks` | Outbound webhook dispatcher (NOT inbound) | worker |
| `zones` | Zones (public + admin) | yes |
| `zop` | LLM chat (OpenRouter) | yes |

### `internal/crm/` (admin side)

| Dir | Purpose |
|-----|---------|
| `alerts`, `analytics`, `audit`, `auth`, `banners`, `dashboard`, `experiments`, `flags`, `growth`, `healthmetrics`, `leaves`, `localities`, `middleware`, `notifications`, `orders`, `payouts`, `platform`, `promos`, `refunds`, `trustsafety`, `users`, `workers`, `zoneapprovals`, `zones` | each = one CRM module, mounted under `/admin/<name>` |

(`internal/crm/payroll` exists on `feature/payroll-targets-flags` branch only; not present in `develop` baseline used here.)

---

## 7. Secret / env reads

`pkg/config/config.go` (customer/pro side):

| Env var | Line | Used for |
|---------|------|----------|
| `DATABASE_URL` | 102 | Primary DB |
| `REDIS_URL` | 103 | Redis |
| `JWT_SECRET` | 111 | **Legacy** HS256 signing key (still parsed) |
| `JWT_PREVIOUS_SECRETS` | 115 | Rotation list |
| `JWT_ACCESS_SECRET` | 129 | Current access-token signing key |
| `JWT_REFRESH_SECRET` | 136 | Refresh-token signing key |
| `MESSAGECENTRAL_CUSTOMER_ID` | 140 | OTP vendor auth |
| `MESSAGECENTRAL_AUTH_TOKEN` | 141 | OTP vendor auth |
| `MESSAGECENTRAL_BASE_URL` | 142 | OTP vendor base |
| `OTP_DEV_MODE` | 146 | If true, skips real SMS — must NOT be true in prod |
| `CASHFREE_PG_APP_ID` | 148 | Cashfree creds |
| `CASHFREE_PG_SECRET_KEY` | 149 | Cashfree creds |
| `CASHFREE_PG_ENV` | 150 | sandbox/production switch |
| `CASHFREE_PG_WEBHOOK_SECRET` | 151 | Cashfree webhook signature key |
| `PUBLIC_BASE_URL` | 159 | Used in deep links |
| `ALLOWED_WEBHOOK_DOMAINS` | 171 | SSRF allowlist for outbound webhooks |
| (helpers at 418, 425) | generic getters |

`pkg/crmconfig/config.go` (CRM admin):

| Env var | Line | Used for |
|---------|------|----------|
| `DATABASE_URL` | 69 | DB |
| `CRM_DATABASE_READ_URL` | 70 | Read replica |
| `REDIS_URL` | 71 | Redis |
| `CRM_JWT_SECRET` | 78 | CRM JWT signing key (distinct from customer) |
| `CRM_JWT_PREVIOUS_SECRETS` | 90 | Rotation |
| `CRM_REFRESH_COOKIE_DOMAIN` | 83 | Refresh cookie scope |
| `APP_API_URL` | 87 | Health check target |
| `CRM_ALLOWED_ORIGINS` | 96 | CORS allowlist |
| (validation at 135) | refuses `CRM_JWT_SECRET == JWT_SECRET` — sanity check exists |

Other env reads in `internal/`:

| File:line | Var | Used for |
|-----------|-----|----------|
| `cmd/api/main.go:136` | `ENABLE_PPROF` | pprof handlers (dev only — verify prod gating) |
| `cmd/api/main.go:375` | `GOOGLE_MAPS_API_KEY` | Google Maps client |
| `cmd/api/main.go:567` | `OPENROUTER_API_KEY` | Inline pass to `zop.NewService` — read at request time? See Secrets subagent. |
| `cmd/crm-api/main.go:428` | `ENABLE_STUB_ENUMERATOR` | Dev stub enumerator gate |
| `internal/middleware/ratelimit.go:63,65` | `APP_ENV` / `ENV` | dev/prod detect |
| `internal/payments/handler.go:63,65,73,74` | `CASHFREE_BASE_URL`, `CASHFREE_ENV`, `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET` | **Second** set of Cashfree credentials — different naming from `pkg/config`. Verify whether both are used or duplicate. |
| `internal/notification/service.go:42` | `FIREBASE_CREDENTIALS_JSON` | Firebase Admin SDK JSON inline in env |
| `internal/observability/sentry.go:27,33,42,48` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE` | Sentry init |

Env templates present at repo root: `.env`, `.env.example`, `.env.local`, `.env.local.example`. Secrets subagent must enumerate which vars are referenced in code but absent from `.env.example` (and whether `.env` / `.env.local` contains real values — must NOT be committed).

---

## 8. External API integrations

| Vendor | Client init | Invocations | Auth/secret |
|--------|-------------|-------------|-------------|
| **Message Central** (OTP) | `internal/auth/messagecentral.go:69,82` (`http.Client{Timeout: mcTimeout}`) | `messagecentral.go:129` (`http.NewRequestWithContext`) | `MESSAGECENTRAL_CUSTOMER_ID` + `MESSAGECENTRAL_AUTH_TOKEN` |
| **MSG91** (deprecated) | `internal/auth/msg91_deprecated.go:43,59` | `msg91_deprecated.go:194` | unclear — verify if still wired |
| **Cashfree PG** | `internal/payments/cashfree.go:74` (`http *http.Client`) | `cashfree.go:463` | `CASHFREE_PG_APP_ID` + `CASHFREE_PG_SECRET_KEY` + webhook secret |
| **Cashfree alt** | `internal/payments/handler.go:46` (`client *http.Client`) | `handler.go:211, 268` | `CASHFREE_CLIENT_ID` + `CASHFREE_CLIENT_SECRET` (different env names) |
| **Firebase Admin** | `internal/notification/service.go:42` (`credentials.FirebaseOption`) | FCM push | `FIREBASE_CREDENTIALS_JSON` (entire JSON in env var) |
| **OpenRouter (Gemma + Llama)** | `internal/zop/service.go:253` (`httpClient *http.Client`) | `zop/service.go:907` | `OPENROUTER_API_KEY` |
| **Google Maps** | `internal/googlemaps/client.go:30` (`http *http.Client`) | `client.go:86, 170, 252, 311` | `GOOGLE_MAPS_API_KEY` |
| **Outbound webhooks (own)** | `internal/webhooks/dispatcher.go:85,102` (`client.Timeout = httpTimeout`) | `dispatcher.go:316` | Per-subscription HMAC secret |
| **Sentry** | `internal/observability/sentry.go:27` (`sentry.Init(...)`) | global | `SENTRY_DSN` |
| **CRM → App health** | `internal/crm/healthmetrics/handler.go:50` | health check | none (internal) |

Shared HTTP transport: `pkg/httpx/transport.go:27,30` (`NewClient(timeout)`). Verify all the vendor clients use SharedTransport (not raw `http.Client{}`) — connection-pool exhaustion concern for DoS subagent.

---

## 9. CRM SPA route tree — `App/zopmop-crm/src`

Routes (from `App.tsx:52-81`):

| Route | Component | Backend prefix used |
|-------|-----------|---------------------|
| `/login` | LoginPage | `/admin/auth/login`, `/admin/auth/totp/verify` |
| `/` | DashboardPage | `/admin/dashboard/*`, `/admin/alerts/*`, `/admin/notifications/*` |
| `/flags` | FlagsPage | `/admin/flags/*` (api/flags.ts) |
| `/sessions` | SessionsPage | `/admin/auth/sessions` |
| `/orders` | OrdersPage | `/admin/orders` |
| `/orders/:id` | OrderDetailPage | `/admin/orders/:id` |
| `/refunds` | RefundsPage | `/admin/refunds` |
| `/users` | UsersPage | `/admin/users/*` (api/users.ts) |
| `/workers` | WorkersPage | `/admin/workers/*` (api/workers.ts) |
| `/workers/new` | WorkerNewPage | `/admin/workers` |
| `/zone-approvals` | ZoneApprovalsPage | `/admin/zone-approvals/*` (api/zoneApprovals.ts) |
| `/leaves` | LeavesPage | `/admin/leaves/*` (api/leaves.ts) |
| `/map` | LiveMapPage | live tracking |
| `/promos` | PromosPage | `/admin/promos` |
| `/banners` | BannersPage | `/admin/banners`, `/admin/banners/reorder` |
| `/experiments` | ExperimentsPage | `/admin/experiments` |
| `/push` | PushPage | `/admin/push/*` |
| `/analytics` | AnalyticsPage | `/admin/analytics/summary` |
| `/payouts` | PayoutsPage | `/admin/payouts` |
| `/disputes` | DisputesPage | `/admin/disputes` |
| `/audit` | AuditPage | `/admin/audit` |
| `/settings` | SettingsPage | `/admin/blacklist`, `/admin/incidents`, `/admin/webhooks`, `/admin/templates`, `/admin/app-versions`, `/admin/changelog` |
| `/localities` | LocalitiesPage | `/admin/localities/*` (api/localities.ts) |

Authed wrapper: `<Shell>` at App.tsx:55. Login redirect when `!isAuthed`. Token storage and refresh — see `src/api/client.ts` (Auth subagent should verify token storage: localStorage vs cookie, refresh flow).

API files in `src/api/`: `all.ts` (catch-all), `audit.ts`, `auth.ts`, `client.ts`, `dashboard.ts`, `flags.ts`, `leaves.ts`, `localities.ts`, `notifications.ts`, `users.ts`, `workers.ts`, `zoneApprovals.ts`. (`payroll.ts` exists on `feature/payroll-targets-flags` only.)

---

## 10. Webhook endpoints (inbound)

| Endpoint | Auth | Signature verify | Registrar |
|----------|------|-------------------|-----------|
| `POST /api/v1/payments/cashfree/webhook` | **no auth middleware** (per comment at `cmd/api/main.go:598`) | yes — Cashfree HMAC; entry `internal/payments/handler.go:730` (`CashfreeWebhook`), routing at `handler.go:875` (`dispatchCashfreeEventTx`) | `payments.RegisterWebhookRoutes` at `handler.go:128, 132–133` |

No other inbound webhooks observed.

---

## 11. Background workers / crons

| Worker | Owner | Schedule | Touches |
|--------|-------|----------|---------|
| Outbox dispatch | `cmd/api/main.go:405,408` (`outboxWorker.Register`) | loop | DB outbox table → push, webhooks |
| Scheduled dispatcher | `cmd/api/main.go:655` (`matching.NewScheduledDispatcher`) | loop | future bookings → pros |
| Stealth dispatcher | `cmd/api/main.go:656` | loop | retry/stealth re-offer |
| Rebook scanner | `cmd/api/main.go:657` | loop | repeat-booking suggestions |
| Pending action sweeper | `cmd/api/main.go:658` (`booking.NewPendingActionSweeper`) | loop | refund/cancel stuck bookings + wallet ops |
| Hourly balance refill | `cmd/api/main.go:690` (comment "Hourly cron — idempotent monthly balance refill") | hourly | helper monthly balance |
| Leave worker | `cmd/api/main.go:860` (`leaveWorker.Stop`) | loop | helper leave windows |
| Roomies worker | `cmd/api/main.go:863` (`roomiesWorker.Stop`) | loop | roomies feature |
| Retention worker | `cmd/retention-worker/main.go` | separate binary | data retention/PurgeUserData |
| Push scheduler (CRM) | `cmd/crm-api/main.go:245` (`pushScheduler`) | per-row | scheduled marketing pushes |

Cron context cancellation paths exist (graceful shutdown at 855–865). Compliance "30-day grace cron" referenced in code comment at `internal/compliance/service.go:5` — verify whether implementation exists or is TODO.

---

## 12. Migrations directory

- `App/househelp-api/migrations/` — 124 SQL files, numbered 001 → 108 (paired up/down).
- Latest: `108_payroll_engine.up.sql`.
- Security-relevant migrations to spot-check in subagents:
  - `055_*`, `056_*` — RLS-related (if any).
  - `065_helper_kyc_*` — KYC data columns.
  - `075_referral_*` — referral system.
  - `096_cart_service_only_unique` — uniqueness constraints.
  - `097_msg91_auth` — OTP vendor schema.
  - `102_pro_contact_reveals` — pro PII reveal log.
  - `103_admin_pro_deductions`, `104_admin_booking_notes` — admin audit surfaces.
  - `106_helpers_kyc_payment_fields` — payment account columns (sensitive).
  - `108_payroll_engine` — payout schema.

Grep for `GRANT`, `REVOKE`, `ROW LEVEL SECURITY`, `POLICY` across migrations is recommended for AuthN/Z subagent.

---

## 13. Config / env templates

Root `.env`, `.env.example`, `.env.local`, `.env.local.example` present. Both `.env` and `.env.local` are NOT typical templates — Secrets subagent must confirm they are gitignored AND not in history. `.gitignore` exists (root).

`docker-compose.yml`, `Dockerfile`, `railway.json` under `App/househelp-api/` define deployment config.

`secrets/` directory under `App/househelp-api/` exists — secrets subagent must inspect contents and `.gitignore` coverage.

---

## Surprises / quick flags for subagents

- **CRM has NO CSRF middleware** (`cmd/crm-api/main.go:140–147` has no `csrf` call). Customer side does (`cmd/api/main.go:235`). Bearer-token CRM may be intentional; confirm token storage isn't a cookie that would need CSRF.
- **Two Cashfree credential sets in env**: `pkg/config/config.go:148–151` reads `CASHFREE_PG_*`, while `internal/payments/handler.go:63–74` reads `CASHFREE_CLIENT_ID/SECRET` + `CASHFREE_BASE_URL/ENV`. Verify whether one path is dead code or both are live. Cashfree handler also reads env at constructor time only — check whether per-request reads exist elsewhere.
- **`OPENROUTER_API_KEY` read inline at `cmd/api/main.go:567`** — passed into `zop.NewService`. Fine if cached at boot; not fine if re-read per request.
- **`FIREBASE_CREDENTIALS_JSON` is an entire JSON document in an env var** (`internal/notification/service.go:42`). Verify it isn't logged anywhere (Sentry/error paths).
- **`ENABLE_PPROF=1` gates pprof on default mux** (`cmd/api/main.go:136`). If exposed on the listen port in prod, that's a leak — verify deployment env never sets it.
- **`ENABLE_STUB_ENUMERATOR=1` exposes `/admin/_stub/:module`** (`cmd/crm-api/main.go:428`) — dev only, must not be set in prod.
- **Cashfree webhook has no auth middleware** (`cmd/api/main.go:598–601`) — relies entirely on signature check inside `handler.go:730`. Verify constant-time HMAC compare and replay protection.
- **`OTP_DEV_MODE` (`pkg/config/config.go:146`) bypasses real SMS** — must be false in prod. Verify it isn't sticky / cached if toggled.
- **`pkg/crmconfig/config.go:135` actively rejects `CRM_JWT_SECRET == JWT_SECRET`** — good. But there's no equivalent check that JWT_ACCESS_SECRET != JWT_REFRESH_SECRET.
- **`pprof_dev.go` registers on `http.DefaultServeMux`** (`cmd/api/main.go:145`), which is then bound to a separate listener (line ~145 comment). Trace where this listener is bound and on which port — must not be public.
- **`internal/auth/msg91_deprecated.go`** still has live HTTP client init code (`:43, :59, :194`). "deprecated" in filename but compiled. Confirm whether it's reachable.
- **Past memory: "burned API key flagged for urgent rotation"** — Secrets subagent must verify rotation in code AND in git history. Grep `git log --all -p` for any AKIA/eyJ/sk- prefixes.

End of REPO_MAP.
