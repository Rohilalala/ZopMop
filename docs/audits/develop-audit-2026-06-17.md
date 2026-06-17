# ZopMop `develop` — Audit Verdict

## 1. Health Verdict

**develop is shippable to staging but NOT pilot-clean: one confirmed money-loss launch blocker (pro mid-service cancel leaks customer prepayment) plus a cluster of promo-vs-gross money/coherence bugs in the cart all sit on the customer money path.** Auth, OTP, webhook, JWT, and wallet-floor invariants are solid (verified clean). Fix the cancel-refund gap and the CartScreen gross/net mismatches before pilot.

---

## 2. Confirmed Critical / High Issues (by domain)

### Money — Refunds (LAUNCH BLOCKER)
- **Pro mid-service cancel silently loses customer money** — `App/househelp-api/internal/shift/service.go:387-457` (`CancelBooking` → `MarkBookingCancelled`). Sets status `cancelled` but never creates a `pending_refunds` row; `payment_status` stays `paid` forever for prepaid (Cashfree) bookings. **Fix:** route pro-cancel through the existing refund path (`CancelBookingWithFee` in booking service) so a refund/`pending_refunds` row is created. This is audit LB-1.

### Money — Cart / Checkout (RN customer)
All four are the same root cause: the UI computes the displayed share from `netCents` (after promo) but sends/checks `totalCents` (gross). Backend correctly uses net, so it's a cross-layer contract mismatch.
- **Roomies split records gross, not net** — `App/zopmop-app/src/screens/main/CartScreen.tsx:387` sends `total_amount: totalCents`. **Fix:** send `netCents`.
- **Wallet split-apply computed from gross** — `CartScreen.tsx:316` `Math.min(walletBalance, totalCents)`. **Fix:** clamp against `netCents` (backend caps to net at `service.go:331`, so no overcharge today, but the sent value and the PaymentPicker display are wrong).
- **Wallet-full balance check against gross** — `CartScreen.tsx:323` `walletBalance < totalCents` wrongly rejects a customer who has exactly the discounted amount. **Fix:** compare against `netCents`.

> Note: the refund-notification finding at `refunds.go:892` (divides paise by 100 → notifies 1/100th of refund) was bundled into the assigner-cron entry's `why` but is a **distinct, real money/coherence bug** worth its own ticket. **Fix:** stop dividing by 100 (column `amount_cents` actually stores paise). Severity: med.

---

## 3. Med Issues Worth Fixing

- **Split summary display is arithmetically inconsistent under promo** — `CartScreen.tsx:646` shows "Total order" = `totalCents` while line 657 "Your share" = `myShareCents` (from `netCents`); `total / count ≠ share`. **Fix:** display `netCents` at line 646, or add a discount line in the split summary (mirror lines 783-794). (rn-customer / coherence)
- **AssignerCron.Start() race** — `App/househelp-api/internal/matching/assigner_cron.go:61-62` the `if c.cancel != nil { return }` guard is unsynchronized; concurrent `Start()` calls can spawn duplicate tick loops → double dispatch. **Fix:** wrap the guard + assignment in a mutex (or `sync.Once`). (matching-dispatch / correctness)
- **Refund notify amount /100** — `App/househelp-api/internal/crm/refunds/refunds.go:892` (see note above). (money)
- **Maps API key in working-tree `.env`** — `App/zopmop-crm/.env:2` plaintext `AIzaSy...`. Gitignored (not tracked), so git exposure is mitigated, but it's a domain-restricted public key sitting on disk. **Fix:** move to secret manager / restrict by HTTP referrer + API; confirm no history leak (the open "Maps key history scrub" blocker). (security)

---

## 4. Low / Nits

- `booking/service.go:573` `recordPaymentIntent(... amountCents int)` — param is paise, not cents; rename `amountPaise`. Naming only.
- `booking/service.go:567` `CollectCash` returns 0 but JSON field is `outstanding_paise` (`jobs.go:273`); frontend ignores it. Misleading contract, no bug.
- Pervasive `*Cents` naming for paise values across cart + booking layers — cosmetic but invites exactly the gross/net class of bug above; worth a sweep.

