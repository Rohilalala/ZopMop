import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../types/navigation';
import LocationCheckScreen from '../screens/auth/LocationCheckScreen';
import NotServiceableScreen from '../screens/auth/NotServiceableScreen';
import PhoneEntryScreen from '../screens/auth/PhoneEntryScreen';
import OTPVerificationScreen from '../screens/auth/OTPVerificationScreen';
import RoleSelectionScreen from '../screens/auth/RoleSelectionScreen';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="Location" component={LocationCheckScreen} />
      <Stack.Screen name="NotServiceable" component={NotServiceableScreen} />
      <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
      <Stack.Screen
        name="OTPVerification"
        component={OTPVerificationScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="RoleSelection"
        component={RoleSelectionScreen}
        options={{ animation: 'slide_from_right' }}
      />
    </Stack.Navigator>
  );
}
