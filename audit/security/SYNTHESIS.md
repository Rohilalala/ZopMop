# Security Audit — Synthesis

Branch: `feature/security-audit-2026-05-21` (off `develop`, HEAD `3399626 → a5b96df`).
Phase 1 corpus: `findings-secrets.md`, `findings-authnz.md`, `findings-input-validation.md`, `findings-dos.md`, `findings-disclosure.md`, with cross-refs into `audit/findings/*.md` (prior work).
Context: pre-pilot, ~5 customers + ~5 pros. Indian on-demand household help.

---

## 🚨 Launch blockers (do not ship as-is)

1. **B-001 / S-002 — OTP dev-mode bypass with no production refusal.** `OTP_DEV_MODE=true` returns the OTP in the HTTP response and accepts hardcoded `999999`. The `.env.example` ships with this flag `true` by default. Any operator who copies the template, forgets to flip it, AND sets `APP_ENV` to something other than `production` (or leaves it empty) → anonymous full account takeover for every registered phone. The blast radius reaches admin accounts whose customer-side login flows through the same OTP path. **Fix in <30 minutes**: refuse boot when `OTP_DEV_MODE=true && APP_ENV in {production,prod}`. Until that lands, do NOT cut a build for real customers. `pkg/config/config.go:146`.

2. **D-001 / B-006 — OTP economic DoS + phone enumeration.** Per-phone (3/15min) and per-IP (5/15min) ceilings plus `is_new_user` enumeration in response = a botnet can burn SMS budget at ~₹7k–₹15k/day per attacker AND build a registered-phones list. **Fix**: drop `is_new_user` from public response; add a global Redis circuit breaker (e.g. ≤60 send/min total); confirm Message Central dashboard has a hard daily spend cap. Without this, the launch announcement itself is the attack window.

3. **S-001 — Google Maps API key (both burned predecessor AND its rotated successor) permanently in git history.** Both `AIzaSyDvyOQs4SFHLZoupsERIXBCKUhAHMSJU7w` (introduced `659a79f`) and `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` (introduced `b815c0a`) are in repo history. The rotation only bought a moving target. Anyone who has cloned the repo (incl. anyone you onboarded) can run up your Maps quota. **Fix**: rotate again to a server-IP-restricted key for the backend AND a referrer/bundle-restricted key for the app + EAS-secret-injected at build time. Set hard daily quota caps in Google Cloud Console. Treat both leaked values as compromised forever.

4. **C-004 — Outbound webhook SSRF DNS-rebinding bypass (acknowledged in code, not closed).** A CRM admin who configures a webhook with an attacker-controlled DNS gets to hit cloud-instance metadata (IMDS at 169.254.169.254) or internal services. Code comment says "we rely on a network policy at the cluster level" — Railway pods do not have that policy by default. **Fix**: custom `http.Transport.DialContext` that re-checks the resolved IP against `privateRanges` at connect time. `internal/webhooks/ssrf.go:48-56`.

---

## Top 10 ranked by severity × exploitability

| Rank | ID | Severity | File:line | Exploit (one line) | Fix (one line) |
|------|----|----------|-----------|---------------------|----------------|
| 1 | B-001 / S-002 | CRITICAL | `pkg/config/config.go:146`; `internal/auth/handler.go:330-338`; `internal/auth/service.go:157-160` | OTP dev mode in prod → anyone gets OTP back, full ATO | Boot-refuse on `OTP_DEV_MODE=true && prod`; drop `otp` from response |
| 2 | D-001 / B-006 | CRITICAL | `internal/auth/ratelimit.go:33-41`; `internal/auth/handler.go:319-330` | Botnet drains SMS budget + enumerates which Indian numbers are registered | Drop `is_new_user`; add global Redis send circuit breaker + alert |
| 3 | S-001 | CRITICAL | git history — `b815c0a`, `659a79f`, `89f568f`, others; not in HEAD | Both Maps keys (burned + rotated) extractable from any clone → quota burn | Rotate again; restrict server key to backend IP; restrict app key to bundle + EAS secret |
| 4 | C-004 | HIGH | `internal/webhooks/ssrf.go:48-56` | Admin-configured webhook + DNS rebinding → IMDS / internal services exfil | `DialContext` re-checks IP against private ranges |
| 5 | S-003 / E-001 | HIGH | `internal/observability/sentry.go:113-132` | Phone / JWT / OTP leak to Sentry via Extra / Tags / Breadcrumbs / URL query | Replace allow-list scrub with deny-list walk over Extra/Tags/Breadcrumbs/URL + value-shape match |
| 6 | B-002 | HIGH | `internal/middleware/auth.go:139-149` | DB blip → every authed request 503; no caching | Cache `is_suspended` for 30s in Redis; circuit breaker on DB |
| 7 | B-003 | HIGH | `internal/middleware/jwt.go:25-72` | No `iss/aud` claim check → CRM token replayable as customer token if secrets ever align | Mint with `iss/aud`; validate; reject mismatch |
| 8 | B-005 | HIGH | `internal/crm/middleware/jwt.go:68-74,124-136` | CRM admin's role downgrade not enforced until session expiry | Re-read role from DB (Redis-cached 60s) in middleware; don't trust claim |
| 9 | B-007 / D-002 | HIGH | `internal/auth/ratelimit.go:105-130` | Redis hiccup → OTP send unlimited (fail OPEN) — compounds D-001 | Fail CLOSED on send-OTP; log+alert each Redis error |
| 10 | D-005 / B-012 | HIGH | `cmd/api/main.go:533` | WS booking-track on public bucket no auth → location stream leak + conn-exhaustion | Validate JWT on upgrade; per-user concurrent-WS cap; idle timeout |

