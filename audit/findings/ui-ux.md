# UI/UX & Design System Audit — Subagent 7

Scope: `App/zopmop-app/src/` — brand consistency, color/typography/spacing tokens,
interactive states, empty/error states, trust signals, mascot usage, tagline
placement, emoji-as-icon, loading consistency, dark-mode adherence.

Canonical design system reference:
- `src/theme/colors.ts` — `lightColors` / `darkColors` tokens
- `src/theme/screen.ts` — `C` palette for the locked dark glassmorphism screens
- `src/theme/typography.ts` — `FontFamily` (Plus Jakarta Sans family)
- `src/theme/index.ts` — `Spacing`, `Radius`, `Shadow`
- `src/components/PrimaryButton.tsx`, `src/components/EmptyState.tsx`,
  `src/components/skeletons/*` — shared primitives

Cross-reference: prior audit `.audit/FINAL_REPORT.md`, user memory items
`project_design_conventions`, `project_svg_icons_revamp`, `feedback_no_emojis`.

---

## Severity summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 9 |
| Medium   | 12 |
| Low      | 7 |
| Nit      | 3 |
| Total    | 31 |

---

## Findings

### 1. Brand & wordmark

```
[SEVERITY: High]
[FILE: src/components/home/HomeFooter.tsx:171]
[CATEGORY: UI/UX / Brand spelling]
Finding: The HomeFooter wordmark renders the brand as "ZOPMOP" (all caps),
violating the locked-in spelling "ZopMop" (capital Z, capital M, mixed case).
Impact: Inconsistent brand presentation in the most visible
end-of-feed signature spot. Other surfaces use correct "ZopMop"
(see ProfileScreen.tsx:346 "ZopMop · v{APP_VERSION}").
Fix: Render as "ZopMop" with letter-spacing styling, or convert the
wordmark to an SVG/Qurova-rendered logo glyph rather than typed text.
Per user memory, only Qurova Medium should render the wordmark.
Evidence: `<Text style={[fontExtra, { fontSize: 22, color: '#F5A300',
letterSpacing: 6, marginTop: 24 }]}>ZOPMOP</Text>` at line 171.
```

```
[SEVERITY: High]
[FILE: src/screens/main/ProfileScreen.tsx:405]
[CATEGORY: UI/UX / Brand spelling]
Finding: Profile hero eyebrow reads "ZOPMOP · {roleLabel(role)}".
Should be "ZopMop · …" or rendered as a wordmark glyph.
Impact: Mixed casing across screens dilutes brand identity.
Fix: Replace with "ZopMop" or an SVG wordmark.
Evidence: `<Text style={s.heroEyebrow} numberOfLines={1}>ZOPMOP · …</Text>`
```

```
[SEVERITY: High]
[FILE: src/screens/main/WalletScreen.tsx:269]
[CATEGORY: UI/UX / Brand spelling]
Finding: Wallet hero eyebrow reads "ZOPMOP · WALLET BALANCE".
Same casing violation as above.
Impact: Inconsistent brand across the three primary headered surfaces
(Profile, Wallet, HomeFooter).
Fix: Replace with "ZopMop · WALLET BALANCE" — only the descriptor
should be uppercase, not the brand.
Evidence: `<Text style={s.heroEyebrow}>ZOPMOP · WALLET BALANCE</Text>`
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/ProfileScreen.tsx:316,347]
[CATEGORY: UI/UX / Tagline placement]
Finding: Tagline "Home, handled." only appears in two places inside the
running app: the About modal copy on Profile (line 316) and the
ProfileScreen footer (line 347). It is not present on the splash screen,
the welcome screen, or any onboarding step.
Impact: The brand promise is essentially hidden from new users.
Fix: Surface "Home, handled." on at least SplashScreen and WelcomeScreen,
and ideally in the empty-state copy for the home feed.
Evidence:
- src/screens/main/ProfileScreen.tsx:316 (About modal)
- src/screens/main/ProfileScreen.tsx:347 (footer tagline)
- src/components/home/HomeHero.tsx:64 only uses "Home,\nhandled." between
  12pm and 5pm (afternoon-only headline variant) — i.e. roughly 5/24 of the
  day, brand cadence absent the rest of the time.
```

