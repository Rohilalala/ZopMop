// Dynamic config — extends app.json and injects env vars into native build.
// Expo reads this automatically. Never hardcode API keys here.
//
// SECURITY NOTE:
// - GOOGLE_MAPS_API_KEY (no EXPO_PUBLIC_ prefix) → injected into the native binary only.
//   It does NOT appear in the JavaScript bundle. Restrict this key in the Google Cloud
//   Console to the app's package name + SHA-1 fingerprint (Android) / bundle ID (iOS).
// - All geocoding and address search now use expo-location's on-device geocoder.
//   No Google Maps API key is compiled into the JS bundle.

// aps-environment selects which APNs gateway iOS pushes route through.
// "production" is the App Store / TestFlight gateway; "development" is
// the Xcode-debug sandbox. Mismatch = silent push failure (audit E3D-10).
// EAS production builds get "production"; everything else (local dev,
// EAS development/preview) gets "development". Set explicitly here so
// the entitlement always lands in the prebuild output, regardless of
// what's hardcoded in the committed native .entitlements file.
const apsEnvironment = process.env.EAS_BUILD_PROFILE === 'production'
  ? 'production'
  : 'development';

/** @type {(config: import('@expo/config').ConfigContext) => import('@expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    config: {
      ...config.ios?.config,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    },
    entitlements: {
      ...config.ios?.entitlements,
      'aps-environment': apsEnvironment,
    },
  },
  android: {
    ...config.android,
    config: {
      ...config.android?.config,
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
    },
  },
  plugins: [
    ...(config.plugins ?? []),
    [
      'react-native-maps',
      {
        iosGoogleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
        androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
    ],
  ],
});
