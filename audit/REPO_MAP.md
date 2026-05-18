# ZopMop — Repository Map (audit baseline)

Generated 2026-05-15 as the shared context for the comprehensive audit. Every
subagent must read this before starting. Cite file:line in findings.

## High-level architecture

- **Customer mobile app** (React Native + Expo SDK 54, RN 0.81.5, new arch
  enabled): `App/zopmop-app/`
- **Pro app**: same React Native binary as the customer app. Pro screens live
  under `App/zopmop-app/src/screens/pro/`. Auth/role flag determines which
  navigation graph is shown. No separate native binary.
- **Backend** (Go 1.25/1.26, Fiber v2): `App/househelp-api/`
- **Admin / CRM web app** (Vite + TS + Tailwind): `App/zopmop-crm/`
- **Marketing website (live)**: `website/` (static HTML, deployed via cPanel to
  zopmop.com). Two universal-link manifests served from there:
  `.well-known/apple-app-site-association` + `.well-known/assetlinks.json`.
- **Next.js marketing rebuild** (in progress, gitignored): `web/`
- **Repo top-level docs / audits**: `AUDIT_2025_2026-05-03.md`,
  `security_audit_report.md`, `PROGRESS.md`, `.audit/FINAL_REPORT.md` (prior
  audits — cross-reference, don't redo findings already documented there).

## Customer + pro mobile app (`App/zopmop-app/`)

- Entrypoint: `index.ts` → `App.tsx`
- Source root: `src/`
  - `screens/auth/` — onboarding, OTP, splash, intro
  - `screens/main/` — customer-side (home, cart, referral, etc.)
  - `screens/booking/` — active booking, history, rating
  - `screens/pro/` — pro dashboard, active, matched, leave, onboarding, profile
  - `screens/BackendDownScreen.tsx` — global offline / unreachable
- `api/` — typed clients per backend module
- `sdui/` — server-driven UI section renderers (home is partially SDUI)
- `context/` — Auth, Cart, Prefetch (geo + addresses), etc.
- `navigation/` — RN-Nav v7 native-stack + bottom-tabs
- `components/`, `theme/`, `utils/`, `hooks/`, `analytics/`,
  `services/` (push tokens etc.), `constants/`, `types/`, `config/`
- `assets/` — fonts, icons (SVGs), animations (Lottie `.lottie` archives)

### Mobile dependencies (selected highlights from `package.json`)
- React 19.1.0, RN 0.81.5, Expo SDK ~54.0
- New arch enabled in `app.json` (`newArchEnabled: true`)
- Auth: `@react-native-firebase/auth` 24
- Push: `@react-native-firebase/messaging` 24
- Payments: `react-native-cashfree-pg-sdk` 2.3.2 (patched via patch-package),
  `cashfree-pg-api-contract` 2.1.1
- Maps: `react-native-maps` 1.27.2 (Google provider)
- Analytics: `posthog-react-native` 4.45 (PostHog SDK — declared in
  `src/config/posthog.ts` per the wizard report; needs verification)
- Storage: `@react-native-async-storage/async-storage`, `expo-secure-store`
- Lottie: `lottie-react-native` 7.3.1
- UI: NativeWind + Tailwind 3, `@expo/vector-icons` 15, FlashList 1.7.6
- Localization: `expo-localization`
- OTA: `expo-updates`

### Native config

- iOS Info.plist: `App/zopmop-app/ios/zopmopapp/Info.plist`
  - Bundle ID set via `$(PRODUCT_BUNDLE_IDENTIFIER)`, expected `com.zopmop.app`
  - `LSMinimumSystemVersion` = `12.0` — older than current Apple recommendations
  - Privacy strings present for: `NSFaceIDUsageDescription`,
    `NSLocationAlwaysAndWhenInUseUsageDescription`,
    `NSLocationAlwaysUsageDescription`,
    `NSLocationWhenInUseUsageDescription`
  - **Multiple privacy strings are generic placeholders** (e.g. "Allow
    $(PRODUCT_NAME) to access your location") — Apple-rejection risk
  - `NSPrivacyAccessedAPITypes` declared via `PrivacyInfo.xcprivacy` but
    `NSPrivacyCollectedDataTypes` is **empty array**, `NSPrivacyTracking` =
    false — does NOT match the actual SDK surface (PostHog, Firebase
    Analytics, Crashlytics, FCM, Cashfree) — Apple-rejection risk
  - `UIBackgroundModes` lists `remote-notification`, `fetch` twice (duplicated)
  - `CFBundleURLTypes` duplicates the Google OAuth scheme twice
  - No `NSUserTrackingUsageDescription` — but PostHog is integrated, which
    may need ATT depending on configuration
  - `NSAppTransportSecurity.NSAllowsLocalNetworking` = true — fine for dev,
    documentation expected by review
- iOS PrivacyInfo.xcprivacy: present but incomplete (see above)
- Android manifest: `App/zopmop-app/android/app/src/main/AndroidManifest.xml`
  - Permissions: `INTERNET`, `POST_NOTIFICATIONS`, `ACCESS_COARSE_LOCATION`,
    `ACCESS_FINE_LOCATION`, `VIBRATE`, **`SYSTEM_ALERT_WINDOW`**,
    **`READ_EXTERNAL_STORAGE`**, **`WRITE_EXTERNAL_STORAGE`**
  - The latter three are flagged in-line with comment "OPTIONAL PERMISSIONS,
    REMOVE WHATEVER YOU DO NOT NEED" — they remain present and are
    **Play-rejection risk** (especially SYSTEM_ALERT_WINDOW)
  - Intent filter for universal links: `https://zopmop.com/r/*`, `autoVerify`
- `app.json`:
  - iOS bundle ID: `com.zopmop.app`
  - Android package: `com.zopmop.app`
  - **Google Maps API key embedded in plain text**:
    `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0`
    appears in `app.json` (iOS + plugin config) and `ios/zopmopapp/Info.plist`.
    Critical: secrets-in-source. Must verify rotation status and confirm key
    restrictions in Google Cloud Console (HTTP referrer / iOS bundle / Android
    SHA1 lock).
- `eas.json`:
  - Three profiles: development, preview, production. Production has
    `autoIncrement: true` (good).
  - Development env points API at `http://localhost:8080/api/v1`. Production
    env is empty — confirm prod URL is set via EAS secret or `app.config.js`
    extra.
- `google-services.json` + `GoogleService-Info.plist`: tracked in repo
  (Firebase project config — generally OK to commit but verify no API key
  has unrestricted scope)
- `patches/`: contains `@shopify+flash-list+1.7.6.patch` and
  `react-native-cashfree-pg-sdk+2.3.2.patch`. Wired via `postinstall:
  patch-package`.

### Mobile build tooling
- `metro.config.js` with `react-native-svg-transformer` (SVG-as-component)
- `babel.config.js` likely uses `babel-plugin-transform-remove-console` for
  production (verify)
- ESLint flat config (`eslint.config.js`) wires `eslint-config-expo/flat`

## Backend (`App/househelp-api/`)

- Language: Go 1.25 (toolchain pinned 1.26.3 in `go.mod`)
- Framework: Fiber v2 (with helmet, websocket)
- Database: PostgreSQL 16 + PostGIS 3.4 (local `postgis/postgis:16-3.4-alpine`)
- Driver: pgx/v5
- Cache: Redis 7
- Auth: Firebase Admin SDK (`firebase.google.com/go/v4`) for phone OTP,
  internal JWT (`golang-jwt/jwt/v5`) issued post-Firebase exchange
- Logging: zerolog
- Validation: `go-playground/validator/v10`
- Circuit breaker: `sony/gobreaker`
- Schema validation: `xeipuuv/gojsonschema`
- Other: `pquerna/otp` (TOTP), `redis/go-redis/v9`, `joho/godotenv`,
  `golang-migrate/migrate/v4`

### Backend directory map

`App/househelp-api/`
- `cmd/`
  - `api/` — primary HTTP server (Fiber)
  - `crm-api/` — separate CRM/admin API server
  - `crm-integrity/`, `jsonb-scrub-backfill/`, `loadseed/`,
    `promptdump/`, `retention-worker/`, `sim/`, `stresstest/`
  - `migrate/` — schema migration runner (forward-only by policy)
- `internal/` (38 modules)
  - Auth & identity: `auth`, `middleware`, `credentials`, `users`
  - Domain logic: `booking`, `cart`, `helper`, `experts`, `matching`,
    `slots`, `leave`, `addresses`, `roomies`, `referral`, `reviews`,
    `disputes`, `offers`, `payments`, `wallet`
  - Backend-for-frontend: `bff`, `sdui` (referenced from `content`)
  - Operational: `analytics`, `insights`, `reengagement`, `segments`,
    `outbox` (event outbox + reliability)
  - Compliance: `compliance` (DPDP / data subject rights), `admin`
  - Notifications: `notification`
  - Geo: `googlemaps`, `places`, `location`, `zones`
  - Webhooks: `webhooks`
  - Config: `config_manager`
  - Misc: `content` (SDUI page configs), `crm` (CRM-specific handlers),
    `zop` (AI assistant)
- `pkg/` — reusable (config, crmconfig, database, httpx, logger, validator)
- `migrations/` — 95 forward migrations (`001`..`095`). Latest two (094/095)
  are recovery migrations for a 2026-05-14 hybrid-schema incident; both are
  idempotent. See `migrations/094_*.up.sql` and `migrations/095_*.up.sql`.
- `schemas/` — JSON schemas (SDUI payload validation)
- `docs/audits/` — prior audit docs (preserve, cross-reference)
- `loadtest/`, `scripts/`, `static/`, `deploy/`, `secrets/` (gitignored)

### Backend infra
- `Dockerfile` — multi-stage. `golang:1.26-alpine` build → `alpine:3.19`
  runtime. Runs as `app` user (uid 10001). Both `api` and `migrate` binaries
  built and copied. Migrations + JSON schemas copied to `/app`.
- `docker-compose.yml` — backend + postgres (PostGIS 16) + redis + migrate
  one-shot.
- `railway.json` — declares `preDeployCommand: /usr/local/bin/migrate up`
  so every Railway deploy applies pending migrations before booting api.
- `.env.example` is in-repo; superset `.env.local.example` provides
  Docker-compose-network defaults.
- Pool tuning env vars present (`DB_POOL_MIN_CONNS`, `_MAX_CONNS`,
  `DB_BOUND_MAX_INFLIGHT`, `DB_BOUND_QUEUE_WAIT_MS`).

### Backend deploy
- Railway production branch: **`main`** (renamed from `feature/sdui` on
  2026-05-15). Auto-deploys via the Railway GitHub App when GitHub user
  `Rohilalala` is linked to the Railway account. Pre-deploy hook runs
  `migrate up` on a single instance before api boots.
- Public URL: `https://zopmop-production.up.railway.app`
- Prod DB: Railway PostGIS service. Public TCP URL via
  `turntable.proxy.rlwy.net:47710` (credentials in Railway dashboard, not
  in repo).

## CRM admin web app (`App/zopmop-crm/`)

- Vite + TypeScript + Tailwind CSS + PostCSS.
- Hits the `cmd/crm-api` backend.
- Hosting: deploys separately (not Railway; details in repo if present).

## Marketing website (`website/`)

- Static HTML/CSS/JS, ~46 MB.
- Deployed via GoDaddy cPanel to `zopmop.com` (FTP/SFTP via Cyberduck).
- Tracked in git only for `.well-known/apple-app-site-association` and
  `.well-known/assetlinks.json` (universal-link manifests). Rest of the
  site is ignored via `/website/` rule.
- `.htaccess` adds `Content-Type: application/json` for AASA + assetlinks
  (added during this work).

## Notable conventions and policies

- **No `.down.sql` migrations** as repo policy (see
  `cmd/migrate/main.go:9-10`). Practice has drifted — both `.up.sql` and
  `.down.sql` exist for 084-095; the down files contain forward-only
  comments and should never be run.
- **No CO Authored-By assist trailers** on commits in this repo.
- **No auto-commit / no auto-push** without explicit user permission.
- **Caveman mode** is active in the user's interactive sessions but does
  NOT apply to audit deliverables, code, commits, or security findings.
- Brand: **ZopMop** — capital Z, capital M, no spaces. Tagline:
  "Home, handled." Mascot: "Zop" (proportions defined in design system).

## Prior audits (cross-reference, do not duplicate)

- `AUDIT_2025_2026-05-03.md` (top-level, 32 KB) — fairly comprehensive audit
  dated 2026-05-03.
- `security_audit_report.md` (top-level, 40 KB) — security-focused audit
  dated similar timeframe.
- `.audit/2026-05-07/`, `.audit/2026-05-08-loose-ends/` — internal audit
  directories with raw shared memory + per-agent logs.
- `.audit/FINAL_REPORT.md` (42 KB) — consolidated prior report.
- Treat prior audit findings as historical; flag in your finding if it was
  already reported, fixed, or remains outstanding. New findings welcome,
  but explicitly cite existing findings rather than rediscover them.

## Known issues already documented in user memory

- 2026-05-14 hybrid-schema incident on prod (price_cents vs price_paise +
  legacy cart_items UNIQUE) — RESOLVED 2026-05-15 via migrations 094 + 095.
- Google Maps API key burned and previously rotated (per user memory).
  **VERIFY**: every embedded copy of the current key (in `app.json` and
  `Info.plist`) must be the post-rotation key AND must be restricted in
  Google Cloud Console.
- Android `assetlinks.json` still contains DEBUG SHA-256; release SHA needs
  to be added before Play Store launch.
- TestFlight build 1.0.0(1) live; Google Maps iOS wired; APNs key in
  Firebase; Team ID 2P38R9F468.

## Anomalies and oddities to inspect

- `App/zopmop-app/ios/zopmopapp/Info.plist` has duplicate entries:
  `UIBackgroundModes` array contains `remote-notification` and `fetch`
  twice each; `CFBundleURLTypes` lists the Google OAuth scheme twice.
- `AndroidManifest.xml` retains the boilerplate "OPTIONAL PERMISSIONS,
  REMOVE WHATEVER YOU DO NOT NEED" block with `SYSTEM_ALERT_WINDOW`,
  `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` still listed.
- `App.tsx` is large (likely hundreds of lines per existing patterns) —
  worth a structure review.
- `App/zopmop-app/global.css` + Tailwind + NativeWind: ensure styling
  primitives are consistently routed through theme rather than ad-hoc.
- Backend modules `roomies`, `experts`, `referral`, `offers` are recent
  additions per prior memory — verify they all have tests and are wired
  into auth middleware.
- `internal/zop` (AI assistant) integrates OpenRouter; verify prompt
  injection hardening, rate limiting, and token-cost guardrails.

## Pre-existing scripts and tooling

- `App/househelp-api/Makefile` — `up/down/migrate/preflight/...`
- `App/househelp-api/scripts/preflight.sh` — branch guard + vet + tests +
  compose-up + migrate + smoke. Should be the PR-gate.
- `App/househelp-api/.githooks/pre-push` — blocks pushes to `main`
  (deploy branch). Activate per-clone via
  `git config core.hooksPath .githooks`.

## Subagent workflow rules

- Read this file. Then dive into the scope assigned. Cite `file:line`.
- Use the finding format from the audit instructions verbatim.
- Write to `audit/findings/<your-name>.md`. Paginate if the file grows past
  ~500 lines — never truncate.
- Cross-reference prior audit findings explicitly. Don't restate them as
  novel.
- Do not modify source code. Findings only.
- When unclear about intent, append a question to a "QUESTIONS FOR ADITYA"
  section at the bottom of your findings file. The consolidation step pulls
  these into `audit/OPEN_QUESTIONS.md`.
