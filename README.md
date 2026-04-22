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

- **Customer App** — book services, track active jobs, manage households ("Roomies" groups), and pay via Razorpay.
- **Helper / Pro App** — onboard as a pro, receive live job matches, accept work, and manage earnings.

Both talk to a shared Go API backed by PostgreSQL (with PostGIS for geospatial matching) and Redis.

## Features

- **Instant matching** — location-aware dispatch using PostGIS; pros get paged in real time as requests come in.
- **Phone auth** — Firebase OTP, backend token exchange, session-only storage to prevent persistence of sensitive tokens.
- **Live tracking** — react-native-maps + Google Directions, continuously updated ETA.
- **Roomies** — shared households: multiple users under one address, bookings visible to the group, auto-settle of shared expenses.
- **Reengagement** — event-driven push/notification pipeline for idle users, cart abandonment, and offers.
- **Wallet & payments** — Razorpay integration, in-wallet credits, offers, and coupons.
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
| Payments | `react-native-razorpay` |
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
- **Razorpay** test key (optional, for payments)

### Backend

```bash
cd App/househelp-api

# 1. Start Postgres + Redis
docker compose up -d postgres redis

# 2. Run migrations (first run only)
go run ./cmd/api migrate up

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

A dev client build is required (not Expo Go) because the app ships custom native modules: Firebase, Razorpay, Maps, Lottie, SVG.

### Environment

Set in `App/zopmop-app/.env`:

```
EXPO_PUBLIC_API_URL=http://192.168.x.x:8080
GOOGLE_MAPS_API_KEY=...
EXPO_PUBLIC_RAZORPAY_KEY_ID=rzp_test_...
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

## Roadmap

- Split the pro experience into its own Expo app (monorepo).
- Background location updates for pros during active jobs.
- Offline-first cart + booking drafts.
- In-app chat between customer ↔ helper.
- Localisation (Hindi, regional languages).

## Contributing

This repo is currently private. If you have access, branch off `main`, keep commits focused, and open a PR with a description and a screenshot or screen recording for UI changes.

## License

Proprietary — © ZopMop. All rights reserved.
