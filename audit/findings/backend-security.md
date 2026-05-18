# Backend Security Audit — ZopMop househelp-api

Subagent: Backend Security (1 of N).
Scope: `App/househelp-api/` (Go 1.26 / Fiber v2), full handler/middleware/service surface.
Method: read of `cmd/api/main.go`, every middleware in `internal/middleware/`, all customer/pro-facing handlers under `internal/{auth,booking,helper,addresses,location,places,payments,zop,referral,disputes,offers,roomies,insights,bff}`, plus grep sweeps for SQL `fmt.Sprintf`, multipart uploads, `err.Error()` leakage, and the rotated Google Maps key.

Cross-referenced prior audits: `security_audit_report.md`, `AUDIT_2025_2026-05-03.md`, the in-tree `docs/audits/` references.

Overall: the backend is in noticeably better shape than the 2025 audits suggest. Hardening that's already landed: helmet headers, locked-allowlist CORS, CSRF double-submit, per-route rate limiting (incl. Redis fallback), JWT validation with kid rotation, IDOR enforcement at the repository layer for bookings/addresses, HMAC + replay window on Cashfree webhooks, parametrised queries throughout, and a working secret-strength validator in `pkg/config`. The findings below are the residual risks plus a handful of new items.

---

## CRITICAL

[SEVERITY: Critical]
[FILE: App/zopmop-app/app.json:40, App/zopmop-app/app.json:94, App/zopmop-app/ios/zopmopapp/Info.plist:6, App/zopmop-app/ios/zopmopapp/AppDelegate.swift:43]
[CATEGORY: Backend Security / Secrets in source (mobile-side, but server impact)]
Finding: The "rotated" Google Maps API key `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` is committed in plaintext in four places in the mobile app source tree. `git log -p -S "AIzaSy"` shows the *previous* key (`AIzaSyDvyOQs4SFHLZoupsERIXBCKUhAHMSJU7w`, commit `659a79f`) was burned and rotated in commit `b815c0a` to the value currently in tree. So the current key is technically the "rotated" one — but it is **also embedded in version control**, which means the rotation only bought a moving target, not actual key hygiene. Both keys are now permanently in repo history.
Impact: Anyone with read access to the repo (or to a published Expo bundle / iOS .ipa) can lift the key and run up Distance Matrix / Places quota until budget alert fires. Server-side `GOOGLE_MAPS_API_KEY` (used by `cmd/api/main.go:318` and `internal/matching/engine.go` filterByWalkingTime) is a separate env var — confirm it is NOT this same key, or the abuse can also block instant-booking matches.
Fix: 1. Confirm in Google Cloud Console that the iOS bundle (`com.zopmop.app`) and Android SHA-1 restrictions are active for this key, AND that quota caps are set (10k/day on Distance Matrix is plenty for current scale). 2. Server-side `GOOGLE_MAPS_API_KEY` must be a separate, unrestricted (server-IP-locked) key, never shared with the mobile client. 3. Treat the in-repo key as already-compromised: rotate again, and this time consume it via `app.config.js` reading `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` from EAS secrets — never write the value into `app.json` or `Info.plist`. 4. `git filter-repo` is not worth it on a public repo at this scale; instead make the rotation the security boundary.
Evidence: `App/zopmop-app/app.json:40` `"apiKey": "AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0"` and identical strings at the three other lines above. History: `git log --all --oneline -S "AIzaSy"` → 4 commits including the burned-key commit `659a79f`.
Status vs prior audits: `security_audit_report.md:113` flagged the original burned key. The fact that the rotation also went into source tree is a regression / unfinished follow-through, not a new mistake — but it is still Critical because the value is in repo and bundles.

---

## HIGH

