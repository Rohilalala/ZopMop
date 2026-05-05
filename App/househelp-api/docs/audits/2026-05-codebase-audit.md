# ZopMop Codebase Audit — May 2026 (Revision 2)

**Note:** This report has been redacted for version control.
Sensitive values (Firebase service-account project ID, private-key fingerprint, on-disk key filename) have been replaced with placeholders. Original unredacted version remains in the working tree at `.audit/FINAL_REPORT.md` (gitignored).

---

# Codebase Audit — Final Report (Revision 2)
**Repository:** ZopMop · **Branch:** `feature/sdui` · **HEAD:** `9cdc797`
**Scope:** 575 source files (Go, TS/TSX, SQL, JS, YAML, JSON, MD, sh, Dockerfile, .env)
**Conducted by:** orchestrator + 22 specialised sub-agents (5 security, 5 correctness, 5 quality, 4 performance, 3 platform) + 3 challenger passes (Phase 1A–2). After a quota reset, an additional **DEEP pass** ran the originally-failed Phase 1E/1F roles plus three challengers as real sub-agents (E1-DEEP, E2-DEEP, E3-DEEP, F1-DEEP, F2-DEEP, F3-DEEP, CH1-DEEP, CH2-DEEP, CH3-DEEP) — adds new findings and corrects earlier ones.
**Mode:** Read-only. No source files were modified.
**Working artefact:** `.audit/shared_memory.md` (~3823 lines, **37 agent logs** + cross-references + cross-cutting hypotheses + named exploit chains) — kept verbatim.

---

## 0. Revision-2 Headline Changes (DEEP pass)

The DEEP pass discovered **four additional CRITICAL findings** and corrected/strengthened several earlier ones. Read this section before §1 — it supersedes the original top-10.

### 0.1 NEW CRITICALs (DEEP pass)

| # | ID | File:lines | One-line |
|---|-----|------------|----------|
| C-5 | **E2D-1** | `internal/middleware/idempotency.go:28` (vs `internal/middleware/auth.go:69`) | Idempotency middleware reads `c.Locals("user_id")` while auth sets `c.Locals("userID")` → every authenticated user shares the empty-string namespace `idem::<key>` → booking-POST replays leak the cached 2xx response (booking-id, helper, address) **across users**. CH3-DEEP confirmed: severity is HIGHER than originally filed; this is a live cross-user data-leak. |
| C-6 | **E1D-1** | `App/zopmop-app/src/screens/main/PaymentScreen.tsx:237-262` + server `internal/payments/handler.go` | Razorpay native success → toast → cart-clear → navigate, **without any** call to `/payments/verify` (no `razorpay_signature` HMAC check). No `order_id` round-trip either. A tampered client marks bookings paid for free. |
| C-7 | **E1D-2** | `App/zopmop-app/src/sdui/ActionHandler.ts:39-74` | `action.screen` / `action.url` / `action.endpoint` from server are dispatched without any client allowlist, into the navigator and `Linking.openURL` (covers `tel:`, `upi:`, custom intents). Combined with A5-02 (CRM low-RBAC writes to `sdui_pages.config_json`) any mid-priv admin can push an arbitrary deep-link to every device. Upgrades A2-1 from HIGH → CRITICAL. |
| C-8 | **F2D-1** | `internal/auth/repository.go:205-265` | `SoftDeleteUser` scrubs 4 columns on `users` only; the post-delete hook is Redis-only. `user_addresses` (line, lat/lng, receiver_phone), `bookings.address`, `device_tokens`, `booking_messages`, `reviews.comment`, `pro_leaves.note`, `helper_status_log`, `crm_audit` all retained forever. The 30-day grace cron the comment claims **does not exist anywhere in the repo**. DPDP §13 / GDPR Art 17 erasure is structurally impossible. |
| C-9 | **CH1D-1** | `App/zopmop-app/src/navigation/MainNavigator.tsx:153-187` + `src/utils/pushRouter.ts:31-37` | Pro screens (`ProDashboard`, `ProActive`, `ProScheduledInvite`, etc.) are registered in the same nav stack as customer screens with only `initialRouteName` gating. Any deep-link / FCM `SCHEDULED_INVITE` push lands a customer on a pro screen, which then `enqueueLocationPing()`s on their behalf and exposes pro-only actions. |
| C-10 | **CH1D-2** | `App/househelp-api/cmd/stressui/main.go:73-119` | Listens on `:8090` (all interfaces) with **zero auth**. `POST /api/run` accepts `cleanup` / `seed` / `k6` against the bound `DATABASE_URL`, with `go run` exec → full host FS read + arbitrary DB wipe to anyone on the same network. |
| C-11 | **CH1D-3** | `App/zopmop-app/ios/zopmopapp/PrivacyInfo.xcprivacy:45-48` | `NSPrivacyCollectedDataTypes` declared empty while the app collects phone, name, email, address, precise location, payment info. App Store rejection at submission + DPDP / GDPR record-keeping violation. |

(These join the original four CRITICALs: A1-F1 refresh-token TOCTOU, A3-S1 Firebase admin key, B1-1 refund TOCTOU, B1-2 timeout fiber.Ctx race. **Total: 11 CRITICAL.**)

### 0.2 NEW exploit chains (CH2-DEEP)

CH2-DEEP stitched 12 named multi-hop chains. Highest:

- **CHN-1 — Cred-stuff CRM → full PII dump → SDUI weaponisation:** A1-F2 → A1-F4 → A1-F5 → A5-02 → A2-1 / E1D-2. Single dictionary admin password ⇒ DB dump ⇒ arbitrary deep-link push to every user device.
- **CHN-2 — Free-credit double-spend:** E1D-1 → A3-S3 → B1-1 → B5-D4 → D4-N8 → D4-N4. Forged client payment + refund double-click.
- **CHN-6 — Chat-as-shadow-PII-store + cross-border export:** F2D-6 → F1-D1 → F1-D2 → F2D-2 → F2D-1/F2D-4 → E1D-12. Every Zop chat is logged forever, sent to a US LLM, and stored plaintext in AsyncStorage. DPDP §6/§8/§10/§16 simultaneously.
- **CHN-7 — Latency tail → cross-user response bleed:** D2-1 → D4-N4 → B1-2 → D2-2 → D2-5. Already shows as `helper_pull p(95)=9877ms` in load tests; under retry storm can leak auth-bearing bytes between users.
- **CHN-9 — Refund money lost (no attacker required):** B1-1 → B2-02 → C2-01 → B5-D9 → F1-D7. Approve TOCTOU + persist swallow + legacy 'settled' status orphan + audit drift + no alert sink.

