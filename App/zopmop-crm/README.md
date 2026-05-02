# zopmop-crm

Standalone Zopmop CRM admin web app. React 18 + TypeScript + Vite +
Tailwind. Talks to `App/househelp-api/cmd/crm-api/` over HTTP. Lives at
`crm.zopmop.com` in production.

## Stack

- **React 18 + TypeScript + Vite** — minimal toolchain, no framework lock-in.
- **Tailwind CSS** — design tokens defined in `tailwind.config.ts`. **No** UI
  component library — primitives are hand-built in `src/components/ui/`.
- **Zustand** — global state. Auth + Pro Mode only.
- **TanStack Query** — server state (every API call routes through it).
- **Recharts** — charts.
- **Mapbox GL JS** — live map.
- **Framer Motion** — page + element transitions.
- **Lucide React** — icons.

## Running locally

```bash
cp .env.example .env
# fill in VITE_CRM_API_URL (default http://localhost:8090) and VITE_MAPBOX_TOKEN

# in App/househelp-api: ./crm-api  (or `go run ./cmd/crm-api`)
# in App/zopmop-crm:
npm install
npm run dev   # http://localhost:5174
```

## What's wired up

- ✅ **Auth + Shell** — login, TOTP, refresh, lockout, sessions list, sidebar,
  topbar, Pro Mode toggle.
- ✅ **Dashboard** — KPI cards, live orders feed, revenue 7d, category donut,
  alerts feed.
- ✅ **Feature Flags** — categorised list, type-aware editor, confirmation
  modal, snapshot history with rollback.
- 🚧 **All other modules** — render a stub page with a description of what
  belongs there. Backend has placeholder routes via `/admin/_stub/:module`.

## Design tokens

See `tailwind.config.ts` for the canonical palette. Don't introduce new raw
hex values in components — extend the theme instead.
