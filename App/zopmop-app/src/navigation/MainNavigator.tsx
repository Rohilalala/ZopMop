import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../types/navigation';
import { BottomTabBar } from '../components/home/BottomTabBar';
import { navigationRef } from './navigationRef';
import TabsNavigator from './TabsNavigator';
import AddressesScreen from '../screens/main/AddressesScreen';
import ServiceAboutScreen from '../screens/main/ServiceAboutScreen';
import CartScreen from '../screens/main/CartScreen';
import WalletScreen from '../screens/main/WalletScreen';
import OffersScreen from '../screens/main/OffersScreen';
import HelpSupportScreen from '../screens/main/HelpSupportScreen';
import YourExpertsScreen from '../screens/main/YourExpertsScreen';
import BookingRateScreen from '../screens/main/BookingRateScreen';
import ReportIssueScreen from '../screens/main/ReportIssueScreen';
import InstantMatchingScreen from '../screens/booking/InstantMatchingScreen';
// Legacy ActiveBookingScreen replaced by TrackLiveScreen — both routes now
// render the new design.
// import ActiveBookingScreen from '../screens/booking/ActiveBookingScreen';
import ProDashboardScreen from '../screens/pro/ProDashboardScreen';
import ProDeclareLeaveScreen from '../screens/pro/ProDeclareLeaveScreen';
import ProProfileScreen from '../screens/pro/ProProfileScreen';
import ProLeaveHistoryScreen from '../screens/pro/ProLeaveHistoryScreen';
import CommitShiftScreen from '../screens/pro/CommitShiftScreen';
import ZoneApprovalRequestScreen from '../screens/pro/ZoneApprovalRequestScreen';
import ProMoneyScreen from '../screens/pro/ProMoneyScreen';
import LanguageToggleScreen from '../screens/pro/LanguageToggleScreen';
import JobOfferScreen from '../screens/pro/JobOfferScreen';
import JobDetailScreen from '../screens/pro/JobDetailScreen';
import JobStuckScreen from '../screens/pro/JobStuckScreen';
import ProNavigator from './ProNavigator';
import ZoneDriftOverlay from '../components/ZoneDriftOverlay';
import RoomiesSetupScreen from '../screens/main/RoomiesSetupScreen';
import RoomiesCodeShareScreen from '../screens/main/RoomiesCodeShareScreen';
import RoomiesJoinScreen from '../screens/main/RoomiesJoinScreen';
import RoomiesWelcomeScreen from '../screens/main/RoomiesWelcomeScreen';
import ManageHouseholdScreen from '../screens/main/ManageHouseholdScreen';
import BookingConfirmedScreen from '../screens/main/BookingConfirmedScreen';
import TrackLiveScreen from '../screens/main/TrackLiveScreen';
import EndOfServicePaymentScreen from '../screens/main/EndOfServicePaymentScreen';
import ChatScreen from '../screens/main/ChatScreen';
import TipScreen from '../screens/main/TipScreen';
import ReferralEarnScreen from '../screens/main/ReferralEarnScreen';
import ReferralInviteScreen from '../screens/main/ReferralInviteScreen';
import { CartProvider } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const Stack = createNativeStackNavigator<MainStackParamList>();

// Routes that show the BottomTabBar. Detail / modal / pro / booking-flow
// screens are intentionally absent — the bar disappears there.
const TAB_FOR_ROUTE: Record<string, 'home' | 'services' | 'bookings' | 'profile'> = {
  Home:        'home',
  AllServices: 'services',
  Bookings:    'bookings',
  Profile:     'profile',
};

// Persistent tab bar — mounted once at the navigator root so it survives
// stack pushes/pops. Sits OUTSIDE the Stack.Navigator (no navigator context),
// so we read the current route through `navigationRef` instead of the
// `useNavigationState` hook (which requires a navigator parent).
function PersistentTabBar() {
  const [routeName, setRouteName] = useState<string | undefined>(
    () => navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined,
  );
  useEffect(() => {
    const sync = () => {
      if (navigationRef.isReady()) {
        setRouteName(navigationRef.getCurrentRoute()?.name);
      }
    };
    sync();
    const unsub = navigationRef.addListener('state', sync);
    return unsub;
  }, []);
  if (!routeName) return null;
  const active = TAB_FOR_ROUTE[routeName];
  if (!active) return null;
  return <BottomTabBar active={active} />;
}

