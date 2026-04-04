// Global signOut callback registered by AuthProvider on mount.
let _signOut: (() => void) | null = null;

export function registerSignOutCallback(fn: () => void) {
  _signOut = fn;
}

/** Call this to trigger a global sign-out (e.g. user deleted from DB). */
export function triggerSignOut() {
  _signOut?.();
}

/**
 * Drop-in replacement for fetch that auto-signs-out on 401 (token invalid / expired).
 * Use this for all authenticated API calls.
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    _signOut?.();
  }
  return res;
}
