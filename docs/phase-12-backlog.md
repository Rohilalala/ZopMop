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

