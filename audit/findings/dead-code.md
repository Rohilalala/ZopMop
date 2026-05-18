# Subagent 9 — Dead Code & Cleanup

Audit run: 2026-05-15. Branch: `feature/referral-flow-fixes`.

## Summary

- TODO/FIXME comments: **13** total (3 mobile, 10 backend)
- Unused TS locals/imports (TS6133 with `--noUnusedLocals --noUnusedParameters`): **35** across 27 files
- Unused theme tokens: **4** (`primaryLight`, `accentLight`, `info`, `infoBg`)
- Commented-out import: **1** (MainNavigator.tsx:20)
- Unused npm dependencies (no runtime references found): **6** candidates flagged for verification
- `go vet ./...` on backend: **clean** (no warnings)
- Backup files in source tree (`.bak/.old/.orig`): **0** outside `ios/Pods/` (third-party, ignore)
- Lottie animations referenced: **7/7** — all used
- SVG icons referenced: **14/14** — all wired through `SvgIcon.tsx` ICONS map (one entry, `coins`, is on the "gig-worker remnant" surface — see finding D-7)
- Gig-worker UI in `screens/pro/`: greps for `earnings|payout|cash-?out|withdraw` returned **0** matches, BUT `ProDashboardScreen.tsx:439` displays a paise-denominated "Earned" stat (see finding D-7)

Severity skew: mostly Low/Nit. Two Medium findings: unused npm deps that bloat binary (D-3) and the lingering earnings stat tile (D-7) which contradicts the "purge gig-worker UI" memory.

---

## Findings

### D-1 — 35 unused TypeScript locals/imports

[SEVERITY: Low]
[FILE: App/zopmop-app/src/... (27 files — see evidence)]
[CATEGORY: Dead Code / Unused symbols]
Finding: Running `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` reports 35 TS6133 errors. None are caught today because `tsconfig.json` only sets `"strict": true` without enabling the two unused flags.
Impact: Cosmetic; modest bundle bloat from unused imports (icons/utils tree-shake fine but typed components do not). Catches stale refactors.
Fix: Add `"noUnusedLocals": true` and `"noUnusedParameters": true` to `App/zopmop-app/tsconfig.json` and clean up. Alternatively, configure ESLint `@typescript-eslint/no-unused-vars` in `eslint.config.js`.
Evidence (representative — full list in tsc output):
- src/components/FloatingCartButton.tsx:2 — `View` imported, never used
- src/components/FloatingCartButton.tsx:7 — `FontSize` imported, never used
- src/components/home/BottomTabBar.tsx:14 — `Text` imported, never used
- src/components/home/GreetingHeroCard.tsx:2 — `Text` imported, never used
- src/components/home/GreetingHeroCard.tsx:55 — destructured `active` never read
- src/components/home/HomeCartBar.tsx:1 — `useCallback` imported, never used
- src/components/home/HomeCartBar.tsx:17 — `fontBold` declared, never used
- src/components/home/HomeFooter.tsx:88 — `TrustStrip` declared, never used (likely dead component)
- src/components/home/HomeHeader.tsx:12 — `fontSemi` declared, never used
- src/components/LocationSelectorModal.tsx:47 — `fontExtra` declared, never used
- src/components/OfflineBanner.tsx:8 — `c` (color) destructured, never used
- src/components/SkeletonBox.tsx:11 — `C` constant, never used
- src/components/skeletons/HomeScreenSkeleton.tsx:6 — `TILE` constant, never used
- src/components/ui/Input.tsx:31 — destructured `focused` never read
- src/components/ZopQuickReplies.tsx:2 — `View` imported, never used
- src/components/ZopQuickReplies.tsx:4 — `AMBER` constant, never used
- src/screens/booking/InstantMatchingScreen.tsx:14 — `useRoute` imported, never used
- src/screens/booking/InstantMatchingScreen.tsx:31 — `W` constant, never used
- src/screens/main/AddressesScreen.tsx:31 — `fontSemi` declared, never used
- src/screens/main/AllServicesScreen.tsx:18 — `Alert` imported, never used
- src/screens/main/BookingConfirmedScreen.tsx:1111 — `ReferNudge` declared, never used (likely dead component)
- src/screens/main/ChatScreen.tsx:7 — `useMemo` imported, never used
- src/screens/main/ChatScreen.tsx:33 — `fontBold` declared, never used
- src/screens/main/HomeScreen.tsx:30 — `Alert` imported, never used
- src/screens/main/HomeScreen.tsx:36 — `View` imported, never used
- src/screens/main/ProfileScreen.tsx:508 — `ReferralTicket` declared, never used (likely dead component)
- src/screens/main/TipScreen.tsx:7 — `Alert` imported, never used
- src/screens/main/TrackLiveScreen.tsx:51 — `SCREEN_W` constant, never used
- src/screens/main/TrackLiveScreen.tsx:60 — `AMBER_LIGHT` constant, never used
- src/screens/main/WalletTopupSheet.tsx:32 — `fontBold` declared, never used
- src/screens/pro/ProDashboardScreen.tsx:22 — `Spacing` imported, never used
- src/screens/pro/ProOnboardingScreen.tsx:10 — `Alert` imported, never used
- src/screens/pro/ProOnboardingScreen.tsx:56 — destructured `phone` never read
- src/screens/pro/ProOnboardingScreen.tsx:57 — destructured `navigation` never read
- src/sdui/sections/ServiceGridSection.tsx:39 — `CARD_W` constant, never used

