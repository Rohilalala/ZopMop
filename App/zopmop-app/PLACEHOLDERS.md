# ZopMop App Placeholder Audit

Audit date: 2026-05-08
Branch: feature/sdui
Scope: `App/zopmop-app/src/` (React Native + Expo)
Method: keyword grep + screen-by-screen reading. Backend (Go), design system, fonts and colors are out of scope.

---

## 1. Summary

Total entries cataloged: **62**.

By category:

| # | Category | Count |
|---|----------|-------|
| 1 | Dummy display data (counts/badges/names) | 14 |
| 2 | Lorem / filler prose | 0 |
| 3 | Dev shortcuts visible in UI | 0 (Firebase `appVerificationDisabledForTesting` is `__DEV__`-gated, low risk) |
| 4 | TODO / FIXME copy in user-visible strings | 0 in UI text; 4 in code comments (no user impact) |
| 5 | Generic stub strings | 4 |
| 6 | i18n / interpolation leaks | 0 |
| 7 | Wrong default avatars / images | 0 (mascot-based fallbacks are intentional) |
| 8 | Hardcoded test entities | 1 (`tel:+911800000000` in Help) |
| 9 | Empty-state copy that's wrong | 0 (all empty-state copy reads as intentional UX) |
| 10 | Debug labels visible to users | 0 |
| 11 | Truncated / WIP copy | 6 (Coming-soon shortcuts) |
| 12 | Brand consistency (ZopMop variants) | 12 |

Top 3 most-affected screens:
1. `src/screens/main/ProfileScreen.tsx` — 14 entries (the known offender; full hero + every meta line is hardcoded)
2. `src/screens/main/TrackLiveScreen.tsx` — 7 entries (Priya M., 4.9, 312 jobs, 1.2 km, 9:35 AM, "accepted in 12 sec", `~6 min`)
3. `src/screens/main/BookingConfirmedScreen.tsx` — 4 entries ("In ~6 min" hardcoded, helperRating fallback `4.9`, scheduled "Matching tomorrow morning" copy, ReferNudge ₹100)

Plus a recurring brand bug: **WalletScreen, WalletTopupSheet, theme/colors.ts, useCashfreePayment.ts and api/wallet.ts** all spell the brand "Zopmop" (sentence-case) instead of "ZopMop". Two of those (`s.sub` line 159 and `Row` line 221 of WalletScreen) ship in user-visible copy.

---

## 2. By Severity

### SHIP-BLOCKERS — visible in first 5 minutes / on every login

