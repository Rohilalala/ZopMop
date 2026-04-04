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

export type MainTabParamList = {
  Home: undefined;
  Bookings: undefined;
};

export type MainStackParamList = {
  Tabs: undefined;
  Profile: undefined;
  Addresses: undefined;
  ServiceAbout: { service: ApiService };
  Cart: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
