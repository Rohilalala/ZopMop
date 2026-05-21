# Findings — Input Validation & Injection

## Summary
Backend is parameterised throughout (no `fmt.Sprintf("SELECT ...")` hits in grep). Body size capped (4 MB customer / 8 MB CRM). Cashfree HMAC uses constant-time compare with timestamp skew window. SSRF protection exists for outbound webhooks (private-range + allowlist) but explicitly does not defend DNS rebinding. Several handlers `_ = c.BodyParser(...)` discarding errors. LLM (Zop) chat input is unbounded. CRM SPA — no unsafe React-html-injection sinks in `App/zopmop-crm/src`.

Totals (this domain): 0 CRITICAL, 4 HIGH, 6 MEDIUM, 4 LOW.

## Methodology
- `grep -rnE "fmt.Sprintf.*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)" --include="*.go"` over internal/, pkg/, cmd/ → 0 hits.
- `grep -rn "BodyParser"` → 50+ call sites (sampled 10).
- Read `internal/webhooks/ssrf.go`, `internal/payments/cashfree.go:420-450`, `cmd/api/main.go:192-209` Fiber config, `cmd/crm-api/main.go:115-135`.
- `grep -rn "innerHTML " --include="*.tsx"` plus dangerous-react-sink scan over `App/zopmop-crm/src` → 0 hits.
- `grep -rn "regexp.MustCompile"` (deferred — see C-009).
- code-review-graph attempted; fell back to grep.

---

## Findings

### C-001 [HIGH — pre-existing] Zop (LLM) chat input is unbounded — prompt-injection & cost-DoS
- **Location:** `internal/zop/handler.go:89-101`.
- **Description:** Per `audit/findings/backend-security.md:28-35`: `Chat` only checks `strings.TrimSpace(req.Message) == ""`. The Fiber 4 MB BodyLimit caps a single request, but with 90 s `Timeout` and authLimiter (100/min) per user, a malicious customer (or bot net of customers) can flood OpenRouter tokens. Long inputs also widen prompt-injection surface; the cleaner is best-effort, not a security boundary.
- **Fix:** Cap `req.Message` to ~2000 chars (match `booking/messages.go:205`). 413 before LLM hop. Add per-user daily token budget in Redis.
- **Evidence:** As cited above.

### C-002 [HIGH — pre-existing] `internal/bff/admin_handler.go` returns raw `err.Error()` 24+ times — schema disclosure
- **Location:** `internal/bff/admin_handler.go` many lines.
- **Description:** Already documented at `audit/findings/backend-security.md:54-71` under B-008. Listed here too because (a) the inputs hitting these errors are admin-supplied, validation should reject before the DB call, and (b) sentinel-mapping is the input-validation pattern that fixes both.
- **Fix:** Per prior audit — sentinel mapping; never return raw err.
- **Evidence:** Prior audit.

### C-003 [HIGH — NEW] OpenRouter chat path does not sanitize LLM output before persistence/return
- **Location:** `internal/zop/service.go:907` builds the request; response surfaced to the customer is the LLM's raw text.
- **Description:** Zop's response is rendered in the RN app and may also be persisted (verify in `zop/repository.go`). If the LLM ever returns an `[image](javascript:…)` markdown link, a malformed deep link, or a script-like payload, and the RN side renders it as HTML/markdown, you have stored-XSS-equivalent in the chat history. Even without rendering, LLM output should be size-capped before storage to avoid one user's prompt-induced 100 KB reply filling their chat history.
- **Fix:** Strip control chars + cap at 10 KB pre-storage. Render in app as plain text only (no markdown parser, or strict allowlist). Add a deny-list for `javascript:`, `data:`, `file:` URL schemes if links are rendered.
- **Evidence:** `internal/zop/service.go:907`. Confirm rendering in `App/zopmop-app/src/screens/zop/` (Phase 3 review subagent).

### C-004 [HIGH — pre-existing] DNS rebinding bypass on outbound webhook dispatcher acknowledged in code, not closed
- **Location:** `internal/webhooks/ssrf.go:54-56` (own comment).
- **Description:** `validateWebhookTarget` resolves the host's IPs at validation time and rejects private ranges. The actual `http.Do` re-resolves. An attacker-controlled DNS server can return a public IP at validation, then a 127.0.0.1 / 169.254.169.254 (cloud IMDS) at fetch time. The code comment explicitly notes this and defers to "a network policy that drops RFC1918 destinations at the cluster level." Railway-deployed pods almost certainly do NOT have such egress filtering by default.
- **Exploit:** Admin creates a webhook subscription with attacker DNS → attacker exfiltrates IMDS credentials or hits internal Redis/DB.
- **Fix:** Use a custom `http.Transport` with a `DialContext` that re-resolves and re-checks the IP against `privateRanges` at connect time. OR pin DNS resolution to a known resolver + bind the socket to a dest IP rather than hostname (resolve once, dial that IP, set `Host:` header). The Go stdlib pattern is well-known; the existing comment shows the team knows about it.
- **Evidence:** `internal/webhooks/ssrf.go:48-56`. Prior: not specifically called out in `audit/findings/` (which mentions the existing allowlist favorably). NEW elevation.

