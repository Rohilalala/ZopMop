# ZopMop Privacy & Data Handling Notes

**Purpose:** Running notes on what data ZopMop collects, why, and 
what happens when users delete their accounts. Source material for 
drafting the actual privacy policy and DPDP/GDPR compliance docs. 
Plain language — these notes get translated into legal language 
later.

**Status:** Living document, updated as decisions are made.

---

## What we collect

### From customers
- **Phone number** — required for OTP login. Stored permanently 
  while account is active.
- **Name** — collected at signup. Required for helper to know who 
  they're meeting.
- **Address(es)** — collected when booking. Includes flat number, 
  building, full address, lat/lng. Used to send the helper to the 
  right place.
- **Precise location** — collected when actively booking or tracking 
  a helper. NOT collected continuously in the background.
- **Payment information** — handled by Cashfree (we don't store card 
  numbers). We store transaction records (amount, status, timestamps).
- **Device info** — FCM token for push notifications, device ID for 
  fraud detection.
- **In-app chat with helpers** — text messages exchanged during a 
  booking.

### From helpers
- All of the above, plus:
- **KYC documents** (when this is wired up — TODO)
- **Live location during active jobs** — for customer to track 
  helper en route
- **Availability/leave history**

### Automatically collected
- **App usage data** — which screens you open, what you tap. Used 
  for product analytics.
- **Crash reports** — TODO: not currently collected (no Crashlytics/
  Sentry wired up). Will need disclosure when added.

