import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerSignOutCallback, registerTokenAccessors, apiFetch } from '../api/client';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { BASE_URL } from '../api/config';
import { promoStore } from '../utils/promoStore';
import { posthog } from '../config/posthog';
import { setUser as sentrySetUser } from '../config/sentry';
import { logout as logoutHTTP, refreshAccessToken, type AuthUser as ServiceAuthUser } from '../services/auth';

// MSG91-backed auth state. Two tokens are persisted in expo-secure-store:
//
//   - ACCESS_KEY  — short-lived JWT used as Authorization: Bearer
//   - REFRESH_KEY — opaque base64url string used to mint a new pair
//
// On launch the provider tries the stored access token against /me.
// On 401 it falls back to /refresh; on second failure it signs out
// and routes the user to PhoneEntry. The old Firebase silent-refresh
// path is gone — see _legacy/firebase_auth/ for the archive.

const ACCESS_KEY = 'auth_access_token';
const REFRESH_KEY = 'auth_refresh_token';
const USER_KEY = 'auth_user';
const LEGACY_TOKEN_KEY = 'auth_token'; // single-token Firebase-era key
const SIGNUP_COMPLETED_KEY = 'auth_signup_completed_v1';

// Re-export so the rest of the app keeps importing AuthUser from here.
export type AuthUser = ServiceAuthUser;