```
[SEVERITY: Low]
[FILE: src/components/home/HomeHero.tsx:64]
[CATEGORY: UI/UX / Tagline]
Finding: The signature "Home, handled." headline is only emitted by
`headlineFor()` for the 12:00–16:59 window. Morning, evening, and
late-night users see other headlines and never the canonical tagline
inside the home feed.
Impact: Brand line discoverability is gated by time-of-day.
Fix: Either keep "Home, handled." as the immutable headline regardless
of time, or surface it as a static subline beneath the time-of-day
headline so it always appears.
Evidence: `if (hr < 17) return \`Home,\\nhandled.\`;` (line 64).
```

```
[SEVERITY: Nit]
[FILE: src/sdui/allowlist.ts:33]
[CATEGORY: UI/UX / Brand spelling]
Finding: Comment uses lowercase "zopmop" ("data/file/javascript/zopmop and
any custom scheme are blocked"). Cosmetic comment-only issue.
Impact: None — internal comment.
Fix: Capitalise to "ZopMop" in the comment.
Evidence: line 33.
```

### 2. Typography

```
[SEVERITY: Medium]
[FILE: App.tsx:162]
[CATEGORY: UI/UX / Typography]
Finding: `Qurova_500Medium` is loaded via `useFonts` but **never referenced**
anywhere in `src/`. Per user memory, the wordmark should use Qurova; today
the wordmark uses Plus Jakarta Sans ExtraBold instead.
Impact: Wasted font payload at startup; brand wordmark spec unmet.
Fix: Either remove the Qurova font load or wire it into a `<Wordmark>`
component used by HomeFooter / ProfileScreen / WalletScreen.
Evidence:
- App.tsx:162 (`Qurova_500Medium: require('./assets/qurovademomedium-dygo9.otf')`)
- `grep -rn Qurova src/` returns zero matches.
```

```
[SEVERITY: Medium]
[FILE: src/screens/**/*.tsx]
[CATEGORY: UI/UX / Typography]
Finding: 30+ screens declare local `fontMed`, `fontSemi`, `fontBold`,
`fontExtra` constants with raw string literals
(`fontFamily: 'PlusJakartaSans_700Bold'`) instead of importing
`FontFamily` from `src/theme/typography`.
Impact: A future font-family rename requires touching every screen;
typos slip through (e.g. `PlusJakartaSans_700Bold` vs `…_700_Bold`).
Fix: Replace the inline literals with `FontFamily.bold` etc. and delete
the per-screen `fontMed/fontSemi/…` consts in favour of a single shared
helper (or just inline `{ fontFamily: FontFamily.bold }`).
Evidence: ServiceGridSection.tsx:41–44, ReportIssueScreen.tsx:27–29,
YourExpertsScreen.tsx:32–35, AllServicesScreen.tsx:67–70 and at least 25 more
files (`grep -rn "fontFamily: 'PlusJakartaSans"` returns ~40 hits across
src/screens and src/sdui).
```

```
[SEVERITY: Low]
[FILE: src/screens/main/ProfileScreen.tsx:807]
[CATEGORY: UI/UX / Typography]
Finding: A debug/diagnostic text style uses
`fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'`. This is the
only non-Plus-Jakarta fontFamily in user-visible code in src/screens.
Impact: Acceptable for monospace diagnostic blocks but inconsistent with
the design system. Verify it's only used in debug/dev-only surfaces.
Fix: Confirm scope and document via a comment; otherwise wrap in a
`MonoText` primitive that lives next to typography tokens.
Evidence: line 807.
```

### 3. Color tokens & dark-mode adherence

```
[SEVERITY: High]
[FILE: src/screens/**, src/sdui/**]
[CATEGORY: UI/UX / Color tokens]
Finding: 400+ raw hex literals exist inside `src/screens/` (and ~10 inside
`src/sdui/`). 42 distinct screen files use raw hex colors directly instead
of the `C` palette from `src/theme/screen.ts` or `useColors()` from
`ThemeContext`. The values are stable (`#F5A300`, `#FFC042`, `#0A0A0A`,
`#0D0D0F`, `#FFFFFF`, `'rgba(255,255,255,0.x)'`) but copy-pasted across
every screen, so a theme tweak requires editing every file.
Impact: Re-skinning is functionally impossible without a global
search-and-replace; light-mode work (currently deferred) will be a high-touch
migration; subtle drift already exists (e.g. some screens use `#0A0A0A`,
others `#0D0D0F` for "ink"). Tokens already exist in `theme/screen.ts`
— they're just not adopted.
Fix: Phase-1 quick win — replace literals in screens with `C.amber`,
`C.ink`, `C.white`, `C.text`, `C.textMuted`, `C.glass`, etc. Phase-2 —
wire all dark screens through `useColors()` so light/dark can be flipped
on day-one of the light-mode push.
Evidence (sample):
- src/screens/main/CartScreen.tsx:840 `backgroundColor: '#FFFFFF'`
- src/screens/main/CartScreen.tsx:949 `else '#F5A300'`
- src/screens/main/CartScreen.tsx:1009 `color: '#FFFFFF'`
- src/sdui/sections/ServiceGridSection.tsx:185,220,240,255,269,312,313
- Affected file list (42 screens):
  HiZopScreen, LocationCheckScreen, NameEntryScreen, NotServiceableScreen
  (auth + main duplicates), OTPVerificationScreen, PhoneEntryScreen,
  RoleSelectionScreen, BackendDownScreen, ActiveBookingScreen,
  AddressesScreen, AllServicesScreen, BookingConfirmedScreen,
  BookingRateScreen, BookingsScreen, CartScreen, ChatScreen,
  HelpSupportScreen, HomeScreen, ManageHouseholdScreen, OffersScreen,
  PaymentScreen, ProfileScreen, ReferralEarnScreen, ReferralInviteScreen,
  ReportIssueScreen, RoomiesCodeShareScreen, RoomiesJoinScreen,
  RoomiesSetupScreen, RoomiesWelcomeScreen, ServiceAboutScreen, TipScreen,
  TrackLiveScreen, WalletScreen, WalletTopupSheet, YourExpertsScreen,
  ProActiveScreen, ProDashboardScreen, ProDeclareLeaveScreen,
  ProLeaveHistoryScreen, ProMatchedScreen, ProOnboardingScreen,
  ProScheduledInviteScreen.
```

```
[SEVERITY: Medium]
[FILE: src/components/PrimaryButton.tsx:22-27]
[CATEGORY: UI/UX / Color tokens]
Finding: `PrimaryButton` redeclares a local `C` palette
(`amber/amberHi/amberLo/ink`) instead of importing from
`src/theme/screen.ts`. This is the source-of-truth for the brand-amber
gradient — duplicating it risks drift if the theme is ever tweaked.
Impact: Theme changes in `theme/screen.ts` won't propagate to the primary
CTA. Low risk today (values match), but fragile.
Fix: `import { C } from '../theme/screen'` and remove the local const.
Evidence: lines 22-27.
```

```
[SEVERITY: Medium]
[FILE: src/components/EmptyState.tsx:75,82]
[CATEGORY: UI/UX / Color tokens / Dark mode]
Finding: Empty state title is hard-coded `color: '#FFFFFF'` and subtitle
`color: 'rgba(255,255,255,0.55)'`. Acceptable for the locked dark theme
but invisible on a hypothetical light surface.
Impact: When light mode is re-enabled, `<EmptyState>` will be unreadable.
Fix: Pull through `useColors()` or default to `C.text`/`C.textSecondary`
so the primitive flips automatically.
Evidence: lines 72-86.
```

```
[SEVERITY: Low]
[FILE: src/screens/booking/ActiveBookingScreen.tsx:455-456]
[CATEGORY: UI/UX / Dark mode adherence]
Finding: Status badge backgrounds resolve to `c.white` which on the dark
theme is `#1E293B` (slate 800) — fine. But the status text colors use the
**light** primary/success palette values via `useColors()` which on the
dark theme map to brighter variants (`#818CF8`/`#34D399`). Mixing dark
slate-800 surface + light-mode hex everywhere else in this screen makes the
glassmorphism inconsistent: most of the app is `#0A0A0A` matte, this screen
shows slate panels.
Impact: ActiveBookingScreen reads as a different visual language from
HomeScreen, CartScreen, ProfileScreen.
Fix: Move ActiveBookingScreen onto the `C` palette from `theme/screen.ts`
(matte black + glass) instead of the `useColors()` indigo/slate.
Evidence: lines 451-462 (createStyles), background uses `c.white`
(=slate 800), accents use `c.primary` (=indigo 400).
```

### 4. Spacing scale

```
[SEVERITY: Medium]
[FILE: src/screens/**/*.tsx]
[CATEGORY: UI/UX / Spacing tokens]
Finding: Only 8 of 49 screens import `Spacing` from `src/theme`. The rest
use bare pixel literals (`paddingHorizontal: 16`, `marginTop: 24`,
`gap: 12`, etc). Most numbers happen to align with the scale
(4/8/12/16/20/24/32/40/48/64) but several screens drift to off-scale values
(`paddingVertical: 18`, `marginTop: 18`, `paddingBottom: 14`).
Impact: Inconsistent vertical rhythm across screens; tweaking spacing
requires touching every literal.
Fix: Migrate to `Spacing.xs|sm|md|base|lg|xl|2xl|3xl|4xl|5xl`. Flag any
off-scale literals to either round to the scale or extend the scale.
Evidence: 41 screen files contain zero references to `Spacing.`. Quick
sample: AllServicesScreen.tsx, BookingsScreen.tsx, ChatScreen.tsx,
ProfileScreen.tsx, CartScreen.tsx all use raw integers throughout.
```

### 5. Buttons & interactive states

```
[SEVERITY: Low]
[FILE: src/screens/**/*.tsx]
[CATEGORY: UI/UX / Interactive states]
Finding: TouchableOpacity `activeOpacity` values are inconsistent: most use
`0.75`–`0.9`, a handful use `1` (intentional for modal backdrops). No
violations found of opacity below `0.7`.
Impact: Cosmetic — the variance between 0.75 and 0.9 is barely perceptible.
Fix: Standardise on `activeOpacity={0.8}` for content and `0.9` for the
gradient CTA (already used by PrimaryButton); document the convention.
Evidence: grep `activeOpacity=` returns 200+ matches with values
{0.7, 0.75, 0.8, 0.85, 0.9, 1}. The "0.7 = standard" goal in the
audit prompt is not actually the de facto value used.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/ProfileScreen.tsx:407, src/components/home/HomeHeader.tsx, etc.]
[CATEGORY: UI/UX / Touch targets]
Finding: Several icon-only Touchables have layout sizes below the 44pt
recommended minimum and rely on `hitSlop` for compliance. Found 21 uses
of `hitSlop` across `src/`, which is good — but multiple icon buttons
(`width: 28 / 32 / 40` round Touchables) appear in `ProMatchedScreen.tsx:337`,
`ProLeaveHistoryScreen.tsx:80`, `ProDashboardScreen.tsx:854`, the
`heroEdit` button in ProfileScreen, and the back button in
ActiveBookingScreen.tsx:298. Several rely on the visual size without
a `hitSlop`.
Impact: Accessibility — finger-fat targets miss; iOS HIG recommends 44pt.
Fix: Add `hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}` (or 12)
to every icon-only Touchable smaller than 44pt and audit ProLeaveHistory
back button (`<View style={{ width: 28 }} />` is a placeholder so OK).
Evidence: above file:line list.
```

```
[SEVERITY: Low]
[FILE: src/components/PrimaryButton.tsx]
[CATEGORY: UI/UX / Pressed state]
Finding: PrimaryButton has `disabled`, `isLoading`, and a static `disabled`
style — but no distinct **pressed** state beyond the default
`activeOpacity={0.9}`. The amber gradient doesn't visibly compress or
darken on press.
Impact: On-press feedback is subtle on the brightest CTA in the app.
Fix: Add a pressed scale (`Animated.spring` to 0.97) or swap to
`Pressable` with a `pressed` style that boosts `amberLo`.
Evidence: lines 50-77.
```

### 6. Empty states

```
[SEVERITY: High]
[FILE: src/screens/main/HomeScreen.tsx:539]
[CATEGORY: UI/UX / Empty states]
Finding: `HomeScreen` renders the SDUI sections through a `FlashList` but
provides **no `ListEmptyComponent`**. When the SDUI payload is empty (e.g.
backend returns no sections) the screen shows just the hero + a blank
space below.
Impact: Backend hiccups produce a confusing dead screen with no message,
no retry, no fallback content.
Fix: Add a `ListEmptyComponent` that renders `<EmptyState title="Nothing
to show yet" subtitle="Pull to refresh" />` (the EmptyState primitive
already exists).
Evidence: `<FlashList … />` at line 539 has no `ListEmptyComponent` prop.
```

```
[SEVERITY: High]
[FILE: src/screens/main/ReferralInviteScreen.tsx:148]
[CATEGORY: UI/UX / Empty states]
Finding: Referral invite list uses `FlatList` with no `ListEmptyComponent`.
A new user with zero referral history sees blank space.
Impact: Empty-screen confusion on first-use.
Fix: Add `ListEmptyComponent={<EmptyState title="No referrals yet" …>}`.
Evidence: `<FlatList … />` at line 148.
```

```
[SEVERITY: Medium]
[FILE: src/components/ZopBookingsList.tsx:31]
[CATEGORY: UI/UX / Empty states]
Finding: `ZopBookingsList` (used inside the Zop AI bookings carousel)
wraps a `FlatList` with no `ListEmptyComponent`. Empty state is handled
by callers (or not).
Impact: Inconsistent empty handling for AI assistant surfaces.
Fix: Either accept an optional `emptyText`/`emptyNode` prop and pass it
through to `ListEmptyComponent`, or have the caller always pass it.
Evidence: line 31.
```

```
[SEVERITY: Low]
[FILE: src/components/ZopChat.tsx:452]
[CATEGORY: UI/UX / Empty states]
Finding: The Zop chat `FlatList` (line 452) has no `ListEmptyComponent`.
Acceptable because chat opens with quick replies + a greeting, but worth
adding a defensive empty state for first-render flashes.
Impact: Minor — momentary blank list on cold open.
Fix: Add a hidden-by-default empty component or render quick replies as
the empty state.
Evidence: line 452.
```

### 7. Error states & retry

```
[SEVERITY: High]
[FILE: src/screens/pro/ProDashboardScreen.tsx:91,159,333,348,388]
[CATEGORY: UI/UX / Error UI]
Finding: 5+ `.catch(() => {})` swallows on the Pro dashboard. Stats load,
location flush, and FCM token registration all silently drop errors with
no surface in the UI. Pro is left wondering why numbers are stale.
Impact: Pros can't tell when their dashboard is showing cached vs live
data; ops team can't triage from screenshots.
Fix: Replace empty catches with `setError(...)` + a visible banner or
toast. Cross-reference user-memory item `project_pro_audit_2026_05_12`
which already calls out "stats row API" as one of two deferred fixes.
Evidence:
- line 91 `getHelperStats(token).then(setStats).catch(() => {})`
- line 159 `.catch(() => {})`
- line 333 `}).catch(() => {})`
- line 348 `flushLocationPingQueue(token).catch(() => {})`
- line 388 `getHelperStats(token!).then(setStats).catch(() => {})`
```

```
[SEVERITY: High]
[FILE: src/screens/main/* (10 files)]
[CATEGORY: UI/UX / Error UI]
Finding: 10 customer-facing screens have no "retry" affordance in any
state: ReportIssueScreen, NotServiceableScreen, YourExpertsScreen,
BookingRateScreen, AllServicesScreen, RoomiesJoinScreen,
ReferralInviteScreen, OffersScreen, CartScreen, HelpSupportScreen.
Several of these do async work (YourExpertsScreen, AllServicesScreen,
OffersScreen, ReferralInviteScreen, CartScreen) and can land in an error
state with no path forward besides backing out.
Impact: When the backend hiccups or the device is offline, the user is
stuck on a blank or partially-loaded screen.
Fix: Standardise on a `<ErrorRetry message onRetry />` primitive used by
WalletScreen / ReferralEarnScreen / ChatScreen (which already have retry).
Evidence: `grep -rL "retry\|Retry\|reload" src/screens/main/` returns
the 10 files above.
```

```
[SEVERITY: Medium]
[FILE: src/utils/haptics.ts:4-6, src/context/AuthContext.tsx (12 sites)]
[CATEGORY: UI/UX / Error handling]
Finding: AuthContext silently swallows 12 SecureStore errors and Haptics
swallows feedback errors. The Haptics silencing is fine; AuthContext's
silent token-write failures could leave users unable to persist sessions
without any UI indication.
Impact: A device with locked Keychain (rare) auth-loops forever.
Fix: At minimum log via the analytics logger; ideally surface a one-time
banner if SecureStore writes repeatedly fail.
Evidence: AuthContext.tsx lines 247, 251, 269, 303, 317, 319, 326, 334-336,
340, 350. Haptics file lines 4-6.
```

### 8. Trust signals

```
[SEVERITY: High]
[FILE: src/screens/booking/ActiveBookingScreen.tsx:329-341]
[CATEGORY: UI/UX / Trust signals]
Finding: The Pro card on ActiveBookingScreen shows only name, initial
avatar, and a single rating value. No verified-pro badge, no response-time
indicator, no completed-jobs count, no profile/background-check icon.
Impact: The single most anxious moment in the user journey (waiting for a
stranger to arrive at their home) is exactly when trust signals matter
most.
Fix: Add a "verified ✓" badge next to the name when
`booking.helper_verified === true`, surface response-time (`< 5 min avg`)
and total completed jobs (`1,200+ jobs`). Source data exists on the
helper model — see prior audits.
Evidence: lines 329-341. Compare with HomeFooter.tsx:105 which already
renders the aggregate trust strip ("8,400+ verified pros / 100% / 60 sec
avg booking") — the same metaphor must extend to the individual pro.
```

```
[SEVERITY: Medium]
[FILE: src/screens/pro/ProProfileScreen.tsx]
[CATEGORY: UI/UX / Trust signals]
Finding: ProProfileScreen does not currently surface verification status,
background-check status, or training/badge progress in a structured trust
panel. (Spot-check shows mostly profile fields and stats.) The pro-side
equivalent of "you can trust this customer" is also absent for the helper.
Impact: Pros can't tell at-a-glance which trust badges they've earned.
Fix: Add a Verification panel (KYC ✓, training ✓, background check ✓,
top-rated ✓) with explicit empty states for the unearned ones.
Evidence: file inspection — no "verified" / "badge" UI hits in
ProProfileScreen.tsx by grep.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/BookingsScreen.tsx:540]
[CATEGORY: UI/UX / Trust signals]
Finding: Bookings list item renders rating as a star + number string but
not as a structured component. Inconsistent across the app — sometimes
`★ 4.9`, sometimes a styled badge, sometimes a `SvgIcon name="star-filled"`.
Impact: Trust UI feels hand-rolled per screen.
Fix: Build a `<RatingBadge value={4.9} count={120} />` shared component
and use it in BookingsScreen, ActiveBookingScreen, ServiceAboutScreen,
ProProfileScreen, YourExpertsScreen.
Evidence: line 540 vs ActiveBookingScreen.tsx:336-339 vs
ServiceAboutScreen.tsx:201 — all three render ratings differently.
```

### 9. Mascot (Zop) usage

```
[SEVERITY: High]
[FILE: src/screens/auth/SplashScreen.tsx:23, HiZopScreen.tsx:48, ZopIntroScreen.tsx:25, WelcomeScreen.tsx:75, NameEntryScreen.tsx:122, PhoneEntryScreen.tsx:160, OTPVerificationScreen.tsx:253]
[CATEGORY: UI/UX / Mascot proportions]
Finding: All 7 mascot Lottie views use `resizeMode="cover"`. On
non-design-aspect-ratio devices (tall phones, foldables, tablets) `cover`
crops the Lottie composition — meaning the mascot can be cut off,
zoomed, or have its proportions effectively distorted because the
composition viewBox no longer matches the rendered area.
Impact: On the Zop SE/X/13mini and on tablets the mascot may render with
the head clipped or limbs cropped — a brand violation per user memory
("Proportions must not be distorted").
Fix: Switch to `resizeMode="contain"` (preferred for brand assets) and
size the container to the Lottie's intrinsic aspect ratio
(`aspectRatio: <w/h>` in the style). If `cover` is required for hero
fullscreens to fill the viewport, document the design intent in a comment
and verify on smallest/largest devices.
Evidence: see file:line list above; all 7 use `resizeMode="cover"`.
```

```
[SEVERITY: Medium]
[FILE: src/components/EmptyState.tsx:38-43]
[CATEGORY: UI/UX / Mascot usage]
Finding: Default empty-state Lottie is `lookaway.lottie`. It renders at a
fixed `width: 180, height: 180` square — fine — but with no
`resizeMode`, so default `cover` applies. If the Lottie composition isn't
square the mascot is squashed.
Impact: Subtle distortion in every empty-state surface that uses the
default lottie.
Fix: Add `resizeMode="contain"` to LottieView.
Evidence: lines 37-43.
```

### 10. Emoji-as-icon

```
[SEVERITY: Medium]
[FILE: src/screens/main/ServiceAboutScreen.tsx:190,347]
[CATEGORY: UI/UX / Emoji-as-icon]
Finding: ServiceAboutScreen falls back to emoji literals as UI icons:
`<Text style={s.overviewEmoji}>{service.emoji ?? '🧹'}</Text>` and
`<Text style={s.addonEmoji}>{addon.emoji ?? '✨'}</Text>`.
The `service.emoji ?? ` part is data-driven (tolerated per user memory
`project_svg_icons_revamp`) but the **hard-coded fallback emojis**
(`🧹`, `✨`) are UI-as-icon, which violates `feedback_no_emojis`.
Impact: Inconsistent icon rendering across platforms (Android emojis
look different from iOS); breaks the Feather-icon-only rule.
Fix: Replace the hard-coded fallbacks with a SvgIcon (`<SvgIcon name="…" />`)
so the fallback path doesn't ship emoji glyphs.
Evidence: lines 190, 347.
```

```
[SEVERITY: Medium]
[FILE: src/screens/pro/ProOnboardingScreen.tsx:35-40, 271, 306]
[CATEGORY: UI/UX / Emoji-as-icon]
Finding: Pro service-category picker uses emoji literals as the picker
icons (🏠/🍳/👕/🐾/🌿/🚗) and the success checkmark is the unicode `✓`
character at lines 271 and 306. Per user memory this is the same icon
swap waiting for 3D icons — flag explicitly.
Impact: Pro onboarding doesn't yet have the planned 3D icon set.
Fix: Replace with SVG/3D icons when ready; in the interim use Feather
`check` instead of `✓` for the success-tick affordance.
Evidence: lines 35-40 (data block), 271, 306.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/ServiceAboutScreen.tsx:201, BookingRateScreen.tsx:177, AllServicesScreen.tsx:610, BookingsScreen.tsx:540,741, YourExpertsScreen.tsx:157, sdui/sections/ServiceGridSection.tsx:220]
[CATEGORY: UI/UX / Emoji-as-icon]
Finding: Star-rating glyphs (`★`) are used as Text everywhere. Most
surfaces use `<SvgIcon name="star-filled" />` (e.g. ActiveBookingScreen)
but 7 surfaces still use the unicode glyph in a `<Text>`.
Impact: Inconsistent stroke weight across screens; the unicode glyph
can't be partially-filled for fractional ratings.
Fix: Use `<SvgIcon name="star-filled" />` (already in the icon set) or a
shared `<RatingBadge>` (see Trust Signals finding).
Evidence: file:line list above.
```

### 11. Loading & skeleton consistency

```
[SEVERITY: Medium]
[FILE: src/screens/main/* (multiple)]
[CATEGORY: UI/UX / Loading states]
Finding: Loading UI is split three ways: dedicated `Skeleton*` components
(`HomeScreenSkeleton`, `BookingsScreenSkeleton`, `CartScreenSkeleton`,
`LoadingSkeleton`), generic `<ActivityIndicator>` (used by PaymentScreen,
WalletTopupSheet, ReferralEarnScreen, ReferralInviteScreen, OffersScreen),
and per-screen ad-hoc `LoadingBars` (ActiveBookingScreen).
Impact: Inconsistent perceived performance and visual language.
ActivityIndicator users feel "older" / "less polished" than the skeleton
users.
Fix: Standardise on the skeleton pattern for first-paint and `LoadingBars`
(amber-bars primitive) for inline / button-internal spinners. Remove
`ActivityIndicator` references in the 5 files listed.
Evidence:
- ActivityIndicator: PaymentScreen.tsx:269,288; WalletTopupSheet.tsx:219;
  ReferralEarnScreen.tsx:136; ReferralInviteScreen.tsx:142,205;
  OffersScreen.tsx:180.
- Skeleton: HomeScreen, BookingsScreen, CartScreen, AddressesScreen,
  AllServicesScreen, ChatScreen, ManageHouseholdScreen, YourExpertsScreen,
  ServiceAboutScreen, ProDeclareLeaveScreen, ProLeaveHistoryScreen.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/PaymentScreen.tsx:269,288 / WalletTopupSheet.tsx:219]
[CATEGORY: UI/UX / Loading states]
Finding: `ActivityIndicator` color hard-coded to `#F5A300` / `#0D0D0F`
instead of using `C.amber` / `C.ink`. Same drift pattern as the color
finding.
Impact: As above.
Fix: Replace with `LoadingBars color={C.amber} />` and pull tokens.
Evidence: lines listed.
```

### 12. Dark-mode adherence (creep)

```
[SEVERITY: Medium]
[FILE: src/screens/booking/ActiveBookingScreen.tsx]
[CATEGORY: UI/UX / Dark mode]
Finding: ActiveBookingScreen uses `useColors()` (theme-aware) rather than
the locked dark palette `C` from `theme/screen.ts`. The result: when the
device is in dark mode, the booking sheet renders on slate-800 (not the
matte black used by HomeScreen, CartScreen, etc.); when light mode is
re-enabled, this screen will flip independently of the other screens,
which are hard-coded dark.
Impact: Visual incoherence between Home → ActiveBooking → Cart flows.
Fix: Pick one — either migrate everything to `useColors()` (the right
long-term answer) or hard-pin ActiveBookingScreen to `C` like the rest of
the dark screens until light mode is fully scoped.
Evidence: ActiveBookingScreen.tsx imports `useColors` and constructs styles
via `createStyles(c)`. Compare with HomeScreen / CartScreen / WalletScreen
which use `C` from `theme/screen.ts`.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/* (auth + main folders)]
[CATEGORY: UI/UX / Dark mode]
Finding: ~20 screens still pull from `useColors()` (light/dark) while
the dark-glassmorphism screens use the static `C` palette. Per user memory
`project_design_conventions` the locked-dark pattern is the convention
for migrated screens; the `useColors()` screens are the unmigrated ones.
Impact: Two parallel theme paradigms in the codebase; new contributors
won't know which to use.
Fix: Document the migration boundary in `src/theme/README.md` (does not
exist) or in `theme/screen.ts`. Track which screens are migrated vs not.
Evidence: 63 `useColors|useTheme` hits across screens (mostly older
screens) vs the dark-locked screens that use `C` directly.
```

### 13. Misc / Nits

```
[SEVERITY: Nit]
[FILE: src/components/PrimaryButton.tsx:3]
[CATEGORY: UI/UX / Code hygiene]
Finding: Stray blank line/whitespace at line 3 inside the
react-native import block.
Impact: None.
Fix: Drop the blank line.
Evidence: blank line between `import React` and `import { … }`.
```

```
[SEVERITY: Nit]
[FILE: src/screens/main/CartScreen.tsx:840-841]
[CATEGORY: UI/UX / Color drift]
Finding: Cart trash-button render uses `backgroundColor: '#FFFFFF'` over a
dark surface — and the shadow is `shadowColor: '#000'` instead of
`C.ink`. Cosmetic.
Impact: Cosmetic; values match the convention.
Fix: Replace with `C.white` and `C.ink`.
Evidence: lines 840-841.
```

```
[SEVERITY: Nit]
[FILE: src/screens/auth/HiZopScreen.tsx:88]
[CATEGORY: UI/UX / Color drift]
Finding: HiZopScreen CTA shadow uses `shadowColor: '#000'`. Should use
`C.ink` for consistency.
Impact: Cosmetic.
Fix: Token swap.
Evidence: line 88.
```

---

## Cross-references to prior audits

- Prior audit `project_pro_audit_2026_05_12` already calls out the
  "stats row API" silent-failure pattern in ProDashboardScreen — this
  audit confirms the swallowed `.catch(() => {})` instances at
  lines 91, 159, 333, 348, 388 are still present.
- User memory `project_svg_icons_revamp` already flags that 14 placeholder
  SVG icons and service-category emojis are pending 3D icon swap — this
  audit confirms and locates the emoji literals still in code.
- User memory `feedback_no_emojis` was reinforced — only the
  data-driven `service.emoji` field is borderline-tolerated; hard-coded
  fallback emojis (`🧹`, `✨`) and `✓` glyphs should be replaced now.
- Prior audit `AUDIT_2025_2026-05-03.md` (top-level) — recommend
  cross-checking whether the raw-hex / no-token issue was already
  documented there to avoid duplicate counting in the consolidation step.

---

## QUESTIONS FOR ADITYA

1. **Tagline placement.** Is the deliberate decision to only show
   "Home, handled." between 12pm and 5pm a marketing call, or a bug?
   If marketing wants the tagline always-visible, the headline rotation
   needs to change.
2. **Wordmark casing.** Is "ZOPMOP" (all caps with letter-spacing) the
   intentional wordmark style? It contradicts the brand spec which
   requires "ZopMop" mixed case, but it's currently shipping in three
   prominent places (HomeFooter, ProfileScreen hero, WalletScreen hero).
3. **Qurova font.** Should we cut the Qurova font load entirely or
   wire it into a `<Wordmark>` component? Today it's loaded at startup
   but never used.
4. **`useColors()` vs `C` palette.** Per `project_design_conventions`
   the locked-dark `C` palette is canonical for migrated screens, but
   ActiveBookingScreen + ~20 others still go through `useColors()`.
   Confirm migration plan and target date so this audit can mark them
   as "deferred, tracked" vs "violation".
5. **Trust signals on Pro cards.** Confirm the data model exposes
   `helper_verified`, `helper_completed_jobs`, `helper_response_minutes`
   on the active booking payload so the trust panel can be built without
   a backend change.
