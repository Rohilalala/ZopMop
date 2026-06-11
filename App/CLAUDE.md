# App/ — CLAUDE.md
**Purpose:** Holds all three deployable ZopMop apps: `househelp-api` (Go backend), `zopmop-app` (RN/Expo mobile), `zopmop-crm` (React+Vite CRM). This is the code that ships; everything money/auth/dispatch lives under here.

**Run / test:**
- Backend:  `cd App/househelp-api && go run ./cmd/api`  | test: `go test ./...`
- Mobile:   `cd App/zopmop-app && npx expo start`        | unit: `npx jest`
- CRM:      `cd App/zopmop-crm && npm run dev`            | lint: `npm run lint`

**Debug:**
- Backend logs to stdout locally; Railway: `railway logs --tail`. "table not found" → migration order.
- Mobile: Metro logs in the `expo start` terminal; Android `adb logcat | grep -i zopmop`.
- CRM: Vite dev server console + browser devtools.

**Landmines:**
- Money is int64 paise everywhere — no floats crossing any layer.
- `IsProduction()` must gate OTP/SMS/payment/webhook side effects. Bypassing fired real SMS in dev (PR #27).
- Two pro-pay formulas alive (C1) — `internal/booking/earnings.go` vs `internal/payroll/calc.go`. Don't add a third.
- OTP "999999" hardcoded across config/auth (C10) — confirm not reachable in prod.
- lottie-react-native 7.3.6: async race on `.lottie` under New Architecture → black screen. Preload before render.

**Open items:** C1 (pay formulas), C7 (Aadhaar/bank plaintext), C10 (OTP hardcode) → docs/business-rules-audit-2026-05-21.md. LB-1/LB-6 → audit/money/SYNTHESIS.md.

**Last updated:** 2026-06-05

---

## Approach
- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct.
- User instructions always override this file.

## Learnings
### 2026-06-11 — lottie-react-native 7.3.6 segment playback
Imperative `ref.play(start, end)` under New Architecture finishes instantly (onAnimationFinish loop, frame stuck at 0) — even for known-good files. Drive states by swapping `autoPlay` sources between separate .json files whose boundary poses match (see ZopDownLottie in src/screens/BackendDownScreen.tsx).

### 2026-06-11 — hand-authored Lottie JSON rules
Non-final keyframes MUST carry `o`/`i` easing or `h:1`, else players crash ("reading 'x'") and render static. Shape arrays stack like AE: index 0 = topmost. Validate with lottie-web before shipping.
