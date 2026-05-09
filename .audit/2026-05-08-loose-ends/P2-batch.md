P2 BATCH - 7 tickets (lower-priority quality and security items)

Date: 2026-05-08
Source: System walkthrough Part 6 + cross-reference investigation

Each ticket below is a P2: should fix soon, quality issue or technical debt
or future-blocking, but not launch-critical. Most are 30 min to a few
hours of work each.

Note: P2-002 (ProfileScreen dark mode toggle disconnected) was dropped
from this audit on 2026-05-08 - light mode is not yet implemented, so the
toggle UI itself shouldn't exist on ProfileScreen. That's a placeholder-
cleanup concern, separate audit. Numbering preserved (002 skipped) for
INDEX consistency.

================================================================================
P2-001 - Cart optimistic add shows blank service name and 0 rupee subtotal
================================================================================

Severity: P2
Category: UX

SUMMARY
When user taps Add to Cart, the optimistic UI update creates a temporary
cart item with service_name='' and price_cents=0 until the server response
lands ~500ms later. Users see a blank row and 0 rupee subtotal flicker
before real data appears. Janky but not data-corrupting. Fix: in
CartContext.addItem populate the temp item with values already in scope
(service.name, computed priceCents from duration times base) instead of
empty strings.

EVIDENCE
src/context/CartContext.tsx addItem() constructs tempItem with hardcoded
blanks. The caller (ServiceAboutScreen) has the real values in scope.

FIX
Replace tempItem construction with:
  const tempItem = {
    id: 'tmp-' + Date.now(),
    service_id: serviceId,
    service_name: service.name,
    price_cents: service.base_price_cents * duration / service.min_duration_minutes,
    duration_minutes: duration,
  };

EFFORT: 30 min

ACCEPTANCE: Add-to-cart on slow network shows correct name + price during
optimistic window.

================================================================================
P2-003 - Disputes table exists but has no creation path
================================================================================

Severity: P2
Category: OPS

SUMMARY
Backend has a disputes table and CRM has a Trust and Safety module that
lists/manages disputes, but no automated path creates dispute rows. The
dashboard's open disputes KPI always shows 0. Today this is fine because
no disputes exist. Becomes blocking the moment a real complaint comes in -
no UI for the customer to file a dispute, no automatic dispute creation
from negative reviews/ratings, no helper-side dispute creation. Fix: add
POST /api/v1/disputes for customers + automatic creation when 1-star
reviews land.

EVIDENCE
migrations/...disputes...up.sql creates the table. CRM has read+update
endpoints. No INSERT path in user API or CRM. Dashboard KPI returns
COUNT(*) which is always 0.

FIX
Backend:
- POST /api/v1/disputes endpoint accepting from authenticated customer:
  {booking_id, reason, description}
- Trigger on review insertion: if rating <= 2, optionally auto-create
  dispute (configurable via env flag DISPUTES_AUTO_CREATE_THRESHOLD)
Mobile:
- Report an issue button on completed-booking detail screen
- Free-text description + reason picker

EFFORT: 4 hr backend + 2 hr mobile. Total 6 hr.

ACCEPTANCE: Customer can file dispute from app, appears in CRM dispute
queue with full booking context (helper, payment, address, timestamps).

================================================================================
P2-004 - Pre-outbox booking events bypass the transactional outbox
================================================================================

Severity: P2
Category: DATA

SUMMARY
event_outbox pattern was added around migration 069. Booking/matching
code that pre-dates 069 emits events through different code paths
(direct FCM calls inline with business logic, no atomic guarantee). If
you ever rely on outbox-replay for those event types, you'll get
incomplete history. Fix: audit the pre-069 emission paths, either migrate
them to outbox or accept the inconsistency and document it.

EVIDENCE
grep -rn "FCM\.Send\|messaging\.Send\|notification\.Send" --include="*.go" App/househelp-api/internal/booking/
grep -rn "outbox\.Insert\|event_outbox" --include="*.go" App/househelp-api/internal/booking/

The first finds inline FCM sites. The second should ideally cover all of
them but won't.

FIX
For each inline FCM site in booking/matching/payment lifecycle:
- Replace with outbox row insertion in the same pgx transaction
- Outbox consumer (P0-001) then dispatches FCM async

This makes event delivery atomic with business logic. If transaction
rolls back, FCM is never sent. If transaction commits, FCM is guaranteed
to send (eventually, via the consumer).

EFFORT: 3 hr investigation + 2-3 hr migration if needed. Total 5-6 hr.

DEPENDENCIES
- P0-001 (event_outbox consumer) must ship before this is meaningful

ACCEPTANCE: No FCM.Send calls in booking lifecycle code outside of
outbox consumer. All booking lifecycle events flow through outbox.

================================================================================
P2-005 - Cashfree webhook clock-skew assumption unmonitored
================================================================================

Severity: P2
Category: OPS

SUMMARY
Webhook signature verification rejects timestamps more than 300 seconds
from server time. If Railway's container clock drifts (NTP issue,
hypervisor weirdness, timezone misconfig), Cashfree webhooks silently
fail verification and never get processed. Customer pays, system never
sees the webhook, booking stays unpaid. Fix: add a metric for webhook
signature failures + alert if more than N per hour. Confirm tzdata is
correctly bundled in Docker image (already verified in today's deploy
fixes - tzdata is in alpine package list).