Full list of 12 chains in `.audit/shared_memory.md` under `### Agent CH2-DEEP`.

### 0.3 NEW cross-cutting clusters (F3-DEEP)

Added to the original X1–X9:

- **X10 — Logging-as-PII-store** (F1-1, F1-D1, F1-D2, F1-D3, F1-D4, F1-D5, F1-D9, F2-3, F2D-1, F2D-2, F2D-10): Zop chat content + UPI VPAs + push bodies + raw `Idempotency-Key`s logged at Info; no retention purge → logs are now the largest PII surface. Single fix: `pkg/logger/safe` allowlist API + retention cron in same PR.
- **X11 — Idempotency cross-user contamination** (E2D-1, B1-3, A5-16, E1-1, D4-N4, F1-D5): the locals-key typo is the root; RN's missing client-side key amplifies. Single fix: `mw.LocalsKeyUserID` constant + Lua-SETNX server lock + RN auto-key.
- **X12 — Pprof / debug surfaces leaked** (E3D-2 unconditional `_ "net/http/pprof"` import, E2-4 `/admin/_stub/:module`, E3D-8 sourcemaps in prod CRM, E3D-10 `aps-environment=development`, E3D-13). Single fix: `dev_only` build tag + Vite mode gate + CI assertion.
- **X13 — Compliance-as-schema-only** (super-cluster: F2D-1 to F2D-8, F2-2/7/8, B5-D1/D2, H_F2D_1, E1D-3, E1D-12). Single fix: `internal/compliance/` package with `PurgeUserData`, retention crons, `GET /me/export`, `user_consents` table; CODEOWNERS rule pairing every soft-delete migration with cron + endpoint.

### 0.4 Corrections to Revision-1 findings (CH3-DEEP + DEEP pass)

- **E1-10 (INFO)** "session-only token" claim verified — was wrong. JWT *is* persisted to SecureStore (`AuthContext.tsx:128-131,245-248`) under key `auth_token`. Replaced by **E1D-3 (HIGH)**.
- **B5-D5 (HIGH)** "helper FK drift" — DOWNGRADE to MED. `migrations/002_create_helpers.sql:7` declares `helpers.id REFERENCES users(id)` as 1:1 PK identity, so `bookings.helper_id` (FK→users) and `reviews.helper_id` (FK→helpers) reference the same UUID. Loose-typing concern, not a runtime FK break.
- **B3-1 (LOW)** booking FSM map omits `searching`/`pending_customer_action` — INVALIDATE. Zero callers of `UpdateBookingStatus`; agent self-acknowledged.
- **A2-7 (MED)** LLM context injection via address fields — DOWNGRADE LOW. Booking-create path requires non-LLM client confirm; blast small.
- **A4-F5 (MED)** razorpay package small-maintainer — DOWNGRADE LOW. Official affiliated package; pinning is the meaningful action.
- **A1-F1 (CRIT)** refresh-token TOCTOU — CONFIRMED. CH3-DEEP verified `RotateSession` UPDATE keys on `WHERE id = $1` not on old hash → concurrent refreshes both succeed. UNIQUE constraint on `refresh_token_hash` prevents collisions but not replay.
- **A3-S1 (CRIT)** Firebase admin key — CONFIRMED unrotated. `private_key_id <REDACTED_KEY_FP>` unchanged on disk; `.env:6` pins the path. Unless prod *unsets* `FIREBASE_CREDENTIALS_JSON` (and Firebase library falls back to ADC), the on-disk JSON IS the prod credential.
- **B1-2 (CRIT)** timeout-middleware fiber.Ctx race — CONFIRMED. Handler goroutine continues writing to pooled fasthttp `RequestCtx` after parent returns 503.
- **A5-02 (HIGH)**, **A2-2 (HIGH)**, **E1D-1 (CRIT)** — all CONFIRMED via direct re-read.

### 0.5 Updated counts (Rev-2)

| Severity | Rev-1 | Rev-2 | Δ |
|----------|------:|------:|---:|
| CRITICAL | 4 | **11** | +7 |
| HIGH | ~85 | ~110 | +25 |
| MEDIUM | ~115 | ~135 | +20 |
| LOW | ~85 | ~95 | +10 |
| INFO | ~40 | ~45 | +5 |
| **Total** | **~329** | **~396** | **+67** |

### 0.6 Single highest-leverage PR (F3-DEEP)

**One PR — "compliance + idempotency + payment-verify hardening pack."** Closes 4 of the 4 DEEP-pass CRITICALs (E2D-1, E1D-1, F2D-1, plus most of CHN-2/3/5/6) and ≥6 top-tier HIGHs.

1. **Idempotency**: fix `Locals("user_id")` typo + add `mw.LocalsKeyUserID` constant + Lua SETNX server lock + RN auto-`X-Idempotency-Key` with jitter (E2D-1, B1-3, A5-16, E1-1, D4-N4, F1-D5).
2. **Payments**: `/api/v1/payments/create-order` + `/api/v1/payments/verify` (HMAC) + `/webhooks/razorpay` + UNIQUE `(provider, payment_id)` on `payments_processed`; gate booking-confirm on verified payment (E1D-1, A3-S3, B5-D4, D4-N8).
3. **Compliance**: `internal/compliance/` with `PurgeUserData` (covers all PII tables), retention crons for 7 append-only tables, `GET /me/export`, `user_consents` table replacing migration 049's boolean flag (F2D-1, F2D-2, F2D-3, F2-2, F2-7).
4. **Logging**: `safelog.With(...)` allowlist API; remove raw `Interface()` dumps in zop, notification, payments, idempotency middleware (F1-D1 to F1-D5).

