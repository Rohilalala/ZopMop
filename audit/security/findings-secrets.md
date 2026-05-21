# Findings — Secrets & Credentials

## Summary
Branch HEAD (`feature/security-audit-2026-05-21`, off `develop`) contains **no live secrets in tree**. However, two generations of the Google Maps API key sit in git history forever, the Sentry PII scrubber has reachable bypass surface, `OTP_DEV_MODE` ships a hardcoded fallback OTP that opens auth bypass if ever set in prod, and Firebase/OpenRouter/Cashfree credentials are read from env once at boot but the parse-failure paths echo the env-var name only (good).

Totals: 1 CRITICAL, 2 HIGH, 3 MEDIUM, 3 LOW.

## Methodology
- HEAD tree scan: `grep -rnE` over App/, pkg/, internal/, cmd/, migrations/, website/, web/, .github/, scripts/ for patterns `eyJ[A-Za-z0-9_-]{30,}`, `AIza[A-Za-z0-9_-]{20,}`, `sk_(live|test)_*`, `AKIA[A-Z0-9]{16}`, `sk-or-*`, `BEGIN.*PRIVATE.*KEY`, generic `(password|api_key|secret|token).*=.*['"]{long}['"]`.
- Git history: `git log --all -p -S "AIzaSy"`, `-S "AIzaSyCYC"`, `-S "AIzaSyDvyO"`, `-S "BEGIN PRIVATE"`, `-S "eyJhbGciOi"`, `-S "sk_live"`. Branches enumerated via `git log --all --oneline -S …`.
- `.env*` template inspection at all 5 locations (zopmop-app, zopmop-crm, househelp-api ×2). Repo `.gitignore` confirmed to cover `.env`, `.env.local`, `.env.*.local`.
- Secrets-reading code paths cross-checked against REPO_MAP §7.
- Code-review-graph MCP returned >400 KB on `get_architecture_overview` — fell back to grep / Read for everything.

---

## Findings

### S-001 [CRITICAL] Google Maps API key permanently in git history (2 generations)
- **Location:** History only — not in current tree.
  - Burned predecessor `AIzaSyDvyOQs4SFHLZoupsERIXBCKUhAHMSJU7w` introduced in `659a79f` (commit "better"), persisted through `bbe57de`, `3017c93`, `9cdc797`, `89f568f`.
  - Rotated successor `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` introduced in `b815c0a` (feat: referral universal links), `7a0b4df`, `89f568f`. Was in `App/zopmop-app/app.json` until removed.
- **Description:** Past handoff memo flagged the first key as "burned, urgent rotation." Rotation happened (b815c0a → CYC… replaces DvyO…), but the replacement was committed to the same file. Both values are now permanently in the public reachable history. Anyone with repo access (incl. anyone who ever forked/cloned) can extract either key.
- **Exploit / impact:** Free use of Maps quota on ZopMop's billing account → financial loss; if quota-unlimited, can also abuse expensive APIs (Distance Matrix, Directions). For Android signing-restricted keys this is reduced — but Maps JavaScript keys in `VITE_GOOGLE_MAPS_API_KEY` template (§REPO_MAP) and Static Maps usage from React Native cannot be reliably referrer-restricted on mobile.
- **Fix:**
  1. Rotate BOTH leaked keys at Google Cloud Console (kill the predecessor too — even if app no longer uses it, attackers can still spend).
  2. Apply HTTP-referrer / Android package / iOS bundle restrictions + per-day quota cap on the new key.
  3. Stop committing API keys: move to EAS secret + runtime-injected build var, never to `app.json`.
  4. Optional but recommended: BFG-clean history and force-push if this is a private repo and contributor list is short — irreversible for any clone in the wild.
- **Evidence:** `git log --all --oneline -S "AIzaSy"` → 6 commits. `git log --all -p -S "AIzaSyCYC"` → still in `App/zopmop-app/app.json` at b815c0a, 7a0b4df, 89f568f. Not in HEAD of `feature/security-audit-2026-05-21`.

### S-002 [HIGH] `OTP_DEV_MODE=true` accepts hardcoded OTP `999999`; no boot-time guard prevents enabling in prod
- **Location:** `App/househelp-api/.env.example:51` and `pkg/config/config.go:146`; OTP accept logic in `internal/auth/messagecentral.go` + handler.
- **Description:** Per `.env.example`: "OTP_DEV_MODE=true short-circuits all network calls and accepts the hardcoded OTP `999999`." The default in the template is `OTP_DEV_MODE=true`. There is no boot validator that refuses to start with `OTP_DEV_MODE=true` when `APP_ENV/ENV=production`. A misconfigured deploy or a stale env var on Railway silently bypasses OTP for every phone.
- **Exploit / impact:** Anyone who guesses any registered phone number can log in by entering `999999`. Full account takeover, including admin accounts whose CRM login flows back through this auth (verify in AuthN/Z findings).
- **Fix:** In `pkg/config/config.go` Validate(), refuse boot if `OTP_DEV_MODE` is set AND `(APP_ENV|ENV) ∈ {production, prod}`. Emit a `log.Fatal`. Independently, add a startup `log.Warn` whenever `OTP_DEV_MODE=true` so the line shows up in CloudWatch/Railway logs every restart.
- **Evidence:** `App/househelp-api/.env.example:48-51` documents behavior. `pkg/config/config.go:146` reads var without conditional rejection.