### What we DON'T collect
- Email addresses (we don't ask for them)
- Contacts list, calendar, photos, or other device data beyond 
  what's listed above
- Cross-app tracking (we have no ad SDKs)
- Background location

---

## Where data goes

- **Our servers** (Postgres + Redis, hosted on [TODO: name your 
  cloud provider]) — primary store
- **Cashfree** — payment processing (their privacy policy applies 
  to card data they handle directly)
- **Firebase** — for push notifications (FCM tokens, message 
  delivery; Google's privacy policy applies)
- **Google Maps** — when displaying maps in the app (Google's 
  privacy policy applies)
- **Zop AI assistant** — when users chat with the AI, those messages 
  get sent to [TODO: confirm which LLM provider]. The AI provider 
  receives the chat content. Audit flagged this as a separate 
  concern (F1-D1).

---

## How long we keep things

This section grows as we make retention decisions. Last updated: 
2026-05-06.

| Data | Kept for | What happens when user deletes account |
|---|---|---|
| Account profile (phone, name) | While account is active | Soft-deleted (anonymized in users table) |
| Addresses | While account is active | Hard-deleted on account deletion |
| Device tokens | While account is active | Hard-deleted on account deletion |
| Cart contents | While account is active | Hard-deleted on account deletion |
| Preferred helpers list | While account is active | Hard-deleted on account deletion |
| Reengagement notifications | While account is active | Hard-deleted on account deletion |
| In-app chat (booking_messages) | 24 months from message date | Sender anonymized, body retained for dispute investigation, hard-deleted after 24 months |
| Bookings (money moved) | 7 years from completed_at | customer_id + helper_id anonymised to tombstone, address text cleared, address_id detached, lat/lng rounded to ~11km (1 decimal), locality preserved, all financial fields preserved. Hard-deleted after 7 years. |
| Bookings (money never moved) | n/a | Hard-deleted on user erasure (no tax obligation) |
| Reviews | 3 years from review date | Customer-side anonymized to tombstone (rating + comment retained); helper-side anonymized to tombstone helper (prevents rating-reset exploit); hard-deleted after 3 years |
| CRM admin login attempts | 90 days from attempt | (No customer-facing user impact — admin auth log) |
| Audit log (legacy) | 3 years from row creation | Target user identifiers anonymized on user deletion; admin actor identifiers preserved within window. JSONB old_value/new_value not scrubbed (3-year retention is the bound). |
| CRM audit log | 3 years from row creation | Target user identifiers anonymized on user deletion; admin actor identifiers preserved within window. JSONB before_value/after_value not scrubbed (3-year retention is the bound). |
| Refunds | TODO: decide |  |
| Audit logs | TODO: decide |  |
| Push notification history | TODO: decide |  |
| Helper status pings | TODO: decide |  |
| Roomies wallet history | TODO: decide |  |

---

## When users delete their accounts

What works today (as of 2026-05-06):
- 4 columns scrubbed on the users table (phone, name, fcm_token, 
  anonymizing the row)
- helpers row is deleted
- Trivial user-owned data hard-deleted (addresses, device tokens, 
  cart, preferred helpers, reengagement notifications)
- In-app chat anonymized (sender_id replaced with tombstone, body 
  retained for trust & safety review)
- Reviews bidirectionally anonymized: outbound reviews reassign 
  customer_id to the tombstone user; inbound reviews (when the 
  deleted user was a helper) reassign helper_id to the tombstone 
  helper. Rating + comment preserved.
- Bookings split by payment rail: rows where money moved (Cashfree 
  paid / COD completed / wallet completed) have customer_id + 
  helper_id reassigned to tombstone, address text cleared, lat/lng 
  rounded to ~11km, locality + financial fields preserved, retained 
  7 years from completed_at. Rows where money never moved are 
  hard-deleted.

What's still being built (audit C-8 / F2D-1):
- TODO: decide retention for bookings, reviews, refunds, etc.
- Retention crons that automatically purge old data after windows
- Real /me/export endpoint (currently stubbed at 501 Not Implemented)
- Proper consent versioning (currently a single boolean)

---

## User rights (under DPDP / GDPR)

Things users can do today:
- Request account deletion (works partially — see above)
- View their addresses, bookings, payment history (in-app)

Things they cannot yet do:
- Download their full data in a portable format (TODO — endpoint 
  exists as stub)
- Withdraw specific consents (TODO — current consent is all-or-nothing 
  boolean)
- See an audit trail of who accessed their data (TODO)

---

## Open decisions (update as we make them)

- [x] **booking_messages**: anonymize sender, keep body, 24 month 
  retention. Reasoning: trust & safety needs ability to review 
  disputes; 24 months is industry-standard window. Decision date: 
  2026-05-06.
- [x] **reviews**: 3-year retention from created_at. Customer-side 
  anonymises customer_id to tombstone (rating + comment retained — 
  helper's reputation still reflects past customer's vote). Helper-
  side anonymises helper_id to tombstone helper (prevents rating-
  reset exploit — a helper with bad reviews cannot delete-and-
  recreate to wipe history). Comment body kept as-is (PII risk in 
  body accepted in exchange for dispute-investigation utility). 
  Hard-deleted after 3 years by retention worker. Decision date: 
  2026-05-06.
- [x] **bookings**: 7-year retention from completed_at for rows where 
  money moved on any payment rail (Cashfree-paid via webhook, 
  COD-completed, or wallet-completed). Predicate matches the existing 
  in-code "real booking" predicate at booking/repository.go:509,663 — 
  `(payment_method != 'cashfree' AND status = 'completed') OR 
  payment_status = 'paid'`. PII redaction at anonymisation time: 
  customer_id + helper_id reassigned to tombstone, address text 
  cleared, address_id FK detached, lat/lng rounded to 1 decimal 
  (~11km, "metropolitan area" grain). locality preserved. All 
  financial fields retained for tax-audit defence. Bookings where 
  money never moved (cancelled / abandoned / failed-pay) are hard-
  deleted on user erasure — no tax obligation. Decision date: 
  2026-05-06.
- [ ] **refunds**: ?  Same as bookings — financial.
- [x] **audit_log** (legacy migration 008): 3-year retention from 
  row creation. On user erasure, `target_id` for rows where the 
  deleted user is the action target is anonymised to TombstoneUserID. 
  Admin actor fields (admin_id, ip_address) preserved within the 
  window for accountability — they age out with the row at 3 years. 
  JSONB `old_value` / `new_value` payloads NOT scrubbed (see follow-
  up note below). Decision date: 2026-05-06.
- [x] **crm_audit_log**: same policy as legacy audit_log. 3-year 
  retention; user-target-side anonymised; admin actor preserved 
  within window. Decision date: 2026-05-06.
- [x] **crm_login_attempts**: 90-day retention from created_at. 
  Industry-standard security investigation window. On (future) 
  CRM admin deletion, the admin's email is anonymised to 
  `<deleted>@tombstone.local` and ip_address NULLed; success/reason 
  forensic counters preserved. Hard-deleted by retention worker 
  after 90 days. Note: no customer-facing user impact — this is 
  the CRM admin auth log, separate from customer/helper users. 
  AnonymizeLoginAttemptsByEmail method exists but has no live 
  caller; CRM admin deletion flow is not yet implemented and is 
  tracked as future work. Decision date: 2026-05-06.
- [ ] **crm_push_messages**: ?  Push content can contain PII.
- [ ] **helper_status_log**: ?  Location pings; could be considered 
  customer PII because pings are usually near customer addresses.
- [ ] **roomies wallet history**: ?  Counterparty's ledger view 
  needs to be preserved.

---

## Things to revisit before launch

- Audit log JSONB scrubbing: `before_value` / `after_value` (and 
  legacy `old_value` / `new_value`) payloads may contain user PII 
  baked in by the recording module — for example, an admin 
  user-suspension action might log the full users row, including 
  phone and name. The chunk-6 structured-column anonymisation does 
  NOT scrub these blobs. The 3-year retention window is the bound — 
  PII ages out via the retention worker. JSONB-key-level recursive 
  redaction (with a known-PII-keys allowlist) is dedicated follow-up 
  work for the compliance sprint.
- Implement the CRM admin deletion flow. When built, it should call 
  `compliance.AnonymizeLoginAttemptsByEmail(adminEmail)` to scrub 
  per-account history at deletion time. The 90-day retention sweep 
  is the immediate forensic-window guarantee in the meantime.
- When the refund flow starts writing `payment_status='refunded'` 
  to bookings (currently the value is documented but no code path 
  sets it), expand the "money moved" predicate in 
  internal/compliance/purge.go (moneyMovedPredicate constant) to 
  include `payment_status='refunded'`. Refunded bookings are still 
  tax records — money moved both directions.
- File a vendor issue with Cashfree about their missing 
  PrivacyInfo.xcprivacy SDK manifest (Apple App Store may reject 
  at submission)
- Confirm hosting region (DPDP has cross-border transfer 
  implications if data leaves India)
- Decide on data retention for Zop AI conversations — they currently 
  go to a third-party LLM provider (audit F1-D1)
- Get a real privacy policy URL up — currently the app references 
  TERMS_URL and PRIVACY_POLICY_URL constants but they may point at 
  placeholders