| # | File:line | Current text | Where it shows | Suggested fix |
|---|-----------|--------------|----------------|---------------|
| S1 | `src/screens/main/ProfileScreen.tsx:318` | `const bookingsLabel = '14 bookings';` | Profile hero, chip below avatar | Wire to `user.completed_bookings_count` from `getMe`. Backend may need to expose count. |
| S2 | `src/screens/main/ProfileScreen.tsx:384` | `<Text style={s.chipText}>Active member</Text>` | Profile hero, status chip | Drop pill OR derive from `user.status` / membership tier. Currently always renders for everyone, including brand-new accounts. |
| S3 | `src/screens/main/ProfileScreen.tsx:344` | `ZOPMOP · {roleLabel(role)}` | Profile hero eyebrow | Eyebrow text itself is fine; the underlying badge styling is built around it being permanent. Verify product wants it on for free `MEMBER` role. |
| S4 | `src/screens/main/ProfileScreen.tsx:222` | `meta="Home · Work · 1 more"` | Account → Saved Addresses row | Compute from `listAddresses(token)` length & tags; fresh accounts have 0. |
| S5 | `src/screens/main/ProfileScreen.tsx:229` | `meta="3 members · split bills automatically"` | Account → Roomies row | Use `myGroup.members.length` from `useRoomies()`; show "Not joined yet" for fresh accounts. |
| S6 | `src/screens/main/ProfileScreen.tsx:236` | `meta="5 favorite pros"` | Account → Your Experts row | Wire to `listExperts(token).length`; show "0 of 5" or "Add after a service" for fresh accounts. |
| S7 | `src/screens/main/ProfileScreen.tsx:243` | `meta="Push · WhatsApp · Email"` | Account → Notifications row | Backend has no notification-prefs endpoint yet — show "Manage delivery channels" or hide the meta line entirely until wired. |
| S8 | `src/screens/main/ProfileScreen.tsx:211` | `meta="30 min before booking"` | Preferences → Reminders row | Pull from real reminder-prefs setting (none exists yet — backend work needed). |
| S9 | `src/screens/main/ProfileScreen.tsx:406` | `pip: 2,` (Bookings rail) | Profile, Bookings tile pip | Wire to upcoming-bookings count from `getBookings({status:'upcoming'})`. |
| S10 | `src/screens/main/ProfileScreen.tsx:418` | `pip: 3,` (Offers rail) | Profile, Offers tile pip | Wire to active-offers count (currently the OFFERS const has 3 entries — see S22). |
| S11 | `src/screens/main/ProfileScreen.tsx:105` | `Alert.alert('Log out of ZopMop?', ...)` | Logout confirm modal | OK as-is (canonical brand). |
| S12 | `src/screens/main/ProfileScreen.tsx:257` | `'ZopMop · v1.0.0\nHome, handled.'` | About ZopMop info modal | Pull `v1.0.0` from `Constants.expoConfig.version` so it tracks releases. |
| S13 | `src/screens/main/ProfileScreen.tsx:264` / `:271` | `showInfo('Coming soon.', { title: 'Terms of Service' })` and same for Privacy Policy | Profile → Info & Legal rows | Either hide the rows or open the existing URLs from `OTPVerificationScreen.tsx:34-35` (`https://zopmop.com/privacy`, `…/terms`) via `Linking`. |
| S14 | `src/screens/main/ProfileScreen.tsx:196` | `'Share ZopMop with friends — you both earn ₹100 in wallet credit. Coming soon.'` | Profile referral ticket info modal | Either wire to a real referral URL/share intent or remove the ticket until ready. |
| S15 | `src/screens/main/ProfileScreen.tsx:466` | `<Text style={s.ticketTitle}>Earn ₹100</Text>` and `s.ticketSub: per friend who joins ZopMop` | Profile referral ticket | Same as S14. Hardcoded reward amount; should pull from a remote-config / promos endpoint. |
| S16 | `src/screens/main/ProfileScreen.tsx:171` | `showInfo('Reach support from the Help screen.', { title: 'Help' })` | Profile top-right help icon | Either route to `HelpSupport` directly or remove. The button currently no-ops. |
| S17 | `src/screens/main/ProfileScreen.tsx:245` | `showInfo('Notification settings are coming soon.', { title: 'Notifications' })` | Profile → Notifications row | Same as S7 — needs backend prefs endpoint. |
| S18 | `src/screens/main/HomeScreen.tsx:286` | `let name = 'Sector 51, Gurugram';` | First-load Home location chip if the user denies location permission | Show "Set your address" or last-known city instead of a hardcoded sector. |
| S19 | `src/screens/main/HomeScreen.tsx:82-83` | `DEFAULT_LAT = 28.4357; DEFAULT_LON = 77.0763;` | Used for first-fetch SDUI page when geocoding fails | Coordinates are hardcoded to Gurugram. Acceptable as fallback ONLY if accompanied by an explicit "Set your location" prompt; otherwise the page will fetch services for an area the user is not in. |
| S20 | `src/components/home/HomeFooter.tsx:103` | `<TrustCol top="8,400+" label="verified pros" />` | Home footer trust strip | The "8,400+" / "100%" / "60 sec" stats are entirely fabricated for a brand-new app. Either pull from a real /stats endpoint, scale-down ("400+"), or remove the strip. |
| S21 | `src/components/home/HomeFooter.tsx:105` | `top="100%" label='satisfaction\nor re-clean free'` | Home footer trust strip | Backed only by marketing copy; flag for product review before launch. |
| S22 | `src/components/home/HomeFooter.tsx:107` | `top="60 sec" label="avg. booking"` | Home footer trust strip | Same as S20. |
| S23 | `src/screens/main/OffersScreen.tsx:52-83` | Hardcoded `OFFERS: Offer[] = [...]` (WARDROBE10, KIT10, FIRST50) | Entire Offers list and "Apply" coupon flow | Move to BFF — `GET /offers` — so coupons can be added/expired without app updates. Currently a coupon never marked "expired" can be applied indefinitely; backend must validate at booking. |
| S24 | `src/screens/main/HelpSupportScreen.tsx:71` | `Linking.openURL('tel:+911800000000')` | Help & support → Call us | `+911800000000` is a placeholder number. Replace with the real support line or hide the row. |
| S25 | `src/screens/main/HelpSupportScreen.tsx:64` | `showInfo('Live chat is coming soon.', { title: 'Chat' })` | Help & support → Live chat row | Hide the row OR ship a simple "submit a ticket" form until live chat is wired. |
| S26 | `src/screens/main/HelpSupportScreen.tsx:31-48` | `FAQS` array hardcoded (4 entries) | Help → FAQ list | Acceptable for v1, but flag — should be a CMS-driven endpoint long-term. |
| S27 | `src/screens/auth/LocationCheckScreen.tsx:377` | `<Text style={styles.comingSoon}>Coming soon</Text>` | City picker (auth flow) for unsupported cities | Wording is OK; depends on `serviceability.ts` ALL_KNOWN_CITIES list being kept current. |
| S28 | `src/screens/auth/NotServiceableScreen.tsx:68` | `<Text style={s.comingSoon}>More cities coming soon</Text>` | Not-serviceable splash | OK as static brand copy. |
| S29 | `src/screens/auth/NotServiceableScreen.tsx:71` | `<Text style={s.badgeText}>Currently serving Gurugram</Text>` | Not-serviceable splash | Hardcoded to single city. As ZopMop expands this needs to come from `ALL_KNOWN_CITIES.filter(c=>c.serviceable)`. |
| S30 | `src/screens/main/BookingConfirmedScreen.tsx:833` | `value="In ~6 min"` | Instant-booking confirmation, "When" detail tile | Should be backend-supplied ETA, not a hardcoded `6`. Falls through to this on every instant booking. |

