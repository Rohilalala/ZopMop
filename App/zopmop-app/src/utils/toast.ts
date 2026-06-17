import Toast from 'react-native-toast-message';
import { haptics } from './haptics';
import { navigationRef } from '../navigation/navigationRef';
import { presentZopBanner, type ZopBannerType } from '../components/ZopErrorBanner';

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

// Default headlines per notification type for the Zop banner.
const DEFAULT_TITLE: Record<ZopBannerType, string> = {
  error: 'Hmm, that didn’t work',
  success: 'All set',
  info: 'Heads up',
};

// Route a notification to the universal Zop banner, except on screens where Zop
// is already on stage — there it falls back to the plain top toast.
function notify(type: ZopBannerType, message: string, opts: Opts) {
  const route = currentRoute();
  if (!route || !ZOP_PRESENT_SCREENS.has(route)) {
    presentZopBanner({ type, title: opts.title ?? DEFAULT_TITLE[type], message });
    return;
  }
  if (type === 'error') haptics.error();
  else if (type === 'success') haptics.success();
  Toast.show({
    type,
    text1: opts.title ?? (type === 'error' ? 'Something went wrong' : type === 'success' ? 'Done' : message),
    text2: type === 'info' && !opts.title ? undefined : message,
    position: 'top',
    visibilityTime: opts.duration ?? (type === 'error' ? 3500 : 2500),
  });
}

export function showError(message: string, opts: Opts = {}) {
  notify('error', message, opts);
}

export function showSuccess(message: string, opts: Opts = {}) {
  notify('success', message, opts);
}

export function showInfo(message: string, opts: Opts = {}) {
  notify('info', message, opts);
}
