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
| Bookings | TODO: decide |  |
| Reviews | TODO: decide |  |
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
- [ ] **reviews**: ?  Four sub-decisions: customer delete × helper 
  delete × delete-vs-anonymize × comment retention. Affects helper's 
  public rating which is income-impacting.
- [ ] **bookings**: ?  Financial records, GST law typically requires 
  7 years for tax — likely anonymize customer/helper IDs but retain 
  the row.
- [ ] **refunds**: ?  Same as bookings — financial.
- [ ] **audit_log**: ?  Security records — typical retention 1-7 
  years.
- [ ] **crm_audit_log**: ?
- [ ] **crm_login_attempts**: ?  Security — short retention typical.
- [ ] **crm_push_messages**: ?  Push content can contain PII.
- [ ] **helper_status_log**: ?  Location pings; could be considered 
  customer PII because pings are usually near customer addresses.
- [ ] **roomies wallet history**: ?  Counterparty's ledger view 
  needs to be preserved.

---

## Things to revisit before launch

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