### PRE-LAUNCH FIXES — secondary flows, less-trafficked screens

| # | File:line | Current text | Where it shows | Suggested fix |
|---|-----------|--------------|----------------|---------------|
| P1 | `src/screens/pro/ProDashboardScreen.tsx:371` | `<StatCard icon="⭐" label="Rating" value="4.9" />` | Pro dashboard, top stats row | Hardcoded `4.9`. Wire to helper's actual rating from `/helpers/me`. The other two cards (`Jobs Done="—"`, `Earned="₹—"`) correctly show em-dash for missing data; Rating should match. |
| P2 | `src/screens/main/TrackLiveScreen.tsx:107` | `helperName = 'Priya M.',` (default param) | Live tracking, when route param missing | Should never default to a fake name. Render "Your pro" or skip until WS delivers. |
| P3 | `src/screens/main/TrackLiveScreen.tsx:109` | `helperRating = 4.9,` (default) | Live tracking pro-row rating | Same — show stars only when known. |
| P4 | `src/screens/main/TrackLiveScreen.tsx:110` | `helperJobs = 312,` (default) | Live tracking pro-row "X jobs" | Same — render only when value is real. |
| P5 | `src/screens/main/TrackLiveScreen.tsx:111` | `paramDistanceKm = 1.2,` | Live tracking pin pill + step row | Should hide until tracking WS reports a value (currently shows "1.2 km" before any data arrives). |
| P6 | `src/screens/main/TrackLiveScreen.tsx:454` | `sub={`${helperName.split(' ')[0]} accepted in 12 sec`}` | Tracking timeline → Booking confirmed step | "12 sec" is fabricated. Either hide the sub or compute from real `accepted_at - created_at` from booking record. |
| P7 | `src/screens/main/TrackLiveScreen.tsx:455` | `time="9:35 AM"` | Same step, time column | Hardcoded — must be `booking.accepted_at` formatted. |
| P8 | `src/screens/main/TrackLiveScreen.tsx:67` | `DEFAULT_REGION` Bangalore-ish | Map fallback while tracking lands | Acceptable fallback; only visible for ~1 frame before WS lands. Low risk. |
| P9 | `src/screens/main/TrackLiveScreen.tsx:406` | `<Text style={[fontExtra, styles.badgeText]}>TOP PRO</Text>` | Tracking pro-row badge | Always renders. Should derive from `helper.is_top_pro` flag (no such field today). |
| P10 | `src/screens/main/BookingConfirmedScreen.tsx:977` | `{(helperRating ?? 4.9).toFixed(1)} · Verified` | Booking confirmed pro-mini, instant variant | Drop the `4.9` fallback; show "—" or hide the row when rating unknown. |
| P11 | `src/screens/main/BookingConfirmedScreen.tsx:951` | `Matching tomorrow morning` | Scheduled-booking confirmation pro-mini | Static copy — acceptable but verify with product (the booking might not even be tomorrow). |
| P12 | `src/screens/main/BookingConfirmedScreen.tsx:1108` | `Refer & earn ₹100` | Booking-confirmed instant variant ReferNudge | Hardcoded ₹100. Same as S15. |
| P13 | `src/screens/pro/ProDashboardScreen.tsx:201` | `serviceName: invite.services?.[0] ?? 'Home Service',` | Routed param to ProMatched/ProActive when service unknown | "Home Service" is generic placeholder. Backend should always provide a service; flag for matching API contract. |
| P14 | `src/screens/pro/ProDashboardScreen.tsx:99` | `customerAddress: a.address ?? 'Customer Location',` | ProActive route param fallback | Genuine fallback OK — but visible in pro UI as "Customer Location" if backend omits address. |
| P15 | `src/screens/pro/ProMatchedScreen.tsx:139,184` | `serviceName ?? 'Home Service'` | Pro-matched banner & detail row | Same as P13. |
| P16 | `src/screens/booking/InstantMatchingScreen.tsx:180` | `'User Location'` (createInstantBooking address arg) | Address line POSTed to backend when address resolution fails | Sent to backend so the helper sees "User Location" in their dashboard. Use last-known address tag instead. |
| P17 | `src/screens/booking/InstantMatchingScreen.tsx:218,234` | `name: status.helper.name ?? 'Your Pro'` | Instant-matching → BookingConfirmed routing | OK as fallback; helper.name should always be set on `matched`. |
| P18 | `src/sdui/allowlist.ts:11` | `// TODO (follow-up): jest test asserting…` | Comment, not user-visible | No-op for users. Tracked for engineering follow-up only. |
| P19 | `src/api/bookings.ts:124` | `// Replace the stub with a real implementation…` | Comment, not user-visible | Same. |
| P20 | `src/screens/main/BookingRateScreen.tsx:8` | `// 1. POST /bookings/:id/rate (backend stub — non-fatal on 404)` | Comment | Same. |
| P21 | `src/screens/main/HomeScreen.tsx:467` | filter strips `hero_carousel` SDUI sections | Already documented; not a placeholder per se but worth flagging that BFF may still send dummy carousel sections that this client silently drops. | Verify BFF stops sending placeholder hero carousel slides. |

