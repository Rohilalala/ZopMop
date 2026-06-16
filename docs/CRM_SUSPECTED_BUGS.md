# ZopMop CRM — Suspected Bugs (UNVERIFIED)

> 117 findings from the mapping pass. Each is a **single-reader suspicion** — verify against current code before fixing. Counts: P0:3 · P1:24 · P2:48 · P3:42

## P0 (3)

### P0.1 [orders] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/refunds/refunds.go:1037-1046`
- **Problem:** Refund-from-order has a check-then-insert race (TOCTOU). CreateFromOrder calls findActiveRefundForBooking (the duplicate guard) and then CreatePendingForBooking (the INSERT) with no row lock or unique constraint spanning the two. Two concurrent POST /admin/refunds/from-order/:orderId for the same booking can both pass the duplicate check before either inserts, creating two pending_refunds rows and refunding the customer twice. Contrast with Approve/Retry which use lockForApproval (CAS). The single-button UI mostly hides this (mutation isPending disables the button), but two tabs or two admins can collide.
- **Verify:** Open the same un-refunded order in two browser tabs (admin role). Enter full amount + reason in both and click Issue refund in both as simultaneously as possible. Then query pending_refunds for that booking_id — if two rows exist (and especially if two gateway calls fired), money moved twice. Alternatively fire two concurrent curl POSTs to /admin/refunds/from-order/:orderId.

### P0.2 [workers] `App/househelp-api/internal/crm/workers/repository.go:235-247 (Get) and model.go:62-71; App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx:528-585`
- **Problem:** C7 plaintext PII exposure with no role masking and no reveal audit. GET /admin/workers/:id returns full plaintext aadhaar_number and bank_account_number to ANY role >= support (workers.read=support). The masking is purely client-side (eye toggle); the API ships the raw values regardless of role. The TODO at repository.go:233-234 to null out PII for non-superadmin is unimplemented. Reveal in the UI writes no audit event (only page-load worker.view is logged).
- **Verify:** With a support-role token call GET /admin/workers/:id and observe aadhaar_number/bank_account_number present in plaintext in the JSON. Confirm no audit row is written when toggling the eye icon (only the initial worker.view exists).

### P0.3 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:156-197`
- **Problem:** validateCreateRequest enforces only code presence and discount bounds. The doc comment at line 157 claims 'basic non-negativity', but min_order_cents, max_uses, and max_per_user are never validated. Negative or absurd values flow straight to the INSERT/UPDATE. A negative max_per_user or max_uses could weaken per-user/total redemption caps at booking time (money exposure), and negative min_order is nonsensical.
- **Verify:** POST /admin/promos (admin) with min_order_paise=-100, max_uses=-5, max_per_user=-1 and a valid discount. If it returns 200, the values are unvalidated. Confirm whether a DB CHECK catches them; if not, this is a real gap. (Run PROMO-NEG-04.)

## P1 (24)

### P1.1 [auth-rbac] `App/househelp-api/internal/crm/auth/service.go:164-241 (VerifyTOTPAndIssue)`
- **Problem:** Challenge token is not single-use. VerifyTOTPAndIssue validates the challenge JWT but never marks it consumed, so the same challenge_token + a still-valid TOTP code can be POSTed repeatedly within the 5-minute challenge TTL, each time creating a brand-new session row. Combined with TOTP codes being reusable within their 30s window (no used-code/jti tracking), a captured challenge+code mints unlimited sessions.
- **Verify:** Run flow AUTH-25: capture challenge_token from /login, compute a valid TOTP, POST /admin/auth/totp/verify with the same token+code 3x within 30s. Each returns 200 and SELECT count(*) FROM crm_admin_sessions WHERE admin_id=... increases by one per call.

