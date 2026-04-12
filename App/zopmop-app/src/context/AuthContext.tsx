import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { registerSignOutCallback, apiFetch } from '../api/client';
import { updateFCMToken } from '../api/users';
import { usePushNotifications } from '../hooks/usePushNotifications';

import { BASE_URL } from '../api/config';
import { otpStore } from '../utils/otpStore';
import { promoStore } from '../utils/promoStore';
import { pendingAuthStore } from '../utils/pendingAuthStore';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

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

  const { expoPushToken } = usePushNotifications();

  // Register the global signOut callback so apiFetch can sign out on 401.
  useEffect(() => {
    registerSignOutCallback(signOut);
  }, []);

  // Restore session from SecureStore on app launch, then validate the token
  // against the backend. Signs out if the user no longer exists in the DB.
  useEffect(() => {
    async function restore() {
      try {
        const [storedToken, storedUser] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(USER_KEY),
        ]);

        if (!storedToken) return;

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
            // User deleted or token invalid — wipe the session.
            console.warn('[Auth] token rejected by server — clearing session');
            await Promise.all([
              SecureStore.deleteItemAsync(TOKEN_KEY),
              SecureStore.deleteItemAsync(USER_KEY),
            ]);
            return;
          }

          if (res.ok) {
            const freshUser: AuthUser = await res.json();
            setToken(storedToken);
            setUser(freshUser);
            console.info('[Auth] session restored from server');
            SecureStore.setItemAsync(USER_KEY, JSON.stringify(freshUser)).catch(() => {});
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
        setIsLoading(false);
      }
    }
    restore();
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

  // Sync FCM token to backend when logged in and token is available
  useEffect(() => {
    if (token && token !== '__guest__' && expoPushToken) {
      updateFCMToken(token, expoPushToken).catch(() => {});
    }
  }, [token, expoPushToken]);

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
  }

  function signOut() {
    setToken(null);
    setUser(null);
    SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
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