[SEVERITY: High]
[FILE: App/househelp-api/internal/zop/handler.go:89-101]
[CATEGORY: Backend Security / Input validation + DoS / cost-control]
Finding: `Chat` does not bound the length of `req.Message`. The cleaner + agent loop both forward the user message into OpenRouter prompts; long inputs translate directly into OpenRouter token cost and into the cleaner's prompt-injection surface. The route is gated by `mw.RequireRole("customer")` + `authLimiter` (100 req/min) but a single 64 KB message per request still slips through Fiber's 4 MB BodyLimit and the per-handler 90s Timeout — enough headroom to exhaust the LLM budget very quickly.
Impact: (a) Cost DoS: 100 messages × 50 KB each × N concurrent authenticated customers easily blows through the OPENROUTER monthly cap, particularly with the 70B agent loop. (b) Prompt-injection footprint: more characters = more places for jailbreak payloads to hide. The cleaner is best-effort, not a security boundary.
Fix: Cap `req.Message` to a small, hard limit (suggest 2000 chars to match `booking/messages.go:205` chat limit). Reject with 413 before the rate-limiter check. Also consider a per-user daily token budget tracked in Redis.
Evidence: `internal/zop/handler.go:94` only checks `strings.TrimSpace(req.Message) == ""`. The grep confirms only `service.go:1024` reads `len(message)` and that's purely for a log field.

[SEVERITY: High]
[FILE: App/househelp-api/internal/auth/handler.go:330-338]
[CATEGORY: Backend Security / Information disclosure]
Finding: `SendOTP` returns the plaintext OTP in the response when `s.devOTPEnabled` is true (`internal/auth/service.go:157-160`). That flag is bound to `cfg.IsDevelopment()` per `cmd/api/main.go:258`. The risk is configuration: if `APP_ENV` is left at the empty string or anything other than `production`, `IsDevelopment()` returns true and the API will hand out OTP codes to anyone who hits `/api/v1/auth/send-otp`.
Impact: One mis-set Railway env var on the production service and authentication is fully bypassed for any phone the attacker controls in the response.
Fix: Either (a) make the production check explicit and fail-closed — require `APP_ENV=production` AND error if devOTPEnabled is true when running on the Railway prod URL, or (b) drop the response field entirely and use a development-only stub SMS provider that prints to logs. Add a regression test that compiles the prod binary with `APP_ENV=production` and asserts the OTP field is empty.
Evidence:
```go
// service.go:157
if !s.devOTPEnabled { return "", isNewUser, nil }
return otpCode, isNewUser, nil
// handler.go:334
if otp != "" {
    response["otp"] = otp
    response["note"] = "OTP included in response for development only"
}
```

[SEVERITY: High]
[FILE: App/househelp-api/internal/bff/admin_handler.go (many lines, e.g. 96, 106, 125, 150, 165, 186, 205, 222, 237, 258, 282, 302, 331, 347, 373, 386, 398, 419, 431, 442, 455, 465, 481)]
[CATEGORY: Backend Security / Error leakage]
Finding: 24+ call sites return `err.Error()` directly to the client in JSON 4xx/5xx responses. Many of these will surface raw pgx / unmarshaling / schema-validator messages including column names, constraint names, and (for the JSON validator) potentially the offending source text.
Impact: Admin-only group (gated by `AdminMiddleware` + `SduiAdminAuth`), so blast radius is limited to authenticated admins. Still leaks DB schema details and aids any attacker who pivots an admin session (e.g. via OAuth phish on a logged-in admin browser, since CSRF is enforced but session theft via XSS in the CRM bundle is not).
Fix: Wrap repo errors at the service layer with sentinel errors and map them in the handler; never return `err.Error()` to clients. Mirror the booking-handler pattern at `internal/booking/handler.go:107-163` (sentinel-mapping with error codes).
Evidence: Sample: `internal/bff/admin_handler.go:96` `return c.Status(500).JSON(fiber.Map{"error": err.Error()})` — at minimum 24 occurrences in this one file.