type AuthContextType = {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  signIn: (access: string, refresh: string, user: AuthUser) => void;
  signOut: () => void;
  updateUser: (user: AuthUser) => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Refs let the apiFetch token-accessors read the *current* values
  // without rebuilding on every state update.
  const tokenRef = useRef<string | null>(null);
  const refreshTokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  refreshTokenRef.current = refreshToken;

  // Push notifications: same contract as before, role drives which
  // device_tokens column the backend writes.
  usePushNotifications(token, token !== null && token !== '__guest__', user?.role ?? null);

  // Persist tokens. Set both keys (or wipe both) so the in-memory
  // state and SecureStore never disagree.
  const persistTokens = useCallback((access: string | null, refresh: string | null) => {
    if (access) {
      SecureStore.setItemAsync(ACCESS_KEY, access).catch(() => {});
    } else {
      SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {});
    }
    if (refresh) {
      SecureStore.setItemAsync(REFRESH_KEY, refresh).catch(() => {});
    } else {
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    }
  }, []);

  const signOut = useCallback(() => {
    posthog.capture('user_signed_out');
    posthog.reset();
    sentrySetUser(null);
    // Best-effort server-side revoke. Don't block — the local wipe is
    // what actually signs the user out.
    logoutHTTP(tokenRef.current, refreshTokenRef.current);
    setToken(null);
    setRefreshToken(null);
    setUser(null);
    SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {});
    SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
    SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY).catch(() => {});
    SecureStore.deleteItemAsync(SIGNUP_COMPLETED_KEY).catch(() => {});
    promoStore.clear();
    AsyncStorage.multiRemove(['pendingReferralCode', 'pendingReferralCodeAt']).catch(() => {});
  }, []);

  const signOutRef = useRef(signOut);
  useEffect(() => { signOutRef.current = signOut; }, [signOut]);

  // Wire apiFetch into the auth state so it can attach Bearer headers
  // and silently rotate on 401 without an import cycle.
  useEffect(() => {
    registerSignOutCallback(() => signOutRef.current());
    registerTokenAccessors({
      getAccess: () => tokenRef.current,
      getRefresh: () => refreshTokenRef.current,
      setTokens: (access: string, refresh: string) => {
        setToken(access);
        setRefreshToken(refresh);
        persistTokens(access, refresh);
      },
    });
  }, [persistTokens]);

  // Restore session on launch.
  useEffect(() => {
    const ceiling = setTimeout(() => {
      console.warn('[Auth] restore exceeded ceiling — forcing isLoading=false');
      setIsLoading(false);
    }, 8_000);

    (async () => {
      try {
        const [storedAccess, storedRefresh, storedUser, legacyToken] = await Promise.all([
          SecureStore.getItemAsync(ACCESS_KEY),
          SecureStore.getItemAsync(REFRESH_KEY),
          SecureStore.getItemAsync(USER_KEY),
          SecureStore.getItemAsync(LEGACY_TOKEN_KEY),
        ]);

        // Upgrade path: a pre-migration install carried only the
        // single Firebase-era token. Treat it as an access token and
        // attempt one /me call; on 401 the user lands on PhoneEntry.
        const access = storedAccess ?? legacyToken ?? null;
        if (!access) {
          // No stored credentials — clean slate.
          if (legacyToken) {
            SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY).catch(() => {});
          }
          return;
        }

        // Hydrate state before the /me probe so the UI can render
        // cached user info if the network is slow.
        setToken(access);
        if (storedRefresh) setRefreshToken(storedRefresh);
        if (storedUser) {
          try { setUser(JSON.parse(storedUser) as AuthUser); } catch { /* ignore corrupted */ }
        }

        // Validate against the server. If /me 401s and we have a
        // refresh token, apiFetch will rotate transparently.
        try {
          const res = await apiFetch(`${BASE_URL}/me`, { method: 'GET' });
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            // apiFetch already attempted /refresh internally; a 401
            // here means refresh failed too. signOut was already
            // invoked by the 401 interceptor.
            return;
          }
          if (res.ok) {
            const fresh = await res.json() as AuthUser;
            setUser(fresh);
            SecureStore.setItemAsync(USER_KEY, JSON.stringify(fresh)).catch(() => {});
            SecureStore.setItemAsync(SIGNUP_COMPLETED_KEY, '1').catch(() => {});
          }
        } catch {
          // Offline — keep cached state.
          console.info('[Auth] server unreachable — restoring from cache');
        }
      } finally {
        clearTimeout(ceiling);
        setIsLoading(false);
      }
    })();

    return () => clearTimeout(ceiling);
  }, []);

  // Re-validate on foreground (catches mid-session deletion). Same
  // contract as before — apiFetch handles 401 → refresh → retry.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const currentToken = tokenRef.current;
      if (nextState !== 'active' || !currentToken || currentToken === '__guest__') return;
      apiFetch(`${BASE_URL}/me`, { method: 'GET' })
        .then((res) => {
          if (res.status === 403 || res.status === 404) {
            console.warn('[Auth] foreground re-validation failed — signing out');
            signOutRef.current();
          }
        })
        .catch(() => {}); // offline — keep session
    });
    return () => sub.remove();
  }, []);

  function signIn(access: string, refresh: string, authUser: AuthUser) {
    if (!access || access === '__guest__') {
      console.warn('[Auth] signIn called with empty or sentinel token — ignoring.');
      return;
    }
    setToken(access);
    setRefreshToken(refresh);
    setUser(authUser);
    persistTokens(access, refresh);
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(authUser)).catch(() => {});
    SecureStore.setItemAsync(SIGNUP_COMPLETED_KEY, '1').catch(() => {});
    // PostHog identify: distinct_id + cohort props only — no PII.
    posthog.identify(authUser.id, {
      $set: { role: authUser.role, user_type: authUser.type },
      $set_once: { first_sign_in_date: new Date().toISOString() },
    });
    sentrySetUser(authUser.id);
    posthog.capture('user_signed_in', { role: authUser.role, user_type: authUser.type });
  }

  function updateUser(updatedUser: AuthUser) {
    setUser(updatedUser);
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(updatedUser)).catch(() => {});
  }

  // Suppress the unused-import warning for refreshAccessToken — it's
  // re-exported below so the legacy paths can still call it directly
  // if needed during the migration. Tree-shaken in prod builds.
  void refreshAccessToken;

  return (
    <AuthContext.Provider value={{
      isAuthenticated: token !== null && token !== '__guest__',
      isLoading,
      token,
      refreshToken,
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
