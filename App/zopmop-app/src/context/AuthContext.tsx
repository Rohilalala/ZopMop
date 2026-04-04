import React, { createContext, useContext, useState } from 'react';

type AuthContextType = {
  isAuthenticated: boolean;
  signIn: (phone: string, role: 'user' | 'professional') => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  function signIn(_phone: string, _role: 'user' | 'professional') {
    setIsAuthenticated(true);
  }

  function signOut() {
    setIsAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
