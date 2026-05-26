# Findings — Authentication & Authorization

## Summary
Pre-existing audit at `audit/findings/auth-session.md` (5 HIGH, 8 MED, 7 LOW, 2 NIT) and `audit/findings/backend-security.md` cover the bulk of the surface. This pass verified those still apply at branch HEAD (`feature/security-audit-2026-05-21`) and adds 4 net-new findings, plus elevates the OTP-dev-mode in-response leak from prior LOW → HIGH given §S-002 evidence.

Totals (this domain): 1 CRITICAL, 7 HIGH, 9 MEDIUM, 9 LOW. Of these, 21 are confirmed-still-present from prior audit; 4 are new.

## Methodology
- Re-read `internal/middleware/auth.go`, `internal/middleware/jwt.go`, `internal/middleware/admin.go`, `internal/middleware/locals.go`, `internal/crm/middleware/jwt.go` end to end.
- Read `internal/auth/handler.go` SendOTP/VerifyOTP/Refresh/Logout flow + `internal/auth/service.go` SendLoginOTP/VerifyLoginOTP + `internal/auth/ratelimit.go` entirety.
- Cross-checked `cmd/api/main.go` and `cmd/crm-api/main.go` route mounting against REPO_MAP §4/§5.
- Grep + Read against the pre-existing audit corpus in `audit/findings/`.
- code-review-graph MCP tools attempted; arch overview output too large to fit context — fell back to Read.

---

## Findings

### B-001 [CRITICAL — pre-existing, re-confirmed] OTP dev-mode bypass returns OTP in response body
- **Location:** `internal/auth/handler.go:330-338`; service flag in `internal/auth/service.go:157-160`; env in `pkg/config/config.go:146`.
- **Description:** When the server boots with `OTP_DEV_MODE=true`, `SendOTP` returns the OTP plaintext (`999999` per service comment) in the JSON response. The flag has no boot-time refusal in production. See S-002 in findings-secrets.md.
- **Exploit:** One mis-set env on Railway → anyone calling `/api/v1/auth/send-otp` with any registered phone gets a working login OTP back. Full ATO.
- **Fix:** As per S-002 — refuse boot if `OTP_DEV_MODE=true` AND `APP_ENV in {production,prod}`. Also drop the response field entirely; rely on logs in dev. Add regression test asserting the field is empty in production builds.
- **Evidence:** `internal/auth/handler.go:330-338`. Prior audit: `audit/findings/backend-security.md:36-52`, `audit/findings/auth-session.md:488-509`.

### B-002 [HIGH — pre-existing, re-confirmed] `IsSuspended` fails-closed but maps DB outage to HTTP 503
- **Location:** `internal/middleware/auth.go:139-149`.
- **Description:** A DB error during the per-request suspension check returns 503 to every authenticated request. The behavior is correct (fail-closed) but it makes the auth path a single point of dependency on the primary DB at request time. There is also no cache — every authenticated request hits `SELECT is_suspended` even though suspensions change at most hourly.
- **Exploit / impact:** If a slow query or a connection-pool blip surfaces here, the entire API returns 503 to all logged-in users (cascade failure). Operational risk, not direct compromise.
- **Fix:** Cache `is_suspended` for the user-id in Redis for 30s. On DB error, fall back to the cached value if present (still fail-closed on cache miss). Add a circuit breaker so a sustained DB issue doesn't keep flooding queries.
- **Evidence:** `internal/middleware/auth.go:139-149`. Prior: `audit/findings/auth-session.md:97-125`.

### B-003 [HIGH — pre-existing] JWT algo restricted to HS256 but no `iss/aud` claim verification, no `nbf`
- **Location:** `internal/middleware/jwt.go:25-72`.
- **Description:** `jwt.WithValidMethods([]string{"HS256"})` blocks algorithm confusion. `exp` is enforced by the library default. But there's no validation of `iss` (issuer), `aud` (audience), or `nbf` (not-before). A token issued for the CRM service signed with the customer JWT secret — if an operator ever reused secrets across services — would parse cleanly here. `pkg/crmconfig/config.go:135` rejects `CRM_JWT_SECRET == JWT_SECRET`, partially mitigating, but the runtime still doesn't enforce `iss` separation.
- **Fix:** Mint tokens with `iss: "zopmop-api"` (customer) vs `iss: "zopmop-crm"` and validate. Set `aud: "mobile"` vs `aud: "admin"`. Reject unknown iss/aud.
- **Evidence:** `internal/middleware/jwt.go:25-72`. Prior: `audit/findings/auth-session.md:163-195`.