[SEVERITY: High]
[FILE: App/househelp-api/cmd/api/main.go:736-740]
[CATEGORY: Backend Security / TLS/binding]
Finding: `app.Listen(addr)` binds to `":<port>"`, i.e. all interfaces, with no TLS. On Railway this is intentional (the platform terminates TLS in front of the container) — but in any other deployment (running the Dockerfile on a bare host, or pulling the image into a private VPC without an external proxy) the app serves cleartext on the public interface. There is no startup guard that warns or refuses to start without a proxy.
Impact: Minor on Railway; high if the same image is ever deployed without Railway's edge.
Fix: Add a startup log line stating "expecting upstream TLS termination at <PUBLIC_BASE_URL>", and refuse to boot in production when `PUBLIC_BASE_URL` starts with `http://`. The Cashfree branch in `pkg/config/config.go:258` already enforces this for the gateway path — extend the check globally when `APP_ENV=production`.
Evidence: `main.go:735` `addr := fmt.Sprintf(":%s", cfg.Port)` followed by `app.Listen(addr)` with no TLS / bind-host config.

---

## MEDIUM

[SEVERITY: Medium]
[FILE: App/househelp-api/cmd/api/main.go:735, App/househelp-api/internal/middleware/admin.go:25-103, App/househelp-api/internal/middleware/auth.go:147-149]
[CATEGORY: Backend Security / Locals key drift (architectural risk)]
Finding: `AuthMiddleware` writes the user ID into Fiber Locals via the constant `LocalsKeyUserID = "userID"` (see `internal/middleware/locals.go`). Every subsequent middleware and handler then reads `c.Locals("userID")` as a hardcoded string literal — including `admin.go:27`, `admin_auth.go:32`, and every handler in `auth/booking/addresses/helper/etc`. The `LocalsKeyUserID` constant was introduced after a prior incident (audit E2D-1: `userID` vs `user_id` typo collapsed every user into the empty-string namespace and cross-leaked an idempotent booking response) — but only the writer in auth.go uses the constant.
Impact: The next time someone refactors a `c.Locals("userID")` call to `c.Locals("user_id")` (or vice versa) the bug recurs silently. The constant exists specifically to make that drift impossible; failing to use it everywhere defeats the defense-in-depth.
Fix: Replace every string-literal `c.Locals("userID")` (Bash grep returns 80+ call sites) with `c.Locals(middleware.LocalsKeyUserID)`. Add a `staticcheck` or `forbidigo` rule banning the literal in `internal/**` (allow only in `middleware/locals.go`).
Evidence: `auth.go:148` `c.Locals(LocalsKeyUserID, userIDStr)` (the only writer using the constant). `admin.go:27` `userID, ok := c.Locals("userID").(string)` (literal). `idempotency.go:53` correctly uses `LocalsKeyUserID` — half-converted refactor.

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/admin.go:65-69]
[CATEGORY: Backend Security / Error handling / privilege escalation surface]
Finding: When `AdminMiddleware` cannot reach the DB (DNS, transient pool exhaustion), the lookup query returns an error and the middleware responds 403 "insufficient permissions" (`admin.go:71-74`). That's the wrong failure mode: a transient DB blip locks admins out — and worse, the 403 response is identical to "user is not an admin", which obscures the difference between "DB outage" and "user actually has no admin row". Note: prior chunk-16 audit work (referenced in the source comments) fixed the analogous case for AuthMiddleware (5xx + AUTH_CHECK_FAILED). Admin lookup did not get the same treatment.
Impact: Operationally bad (admin lockout during DB outages); also a mild information leak (silent failure makes incident response harder).
Fix: Distinguish `pgx.ErrNoRows` (legitimate 403) from any other err (5xx with AUTH_CHECK_FAILED), mirroring the auth-middleware pattern at `auth.go:122-132`.
Evidence:
```go
err = db.QueryRow(...).Scan(&adminID, &permissionsJSON)
if err != nil {
    log.Error().Err(err).Str("user_id", userID).Msg("admin lookup failed")
    return c.Status(fiber.StatusForbidden).JSON(...)  // collapses both cases
}
```

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/security.go:47-74]
[CATEGORY: Backend Security / CORS]
Finding: CORS is configured with `AllowCredentials: true` and an allowlist read from `ALLOWED_ORIGINS`. When the env var is empty the middleware locks to a sentinel `https://cors-disabled.invalid` — good. But: there is no enforcement that the allowlist entries themselves are HTTPS in production, and no rejection of suspicious values (e.g. wildcards, `null`, file URLs). A misconfigured env value like `*` would be passed straight to Fiber and Fiber's cors middleware does allow `*` literally, but `*` with credentials is rejected by browsers — so the practical impact is "CORS just stops working" rather than full bypass. Still worth defending.
Impact: Low likelihood of real exploit, but the config surface should refuse to accept `*` when AllowCredentials is true.
Fix: Validate at config load: reject any allowed origin that is `*`, `null`, or not `https?://...`. In production, require all origins to be `https://`. Log loud on startup.
Evidence: `security.go:50-54` only filters empty strings.

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/csrf.go:39-44]
[CATEGORY: Backend Security / CSRF bypass surface]
Finding: The CSRF middleware skips any request that presents an `Authorization` header (line 41-44). The comment is correct that Bearer tokens are not auto-attached by browsers, but the implementation skips on the *presence* of the header, not on its validity. A page on an attacker-controlled origin can trivially construct a `fetch(..., {credentials:"include", headers:{Authorization:"Bearer x"}})` from JS — the browser WILL send the cookie because of `credentials:"include"`, and Fiber's CSRF will skip because `Authorization` is non-empty. The cookie auth path then validates the JWT in the cookie and lets the request through.
Impact: Real CSRF bypass for the cookie-auth (browser) flow. The mobile app doesn't have a cookie so it's unaffected, but the CRM admin web app uses cookie auth.
Fix: Either (a) skip CSRF only when there is NO cookie (`c.Cookies(AuthCookieName) == ""`), so a request with both a cookie and a header still gets CSRF'd, or (b) reject requests that present both cookie and Authorization header outright. Option (a) is cleaner.
Evidence:
```go
Next: func(c *fiber.Ctx) bool {
    if c.Get("Authorization") != "" { return true }  // bypass condition
    ...
}
```

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/auth.go:74-87]
[CATEGORY: Backend Security / Token source precedence]
Finding: AuthMiddleware prefers the `Authorization: Bearer` header over the `auth_token` cookie. Combined with the CSRF skip above (M-7), an attacker who can plant a same-site request with both a stale Authorization header (e.g. captured from a TLS-misconfigured origin) AND the victim's session cookie ends up authenticated as either user, depending on which token middleware picks. This is mainly a CSRF-amplifier and is mitigated by fixing the CSRF skip above; flagging it explicitly because the precedence is asymmetric to the CSRF skip's assumption.
Impact: Low alone; medium combined with the CSRF skip finding.
Fix: When both sources are present, prefer the cookie and ignore the header (browser context), OR explicitly reject as ambiguous. Document the precedence in the function comment.
Evidence: `auth.go:76-87` — header checked first, cookie only if header empty.

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/ratelimit.go:43-56]
[CATEGORY: Backend Security / Rate limit fail-mode]
Finding: `PublicRateLimit.FailureMode = "local-fallback"` means on Redis outage the limiter falls back to an in-process counter (presumed). For an IP-keyed counter spread across N Fiber workers / pods this means an attacker who knows Redis is down can flood from one IP and only hit 1/N of the configured ceiling. Critical-path public endpoints inherit `PublicRateLimit` (e.g. `/insights/nearby`, `/zones`, SDUI `/app/*` under public group). Auth endpoints use `SensitivePublicRateLimit` with `fail-closed` (good).
Impact: Degraded protection during partial outages, not full bypass. Distinct from the SMS-bombing flow (which has its own per-phone limiter in `auth/service.go`).
Fix: Document the trade-off explicitly. Consider switching `PublicRateLimit` to `fail-closed` in production once Redis HA is confirmed, or use a token-bucket-with-local-fallback that's globally consistent in steady state.
Evidence: `ratelimit.go:43` `FailureMode: "local-fallback"`.

