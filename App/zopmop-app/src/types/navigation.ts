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
};

export type MainStackParamList = {
  Home: undefined;
  Bookings: undefined;
  Profile: undefined;
  Addresses: undefined;
  AllServices: undefined;
  ServiceAbout: { service: ApiService };
  Cart: undefined;
  Wallet: undefined;
  Offers: undefined;
  HelpSupport: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