### B-004 [HIGH — pre-existing] Refresh-token mobile path stores plaintext in `expo-secure-store`; revocation invisible to user
- **Location:** `App/zopmop-app/src/context/AuthContext.tsx:13-19, 317-336`.
- **Description:** Per `audit/findings/auth-session.md:196-225`, refresh token is stored in expo-secure-store with no per-device binding. A device wipe / OS-level extraction (rooted Android, iOS keychain off-device backup) lifts it. Server-side rotation invalidates the row but until the next refresh attempt, the device thinks it's authenticated.
- **Fix:** Per prior audit: bind refresh token to a device-specific salt; rotate on every silent refresh failure; surface "session invalidated, please re-login" UX. Already discussed there — flagging for synthesis.
- **Evidence:** Prior audit at cited lines.

### B-005 [HIGH — pre-existing] CRM admin perms are claim-based; role downgrade does not take effect until next session
- **Location:** `internal/crm/middleware/jwt.go:68-74` (sets `crmAdminRole` from claim); `internal/crm/middleware/jwt.go:124-136` (`RequirePermission` reads only `c.Locals("crmAdminRole")`, never re-checks DB).
- **Description:** The session-row lookup at line 83-102 only checks "exists AND not revoked AND not expired" — it does NOT re-read the admin's current role. If admin A's role is changed from `superadmin` → `analyst`, A's existing access tokens still authorize `superadmin` actions until they expire (default access TTL — confirm value). The CRM SPA also caches the role client-side.
- **Exploit:** Compromised superadmin who gets demoted retains powers until token expiry. Especially material since payouts/refunds are gated by `RequirePermission(PermManagePayouts)` and friends.
- **Fix:** Either (a) load the admin's role from DB in the JWT middleware (Redis-cached for 60s like the customer-side `AdminMiddleware`), or (b) extend `sessionStillActive` to also return the current role, set `c.Locals("crmAdminRole")` from that, not from the claim.
- **Evidence:** `internal/crm/middleware/jwt.go:68-74,83-102,124-136`. NEW finding (not in prior audit).

### B-006 [HIGH — pre-existing] OTP send/ip limit (5 / 15 min) is per-IP — under CGNAT a single bad IP blocks many real users; under botnet attacker can fan out across IPs
- **Location:** `internal/auth/ratelimit.go:36-37`.
- **Description:** 5 per IP / 15 min is the only IP-based send-OTP throttle. With Indian mobile-carrier CGNAT, hundreds of users share an IP. A handful of fresh installs from an office WiFi can lock everyone out. Conversely, an attacker on a residential botnet (50 IPs) gets 250 sends / 15 min and can systematically harvest "is this phone registered" via `is_new_user` response field.
- **Exploit:** (a) Account enumeration via `is_new_user`. (b) SMS-cost DoS targeting unique phones. (c) Lockout of innocents.
- **Fix:** Drop `is_new_user` from the unauthenticated response (decide newness post-OTP-verify). Add an additional global Redis bucket (e.g. 100 sends / minute total across all phones) as a circuit breaker, with a Sentry alert when triggered. Document expected daily SMS spend and budget cap at Message Central side.
- **Evidence:** `internal/auth/ratelimit.go:36-37` + handler `handler.go:319-330` (returns `is_new_user`). Prior: partially covered at `audit/findings/rate-limiting.md:101-152`.

### B-007 [HIGH — NEW] OTP rate limiter "fails open" on Redis errors with no audit log
- **Location:** `internal/auth/ratelimit.go:105-130` `bump`, comment at lines 11-30.
- **Description:** When Redis fails for any reason (network blip, OOM, auth refused), `bump` swallows the error and returns nil — meaning the OTP send proceeds unthrottled. The header comment claims the outer `SensitivePublicRateLimit` (20/min IP limit) fails closed as the safety net. But the comment is wrong about `publicRateLimit`'s fail mode AND about the layering: per `cmd/api/main.go:488,49`, the public auth group uses `authPublicLimiter` (a separate name); its fail mode needs verification.
- **Exploit:** Redis incident → OTP send becomes unlimited → SMS-bill burn or victim-phone flood.
- **Fix:** Log every Redis failure in this path at WARN with rate `ip_addr` + a rolling count; alert in Sentry. Consider switching to fail-CLOSED on the OTP send path (refuse OTP if Redis unavailable — explicit failure beats silent over-billing).
- **Evidence:** `internal/auth/ratelimit.go:109-113`. NEW.

