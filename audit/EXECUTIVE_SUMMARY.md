# ZopMop Audit — Executive Summary

**Audit date:** 2026-05-15
**Scope:** Full-stack — Go/Fiber backend, React Native + Expo mobile (customer + pro), CRM web, infra, store readiness.
**Subagents:** 12 (Backend Security, Rate Limiting, Auth & Session, Database, Performance, Frontend, UI/UX, Bug Hunt, Dead Code, Code Quality, DevOps, Store Readiness).
**Total findings:** ~290 across all severities.

---

## Counts

| Severity | Count | Notes |
|----------|------:|-------|
| Critical | 21    | Includes 7 store-readiness BLOCKERs (cannot submit until fixed). |
| High     | 67    | Includes 9 store HIGH RISK + 6 perf + 8 frontend + 7 store + 6 db + 6 code-quality + 6 devops + 5 auth + 4 backend-sec + 4 frontend-2 + 1 rate-limiting + 10 ui-ux + 6 bugs. |
| Medium   | ~100  | Cleanup, hardening, idempotency, naming. |
| Low      | ~55   | Mostly cleanup + hardening. |
| Nit      | ~25   | Style / polish. |

Store-readiness breakdown (from `STORE_READINESS.md`):
**BLOCKER 8 · HIGH RISK 9 · ASO 6 · POLICY DEBT 5.**

---

## Top 10 Critical findings (ranked by launch risk + active prod risk)

1. **Cart `AddItem` is broken in prod RIGHT NOW.**
   `internal/cart/repository.go:54-60` issues `INSERT … ON CONFLICT (cart_id, service_id)`,
   but the unique constraint was dropped by migration `095_drop_legacy_cart_items_unique.up.sql`
   (applied 2026-05-15). PostgreSQL requires a matching unique index for the
   inference form of ON CONFLICT; the statement errors with code 42P10.
   Every customer cart-add returns 500. **Active prod outage of cart funnel.**
   Fix: port the writer to the new variant/bundle partial unique indexes
   `(cart_id, variant_id)` / `(cart_id, bundle_id)` or `INSERT … ON CONFLICT
   ON CONSTRAINT <new>`. Pair with the booking writer port below.

2. **Booking_services price column drift.**
   `internal/booking/repository.go:678` (`CreateScheduledBooking`) and `:734` (list query)
   use `price_cents`, but migration 094 renamed the column to `price_paise` (applied
   2026-05-15). Both queries error with `column "price_cents" does not exist`.
   Every scheduled-booking creation + My Bookings list errors. Active prod outage for
   the corresponding flows. Fix in lockstep with finding #1.

3. **Stealth instant bookings cannot be accepted.**
   `internal/booking/repository.go:328-389`. The stealth dispatcher flips
   `bookings.status` to `searching` before inviting pros, but `AcceptBooking` is
   gated on `status = 'pending'`. Every pro-accept on a stealth booking returns
   `ErrAlreadyAccepted`. After-8pm-IST stealth flow is dead.

4. **Referral wallet double-credit race.**
   `internal/referral/service.go:158-200`. `MaybeCompleteOnBookingTx` reads the
   pending referral with no `FOR UPDATE`; two concurrent booking completions
   for the same customer can both credit referee + referrer. No idempotency
   key on `wallet_transactions` for `referral_credit` kind. With the recent
   ₹150 reward + heavier referral push, this is exploitable.

5. **PostHog identify leaks phone PII.**
   `src/context/AuthContext.tsx:320-323` calls `posthog.identify(uid, { phone, name })`
   on every sign-in with raw `+91XXXXXXXXXX`. Phone in PostHog person properties
   is DPDP-relevant personal data, retrievable by anyone with PostHog access.
   Apple 5.1.2 violation if surfaced. Hash or drop the property; treat
   `identify` distinct_id as the only durable identifier.

6. **Google Maps API key embedded in repo (twice).**
   `App/zopmop-app/app.json:40,94` and `ios/zopmopapp/Info.plist:5-6`. The
   "rotated" key `AIzaSy…HYYQ0` lives in git history and EAS bundles. Two prior
   keys also in `git log -p -S "AIzaSy"`. Confirm Google Cloud restrictions
   (bundle ID + Android SHA1 + quota caps); rotate again into EAS secret and
   consume via `app.config.js`. Server-side `GOOGLE_MAPS_API_KEY` must be a
   separate IP-restricted key.

7. **iOS PrivacyInfo.xcprivacy is empty.**
   `ios/zopmopapp/PrivacyInfo.xcprivacy:45-48` has `NSPrivacyCollectedDataTypes = <array/>`
   and `NSPrivacyTracking = <false/>` despite PostHog, Firebase Auth, FCM,
   Cashfree, Google Maps integrations. App Store Connect rejects on upload.
   **Submission blocker.**

