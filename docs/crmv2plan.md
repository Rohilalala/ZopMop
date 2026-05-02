# CRM v2 — Detailed Redesign Plan

**Stack:** Vite · React 19 · Tailwind · axios · cookie-auth + CSRF
**Branch:** `feature/crm-v2`
**Status:** Planning. Built behind feature flag `crm.v2`. Parity with v1 in 5–6 weeks.

---

## 1. Goals

1. **Newbie can ship a config in < 5 minutes** without reading any doc.
2. **No JSON editing** for SDUI page configs in the happy path.
3. **No silent 403s** — UI reflects what the current admin can do.
4. **Live preview** of every SDUI change before publishing.
5. **All destructive ops** are reversible (undo) or warned with consequence text.
6. **Zero functionality loss** vs v1 — every endpoint v1 reaches must remain reachable.
7. **Discoverability** — a logged-in admin can find every feature within 2 clicks or via `cmd-k`.

## 2. Non-goals

- No native (electron) build.
- No multi-tenancy (single-org admin).
- No mobile-first responsive — desktop ≥ 1280px is the supported viewport.
- No internationalisation in v2.0 (only en-IN strings).
- No real-time collaboration on configs (single-editor model w/ ETag locks).

## 3. UX principles

| # | Principle | Concrete rule |
|---|-----------|---------------|
| 1 | Forms over JSON | Raw JSON is escape-hatch only, behind an "Advanced" toggle |
| 2 | Plain-language lifecycle | Replace draft/staged/active/archived with Save / Test / Live / Old |
| 3 | One primary action per screen | Big indigo button. Secondary actions in `...` menu |
| 4 | Detail drawer over page nav | Right-side panel, esc-close, url-routable |
| 5 | Permission-aware controls | `<Can perm="X">` wrapper. Hidden when no perm; tooltip on disabled |
| 6 | Empty state = next step | Icon + headline + single CTA. Never a blank screen |
| 7 | Undo over confirm-prompt | `window.confirm` banned. 5s undo toast for destructive ops |
| 8 | Inline validation | Errors next to field, not a toast |
| 9 | Live preview where possible | SDUI editor, promo card, banner, dashboard widget |
| 10 | Discoverability | `cmd-k` palette + global search bar in every list |

## 4. Information architecture

### 4.1 New sidebar

```
HOME
└─ Dashboard               (default landing)

OPERATIONS
├─ Bookings                (detail drawer)
├─ Customers               (detail drawer)
├─ Pros                    ┐
│   ├─ All                 │ tabs in same page
│   └─ Pending             ┘
└─ Refunds                 (detail drawer; tabs Pending/Settled)

CATALOGUE
├─ Services                (detail drawer + addons/includes/excludes)
└─ Promotions              (wizard)

ENGAGEMENT
├─ Notifications           (broadcast composer + history)
├─ Banners                 (visual editor)
└─ Home page (SDUI)        (visual editor + lifecycle stepper)

SYSTEM
├─ Config                  (typed inputs)
├─ Allowed actions         (curated checklist)
├─ Audit log               (human-readable timeline)
└─ Runtime metrics         (db_pool, rate limiter, rollups)

PROFILE   (footer)
└─ Sign out
```

### 4.2 URL conventions

- `/<resource>` — list view
- `/<resource>?drawer=<id>` — list + drawer open
- `/<resource>/new` — wizard
- `/sdui` — visual editor for the active page; defaults to `home`
- `/sdui?page=<id>&version=<v>&mode=preview|edit` — deep-link

### 4.3 Header

Persistent top bar:
- Logo + env pill (dev/staging/prod)
- Global `<input>` search (cmd-k surrogate)
- Quick-create (`+`) button: New booking · New promo · New SDUI draft
- Notification bell (admin alerts: kill switch active, rollout instability)
- User menu

---

## 5. Component primitives

### 5.1 `<Drawer>`

Right-side panel. Stacks (drawer-over-drawer). Closes on:
- ESC
- Outside click (with confirm if dirty)
- Back button (history.popState)

