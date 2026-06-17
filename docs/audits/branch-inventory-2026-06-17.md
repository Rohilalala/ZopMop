# ZopMop Branch Inventory Report
*All branches compared against `develop` (tip 2026-06-17). 17 branches analyzed.*

---

## 1. TL;DR Table

| Branch | Purpose (short) | Status | Recommendation |
|---|---|---|---|
| `feature/pro-app-two-otp-flow` | Full Phase 1 two-OTP payment-gated flow + customer/pro UI | gap-missing-from-develop | **needs-review** |
| `origin/fix/phase1-isolated-audit` | Phase 1 Step 3 cash-resolve + CRM settlement + dev harness | gap-missing-from-develop | **needs-review** |
| `origin/feature/website-redesign` | New marketing landing page (GSAP/Three.js, Zop mascot) | gap-missing-from-develop | **merge** |
| `origin/backup/develop` | Claude agents/hooks/configs WIP backup | gap-missing-from-develop | cherry-pick-parts |
| `origin/feature/pro-polish` | Pro screen polish + helper stats API + components | partially-in-develop | cherry-pick-parts |
| `origin/audit/phase1-business-rules` | Phase 1 business-rules audit + backend lineage | gap-missing-from-develop | cherry-pick-parts |
| `origin/feature/otp-namespace-separation` | Redis namespace-separated OTPs | partially-in-develop | discard |
| `origin/audit/phase1` | Read-only Phase 1 audit (Do NOT merge) | gap-missing-from-develop | discard |
| `origin/audit/phase1-security` | Read-only Phase 1 security audit | gap-missing-from-develop | discard |
| `origin/audit/phase1-money-flow` | Read-only Phase 1 money-flow audit | partially-in-develop | discard |
| `origin/backup/fix-phase1-isolated-audit` | Phase 1 Redis-OTP backup snapshot | gap-missing-from-develop | discard |
| `origin/fix/auth-restore-token-refs` | Sync token-ref priming for /me probe | already-in-develop | discard |
| `feature/referral-150` | Referrer reward Rs 200→150 + incoming state | already-in-develop | discard |
| `origin/feature/eslint-config` | Expo flat ESLint config | already-in-develop | discard |
| `origin/feature/cashfree-pin` | Pin Cashfree API to 2023-08-01 | already-in-develop | discard |
| `origin/feature/cart-variants` | Variant cart pricing + 12 migrations | already-in-develop | discard |

---

## 2. Gaps develop is missing (actionable, most valuable first)

### 2.1 `origin/feature/website-redesign` — **MERGE (highest-value, lowest-risk)**
The entire branded marketing landing page (377 HTML / 873 CSS / 700 JS LOC): preloader, Three.js hero bubble field, masked line reveals, service slabs, Zop mascot (11 expressions), Lenis smooth scroll, with no-JS fallbacks and `prefers-reduced-motion` support. Develop only has `.well-known/` config files.
- **Why safe:** all changes are new files in `website/`; no app-code overlap; no conflicts.
- **Action:** Merge as-is. **Decision point for you:** the branch lands with a revert (`259e6b0`) that undoes the newer `zopnew` face kit (`5614ef2`). If you want the newer faces, squash/drop the revert first; otherwise merge as-is.

### 2.2 Phase 1 Step 3 — customer cash-resolution + CRM settlement (genuinely NOT in develop)
This is the **one real backend gap** across the whole Phase 1 cluster, and it shows up consistently in three branches. Develop has the OTP *gates* (DB-stored OTPs, migration 144) but lacks the **customer-choice cash resolve + settlement attribution** layer. Best source branches:

- **`origin/fix/phase1-isolated-audit` (needs-review)** — cleanest carrier of the Step 3 backend: `ResolveCash` handler, `internal/crm/cash/cash.go` (owes-per-pro + settlement), `dev_seed.go`, `self_heal.go`, chargeability guards, cancel-truth-table tests.
- **`feature/pro-app-two-otp-flow` (needs-review)** — additionally carries the **customer-facing UI** missing everywhere else: `EndOfServicePaymentScreen` (~890 LOC), `ActiveBookingPill`, `OTPInput`, `EndCodeCard`, pro `JobDetailScreen` state machine + `JobStuckScreen`, and Cashfree drop-in at service-end.
- **`origin/audit/phase1-business-rules` (cherry-pick-parts)** — same backend lineage; its audit doc is the spec reference, not a merge target.

