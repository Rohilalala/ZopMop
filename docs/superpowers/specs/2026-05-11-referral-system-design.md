# Referral System Design

**Date:** 2026-05-11  
**Status:** Approved  
**Approach:** Option A — synchronous, in-transaction credits

---

## Overview

Users share a personal referral link. When a new user signs up via that link they get Rs 100 wallet credit immediately. When that referee completes their first booking, the referrer gets Rs 200 wallet credit. Each user can refer at most 3 people (3 successful completions = Rs 600 max earnings).

---

## Reward Rules

| Event | Who | Amount |
|-------|-----|--------|
| Referee completes first booking after accepting invite | Referee | Rs 100 (10,000 paise) |
| Referee completes first booking after accepting invite | Referrer | Rs 200 (20,000 paise) |

Both credits fire in the **same transaction** when the referee completes their first booking. Cancellations do not trigger any credit — only a completed (not cancelled, not disputed) booking counts.

- Max 3 referrals per referrer (total rows in `referrals` for that referrer, pending + completed)
- A user can only be referred once (`UNIQUE(referee_id)`)
- Self-referral rejected at service layer

---

## Data Model

### Migration `083_referrals.up.sql`

```sql
-- referral code per user, name-based (e.g. ADITYA42)
ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE;

CREATE TABLE referrals (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id          UUID        NOT NULL REFERENCES users(id),
  referee_id           UUID        NOT NULL REFERENCES users(id),
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'completed')),
  referee_credited_at  TIMESTAMPTZ,          -- set at row creation (Rs 100 credited)
  referrer_credited_at TIMESTAMPTZ,          -- set when first booking completes (Rs 200 credited)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referee_id)
);

CREATE INDEX referrals_referrer_idx ON referrals(referrer_id, status);
```

Update wallets `CHECK` constraint (migration) to include `referral_credit` in the allowed kinds.

---

## Referral Code Generation

- Triggered on `PUT /me` (name update) if `referral_code IS NULL`
- Algorithm:
  1. Extract first name (first whitespace-delimited word of name)
  2. Uppercase, strip non-alpha → e.g. `ADITYA`
  3. Pick a random suffix and attempt insert; suffix digit-length escalates as the namespace fills:
     - 2 digits (00–99, 100 slots): try until collision
     - 3 digits (100–999): once all 2-digit slots for that prefix are taken
     - 4 digits (1000–9999): once all 3-digit slots taken
     - and so on — suffix length grows by 1 digit each time the previous tier is exhausted
  4. Implementation: retry loop — on `UNIQUE` violation, increment suffix length tier and retry; `UNIQUE` constraint is the authoritative collision guard
- `users.referral_code` has a `UNIQUE` index — DB enforces no two users ever share a code regardless of timing
- Fallback for nameless users OR non-latin names that strip to empty string: `USER` + last 4 digits of phone → `USER9876`
- Once generated, code is **permanently locked** — name changes do not regenerate it (prevents breaking shared links)
- Code is returned in `GET /me/referral` response; also lazy-generated there if still null

---

## Wallet Kind

Add `KindReferralCredit Kind = "referral_credit"` to `internal/wallet/model.go`.

- `IsCredit()` returns `true`
- No `paymentID` or `bookingID` required (note carries referral context)
- Note format: `"referral credit: referee {referee_id}"` / `"referral bonus: referrer reward for {referee_id}"`

`ValidateCreditInputs` already allows credit kinds without paymentID as long as kind != topup — no change needed there.

---

## API Endpoints

### `GET /me/referral`

Auth: required (customer)

Response:
```json
{
  "code": "ADITYA42",
  "link": "https://zopmop.com/r/ADITYA42",
  "referrals_used": 2,
  "referrals_remaining": 1,
  "total_earned_paise": 40000
}
```

Lazy-generates `referral_code` if null.

---

### `POST /referrals/apply`

Auth: required (customer)

Request:
```json
{ "code": "ADITYA42" }
```

In a single transaction:
1. Resolve referrer from `users.referral_code = code`
2. Validate: referrer exists, referrer != caller, caller has no existing referral row, referrer total referral count < 3
3. Insert `referrals` row: `referrer_id`, `referee_id=caller`, `status='pending'` — **no wallet credit here**

Error responses:
- `404` — code not found
- `409 code=already_referred` — caller already used a referral code
- `409 code=referral_cap_reached` — referrer at 3/3
- `400 code=self_referral` — same user

---

## Both Credits (Booking Completion Hook)

In the booking-completion handler (where booking status is set to `completed`), inside the existing transaction, after status update:

