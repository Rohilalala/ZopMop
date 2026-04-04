export type AuthStackParamList = {
  Location: undefined;
  NotServiceable: { cityName: string };
  PhoneEntry: undefined;
  OTPVerification: {
    phone: string;
  };
  RoleSelection: {
    phone: string;
  };
};

export type MainTabParamList = {
  Home: undefined;
  Bookings: undefined;
};

export type MainStackParamList = {
  Tabs: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