8. **Android manifest carries unjustified permissions.**
   `android/app/src/main/AndroidManifest.xml:12,15,16`. `SYSTEM_ALERT_WINDOW`,
   `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` are all in the boilerplate
   "OPTIONAL PERMISSIONS, REMOVE WHATEVER YOU DO NOT NEED" block with no usage.
   Guaranteed Play rejection. **Submission blocker.**

9. **Android signing + bundle ID misconfig.**
   `android/app/build.gradle:91-92` declares `namespace`/`applicationId` =
   `com.zopmopapp`, but every other surface (manifest, app.json, iOS, AASA,
   assetlinks) uses `com.zopmop.app`. Same file line 112-117 keeps the
   release `signingConfig` pointed at the debug keystore. App will either
   crash on launch or break universal links; AABs may go out debug-signed.
   **Submission blocker.**

10. **InviteChain + DB pool: Railway-autoscale time bomb.**
    `internal/matching/dispatch.go:295-360` runs cron goroutines that hold
    25 s per-pro in-memory state. Multi-replica deploys double-fire each cron
    and race on Redis. `pkg/database/postgres.go:30-37` sets
    `DB_POOL_MAX_CONNS=80` per replica with a 600-deep request queue (75 ms
    wait). Two replicas exceed Railway's hobby / developer Postgres
    connection cap (22-64). System works on single-replica today; first
    autoscale event = matching + pool exhaustion at the same time.

---

## Same-class findings worth surfacing alongside the top 10

- **Address soft-delete half-built** (database.md #2): Migration 061 added
  `deleted_at` + partial index with a code-switch comment; `Delete()` still
  hard-deletes, severing booking history. Either flip to soft-delete or drop
  the migration's index.
- **Money JSON tag/name mismatch** (code-quality.md #1): 14 Go structs serialize
  `*Paise int` fields as `json:"price_cents"`. Mobile mirrors the wrong name.
  External webhook integrators will read 100× wrong.
- **No error tracking / APM anywhere** (devops.md #2): Sentry / Crashlytics
  absent in both binaries. Prod crashes invisible.
- **No documented backup/restore runbook** (devops.md #1): DR not exercised.
- **Privacy + Terms still labelled "Draft notice"** in `website/privacy.html`
  + `terms.html`; app links to them from `OTPVerificationScreen.tsx:35` and
  `ProfileScreen.tsx:45`. Apple cites this directly.
- **No UGC report/block/mute** in chat or review flows (store-readiness #11/#12):
  Apple 1.2 + Play UGC policy both require this.
- **JWT has no `jti`, no `nbf`, parser has no leeway; no server-side
  revocation** (auth-session.md #2, #3): 24 h compromised-token window.

---

## Time-to-blocker-clear estimate

The 8 store BLOCKERs + the 4 active-prod-bug Criticals (#1-4) are the launch gate.

| Category | Items | Estimated effort |
|----------|------:|------------------|
| Mobile manifest / plist surgery (BLOCKERs #1-7) | 7 | **0.5 day** — mostly edits + verify EAS prebuild |
| Bundle ID + keystore + AASA SHA realign | 1 | **0.5 day** including a clean EAS build to verify |
| `PrivacyInfo.xcprivacy` populate | 1 | **2 h** with Apple's category reference + SDK list |
| Privacy + Terms legal review | 1 | **1-3 weeks external** — start now, runs in parallel |
| Cart + Booking variant/price code port (Critical #1, #2) | 2 | **1-2 days**: writer migration to variant table + tests |
| Stealth dispatcher accept fix (Critical #3) | 1 | **2 h** — relax AcceptBooking gate to allow `searching` |
| Referral race FOR UPDATE + idempotency (Critical #4) | 1 | **3 h** — row lock + dedup key on wallet_transactions |
| PostHog PII drop (Critical #5) | 1 | **1 h** — `posthog.identify(uid, {})`; remove $set props |
| Google Maps key rotation + EAS secret wiring (Critical #6) | 1 | **2 h** — rotate, restrict, route via env |
| Crashlytics / Sentry wiring | 1 | **0.5 day** — RN side, backend side |

**Total: roughly 4-5 working days of focused work** for the launch-blocker set,
plus the external legal-review timeline for privacy/terms.

The remaining ~280 findings span operational hardening, code quality, dead
code cleanup, perf headroom, and policy debt — none are launch-blocking
but most are worth tackling in the order they appear in `QUICK_WINS.md`
and `FULL_REPORT.md`.

---

## How to use this report

- `STORE_READINESS.md` — the launch-blocker checklist. Fix in the order listed.
- `FULL_REPORT.md` — pointer index into every per-domain findings file.
- `QUICK_WINS.md` — every finding fixable in ≤30 minutes, ordered by impact.
- `OPEN_QUESTIONS.md` — the 30+ judgement calls that need Aditya's input
  before the corresponding findings can be turned into closed work items.

Per-subagent detail in `audit/findings/<name>.md`.