Other recommended fixes (sourcemap gating, pprof private mux, polling → push) become safer once payments and erasure stop bleeding.

---

## 1. Executive Summary

ZopMop is a two-app (customer + helper) marketplace plus a Vite/React CRM, fronted by a Go 1.25 / Fiber-v2 backend with Postgres+PostGIS and Redis. The codebase is **substantial and well-organised** — 39 internal packages, clean handler→service→repository layering in most places, masked-PII logging, multi-stage Dockerfile, two-process split between user-API and CRM. Several engineering instincts are right: helmet-style security headers, idempotency middleware on bookings, separate read/write CRM pools, gracefully-shutdown background workers in CRM, HS256 algorithm pinning with `kid` rotation, in-memory pendingAuthStore, `crypto/rand` for OTPs.

But the audit surfaced **four CRITICAL and ~80 HIGH issues**, dominated by five families of structural risk:

1. **Money flows are not transactional.** Razorpay payments have no backend signature verification (A3-S3, B4-1, B5-D4, D4-N8); refunds call the gateway *before* the DB UPDATE without an idempotency key (B1-1, B5-D4); RN retries 5xx POSTs with no `X-Idempotency-Key` (E1-1, A5-16, D4-N4). One double-tap on Approve refunds twice; one rage-click on Pay marks unpaid bookings paid.
2. **A real Firebase admin private key sits on disk** (A3-S1 / F2-1). It is gitignored and not in history, but it travels with every clone of the repo and is referenced from `.env`. Treat as compromised; rotate immediately.
3. **The CRM API is unprotected.** No `recover` middleware, no rate-limiter, no CSRF, **no permission gate on PII read endpoints** (A5-01, A5-02, A1-F2, E2-2). Any logged-in CRM user can dump customer/worker phone, email, address, lat/lng. Login itself burns one bcrypt verify per request with zero IP throttle.
4. **A pervasive "read → external side-effect → write" anti-pattern.** Same shape repeats across CRM refresh-token rotation (A1-F1), refund approval (B1-1), payment idempotency (B5-D3), push fan-out (B1-5), scheduled dispatch (B1-7). Every one is exploitable under retry pressure. Hypothesis H4 / Cluster X1 in shared memory.
5. **CRM features are decorative.** `crm_blacklist` is never consulted (B4-7); per-zone surge rules (B4-4), CRM promos (B4-5), preferred helpers in instant matching (B4-3), tipping (B4-1) are CRUD-only with no runtime consumer. UI text claims behaviour the backend does not implement (C5-1/2). Roughly half of "shipped CRM v2" is theatre.

The repo has **near-zero test coverage on the highest-risk packages** (booking, matching, payments, refunds, growth, zop, BFF — C4-T1) and CI does not run `go test -race` (E3-2). Concurrency, idempotency, and money flows therefore have no regression net.

**Overall health grade: C.** Architecture is good. Security and money correctness are the unfinished half of "v1."

### Top 10 Issues (operator action order)

| # | ID | Severity | Issue | First file |
|---|-----|----------|-------|-----------|
| 1 | A3-S1 / F2-1 | CRITICAL | Firebase admin RSA-2048 private key on disk | `App/househelp-api/secrets/zopmop-<REDACTED>.json` |
| 2 | A3-S3 / B4-1 / B5-D4 / D4-N8 | HIGH-cluster | Razorpay flow: no backend signature verify, no idem-key, no webhook | `internal/payments/`, `App/zopmop-app/src/screens/main/PaymentScreen.tsx` |
| 3 | A5-02 | HIGH | CRM PII reads ungated (any CRM JWT dumps phone/email/address) | `cmd/crm-api/main.go:265-302` |
| 4 | A5-01 / E2-2 / A1-F2 | HIGH | Zero rate-limit, zero CSRF, zero recover on `cmd/crm-api` | `cmd/crm-api/main.go:122-126` |
| 5 | A1-F1 | CRITICAL | CRM refresh-token rotation has no replay detection | `internal/crm/auth/service.go:202-239` |
| 6 | B1-1 | CRITICAL | Refund Approve TOCTOU → double-refund on double-click | `internal/crm/refunds/refunds.go:386-501` |
| 7 | B1-2 | CRITICAL | Timeout middleware writes pooled `*fiber.Ctx` from spawned goroutine | `internal/middleware/timeout.go:51-95` |
| 8 | A2-2 | HIGH | Webhook dispatcher SSRF (admin-set URLs, no host allowlist) | `internal/webhooks/dispatcher.go:247-265` |
| 9 | A2-1 / C3-15 | HIGH | SDUI client trusts server `action.{url,screen,endpoint}` blindly | `App/zopmop-app/src/sdui/{ActionHandler,safeguards}.ts` |
| 10 | B5-D1 / B5-D2 | HIGH | Soft-delete partly implemented; users.deleted_at filtered only in auth | many `repository.go` |

---

## 2. Severity Counts

Aggregated across 22 agent logs + 3 challenger passes (de-duplicated where the same finding was filed twice with the second instance marked as cross-ref).

| Severity | Count |
|----------|------:|
| CRITICAL | 4 |
| HIGH | ~85 |
| MEDIUM | ~115 |
| LOW | ~85 |
| INFO | ~40 |
| **Total** | **~329** |

(Precise counts per agent are listed in `.audit/shared_memory.md` under each `### Agent <X>` block.)

---

## 3. Findings by Severity

This section names every CRITICAL and HIGH finding with file:line evidence. MEDIUM/LOW/INFO findings remain in `.audit/shared_memory.md` to keep this report navigable.

### 3.1 CRITICAL (4)

