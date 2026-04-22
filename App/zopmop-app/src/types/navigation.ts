import type { ApiService } from '../api/services';

export type AuthStackParamList = {
  ZopIntro: undefined;
  HiZop: undefined;
  Location: undefined;
  NotServiceable: { cityName: string };
  PhoneEntry: undefined;
  OTPVerification: {
    phone: string;
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
  RoleSelection: {
    phone: string;
  };
  ProOnboarding: {
    phone: string;
  };
};

export type MainStackParamList = {
  Home: undefined;
  Bookings: undefined;
  Profile: undefined;
  Addresses: undefined;
  AllServices: { instant?: boolean } | undefined;
  ServiceAbout: { service: ApiService };
  Cart: { selectedAddressId?: string } | undefined;
  Wallet: undefined;
  Payment: undefined;
  Offers: undefined;
  HelpSupport: undefined;
  InstantMatching: { serviceId: string; serviceName: string };
  ActiveBooking: {
    bookingId: string;
    serviceName: string;
    helperName: string;
    helperRating: number;
    helperLat?: number;
    helperLng?: number;
    etaMinutes: number;
  };
  ProDashboard: undefined;
  ProMatched: {
    bookingId: string;
    serviceName?: string;
    customerAddress: string;
    customerLat: number;
    customerLng: number;
    distanceKm?: number;
  };
  ProActive: {
    bookingId: string;
    serviceName?: string;
    customerAddress: string;
    customerLat: number;
    customerLng: number;
  };
  RoomiesSetup: undefined;
  RoomiesCodeShare: { groupId: string; code: string; groupName: string };
  RoomiesJoin: undefined;
  RoomiesWelcome: { groupName: string; addressLabel: string; addressAdded: boolean };
  ManageHousehold: { groupId: string };
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
