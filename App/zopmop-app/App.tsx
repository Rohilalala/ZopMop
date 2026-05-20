import './global.css';
// Sentry must be imported before the rest of the app so its init runs
// before any other module can crash. See src/config/sentry.ts for the
// DSN-gated init (no-op when SENTRY_DSN is unset).
import { wrapRoot as wrapWithSentry } from './src/config/sentry';
import React, { useState, useCallback, useEffect } from 'react';
import { View, LogBox, Linking } from 'react-native';

LogBox.ignoreLogs(['Error while flushing PostHog', 'PostHogFetchNetworkError']);
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { navigationRef, flushPendingNavigation, navigate as navNavigate } from './src/navigation/navigationRef';
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import * as SplashScreenNative from 'expo-splash-screen';
import SplashScreen from './src/screens/auth/SplashScreen';
import BackendDownScreen from './src/screens/BackendDownScreen';
import AuthNavigator from './src/navigation/AuthNavigator';
import MainNavigator from './src/navigation/MainNavigator';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ThemeProvider, useColors } from './src/context/ThemeContext';
import { RoomiesProvider } from './src/context/RoomiesContext';
import { PrefetchProvider } from './src/context/PrefetchContext';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useBackendHealth } from './src/hooks/useBackendHealth';
import { addConnectivityListener, isConnected } from './src/utils/netInfo';
import Toast from 'react-native-toast-message';
import { PostHogProvider } from 'posthog-react-native';
import { posthog } from './src/config/posthog';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bootstrapLocale } from './src/i18n';

SplashScreenNative.preventAutoHideAsync();

function Navigation() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const routeNameRef = React.useRef<string | undefined>(undefined);

  // Deep link handler: parse /r/<code> and route to ReferralInvite or stash for after login.
  //
  // The stash carries a 24h TTL (`pendingReferralCodeAt`) and is cleared on
  // signOut (see AuthContext) so a shared device can't apply one user's
  // referral code to the next user who installs/signs in.
  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      const match = url.match(/\/r\/([A-Za-z0-9_]+)/);
      if (!match) return;
      const code = match[1].toUpperCase();
      if (isAuthenticated) {
        navNavigate('ReferralInvite', { code });
      } else {
        await AsyncStorage.multiSet([
          ['pendingReferralCode', code],
          ['pendingReferralCodeAt', String(Date.now())],
        ]);
      }
    };

    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    return () => sub.remove();
  }, [isAuthenticated]);

  // After login, flush any stashed referral code — only if fresher than 24h.
  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      const [[, code], [, atRaw]] = await AsyncStorage.multiGet([
        'pendingReferralCode',
        'pendingReferralCodeAt',
      ]);
      if (!code) return;
      const at = Number(atRaw) || 0;
      const stale = !at || Date.now() - at > 24 * 60 * 60 * 1000;
      await AsyncStorage.multiRemove(['pendingReferralCode', 'pendingReferralCodeAt']);
      if (stale) return;
      setTimeout(() => {
        navNavigate('ReferralInvite', { code });
      }, 300);
    })();
  }, [isAuthenticated]);

  if (isLoading) return null;
  return (
    <ErrorBoundary>
      <Toast />
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          routeNameRef.current = navigationRef.current?.getCurrentRoute()?.name;
          flushPendingNavigation();
        }}
        onStateChange={() => {
          const current = navigationRef.current?.getCurrentRoute()?.name;
          if (current && current !== routeNameRef.current) {
            posthog?.capture('$screen', { $screen_name: current });
          }
          routeNameRef.current = current;
        }}
      >
        <PostHogProvider
          client={posthog}
          autocapture={{
            captureScreens: false,
            captureTouches: true,
            propsToCapture: ['testID'],
            maxElementsCaptured: 20,
          }}
        >
          {/* Key MainNavigator on user.role so a stale cached role
              (e.g. 'customer' restored from SecureStore at launch)
              doesn't lock initialRouteName='Tabs' when /me returns
              'pro' a moment later — React remounts the stack and
              the gate re-evaluates with the fresh role. */}
          {isAuthenticated
            ? <MainNavigator key={`main-${user?.role ?? 'unknown'}`} />
            : <AuthNavigator />}
        </PostHogProvider>
      </NavigationContainer>
    </ErrorBoundary>
  );
}

function ThemedRoot({ splashDone, setSplashDone, onLayout }: {
  splashDone: boolean;
  setSplashDone: (v: boolean) => void;
  onLayout: () => void;
}) {
  useColors();
  const { status, retry } = useBackendHealth();
  // Hold the splash until auth knows the user's role (or has decided
  // there's no session). Prevents a black-screen flash when the Lottie
  // animation finishes before /me resolves, and prevents the wrong
  // navigator from mounting from a missing/stale cache.
  const { isLoading: authLoading } = useAuth();

  // null = not yet checked (fail-open: assume online until we know otherwise)
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  useEffect(() => {
    isConnected().then(setIsOnline);
    return addConnectivityListener(setIsOnline);
  }, []);

  const retryOffline = useCallback(() => {
    isConnected().then(setIsOnline);
  }, []);

  // Sticky "show backend-down screen" flag. Goes true the first time the
  // hook reports down. Stays true through subsequent 'unknown' probe windows
  // so the screen remains mounted and can run its peek/refresh animation.
  // Cleared only when status flips to 'up'.
  const [showDown, setShowDown] = useState(false);
  useEffect(() => {
    if (status === 'down') setShowDown(true);
    else if (status === 'up') setShowDown(false);
  }, [status]);

  // If backend is reachable, treat as online regardless of NetInfo (iOS
  // simulator can false-negative isConnected during app startup).
  const offline = isOnline === false && status !== 'up';

  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0A' }} onLayout={onLayout}>
      {(!splashDone || authLoading) ? (
        <SplashScreen onReady={() => setSplashDone(true)} />
      ) : offline ? (
        <BackendDownScreen onRetry={retryOffline} />
      ) : showDown ? (
        <BackendDownScreen onRetry={retry} />
      ) : (
        <Navigation />
      )}
    </View>
  );
}

function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [localeReady, setLocaleReady] = useState(false);

  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    Qurova_500Medium: require('./assets/qurovademomedium-dygo9.otf'),
  });

  useEffect(() => {
    bootstrapLocale().finally(() => setLocaleReady(true));
  }, []);

  const onLayoutRootView = useCallback(async () => {
    if (fontsLoaded && localeReady) {
      await SplashScreenNative.hideAsync();
    }
  }, [fontsLoaded, localeReady]);

  if (!fontsLoaded || !localeReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <PrefetchProvider>
              <RoomiesProvider>
                <ThemedRoot
                  splashDone={splashDone}
                  setSplashDone={setSplashDone}
                  onLayout={onLayoutRootView}
                />
              </RoomiesProvider>
            </PrefetchProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Wrap with Sentry so React render errors are captured automatically.
// Pass-through when SENTRY_DSN is unset.
export default wrapWithSentry(App);
