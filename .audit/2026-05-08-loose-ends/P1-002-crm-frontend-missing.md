# P1-002 — CRM frontend missing from repo

**Severity:** P1
**Category:** OPS
**Surfaced by:** System walkthrough Part 4
**Date:** 2026-05-08

## Summary

`cmd/crm-api` is a complete production-grade admin backend (auth + TOTP +
audit logging + 13 modules including dashboard, workers, users, orders,
refunds, promos, banners, payouts, analytics, experiments, feature flags,
trust & safety, growth, zones, platform). But there is NO frontend in this
repository to consume it. `App/househelp-test-client.bak/` is unrelated dead
code. `docs/crmv2plan.md` plans a React 19 + Vite SPA on `feature/crm-v2`
branch but it's not built. Net result: ZopMop has no admin interface today.
Fix: scope out CRM v1 (minimum viable for launch ops) vs v2 (full plan), then
ship v1 in week 1 post-launch. ~2-3 days for v1.

## Finding

The CRM API is genuinely impressive — it has:
- Two-step login with TOTP enrollment
- Refresh token rotation with replay detection (RFC 6819 §5.2.2)
- 4-tier role system (viewer/support/admin/superadmin)
- Audit logging on every mutation
- Outbound webhooks for major events
- Idempotency keys
- Read replica routing for analytics

This is more than the user API has in some areas. But the audience for CRM
APIs is internal ops — without a UI, the CRM is unreachable by humans.

What likely happened: The backend got built with intent to ship a Vite
React SPA. Plan exists in `docs/crmv2plan.md`. Either the frontend was
deferred for the user-side launch, or it was started on a separate branch
that wasn't merged.

The implication: Once you launch ZopMop and have real users/helpers/orders,
you'll need to:
- Approve helper applications
- Process refund requests
- Cancel/reassign bookings
- Run promo campaigns
- Respond to disputes
- Send growth pushes

All of which require either:
1. A CRM UI
2. Hand-rolled curl/Postman scripts (dangerous, no audit trail of who did
   what, no role enforcement at the human level)
3. Direct DB queries (very dangerous, bypasses business logic, breaks
   idempotency)

## Evidence

```bash
ls App/                                         # No crm-frontend dir
cat docs/crmv2plan.md | head -30                # Plan exists
git branch -r | grep crm                        # Check feature/crm-v2 status
ls App/zopmop-crm 2>/dev/null                   # Explicit check
ls App/househelp-test-client.bak/               # Dead, no CRM pages
```

## Blast Radius

**At launch (assuming 0-50 users):** Manual ops via psql + curl is feasible
for a week. Painful but possible.

**Month 1 (50-500 users):**
- Helper applications pile up unreviewed
- Refund SLAs miss (no UI to triage queue)
- Promos can't be created safely without seeing existing ones
- No visibility into live order status
- Can't easily search "show me all bookings for user X"

**Month 2+ (500+ users):**
- Operational dysfunction. Things break, you have no UI to debug.
- Customer support takes hours instead of minutes per ticket.
- Decisions get made on stale data.
- You will deeply regret not having this.

## Reproduction

Try to do any admin task without the UI:
```bash
# "Approve a helper application"
psql 'postgres://...' -c "UPDATE helpers SET approval_status='approved' WHERE id=...;"
# Bypasses: audit log, outbound webhook (EventAdminWorkerApproved),
# role check, FCM notification to helper, etc.

# "Process a refund"
# ... requires multi-step state machine that has CAS locks, gateway calls,
# wallet credits, FCM. Manual psql will desync state.
```

These patterns work but are brittle, error-prone, and not auditable.

## Fix Plan

### Decision: v1 (minimal) vs v2 (planned)

**v2 (per docs/crmv2plan.md)**: Full React 19 + Vite SPA. All 13 modules.
Estimated 2-4 weeks of solo work. Right answer eventually. Not right answer
for "we're launching in 2 weeks."

**v1 (proposal)**: Bare-bones Next.js or React app. Only the modules you'll
actually need in launch month 1:

Tier 1 (must-have at launch):
- Login + TOTP
- Workers list + approve/reject + suspend
- Users search + suspend/ban
- Orders search + cancel/reassign + refund
- Refunds queue + approve

Tier 2 (within month 1):
- Dashboard KPIs
- Promos CRUD
- Audit log viewer

Tier 3 (month 2+):
- Banners
- Payouts
- Analytics
- Experiments
- Feature flags
- Trust & safety modules
- Growth campaigns

A Tier-1 v1 = 5 modules + login. ~2-3 days of solo work with AI assistance.

### Implementation path: Next.js (recommended)

Why Next.js over Vite SPA:
- Already what's deployed for marketing site (zopmop.com)
- Server-side rendering simplifies auth (cookie-based, no SPA token-juggling
  complexity for an admin tool)
- App Router + server actions = clean form handling without REST gymnastics
- Easy to deploy on Railway alongside existing services

Repo location: `App/zopmop-crm/` (new directory, new package).

Stack:
- Next.js 15 + App Router
- React 19 (matches mobile)
- TanStack Query for client-side data
- Tailwind + shadcn/ui (consistent with marketing site)
- TypeScript strict mode
- API client typed against the existing CRM API responses

Auth flow:
- Login page calls `POST /api/v1/admin/auth/login`, stores challenge JWT in
  HttpOnly cookie
- TOTP page calls `POST /api/v1/admin/auth/verify-totp`, server stores
  access JWT in HttpOnly cookie + refresh cookie auto-set by API
- Protected routes use Next.js middleware to check cookie + role
- Logout clears cookies + calls `POST /admin/auth/logout`

Deployment:
- Railway service: `App/zopmop-crm/`
- Domain: `crm.zopmop.com` or `admin.zopmop.com`
- Same project as ZopMop (motivated-fascination)

### Implementation path: Defer to v2

Skip building anything, ship v2 to launch deadline. Risk: launching without
admin UI is gambling.

## Recommendation

**Build v1 (Tier 1) in Next.js. Ship within 1 week.** Continue v2 plan
in parallel as a longer-term track.

## Effort

For v1 Tier 1 (login + 4 modules):
- Project scaffold + Next.js + Tailwind + shadcn: 2 hr
- Login + TOTP flow: 4 hr
- Layout + sidebar + role-aware nav: 2 hr
- Workers module (list + approve + suspend): 4 hr
- Users module (search + suspend): 3 hr
- Orders module (list + cancel + reassign): 5 hr
- Refunds module (queue + approve): 3 hr
- Deploy to Railway: 1 hr

**Total: 2-3 days solo with AI pair programming.**

For v2 (full): 2-4 weeks.

## Dependencies

- CRM API is already deployed-ready (ticket P1-003 covers actually deploying
  it)
- Shared TypeScript types from CRM API would help; if not present, generate
  via OpenAPI export or hand-write
- Decision needed: Next.js vs Vite SPA (per docs/crmv2plan.md)

## Acceptance Criteria

For v1:
- Admin can login + complete TOTP enrollment
- Admin can approve a helper application end-to-end (UI → API → DB → FCM)
- Admin can find a user by phone, suspend them
- Admin can find an order, cancel it
- Admin can approve a refund
- Audit log shows the admin's email + action for each operation
- Role enforcement: a `support` admin cannot suspend, only read

## Related

- P1-003 covers deploying `cmd/crm-api` itself (no Dockerfile today)
- P0-001 (event_outbox) is independent but admin actions emit outbox events,
  so the consumer should be live before CRM goes live

## Anchor

New repo location to be created: `App/zopmop-crm/`
Pre-fix tag (when implementation starts): `pre-build-crm-v1`