---

## Quick wins (<30 min each)

- **QW-1 (S-002 / B-001):** add `OTP_DEV_MODE && prod → log.Fatal` in `pkg/config/config.go` Validate.
- **QW-2:** delete the `otp` field from the response in `internal/auth/handler.go:333-336` AND the `note` line. Replace with WARN log in dev only.
- **QW-3 (B-006):** drop `is_new_user` from the unauthenticated `SendOTP` response. Decide newness post-verify.
- **QW-4 (B-015 / C-008):** strip `required_role` / `your_role` from CRM 403 bodies in `internal/crm/middleware/jwt.go:113-118, 131-134`.
- **QW-5 (B-009):** rename literal `"userID"` → `LocalsKeyUserID` in `internal/middleware/admin.go:27`.
- **QW-6 (S-005):** add `JWT_ACCESS_SECRET != JWT_REFRESH_SECRET` and length ≥ 32 in `pkg/config/config.go` Validate.
- **QW-7 (S-007):** delete `internal/auth/msg91_deprecated.go` (build tag at minimum).
- **QW-8 (B-021):** add WARN log on `RequireRole` denial in `internal/middleware/auth.go:209-221`.
- **QW-9 (E-004):** WARN log + Sentry tag on CSRF rejection.
- **QW-10 (C-005):** stop discarding `c.BodyParser` errors in `internal/auth/handler.go:242,282`.

---

## Defer (acceptable risk for 5-pro pilot)

- **B-014** — 5-min admin-perms cache window. Operationally fine; tighten when CRM admin count > 10.
- **D-006** — local-fallback ceiling × replicas. Document; revisit before scaling beyond 2 replicas.
- **D-016** — health endpoint shares 30/min IP bucket with general traffic. Probe-friendly enough for Railway today.
- **D-007** — `BookingCreate 3/min/user`. Adequate at pilot scale.
- **B-018** — DEBUG-vs-WARN log level on JWT validation failure. Cosmetic.
- **C-009, C-010, C-012** — regex/upload/validator-tag enumeration. Defer to follow-up audit when handlers stabilise.
- **E-013/E-014** — refresh-handler code + X-Powered-By verification. Probably already correct; spot-check post-launch.

---

## Cross-cuts & root causes

- **Root cause "env-gated unsafe defaults":** OTP_DEV_MODE (S-002), ENABLE_PPROF (S-008), ENABLE_STUB_ENUMERATOR (S-008), stack-trace gating (E-009). Common fix pattern: `pkg/config/config.go` Validate refuses boot whenever ANY of these is true AND `IsProduction()`. One PR, one test, several findings closed.
- **Root cause "claim-trust over DB-trust":** JWT-derived role/perm used at gate time (B-003, B-005). Fix pattern: middleware resolves DB-current state with Redis cache.
- **Root cause "PII bleed into observability":** Sentry scrubber (S-003), error-string raw (B-008/C-002), CRM 403 verbosity (B-015), `cf_payment_id` in logs (E-011). Fix pattern: structured `Field` wrapper that scrubs by name; Sentry `BeforeSend` walks every map.
- **Root cause "fail-open under partial dependency failure":** OTP limiter (B-007), local-fallback limiter (D-006). Fix pattern: fail-closed for security-critical paths, fail-open elsewhere with explicit logging.
- **Root cause "secrets in source tree":** Maps key (S-001), Firebase JSON env (S-004). Fix pattern: move all client-shipped secrets to EAS Secret or platform Secret Manager; never commit.

---

## Numbers at a glance

| Domain | Crit | High | Med | Low | Total |
|--------|------|------|-----|-----|-------|
| Secrets | 1 | 2 | 3 | 3 | 9 |
| AuthN/Z | 1 | 7 | 9 | 9 | 26 |
| Input validation | 0 | 4 | 6 | 4 | 14 |
| DoS / cost | 1 | 4 | 7 | 5 | 17 |
| Disclosure | 0 | 5 | 7 | 4 | 16 |
| **Sum (raw)** | **3** | **22** | **32** | **25** | **82** |
| Deduplicated unique findings | 3 | 17 | 26 | 22 | 68 (approx) |

Pre-existing in `audit/findings/`: ~70% of the surface above was already documented before this audit. Net-new from this session: ~15 findings.

---

## Recommended sequencing for the fix PRs

1. **PR-1 "auth bypass + SMS DoS hardening"** — quick wins QW-1, QW-2, QW-3 + B-007 fix. ~1 hour. Blocks all 3 launch blockers around auth/SMS.
2. **PR-2 "secret rotation + history hygiene"** — execute the Maps-key rotation (vendor side) + commit `.env.example` change + document rotation. ~30 min code + vendor steps.
3. **PR-3 "SSRF DialContext + admin permission DB-trust"** — close C-004 and B-005. ~2 hours.
4. **PR-4 "Sentry scrubber rewrite + raw-err sentinel mapping"** — close S-003/E-001 + B-008/C-002. ~3 hours.
5. **PR-5 (smaller polish)** — remaining quick wins QW-4..QW-10. ~2 hours.

After PR-1+2+3, you can ship the pilot. PR-4+5 inside the first 2 weeks of pilot.

End of synthesis.
