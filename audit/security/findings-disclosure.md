# Findings — Logging, Error Handling, Information Disclosure

## Summary
Backend ships with helmet, locked-allowlist CORS (sentinel `cors-disabled.invalid` when ALLOWED_ORIGINS empty — clever), CSP `default-src 'none'`, HSTS preload. Auth path generic 401s, Refresh path generic too. But Sentry scrubber is allow-list and leaks PII via Extra/Tags/Breadcrumbs (S-003). BFF admin handler returns raw `err.Error()` 24+ times (B-008/C-002). CRM `RequirePermission` 403 leaks role taxonomy (B-015). Audit log coverage of admin actions is partial.

Totals (this domain): 0 CRITICAL, 5 HIGH, 7 MEDIUM, 4 LOW.

## Methodology
- Read `internal/middleware/security.go:1-90` (helmet + CORS).
- Read `internal/observability/sentry.go:1-132`.
- Read `internal/middleware/auth.go` for log statements in failure paths.
- `grep -rn "log\..*phone\|log\..*token\|log\..*JWT\|log\..*OTP\|log\..*secret" --include="*.go"` to find PII in logs.
- Cross-referenced `audit/findings/auth-session.md`, `audit/findings/backend-security.md`, `audit/findings/devops.md`.

---

## Findings

### E-001 [HIGH — pre-existing] Sentry scrubber allow-list leaks PII (S-003 dup)
- See S-003 in findings-secrets.md. Cross-domain — fix once.

### E-002 [HIGH — pre-existing] BFF admin returns raw `err.Error()` × 24+ (B-008/C-002 dup)
- See `audit/findings/backend-security.md:54-71`.

### E-003 [HIGH — NEW] Admin-action audit log scope: payouts/refunds/promos write rows but cancel/suspend/role-change coverage unverified
- **Location:** `internal/crm/audit/` package + each module's handler.
- **Description:** CRM has an audit subsystem (per REPO_MAP §6 `internal/crm/audit`), but no enumeration exists of WHICH state-changing endpoints actually call it. Without coverage tests, after-the-fact compromise investigation is blind.
- **Fix:** Add a generated index of `crm_audit_log` writers; require every CRM `Register*Routes` PUT/POST/DELETE to be one of them or explicitly opt-out via comment. Add a smoke test.
- **Evidence:** Need Phase-3 enumeration of all CRM mutating endpoints vs audit-log call sites.

### E-004 [HIGH — pre-existing] CSRF token validation uses generic 403; no IP/admin tagging in error path
- **Location:** `internal/middleware/csrf.go:39-44` (per prior audit `audit/findings/backend-security.md:105-118`).
- **Description:** A failed CSRF check returns generic 403. Operationally invisible — can't distinguish "real CSRF attempt" from "expired token bug". Pivoted attacks blend into noise.
- **Fix:** Log denied CSRFs at WARN with user_id + IP + path. Add a Sentry alert when rate spikes.

### E-005 [HIGH — pre-existing] No HTTP access log retention policy documented (DPDP / log-PII)
- **Description:** RequestLogger logs every 4xx/5xx. URL paths can contain UUIDs (booking_id, user_id) but no plaintext PII unless misused. Retention period for these logs and Sentry events is not documented (per `audit/findings/devops.md` notes).
- **Fix:** Document retention (e.g. 14 d hot, 90 d cold, purge). Required for DPDP §11 alignment.

### E-006 [MEDIUM — pre-existing] CORS `AllowCredentials: true` + dynamic allowlist — confirm no wildcard accepted
- **Location:** `internal/middleware/security.go:64-73`.
- **Description:** The sentinel `cors-disabled.invalid` on empty config is good. But `AllowCredentials: true` forbids wildcard origin per spec — verify the cors library actually enforces. Risk: if any future change adds `*` to ALLOWED_ORIGINS, browsers would reject anyway, but if a regex/array allows both `*` and credentials, exposed.
- **Fix:** Add a startup assertion: `len(filtered) > 0 && noWildcardInList(filtered)`. Document.