[SEVERITY: Medium]
[FILE: App/househelp-api/cmd/api/main.go:505-508]
[CATEGORY: Backend Security / Cost-control / DoS via paid API]
Finding: `/api/v1/places/autocomplete` is JWT-gated (good) but mounted with only `authLimiter` (100 req/min per user) and no `dbBoundLimiter` (because it doesn't touch the DB). Every request fans out to the Google Places Autocomplete API which is billable per call. An authenticated user can burn through Places quota at 100 calls/min sustained, or 6000 in an hour, with no per-user cost cap. Combined with the `q` length cap (2-100 chars at `places/handler.go:29-31`) that's still ~hundreds of dollars/month/abuser at Places pricing.
Impact: Bill-shock DoS by any authenticated user. Reflected in Google Cloud bill, not in service availability.
Fix: Add a `NamedRateLimiter` keyed per user at 20 req/min (matches realistic typing cadence) and/or short-circuit cache hits in Redis with a 5-minute TTL for the same `q`.
Evidence: `main.go:507` `placesGroup := api.Group("/places", authMiddleware, authLimiter)` — no places-specific limiter, no Redis cache wrapping in `places/handler.go`.

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/security.go:64-73]
[CATEGORY: Backend Security / CORS / preflight]
Finding: `AllowMethods` includes `OPTIONS` and `AllowHeaders` includes `X-Csrf-Token`, but the header list is missing `Idempotency-Key` (used by booking-create idempotency middleware at `main.go:445`). Browser clients in CORS contexts will fail preflight when they try to send Idempotency-Key. Not a security regression per se, but degrades the idempotency protection for any non-mobile booking path (e.g. future web booking flow / CRM).
Impact: Browsers in CORS context cannot use idempotency. Bookings created via the CRM web app may double-charge on accidental retries.
Fix: Add `Idempotency-Key` to `AllowHeaders`.
Evidence: `security.go:69` `AllowHeaders: "Origin,Content-Type,Accept,Authorization,X-Request-ID,X-Csrf-Token"`.

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/payments/handler.go:419, App/househelp-api/internal/payments/handler.go:683]
[CATEGORY: Backend Security / Information disclosure]
Finding: The booking-payment ownership check responds with the specific code `not_owner` and message `booking does not belong to caller`. Combined with the separate `booking_not_found` response, this is enough for an enumeration probe to distinguish "this booking ID exists and isn't mine" from "this booking ID doesn't exist" — useful for ID enumeration if booking IDs were ever sequential. They are UUIDs so the enumeration risk is low, but the booking handler's `GetBookingByID` (`internal/booking/repository.go:73-78`) is more conservative — it returns "booking not found" in both cases specifically to prevent this distinction.
Impact: Minor (UUIDs aren't enumerable in practice), but inconsistent with the rest of the codebase's posture.
Fix: Unify on the booking-repository pattern: collapse "not found" and "not owner" into the same 404 response. Internal logs still distinguish the cases for incident response.
Evidence:
```go
// handler.go:418-420
if bookingCustomerID != userID {
    return errResp(c, fiber.StatusForbidden, "not_owner", "booking does not belong to caller")
}
```
vs. booking/repository.go:74-77:
```go
if b.CustomerID != requestingUserID {
    if b.HelperID == nil || *b.HelperID != requestingUserID {
        return nil, fmt.Errorf("booking not found") // Intentionally vague
    }
}
```

[SEVERITY: Medium]
[FILE: App/househelp-api/internal/booking/handler.go:155-158]
[CATEGORY: Backend Security / Error leakage]
Finding: `CreateBooking` echoes `err.Error()` back to the client for two specific cases — "maximum active bookings limit reached" and "service category is not available". The strings themselves are safe today, but the pattern of `err.Error() == "literal"` followed by `message = err.Error()` is fragile: any future repo error that happens to match these strings (or that wraps them) becomes part of the public API. The booking handler is otherwise the gold standard for mapping sentinels — these two lines are a regression.
Impact: Low today; mid risk of accidental leak via a future code change.
Fix: Replace with sentinel errors (`var ErrMaxActiveBookings = errors.New("maximum active bookings limit reached")`) and `errors.Is` checks. Same for the `cart is empty` / `time slot not found` branches.
Evidence: `handler.go:155-157`:
```go
} else if err.Error() == "maximum active bookings limit reached" || err.Error() == "service category is not available" {
    status = fiber.StatusBadRequest
    message = err.Error()
}
```
Similar at `handler.go:303-306`, `handler.go:415-426`, `handler.go:600-603`.

---

## LOW

[SEVERITY: Low]
[FILE: App/househelp-api/cmd/api/main.go:127-144]
[CATEGORY: Backend Security / Operational / pprof]
Finding: `ENABLE_PPROF=1` starts a pprof listener on `127.0.0.1:6060`. The binding to localhost is correct. The build tag (`-tags pprof`) is required for handlers to actually register (per the comment); the listener starts unconditionally. So a `ENABLE_PPROF=1` env var on a non-pprof build serves an empty mux on 6060. Harmless, but wastes a port and creates startup-log noise.
Impact: None security-wise (no handlers registered). Minor operational annoyance.
Fix: Move the listener startup behind the same build tag.
Evidence: `main.go:127-143`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/security.go:33-36]
[CATEGORY: Backend Security / HSTS preload]
Finding: `HSTSPreloadEnabled = true` is set in production. Preload requires that you commit to *every* subdomain serving HTTPS for the indefinite future before submitting to hstspreload.org. The Railway production URL is `zopmop-production.up.railway.app`, not `zopmop.com`, so preloading the Railway URL is a no-op (it's not what would be preloaded). If/when a custom `api.zopmop.com` is added, this preload flag becomes load-bearing — verify the marketing site, the CRM, and any subdomain are fully HTTPS before going live with the custom domain. Documenting because the current setup looks intentional but is effectively a tripwire.
Impact: None today, only matters when a custom API domain is wired up.
Fix: Document in CLAUDE.md. Confirm hstspreload status of `zopmop.com` before pointing the api at it.
Evidence: `security.go:36` `cfg.HSTSPreloadEnabled = true`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/auth.go:96-101, internal/middleware/auth.go:139-145]
[CATEGORY: Backend Security / Suspension check legacy path]
Finding: When `checker == nil`, AuthMiddleware falls back to the JWT-claim `is_suspended` (line 139). This is documented as "tests only" but the fallback is also active in any prod binary where the wiring breaks silently (e.g. a future refactor that forgets to pass the repo). Drift risk.
Impact: A suspension that should take effect immediately could lag by up to `JWT_EXPIRY_HOURS` if the legacy path is unintentionally re-entered.
Fix: Require non-nil checker in production: `if checker == nil && cfg.IsProduction() { log.Fatal(...) }`. Or: drop the legacy path entirely and update tests to inject a stub checker.
Evidence: `auth.go:115` `if checker != nil {` ... `else if isSuspended, ok := claims["is_suspended"].(bool); ok && isSuspended { ... }`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/booking/messages.go:108-115]
[CATEGORY: Backend Security / Error leakage]
Finding: `authorizeChatParty` returns `fmt.Errorf("failed to load booking: %w", err)` for any non-ErrNoRows DB error. The handler at `messages.go:180-184` only maps the string literal "booking not found" and "forbidden"; any other error falls through to a generic 500 — but the wrapped pgx error is still in the response if a future refactor surfaces it.
Impact: Low. Currently safe because the handler does not propagate wrapped errors. Flagged as a stylistic risk so it doesn't regress.
Fix: Use sentinel errors at the service boundary.
Evidence: `messages.go:115` `return "", fmt.Errorf("failed to load booking: %w", err)`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/admin/handler.go:241-243]
[CATEGORY: Backend Security / Error leakage]
Finding: `SettleRefund` echoes `err.Error()` for the "refund not found or already settled" case. Admin-only, low impact, included for completeness.
Impact: Negligible (admin auth required).
Fix: Same sentinel-error pattern as flagged elsewhere.
Evidence: `admin/handler.go:241-244`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/admin.go:99-101]
[CATEGORY: Backend Security / TOCTOU]
Finding: Admin permissions are cached in Redis for 5 minutes (`adminCacheTTL`). Revoking an admin's permission (via the admin CRUD endpoints) does not bust the cache, so the affected admin retains effective permissions for up to 5 minutes after revocation.
Impact: Operational risk during incident response when revoking compromised admin sessions. Live suspension via `is_suspended` (handled separately, see `auth.go:115-132`) is unaffected — the user is still locked out, but if only their *permissions* changed (not their account), the change lags.
Fix: On admin permission write, DEL the corresponding `admin:perms:%s` key. Cheap and stops the lag cold.
Evidence: `admin.go:94` `if cacheErr := rdb.Set(ctx, cacheKey, permsJSON, adminCacheTTL).Err(); ...`. No DEL on admin update found via grep.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/payments/handler.go:73-74]
[CATEGORY: Backend Security / Secret handling at boot]
Finding: Cashfree Payouts (NewHandler) reads `CASHFREE_CLIENT_ID/SECRET` directly via `os.Getenv` rather than through `pkg/config`. This skips the all-or-none + strength validators that the rest of the Cashfree config goes through (`pkg/config/config.go:232-262`). If the operator sets one but not the other, the handler boots silently and only fails at first call with a 503.
Impact: Operational, not security per se. Bypasses the centralised secret validator.
Fix: Pull CASHFREE_CLIENT_ID/SECRET + CASHFREE_BASE_URL/ENV into `pkg/config`, validate as a unit, and inject into NewHandler. Mirror the PG-side wiring.
Evidence: `payments/handler.go:62-78`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/booking/repository.go:67-70]
[CATEGORY: Backend Security / Error envelope leakage]
Finding: `GetBookingByID` returns `fmt.Errorf("failed to get booking: %w", err)` for non-ErrNoRows DB errors. Currently the handler at `internal/booking/handler.go:177-181` always maps to a static "booking not found" 404 response so nothing leaks — but as above, the wrapped error message contains the raw pgx error if a future refactor exposes it.
Impact: None today; latent risk.
Fix: Use sentinel errors.
Evidence: `repository.go:69-71`.