1. Query: does `customer_id` have a `referrals` row with `status='pending'`?
2. If yes: does this customer have any prior completed booking with `completed_at > referrals.created_at`? (i.e. have they completed a booking before, after the referral was accepted)
3. If no prior post-referral completed booking exists → this is the trigger:
   - Credit **referee** 10,000 paise via `wallet.CreditTx` with `KindReferralCredit`, note: `"referral credit: first booking bonus"`
   - Credit **referrer** 20,000 paise via `wallet.CreditTx` with `KindReferralCredit`, note: `"referral bonus: referee {referee_id} completed first booking"`
   - Update referral row: `status='completed', referee_credited_at=NOW(), referrer_credited_at=NOW()`
4. If referrer account is deleted or suspended → skip referrer credit silently, still credit referee and mark `completed`
5. Cancelled bookings: booking-completion handler only fires on `completed` status — cancellations never reach this code path

"First booking" = first booking completed after `referrals.created_at`. Existing users with prior bookings handled correctly — only post-referral bookings count.

All three writes (2 wallet credits + referral status update) inside the booking completion tx — atomic.

---

## Universal / Deep Links

URL: `https://zopmop.com/r/{code}`

**iOS Universal Links:**
- Host `apple-app-site-association` at `https://zopmop.com/.well-known/apple-app-site-association`
- Path pattern: `"/r/*"`
- Team ID: `2P38R9F468`

**Android App Links:**
- Host `assetlinks.json` at `https://zopmop.com/.well-known/assetlinks.json`
- Package + SHA-256 fingerprint of release keystore

**No-app fallback:**
- `zopmop.com/r/{code}` serves a landing page with App Store + Play Store buttons
- The code is preserved in the redirect so it can be passed as a query param on first launch

---

## App Screens

### ReferralInviteScreen — full flow

Triggered when app is opened via `zopmop.com/r/{code}`. Applies to both new and existing users (existing users who were never referred still go through the full flow; they can only accept once).

**Step 1 — Auth gate**
- If not logged in: store `pendingReferralCode` in AsyncStorage, run normal signup/login flow (OTP), then resume from Step 2 after auth completes
- If already logged in: proceed directly to Step 2

**Step 2 — Location check**
- App requests location permission and detects current location
- On permission denied or GPS failure: show manual city picker (list of serviceable cities)
- Call existing serviceable-zone check against detected coordinates or selected city
- If **not serviceable**: show static screen "This location is not serviceable yet" — no referral applied, flow ends
- If **serviceable**: proceed to Step 3

**Step 3 — Confirmation**
- Show bottom sheet / modal: "{Referrer first name} invited you to ZopMop. Accept to get Rs 100 wallet credit?"
- Two buttons: **Accept** / **Decline**
- Decline → dismiss, navigate to home, no referral applied
- Accept → call `POST /referrals/apply` → proceed to Step 4

**Step 4 — Success screen**
- Full screen (not toast): "Invite accepted! Complete your first booking to get Rs 100 in your wallet."
- Single CTA button: **Explore Services** → navigates to services tab
- If `already_referred` error from API: show "You've already used a referral code"
- If `referral_cap_reached`: show "This referral link is no longer active"

---

### Refer & Earn Screen

Accessible from home nav or profile.

- User's referral code + copy button
- Share button → native share sheet with pre-filled message:  
  `"Use my code {CODE} to get Rs 100 off your first ZopMop booking! https://zopmop.com/r/{CODE}"`
- Progress bar: `{n}/3 referrals · Rs {earned} earned`
- Empty state when no referrals yet

---

## App Navigation / Deep Link Routing

- Register `zopmop.com` as Universal Link / App Link domain in Expo config
- Deep link handler: parse path `/r/:code` → push `ReferralInviteScreen` with `{ code }`
- Store pending code in AsyncStorage key `pendingReferralCode`; cleared after successful apply or explicit decline
- Auth completion handler checks for `pendingReferralCode`, resumes ReferralInviteScreen at Step 2

---

## Edge Case Resolutions

| Case | Resolution |
|------|-----------|
| User changes name after code generated | Code permanently locked; no regeneration |
| Referee already had prior bookings | "First booking" = first completed booking after `referrals.created_at`, not first ever |
| Referrer deleted/suspended at credit time | Silently skip wallet credit; mark referral `completed` anyway |
| Non-latin / symbol-only name strips to empty | Fall back to `USER` + last 4 phone digits |
| Multiple referral links tapped before signup | Last tap wins (AsyncStorage overwrites); documented behaviour |

---

## Out of Scope

- Referral expiry (codes never expire)
- Referral leaderboard / gamification
- Pro (helper) referrals — customers only
- Push notification on referral reward credit (can be added via existing wallet.credited outbox event later)