### NICE-TO-HAVE — dev-only / edge / cosmetic

| # | File:line | Current text | Severity reasoning |
|---|-----------|--------------|---------------------|
| N1 | `src/screens/auth/PhoneEntryScreen.tsx:119-121` | `firebaseAuth.settings.appVerificationDisabledForTesting = true` inside `if (__DEV__)` | Dev-only; cannot leak to release. Low risk. |
| N2 | `src/screens/auth/OTPVerificationScreen.tsx:176-178` | Same pattern | Same. |
| N3 | `src/screens/auth/PhoneEntryScreen.tsx:192` | `placeholder="98765 43210"` | Phone-input placeholder text. Acceptable example, but be aware it is a real-looking IN mobile prefix. Switch to "9876543210" or "Enter mobile number" if any concern. |
| N4 | `src/sdui/__tests__/safeguards.test.ts:57,187` | `tel:+911234567890`, `https://zopmop.com/x` | Test fixtures — never reach end users. |
| N5 | `src/components/home/HomeHero.tsx:60-67` | Time-of-day headlines (`Day starts. Chores don't.`, `Off hours. Catch us tomorrow.` etc.) | Static brand copy. Confirm with product before launch. |
| N6 | `src/components/home/HomeFooter.tsx:160` | `We mop.\nYou zop.` | Brand sign-off. Confirm with product. |

