import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { registerSignOutCallback, apiFetch } from '../api/client';
import { usePushNotifications } from '../hooks/usePushNotifications';

import { BASE_URL } from '../api/config';
import { otpStore } from '../utils/otpStore';
import { promoStore } from '../utils/promoStore';
import { pendingAuthStore } from '../utils/pendingAuthStore';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';
// Marker: this device has completed at least one full backend signIn. Gates
// Firebase silent-refresh on launch so a force-quit during OTP entry — which
// commits Firebase native state before the backend handoff finishes — cannot
// mint a session on the next launch.
const SIGNUP_COMPLETED_KEY = 'auth_signup_completed_v1';

// Silent-restore window. If Firebase reports a sign-in newer than this, we'll
// try to silently re-issue the backend session via getIdToken(true) → POST
// /auth/firebase. Older sessions force the user back through PhoneEntry so
// stale device installs can't roll forward indefinitely.
const FIREBASE_SILENT_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Hard cap on any Firebase native call we make from launch-restore. If the
// native module hangs (broken bridge, stuck token refresh) we must NOT block
// setIsLoading(false) — that strands the UI on a black screen because
// Navigation returns null while isLoading is true.
const FIREBASE_OP_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

// Silently exchange a fresh Firebase ID token for a backend JWT. Returns the
// session on success. Returns null when:
//   - @react-native-firebase/auth is unavailable (Expo Go, web, missing native)
//   - no current Firebase user
//   - last sign-in is older than the window
//   - token refresh throws
//   - backend exchange returns non-2xx
async function tryFirebaseSilentRefresh(): Promise<{ token: string; user?: AuthUser } | null> {
  let mod: typeof import('@react-native-firebase/auth') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@react-native-firebase/auth');
  } catch {
    return null;
  }
  if (!mod) return null;

  try {
    const fbAuth = mod.getAuth();
    const current = fbAuth.currentUser;
    if (!current) return null;

    // metadata.lastSignInTime is an ISO string per Firebase types.
    const lastSignInIso = current.metadata?.lastSignInTime;
    const lastSignInMs = lastSignInIso ? Date.parse(lastSignInIso) : NaN;
    if (!Number.isFinite(lastSignInMs)) return null;
    if (Date.now() - lastSignInMs > FIREBASE_SILENT_REFRESH_WINDOW_MS) {
      console.info('[Auth] Firebase session older than window — skipping silent refresh');
      return null;
    }

    const idToken = await withTimeout(mod.getIdToken(current, true), FIREBASE_OP_TIMEOUT_MS);
    if (!idToken) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`${BASE_URL}/auth/firebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebase_token: idToken }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn('[Auth] Firebase silent refresh: backend returned', res.status);
        return null;
      }
      const data = await res.json();
      if (!data?.token) return null;
      return { token: data.token as string, user: data.user as AuthUser | undefined };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.info('[Auth] Firebase silent refresh failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Sign out of Firebase native state without surfacing errors. Used to clear
// orphaned currentUser created by a partial OTP attempt (confirmation.confirm
// commits Firebase state before the backend handoff). No-op when the module
// isn't available or no current user exists.
async function trySignOutFirebaseSilently(): Promise<void> {
  let mod: typeof import('@react-native-firebase/auth') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@react-native-firebase/auth');
  } catch {
    return;
  }
  if (!mod) return;
  try {
    const fbAuth = mod.getAuth();
    if (fbAuth.currentUser) {
      await withTimeout(mod.signOut(fbAuth), FIREBASE_OP_TIMEOUT_MS);
      console.info('[Auth] cleared lingering Firebase native state');
    }
  } catch {
    // non-fatal
  }
}

export interface AuthUser {
  id: string;
  phone: string;
  name?: string;
  role: string;
  created_at: string;
  updated_at: string;
}

type AuthContextType = {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  user: AuthUser | null;
  signIn: (jwt: string, user?: AuthUser) => void;
  signOut: () => void;
  updateUser: (user: AuthUser) => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Side-effect-only hook: requests notification permission, fetches the FCM
  // token, and registers it with the backend whenever the user is signed in.
  // Pass auth state directly — this runs inside AuthProvider so useAuth is unavailable.
  usePushNotifications(token, token !== null && token !== '__guest__', user?.role ?? null);

  // Register the global signOut callback so apiFetch can sign out on 401.
  useEffect(() => {
    registerSignOutCallback(signOut);
  }, []);

  // Restore session from SecureStore on app launch, then validate the token
  // against the backend. Signs out if the user no longer exists in the DB.
  // Falls back to a Firebase silent refresh when no stored token is present
  // or the stored token is rejected — this lets returning users skip
  // PhoneEntry as long as their Firebase session is < 30 days old.
  useEffect(() => {
    // Hard ceiling: no matter what restore() is doing, flip isLoading so the
    // UI never strands on a black screen. SecureStore/Firebase native bridges
    // can hang on simulator and would otherwise keep Navigation rendering null.
    const ceiling = setTimeout(() => {
      console.warn('[Auth] restore exceeded ceiling — forcing isLoading=false');
      setIsLoading(false);
    }, 8_000);

    async function trySilentFirebase(): Promise<boolean> {
      const session = await tryFirebaseSilentRefresh();
      if (!session) return false;
      setToken(session.token);
      if (session.user) setUser(session.user);
      try {
        await SecureStore.setItemAsync(TOKEN_KEY, session.token);
        if (session.user) {
          await SecureStore.setItemAsync(USER_KEY, JSON.stringify(session.user));
        }
        await SecureStore.setItemAsync(SIGNUP_COMPLETED_KEY, '1');
      } catch {}
      console.info('[Auth] session restored via Firebase silent refresh');
      return true;
    }

    async function restore() {
      try {
        const [storedToken, storedUser] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(USER_KEY),
        ]);

        if (!storedToken) {
          // Gate silent refresh on prior successful signIn. Without this,
          // confirmation.confirm() during OTP entry commits Firebase native
          // state before the backend handoff — a force-quit at that point
          // would let the next launch mint a session despite signup never
          // completing. Marker is set in signIn(), cleared in signOut().
          const completed = await SecureStore
            .getItemAsync(SIGNUP_COMPLETED_KEY)
            .catch(() => null);
          if (completed === '1') {
            await trySilentFirebase();
          } else {
            await trySignOutFirebaseSilently();
          }
          return;
        }

        // Validate the stored token — catches deleted users and expired tokens.
        // 5s timeout prevents splash screen hang if backend is unreachable.
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          let res: Response | null = null;
          try {
            res = await apiFetch(`${BASE_URL}/me`, {
              headers: { Authorization: `Bearer ${storedToken}` },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          if (res.status === 401 || res.status === 403 || res.status === 404) {
            // User deleted or token invalid — wipe the session and try a
            // Firebase silent refresh before falling back to PhoneEntry.
            console.warn('[Auth] token rejected by server — clearing session');
            await Promise.all([
              SecureStore.deleteItemAsync(TOKEN_KEY),
              SecureStore.deleteItemAsync(USER_KEY),
            ]);
            await trySilentFirebase();
            return;
          }

          if (res.ok) {
            const freshUser: AuthUser = await res.json();
            setToken(storedToken);
            setUser(freshUser);
            console.info('[Auth] session restored from server');
            SecureStore.setItemAsync(USER_KEY, JSON.stringify(freshUser)).catch(() => {});
            // Backfill marker for upgrade migration: pre-fix users have a
            // valid session but no marker; setting it preserves their UX
            // if their token later gets revoked and triggers silent refresh.
            SecureStore.setItemAsync(SIGNUP_COMPLETED_KEY, '1').catch(() => {});
            return;
          }
        } catch {
          // Network error or timeout (offline) — restore from cache so app still works.
          console.info('[Auth] server unreachable — restoring from cache');
        }

        // Backend unreachable: restore from SecureStore cache.
        setToken(storedToken);
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser));
            console.info('[Auth] session restored from cache');
          } catch {
            // Corrupted cache — stay authenticated but without user object.
            // Will be repopulated on next successful /me call.
            console.warn('[Auth] corrupted user cache — clearing');
            SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
          }
        }
      } catch {
        // SecureStore unavailable (simulator without keychain) — start unauthenticated.
      } finally {
        clearTimeout(ceiling);
        setIsLoading(false);
      }
    }
    restore();
    return () => clearTimeout(ceiling);
  }, []);

  // Re-validate when the app comes to the foreground (catches mid-session user deletion).
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  // Keep signOut ref current so the AppState listener (registered once) always
  // calls the latest signOut without needing to re-subscribe.
  const signOutRef = useRef(signOut);
  useEffect(() => { signOutRef.current = signOut; });

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const currentToken = tokenRef.current;
      if (nextState !== 'active' || !currentToken || currentToken === '__guest__') return;
      apiFetch(`${BASE_URL}/me`, { headers: { Authorization: `Bearer ${currentToken}` } })
        .then((res) => {
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            console.warn('[Auth] foreground re-validation failed — signing out');
            signOutRef.current();
          }
        })
        .catch(() => {}); // offline — keep session
    });
    return () => sub.remove();
  }, []);

  function signIn(jwt: string, authUser?: AuthUser) {
    // Security: reject sentinel/placeholder tokens — they must never be stored
    // or used to make authenticated API calls.
    if (!jwt || jwt === '__guest__') {
      console.warn('[Auth] signIn called with empty or sentinel token — ignoring.');
      return;
    }
    setToken(jwt);
    if (authUser) setUser(authUser);
    SecureStore.setItemAsync(TOKEN_KEY, jwt).catch(() => {});
    if (authUser) {
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(authUser)).catch(() => {});
    }
    SecureStore.setItemAsync(SIGNUP_COMPLETED_KEY, '1').catch(() => {});
  }

  function signOut() {
    setToken(null);
    setUser(null);
    SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
    SecureStore.deleteItemAsync(SIGNUP_COMPLETED_KEY).catch(() => {});
    // Clear Firebase native state too — otherwise the next launch could
    // silent-refresh from the orphaned Firebase user (defense in depth;
    // the marker check above is the primary gate).
    trySignOutFirebaseSilently().catch(() => {});
    // Clear all module-level singletons so a subsequent user on the same
    // device cannot inherit stale OTP handles, promo codes, or pending tokens.
    otpStore.clear();
    promoStore.clear();
    pendingAuthStore.clear();
  }

  function updateUser(updatedUser: AuthUser) {
    setUser(updatedUser);
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(updatedUser)).catch(() => {});
  }

  return (
    <AuthContext.Provider value={{
      isAuthenticated: token !== null && token !== '__guest__',
      isLoading,
      token,
      user,
      signIn,
      signOut,
      updateUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