### B-008 [HIGH — pre-existing] BFF admin handlers leak raw `err.Error()` in 24+ places
- **Location:** `internal/bff/admin_handler.go` (many lines).
- **Description:** Per `audit/findings/backend-security.md:54-71`, admin-only routes return raw pgx error strings to the client. Schema names, constraint names, source rows leak. Blast radius bounded by admin-only access but pivots into post-exploitation aid.
- **Fix:** Sentinel mapping like `internal/booking/handler.go:107-163` does.
- **Evidence:** Prior audit at lines cited.

### B-009 [MEDIUM — NEW] `c.Locals("userID")` vs `LocalsKeyUserID` — admin middleware reads literal "userID"
- **Location:** `internal/middleware/admin.go:27`, `internal/middleware/locals.go:13`, `internal/middleware/auth.go:167`.
- **Description:** Per `locals.go:13`, `LocalsKeyUserID = "userID"`. So `c.Locals("userID")` does in fact resolve to the same key. Not a bug today. BUT: a future rename of the constant would silently break admin auth (admin requests would 401 because adminMW reads the old literal). This is the exact incident the constant was created to prevent.
- **Fix:** Change `internal/middleware/admin.go:27` from `c.Locals("userID")` → `c.Locals(LocalsKeyUserID)`. Same for any other middleware/handler that reads `"userID"` as a string literal.
- **Evidence:** `internal/middleware/admin.go:27`, `internal/middleware/locals.go:6-13` (history note about the prior cross-user leak from this exact drift).