**⚠ CRITICAL — needs your eyes (architectural conflict):** develop stores OTPs in the DB (`bookings.start_otp/end_otp`, migration 144, CSPRNG). Every Phase 1 branch stores them in **Redis** (`internal/otp` package, `otp:{scope}:{ownerID}`) with migrations **112/113**. These are **incompatible implementations of the same feature.** Do **not** merge any Phase 1 branch wholesale.

**Recommended action (sequenced):**
1. Decide the production OTP storage target — develop's DB model is already live/tested as of 2026-06-17 and has fresh bug fixes (`331df7a`, `b84ad59`). Likely keep DB model.
2. **Cherry-pick + adapt** only the *missing* pieces onto develop's DB model: `ResolveCash`, `internal/crm/cash`, cash-attribution columns (rebuild as a fresh migration ≥145 — do **not** reuse 112/113; they collide semantically with develop's catalog migrations), customer payment UI from `feature/pro-app-two-otp-flow`, and the chargeability guard.
3. Drop the Redis `internal/otp` package, `self_heal.go` (develop's single-tx gate replaces it), and the Redis-specific tests.

**⚠ Also flag (security):** `audit/phase1-business-rules` notes a customer-only OTP-code gating fix (`5ded4cb`) that lives **only** on `feature/pro-app-two-otp-flow`'s lineage. Without it, `GetTracking` could leak OTP codes to the pro. If you port any Phase 1 backend work, confirm this gating is present on develop.

### 2.3 `origin/feature/pro-polish` — **CHERRY-PICK-PARTS**
Wanted: helper stats API (`getHelperStats` in `api/pro.ts`), `OfflineBanner`, `SvgIcon` + 11 SVG assets, refactored polling/pacing constants (`INVITE_POLL_MS`, `LOCATION_PUSH_MS`), `mountedRef` patterns across 8 pro screens.
**⚠ Do NOT merge whole:** the single commit (`16dbb76`) also **deletes 22+ migration files** and **regresses referral** (drops `IncomingReferral`, reverts `ReferrerCreditPaise` 15000→20000) — directly undoing what develop currently has. Cherry-pick only the UI/API/component additions; reject the migration and referral deletions.

### 2.4 `origin/backup/develop` — **CHERRY-PICK-PARTS (tooling, separate scope)**
Additive `.claude/` tooling: 5 review agents, 6 hook scripts (block-secrets, block-eas-prod, go-fmt-vet, js-lint, migration-name, sql-lint), enhanced `settings.json`, `.golangci.yml`, project CLAUDE.md docs, market-opportunity doc. Non-breaking, no app code. Cherry-pick the agents/hooks/configs if you want them; low risk. (See also §4.)

---

## 3. Already in develop / obsolete — safe to delete

| Branch | Why safe to delete |
|---|---|
| `feature/referral-150` | Identical changes already merged via `648526b`; branch is 335 commits behind develop. Files verified identical. |
| `origin/feature/eslint-config` | Byte-for-byte re-implemented on develop as `0958e60` (same `eslint.config.js` md5, same deps). |
| `origin/feature/cashfree-pin` | Single commit `f2afedf` already merged as `2be4fa2` with identical content. |
| `origin/feature/cart-variants` | All 12 migrations (084–095) + backend/frontend present in develop via `6f6255f`, with refinements. |
| `origin/fix/auth-restore-token-refs` | Core fix in develop, which has the **better** hardened version (403/404 handling, token rotation, no role-demotion). Superseded. |
| `origin/feature/otp-namespace-separation` | develop has a more mature DB-backed OTP approach. Redis namespacing not needed; reconciling two architectures isn't worth it. |
| `origin/backup/fix-phase1-isolated-audit` | Redis-OTP Phase 1 snapshot superseded by develop's DB-centric impl. **Note:** its useful *Step 3 cash* delta is better sourced from `fix/phase1-isolated-audit` (§2.2). |

**Audit branches (read-only, "Do NOT merge" by their own docs) — discard the branches, optionally preserve docs:**
- `origin/audit/phase1`, `origin/audit/phase1-security`, `origin/audit/phase1-money-flow` — historical snapshots; the bugs they flagged (double-charge M-001/S-001, missing-stamp M-002, per-booking lockout) are **already fixed on develop** (`331df7a`, `b84ad59`). If you want the audit reports for records, cherry-pick just the doc commit; otherwise delete.

---

## 4. Separate scope / backups — note & leave

- **`origin/backup/develop`** — WIP tooling backup, not feature code. Don't delete blindly (it's the only home for the `.claude` agents/hooks). Either cherry-pick the tooling (§2.3-adjacent) or leave parked. Listed here because it's a backup, but it does contain genuinely-missing, low-risk tooling.
- **`origin/backup/fix-phase1-isolated-audit`** — pure backup snapshot of the Redis Phase 1 line; leave parked until the Phase 1 storage decision (§2.2) is final, then delete.
- **Audit branches** (`audit/phase1*`) — reference artifacts, not branches to integrate. Keep only if you want the audit history; otherwise safe to remove once §2.2 is resolved.

