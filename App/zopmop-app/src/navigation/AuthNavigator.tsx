import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../types/navigation';
import LocationCheckScreen from '../screens/auth/LocationCheckScreen';
import NotServiceableScreen from '../screens/auth/NotServiceableScreen';

// Placeholder — will be replaced when built
function PhoneEntryPlaceholder() {
  const { View, Text } = require('react-native');
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Phone Entry — coming next</Text>
    </View>
  );
}

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="Location" component={LocationCheckScreen} />
      <Stack.Screen name="NotServiceable" component={NotServiceableScreen} />
      <Stack.Screen name="PhoneEntry" component={PhoneEntryPlaceholder} />
      <Stack.Screen name="OTPVerification" component={PhoneEntryPlaceholder} />
    </Stack.Navigator>
  );
}
