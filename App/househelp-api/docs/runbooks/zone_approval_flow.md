# Runbook: zone-approval FCM smoke test

End-to-end manual test for the outside-zone approval flow that was
shipped in Phase 7 Part A (backend) + Part B (pro app). The path
exercises three FCM moving parts that can't be auto-tested:

1. Pro device FCM token is registered against `users.fcm_token`.
2. Admin device(s) FCM tokens are registered against `admin_users`.
3. `notification.Service.SendToAdmins` / `SendToProByID` actually fan
   out to live FCM and the receiving devices route the data push
   into `pushRouter.ts` → `shiftEvents` emitter.

Re-run after any of: changing `internal/shift/notifier.go`, changing
the `shiftPushAdapter` wiring in `cmd/api/main.go`, swapping FCM
project, rotating service-account creds, touching `pushRouter.ts`
case-`zone_approval_granted` or `zone_drift_warning`.

## Prerequisites

- Backend running with valid Firebase service-account
  (`secrets/firebase-adminsdk.json` mounted into the container).
- Two physical devices (FCM does not deliver to iOS Simulator;
  Android emulator with Play Services works).
- One admin user in DB (`admin_users` row + `users.role = 'admin'`).
- One approved pro: `+919123456789` is the seeded test pro.

## Step 1 — Register the pro FCM token

On the pro device, log in as `+919123456789` (dev OTP `999999`).

The app's `usePushNotifications` hook calls `messaging().getToken()`
and POSTs to one of:

- `POST /api/v1/devices/register` (preferred — `device_tokens` table)
- `PUT /api/v1/me/fcm-token` (legacy `users.fcm_token`)

Both paths also mirror the token into `users.fcm_token` so
`SendToProByID` finds it via the legacy column. Verify:

```sql
SELECT id, name, LEFT(fcm_token, 16) AS token_prefix
  FROM users
 WHERE phone = '+919123456789';
```

A 16-char prefix should appear. If empty: the FCM init failed on the
device (check device logs for `[Push] FCM init failed`); APNs cert
missing on iOS, or Play Services missing on Android.

## Step 2 — Register the admin FCM token

The CRM frontend is not yet built, so there's no app-side flow that
registers an admin FCM token automatically. For the smoke test, you
have two options:

**Option A — seed manually via SQL.** Best when you already have an
FCM token from a different test app:

```sql
-- assume there's an admin user with id <admin_uuid>
UPDATE users SET fcm_token = '<paste-fcm-token>'
 WHERE id = '<admin_uuid>' AND role = 'admin';
```

`AdminFCMTokens` in `internal/notification/service.go` joins
`admin_users` to `users` and pulls `users.fcm_token`, so this is
sufficient.

**Option B — open the pro app on a second device, log in as a
different account that you've manually promoted to admin.** The same
`usePushNotifications` hook registers the token. Promote with:

```sql
UPDATE users SET role = 'admin' WHERE id = '<your-test-uuid>';
INSERT INTO admin_users (id, can_approve_zone_requests)
VALUES ('<your-test-uuid>', true)
ON CONFLICT (id) DO NOTHING;
```

Make sure to re-issue the access token (log out + back in) after the
role change — JWTs cache the old role.

## Step 3 — Trigger the outside-zone path

On the pro device:

1. Pre-condition: pro has a committed shift for today (or active
   commitment) — backend rejects approval requests for unknown
   commitments.

```sql
SELECT id, shift_date, status FROM shift_commitments
 WHERE pro_id = (SELECT id FROM users WHERE phone = '+919123456789')
 ORDER BY shift_date DESC LIMIT 3;
```

2. Mock GPS to coordinates well outside the assigned zone. iOS
   simulator: Features → Location → Custom. Real device: use a GPS
   mocking app (Android: "Mock GPS"; iOS: requires a paired Mac and
   Xcode → Devices → Simulate location).

