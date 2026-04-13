import React, { useState, useCallback } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
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
import AuthNavigator from './src/navigation/AuthNavigator';
import MainNavigator from './src/navigation/MainNavigator';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ThemeProvider, useColors } from './src/context/ThemeContext';

SplashScreenNative.preventAutoHideAsync();

function Navigation() {
  const { isAuthenticated } = useAuth();
  return (
    <NavigationContainer>
      {isAuthenticated ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}

function ThemedRoot({ splashDone, setSplashDone, onLayout }: {
  splashDone: boolean;
  setSplashDone: (v: boolean) => void;
  onLayout: () => void;
}) {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }} onLayout={onLayout}>
      {!splashDone ? (
        <SplashScreen onReady={() => setSplashDone(true)} />
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
  });

  const onLayoutRootView = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreenNative.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ThemedRoot
            splashDone={splashDone}
            setSplashDone={setSplashDone}
            onLayout={onLayoutRootView}
          />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
