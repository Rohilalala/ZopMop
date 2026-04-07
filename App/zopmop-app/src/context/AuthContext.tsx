import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { registerSignOutCallback } from '../api/client';
import { updateFCMToken } from '../api/users';
import { usePushNotifications } from '../hooks/usePushNotifications';

import { BASE_URL } from '../api/config';

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
        try {
          const res = await fetch(`${BASE_URL}/me`, {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          if (res.status === 401 || res.status === 403 || res.status === 404) {
            // User deleted or token invalid — wipe the session.
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
            SecureStore.setItemAsync(USER_KEY, JSON.stringify(freshUser)).catch(() => {});
            return;
          }
        } catch {
          // Network error (offline) — restore from cache so the app still works.
        }

        // Backend unreachable: restore from SecureStore cache.
        setToken(storedToken);
        if (storedUser) setUser(JSON.parse(storedUser));
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

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const currentToken = tokenRef.current;
      if (nextState !== 'active' || !currentToken || currentToken === '__guest__') return;
      fetch(`${BASE_URL}/me`, { headers: { Authorization: `Bearer ${currentToken}` } })
        .then((res) => {
          if (res.status === 401 || res.status === 403 || res.status === 404) signOut();
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
