P3 BATCH - 11 tickets (cleanup, vestigial code, low-impact items)

Date: 2026-05-08
Source: System walkthrough Part 6 + business logic clarifications

Each ticket below is a P3: nice to clean up, cosmetic or vestigial or
low-impact technical debt. Most are 15-60 min of work. Do these in a
single afternoon when you want to feel productive without tackling
anything heavy.

================================================================================
P3-001 - FloatingCartButton uses cart emoji, project convention is vector icons
================================================================================

Severity: P3
Category: UX

SUMMARY
src/components/FloatingCartButton.tsx line 23 renders a shopping cart
emoji. Project convention per design system is Feather/vector icons only,
no emojis anywhere in UI. Isolated violation.

FIX
Replace the emoji with @expo/vector-icons Feather:
  import { Feather } from '@expo/vector-icons';
  <Feather name="shopping-cart" size={24} color={...} />

EFFORT: 5 min

ACCEPTANCE: No emoji renders in FloatingCartButton. Visual matches other
icons in the app.

================================================================================
P3-002 - househelp-test-client.bak/ in monorepo
================================================================================

Severity: P3
Category: TECH

SUMMARY
App/househelp-test-client.bak/ is an archived React+Vite client with full
node_modules present. Inactive, no CRM pages, just boilerplate. Pollutes
grep/find searches. Should be removed or moved out of the monorepo.

FIX
git rm -rf App/househelp-test-client.bak/
git commit -m "chore: remove archived test client (househelp-test-client.bak)"

If anything from it might be useful later, archive to a separate dead-code
repo before deletion.

EFFORT: 5 min

ACCEPTANCE: Directory gone. Grep/search results no longer include
boilerplate hits from this folder.

================================================================================
P3-003 - Double-listed app.json fields (UIBackgroundModes etc.)
================================================================================

Severity: P3
Category: TECH

SUMMARY
ios.infoPlist.UIBackgroundModes, ios.infoPlist.CFBundleURLSchemes, and
android.permissions in App/zopmop-app/app.json appear listed twice each.
Likely an expo prebuild artifact accumulation from running prebuild
multiple times. Cosmetic, doesn't break builds.

FIX
Open app.json, deduplicate the listed fields manually. Run npx expo
prebuild --clean once cleanly to verify no duplicates regenerate.

EFFORT: 15 min

ACCEPTANCE: Each app.json field appears at most once. Prebuild output
clean.

================================================================================
P3-004 - H3 hex_cell_id telemetry-only, not used in matching
================================================================================

Severity: P3
Category: TECH

SUMMARY
helpers.hex_cell_id and demand_snapshots table exist (added migration 018).
The matching engine uses PostGIS KNN, not H3, for actual helper-to-booking
matching. TrackDemand function call in CreateBooking writes to
demand_snapshots but UNCLEAR if any current decision logic reads from it.
Either the H3 grid is dead infrastructure, or it's quietly powering some
analytics/dashboard. Worth confirming and either wiring it in properly
or removing.

EVIDENCE
grep -rn "hex_cell_id\|TrackDemand\|demand_snapshots" --include="*.go" App/househelp-api/

If results are write-only with no read path, H3 is dead infrastructure.

FIX
Decide:
- Use it: integrate H3 grid into matching engine for surge detection,
  zone-based heatmaps, or capacity planning
- Remove it: drop hex_cell_id column, drop demand_snapshots table, remove
  TrackDemand calls from CreateBooking

EFFORT: 30 min decision + investigation. Implementation varies by choice.

ACCEPTANCE: Clear documented purpose for H3 grid OR clean removal.

================================================================================
P3-005 - Dashboard "open disputes" KPI always returns 0
================================================================================

Severity: P3
Category: UX

SUMMARY
CRM dashboard KPI query for open disputes runs but always returns 0
because no automated path creates dispute rows (see P2-003). Cosmetic
problem: dashboard shows "0 disputes" which is misleading because the
feature isn't yet active. Fix: hide the KPI card until P2-003 ships, or
replace with placeholder text "Disputes feature pending".

FIX
In CRM dashboard component or API response shaper, conditionally hide the
disputes KPI tile until disputes table has at least one row historically.
Or replace numeric value with text indicator.

EFFORT: 15 min

DEPENDENCIES
- Becomes obsolete when P2-003 ships (auto-resolves)

ACCEPTANCE: Dashboard does not show misleading 0 disputes count. After
P2-003 lands, automatic resolution.

================================================================================
P3-006 - gsap in dependencies, usage unclear
================================================================================

Severity: P3
Category: TECH

SUMMARY
gsap 3.15 is listed in package.json. GSAP is primarily a DOM/web
animation library. Has React Native adaptations but unusual alongside
react-native-reanimated which already covers RN animation. Either
actively used somewhere or vestigial bundle weight (~50KB).

EVIDENCE
grep -rn "import.*gsap\|from 'gsap'" --include="*.ts" --include="*.tsx" App/zopmop-app/src/

FIX
- If grep returns hits: document where and why GSAP over Reanimated
- If grep returns empty: remove from package.json + lockfile
  npm uninstall gsap

EFFORT: 10 min audit + cleanup

ACCEPTANCE: Either documented usage or removed dependency.

================================================================================
P3-007 - @react-navigation/material-top-tabs in deps, usage unclear
================================================================================