URL-routable via `?drawer=<resource>:<id>`. Re-opens on refresh.

```jsx
<Drawer
  open={!!selectedId}
  onClose={...}
  title="Booking BK-12345"
  width="lg"            // sm 480 | md 640 | lg 800
  primary={<Button>Save</Button>}
  dirty={form.isDirty}
>
  <DrawerSection title="Customer">
    ...
  </DrawerSection>
</Drawer>
```

### 5.2 `<Can>`

Permission gate.

```jsx
<Can perm="manage_promotions" fallback={null}>
  <Button>New promo</Button>
</Can>
<Can perm="manage_promotions" mode="disable" reason="Needs manage_promotions">
  <Button>Edit</Button>
</Can>
```

Read perms once at login from `/api/v1/me` response (already returned by backend). Cache in `AuthContext`.

### 5.3 `<UndoToast>`

Replaces `window.confirm`. Action runs immediately; toast shows for 5s with `Undo` button that calls a passed-in inverse op.

```jsx
toast.action("Refund settled", {
  undo: async () => api.unsettleRefund(id),
  duration: 5000,
});
```

For irreversible ops (kill-switch on prod, hard delete) keep an explicit `<ConfirmDialog>` with consequence text and a typed-confirmation field.

### 5.4 `<EmptyState>`

```jsx
<EmptyState
  icon={Megaphone}
  title="No promos yet"
  body="Promo codes appear here once you create one."
  cta={<Button onClick={...}>New promo</Button>}
/>
```

### 5.5 `<Stepper>`

```
[ Save  ] ──▶ [ Test  ] ──▶ [ Live  ] ──▶ [ Old ]
                            ●
```

Highlighted = current state. Click steps user can move to. Greyed = invalid transitions. Tooltip explains why.

### 5.6 `<CommandPalette>`

`cmd-k` opens it. Sources:
- Pages (every sidebar entry)
- Recent records (last 20 viewed bookings/customers/configs)
- Quick actions (New promo, Toggle home kill switch)
- Live record search (debounced 300ms; calls each list endpoint with `search=`)

Built on `cmdk` library. Keyboard-only navigation. Footer shows `↑↓ Navigate · ↵ Open · esc Close`.

### 5.7 Form-kit

`react-hook-form` + `zod` schemas. Wrappers:
- `<FormField name="..." label="..." help="..." />`
- `<MoneyField name="..." />` — accepts ₹ input, stores cents
- `<DurationField name="..." units={["h","d","w"]} />`
- `<RefPicker name="..." sources={['user.first_name', 'promos.active']} />`

### 5.8 `<LiveDiff>`

Side-by-side JSON diff (uses `diff-match-patch`). Used for audit log expand and SDUI version diff.

---

## 6. Phase A — foundations (week 1)

### A1. Auth + permissions context

- `AuthContext`: extend with `permissions: string[]`. Hydrate from `/api/v1/me` (currently `/me` returns user; verify it includes `permissions`. If not, **backend ticket: include `admin_users.permissions` in `/me` response**).
- `useHasPerm(perm: string): boolean` hook.
- `<Can>` wrapper component.

**Files:** `src/context/AuthContext.jsx`, `src/components/Can.jsx`, `src/hooks/useHasPerm.js`.

**Acceptance:** Login as a non-admin → no admin nav visible. Login as admin missing `manage_promotions` → Promotions in nav but "+" hidden + "Disable" tooltip-disabled.

### A2. Drawer primitive

- Stackable, URL-routable, esc-close, outside-click confirm if dirty.
- Pulls open state from `useSearchParams` so back-button closes correctly.
- Width prop: sm/md/lg/xl.

**Files:** `src/components/Drawer.jsx`, `src/components/DrawerSection.jsx`, `src/hooks/useDrawerRoute.js`.

**Acceptance:** Open Bookings list, click row → drawer opens; refresh → drawer still open; back → drawer closes; another row click while drawer open → swap content (no stack); cmd-k → palette opens over drawer (no z-index war).