[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/csrf.go:55-58]
[CATEGORY: Backend Security / CSRF skip list audit]
Finding: CSRF is also bypassed for any path under `/api/v1/auth/`. Most auth routes are state-changing (verify-otp, firebase-auth, logout) and are protected only by the rate limiter + cookie scoping. Logout in particular *should* be CSRF-protected because the user has a cookie by that point. Right now an attacker page can force-logout an authenticated browser session — annoying, not exploitable.
Impact: Forced logout via CSRF on `/api/v1/auth/logout`. Minor UX-grade nuisance.
Fix: Tighten the skip to only the pre-session endpoints (`/auth/send-otp`, `/auth/verify-otp`, `/auth/firebase`). Make `/auth/logout` CSRF-protected like any other state change.
Evidence: `csrf.go:56-58` skips all `/api/v1/auth/`.

---

## NIT

[SEVERITY: Nit]
[FILE: App/househelp-api/cmd/api/main.go:719-721]
[CATEGORY: Backend Security / Style]
Finding: Trailing slash routes (`POST "/"`) registered on a grouped path can cause subtle 404 vs 405 differences depending on Fiber's strict-routing flag. The default is non-strict so `/api/v1/events` and `/api/v1/events/` both match — but this differs from the canonical Fiber example, easy to break on upgrade.
Impact: None today.
Fix: Explicit path: `analyticsClientGroup.Post("", ...)`.

