# Replace MSG91 with Message Central VerifyNow — Design

**Date:** 2026-05-20
**Branch:** `feature/messagecentral-otp` (cut from `develop`)
**PR target:** `develop` (do NOT merge — manual review/merge)
**Scope:** Swap the OTP delivery/verification vendor for the auth login flow.
The mobile-app HTTP contract (routes, request/response shapes, status codes)
is unchanged.

## Why

MSG91 requires DLT registration, which requires a GSTIN we do not yet have.
Message Central VerifyNow uses an international route and bypasses DLT.

## Background: current state (verified in code, not assumed)

The auth package has **two** OTP paths:

1. **Legacy pure-Redis** — `Service.SendOTP` (`service.go:131`),
   `Service.VerifyOTP` (`service.go:199`). Service generates a 6-digit OTP,
   stores it in Redis (`otp:{phone}`), constant-time-compares on verify. **No
   vendor involved. Not wired to any HTTP handler.** Out of scope. Dead-code
   removal filed in `docs/phase-12-backlog.md`.

2. **MSG91 (live, wired)** — `Service.SendOTPMSG91` (`service.go:376`),
   `Service.VerifyOTPMSG91` (`service.go:414`), called by `Handler.SendOTP` /
   `Handler.VerifyOTP`. MSG91 owns the OTP lifecycle (template OTP, stateless
   from the service's POV — verify takes `phone + otp`).

Only path 2 is reworked.

### Contradictions with the original task brief (resolved)

- **`msg91.go` cannot be build-tagged/commented out.** `ErrOTPInvalid` and
  `devModeOTPVal` live in `msg91.go` but are referenced by `service.go`;
  `handler.go:562` references `ErrMSG91Misconfigured`. Resolution: rename file
  to `msg91_deprecated.go`, **keep it compiled** (same package, unreferenced),
  relocate the shared symbols into `messagecentral.go`.
- **`handler.go` must change** (brief said it likely wouldn't): `handler.go:562`
  maps `ErrMSG91Misconfigured` → must become `ErrMCMisconfigured`.
- **`handler_test.go` has no MSG91 mock** — the "swap the mock" instruction has
  nothing to act on. New tests are added instead.
- **`RetryOTP` is wired to no route/service call** — dead today. Ported for
  interface parity; remains unwired.
- Do-not-touch files (`middleware/auth.go`, `locals.go`, `tokens.go`,
  `model.go`, `repository.go`, `ratelimit.go`) reference "MSG91" in **comments
  only** — left untouched (optional cosmetic comment fixes only).

## Architecture

### New file: `internal/auth/messagecentral.go`

```go
type MessageCentralConfig struct {
    CustomerID string
    AuthToken  string // base64 password/key from console.messagecentral.com
    BaseURL    string // default https://cpaas.messagecentral.com
    DevMode    bool
}

type MessageCentralClient struct {
    cfg         MessageCentralConfig
    http        *http.Client // 6s timeout
    baseURL     string
    mu          sync.Mutex   // guards cachedToken
    cachedToken string
}
```

Relocated here from the (now deprecated) MSG91 file — same package, so no
other file changes:

- `ErrOTPInvalid` (shared OTP sentinel)
- `devModeOTPVal = "999999"` (dev-mode bypass code)

New sentinels: `ErrMCMisconfigured`, `ErrMCNetwork`, `ErrMCRejected`.

**Methods**

- `NewMessageCentralClient(cfg) *MessageCentralClient`
- `(c) DevMode() bool` → `c.cfg.DevMode`
- `(c) token(ctx) (string, error)` — internal. Returns `cachedToken` if set;
  else `POST {baseURL}/auth/v1/authentication/token?customerId=<id>&key=<base64>&scope=NEW&country=91`,
  caches and returns the token. Mutex-guarded so concurrent callers refetch
  once, not N times.
- `(c) SendOTP(ctx, phone) (verificationID string, err error)`
- `(c) VerifyOTP(ctx, verificationID, code string) error`
- `(c) RetryOTP(ctx, verificationID string) error`

`MessageCentralClient` satisfies the `otpVendor` interface.

#### Token caching strategy (point 5)

**Reactive-only. No time-based expiry.** Token is fetched lazily, cached in
`cachedToken`, and reused indefinitely until a call rejects it. The mutex
serializes concurrent refetch so a token expiry under load triggers exactly
one refetch, not a thundering herd.

#### 401 retry policy (point 2 — exact)

On **any non-token endpoint** (`/verification/v3/send`, `/validateOtp`,
resend) returning HTTP 401:

1. Invalidate `cachedToken` (under mutex).
2. Refetch the token **once**.
3. Retry the original call **once**.
4. If the retried call **also** returns 401 → return `ErrMCMisconfigured`.
   **No further retries.**

#### Defensive parsing failure mode (point 4)

Responses are parsed into a struct that accepts both a flat shape
(`{"verificationId":...}`) and a `data`-wrapped shape
(`{"data":{"verificationId":...}}`). If the body matches **neither** (no usable
field after both attempts): log at **WARN** with the raw response body (any
echoed `authToken` redacted) and return `ErrMCRejected`. **Never silently
default-parse or treat an unparseable body as success.**

#### Phone normalization

App-internal phone is E.164 `+91XXXXXXXXXX`. Message Central's
`/verification/v3/send` expects a **10-digit national** number (no `+91`).
Normalize at the client boundary (new helper, e.g. `normalizeToNational10`);
`countryCode` is sent separately as `"91"`.

#### Endpoint payloads (best-effort; integration test is the source of truth)

Official docs (`docs.messagecentral.com`) were unreachable from the build
environment (WebFetch blocked). Confirmed via web search:

- Token: `POST /auth/v1/authentication/token` — query params `customerId`,
  `key` (base64), `scope=NEW`, `country=91`. Response carries an auth token.
- Send: `POST /verification/v3/send` — header `authToken`; params
  `countryCode=91`, `mobileNumber=<10-digit>`, `flowType=SMS`, `otpLength=6`.
  Response carries `verificationId`.
- Validate: `GET /verification/v3/validateOtp` — header `authToken`; query
  `verificationId`, `code`. Response carries a verification status
  (`VERIFICATION_COMPLETED` on success).
- Resend: path unconfirmed; implemented behind the integration test.

**Known risk:** exact param style (query vs body), response envelope, and the
resend path are not 100%-confirmed from official docs. Mitigation: defensive
parsing (above), inline `// ASSUMPTION:` comments, and the
`MC_INTEGRATION_TEST=1` test validating against the real API.

#### Logging discipline

Never log the OTP code (even masked). Log: verification IDs, `logger.MaskPhone`
phone hash, HTTP status codes. Redact `authToken` if echoed in any error body.

### `otpVendor` interface (service.go, unexported)

Exactly the four methods `service.go` calls — no wider:

```go
type otpVendor interface {
    SendOTP(ctx context.Context, phone string) (verificationID string, err error)
    VerifyOTP(ctx context.Context, verificationID, code string) error
    RetryOTP(ctx context.Context, verificationID string) error
    DevMode() bool
}
```

`Service.msg91 *MSG91Client` → `Service.otp otpVendor`.
`SetMSG91(*MSG91Client)` → `SetOTPVendor(otpVendor)`.
`main.go` constructs the concrete `*MessageCentralClient` and passes it in.
(The deprecated `MSG91Client` has different signatures and does **not** satisfy
`otpVendor` — fine; it is unwired.)

### Method rename

`service.go` already defines `SendOTP`/`VerifyOTP` (legacy path) — a rename to
those plain names **would collide**. Therefore:

- `SendOTPMSG91` → **`SendLoginOTP`**
- `VerifyOTPMSG91` → **`VerifyLoginOTP`**

Update the two callers in `handler.go`. Vendor name removed from method names
(the interface, not the name, encodes the vendor).

### The stateful shift (service.go) — the one meaningful behavior change

MSG91 was stateless from the service POV (verify took `phone+otp`). Message
Central requires the caller to retain the `verificationId` returned by send and
present it at validate. The service now stores it in Redis.

```
 SendLoginOTP:
   ... rate limit (s.rate.CheckSend) + user lookup + suspended check unchanged ...
-  if err := s.msg91.SendOTP(ctx, phone); err != nil { ... }
+  vid, err := s.otp.SendOTP(ctx, phone)
+  if err != nil { ... same error handling ... }
+  // NEW: MC validate needs this id later; MSG91 was stateless.
+  // A fresh send intentionally overwrites any prior id (see semantics below).
+  if err := s.rdb.Set(ctx, "otp:vid:"+phone, vid, otpExpiry).Err(); err != nil {
+      return "", false, fmt.Errorf("store verification id: %w", err)
+  }
   ... dev-mode return unchanged ...

 VerifyLoginOTP:
   ... rate limit (s.rate.CheckVerify) unchanged ...
+  vid, err := s.rdb.Get(ctx, "otp:vid:"+phone).Result()
+  if err == redis.Nil {
+      // Preserve current contract: expired/missing OTP today returns
+      // 401 INVALID_OTP (MSG91 path never returned OTP_EXPIRED). The
+      // more-correct OTP_EXPIRED is filed in phase-12 backlog.
+      return nil, ErrInvalidOTP
+  }
+  if err != nil { return nil, fmt.Errorf("load verification id: %w", err) }
-  if verr := s.msg91.VerifyOTP(ctx, phone, code); verr != nil {
+  if verr := s.otp.VerifyOTP(ctx, vid, code); verr != nil {
       if errors.Is(verr, ErrOTPInvalid) { return nil, ErrInvalidOTP }
       ... log + return verr ...
   }
+  // One-time use: drop the id on success so a replayed code can't re-verify.
+  if delErr := s.rdb.Del(ctx, "otp:vid:"+phone).Err(); delErr != nil {
+      log.Warn()... // non-fatal
+  }
   ... user upsert + token issuance unchanged ...
```

- **Redis key:** `otp:vid:{phone}`, TTL = existing `otpExpiry` (10 min).
  Namespace matches existing `otp:` / `otp:lock:` / `otp:cooldown:` keys.
- **Overwrite semantics (point 1 — known, intentional, not a bug):** a new
  `SendLoginOTP` overwrites the prior `otp:vid:{phone}` (Redis `SET`). This
  mirrors MSG91, where re-sending invalidated the previous OTP. The most
  recent send is the only one that can be verified. Documented as a known
  semantic in code comment + this spec.
- **Expired/missing vid (point 6):** returns `ErrInvalidOTP` → handler maps to
  HTTP **401 `INVALID_OTP`** — identical to today's MSG91 behavior. Mobile
  contract unchanged. The arguably-better `OTP_EXPIRED` response is filed in
  `docs/phase-12-backlog.md`, not done here.

### config.go

Remove: `MSG91AuthKey`, `MSG91TemplateID`, `MSG91SenderID`, `MSG91DevMode`
(struct fields, env reads at `:139-142`, validation at `:242-247`).

Add:

| Env | Field | Notes |
|-----|-------|-------|
| `MESSAGECENTRAL_CUSTOMER_ID` | `MessageCentralCustomerID` | required unless dev mode |
| `MESSAGECENTRAL_AUTH_TOKEN`  | `MessageCentralAuthToken`  | required unless dev mode |
| `MESSAGECENTRAL_BASE_URL`    | `MessageCentralBaseURL`    | default `https://cpaas.messagecentral.com` |
| `OTP_DEV_MODE`               | `OTPDevMode` (bool)        | vendor-neutral dev toggle |

Validation (prod only, mirrors existing MSG91 style):

```
MESSAGECENTRAL_CUSTOMER_ID is required when OTP_DEV_MODE is not true
MESSAGECENTRAL_AUTH_TOKEN is required when OTP_DEV_MODE is not true
```

`MESSAGECENTRAL_BASE_URL` is defaulted, so not required. Update **both**
`.env.example` and `.env.local.example` (remove `MSG91_*`, add the new keys) —
per `App/househelp-api/CLAUDE.md`.

### cmd/api/main.go

Replace MSG91 client construction + `SetMSG91` with `NewMessageCentralClient`
+ `SetOTPVendor`, fed from the new config fields.

### handler.go

- `mapSendOTPError`: `ErrMSG91Misconfigured` → `ErrMCMisconfigured` (still
  → HTTP 503 "OTP gateway unavailable").
- Update callers `SendOTPMSG91`→`SendLoginOTP`, `VerifyOTPMSG91`→`VerifyLoginOTP`.
- Fix stale `// ... "9999" ...` / MSG91 comments (dev code is `999999`).

### Deprecation

- `git mv internal/auth/msg91.go internal/auth/msg91_deprecated.go`
- Remove the relocated `devModeOTPVal` const + `ErrOTPInvalid` var from it
  (now in `messagecentral.go`, same package).
- Add header comment: `DEPRECATED — retained for possible MSG91 transactional
  SMS reuse; NOT wired into the auth flow. See docs/phase-12-backlog.md.`
- File stays compiled and unreferenced (vet-clean: exported symbols).

### docs/phase-12-backlog.md

Append follow-ups (not done in this PR):

1. Remove the legacy pure-Redis `SendOTP`/`VerifyOTP` path + its Redis OTP-gen.
2. Remove `msg91_deprecated.go` if MSG91 transactional SMS is not adopted.
3. Return `OTP_EXPIRED` (not `INVALID_OTP`) for an expired/missing
   `verificationId` — UX improvement, deferred to avoid changing the mobile
   contract mid-vendor-swap.

## Testing

### `internal/auth/messagecentral_test.go` (unit, `httptest` fake MC)

- Token fetched once and cached across two `SendOTP` calls (assert exactly one
  `/auth/v1/authentication/token` hit).
- `SendOTP` happy path returns the `verificationId`.
- `VerifyOTP` happy path (`VERIFICATION_COMPLETED`) → `nil`.
- `VerifyOTP` wrong code → `ErrOTPInvalid`.
- Dev mode: `SendOTP` returns `dev-<national>`, no network call; `VerifyOTP`
  accepts `999999` for any `dev-` id, rejects anything else.
- 401 on `/send` → invalidate, refetch token once, retry once; second 401 →
  `ErrMCMisconfigured`; assert no third attempt.
- Unparseable body → WARN logged, `ErrMCRejected`.

### Service-flow test (fake `otpVendor` + `miniredis`)

- `SendLoginOTP` stores `otp:vid:{phone}`.
- `VerifyLoginOTP` reads the id, calls vendor, deletes the key on success.
- `VerifyLoginOTP` with no stored id → `ErrInvalidOTP` (asserts 401
  `INVALID_OTP` contract preserved).
- Second `SendLoginOTP` overwrites the prior id (documented semantic).

### Integration test — gated `MC_INTEGRATION_TEST=1`

Hits the real Message Central API. Never runs in CI by default. **File header
must document:** uses production credentials; each run sends a real SMS and
costs approximately ₹0.30; intended for manual local verification only.

### handler_test.go

No mock swap (no MSG91 mock exists). Only touched if a renamed symbol/method
is referenced (it is not).

## Done criteria

`go test ./...` green, `go vet ./...` clean, `gofmt`, `make preflight` before
PR. Conventional commit. PR opened to `develop`. **Not merged** — manual.