### A3. Toast + undo system

- Replace existing `useToast` with new shape: `toast.success | warn | error | action({ undo })`.
- Auto-dismiss 4s (5s for undo). Stack max 3.
- Replace every `window.confirm` / `alert` in v1 pages once feature flag swaps.

**Files:** `src/components/Toast.jsx` (rewrite), `src/hooks/useToast.js` (rewrite).

### A4. Empty-state + Skeleton primitives

- `<EmptyState>` (sec 5.4).
- `<TableSkeleton rows={N} cols={M} />`.
- `<DrawerSkeleton />`.

### A5. Stepper

- `<Stepper steps={["Save","Test","Live"]} current="Test" onClick={...} />`.

### A6. Command palette

- `cmdk` library. `cmd-k` global hotkey.
- Static actions registered via `registerCommand({ id, title, perm, run })`.
- Fuzzy search across `recentRecords` (last-20 stored in localStorage).

**Files:** `src/components/CommandPalette.jsx`, `src/registry/commands.js`.

**Acceptance:** `cmd-k` from any page → palette opens; type "promo" → "New promo" + matching codes appear; ↵ → routes correctly. Permission-gated commands hidden when not allowed.

### A7. Form-kit

- Set up `react-hook-form` + `zod` + custom inputs (MoneyField, RefPicker, DurationField).
- Style guide doc at `src/components/forms/README.md`.

### A8. Feature flag plumbing

- New `FeatureFlagContext` reading `import.meta.env.VITE_CRM_V2 === '1'` AND/OR query param `?v2=1`.
- `App.jsx`: conditionally render v1 or v2 routes.

**Acceptance for Phase A:** All primitives render in a Storybook-ish dev page at `/dev/components`. v2 flag toggleable.

---

## 7. Phase B — SDUI visual editor (1.5 weeks)

The v1 `SduiPagesPage` becomes `SduiPage` (`/sdui`). Core change: no JSON in primary flow.

### B1. Routes + layout

```
/sdui                       → editor for active page (default home)
/sdui?page=home             → ditto
/sdui?page=home&version=1.2 → editor pinned to v1.2 (read-only if not draft)
/sdui?compare=1.1,1.2       → diff viewer
```

3-pane layout (resizable):
- Left:  section tree + add-section button
- Center: property panel (form for selected section)
- Right: live preview (iPhone frame)

### B2. Backend changes needed

- `GET /admin/sdui/sources` — return registered $ref keys + return type + critical flag. Read from `bff.SourceRegistry`. Used by `<RefPicker>`.
- `GET /admin/sdui/section-types` — return registered section types + their data schema. Used by section-type picker.
- Ensure `GET /admin/pages` returns `[{ id, name, last_active_version }]` instead of `[]string` (audit P2).
- Lifecycle responses unified to `{ config, warnings? }` shape (audit P2).

### B3. Section tree (left pane)

- Drag-to-reorder (`@dnd-kit/core`).
- Each item: type icon + section.id + visibility toggle + actions menu.
- "+ Add section" → modal with grid of available types (hero_carousel, live_pill, usuals_row, service_grid, footer + future).
- Click section → selects it for property panel.

### B4. Property panel (center)

Per-type form using form-kit. Each section type ships a `SduiSectionForm.<type>.jsx`.

#### Hero carousel

- Greeting source: `<RefPicker>` defaulting to `user.first_name` + default-text input.
- Slides table: drag-reorder, each row has fields (eyebrow, title, body, cta, emoji, bg, accent, action).
- Action editor: dropdown `navigate | bottom_sheet | toast | api_call | deep_link | load_more` → per-type sub-form.

#### Live pill

- Three `<RefPicker>`s for nearby_count, avg_eta_min, avg_rating (always default to insights.* refs).

#### Usuals row

- visible: `<RefPicker bool>`.
- services: `<RefPicker>` defaulting to `user.usuals`.

#### Service grid

- Title text input.
- services: `<RefPicker>`.
- has_more, cursor — read-only display, server-side computed.

#### Footer