EVIDENCE
internal/payments/cashfree.go VerifyWebhookSignature does the 300s
clock-skew check. No metric on the failure path.

FIX
- Add counter: cashfree_webhook_signature_failures_total{reason="clock_skew"|"hmac_mismatch"}
- Alert: more than 5 per hour on either reason
- Document: NTP sync expected on host, Railway uses ntpd by default
- Add boot log assertion: if container time differs from external NTP by
  more than 30 sec, log a warning at startup

EFFORT: 1 hr

ACCEPTANCE: Counter visible in observability surface. Alert fires when
synthesized clock drift more than 300s in test. Boot warning if drift
detected.

================================================================================
P2-006 - Outbound webhooks consumer destination unclear
================================================================================

Severity: P2
Category: OPS

SUMMARY
CRM emits outbound webhooks for major events (EventAdminWorkerApproved,
EventOrderReassigned, EventAdminPromoCreated, etc.) via the webhooks
package. What systems actually receive these? If pointed at /dev/null,
all admin-action notifications are dark. If pointed at something real,
document it. Fix: audit the webhooks subscription table, confirm
destinations, document.

EVIDENCE
SELECT destination_url, is_active FROM webhook_subscriptions LIMIT 20;

FIX
- Confirm what's subscribed in production
- Either: ship at launch with no subscriptions (admin events go nowhere -
  fine if no consumers exist yet) and document
- Or: configure subscription to actual receiving system (Slack? email
  digest? internal monitoring?)
- SSRF allowlist tightening (P2-007) is related

EFFORT: 1 hr

ACCEPTANCE: docs/WEBHOOKS.md exists, lists what's subscribed in
production, who receives, with what authentication.

================================================================================
P2-007 - Webhook SSRF allowlist not tightened
================================================================================

Severity: P2
Category: SEC

SUMMARY
Outbound webhook destinations (CRM-side, the system that fires events to
subscribers) need an allowlist of permitted domains to prevent SSRF
attacks via malicious subscription URLs. From earlier audit work this was
deferred pending vendor list. Now that you know your real subscriber set
(P2-006), define the allowlist.

EVIDENCE
Original audit finding from .audit/FINAL_REPORT.md, blocked on user
provides vendor domain list.

FIX
- Define ALLOWED_WEBHOOK_DOMAINS config var (comma-separated list)
- In webhook dispatcher, validate destination URL against allowlist
  before HTTP call
- Reject + log + alert on any mismatch (could indicate compromised admin
  or misconfigured subscription)
- Block private/internal IP ranges (10.0.0.0/8, 172.16.0.0/12,
  192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16) regardless of allowlist

EFFORT: 1 hr

DEPENDENCIES
- P2-006 (need to know real subscriber domain list first)

ACCEPTANCE: Subscription with non-allowlisted URL fails to save (or
saves but never dispatches, with clear log). Internal IP ranges blocked.
Allowlist documented in docs/WEBHOOKS.md.

================================================================================
P2-008 - Firebase admin key rotation overdue
================================================================================

Severity: P2
Category: SEC

SUMMARY
Firebase Admin credentials are configured via FIREBASE_CREDENTIALS_JSON
env var (raw JSON in Railway). These are long-lived keys with full
Firebase project access (FCM, Auth, etc.). Best practice is quarterly
rotation. Rotation cadence isn't established. Fix: define quarterly
rotation schedule, document in docs/SECURITY.md, do first rotation now.

EVIDENCE
Firebase Console -> Project Settings -> Service Accounts. Compare
creation date of currently-deployed key.

FIX
1. Generate new service account key in Firebase Console (Service
   Accounts -> Generate new private key)
2. Paste into Railway FIREBASE_CREDENTIALS_JSON (raw JSON, not file path)
3. ZopMop auto-redeploys
4. Verify FCM still sends (manual test push), OTP still verifies (manual
   login)
5. Delete old key in Firebase Console
6. Add to calendar: rotate every 90 days
7. Document in docs/SECURITY.md: rotation procedure, last rotation date,
   next rotation date

EFFORT: 30 min including verification

DEPENDENCIES
- P0-003 (Postgres password rotation) - same operational discipline,
  build the muscle for both

ACCEPTANCE: Current Firebase service account key less than 30 days old.
Rotation procedure documented. Calendar reminder set for 90-day rotation.

================================================================================
P2 BATCH SUMMARY
================================================================================

7 tickets total. Approximate combined effort: 12-15 hr coding + ops.

Recommended order:
1. P2-008 (Firebase rotation) - 30 min, do today
2. P2-005 (Cashfree webhook monitoring) - 1 hr, do this week
3. P2-006 (webhook destinations audit) - 1 hr
4. P2-007 (SSRF allowlist, depends on P2-006) - 1 hr
5. P2-001 (cart optimistic UI) - 30 min, do whenever
6. P2-004 (pre-outbox events) - 5-6 hr, after P0-001 ships
7. P2-003 (disputes creation path) - 6 hr, before first real complaints

P2-002 was dropped (light mode not implemented, dark mode toggle is a
placeholder UI cleanup concern, separate audit).
