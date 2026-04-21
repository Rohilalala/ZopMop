import { createContext, useState, useEffect } from 'react';
import client from '../api/client';

export const AuthContext = createContext(null);

// JWT is stored exclusively in the HttpOnly auth_token cookie set by the
// backend on /auth/verify-otp and /auth/firebase. JS cannot read it, so XSS
// cannot steal it. The browser attaches it automatically on every request
// because the axios client is configured with withCredentials=true.
//
// Only the User profile (id, role, name) is cached client-side in
// sessionStorage for UI rendering. It is not a credential.
const USER_KEY = 'househelp_user';
const LEGACY_TOKEN_KEY = 'househelp_token';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  useEffect(() => {
    // One-time migration: evict any legacy JWT copies from prior builds.
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);

    const savedUser = sessionStorage.getItem(USER_KEY);
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (e) {
        console.error('Failed to parse user from session storage', e);
        sessionStorage.removeItem(USER_KEY);
      }
    }
  }, []);

  const login = (_ignoredToken, newUser) => {
    // The JWT is set as an HttpOnly cookie by the server — we ignore the
    // body-returned token on web. Only persist the user profile.
    sessionStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setUser(newUser);
  };

  const logout = async () => {
    try {
      // Server clears the HttpOnly cookie.
      await client.post('/auth/logout');
    } catch {
      // Even if the network call fails, evict local state.
    }
    sessionStorage.removeItem(USER_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
