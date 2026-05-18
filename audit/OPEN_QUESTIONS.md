# ZopMop Audit — Open Questions for Aditya

Each item is a judgment call the audit subagents could not answer from the
code alone. Resolving these unblocks the next round of remediation. Grouped
by domain.

---

## Active-prod / launch-blocking

**Q1. Cart writer port to variants — when?** (database-2, bugs)
Migration 095 dropped `cart_items_cart_id_service_id_key`; `internal/cart/repository.go`
still uses `ON CONFLICT (cart_id, service_id)`. Prod cart-add is currently
broken on the new schema. Two paths:
  (a) Roll forward: port writer to new partial unique indexes + variant_id /
      bundle_id awareness (1-2 days).
  (b) Roll back: re-add the legacy UNIQUE constraint as a recovery migration
      and re-defer variant work.
**Decision needed before:** next deploy that touches cart code.

**Q2. Booking_services price column — same story.**
Migration 094 renamed `price_cents → price_paise`. Booking repository
references the old name at two sites. Same fork as Q1 — port or roll back.
**Decision needed:** same window.

**Q3. Stealth dispatcher status='searching' (bugs Critical-3).**
Has any after-8pm-IST stealth booking ever successfully assigned a pro in
production? If yes, there is a transition path the audit missed — point it
out. If no, the AcceptBooking gate needs to accept `searching` as well.

**Q4. Referral phone-graph anti-fraud (bugs Medium-7).**
Should the audit recommend a phone-graph check on referral apply (block
referrals when referrer and referee phones share area-code prefix patterns
typical of fraud rings), or is the policy to accept that surface for now?

---

## Security / Auth

**Q5. Google Maps API key history (backend-security, store-readiness, devops).**
Three sub-questions:
  - Is `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` the post-rotation key, or
    is it stale? `git log -p -S "AIzaSy"` shows multiple values.
  - In Google Cloud Console, is it restricted to iOS bundle
    `com.zopmop.app` + Android SHA-1 + quota cap?
  - Is the server-side `GOOGLE_MAPS_API_KEY` (`cmd/api/main.go:318`) the
    SAME key, or a separate IP-restricted one? If the same, that key needs
    immediate split.

**Q6. Server-side JWT revocation in scope this sprint?** (auth-session)
The biggest auth gap is no `token_version`/`jti` for revocation. 24 h
compromised-token window. Quick to ship (~half day). In or out for the
launch sprint?

**Q7. CRM auth model (backend-security M-CSRF).**
Does the CRM web app use cookie auth or bearer-token auth against `cmd/crm-api`?
The audit found a CSRF middleware skip on requests carrying `Authorization`
header — fine if CRM uses bearer, urgent if cookie.

**Q8. OpenRouter per-user budget (backend-security).**
Beyond the 100 req/min `ZopRateLimiter`, is there a per-user token / cost
budget enforced? If not, a single jailbroken user can run up significant
LLM bill before manual intervention.

**Q9. Firebase App Check (rate-limiting).**
Is App Check enabled on the Firebase project? If yes, the missing per-phone
throttle on `/auth/firebase` is less urgent (Firebase will throttle the
SMS-bombing surface client-side). If no, that's the single highest-leverage
fix.

**Q10. Cashfree webhook replay window (rate-limiting).**
Audit found a ±300 s window. Is that Cashfree's documented retry window,
or can we tighten to ±60 s for replay-protection hardening?

**Q11. `__guest__` sentinel (auth-session).**
Is any flow still exercising the `__guest__` user ID? If dead, drop it.

**Q12. Phone-change flow (auth-session).**
Is a phone-change endpoint planned? Currently users must delete + recreate
their account.

---

## Data / Schema

**Q13. Address soft-delete intent (database-2).**
Migration 061 prepped soft-delete but the code still hard-deletes. Was this
deliberately deferred or forgotten? Hard-delete is destroying booking history.

**Q14. `.down.sql` policy drift (database-2).**
Repo CLAUDE.md says forward-only / no `.down.sql`. Practice has drifted
(084-095 all have both). Codify the actual practice or remove the files?

---

## Performance / Infra

**Q15. Railway Postgres connection cap (performance).**
What's the actual connection cap on the Railway production Postgres /
PostGIS service? Pool defaults to 80; if plan allows ≥160, autoscale-to-2
is safe.

**Q16. Replicas in production today (performance, devops).**
Does Railway run a single replica? If yes, the multi-instance cron / chain
findings are dormant. If you ever scale to ≥2, they fire instantly.

**Q17. InviteChain restart resume (performance).**
"We lose in-flight chains on `api` restart" — acceptable for v1, or do we
need the resume path before TestFlight rollout?

**Q18. Phase3_geo load-test result (performance).**
94.5% failure rate at 6157 rps — intentional ceiling test that drove the
bound-limiter, or a known regression no-one fixed yet?

**Q19. Worker extraction (devops, performance).**
Will the `api` service ever run with >1 replica? If yes, the in-process
crons (rollup, reengagement, segment, outbox, matchBatcher, etc.) need to
be extracted to a single-replica `worker` binary before that scaling event.

---

## DevOps / Ops

**Q20. Railway Postgres backup retention (devops).**
Retention window? PITR window? Has a restore drill ever been executed?

