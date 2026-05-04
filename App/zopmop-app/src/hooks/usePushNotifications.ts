import { useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import { registerDevice } from '../api/devices';
import { routeFcmMessage } from '../utils/pushRouter';

const LAST_TOKEN_KEY = 'zopmop.lastFcmToken';

// Lazily-required messaging module. Required at first use so that the app
// does not crash at import time if the native module is missing (Expo Go,
// older binary that hasn't been rebuilt with the new plugin, web).
function getMessaging():
  | typeof import('@react-native-firebase/messaging').default
  | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-firebase/messaging');
    return (mod?.default ?? mod) as typeof import('@react-native-firebase/messaging').default;
  } catch (err) {
    console.info('[Push] @react-native-firebase/messaging unavailable — skipping FCM init', err);
    return null;
  }
}

async function getDeviceID(): Promise<string> {
  try {
    if (Platform.OS === 'ios') {
      return (await Application.getIosIdForVendorAsync()) ?? 'ios-unknown';
    }
    return Application.getAndroidId() ?? 'android-unknown';
  } catch {
    return `${Platform.OS}-unknown`;
  }
}

export function usePushNotifications(authToken: string | null, isAuthenticated: boolean) {
  const [fcmToken, setFcmToken] = useState<string | undefined>(undefined);
  const [notification, setNotification] = useState<unknown>(undefined);

  const registerToken = useCallback(
    async (newToken: string) => {
      if (!authToken || authToken === '__guest__') return;
      try {
        const last = await SecureStore.getItemAsync(LAST_TOKEN_KEY);
        if (last === newToken) return; // skip redundant registration
        const deviceId = await getDeviceID();
        const platform = (Platform.OS === 'ios' ? 'ios' : 'android') as 'ios' | 'android';
        await registerDevice(authToken, {
          fcm_token: newToken,
          platform,
          device_id: deviceId,
        });
        await SecureStore.setItemAsync(LAST_TOKEN_KEY, newToken);
      } catch (err) {
        // Network failure or backend rejection — try again on next launch /
        // token refresh. Do not surface to UI.
        console.warn('[Push] device register failed', err);
      }
    },
    [authToken],
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    const messaging = getMessaging();
    if (!messaging) return;

    let unsubRefresh: (() => void) | undefined;
    let unsubMessage: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const status = await messaging().requestPermission();
        const granted =
          status === messaging.AuthorizationStatus.AUTHORIZED ||
          status === messaging.AuthorizationStatus.PROVISIONAL;
        if (!granted || cancelled) return;

        const t = await messaging().getToken();
        if (cancelled) return;
        if (t) {
          setFcmToken(t);
          registerToken(t);
        }

        unsubRefresh = messaging().onTokenRefresh((next: string) => {
          setFcmToken(next);
          registerToken(next);
        });
        unsubMessage = messaging().onMessage((m: any) => {
          setNotification(m);
          // Route data-only pushes (SCHEDULED_INVITE, BOOKING_*) to the
          // right screen / toast. Foreground delivery only — background
          // taps land in the OS tray and re-open the app via the deep-link
          // handler (TODO: wire in App.tsx if we add tray notifications).
          routeFcmMessage(m?.data as Record<string, string> | undefined);
        });
      } catch (err) {
        // Permission denied, APNs unavailable, simulator without push, etc.
        // Bail out silently — feature is non-critical for app function.
        console.warn('[Push] FCM init failed', err);
      }
    })();

    return () => {
      cancelled = true;
      unsubRefresh?.();
      unsubMessage?.();
    };
  }, [isAuthenticated, registerToken]);

  return { fcmToken, notification };
}
