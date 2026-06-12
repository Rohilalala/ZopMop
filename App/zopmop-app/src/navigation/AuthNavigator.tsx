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

const Stack = createNativeStackNavigator<AuthStackParamList>();

type AuthNavigatorProps = {
  // When an already-authenticated customer still has no name, the app keeps
  // this navigator mounted and opens it straight on NameEntry instead of the
  // cold onboarding start (ZopIntro). See App.tsx `needsName`.
  needsName?: boolean;
  phone?: string;
};

export default function AuthNavigator({ needsName = false, phone }: AuthNavigatorProps) {
  return (
    <Stack.Navigator
      initialRouteName={needsName ? 'NameEntry' : 'ZopIntro'}
      screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: '#FAF7F2' } }}
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
        initialParams={{ phone: phone ?? '' }}
      />
      <Stack.Screen
        name="Welcome"
        component={WelcomeScreen}
        options={{ animation: 'fade' }}
      />
    </Stack.Navigator>
  );
}
