# zopmop-app (React Native + Expo)

Customer + pro flows in one app. `expo start` · `expo run:ios` · `expo run:android`.
`postinstall` runs `patch-package` — native/dep patches live in `patches/`.

## src/ layout
- `screens/` — hardcoded screens. `sdui/` — server-driven UI (see below).
- `components/home/` — home-screen primitives (ScreenBg, GlassCard, Bloom, Hero*, *Pill, ServiceThumb…). Reuse these; don't re-roll layout pieces.
- `theme/`, `context/`, `hooks/`, `navigation/`, `services/`, `api/`, `analytics/`, `i18n/`.

## Conventions (non-obvious)
- **SDUI + hardcoded split:** dynamic surfaces render through `sdui/` (`registry.tsx`,
  `SectionRenderer.tsx`, `ActionHandler.ts`) gated by `allowlist.ts` + `safeguards.ts`.
  Static screens live in `screens/`. New section type → register + allowlist it.
- **Theme:** colors come from `useColors()` / `useTheme()` (`context/ThemeContext.tsx`),
  never hardcoded hex. Dark mode is the locked, finished design; light mode is deferred
  until all dark screens ship — build dark-first.
- **No emoji as UI** — never use emoji characters for icons or text. Use Feather / vector icons.