#### C-1 — Firebase admin private key on disk
- **ID:** A3-S1 (= F2-1)
- **File:** `App/househelp-api/secrets/zopmop-<REDACTED_PROJECT>-firebase-adminsdk-<REDACTED_KEY_FP>.json`
- **Evidence:** RSA-2048 private key (`private_key_id <REDACTED_KEY_FP>`) referenced by `App/househelp-api/.env` `FIREBASE_CREDENTIALS_JSON=./secrets/...`. Verified gitignored and **not** in git history, but the file is in the working tree and travels with any clone.
- **Impact:** Compromise grants full admin to the Firebase project — read all auth users, mint custom tokens, impersonate any phone-OTP user.
- **Advisory fix:** Rotate the key in Firebase Console immediately; switch backend to Application Default Credentials (ADC) or a secret-manager. Treat the on-disk key as already burnt.

#### C-2 — CRM refresh-token rotation lacks replay detection
- **ID:** A1-F1
- **File:** `internal/crm/auth/service.go:202-239`
- **Evidence:** `RefreshToken` rotates without checking that the presented refresh hasn't been seen before. RFC 6819 §5.2.2 anti-replay missing.
- **Impact:** Stolen refresh cookie keeps an attacker logged in indefinitely while the legit user is silently logged out.
- **Advisory fix:** Mark old refresh as "rotated"; if the same token is presented again, kill the entire family and audit-log `auth.session_replay_detected`.

#### C-3 — Refund Approve TOCTOU → double-refund
- **ID:** B1-1
- **File:** `internal/crm/refunds/refunds.go:386-501`
- **Evidence:** `Approve` reads `status='pending'` then makes the gateway call before any DB write. Two concurrent Approve clicks both pass the read and both call Razorpay.
- **Impact:** Money loss; customer refunded twice.
- **Advisory fix:** First UPDATE `SET status='processing' WHERE id=$1 AND status='pending' RETURNING id`; only the row owner calls the gateway; on success UPDATE → `processed`, on failure → `failed_provider`. Send a real `Idempotency-Key` to Razorpay.

#### C-4 — Timeout middleware races pooled `*fiber.Ctx`
- **ID:** B1-2
- **File:** `internal/middleware/timeout.go:51-95`
- **Evidence:** Handler runs in a separate goroutine; on timeout the parent writes 503 while the handler may still write to the same `RequestCtx` (Fiber pools it).
- **Impact:** A slow handler's response bytes can bleed into another connection's response — cross-user data leak. CH2 highlighted that combined with A1-F9 (24-h JWT-suspend lag) and A5-04 (PII in push), this can leak auth-bearing responses.
- **Advisory fix:** Drop the goroutine-and-pretend pattern. Set a per-request `context.Context` deadline and rely on Fiber's handler returning when DB/HTTP calls observe `ctx.Done()`. Or migrate to Fiber v3 which handles this natively.

### 3.2 HIGH (selected — full list in shared_memory)

A representative subset; every one has full evidence + file:lines in `.audit/shared_memory.md`.

**Auth / RBAC / API surface**
- A1-F2 — `/admin/auth/login` has no per-IP rate-limit (`cmd/crm-api/main.go`).
- A1-F3 — Pro routes never check `helpers.approval_status` (`internal/helper/handler.go:25-26`).
- A5-01 — CRM has zero rate-limit middleware (`cmd/crm-api/main.go:265-302`).
- A5-02 — CRM read endpoints (users/workers/orders/refunds) gate writes only; reads expose full PII (`crm/users/repository.go:119,203`).
- A5-04 — Push notification bodies leak helper names (`internal/notification/service.go:170-183`).
- A5-06 — `is_suspended` read from JWT claims, not DB (`internal/middleware/auth.go:62-66`).

**Money flows / payments**
- A3-S3 — No Razorpay backend signature verification.
- B4-1 — Tip flow: UI lies, no API endpoint exists (`TipScreen.tsx`).
- B4-7 — `crm_blacklist` CRUD exists but never read at runtime.
- B4-8 — Wallet, refunds, settlement, surge truncation: schema acknowledges money, code does not move it.
- B5-D3 / B5-D4 — `payments/idempotency.go:24-57` self-documenting race; `crm/refunds/refunds.go:444-467` Razorpay call before DB update.

**Concurrency / lifecycle**
- B1-3 — Idempotency middleware is GET→handler→SET (not SETNX); RN retries POST without idem-key.
- B1-5 — `growth.SendPush` TOCTOU duplicates entire FCM blasts.
- B1-7 — `ScheduledDispatcher.claimNext` releases lock before `InviteChain` runs.
- D2-2 — tracking_ws clears `SetReadDeadline(time.Time{})` after auth → forever-blocked goroutine per stale mobile session.
- D2-5 — Two unbounded ratelimit maps swept under one write lock → GC-stall under botnet.

**Data / DB**
- B5-D1 / B5-D2 — `users.deleted_at` filtered only in `auth/repository.go`; booking, admin, notification, crm/orders, crm/refunds, crm/payouts read unfiltered.
- B5-D5 — `bookings.helper_id` → users(id) but `reviews.helper_id` → helpers(id); booking can refer to a customer-role user with no helpers row.
- B5-D7 — No migration runner in repo, no `schema_migrations` table.
- D1-1 — `internal/bff/sources.go:145` selects `users.first_name` (column does not exist).
- D1-2 / D1-4 — Matching hot path runs city-wide `bookings GROUP BY helper_id` per batch tick; per-candidate overlap-check has no covering index.
- D1-5 / D1-6 / D1-8 — Whole CRM list surface uses OFFSET pagination with LATERAL aggregates re-run per request.

**Network / I/O / perf**
- D2-1 / D4-N1 — All seven outbound HTTP clients use Go's default `Transport` (`MaxIdleConnsPerHost=2`).
- D4-N2 — Webhook dispatcher zero retry/backoff, semaphore acquired *after* spawn.
- D4-N4 / E1-1 — RN retries POST/PUT/DELETE on 5xx with un-jittered `[1,2,4]s` and no Idempotency-Key.
- D3-F1 — `validateInviteIDs` issues N serial `SELECT … WHERE id=$1` per helper-poll tick.
- D3-F2 — `NearbyStats` issues up to 50 serial Redis EXISTS per LivePill 5s poll.
- D3-F5 — `inviteSinglePro` polls bookings PK every 2s for 25s per pro per chain (~390 RTTs / 30-pro chain).