- No fields.

#### Common fields (every section)

- ID (read-only after create).
- Hydration: eager/lazy radio.
- Visibility: bool OR `<RefPicker bool>`.
- Layout: collapsible group with dropdowns/numeric inputs whitelisted by SduiLayout.
- Style: bg/fg color-token select, radius dropdown.
- Rollout: collapsible — min_client_version, percentage slider, segment dropdown.
- Priority: high/medium/low chips.

### B5. Live preview pane (right)

Two render strategies (pick one in B5a, fallback B5b):

#### B5a (preferred) — RN-Web shim

- Render the SduiPage via `react-native-web` inside an iframe sized to iPhone 14 Pro.
- Reuse the same `SectionRenderer` and section components from `App/zopmop-app` via a thin shim (mark as `react-native-web` compatible — most of them already are if we avoid native-only Reanimated APIs).
- Preview re-renders on every form change with debounce 300ms. Calls `POST /admin/sdui/render-preview` with the in-progress draft (no need to save).

**Backend ticket:** `POST /admin/sdui/render-preview { config_json, lat, lon, user_id? }` — runs the BFF resolve pipeline against a non-persisted config. Returns the same `SduiPage` shape as `GET /page/:id`.

#### B5b (fallback) — server-rendered screenshot

- If RN-Web shim is too heavy or sections use Reanimated/native-only modules, switch to a server-side render endpoint that returns a PNG (Puppeteer + RN web). Heavier but isolated.

### B6. Lifecycle stepper

Above the editor:

| v1 status | v2 label | v2 description shown on hover |
|-----------|----------|-------------------------------|
| draft     | Save     | Editing freely. Not visible to users. |
| staged    | Test     | Validated. Visible only on staging env. |
| active    | Live     | Visible to users right now. |
| archived  | Old      | Replaced by a newer version. |

CTAs change based on stage:
- draft: "Send to Test" (calls /stage; surfaces validation errors inline, not toast)
- staged: "Go Live" (calls /activate; etag forwarded automatically; If-Match conflict → toast: "Someone else changed this. Reload?")
- active: "Revert to previous" (calls /rollback; double-confirm dialog)
- archived: "Clone to new draft"

### B7. Validation surfacing

`/stage` errors+warnings parsed and rendered:
- Errors: red banner above section tree + inline highlight on offending sections.
- Warnings: yellow strip per section.
- "Fix all" button available where auto-fix is safe (e.g., trim trailing whitespace).

### B8. Kill switch

Compact card top-right:
```
[ ⚪ Kill switch ]   off
[ 🔴 Kill switch ]   on for 23h 12m → click to clear
```

Confirmation dialog with consequence: "Users will see the safe-fallback layout immediately."

### B9. Audit log (per page)

Bottom drawer: timeline of last 50 events. Each entry rendered as a sentence:
> Aditya activated home v1.2 · 3 sections changed · 2 mins ago · [diff]

Click `[diff]` → side-by-side `<LiveDiff>` of `old_value` vs `new_value`.

### B10. Allowed actions page

Visual rewrite. Curated lists:
- **Standard endpoints** (catalog, surfaced from a constant): /favorites, /favorites/toggle, /usuals/dismiss, /notifications/preferences. Toggle to enable/disable.
- **Custom endpoints** (free input): kept for forward-compat, gated behind "Advanced" toggle.

Show last-used timestamp per row (audit log query) so admins know which actions are dead.

### B11. Promo manager (replaces home_promos SQL access)

`Engagement → Banners` already covers banners. Add **Engagement → Promo slides** that CRUDs `home_promos` table:
- Visual card preview with the bg/accent/emoji/copy.
- Display order via drag.
- Active toggle.
- Screen + screen_params via dropdown of registered RN screens (need to publish a list; backend ticket: `GET /admin/sdui/screens`).

**Backend ticket:** `GET/POST/PATCH/DELETE /admin/promos` for `home_promos` CRUD.

### B12. Acceptance for Phase B

