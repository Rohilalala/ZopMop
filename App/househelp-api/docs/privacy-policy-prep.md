# ZopMop Privacy Policy — Preparation Document

> **STATUS: NOT A POLICY.** This is a working document listing every 
> fact, decision, and disclosure that a real privacy policy will need. 
> Use this as input to a lawyer, a policy-generator service (Termly, 
> iubenda), or a vetted DPDP template (Trilegal/AZB publish these). 
> DO NOT deploy any of this content as-is.

> **Last updated:** [auto-fill today's date]

---

## How to use this document

Walk through each section. For each item:
- If you know the answer, fill it in.
- If you don't, mark `[TODO]` and add a note about who to ask.
- If the question doesn't apply to ZopMop, mark `N/A` with a one-line 
  reason.

When most items are filled, take this document to a lawyer or paste 
into a policy generator. The output of that step is your real policy.

---

## Section 1 — Identity of the data fiduciary

DPDP §2(i): the entity collecting the data.

- [ ] Legal name of the entity behind ZopMop (private limited? LLP? 
  sole proprietorship?)
- [ ] Registered office address
- [ ] CIN / company registration number (if registered)
- [ ] GSTIN (if registered)
- [ ] Founder/contact name and email
- [ ] **Data Protection Officer (DPO)** — Indian DPDP requires this 
  for "Significant Data Fiduciaries." Even for non-SDFs, naming a 
  contact for privacy concerns is good practice.
  - DPO name: [TODO]
  - DPO contact email: [TODO]
- [ ] **Grievance Officer** — DPDP §13 requires a contactable 
  grievance officer for data principal complaints
  - Name: [TODO]
  - Email: [TODO]
  - Response timeline commitment (regulation expects within 30 days)

---

## Section 2 — What data you collect

### From customers
- [x] Phone number (required for OTP login)
- [x] Name (required for service delivery)
- [x] Address(es) — flat number, building, full address, lat/lng, 
  receiver name, receiver phone
- [x] Precise location during active booking/tracking
- [x] In-app chat with helpers
- [x] Cart contents (browsing data)
- [x] Payment information — handled by Cashfree (PCI-DSS); ZopMop 
  stores transaction records only
- [x] Device info — FCM token for push, device ID
- [ ] Email address — `N/A` (not collected)
- [ ] Photo / image of self — [TODO: clarify, does signup require 
  this? Profile picture optional?]
- [ ] Date of birth — [TODO: clarify, do you collect this anywhere?]

### From helpers (Pros)
- All of the above
- [ ] KYC documents — when wired in future. Specify exactly which 
  documents (Aadhaar? PAN? Driving license? Bank account?)
- [x] Live location during active jobs
- [x] Availability/leave history
- [ ] Background check data — [TODO: do you do background checks? 
  Through which provider?]
- [ ] Banking details for payouts — [TODO: when this flow ships, 
  document what's collected]

### Automatically collected
- [x] App usage data — analytics events (tap-throughs, screens 
  visited)
- [x] Crash reports — `[TODO]` (currently NOT collected; if you 
  add Sentry/Firebase Crashlytics later, document)
- [x] Device-level data the OS provides — Android device ID, iOS 
  IDFV, app version, OS version

### Things you DON'T collect (state these explicitly)
- Email addresses
- Contacts list / address book
- Calendar
- Photos library
- Microphone access
- Cross-app advertising identifiers (no Facebook SDK, no Google 
  Ads SDK in current code)
- Background location (only foreground while booking active)

---

## Section 3 — Why you collect each thing (purpose specification)

DPDP §6 requires "specific" purpose. Vague language ("for service 
improvement") is not defensible. List each purpose distinctly.

- [ ] **Service operation** — phone (login), name (helper knows 
  who they're meeting), address (helper goes to the right place), 
  payment (process bookings), location during active job (live 
  tracking, ETA, arrival detection)
- [ ] **Trust and safety** — chat retention for dispute investigation, 
  ratings/reviews for fraud detection, login attempts for security 
  forensics
- [ ] **Operational debugging** — crash logs (when added), structured 
  request logs (no precise PII; coordinates rounded to ~1.1km in 
  logs)
- [ ] **Service quality analytics** — anonymized booking patterns, 
  helper performance metrics
- [ ] **Marketing communications** — push notification campaigns 
  for offers and engagement (separate consent — see Section 7)
- [ ] **Legal compliance** — bookings retention for GST/tax (7 
  years); audit logs for security investigation (3 years)
- [ ] **Account management** — re-engagement notifications for 
  inactive users

---

## Section 4 — Where data goes (third-party processors)

For each processor, you need:
- What service they provide
- What data they receive
- Their geographic location (DPDP cross-border implications)
- Link to their privacy policy

Currently identified processors:

- [ ] **Cashfree (Payments)**
  - Data: card details, bank info, name, phone (for transaction)
  - Location: India (Bangalore HQ)
  - Privacy policy URL: https://www.cashfree.com/privacy-policy
- [ ] **Firebase / Google (Push notifications)**
  - Data: FCM token, push payload contents
  - Location: USA (Google Cloud)
  - Privacy policy URL: https://firebase.google.com/support/privacy
  - **DPDP cross-border note:** US is not on India's "trusted 
    jurisdictions" list (as of 2026); document this and decide 
    whether to disclose explicitly
- [ ] **Google Maps**
  - Data: location queries, addresses for geocoding
  - Location: USA (Google Cloud)
  - Privacy policy: https://policies.google.com/privacy
- [ ] **Zop AI / LLM provider** — [TODO: which provider? 
  Anthropic? OpenAI? OpenRouter?]
  - Data: chat messages users send to the AI
  - Location: depends on provider (Anthropic = USA, OpenAI = USA)
  - Privacy policy: depends on provider
  - **CRITICAL:** users sending PII into the AI chat have it 
    leaving your system. This needs explicit disclosure.
- [ ] **Hosting/cloud provider** — [TODO: AWS? GCP? Azure? 
  DigitalOcean? Railway?]
  - Data: all of it (the entire database lives here)
  - Location: which region? Mumbai (ap-south-1)? Singapore?
  - **DPDP note:** Indian users' data crossing borders requires 
    specific disclosure. If hosted outside India (Singapore, 
    USA, etc.), users need to know.
- [ ] **Email provider** (transactional or marketing) — [TODO: 
  SendGrid? Mailgun? AWS SES?] (currently not used; flag for when 
  added)
- [ ] **Analytics service** — [TODO: do you use a third-party 
  analytics SDK like Mixpanel/Amplitude/Segment, or just internal 
  analytics_events table?] If internal only, mark N/A.
- [ ] **Customer support tool** — [TODO: Intercom? Zendesk? 
  Currently nothing?]
- [ ] **Crash/error reporting** — [TODO: Sentry? Bugsnag? 
  Datadog? Currently nothing?]
- [ ] **Log aggregation** — [TODO: Datadog? CloudWatch? Splunk? 
  Loki?] Logs contain PII (phone, user_id, rounded coords); the 
  log retention service is itself a processor.

---

## Section 5 — How long you keep things (retention)

Pulled from privacy-notes.md retention table. Cross-reference and 
confirm each:

| Data | Kept for | Source decision |
|---|---|---|
| Account profile | While active | Soft-deleted on user deletion |
| Addresses | While active | Hard-deleted on deletion |
| Bookings (paid) | 7 years from completion | Tax law (GST/IT) |
| Bookings (unpaid) | Until cancellation | Hard-deleted on user deletion |
| Booking messages (chat) | 24 months | T&S investigation window |
| Reviews | 3 years from review date | Reputation signal + data minimization |
| Refunds | 7 years from processing | Tax law |
| Login attempts (admin) | 90 days | Security forensics |
| Audit logs (security) | 3 years | Security retention |
| Push campaign records | 90 days | Marketing analytics window |
| Helper status log | 90 days | Operational activity log |
| Wallet transactions | [TODO: confirm; defaults to 7 years for financial records] | |
| Analytics events | [TODO: confirm; rolling 90 days? 1 year? indefinite aggregated?] | |
| Re-engagement records | [TODO: confirm; probably 90 days like push] | |

For each row, the policy needs to state:
- What gets deleted vs anonymized vs retained
- The retention period
- The legal basis for the retention (legitimate interest, legal 
  obligation, etc.)

---

## Section 6 — User rights (DPDP §11-13 / GDPR Art 15-22)

### Currently implemented
- [x] Right to access (`/me/export` endpoint working)
- [x] Right to deletion (account deletion with proper anonymization)

### Required by DPDP/GDPR but currently NOT implemented
- [ ] Right to correction — user can edit their own data via 
  app screens (verify all editable fields work, especially 
  addresses and profile)
- [ ] Right to nominate (DPDP §13(2)) — user can name another person 
  to exercise rights on their behalf if they're incapacitated. 
  Indian-specific.
- [ ] Right to grievance redressal — process for users to file 
  complaints. Section 1 grievance officer + 30-day response.
- [ ] Right to consent withdrawal — user can withdraw consent for 
  specific purposes (marketing, analytics) without affecting 
  service operation. Currently not implemented.

### Process for each right
For each right, your policy needs to state:
- How a user exercises it (in-app button? email? form?)
- Who handles the request
- Maximum response time (DPDP doesn't specify; GDPR says 30 days; 
  industry norm is "promptly")
- What identification you require (phone OTP verification?)

---

## Section 7 — Consent details

DPDP §6: consent must be free, specific, informed, unambiguous.

- [ ] **At signup**: what's the exact text the user agrees to? 
  ("By creating an account, you accept the [Terms](url) and 
  [Privacy Policy](url).") This text is itself part of the 
  consent record.
- [ ] **Tiered consent** — separate toggles for:
  - Service operation (required, can't opt out)
  - Marketing communications (optional, separate toggle)
  - Analytics (optional if you classify it as such; DPDP debates 
    whether it requires consent or is "legitimate interest")
- [ ] **Re-consent on policy update** — when you publish a new 
  version, what's the user flow?
  - Force blocking screen on next app open?
  - Banner with grace period?
  - Per-section re-acceptance?
- [ ] **Consent withdrawal flow** — where in the app does a user 
  go to withdraw consent? Settings screen? What happens after 
  they withdraw?

---

## Section 8 — Data security disclosures

What you tell users about how you protect their data.

- [ ] **Encryption in transit** — HTTPS/TLS for all API calls 
  (verify — should be true)
- [ ] **Encryption at rest** — does your DB host encrypt? (most 
  managed Postgres services do; verify)
- [ ] **Access controls** — admin access to user data, audit 
  logging (chunk 6 work)
- [ ] **Breach notification** — DPDP §8(6) requires notification 
  to affected users + Data Protection Board "without delay." 
  Process: who decides it's a breach, who notifies, timeline 
  commitment.
- [ ] **Security certifications** — none yet for ZopMop. Note as 
  "not currently certified" rather than claiming SOC-2 / ISO 27001 
  you don't have.

---

## Section 9 — Children's data

DPDP §9: data of children (<18 in India) requires verifiable 
parental consent. Behavioral monitoring, advertising to children, 
profiling are restricted.

- [ ] **Age verification** — does ZopMop collect age? If not, 
  state "ZopMop is not designed for users under 18."
- [ ] **What if a minor signs up?** — current policy: ?
- [ ] **What if you discover a minor used the service?** — 
  process to delete their data
- [ ] **Parent contact mechanism** — if a parent contacts you 
  about a child's data, what's the response process?

---

## Section 10 — Cross-border data transfer

If your hosting or any processor is outside India, you need to 
disclose:

- [ ] Hosting region (verified)
- [ ] List of countries data may be transferred to (Cashfree → 
  India; Firebase → USA; etc.)
- [ ] Legal basis for transfer (DPDP §16: government-notified 
  countries are easier; others require user consent + 
  adequacy assessment)
- [ ] Whether you've assessed each transfer's adequacy

---

## Section 11 — Marketing communications

If you send marketing pushes/emails/SMS:

- [ ] How users opt in (default ON or default OFF?)
- [ ] How users opt out (in-app toggle? unsubscribe link?)
- [ ] Frequency caps (if any)
- [ ] What kinds of marketing (offers? newsletters? feature 
  announcements?)
- [ ] Whether marketing data is shared with third parties (is your 
  push provider seeing marketing copy? Yes — Firebase processes it.)

---

## Section 12 — Cookies and tracking technologies

Even though ZopMop is mobile-first, the website (when launched) 
needs cookie disclosures.

- [ ] **App tracking** — does the app use any analytics SDK that 
  qualifies as "tracking" under iOS App Tracking Transparency? 
  (Currently: probably no, but verify.)
- [ ] **Web cookies** — when website launches, what cookies?
  - Functional (login session)
  - Analytics (Google Analytics? Plausible? Custom?)
  - Marketing (Google Ads pixel? Meta pixel? None?)

---

## Section 13 — Special categories / sensitive data

DPDP doesn't have a "special category" carve-out the way GDPR does, 
but Indian sectoral regulators (RBI for banking data, IRDAI for 
insurance) impose stricter rules on specific data types.

- [ ] **Aadhaar** — if KYC ever requires Aadhaar, that's heavily 
  regulated by UIDAI separately from DPDP. Consult a lawyer 
  specifically about Aadhaar handling before storing it.
- [ ] **PAN** — if collected, list separately from regular ID
- [ ] **Bank account details** — when payouts wire up, separate 
  treatment under RBI guidelines
- [ ] **Biometric data** — `N/A` (not collected; verify and confirm)
- [ ] **Health data** — `N/A` if not collected
- [ ] **Caste/religion/political views** — `N/A` (must not be 
  collected unless absolutely necessary)

---

## Section 14 — Effective date and updates

- [ ] Date the policy first becomes effective
- [ ] How users are notified of changes (in-app banner? email? 
  push notification?)
- [ ] Where past versions are archived (ZopMop already has 
  consent_versions table for this)
- [ ] Material changes vs typo fixes (do typo fixes require 
  re-consent? Most platforms say no.)

---

## Section 15 — Contact information

The policy needs at minimum:
- [ ] Company legal name
- [ ] Postal address
- [ ] Contact email for general inquiries
- [ ] DPO/Grievance Officer email (Section 1)
- [ ] Phone number (often required by app stores)

---

## What ZopMop already has prepared

These items are in good shape, sourced from current code + audit 
work:

- [x] Comprehensive data inventory (privacy-notes.md)
- [x] Retention decisions for 9 categories of data
- [x] User-deletion mechanism (anonymization for retained data, 
  hard-delete for non-retained)
- [x] Data export endpoint (`/me/export` returning DPDP §11-compliant 
  JSON)
- [x] Audit logging of admin actions on user data (chunk 6 work)
- [x] Consent versioning database schema (chunk 1; not yet wired 
  to auth flow)
- [x] PII scrubbing in logs (coords rounded to ~1.1km)
- [x] PII scrubbing on user deletion (chunk 12 walker)

## What ZopMop is MISSING

Items the policy will reference that don't exist in code yet:

- [ ] Consent versioning wired into auth flow (chunk 1 schema 
  exists; auth handler still uses old boolean)
- [ ] Grievance officer designation + contact
- [ ] DPO designation + contact (if required)
- [ ] Breach notification process / runbook
- [ ] Settings screen for consent withdrawal
- [ ] Process for handling government data requests
- [ ] Policy text itself (this document is prep, not policy)
- [ ] Cookie policy (when website launches)
- [ ] Children's data process

---

## Recommended next steps

1. **Get a legal consultation** — 1 hour with a tech/privacy lawyer 
   in India (~5K-15K INR). Take this document. Ask them which items 
   apply to ZopMop and which don't, and what they'd add.

2. **Choose a drafting path:**
   - **Lawyer-drafted:** ~30K-1L INR for a real privacy policy 
     drafted from this prep doc
   - **Template + customization:** Trilegal/AZB Partners publish 
     vetted DPDP templates. ~Free or ~5K INR. You customize from 
     this prep doc.
   - **Generator service:** Termly, iubenda. ~$10-50/month. 
     Guided questionnaire, vetted output.

3. **Don't deploy without legal review** — even template-based 
   policies need someone qualified to verify they match your actual 
   practices.

4. **Tie real policy to consent versioning** — once you have a real 
   policy URL, wire it into the consent flow (chunk N: consent 
   versioning auth wiring).

---

## Things to think about beyond the policy itself

- [ ] **Internal data handling policy** — separate document for 
  employees: who can access user data, when, how it's logged
- [ ] **Vendor data processing agreements (DPAs)** — for each 
  processor in Section 4, you should have a contract that 
  specifies data handling. Cashfree/Firebase/Google have 
  standard DPAs you sign by accepting their TOS; smaller vendors 
  need explicit DPAs.
- [ ] **Insurance** — cyber liability insurance covers breach 
  costs. Becomes relevant once you have meaningful user data 
  volumes.
- [ ] **Incident response plan** — even a one-pager: "if there's 
  a breach, here's the order of operations" (assess scope → 
  contain → notify users → notify Data Protection Board → 
  investigate root cause → publish post-mortem)

---

**End of preparation document.**

This document is a living artifact — update it as you make decisions, 
add processors, change retention, or learn things from a lawyer. 
When most items are filled, hand it to your drafter.
