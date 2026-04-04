import type { FirebaseAuthTypes } from '@react-native-firebase/auth';

/**
 * Holds the Firebase ConfirmationResult between PhoneEntry and OTPVerification.
 * Kept outside navigation state because ConfirmationResult is a class instance
 * (non-serializable) and would trigger React Navigation warnings if passed as a param.
 */
let _confirmation: FirebaseAuthTypes.ConfirmationResult | null = null;

export const otpStore = {
  set(c: FirebaseAuthTypes.ConfirmationResult) {
    _confirmation = c;
  },
  get(): FirebaseAuthTypes.ConfirmationResult | null {
    return _confirmation;
  },
  clear() {
    _confirmation = null;
  },
};
