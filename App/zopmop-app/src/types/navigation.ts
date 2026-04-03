export type AuthStackParamList = {
  Location: undefined;
  NotServiceable: { cityName: string };
  PhoneEntry: undefined;
  OTPVerification: { phone: string };
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};
