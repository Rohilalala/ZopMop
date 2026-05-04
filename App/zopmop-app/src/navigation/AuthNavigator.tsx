import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../types/navigation';
import ZopIntroScreen from '../screens/auth/ZopIntroScreen';
import HiZopScreen from '../screens/auth/HiZopScreen';
import LocationCheckScreen from '../screens/auth/LocationCheckScreen';
import NotServiceableScreen from '../screens/auth/NotServiceableScreen';
import PhoneEntryScreen from '../screens/auth/PhoneEntryScreen';
import OTPVerificationScreen from '../screens/auth/OTPVerificationScreen';
import NameEntryScreen from '../screens/auth/NameEntryScreen';
import WelcomeScreen from '../screens/auth/WelcomeScreen';
import RoleSelectionScreen from '../screens/auth/RoleSelectionScreen';
import ProOnboardingScreen from '../screens/pro/ProOnboardingScreen';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="ZopIntro"
      screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: '#0A0A0A' } }}
    >
      <Stack.Screen
        name="ZopIntro"
        component={ZopIntroScreen}
        options={{ animation: 'none' }}
      />
      <Stack.Screen
        name="HiZop"
        component={HiZopScreen}
        options={{ animation: 'none' }}
      />
      <Stack.Screen name="Location" component={LocationCheckScreen} />
      <Stack.Screen name="NotServiceable" component={NotServiceableScreen} />
      <Stack.Screen
        name="PhoneEntry"
        component={PhoneEntryScreen}
        options={{ animation: 'none' }}
      />
      <Stack.Screen
        name="OTPVerification"
        component={OTPVerificationScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="NameEntry"
        component={NameEntryScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="Welcome"
        component={WelcomeScreen}
        options={{ animation: 'fade' }}
      />
      <Stack.Screen
        name="RoleSelection"
        component={RoleSelectionScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="ProOnboarding"
        component={ProOnboardingScreen}
        options={{ animation: 'slide_from_right' }}
      />
    </Stack.Navigator>
  );
}
