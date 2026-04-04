import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../types/navigation';
import HomeScreen from '../screens/main/HomeScreen';
import BookingsScreen from '../screens/main/BookingsScreen';
import ProfileScreen from '../screens/main/ProfileScreen';
import AddressesScreen from '../screens/main/AddressesScreen';
import ServiceAboutScreen from '../screens/main/ServiceAboutScreen';
import CartScreen from '../screens/main/CartScreen';
import AllServicesScreen from '../screens/main/AllServicesScreen';
import WalletScreen from '../screens/main/WalletScreen';
import OffersScreen from '../screens/main/OffersScreen';
import HelpSupportScreen from '../screens/main/HelpSupportScreen';
import { CartProvider } from '../context/CartContext';

const Stack = createNativeStackNavigator<MainStackParamList>();

export default function MainNavigator() {
  return (
    <CartProvider>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen
          name="Bookings"
          component={BookingsScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Addresses"
          component={AddressesScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="ServiceAbout"
          component={ServiceAboutScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="AllServices"
          component={AllServicesScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Cart"
          component={CartScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Wallet"
          component={WalletScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Offers"
          component={OffersScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="HelpSupport"
          component={HelpSupportScreen}
          options={{ animation: 'slide_from_right' }}
        />
      </Stack.Navigator>
    </CartProvider>
  );
}