A newbie admin can:
1. Open `/sdui` → see home page sections in a list.
2. Drag the order around.
3. Click hero → edit a slide's CTA copy.
4. Right pane updates live within 500ms.
5. Click "Send to Test" → validation errors (if any) shown inline; user fixes.
6. Click "Go Live" → confirm dialog with consequence text → live in < 2s.
7. Audit log entry says "<name> activated home v1.X".
8. No JSON ever shown.

---

## 8. Phase C — operational drawers (1 week)

### C1. Booking drawer

Click any booking row → drawer with:
- Header: BK-id, status pill, created-at timeago, customer phone, helper phone (if assigned).
- **Schedule:** instant vs scheduled badge; if scheduled, slot date/time + slot id.
- **Services:** list with prices (per-service mode for scheduled bookings).
- **Payment:** price, discount, promo code applied, refund state.
- **Timeline:** every status change + admin action (suspend, cancel, refund).
- **Helper assignment:** who, when, distance traveled.
- **Actions:** Cancel (w/ undo), Issue refund, Reassign (if not started).

**Backend gaps:** May need `GET /admin/bookings/:id/detail` returning the joined view (timeline + services + helper + payment). Implement via repository SELECT joining bookings + services + booking_status_history (if exists; else add one).

### C2. Customer drawer

- Profile: phone, name, role, suspended state, joined.
- Stats: lifetime spend, booking count, avg rating given, last booking.
- Bookings list (clickable to open booking drawer atop).
- Suspended toggle with reason (audit-logged).
- Soft-deleted state surfaced (deleted_at + reason from migration 031).

### C3. Pro drawer (existing pros)

- Profile + ratings.
- Performance graph (last 30d completion rate, avg job min) — uses `getWorkerPerformance(30, 100).workers`.
- Recent bookings list.
- Location pin on small map (read current_lat/lng; only if fresh).
- Documents (if column exists; else: backend ticket `helpers.documents jsonb`).
- Approval-status badge.

### C4. Pending pro drawer

- All Pro-drawer fields read-only.
- Plus: documents preview, vehicle info, category, applied-at.
- Approve / Reject buttons inline at bottom. Reject requires reason text.

### C5. Refund drawer

- Refund id + status + amount (₹).
- Linked booking row (clickable → opens Booking drawer atop).
- Source (e.g. `cancel_after_assignment`).
- Audit trail.
- Settle button (when pending). Undo enabled for 5s.

### C6. Service drawer (catalogue)

- Edit base fields (already in v1 ServicesPage).
- Tabs:
  - **Includes** — drag-orderable list, +Add row.
  - **Excludes** — same.
  - **Steps** — title + description + icon.
  - **Addons** — table with emoji + price.
- Save persists each tab independently.

**Backend tickets:**
- `GET /admin/services/:id/includes` (and PUT/DELETE).
- Same for excludes, steps, addons.
- Models exist in `services/model.go`; need handlers + repository methods.

### C7. Bookings list improvements

- New columns: scheduled-time (or "instant"), slot, refund pill (if any).
- Filter chips on status now also include "scheduled".
- Search input wired to backend `search` query (already added in P3).
- Per-row "..." menu: Open · Cancel · Refund.

### C8. Acceptance Phase C

- Every list row has a clickable detail drawer with full context — zero need to query DB for triage.
- Cancel/refund flows are 1-click + undo.
- Scheduled bookings are visually distinct.

---

## 9. Phase D — admin polish (1 week)

### D1. Audit log timeline

Replace the v1 expand-row pattern with a vertical timeline:
- Each entry is one line: `<actor> <verb> <target> · <timeago> · [details]`.
- Verb mapping: `suspend_user → "suspended"`, `activated → "made live"`, etc. Defined in `src/lib/auditTemplates.js`.
- Click `[details]` → side-by-side `<LiveDiff>` of old/new value.
- Filters as chips up top: actor, action, target_type, date range.
- Pagination via `?page=` URL state.

**Backend ticket:** Add `total_count` + offset to `GET /admin/audit-log` response (audit P2).