export default function MainNavigator() {
  const { user } = useAuth();
  
  return (
    <CartProvider>
      <View style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
      <Stack.Navigator
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0A0A0A' } }}
        initialRouteName={user?.role === 'pro' || user?.role === 'helper' ? 'Pro' : 'Tabs'}
      >
        {/* The four bottom-bar destinations live inside TabsNavigator so
            switching between them is instant (parallel-mounted tabs, no
            stack push animation, no remount). Detail screens (Cart,
            ServiceAbout, etc.) keep pushing on top of this Tabs screen. */}
        <Stack.Screen
          name="Tabs"
          component={TabsNavigator}
          options={{ animation: 'none' }}
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
          name="Payment"
          getComponent={() => require('../screens/main/PaymentScreen').default}
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
          name="YourExperts"
          component={YourExpertsScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="BookingRate"
          component={BookingRateScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
        />
        <Stack.Screen
          name="ReportIssue"
          component={ReportIssueScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
        />
        <Stack.Screen
          name="InstantMatching"
          component={InstantMatchingScreen}
          options={{ animation: 'slide_from_bottom', gestureEnabled: false }}
        />
        <Stack.Screen
          name="ActiveBooking"
          component={TrackLiveScreen}
          options={{ animation: 'fade', gestureEnabled: false }}
        />
        <Stack.Screen
          name="EndOfServicePayment"
          component={EndOfServicePaymentScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'modal', gestureEnabled: true }}
        />
        <Stack.Screen
          name="Pro"
          component={ProNavigator}
          options={{ animation: 'none' }}
        />
        <Stack.Screen
          name="ProDashboard"
          component={ProDashboardScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="LanguageToggle"
          component={LanguageToggleScreen}
          options={{ animation: 'slide_from_right' }}
        />
        {/* ProMatched / ProActive / ProScheduledInvite were retired
            in Phase 10 — replaced by JobDetail + JobOffer.
            Archived at _legacy/pro_legacy_screens/. */}
        <Stack.Screen
          name="ProProfile"
          component={ProProfileScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="ProDeclareLeave"
          component={ProDeclareLeaveScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="ProLeaveHistory"
          component={ProLeaveHistoryScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="CommitShift"
          component={CommitShiftScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="ZoneApprovalRequest"
          component={ZoneApprovalRequestScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="ProMoney"
          component={ProMoneyScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="JobOffer"
          component={JobOfferScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal', gestureEnabled: false }}
        />
        <Stack.Screen
          name="JobDetail"
          component={JobDetailScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="JobStuck"
          component={JobStuckScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
        />
        <Stack.Screen
          name="RoomiesSetup"
          component={RoomiesSetupScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="RoomiesCodeShare"
          component={RoomiesCodeShareScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="RoomiesJoin"
          component={RoomiesJoinScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="RoomiesWelcome"
          component={RoomiesWelcomeScreen}
          options={{ animation: 'fade', headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen
          name="ManageHousehold"
          component={ManageHouseholdScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="BookingConfirmed"
          component={BookingConfirmedScreen}
          options={{ animation: 'slide_from_bottom', gestureEnabled: false }}
        />
        <Stack.Screen
          name="TrackLive"
          component={TrackLiveScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Tip"
          component={TipScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="ReferralEarn"
          component={ReferralEarnScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="ReferralInvite"
          component={ReferralInviteScreen}
          options={{ gestureEnabled: false, animation: 'slide_from_bottom' }}
        />
      </Stack.Navigator>
      <PersistentTabBar />
      <ZoneDriftOverlay />
      </View>
    </CartProvider>
  );
}