Severity: P3
Category: TECH

SUMMARY
Declared as a dependency in package.json. Not observed in any screen
during the system walkthrough. May be vestigial or used in a screen the
walk missed.

EVIDENCE
grep -rn "material-top-tabs\|MaterialTopTab" --include="*.ts" --include="*.tsx" App/zopmop-app/src/

FIX
- If grep empty: npm uninstall @react-navigation/material-top-tabs
- If grep has hits: document the screens that use it

EFFORT: 10 min

ACCEPTANCE: Either documented usage or removed dependency.

================================================================================
P3-008 - expo-device in deps, no usage found
================================================================================

Severity: P3
Category: TECH

SUMMARY
Listed in dependencies, not found in screen imports during the system
walkthrough. Common use is device fingerprinting or platform-specific
checks. Verify usage or remove.

EVIDENCE
grep -rn "expo-device\|Device\." --include="*.ts" --include="*.tsx" App/zopmop-app/src/

FIX
- If grep empty: npm uninstall expo-device
- If grep has hits: document where it's used (likely device_id generation
  for FCM token registration?)

EFFORT: 10 min

ACCEPTANCE: Either documented usage or removed dependency.

================================================================================
P3-009 - react-native-tab-view in deps, custom glass-tab glider used instead
================================================================================

Severity: P3
Category: TECH

SUMMARY
react-native-tab-view declared as dependency. BookingsScreen uses a custom
glass-tab glider component instead. May be used elsewhere or vestigial.

EVIDENCE
grep -rn "react-native-tab-view\|TabView" --include="*.ts" --include="*.tsx" App/zopmop-app/src/

FIX
- If grep empty: npm uninstall react-native-tab-view
- If grep has hits: document where

EFFORT: 10 min

ACCEPTANCE: Either documented usage or removed dependency.

================================================================================
P3-010 - Roomies worker responsibilities and tick interval undocumented
================================================================================

Severity: P3 (escalated to P1-equivalent at launch readiness check)
Category: OPS

SUMMARY
roomies.NewWorker is started as a background goroutine in main.go. Its
tick interval and exact responsibilities were not deeply read in the
system walkthrough. Roomies feature is ACTIVE at launch per business
logic confirmed 2026-05-08, so understanding what this worker does is
launch-relevant even if the cleanup itself is P3.

NOTE: This was originally INDEX row 028. Already escalated to P1 in the
INDEX patch session for P1-007 (since roomies is active at launch). This
P3 ticket entry is for the documentation cleanup specifically. The
"verify it works" concern is captured in the INDEX P1 reference.

EVIDENCE
grep -rn "RoomiesWorker\|roomies.NewWorker\|NewRoomiesWorker" --include="*.go" App/househelp-api/

FIX
Read internal/roomies/worker.go (or equivalent location). Document:
- Tick interval
- What state changes it makes
- Failure modes
- Acceptance criteria for it being healthy
Add to docs/WORKERS.md (or similar) alongside ScheduledDispatcher,
StealthDispatcher, etc.

EFFORT: 30 min reading + documentation

ACCEPTANCE: docs/WORKERS.md has a Roomies entry with same fields as
other workers. Worker behavior verified before launch.

================================================================================
P3-011 - OFFSET pagination in admin queries (audit findings D1-005, D1-008)
================================================================================

Severity: P3
Category: TECH

SUMMARY
Some admin/CRM queries use OFFSET-based pagination (LIMIT N OFFSET M) which
becomes slow at scale because Postgres scans+discards M rows. Original
audit findings D1-005 and D1-008. Premature optimization for ZopMop
launch scale (admin pagination of low-volume tables) but worth tracking
as a "fix when it actually matters" item.

EVIDENCE
grep -rn "OFFSET" --include="*.go" App/househelp-api/internal/crm/

FIX
When list endpoint pages exceed ~10 pages or scan ~10K rows, replace
OFFSET with keyset pagination:
- Track the last seen sort key (created_at, id) in cursor
- Next page query: WHERE (created_at, id) < (last_created_at, last_id)
  ORDER BY created_at DESC, id DESC LIMIT N
- Cursor encoded as opaque base64 string in API response

EFFORT: 2-4 hr per endpoint, but only when scale demands.

DEPENDENCIES
- Becomes meaningful when CRM admin tables exceed ~50K rows or pagination
  exceeds page 10

ACCEPTANCE: Defer until needed. Track as known performance debt.

================================================================================
P3 BATCH SUMMARY
================================================================================

11 tickets total. Approximate combined effort: 4-6 hours of focused
afternoon cleanup, plus some larger items deferred until needed.

Recommended single-session sweep (P3-001 through P3-009):
- P3-001: 5 min
- P3-002: 5 min
- P3-003: 15 min
- P3-005: 15 min
- P3-006: 10 min
- P3-007: 10 min
- P3-008: 10 min
- P3-009: 10 min
Total: under 90 min for cosmetic + vestigial cleanup

Larger P3 items, do when ready:
- P3-004 (H3 grid decision): 30 min decision + variable implementation
- P3-010 (Roomies worker doc): 30 min, related to launch-readiness P1 escalation
- P3-011 (OFFSET pagination): defer until scale demands

Most of these become commit material for a single "cleanup pass" that
touches 8-10 files for a clean diff.
