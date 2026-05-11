import './global.css';
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

SplashScreenNative.preventAutoHideAsync();

function Navigation() {
  const { isAuthenticated, isLoading } = useAuth();
  const routeNameRef = React.useRef<string | undefined>(undefined);

  // Deep link handler: parse /r/<code> and route to ReferralInvite or stash for after login.
  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      const match = url.match(/\/r\/([A-Za-z0-9_]+)/);
      if (!match) return;
      const code = match[1].toUpperCase();
      if (isAuthenticated) {
        navNavigate('ReferralInvite', { code });
      } else {
        await AsyncStorage.setItem('pendingReferralCode', code);
      }
    };

    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    return () => sub.remove();
  }, [isAuthenticated]);

  // After login, flush any stashed referral code.
  useEffect(() => {
    if (!isAuthenticated) return;
    AsyncStorage.getItem('pendingReferralCode').then(code => {
      if (!code) return;
      AsyncStorage.removeItem('pendingReferralCode');
      setTimeout(() => {
        navNavigate('ReferralInvite', { code });
      }, 300);
    });
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
          {isAuthenticated ? <MainNavigator /> : <AuthNavigator />}
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
      {!splashDone ? (
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

export default function App() {
  const [splashDone, setSplashDone] = useState(false);

  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    Qurova_500Medium: require('./assets/qurovademomedium-dygo9.otf'),
  });

  const onLayoutRootView = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreenNative.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

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
