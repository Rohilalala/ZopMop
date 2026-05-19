# Phase 12 Backlog

Carry-forward items surfaced during Phases 11A → 11H. Not a roadmap — a debt
ledger. Each item lists the surface area, why it's deferred, and a rough
priority bucket. Priorities are P0 (regulatory / security blockers), P1
(operationally painful), P2 (polish).

## PII / Security

- **P0 — Aadhaar encryption-at-rest** with KMS-managed key. Stored plaintext
  today in `helpers.aadhaar_number`. Acceptable for pilot scale only.
- **P0 — Aadhaar masking** in non-superadmin GET responses (server-side at
  the repository layer, not client-side). Currently any admin sees the full
  number on `/admin/workers/:id`. TODO comment lives at
  `internal/crm/workers/repository.go::Get`.
- **P0 — Bank account encryption-at-rest** with the same KMS key.
- **P1 — Aadhaar verification flow** via Karza or Digio API. The
  `aadhaar_verified` boolean column exists; nothing flips it today.
- **P1 — Bank account verification** via penny-drop API (Razorpay Verify or
  Cashfree Validations). Same shape: `bank_verified` boolean exists, no
  pipeline.
- **P1 — Server-side audit of admin "Reveal" actions** on PII fields.
  `PIIRow` in `WorkerDrawer.tsx` toggles client-side only; the server has no
  record of who looked at which Aadhaar. Add a `POST /admin/workers/:id/pii-
  reveal` audit-only endpoint that the SPA hits on toggle.
- **P2 — Zone approval idempotency on stale targets**. Backend
  `DecideZoneApproval` uses `WHERE status='pending'` but returns 200 even
  when 0 rows are affected. Should return 409 to surface racing admins to
  the SPA. Filed at `internal/shift/repository.go::DecideZoneApproval`.

## Performance / Bundle

- **P1 — Lazy-load all routes** via `React.lazy` + `Suspense`. Bundle is
  currently 1.45 MB minified (357 KB gzipped). Login + Dashboard pull the
  whole graph including Google Maps SDK.
- **P2 — Vendor-chunk split** via Vite `build.rollupOptions.output
  .manualChunks`. Separate `react`, `@tanstack/react-query`, `@react-google-
  maps/api` into their own chunks for browser cache stickiness.
- **P2 — Image optimization for KYC photos** — current Phase 7 photo
  capture stores up to 4 MB base64 data URLs in `photo_url`. Compress to
  ~200 KB JPEG before upload + store an S3 URL instead.

## UX polish

- **P1 — URL search params for OrdersPage filters**. AuditPage already does
  this — port the `useSearchParams` pattern. Back-navigation from
  `/orders/:id` currently resets filters.
- **P1 — Server-side date range filter for `/admin/audit`** endpoint. Client
  side filtering operates only on the fetched page; data older than the
  limit is invisible. Backend should accept `from` / `to` ISO timestamps.
- **P1 — UsersPage handles `?id=` deep-link query param**. AuditPage entity
  links and OrderDetailPage CustomerCard both point to `/users?id=...` but
  UsersPage ignores it. Same fix needed for WorkersPage.
- **P2 — Dynamic module dropdown for AuditPage** via `GET
  /admin/audit/modules` — currently hardcoded 23-string list at the top of
  `AuditPage.tsx`. New backend modules don't appear until the constant is
  bumped.
- **P2 — Lazy-load OrderDetailPage available-workers list** w/ debounced
  search and infinite scroll. Current flat list works for ≤50 workers; will
  thrash beyond that.
- **P2 — Sidebar group collapse state persistence** (localStorage).
- **P2 — Browser notification toggle for Zone Approvals** — deferred during
  Phase E. Opt-in bell with `Notification.permission` + Web Audio chime.
- **P2 — CSV export for Audit Log**. Defer unless regulatory need arises.
- **P2 — WorkerDrawer "Open Full Detail" button** → standalone
  `/workers/:id` detail page. Drawer-with-tabs covers 95% but a full page
  helps for forensic deep-dives.

## Audit log

- **P2 — admin_id UUID fallback** when `admin_email` is null in the
  response. Currently shows "—". Requires the backend to also surface
  `admin_id` on the AuditRow shape.
- **P2 — Audit entry tagging / starring** for follow-up.
- **P2 — Diff view between before/after** for update actions. JSON blocks
  are fine for view; a structured diff would be a meaningful UX upgrade.

## Multi-admin / Roles

- **P1 — `POST /admin/admins` endpoint** for inviting new admins. Currently
  only the seed admin can log in; new admins must be added via psql.
- **P1 — Admin roles + permission groups** (not wildcard). Today
  `permissions` field is just `["*"]` for the seed admin. Multi-tenant
  admin teams need fine-grained role assignment.
- **P1 — Settings → Team page** with invite flow once the endpoint exists.
- **P2 — Admin-email join for "applied by" fields**. `Deductions` history
  shows UUID only because `admin_pro_deductions` doesn't join `crm_admins`.
  Same for `admin_booking_notes` (already joins but inconsistent across
  modules).

## CRM API hardening

- **P1 — 409 on stale concurrent updates** for zone approvals, refund
  re-approvals, worker suspend-while-suspended, etc.
- **P2 — Idempotency keys** on POST endpoints that may be retried by the
  SPA (refund creation, deduction add). Header: `Idempotency-Key`.
- **P2 — Webhook secret rotation** in Platform settings.
- **P2 — Per-admin rate limiting** on the CRM API.

## Deprecation