### P1.2 [auth-rbac] `App/househelp-api/pkg/crmconfig/config.go:86 (RefreshCookieSecure default true) + internal/crm/auth/handler.go:255-266 (setRefreshCookie)`
- **Problem:** CRM_REFRESH_COOKIE_SECURE defaults to true. For local QA over plain HTTP (http://localhost:5174 -> :8090) the browser will not store/send a Secure cookie, so /refresh and session persistence silently fail and every reload bounces the tester to /login — easily mistaken for a login bug. Must set CRM_REFRESH_COOKIE_SECURE=false for local testing.
- **Verify:** Run flow AUTH-26: start crm-api with the default config, log in, reload — /refresh returns 401 'no session'. Set CRM_REFRESH_COOKIE_SECURE=false and the same flow persists the session.

### P1.3 [dashboard] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/alerts/alerts.go:143`
- **Problem:** POST /admin/alerts/read-all is mounted with NO RequirePermission middleware — only the JWT group auth applies. Every other dashboard read is gated (alerts.read=viewer), but this WRITE is reachable by any authenticated admin including the lowest 'viewer' role. There is also no audit-log entry for this mutation (other CRM writes are audit-wrapped in main.go). A viewer can mutate read_by on every alert row globally.
- **Verify:** As a viewer-role admin, grab the access token and POST /admin/alerts/read-all with it; expect 200 {ok:true}. Then GET /admin/alerts and confirm read_by now contains the viewer's adminID on every alert. Check backend logs / audit table for a missing audit record. (See flow DASH-P0-15.)

### P1.4 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/analytics/analytics.go:131-140 vs 46-62`
- **Problem:** Revenue is computed against TWO different timestamp columns in the same screen. Summary.revenue_paise sums completed bookings filtered by created_at BETWEEN from AND to. RevenueDaily sums completed bookings filtered by completed_at per day bucket. For the same date range the 'Revenue' KPI card and the sum of the 'Revenue / day' chart will not agree whenever a booking's created_at and completed_at fall in different windows (the common case for multi-day jobs or month-boundary completions). This is a money-reporting reconciliation hazard.
- **Verify:** Seed a completed booking created 40 days ago but completed yesterday. Open /analytics at 30d. The chart includes its revenue (completed_at in range) but the Revenue card excludes it (created_at out of range). The two totals diverge.

### P1.5 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/AnalyticsPage.tsx:23-27,44-104`
- **Problem:** The page never handles query error state. It branches only on isLoading and empty (data?.length === 0). On a backend 500, summary.data is undefined so the stat cards render permanent skeletons, and the charts (data ?? []) hit the empty branch and show 'No data in range'. A genuine server error is therefore presented to the operator as 'no data', with no toast and no retry affordance — silently misleading.
- **Verify:** Break the read pool (point CRM_DATABASE_READ_URL at a DB without the bookings table) and reload /analytics. Endpoints return 500 but the UI shows empty charts and stuck stat skeletons instead of an error.

### P1.6 [orders] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/orders/orders.go:409-422`
- **Problem:** MarkComplete has no source-status whitelist — it forces ANY non-terminal order (including pending/searching with no helper assigned) straight to 'completed' and stamps completed_at. The detail page only disables the button for non-completable statuses (accepted/in_progress/arrived/en_route), but that is client-only; a direct POST /admin/orders/:id/complete on a 'pending' order succeeds, bypassing the entire dispatch/accept lifecycle and triggering downstream earnings on an order with possibly no helper. The handler comment claims 'Pro Mode only on the SPA' but there is no Pro-Mode/IsProduction guard server-side.
- **Verify:** As admin, take a 'pending' booking id and POST /admin/orders/:id/complete directly (curl). Observe 200 {ok:true} and status flips to completed with completed_at set, despite never being accepted by a pro. Check whether earnings/rating side effects fire on a helper-less order.

### P1.7 [payouts-payroll] `App/househelp-api/internal/crm/payouts/payouts.go:128-141, 232-243`
- **Problem:** Legacy crm_payouts mark-paid/mark-failed record audit BEST-EFFORT and OUTSIDE the DB transaction (h.audit is a fire-and-forget call after the UPDATE returns, with no error propagation). If the audit recorder fails or the process dies between the UPDATE commit and the audit insert, a money state change (paid/failed) lands with NO audit trail. The payroll-engine module deliberately does this inside one tx (payroll.go:258); the legacy module does not.
- **Verify:** Mark a legacy payout paid, then break/stub the audit recorder (or inspect crm_audit_log): the status flips to paid even though no audit row is guaranteed. Compare with payroll mark-paid which writes payout_audit_log atomically.

### P1.8 [payouts-payroll] `App/househelp-api/internal/crm/payouts/payouts.go:128-141 (MarkPaid) & migration 041_crm_modules.up.sql crm_payouts`
- **Problem:** Legacy mark-paid does NOT record WHO marked it paid — crm_payouts has no paid_by column and the UPDATE only sets status/paid_at/external_ref. For a money action this loses accountability at the row level (only the best-effort audit log, see above, carries the admin id). The payroll-engine table stores paid_by_admin_id directly.
- **Verify:** Mark a legacy payout paid as admin A; query crm_payouts row — there is no field identifying admin A. Contrast payouts table which has paid_by_admin_id.

### P1.9 [workers] `App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx:642-649 & 692-716; App/househelp-api/internal/crm/workers/repository.go:773-783`
- **Problem:** Force-offline ignores the active-job warning and strands in-flight bookings. The repo comment (repository.go:354-355) says HasActiveJob is 'used before force-offline to surface a warning', but the Force-offline ConfirmModal never calls workerActiveJob nor warns; and ForceOffline only sets is_available=FALSE without cancelling/reassigning the active booking, so a worker with an accepted/arrived/in_progress job is silently pulled from matching while the job remains assigned to them.
- **Verify:** Set up a worker with a booking in accepted/in_progress and is_online true. Click Force offline, confirm. Observe no warning was shown and the booking row still has helper_id set and status unchanged.

### P1.10 [workers] `App/househelp-api/internal/crm/workers/repository.go:728-739 (Reject) and handler.go:216-227`
- **Problem:** Reject reason is collected and required but never persisted to the worker record. The handler requires a non-empty reason and the UI comment/doc says it is 'stored as a note', but repo Reject only flips approval_status='rejected' and discards the reason; the only place the reason survives is the audit log. Future review of why a pro was rejected is not visible on the worker (no suspend_reason-equivalent for rejection).
- **Verify:** Reject a pending worker with reason 'fake documents'. Query helpers/users for that worker — no rejection reason is stored anywhere on the record; only the audit log has it.

### P1.11 [workers] `App/househelp-api/internal/crm/workers/repository.go:708-724 (Approve)`
- **Problem:** No state-machine guard on lifecycle transitions. Approve runs an unconditional UPDATE helpers SET approval_status='approved' against ANY helpers row regardless of current state, so a 'rejected' or already-'active' worker can be (re)approved, and approve does not clear is_suspended/banned. The FE hides the button for non-pending states but the API has no guard, so direct calls or stale UI can move a rejected worker straight to approved with no audit trail of the prior state being unexpected.
- **Verify:** Take a rejected worker, POST /admin/workers/:id/approve directly — it returns 200 and the worker becomes active despite never being re-reviewed as pending.

### P1.12 [zone-approvals] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zoneapprovals/handler.go:67-88 (Reject) — only NULLIF in repository.go:480`
- **Problem:** Reject 'reason' min-length is enforced only in the React UI (notes.trim().length < 5). The backend Reject handler does no length validation: it parses notes and stores NULLIF($4,''). A direct API call (or any non-SPA client) can reject with empty or 1-char notes, producing rejections with no auditable reason. For an audit-logged compliance surface this is a validation gap.
- **Verify:** POST /admin/zone-approvals/<pendingId>/reject body {"notes":""} with admin JWT -> 200 'rejected', DB notes=NULL. Repeat with {"notes":"x"} -> stored verbatim.

### P1.13 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/trustsafety/trustsafety.go:142-154`
- **Problem:** ResolveDispute has NO state guard — the UPDATE matches any row by id with no `AND status != 'resolved'` clause (contrast SetDisputeStatus at line 166 which excludes resolved/closed). Re-resolving an already-resolved dispute returns 200 and silently overwrites resolution and resolved_at, and a second audit row is written. There is no reopen path, so the only effect is data being rewritten on a closed case.
- **Verify:** Resolve a dispute, then POST /admin/disputes/{id}/resolve again with a different {resolution}. Observe 200 {ok:true} and that crm_disputes.resolution/resolved_at changed. (UI hides the button on the Resolved tab, so reproduce via API.)

### P1.14 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/DisputesPage.tsx:121-130`
- **Problem:** The resolve ConfirmModal's confirm action (onConfirm={() => m.mutateAsync()}) is not gated by m.isPending, and the Resolve trigger/confirm button is not disabled while the mutation is in flight (unlike the status-transition buttons which use transition.isPending at lines 81/92). Combined with the missing backend idempotency guard, a double-click can fire two resolve POSTs.
- **Verify:** Throttle the network, click Resolve, type an outcome, double-click the confirm 'Resolve' button. Check the network tab for two POSTs and the audit log for two dispute.resolve rows.

### P1.15 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:232-255`
- **Problem:** Update() does not re-check 'expires_at must be in the future'. Create() has this guard at lines 203-205 but Update() omits it. An admin editing any field can set the expiry to a past date and the API returns 200, producing a promo that is silently dead/expired.
- **Verify:** Open an existing promo's Edit modal, set 'Expires at' to yesterday, Save > Save. If you get toast 'Promo updated.' (HTTP 200) instead of a 400, the guard is missing. (Run PROMO-EDGE-07.)

### P1.16 [promos] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/PromosPage.tsx:16-86`
- **Problem:** The list shows at most `limit` (50) rows and offers no pagination UI. params.offset is initialized to 0 and never updated anywhere (no next/prev controls). When total_count > 50, promos beyond the first page are unreachable except by searching by code. The backend supports offset, the frontend never sends a non-zero one.
- **Verify:** Seed 60+ promos and load /promos. Only 50 render; there is no way to view the rest. (Run PROMO-EDGE-05.)

### P1.17 [banners] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/banners/banners.go:183-197 (Reorder) and /Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/BannersPage.tsx:32-39 (move)`
- **Problem:** Reorder is non-idempotent and race-prone. The backend Reorder sets display_order=index only for the ids passed and never verifies the list covers all banners or that ids exist; a partial/stale list leaves other rows at their old display_order, producing DUPLICATE display_order values. The frontend move() calls reorder.mutate on every arrow click with NO disable-while-pending guard, so rapid double-clicks or two tabs with stale lists fire overlapping reorder POSTs that race (last-writer-wins, can corrupt ordering).
- **Verify:** See BAN-20 (two-tab / double-click race) and BAN-21 (POST /admin/banners/reorder with {"ids":["<oneId>"]}). After either, GET /admin/banners and observe two banners sharing the same display_order, or a non-sequential order.

### P1.18 [push] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/growth/growth.go:32-44, 135-153, 211-226`
- **Problem:** The Go PushMsg struct and the ListPush/GetPush SELECTs do not include sent_count, delivered_count, failed_count, or error_message — even though those columns exist (migrations 044, 045) and are written by SendPush. The frontend PushMsg type and PushRow component (PushPage.tsx:260-291) render Sent/Delivered/Failed counts and the failed error_message, but they will ALWAYS be undefined. Result: the delivery-stats line never appears for sent pushes, and a failed push never shows WHY it failed. Operators retry blind.
- **Verify:** Send a push (PUSH-04) and refresh. The list row never shows the 'Sent: x · Delivered: y · Failed: z' line. Inspect the GET /admin/growth/push response in devtools Network — the JSON objects have no sent_count/delivered_count/failed_count/error_message keys. Force a failed push and confirm no red error text renders above the body.

### P1.19 [push] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/PushPage.tsx:98-130`
- **Problem:** None of the create/send/cancel/retry mutations define an onError handler. When the backend returns 4xx (e.g. 'scheduled_at must not be in the past', 'push is sent, cannot resend', 'push already claimed by another dispatcher', or any 403), the error is swallowed: no error toast is shown, and for create the confirm modal's onConfirm rejects so fields are not reset and the modal behavior is inconsistent. The operator gets zero feedback that the action failed.
- **Verify:** Run PUSH-10 (schedule in the past) and PUSH-11 (cancel/send on a terminal-state push). Observe that no error toast appears and the UI silently does nothing while the Network tab shows a 400 response.

### P1.20 [push] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/notification/service.go:40-59, 115-122, 198-206; /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/growth/growth.go:233-333`
- **Problem:** There is NO IsProduction() guard anywhere in the push send path. The only thing preventing real FCM delivery in dev is fcmClient==nil (i.e. FIREBASE_CREDENTIALS_JSON unset/invalid). The repo non-negotiable (App/CLAUDE.md, root CLAUDE.md) requires IsProduction() to gate push/SMS/payment side effects — a previous incident (PR #27) fired real SMS in dev for exactly this reason. Any dev/staging environment that has valid Firebase creds set (common, since the same creds power other features) will dispatch real pushes to real user/pro devices the moment an admin clicks 'Send now'.
- **Verify:** Start crm-api in a non-prod config but with a valid FIREBASE_CREDENTIALS_JSON. Create + send a push to 'users'. Real devices receive it; backend logs the real FCM dispatch (not the 'mocked (FCM offline)' line). There is no environment check that would have blocked it.

### P1.21 [experiments-flags] `App/househelp-api/internal/crm/experiments/experiments.go:159-181 (SetStatus)`
- **Problem:** No state-machine transition guard. SetStatus runs an unconditional UPDATE to whatever target status is requested, so any transition is allowed via the API (e.g. draft -> rolled_out, completed -> running, paused -> start again). The DB CHECK only constrains the enum value, not the path. The FE merely hides buttons; a direct API call (or a stale tab) can drive an experiment into a nonsensical state (e.g. rolled_out with started_at NULL).
- **Verify:** As admin, POST /admin/experiments/:id/rollout {winner:'<vid>'} against a draft experiment; observe {ok:true} and status becomes rolled_out with started_at still null and ended_at set. See EXP-07.

### P1.22 [experiments-flags] `App/househelp-api/internal/crm/experiments/experiments.go:242-255 (Rollout)`
- **Problem:** Rollout does not validate that the supplied winner is one of the experiment's variant ids. Any non-empty string is stored into winner_variant. Since the FE later renders the winner / a future engine may apply it, an invalid winner is a data-integrity hole.
- **Verify:** POST /admin/experiments/:id/rollout {winner:'does-not-exist'} on a completed experiment; observe it is accepted and persisted. See EXP-08.

### P1.23 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zones/zones.go:24-41,107-110,162-172`
- **Problem:** Money/state smell: surge Multiplier and zone Lat/Lon/RadiusKM are float64 end-to-end (struct, request, SQL, DB float8). The surge multiplier directly scales pricing downstream; ZopMop's money rule mandates integer paise with no floats crossing layers. A float multiplier applied to a paise amount can produce non-integer paise / rounding drift depending on where it's applied.
- **Verify:** Create a surge multiplier of e.g. 1.33, then trace where pricing applies it (search booking/pricing for multiplier); verify the result is rounded to integer paise and not stored/charged as a float. If price = paise * 1.33 without explicit integer rounding, drift occurs.

### P1.24 [sdui] `App/househelp-api/internal/bff/repository.go:218-251 (CreateDraft) vs :626-629 (InsertAllowedAction)`
- **Problem:** CreateDraft does not map the Postgres 23505 unique-violation (UNIQUE(page_id,version,env)) to ErrConflict, so a duplicate-version draft returns HTTP 500 with the raw pg error string leaked into the UI toast. InsertAllowedAction handles the same case correctly (returns 409). Inconsistent + leaks internals.
- **Verify:** As admin, /sdui/home → New draft → Version 'static-1.0' (collides with seeded row) → Create draft. Toast shows a raw 'duplicate key value violates unique constraint' 500 instead of a clean 409 'version already exists'.

## P2 (48)

### P2.1 [auth-rbac] `App/househelp-api/internal/crm/auth/service.go:181-185 (VerifyTOTP path) & totp.go:46-51`
- **Problem:** TOTP code replay within the 30-second period is allowed — there is no last-used-counter/code dedupe. A valid 6-digit code can be submitted multiple times while it is still in its 30s validity window (and pquerna/totp also accepts +/-1 period of skew, widening the reuse window to ~90s).
- **Verify:** Submit the same valid TOTP code twice within 30s on /totp/verify; both succeed. Compare against a hardened design where the second submission of an already-used counter is rejected.

### P2.2 [auth-rbac] `App/househelp-api/internal/crm/auth/service.go:164-185 (VerifyTOTPAndIssue) vs Login:99-102`
- **Problem:** Account-lock state is checked at the password step (Login) but NOT at the TOTP step (VerifyTOTPAndIssue). An admin who already holds a valid challenge token can complete TOTP verify and obtain a session even if the account was locked (locked_until in the future) between password success and TOTP submission. The TOTP failure path also increments the lock counter but verify never reads locked_until.
- **Verify:** Get a valid challenge token, then DB-set crm_admins.locked_until to now()+15min, then submit a valid TOTP code. Observe that verify still returns 200 and a session is created despite the lock.

### P2.3 [auth-rbac] `App/househelp-api/internal/crm/auth/handler.go:173-194 (Logout) and cmd/crm-api/main.go:400-401 (RegisterPublicRoutes)`
- **Problem:** Logout is mounted as a PUBLIC route (no JWT middleware), so c.Locals('crmAdminID')/('crmAdminEmail') are never populated. The audit recorder in Logout reads those locals, so every auth.logout audit row is written with empty admin_id/admin_email — logout events are not attributable to a specific admin.
- **Verify:** Run flow AUTH-30: sign out, then inspect the newest audit_logs row action=auth.logout — admin_id and admin_email are empty strings.

### P2.4 [dashboard] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/dashboard/dashboard.go:103-110`
- **Problem:** KPIs runs each subquery best-effort: on any error it logs a warning and defaults the metric to 0, then returns 200. A genuinely-broken query (dropped column, dead replica, lock timeout) is indistinguishable on the UI from a real zero — e.g. revenue_today silently shows ₹0 during an outage, and pending_refunds/open_disputes can hide a backlog. There is no per-metric error signal to the client.
- **Verify:** On a scratch DB, rename the bookings.amount_paise column or the pending_refunds table, open the dashboard. Tile shows 0, endpoint returns 200, only a backend WARN log reveals the failure. (See flow DASH-P2-13.)

### P2.5 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/analytics/analytics.go:48-60 (and 66-77, 83-93)`
- **Problem:** generate_series uses both endpoints inclusive: generate_series(date_trunc('day',from), date_trunc('day',to), '1 day'). With from=now-30d and to=now the series spans 31 distinct IST days, so the '30d' preset renders 31 day-buckets (7d -> 8, 90d -> 91). Off-by-one against the labelled range.
- **Verify:** Open /analytics, select 30d, count bars in 'Revenue / day' -> 31, not 30.

### P2.6 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/analytics/analytics.go:23-37`
- **Problem:** parseRange silently swallows invalid/malformed ?from/?to values (only overrides defaults when time.Parse succeeds) and never validates from <= to. A malformed date or a reversed range returns 200 with default/empty data instead of a 400. Operators get no signal that their requested window was ignored.
- **Verify:** Call GET /admin/analytics/summary?from=garbage with a valid token -> 200 with default-30d data. Call revenue-daily with from after to -> 200 with an empty points array.

### P2.7 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/analytics/analytics.go:159-168`
- **Problem:** ByCategory reports orders as COUNT(*) over ALL statuses in range but revenue as SUM filtered to completed only. The 'Orders' and 'Revenue' columns in the By-category table are computed over different booking populations, so revenue-per-order is not derivable and a category with many cancelled orders shows high order count with disproportionately low revenue. May be intentional but is undocumented and inconsistent with how an operator reads the table.
- **Verify:** Seed a category with 10 cancelled + 0 completed bookings in range. Table shows Orders=10, Revenue=₹0. Compare against operator expectation.

### P2.8 [orders] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/orders/orders.go:283 (Get) and 312 (Get services)`
- **Problem:** GET /orders/:id casts the path param to ::uuid directly in SQL. A non-UUID id (e.g. /orders/not-a-uuid) raises a Postgres invalid-uuid error which is returned as 500 internal error instead of a 404/400. Inconsistent with the intended not-found semantics and leaks a 500 for malformed client input.
- **Verify:** Call GET /admin/orders/not-a-uuid. Observe HTTP 500 {error:'internal error'} (from 'get order: ...' wrap) rather than a 400/404. The SPA still shows 'Booking not found', so it is masked in UI but the status code is wrong.

### P2.9 [orders] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/orders/OrderDetailPage.tsx:540 and orders.go:805`
- **Problem:** Cancel reason 'min 5 chars' is advertised but never enforced. The Cancel ConfirmModal renders a textarea with placeholder 'Reason (required, min 5 chars)' but does NOT pass confirmDisabled, so the confirm button is enabled regardless of reason length. Backend Cancel only checks TrimSpace(reason)!='' (the struct's validate:min=2 tag is never executed because the handler uses BodyParser + manual empty check, not the validator). Result: a 1-character reason is accepted end-to-end; an empty reason 400s. Misleading UX and weaker-than-stated audit quality.
- **Verify:** As admin, open Cancel booking, type a single character 'x', click Cancel booking. Observe 200 success and crm_audit_log 'order.cancel' stores reason 'x'. Then try empty reason → 400 'reason required'.

### P2.10 [orders] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/orders/orders.go:148-149 vs 829-855`
- **Problem:** available-workers status-code inconsistency. The SetRedis doc comment states 'endpoints that need it return a 503 if unset', but AvailableWorkersNear returns a plain error('redis not configured') which the handler maps to 400 (the generic err.Error() branch), not 503. A misconfigured/Redis-down deployment surfaces a misleading 400 to the admin instead of a 503 service-unavailable.
- **Verify:** Run the backend without Redis wired (or stop Redis), then GET /admin/orders/:id/available-workers?radius_km=5. Observe HTTP 400 {error:'redis not configured'} rather than 503.

### P2.11 [orders] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/orders/orders.go:684-686 vs 449-451 and 568-569`
- **Problem:** Status-guard inconsistency between reassign-candidate listing and reassign-apply. GET /orders/:id/available-workers rejects only completed/cancelled (allows pending/searching/arrived/en_route), but POST /orders/:id/reassign only permits accepted/in_progress. So an admin can list candidates for an 'arrived' or 'searching' order, pick one, and the Assign POST will 400 with 'only accepted/in_progress orders can be reassigned'. Confusing dead-end UX; the modal lets you select and click Assign before failing.
- **Verify:** Open an order with status 'arrived' (or 'searching') as admin, click Assign pro, pick a candidate that appears in the list, enter reason, click Assign. Observe a 400 'order is arrived — only accepted/in_progress orders can be reassigned' toast even though the candidate list populated.

### P2.12 [refunds] `App/zopmop-crm/src/pages/RefundsPage.tsx:12-19`
- **Problem:** The STATUSES tab list omits 'cancelled' even though RefundStatus, STATUS_TONE (line 28), and the backend approveUpdate settled_at CASE clause (refunds.go:360) all treat 'cancelled' as a real terminal status. Any refund row that reaches status='cancelled' is invisible in the CRM — there is no tab to display it, so ops cannot see or audit cancelled refunds.
- **Verify:** Insert a pending_refunds row with status='cancelled'. Open the Refunds page and click every tab — the row never appears on any tab.

### P2.13 [refunds] `App/zopmop-crm/src/pages/RefundsPage.tsx:283`
- **Problem:** The partial-amount input strips all non-digits (value.replace(/\D/g,'')), so an admin can only enter whole rupees. Refunds that need paise precision (e.g. ₹250.50 = 25050 paise) cannot be issued from the UI — the decimal is silently dropped, turning ₹250.50 into ₹250.00 (25000 paise). The backend accepts arbitrary paise via amount_paise, so the UI is strictly less capable than the API and can produce a wrong (rounded-down) refund amount without warning.
- **Verify:** Click Approve, type '250.50' in the partial field — only '25050' is kept after the '.' is stripped, which then ×100 becomes ₹25,050 not ₹250.50. Type '250.5' → becomes '2505' → ₹2505. The field cannot express sub-rupee amounts and mis-parses any decimal input.

### P2.14 [payouts-payroll] `App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx:1381-1398 + App/zopmop-crm/src/api/client.ts:170-173`
- **Problem:** Duplicate error toasts on payroll mutations. The axios response interceptor already shows a toast for any non-401 error (status!==401), AND the PayoutsTab mutations have their own onError that calls showToast again. A 409/400/500 from mark-paid/mark-failed/recompute will pop TWO toasts. (RBAC 403 with error==='insufficient_permissions' is special-cased to one toast, but the generic 409 invalid-transition path is not.)
- **Verify:** Trigger a 409 (double mark-paid via replay, PR-08) and watch the toast stack — two toasts appear: the interceptor's err message and the mutation's onError message.

### P2.15 [payouts-payroll] `App/househelp-api/internal/crm/payouts/payouts.go:53-99 (List) + App/zopmop-crm/src/pages/PayoutsPage.tsx:16`
- **Problem:** Legacy Payouts page has no pagination: it always requests limit:100, offset 0, and renders no next-page control, while the backend supports up to 200 and an offset. With >100 pending payouts the remaining rows are silently invisible to the operator — a money-visibility gap, not just cosmetic.
- **Verify:** Seed 150 pending crm_payouts rows; open /payouts → pending; only 100 render and there is no way to reach the other 50 (PP-04).

### P2.16 [payouts-payroll] `App/househelp-api/internal/crm/payouts/payouts.go:198-213 (MarkPaid handler) vs PayoutsPage.tsx:113-116`
- **Problem:** On the legacy page, external_ref can only be set during mark-PAID; the mark-FAILED modal collects 'notes' but there is no way to attach a UTR to a failed attempt, and a failed row can never be reversed to paid (state gate is pending/processing only). Combined with bug above, a wrongly-failed legacy payout is a dead row with no recovery path in the UI — operator must edit DB directly.
- **Verify:** Mark a pending legacy payout failed by mistake; there is no UI action on the failed tab to recover it (PP-06). Contrast payroll recompute path.

### P2.17 [users] `App/househelp-api/internal/crm/users/handler.go:152-153 and 184-185 (with model.go:97,104,114)`
- **Problem:** The validate:"required,min=2,max=500" tags on SuspendRequest/BanRequest.Reason and validate:"min=1,max=2000" on AddNoteRequest.Body are never enforced — no validator.Struct() call runs in any handler. Handlers only check strings.TrimSpace(...) == "". So a 1-char reason or a multi-KB note/reason is accepted, and the documented bounds are a false guarantee.
- **Verify:** As admin POST /admin/users/{id}/suspend with {"reason":"x"} → 200 (should be 400 if min=2 enforced). POST /admin/users/{id}/notes with a 5000-char body → 200 (should be 400 if max=2000 enforced).

### P2.18 [users] `App/househelp-api/internal/crm/users/repository.go:346-359 (Ban) and 313-326 (Suspend)`
- **Problem:** No state-precondition guard: Ban sets banned_at=now() and ban_reason=$2 with WHERE id=... only — re-banning an already-banned user overwrites the original banned_at timestamp and ban_reason. Suspend likewise re-overwrites suspend_reason. Combined with handler.go always passing before=nil to audit (e.g. h.audit(c,"user.ban",id,nil,req.Reason)), the original ban metadata is lost and not captured in the audit before-value. Not idempotent.
- **Verify:** Ban a user with reason A (record banned_at). Replay POST /admin/users/{id}/ban with reason B. Re-GET: banned_at has moved to the new now() and ban_reason=B; the audit row's before_value is null, so the original timestamp/reason is unrecoverable from audit.

### P2.19 [workers] `App/househelp-api/internal/crm/workers/repository.go:30-38 (statusExpr) vs 58-69 (List status filter)`
- **Problem:** Displayed status and the status filter can disagree. statusExpr orders banned>suspended>pending>rejected>active, but the 'pending' filter clause is just h.approval_status='pending' with no exclusion of suspended/banned. A worker who is both is_suspended/banned AND approval_status='pending' is returned by the Pending filter yet renders a Suspended/Banned pill — a confusing mismatch. Conversely the Active filter requires approval_status='approved', but statusExpr's ELSE labels any non-pending/rejected/suspended/banned value (e.g. an 'in_training' or unexpected approval_status) as 'active', so such a row shows Active but is excluded by the Active filter.
- **Verify:** Create/seed a helper with approval_status='pending' and users.is_suspended=TRUE. Filter by Pending — the row appears with a Suspended pill. Then set approval_status to a non-standard value and observe an 'active' pill while the Active filter excludes it.

### P2.20 [workers] `App/zopmop-crm/src/pages/workers/WorkerDrawer.tsx:935-938`
- **Problem:** Deduction amount is computed with floating-point math (Math.round(Number(v.amount) * 100)) on the client before sending paise. While Math.round mitigates most cases, this violates the repo's 'integer paise, no floats, ever' rule and could drift for unusual large inputs; the safer path is to parse rupees+paise as integers. Backend correctly uses int64 amount_paise.
- **Verify:** Apply deductions for values like 0.1+0.2-style or very large amounts (e.g. 81237.35) and confirm the stored amount_paise matches the expected integer exactly; look for any single-paise drift.

### P2.21 [zone-approvals] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/shift/repository.go:472-493 (DecideZoneApproval) + /Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zoneapprovals/handler.go:53-58`
- **Problem:** No 404 distinction. A non-existent (but valid-UUID) request id affects 0 rows in the conditional UPDATE and is reported as ErrAlreadyReviewed -> 409 'already reviewed by another admin'. An admin acting on a typo'd/deleted id is told another admin reviewed it, which never happened — misleading audit/UX and hides genuine data problems.
- **Verify:** POST /admin/zone-approvals/<random-valid-uuid-not-in-db>/approve with an admin JWT. Observe 409 already_reviewed instead of 404.

### P2.22 [zone-approvals] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/shift/repository.go:475-485 (DecideZoneApproval UPDATE) -> handler.go:60-61`
- **Problem:** A malformed (non-UUID) :id makes Postgres fail to cast in the WHERE clause; DecideZoneApproval returns the raw driver error, which the handler returns verbatim as 400 {error: <raw pg error string>}. This leaks an internal DB error message to the client and returns 400 rather than a clean 404/422 validation response. The frontend handleConflict then misclassifies the 400 as 'already reviewed'.
- **Verify:** POST /admin/zone-approvals/not-a-uuid/approve with admin JWT. Inspect the 400 body for a raw Postgres/pgx error string instead of a sanitized message.

### P2.23 [leaves] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/leaves/leaves.go:325-352`
- **Problem:** Allocate handler does NOT validate that the :id path param is a valid UUID before issuing UPDATE helpers SET ... WHERE id = $1. List (line 274-278) and Balances (line 308-312) both uuid.Parse-guard their pro_id, but Allocate does not. A malformed id (e.g. /admin/pro/not-a-uuid/leave/allocate) makes Postgres raise 'invalid input syntax for type uuid', which is NOT pgx.ErrNoRows, so it falls through to the generic 500 branch instead of returning a clean 400. Inconsistent with the sibling handlers and leaks a 500 on bad client input.
- **Verify:** With an admin JWT: curl -X POST http://localhost:8090/admin/pro/not-a-uuid/leave/allocate -H 'Authorization: Bearer <jwt>' -H 'Content-Type: application/json' -d '{"days":1}'. Observe 500 {"error":"internal error"} (and a '[crm.leaves] allocate failed' log line) instead of 400.

### P2.24 [leaves] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/leaves/leaves.go:364-370`
- **Problem:** The allocate audit entry sets Before: nil, so the prior leave_balance is never recorded. For a money/state-changing balance adjustment (especially negative deductions), the audit log captures only the delta (after_value = {days,reason}) but not the from/to balance, making it impossible to reconstruct the balance at the time of the change from the audit trail alone.
- **Verify:** Run LV-22: allocate, then SELECT before_value, after_value FROM crm_audit_log WHERE action='leave.allocate' ORDER BY created_at DESC LIMIT 1. before_value is NULL; after_value lacks any old/new balance. The Allocate repo method already does UPDATE...RETURNING leave_balance, so the new balance is known but not persisted to audit either.

### P2.25 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/trustsafety/trustsafety.go:160-174 (and handler 393-407)`
- **Problem:** Attempting a status transition on a resolved/closed dispute returns 404 'dispute not found or already resolved' (RowsAffected=0 -> ErrNotFound). A terminal-state conflict is semantically a 409, not a 404; this conflates 'missing' with 'wrong state' and could mislead clients/automation.
- **Verify:** POST /admin/disputes/{resolvedId}/status with {status:'in_progress'}; observe HTTP 404 for a row that demonstrably exists.

### P2.26 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/trustsafety/trustsafety.go:142-149,160-169,315`
- **Problem:** A malformed (non-UUID) :id is passed straight into `$1::uuid` with no pre-validation. The Postgres cast errors, so ResolveDispute returns a wrapped (non-ErrNotFound) error and the handler responds 500 'internal error' instead of 400/404. Client-supplied bad input becomes a server error.
- **Verify:** POST /admin/disputes/not-a-uuid/resolve; observe HTTP 500 rather than a 400/404. Same for /status.

### P2.27 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:180-205`
- **Problem:** No validation that starts_at < expires_at on create or update. A promo can be created with starts_at after expires_at, making it permanently invalid yet present and 'active'.
- **Verify:** Create a promo with Starts at = next month and Expires at = next week. If accepted (200), ordering is unvalidated. (Run PROMO-EDGE-08.)

### P2.28 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:407-412`
- **Problem:** Create() fires the admin.promo.created webhook via fireWebhook -> Dispatcher.Dispatch with no IsProduction() guard. Project CLAUDE.md mandates IsProduction() gate webhook side effects; dispatcher.go:124 Dispatch has no such guard. Creating a promo in a dev/staging environment will fire real outbound HTTP webhooks to any configured subscribers.
- **Verify:** With a crm_webhook subscriber configured for event 'admin.promo.created' and APP_ENV != production, create a promo and check crm_webhook_deliveries / the subscriber endpoint receives a real delivery.

### P2.29 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:416-427`
- **Problem:** Update handler maps every repo error (including ErrNotFound returned when RowsAffected()==0) to HTTP 400, not 404. Get() correctly returns 404 for ErrNotFound (line 365) but Update() does not distinguish it. Wrong status code for a missing resource.
- **Verify:** PUT /admin/promos/<random-uuid> with a valid body. Response is 400 {error:'promo not found'} instead of 404. (Run PROMO-NEG-05.)

### P2.30 [push] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/growth/growth.go:358-371`
- **Problem:** RetryPush resets a failed row to 'draft' (clearing error_message and sent_at) and then calls SendPush synchronously. If SendPush itself fails again, the row is correctly re-marked 'failed', but the brief window where the row is 'draft' means a concurrent scheduler Tick or a second admin 'Send now' could also claim it. The claim-CAS prevents double-send, so it's not a delivery bug, but two simultaneous retries can both think they will dispatch and one returns a confusing 'already claimed' 400 (which the UI swallows). Lower severity because single-delivery is preserved.
- **Verify:** Click 'Retry Now' on a failed row in two tabs nearly simultaneously. One succeeds; the other returns 400 'push already claimed by another dispatcher' with no UI feedback.

### P2.31 [push] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/growth/growth.go:182-184`
- **Problem:** CreatePush validates ScheduledAt > now-1min but does NOT validate target_kind against the allowed set before insert; an invalid target_kind would only fail at the DB CHECK constraint (target_kind IN ('users','pros','both','specific')), surfacing as a generic 'create push: ...' 400 rather than a clear validation message. The CRM UI only emits users/pros/both so this is not reachable from the page, but the createPush API in all.ts accepts an arbitrary target_kind string and a user_ids array (for 'specific') that the PushPage never sends — so 'specific' targeting is implemented in the backend but has no UI.
- **Verify:** POST /admin/growth/push with target_kind:'garbage' — returns a 400 whose message is the raw DB error rather than a friendly 'invalid target_kind'. Also confirm the PushPage has no way to pick 'specific'/user_ids.

### P2.32 [push] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/PushPage.tsx:101-102, 161`
- **Problem:** The schedule field is a datetime-local input. new Date(scheduled).toISOString() interprets the entered wall-clock time in the browser's local timezone and converts to UTC. The repo standard is Asia/Kolkata everywhere; if the operator's browser is not in IST, the scheduled send time will be off by the tz offset with no warning. The confirm modal shows new Date(scheduled).toLocaleString() which masks the discrepancy because it also uses local tz.
- **Verify:** Set the OS/browser timezone to something other than IST, schedule a push for '15:00', and inspect the scheduled_at sent in the POST body and the countdown — it reflects the browser's tz, not IST, diverging from how other timestamps are stored/displayed.

### P2.33 [experiments-flags] `App/househelp-api/internal/crm/experiments/experiments.go:251 vs 217 (status codes)`
- **Problem:** Inconsistent error codes for the same not-found condition: statusChange/Rollout surface ErrNotFound as 400 (h.repo.SetStatus error -> StatusBadRequest), while Get returns 404 for the same missing experiment. A 'not found' on a lifecycle action should be 404, not 400.
- **Verify:** POST /admin/experiments/<random-uuid>/start -> 400 'experiment not found'; GET /admin/experiments/<random-uuid> -> 404. Compare. See EXP-09.

### P2.34 [experiments-flags] `App/househelp-api/internal/crm/flags/flags.go:206-233 (Rollback) + handler.go:43`
- **Problem:** Rollback is whole-tree: it DELs the entire Redis flags hash and re-applies only the keys present in the snapshot's flags_json. This means (a) any flag the admin changed since the snapshot but did not intend to revert is silently reverted (large blast radius for a 'rollback'), and (b) a flag key that exists in Redis now but was absent in the snapshot is deleted (falls back to def.Default). The UI confirm modal does warn 'All flags will revert', but operators may expect targeted revert. Because SaveSnapshot stores the full registry tree, in practice every flag is overwritten.
- **Verify:** As superadmin take snapshot S0, then change a different flag (payments.upi_enabled=false), then Rollback to S0; observe payments.upi_enabled reverts to its S0 value even though you only meant to undo the original change. See FLAG-08.

### P2.35 [experiments-flags] `App/househelp-api/internal/crm/flags/handler.go:82-84 (Update, snapshot save failure swallowed)`
- **Problem:** If SaveSnapshot fails, the error is only logged and the request still returns {ok:true} with the value already written to Redis. The UI then shows 'Flag value saved (and snapshotted for rollback)' even though no rollback snapshot exists — a broken recovery guarantee. The write to Redis and the snapshot are not transactional.
- **Verify:** Make the snapshot INSERT fail (e.g. point DB at a state where crm_config_snapshots is unavailable / revoke insert), then PUT a flag; observe Redis value changed, response ok:true, success toast, but no new snapshot in History.

### P2.36 [experiments-flags] `App/househelp-api/internal/crm/flags/handler.go:102-108 (Update, fireWebhook) + webhooks/dispatcher.go:124 (Dispatch)`
- **Problem:** Flag Update fires the admin.flag.changed webhook unconditionally via the dispatcher, and Dispatcher.Dispatch has no IsProduction() guard — it performs real outbound HTTP deliveries to any registered subscriber in any environment. Repo non-negotiable requires IsProduction() to gate webhook calls. If a subscriber is registered in dev/staging, editing a flag fires a real external request.
- **Verify:** Register a webhook subscriber for admin.flag.changed pointing at a local listener, then edit any flag as superadmin and watch the listener receive a POST. See FLAG-13. (Confirm whether an IsProduction/env guard exists upstream of the dispatcher; none is present in the flags handler or Dispatch.)

### P2.37 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/workers/repository.go:294-318`
- **Problem:** LivePins SELECT never projects last_location_at (or any timestamp) into LivePin.UpdatedAt; the struct field (model.go:94) and frontend InfoCard line that renders 'Updated {time}' (LiveMapPage.tsx:203-207) therefore never populate/show. Dead UI element — admins never see the freshness of a worker's location.
- **Verify:** Open /map, click any marker; the InfoWindow shows name/phone/status/rating but never an 'Updated ...' line. Confirm GET /admin/workers/live response objects have no updated_at field.

### P2.38 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/localities/localities.go:121,149`
- **Problem:** Update and Delete cast the path :id directly to ::uuid. A non-UUID id (e.g. 'abc') makes Postgres raise an invalid-input error that falls through to the default branch -> 500 'failed to update'/'failed to delete' instead of a clean 400/404. Same pattern means clients can't distinguish 'bad id' from 'server error'.
- **Verify:** PATCH /admin/localities/not-a-uuid and DELETE /admin/localities/not-a-uuid with a valid body/token; observe HTTP 500 rather than 400/404.

### P2.39 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/localities/localities.go:282,299`
- **Problem:** Audit entries for locality.update and locality.delete pass before=nil. The prior state of the row is never captured, so the audit log cannot show what a rename changed FROM or what a deleted locality contained. Update could read oldName (it already SELECTs it) and pass it as 'before'.
- **Verify:** Rename a locality via PATCH, then inspect /admin/audit module=localities: the entry's before is null; you cannot tell the previous name.

### P2.40 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zones/zones.go:236-247`
- **Problem:** UpdateZone maps every error (including ErrNotFound) to HTTP 400 with the raw error message, so a missing zone returns 400 'zone not found' instead of 404. Inconsistent with ToggleZone (line 256) which correctly returns 404. DeleteSurge (line 291-298) has the same flaw — missing rule -> 400 not 404.
- **Verify:** PUT /admin/zones/<random-uuid> with a valid body as admin; observe 400 not 404. Same for DELETE /admin/zones/surge/<random-uuid>.

### P2.41 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zones/zones.go:54-60,162-172`
- **Problem:** CreateSurge does not validate that StartsAt < EndsAt, nor that the window is in the future. An admin can create a surge rule whose end precedes its start, or one already expired, and it is accepted (200) and may fire the activation webhook.
- **Verify:** POST /admin/zones/surge with starts_at later than ends_at; expect 200 and a fired admin.surge.activated webhook for an invalid window.

### P2.42 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/LiveMapPage.tsx:44-75`
- **Problem:** RBAC/UX gap: LiveMapPage has no error handling for the /admin/workers/live query. A viewer-role admin (workers.read requires support) gets 403 but the page silently shows '0 workers online' with no error toast — indistinguishable from genuinely no workers. The /map sidebar link is also shown to viewers who cannot use it.
- **Verify:** Log in as a viewer-role CRM admin, open /map; network tab shows 403 on GET /admin/workers/live but the UI shows an empty map / '0 workers online' with no error message.

### P2.43 [sdui] `App/househelp-api/internal/bff/admin_handler.go:331-384 (preview)`
- **Problem:** The preview handler is a GET (read, gated by sdui.read) but writes an audit row (action='previewed') on every invocation via AppendAuditLog. A read endpoint mutating state means repeated previews flood the audit log and a read-only role boundary still triggers writes. Also the audit write error is swallowed with '_ ='.
- **Verify:** Open Preview on any config and click 'Run preview' several times; then view the Audit log — each preview added a 'previewed' row. Confirms a GET is performing writes.

### P2.44 [sdui] `App/zopmop-crm/src/App.tsx:81-83`
- **Problem:** The /sdui, /sdui/:pageId and /sdui/allowed-actions routes are not wrapped in any route-level permission guard (unlike a <Can> gate), while ALL sdui.* permissions require RoleAdmin. A viewer/support admin can navigate to these pages and sees the full chrome before every data query 403s, producing a stream of 'Insufficient permissions' toasts rather than a clean redirect/empty-access screen. Server-side RBAC still blocks the data, so this is UX/defense-in-depth, not a data-exposure bug.
- **Verify:** Log in as a 'viewer' or 'support' admin, type /sdui in the URL. Page shell renders; GET /admin/pages returns 403 and a permissions toast fires. No friendly 'no access' state.

### P2.45 [sdui] `App/househelp-api/cmd/crm-api/sdui.go:88-96 (sduiLocalsBridge) + internal/bff/admin_handler.go:336-342 (preview)`
- **Problem:** sduiLocalsBridge hardcodes c.Locals('role','admin') for every CRM admin, which unconditionally unlocks the bff preview handler's 'preview as another arbitrary user_id' path for anyone who can reach preview (sdui.read = admin). There is no finer gate distinguishing a regular admin from a super-admin for impersonated preview. Low risk because preview is read-only hydration, but it means any admin can hydrate a layout as any user id.
- **Verify:** As any admin, open Preview, set User ID to another real user's id, Run preview — hydration uses that user's context (audit note 'preview as user=<other>'). Confirms impersonation is always available.

### P2.46 [audit-settings] `App/zopmop-crm/src/pages/audit/AuditPage.tsx:124`
- **Problem:** Subtitle reports 'server cap {filters.limit}' echoing the CLIENT-requested limit, but the backend clamps any limit<=0 or >500 back to 100 (platform.go:372). A URL like /audit?limit=9999 displays 'server cap 9999' while only 100 rows are actually fetched — misleading count for QA and admins reasoning about completeness.
- **Verify:** Load /audit?limit=9999 as admin; subtitle shows 'server cap 9999' but at most 100 rows return (and 'fetched' count <=100).

### P2.47 [audit-settings] `App/zopmop-crm/src/pages/audit/AuditPage.tsx:99-215`
- **Problem:** entity_type/entity_id/from/to filters run CLIENT-side over only the fetched (newest-N, N=limit) page. Filtering by an old date or a specific entity that lives beyond the limit shows the 'No audit entries match your filters' empty state even though matching rows exist in the DB. An auditor could wrongly conclude an action was never logged.
- **Verify:** With >limit rows present, set Limit=25 and a From/To date older than the 25 newest rows -> empty state; raise Limit to 500 -> rows appear. Same for entity_id of an older row.

### P2.48 [audit-settings] `App/zopmop-crm/src/pages/SettingsPage.tsx:78-88, 319-322, 242-245, 653-656`
- **Problem:** Several write mutations (loyalty setLoyalty, webhook create, surge create, app-version, changelog, template create) define onSuccess but no onError. A 4xx from the backend (e.g. loyalty 'points_per_redeem_inr must be > 0', webhook 'url must start with http(s)') rejects the mutation with no toast, so the user gets no feedback that the save failed — looks like a silent no-op.
- **Verify:** As superadmin set loyalty 'Points per ₹1 discount'=0 and Save+confirm; backend returns 400 but observe whether any error toast appears. Repeat with a non-http webhook URL.

## P3 (42)

### P3.1 [auth-rbac] `App/househelp-api/internal/crm/auth/service.go:86-93 (Login, ErrNotFound path)`
- **Problem:** User-enumeration timing side-channel: when the email matches no admin, Login returns ErrInvalidCredentials WITHOUT running bcrypt.CompareHashAndPassword, whereas a real email with a wrong password runs the ~100ms bcrypt compare. The measurable latency difference lets an attacker enumerate valid admin emails. Standard mitigation (compare against a dummy hash) is absent.
- **Verify:** Time POST /admin/auth/login for a known-good email+wrong-password vs a random non-existent email+password; the non-existent email responds noticeably faster (no bcrypt).

### P3.2 [auth-rbac] `App/zopmop-crm/src/auth/permissions.ts vs App/househelp-api/internal/crm/auth/permissions.go`
- **Problem:** The frontend permission map is a hand-maintained mirror of the backend map and can drift. Several backend keys are absent from the FE map (e.g. payouts.create/mark_paid present but localities.*, alerts.read, analytics.read, dashboard.read, orders.read, many *.read keys, surge.*, zones.*, incidents.*, disputes.read, healthmetrics.read, growth.read, notifications.read are NOT in the FE PERMISSIONS object). hasPermission() on a missing key reads PERMISSIONS[perm]=undefined -> ROLE_RANK[undefined]=undefined and r>=undefined is false, so Can() hides controls the user is actually authorized for (and TS only catches it because keys are typed — runtime drift on dynamically-passed keys would silently mis-gate).
- **Verify:** Diff the key sets of permissions.ts PERMISSIONS and permissions.go permissions. For any backend read-permission missing from the FE map, a Can perm=that-key block renders the fallback (hidden) even for a superadmin. Server still authorizes the request, so it is fail-safe but causes hidden UI.

### P3.3 [dashboard] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/DashboardPage.tsx:189,238`
- **Problem:** Live-orders and alerts timestamps are rendered with new Date(created_at).toLocaleTimeString()/toLocaleString(), which uses the browser's local timezone. The ZopMop repo rule (CLAUDE.md) requires all timestamps to be displayed in Asia/Kolkata. A tester or operator in a non-IST timezone sees shifted times, which can cause wrong operational decisions on the live feed.
- **Verify:** Set the browser/OS timezone to a non-IST zone (e.g. America/New_York), open the dashboard, and compare the live-order/alert times to the known IST created_at; they will be offset. (See flow DASH-P2-20.)

### P3.4 [dashboard] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/dashboard/dashboard.go:19-25`
- **Problem:** KPIs struct fields (incl. RevenueTodayCents) are Go `int`, and the JSON key is revenue_today_paise. On a 64-bit build int is 64-bit so paise sums are safe in practice, but the type is platform-dependent rather than the repo-mandated int64 for money. Other money fields use int64; this one relies on the build target. Low risk on amd64 prod but inconsistent with the 'int64 paise everywhere' rule.
- **Verify:** Seed total daily completed revenue > 2,147,483,647 paise (≈₹21.47M) and confirm the value is exact on the deployed build; verify the build target is 64-bit. (See flow DASH-P2-12.)

### P3.5 [dashboard] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/components/dashboard/QuickActions.tsx:35`
- **Problem:** The 'View Refunds' QuickAction link has no perm and is shown to every role, but the /refunds backend requires refunds.read=support. A viewer clicking it will navigate to a page that 403s on load (relying on the target page to surface the error) rather than the pill being hidden like the other gated actions. Inconsistent gating UX.
- **Verify:** As a viewer, open the dashboard, confirm 'View Refunds' pill is visible, click it, and observe whether /refunds shows an insufficient-permissions toast / blank rather than a clean hidden-action experience. (See flow DASH-P1-14.)

### P3.6 [analytics] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/healthmetrics/handler.go:35-44,46-63`
- **Problem:** Metrics() runs a synchronous upstream HTTP probe (3s timeout) on every request. A slow/hung upstream makes the CRM health-metrics endpoint itself slow (up to 3s/call), and the probe result is not cached, so frequent polling of the health strip amplifies load on the upstream /health. Low risk (appURL is server config, no SSRF), but a self-inflicted latency/coupling issue.
- **Verify:** Point AppAPIURL at a host that accepts connections but never responds; call GET /admin/health/metrics and observe ~3s response time every call.

### P3.7 [orders] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/OrdersPage.tsx:23-92`
- **Problem:** Filter/URL state supports min_cents, max_cents, category, customer_id, worker_id, sort_by, sort_dir (all wired to the backend), but the OrdersPage UI exposes only search, status, from, to. The extra filters are reachable solely by hand-editing the URL. Either dead/unfinished UI or an undocumented power-user feature. Also min_cents/max_cents filter the GROSS amount_paise while net (amount-discount) is the figure used for refunds, a potential mental-model mismatch.
- **Verify:** Load /orders?min_cents=100000&category=Cleaning&sort_by=price&sort_dir=asc and confirm results filter/sort correctly, then confirm no on-screen control sets these — they vanish from the visible filter bar and only the Clear button (which clears them) acknowledges them.

### P3.8 [orders] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/orders/OrderDetailPage.tsx:725-762`
- **Problem:** Refund amount is entered as a floating-point rupee value (type=number, step=0.01) and converted via Math.round(amount*100). While the round mitigates most precision loss, the field accepts sub-paise/odd decimals and relies on JS float math for the rupee→paise conversion at the UI boundary — contrary to the repo's strict 'integer paise, no floats ever' rule. A value like 0.015 rounds to 2 paise; pasted scientific notation or many decimals could surprise. Lower risk because the server re-validates against NetPaise.
- **Verify:** In the refund modal type 0.015 (or 1499.999) and submit; inspect the amount_paise sent (Math.round(amount*100)) vs what was typed. Confirm it never sends a non-integer and never exceeds NetPaise, but note the float pathway exists at the boundary.

### P3.9 [refunds] `App/zopmop-crm/src/pages/RefundsPage.tsx:114-117`
- **Problem:** isPartial is only true when partialCents < r.amount_paise. If an admin enters a partial value GREATER than the original, isPartial becomes false and effectiveAmount falls back to the full amount, so the UI silently submits a FULL refund instead of surfacing 'amount exceeds original'. The user intended an over-refund (likely a typo) and instead gets a full refund with no warning. The backend would reject amount > original with 400, but the FE never sends the over-amount — it downgrades to full.
- **Verify:** On a ₹500 pending row, Approve and enter 6000 in partial. The modal 'Refund amount' shows ₹500 (not the typed value) and submitting issues a full ₹500 refund rather than warning the operator.

### P3.10 [refunds] `App/zopmop-crm/src/pages/RefundsPage.tsx:144 and :166`
- **Problem:** The approve/retry onError handlers only show the gateway-failure toast when e.response.status >= 500, but the backend returns gateway errors as 502 Bad Gateway (refunds.go:611,743) — which is >=500, so this works — HOWEVER if the gateway error were ever surfaced as a 4xx (or the REFUND_ROLLBACK_FAILED 500 with error code != 'gateway_error'), the branch condition (status>=500 AND data.error==='gateway_error') is narrow: the REFUND_ROLLBACK_FAILED 500 (error:'refund rollback failed; manual reconciliation required') falls through with no special handling and relies on the generic interceptor toast. Worth confirming the generic interceptor actually surfaces that critical reconciliation message to the operator.
- **Verify:** Force a gateway_error rollback DB-write failure (delete the row mid-call as the test failingGatewayWithRowDeletion does) → API returns 500 with code REFUND_ROLLBACK_FAILED. Confirm the operator sees a toast; the row-level onError handler ignores it (error!=='gateway_error'), so only the global axios interceptor can surface this critical state.

### P3.11 [refunds] `App/househelp-api/internal/crm/refunds/refunds.go:899-910`
- **Problem:** Reject() returns 400 with err.Error() directly for any repo failure. When the row is not pending (RowsAffected=0), repo.Reject returns ErrNotFound → handler responds 400 {error:'refund not found'} instead of a 404, and a genuine DB error would also leak as a 400 with the raw error string. Inconsistent with Approve/Get which map ErrNotFound to 404. Minor status-code/leakage inconsistency.
- **Verify:** POST /admin/refunds/<nonexistent-uuid>/reject with a reason → observe 400 (not 404) and the error string 'refund not found'. POST reject on an already-rejected row → 400 'refund not found' even though the row exists.

### P3.12 [refunds] `App/househelp-api/internal/crm/refunds/refunds.go:876-897`
- **Problem:** notifyCustomer divides paise by 100 with integer division (cents/100) to build the human notification amount, dropping the paise remainder. A ₹250.50 (25050 paise) refund notifies the customer '₹250'. Display-only (the actual refunded amount is correct), but a customer-facing money figure is silently truncated rather than rounded. Acceptable per the comment, flagged for awareness.
- **Verify:** Approve a wallet/processed refund of 25050 paise and inspect the FCM payload — amount shows '250' not '250.50'.

### P3.13 [payouts-payroll] `App/househelp-api/internal/crm/payouts/payouts.go:132,146 + migration 041 (status CHECK includes 'processing')`
- **Problem:** crm_payouts allows status 'processing' and both mark-paid/mark-failed accept it, but no code path in this module ever sets 'processing' (Create defaults 'pending'; there is no processing-transition endpoint). Dead state — either a half-built feature or the 'payment worker' integration that was never wired. Harmless but misleading for testers/operators expecting a processing flow.
- **Verify:** grep the backend for any UPDATE setting crm_payouts.status='processing' — none exists; the status is only ever 'pending' until an admin marks it.

### P3.14 [payouts-payroll] `App/househelp-api/internal/payroll/payroll.go:21-26 (BaseRatePaisePerHour=8000, BonusRatePaisePerHour=8000) + calc.go:107-109; recompute path service.go:135`
- **Problem:** The payroll engine pays base at 8000 paise/hr on ONLINE minutes AND an equal 8000 paise/hr bonus on WORKING minutes; since working ⊆ online, every working minute is effectively paid at ₹160/hr (₹80 base + ₹80 bonus) while idle-online minutes are ₹80/hr. This is the single live formula the CRM recompute uses (audit C1 flags two pay formulas across the repo: internal/booking/earnings.go vs internal/payroll/calc.go). Confirm with finance that the doubled rate on worked time is intended — recompute will (re)write these doubled figures over any prior value.
- **Verify:** Run PR-05 with 120 online / 60 working min: result is base 16000 + bonus 8000 = gross 24000 paise. Verify that ₹240 for 2h (1h of which was a job) is the intended pay vs the booking/earnings.go formula.

### P3.15 [payouts-payroll] `App/househelp-api/internal/crm/payroll/payroll.go:290-298 (MarkFailed on already-failed) & transitionInTx:407-414`
- **Problem:** Marking an already-'failed' payout failed again returns a generic 409 'invalid status transition' (allowed_from=pending_manual_payout|paid, current=failed). The UI never offers this (failed rows only show Recompute), but a replayed/forced request gives a confusing message rather than an idempotent no-op. Low impact but worth noting for negative-test expectations.
- **Verify:** Force POST mark-failed on a failed payout id; observe 409 with allowed_from listing pending_manual_payout|paid and current=failed.

### P3.16 [users] `App/househelp-api/internal/crm/users/repository.go:362-375 (Unban)`
- **Problem:** Unban's UPDATE WHERE clause is `WHERE id = $1::uuid` and OMITS the `AND deleted_at IS NULL` guard that suspend/unsuspend/ban/setvip all include. A soft-deleted (deleted_at set) user can have banned_at cleared, partially resurrecting a deleted account's state. Inconsistent with the rest of the module.
- **Verify:** Soft-delete a user (set deleted_at) who is banned, then POST /admin/users/{id}/unban → RowsAffected=1 (200) even though Get() filters that user out as not-found. Compare to suspend on the same user which returns 404.

### P3.17 [users] `App/househelp-api/internal/crm/users/handler.go:159-168 vs 171-179 and 191-200 vs 203-211`
- **Problem:** Webhook asymmetry: Suspend fires EventAdminUserSuspended and Ban fires EventAdminUserBanned, but Unsuspend and Unban fire NO webhook. Downstream subscribers learn when access is removed but never when it is restored, which can leave external systems with stale 'banned/suspended' state.
- **Verify:** Subscribe a webhook to admin.user.* events. Suspend then unsuspend a user; only the suspend delivery arrives. Same for ban→unban.

### P3.18 [users] `App/househelp-api/internal/crm/users/repository.go:40-48`
- **Problem:** Search LIKE clause uses %term% with no ESCAPE, so user-typed % or _ act as SQL wildcards (e.g. searching '%' matches every user). Parameterised so not an injection, but matching is surprising and a leading-% LIKE on phone/name/email prevents index use — full scan per keystroke on large tables (note the debounce-free onChange in UsersPage fires a request per character).
- **Verify:** Search '%' → all users returned. Search a string with '_' → unexpected single-char wildcard matches. Watch network tab: one GET /admin/users per keystroke (no debounce).

### P3.19 [zone-approvals] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/zoneApprovals/ZoneApprovalsPage.tsx:227-236 (handleConflict)`
- **Problem:** handleConflict treats statuses 404, 409 AND 400 all as 'Already reviewed by another admin'. A genuine 400 validation error (e.g. if backend later adds notes validation, or the non-UUID raw-error 400 above) would be mis-surfaced to the operator as a benign race and the drawer silently closes, masking the real failure.
- **Verify:** Force a 400 on reject (e.g. via the non-UUID id path) and observe the UI shows 'Already reviewed by another admin. Refreshing.' rather than the actual error.

### P3.20 [zone-approvals] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/audit/audit.go:48-91 (Recorder.Log) called from handler.go:63 & 88`
- **Problem:** Audit write is fire-and-forget: a failed INSERT into crm_audit_log is only logged, not surfaced, and the decision still returns 200. So a state-changing approve/reject can succeed with NO audit row if the audit insert fails (e.g. schema drift, DB hiccup). For an explicitly audit-logged surface this is a silent gap. (By-design best-effort, but worth flagging for an audit-critical area.)
- **Verify:** Temporarily break the crm_audit_log table (rename a column) and approve a request — observe 200 success + 'failed to write audit row' log line + no audit row, with the status still flipped.

### P3.21 [leaves] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/leaves/leaves.go:341-350 + internal/crm/auth/permissions.go:38-39,119`
- **Problem:** The 'extra' RBAC gate for negative-days deduction is effectively a no-op: leaves.deduct => RoleAdmin and the route's workers.update => RoleAdmin are the SAME minimum role. The code comment (leaves.go:340 'a support agent who can add days can't sneak deductions through') implies grant is a lower bar than deduct, but support cannot grant either (workers.update is already admin-only). So no role can grant-but-not-deduct; the second check never changes the outcome.
- **Verify:** Trace roles: workers.update=admin (permissions.go:39), leaves.deduct=admin (line 119). Any role that passes workers.update (admin/superadmin) also passes leaves.deduct. Run LV-09 as admin (both pass) and as support (blocked at route before the negative branch) — there is no role for which the negative-days branch flips the result.

### P3.22 [leaves] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/LeavesPage.tsx:58-68 + 145-149`
- **Problem:** Off-by-design pagination: FE requests limit=100, never sends offset, and never renders a pager or total_count. Backend returns total_count, but if a pro/date window has >100 leaves only the first 100 (by date desc) are shown and the remainder are silently invisible to the operator. No empty/overflow indicator.
- **Verify:** Seed >100 pro_leaves in one window; load /leaves; compare rendered row count (100) to the total_count in the /admin/leaves response (Network tab). The surplus rows never appear and nothing in the UI signals truncation.

### P3.23 [leaves] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/LeavesPage.tsx:219-226`
- **Problem:** The Allocate number input enforces only a lower bound in JS (onChange uses Math.max(1, Number(...)||1)); the upper bound is the HTML max=31 attribute, which browsers do not enforce on typed/pasted input. Combined with no server-side ceiling (leaves.go Allocate adds any non-zero int), an operator can submit an arbitrarily large grant. Minor, but a fat-finger '310' instead of '31' silently over-allocates 310 days.
- **Verify:** On /leaves, type a large number like 310 into the Allocate input and click Allocate; observe success toast 'New balance: ...' reflecting +310. Or POST {"days":100000} directly (LV-23) — accepted with no cap.

### P3.24 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/trustsafety/trustsafety.go:123-140,364-372`
- **Problem:** CreateDispute does not validate severity/source against the allowed set in Go; it relies on the DB CHECK constraint (migration 041 lines 89-95). When violated, the raw pgx error string is returned in the 400 body ({error: err.Error()}), leaking the constraint/SQL detail to the client instead of a friendly validation message.
- **Verify:** POST /admin/disputes with {description:'x', severity:'urgent'}; observe 400 whose error string contains the Postgres CHECK constraint text.

### P3.25 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/api/all.ts:326 and trustsafety.go:89-99,358-361`
- **Problem:** Frontend listDisputes never sends a limit; backend caps at 50 with no pagination/cursor. On a queue with >50 disputes in one status, rows 51+ are silently unreachable from the UI (no pager). Not an off-by-one, but a visibility/data-completeness gap for an operational queue.
- **Verify:** Seed 60+ open disputes; load the Open tab; confirm only 50 cards render and there is no way to load more.

### P3.26 [disputes] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/DisputesPage.tsx:126 and trustsafety.go:142-154`
- **Problem:** Resolution/outcome is optional everywhere: the textarea has no required validation and the backend never checks resolution!='' — a dispute can be marked resolved with an empty outcome, defeating the modal's stated purpose ('record outcome').
- **Verify:** Click Resolve, leave the textarea blank, confirm; verify the dispute resolves with resolution=''.

### P3.27 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:350-359`
- **Problem:** List handler ignores strconv.Atoi errors (limit, _ := ... and offset, _ := ...) and echoes the RAW requested limit/offset back in the JSON response rather than the values actually used after Repository.List clamps them. A client passing limit=99999 gets a response claiming limit:99999 while only <=50 items are returned, which can confuse a paginating client.
- **Verify:** GET /admin/promos?limit=99999 — response JSON shows limit:99999 but items length <=50. (Run PROMO-EDGE-06.)

### P3.28 [promos] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/promos/promos.go:425,434,443`
- **Problem:** promo.update, promo.deactivate, and promo.activate audit entries pass before=nil — no pre-mutation snapshot is captured, so the audit trail cannot show what the values were before an edit/toggle (only the new request body for update). Money/discount changes are not diff-auditable.
- **Verify:** Edit a promo's discount_value, then inspect the audit entry: the Before field is null. (Run PROMO-AUDIT-01.)

### P3.29 [banners] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/banners/banners.go:266-273 (Delete) and 253-264 (Update)`
- **Problem:** ErrNotFound is mapped to HTTP 400, not 404, on Update and Delete (only Get returns 404). All repo errors are funneled into 400 with err.Error(). Inconsistent status semantics; also leaks raw error strings (e.g. Postgres CHECK / uuid-cast messages) to the client.
- **Verify:** See BAN-16: DELETE/PUT a valid-format UUID not present -> 400 (expected 404). BAN-11/BAN-12: invalid cta_kind/audience -> 400 with raw 'violates check constraint' Postgres text in the JSON error.

### P3.30 [banners] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/banners/banners.go:228-237 (Get) and 94 (Get query ::uuid cast)`
- **Problem:** A malformed (non-UUID) id on GET /admin/banners/{id} causes the Postgres ::uuid cast to error, which is not pgx.ErrNoRows, so it returns 500 'internal error' for what is really a client/4xx condition.
- **Verify:** See BAN-17: GET /admin/banners/not-a-uuid returns 500 instead of 400/404.

### P3.31 [banners] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/auth/permissions.ts:40-44 (no 'banners.read' key)`
- **Problem:** The frontend PERMISSIONS map has no 'banners.read' entry even though the backend route is gated on banners.read (viewer). The page never calls usePermission('banners.read') so it does not crash, and there is no client-side gate hiding the /banners route from sub-viewer roles — the list request just 403s. Minor: read-gating relies entirely on the server, and an unknown PermissionKey would be a TS-only guard, not runtime. Low impact because viewer is the lowest real role.
- **Verify:** Search permissions.ts for 'banners.read' (absent). Confirm BannersPage only references reorder/delete/create/update perms. A role below viewer (none exist by default) would still see the page shell and get a 403 toast on list.

### P3.32 [banners] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/BannersPage.tsx:230 (editor live-preview img)`
- **Problem:** The editor's live-preview <img> has no onError handler (unlike the list card img at line 61), so a broken/invalid image URL renders a broken-image glyph in the preview pane rather than degrading to the placeholder. Cosmetic.
- **Verify:** See BAN-15: enter a non-resolving image URL in the editor; the live preview shows a broken image icon while the list card hides it.

### P3.33 [banners] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/BannersPage.tsx:170-176 (save mutation body)`
- **Problem:** The Update path sends a Partial<Banner> spread from the form including display_order from emptyForm (b.display_order). Because there is NO display_order input in the editor, editing a banner re-sends its current display_order — which is fine — but if a reorder happened in another tab after the editor opened, saving the edit will revert display_order to the stale value the editor captured. Interaction with the reorder race above.
- **Verify:** Open Edit on a banner (display_order=2). In another tab reorder so it becomes 0. Back in tab 1, change the title and Save -> GET shows display_order reverted to 2.

### P3.34 [experiments-flags] `App/zopmop-crm/src/App.tsx:60,73 (routes not permission-gated)`
- **Problem:** The /flags route is reachable by any authenticated admin regardless of role, but flags.read requires admin on the backend. A viewer/support who navigates directly to /flags triggers a 403 on GET /admin/flags and lands on a broken/empty page plus an error toast rather than a clean access-denied screen. (/experiments is fine since experiments.read=viewer.)
- **Verify:** Log in as viewer/support, navigate to http://localhost:5174/flags; observe 403 on GET /admin/flags and degraded page. See FLAG-11.

### P3.35 [experiments-flags] `App/zopmop-crm/src/pages/FlagsPage.tsx:216 (NumericInput Save disabled when num===Number(flag.value))`
- **Problem:** The Save button disables when the typed number equals the current value. For a flag never written to Redis, current value equals def.Default, so an operator cannot explicitly persist the default into the store (e.g. to lock it in). Minor UX/idempotency edge.
- **Verify:** On a number flag still at its default, type the same default number; Save (disk) button stays disabled, so no PUT/snapshot can be created for that no-op.

### P3.36 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/househelp-api/internal/crm/zones/zones.go:92-94`
- **Problem:** validateZone rejects only the exact lat==0 && lon==0 case as 'lat / lon required'. This is a sentinel-for-required check that also rejects a legitimate zone centered at exactly (0,0). Low real-world impact (Gulf of Guinea) but it is an incorrect use of zero-as-missing for a float coordinate; there is no proper presence check (pointer/omitempty).
- **Verify:** POST /admin/zones/ with lat=0, lon=0, valid name/city/radius; observe 400 even though the input is well-formed.

### P3.37 [localities-maps] `/Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/pages/LocalitiesPage.tsx:43-50,134-149`
- **Problem:** The Active/Disabled toggle button only disables on toggle.isPending globally (a single shared mutation), so while one row's toggle is in flight ALL rows' toggle buttons disable; and rapid clicks on the same row before refetch can send stale active values. Also the toggle button reuses the create/update mutation's name/city as-is; no per-row in-flight tracking.
- **Verify:** With several localities, click row A's toggle and immediately try row B's toggle — both appear disabled until A settles. Rapidly double-click one row's toggle and watch for a flip-flop.

### P3.38 [sdui] `App/househelp-api/internal/bff/admin_handler.go:398-457 (killOn/killOff/expKillOn/expKillOff)`
- **Problem:** SDUI page and experiment kill switches write to shared Redis keys (sdui:kill:<page>, sdui:kill:exp:<id>) that the production user-app BFF reads, with no IsProduction() guard. Per repo CLAUDE.md the CRM 'is not deployed to prod', yet it shares the prod DB/Redis, so toggling a kill switch (or activating/rolling back a config) from the CRM immediately blanks/changes the real production home screen for end users. This is by design for ops, but QA must run these flows against a NON-prod Redis/DB or they will affect live users. No code-level guard prevents prod impact.
- **Verify:** Enable the 'home' kill switch from /sdui/home, then hit the user-app SDUI endpoint for page 'home' — clients receive the safe/empty layout. Confirms cross-system production effect with no environment guard.

### P3.39 [audit-settings] `App/househelp-api/internal/crm/platform/platform.go:483-492`
- **Problem:** ListDeliveries (a READ) writes an audit row 'webhook.delivery.list' on every call, contradicting audit/audit.go:3 ('Reads are not audited'). The CRM Deliveries drawer also polls GET /admin/webhooks/:id/deliveries every 10s (SettingsPage.tsx:481), so if the poll re-hits this endpoint it could append a webhook.delivery.list audit row every 10 seconds, flooding crm_audit_log while the drawer is open.
- **Verify:** Open Settings>Webhooks>Deliveries on any webhook, leave it open ~1 minute, then /audit filter module=platform action=delivery — check whether one row or ~6 rows/minute accumulate.

### P3.40 [audit-settings] `App/zopmop-crm/src/pages/audit/AuditPage.tsx:347-357`
- **Problem:** ModulePill maps 'webhooks' to the 'warning' tone, but platform webhook actions are recorded under module 'platform' (platform.go:649), and the MODULES filter dropdown has no 'webhooks' entry. So webhook audit rows always render as the generic 'platform' pill; the 'webhooks'/'blacklist'/'fraud' branches in ModulePill are dead because those modules are recorded as 'platform'/'trustsafety'. Cosmetic, but the colour-coding never triggers for those.
- **Verify:** Create a webhook (superadmin), open /audit — the new row's module pill reads 'platform' with warning tone (from the platform branch), never 'webhooks'.

### P3.41 [audit-settings] `App/zopmop-crm/src/pages/SettingsPage.tsx:243, 262`
- **Problem:** Surge multiplier is parsed with Number(mul) and sent as a float; an unparseable input ('abc') yields NaN. JSON.stringify(NaN) serializes to null, so the backend may receive multiplier:null/0. Pricing multipliers should be validated; relying on float Number() with no client validation risks a zero/null multiplier being persisted.
- **Verify:** Settings>Surge, pick a zone, set Multiplier='abc', click Add; inspect the POST /admin/zones/surge body (multiplier becomes null) and whether the backend rejects it or stores a bad rule.

### P3.42 [audit-settings] `App/zopmop-crm/src/pages/SettingsPage.tsx:760 vs 383`
- **Problem:** The embedded Settings>Audit tab is visible to ALL roles (it is not in the superadmin-only hide list), but GET /admin/audit requires audit.read=admin. For viewer/support the tab renders but the data call returns 403; platformApi.listAudit has no error handling so the tab likely shows an empty/'No matching rows' state that is indistinguishable from genuinely empty — confusing for lower roles who think the log is empty rather than forbidden.
- **Verify:** Log in as viewer, open Settings, click the audit tab; observe a 403 in the network tab but a benign-looking empty list in the UI.
