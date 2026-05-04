import './global.css';
import React, { useState, useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { navigationRef } from './src/navigation/navigationRef';
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
import Toast from 'react-native-toast-message';

SplashScreenNative.preventAutoHideAsync();

function Navigation() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return (
    <ErrorBoundary>
      <Toast />
      <NavigationContainer ref={navigationRef}>
        {isAuthenticated ? <MainNavigator /> : <AuthNavigator />}
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

  // Sticky "show backend-down screen" flag. Goes true the first time the
  // hook reports down. Stays true through subsequent 'unknown' probe windows
  // so the screen remains mounted and can run its peek/refresh animation.
  // Cleared only when status flips to 'up'.
  const [showDown, setShowDown] = useState(false);
  useEffect(() => {
    if (status === 'down') setShowDown(true);
    else if (status === 'up') setShowDown(false);
  }, [status]);

  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0A' }} onLayout={onLayout}>
      {!splashDone ? (
        <SplashScreen onReady={() => setSplashDone(true)} />
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