- **P1 — Remove `cmd/api /admin/zone-approval-requests`** routes. Phase 11B
  consolidated zone approvals to `cmd/crm-api`. The legacy `cmd/api` admin
  surface still exposes them and writes to the legacy `audit_log` table.
- **P2 — Remove legacy `admin_users` table** once nothing reads from it.
  Migration 105 dropped the FK on `zone_approval_requests.reviewed_by`;
  other tables (legacy audit, sessions) may still depend on it.
- **P2 — Remove the unused `proMode` zustand store + sidebar toggle** if no
  page consumes it after the OrdersPage drawer was deleted in Phase H.
  (`grep proMode src/` should be empty.)

## Zone geometry

- **P2 — CRM polygon editor** — admin can draw multi-vertex zone boundaries instead of circles; replaces lat/lon/radius_km when set. Today `internal/crm/zones/zones.go:2` confirms circle-only.
- **P2 — Dispatcher adopts `service_zones.boundary`** — ST_Contains/ST_Within check when boundary is set; falls back to `pro_zone_assignments` + `helpers.locality` otherwise. Today `dispatch.go:181` only JOINs for zone name; the GEOGRAPHY(POLYGON) column from migration 100 is dead.

## Pre-pilot bug batch carry-overs

- **P2 — NEW-2: Analytics revenue chart Y-axis collapsed.** Revenue chart on
  `AnalyticsPage` renders with a degenerate Y-axis (all bars flat / scale
  collapsed to zero range). Chart-scaling bug, not a data bug — the
  `/admin/analytics/revenue-daily` points return correct `value`s. Suspect
  the domain calc when all points share a magnitude or a single non-zero
  point. MEDIUM. Deferred out of the pre-pilot bug batch.
- **P2 — BUG #6: "Flags cards vanish on toggle off" — UNREPRODUCIBLE as
  specified; needs a live repro.** The batch spec attributed this to a
  "render filter excluding off flags" in `FlagsPage.tsx`. Investigated:
  there is NO such filter — `FlagsPage` groups by `def.category` and renders
  every flag unconditionally, and the backend `flags.Service.List`
  (`internal/crm/flags/flags.go:71-88`) + `Handler.List`
  (`handler.go:47-54`) return every registered flag regardless of value
  (a `false`/empty value round-trips fine). No code path drops "off" flags.
  The Modal.tsx fix (BUG #2) now surfaces any silent error, so the next step
  is a live repro capturing the exact flag key + Network/Console output when
  a card disappears (likely a transient `listFlags` refetch error or a
  specific flag's value failing `JSON.unmarshal` server-side, not a filter).
  No code changed — fixing non-existent filter code was declined per
  root-cause-before-fix discipline. **ROOT CAUSE LATER FOUND** (see Flags
  UX overhaul below): `flags.Service.List` iterates a Go `map` (`flags.go:78`),
  which Go randomizes — every `/admin/flags` refetch returns a different
  order, so after toggle→invalidate→refetch a card "jumps"/appears to
  vanish from its prior position. Fixed as part of the overhaul's
  server-side stable sort, not a render filter.

## Flags page UX overhaul

- **P1 — Staged flag edits with bulk atomic apply.** Today every toggle
  POSTs immediately (misclick = production change) and cards reorder on
  every refetch (root cause: `flags.Service.List` iterates a Go map →
  non-deterministic order; NOT active-first sorting).

  **Target state**
  - Toggle flips visual state only; does NOT POST.
  - Sticky top panel: "N unsaved flag changes" with a per-flag diff
    (old → new value).
  - "Apply N changes" commits all atomically; "Discard changes" reverts
    the UI to current backend state.
  - Card order stable regardless of flag value.

  **Backend changes**
  - New `POST /admin/flags/bulk-update` accepting `[{key, value,
    expected_current}]`. **Optimistic per-key concurrency**: apply
    atomically only if every flag's current value still equals
    `expected_current`; otherwise `409` listing the drifted keys (panel
    highlights them, admin re-reviews). Prevents silently clobbering a
    racing admin's change or a snapshot rollback.
  - Atomic apply: validate ALL values first (reject whole batch with
    per-key errors on any invalid value/unknown key); then a single
    multi-field Redis `HSET` (atomic) so it's all-or-none.
  - One snapshot + one audit entry covering the whole batch (reuse
    `SaveSnapshot` with a combined diff map; one `flag.bulk_update`
    audit Entry, not N).
  - `flags.List` response sorted server-side by (category,
    display_name). Frontend renders sections in category order, flags
    within each section in alphabetical order. Sort is stable regardless
    of flag value/last-modified time — toggling a flag never reorders
    cards.
  - Keep the existing per-key `PUT /admin/flags/:key` (rollback path /
    backward compat); FlagsPage stops using it. No deprecation needed.

  **Frontend changes**
  - Local pending-changes state model in `FlagsPage` (Map<key,
    {before, next}>), seeded/cleared from the query cache.
  - Sticky pending-changes panel component with diff + Apply/Discard.
  - Render order driven by the now-stable server response (no
    client-side re-sort on toggle).
  - On 409, mark drifted keys in the panel and refresh their baseline.

  Design decisions resolved in brainstorming 2026-05-19 (concurrency:
  optimistic per-key; sort: category then name A–Z). Remaining detail
  (panel visual design, exact 409 payload shape) to be designed when
  scheduled.

## CRM worker management

- **P1 — Rebuild WorkerDrawer with 4 tabs.** Phase D claim of 803 LOC was hallucination; file was committed empty. Need full Profile/Performance/Actions/Deductions structure with manual deduction form, leave adjustment, send notification, deductions history per Phase D spec. ~2-3 hours of focused work.