### BRAND CONSISTENCY — every "ZopMop" deviation

Canonical: **`ZopMop`** (camelCase). All-caps `ZOPMOP` is acceptable in eyebrow/badge contexts only.

| # | File:line | Current | Should be | Visibility |
|---|-----------|---------|-----------|------------|
| B1 | `src/screens/main/WalletScreen.tsx:159` | `Closed-loop credit for Zopmop bookings.` | `…ZopMop bookings.` | Wallet header subtitle — visible to every user that opens Wallet |
| B2 | `src/screens/main/WalletScreen.tsx:221` | `Spendable only on Zopmop bookings — no third-party charges.` | `…ZopMop bookings…` | Wallet "Why ZopMop wallet" card body |
| B3 | `src/screens/main/WalletTopupSheet.tsx:183` | `Funds stay in your Zopmop wallet.` | `…ZopMop wallet.` | Top-up sheet subtitle — every top-up |
| B4 | `src/api/wallet.ts:4` | `// closed-loop semantics: balance is spendable only on Zopmop bookings` | `…ZopMop bookings…` | Comment only (low risk, fix for hygiene) |
| B5 | `src/theme/colors.ts:5` | `accent: '#F5A300', // Zopmop amber` | `// ZopMop amber` | Comment only |
| B6 | `src/theme/colors.ts:6` | `accentLight: '#FFC042', // Zopmop amber-hi` | `// ZopMop amber-hi` | Comment only |
| B7 | `src/theme/colors.ts:42` | `// Zopmop amber-hi (brighter on dark)` | `// ZopMop amber-hi` | Comment only |
| B8 | `src/theme/colors.ts:43` | `// Zopmop amber-glow` | `// ZopMop amber-glow` | Comment only |
| B9 | `src/hooks/useCashfreePayment.ts:41` | `navigationBarBackgroundColor: '#0A0A0A',  // header — Zopmop dark` | `// header — ZopMop dark` | Comment only |
| B10 | `src/sdui/allowlist.ts:12,33` | `zopmop-app has no jest config…` and `data/file/javascript/zopmop and any custom scheme are blocked.` | code/comment, lower-cased intentionally to denote internal scheme name | Comment only — do **not** capitalize the deny-listed `zopmop:` URL scheme; that string is a literal denylist key. |
| B11 | `app.json:3-4` | `"name": "zopmop-app", "slug": "zopmop-app"` | acceptable for package id; `CFBundleDisplayName: "ZopMop"` (line 24) is correct | iOS home-screen label is correct. Slug is internal. |
| B12 | `package.json:2` | `"name": "zopmop-app"` | acceptable for npm package | npm naming forbids capitals; do not change. |

The only **user-visible** brand bugs are B1, B2, B3 (Wallet + Wallet Topup screens). The rest are code comments / package names and can be fixed for hygiene without affecting users.

---

## 3. Cross-Reference by Type