### S-003 [HIGH] Sentry PII scrubber is allow-list, not deny-list — multiple PII channels uncovered
- **Location:** `App/househelp-api/internal/observability/sentry.go:113-132` (`scrubEvent`).
- **Description:** The scrubber removes `Request.Cookies`, `Request.Data`, headers `Authorization|Cookie|X-Csrf-Token|Idempotency-Key`, and `User.Email`. It does NOT touch:
  - `event.Request.URL` / `QueryString` — phone numbers, OTP codes, JWTs appended to query strings of failing endpoints would ship to Sentry.
  - `event.Request.Headers["X-Phone"]`, `event.Request.Headers["X-Refresh-Token"]`, any custom header carrying secrets.
  - `event.User.ID`, `event.User.Username`, `event.User.IPAddress` — phone often lands here via `scope.SetUser({ID: phoneOrUserID})`.
  - `event.Extra`, `event.Tags`, `event.Breadcrumbs` — any code path that adds a phone, JWT, OTP, or refresh token via `scope.SetExtra`/`scope.SetTag` leaks it.
  - `event.Message` / `event.Exception.Value` — if any error string contains formatted PII (e.g. `fmt.Errorf("OTP %s invalid for %s", otp, phone)`).
- **Exploit / impact:** Routine error paths leak phone, OTP, JWT, refresh-token contents to Sentry. Anyone with Sentry-project access (developers + any leaked Sentry token) gets a live PII feed without ever touching prod systems.
- **Fix:**
  1. Switch to a deny-list: walk `Extra`, `Tags`, breadcrumb `Data`, header map, and replace any value matching `/^91[0-9]{10}$|^\+?[0-9]{8,15}$|^\d{4,8}$ /` (phones, OTP-shaped) and any header named `*-token|*-key|*-secret|x-phone` with `[REDACTED]`.
  2. Strip query string from `event.Request.URL`.
  3. Block setting `User.Email|User.Username|User.ID` to values matching phone shape — overwrite with hash.
  4. Add a Sentry test fixture for each PII vector.
- **Evidence:** `internal/observability/sentry.go:113-132` source.

### S-004 [MEDIUM] `FIREBASE_CREDENTIALS_JSON` parses a full service-account JSON from a single env var; parse errors must not echo it
- **Location:** `internal/notification/service.go:42`, `internal/credentials/firebase.go` (likely).
- **Description:** REPO_MAP §7 documents that the entire Firebase service-account private key is embedded in `FIREBASE_CREDENTIALS_JSON`. This is a routine pattern, but it means: (a) any panic / log line that dumps env vars (e.g. a generic `log.Error().Interface("env", os.Environ())`) leaks the private key, and (b) Railway dashboard users with read access see the key. We could not confirm the parse path never echoes the value because we did not read `internal/credentials/firebase.go` in this pass.
- **Exploit / impact:** Service-account compromise = full Firebase project admin (FCM send-as-anyone, Auth user CRUD, Storage). High blast radius if leaked.
- **Fix:** Confirm `internal/credentials/firebase.go` never logs the raw value on parse error (only "FIREBASE_CREDENTIALS_JSON invalid: <error>" — never the doc). Add explicit redaction test. Long-term: move to per-instance metadata-server credentials (Workload Identity / GKE) so the key never sits in env.
- **Evidence:** `internal/notification/service.go:42` reads env; full audit path deferred (review subagent should read `internal/credentials/`).

### S-005 [MEDIUM] CRM and customer JWTs are validated as distinct but no cross-check on access vs refresh secret reuse
- **Location:** `pkg/config/config.go:129,136`; `pkg/crmconfig/config.go:135`.
- **Description:** `pkg/crmconfig/config.go:135` actively rejects `CRM_JWT_SECRET == JWT_SECRET` — good. There is no equivalent check that `JWT_ACCESS_SECRET != JWT_REFRESH_SECRET`. If an operator reuses the same string, an access token can be replayed as a refresh token (or vice versa), bypassing rotation guarantees.
- **Exploit / impact:** Operator misconfiguration → refresh-token rotation bypass → stolen access token reusable as a long-lived refresh.
- **Fix:** In `pkg/config/config.go` Validate, require `JWT_ACCESS_SECRET != JWT_REFRESH_SECRET` and both ≥ 32 bytes after `base64` / hex decode. Refuse boot otherwise.
- **Evidence:** `pkg/crmconfig/config.go:135` has the cross-check pattern; `pkg/config/config.go:129-136` does not.