**Server lifecycle / infra / docs**
- B2-01 / E2-1 / E2-2 — No `fiber.Recover()` on either app; CRM also lacks rate-limit + CSRF.
- B2-02 — Refund DB write errors swallowed after gateway success → money stranded.
- B2-03 — `notification/service.go:99-110` never types Firebase errors → dead FCM tokens never pruned (multicast path does it).
- B2-05 — `err.Error()` leaked verbatim across tracking_ws, helper, zop, auth.
- E2-3 — Fiber `WriteTimeout=10s` collides with Zop `Timeout(90s)` middleware → chat replies > 10s fail at the socket.
- E2-4 — `/admin/_stub/:module` enumerates CRM module taxonomy.
- E3-1 / E3-2 — Dockerfile uses Go 1.22-alpine and CI pins Go 1.22 while go.mod requires 1.25/1.26.2; CI does not run `go test -race`, no CRM job.
- E3-3 — `bin/api` (64 MB) committed to git; `loadtest/results/` committed.

**Frontend / SDUI**
- A2-1 / C3-15 — SDUI client `ActionHandler` accepts arbitrary `url`/`screen`/`endpoint`. Combined with A5-02 (CRM RBAC gap) a low-priv admin can route any user to any screen.
- C3-04 — BFF runs raw SQL against `users` / `bookings` / `home_promos` (domains it does not own).
- C3-08 — Three repositories write `users` (`auth`, `admin`, `crm/users`); race + audit gap.
- C3-13 — `api/client.ts` does not inject `Authorization`; token is threaded manually through 17 of 21 modules.

**Observability / compliance**
- F1-1 — Notification service logs `Interface("data", data)` (PII).
- F1-2 — No `/metrics`, no OpenTelemetry, no scrapable RED metrics.
- F2-2 — No DSAR endpoint; soft-delete + retention not finished.
- F2-3 — Push payloads leak names to OEM clouds.
- F2-4 — Load-test CSV (`customers.csv`, `helpers.csv`, ~720 KB) checks in real-prefix Indian phone numbers; signed HS256 tokens too. Cross-ref C4-T2.

**Documentation**
- C5-1/2 — Customer-facing copy (TipScreen toast, Wallet "live" panel) lies about backend behaviour.
- C5-3/4/5 — README claims Go 1.22 + an unimplemented migrate-up command; SDUI doc says "not started" while SDUI is the live home screen; BUSINESS doc says Razorpay test-mode "wired" while server has zero verification.

---

## 4. Findings by File

The full grouping is computable from `.audit/shared_memory.md`; below are the files that draw the most fire. Each entry lists the agents that filed against it.

| File | Agents that filed | Themes |
|------|-------------------|--------|
| `cmd/api/main.go` | A1, A2, A5, B2, D4, E2, E3 | Middleware order, no recover, WriteTimeout vs Zop |
| `cmd/crm-api/main.go` (+ middleware.go) | A1, A5, B2, C3, E2 | No rate-limit/CSRF/recover, /_stub enumerator |
| `internal/auth/service.go` | A1, A3, B2 | Refresh-token TOCTOU, plain TOTP, error leaks |
| `internal/auth/handler.go` | A1, A5, B2 | OTP rate-limit, error leaks |
| `internal/middleware/auth.go` | A1, A5 | `is_suspended` from JWT not DB |
| `internal/middleware/timeout.go` | B1, D2 | RequestCtx race (CRITICAL) |
| `internal/middleware/idempotency.go` | B1, B5 | GET-then-SET race |
| `internal/middleware/ratelimit.go` | A5, D2 | Two unbounded maps, env-flip permissive |
| `internal/booking/service.go` | B1, B3, B4, C1, D3 | FSM holes, surge truncation, side-effect drop |
| `internal/booking/repository.go` | B3, B5, C1, D1 | FSM map gaps, missing covering indexes |
| `internal/booking/tracking_ws.go` | B1, D2, E2 | Read-deadline cleared, goroutine leak |
| `internal/matching/dispatch.go` | A2, B1, D1, D3 | LIKE wildcard, lock release before chain, N+1 polls |
| `internal/matching/engine.go` | B1, D1, D3 | Hot-path index miss |
| `internal/payments/idempotency.go` | B1, B5 | Self-documenting race |
| `internal/payments/handler.go` | A3, A5, D2 | No Razorpay verify route, default Transport |
| `internal/payments/razorpay.go` | A3, B1, D4 | No `Idempotency-Key` header |
| `internal/crm/auth/service.go` | A1, A3 | Refresh replay, plaintext TOTP secret |
| `internal/crm/refunds/refunds.go` | A5, B1, B2, B5, C1, D4 | Double-refund, swallowed errors, non-atomic |
| `internal/crm/users/repository.go` | A5, C1, D1 | PII reads, OFFSET pagination, dup-CRUD |
| `internal/crm/workers/repository.go` | A5, C1, D1 | Same |
| `internal/crm/growth/growth.go` | A5, B1, D4 | Push TOCTOU duplicates entire blast |
| `internal/notification/service.go` | A5, B2, F1, F2 | Untyped FCM errors, PII in body, PII in logs |
| `internal/webhooks/dispatcher.go` | A2, B1, D2, D4 | SSRF, no retry, semaphore inversion |
| `internal/bff/sources.go` | A5, C3, D1 | Wrong column names (`first_name`, `user_id`) |
| `internal/bff/repository.go` / `hydrator.go` / `resolver.go` | C3, D1, D3 | Per-section serial fetches; cross-domain SQL |
| `internal/zop/service.go` | A2, B2, C1, D4 | Prompt injection, exempt from request timeout |
| `App/zopmop-app/src/api/client.ts` | A5, B2, D4, E1 | Retry without idem-key, error leak via toast |
| `App/zopmop-app/src/sdui/ActionHandler.ts` / `safeguards.ts` | A2, C3, E1 | No client allowlist for action types |
| `App/zopmop-app/src/screens/main/PaymentScreen.tsx` | A3, B2, D4 | Client-success → mark paid; clearCart fire-and-forget |
| `App/zopmop-app/src/screens/main/TipScreen.tsx` | B4, C2, C5 | UI-only stub |
| `App/zopmop-app/src/screens/main/{Booking,Track,Profile,AllServices}*` | C1, D2, D3, E1 | 800–1500 LOC, polling cadence |
| `App/zopmop-crm/src/pages/SettingsPage.tsx` | C2, C3 | 855 LOC kitchen-sink |
| `App/zopmop-crm/src/api/all.ts` | C3 | 338 LOC god module |
| `App/househelp-api/Dockerfile` / `.github/workflows/ci.yml` | A4, E3 | Go-version drift, no -race, no CRM job |
| `App/househelp-api/migrations/049_*` / `057_*` / `058_*` | B5, C5 | Duplicate migration prefixes |