### 1. Dummy display data
- ProfileScreen `14 bookings` (line 318) → wire to bookings count.
- ProfileScreen `Active member` (line 384) → derive from membership.
- ProfileScreen Bookings rail `pip: 2` (line 406), Offers `pip: 3` (line 418) → wire to real counts.
- ProfileScreen `Home · Work · 1 more` (line 222), `3 members…` (line 229), `5 favorite pros` (line 236), `Push · WhatsApp · Email` (line 243), `30 min before booking` (line 211) → wire to per-user data.
- ProDashboardScreen `Rating value="4.9"` (line 371) → wire to helper rating.
- TrackLiveScreen defaults `Priya M.` / `4.9` / `312 jobs` / `1.2 km` (lines 107-111) → never default to fake.
- TrackLiveScreen `accepted in 12 sec` (line 454), `time="9:35 AM"` (line 455) → derive from booking timeline.
- BookingConfirmedScreen `In ~6 min` (line 833) → real ETA.
- BookingConfirmedScreen `helperRating ?? 4.9` (line 977) → drop fallback.
- HomeFooter trust strip `8,400+` / `100%` / `60 sec` (lines 103-107) → real stats endpoint or remove.

### 2. Lorem / filler prose
None.

### 3. Dev shortcuts in UI
None left in UI. Firebase test bypasses are `__DEV__`-gated (see N1, N2).

### 4. TODO/FIXME in user-visible strings
None reach UI; comment-only TODOs:
- `src/sdui/allowlist.ts:11` (jest test follow-up)
- `src/api/bookings.ts:124` (replace stub when backend ships)
- `src/hooks/usePushNotifications.ts:97` (wire tray-notif handler)
- `src/screens/main/BookingRateScreen.tsx:8` (backend stub note)

### 5. Generic stub strings
- "Customer Location" → ProDashboardScreen line 99 (param fallback) and any place using `address ?? 'Customer Location'`.
- "Home Service" → ProDashboardScreen line 201, ProMatchedScreen lines 139 and 184.
- "User Location" → InstantMatchingScreen line 180 (sent to backend).
- "Your Pro" → InstantMatchingScreen lines 218, 234 (matched-helper fallback name).

### 6. Interpolation leaks
None spotted. All `${...}` use real bindings.

### 7. Wrong default avatars / images
None. The codebase uses Zop SVG mascot fallbacks (`assets/zop/zop-*.svg`) consistently. No `picsum.photos`, `placeholder.com`, `via.placeholder`, `dicebear`, or `loremflickr` strings exist.

### 8. Hardcoded test entities
- `tel:+911800000000` → `src/screens/main/HelpSupportScreen.tsx:71` (the call-us button dials a placeholder).
- `https://zopmop.com/privacy` and `https://zopmop.com/terms` → `src/screens/auth/OTPVerificationScreen.tsx:34-35`. Need verification that those URLs resolve to live pages before launch (not flagged as test, but worth checking).
- `hello@zopmop.com` → `HelpSupportScreen.tsx:67-68`. Verify the inbox is monitored.

### 9. Empty-state copy
All empty states (Wallet "No transactions yet", AddressesScreen "No saved addresses", YourExpertsScreen "No experts yet", AllServicesScreen "No services available", ChatScreen "Say hi…") read as intentional UX. None flagged.

### 10. Debug labels visible to users
None.

### 11. Truncated / WIP "Coming soon" copy
- ProfileScreen → Notifications row (`:245`)
- ProfileScreen → Terms of Service (`:264`)
- ProfileScreen → Privacy Policy (`:271`)
- ProfileScreen referral ticket info (`:196`)
- HelpSupportScreen → Live chat (`:64`)
- LocationCheckScreen unsupported-city pill (`:377`) — branding-OK
- NotServiceableScreen `:68` — branding-OK

### 12. Brand consistency
See section 2 / Brand Consistency table. Fix B1–B3 immediately; rest is hygiene.

---

## 4. Real-Data Wiring Notes

