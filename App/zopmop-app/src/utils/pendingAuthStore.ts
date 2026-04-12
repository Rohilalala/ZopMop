import type { AuthUser } from '../context/AuthContext';

/**
 * Holds the backend JWT and user object during the post-OTP onboarding flow
 * (OTPVerification → NameEntry → RoleSelection → ProOnboarding).
 *
 * Security rationale: React Navigation route params are serializable and may be
 * persisted to disk by state-persistence features, or appear in Android's saved
 * instance state bundle. Keeping the JWT here (module-level memory only) prevents
 * it from being written to any persistent storage outside of SecureStore.
 *
 * This store must be cleared after sign-in completes or the flow is abandoned.
 */

interface PendingAuth {
  token: string;
  user?: AuthUser;
}

let _pending: PendingAuth | null = null;

export const pendingAuthStore = {
  set(token: string, user?: AuthUser) {
    _pending = { token, user };
  },
  get(): PendingAuth | null {
    return _pending;
  },
  clear() {
    _pending = null;
  },
};
