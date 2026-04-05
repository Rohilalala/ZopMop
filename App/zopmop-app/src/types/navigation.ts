import type { ApiService } from '../api/services';

export type AuthStackParamList = {
  Location: undefined;
  NotServiceable: { cityName: string };
  PhoneEntry: undefined;
  OTPVerification: {
    phone: string;
  };
  NameEntry: {
    phone: string;
    backendToken?: string;
    backendUser?: any;
  };
  RoleSelection: {
    phone: string;
    backendToken?: string;
    backendUser?: any;
  };
  ProOnboarding: {
    phone: string;
    backendToken?: string;
    backendUser?: any;
  };
};

export type MainStackParamList = {
  Home: undefined;
  Bookings: undefined;
  Profile: undefined;
  Addresses: undefined;
  AllServices: { instant?: boolean } | undefined;
  ServiceAbout: { service: ApiService };
  Cart: undefined;
  Wallet: undefined;
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
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