---

## 5. Suggested next actions (ordered)

1. **Merge `feature/website-redesign`** — highest value, zero conflict. First decide: keep the reverted face kit or squash the revert for the newer `zopnew` faces.
2. **Make the Phase 1 OTP storage decision** (DB vs Redis). Recommendation: keep develop's DB model — it's live, tested, and already has the double-charge/lockout fixes. This decision unblocks everything else in the Phase 1 cluster.
3. **Once decided, port Step 3 onto develop's DB model:** cherry-pick + adapt `ResolveCash` + `internal/crm/cash` + cash-attribution columns (as a **fresh migration ≥145**, not 112/113) from `fix/phase1-isolated-audit`, plus the customer payment UI (`EndOfServicePaymentScreen`, `ActiveBookingPill`, `OTPInput`) from `feature/pro-app-two-otp-flow`.
4. **Before/while porting, verify the OTP-leak fix (`5ded4cb`) is on develop** — if not, port it. This is a security gate, not optional.
5. **Cherry-pick pro-polish UI** (`getHelperStats`, `OfflineBanner`, `SvgIcon` + icons, pacing constants) — explicitly excluding its migration deletions and referral regression.
6. **(Optional) Cherry-pick `backup/develop` .claude tooling** (agents + hooks) if you want the lint/secret/migration guardrails.
7. **Delete obsolete branches:** `feature/referral-150`, `feature/eslint-config`, `feature/cashfree-pin`, `feature/cart-variants`, `fix/auth-restore-token-refs`, `feature/otp-namespace-separation`.
8. **After §3–4 resolved, delete the audit/backup branches** (`audit/phase1`, `audit/phase1-security`, `audit/phase1-money-flow`, `audit/phase1-business-rules`, `backup/fix-phase1-isolated-audit`) — cherry-pick any audit docs you want to keep first.

### Items flagged for your eyes (uncertain / decision-required)
- **OTP storage architecture (DB vs Redis):** the single biggest unknown; blocks the whole Phase 1 cluster. The five audit/feature branches all assume Redis; develop chose DB. I'm recommending DB, but this is your call.
- **OTP-code leak fix `5ded4cb`:** confirm it's on develop before merging any Phase 1 backend; otherwise pros can see OTP codes via `GetTracking`.
- **Website face kit:** branch ships with the revert applied (older faces). Confirm which face set should go to production.
- **`fix/phase1-isolated-audit` vs `feature/pro-app-two-otp-flow` overlap:** both carry Step 3; I've split backend→`fix/phase1-isolated-audit`, UI→`feature/pro-app-two-otp-flow`. Confirm you don't want a single reconciled branch instead.
- **Migration numbering:** branches use 112/113 which already exist on develop as catalog migrations. Any ported schema must use ≥145. Do not reuse 112/113.