### S-006 [MEDIUM] Dual Cashfree credential paths — risk of credential drift / outdated key usage
- **Location:** `pkg/config/config.go:148-151` (`CASHFREE_PG_*`) vs `internal/payments/handler.go:63-74` (`CASHFREE_CLIENT_ID/SECRET`, `CASHFREE_BASE_URL`, `CASHFREE_ENV`).
- **Description:** REPO_MAP flagged this as "two Cashfree credential sets." Reading `.env.example:80-100` clarifies: `CASHFREE_*` is the Payouts product (helper VPA validation, future helper disbursement), `CASHFREE_PG_*` is the Payment Gateway (collection/checkout/webhook). So this is NOT duplicate creds — but the operator must keep TWO sets of keys current, and only PG creds are validated for required-when-`PUBLIC_BASE_URL`-set. Payouts creds have no equivalent boot validation and the route silently returns 503 (per template comment). Easy to miss when one is rotated and the other isn't.
- **Exploit / impact:** Stale Cashfree Payouts creds → helper disbursement returns 503 silently → payroll appears to succeed but money does not move. Wallet/payout subagent territory; flagging here because the credential surface area is doubled.
- **Fix:** Add a boot-time sanity check that if `CASHFREE_PG_APP_ID` is set then `CASHFREE_CLIENT_ID` is also set (or expected to be empty for the pre-payouts pilot). Document the two-key reality in README.
- **Evidence:** `pkg/config/config.go:148-151`, `internal/payments/handler.go:63-74`, `App/househelp-api/.env.example:80-100`.

### S-007 [LOW] `MSG91` deprecated client still compiled into the binary
- **Location:** `App/househelp-api/internal/auth/msg91_deprecated.go:18-194`.
- **Description:** Filename says "deprecated" and the file comment confirms NOT WIRED into auth handler. But it builds — its constructor allocates a real `http.Client`, holds API creds, and its constants compile in. AuthN/Z subagent should verify no `RegisterRoutes` reaches it. Otherwise it's dead code that bloats attack surface (loaded reflectively, reachable via misconfigured router during refactor).
- **Exploit / impact:** Latent SMS-billing path if anyone wires it back accidentally. Currently dormant.
- **Fix:** Delete the file; the git history is enough archive. If retention is required, move under `internal/_legacy/auth/` with build tag `//go:build legacy` so it does not compile.
- **Evidence:** `internal/auth/msg91_deprecated.go:18,23,31,43,49`.

### S-008 [LOW] `ENABLE_PPROF=1` and `ENABLE_STUB_ENUMERATOR=1` are documented but not refused in production
- **Location:** `cmd/api/main.go:136` (pprof), `cmd/crm-api/main.go:428` (stub enumerator).
- **Description:** Both env-var-gated dev surfaces. Neither code path inspects `APP_ENV` to refuse activation in production. If a stale Railway env var lingers, internal endpoints become reachable.
- **Exploit / impact:** pprof endpoints leak goroutine stacks, heap, CPU profile — usually internal-only but if bound to the same listener, anyone with the URL pulls debug info. Stub enumerator is dev-only by design.
- **Fix:** Wrap both with `if cfg.IsProduction() { log.Fatal(...) }` when the env is set. Or, simpler, restrict to a separate localhost-only `:6060` listener for pprof and never bind in prod.
- **Evidence:** `cmd/api/main.go:136`, `cmd/crm-api/main.go:428`.

### S-009 [LOW] `OPENROUTER_API_KEY` read inline at handler setup, not cached in `cfg`
- **Location:** `cmd/api/main.go:567`.
- **Description:** `os.Getenv("OPENROUTER_API_KEY")` is inlined into `zop.NewService(...)`. Not a leak, but: (a) it sidesteps `pkg/config/config.go` validation (no warning if missing, no length check); (b) any downstream test that constructs the Zop service has to know about this env var. Convention violation.
- **Exploit / impact:** None directly; hygiene.
- **Fix:** Move into `pkg/config/config.go` alongside other vendor keys.
- **Evidence:** `cmd/api/main.go:567`.

---

## Notes for downstream subagents
- AuthN/Z: please cross-check whether `msg91_deprecated.go` has any reachable handler reference.
- Disclosure (Subagent E): the Sentry scrubber gaps in S-003 are also a disclosure finding — coordinate dedupe in synthesis.
- DoS (Subagent D): Cashfree-Payouts 503 fallback (S-006) is a behavior worth checking in webhook idempotency review.

End of findings.
