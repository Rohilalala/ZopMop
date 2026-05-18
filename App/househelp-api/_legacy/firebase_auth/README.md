# Firebase Auth — Archived

This directory holds the Firebase Phone Auth code that was the backend
verifier for ZopMop sign-in before the MSG91 migration.

| | |
|---|---|
| Archived on | 2026-05-16 |
| Original migration | Phase 4–5 (Firebase → MSG91 OTP + self-issued JWT) |
| Removal target | 2026-08-16 (90 days from archival) |

If MSG91 has been running stable for 90 days without a rollback need,
this directory should be deleted in a single PR alongside any
`firebase.google.com/go/v4/auth` references that may have crept back.

## Files

| File | Role in the old flow |
|------|----------------------|
| `firebase.go` | Singleton Firebase Admin Auth client + `VerifyFirebaseToken(ctx, idToken)` — extracted the phone number from a verified Firebase ID token. |

## What was deleted from active code

- `internal/auth/firebase.go` (verifier)
- `internal/auth/handler.go::VerifyFirebase` (the `POST /auth/firebase` handler)
- `internal/auth/handler.go::mapVerifyFirebaseError`
- `internal/auth/service.go::VerifyFirebaseToken` (service-level upsert wrapper)
- `internal/auth/model.go::FirebaseAuthRequest`
- `internal/auth/handler_test.go::TestMapVerifyFirebaseError_*`
- `router.Post("/firebase", h.VerifyFirebase)` mount in `RegisterRoutes`

## Why the `firebase.google.com/go/v4` module stays in `go.mod`

`internal/notification` uses **Firebase Cloud Messaging** (FCM) to deliver
push notifications. `internal/crm/growth` + `internal/analytics/sanitizer`
also touch the broader Firebase SDK. Only the `/auth` sub-package was the
phone-auth verifier — that sub-package is no longer imported anywhere in
active code (verified by `grep -rln "firebase.google.com/go/v4/auth"`
returning zero hits in `internal/` + `cmd/`).

## Rollback recipe (if needed before 2026-08-16)

1. Copy `firebase.go` back to `internal/auth/firebase.go`.
2. Re-add `VerifyFirebase` handler + `VerifyFirebaseToken` service method
   from `git log -- internal/auth/handler.go internal/auth/service.go`.
3. Re-add the `router.Post("/firebase", ...)` mount in `RegisterRoutes`.
4. Re-add `FirebaseAuthRequest` to `model.go`.
5. Ensure `FIREBASE_CREDENTIALS_JSON` is set on the Railway service.