### C-005 [MEDIUM — NEW] `c.BodyParser` errors discarded in 2+ paths
- **Location:** `internal/auth/handler.go:242`, `:282`.
- **Description:** `_ = c.BodyParser(&req)` swallows the parse error. If JSON is malformed, `req` is zero-valued, the handler keeps running with empty fields. For `Logout` / `Refresh` siblings this masks integration bugs; in other handlers where it might be copied it could allow bypassing validation.
- **Fix:** Always check the error. The Logout body may be optional, but parse failures should still trigger a sentinel response.
- **Evidence:** `internal/auth/handler.go:242,282`.

### C-006 [MEDIUM — pre-existing] Cashfree webhook signature: timestamp skew check exists, replay protection beyond skew unclear
- **Location:** `internal/payments/cashfree.go:430-447`.
- **Description:** HMAC-verified, constant-time, ±skew enforced. But does the dispatch path dedupe by `cf_payment_id` / `event_id` in Redis or DB? A valid signature within the skew window can be replayed. Per `internal/payments/handler.go:875` (`dispatchCashfreeEventTx`), event dedup may exist — needs confirmation.
- **Fix:** If not already: `INSERT … ON CONFLICT DO NOTHING` on a `cashfree_webhook_events(event_id PRIMARY KEY)` table, gate downstream side effects on the insert succeeding.
- **Evidence:** As cited. Confirm in Phase 3.

### C-007 [MEDIUM — pre-existing] Several CRM handlers store free-form admin input as DB content without HTML escape
- **Location:** Per prior audit `audit/findings/backend-security.md:224-231` (admin handler banner/changelog body), and CRM API path `/admin/templates`, `/admin/banners`, `/admin/changelog`.
- **Description:** Admins author HTML/Markdown content stored as-is. If any RN app screen ever renders these via WebView or HTML-aware markdown without sanitization, a compromised/malicious admin can deliver script to customer devices.
- **Fix:** Run admin-authored bodies through an HTML sanitizer at write time (e.g. bluemonday in Go), even if today's rendering is plaintext. Defense-in-depth before the rendering ever changes.
- **Evidence:** Prior audit.

### C-008 [MEDIUM — pre-existing] CRM `RequirePermission` 403 body leaks the role taxonomy (also flagged as B-015)
- See `internal/crm/middleware/jwt.go:131-134`.
- **Description:** Input-validation framing: error responses to invalid input expose internal vocabulary.
- **Fix:** Drop `required_role`/`your_role` from the body; log them.

### C-009 [MEDIUM — pre-existing] Regex compiled at boot, but a couple of patterns include `.*.*` style — verify ReDoS
- **Location:** `grep -rn "regexp.MustCompile" --include="*.go" App/househelp-api/` — sample.
- **Description:** Did not enumerate every pattern in this pass; flagging as a Phase-3 follow-up. Concerning hotspots: phone normalization, address parsing, OTP normalization.
- **Fix:** Audit every `regexp.MustCompile` for nested quantifiers; use `regexp/syntax` or fuzz to validate.
- **Evidence:** Deferred to Phase 3.

### C-010 [MEDIUM — pre-existing] No filename-/MIME-validation on banner/content image upload paths (if any)
- **Location:** CRM admin banner endpoints.
- **Description:** Per REPO_MAP, the BFF admin path mounts banner CRUD. Need to confirm whether uploads are direct-to-server (filename + content-type from request) or pre-signed S3 (vendor handles it).
- **Fix:** If direct: magic-byte sniff, restrict to image/png|image/jpeg, store under random UUID filenames, set `Content-Disposition: attachment` on download.
- **Evidence:** Confirm Phase 3.

### C-011 [LOW — NEW] Fiber `BodyLimit: 8 * 1024 * 1024` for CRM — banner upload comment, but no per-route reduction
- **Location:** `cmd/crm-api/main.go:119`.
- **Description:** 8 MB body limit applies to every CRM endpoint, not just banner upload. A small JSON endpoint accepts 8 MB requests. Multiply by concurrent connections → memory pressure attack.
- **Fix:** Keep 8 MB on the banner upload route only; reduce default to 1 MB.
- **Evidence:** `cmd/crm-api/main.go:119`.

### C-012 [LOW — NEW] Validator at handler layer only — no struct-tag dive done
- **Description:** Spot-checked `SendOTP` request; uses `validator.Validate.Struct(req)` with go-playground/validator. Need to confirm every Request type has appropriate `validate:` tags (esp. min/max len, email, e164, oneof) — not enumerated in this pass.
- **Fix:** Add a unit-test-time meta-check: walk every `*Request` struct via reflect, fail if any string-typed field lacks `validate:` tag. Or use a linter rule.
- **Evidence:** Deferred.

### C-013 [LOW — pre-existing] Phone-mask logger pattern correct, but error path uses raw `err.Error()` in many places
- See prior audit `audit/findings/auth-session.md` MEDIUM entries.

### C-014 [LOW — pre-existing] OpenRouter request URL hardcoded (good), but model name comes from config — confirm no user influence
- **Location:** `internal/zop/service.go:907` and around.
- **Description:** If model name is user-controllable (e.g. via header) it could pivot to a more expensive model.
- **Fix:** Verify model is config-only.
- **Evidence:** Confirm Phase 3.

---

## Cross-cuts
- C-001 ↔ Disclosure (LLM cost is also a DoS economic finding — see D-NNN in findings-dos.md).
- C-004 ↔ AuthN/Z (webhook target host could point at internal admin).
- C-007 ↔ Disclosure (admin-stored XSS = cross-tenant info leak to customers).

End of findings.