### D2. Promo wizard

4-step modal:
1. **Type** — Percent off · Fixed off · Free shipping (latter behind flag).
2. **Value** — entered in ₹ (or %). Live preview: "User pays ₹450 instead of ₹500."
3. **Limits** — min order (₹), max uses (or unlimited), expires on (date picker, not days), per-user cap (if backend supports).
4. **Review** — summary + confirm. POST.

Edit existing promo: same wizard pre-filled (backend `PATCH /admin/promotions/:id` already exists).

### D3. Config typed inputs

Per-row input adapts to `value_type`:
- `bool`: toggle.
- `int`: number input with step + range hint from `description`.
- `float`: number input with step.
- `string`: text input.
- `json`: textarea with monaco-style highlighting (lazy-loaded chunk).

Validate before save. On save, debounce 500ms then `PATCH /admin/config/:key`. No bulk-edit textarea — bulk is replaced by group-level "save all" button per prefix.

### D4. Onboarding checklist

Dashboard card visible when **any of** the following are unconfigured:
- No active SDUI page for `home`.
- < 4 active home_promos.
- < 1 service category.
- No allowed actions.

Each item: status icon + label + CTA route. Hide entire card when all done; user can re-show via Help → Setup checklist.

### D5. Global search bar

Header input. Debounced 300ms. Calls multiple admin endpoints in parallel:
- `/admin/users?search=`
- `/admin/helpers?search=`
- `/admin/bookings?search=`
- (eventually: configs, promos)

Results grouped by type, ↵ opens drawer for the chosen result.

### D6. Keyboard shortcuts

Overlay shown via `?`:
```
cmd-k        Command palette
cmd-/        Search bar focus
g h          Go to Home (Dashboard)
g b          Go to Bookings
n p          New promo
?            This overlay
esc          Close drawer / dialog
```

### D7. Notification bell

Header bell shows admin alerts:
- Kill switch active for any page > 30 min.
- Config rolled back > 3 times in last 24h.
- > N% errors on /sdui/page in last 5 min.

Source: poll `/admin/runtime/metrics` + `/admin/audit-log` every 60s. Alert rules in `src/lib/alertRules.js`.

### D8. Acceptance Phase D

- An admin who has never opened the CRM finishes setup checklist in < 10 minutes.
- Every form has inline validation; no page reload needed for any flow.
- Audit log reads like a story.

---

## 10. Phase E — power features (optional, 1 week)

### E1. SDUI version diff

`/sdui?compare=1.1,1.2` → split-pane `<LiveDiff>`. Section-level + raw-JSON view. "Copy 1.1's footer to 1.2" copy button.

### E2. Scheduled publish

In the Lifecycle stepper, "Go Live" gets a dropdown: **Now · At specific time**. Picks a future timestamp. Server-side cron flips status at that time.

**Backend ticket:** Add `scheduled_for TIMESTAMPTZ NULL` to `sdui_page_configs`. New cron job: every minute, `UPDATE … SET status='active' WHERE status='staged' AND scheduled_for <= now()`. Cron emits an audit log entry as the system actor.

### E3. A/B experiment dashboard

`/sdui/experiments`:
- List experiments with %, kill-switch button, impression count, conversion (if event tracking is in place).
- Drill-in shows two variants side-by-side with metrics from `/admin/analytics`.

Depends on analytics events surfacing experiment_id (already ships via SDUI request context) and a rollup query.

**Backend ticket:** `GET /admin/sdui/experiments` aggregating from `sdui_page_configs.experiment_id` + analytics rollup.

### E4. Multi-page support

Today only `home` is SDUI'd. Plan for `services`, `profile`, `service_detail`. CRM gains a "+ New page" button.

Requires a per-page section-type registry on the client; safe layouts per page id.

### E5. Saved filters

Each list view persists `?filter=...` state in URL + localStorage. "Save as" dropdown stores named presets (per user, per list).

---

## 11. Backend changes summary

Tickets to file (grouped):