---

## 5. Cross-Cutting Issues

These are the structural patterns that surface as many findings under different agents — fix one of these and you close ≥ 5 finding entries.

### X1 — "Read → external side-effect → write"
A1-F1, B1-1, B5-D3, B5-D4, B1-5, B1-7, D4-N4, D4-N8, E1-1, A5-16. The dominant correctness risk class. **Fix shape:** atomic `UPDATE … SET status='processing' WHERE status='pending' RETURNING id`; only the row owner performs the side-effect; outbox row records the side-effect-pending event.

### X2 — Soft-delete leak
B5-D1, B5-D2, A5-02, A1-F8, C2-04, D1-7, D1-11, F2-2, F2-7. **Fix shape:** wrap user reads in `repo.UsersAlive()`; CHECK constraint on `users.role`; DSAR + retention cron behind a single feature flag.

### X3 — Outbound HTTP defaults
D2-1, D4-N1, D4-N6, D4-N7, D2-3. All seven outbound clients construct their own `*http.Client`. **Fix shape:** `pkg/httpx.NewClient(name, opts)` with shared transport, jittered retry, circuit-break, per-route `Idempotency-Key` injection.

### X4 — "CRM theatre"
B4-1, B4-3, B4-4, B4-5, B4-7, B4-12, C5-1/2, C2-02. CRM modules wired in UI but inert in the booking/auth/match runtime. **Fix shape:** every CRM feature must have a runtime consumer test (`go test` proves the read path exists).

### X5 — Razorpay verification absence + race
A3-S3, B4-1/8, B5-D4, D4-N8, F2-6, B2-13, E1-1. **Fix shape:** `/api/v1/payments/verify` (HMAC) + `/webhooks/razorpay` + UNIQUE `(provider, payment_id)` on `payments_processed`.

### X6 — Naming / column drift
A5-18, D1-1, C2-04, C2-05, B5-D5, C2-01. **Fix shape:** schema-drift CI gate (sqlc / pgxgen / hand-rolled `pg_dump --schema-only` snapshot) + a one-shot rename PR.

### X7 — Concurrency lifecycle
B1-2, B1-4, B1-6, B1-13, D2-2, D2-3, D2-8, D2-9. **Fix shape:** every `go func()` → `mw.SafeGo(ctx, name, fn)`; ban bare goroutine in lint.

### X8 — Polling instead of push
C1-12, D3-F8, D4-N5, E1-5. Tracking WS and FCM already exist. **Fix shape:** consolidate behind WS or FCM-data-only; kill setIntervals.

### X9 — No CI gates for known failure modes
E3-1/2/3, C4-T1. **Fix shape:** `go test -race -short` on every PR; CRM job; binaries excluded from git; migration-runner enforcement.

(Full chain-of-custody for each cluster lives in `.audit/shared_memory.md` under `### Agent F3` and `### Agent CH2`.)

---

## 6. Architectural Observations

- **Two-process split (user-API + CRM API)** is the right call and is mostly executed. Pools are separate, secrets are separate, audit recorder is wired into CRM mutations. The miss is consistency: CRM lacks the recover/rate-limit/CSRF that the user-API has, and CRM read endpoints lack the permission gating that the mutations have.
- **Domain layering** is healthy in most packages (handler → service → repository). Violations are localised: BFF reaches into other domains' tables (C3-04), location handler queries `bookings` directly (C3-02), booking handler reaches into `service.repo` (C3-01). One rule (`no-direct-foreign-table-access` lint) closes most of these.
- **SDUI** is a strong product feature undermined by trust placement: validation happens at staging time, the runtime client trusts payloads, types are duplicated 4× without codegen (C3-14), `navigate.screen` is an unconstrained string (C3-15). Adding a generated allowlist closes A2-1, C3-15, E1-6, and the action-fan-out blast radius.
- **CRM module "theatre"** (X4) is the largest single concern after security and money. Several modules have admin CRUD + audit but no runtime consumer. Either wire them or delete them — the cost of the in-between is lying UI and a misleading product narrative.
- **Polling vs push** (X8) is paid in mobile battery and PG QPS today. The infrastructure to fix it (WS + FCM) is already shipped; the work is on the client.
- **Tests do not exist where risk lives.** Handler tests on auth and analytics, no tests on booking, matching, payments, refunds, growth, zop, BFF, notification (C4-T1). Race detector is not in CI (E3-2). The findings in §3 will silently regress.

---

## 7. Agent Coverage Matrix (sampled)

A complete file × agent matrix would be ≈575 × 25 — kept in `.audit/shared_memory.md`. Below: how often the highest-risk files were touched.

| File | Agents that filed against it |
|------|------------------------------|
| `cmd/api/main.go` | 7 (A1, A2, A5, B2, D4, E2, E3) |
| `cmd/crm-api/main.go` | 5 (A1, A5, B2, C3, E2) |
| `internal/booking/service.go` | 5 (B1, B3, B4, C1, D3) |
| `internal/crm/refunds/refunds.go` | 6 (A5, B1, B2, B5, C1, D4) |
| `internal/middleware/timeout.go` | 2 (B1, D2) — but both filed CRITICAL/HIGH |
| `internal/middleware/idempotency.go` | 2 (B1, B5) |
| `App/zopmop-app/src/api/client.ts` | 4 (A5, B2, D4, E1) |
| `App/zopmop-app/src/sdui/ActionHandler.ts` | 3 (A2, C3, E1) |
| `App/zopmop-app/src/screens/main/PaymentScreen.tsx` | 3 (A3, B2, D4) |
| `internal/notification/service.go` | 4 (A5, B2, F1, F2) |