**Q21. EAS Secrets for production (devops).**
Is `GOOGLE_MAPS_API_KEY`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` actually
configured as EAS Secrets, or is the prod build picking up empty `env: {}`?

**Q22. Committed PostHog token (devops).**
`App/zopmop-app/.env` is committed and contains a PostHog token. Is that a
public project token (safe to commit) or a personal API key (must rotate)?

**Q23. Retention worker deployment (devops).**
`deploy/retention-cronjob.yaml` references `/app/bin/retention-worker` which
the Dockerfile doesn't build. Is DPDP retention actually running anywhere?

**Q24. Slack / PagerDuty for Railway failures (devops).**
Any deploy / health alerting wired up? Audit found nothing in-repo.

---

## Mobile / UX

**Q25. Earnings tile on Pro Dashboard (dead-code).**
`ProDashboardScreen.tsx:439` renders "Earned ₹X" from `total_earned_paise`.
Per the design-conventions memory, gig-worker earnings UI was supposed to
be purged. Pros are still commission-based (keep the tile), salaried
(remove field + UI), or in transition?

**Q26. Expo OTA strategy (dead-code, devops).**
Will EAS Update be used for OTA hotfixes? If yes, `expo-updates` stays.
If no, removing it shrinks bundle + dev-client matters less.

**Q27. TS strict-unused enforcement (dead-code).**
Flip `noUnusedLocals` / `noUnusedParameters` on now (35 fixes) or defer to
a dedicated cleanup PR?

**Q28. Tagline placement (ui-ux).**
"Home, handled." rotates in/out via `headlineFor()` showing only 12-5pm IST.
Marketing decision or unintended rotation behavior?

**Q29. Wordmark casing (ui-ux).**
"ZOPMOP" all-caps with letter-spacing currently ships in 3 places. Brand
spec says "ZopMop" mixed case. Confirm which wins.

**Q30. Qurova Medium font (ui-ux).**
Loaded at startup but never used. Cut it (~50 KB) or wire it into a
`<Wordmark>` component per the spec?

**Q31. `useColors()` vs `C` palette migration (ui-ux).**
Locked-dark `C` palette is canonical for migrated screens, but
ActiveBookingScreen + ~20 others still go through `useColors()`. Migration
plan and target date — so the audit can mark them "deferred, tracked"
vs "violation."

**Q32. Trust signals on pro cards (ui-ux).**
Does the active-booking payload expose `helper_verified`,
`helper_completed_jobs`, `helper_response_minutes`? If yes, the trust panel
can be built without a backend change.

---

## Code Quality / API contracts

**Q33. OpenAPI / codegen pipeline (code-quality).**
Is one planned, or are mobile types maintained by hand? Affects fix
strategy for the JSON tag/name mismatch (Critical) and TS type drift (High).

**Q34. Force-update policy (code-quality).**
Min-supported-version via backend env var, or via `expo-updates` manifest?
Both work; pick a direction.

**Q35. Dual-route booking cancel (code-quality).**
Is `/bookings/:id` DELETE + `/bookings/:id/cancel` POST intentional (CRM
vs mobile each use one) or accidental? Document or consolidate.

**Q36. CRM `items` list envelope vs customer-side keys (code-quality).**
Rename the CRM side to match the customer side in one sweep, or keep as-is
for an existing CRM frontend dependency?

**Q37. Reviews endpoint (code-quality).**
Is `POST /bookings/:id/rate` actually implemented and the mobile call just
has a path mismatch? Or is the endpoint really missing? Stub currently
returns 404 silently.

---

## Store / Legal

**Q38. EAS-managed keystore (store-readiness).**
Production build using EAS-managed credentials, or a manually-supplied
keystore? Fingerprint must be pulled from EAS and used to update
`assetlinks.json`.

**Q39. Canonical bundle ID (store-readiness).**
`com.zopmop.app` (everywhere) or `com.zopmopapp` (build.gradle)? Pick one
before next release build.

**Q40. Privacy + Terms legal review timeline (store-readiness).**
On a timeline that fits launch submission? Draft-banner alone is near-certain
Apple reject.

**Q41. Analytics opt-out priority (store-readiness).**
OK to defer the in-app analytics opt-out toggle to post-launch? DPDP
enforcement starts to bite in 2026.

**Q42. `NSFaceIDUsageDescription` purpose (store-readiness).**
Is FaceID used anywhere? If no, drop the string. If planned, keep + add the
matching code.

**Q43. "ZopMop" trademark cleared in India + USPTO?** (store-readiness)
The audit flagged this as an open question; not verifiable from repo.

---

## Cross-cutting

**Q44. Crashlytics / Sentry choice (devops).**
Which error-tracking platform — Firebase Crashlytics (already partial
Firebase wiring) or Sentry (more powerful, separate vendor)? Decision
unblocks ~half a day of integration.

**Q45. PostHog data minimization PR scope (frontend, devops).**
Treat as one PR: drop phone from identify, scrub autocapture, opt-out
toggle, rotate token if it's not public-safe? Or split?

**Q46. Brand consistency PR scope (ui-ux).**
One sweeping PR (wordmark, font, palette, mascot resizeMode, hex literals)
or split per area (typography, color, brand, motion)?
