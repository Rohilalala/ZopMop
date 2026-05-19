# Legacy Firebase Phone Auth — Archived

This folder holds the customer-app pieces of the **Firebase Phone Auth**
flow that was replaced by the in-house **MSG91 OTP + self-issued JWT**
flow during the Phase 5 migration.

| | |
|---|---|
| Initial archival (Phase 5) | 2026-05-16 |
| Phase 9 final cleanup | 2026-05-16 |
| Removal target | 2026-08-16 (90 days from cleanup) |

After 2026-08-16, if MSG91 has shipped stable without a rollback need,
this directory **and** the `@react-native-firebase/auth` package can be
deleted in a single PR. FCM (`@react-native-firebase/messaging`) and
Analytics (`@react-native-firebase/analytics`) stay — they're unrelated
to auth.

## Files

| File | Role in the old flow |
|------|----------------------|
| `otpStore.ts` | In-memory holder for the Firebase `ConfirmationResult` passed between `PhoneEntryScreen` and `OTPVerificationScreen`. No longer reachable from current screens. |
| `pendingAuthStore.ts` | In-memory holder for the backend JWT minted by `POST /auth/firebase` while the user was still on the NameEntry/RoleSelection screens. Replaced by direct `signIn()` in `OTPVerificationScreen` (Phase 5). |

## What changed in active code (Phases 5 + 9)

- `src/screens/auth/PhoneEntryScreen.tsx` — drops `getAuth`/`signInWithPhoneNumber`; calls `sendOTP()` from `src/services/auth.ts` instead.
- `src/screens/auth/OTPVerificationScreen.tsx` — drops `confirmation.confirm()`/`getIdToken()`/`/auth/firebase` exchange; calls `verifyOTP()` and signs in with `{access, refresh, user}`.
- `src/screens/auth/NameEntryScreen.tsx` — drops `pendingAuthStore`; pulls `token` + `updateUser` from `useAuth()`.
- `src/screens/auth/RoleSelectionScreen.tsx` — drops `signIn`/`pendingAuthStore` (user is already signed in by then).
- `src/screens/auth/WelcomeScreen.tsx` — reads name from `useAuth().user`.
- `src/screens/pro/ProOnboardingScreen.tsx` — drops the pendingAuthStore bridge; uses `apiFetch` auto-auth + `updateUser`.
- `src/context/AuthContext.tsx` — two-token model (access + refresh in `expo-secure-store`), HTTP `/refresh` rotation, no more `tryFirebaseSilentRefresh`.
- `src/api/client.ts` — Bearer header injection + 401 → `/refresh` → retry.

## Why the `@react-native-firebase/*` packages stay in `package.json`

`@react-native-firebase/{app, messaging}` are required for **FCM push**
and **Firebase Analytics**. Removing them now would break:
- `src/hooks/usePushNotifications.ts` — FCM token register/refresh
- `index.ts` — `messaging().setBackgroundMessageHandler` at module top level

`@react-native-firebase/auth` is no longer imported by any file in
`src/` (verified with `grep -r "@react-native-firebase/auth" src` →
zero hits). It only stays in `package.json` because removing it
forces a native pod resync that we'd rather batch with other native
churn. Drop it together with this folder at the 2026-08-16 target.

## Verification commands (re-run before any PR that touches auth)

```bash
# Backend — zero hits expected
grep -rln "firebase.google.com/go/v4/auth" internal cmd

# App — zero hits expected
grep -rln "react-native-firebase/auth\|PhoneAuthProvider\|signInWithPhoneNumber\|verifyPhoneNumber" src
```