3. Tap **Go Online** on the dashboard. The screen should navigate
   to ZoneApprovalRequestScreen with a `distance_meters` > the
   per-zone `shift_radius_km`.

4. Tap **फोटो अपलोड करके मंज़ूरी मांगें** → grant camera permission
   → take a selfie.

5. Tap **मंज़ूरी के लिए भेजें**.

Expected: ZoneApprovalRequestScreen flips to the
**मंज़ूरी का इंतज़ार है** waiting state.

Verify backend insert:

```sql
SELECT id, pro_id, status, LEFT(photo_url, 32) AS photo_prefix, requested_at
  FROM zone_approval_requests
 ORDER BY requested_at DESC LIMIT 1;
```

`photo_url` should start with `data:image/jpeg;base64,…` (pre-S3
inline storage). Status: `pending`.

## Step 4 — Confirm admin push fires

Within ~1s of the submit, the admin device should receive an FCM
data push:

- title: `Zone approval needed`
- body: `<Pro name> is outside their assigned zone and needs manual approval`
- data: `{type: zone_approval_pending, request_id, pro_id, pro_name}`

If the admin device is foregrounded and shows nothing: tail backend logs.

```bash
docker compose logs backend --tail 60 | grep -iE 'shift|notifier|admin'
```

Look for `[shift.notifier] admin fan-out failed` — that means the
FCM call returned an error (most likely an invalid token or a missing
service account). Also check `[notification]` log lines for the
multicast report (success/failure counts).

## Step 5 — Approve as admin

The CRM UI isn't built yet — approve via SQL or the admin endpoint:

```bash
ADMIN_TOKEN=...  # admin user's JWT
REQ_ID=...       # request_id from the row inserted above

curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8080/api/v1/admin/zone-approval-requests/$REQ_ID/approve
```

Or directly in DB if you don't have an admin JWT handy:

```sql
UPDATE zone_approval_requests
   SET status = 'approved', reviewed_by = '<admin_uuid>', reviewed_at = now()
 WHERE id = '<request_id>';
```

The DB-update path **does not** fire the pro push (the push is wired
inside `Service.ApproveZoneRequest`). For the FCM half of the smoke
test, use the HTTP endpoint.

## Step 6 — Confirm pro push fires + dashboard recovers

The pro device should receive a data push:

- title: `ज़ोन मंज़ूरी मिल गई`
- body: `अब आप ऑनलाइन जा सकते हैं`
- data: `{type: zone_approval_granted, request_id, commitment_id}`

`pushRouter.ts` calls `emitShiftEvent({type:'zone_approval_granted'})`.
ProDashboardScreen subscribes to `onShiftEvent`, clears the
`approvalPendingRef`, and refetches. The dashboard should transition
from State 6 (approval pending) to State 2 (canGoOnline).

Tap **ऑनलाइन जाएं** again. Backend `GoOnline` should now bypass the
radius check via `ApprovedApprovalForCommitment` and return
`location_ok: true` with a session id. Dashboard advances to State 3
(online).

## Failure modes seen during initial bring-up

- `users.fcm_token` updated but `admin_users` row missing →
  `AdminFCMTokens` returns 0 tokens silently. The `SendToAdmins`
  multicast returns `&MulticastReport{}` with no log line. **Fix:**
  ensure an `admin_users` row exists for the user.
- Pro device upgraded the app but never re-registered → stale token,
  FCM returns `messaging/registration-token-not-registered`. **Fix:**
  log out + back in on the pro device.
- Local Docker stack hit the daily Firebase quota → all sends fail
  with `quota-exceeded`. **Fix:** wait 24h, or switch the
  `firebase-adminsdk.json` to a different project.

## Cleanup

```sql
DELETE FROM zone_approval_requests WHERE pro_id = (SELECT id FROM users WHERE phone='+919123456789');
```

Reset the test commitment if you forced one:

```sql
DELETE FROM shift_commitments WHERE pro_id = (SELECT id FROM users WHERE phone='+919123456789') AND shift_date > current_date;
```