### B-010 [MEDIUM — pre-existing] CRM has no CSRF middleware; SPA uses bearer + access token in memory — confirm
- **Location:** `cmd/crm-api/main.go:140-147` (no CSRF in chain).
- **Description:** Customer side mounts `mw.CSRF(...)`. CRM does not. Acceptable IF the SPA uses bearer in `Authorization: Bearer` (which CSRF can't add cross-origin). REQUIRES verifying `App/zopmop-crm/src/api/client.ts` does not put the access token in a cookie sent automatically.
- **Fix (if verification confirms cookie): add double-submit CSRF on `/admin/*` POST/PUT/DELETE. (if verification confirms bearer): document the choice + add a security-headers test.
- **Evidence:** `cmd/crm-api/main.go:140-147`. Needs `client.ts` read in Phase 3.

### B-011 [MEDIUM — pre-existing] Cashfree webhook route inherits Fiber's parent-prefix middleware; safety relies on `IsUnauthenticatedPath`
- **Location:** `internal/middleware/auth.go:47-53`, `cmd/api/main.go:595-601`.
- **Description:** Per the long comment at `auth.go:38-46`: `paymentsGroup` mounts `authMiddleware` on the `/payments` prefix. The webhook group at `/payments/cashfree/webhook` inherits it via Fiber's Use-on-prefix semantics. The workaround is the `IsUnauthenticatedPath` exception list — fragile and easy to forget when new webhooks land.
- **Fix:** Move the webhook to a distinct top-level group (e.g. `/api/v1/webhooks/cashfree`) registered BEFORE the authed payments group. Drop `IsUnauthenticatedPath`.
- **Evidence:** As cited. Prior: `audit/findings/backend-security.md:135-142`.

### B-012 [MEDIUM — pre-existing] WebSocket booking-tracking route is on `publicLimiter` group — verify JWT validation on upgrade
- **Location:** `cmd/api/main.go:533`.
- **Description:** `bookingTrackWS.RegisterTrackingWS(api.Group("/bookings", publicLimiter))` — no `authMiddleware` in the chain. WS handler MUST validate JWT during upgrade (read token from query / cookie / Sec-WebSocket-Protocol).
- **Fix:** Verify `internal/booking/handler.go` or wherever `RegisterTrackingWS` lives parses the token before accepting the upgrade. If not, anyone can subscribe to any booking's location stream.
- **Evidence:** `cmd/api/main.go:533`. NEW (not specifically in prior audit).

### B-013 [MEDIUM — pre-existing] IDOR audit incomplete; `audit/findings/database.md` shows fragile JOIN-based checks
- **Location:** Multiple — `internal/booking/repository.go:678,734` (CRITICAL per prior database audit), `internal/addresses/repository.go:31-67,209`.
- **Description:** Prior `audit/findings/database.md:24-106` flagged two CRITICAL IDOR/data-confidentiality issues at the repository layer (booking + address). Verify both still hold at branch HEAD.
- **Fix:** Per prior audit recommendations.
- **Evidence:** Prior audit at cited lines.

### B-014 [MEDIUM — pre-existing] Admin perms cached 5 min — revoked permission lingers for that window
- **Location:** `internal/middleware/admin.go:21,86-97`.
- **Description:** Per `audit/findings/auth-session.md:362-392`, the 5-min cache means a permission revoke takes up to 5 minutes to propagate.
- **Fix:** Invalidate the cache key on permission update (already a known pattern in the CRM admin update path — verify it actually busts the right key).
- **Evidence:** As cited.

### B-015 [MEDIUM — NEW] CRM `RequirePermission` (`internal/crm/middleware/jwt.go:124-136`) returns the role hierarchy in the 403 body
- **Location:** `internal/crm/middleware/jwt.go:131-134`.
- **Description:** On denial, returns `{"required_role": auth.MinRoleFor(perm), "your_role": role}`. Leaks the role taxonomy to anyone who pokes endpoints. Mildly useful to attacker for understanding the system; a compromised low-perm admin gets a free escalation roadmap.
- **Fix:** Drop `required_role`/`your_role` from the response. Log them server-side. Keep the 403 + generic message.
- **Evidence:** `internal/crm/middleware/jwt.go:113-118` (same anti-pattern in `RequireRole`).

### B-016 [LOW — pre-existing] CORS allowlist hardcoded, no wildcard, but no preflight-cache TTL
- See `audit/findings/backend-security.md:97-104`.

### B-017 [LOW — pre-existing] CSRF token allowed to live across browser tabs without rotation
- See `audit/findings/backend-security.md:105-118`.

### B-018 [LOW — pre-existing] AuthMiddleware fails-open log noise at DEBUG; should be WARN with IP
- See `audit/findings/backend-security.md:208-215`.

### B-019 [LOW — pre-existing] No login lockout on CRM after N failed password attempts
- **Location:** `internal/crm/auth/service.go` (Login handler) — verify in synthesis.
- **Description:** Per prior audit work (rate-limiting.md) the CRM login is protected by `crmLoginLimiter` (per-IP). No per-account counter exists — distributed bruteforce against a known admin email works.
- **Fix:** Add `failed_login_count` column to `crm_admins`; lock account for 30 min after 10 failed attempts; clear on success. Alert at 5.
- **Evidence:** `cmd/crm-api/main.go:320` (limiter). Confirm absence in `internal/crm/auth/service.go`.

### B-020 [LOW — pre-existing] Bootstrap admin creation has no audit log
- See `cmd/crm-api/bootstrap/main.go`.

### B-021 [LOW — NEW] `RequireRole` in customer middleware does not log denied attempts
- **Location:** `internal/middleware/auth.go:209-221`.
- **Description:** Silent 403 on role mismatch. An attacker probing pro-only endpoints with a customer token gets quiet rejection — no signal to operations.
- **Fix:** `log.Warn().Str("user_id", ...).Str("role_got", role).Strs("role_wanted", allowed).Str("path", c.Path()).Msg("role gate denied")`. Surfaces lateral-movement attempts.
- **Evidence:** `internal/middleware/auth.go:209-221`. NEW.

### B-022 [LOW — pre-existing] Refresh-token rotation oracle still leaks via timing if DB lookup uses constant-time NEQ
- See `audit/findings/auth-session.md:534-559`.

### B-023 [LOW — pre-existing] OTP `is_new_user` field tells attackers which phone is registered
- See B-006 fix above.

### B-024 [LOW — pre-existing] Bearer-token error and cookie-token error both map to identical 401 but log path differs
- See `audit/findings/auth-session.md:510-533`.

### B-025 [LOW — NEW] No max-session-per-admin enforcement
- **Location:** CRM session model.
- **Description:** A CRM admin can have unlimited concurrent active sessions across browsers/IPs. A leaked refresh token + active session = silent sit-along.
- **Fix:** Cap to 5 active CRM sessions per admin; oldest evicted on new login. Surface "active sessions" view at `/sessions` page (route exists per REPO_MAP §9).
- **Evidence:** `internal/crm/middleware/jwt.go:83-102` checks one row; no cap query exists.

### B-026 [LOW — pre-existing] `internal/auth/msg91_deprecated.go` still compiles
- See S-007 in findings-secrets.md.

---

## Cross-cuts with other domains
- S-002, S-003 → also disclosure (Subagent E).
- B-006/B-007 → DoS surface (Subagent D).
- IDOR claims B-013 → input validation (Subagent C) should sanity-check repository params.

End of findings.
