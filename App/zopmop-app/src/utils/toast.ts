import Toast from 'react-native-toast-message';
import { haptics } from './haptics';
import { navigationRef } from '../navigation/navigationRef';
import { presentZopError } from '../components/ZopErrorBanner';

type Opts = { title?: string; duration?: number };

// Screens where Zop is already on stage — there the friendly Zop banner would
// be a second Zop, so errors fall back to the plain top toast instead.
const ZOP_PRESENT_SCREENS = new Set<string>([
  'Home',
  'ZopIntro', 'HiZop', 'Welcome', 'PhoneEntry', 'OTPVerification', 'NameEntry', 'Location', 'NotServiceable',
  'BookingConfirmed',
]);

function currentRoute(): string | undefined {
  try {
    return navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined;
  } catch {
    return undefined;
  }
}

export function showError(message: string, opts: Opts = {}) {
  const route = currentRoute();
  // Off the Zop-present screens, errors get the friendly Zop banner.
  if (!route || !ZOP_PRESENT_SCREENS.has(route)) {
    presentZopError({ title: opts.title ?? 'Hmm, that didn’t work', message });
    return;
  }
  // Zop-present screen → plain toast (no duplicate Zop).
  haptics.error();
  Toast.show({
    type: 'error',
    text1: opts.title ?? 'Something went wrong',
    text2: message,
    position: 'top',
    visibilityTime: opts.duration ?? 3500,
  });
}

export function showSuccess(message: string, opts: Opts = {}) {
  haptics.success();
  Toast.show({
    type: 'success',
    text1: opts.title ?? 'Done',
    text2: message,
    position: 'top',
    visibilityTime: opts.duration ?? 2500,
  });
}

export function showInfo(message: string, opts: Opts = {}) {
  Toast.show({
    type: 'info',
    text1: opts.title ?? message,
    text2: opts.title ? message : undefined,
    position: 'top',
    visibilityTime: opts.duration ?? 2500,
  });
}