---

## 5. Checked & Found CLEAN (coverage)

Verified as correctly implemented — do not re-flag:

- **OTP dev-mode prod guard** — `auth/service.go:440` `shouldEchoDevOTP()` requires DevMode AND `!isProduction`; `999999` cannot leak in prod (C10/LB-1 defense-in-depth holds).
- **Per-booking OTP lockout** — `booking/service.go:2196` caps at `maxOTPAttempts=10` before accepting any code; brute-force of 4-digit space blocked.
- **Payment-gated completion** — `booking/service.go:2490` rejects END OTP unless `payment_status == "paid"`; cannot complete without paying even with a correct OTP.
- **Live suspension check** — `middleware/auth.go:132-149` reads `is_suspended` per request, fails CLOSED (503); closes the JWT-staleness gap (A5-06).
- **Wallet floor** — `wallet/repository.go:173` rejects `newBalance < 0` before write + SQL `CHECK (balance_paise >= 0)` (migration 067). Dual enforcement, no negative-balance leak.
- **Backend split/wallet math uses net** — `booking/service.go:331` `applied = min64(bal, netPaise)`; this is why the cart frontend bugs cause no actual overcharge (display/contract only).
- **Cashfree webhook** — `payments/cashfree.go:415` HMAC via `hmac.Equal` (constant-time) + 300s replay window. No spoof/replay/timing hole.
- **Webhook SSRF** — `webhooks/ssrf.go:56` resolves DNS and rejects RFC1918 / 169.254/16 (IMDS) / loopback + domain allowlist.
- **JWT alg pinning** — `middleware/jwt.go:25,53` HS256-only via `WithValidMethods` + explicit non-HMAC rejection. No alg-substitution / `none` attack.
- **Refresh token rotation** — `auth/refresh_repo.go:80` checks revoked + expired; `service.go:554` atomically revokes-old-and-inserts-new in one tx. No stale-token reuse.
- **Wallet top-up bounds** — `payments/handler.go:473-480` clamps ₹1–₹5,000.

---

## 6. Prioritized Fix Order

1. **`shift/service.go:387-457`** — pro mid-service cancel must trigger refund / `pending_refunds`. **(LB-1, money loss, pilot blocker.)**
2. **`CartScreen.tsx:387`** — roomies split: send `netCents` (ledger records correct split). **(high, money/accounting.)**
3. **`CartScreen.tsx:323`** — wallet-full check against `netCents` (stop rejecting valid payments). **(high, money.)**
4. **`CartScreen.tsx:316`** — wallet-split apply from `netCents` (correct value + PaymentPicker display). **(high, money/UX.)**
5. **`CartScreen.tsx:646`** — display `netCents`/discount line in split summary. **(med, coherence.)**
6. **`refunds.go:892`** — remove `/100`; notify true refund amount. **(med, money/coherence.)**
7. **`assigner_cron.go:61-62`** — mutex the Start() guard. **(med, double-dispatch under concurrent Start.)**
8. **`zopmop-crm/.env:2`** — rotate/restrict Maps key + confirm history scrub. **(med, security hygiene.)**
9. Naming sweep: `*Cents`→`*Paise` in cart/booking; `recordPaymentIntent`, `CollectCash`/`outstanding_paise`. **(low.)**

**Uncertainty flags:** Items 1-8 above are read-confirmed (I independently re-verified the CartScreen gross/net lines 176-180, 316, 323, 387 in this session). The `refunds.go:892` fix assumes the `amount_cents` column stores paise everywhere — confirm that one column-name convention before patching the divisor, since fixing display without checking storage could itself introduce a 100x error. The assigner-cron race assumes `Start()` is reachable concurrently; if it's only ever called once at boot, downgrade to low.