[SEVERITY: Nit]
[FILE: App/househelp-api/internal/middleware/security.go:67]
[CATEGORY: Backend Security / Style]
Finding: `AllowMethods` includes both `PATCH` and `DELETE` but the CRM web app may not use them; trimming the list reduces preflight noise. Cosmetic.

---

## Items reviewed and explicitly OK

- **SQL injection**: 15 SQL `fmt.Sprintf` occurrences inspected. All use `$N` placeholders for value bindings and only interpolate column/table identifiers from in-tree literals (e.g. `services/repository.go:131`, `compliance/jsonb_scrub_repo.go:86`, `matching/dispatch.go:242`). No raw value concatenation found.
- **Booking IDOR**: `repository.go:73-78` enforces customer or assigned-helper ownership and returns a vague "booking not found" for both cases. Service calls into `GetBookingByID` consistently pass the authenticated user ID.
- **Address IDOR**: addresses repo always scopes by `user_id = $auth` (e.g. service.go:127 + repo Update/Delete). Booking creation re-verifies address ownership at `internal/booking/service.go:1001`.
- **Helper location IDOR**: `internal/location/handler.go:255-290` restricts GET /helper/:id to admin, the helper themselves, or a customer with an ACTIVE booking. Explicitly enforced via SQL `WHERE` clause.
- **Booking messages**: `messages.go:100-126` authorises both parties via `customer_id` / `helper_id` lookup before any read/write.
- **Cashfree webhook**: HMAC-SHA256 with timestamp + raw body, replay window 300s, signature failures and stale timestamps both 4xx. `internal/payments/cashfree.go:415-446`. Excellent.
- **Phone in logs**: every grep'd `phone` log call goes through `logger.MaskPhone` (e.g. `auth/handler.go:326`). No raw PII in logs found in non-CRM code.
- **VPA in logs**: masked via `logger.MaskVPA` at `payments/handler.go:180`.
- **OTP in logs**: explicitly skipped (`auth/service.go:152`).
- **JWT strength**: `pkg/config/config.go:298-319` rejects short/blocked-substring secrets; HS256-only verification in `middleware/jwt.go:25,53`.
- **File uploads**: none. No multipart handlers exist in `internal/`.
- **PostGIS unbounded radius**: matching engine no longer uses an explicit radius gate — eligibility is decided by the Distance Matrix walking-time check, with `candidateFetchLimit` bounding fetch size. Insights queries pre-filter via Redis GEOSEARCH inside a fixed radius. No user-controlled `ST_DWithin` radius found.
- **Mass-assignment**: User-facing structs (`UpdateProfileRequest`, `OnboardProRequest`) are whitelisted to non-privileged fields. Role/approval/wallet fields are never bound via `BodyParser`.
- **Firebase service-account**: gitignored at repo root (`.gitignore:1-2`); compose mounts ro at `/app/secrets/firebase-adminsdk.json`.

---

## QUESTIONS FOR ADITYA

1. The Google Maps key `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` in app.json/Info.plist — is it the post-rotation key (per memory) or the still-current burned one? Either way, see Critical-1: it is in repo history, so it should be rotated again and consumed via EAS secret rather than committed.
2. Server-side `GOOGLE_MAPS_API_KEY` (`cmd/api/main.go:318`) — is it the same key as the mobile client's, or a separate server-IP-restricted key? If the same, rotate immediately and split.
3. CRM admin web app — does it use cookie auth or bearer auth? Answer determines whether the M-CSRF-skip finding is urgent or merely a hardening item.
4. Is there an existing per-user OpenRouter token budget / quota beyond the `ZopRateLimiter` 100req/min? If not, the High-zop-message-length finding is doubly important.
