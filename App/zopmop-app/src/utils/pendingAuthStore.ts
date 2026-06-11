// pendingAuthStore — in-memory flag tracking whether a freshly-signed-up
// user still needs to complete the Welcome → RoleSelection (→ ProOnboarding)
// flow.
//
// Why this exists: a new user signs in (signIn() flips isAuthenticated)
// BEFORE choosing customer-vs-pro. Without this flag, App.tsx immediately
// swaps AuthNavigator → MainNavigator, unmounting Welcome before its
// auto-advance timer can navigate to RoleSelection — so in-app pro signup
// was unreachable and every signup silently became a customer.
//
// Keeping the user signed in (rather than deferring signIn) is deliberate:
// RoleSelection and ProOnboarding both make authenticated API calls
// (/me/onboard-pro), so they need a live session. This flag just keeps the
// AuthNavigator mounted until role selection completes.
//
// In-memory only — never persisted. A relaunch mid-flow lands the user in
// the app per their backend role, which is the correct fallback.

let needsRoleSelection = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* keep going */ }
  });
}

/** Marks that the current session must finish role selection before
 *  entering the main app. Called from OTPVerification for new users. */
export function setNeedsRoleSelection(value: boolean) {
  if (needsRoleSelection === value) return;
  needsRoleSelection = value;
  emit();
}

export function getNeedsRoleSelection(): boolean {
  return needsRoleSelection;
}

/** Subscribe to changes. Returns an unsubscribe fn. */
export function onPendingAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