### E-007 [MEDIUM — NEW] `RequestLogger` logs `User-Agent` and IP but not user-id by default — pivot-difficulty
- **Location:** `internal/middleware/security.go:85+`.
- **Description:** Failing request logs include `User-Agent` (potential PII via custom apps) and IP but not the resolved user-id. Compromise investigation requires joining the request-id to a separate audit trail.
- **Fix:** When `c.Locals(LocalsKeyUserID)` is populated, include masked user_id in the log line.

### E-008 [MEDIUM — pre-existing] Helmet CSP `default-src 'none'` good, but no `Permissions-Policy` / `Cross-Origin-Embedder-Policy`
- **Location:** `internal/middleware/security.go:24-39`.
- **Description:** Helmet defaults are strong for JSON APIs; CRM SPA (separate origin) doesn't ride this middleware. CRM helmet config not enumerated in this pass.
- **Fix:** Confirm CRM also sets equivalent headers (`cmd/crm-api/middleware.go`).

### E-009 [MEDIUM — pre-existing] Stack trace shipped to clients when `cfg.IsDevelopment()` — confirm dev-only
- **Location:** `cmd/api/main.go:216-225` recover middleware; `cmd/crm-api/main.go:140-142`.
- **Description:** `EnableStackTrace: cfg.IsDevelopment()` — fine if `IsDevelopment` is correctly gated. Same env-misconfig risk as S-002 (OTP dev mode). If APP_ENV is empty or anything other than "production", stack traces ship.
- **Fix:** Per S-002 — IsProduction explicit (require APP_ENV in {production, prod}); IsDevelopment is the inverse but the boot should refuse to start with no APP_ENV.
- **Evidence:** As cited.

### E-010 [MEDIUM — pre-existing] `internal/middleware/admin.go:65-69` logs `user_id` when admin lookup fails — confirm not user-supplied
- **Location:** As cited.
- **Description:** Logs user_id at ERROR on admin lookup failure. The user_id is from the JWT (so trusted shape), but in Sentry the value reaches the Extra field with no scrubbing. Per S-003, this lands in Sentry.
- **Fix:** Mask user_id in error logs (last 4 only). Sentry scrubber should also mask UUID-shaped values.

### E-011 [MEDIUM — pre-existing] Errors in CashfreeWebhook handler logged with `cf_payment_id` — may correlate to customer/booking
- **Location:** `internal/payments/cashfree.go` HMAC failure paths.
- **Description:** `cf_payment_id` appears in logs/metrics. Low-direct-risk but a Sentry leak chain (S-003) magnifies.
- **Fix:** Treat `cf_payment_id` as PII-adjacent in scrub rules.

### E-012 [MEDIUM — pre-existing] `audit/findings/devops.md` flags missing Crashlytics + missing structured alerting
- See devops.md §11 and §5. Not direct disclosure, but the absence makes post-compromise detection slow.

### E-013 [LOW — pre-existing] Refresh handler returns generic 401 with `code: REFRESH_INVALID` — code is fine; consistency check
- **Location:** `internal/auth/handler.go:392-398`. Looks correct — no oracle.

### E-014 [LOW — pre-existing] X-Powered-By header — verify removed
- **Location:** Fiber emits no X-Powered-By by default. Confirm not re-introduced by helmet config.

### E-015 [LOW — NEW] `health/ready` endpoints expose nothing operational — verify
- **Location:** `cmd/api/main.go:256-264`.
- **Description:** A reasonable `/ready` reports DB+Redis status. If it leaks build SHA / pool stats, it's a fingerprint. Confirm response is minimal.

### E-016 [LOW — pre-existing] No request-body redaction in logs (request bodies generally aren't logged but verify Fiber's debug-level isn't on in prod)

---

## Cross-cuts
- E-001/E-010 ↔ S-003 (same root: PII scrubber gaps).
- E-002 ↔ C-002/B-008 (raw err.Error()).
- E-003 ↔ B-019/B-020 (admin lifecycle audit gaps).

End of findings.