### B (SDUI editor)
- `GET /admin/sdui/sources` — registered $ref source list.
- `GET /admin/sdui/section-types` — registered section types + data schema.
- `GET /admin/sdui/screens` — registered RN screens for navigate actions.
- `POST /admin/sdui/render-preview` — render in-progress draft against the BFF pipeline without persisting.
- Unify lifecycle response shape to `{ config, warnings? }` (audit P2).
- `GET /admin/pages` returns `[{ id, name, last_active_version }]` (audit P2).
- `GET/POST/PATCH/DELETE /admin/promos` for `home_promos`.

### C (operational)
- `GET /admin/bookings/:id/detail` — joined view (timeline + services + helper + payment).
- `GET /admin/services/:id/{includes,excludes,steps,addons}` + write counterparts.
- Add `helpers.documents jsonb` if not present, plus admin GET.

### D (polish)
- `GET /admin/audit-log` — return `total_count` + offset (audit P2).
- Permissions exposed on `/me` response (verify; add if missing).

### E (power)
- `sdui_page_configs.scheduled_for TIMESTAMPTZ NULL` + cron worker.
- `GET /admin/sdui/experiments` aggregator.

---

## 12. Migration strategy

### 12.1 Branch + flag

- New branch `feature/crm-v2`.
- `VITE_CRM_V2=1` env or `?v2=1` query enables v2 routes.
- Both v1 and v2 coexist in `App.jsx` until parity declared.

### 12.2 Page-by-page swap order (lowest-risk first)

1. **SDUI editor** — biggest win, isolated surface. Swap first.
2. **Refunds** — simple list+drawer.
3. **Pending pros** — same.
4. **Bookings** — adds drawer + scheduled column.
5. **Customers** — drawer.
6. **Workers** — drawer + perf graph.
7. **Promotions** — wizard.
8. **Config** — typed inputs.
9. **Audit log** — timeline.
10. **Banners** — visual editor.
11. **Notifications** — composer + history (history requires backend).
12. **Dashboard** — onboarding checklist + alerts.

A page is "swapped" when:
- v2 route exists and reaches functional parity.
- v2 form passes manual QA against the same backend.
- v1 route renders a banner: "This page is moving. Try the new version → ".
- After 1 full week of v2-only usage by Aditya without regressions, delete v1 page.

### 12.3 Cleanup at end

- Delete v1 pages.
- Drop `crm.v2` flag.
- Bump Vite chunk strategy if bundle grows past 500 KB gzip (target: stay under).

---

## 13. Testing strategy

### 13.1 Component-level

- Storybook-equivalent: `/dev/components` route renders every primitive in every state.
- Vitest unit tests for: form validators (zod), permission gate (`<Can>`), URL drawer hook.

### 13.2 Page-level

- Vitest + RTL for critical user flows: login → SDUI editor → drag → save → publish; promo wizard; refund settle + undo.
- Mock axios with MSW; never hit real backend in CI.

### 13.3 E2E

- Playwright. Two flows initially:
  - "Newbie ships first SDUI change": signs in → opens /sdui → edits hero copy → publishes → verifies via curl that public `/api/v1/sdui/page/home` reflects.
  - "Refund operator flow": creates a synthetic pending refund via Postgres → settles via CRM → verifies status='settled'.
- Run on every PR. Sandboxed Postgres + Redis + API in docker-compose.

### 13.4 Manual QA matrix

Per page swap, fill out a matrix of `(role × permission combos)`:

|                     | super-admin | manage_users only | view_analytics only |
|---------------------|-------------|-------------------|---------------------|
| Bookings list       | ✓           | ✓                 | ✓                   |
| Booking cancel      | ✓           | ✓                 | hidden              |
| ...                 |             |                   |                     |

### 13.5 Accessibility

- All interactive components keyboard-reachable.
- ESC closes drawers/dialogs.
- Tab order respects visual order.
- Form-kit fields auto-link `<label htmlFor>`.
- Color-contrast minimum AA on text and AA-large on UI elements (use `eslint-plugin-jsx-a11y` + manual sweep).

---

