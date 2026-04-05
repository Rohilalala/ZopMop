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
import InstantMatchingScreen from '../screens/booking/InstantMatchingScreen';
import ActiveBookingScreen from '../screens/booking/ActiveBookingScreen';
import ProDashboardScreen from '../screens/pro/ProDashboardScreen';
import ProMatchedScreen from '../screens/pro/ProMatchedScreen';
import ProActiveScreen from '../screens/pro/ProActiveScreen';
import { CartProvider } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const Stack = createNativeStackNavigator<MainStackParamList>();

export default function MainNavigator() {
  const { user } = useAuth();
  
  return (
    <CartProvider>
      <Stack.Navigator 
        screenOptions={{ headerShown: false }}
        initialRouteName={user?.role === 'pro' || user?.role === 'helper' ? 'ProDashboard' : 'Home'}
      >
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
        <Stack.Screen
          name="InstantMatching"
          component={InstantMatchingScreen}
          options={{ animation: 'slide_from_bottom', gestureEnabled: false }}
        />
        <Stack.Screen
          name="ActiveBooking"
          component={ActiveBookingScreen}
          options={{ animation: 'fade', gestureEnabled: false }}
        />
        <Stack.Screen
          name="ProDashboard"
          component={ProDashboardScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="ProMatched"
          component={ProMatchedScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="ProActive"
          component={ProActiveScreen}
          options={{ animation: 'fade', gestureEnabled: false }}
        />
      </Stack.Navigator>
    </CartProvider>
  );
}
