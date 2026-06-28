# Spec C1 — Server OTP Rail + Payment-Gated END OTP

- **Date:** 2026-06-17
- **Status:** Approved (design); implementation plan pending
- **Branch target:** `feature/cart-booking-overhaul` → `develop`
- **Author:** session (ZopMop)
- **Supersedes the "Spec C" handoff bundle** — that bundle is split into C1 (this doc) and C2 (future).

---

## 1. Background

### Current state (verified in code)
- **START OTP** is client-derived: `deriveOtp()` = FNV-1a hash of `bookingId`, 4-digit, in `zopmop-app/src/screens/main/TrackLiveScreen.tsx:1121`. Shown to the customer at substate `en_route`/`arrived`. **Never verified server-side.**
- Pro "Start Job" → `POST /pro/jobs/:id/start` with **no OTP**; backend only checks `status='accepted'` (`househelp-api/internal/booking/service.go:2040`).
- **No END OTP exists** anywhere. `POST /pro/jobs/:id/complete` has **no payment gate**.
- No booking-OTP DB columns, no redis keys, no verify endpoints.
- **Payment rails:** wallet / split / cashfree-direct / cod. COD = `payment_method='cod'`, `payment_status` NULL, dispatched immediately. `payment_status='paid'` is set by wallet debit, split-full, and the Cashfree webhook.
- Cashfree order-create already exists: `POST /payments/cashfree/order` with `booking_id`; the already-paid guard is scoped to `gateway='cashfree' AND gateway_status='success'` and subtracts `wallet_applied_paise`.
- Pro pay is **time-based** (₹80/hr online + working, fortnightly settle). No per-job collection UI exists.

### Two corrections to the original handoff
1. **C10 ≠ booking OTP.** The hardcoded `"999999"` is the **login** OTP (dev-only, gated `OTP_DEV_MODE && !IsProduction()`). This spec does **not** touch it.
2. **D15 is not in the audit.** No "Pay online now" nudge row is documented in `docs/business-rules-audit-2026-05-21.md`. The nudge here is a new design decision, not an audit-backed rule.

---

## 2. Scope

**In scope (C1):** server-generated START + END OTP, persistence, pro-side verification, payment-gated END-OTP visibility, the always-present online-pay nudge, cash-at-completion as a payment-unlock, legacy backfill.

**Out of scope (→ C2):**
- Cash reconciliation **ledger** (pro ↔ platform who-owes-whom). C1 only records a cash `payments` row; it does not settle pro balances.
- Any settle-online endpoint work beyond reusing the existing Cashfree order flow.

---

## 3. Core loop

- **START OTP:** always generated and shown to the customer, regardless of payment. A job can start unpaid.
- **END OTP:**
  - Paid (upfront wallet/split/cashfree, **or** paid online mid/post-job, **or** cash collected by the pro) → shown to the customer when the job is `in_progress`.
  - Unpaid → **hidden**; the customer sees the nudge row instead.
- **Pro:** enters START OTP to move `accepted→in_progress`; enters END OTP to move `in_progress→completed`. END OTP is the single completion key for **every** path, including cash.

---

## 4. Data model — migration 144

Add to `bookings`:

| column | type | note |
|---|---|---|
| `start_otp` | `VARCHAR(4)` | plaintext; low-secrecy, one-booking blast radius |
| `end_otp` | `VARCHAR(4)` | plaintext |
| `start_otp_attempts` | `INT NOT NULL DEFAULT 0` | audit counter |
| `end_otp_attempts` | `INT NOT NULL DEFAULT 0` | audit counter |
| `start_verified_at` | `TIMESTAMPTZ NULL` | set on successful START verify |
| `end_verified_at` | `TIMESTAMPTZ NULL` | set on successful END verify |

**Plaintext rationale:** the customer must re-display the code on every TrackLive open; a 4-digit, single-booking-scoped code does not warrant one-way hashing + per-render reveal endpoints. The protection is exposure control (Section 7), not at-rest hashing.

---

## 5. Generation

- Both OTPs generated at **booking accept** (when a pro is assigned), 4-digit via `crypto/rand` (uniform 0000–9999).
- Timing is safe: by accept-time the payment outcome is settled — cashfree-direct is paid before any pro is assigned; COD / wallet / split assign immediately on create.
- Idempotent: only generate if the column is NULL (re-accept / retry must not rotate a live code).

---

## 6. API

### 6.1 `POST /pro/jobs/:id/start`  (modified)
- Body adds `{ "otp": "1234" }`.
- Server: load booking, require `status='accepted'` and assigned-pro match; `start_otp_attempts++`; compare constant-time against `start_otp`.
  - Match → set `start_verified_at`, transition `accepted→in_progress`, return current job payload.
  - Mismatch → `400 invalid_otp` (no transition).
- **START is never payment-gated.**

### 6.2 `POST /pro/jobs/:id/complete`  (modified)
- Body adds `{ "otp": "5678" }`.
- Server: require `status='in_progress'` and assigned-pro match.
  - If `payment_status != 'paid'` → `409 payment_required` (before any OTP check).
  - Else `end_otp_attempts++`, constant-time compare against `end_otp`.
    - Match → set `end_verified_at`, transition `in_progress→completed`, return completion payload (existing `pro_earnings_paise`, `actual_duration_minutes`).
    - Mismatch → `400 invalid_otp`.

