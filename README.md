<div align="center">

# ZopMop

**Home services, instantly.**

On-demand help for chores, cleaning, and errands — delivered by verified helpers in your neighbourhood.

[![React Native](https://img.shields.io/badge/React_Native-0.81-61DAFB?logo=react&logoColor=white)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo-SDK_54-000020?logo=expo&logoColor=white)](https://expo.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io)

</div>

---

## Overview

ZopMop connects customers with vetted home-service professionals — cleaning, repairs, household chores, groceries, and more — with instant or scheduled dispatch. The platform is built as two primary experiences:

- **Customer App** — book services, track active jobs, manage households ("Roomies" groups), and pay via Cashfree PG or the closed-loop Zopmop Wallet.
- **Helper / Pro App** — onboard as a pro, receive live job matches, accept work, and manage earnings.

Both talk to a shared Go API backed by PostgreSQL (with PostGIS for geospatial matching) and Redis.

## Features

- **Instant matching** — location-aware dispatch using PostGIS; pros get paged in real time as requests come in.
- **Phone auth** — Firebase OTP, backend token exchange, session-only storage to prevent persistence of sensitive tokens.
- **Live tracking** — react-native-maps + Google Directions, continuously updated ETA.
- **Roomies** — shared households: multiple users under one address, bookings visible to the group, auto-settle of shared expenses.
- **Reengagement** — event-driven push/notification pipeline for idle users, cart abandonment, and offers.
- **Wallet & payments** — Cashfree PG integration with closed-loop wallet (topup, spend, refund credit), offers, and coupons.
- **Mascot-driven onboarding** — Lottie + custom animations for a playful, app-specific intro flow.

## Tech Stack

### Mobile (`App/zopmop-app`)
| Layer | Tech |
|-------|------|
| Runtime | React Native 0.81, Expo SDK 54, TypeScript |
| Navigation | `@react-navigation/native-stack`, bottom tabs, top tabs |
| State | Context + in-memory stores (no persistence of secrets) |
| Animations | `lottie-react-native`, `gsap`, `react-native-svg` |
| Auth | `@react-native-firebase/auth` — phone OTP |
| Maps | `react-native-maps`, Google Directions via `@mapbox/polyline` |
| Payments | `react-native-cashfree-pg-sdk` |
| Fonts | Plus Jakarta Sans, Qurova (brand wordmark) |

### Backend (`App/househelp-api`)
| Layer | Tech |
|-------|------|
| Language | Go 1.22 |
| Database | PostgreSQL 16 + PostGIS 3.4 |
| Cache / queues | Redis 7 |
| Auth | Firebase ID token verification → first-party JWT |
| Geocoding | Google Maps Go SDK |
| Deploy | Docker Compose for local dev; Cloud Run-compatible |

## Architecture

```
┌──────────────┐        ┌──────────────┐        ┌────────────────┐
│  Customer    │        │    Helper    │        │   Admin (ops)  │
│     App      │        │     App      │        │   dashboards   │
└──────┬───────┘        └──────┬───────┘        └────────┬───────┘
       │                       │                         │
       └───────────┬───────────┘                         │
                   │ HTTPS / JSON                        │
                   ▼                                     ▼
        ┌────────────────────────────────────────────────────┐
        │              househelp-api (Go)                    │
        │  auth · matching · bookings · wallet · roomies     │
        │  reengagement · payments · analytics · cron        │
        └───────┬────────────────────┬──────────────┬────────┘
                │                    │              │
                ▼                    ▼              ▼
         ┌──────────────┐     ┌───────────┐   ┌──────────────┐
         │ Postgres +   │     │   Redis   │   │   Firebase   │
         │  PostGIS     │     │           │   │   Auth       │
         └──────────────┘     └───────────┘   └──────────────┘
```

## Repository Layout

```
ZopMop/
├── App/
│   ├── zopmop-app/           # React Native (Expo) mobile app
│   │   ├── src/
│   │   │   ├── api/          # HTTP client + typed service modules
│   │   │   ├── components/   # Reusable UI (Zop mascot, cards, etc.)
│   │   │   ├── context/      # Theme, Auth providers
│   │   │   ├── navigation/   # Auth + Main stacks, tabs
│   │   │   ├── screens/
│   │   │   │   ├── auth/     # Splash → Intro → Phone → OTP → Name → Welcome
│   │   │   │   ├── booking/  # Active booking, instant matching
│   │   │   │   ├── main/     # Home, cart, wallet, roomies, etc.
│   │   │   │   └── pro/      # Helper-side screens
│   │   │   ├── theme/        # Colors, typography, spacing
│   │   │   ├── types/        # Navigation + API types
│   │   │   └── utils/        # Stores, helpers
│   │   └── assets/           # Fonts, mascot SVGs, Lottie animations
│   └── househelp-api/        # Go backend
│       ├── cmd/api/          # Entry point
│       ├── internal/         # Domain modules (auth, bookings, roomies, …)
│       ├── pkg/              # Shared infra (db, redis, logging)
│       └── migrations/       # Ordered SQL migrations
├── docs/                     # Architecture + design notes
└── report/                   # Generated audits / plans
```

## Getting Started

### Prerequisites

- **Node.js** 20+ and **npm** 10+
- **Xcode** 16+ (iOS) and/or **Android Studio** (Android)
- **Go** 1.22+
- **Docker** (for local Postgres + Redis)
- **Firebase project** with phone auth enabled (`GoogleService-Info.plist` / `google-services.json`)
- **Cashfree** sandbox keys (App ID + Secret) for end-to-end payment testing. Backend uses both; the RN app needs only the App ID.

### Backend

```bash
cd App/househelp-api

# 1. Start Postgres + Redis
docker compose up -d postgres redis

# 2. Build + run migrations (first run only)
go build -o bin/migrate ./cmd/migrate
DATABASE_URL=postgres://... ./bin/migrate up
# Existing DBs that pre-date the runner: ./bin/migrate baseline first.
# See App/househelp-api/docs/migrations.md for full procedure.

# 3. Start the API
go run ./cmd/api
# → listening on :8080
```

Config lives in `App/househelp-api/.env` (example in `.env.example`).

### Mobile App

```bash
cd App/zopmop-app

# 1. Install deps
npm install

# 2. iOS — install CocoaPods & run on simulator
cd ios && pod install && cd ..
npx expo run:ios

# Android
npx expo run:android

# Metro only (after a native build already installed on the device)
npx expo start --clear
```

A dev client build is required (not Expo Go) because the app ships custom native modules: Firebase, Cashfree PG, Maps, Lottie, SVG.

### Environment

Set in `App/zopmop-app/.env`:

```
EXPO_PUBLIC_API_URL=http://192.168.x.x:8080
GOOGLE_MAPS_API_KEY=...
EXPO_PUBLIC_CASHFREE_PG_APP_ID=TEST...
EXPO_PUBLIC_CASHFREE_ENV=sandbox
```

Use your machine's LAN IP for `EXPO_PUBLIC_API_URL` when running on a physical device.

## Onboarding Flow

The intro experience is a chained sequence of Lottie animations designed in Figma:

```
Splash  →  ZopIntro  →  HiZop  →  PhoneEntry  →  OTP  →  NameEntry  →  Welcome
 (logo)     (mascot    (tap CTA)    (form +       (6-digit     (keeps     (hero
            morph)                   keyboard-     + look-      your       + greet
                                     aware         away          name)      lottie)
                                     button)      mascot)
```

Each screen overlays form elements on top of a full-screen `.lottie` asset. Navigation transitions between animated screens are set to `animation: 'none'` so the mascot appears to move continuously across screens.

## Development Notes

- **TypeScript strict mode** is on. Prefer narrow types; avoid `any`.
- **Animations** prefer Lottie for complex sequences, `Animated` / `gsap` for incidental opacity / transforms.
- **Security**: short-lived tokens are held in `pendingAuthStore` (in-memory only) and never serialized to disk through React Navigation state.
- **Graph-powered navigation** — the repo includes a code-review knowledge graph (`code-review-graph` MCP tools) for structural queries; use it instead of grep when exploring.

## Payments — Cashfree PG

Single-gateway architecture on Cashfree. Cashfree PG (`api.cashfree.com/pg`) handles
collection (orders, hosted checkout, webhooks, refunds). Cashfree Payouts
(`payout-api.cashfree.com`) is retained for VPA validation today and helper
disbursement later. Razorpay is excised.

```
   ┌──────────┐  POST /payments/cashfree/order   ┌──────────┐
   │  RN app  │ ───────────────────────────────▶ │  backend │
   └──────────┘ ◀─ payment_session_id ────────── └──────────┘
        │                                              │ POST /orders
        │ doWebPayment(payment_session_id)             ▼
        │                                        ┌──────────┐
        ▼                                        │ Cashfree │
   ┌──────────┐                                  │   PG     │
   │ Cashfree │                                  └──────────┘
   │  hosted  │ ◀──── card / UPI / netbanking ───┐
   │ checkout │                                  │
   └──────────┘ ─── webhook (HMAC-signed) ───▶ /payments/cashfree/webhook
                                                      │
   GET /payments/cashfree/orders/:id/status ─────────▶ backend
   (RN app polls every 3s for up to 60s)              │
                                                      ▼
                                                 ledger + outbox
```

### Required env vars (househelp-api)

| Var | Purpose | Local dev |
|---|---|---|
| `CASHFREE_PG_APP_ID` | Cashfree PG app id (Dashboard → Developers → API Keys) | required |
| `CASHFREE_PG_SECRET_KEY` | Matching secret | required |
| `CASHFREE_PG_ENV` | `sandbox` or `production` | `sandbox` |
| `CASHFREE_PG_WEBHOOK_SECRET` | Webhook signing secret (defaults to `CASHFREE_PG_SECRET_KEY`) | optional |
| `PUBLIC_BASE_URL` | Public https URL of the API; used to build the webhook callback | required (use ngrok locally) |

### Local webhook setup

1. Install ngrok: `brew install ngrok`
2. Run backend: `go run ./cmd/api` from `App/househelp-api`
3. Tunnel: `ngrok http 8080`
4. Set `PUBLIC_BASE_URL` to the printed `https://*.ngrok-free.app`
5. In Cashfree Dashboard → Developers → Webhooks, set URL to `<ngrok-url>/payments/cashfree/webhook`
6. Click "Send Test" — you should see `[cashfree] merchant dashboard test webhook acknowledged` in the API log

### Webhook signature

Signing string = `timestamp + raw_body` (no separator). HMAC-SHA256 with
`CASHFREE_PG_WEBHOOK_SECRET`. Base64-encoded. Replay window ±300s. The handler
reads `c.Body()` *before* parsing so signature computation matches Cashfree's
exact byte sequence.

### Idempotency

Every webhook dispatch runs inside `payments.ConsumeOnceTx` — a single Postgres
transaction that atomically claims the `event_id` AND runs the business logic.
Crash between ledger update and outbox emit rolls both back; Cashfree's retry
re-runs from scratch. Migration `070_event_outbox_dedupe.sql` adds a unique
index on `event_outbox(payload->>'payment_id')` for `booking.paid` /
`wallet.topped_up` events as belt-and-suspenders.

## Wallet (closed-loop)

Schema: `migrations/067_wallets.sql` (`wallets` + `wallet_transactions`).

### Closed-loop guarantees

- **No P2P transfers.** No kind in `wallet_transactions.kind` enum allows
  user-to-user movement.
- **No withdrawal-to-bank.** No route exists; refund of a wallet-paid booking
  credits back into the wallet (kind=`refund_credit`) by design.
- **No third-party payments.** Wallet funds are only spendable through
  `kind='spend'`, which the service-layer validation requires a `booking_id`
  for. The booking belongs to a Zopmop service, gated by the matching engine.
- **Money in only via Cashfree topup** (kind=`topup`, requires
  `payment_id` referencing the Cashfree-funded `payments` row) or refund
  credit / admin adjustment.

This keeps Zopmop outside RBI Prepaid Payment Instrument licensing scope —
closed-loop instruments don't require RBI authorisation under the Master
Direction on PPIs.

### Race protection

`Repository.ApplyTransactionTx` locks the `wallets` row with
`SELECT … FOR UPDATE` before computing the new balance. Two concurrent debits
on the same wallet are serialised at the row level. Test:
`TestApplyTransactionTx_RaceCondition` runs 50 × 2 concurrent debits and
asserts exactly one succeeds per iteration.

### Topup limits

`100 paise (₹1)` ≤ amount ≤ `500_000 paise (₹5,000)`, enforced in
`payments.Handler.createCashfreeOrderForWalletTopup`. Returns 402 with code
`amount_too_low` / `amount_too_high`.

### Routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/wallet` | `{ balance_paise }` |
| `GET` | `/wallet/transactions?limit=20&before=<rfc3339>&before_id=<uuid>` | reverse-chrono history with cursor pagination |
| `POST` | `/wallet/topup` | body `{ amount_paise }`; delegates to payments handler with `payment_source=wallet_topup` |

## Migrations

`*.up.sql` files under `App/househelp-api/migrations/` driven by
`golang-migrate/migrate/v4`. CLI binary at `App/househelp-api/cmd/migrate`.
Forward-only (no `.down.sql` files). See
`App/househelp-api/docs/migrations.md` for the full procedure.

| File | Summary |
|---|---|
| `064_add_email_to_users.sql` | Adds optional `users.email` column for Cashfree customer details |
| `065_bookings_amount_paise.sql` | Renames `bookings.price_cents`→`amount_paise`, `discount_cents`→`discount_paise`, widens to `BIGINT` |
| `066_cashfree_orders.sql` | Per-payment Cashfree order metadata (`cf_order_id`, `payment_session_id`, `expires_at`) |
| `067_wallets.sql` | `wallets` + `wallet_transactions` (closed-loop) |
| `068_payments_nullable_booking.sql` | Loosens `payments.booking_id NOT NULL` so wallet topups can land |
| `069_event_outbox.sql` | Transactional outbox (status state machine, version, available_at) |
| `070_event_outbox_dedupe.sql` | Unique index on `event_outbox(payload->>'payment_id')` for booking.paid / wallet.topped_up |

### Apply order

1. Deploy the Go binary built from this commit (or atomically with step 2).
2. Run `./bin/migrate up` (existing DBs: `./bin/migrate baseline` once first).
3. Restart backend.

**Migration 065 is binary-aware**: applying it before deploying matching code
breaks every booking read because deployed SQL strings still reference
`price_cents` / `discount_cents`. Single-PR deploys are safe; canary deploys
must hold the migration until all old replicas drain.

### Known *_cents naming drift

`service_categories.base_price_cents` / `mrp_cents`, `cart_items.price_cents`,
`booking_services.price_cents`, and `analytics_*.revenue_*_cents` all store
**paise** despite the `_cents` suffix. The values are correct; the names lie.
Do not multiply when reading. Future cleanup will rename in a separate sweep.

## Compliance & retention

ZopMop runs scheduled retention sweeps to comply with DPDP / GDPR
data-minimization requirements. The retention worker
(`cmd/retention-worker`) applies time-based DELETE / anonymize policies
across:

- `bookings` — money-rail anonymized after 7 years; unpaid hard-deleted
- `booking_messages` — sender anonymized after 24 months
- `reviews` — bidirectional anonymize after 3 years
- `refunds` — 7-year retention from `processed_at` (with active-lock guard)
- `audit_log` + `crm_audit_log` — 3-year retention; target-side anonymize on user delete
- `crm_login_attempts`, `crm_push_messages`, `helper_status_log` — 90-day retention

Soft-delete of a user (`SoftDeleteUser`) invokes anonymization hooks
across booking_messages, reviews, addresses, refunds, audit logs, JSONB
blobs, location residue (Redis), and campaign targets. See
`internal/compliance/` for implementation.

### Running retention

See `App/househelp-api/deploy/README.md` for scheduling. Default:
03:00 IST daily via Kubernetes CronJob. Use `-dry-run` for the first
sweep to verify counts before enabling.

### DSAR support

Users can request a data export via `GET /me/export`. Streaming JSON,
rate-limited to 1 export per hour per user, helper-id / customer-id of
counter-parties redacted. See `internal/compliance/export.go`.

## Tech Debt

- COD placeholder row in `payments` for direct-pay bookings — `recordPaymentIntent`
  inserts a `gateway='cod'` row that stays `pending` forever when the customer
  pays via Cashfree. Pre-existing; needs a sweep.
- JSON-tag back-compat — Go field names are `AmountPaise` / `DiscountPaise`
  but JSON tags still read `price_cents` / `discount_cents`. Rename gated on
  mobile v2 client adoption — see `App/househelp-api/docs/jsontag-rename-tracking.md`.
- Naming drift on `*_cents` columns outside `bookings` (see Migrations section).
- Outbox drainer worker — `event_outbox` accumulates rows with no consumer.
  Will write when the CRM swap or analytics pipeline lands.
- Cashfree S2S / custom UI — currently using hosted checkout via
  `doWebPayment`. S2S enablement pending from Cashfree; RN side will swap
  when it lands (backend already supports both flows).

## Roadmap

- Split the pro experience into its own Expo app (monorepo).
- Background location updates for pros during active jobs.
- Offline-first cart + booking drafts.
- In-app chat between customer ↔ helper.
- Localisation (Hindi, regional languages).

## Contributing

This repo is currently private. If you have access, keep commits focused, and open a PR with a description and a screenshot or screen recording for UI changes.

### Branching

- **`main`** — production-ready. Deploys to production (when applicable).
- **`develop`** — integration / pre-prod. All feature work merges here first for end-to-end testing.
- **`feature/*`** — short-lived feature branches.

Flow:

1. Branch off `develop`: `git checkout develop && git pull && git checkout -b feature/your-feature`
2. Build feature. Commit frequently. Push to remote.
3. Open PR to `develop`. Self-review, merge.
4. End-to-end test on `develop` (real-device smokes, full booking lifecycle, CRM walkthrough).
5. When `develop` is stable and tested, merge `develop` → `main`.

Never merge feature branches directly to `main`. Always go through `develop`.

**Hotfix exception:** for a critical production bug, branch off `main`, fix, then merge to `main` **and** `develop` simultaneously to keep them in sync.

## License

Proprietary — © ZopMop. All rights reserved.
