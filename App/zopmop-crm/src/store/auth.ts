import { create } from 'zustand';

// Auth state. The access token lives in memory only — never localStorage —
// because XSS is the larger threat than reload-time token loss. Reload
// silently calls /auth/refresh which uses the HttpOnly cookie to mint a
// fresh access token without user interaction.
export type Admin = {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string | null;
  role: string;
  permissions: unknown;
};

type AuthState = {
  accessToken: string | null;
  expiresAt: number | null; // ms epoch
  admin: Admin | null;
  isReady: boolean;         // becomes true after initial /refresh attempt resolves
  setSession: (token: string, expiresAt: string, admin: Admin) => void;
  clear: () => void;
  setReady: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  expiresAt: null,
  admin: null,
  isReady: false,
  setSession: (token, expiresAt, admin) =>
    set({
      accessToken: token,
      expiresAt: new Date(expiresAt).getTime(),
      admin,
      isReady: true,
    }),
  clear: () => set({ accessToken: null, expiresAt: null, admin: null, isReady: true }),
  setReady: () => set({ isReady: true }),
}));

// Helper read used outside React components (the api client).
export const getAccessToken = () => useAuth.getState().accessToken;