## 14. Risks

| Risk | Mitigation |
|------|------------|
| RN-Web preview shim doesn't render real components 1:1 | Fallback to server-rendered screenshot (B5b). Pick after a 2-day spike. |
| Drawer-over-drawer + cmd-k z-index conflicts | Centralised z-index scale (`src/lib/zIndex.js`). Test matrix. |
| Permission API doesn't expose all perms on /me | Add a backend ticket; meanwhile gate v2 launch on it. |
| Rebuilding 12 pages stretches 6 weeks | Page-by-page swap means partial v2 is shippable at any time. Stop at any phase boundary. |
| Adopters miss v1 features we drop | Each swap PR includes a parity checklist; v1 stays mounted until checklist green. |
| Bundle size balloons (cmdk + dnd-kit + monaco) | Code-split by route. Monaco lazy-loaded only on Config page. |
| Operators trained on v1 rebel against new layout | Inline "what's changed" tooltip on first v2 visit. v1 remains for one rollback week. |

---

## 15. Success metrics

Tracked from analytics events fired by the CRM (extend `sdui_action` style logging to admin actions).

| Metric | v1 baseline (estimate) | v2 target |
|--------|------------------------|-----------|
| Time-to-first-SDUI-publish (newbie) | > 30 min | < 5 min |
| Promo creation success rate | ~60% (cents bug + form) | > 95% |
| Admin tasks per session | 3–4 | 6–8 |
| Page abandonments mid-flow | unknown | < 10% |
| `window.confirm` invocations | every destructive op | 0 |
| Number of /admin endpoints reachable from UI | ~70% | 100% (all surfaced) |
| First-week NPS from operators | n/a | +20 |

---

## 16. Estimated timeline

- **Week 1** — Phase A foundations (1 engineer)
- **Week 2** — Phase B SDUI editor (1 engineer, can parallel Phase C with second engineer)
- **Week 3** — Phase B continues + Phase C operational drawers
- **Week 4** — Phase C continues + Phase D admin polish
- **Week 5** — Phase D continues + parity QA + page swap
- **Week 6** — Cleanup + delete v1 pages + Phase E spike (optional)

Two engineers in parallel from Week 2: 4 weeks total.

---

## 17. Open questions

1. Do we want to keep `househelp-test-client` as the package name or rebrand to `zopmop-admin`?
2. Is RN-Web shim acceptable, or should we invest in server-rendered screenshots from the start?
3. Authentication flow: keep cookie-only or add a session-resume token for cmd-k server search reliability?
4. Should Audit log timeline support live tailing (websocket) or is 60s polling enough?
5. Multi-language support timeline — v2.1?

---

## 18. What stays unchanged

- Cookie-auth + CSRF interceptor in `src/api/client.js`.
- Tailwind palette + dark-only theme.
- Vite + React 19 toolchain.
- Existing endpoint contracts (only additive changes proposed).
- Login flow.
- Health/ready endpoints.

---

## 19. Out of scope for v2

- Mobile-responsive redesign.
- White-label / multi-org support.
- SSO / OAuth login.
- Bulk import (CSV) for any resource.
- Automated test data seeding from CRM.
- Dark/light theme toggle (dark-only confirmed adequate).
- Real-time collaboration on configs.

---

## 20. Glossary

| Term | Meaning |
|------|---------|
| SDUI | Server-driven UI — see docs/SDUI.md |
| BFF | Backend-for-frontend (`internal/bff` package) |
| Stage | v1 lifecycle stage `staged`. Renamed to "Test" in v2 UI. |
| Active | v1 lifecycle stage. Renamed to "Live" in v2 UI. |
| Drawer | Right-side panel pattern (sec 5.1). |
| Section | A unit in an SDUI page config — hero_carousel, live_pill, etc. |
| $ref | Server-resolved reference in an SDUI config (e.g. `user.first_name`). |
| Allowed action | API endpoint+method whitelist for `api_call` SDUI actions. |
| Kill switch | Redis flag forcing the safe-fallback layout for a page. |
