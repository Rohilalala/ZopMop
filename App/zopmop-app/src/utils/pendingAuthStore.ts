// pendingAuthStore — in-memory flag tracking whether a freshly-named user
// still needs to see the Welcome screen before entering the main app.
//
// Why this exists: saving the name on NameEntry (updateUser) flips App.tsx
// `needsName` to false, which would immediately swap AuthNavigator →
// MainNavigator and unmount Welcome before it can render. This flag keeps
// the AuthNavigator mounted for the one Welcome beat after naming.
//
// Roles are never chosen in-app: every signup is a customer and only the
// CRM can promote a number to pro, so there is no role-selection step to
// gate anymore.
//
// In-memory only — never persisted. A relaunch mid-flow lands the user in
// the app per their backend role, which is the correct fallback.

let needsWelcome = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* keep going */ }
  });
}

/** Marks that the current session must show Welcome before entering the
 *  main app. Set from NameEntry after the name is saved. */
export function setNeedsWelcome(value: boolean) {
  if (needsWelcome === value) return;
  needsWelcome = value;
  emit();
}

export function getNeedsWelcome(): boolean {
  return needsWelcome;
}

/** Subscribe to changes. Returns an unsubscribe fn. */
export function onPendingAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
