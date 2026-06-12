import type { NavigatorScreenParams } from '@react-navigation/native';
import type { ApiService } from '../api/services';
import type { ProTabParamList } from '../navigation/ProNavigator';

export type AuthStackParamList = {
  ZopIntro: undefined;
  HiZop: undefined;
  Location: { phone: string; name: string };
  NotServiceable: { cityName: string; phone: string; name: string };
  PhoneEntry: undefined;
  OTPVerification: {
    phone: string;
    /** From POST /auth/send-otp. When true, OTPVerificationScreen renders the
     *  Terms / Privacy Policy checkbox and disables the verify button until
     *  it's ticked. Returning users skip the checkbox entirely. */
    isNewUser?: boolean;
  };
  // Security: backendToken and backendUser have been removed from nav params.
  // They are stored in pendingAuthStore (in-memory only) to prevent serialization
  // to disk via React Navigation state persistence.
  NameEntry: {
    phone: string;
  };
  Welcome: {
    phone: string;
    name?: string;
  };
  // Kept for ProOnboardingScreen's prop types only — the screen is no
  // longer registered in AuthNavigator. Roles are assigned in the DB via
  // the CRM; the app never asks customer-vs-pro.
  ProOnboarding: {
    phone: string;
  };
};

export type MainStackParamList = {
  // The four bottom-bar destinations live inside a nested bottom-tabs
  // navigator (`TabsNavigator`). React Navigation resolves these by name
  // across nesting levels, so existing `navigation.navigate('Home')` etc.
  // still work — they jump the active tab inside `Tabs`.
  Tabs: { screen?: 'Home' | 'AllServices' | 'Bookings' | 'Profile' } | undefined;
  Home: undefined;
  Bookings: undefined;
  Profile: undefined;
  Addresses: undefined;
  AllServices: { instant?: boolean } | undefined;
  ServiceAbout: { service: ApiService };
  Cart: { selectedAddressId?: string } | undefined;
  Wallet: undefined;
  // Cashfree Drop Checkout entry point. Pushed from CartScreen when the
  // customer chooses Pay-now (direct) at confirm-booking time.
  Payment: { booking_id: string; amount_paise: number; bookingType: 'instant' | 'scheduled' };
  Offers: undefined;
  HelpSupport: undefined;
  YourExperts: undefined;
  BookingRate: { bookingId: string; helperId?: string; helperName?: string };
  ReportIssue: { bookingId: string; serviceName?: string };
  InstantMatching: { serviceId: string; serviceName: string; durationMinutes?: number };
  ActiveBooking: {
    bookingId: string;
    serviceName: string;
    helperName: string;
    helperRating: number;
    helperLat?: number;
    helperLng?: number;
    etaMinutes: number;
  };
  /** Pro umbrella — bottom-tab navigator (Home/Shift/Jobs/Money/Profile).
   *  Accepts a nested `{ screen }` param so callers can jump to a specific
   *  pro tab (e.g. `navigate('Pro', { screen: 'ProHome' })`) while keeping
   *  the tab bar mounted. */
  Pro: NavigatorScreenParams<ProTabParamList> | undefined;
  /** Legacy single-screen routes kept for back-compat with anything that
   *  still calls navigation.navigate('ProDashboard', ...). They point at
   *  the same components but live on the parent stack so the tab bar
   *  hides behind them — only push these when a non-tab modal flow
   *  genuinely needs that. Prefer navigating to a Pro tab via
   *  `navigation.navigate('Pro', { screen: 'ProHome' })`. */
  ProDashboard: undefined;
  ProProfile: undefined;
  ProDeclareLeave: undefined;
  ProLeaveHistory: undefined;
  CommitShift: undefined;
  ZoneApprovalRequest: {
    commitment_id: string;
    current_lat: number;
    current_lng: number;
    distance_meters: number;
  };
  ProMoney: undefined;
  LanguageToggle: undefined;
  JobOffer: { booking_id: string };
  JobDetail: { booking_id: string };
  // ProMatched / ProActive / ProScheduledInvite retired in Phase 10.
  // Replaced by JobDetail + JobOffer below. Screens archived at
  // _legacy/pro_legacy_screens/.
  RoomiesSetup: undefined;
  RoomiesCodeShare: { groupId: string; code: string; groupName: string };
  RoomiesJoin: undefined;
  RoomiesWelcome: { groupName: string; addressLabel: string; addressAdded: boolean };
  ManageHousehold: { groupId: string };
  TrackLive: {
    bookingId: string;
    serviceName?: string;
    helperName?: string;
    helperPhone?: string;
    helperRating?: number;
    helperJobs?: number;
    etaMinutes?: number;
    distanceKm?: number;
    /** 4-digit OTP customer shares with pro to start the job. */
    otp?: string;
    /** ISO timestamp when booking was confirmed (for the timeline). */
    confirmedAt?: string;
    /** ISO timestamp when the booking was created (used to compute "accepted in X"). */
    createdAt?: string;
    /** ISO timestamp when the helper accepted the booking. */
    acceptedAt?: string;
  };
  BookingConfirmed: {
    bookingId: string;
    totalCents: number;
    slot?: string;
    addressLine?: string;
    /** Optional context for the rich confirmation screen. */
    serviceId?: string;
    serviceName?: string;
    durationMinutes?: number;
    helperName?: string;
    helperPhone?: string;
    helperRating?: number;
    paymentLabel?: string;     // e.g. "Paid · GPay" or "Paid · HDFC •••• 4521"
    discountCents?: number;
    promoCode?: string;
    bookingType: 'instant' | 'scheduled';
    /** Initial ETA (minutes) for the "When" tile on instant bookings. */
    etaMinutes?: number;
  };
  Chat: {
    bookingId: string;
    helperName?: string;
  };
  Tip: {
    bookingId: string;
    helperName?: string;
    initialAmountRupees?: number;
  };
  ReferralEarn: undefined;
  ReferralInvite: { code: string };
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