| Placeholder | Likely backend source | Status |
|-------------|----------------------|--------|
| Profile bookings count (S1, S9) | `GET /bookings?status=upcoming` already exists; total-count not exposed | Backend can expose count cheaply or screen can `.length` the response |
| Profile addresses meta (S4) | `listAddresses(token)` already used elsewhere | Wire client-side |
| Profile roomies meta (S5) | `useRoomies()` already in scope | Wire client-side |
| Profile experts meta (S6) | `listExperts(token)` already used elsewhere | Wire client-side |
| Profile notifications meta (S7), reminders (S8) | No backend endpoint | **Backend work needed** |
| Profile bookings/offers pip (S9, S10) | Bookings endpoint OK; offers needs `GET /offers` (see S23) | Partially backend |
| ProDashboard Rating (P1) | `GET /helpers/me` (similar to `getMe`) | Verify `average_rating` field; if missing, backend work |
| TrackLive helper defaults (P2-P5) | WS already provides — just remove fallback values | Client-only fix |
| TrackLive booking timeline (P6, P7) | Booking record already has `created_at`/`accepted_at` | Surface in `getMatchStatus` response |
| Booking ETA (S30) | Backend already supplies via WS in TrackLive — BookingConfirmed needs a similar field | **Backend work** to extend `getMatchStatus` with `eta_minutes` for instant bookings |
| Home location fallback (S18, S19) | Last-known location is already cached (`writeLastKnownLocation`) | Use cached value before falling back to Sector 51 |
| Footer trust stats (S20-S22) | No `/stats` endpoint | **Backend work needed** OR remove |
| Offers (S23) | No `/offers` endpoint | **Backend work needed** — this is a launch-critical gap |
| Support phone (S24) | Static config | Replace with real number when issued by ops |
| Live chat (S25) | No backend | **Vendor work** (Intercom / Freshchat / etc.) |
| Helper "TOP PRO" badge (P9) | No `is_top_pro` flag | **Backend work** OR drop the badge |

---

## 5. Quick Wins (<5 min each)

These need only a copy change or simple delete; safe to ship without backend work.

1. `WalletScreen.tsx:159` — change `Zopmop` → `ZopMop`
2. `WalletScreen.tsx:221` — change `Zopmop` → `ZopMop`
3. `WalletTopupSheet.tsx:183` — change `Zopmop` → `ZopMop`
4. `theme/colors.ts:5,6,42,43` — change `Zopmop` → `ZopMop` in comments
5. `useCashfreePayment.ts:41` — change `Zopmop` → `ZopMop` in comment
6. `api/wallet.ts:4` — change `Zopmop` → `ZopMop` in comment
7. `ProfileScreen.tsx:318` — delete `bookingsLabel` chip OR replace with `{bookingsLabel}` only when count > 0
8. `ProfileScreen.tsx:384` — delete the `Active member` chip until membership tier exists
9. `ProfileScreen.tsx:406` — remove `pip: 2` until wired
10. `ProfileScreen.tsx:418` — remove `pip: 3` until wired
11. `ProfileScreen.tsx:222,229,236,243,211` — replace hardcoded `meta=` strings with `undefined` so the row collapses
12. `ProfileScreen.tsx:257` — replace `'v1.0.0'` literal with `Constants.expoConfig?.version`
13. `ProfileScreen.tsx:171` — wire help icon to `navigation.navigate('HelpSupport')` or remove
14. `HelpSupportScreen.tsx:71` — replace `+911800000000` with the real number or hide the row
15. `BookingConfirmedScreen.tsx:833` — change `value="In ~6 min"` to `etaMinutes ? `In ~${etaMinutes} min` : 'Tracking ETA…'`
16. `BookingConfirmedScreen.tsx:977` — drop `?? 4.9` fallback; render rating only when known
17. `TrackLiveScreen.tsx:107-111` — remove default-param values for helperName/Rating/Jobs/distanceKm; gate UI on real values
18. `TrackLiveScreen.tsx:454-455` — replace `accepted in 12 sec` and `9:35 AM` with computed values or hide
19. `ProDashboardScreen.tsx:371` — change `value="4.9"` to `value={user?.average_rating?.toFixed(1) ?? '—'}`
20. `HomeFooter.tsx:103-107` — drop or down-scale the trust strip stats

Deeper items (need design / copy / backend):
- Offers list (S23) — backend endpoint
- Live chat / live support phone — ops + vendor decisions
- "TOP PRO" badge (P9) — backend flag
- Notification preferences (S7, S17) — backend endpoint
- Trust strip stats (S20-S22) — analytics endpoint or content decision
- Referral program (S14, S15, P12) — full feature + backend
- City list (S29) — content decision as ZopMop expands