**Files audited by ≥3 agents:** ≈75 (the hot-spot core).
**Files audited by 1–2 agents:** ≈300.
**Files only inventoried (zero focused audit):** ≈200, mostly migrations after the B5 sweep, design tokens, asset metadata, RN screens not in the top-30 by LOC, CRM secondary pages.

---

## 8. Assumptions Made During the Audit

1. The branch `feature/sdui` at HEAD `9cdc797` represents the codebase the team intends to ship. Findings against work-in-progress migrations (062, 063) are still in scope.
2. `App/househelp-test-client.bak/` was treated as a backup (per its name) and excluded.
3. Read-only mode was honoured — no `npm install`, no `go mod tidy`, no `git` writes. Several findings (e.g. dependency-vulnerability scanning beyond version inspection, runtime `EXPLAIN ANALYZE` of queries) would require running tools and were therefore *advisory* based on static reading.
4. Where the same finding was filed by more than one agent (e.g. soft-delete leak, default `http.Transport`), it is counted **once** in §2 totals; the cross-references appear under each agent's log in `.audit/shared_memory.md`.
5. Severity calibration is "what an attacker / operator could do today against prod with the minimum information they could realistically obtain." CH3 downgraded a small number of findings on this basis (A4-F5, B3-1, E3-1).
6. CSV fixtures with real-prefix Indian phone numbers (C4-T2 / F2-4) were assumed to be team-internal numbers; this should be verified.
7. Phase 1E and 1F were executed by the orchestrator in the main context, not by sub-agents, after the Anthropic sub-agent quota cut off Phase 1E. The substance follows the same per-finding format; coverage is necessarily lighter than a full sub-agent pass would have produced. CH1 names what remains under-audited.

---

## 9. What Was NOT Audited (and why)

- **iOS Info.plist privacy strings, Android manifest permissions** — not opened. The mobile audit ran in static-source mode; native config was beyond the read window. CH1 dispatched a follow-up.
- **Production deployment infra** — no manifests visible (`kubernetes/`, `terraform/`, etc.) in the repo. Migration runner, prod env injection, and secret mounting are inferable from the .env shapes only. Open Question Q-DEPLOY-1.
- **`cmd/sim`, `cmd/stresstest`, `cmd/loadseed`, `cmd/promptdump`, `cmd/crm-integrity`, `cmd/stressui`** — only inventoried. They are internal tools; blast radius small. A 5-min smoke read is recommended for `cmd/sim/main.go` (510 LOC).
- **CRM frontend pages other than SettingsPage / api/all.ts** — Orders, Refunds, Users, Workers, LiveMap, Sessions, Disputes, Experiments, Localities, Promos, Push, Banners, Leaves, Payouts, Flags. Touched by C3 in aggregate; no per-page security/a11y/perf review.
- **Network egress firewalling** in production. A2-2's webhook SSRF severity assumes IMDS / RFC1918 are reachable from the API workload. Confirm at the cloud-provider level.
- **Dependency CVE scanning** beyond version inspection. A4 was instructed not to run `npm audit` or `go list -m -u`.
- **Pro screens RBAC behaviour** in the mobile UI (does the UI actually hide pro-only routes when `role!='pro'`). Source-level hints exist; runtime trace would be the truthful test.
- **Two binary artefacts** (`App/househelp-api/bin/api` 64 MB, `App/househelp-api/sim` ~14.7 MB) — not opened (treated as build artefacts; A4-F1 covers the policy violation).
- **Lockfile vs registry diff** for `package-lock.json` (Mobile + CRM): only inspected for shape, not delta.

---

## 10. Recommended Next Steps (advisory, prioritised)

The list is ordered for operational impact, not for engineering effort.

### Hour 0 — stop the bleed (do today)
1. **Rotate the Firebase admin private key.** Switch backend to ADC / secret-manager. Delete `App/househelp-api/secrets/zopmop-<REDACTED>.json` from the working tree.
2. **Rotate any other key that ever touched a developer machine** — Google Maps, Razorpay test, OpenRouter (per A3-S2). Apply per-platform restrictions (Android SHA-1 + package, iOS bundle ID).
3. **Add `fiber.Recover()` first** in both `cmd/api` and `cmd/crm-api` (closes B2-01 / E2-1 / E2-2).
4. **Add a per-IP rate-limiter to `cmd/crm-api`** (closes A5-01 / A1-F2).
5. **Permission-gate every CRM read** with `RequirePermission(...)` (closes A5-02). One-line addition per route.
6. **Disable the `/admin/_stub/:module` enumerator** (closes E2-4).

### Day 1 — close the money holes
7. **Implement the Razorpay verify route + webhook** (closes A3-S3, B4-1, B5-D4, F2-6).
8. **Refactor refund Approve to atomic flip-to-processing** (closes B1-1).
9. **Send `Idempotency-Key` to Razorpay** (closes D4-N8).
10. **Inject `X-Idempotency-Key` from `api/client.ts` for retries** on payments + roomies/book + helper status (closes A5-16, D4-N4, E1-1).
11. **Replace the timeout middleware** with `context.Context` deadlines instead of goroutine handover (closes B1-2).

### Week 1 — structural fixes
12. **Add CRM pre-upgrade rate-limit + CSRF + audit-on-read** (closes A5-02 with paper trail, F1-7).
13. **Wrap user reads in `UsersAlive()` and add a CHECK constraint on `users.role`** (closes B5-D1/D2, A1-F8, C2-04).
14. **Add a webhook URL allowlist** (closes A2-2).
15. **Build `pkg/httpx`** with shared `Transport`, jittered retry, circuit-break (closes D2-1, D4-N1/N2/N6).
16. **Tighten WS lifecycle** — ping/pong, write deadline, max conns (closes D2-2, D2-5, E2-7).
17. **Add `go test -race -short` to CI; fix Go-version drift; remove `bin/` and `loadtest/results/` from git** (closes E3-1/2/3).