Three of these are likely deletable inline components (`TrustStrip`, `ReferNudge`, `ReferralTicket`) — verify they are not referenced indirectly before removing.

---

### D-2 — Commented-out import in navigator

[SEVERITY: Nit]
[FILE: App/zopmop-app/src/navigation/MainNavigator.tsx:20]
[CATEGORY: Dead Code / Commented-out code]
Finding: `// import ActiveBookingScreen from '../screens/booking/ActiveBookingScreen';` — a single dangling commented import. Only commented-out code line found across mobile `src/`.
Impact: Low; minor noise.
Fix: Delete the line. If routing reverts to that import later, recover from git.
Evidence: line 20.

---

### D-3 — Six npm dependencies declared but not imported anywhere

[SEVERITY: Medium]
[FILE: App/zopmop-app/package.json]
[CATEGORY: Dead Code / Unused dependencies]
Finding: The following declared deps have **zero** `from '<pkg>'` / `require('<pkg>')` references anywhere in `src/`, `App.tsx`, `index.ts`, `app.json`, `app.config.*`, `babel.config.js`, `metro.config.js`, or any other tracked TS/JS/JSON file outside `node_modules` and `package-lock.json`:
- `expo-device`
- `expo-file-system`
- `expo-localization`
- `expo-status-bar` (RN's own `StatusBar` is used in `BackendDownScreen.tsx`, `HiZopScreen.tsx`, etc.)
- `expo-updates` (no `Updates.` calls found)
- `expo-dev-client`

Impact: Adds to install time and (for native ones) to binary size. `expo-updates` in particular bundles a native module that runs at boot.
Fix: Run `npx expo install --check` then remove dead entries. Some may be transitively required by `expo` (e.g. `expo-dev-client` for dev builds, `expo-updates` if EAS Update is intended). **Do not delete blind** — verify with EAS/Expo config:
- `expo-dev-client`: kept if you build dev clients (`eas build --profile development`). Confirm.
- `expo-updates`: only needed if OTA is enabled (`updates.url` in `app.json`). Spot-check `app.json`.
- `expo-status-bar`: replace remaining RN `StatusBar` usages with `expo-status-bar` OR drop the package.
- `expo-localization`: drop unless I18n is planned.
- `expo-device`, `expo-file-system`: drop or wire up.
Evidence: see `grep -rln "<pkg>"` against the entire repo (only `package.json` + `package-lock.json` hits).

---

### D-4 — Four defined theme color tokens never referenced

[SEVERITY: Low]
[FILE: App/zopmop-app/src/theme/colors.ts:3,6,24,25]
[CATEGORY: Dead Code / Dead design tokens]
Finding: `primaryLight`, `accentLight`, `info`, `infoBg` are defined in both `lightColors` and `darkColors` but no consumer references `c.<token>`, `colors.<token>`, or `Colors.<token>` anywhere in `src/`.
Impact: Cosmetic.
Fix: Either remove them or wire them into the existing info/banner UI (e.g. `OfflineBanner.tsx`, `BackendDownScreen.tsx`) which currently fall back to ad-hoc hex.
Evidence:
- `grep -rn "c\.primaryLight\|Colors\.primaryLight"` → 0
- `grep -rn "c\.accentLight\|Colors\.accentLight"` → 0
- `grep -rn "c\.info\b\|Colors\.info\b"` → 0
- `grep -rn "c\.infoBg\|Colors\.infoBg"` → 0

---

### D-5 — 13 TODO / FIXME / HACK / XXX comments

[SEVERITY: Nit]
[FILE: multiple — see evidence]
[CATEGORY: Dead Code / Outstanding TODOs]
Finding: Inventoried via `grep -rn -E "TODO|FIXME|HACK|XXX"` across `App/zopmop-app/src/`, `App/househelp-api/internal/`, `cmd/`, `pkg/`.

Mobile (3):
- src/screens/auth/NotServiceableScreen.tsx:69 — `TODO(post-expansion): replace with ...`
- src/screens/main/BookingConfirmedScreen.tsx:952 — `TODO(backend): derive copy from booking.scheduled_at (e.g. "Matching ...")`
- src/sdui/allowlist.ts:11 — `TODO (follow-up): jest test asserting this Set matches the navigator's ...`

Backend (10):
- internal/auth/repository.go:204 — `TODO: gate helper-only routes on approval_status='approved' once the admin ...` (security-adjacent; track)
- internal/crm/banners/banners.go:4 — `(Adding S3 presign here is a future TODO.)`
- internal/roomies/service.go:363 — `On force=true: prepaid balances are zeroed (TODO: credit to main wallet) and group deleted.`
- internal/roomies/service.go:401 — `Wallet credit handled by pending_refunds settlement worker (TODO: build settlement worker).`
- internal/roomies/repository.go:119 — `TODO: credit zeroed prepaid_balance to each member's main wallet (main wallet not yet built).`
- internal/roomies/repository.go:140 — `TODO: before zeroing, read balances and enqueue credits to main wallet per user.`
- internal/roomies/model.go:170 — `On force=true, balances are credited back (TODO: main wallet) and group is deleted.`
- pkg/config/config_test.go:21 — `"uppercase variant", "CHANGE-THIS-TO-A-RANDOM-64-CHAR-STRING-IN-PRODUCTION-XXXXXXXXXXXX"` (the `XXXXXXXXXXXX` is part of the placeholder, not a marker — false positive but worth noting)
- pkg/config/config.go:280 — `"change-this-to-a-random-64-char-string-in-production-XXXXXXXXXXXX"` (same — false positive marker)

Impact: Tracks unfinished work. Roomies → main-wallet plumbing is a real money-handling debt: settlements are silently dropped when `force=true`.
Fix:
- Decide on roomies wallet credit path before launching the roomies group billing feature.
- The auth approval_status gating TODO is a security item — escalate via Subagent 1's auth review (or open a backlog ticket).
- Drop the `XXXXXXXXXXXX` lines from "TODO list" framing — they are placeholder string literals, not real markers.

Evidence: see `grep -rn -E "TODO|FIXME|HACK|XXX" App/zopmop-app/src App/househelp-api/internal App/househelp-api/cmd App/househelp-api/pkg`.

---

### D-6 — `go vet ./...` is clean (positive note)

[SEVERITY: Nit]
[FILE: App/househelp-api/]
[CATEGORY: Dead Code / Static analysis]
Finding: `go vet ./...` runs clean against the entire backend. No unused-result, shadowed-variable, or composite-literal warnings.
Impact: None — positive note.
Fix: N/A. Recommend wiring `staticcheck` into `make preflight` to catch what `vet` misses (unused functions, unused params, ineffectual assignments).
Evidence: command produced empty output.

---

### D-7 — "Earned" stat tile on Pro Dashboard contradicts gig-worker UI purge

[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx:439]
[CATEGORY: Dead Code / Stale UX]
Finding: User memory note `project_pro_audit_2026_05_12.md` and `project_design_conventions.md` flag historical gig-worker UI (earnings dashboards, payout screens) as something to be purged. A targeted grep for `earnings|payout|cash-?out|withdraw` in `screens/pro/` returns zero matches BUT `ProDashboardScreen.tsx:439` still renders:
```
<StatCard iconName="coins" label="Earned" value={stats ? `₹${Math.round(stats.total_earned_paise / 100)}` : '₹—'} />
```
The `coins` SVG icon (`assets/icons/coins.svg`) and the `total_earned_paise` field on the pro stats payload exist solely to feed this tile. If pros are W-2-equivalent (salaried), this tile is misleading and should be removed; if they remain commission-based, the design conventions note is stale.
Impact: Conflicting product direction; the visible "Earned ₹X" widget tells pros they are gig workers, contrary to the design conventions document.
Fix: Decide (product call). If purging:
- Remove the StatCard at ProDashboardScreen.tsx:439.
- Drop the `coins` registration from `SvgIcon.tsx:14,30` and delete `assets/icons/coins.svg`.
- Strip `total_earned_paise` from the pro stats response (backend `internal/helper` or `internal/users` — verify).
If keeping: update `project_design_conventions.md` to reflect that earnings are still surfaced.
Evidence: grep + memory notes referenced above.

---

### D-8 — Roomies module has 5 separate references to a non-existent "main wallet"

[SEVERITY: Low]
[FILE: App/househelp-api/internal/roomies/{service.go,repository.go,model.go}]
[CATEGORY: Dead Code / Aspirational hooks]
Finding: Five TODOs in `roomies/` all reference a "main wallet" that "is not yet built" — see D-5 line numbers. The roomies group-billing flow silently drops prepaid balances when groups are force-deleted.
Impact: Hidden money-loss path. Not dead code per se but dead end of a feature.
Fix: Either build the main-wallet credit path before exposing force-delete, or block force-delete via repo policy until the worker exists.
Evidence: file lines listed in D-5.

---

### D-9 — No `staticcheck` baseline; unable to verify "no unused exported funcs"

[SEVERITY: Nit]
[FILE: App/househelp-api/]
[CATEGORY: Dead Code / Tooling gap]
Finding: Repo does not wire `staticcheck` (or `golangci-lint`). Subagent scope asked for "staticcheck candidates" — without it installed in `make preflight`, the analysis is shallow.
Impact: Possible unused exported funcs and ineffectual assignments slip through `go vet`.
Fix: Add `staticcheck` to `make preflight` or to a CI step. One-shot run today (outside the audit, by user): `go install honnef.co/go/tools/cmd/staticcheck@latest && staticcheck ./...`.
Evidence: `go vet` clean; no `staticcheck` config or invocation found.

---

### D-10 — Lottie animations and SVG icons inventory check (positive)

[SEVERITY: Nit]
[FILE: App/zopmop-app/assets/]
[CATEGORY: Dead Code / Asset audit]
Finding: All 7 `.lottie` files in `assets/animation/` are referenced by name. All 14 `.svg` files in `assets/icons/` are imported by `SvgIcon.tsx`. No orphan assets.
Impact: None — positive note. (The user-memory note about 14 placeholder SVGs needing a 3D-icon revamp is unrelated to dead code.)
Fix: N/A.
Evidence:
- `grep -rn "\.lottie"` → 8 source-file hits covering all 7 names.
- 14/14 SVG filenames appear in `src/components/SvgIcon.tsx` ICONS map (lines 4-17 and 19-34).

---

### D-11 — Hardcoded PostHog feature-flag boot config (not a flag toggle)

[SEVERITY: Nit]
[FILE: App/zopmop-app/src/config/posthog.ts:33-35]
[CATEGORY: Dead Code / False positive on "hardcoded flags"]
Finding: Audit scope asked about permanently-on/off feature flags. The only matches in `src/config/` are `preloadFeatureFlags: true`, `sendFeatureFlagEvent: true`, `featureFlagsRequestTimeoutMs: 10000` — these are PostHog client init flags, not product feature flags.
Impact: None — these are correct SDK configuration.
Fix: N/A; documented to close the audit item.
Evidence: file content.

---

## QUESTIONS FOR ADITYA

1. **Earnings stat tile on Pro Dashboard (D-7):** Are pros still commission-based (keep the tile) or salaried (remove tile + `total_earned_paise` field + `coins` icon)? The design conventions doc and the live UI disagree.
2. **Roomies main-wallet path (D-8):** Is the "main wallet" still planned? If yes, what's the ETA? If no, the roomies `force=true` flow needs a different settlement strategy.
3. **Expo OTA / dev client deps (D-3):** Do you intend to ship `expo-updates` (EAS Update OTA)? If not, removing it shrinks the binary. `expo-dev-client` similarly — only needed if you build dev clients.
4. **TS strict-unused enforcement (D-1):** Want to flip `noUnusedLocals`/`noUnusedParameters` on now (35 fixes) or defer until a dedicated cleanup PR?

---