### 6.3 `POST /pro/jobs/:id/collect-cash`  (new)
- Preconditions: assigned-pro match, `payment_method='cod'`, `payment_status != 'paid'`, `status='in_progress'`.
- Action (single tx): set `payment_status='paid'` (method stays `'cod'`); insert a `payments` row `gateway='cash', gateway_status='success', amount_paise = outstanding net`; emit no Cashfree calls.
- Effect: END OTP becomes visible to the customer on next read; pro can now `/complete`.
- Returns `{ outstanding_paise: 0 }`.
- `outstanding net = amount_paise − discount_paise − wallet_applied_paise`.

### 6.4 Pay online (reuse, unchanged)
- Customer taps the nudge → existing `POST /payments/cashfree/order` (booking) → Cashfree Drop SDK → `PAYMENT_SUCCESS_WEBHOOK` sets `payment_status='paid'`. END OTP then appears.

---

## 7. Read-side OTP exposure (security-critical)

- **Customer (booking owner) payload** (booking detail / matching detail):
  - `start_otp`: always returned when present.
  - `end_otp`: returned **iff `payment_status='paid'`**; otherwise `null`/omitted (app shows nudge).
- **Pro payload** (`/pro/jobs/*`, job detail): **never** includes `start_otp` or `end_otp`. Pro types them; server compares. Pro payload carries `payment_status` + `outstanding_paise` so the UI can branch.
- Enforce at the serialization layer, not the screen — strip OTP fields from pro DTOs explicitly.

---

## 8. Customer UI — `TrackLiveScreen`

- **START card:** show `start_otp` from pro-en-route onward, persists through the job. (Replaces `deriveOtp`.)
- **END card:** render when `status='in_progress'` **and** `end_otp` present (= paid).
- **Nudge row:** visible while `payment_status != 'paid'` AND booking active (not `completed`/`cancelled`).
  - Copy: **"Pay ₹X online to avoid cash handling"** (X = outstanding net, formatted ₹).
  - Chrome: single thin row, ₹-in-circle icon, chevron — **ZopMop-themed** (brand tokens from existing TrackLive cards; not Toing/super.money styling). No cashback subtitle.
  - Tap → Cashfree order + Drop SDK sheet.
  - On payment success: nudge disappears, END card takes its place (live).

---

## 9. Pro UI — `JobDetailScreen`

- **"Start Job"** → 4-digit OTP **bottom sheet** → `POST /start {otp}`. Wrong code → inline error, stay on sheet.
- **"Finish Job":**
  - **Paid** → END OTP bottom sheet → `POST /complete {otp}`.
  - **Unpaid** → state shows **"Awaiting payment — ₹X outstanding"** + **"Collect ₹X cash"** button.
    - Tap → confirm → `POST /collect-cash` → `payment_status='paid'` → END OTP releases to customer → customer reads it → pro enters it in the END sheet → `POST /complete`.
    - If the customer pays online first, the screen flips live from "Collect cash" to END-OTP entry.

---

## 10. Abuse / lifecycle

- **Light handling:** `*_otp_attempts` counted for audit; **no hard lockout** (a typo must not strand a pro mid-job). Existing global rate limiting still applies.
- **No OTP rotation/regeneration** in C1.
- **Stuck job** (customer never pays and is absent for cash): out of scope — support/CRM resolves. No pro escape hatch.

---

## 11. Back-compat — within migration 144

- Backfill `start_otp` and `end_otp` for all active bookings (`pending`/`accepted`/`in_progress`) using SQL random: `lpad((floor(random()*10000))::text, 4, '0')`.
- Customer app drops `deriveOtp()` entirely and reads `otp` from the booking payload.
- Old app builds still hashing would mismatch — acceptable given early-stage; assume force-update.

---

## 12. Success criteria / test plan

1. Wrong START OTP → no `accepted→in_progress` transition; counter increments.
2. Correct START OTP → transition; `start_verified_at` set.
3. `/complete` on an unpaid booking → `409 payment_required`, even with a correct-looking OTP.
4. END OTP `null` in customer payload while unpaid; populated after online-pay webhook **and** after `/collect-cash`.
5. `/collect-cash` writes a `gateway='cash', gateway_status='success'` payments row with `amount_paise = outstanding net`; partial-wallet pay-after collects only the remainder.
6. Pro payloads never contain `start_otp`/`end_otp` (assert at the API layer).
7. Migration backfills active bookings; a backfilled booking verifies START/END correctly end-to-end.
8. Cash path: `/collect-cash` → END OTP appears → pro `/complete {otp}` → `completed`.

### Verification gates
- Static: `go build ./...`, `go vet ./...`, `go test ./...` (booking + payments packages), `tsc --noEmit` (app).
- Live rail matrix (HTTP layer, not just DB units — per the split `already_paid` lesson): paid-upfront complete, unpaid complete (expect 409), pay-online-then-complete, collect-cash-then-complete.
- iOS-sim UI smoke: customer START/END cards + nudge swap; pro start/finish/collect-cash sheets.