### Week 2 — debt that will bite
18. **Pick a single migration runner** and add `schema_migrations` (closes B5-D7); resolve duplicate migration prefixes 049, 057, 058.
19. **Add tests on the booking/matching/payments/refunds hot path** with `testcontainers` (closes C4-T1).
20. **Plan: WIRE_OR_KILL each CRM-theatre module** (closes X4 / B4-1/3/4/5/7/12). Each module either gets a runtime consumer test or gets deleted.
21. **Consolidate polling behind WS+FCM** (closes X8).
22. **SDUI: codegen types from one schema; generate allowlist for `action.screen`** (closes C3-14/15, A2-1).
23. **DSAR endpoint + retention cron** (closes F2-2, F2-7).

### Week 3+ — architecture
24. **Outbox for booking side-effects** — the plan already exists at `App/househelp-api/docs/superpowers/plans/2026-05-01-booking-side-effects-outbox.md`; implement it (closes the long tail of B1-5/B5-D12 / B2-04).
25. **Distributed tracing + `/metrics`** on both apps (closes F1-2/F1-4).
26. **Helper FK reconciliation** (`bookings.helper_id` → `helpers(user_id)`?) and refund status enum fix (closes B5-D5, C2-01).
27. **Drop or fully wire `legacy promotions` vs `crm_promos`** (closes B4-5).

### Always
- Treat any `// TODO` in `internal/auth/repository.go:146` (helper approval) and the four roomies wallet TODOs as load-bearing comments — they describe holes that map to live findings (A1-F3, B5-D6, B4-1).
- Keep `.audit/shared_memory.md` as the working artefact for the next pass; do not delete it. New audits should append, not replace.

---

*End of report.*

---

## 11. DEEP-pass Addendum — full new finding list

The DEEP pass added 9 sub-agent logs (E1-DEEP, E2-DEEP, E3-DEEP, F1-DEEP, F2-DEEP, F3-DEEP, CH1-DEEP, CH2-DEEP, CH3-DEEP) that augment the Rev-1 sections. Per-finding evidence and advisory fixes are in `.audit/shared_memory.md`; this addendum lists IDs only.

### 11.1 New CRITICAL (7)
E2D-1, E1D-1, E1D-2, F2D-1, CH1D-1, CH1D-2, CH1D-3 — see §0.1.

### 11.2 New HIGH (selected)
- **E2D-3** Leave + roomies cron tickers no Stop hook → "use of closed connection" panics on SIGTERM.
- **E2D-5** Tracking WS no read-deadline rotation, no `SetReadLimit`, no max-conn cap; 1000 idle sockets ⇒ ~200 qps DB hammer.
- **E1D-3** README claim about session-only token is wrong; JWT persisted in SecureStore (`AuthContext.tsx:128-131`).
- **F1-D1** `internal/zop/service.go:1711-1723` Info-logs full chat content (120-byte preview). Net: log aggregator becomes chat-transcript store.
- **F1-D3** `internal/payments/handler.go:103` raw VPA logged on gateway error.
- **F2D-2** Zero retention crons across `helper_status_log`, `crm_audit`, `crm_login_attempts`, `processed_webhook_events`, `audit_log`, `crm_push_messages`, `bookings_scheduling_meta`.
- **F2D-3** `migrations/049_users_privacy_policy.sql` captures consent as a single boolean; no version, no per-purpose split, no withdrawal path.
- **E3D-1** `internal/middleware/ratelimit.go:47-55` `init()` reads APP_ENV/ENV before `godotenv.Load()` runs in `cfg.Load()` — dev relaxation never fires when env lives only in `.env`.
- **E3D-2** `cmd/api/main.go:9` blank-imports `_ "net/http/pprof"` unconditionally, wiring `/debug/pprof/*` onto `http.DefaultServeMux`. Any subsequent `http.ListenAndServe(addr, nil)` leaks profiles.
- **E3D-3** `report/.logs/`, `report/.prompts/`, `report/audit_security.md`, `App/househelp-api/report.json`, untracked `App/househelp-api/sim` (14.7 MB Mach-O), `bin/stressui` (8.7 MB) all NOT in `.gitignore`; no `.dockerignore` exists either, so `docker build` slurps `secrets/`, `.env*`, `bin/`, `sim`, `loadtest/` into the build cache.
- **CH1D-10** `internal/crm/audit/audit.go` no read auditing, swallowed write failures, no HMAC chain, missing `LogTx`.
- **CH1D-11** Migration 049 retroactively backfills consent (DPDP §6 violation).
- **CH1D-12** `crm_webhooks.secret TEXT` plaintext.
- **CH1D-4** Hardcoded GMSApiKey in iOS `Info.plist`.
- **CH1D-13** `pushRouter.ts` no role check.
- **CH1D-14** `locationPingQueue.ts` read-modify-write race.

### 11.3 New MED / LOW / INFO
~30 items; see DEEP agent blocks in shared_memory.

### 11.4 Files newly under-audited (CH1-DEEP residual list)
`AnalyticsPage`, `ExperimentsPage`, `PayoutsPage`, `auth/LoginPage` (TOTP path), iOS `AppDelegate.swift` + entitlements, full `android/` tree, `cmd/{loadseed,promptdump,crm-integrity,stresstest/*}.go`, migrations 035–036/042–048/052/053/055/056, single-pass utils `{netInfo,serviceability,toast,haptics,pendingAuthStore,promoStore,ratedBookingsStore}.ts`. Recommend a third pass or targeted security-review on these.

### 11.5 Audit completeness

- 37 agent logs total (22 Phase-1A–1D sub-agents + 6 Phase-1E/1F main-context + 3 Phase-2 main-context + 9 DEEP sub-agents).
- 12 named exploit chains (CH2 + CH2-DEEP).
- 13 cross-cutting clusters (X1–X13).
- 4 Rev-1 corrections (1 INVALIDATE, 3 DOWNGRADEs).
- ~396 distinct findings across all severities.

The audit is now substantially complete on the high-leverage areas; residual gaps in §11.4 are documented and bounded.

---

*End of report (Revision 2).*
